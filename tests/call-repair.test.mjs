import assert from 'node:assert/strict';
import test from 'node:test';
import { missingArgumentMessage, missingRequired, normalizeArgs, resolveToolName, signature } from '../src/agent/call-repair.mjs';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, waitFor } from './helpers.mjs';

const TOOLS = ['fs_read', 'fs_write', 'fs_patch', 'fs_list', 'shell_exec', 'search_text', 'search_files', 'git_diff', 'mcp__srv__lookup'];

test('resolveToolName leaves exact names alone and repairs spelling, case, aliases and namespaces', () => {
  assert.deepEqual(resolveToolName('fs_read', TOOLS), { name: 'fs_read', how: null });
  assert.equal(resolveToolName('FS_Read', TOOLS).name, 'fs_read');
  assert.equal(resolveToolName('fs-read', TOOLS).name, 'fs_read');
  assert.equal(resolveToolName('fsRead', TOOLS).name, 'fs_read');
  assert.equal(resolveToolName('read_file', TOOLS).name, 'fs_read');
  assert.equal(resolveToolName('bash', TOOLS).name, 'shell_exec');
  assert.equal(resolveToolName('str_replace', TOOLS).name, 'fs_patch');
  assert.equal(resolveToolName('functions.fs_list', TOOLS).name, 'fs_list');
  assert.equal(resolveToolName('shell_exe', TOOLS).name, 'shell_exec');
});

test('resolveToolName never invents a tool and never guesses an MCP tool', () => {
  const none = resolveToolName('launch_missiles', TOOLS);
  assert.equal(none.name, null);
  assert.ok(Array.isArray(none.suggestions));
  assert.equal(resolveToolName('mcp__srv__lookpu', TOOLS).name, null, 'MCP names must match exactly');
  assert.equal(resolveToolName('read_file', ['fs_write']).name, null, 'an alias only applies when its target exists');
});

test('resolveToolName refuses an ambiguous typo', () => {
  assert.equal(resolveToolName('search_fil', ['search_files', 'search_filez']).name, null);
});

const patchSchema = {
  type: 'object', required: ['path', 'edits'],
  properties: {
    path: { type: 'string' },
    edits: { type: 'array', items: { type: 'object', required: ['oldText', 'newText'], properties: { oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } } } },
  },
};

test('normalizeArgs renames aliased keys and leaves a correct call untouched', () => {
  const correct = { path: 'a.js', edits: [{ oldText: 'x', newText: 'y' }] };
  const same = normalizeArgs(correct, patchSchema);
  assert.deepEqual(same.args, correct);
  assert.deepEqual(same.repairs, []);

  const aliased = normalizeArgs({ file_path: 'a.js', edits: [{ old_string: 'x', new_string: 'y' }] }, patchSchema);
  assert.deepEqual(aliased.args, correct);
  assert.ok(aliased.repairs.length >= 3);
});

test('normalizeArgs hoists a flattened edit into the edits array', () => {
  const { args, repairs } = normalizeArgs({ path: 'a.js', old_string: 'x', new_string: 'y' }, patchSchema);
  assert.deepEqual(args, { path: 'a.js', edits: [{ oldText: 'x', newText: 'y' }] });
  assert.ok(repairs.some((entry) => entry.kind === 'wrap'));
});

test('normalizeArgs coerces scalar types, enums and JSON-encoded containers', () => {
  const schema = {
    type: 'object', required: ['n'],
    properties: { n: { type: 'integer' }, flag: { type: 'boolean' }, mode: { type: 'string', enum: ['create', 'append'] }, list: { type: 'array', items: { type: 'string' } }, label: { type: 'string' }, nested: { type: 'object', properties: { depth: { type: 'integer' } } } },
  };
  const { args } = normalizeArgs({ n: '5', flag: 'yes', mode: 'Append', list: '["a","b"]', label: 7, nested: '{"depth":"3"}' }, schema);
  assert.deepEqual(args, { n: 5, flag: true, mode: 'append', list: ['a', 'b'], label: '7', nested: { depth: 3 } });
  assert.deepEqual(normalizeArgs({ n: 2, list: 'one' }, schema).args, { n: 2, list: ['one'] });
  assert.equal(normalizeArgs({ n: null, label: 'x' }, schema).args.n, undefined, 'null means absent');
});

