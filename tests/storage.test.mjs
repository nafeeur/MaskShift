import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GiB, MiB, computeBudget, formatBytes, pressureOf, probeHost } from '../src/storage/budget.mjs';
import { directorySize } from '../src/storage/size.mjs';
import { Store } from '../src/core/store.mjs';
import { prioritise } from '../src/indexer/scan.mjs';
import { runCommand } from '../src/core/utils.mjs';
import { createProject, runtimeForTest, tempDir } from './helpers.mjs';

const host = (overrides = {}) => ({ diskTotal: 256 * GiB, diskFree: 60 * GiB, memTotal: 16 * GiB, cpus: 8, ...overrides });
const DAY = 86_400_000;

test('the budget follows the disk: roomy hosts get more, tight ones get less and keep things for less time', () => {
  const roomy = computeBudget(host({ diskTotal: 2048 * GiB, diskFree: 1500 * GiB }), 0);
  const normal = computeBudget(host(), 0);
  const tight = computeBudget(host({ diskTotal: 128 * GiB, diskFree: 8 * GiB }), 2 * GiB);
  const critical = computeBudget(host({ diskTotal: 128 * GiB, diskFree: 1.5 * GiB }), 2 * GiB);
  assert.deepEqual([roomy, normal, tight, critical].map((item) => item.pressure), ['roomy', 'normal', 'tight', 'critical']);
  assert.ok(roomy.total > normal.total && normal.total > tight.total && tight.total >= critical.total);
  assert.ok(roomy.total <= 40 * GiB, 'never more than 40 GiB however large the disk');
  for (const [a, b] of [[roomy, normal], [normal, tight], [tight, critical]]) {
    assert.ok(a.checkpoints.keepPerWorkspace >= b.checkpoints.keepPerWorkspace);
    assert.ok(a.checkpoints.maxAgeDays >= b.checkpoints.maxAgeDays);
    assert.ok(a.runEventDays >= b.runEventDays);
    assert.ok(a.index.maxTextBytes >= b.index.maxTextBytes);
  }
  assert.ok(critical.checkpoints.keepPerWorkspace >= 3 && critical.checkpoints.maxAgeDays >= 2, 'a floor keeps recent undo points even when starved');
  assert.equal(normal.share.index + normal.share.checkpoints + normal.share.other, normal.total);
});

test('a nearly full disk never gets a budget bigger than what it could reclaim', () => {
  const small = computeBudget(host({ diskTotal: 16 * GiB, diskFree: 1 * GiB }), 0.5 * GiB);
  assert.ok(small.total <= 0.5 * (1 * GiB + 0.5 * GiB) + 1, `${formatBytes(small.total)}`);
});

test('memory caps how much one workspace may index, and explicit settings win', () => {
  const lowMemory = computeBudget(host({ memTotal: 2 * GiB }), 0);
  const highMemory = computeBudget(host({ memTotal: 64 * GiB }), 0);
  assert.ok(lowMemory.index.maxTextBytes < highMemory.index.maxTextBytes);
  assert.ok(lowMemory.index.maxFiles < highMemory.index.maxFiles);
  const pinned = computeBudget(host(), 0, { maxGb: 3, indexMaxMb: 50, keepCheckpoints: 7, checkpointMaxAgeDays: 9, runEventDays: 11, staleIndexDays: 13, indexMaxFiles: 1234 });
  assert.equal(pinned.total, 3 * GiB);
  assert.equal(pinned.index.maxTextBytes, 50 * MiB);
  assert.equal(pinned.index.maxFiles, 1234);
  assert.equal(pinned.checkpoints.keepPerWorkspace, 7);
  assert.equal(pinned.checkpoints.maxAgeDays, 9);
  assert.equal(pinned.runEventDays, 11);
  assert.equal(pinned.index.staleDays, 13);
});

test('probing this machine yields a usable budget, and a failed probe falls back to memory', async (t) => {
  const real = await probeHost(await tempDir(t));
  assert.ok(real.diskTotal > 0 && real.diskFree > 0 && real.memTotal > 0);
  assert.ok(computeBudget(real, 0).total >= 256 * MiB);
  const blind = computeBudget({ diskTotal: 0, diskFree: 0, memTotal: 8 * GiB, cpus: 4 }, 0);
  assert.ok(blind.total >= 1 * GiB && pressureOf({ diskTotal: 0, diskFree: 0 }) === 'normal');
});

test('directory sizes add up under concurrency', async (t) => {
  const root = await tempDir(t);
  let expected = 0;
  for (let a = 0; a < 6; a += 1) {
    for (let b = 0; b < 6; b += 1) {
      const dir = path.join(root, `a${a}`, `b${b}`);
      await fsp.mkdir(dir, { recursive: true });
      for (let c = 0; c < 5; c += 1) {
        const size = 100 + a * 10 + b + c;
        await fsp.writeFile(path.join(dir, `f${c}`), Buffer.alloc(size));
        expected += size;
      }
    }
  }
  assert.equal(await directorySize(root), expected);
  assert.equal(await directorySize(path.join(root, 'missing')), 0);
});

