import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { cleanText, condenseText, dedupeLines, shapeObservation } from '../src/agent/observation.mjs';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, waitFor } from './helpers.mjs';

test('cleanText strips ANSI colour and keeps only the last frame of a progress bar', () => {
  assert.equal(cleanText('\u001B[31mred\u001B[0m ok'), 'red ok');
  assert.equal(cleanText('10%\r50%\r100%\ndone'), '100%\ndone');
  assert.equal(cleanText('plain'), 'plain');
});

test('dedupeLines collapses runs but leaves blank lines alone', () => {
  assert.deepEqual(dedupeLines(['a', 'a', 'a', 'b', '', '', 'c']), ['a  [×3]', 'b', '', '', 'c']);
});

test('condenseText returns small text untouched', () => {
  const result = condenseText('hello\nworld', 1000);
  assert.equal(result.text, 'hello\nworld');
  assert.equal(result.omittedLines, 0);
});

test('condenseText keeps the head, the tail and the lines around an error', () => {
  const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} ${'x'.repeat(30)}`);
  lines[900] = 'FAIL tests/payment.test.js';
  lines[901] = '  AssertionError: expected 5 to equal 7';
  lines[1999] = '3 failed, 40 passed';
  const result = condenseText(lines.join('\n'), 4000);
  assert.ok(result.text.length <= 4600, `fit the budget, was ${result.text.length}`);
  assert.match(result.text, /line 0 /);
  assert.match(result.text, /FAIL tests\/payment\.test\.js/);
  assert.match(result.text, /AssertionError: expected 5 to equal 7/);
  assert.match(result.text, /3 failed, 40 passed/);
  assert.match(result.text, /\[\d+ lines omitted\]/);
  assert.ok(!result.text.includes('line 500 '), 'the uneventful middle is what gets dropped');
  assert.ok(result.omittedLines > 1000);
});

test('a shell result is rendered as a compact transcript, not a JSON blob', async () => {
  const { text } = await shapeObservation({ command: 'npm test', cwd: '/x', pid: 99, code: 1, signal: null, timedOut: false, aborted: false, stdout: 'ran 3\n', stderr: 'boom\n', durationMs: 2300 });
  assert.match(text, /^\$ npm test\n→ exit 1 in 2\.3s/);
  assert.match(text, /\[stderr\]\nboom/);
  assert.match(text, /\[stdout\]\nran 3/);
  assert.ok(!/pid|cwd/.test(text));
  assert.ok(text.indexOf('[stderr]') < text.indexOf('[stdout]'), 'on failure the error stream comes first');
});

test('a successful command leads with its output and reports empty output plainly', async () => {
  const ok = await shapeObservation({ command: 'ls', code: 0, stdout: 'a\nb\n', stderr: 'note\n', durationMs: 5 });
  assert.ok(ok.text.indexOf('[stdout]') < ok.text.indexOf('[stderr]'));
  const silent = await shapeObservation({ command: 'true', code: 0, stdout: '', stderr: '', durationMs: 1 });
  assert.match(silent.text, /\(no output\)/);
});

test('an oversized shell result is condensed and the full text is spilled and referenced', async () => {
  const stdout = Array.from({ length: 3000 }, (_, index) => (index === 1500 ? 'Error: kaboom in module x' : `progress ${index}`)).join('\n');
  const saved = [];
  const { text, condensed, omittedLines } = await shapeObservation(
    { command: 'build', code: 2, stdout, stderr: '', durationMs: 10 },
    { budget: 3000, spill: async (full) => { saved.push(full); return '.maskshift/outputs/r-1.txt'; } },
  );
  assert.equal(condensed, true);
  assert.ok(omittedLines > 2000);
  assert.ok(text.length < 3700, `was ${text.length}`);
  assert.match(text, /Error: kaboom in module x/);
  assert.match(text, /full output saved to \.maskshift\/outputs\/r-1\.txt/);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].includes('progress 2999'), 'the spill is complete');
});

test('an object with bulky text renders the text raw, not as an escaped JSON string', async () => {
  const content = Array.from({ length: 30 }, (_, index) => `     ${index + 1} | const a${index} = "q";`).join('\n');
  const { text } = await shapeObservation({ path: '/p/a.js', size: 900, totalLines: 30, content });
  assert.match(text, /^\{"path":"\/p\/a\.js"/);
  assert.match(text, /content:\n {5}1 \| const a0 = "q";/);
  assert.ok(!text.includes('\\n') && !text.includes('\\"'), 'no JSON escaping inside the file text');
});

test('long arrays are trimmed evenly with a count, and short results pass through unchanged', async () => {
  const entries = Array.from({ length: 5000 }, (_, index) => ({ path: `src/file-${index}.js`, size: index }));
  const { text, condensed } = await shapeObservation({ root: '.', entries }, { budget: 8000 });
  assert.equal(condensed, true);
  assert.ok(text.length <= 8000);
  assert.match(text, /more items/);
  const small = await shapeObservation({ a: 1, b: [1, 2] });
  assert.equal(small.text, '{"a":1,"b":[1,2]}');
  assert.equal(small.condensed, false);
});

test('plain strings and scalars are handled', async () => {
  assert.equal((await shapeObservation('hi')).text, 'hi');
  assert.equal((await shapeObservation(42)).text, '42');
  assert.equal((await shapeObservation(null)).text, 'null');
  assert.equal((await shapeObservation(undefined)).text, 'undefined');
});

test('a run sees a condensed build log and can recover the rest from the saved file', async (t) => {
  let turn = 0;
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    requests.push(await readJsonBody(request));
    turn += 1;
    const usage = { prompt_tokens: 5, completion_tokens: 2 };
    if (turn === 1) {
      const script = "for i in $(seq 1 4000); do echo \"compiling unit $i\"; done; echo 'Error: unresolved symbol frobnicate' >&2; exit 3";
      return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: script } }], finishReason: 'tool_calls', usage });
    }
    return respondOpenAIChatSSE(response, { content: 'seen', finishReason: 'stop', usage });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-obs:obs-model',
    maxToolOutputChars: 6000,
    providers: [{ id: 'fixture-obs', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'obs-model' }], timeoutMs: 15_000 }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'build it', modelRef: 'fixture-obs:obs-model' });
  await waitFor(async () => (['completed', 'failed', 'stagnated'].includes(runtime.store.getRun(run.id).status) ? true : null), { timeoutMs: 20_000, message: 'run completion' });
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.length < 7000, `the model saw ${toolMessage.content.length} chars, not the ~80k the command printed`);
  assert.match(toolMessage.content, /→ exit 3/);
  assert.match(toolMessage.content, /Error: unresolved symbol frobnicate/);
  const reference = toolMessage.content.match(/saved to (\.maskshift\/outputs\/[^;\s]+\.txt)/);
  assert.ok(reference, 'the result says where the full output is');
  const full = await fsp.readFile(path.join(project, reference[1]), 'utf8');
  assert.match(full, /compiling unit 4000/);
});

test('a file read that does not fit is cut at a line boundary with a pointer to where it continues, never gutted', async () => {
  const content = Array.from({ length: 400 }, (_, index) => `${String(index + 1).padStart(6)} | const value${index} = compute(${index}); // error handling elsewhere`).join('\n');
  const { text, condensed } = await shapeObservation({ path: '/p/big.js', size: 30000, totalLines: 400, startLine: 1, endLine: 400, content }, { budget: 4000 });
  assert.equal(condensed, true);
  assert.ok(text.length < 4300);
  assert.match(text, /showing \d+ of 400 lines; the file continues at line \d+ — read it with fs_read startLine=\d+/);
  const shown = [...text.matchAll(/^ {0,5}(\d+) \| /gm)].map((match) => Number(match[1]));
  assert.deepEqual(shown, shown.map((_, index) => index + 1), 'what is shown is one unbroken run from the first line');
  assert.ok(!/omitted/.test(text), 'no lines are silently dropped from the middle of the source');
  const next = Number(text.match(/continues at line (\d+)/)[1]);
  assert.equal(next, shown.length + 1);
});

test('a large diff keeps its start and end rather than lines that merely mention errors', async () => {
  const diff = Array.from({ length: 800 }, (_, index) => (index === 400 ? '+  throw new Error("boom");' : `+  line${index}();`)).join('\n');
  const { text } = await shapeObservation({ stat: false, diff }, { budget: 3000 });
  assert.match(text, /line0\(\)/);
  assert.match(text, /line799\(\)/);
  assert.ok(!/boom/.test(text), 'diffs are not error-hunted like logs');
});
