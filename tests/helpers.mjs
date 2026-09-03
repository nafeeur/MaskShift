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
      autoOpen: false,
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
