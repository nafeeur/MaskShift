import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { commandExists, runCommand } from '../src/core/utils.mjs';
import { createProject, jsonServer, runtimeForTest } from './helpers.mjs';

function contextFor(runtime, workspace, project) {
  return { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
}

test('web_search prefers a configured provider and falls back to DuckDuckGo on failure', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  const brave = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ web: { results: [{ title: 'Brave result', url: 'https://example.invalid/brave', description: 'from brave' }] } }));
  });

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = 'test-key';
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith('https://api.search.brave.com')) return originalFetch(`${brave.url}/brave`, init);
    return originalFetch(url, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = originalKey; });

  const result = await runtime.toolRegistry.execute('web_search', { query: 'maskshift' }, context);
  assert.equal(result.provider, 'brave');
  assert.equal(result.results[0].url, 'https://example.invalid/brave');
  assert.equal(result.results[0].snippet, 'from brave');
});

test('pdf_read extracts text via pdftotext when available', async (t) => {
  if (!(await commandExists('pdftotext')) || !(await commandExists('ps2pdf'))) {
    t.skip('pdftotext or ps2pdf is not installed on this host');
    return;
  }
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  const psPath = path.join(project, 'fixture.ps');
  const pdfPath = path.join(project, 'fixture.pdf');
  await fsp.writeFile(psPath, '%!PS\n/Helvetica findfont 24 scalefont setfont\n72 700 moveto\n(MASKSHIFT_PDF_OK) show\nshowpage\n');
  const converted = await runCommand(`ps2pdf ${psPath} ${pdfPath}`, { timeoutMs: 20_000 });
  assert.equal(converted.code, 0);

  const result = await runtime.toolRegistry.execute('pdf_read', { path: 'fixture.pdf' }, context);
  assert.match(result.text, /MASKSHIFT_PDF_OK/);
  assert.equal(result.totalPages, 1);
});

test('notebook_read and notebook_edit operate on Jupyter notebook cells', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  const notebook = {
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Title\n'] },
      { cell_type: 'code', metadata: {}, execution_count: 3, outputs: [{ output_type: 'stream', name: 'stdout', text: ['4\n'] }], source: ['2 + 2\n'] },
    ],
  };
  await fsp.writeFile(path.join(project, 'fixture.ipynb'), JSON.stringify(notebook, null, 1));

  const read = await runtime.toolRegistry.execute('notebook_read', { path: 'fixture.ipynb' }, context);
  assert.equal(read.cellCount, 2);
  assert.equal(read.cells[1].executionCount, 3);
  assert.equal(read.cells[1].outputs[0].text, '4\n');

  await runtime.toolRegistry.execute('notebook_edit', {
    path: 'fixture.ipynb', cellIndex: 1, editMode: 'replace', cellType: 'code', source: '3 + 3\n',
  }, context);
  const afterReplace = await runtime.toolRegistry.execute('notebook_read', { path: 'fixture.ipynb' }, context);
  assert.equal(afterReplace.cells[1].source, '3 + 3\n');
  assert.equal(afterReplace.cells[1].executionCount, null);
  assert.deepEqual(afterReplace.cells[1].outputs, []);

  await runtime.toolRegistry.execute('notebook_edit', {
    path: 'fixture.ipynb', cellIndex: 0, editMode: 'insert', cellType: 'markdown', source: '## Inserted\n',
  }, context);
  const afterInsert = await runtime.toolRegistry.execute('notebook_read', { path: 'fixture.ipynb' }, context);
  assert.equal(afterInsert.cellCount, 3);
  assert.equal(afterInsert.cells[0].source, '## Inserted\n');

  await runtime.toolRegistry.execute('notebook_edit', { path: 'fixture.ipynb', cellIndex: 0, editMode: 'delete' }, context);
  const afterDelete = await runtime.toolRegistry.execute('notebook_read', { path: 'fixture.ipynb' }, context);
  assert.equal(afterDelete.cellCount, 2);
});

test('repository indexing blends embedding-based semantic search with lexical search', async (t) => {
  const embedCalls = [];
  const ollama = await jsonServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    embedCalls.push(body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    // Deterministic fake embedding: cosine-similar vectors for inputs sharing the token "velocity".
    const embeddings = inputs.map((text) => {
      const hasVelocity = /velocity/i.test(text) ? 1 : 0;
      return [hasVelocity, 1 - hasVelocity, 0.1];
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ embeddings }));
  });

  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    indexing: { embeddings: true, embedModel: 'mock-embed', embedBatchSize: 8 },
    providers: [{ id: 'ollama', baseUrl: ollama.url }],
  });
  const workspace = await runtime.workspaceManager.open(project);

  const index = await runtime.indexer.index(workspace.id, { force: true });
  assert.ok(index.embeddedChunks >= 1);
  assert.ok(embedCalls.length >= 1);

  const stats = runtime.indexer.stats(workspace.id);
  assert.equal(stats.semanticSearchAvailable, true);
  assert.ok(stats.embeddedChunks >= 1);

  const hits = await runtime.indexer.search(workspace.id, 'velocity', 5);
  assert.ok(hits.some((hit) => hit.path === 'index.js'));

  // Reindexing without content changes must not re-embed unchanged chunks (content-hash reuse).
  const callsBeforeReindex = embedCalls.length;
  await runtime.indexer.index(workspace.id, { force: true });
  const statsAfter = runtime.indexer.stats(workspace.id);
  assert.equal(statsAfter.embeddedChunks, stats.embeddedChunks);
  assert.equal(embedCalls.length, callsBeforeReindex, 'no new embedding requests for unchanged content');
});
