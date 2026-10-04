import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { classifyTask, similarity } from '../src/learning/profile.mjs';
import { OutcomeLedger, harnessExecutor, modelExecutor } from '../src/learning/ledger.mjs';
import { LearnedRouter, scoreCandidate } from '../src/learning/route.mjs';
import { buildTrace, commandKey, correctionsIn, isVerifyCommand } from '../src/learning/trace.mjs';
import { LessonStore, deriveLessons, errorSignature } from '../src/learning/lessons.mjs';
import { PreferenceStore, extractPreferences } from '../src/learning/preferences.mjs';
import { applyConsolidation, planConsolidation } from '../src/learning/consolidate.mjs';
import { draftSkill, minePatterns, stepsOf } from '../src/learning/skill-miner.mjs';
import { ContextFeedback, measureUse } from '../src/learning/context-feedback.mjs';
import { emptyState, extractState, renderState } from '../src/learning/state.mjs';
import { ambiguityNote, assessCall, assessCommand, assessPrompt } from '../src/learning/uncertainty.mjs';
import { ProgressMonitor, stuckNudge } from '../src/learning/progress.mjs';
import { ToolCache, planBatches } from '../src/agent/tool-cache.mjs';
import { createProject, runtimeForTest, tempDir } from './helpers.mjs';

const DAY = 86_400_000;

async function learningRuntime(t, overrides = {}) {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, overrides);
  const workspace = await runtime.workspaceManager.open(project);
  return { project, runtime, workspace, learning: runtime.learningManager, store: runtime.store };
}

const ev = (type, payload = {}) => ({ type, payload });
const call = (id, name, args) => ev('assistant', { toolCalls: [{ id, name, args }] });
const result = (id, tool, content, error = false) => ev(error ? 'tool-error' : 'tool-result', { toolCallId: id, tool, content });

// ---------------------------------------------------------------- profile

test('tasks are classified by kind of work and compared by how alike they are', () => {
  const fix = classifyTask('Fix the crash in the react component when the list is empty');
  assert.ok(['frontend', 'debugging'].every((tag) => fix.tags.includes(tag)), fix.tags.join());
  assert.deepEqual(classifyTask('hello there').tags, ['general-coding']);
  assert.equal(classifyTask('refactor the whole module across the repo').complexity, 'high');
  const near = similarity(fix, classifyTask('Fix the crash in the react list component'));
  const far = similarity(fix, classifyTask('Write a README for the deployment pipeline with docker'));
  assert.ok(near > far && near > 0.4, `${near} vs ${far}`);
});

// ----------------------------------------------------------- ledger + route

test('the ledger weights similar tasks and recent outcomes, and the router prefers what has worked at lower cost', async (t) => {
  const { store } = await learningRuntime(t);
  const ledger = new OutcomeLedger({ store });
  const profile = classifyTask('fix the failing test in the parser');
  const add = (executor, success, cost, prompt = 'fix the failing test in the parser', ageDays = 0) => {
    const row = ledger.record({ executor, kind: 'model', ...classifyTask(prompt), status: success ? 'completed' : 'failed', success, steps: 5, cost, durationMs: 1000, corrections: 0 });
    if (ageDays) store.db.prepare('UPDATE run_outcomes SET created_at = ? WHERE id = ?').run(new Date(Date.now() - ageDays * DAY).toISOString(), row.id);
  };
  for (let i = 0; i < 6; i += 1) add('model:cheap', i < 5, 0.01);
  for (let i = 0; i < 6; i += 1) add('model:pricey', i < 5, 0.40);
  for (let i = 0; i < 6; i += 1) add('model:bad', i < 1, 0.02);
  for (let i = 0; i < 8; i += 1) add('model:cheap', false, 0.01, 'write a haiku about the sea'); // different kind of task: must not drag it down

  const router = new LearnedRouter({ ledger, config: { get: () => ({}) } });
  const { ranked, informed } = router.rank(['model:cheap', 'model:pricey', 'model:bad', 'model:new'].map((executor) => ({ executor })), profile);
  assert.equal(informed, true);
  assert.equal(ranked[0].executor, 'model:cheap', 'equal success, lower cost wins');
  assert.equal(ranked.at(-1).executor, 'model:bad');
  assert.ok(ranked.find((item) => item.executor === 'model:new').learned.bonus > ranked[0].learned.bonus, 'an untried candidate is given room to be tried');
  const stats = ledger.stats('model:cheap', profile);
  assert.ok(stats.rate > 0.7, `the haiku failures were ignored: ${stats.rate}`);

  // Old outcomes fade.
  add('model:aged', false, 0.01, 'fix the failing test in the parser', 400);
  assert.equal(ledger.stats('model:aged', profile).effective, 0, 'beyond the window it is not counted at all');
  const plan = router.plan([{ executor: 'model:cheap' }, { executor: 'model:bad' }], profile);
  assert.equal(plan.primary.executor, 'model:cheap');
  assert.equal(plan.escalation[0].executor, 'model:bad');
  assert.match(router.explain(ranked).join('\n'), /1\. model:cheap: \d+% expected/);
});

