import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseToolCalls, renderToolInstructions, toTextProtocolMessages } from '../src/agent/tool-protocol.mjs';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest } from './helpers.mjs';

const TOOLS = [{
  name: 'fs_read', description: 'Read a file',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
}];

/** A model with no native tool calling: it ignores `tools` and only ever replies in prose. */
function scriptedModel(t, script, { failOnTools = false } = {}) {
  const seen = { requests: [], turn: 0 };
  const server = jsonServer(t, async (request, response) => {
    const body = await readJsonBody(request);
    seen.requests.push(body);
    if (failOnTools && body.tools?.length) {
      respondJson(response, 400, { error: { message: 'This model does not support tools' } });
      return;
    }
    const content = script[Math.min(seen.turn, script.length - 1)];
    seen.turn += 1;
    respondJson(response, 200, {
      id: 'chatcmpl-test', object: 'chat.completion', model: 'small-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
  });
  return { seen, server };
}

async function textProtocolRuntime(t, project, url, overrides = {}) {
  return runtimeForTest(t, project, {
    defaultModel: 'small:small-model',
    providers: [{
      id: 'small', name: 'Small model', type: 'openai', baseUrl: `${url}/v1`, apiKeyEnv: null,
      enabled: true, autoDiscover: false, models: [{ id: 'small-model' }], timeoutMs: 15_000,
      ...overrides,
    }],
  });
}

test('the text protocol parser survives the output small models actually produce', () => {
  const variants = [
    ['canonical', '<tool_call>{"name":"fs_read","arguments":{"path":"a.js"}}</tool_call>'],
    ['wrapped in prose', 'Let me look.\n<tool_call>{"name":"fs_read","arguments":{"path":"a.js"}}</tool_call>\nStandby.'],
    ['single quotes', "<tool_call>{'name':'fs_read','arguments':{'path':'a.js'}}</tool_call>"],
    ['unquoted keys', '<tool_call>{name:"fs_read",arguments:{path:"a.js"}}</tool_call>'],
    ['trailing comma', '<tool_call>{"name":"fs_read","arguments":{"path":"a.js",}}</tool_call>'],
    ['double-encoded arguments', '<tool_call>{"name":"fs_read","arguments":"{\\"path\\":\\"a.js\\"}"}</tool_call>'],
    ['arguments flattened onto the call', '<tool_call>{"name":"fs_read","path":"a.js"}</tool_call>'],
    ['key aliases', '<tool_call>{"tool":"fs_read","parameters":{"path":"a.js"}}</tool_call>'],
    ['function_call tag', '<function_call>{"name":"fs_read","arguments":{"path":"a.js"}}</function_call>'],
    ['fenced block', '```tool_call\n{"name":"fs_read","arguments":{"path":"a.js"}}\n```'],
    ['json fence nested in the tag', '<tool_call>\n```json\n{"name":"fs_read","arguments":{"path":"a.js"}}\n```\n</tool_call>'],
    ['truncated closing tag', '<tool_call>{"name":"fs_read","arguments":{"path":"a.js"}}'],
    ['name carried on the attribute', '<tool_call name="fs_read">{"path":"a.js"}</tool_call>'],
    ['uppercase tag', '<TOOL_CALL>{"name":"fs_read","arguments":{"path":"a.js"}}</TOOL_CALL>'],
    ['prose trailing the json', '<tool_call>{"name":"fs_read","arguments":{"path":"a.js"}} that should do it</tool_call>'],
  ];

  for (const [label, input] of variants) {
    const { toolCalls } = parseToolCalls(input);
    assert.equal(toolCalls.length, 1, `${label}: expected one call`);
    assert.equal(toolCalls[0].name, 'fs_read', `${label}: wrong tool name`);
    assert.deepEqual(toolCalls[0].args, { path: 'a.js' }, `${label}: wrong arguments`);
  }

  const python = parseToolCalls('<tool_call>{"name":"fs_list","arguments":{"includeHidden":True,"path":None}}</tool_call>');
  assert.deepEqual(python.toolCalls[0].args, { includeHidden: true, path: null });

  const parallel = parseToolCalls('<tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>');
  assert.deepEqual(parallel.toolCalls.map((call) => call.name), ['a', 'b']);

  // The call syntax must never leak into the user-visible answer.
  assert.equal(parseToolCalls('Here goes.\n<tool_call>{"name":"a","arguments":{}}</tool_call>').content, 'Here goes.');
});

test('the text protocol parser does not invent calls out of ordinary text', () => {
  for (const prose of [
    'I read the file and it exports a velocity function. No tools needed.',
    '{"result": 42, "status": "ok"}',
    'Use the fs_read tool when you need file contents.',
  ]) {
    const parsed = parseToolCalls(prose);
    assert.equal(parsed.toolCalls.length, 0, `treated as a call: ${prose}`);
    assert.equal(parsed.parseErrors.length, 0);
  }

  // Something call-shaped but unusable must be reported, never silently dropped.
  const broken = parseToolCalls('<tool_call>totally not json at all</tool_call>');
  assert.equal(broken.toolCalls.length, 0);
  assert.equal(broken.parseErrors.length, 1);
});

test('text protocol history uses only plain chat roles', () => {
  const converted = toTextProtocolMessages([
    { role: 'system', content: 'Base prompt.' },
    { role: 'user', content: 'Read a.js' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'fs_list', args: { path: '.' } }] },
    { role: 'tool', toolCallId: 't1', toolName: 'fs_list', content: 'a.js', isError: false },
    { role: 'tool', toolCallId: 't2', toolName: 'fs_stat', content: '12 bytes', isError: false },
  ], TOOLS);

  // Providers without tool support reject the `tool` role outright.
  assert.deepEqual([...new Set(converted.map((message) => message.role))], ['system', 'user', 'assistant']);
  assert.match(converted[0].content, /Base prompt\./);
  assert.match(converted[0].content, /<tool_call>/);
  assert.match(converted[2].content, /"name":"fs_list"/);
  // Consecutive results merge: many chat templates reject back-to-back user turns.
  const responseTurns = converted.filter((message) => message.role !== 'system' && message.content.includes('<tool_response'));
  assert.equal(responseTurns.length, 1);
  assert.match(converted[3].content, /fs_stat/);

  const instructions = renderToolInstructions(TOOLS);
  assert.match(instructions, /fs_read/);
  assert.match(instructions, /path \(string, required\)/);
});

