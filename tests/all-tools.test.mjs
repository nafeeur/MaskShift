import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandExists, shellQuote } from '../src/core/utils.mjs';
import { createProject, runtimeForTest, jsonServer, respondJson, waitFor } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const coverage = new Map();
let inventory;

async function setup(t, overrides = {}) {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, overrides);
  const workspace = await runtime.workspaceManager.open(project);
  inventory ||= runtime.toolRegistry.list();
  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  const context = { workspaceId: workspace.id, workspacePath: project, sessionId: session.id,
    eventBus: runtime.eventBus, scope: { workspaceId: workspace.id },
    capabilityState: runtime.capabilityController.createState({ workspaceId: workspace.id }),
    planState: { summary: '', steps: [] } };
  async function call(name, args = {}, verify = (value) => assert.notEqual(value, undefined), level = 'local integration') {
    const result = await runtime.toolRegistry.execute(name, args, context);
    await verify(result);
    coverage.set(name, { level, scenario: t.name });
    return result;
  }
  async function optional(name, commands, args, verify) {
    const found = await Promise.all(commands.map(command => commandExists(command)));
    if (found.some(Boolean)) return call(name, args, verify);
    const reason = `Requires one of: ${commands.join(', ')}`;
    coverage.set(name, { level: 'SKIPPED', scenario: t.name, reason });
    await t.test(name, { skip: reason }, () => {});
    return null;
  }
  return { project, runtime, workspace, context, call, optional };
}