test('with no history the router says so and a lucky run proves little', () => {
  const none = scoreCandidate({ effective: 0, successes: 0, globalRate: null, avgCost: null });
  assert.equal(none.successRate, 0.5);
  const lucky = scoreCandidate({ effective: 1, successes: 1, globalRate: null, avgCost: null });
  const proven = scoreCandidate({ effective: 20, successes: 19, globalRate: null, avgCost: null });
  assert.ok(lucky.successRate < proven.successRate);
  const router = new LearnedRouter({ ledger: { stats: () => ({ effective: 0, successes: 0, globalRate: null }) }, config: { get: () => ({}) } });
  assert.equal(router.rank([{ executor: 'a' }], classifyTask('x')).informed, false);
  assert.equal(new LearnedRouter({ ledger: { stats: () => ({ effective: 50, successes: 40, globalRate: 0.8 }) }, config: { get: () => ({ learning: { routing: { learned: false } } }) } }).rank([{ executor: 'a' }], classifyTask('x')).informed, false, 'can be switched off');
});

test('model routing uses the learned record, honours configuration, and offers the next candidate to escalate to', async (t) => {
  const { runtime, workspace, store } = await learningRuntime(t, {
    routing: { models: [{ model: 'p:strong', tags: [], priority: 0 }, { model: 'p:cheap', tags: [], priority: 0 }, { model: 'p:other', tags: [], priority: 0 }] },
  });
  const ledger = runtime.learningManager.ledger;
  const prompt = 'fix the bug in the parser';
  const add = (model, success, cost) => ledger.record({ executor: modelExecutor(model), kind: 'model', workspaceId: workspace.id, ...classifyTask(prompt), status: success ? 'completed' : 'failed', success, steps: 4, cost });
  for (let i = 0; i < 8; i += 1) add('p:cheap', true, 0.01);
  for (let i = 0; i < 8; i += 1) add('p:strong', i % 4 !== 0, 0.5);
  const route = runtime.intelligenceRouter.routeModel(prompt, { workspaceId: workspace.id, fallback: 'p:strong' });
  assert.equal(route.selected, 'p:cheap');
  assert.equal(route.informed, true);
  assert.match(route.explanation[0], /p:cheap/);
  const next = runtime.intelligenceRouter.escalation(route, ['p:cheap']);
  assert.ok(next && next.model !== 'p:cheap');
  assert.equal(runtime.intelligenceRouter.escalation(route, route.candidates.map((item) => item.model)), null, 'nothing left to try');
  assert.ok(store.listOutcomes({ limit: 100 }).length >= 16);
});

// -------------------------------------------------------------------- trace

test('a trace reads files, commands, verification and corrections out of run events', () => {
  const trace = buildTrace([
    ev('model-turn', { step: 1 }), call('a', 'fs_read', { path: 'src/a.js' }), result('a', 'fs_read', 'x'),
    ev('model-turn', { step: 2 }), call('b', 'fs_patch', { path: 'src/a.js', edits: [] }), result('b', 'fs_patch', 'ok'),
    call('c', 'shell_exec', { command: 'npm test --silent' }), result('c', 'shell_exec', 'fail', true),
    ev('verification', { ok: false, attempt: 1, results: [{ command: 'npm test', ok: false }] }),
    ev('stagnation', { level: 'warn' }), ev('tool-call-repaired', {}), ev('steered', {}),
  ]);
  assert.deepEqual([...trace.read], ['src/a.js']);
  assert.deepEqual([...trace.edited], ['src/a.js']);
  assert.equal(trace.commands[0].key, 'npm test');
  assert.equal(correctionsIn(trace), 4);
  assert.equal(commandKey('cd app && pnpm run build -- --prod'), 'pnpm build');
  assert.ok(isVerifyCommand('cargo test --all') && isVerifyCommand('npm run lint') && !isVerifyCommand('npm install'));
});

// ------------------------------------------------------------------ lessons

