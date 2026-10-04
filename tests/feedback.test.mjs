import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { EditFeedback, editedFiles, syntaxProblem } from '../src/agent/feedback.mjs';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, tempDir, waitFor } from './helpers.mjs';

async function write(dir, name, content) {
  const file = path.join(dir, name);
  await fsp.writeFile(file, content);
  return file;
}

test('syntaxProblem finds errors in JSON, JavaScript, Python and shell, and passes clean files', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await syntaxProblem(await write(dir, 'ok.json', '{"a": [1, 2]}')), null);
  const badJson = await syntaxProblem(await write(dir, 'bad.json', '{"a": [1, 2,]\n}'));
  assert.match(badJson, /Unexpected token|not valid JSON/);
  assert.ok(!badJson.includes('\n'), 'one line, not the whole file');

  assert.equal(await syntaxProblem(await write(dir, 'ok.mjs', 'export const a = 1;\n')), null);
  const badJs = await syntaxProblem(await write(dir, 'bad.mjs', 'export const a = {\n  b: 1,\n;\n'));
  assert.match(badJs, /SyntaxError/);

  assert.equal(await syntaxProblem(await write(dir, 'ok.py', 'def f():\n    return 1\n')), null);
  const badPy = await syntaxProblem(await write(dir, 'bad.py', 'def f(:\n    return 1\n'));
  assert.match(badPy, /SyntaxError/);

  assert.equal(await syntaxProblem(await write(dir, 'ok.sh', 'echo hi\n')), null);
  assert.ok(await syntaxProblem(await write(dir, 'bad.sh', 'if true; then\necho hi\n')));
  await assert.rejects(fsp.access(path.join(dir, '__pycache__')), 'no bytecode is left behind');
});

test('JSON with comments and trailing commas is not called broken, but real errors still are', async (t) => {
  const dir = await tempDir(t);
  const jsonc = '{\n  // compiler options\n  "compilerOptions": { "strict": true, },\n  /* block */\n  "include": ["src",],\n  "url": "http://x//y"\n}\n';
  assert.equal(await syntaxProblem(await write(dir, 'tsconfig.json', jsonc)), null);
  assert.ok(await syntaxProblem(await write(dir, 'bad.jsonc', '// note\n{"a": 1 "b": 2}')));
  assert.ok(await syntaxProblem(await write(dir, 'package.json', '{"name": "x",}')), 'strict JSON files keep strict rules');
});

test('a .js file with JSX or bundler-style ES modules is not blamed on the edit, but a plain syntax error is', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await syntaxProblem(await write(dir, 'View.js', 'export default function View() {\n  return <div className="a">hi</div>;\n}\n')), null);
  assert.equal(await syntaxProblem(await write(dir, 'esm.js', "import fs from 'fs';\nexport const a = fs;\n")), null);
  assert.match(await syntaxProblem(await write(dir, 'plain.js', 'const a = {\n  b: 1,\n;\n')), /SyntaxError/);
});

test('syntaxProblem ignores file types it cannot check and files that do not exist', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await syntaxProblem(await write(dir, 'notes.md', '# hi {')), null);
  assert.equal(await syntaxProblem(path.join(dir, 'missing.js')), null);
});

test('editedFiles reads the path from edit results and the targets from a unified diff', () => {
  assert.deepEqual(editedFiles('fs_patch', {}, { path: '/w/a.js' }, '/w'), ['/w/a.js']);
  const patch = '--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+z\n';
  assert.deepEqual(editedFiles('fs_apply_patch', { patch }, { cwd: '/w' }, '/w'), ['/w/src/x.js', '/w/src/new.js']);
  assert.deepEqual(editedFiles('fs_patch', {}, {}, '/w'), []);
});

function feedbackFor(overrides = {}, lspManager = null) {
  const settings = { guardrails: { feedback: overrides } };
  return new EditFeedback({ config: { get: () => settings }, lspManager });
}

