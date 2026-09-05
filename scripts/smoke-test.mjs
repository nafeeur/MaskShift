// End-to-end smoke test: boot the runtime against a fixture model, drive one
// agent run through the CLI path, paint the TUI, and verify the artifact with
// the host terminal — no browser and no HTTP server anywhere.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createRuntime } from '../src/runtime.mjs';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { Theme } from '../src/tui/theme.mjs';
import { stripAnsi, visibleWidth } from '../src/tui/text.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-smoke-'));
const home = path.join(temp, 'home');
const workspace = path.join(temp, 'workspace');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(path.join(workspace, 'package.json'), '{"name":"maskshift-smoke","scripts":{"test":"node test.mjs"}}\n');
await fsp.writeFile(path.join(workspace, 'test.mjs'), "import assert from 'node:assert/strict'; import fsp from 'node:fs/promises'; assert.equal(await fsp.readFile('smoke-agent.txt','utf8'),'MASKSHIFT_SMOKE_OK\\n');\n");

class FakeTerminal extends Writable {
  constructor(columns, rows) { super(); this.columns = columns; this.rows = rows; this.isTTY = false; }
  _write(chunk, encoding, callback) { callback(); }
}

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
try {
  runtime = await createRuntime({
    workspacePath: workspace,
    configOverrides: {
      home, autoIndex: false, autoCheckpoint: false,
      defaultModel: 'smoke:smoke-coder',
      providers: [{
        id: 'smoke', name: 'Smoke model', type: 'openai-responses',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKeyEnv: null,
        enabled: true, autoDiscover: true, models: [{ id: 'smoke-coder' }], timeoutMs: 15_000,
      }],
    },
  });

  const toolCount = runtime.toolRegistry.list({ includeSchema: false }).length;
  const skillCount = runtime.skillManager.list().length;
  assert.ok(toolCount >= 143, `expected the full tool catalogue, saw ${toolCount}`);
  assert.ok(skillCount >= 36, `expected the bundled skills, saw ${skillCount}`);

  const opened = await runtime.workspaceManager.open(workspace);
  const run = await runtime.engine.startRun({
    workspaceId: opened.id,
    prompt: 'Create smoke-agent.txt with the exact requested marker.',
    modelRef: 'smoke:smoke-coder',
    options: { source: 'smoke' },
  });
  const complete = await runtime.engine.waitForRun(run.id);
  assert.equal(complete.status, 'completed', complete.error || 'run did not complete');
  assert.equal(turns, 2);
  assert.equal(await fsp.readFile(path.join(workspace, 'smoke-agent.txt'), 'utf8'), 'MASKSHIFT_SMOKE_OK\n');

  // The interface must paint the finished transcript at an exact size.
  const columns = 120;
  const rows = 32;
  const app = new MaskShiftTui(runtime, {
    workspacePath: workspace, headless: true,
    theme: new Theme({ depth: 24, unicode: true }),
    output: new FakeTerminal(columns, rows),
  });
  await app.bootstrap();
  const frames = {};
  for (const view of ['chat', 'files', 'arsenal', 'network', 'modshop', 'terminal']) {
    app.view = view;
    app.focus = app.defaultFocus();
    app.screen.invalidate();
    const frame = app.snapshot();
    assert.equal(frame.length, rows, `${view} painted ${frame.length} rows`);
    for (const line of frame) assert.equal(visibleWidth(line), columns, `${view}: "${stripAnsi(line)}"`);
    frames[view] = frame.length;
  }
  app.view = 'chat';
  app.screen.invalidate();
  const transcript = app.snapshot().map(stripAnsi).join('\n');
  assert.match(transcript, /Smoke artifact created and verified/);

  const shell = await runtime.toolRegistry.execute('shell_exec', { command: 'node test.mjs', cwd: '.' }, {
    workspaceId: opened.id, workspacePath: workspace, scope: { workspaceId: opened.id },
    eventBus: runtime.eventBus, store: runtime.store,
    capabilityState: runtime.capabilityController.createState({ workspaceId: opened.id }),
    planState: { summary: '', steps: [] },
  });
  assert.equal(shell.code, 0, shell.stderr);

  console.log(JSON.stringify({
    result: 'PASS',
    version: '1.0.0',
    tools: toolCount,
    skills: skillCount,
    mcp: runtime.mcpManager.listServers().length,
    modelTurns: turns,
    agentRun: complete.status,
    interfaceViews: Object.keys(frames).length,
    terminalVerification: 'PASS',
  }, null, 2));
} finally {
  if (runtime) await runtime.close().catch(() => {});
  await close(modelServer).catch(() => {});
  await fsp.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