function failedThenFixedRun() {
  return {
    run: { id: 'r1', prompt: 'make the tests pass', status: 'completed' },
    trace: buildTrace([
      ev('model-turn', { step: 1 }),
      call('a', 'shell_exec', { command: 'npm test' }), result('a', 'shell_exec', JSON.stringify({ error: 'Error: Cannot find module "/home/u/app/src/x.js" at line 12' }), true),
      call('b', 'shell_exec', { command: 'npm test -- --no-cache' }), result('b', 'shell_exec', 'ok'),
      ev('verification', { ok: false, attempt: 1, results: [{ command: 'npm test', ok: false }] }),
      call('c', 'fs_patch', { path: 'src/x.js', edits: [] }), result('c', 'fs_patch', 'ok'),
      ev('verification', { ok: true, attempt: 2, results: [{ command: 'npm test', ok: true }] }),
      call('d', 'shell_exec', { command: 'npm test' }), result('d', 'shell_exec', 'pass'),
    ]),
  };
}

test('lessons are derived from what actually happened, not guessed', () => {
  const { run, trace } = failedThenFixedRun();
  const lessons = deriveLessons(run, trace);
  const keys = lessons.map((lesson) => lesson.key);
  assert.ok(keys.some((key) => key.startsWith('verify:npm test')), 'a command that passed at the end is how this project is checked');
  assert.ok(keys.some((key) => key.startsWith('fix:npm test:')), 'a failing command followed by a working one');
  assert.ok(keys.some((key) => key.startsWith('verify-loop:')), 'verification that failed first');
  const fix = lessons.find((lesson) => lesson.key.startsWith('fix:'));
  assert.match(fix.content, /npm test -- --no-cache.*worked/);
  assert.doesNotMatch(fix.content, /\/home\/u/, 'paths are generalised out of the signature');
  assert.equal(errorSignature('Error at /a/b/c.js:12 abc1234def'), 'Error at <path>:# <hash>');
  assert.deepEqual(deriveLessons({ ...run, status: 'failed' }, buildTrace([])).filter((lesson) => lesson.kind === 'fact'), []);
  const loop = deriveLessons({ id: 'r2', prompt: 'x', status: 'stagnated' }, buildTrace([call('z', 'fs_read', { path: 'a' }), result('z', 'fs_read', 'x'), ev('stagnation', { level: 'stop', tool: 'fs_read' })]));
  assert.ok(loop.some((lesson) => lesson.key.startsWith('loop:fs_read')));
});

test('lessons are reinforced, shown only for similar tasks, trusted by how those runs went, and pruned when wrong', async (t) => {
  const { store, workspace } = await learningRuntime(t);
  const lessons = new LessonStore({ store, config: { get: () => ({}) } });
  const { run, trace } = failedThenFixedRun();
  const derived = deriveLessons(run, trace);
  for (const lesson of derived) lessons.save(lesson, { workspaceId: workspace.id, runId: 'r1' });
  for (const lesson of derived) lessons.save(lesson, { workspaceId: workspace.id, runId: 'r2' }); // seen again
  const listed = lessons.list({ workspaceId: workspace.id });
  assert.equal(listed.length, derived.length, 'reinforced, not duplicated');
  assert.ok(listed.every((item) => item.occurrences === 2));

  const similar = lessons.relevant({ prompt: 'get the failing tests passing again', workspaceId: workspace.id });
  assert.ok(similar.length > 0 && similar.every((item) => item.text.length));
  assert.equal(lessons.relevant({ prompt: 'write a poem about autumn leaves', workspaceId: workspace.id }).filter((item) => item.kind === 'lesson').length, 0, 'unrelated tasks do not see lessons');
  assert.ok(lessons.relevant({ prompt: 'fix the failing build', workspaceId: workspace.id }).some((item) => item.kind === 'fact'), 'how to check the project is offered for code tasks');

  const target = similar[0].id;
  for (let i = 0; i < 6; i += 1) lessons.credit([target], false);
  assert.ok(!lessons.relevant({ prompt: 'get the failing tests passing again', workspaceId: workspace.id }).some((item) => item.id === target), 'a lesson that keeps preceding failures stops being shown');
  assert.ok(lessons.prune() >= 1);
  assert.equal(store.getMemory(target), null);
  const good = lessons.list({ workspaceId: workspace.id })[0];
  for (let i = 0; i < 4; i += 1) lessons.credit([good.id], true);
  assert.ok(lessons.list({ workspaceId: workspace.id }).find((item) => item.id === good.id).confidence > 0.7);
});

// ------------------------------------------------------------- preferences