test('check reports a broken edit, stays silent for a clean one, and ignores non-edit tools', async (t) => {
  const dir = await tempDir(t);
  const bad = await write(dir, 'a.mjs', 'const = ;\n');
  const good = await write(dir, 'b.mjs', 'export const b = 1;\n');
  const feedback = feedbackFor();
  const broken = await feedback.check({ name: 'fs_write', args: {}, value: { path: bad }, workspacePath: dir });
  assert.equal(broken.problems, 1);
  assert.match(broken.text, /\[Harness check\].*fix it before moving on/s);
  assert.match(broken.text, /- a\.mjs: syntax error/);
  assert.equal(await feedback.check({ name: 'fs_write', args: {}, value: { path: good }, workspacePath: dir }), null);
  assert.equal(await feedback.check({ name: 'fs_read', args: {}, value: { path: bad }, workspacePath: dir }), null);
});

test('check can be switched off, and syntax and lsp independently', async (t) => {
  const dir = await tempDir(t);
  const bad = await write(dir, 'a.mjs', 'const = ;\n');
  assert.equal(await feedbackFor({ enabled: false }).check({ name: 'fs_write', args: {}, value: { path: bad }, workspacePath: dir }), null);
  assert.equal(await feedbackFor({ syntax: false, lsp: false }).check({ name: 'fs_write', args: {}, value: { path: bad }, workspacePath: dir }), null);
});

test('language-server errors are reported, warnings are not, and a missing server is skipped', async (t) => {
  const dir = await tempDir(t);
  const file = await write(dir, 'c.ts', 'export const x: number = "s";\n');
  const lsp = {
    definitionFor: async () => ({ id: 'typescript' }),
    diagnostics: async () => [
      { severity: 1, message: "Type 'string' is not assignable to type 'number'.", range: { start: { line: 0, character: 6 } } },
      { severity: 2, message: 'unused variable', range: { start: { line: 3, character: 0 } } },
    ],
  };
  const report = await feedbackFor({}, lsp).check({ name: 'fs_write', args: {}, value: { path: file }, workspaceId: 'w1', workspacePath: dir });
  assert.equal(report.problems, 1);
  assert.match(report.text, /c\.ts: error — line 1: Type 'string' is not assignable/);
  assert.ok(!/unused variable/.test(report.text));

  const missing = { definitionFor: async () => { throw new Error('not installed'); }, diagnostics: async () => { throw new Error('should not be called'); } };
  assert.equal(await feedbackFor({}, missing).check({ name: 'fs_write', args: {}, value: { path: file }, workspaceId: 'w1', workspacePath: dir }), null);

  const hanging = { definitionFor: async () => ({}), diagnostics: () => new Promise(() => {}) };
  const started = Date.now();
  assert.equal(await feedbackFor({ timeoutMs: 100 }, hanging).check({ name: 'fs_write', args: {}, value: { path: file }, workspaceId: 'w1', workspacePath: dir }), null);
  assert.ok(Date.now() - started < 2000, 'a slow language server cannot stall the run');
});

test('a run that writes a broken file is told so in the very same tool result', async (t) => {
  let turn = 0;
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    requests.push(await readJsonBody(request));
    turn += 1;
    const usage = { prompt_tokens: 5, completion_tokens: 2 };
    if (turn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_write', args: { path: 'broken.mjs', content: 'export const = ;\n' } }], finishReason: 'tool_calls', usage });
    if (turn === 2) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c2', name: 'fs_write', args: { path: 'fine.mjs', content: 'export const ok = 1;\n' } }], finishReason: 'tool_calls', usage });
    return respondOpenAIChatSSE(response, { content: 'done', finishReason: 'stop', usage });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-fb:fb-model',
    providers: [{ id: 'fixture-fb', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'fb-model' }], timeoutMs: 15_000 }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'write files', modelRef: 'fixture-fb:fb-model' });
  await waitFor(async () => (['completed', 'failed', 'stagnated'].includes(runtime.store.getRun(run.id).status) ? true : null), { timeoutMs: 20_000, message: 'run completion' });
  const first = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(first.content, /\[Harness check\]/);
  assert.match(first.content, /broken\.mjs: syntax error/);
  const second = requests[2].messages.filter((message) => message.role === 'tool').at(-1);
  assert.ok(!/Harness check/.test(second.content), 'a clean edit costs no extra tokens');
  const events = runtime.store.listRunEvents(run.id, 200).filter((event) => event.type === 'edit-check');
  assert.equal(events.length, 1);
});
