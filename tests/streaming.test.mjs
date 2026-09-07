import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject, runtimeForTest, jsonServer, readJsonBody } from './helpers.mjs';

// Serve a scripted SSE (or NDJSON) body so the reader is exercised against real chunk
// boundaries rather than one tidy write.
function streamServer(t, frames, { contentType = 'text/event-stream', sse = true } = {}) {
  const seen = { bodies: [], urls: [] };
  return jsonServer(t, async (request, response) => {
    seen.urls.push(request.url);
    seen.bodies.push(await readJsonBody(request).catch(() => null));
    response.writeHead(200, { 'Content-Type': contentType });
    for (const frame of frames) {
      response.write(sse ? `data: ${JSON.stringify(frame)}\n\n` : `${JSON.stringify(frame)}\n`);
    }
    if (sse) response.write('data: [DONE]\n\n');
    response.end();
  }).then((server) => ({ ...server, seen }));
}

async function providerRuntime(t, server, type, extra = {}) {
  const project = await createProject(t, { git: false });
  return runtimeForTest(t, project, {
    defaultModel: 'fixture:local',
    providers: [{
      id: 'fixture', name: 'Fixture', type, baseUrl: server.url, apiKey: 'test-key',
      apiKeyEnv: null, enabled: true, models: [{ id: 'local' }], timeoutMs: 5000, ...extra,
    }],
  });
}

function collect() {
  const deltas = [];
  return { deltas, onDelta: (text) => deltas.push(text) };
}

const ask = (runtime, onDelta, tools = []) => runtime.providerManager.complete({
  modelRef: 'fixture:local', messages: [{ role: 'user', content: 'ping' }], tools, maxTokens: 64, onDelta,
});

