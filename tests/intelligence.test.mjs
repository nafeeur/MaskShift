import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createProject, runtimeForTest } from './helpers.mjs';

function context(runtime, workspace, project) {
  return {
    workspaceId: workspace.id, workspacePath: project, sessionId: 'test-session', runId: 'test-run',
    scope: { workspaceId: workspace.id, sessionId: 'test-session', runId: 'test-run' },
    eventBus: runtime.eventBus, store: runtime.store, planState: { summary: '', steps: [] },
  };
}

test('v1.2 code graph persists symbols and predicts reverse dependency impact', async (t) => {
  const project = await createProject(t);
  await fsp.mkdir(path.join(project, 'src'));
  await fsp.mkdir(path.join(project, 'tests'));
  await fsp.writeFile(path.join(project, 'src', 'math.js'), 'export function add(a, b) { return a + b; }\n');
  await fsp.writeFile(path.join(project, 'src', 'service.js'), "import { add } from './math.js';\nexport function total(items) { return add(items.length, 1); }\n");
  await fsp.writeFile(path.join(project, 'tests', 'service.test.js'), "import { total } from '../src/service.js';\ntest('total', () => total([]));\n");
  const runtime = await runtimeForTest(t, project, { indexing: { embeddings: false }, codeGraph: { enabled: true } });
  const workspace = await runtime.workspaceManager.open(project);
  const built = await runtime.codeGraph.build(workspace.id);
  assert.ok(built.nodes >= 6);
  assert.ok(built.edges >= 5);
  assert.ok(runtime.store.codeGraphStats(workspace.id).builtAt);

  const symbols = runtime.codeGraph.query(workspace.id, 'add', { kind: 'function' });
  assert.equal(symbols[0].name, 'add');
  const impact = runtime.codeGraph.impact(workspace.id, ['src/math.js'], { depth: 3 });
  assert.ok(impact.files.includes('src/service.js'));
  assert.ok(impact.files.includes('tests/service.test.js'));
  assert.ok(impact.tests.includes('tests/service.test.js'));
});

test('v1.2 context planner excludes provenance memory after its source changes', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { indexing: { embeddings: false } });
  const workspace = await runtime.workspaceManager.open(project);
  const ctx = context(runtime, workspace, project);
  await runtime.toolRegistry.execute('memory_save', {
    title: 'Velocity implementation', content: 'Velocity is computed in index.js.', sources: ['index.js'], tags: ['velocity'],
  }, ctx);
  let memories = runtime.store.searchMemories('velocity', { workspaceId: workspace.id });
  let checked = await runtime.contextPlanner.validateMemories(memories, project);
  assert.equal(checked[0].provenanceStatus, 'valid');
  await fsp.appendFile(path.join(project, 'index.js'), '// changed\n');
  memories = runtime.store.searchMemories('velocity', { workspaceId: workspace.id });
  checked = await runtime.contextPlanner.validateMemories(memories, project);
  assert.equal(checked[0].provenanceStatus, 'stale');
  const selected = runtime.contextPlanner.select({ prompt: 'velocity', repoHits: [], memories: checked, budgets: runtime.contextPlanner.budgets(20_000) });
  assert.equal(selected.memories.length, 0);
  assert.equal(selected.report.memories.staleExcluded, 1);
});

test('v1.3 router uses task profiles and historical outcomes', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture:general',
    routing: { autoSelect: true, models: [
      { model: 'fixture:ui', tags: ['frontend'], priority: 1 },
      { model: 'fixture:systems', tags: ['systems'], priority: 1 },
    ] },
  });
  const workspace = await runtime.workspaceManager.open(project);
  const route = runtime.intelligenceRouter.routeModel('Fix the React component and CSS layout', { workspaceId: workspace.id });
  assert.equal(route.selected, 'fixture:ui');
  assert.ok(route.taskProfile.tags.includes('frontend'));
});

test('v1.3 DAG plans validate dependencies and reject cycles', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const ctx = context(runtime, workspace, project);
  const plan = await runtime.toolRegistry.execute('plan_dag_update', { summary: 'Build and verify', nodes: [
    { id: 'inspect', task: 'Inspect the implementation' },
    { id: 'verify', task: 'Verify the result', dependsOn: ['inspect'] },
  ] }, ctx);
  assert.equal(plan.dag[1].dependsOn[0], 'inspect');
  await assert.rejects(runtime.toolRegistry.execute('plan_dag_update', { nodes: [
    { id: 'a', task: 'A', dependsOn: ['b'] }, { id: 'b', task: 'B', dependsOn: ['a'] },
  ] }, ctx), /cycle/);

  await runtime.toolRegistry.execute('plan_dag_update', { nodes: [
    { id: 'edit', task: 'Edit implementation', mode: 'edit' },
    { id: 'check', task: 'Check implementation', dependsOn: ['edit'] },
  ] }, ctx);
  const calls = [];
  const originalDelegate = runtime.engine.delegate.bind(runtime.engine);
  runtime.engine.delegate = async (args) => {
    calls.push(args);
    return { runId: `run-${calls.length}`, status: 'completed', workspaceId: args.workspaceId || 'branch-workspace', final: 'ok', isolation: args.isolated ? { workspaceId: 'branch-workspace' } : null };
  };
  t.after(() => { runtime.engine.delegate = originalDelegate; });
  const executed = await runtime.toolRegistry.execute('agent_dag_execute', {}, ctx);
  assert.equal(executed.plan.dag[1].status, 'completed');
  assert.equal(calls[0].isolated, true);
  assert.equal(calls[1].workspaceId, 'branch-workspace');
  assert.equal(calls[1].isolated, false);
});

test('validated skill promotion requires measured uplift and no regressions', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const ctx = context(runtime, workspace, project);
  await runtime.skillManager.create({ name: 'measured-workflow', description: 'A workflow used to test evidence-based promotion.', body: '# Workflow\n\nRun the deterministic fixture.' });
  for (let index = 0; index < 3; index += 1) {
    await runtime.toolRegistry.execute('skill_evaluate', { skillName: 'measured-workflow', taskKey: `case-${index}`, baselinePassed: index === 0, candidatePassed: true, evidence: { fixture: true } }, ctx);
  }
  const promoted = await runtime.toolRegistry.execute('skill_promote_validated', { skillName: 'measured-workflow', addition: 'Also verify the fixture output.', minTrials: 3 }, ctx);
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.report.uplift, 2 / 3);
});
