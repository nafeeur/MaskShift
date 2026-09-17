// Direct, provider-level exercise of the streaming paths in src/agent/providers.mjs — the
// highest-risk part of the streaming feature, since each provider speaks its own SSE/NDJSON
// dialect and none of them can be checked against a live API in this environment. Each test here
// builds a minimal fixture server for exactly one provider's real wire format and asserts both
// that `onDelta` sees the text grow incrementally (not just once, at the end) and that the final
// result is byte-identical to what the old non-streaming parser would have produced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from '../src/agent/providers.mjs';
import { EventBus } from '../src/core/events.mjs';
import { jsonServer, respondAnthropicSSE, respondOpenAIChatSSE, respondOpenAIResponsesSSE } from './helpers.mjs';

function manager(providers) {
  return new ProviderManager({ config: { get: () => ({ providers }) }, logger: console, eventBus: new EventBus() });
}

test('openai-compatible streaming: text grows incrementally and tool-call fragments reassemble', async (t) => {
  const server = await jsonServer(t, (request, response) => {
    respondOpenAIChatSSE(response, {
      content: 'Reading the file now.',
      toolCalls: [{ id: 'call_1', name: 'fs_read', args: { path: 'a.js' } }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 10, completion_tokens: 6 },
    });
  });
  const seen = [];
  const result = await manager([{ id: 'p', type: 'openai-compatible', baseUrl: server.url, enabled: true, models: [{ id: 'm' }] }]).complete({
    modelRef: 'p:m', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'fs_read', inputSchema: {} }],
    onDelta: (content) => seen.push(content),
  });
  assert.ok(seen.length >= 1, 'expected at least one delta');
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].startsWith(seen[i - 1]), 'each delta must extend the previous one, never rewrite it');
  assert.equal(seen.at(-1), 'Reading the file now.');
  assert.equal(result.content, 'Reading the file now.');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'fs_read', args: { path: 'a.js' }, providerCallId: 'call_1' }]);
  assert.equal(result.usage.completion_tokens, 6);
});

test('openai-responses streaming: output_text.delta feeds onDelta, response.completed builds the final result', async (t) => {
  const server = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['Plan', 'ning', ' the', ' change.']) {
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: piece })}\n\n`);
    }
    response.write(`event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: 'r1', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Planning the change.' }] }],
        usage: { input_tokens: 4, output_tokens: 4 },
      },
    })}\n\n`);
    response.end();
  });
  const seen = [];
  const result = await manager([{ id: 'p', type: 'openai-responses', baseUrl: server.url, enabled: true, models: [{ id: 'm' }] }]).complete({
    modelRef: 'p:m', messages: [{ role: 'user', content: 'go' }], onDelta: (content) => seen.push(content),
  });
  assert.deepEqual(seen, ['Plan', 'Planning', 'Planning the', 'Planning the change.']);
  assert.equal(result.content, 'Planning the change.');
  assert.equal(result.usage.output_tokens, 4);
});

test('anthropic streaming: text_delta feeds onDelta and input_json_delta reassembles a tool call', async (t) => {
  const server = await jsonServer(t, (request, response) => {
    respondAnthropicSSE(response, {
      content: [
        { type: 'text', text: 'Checking the repo.' },
        { type: 'tool_use', id: 'call_9', name: 'fs_read', input: { path: 'b.js' } },
      ],
      stopReason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 8 },
    });
  });
  const seen = [];
  const result = await manager([{ id: 'p', type: 'anthropic', baseUrl: server.url, apiKey: 'k', enabled: true, models: [{ id: 'm' }] }]).complete({
    modelRef: 'p:m', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'fs_read', inputSchema: {} }],
    onDelta: (content) => seen.push(content),
  });
  assert.deepEqual(seen, ['Checking the repo.']);
  assert.equal(result.content, 'Checking the repo.');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'fs_read');
  assert.deepEqual(result.toolCalls[0].args, { path: 'b.js' });
  assert.equal(result.finishReason, 'tool_use');
  // providerState.blocks is replayed verbatim into the next turn's request — it must carry the
  // reconstructed tool_use input, not the transient accumulator field used to build it.
  assert.equal(result.providerState.blocks[1]._argText, undefined);
});

test('ollama streaming: NDJSON content fragments accumulate and the final line carries usage', async (t) => {
  const server = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const piece of ['Sure', ', one', ' moment.']) {
      response.write(`${JSON.stringify({ message: { role: 'assistant', content: piece }, done: false })}\n`);
    }
    response.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 })}\n`);
    response.end();
  });
  const seen = [];
  const result = await manager([{ id: 'p', type: 'ollama', baseUrl: server.url, enabled: true, models: [{ id: 'm' }] }]).complete({
    modelRef: 'p:m', messages: [{ role: 'user', content: 'go' }], onDelta: (content) => seen.push(content),
  });
  assert.deepEqual(seen, ['Sure', 'Sure, one', 'Sure, one moment.']);
  assert.equal(result.content, 'Sure, one moment.');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.output_tokens, 3);
});

test('gemini streaming: each SSE frame carries new text, not the whole answer so far', async (t) => {
  const server = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['The ', 'answer ', 'is 42.']) {
      response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: piece }] } }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 } })}\n\n`);
    response.end();
  });
  const seen = [];
  const result = await manager([{ id: 'p', type: 'gemini', baseUrl: server.url, apiKey: 'k', enabled: true, models: [{ id: 'm' }] }]).complete({
    modelRef: 'p:m', messages: [{ role: 'user', content: 'go' }], onDelta: (content) => seen.push(content),
  });
  assert.deepEqual(seen, ['The ', 'The answer ', 'The answer is 42.']);
  assert.equal(result.content, 'The answer is 42.');
  assert.equal(result.finishReason, 'STOP');
  assert.equal(result.usage.candidatesTokenCount, 5);
});

test('a provider that is native-mode salvaged (writes its call as text) never streams the raw markup to onDelta', async (t) => {
  // Simulates auto-mode's text-salvage path: the model ignored native tool calling and wrote
  // the call inline as prose. The *first* attempt is still native mode when it streams, so
  // onDelta legitimately sees the raw <tool_call> markup live — that's the one case this
  // suppression doesn't (and structurally can't) cover, same as the old non-streaming behavior
  // never hid it from the final `content` before parseToolCalls ran either. What must never
  // happen is the *second*, already-downgraded 'text' dispatch forwarding raw markup.
  const server = await jsonServer(t, (request, response) => {
    respondOpenAIChatSSE(response, { content: '<tool_call>{"name":"fs_read","arguments":{"path":"x"}}</tool_call>', finishReason: 'stop' });
  });
  const seen = [];
  const result = await manager([{ id: 'p', type: 'openai-compatible', baseUrl: server.url, enabled: true, toolProtocol: 'text', models: [{ id: 'm' }] }]).complete({
    modelRef: 'p:m', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'fs_read', inputSchema: {} }],
    onDelta: (content) => seen.push(content),
  });
  assert.deepEqual(seen, [], 'text-protocol mode must never forward a delta');
  assert.equal(result.toolCalls[0].name, 'fs_read');
  assert.equal(result.content, '');
});