test('provider streaming', { timeout: 30_000 }, async (suite) => {
  await suite.test('openai-compatible streams text and assembles split tool-call arguments', async (t) => {
    const server = await streamServer(t, [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs_read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]);
    const runtime = await providerRuntime(t, server, 'openai-compatible');
    const { deltas, onDelta } = collect();
    const result = await ask(runtime, onDelta);

    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(result.content, 'Hello');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3 });
    assert.equal(result.streamed, true);
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'fs_read', args: { path: 'a.txt' } }]);
    assert.equal(server.seen.bodies[0].stream, true);
  });

  await suite.test('openai-responses streams text and function-call arguments', async (t) => {
    const server = await streamServer(t, [
      { type: 'response.output_text.delta', delta: 'one ' },
      { type: 'response.output_text.delta', delta: 'two' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'fc_1', name: 'shell_exec' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"command":"ls"}' },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 4 } } },
    ]);
    const runtime = await providerRuntime(t, server, 'openai-responses');
    const { deltas, onDelta } = collect();
    const result = await ask(runtime, onDelta);

    assert.deepEqual(deltas, ['one ', 'two']);
    assert.equal(result.content, 'one two');
    assert.equal(result.finishReason, 'completed');
    assert.deepEqual(result.toolCalls, [{ id: 'fc_1', name: 'shell_exec', args: { command: 'ls' } }]);
  });

  await suite.test('anthropic streams text deltas and input_json_delta tool arguments', async (t) => {
    const server = await streamServer(t, [
      { type: 'message_start', message: { usage: { input_tokens: 11 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thinking' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'fs_write' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"b.txt"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    ]);
    const runtime = await providerRuntime(t, server, 'anthropic');
    const { deltas, onDelta } = collect();
    const result = await ask(runtime, onDelta);

    assert.deepEqual(deltas, ['thinking']);
    assert.equal(result.content, 'thinking');
    assert.equal(result.finishReason, 'tool_use');
    assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 9 });
    assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'fs_write', args: { path: 'b.txt' } }]);
  });

  await suite.test('ollama streams newline-delimited JSON', async (t) => {
    const server = await streamServer(t, [
      { message: { content: 'aa' }, done: false },
      { message: { content: 'bb' }, done: false },
      { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 },
    ], { contentType: 'application/x-ndjson', sse: false });
    const runtime = await providerRuntime(t, server, 'ollama');
    const { deltas, onDelta } = collect();
    const result = await ask(runtime, onDelta);

    assert.deepEqual(deltas, ['aa', 'bb']);
    assert.equal(result.content, 'aabb');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.input_tokens, 5);
  });

  await suite.test('gemini streams over the SSE endpoint', async (t) => {
    const server = await streamServer(t, [
      { candidates: [{ content: { parts: [{ text: 'gem' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'ini' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 12 } },
    ]);
    const runtime = await providerRuntime(t, server, 'gemini');
    const { deltas, onDelta } = collect();
    const result = await ask(runtime, onDelta);

    assert.deepEqual(deltas, ['gem', 'ini']);
    assert.equal(result.content, 'gemini');
    assert.equal(result.finishReason, 'STOP');
    // Streaming must hit :streamGenerateContent with alt=sse, not the unary endpoint.
    assert.match(server.seen.urls[0], /:streamGenerateContent\?alt=sse/);
  });

  await suite.test('an SSE frame split across chunk boundaries is still parsed', async (t) => {
    const chunks = ['data: {"choices":[{"del', 'ta":{"content":"split"}}]}\n', '\ndata: [DONE]\n\n'];
    const server = await jsonServer(t, (request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    const runtime = await providerRuntime(t, server, 'openai-compatible');
    const { deltas, onDelta } = collect();
    assert.equal((await ask(runtime, onDelta)).content, 'split');
    assert.deepEqual(deltas, ['split']);
  });

  await suite.test('no onDelta means the non-streaming path, byte for byte', async (t) => {
    const seen = [];
    const server = await jsonServer(t, async (request, response) => {
      seen.push(await readJsonBody(request));
      const body = JSON.stringify({ choices: [{ message: { content: 'unary' }, finish_reason: 'stop' }] });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    });
    const runtime = await providerRuntime(t, server, 'openai-compatible');
    assert.equal((await ask(runtime, null)).content, 'unary');
    assert.equal(seen[0].stream, undefined);
  });

  await suite.test('streaming: false on a provider falls back to the unary endpoint', async (t) => {
    const seen = [];
    const server = await jsonServer(t, async (request, response) => {
      seen.push(await readJsonBody(request));
      const body = JSON.stringify({ choices: [{ message: { content: 'unary' } }] });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    });
    const runtime = await providerRuntime(t, server, 'openai-compatible', { streaming: false });
    const { deltas, onDelta } = collect();
    assert.equal((await ask(runtime, onDelta)).content, 'unary');
    assert.equal(deltas.length, 0);
    assert.equal(seen[0].stream, undefined);
  });

  // Proxies and older local servers accept `stream: true` and answer with one JSON body
  // anyway. Reading that as a stream finds no frames and yields a silently empty turn.
  await suite.test('an endpoint that ignores stream:true is parsed as a unary body', async (t) => {
    const server = await jsonServer(t, (request, response) => {
      const body = JSON.stringify({
        choices: [{ message: { content: 'ignored the stream flag', tool_calls: [{ id: 'c1', function: { name: 'fs_read', arguments: '{"path":"z"}' } }] }, finish_reason: 'stop' }],
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    });
    const runtime = await providerRuntime(t, server, 'openai-compatible');
    const { deltas, onDelta } = collect();
    const result = await ask(runtime, onDelta);

    assert.equal(result.content, 'ignored the stream flag');
    assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'fs_read', args: { path: 'z' } }]);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(deltas, [], 'nothing streamed, so no deltas should be reported');
  });

  await suite.test('a non-JSON body on the streaming path reports the endpoint, not an empty turn', async (t) => {
    const server = await jsonServer(t, (request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>502 from a proxy</html>');
    });
    const runtime = await providerRuntime(t, server, 'openai-compatible');
    await assert.rejects(ask(runtime, collect().onDelta), /ignored the streaming request/);
  });

  await suite.test('a stream that fails before its first token is still retried', async (t) => {
    let attempts = 0;
    const server = await jsonServer(t, (request, response) => {
      attempts += 1;
      if (attempts === 1) { respondFailure(response); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'after-retry' } }] })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
    function respondFailure(response) {
      const body = JSON.stringify({ error: { message: 'overloaded' } });
      response.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    }
    const project = await createProject(t, { git: false });
    const runtime = await runtimeForTest(t, project, {
      defaultModel: 'fixture:local',
      providerRetry: { attempts: 3, baseMs: 1, maxMs: 4 },
      providers: [{
        id: 'fixture', type: 'openai-compatible', baseUrl: server.url, apiKeyEnv: null,
        enabled: true, models: [{ id: 'local' }], timeoutMs: 5000,
      }],
    });
    const { deltas, onDelta } = collect();
    assert.equal((await ask(runtime, onDelta)).content, 'after-retry');
    assert.equal(attempts, 2);
    // The retry happened before any token reached the caller, so nothing was shown twice.
    assert.deepEqual(deltas, ['after-retry']);
  });
});
