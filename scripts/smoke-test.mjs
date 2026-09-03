import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
import { startServer } from '../src/server.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-smoke-'));
const home = path.join(temp, 'home');
const workspace = path.join(temp, 'workspace');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(path.join(workspace, 'package.json'), '{"name":"maskshift-smoke","scripts":{"test":"node test.mjs"}}\n');
await fsp.writeFile(path.join(workspace, 'test.mjs'), "import assert from 'node:assert/strict'; import fsp from 'node:fs/promises'; assert.equal(await fsp.readFile('smoke-agent.txt','utf8'),'MASKSHIFT_SMOKE_OK\\n');\n");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
function json(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  response.end(data);
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function request(url, route, options = {}) {
  const response = await fetch(`${url}${route}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}: ${text}`);
  return data;
}

let turns = 0;
const modelServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { data: [{ id: 'smoke-coder' }] });
  if (req.method === 'POST' && req.url === '/v1/responses') {
    const input = await body(req);
    turns += 1;
    assert.equal(input.model, 'smoke-coder');
    assert.ok(input.tools.some((tool) => tool.name === 'fs_write'));
    if (!input.input.some((item) => item.type === 'function_call_output')) {
      return json(res, 200, {
        id: 'smoke_tool', status: 'completed',
        output: [{ type: 'function_call', id: 'fc_smoke', call_id: 'call_smoke', name: 'fs_write', arguments: JSON.stringify({ path: 'smoke-agent.txt', content: 'MASKSHIFT_SMOKE_OK\n' }) }],
      });
    }
    return json(res, 200, {
      id: 'smoke_final', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Smoke artifact created and verified.' }] }],
    });
  }
  json(res, 404, { error: { message: 'not found' } });
});

const modelPort = await listen(modelServer);
let runtime;
let daemon;
try {
  runtime = await createRuntime({
    workspacePath: workspace,
    configOverrides: {
      home, autoIndex: false, autoOpen: false, autoCheckpoint: false,
      defaultModel: 'smoke:smoke-coder',
      providers: [{
        id: 'smoke', name: 'Smoke model', type: 'openai-responses',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKeyEnv: null,
        enabled: true, autoDiscover: true, models: [{ id: 'smoke-coder' }], timeoutMs: 15_000,
      }],
    },
  });
  daemon = await startServer(runtime, { host: '127.0.0.1', port: 0, autoOpen: false });
  const health = await request(daemon.url, '/api/health');
  assert.equal(health.ok, true);
  const state = await request(daemon.url, '/api/state');
  assert.ok(state.toolCount >= 143);
  assert.ok(state.skills.length >= 36);

  const opened = await request(daemon.url, '/api/workspaces', { method: 'POST', body: { path: workspace, index: false } });
  const run = await request(daemon.url, '/api/runs', {
    method: 'POST',
    body: { workspaceId: opened.id, prompt: 'Create smoke-agent.txt with the exact requested marker.', modelRef: 'smoke:smoke-coder' },
  });

  let complete;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    complete = await request(daemon.url, `/api/runs/${run.id}`);
    if (['completed', 'failed', 'cancelled', 'max_steps'].includes(complete.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(complete?.status, 'completed', complete?.error || 'run did not complete');
  assert.equal(turns, 2);
  assert.equal(await fsp.readFile(path.join(workspace, 'smoke-agent.txt'), 'utf8'), 'MASKSHIFT_SMOKE_OK\n');

  const shell = await request(daemon.url, '/api/terminal/exec', { method: 'POST', body: { workspaceId: opened.id, command: 'node test.mjs' } });
  assert.equal(shell.code, 0, shell.stderr);

  console.log(JSON.stringify({
    result: 'PASS',
    version: health.version,
    tools: state.toolCount,
    skills: state.skills.length,
    mcp: state.mcpServers.length,
    modelTurns: turns,
    agentRun: complete.status,
    terminalVerification: 'PASS',
  }, null, 2));
} finally {
  if (daemon?.server) await close(daemon.server).catch(() => {});
  if (runtime) await runtime.close().catch(() => {});
  await close(modelServer).catch(() => {});
  await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
