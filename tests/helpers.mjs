import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/core/utils.mjs';
import { createRuntime } from '../src/runtime.mjs';

export async function tempDir(t, prefix = 'maskshift-test-') {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t?.after(async () => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function createProject(t, { git = true } = {}) {
  const root = await tempDir(t, 'maskshift-project-');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  await fsp.writeFile(path.join(root, 'index.js'), 'export function velocity(distance, time) { return distance / time; }\n');
  await fsp.writeFile(path.join(root, 'AGENTS.md'), '# Fixture instructions\n\nKeep verification deterministic.\n');
  if (git) {
    assert.equal((await runCommand('git init -q', { cwd: root })).code, 0);
    assert.equal((await runCommand('git config user.email maskshift@example.invalid && git config user.name MaskShift', { cwd: root })).code, 0);
    assert.equal((await runCommand('git add . && git commit -qm initial', { cwd: root })).code, 0);
  }
  return root;
}

export async function runtimeForTest(t, workspacePath, overrides = {}) {
  const home = await tempDir(t, 'maskshift-home-');
  const runtime = await createRuntime({
    configPath: path.join(home, 'config.json'),
    workspacePath,
    configOverrides: {
      home,
      autoIndex: false,
      autoCheckpoint: false,
      commandTimeoutMs: 20_000,
      automations: { enabled: false, pollIntervalMs: 10_000, maxPerTick: 2 },
      ...overrides,
    },
  });
  t?.after(async () => runtime.close());
  return runtime;
}

export async function jsonServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t?.after(async () => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, port: address.port };
}

export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

export function respondJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

/**
 * Writes a `text/event-stream` response from a list of frames, each `{ event, data }` (`data` is
 * JSON-stringified unless already a string, so a caller can pass `'[DONE]'` verbatim for OpenAI's
 * sentinel). Mirrors what a real provider's streaming endpoint sends, so fixtures exercise the
 * same SSE-parsing path production traffic does rather than a shortcut that only looks similar.
 */
export function respondSSE(response, frames, headers = {}) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...headers });
  for (const frame of frames) {
    const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
    if (frame.event && frame.event !== 'message') response.write(`event: ${frame.event}\n`);
    response.write(`data: ${data}\n\n`);
  }
  response.end();
}

/** Writes a newline-delimited-JSON response (Ollama's streaming format). */
export function respondNDJSON(response, lines, headers = {}) {
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson', ...headers });
  for (const line of lines) response.write(`${JSON.stringify(line)}\n`);
  response.end();
}

/**
 * An OpenAI-compatible `/chat/completions` streaming response built from the same shape a
 * fixture would otherwise hand `respondJson` — one content string, a list of finished tool
 * calls, a finish reason, and optional usage — turned into the delta/tool_calls chunk sequence
 * the real streaming endpoint sends, terminated by the `[DONE]` sentinel.
 */
export function respondOpenAIChatSSE(response, { content = '', toolCalls = [], finishReason = 'stop', usage = null } = {}) {
  const frames = [];
  if (content) frames.push({ data: { choices: [{ index: 0, delta: { content }, finish_reason: null }] } });
  toolCalls.forEach((call, index) => {
    frames.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] } });
    frames.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args ?? call.arguments ?? {}) } }] }, finish_reason: null }] } });
  });
  frames.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(usage ? { usage } : {}) } });
  frames.push({ data: '[DONE]' });
  respondSSE(response, frames);
}

/**
 * An OpenAI Responses API streaming response carrying just a final `response.completed` frame
 * with the given `output` — enough for a fixture that doesn't care about live text deltas, only
 * about the finished result `#openAiResponses` assembles from that event.
 */
export function respondOpenAIResponsesSSE(response, output, { id = 'fixture', status = 'completed', extra = {} } = {}) {
  respondSSE(response, [{ event: 'response.completed', data: { response: { id, status, output, ...extra } } }]);
}

/**
 * An Anthropic `/messages` streaming response built from the same `content` blocks, `stop_reason`
 * and `usage` a fixture would otherwise hand `respondJson`, turned into the message_start,
 * content_block_start/delta/stop (one triple per block), message_delta and message_stop event
 * sequence the real streaming endpoint sends.
 */
export function respondAnthropicSSE(response, { id = 'msg_fixture', content = [], stopReason = null, usage = {} } = {}) {
  const frames = [{ event: 'message_start', data: { message: { id, type: 'message', role: 'assistant', content: [], usage } } }];
  content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      frames.push({ event: 'content_block_start', data: { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } } });
      frames.push({ event: 'content_block_delta', data: { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } } });
    } else {
      frames.push({ event: 'content_block_start', data: { index, content_block: { type: 'text', text: '' } } });
      frames.push({ event: 'content_block_delta', data: { index, delta: { type: 'text_delta', text: block.text || '' } } });
    }
    frames.push({ event: 'content_block_stop', data: { index } });
  });
  frames.push({ event: 'message_delta', data: { delta: { stop_reason: stopReason }, usage } });
  frames.push({ event: 'message_stop', data: {} });
  respondSSE(response, frames);
}

export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 40, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
}