test('a model with no native tool calling still completes a multi-step task', async (t) => {
  const project = await createProject(t);
  const { seen, server } = scriptedModel(t, [
    '<tool_call>{"name":"fs_write","arguments":{"path":"report.txt","content":"DONE"}}</tool_call>',
    'Verifying.\n<tool_call>{"name":"fs_read","arguments":{"path":"report.txt"}}</tool_call>',
    'report.txt contains DONE. Task complete.',
  ]);
  const runtime = await textProtocolRuntime(t, project, (await server).url, { toolProtocol: 'text' });

  const session = runtime.engine.createSession({ workspaceId: (await runtime.workspaceManager.open(project)).id });
  const started = await runtime.engine.startRun({
    sessionId: session.id, prompt: 'Create report.txt containing DONE, then confirm it.', modelRef: 'small:small-model',
  });
  const run = await runtime.engine.waitForRun(started.id);

  assert.equal(run.status, 'completed');
  assert.equal(await fsp.readFile(path.join(project, 'report.txt'), 'utf8'), 'DONE');

  const executed = runtime.store.listMessages(session.id).filter((message) => message.role === 'tool');
  assert.deepEqual(executed.map((message) => message.meta.toolName), ['fs_write', 'fs_read']);

  // Tools travel in the prompt, never on the wire, so endpoints that reject a tools field work.
  assert.ok(seen.requests.every((request) => !request.tools?.length));
  assert.match(String(seen.requests[0].messages.find((message) => message.role === 'system').content), /<tool_call>/);
});