test('preferences are read from the user\'s own words, and one-off corrections need repeating', async (t) => {
  assert.deepEqual(extractPreferences('Please fix the bug.').length, 0);
  assert.ok(extractPreferences('Always use tabs for indentation.')[0].explicit);
  assert.equal(extractPreferences('No, don\'t touch the tests.')[0].explicit, false);
  assert.equal(extractPreferences('Always use tabs?').length, 1, 'an explicit standing statement counts even when phrased as a question');
  assert.equal(extractPreferences('What is a good way to do this?').length, 0);
  assert.equal(extractPreferences('```\nalways never don\'t\n```').length, 0, 'pasted code is not a preference');

  const { store, workspace } = await learningRuntime(t);
  const prefs = new PreferenceStore({ store });
  const user = (content) => ({ role: 'user', content, meta: {} });
  prefs.learnFrom([user('From now on, answer in short paragraphs.')], { workspaceId: workspace.id });
  prefs.learnFrom([user('No, don\'t touch the lockfile.')], { workspaceId: workspace.id });
  prefs.learnFrom([{ role: 'user', content: 'Always do something weird here.', meta: { synthetic: true } }, { role: 'assistant', content: 'Always x', meta: {} }], { workspaceId: workspace.id });
  let top = prefs.top({ workspaceId: workspace.id });
  assert.deepEqual(top.map((item) => item.text), ['Answer in short paragraphs.'.replace('Answer', 'From now on, answer')].map((text) => top[0].text), 'only the explicit one is active so far');
  assert.equal(top.length, 1);
  assert.equal(prefs.list({ workspaceId: workspace.id }).length, 2);
  prefs.learnFrom([user('No, don\'t touch the lockfile please.')], { workspaceId: workspace.id });
  top = prefs.top({ workspaceId: workspace.id });
  assert.equal(top.length, 2, 'said twice, the correction now counts');
  assert.equal(prefs.list({ workspaceId: workspace.id }).length, 2, 'merged, not duplicated');
  const general = store.listMemoriesByKind('preference', { workspaceId: workspace.id }).find((memory) => /short paragraphs/.test(memory.content));
  assert.equal(general.scope, 'global', 'a style statement with no file in it applies everywhere');
});

// ----------------------------------------------------------- consolidation

test('memories that say the same thing differently are folded together, without crossing scopes', async (t) => {
  const { store, workspace } = await learningRuntime(t);
  const save = (title, content, extra = {}) => store.saveMemory({ workspaceId: workspace.id, title, content, tags: [title.split(' ')[0]], importance: 0.5, dedupe: false, ...extra });
  const a = save('Database choice', 'The project uses PostgreSQL 15 for the primary database and Redis for caching.');
  const b = save('Primary datastore', 'The project uses PostgreSQL 15 for its primary database, with Redis used for caching and sessions.', { importance: 0.7 });
  save('Unrelated', 'Deploys happen from the main branch through the nightly pipeline on Fridays.');
  const other = store.saveMemory({ workspaceId: null, scope: 'global', title: 'Global db', content: 'The project uses PostgreSQL 15 for the primary database and Redis for caching.', dedupe: false });
  const plans = planConsolidation(store.listMemories({ workspaceId: workspace.id, limit: 100 }));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].survivorId, b.id, 'the more important memory survives');
  assert.deepEqual(plans[0].mergedIds, [a.id]);
  assert.match(plans[0].content, /sessions/);
  assert.equal(applyConsolidation(store, plans), 1);
  assert.equal(store.getMemory(a.id), null);
  assert.ok(store.getMemory(other.id), 'a global memory is never absorbed into a workspace one');
});

test('memory_optimize also merges near-duplicates, and only when asked to apply', async (t) => {
  const { runtime, workspace, store } = await learningRuntime(t);
  const context = { workspaceId: workspace.id, workspacePath: workspace.path };
  const make = (title, content) => store.saveMemory({ workspaceId: workspace.id, title, content, importance: 0.5, dedupe: false });
  make('Test command', 'Run the unit tests with npm test from the repository root before every commit.');
  make('How to test', 'Run the unit tests with npm test from the repository root before each commit.');
  const dry = await runtime.toolRegistry.execute('memory_optimize', {}, context);
  assert.equal(dry.similarGroups.length, 1);
  assert.equal(store.listMemories({ workspaceId: workspace.id, limit: 100 }).length, 2);
  const done = await runtime.toolRegistry.execute('memory_optimize', { dryRun: false }, context);
  assert.equal(done.merged, 1);
  assert.equal(store.listMemories({ workspaceId: workspace.id, limit: 100 }).length, 1);
});

// ------------------------------------------------------------- skill mining

const minedRun = (id, steps, success = true, prompt = 'fix the lint errors in the api') => ({
  id, steps, success, calls: steps.map((step) => ({ name: step.startsWith('shell:') ? 'shell_exec' : step, args: step.startsWith('shell:') ? { command: step.slice(6) } : { path: 'src/api/a.js' } })),
  commands: steps.filter((step) => step.startsWith('shell:')).map((step) => ({ command: `${step.slice(6)} --fix`, key: step.slice(6) })), ...classifyTask(prompt),
});