test('normalizeArgs accepts bare strings and JSON text for args, and tolerates junk', () => {
  const readSchema = { type: 'object', required: ['path'], properties: { path: { type: 'string' } } };
  assert.deepEqual(normalizeArgs('src/a.js', readSchema).args, { path: 'src/a.js' });
  assert.deepEqual(normalizeArgs('{"file":"src/a.js"}', readSchema).args, { path: 'src/a.js' });
  assert.deepEqual(normalizeArgs(null, readSchema).args, {});
  assert.deepEqual(normalizeArgs([1, 2], readSchema).args, {});
  assert.deepEqual(normalizeArgs({ x: 1 }, { type: 'object' }).args, { x: 1 });
});

test('normalizeArgs keeps unknown keys unless the schema forbids them', () => {
  const open = { type: 'object', properties: { path: { type: 'string' } } };
  assert.deepEqual(normalizeArgs({ path: 'a', extra: 1 }, open).args, { path: 'a', extra: 1 });
  const closed = { ...open, additionalProperties: false };
  assert.deepEqual(normalizeArgs({ path: 'a', extra: 1 }, closed).args, { path: 'a' });
});

test('missing required arguments produce a message a model can act on', () => {
  const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, maxBytes: { type: 'integer' } } };
  assert.deepEqual(missingRequired({}, schema), ['path']);
  assert.deepEqual(missingRequired({ path: 'a' }, schema), []);
  assert.equal(signature('fs_read', schema), 'fs_read(path: string, maxBytes?: integer)');
  assert.match(missingArgumentMessage('fs_read', schema, ['path'], { file: 'x' }), /required argument `path`.*received: `file`.*fs_read\(path: string/);
});

test('a run executes a misspelled tool with misnamed arguments instead of failing the turn', async (t) => {
  let turn = 0;
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    requests.push(await readJsonBody(request));
    turn += 1;
    if (turn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'read_file', args: { file_path: 'index.js', max_bytes: '4000' } }], finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 2 } });
    return respondOpenAIChatSSE(response, { content: 'Read it.', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-repair:repair-model',
    providers: [{ id: 'fixture-repair', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'repair-model' }], timeoutMs: 15_000 }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'read index.js', modelRef: 'fixture-repair:repair-model' });
  const finished = await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps', 'stagnated'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'run completion' });
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(requests.length, 2, 'no extra model turn was spent on repair');
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, 'the tool result reached the model');
  assert.match(toolMessage.content, /velocity/, 'the file was actually read');
  assert.match(toolMessage.content, /"read_file" is not a tool; ran `fs_read` instead/);
  const events = runtime.store.listRunEvents(run.id, 200).filter((event) => event.type === 'tool-call-repaired');
  assert.equal(events.length, 1);
  assert.ok(events[0].payload.repairs.some((entry) => /file_path/.test(entry.detail)));
});

test('a call with a required argument missing is rejected before it runs, with usage', async (t) => {
  let turn = 0;
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    requests.push(await readJsonBody(request));
    turn += 1;
    if (turn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_read', args: { wrong: 1 } }], finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 2 } });
    return respondOpenAIChatSSE(response, { content: 'ok', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-repair:repair-model',
    providers: [{ id: 'fixture-repair', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'repair-model' }], timeoutMs: 15_000 }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'go', modelRef: 'fixture-repair:repair-model' });
  await waitFor(async () => (['completed', 'failed'].includes(runtime.store.getRun(run.id).status) ? true : null), { timeoutMs: 15_000, message: 'run completion' });
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /required argument `path`/);
  assert.match(toolMessage.content, /fs_read\(path: string/);
});