test('a malformed tool call is corrected instead of silently ending the run', async (t) => {
  const project = await createProject(t);
  const { server } = scriptedModel(t, [
    '<tool_call>this is not json</tool_call>',
    '<tool_call>{"name":"fs_write","arguments":{"path":"fixed.txt","content":"OK"}}</tool_call>',
    'Recovered and wrote the file.',
  ]);
  const runtime = await textProtocolRuntime(t, project, (await server).url, { toolProtocol: 'text' });

  const session = runtime.engine.createSession({ workspaceId: (await runtime.workspaceManager.open(project)).id });
  const started = await runtime.engine.startRun({ sessionId: session.id, prompt: 'Write fixed.txt', modelRef: 'small:small-model' });
  const run = await runtime.engine.waitForRun(started.id);

  assert.equal(run.status, 'completed');
  assert.equal(await fsp.readFile(path.join(project, 'fixed.txt'), 'utf8'), 'OK');

  const repairs = runtime.store.listMessages(session.id).filter((message) => message.meta?.toolCallRepair);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0].content, /could not be parsed/);
});

test('auto mode downgrades to the text protocol when an endpoint rejects tools', async (t) => {
  const project = await createProject(t);
  const { seen, server } = scriptedModel(t, [
    '<tool_call>{"name":"fs_write","arguments":{"path":"auto.txt","content":"OK"}}</tool_call>',
    'Done.',
  ], { failOnTools: true });
  // No toolProtocol set: the default 'auto' must recover on its own.
  const runtime = await textProtocolRuntime(t, project, (await server).url);

  const session = runtime.engine.createSession({ workspaceId: (await runtime.workspaceManager.open(project)).id });
  const started = await runtime.engine.startRun({ sessionId: session.id, prompt: 'Write auto.txt', modelRef: 'small:small-model' });
  const run = await runtime.engine.waitForRun(started.id);

  assert.equal(run.status, 'completed');
  assert.equal(await fsp.readFile(path.join(project, 'auto.txt'), 'utf8'), 'OK');
  // First attempt probes natively, then every later request drops the tools field.
  assert.ok(seen.requests[0].tools?.length > 0);
  assert.ok(seen.requests.slice(1).every((request) => !request.tools?.length));
});

test('auto mode salvages a native-protocol model that writes its call as text', async (t) => {
  const project = await createProject(t);
  const { server } = scriptedModel(t, [
    '<tool_call>{"name":"fs_write","arguments":{"path":"salvaged.txt","content":"OK"}}</tool_call>',
    'Done.',
  ]);
  const runtime = await textProtocolRuntime(t, project, (await server).url);

  const session = runtime.engine.createSession({ workspaceId: (await runtime.workspaceManager.open(project)).id });
  const started = await runtime.engine.startRun({ sessionId: session.id, prompt: 'Write salvaged.txt', modelRef: 'small:small-model' });
  const run = await runtime.engine.waitForRun(started.id);

  assert.equal(run.status, 'completed');
  assert.equal(await fsp.readFile(path.join(project, 'salvaged.txt'), 'utf8'), 'OK');
});

test('the lazy capability fabric works over the text protocol', async (t) => {
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'notes.txt'), 'alpha beta gamma\n');
  const { seen, server } = scriptedModel(t, [
    '<tool_call>{"name":"capability_search","arguments":{"query":"inspect a sqlite database"}}</tool_call>',
    '<tool_call>{"name":"capability_activate","arguments":{"names":["sqlite_schema","debugging"],"kind":"auto"}}</tool_call>',
    'Activated the database tooling.',
  ]);
  const runtime = await textProtocolRuntime(t, project, (await server).url, { toolProtocol: 'text' });

  const session = runtime.engine.createSession({ workspaceId: (await runtime.workspaceManager.open(project)).id });
  const started = await runtime.engine.startRun({ sessionId: session.id, prompt: 'Summarise notes.txt for me.', modelRef: 'small:small-model' });
  const run = await runtime.engine.waitForRun(started.id);

  assert.equal(run.status, 'completed');
  const executed = runtime.store.listMessages(session.id).filter((message) => message.role === 'tool');
  assert.deepEqual(executed.map((message) => message.meta.toolName), ['capability_search', 'capability_activate']);

  // The rendered catalog must grow once the model activates something new, or lazy loading
  // would be invisible to a text-protocol model.
  const systemAt = (turn) => String(seen.requests[turn].messages.find((message) => message.role === 'system').content);
  assert.ok(!systemAt(0).includes('\n  sqlite_schema:'));
  assert.ok(systemAt(2).includes('\n  sqlite_schema:'));
  assert.match(systemAt(2), /<skill name="debugging"/);
});