test('a workflow repeated across runs is found, trimmed to its longest form, and drafted as a skill', () => {
  const flow = ['fs_read', 'fs_patch', 'shell:npm run lint', 'shell:npm test'];
  const runs = [
    minedRun('1', ['fs_list', ...flow]), minedRun('2', flow), minedRun('3', [...flow, 'git_diff']),
    minedRun('4', ['fs_read', 'fs_list', 'search_text']), minedRun('5', ['fs_read', 'fs_list', 'search_text']), minedRun('6', ['fs_read', 'fs_list', 'search_text']),
  ];
  const found = minePatterns(runs, { minRuns: 3 });
  assert.equal(found[0].steps.join('>'), flow.join('>'));
  assert.ok(!found.some((item) => item.steps.join('>') === 'fs_read>fs_list>search_text'), 'pure reading is not a skill');
  assert.ok(!found.some((item) => item.steps.length < flow.length && flow.join('>').includes(item.steps.join('>'))), 'a fragment of a longer workflow adds nothing');
  assert.equal(found[0].support, 3);
  const draft = draftSkill(found[0]);
  assert.match(draft.name, /^mined-/);
  assert.match(draft.body, /Run `npm run lint --fix`/);
  assert.match(draft.body, /1\. /);
  assert.equal(minePatterns(runs.slice(0, 2), { minRuns: 3 }).length, 0, 'two runs is a coincidence');
  assert.equal(minePatterns([minedRun('a', flow, false), minedRun('b', flow, false), minedRun('c', flow, false), minedRun('d', flow, true)], { minRuns: 3 }).length, 0, 'a workflow that mostly fails is not worth saving');
});

test('mining reads real runs, proposes candidates, installs on accept, and tracks how the skill does', async (t) => {
  const { runtime, workspace, store, learning } = await learningRuntime(t);
  for (let i = 0; i < 4; i += 1) {
    const session = runtime.engine.createSession({ workspaceId: workspace.id });
    const run = store.createRun({ sessionId: session.id, workspaceId: workspace.id, prompt: `fix the lint errors in the api number ${i}`, modelId: 'p:m' });
    store.updateRun(run.id, { status: 'completed', ended_at: new Date().toISOString() });
    let n = 0;
    for (const [name, args] of [['fs_read', { path: 'src/a.js' }], ['fs_patch', { path: 'src/a.js', edits: [] }], ['shell_exec', { command: 'npm run lint' }], ['shell_exec', { command: 'npm test' }]]) {
      n += 1;
      store.addRunEvent(run.id, 'assistant', { toolCalls: [{ id: `c${n}`, name, args }] });
      store.addRunEvent(run.id, 'tool-result', { toolCallId: `c${n}`, tool: name, content: 'ok' });
    }
  }
  const found = learning.miner.mine({ workspaceId: workspace.id });
  assert.equal(found.length, 1);
  assert.equal(found[0].status, 'proposed');
  assert.equal(learning.miner.mine({ workspaceId: workspace.id })[0].id, found[0].id, 'stable across passes');
  await assert.rejects(learning.miner.accept(workspace.id, 'nope'), /No skill candidate/);
  const skill = await learning.miner.accept(workspace.id, found[0].name);
  assert.ok(skill);
  assert.ok((await runtime.skillManager.scan(), runtime.skillManager.list().some((item) => item.name === found[0].name)));
  assert.equal(learning.miner.candidates(workspace.id)[0].status, 'accepted');
  assert.equal(learning.miner.mine({ workspaceId: workspace.id })[0].status, 'accepted', 'decisions survive re-mining');
  const dismissed = learning.miner.dismiss(workspace.id, found[0].id);
  assert.equal(dismissed.status, 'dismissed');

  const outcome = (skills, success) => store.addOutcome({ executor: 'model:p:m', kind: 'model', tags: ['debugging'], tokens: [], status: success ? 'completed' : 'failed', success, meta: { skills } });
  outcome([found[0].name], true); outcome([found[0].name], true); outcome([], false); outcome([], true);
  const impact = learning.miner.impact(found[0].name);
  assert.equal(impact.uses, 2);
  assert.equal(impact.rate, 1);
  assert.equal(impact.baseline, 0.5);
});

// ---------------------------------------------------------- context feedback

