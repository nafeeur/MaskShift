import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, tempDir } from './helpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const bin = path.join(repoRoot, 'bin', 'maskshift.mjs');

/** Drives `maskshift mcp serve` the way a real MCP client would: NDJSON in, NDJSON out. */
function mcpClient(t, project, home, extraArgs = []) {
  const child = spawn('node', ['--no-warnings', bin, 'mcp', 'serve', '--workspace', project, ...extraArgs], {
    env: { ...process.env, MASKSHIFT_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const waiters = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  t.after(() => { child.kill(); });
  let nextId = 1;
  return {
    stderr: () => stderr,
    request(method, params = {}, timeoutMs = 15_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`Timed out waiting for ${method}. stderr so far: ${stderr}`));
        }, timeoutMs);
        waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

test('mcp serve exposes the native tool catalog to a generic MCP client over stdio', async (t) => {
  const project = await createProject(t);
  const home = await tempDir(t, 'maskshift-mcp-home-');
  const client = mcpClient(t, project, home);

  const initialized = await client.request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(initialized.result.serverInfo.name, 'maskshift');
  assert.ok(initialized.result.capabilities.tools);
  client.notify('notifications/initialized');

  const listed = await client.request('tools/list');
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('fs_read'), 'fs_read should be in the exposed catalog');
  assert.ok(names.includes('fs_write'));
  const fsRead = listed.result.tools.find((tool) => tool.name === 'fs_read');
  assert.ok(fsRead.inputSchema.properties.path);

  const called = await client.request('tools/call', { name: 'fs_read', arguments: { path: 'index.js' } });
  assert.equal(called.result.isError, undefined);
  assert.match(called.result.content[0].text, /export function velocity/);

  const badTool = await client.request('tools/call', { name: 'not_a_real_tool', arguments: {} });
  assert.equal(badTool.error.code, -32601);
});

test('mcp serve --read-only hides and refuses write tools', async (t) => {
  const project = await createProject(t);
  const home = await tempDir(t, 'maskshift-mcp-home-');
  const client = mcpClient(t, project, home, ['--read-only']);

  await client.request('initialize', { protocolVersion: '2025-11-25' });
  const listed = await client.request('tools/list');
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('fs_read'));
  assert.ok(!names.includes('fs_write'), 'fs_write is not read-only and must not be exposed');

  const refused = await client.request('tools/call', { name: 'fs_write', arguments: { path: 'x.txt', content: 'nope' } });
  assert.equal(refused.error.code, -32601);
});

test('mcp serve --tools restricts the catalog to an explicit allowlist', async (t) => {
  const project = await createProject(t);
  const home = await tempDir(t, 'maskshift-mcp-home-');
  const client = mcpClient(t, project, home, ['--tools', 'fs_read']);

  await client.request('initialize', { protocolVersion: '2025-11-25' });
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['fs_read']);

  const refused = await client.request('tools/call', { name: 'shell_exec', arguments: { command: 'echo hi' } });
  assert.equal(refused.error.code, -32601);
});