test('a new database reclaims space by itself and an old one can be converted', async (t) => {
  const dir = await tempDir(t);
  const fresh = new Store(path.join(dir, 'fresh.sqlite'));
  await fresh.init();
  assert.equal(fresh.dbInfo().autoVacuum, 2);
  const workspace = fresh.upsertWorkspace(dir, 'w');
  const chunks = Array.from({ length: 400 }, (_, index) => ({ id: `c${index}`, path: `f${index}.js`, language: 'javascript', startLine: 1, endLine: 2, content: 'x'.repeat(8000), contentHash: `h${index}`, indexedAt: new Date().toISOString() }));
  fresh.replaceRepoChunks(workspace.id, chunks);
  fresh.compact();
  const grown = (await fsp.stat(path.join(dir, 'fresh.sqlite'))).size;
  assert.ok(grown > 5 * MiB);
  assert.equal(fresh.dropWorkspaceIndex(workspace.id), 400);
  fresh.compact({ pages: 1_000_000 });
  assert.ok((await fsp.stat(path.join(dir, 'fresh.sqlite'))).size < grown / 4, 'deleted rows were given back to the filesystem');
  fresh.close();

  // A database created before auto_vacuum existed keeps its old mode until rebuilt.
  const legacyPath = path.join(dir, 'legacy.sqlite');
  const raw = new DatabaseSync(legacyPath);
  raw.exec('CREATE TABLE seed(x)');
  raw.close();
  const legacy = new Store(legacyPath);
  await legacy.init();
  assert.equal(legacy.dbInfo().autoVacuum, 0);
  legacy.vacuumFull();
  assert.equal(legacy.dbInfo().autoVacuum, 2);
  legacy.close();
});

test('indexing stops at the host-derived limits, says so, and keeps the most useful files', async (t) => {
  assert.deepEqual(prioritise(['docs/a.txt', 'z.txt', 'src/deep/x.js', 'main.js', 'src/b.js']), ['main.js', 'src/b.js', 'src/deep/x.js', 'z.txt', 'docs/a.txt']);
  const project = await createProject(t);
  for (let index = 0; index < 30; index += 1) {
    await fsp.mkdir(path.join(project, 'src', 'nested', 'deeper'), { recursive: true });
    await fsp.writeFile(path.join(project, 'src', 'nested', 'deeper', `deep${index}.js`), `export const deep${index} = ${index};\n`.repeat(40));
    await fsp.writeFile(path.join(project, `top${index}.js`), `export const top${index} = ${index};\n`.repeat(40));
    await fsp.writeFile(path.join(project, `note${index}.txt`), 'plain note\n'.repeat(40));
  }
  const runtime = await runtimeForTest(t, project, { storage: { auto: false, indexMaxFiles: 12 } });
  const workspace = await runtime.workspaceManager.open(project);
  const stats = await runtime.indexer.index(workspace.id, { force: true });
  assert.equal(stats.indexedFiles, 12);
  assert.equal(stats.truncated.reason, 'file limit');
  assert.ok(stats.truncated.skipped > 50);
  const indexedPaths = new Set(runtime.store.db.prepare('SELECT DISTINCT path FROM repo_chunks WHERE workspace_id = ?').all(workspace.id).map((row) => row.path));
  assert.ok([...indexedPaths].every((file) => !file.endsWith('.txt') && !file.includes('deeper')), `shallow source files win: ${[...indexedPaths].join(', ')}`);

  const bytes = await runtimeForTest(t, project, { storage: { auto: false, indexMaxMb: 1 } });
  bytes.indexer.limits = () => ({ maxFiles: 1000, maxTextBytes: 2000 });
  const sized = await bytes.indexer.index((await bytes.workspaceManager.open(project)).id, { force: true });
  assert.equal(sized.truncated.reason, 'size limit');
  assert.ok(sized.textBytes < 2000 + 2000, 'stops soon after the byte limit');
});

test('checkpoints copy untracked files only up to the host-derived size, and say what was left out', async (t) => {
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'small.txt'), 'x'.repeat(100));
  await fsp.writeFile(path.join(project, 'big.bin'), Buffer.alloc(5000));
  await fsp.writeFile(path.join(project, 'also-small.txt'), 'y'.repeat(100));
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  runtime.workspaceManager.prepareLimits = null;
  runtime.workspaceManager.checkpointLimits = () => ({ maxFileBytes: 1000, maxBytesEach: 150 });
  const checkpoint = await runtime.workspaceManager.createCheckpoint(workspace.id, { label: 'test' });
  assert.deepEqual(checkpoint.manifest.untracked, ['also-small.txt']);
  assert.equal(checkpoint.manifest.untrackedSkipped, 2);
  assert.equal(checkpoint.manifest.untrackedBytes, 100);
});