test('unused context shrinks the source budget, missed files grow it, and nothing moves without evidence', async (t) => {
  const plan = { profile: 'focused', source: { items: ['a.js', 'b.js', 'c.js', 'd.js'].map((file) => ({ path: file })) } };
  const trace = (read, edited = []) => ({ read: new Set(read), edited: new Set(edited) });
  const wasteful = measureUse(plan, trace(['a.js']), { finalText: '' });
  assert.equal(wasteful.precision, 0.25);
  assert.equal(wasteful.recall, 1);
  const missed = measureUse(plan, trace(['x.js', 'y.js', 'a.js']), {});
  assert.equal(missed.recall, 1 / 3);
  assert.equal(measureUse(plan, trace(['/repo/c.js']), { root: '/repo' }).used, 1);
  assert.equal(measureUse(plan, trace([]), { finalText: 'I changed b.js and d.js' }).used, 2, 'a file named in the answer was used');

  const { store } = await learningRuntime(t);
  const feedback = new ContextFeedback({ store, config: { get: () => ({}) } });
  for (let i = 0; i < 4; i += 1) feedback.record(wasteful);
  assert.equal(feedback.multiplier('focused'), 1, 'four runs is not enough');
  for (let i = 0; i < 4; i += 1) feedback.record(wasteful);
  assert.ok(feedback.multiplier('focused') < 1 && feedback.multiplier('focused') >= 0.6);
  for (let i = 0; i < 12; i += 1) feedback.record({ ...missed, profile: 'broad' });
  assert.ok(feedback.multiplier('broad') > 1 && feedback.multiplier('broad') <= 1.4);
  assert.equal(new ContextFeedback({ store, config: { get: () => ({ learning: { context: { adapt: false } } }) } }).multiplier('focused'), 1);
});

test('the context planner applies the learned multiplier to the source share only', async (t) => {
  const { runtime } = await learningRuntime(t);
  const planner = runtime.contextPlanner;
  const base = planner.budgets(100_000, 'focused');
  planner.learnedMultiplier = () => 0.6;
  const shrunk = planner.budgets(100_000, 'focused');
  assert.ok(shrunk.source < base.source && shrunk.instructions >= 12_000 && shrunk.memories >= base.memories * 0.9);
  planner.learnedMultiplier = () => 1;
});

// --------------------------------------------------------- working state

test('working state is read off the tool calls and rendered compactly, surviving what a summary loses', () => {
  const history = [
    { role: 'user', content: 'Make the parser handle empty input' },
    { role: 'assistant', content: 'I decided to guard at the entry point.', toolCalls: [{ id: '1', name: 'fs_read', args: { path: 'src/parse.js' } }, { id: '2', name: 'shell_exec', args: { command: 'npm test' } }] },
    { role: 'tool', toolCallId: '1', toolName: 'fs_read', content: '...' },
    { role: 'tool', toolCallId: '2', toolName: 'shell_exec', content: 'Error: boom at /x/y/z.js:10', isError: true },
    { role: 'assistant', content: '', toolCalls: [{ id: '3', name: 'fs_patch', args: { path: 'src/parse.js', edits: [] } }, { id: '4', name: 'shell_exec', args: { command: 'npm test' } }] },
    { role: 'tool', toolCallId: '3', toolName: 'fs_patch', content: 'ok' },
    { role: 'tool', toolCallId: '4', toolName: 'shell_exec', content: 'pass' },
  ];
  const state = extractState(history);
  assert.equal(state.goal, 'Make the parser handle empty input');
  assert.deepEqual(state.edited, ['src/parse.js']);
  assert.deepEqual(state.read, [], 'a file that was then changed is listed once, as changed');
  assert.ok(state.decisions[0].includes('guard at the entry point'));
  const text = renderState(state);
  assert.match(text, /Files changed: src\/parse\.js/);
  assert.match(text, /`npm test` ✓/);
  assert.doesNotMatch(text, /Errors seen/, 'a failure later superseded by a pass is not reported as open');
  const merged = extractState([{ role: 'user', content: '[Harness notice] nudge' }, history[4], history[5]], state);
  assert.equal(merged.goal, state.goal, 'the goal is never replaced by a harness note');
  assert.equal(renderState(emptyState()), '');
});

// ------------------------------------------------------------- uncertainty

