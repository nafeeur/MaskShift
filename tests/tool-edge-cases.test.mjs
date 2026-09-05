import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { commandExists } from '../src/core/utils.mjs';
import { LanguageServerClient } from '../src/lsp/client.mjs';
import { createProject, runtimeForTest, jsonServer, respondJson } from './helpers.mjs';

async function fixture(t) {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const call = (name, args) => runtime.toolRegistry.execute(name, args, { workspaceId: workspace.id, workspacePath: project });
  return { project, runtime, call };
}

test('fs_move preserves an existing destination unless overwrite is requested', async t => {
  const { project, call } = await fixture(t);
  await fsp.writeFile(path.join(project, 'source'), 'source');
  await fsp.writeFile(path.join(project, 'destination'), 'destination');
  await assert.rejects(call('fs_move', { from: 'source', to: 'destination' }), /exist/i);
  assert.equal(await fsp.readFile(path.join(project, 'source'), 'utf8'), 'source');
  assert.equal(await fsp.readFile(path.join(project, 'destination'), 'utf8'), 'destination');
  await call('fs_move', { from: 'source', to: 'destination', overwrite: true });
  assert.equal(await fsp.readFile(path.join(project, 'destination'), 'utf8'), 'source');
  await call('fs_move', { from: 'destination', to: 'destination', overwrite: true });
  assert.equal(await fsp.readFile(path.join(project, 'destination'), 'utf8'), 'source');
  await assert.rejects(call('fs_move', { from: 'missing', to: 'destination', overwrite: true }), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(path.join(project, 'destination'), 'utf8'), 'source');
});

test('project_tree respects its requested subdirectory', async t => {
  const { project, call } = await fixture(t);
  await fsp.mkdir(path.join(project, 'subdir'));
  await fsp.writeFile(path.join(project, 'subdir/inside.txt'), 'inside');
  const result = await call('project_tree', { path: 'subdir' });
  assert.ok(result.entries.some(e => e.path.endsWith('inside.txt')));
  assert.ok(!result.entries.some(e => e.path === 'index.js'), 'must not list root files');
});

test('command_lookup accepts explicit executable paths and rejects directories', async t => {
  assert.equal(await commandExists(process.execPath), process.execPath);
  assert.equal(await commandExists(path.dirname(process.execPath)), null);
  const { call } = await fixture(t);
  const result = await call('node_cell', { node: process.execPath, code: 'console.log(42)' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42');
});

test('search_files returns no matches for an empty directory or unmatched glob', async t => {
  if (!(await commandExists('rg'))) return t.skip('ripgrep is not installed');
  const { project, call } = await fixture(t);
  await fsp.mkdir(path.join(project, 'empty'));
  assert.deepEqual((await call('search_files', { path: 'empty' })).files, []);
  assert.deepEqual((await call('search_files', { glob: '*.no-such-extension' })).files, []);
});

test('web_fetch defaults to automatic JSON and readable HTML detection', async t => {
  const { call } = await fixture(t);
  const server = await jsonServer(t, (req, res) => {
    if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Readable</h1><script>hidden()</script>'); }
    respondJson(res, 200, { marker: 42 });
  });
  assert.deepEqual((await call('web_fetch', { url: server.url })).content, { marker: 42 });
  assert.equal((await call('web_fetch', { url: `${server.url}/html` })).content, 'Readable');
});

test('LSP workspace edits decode file URIs containing spaces and Unicode', async t => {
  const { project } = await fixture(t);
  const file = path.join(project, 'hello world-é.js');
  await fsp.writeFile(file, 'old');
  const client = new LanguageServerClient({});
  // Test actual file edits without requiring a running language server.
  client.open = async () => ({}); client.notify = () => {};
  const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'new' };
  await client.applyWorkspaceEdit({ changes: { [pathToFileURL(file).href]: [edit] } });
  assert.equal(await fsp.readFile(file, 'utf8'), 'new');
  await client.applyWorkspaceEdit({ documentChanges: [{ textDocument: { uri: pathToFileURL(file).href }, edits: [{ ...edit, newText: 'end' }] }] });
  assert.equal(await fsp.readFile(file, 'utf8'), 'end');
});