async function backdate(runtime, checkpoint, days) {
  runtime.store.db.prepare('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(new Date(Date.now() - days * DAY).toISOString(), checkpoint.id);
}

test('pruning removes old checkpoints, their copies and their Git refs, but keeps recent ones and every chat', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false, keepCheckpoints: 3, checkpointMaxAgeDays: 7 } });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id, title: 'keep me' });
  runtime.store.addMessage({ sessionId: session.id, role: 'user', content: 'precious conversation' });
  runtime.store.saveMemory?.({ workspaceId: workspace.id, content: 'a memory', title: 'm' });

  const made = [];
  for (let index = 0; index < 6; index += 1) {
    await fsp.writeFile(path.join(project, `scratch${index}.txt`), `scratch ${index}`);
    made.push(await runtime.workspaceManager.createCheckpoint(workspace.id, { label: `cp${index}` }));
  }
  // Newest first: made[5] is today. Age the rest.
  const ages = [20, 15, 10, 4, 2, 0.1];
  for (const [index, checkpoint] of made.entries()) await backdate(runtime, checkpoint, ages[index]);
  const refs = async () => (await runCommand('git for-each-ref refs/maskshift/checkpoints --format="%(refname)"', { cwd: project })).stdout.split('\n').filter(Boolean);
  assert.equal((await refs()).length, 6);

  const dry = await runtime.storageManager.prune({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(runtime.store.allCheckpoints().length, 6, 'a dry run changes nothing');
  assert.equal((await refs()).length, 6);

  const result = await runtime.storageManager.prune({ dryRun: false });
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  const left = runtime.store.allCheckpoints().map((checkpoint) => checkpoint.manifest.label).sort();
  // Of the older three, ages 20/15/10 days are past 7 days; 4 and 2 days are inside the window; today's is protected.
  assert.deepEqual(left, ['cp3', 'cp4', 'cp5']);
  assert.equal((await refs()).length, 3, 'removed checkpoints no longer pin Git commits');
  for (const checkpoint of made.slice(0, 3)) assert.equal(await fsp.stat(runtime.workspaceManager.checkpointStorageDir(checkpoint)).catch(() => null), null);
  for (const checkpoint of made.slice(3)) assert.ok(await fsp.stat(runtime.workspaceManager.checkpointStorageDir(checkpoint)));

  assert.equal(runtime.store.listMessages(session.id, 10)[0].content, 'precious conversation');
  assert.ok(runtime.store.getSession(session.id));
});

test('the newest checkpoint and anything under a day old survive however tight the rules', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false, keepCheckpoints: 1, checkpointMaxAgeDays: 1, maxGb: 0.001 } });
  const workspace = await runtime.workspaceManager.open(project);
  const first = await runtime.workspaceManager.createCheckpoint(workspace.id, {});
  const second = await runtime.workspaceManager.createCheckpoint(workspace.id, {});
  await runtime.storageManager.prune({ dryRun: false });
  assert.deepEqual(runtime.store.allCheckpoints().map((item) => item.id).sort(), [first.id, second.id].sort());
  await backdate(runtime, first, 3);
  await runtime.storageManager.prune({ dryRun: false });
  assert.deepEqual(runtime.store.allCheckpoints().map((item) => item.id), [second.id]);
});