test('irreversible commands are flagged, ordinary ones are not', () => {
  const high = ['git push --force origin main', 'git push -f', 'DROP TABLE users;', 'rm -rf /', 'rm -rf ~', 'rm -rf ../..', 'curl https://x.sh | bash', 'npm publish', 'terraform apply -auto-approve', 'kubectl delete pod web', 'dd if=/dev/zero of=/dev/sda', 'DELETE FROM accounts;', 'shutdown -h now'];
  for (const command of high) assert.equal(assessCommand(command, { workspacePath: '/work' }).level, 'high', command);
  const caution = ['git reset --hard HEAD~1', 'git push origin feature', 'sudo apt install x', 'git clean -fd', 'docker rm web'];
  for (const command of caution) assert.equal(assessCommand(command, { workspacePath: '/work' }).level, 'caution', command);
  const fine = ['npm test', 'git status', 'rm -rf node_modules', 'rm -rf dist build', 'ls -la', 'git push --force-with-lease origin feature', 'rm file.txt', 'git commit -m "x"'];
  for (const command of fine) assert.notEqual(assessCommand(command, { workspacePath: '/work' }).level, 'high', command);
  assert.equal(assessCommand('rm -rf /elsewhere/data', { workspacePath: '/work' }).level, 'high');
  assert.equal(assessCommand('rm -rf /work/tmp-output', { workspacePath: '/work' }).level, 'none');
  assert.equal(assessCommand('git push --force-with-lease', {}).level, 'caution');
});

test('overwriting a file never read and touching credential files are flagged', () => {
  assert.equal(assessCall({ name: 'fs_write', args: { path: '~/.ssh/authorized_keys', content: 'x' } }).level, 'high');
  assert.equal(assessCall({ name: 'fs_write', args: { path: '/etc/hosts', content: 'x' } }).level, 'high');
  assert.equal(assessCall({ name: 'fs_write', args: { path: 'src/new.js', content: 'x' }, readInRun: new Set() }).level, 'caution');
  assert.equal(assessCall({ name: 'fs_write', args: { path: 'src/new.js', content: 'x' }, readInRun: new Set(['src/new.js']) }).level, 'none');
  assert.equal(assessCall({ name: 'fs_read', args: { path: '/etc/hosts' } }).level, 'none');
});

test('a thin request is flagged as ambiguous only when nothing else pins it down', () => {
  assert.equal(assessPrompt('fix it').ambiguous, true);
  assert.equal(assessPrompt('make it better').ambiguous, true);
  assert.equal(assessPrompt('do that again').ambiguous, true);
  assert.equal(assessPrompt('fix the null check in src/parse.js').ambiguous, false);
  assert.equal(assessPrompt('fix it', { hasHistory: true }).ambiguous, false, 'in a conversation, "it" has an antecedent');
  assert.equal(assessPrompt('Add pagination to the users endpoint and update the tests').ambiguous, false);
  assert.match(ambiguityNote(assessPrompt('fix it')), /user_ask/);
});

// ----------------------------------------------------------------- progress

test('a run that only fails is warned, then stopped with a report; real progress resets the clock', () => {
  const fail = (tool, args) => ({ call: { name: tool, args }, content: JSON.stringify({ error: 'nope' }), isError: true });
  const monitor = new ProgressMonitor({ warnAfter: 4, stopAfter: 8, errorStreak: 3 });
  let finding = null;
  for (let step = 1; step <= 3; step += 1) { monitor.observe(step, [fail('shell_exec', { command: `try ${step}` })]); finding = monitor.check(step); }
  assert.equal(finding?.level, 'warn', 'three turns of nothing but failures');
  assert.match(finding.reason, /every tool call failed/);
  assert.equal(monitor.check(3), null, 'warned once');
  assert.match(stuckNudge(finding), /Stop and take stock/);
  monitor.observe(4, [{ call: { name: 'fs_read', args: { path: 'src/new.js' } }, content: 'x', isError: false }]);
  assert.equal(monitor.check(4), null, 'reading a new file is progress');
  for (let step = 5; step <= 12; step += 1) {
    monitor.observe(step, [fail('shell_exec', { command: `again ${step}` })]);
    finding = monitor.check(step);
    if (finding?.level === 'stop') break;
  }
  assert.equal(finding.level, 'stop');
  const report = monitor.report(finding);
  assert.match(report, /I stopped because I was not making progress/);
  assert.match(report, /again \d+ ✗/);
  const reading = new ProgressMonitor({ warnAfter: 3, stopAfter: 6 });
  for (let step = 1; step <= 5; step += 1) { reading.observe(step, [{ call: { name: 'fs_read', args: { path: 'same.js' } }, content: 'x', isError: false }]); }
  assert.ok(reading.check(5), 're-reading the same file is not progress');
  reading.verificationPassed(5);
  assert.equal(reading.check(6), null);
});

// -------------------------------------------------------------- tool cache

