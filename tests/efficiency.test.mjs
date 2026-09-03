import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest, waitFor } from './helpers.mjs';

function contextFor(runtime, workspace, project) {
  return { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
}

test('Anthropic provider marks prompt-cache breakpoints and usage feeds run cost estimation', async (t) => {
  let turn = 0;
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    turn += 1;
    if (turn === 1) {
      return respondJson(response, 200, {
        id: 'msg_1', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call_1', name: 'fs_write', input: { path: 'cache-test.txt', content: 'ok\n' } }],
        usage: { input_tokens: 500, output_tokens: 20 },
      });
    }
    return respondJson(response, 200, {
      id: 'msg_2', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 480 },
    });
  });

  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-anthropic:fixture-claude',
    providers: [{
      id: 'fixture-anthropic', name: 'Fixture Anthropic', type: 'anthropic',
      baseUrl: modelServer.url, apiKey: 'test-key', enabled: true, autoDiscover: false,
      models: [{ id: 'fixture-claude' }], timeoutMs: 15_000,
    }],
    pricing: { currency: 'USD', models: { 'fixture-anthropic:fixture-claude': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 } } },
  });
  const workspace = await runtime.workspaceManager.open(project);

  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'Write cache-test.txt', modelRef: 'fixture-anthropic:fixture-claude' });
  const completed = await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'anthropic run completion' });

  assert.equal(completed.status, 'completed', completed.error || 'run should complete');
  assert.equal(requests.length, 2);

  // First turn: the system prompt is a cacheable block array, and the tool schema list is
  // marked cacheable on its last entry so the (often large) active tool set can be reused too.
  assert.ok(Array.isArray(requests[0].system));
  assert.ok(requests[0].system.some((block) => block.cache_control?.type === 'ephemeral'));
  assert.ok(requests[0].tools.at(-1).cache_control?.type === 'ephemeral');

  // Second turn: the conversation built up by the first turn (assistant tool_use + tool_result)
  // carries a cache_control breakpoint so it can be reused instead of rebilled in full.
  const historyBlocks = requests[1].messages.flatMap((message) => message.content);
  assert.ok(historyBlocks.some((block) => block.cache_control?.type === 'ephemeral'));

  // Usage from both turns (including the cache-read turn) rolls up into a priced cost estimate.
  assert.equal(completed.meta.costEstimate.pricedEntries, 2);
  assert.equal(completed.meta.costEstimate.unpricedEntries, 0);
  assert.equal(completed.meta.costEstimate.cacheReadTokens, 480);
  assert.ok(completed.meta.costEstimate.cost > 0);
});

test('usage_report aggregates cost per model and reports unpriced models honestly', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    pricing: { currency: 'USD', models: { 'anthropic:priced-model': { inputPerMTok: 3, outputPerMTok: 15 } } },
  });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.store.createSession({ workspaceId: workspace.id, title: 'usage test' });

  const priced = runtime.store.createRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'a', modelId: 'anthropic:priced-model' });
  runtime.store.updateRun(priced.id, { status: 'completed', meta: { usage: [{ input_tokens: 1_000_000, output_tokens: 1_000_000 }] } });

  const unpriced = runtime.store.createRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'b', modelId: 'anthropic:mystery-model' });
  runtime.store.updateRun(unpriced.id, { status: 'completed', meta: { usage: [{ input_tokens: 1000, output_tokens: 1000 }] } });

  const report = await runtime.toolRegistry.execute('usage_report', { scope: 'workspace' }, contextFor(runtime, workspace, project));
  assert.equal(report.runsConsidered, 2);
  assert.equal(report.byModel['anthropic:priced-model'].cost, 18);
  assert.equal(report.byModel['anthropic:priced-model'].unpricedEntries, 0);
  assert.equal(report.byModel['anthropic:mystery-model'].unpricedEntries, 1);
  assert.equal(report.totals.cost, 18);
  assert.equal(report.totals.unpricedEntries, 1);
});

test('memory_save deduplicates by title and memory_optimize merges duplicates and prunes stale entries', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { memory: { decayHalfLifeDays: 30 } });
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  const first = await runtime.toolRegistry.execute('memory_save', {
    title: 'Build command', content: 'Use npm run build.', tags: ['build'], importance: 0.4,
  }, context);
  const second = await runtime.toolRegistry.execute('memory_save', {
    title: '  build command  ', content: 'Use npm run build (updated).', tags: ['ci'], importance: 0.6,
  }, context);
  assert.equal(second.id, first.id, 'same-title save should merge into the existing memory, not create a new one');
  assert.equal(second.merged, true);
  assert.deepEqual(new Set(second.tags), new Set(['build', 'ci']));

  const distinct = await runtime.toolRegistry.execute('memory_save', {
    title: 'Deploy command', content: 'Use ./deploy.sh.', importance: 0.9,
  }, context);
  assert.notEqual(distinct.id, first.id);

  // Force a duplicate pair by writing directly with dedupe disabled, to exercise memory_optimize's merge path.
  const duplicate = runtime.store.saveMemory({
    workspaceId: workspace.id, scope: 'workspace', title: 'Build command', content: 'Stale duplicate.',
    importance: 0.1, dedupe: false,
  });
  assert.notEqual(duplicate.id, first.id);

  // Backdate the duplicate and a throwaway memory so they qualify as stale, never-accessed candidates.
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  runtime.store.db.prepare('UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?').run(old, old, duplicate.id);
  const throwaway = runtime.store.saveMemory({
    workspaceId: workspace.id, scope: 'workspace', title: 'Scratch note', content: 'Irrelevant one-off.', importance: 0.05,
  });
  runtime.store.db.prepare('UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?').run(old, old, throwaway.id);

  const dryRun = await runtime.toolRegistry.execute('memory_optimize', {}, context);
  assert.equal(dryRun.dryRun, true);
  assert.ok(dryRun.duplicateGroups.some((group) => group.survivorId === first.id && group.mergedIds.includes(duplicate.id)));
  assert.ok(dryRun.staleCandidates.some((item) => item.id === throwaway.id));

  const applied = await runtime.toolRegistry.execute('memory_optimize', { dryRun: false }, context);
  assert.equal(applied.dryRun, false);
  assert.ok(applied.merged >= 1);
  assert.ok(applied.pruned >= 1);
  assert.equal(runtime.store.getMemory(duplicate.id), null);
  assert.equal(runtime.store.getMemory(throwaway.id), null);
  assert.ok(runtime.store.getMemory(first.id), 'the merge survivor must remain');
});