test('orphaned checkpoint folders go once they are a day old, stale and missing indexes are dropped, old run events pruned', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false, staleIndexDays: 10, runEventDays: 5 } });
  const workspace = await runtime.workspaceManager.open(project);
  const home = runtime.config.get().home;
  const oldOrphan = path.join(home, 'checkpoints', 'cpref_orphan_old');
  const newOrphan = path.join(home, 'checkpoints', 'cpref_orphan_new');
  for (const dir of [oldOrphan, newOrphan]) { await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(path.join(dir, 'f'), 'x'); }
  const longAgo = new Date(Date.now() - 3 * DAY);
  await fsp.utimes(oldOrphan, longAgo, longAgo);

  await runtime.indexer.index(workspace.id, { force: true });
  assert.ok(runtime.store.repoIndexStats(workspace.id).chunks > 0);
  const stale = runtime.store.upsertWorkspace(await tempDir(t), 'stale');
  runtime.store.replaceRepoChunks(stale.id, [{ id: 'cs1', path: 'a.js', language: 'javascript', startLine: 1, endLine: 1, content: 'old', contentHash: 'hs', indexedAt: new Date().toISOString() }]);
  runtime.store.db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * DAY).toISOString(), stale.id);
  const gone = runtime.store.upsertWorkspace(path.join(home, 'no-such-folder'), 'gone');
  runtime.store.replaceRepoChunks(gone.id, [{ id: 'cg1', path: 'a.js', language: 'javascript', startLine: 1, endLine: 1, content: 'gone', contentHash: 'hg', indexedAt: new Date().toISOString() }]);

  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  const run = runtime.store.createRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'p', modelId: 'm' });
  runtime.store.addRunEvent(run.id, 'old', { a: 1 });
  runtime.store.addRunEvent(run.id, 'new', { a: 2 });
  runtime.store.db.prepare("UPDATE run_events SET created_at = ? WHERE type = 'old'").run(new Date(Date.now() - 20 * DAY).toISOString());

  const result = await runtime.storageManager.prune({ dryRun: false });
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  assert.equal(await fsp.stat(oldOrphan).catch(() => null), null);
  assert.ok(await fsp.stat(newOrphan), 'a folder under a day old may be a checkpoint being written');
  assert.equal(runtime.store.repoIndexStats(stale.id).chunks, 0);
  assert.equal(runtime.store.repoIndexStats(gone.id).chunks, 0);
  assert.ok(runtime.store.repoIndexStats(workspace.id).chunks > 0, 'the workspace in use keeps its index');
  assert.deepEqual(runtime.store.listRunEvents(run.id).map((event) => event.type), ['new']);
  assert.ok(runtime.store.getRun(run.id), 'the run itself is kept');
});

test('logs roll over past the limit and keep a few generations', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false } });
  const { logger } = runtime;
  for (let round = 1; round <= 4; round += 1) {
    logger.info('x'.repeat(2000), { round });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await logger.rotate('log', { maxBytes: 1000, keep: 3 }), true);
  }
  const files = (await fsp.readdir(path.dirname(logger.logFile))).filter((name) => name.startsWith(path.basename(logger.logFile)));
  assert.ok(files.includes(`${path.basename(logger.logFile)}.1`) && files.includes(`${path.basename(logger.logFile)}.3`));
  assert.ok(!files.includes(`${path.basename(logger.logFile)}.4`), 'only three generations are kept');
  logger.info('after rotation');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(await fsp.readFile(logger.logFile, 'utf8'), /after rotation/);
});

test('status reports usage, the derived budget and plain-language advice', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false, maxGb: 0.0001 } });
  const status = await runtime.storageManager.status();
  assert.ok(status.usage.database > 0 && status.usage.total >= status.usage.database);
  assert.equal(status.budget.total, Math.round(0.0001 * GiB));
  assert.ok(status.overBudget.total, 'a budget smaller than the database is reported as exceeded');
  assert.ok(status.advice.some((line) => /storage prune/.test(line)));
  assert.equal(status.budget.overrides.maxGb, 0.0001);
});

test('vacuum rebuilds the database and switches it to returning space automatically', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false } });
  const result = await runtime.storageManager.vacuum();
  assert.equal(result.autoVacuumNow, 2);
  assert.ok(result.afterBytes <= result.beforeBytes + 1_000_000);
});

test('the Disk use screens and the cleanup confirmation render, and storage tools answer', async (t) => {
  const { Writable } = await import('node:stream');
  const { MaskShiftTui } = await import('../src/tui/app.mjs');
  const { Theme } = await import('../src/tui/theme.mjs');
  const { ConfirmOverlay, TextOverlay } = await import('../src/tui/overlays.mjs');
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { storage: { auto: false, keepCheckpoints: 1, checkpointMaxAgeDays: 1 } });
  const workspace = await runtime.workspaceManager.open(project);
  const first = await runtime.workspaceManager.createCheckpoint(workspace.id, {});
  await runtime.workspaceManager.createCheckpoint(workspace.id, {});
  await backdate(runtime, first, 5);
  class Term extends Writable { constructor() { super(); this.columns = 110; this.rows = 30; this.isTTY = false; } _write(_c, _e, done) { done(); } }
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new Term(), headless: true, theme: new Theme({ depth: 24, unicode: true }) });
  await app.bootstrap();
  await app.openStorage();
  assert.ok(app.overlay instanceof TextOverlay);
  assert.match(app.overlay.body.join('\n'), /Checkpoints \(undo points\)[\s\S]*This machine:/);
  app.overlay = null;
  await app.confirmStoragePrune();
  assert.ok(app.overlay instanceof ConfirmOverlay);
  assert.match(app.overlay.details.join('\n'), /1 × old checkpoints/);
  await app.overlay.onConfirm();
  assert.equal(runtime.store.allCheckpoints().length, 1);
  app.snapshot();

  const status = await runtime.toolRegistry.execute('storage_status', {}, { workspaceId: workspace.id });
  assert.ok(JSON.stringify(status).includes('usage'));
});