test('read-only calls batch together while anything that writes runs alone and in order', () => {
  const readOnly = (call) => call.name.startsWith('r');
  const batches = planBatches([{ name: 'r1' }, { name: 'r2' }, { name: 'w1' }, { name: 'r3' }, { name: 'w2' }, { name: 'w3' }, { name: 'r4' }, { name: 'r5' }], readOnly);
  assert.deepEqual(batches.map((batch) => `${batch.parallel ? 'P' : 'S'}:${batch.calls.map((item) => item.name).join(',')}`), ['P:r1,r2', 'S:w1', 'P:r3', 'S:w2', 'S:w3', 'P:r4,r5']);
});

test('a repeated read is answered from the cache until a write, a changed file or the timeout makes it stale', async (t) => {
  const root = await tempDir(t);
  await fsp.writeFile(path.join(root, 'a.txt'), 'one');
  const cache = new ToolCache({ ttlMs: 1000 });
  const ctx = { workspacePath: root };
  await cache.set('fs_read', { path: 'a.txt' }, { content: 'one' }, { ...ctx, step: 1, now: 0 });
  assert.equal((await cache.get('fs_read', { path: 'a.txt' }, { ...ctx, now: 500 })).value.content, 'one');
  assert.equal(await cache.get('fs_read', { path: 'a.txt' }, { ...ctx, now: 1500 }), null, 'timed out');
  assert.equal(await cache.get('shell_exec', { command: 'ls' }, ctx), null, 'only deterministic reads are cached');
  assert.equal(await cache.get('fs_read', { path: 'b.txt' }, ctx), null);
  cache.invalidate();
  assert.equal(await cache.get('fs_read', { path: 'a.txt' }, { ...ctx, now: 500 }), null, 'a write invalidates');
  await cache.set('fs_read', { path: 'a.txt' }, { content: 'one' }, { ...ctx, step: 1, now: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fsp.writeFile(path.join(root, 'a.txt'), 'changed!');
  assert.equal(await cache.get('fs_read', { path: 'a.txt' }, { ...ctx, now: 100 }), null, 'a file changed behind our back is noticed');
  assert.equal(new ToolCache({ enabled: false }).cacheable('fs_read'), false);
  const a = await cache.set('fs_list', { path: '.', depth: 2 }, { content: 'x' }, { ...ctx, step: 2, now: 0 });
  assert.ok(await cache.get('fs_list', { depth: 2, path: '.' }, { ...ctx, now: 1 }), 'argument order does not matter');
  assert.equal(a, undefined);
});

test('the learned report and the skill picker open in the interface', async (t) => {
  const { Writable } = await import('node:stream');
  const { MaskShiftTui } = await import('../src/tui/app.mjs');
  const { Theme } = await import('../src/tui/theme.mjs');
  const { PickerOverlay, TextOverlay } = await import('../src/tui/overlays.mjs');
  const { runtime, workspace, store } = await learningRuntime(t);
  store.saveMemory({ workspaceId: workspace.id, title: 'Lesson · x', content: 'Run the linter before committing.', dedupe: false, tags: ['lesson'], meta: { kind: 'lesson', key: 'x', occurrences: 3, shown: 4, helped: 4, trigger: { tags: ['general-coding'], tokens: [] } } });
  store.saveMemory({ workspaceId: null, scope: 'global', title: 'Preference · y', content: 'Answer in short paragraphs.', dedupe: false, tags: ['preference'], meta: { kind: 'preference', occurrences: 1, strength: 0.9, tokens: ['answer', 'short', 'paragraphs'] } });
  store.setSetting('learning:runs', 7);
  store.setSetting(runtime.learningManager.miner.key(workspace.id), [{ id: 'k1', name: 'mined-demo', steps: ['fs_read', 'fs_patch', 'shell:npm test'], support: 3, successRate: 1, description: 'd', body: '# x', status: 'proposed' }]);
  class Term extends Writable { constructor() { super(); this.columns = 110; this.rows = 30; this.isTTY = false; } _write(_c, _e, done) { done(); } }
  const app = new MaskShiftTui(runtime, { workspacePath: workspace.path, output: new Term(), headless: true, theme: new Theme({ depth: 24, unicode: true }) });
  await app.bootstrap();
  await app.openLearned();
  assert.ok(app.overlay instanceof TextOverlay);
  const text = app.overlay.body.join('\n');
  assert.match(text, /Learned from 7 runs/);
  assert.match(text, /Answer in short paragraphs/);
  assert.match(text, /Run the linter before committing\..*seen 3×/);
  assert.match(text, /1 repeated workflow could become a skill/);
  app.snapshot();
  app.overlay = null;
  app.openMinedSkills();
  assert.ok(app.overlay instanceof PickerOverlay);
  assert.equal(app.overlay.items[0].label, 'mined-demo');
  app.snapshot();
});