// Sequential scenarios keep PATH/fetch fixtures local to this test process.
// No live cloud account, container, remote machine, or paid model is used.
test('all native tools have executable verification', { timeout: 180_000 }, async (suite) => {
  await suite.test('filesystem writes, reads, patches, moves and deletes', async (t) => {
    const { call, optional, project } = await setup(t);
    await call('fs_mkdir', { path: 'nested' }, r => assert.equal(r.created, true));
    await call('fs_write', { path: 'nested/a.txt', content: 'alpha\nbeta\n' }, r => assert.equal(r.size, 11));
    await call('fs_read', { path: 'nested/a.txt', startLine: 2, endLine: 2, withLineNumbers: false }, r => assert.equal(r.content, 'beta'));
    await call('fs_read_binary', { path: 'nested/a.txt' }, r => assert.equal(Buffer.from(r.base64, 'base64').toString(), 'alpha\nbeta\n'));
    await call('fs_stat', { path: 'nested/a.txt', hash: true }, r => assert.match(r.sha256, /^[a-f0-9]{64}$/));
    await call('fs_list', { path: 'nested' }, r => assert.ok(r.entries.some(e => e.path.endsWith('a.txt'))));
    await call('fs_patch', { path: 'nested/a.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] }, r => assert.equal(r.applied[0].replacements, 1));
    await call('fs_apply_patch', { patch: '--- a/nested/a.txt\n+++ b/nested/a.txt\n@@ -1,2 +1,2 @@\n alpha\n-gamma\n+delta\n' }, r => assert.equal(r.applied, true));
    assert.equal(await fsp.readFile(path.join(project, 'nested/a.txt'), 'utf8'), 'alpha\ndelta\n');
    await call('fs_move', { from: 'nested/a.txt', to: 'nested/b.txt' });
    assert.equal(await fsp.readFile(path.join(project, 'nested/b.txt'), 'utf8'), 'alpha\ndelta\n');
    await call('fs_delete', { path: 'nested/b.txt' }, r => assert.equal(r.deleted, true));
    await assert.rejects(fsp.access(path.join(project, 'nested/b.txt')), { code: 'ENOENT' });
  });

  await suite.test('shell commands and background process lifecycle', async (t) => {
    const { call, optional, project } = await setup(t);
    await call('shell_exec', { command: 'printf hello' }, r => { assert.equal(r.code, 0); assert.equal(r.stdout, 'hello'); });
    await call('shell_exec_parallel', { commands: ['printf one', { command: 'printf two' }] }, r => assert.deepEqual(r.map(x => [x.code, x.stdout]), [[0, 'one'], [0, 'two']]));
    const child = await call('shell_start', { command: `${shellQuote(process.execPath)} -e 'process.stdin.on("data", x => process.stdout.write(x)); console.log("READY")'` });
    const processId = child.id;
    await waitFor(async () => (await call('shell_process_read', { processId })).stdout.includes('READY'));
    await call('shell_process_write', { processId, input: 'ECHO_OK\n' });
    await waitFor(async () => (await call('shell_process_read', { processId })).stdout.includes('ECHO_OK'));
    await call('shell_process_list', { runningOnly: true }, r => assert.ok(r.some(p => p.id === processId)));
    await call('shell_process_stop', { processId });
    await waitFor(async () => !(await call('shell_process_list', { runningOnly: true })).some(p => p.id === processId));
    await call('system_info', {}, r => assert.equal(r.workspace, project));
    await call('command_lookup', { commands: ['node', 'maskshift_nonexistent_command_123'] }, r => { assert.ok(r.node); assert.equal(r.maskshift_nonexistent_command_123, null); });
  });

  await suite.test('search, project context and indexing', async (t) => {
    const { call, optional, project } = await setup(t);
    await fsp.writeFile(path.join(project, 'imports.js'), "import fs from 'node:fs';\n");
    await optional('search_text', ['rg'], { query: 'velocity', glob: '*.js' }, r => assert.ok(r.matches.some(m => m.text.includes('function velocity'))));
    await optional('search_files', ['rg'], { glob: '*.js' }, r => assert.equal(r.total, 2));
    await call('repo_index', {}, r => assert.ok(r.indexedFiles >= 4));
    await call('repo_search', { query: 'velocity' }, r => assert.ok(r.hits.some(h => h.path === 'index.js')));
    await call('symbol_outline', { path: 'index.js' }, r => assert.equal(r.symbols[0].name, 'velocity'));
    await call('dependency_scan', {}, r => assert.ok(r.graph.some(g => g.imports.includes('node:fs'))));
    await call('project_inspect', {}, r => assert.ok(r.index.chunks > 0));
    await call('project_tree', {}, r => assert.match(r.tree, /index.js/));
    await call('project_instructions', {}, r => assert.match(JSON.stringify(r), /Keep verification deterministic/));
    await call('project_read_manifest', { path: 'package.json' }, r => assert.equal(r.parsed.name, 'fixture'));
    await call('project_index_status', {}, r => assert.ok(r.chunks > 0));
    await call('provider_list', {}, r => assert.ok(Array.isArray(r)));
    await call('session_history', {}, r => assert.deepEqual(r, { messages: [], runs: [] }));
    await call('usage_report', {}, r => assert.equal(r.runsConsidered, 0));
  });

  await suite.test('Git branch, commit, checkpoint and worktree lifecycle', async (t) => {
    const { call, optional, project } = await setup(t);
    await call('git_status', {}, r => assert.match(r.status, /^## /));
    await call('git_log', {}, r => assert.equal(r.log[0].subject, 'initial'));
    await call('git_show', { object: 'HEAD:index.js' }, r => assert.match(r.output, /velocity/));
    await call('git_branch', { action: 'create', name: 'verify-tools' });
    await call('git_branch', { action: 'switch', name: 'verify-tools' });
    await fsp.appendFile(path.join(project, 'index.js'), '// verification\n');
    await call('git_diff', {}, r => assert.match(r.diff, /\+\/\/ verification/));
    await call('git_commit', { message: 'Verify tools', paths: ['index.js'] }, r => assert.equal(r.committed, true));
    const checkpoint = await call('git_checkpoint_create', { label: 'verified' });
    await call('git_checkpoint_list', {}, r => assert.ok(r.some(c => c.id === checkpoint.id)));
    await fsp.writeFile(path.join(project, 'index.js'), 'broken');
    await call('git_checkpoint_restore', { checkpointId: checkpoint.id });
    assert.match(await fsp.readFile(path.join(project, 'index.js'), 'utf8'), /verification/);
    const worktree = await call('git_worktree_create', { name: 'verify-isolation' });
    assert.notEqual(worktree.path, project);
    assert.match(await fsp.readFile(path.join(worktree.path, 'index.js'), 'utf8'), /verification/);
  });

  await suite.test('memory, skills and lazy capability state', async (t) => {
    const { call, runtime } = await setup(t);
    const memory = await call('memory_save', { title: 'fixture-memory', content: 'Remember the velocity formula' });
    await call('memory_search', { query: 'velocity' }, r => assert.ok(r.some(m => m.id === memory.id)));
    await call('memory_list', {}, r => assert.ok(r.some(m => m.id === memory.id)));
    await call('memory_optimize', { dryRun: false }, r => assert.equal(r.pruned, 0));
    await call('memory_delete', { id: memory.id }, r => assert.equal(r.deleted, true));
    await call('memory_list', {}, r => assert.equal(r.length, 0));
    await call('skill_create', { name: 'verification-fixture', description: 'Test fixture only', body: 'Check the marker.' });
    await call('skill_search', { query: 'verification-fixture' }, r => assert.ok(r.some(s => s.name === 'verification-fixture')));
    await call('skill_load', { name: 'verification-fixture' }, r => assert.match(JSON.stringify(r), /Check the marker/));
    await fsp.mkdir(path.join(runtime.config.get().home, 'skills/verification-fixture/references'));
    await fsp.writeFile(path.join(runtime.config.get().home, 'skills/verification-fixture/references/marker.txt'), 'REFERENCE_OK');
    await call('skill_read_reference', { name: 'verification-fixture', reference: 'marker.txt' }, r => assert.equal(r, 'REFERENCE_OK'));
    await call('skill_improve', { name: 'verification-fixture', addition: 'Check it twice.' });
    await call('skill_load', { name: 'verification-fixture' }, r => assert.match(JSON.stringify(r), /Check it twice/));
    await call('capability_search', { query: 'sqlite' }, r => assert.match(JSON.stringify(r), /sqlite_query/));
    await call('capability_activate', { names: ['sqlite_query'], kind: 'tool' });
    await call('capability_state', {}, r => assert.match(JSON.stringify(r), /sqlite_query/));
    await call('plan_update', { summary: 'Verify', steps: [{ text: 'Run tests', status: 'completed' }] });
    await call('plan_get', {}, r => assert.equal(r.steps[0].status, 'completed'));
  });

  await suite.test('SQLite, archives, runtime cells and environment', async (t) => {
    const { call, optional, project } = await setup(t);
    await call('sqlite_query', { database: 'data.sqlite', sql: 'CREATE TABLE items (id INTEGER, name TEXT)' });
    await call('sqlite_query', { database: 'data.sqlite', sql: 'INSERT INTO items VALUES (?, ?)', parameters: [7, "it's a test"] }, r => assert.equal(r.changes, 1));
    await call('sqlite_query', { database: 'data.sqlite', sql: 'SELECT * FROM items', readOnly: true }, r => assert.deepEqual(r.rows, [{ id: 7, name: "it's a test" }]));
    await call('sqlite_schema', { database: 'data.sqlite' }, r => assert.equal(r[0].name, 'items'));
    await optional('archive_create', ['tar'], { output: 'bundle.tar.gz', paths: ['index.js'] }, r => { assert.equal(r.code, 0); assert.ok(r.bytes > 0); });
    const extracted = await optional('archive_extract', ['tar'], { archive: 'bundle.tar.gz', destination: 'extracted' }, r => assert.equal(r.code, 0));
    if (extracted) assert.equal(await fsp.readFile(path.join(project, 'extracted/index.js'), 'utf8'), await fsp.readFile(path.join(project, 'index.js'), 'utf8'));
    await call('file_hash', { path: 'index.js' }, r => assert.match(r.digest, /^[a-f0-9]{64}$/));
    await optional('python_cell', ['python3'], { code: 'print(6 * 7)' }, r => { assert.equal(r.code, 0); assert.equal(r.stdout.trim(), '42'); });
    await call('node_cell', { code: 'console.log(6 * 7)' }, r => { assert.equal(r.code, 0); assert.equal(r.stdout.trim(), '42'); });
    await call('environment_set', { values: { MASKSHIFT_TEST_MARKER: 'fixture' } });
    try { await call('environment_list', { filter: '^MASKSHIFT_TEST_MARKER$', includeValues: true }, r => assert.deepEqual(r, { MASKSHIFT_TEST_MARKER: 'fixture' })); }
    finally { await call('environment_set', { values: { MASKSHIFT_TEST_MARKER: null } }); }
    await optional('port_inspect', ['ss', 'lsof', 'netstat'], { port: 1 }, r => assert.equal(r.code, 0));
    const source = path.join(project, 'index.js');
    const transferred = await optional('rsync_transfer', ['rsync'], { source, destination: path.join(project, 'copy.js') }, r => assert.equal(r.code, 0));
    if (transferred) assert.equal(await fsp.readFile(path.join(project, 'copy.js'), 'utf8'), await fsp.readFile(source, 'utf8'));
  });

  await suite.test('PDF extraction and notebook edits', async (t) => {
    const { call, optional, project } = await setup(t);
    // Minimal real PDF fixture; pdftotext is the only required PDF dependency.
    const stream = 'BT /F1 18 Tf 30 100 Td (MASKSHIFT_PDF_OK) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => String(x).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await fsp.writeFile(path.join(project, 'fixture.pdf'), pdf);
    await optional('pdf_read', ['pdftotext'], { path: 'fixture.pdf' }, r => { assert.match(r.text, /MASKSHIFT_PDF_OK/); assert.equal(r.totalPages, 1); });
    await fsp.writeFile(path.join(project, 'fixture.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', metadata: {}, source: ['1+1'], outputs: [], execution_count: null }] }));
    await call('notebook_read', { path: 'fixture.ipynb' }, r => assert.equal(r.cells[0].source, '1+1'));
    await call('notebook_edit', { path: 'fixture.ipynb', cellIndex: 0, source: '2+2', editMode: 'replace', cellType: 'code' });
    await call('notebook_read', { path: 'fixture.ipynb' }, r => assert.equal(r.cells[0].source, '2+2'));
  });

  await suite.test('automation and plugin lifecycle in disposable home', async (t) => {
    const { call, project, runtime } = await setup(t);
    const automation = await call('automation_create', { name: 'verify', schedule: 'every 1h', enabled: false, action: { type: 'shell', command: 'printf AUTOMATION_OK > automated.txt' } });
    const automationId = automation.id;
    await call('automation_list', {}, r => assert.ok(r.some(a => a.id === automationId)));
    await call('automation_update', { automationId, name: 'verify updated' }, r => assert.equal(r.name, 'verify updated'));
    await call('automation_resume', { automationId }, r => assert.equal(r.enabled, true));
    await call('automation_pause', { automationId }, r => assert.equal(r.enabled, false));
    await call('automation_run_now', { automationId }, r => assert.equal(r.status, 'completed'));
    assert.equal(await fsp.readFile(path.join(project, 'automated.txt'), 'utf8'), 'AUTOMATION_OK');
    await call('automation_delete', { automationId }, r => assert.ok(r.deleted));
    await call('automation_list', {}, r => assert.equal(r.length, 0));
    await call('plugin_scaffold', { name: 'verify-plugin' }, r => assert.equal(r.plugin.status, 'active'));
    await call('plugin_list', {}, r => assert.ok(r.some(p => p.name === 'verify-plugin')));
    await call('plugin_scan', { activate: false });
    await call('plugin_deactivate', { name: 'verify-plugin' });
    assert.equal(runtime.toolRegistry.has('verify_plugin_hello'), false);
    await call('plugin_activate', { name: 'verify-plugin' });
    assert.equal(runtime.toolRegistry.has('verify_plugin_hello'), true);
    await call('plugin_reload', { name: 'verify-plugin' });
    assert.deepEqual(await runtime.toolRegistry.execute('verify_plugin_hello', { name: 'fixture' }), { message: 'Hello, fixture' });
    const source = path.join(project, 'local-plugin');
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'installed-fixture', type: 'module', main: 'index.mjs' }));
    await fsp.writeFile(path.join(source, 'index.mjs'), 'export default function(api) { api.registerTool({name:"installed_fixture_ping", execute: async () => "pong"}); }');
    await call('plugin_install', { source, kind: 'local', name: 'installed-fixture' });
    assert.equal(await runtime.toolRegistry.execute('installed_fixture_ping', {}), 'pong');
  });

  await suite.test('HTTP fetch, download, search and registry fixtures', async (t) => {
    const { call, optional, project } = await setup(t);
    const server = await jsonServer(t, (req, res) => {
      if (req.url === '/file') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('DOWNLOAD_OK'); }
      respondJson(res, 200, { marker: 'FETCH_OK' });
    });
    await call('web_fetch', { url: server.url, mode: 'json' }, r => assert.deepEqual(r.content, { marker: 'FETCH_OK' }));
    await call('web_download', { url: `${server.url}/file`, path: 'download.txt' }, r => assert.equal(r.bytes, 11));
    assert.equal(await fsp.readFile(path.join(project, 'download.txt'), 'utf8'), 'DOWNLOAD_OK');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://html.duckduckgo.com/')) return new Response('<div class="result results_links"><a class="result__a" href="https://example.invalid/fixture">Fixture</a><a class="result__snippet">Search marker</a></div>');
      if (String(url).startsWith('https://registry.modelcontextprotocol.io/')) return Response.json({ servers: [{ server: { name: 'io.fixture/test-server', version: '1.0.0', remotes: [{ type: 'streamable-http', url: `${server.url}/mcp` }] } }] });
      return originalFetch(url, init);
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    await call('web_search', { query: 'fixture', provider: 'duckduckgo' }, r => assert.equal(r.results[0].snippet, 'Search marker'), 'HTTP response fixture');
    await call('mcp_registry_search', { query: 'fixture' }, r => assert.equal(r[0].name, 'io.fixture/test-server'), 'HTTP response fixture');
    await call('mcp_registry_install', { registryName: 'io.fixture/test-server' }, r => assert.match(JSON.stringify(r), /test-server/), 'HTTP response fixture');
  });

  await suite.test('MCP tools over a real stdio fixture server', async (t) => {
    const { call, context } = await setup(t);
    await call('mcp_add', { name: 'verification', definition: { transport: 'stdio', command: process.execPath, args: [path.join(here, 'fixtures-mcp-server.mjs'), 'modern'], enabled: true, lazy: true } });
    await call('mcp_list', {}, r => assert.ok(r.some(s => s.name === 'verification')));
    await call('mcp_search', { query: 'verification' }, r => assert.match(JSON.stringify(r), /verification/));
    await call('mcp_connect', { name: 'verification' }, r => assert.equal(r.status, 'connected'), 'stdio protocol fixture');
    await call('mcp_call', { name: 'mcp__verification__echo', arguments: { marker: 42 } }, r => assert.deepEqual(r.structuredContent, { marker: 42 }), 'stdio protocol fixture');
    await call('mcp_resources', { server: 'verification' }, r => assert.match(JSON.stringify(r), /fixture:\/\/status/), 'stdio protocol fixture');
    await call('mcp_resource_read', { server: 'verification', uri: 'fixture://status' }, r => assert.equal(r.contents[0].text, 'MCP_RESOURCE_OK'), 'stdio protocol fixture');
    await call('mcp_prompts', { server: 'verification' }, r => assert.match(JSON.stringify(r), /verify/), 'stdio protocol fixture');
    await call('mcp_disconnect', { name: 'verification' }, r => assert.equal(r.disconnected, true), 'stdio protocol fixture');
    assert.equal(context.capabilityState.mcpServers.has('verification'), false);
  });

  await suite.test('LSP tools over framed stdio with edits applied to files', async (t) => {
    const { call, runtime, project } = await setup(t);
    await call('lsp_discover', {}, r => assert.ok(r.some(s => s.id === 'typescript')));
    runtime.lspManager.availability = [{ id: 'fixture', languages: ['javascript'], available: true, selected: { executable: process.execPath, args: [path.join(here, 'fixtures-lsp-server.mjs')] } }];
    const pos = { file: 'index.js', line: 1, character: 17, server: 'fixture' };
    await call('lsp_hover', pos, r => assert.equal(r.contents.value, 'velocity: fixture function'), 'stdio protocol fixture');
    await call('lsp_definition', pos, r => assert.equal(r[0].range.start.character, 16), 'stdio protocol fixture');
    await call('lsp_references', pos, r => assert.equal(r.length, 1), 'stdio protocol fixture');
    await call('lsp_symbols', pos, r => assert.equal(r[0].name, 'velocity'), 'stdio protocol fixture');
    await call('lsp_diagnostics', pos, r => assert.equal(r.items[0].message, 'Fixture diagnostic'), 'stdio protocol fixture');
    await call('lsp_status', {}, r => assert.ok(r.some(s => s.started)), 'stdio protocol fixture');
    await call('lsp_rename', { ...pos, newName: 'speed' }, r => assert.equal(r.applied[0].edits, 1), 'stdio protocol fixture');
    assert.match(await fsp.readFile(path.join(project, 'index.js'), 'utf8'), /function speed/);
    await call('lsp_format', pos, r => assert.equal(r.applied.edits, 1), 'stdio protocol fixture');
    assert.match(await fsp.readFile(path.join(project, 'index.js'), 'utf8'), /^\/\/ formatted/);
    await call('lsp_stop', {}, r => assert.equal(r.stopped, true), 'stdio protocol fixture');
    assert.equal(runtime.lspManager.list().length, 0);
  });

  await suite.test('agent tools with a deterministic local model endpoint', async (t) => {
    const server = await jsonServer(t, (req, res) => respondJson(res, 200, { id: 'fixture', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE_AGENT_OK' }] }] }));
    const { call, runtime, workspace, context } = await setup(t, { defaultModel: 'fixture:local', providers: [{ id: 'fixture', type: 'openai-responses', baseUrl: server.url, apiKeyEnv: null, enabled: true, models: [{ id: 'local' }], timeoutMs: 5000 }] });
    context.runId = null; // Manual CLI tools have no parent run.
    await call('agent_delegate', { task: 'Return marker', model: 'fixture:local' }, r => { assert.equal(r.status, 'completed'); assert.equal(r.final, 'FIXTURE_AGENT_OK'); }, 'local model fixture');
    await call('agent_parallel', { tasks: [{ task: 'one', model: 'fixture:local' }, { task: 'two', model: 'fixture:local' }] }, r => { assert.equal(r.length, 2); assert.ok(r.every(x => x.status === 'completed')); }, 'local model fixture');
    const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'cancel fixture', modelRef: 'fixture:local' });
    await call('agent_run_status', { runId: run.id }, r => assert.equal(r.id, run.id), 'local model fixture');
    await call('agent_cancel', { runId: run.id }, r => assert.equal(r.cancelled, true), 'local model fixture');
    assert.equal((await runtime.engine.waitForRun(run.id)).status, 'cancelled');
  });

  await suite.test('external agent bridges execute a local echo CLI', async (t) => {
    const { call } = await setup(t, { agentBridges: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false }, copilot: { enabled: false }, hermes: { enabled: false }, aider: { enabled: false }, fixture: { command: 'node', args: ['-e', 'console.log(process.argv[1])', '{prompt}'] } } });
    await call('agent_bridge_discover', {}, r => assert.ok(r.some(b => b.name === 'fixture' && b.available)), 'local CLI fixture');
    await call('agent_bridge_help', { bridge: 'fixture' }, r => { assert.equal(r.code, 0); assert.match(r.stdout, /Usage/); }, 'local CLI fixture');
    await call('agent_bridge_run', { bridge: 'fixture', prompt: 'BRIDGE_OK' }, r => { assert.equal(r.code, 0); assert.equal(r.stdout.trim(), 'BRIDGE_OK'); }, 'local CLI fixture');
    await call('external_agent_run', { command: 'node', args: ['-e', 'console.log(process.argv[1])', '{prompt}'], prompt: 'CUSTOM_OK' }, r => { assert.equal(r.code, 0); assert.equal(r.stdout.trim(), 'CUSTOM_OK'); }, 'local CLI fixture');
  });

  await suite.test('container, SSH, database CLI and service command adapters', async (t) => {
    const { call, optional, project } = await setup(t);
    const bin = path.join(project, 'fixture-bin'); await fsp.mkdir(bin);
    const source = `#!${process.execPath}\nimport path from 'node:path';\nconst argv = process.argv.slice(2);\nif (path.basename(process.argv[1]) === 'docker' && argv[0] === 'ps') console.log(JSON.stringify({ID:'fixture-container', Names:'fixture'}));\nelse console.log(JSON.stringify({command:path.basename(process.argv[1]),argv}));\n`;
    for (const name of ['docker', 'kubectl', 'ssh', 'systemctl', 'psql']) { await fsp.writeFile(path.join(bin, name), source); await fsp.chmod(path.join(bin, name), 0o755); }
    // Extensionless scripts use a package marker to run as ES modules.
    await fsp.writeFile(path.join(bin, 'package.json'), '{"type":"module"}');
    const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    t.after(() => { process.env.PATH = oldPath; });
    const fixtureCall = (name, args, check) => call(name, args, r => { assert.equal(r.code, 0, r.stderr || r.output); check?.(r); }, 'CLI adapter fixture; live service untested');
    await fixtureCall('container_engine', {}, r => assert.equal(r.available, true));
    await fixtureCall('container_list', {}, r => assert.equal(r.containers[0].ID, 'fixture-container'));
    await fixtureCall('container_run', { image: 'fixture:local', command: ['echo', 'hello world'], env: { TEST: 'value with spaces' } }, r => { const a = JSON.parse(r.stdout).argv; assert.ok(a.includes('--env=TEST=value with spaces')); assert.equal(a.at(-1), 'hello world'); });
    await fixtureCall('container_exec', { container: 'fixture', command: 'printf hello' }, r => assert.deepEqual(JSON.parse(r.stdout).argv.slice(-4), ['fixture', 'sh', '-lc', 'printf hello']));
    await fixtureCall('container_logs', { container: 'fixture', tail: 5 }, r => assert.ok(JSON.parse(r.stdout).argv.includes('--tail=5')));
    await fixtureCall('container_stop', { container: 'fixture', action: 'stop', timeout: 3 }, r => assert.ok(JSON.parse(r.stdout).argv.includes('--time=3')));
    await fixtureCall('container_build', { tag: 'fixture:local', buildArgs: { TEST: 'a b' } }, r => assert.ok(JSON.parse(r.stdout).argv.includes('--build-arg=TEST=a b')));
    await fixtureCall('container_compose', { action: 'config', file: 'fixture compose.yml' }, r => assert.ok(JSON.parse(r.stdout).argv.includes('--file=fixture compose.yml')));
    await fixtureCall('kubernetes_exec', { args: ['get', 'pods'], namespace: 'fixture' }, r => assert.deepEqual(JSON.parse(r.stdout).argv, ['--namespace=fixture', 'get', 'pods']));
    await fixtureCall('ssh_exec', { host: 'fixture.invalid', command: 'printf marker', user: 'fixture', port: 2222 }, r => assert.ok(JSON.parse(r.stdout).argv.includes('fixture@fixture.invalid')));
    await fixtureCall('database_cli', { client: 'psql', args: ['-c', 'SELECT 42'] }, r => assert.deepEqual(JSON.parse(r.stdout).argv, ['-c', 'SELECT 42']));
    await fixtureCall('system_service', { service: 'fixture.service', action: 'status', user: true }, r => assert.deepEqual(JSON.parse(r.stdout).argv, ['--user', 'status', 'fixture.service']));
  });

  await suite.test('browser tool delegation contracts', async (t) => {
    const { call, runtime, workspace } = await setup(t);
    await call('browser_discover', {}, r => assert.equal(typeof r, 'object'));
    const cases = [
      ['browser_launch', 'launch', { profile: 'fixture', headless: true }, a => [a]],
      ['browser_instances', 'list', {}, () => []],
      ['browser_tabs', 'tabs', { instanceId: 'fixture' }, a => [a.instanceId]],
      ['browser_new_tab', 'newTab', { instanceId: 'fixture', url: 'about:blank' }, a => [a.instanceId, a.url]],
      ['browser_navigate', 'navigate', { url: 'http://127.0.0.1/fixture' }, a => [a]],
      ['browser_snapshot', 'snapshot', { maxTextChars: 1000 }, a => [a]],
      ['browser_accessibility', 'accessibility', { limit: 20 }, a => [a]],
      ['browser_click', 'click', { selector: '#button' }, a => [a]],
      ['browser_type', 'type', { selector: '#input', text: 'marker', clear: true }, a => [a]],
      ['browser_wait_for', 'waitFor', { selector: '#button', state: 'visible' }, a => [a]],
      ['browser_evaluate', 'evaluate', { expression: '1+1' }, a => [a]],
      ['browser_screenshot', 'screenshot', { file: 'shot.png' }, a => [{ ...a, workspaceId: workspace.id }]],
      ['browser_print_pdf', 'printPdf', { file: 'page.pdf' }, a => [{ ...a, workspaceId: workspace.id }]],
      ['browser_console', 'console', { limit: 10 }, a => [a]],
      ['browser_network', 'network', { limit: 10 }, a => [a]],
      ['browser_close_tab', 'closeTab', { instanceId: 'fixture', tabId: 'page' }, a => [a.instanceId, a.tabId]],
      ['browser_close', 'close', { instanceId: 'fixture' }, a => [a.instanceId]],
    ];
    for (const [name, method, args, expected] of cases) {
      const original = runtime.browserManager[method];
      let invoked = false;
      runtime.browserManager[method] = async (...received) => { invoked = true; assert.deepEqual(received, expected(args)); return { marker: name }; };
      try { await call(name, args, r => { assert.equal(invoked, true); assert.equal(r.marker, name); }, 'manager contract fixture; live browser untested'); }
      finally { runtime.browserManager[method] = original; }
    }
  });

  await suite.test('coverage gate: every native tool has assertions or an explicit dependency skip', () => {
    const missing = inventory.filter(tool => !coverage.has(tool.name)).map(tool => tool.name);
    assert.deepEqual(missing, [], `Tools without successful assertions: ${missing.join(', ')}`);
  });
  if (process.env.MASKSHIFT_TOOL_REPORT) {
    await fsp.writeFile(process.env.MASKSHIFT_TOOL_REPORT, JSON.stringify({ node: process.version, tools: inventory.map(({ name, category }) => ({ name, category, ...(coverage.get(name) || { level: 'NOT VERIFIED' }) })) }, null, 2) + '\n');
  }
});
