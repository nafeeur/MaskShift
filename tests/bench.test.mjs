import assert from 'node:assert/strict';
import test from 'node:test';
import { FEATURES, compareReports, runBenchmark, verifyTasks } from '../src/bench/runner.mjs';
import { TASKS, taskById } from '../src/bench/tasks.mjs';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest } from './helpers.mjs';

const usage = { prompt_tokens: 40, completion_tokens: 10 };

// A model that solves each task by replaying its reference solution, one tool call per turn.
async function oracleRuntime(t, { sabotage = null } = {}) {
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    const body = await readJsonBody(request);
    const text = (message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    const task = TASKS.find((candidate) => body.messages.some((message) => message.role === 'user' && text(message).includes(candidate.prompt)));
    if (!task) return respondOpenAIChatSSE(response, { content: 'no task', finishReason: 'stop', usage });
    const done = body.messages.filter((message) => message.role === 'tool').length;
    const reference = sabotage ? sabotage(task) : task.reference;
    if (done >= reference.length) return respondOpenAIChatSSE(response, { content: 'Finished.', finishReason: 'stop', usage });
    const call = reference[done];
    return respondOpenAIChatSSE(response, { toolCalls: [{ id: `call_${done}`, name: call.name, args: call.args }], finishReason: 'tool_calls', usage });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-bench:oracle',
    guardrails: { feedback: { lsp: false } },
    providers: [{ id: 'fixture-bench', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'oracle', contextWindow: 64000 }], timeoutMs: 15_000 }],
  });
  return runtime;
}

test('every task is sound: its check fails untouched and passes after the reference solution', async (t) => {
  const runtime = await oracleRuntime(t);
  const results = await verifyTasks({ runtime });
  assert.equal(results.length, TASKS.length);
  for (const entry of results) assert.ok(entry.ok, `${entry.id}: failsBefore=${entry.failsBefore} passesAfter=${entry.passesAfter} ${entry.error || entry.detail || ''}`);
});

test('the suite is well-formed: unique ids, prompts, checks and references', () => {
  assert.equal(new Set(TASKS.map((task) => task.id)).size, TASKS.length);
  assert.ok(TASKS.length >= 10);
  for (const task of TASKS) {
    assert.ok(task.prompt.length > 20 && task.check && task.reference.length && Object.keys(task.files).length, task.id);
    assert.equal(taskById(task.id), task);
  }
});

test('a model that replays the reference solutions solves everything and the report adds up', async (t) => {
  const runtime = await oracleRuntime(t);
  const seen = [];
  const report = await runBenchmark({ runtime, modelRef: 'fixture-bench:oracle', onTask: (entry) => seen.push(entry.id) });
  assert.equal(report.summary.tasks, TASKS.length);
  assert.equal(report.summary.solved, TASKS.length, report.results.filter((entry) => !entry.passed).map((entry) => `${entry.id}: ${entry.error || entry.checkOutput}`).join('\n'));
  assert.equal(report.summary.passRate, 1);
  assert.deepEqual(seen, TASKS.map((task) => task.id));
  assert.ok(report.summary.tokens > 0 && report.summary.tokensPerSolved > 0);
  assert.ok(report.summary.avgSteps >= 2, 'one tool call plus a closing turn');
  assert.ok(report.summary.harnessInterventions.fuzzyEdits >= 1, 'the whitespace task needed the forgiving matcher');
  assert.equal(report.summary.bySource.turn.calls, report.results.reduce((total, entry) => total + entry.bySource.turn.calls, 0));
  assert.equal(report.model, 'fixture-bench:oracle');
  assert.equal(report.level, 1, 'a model of unknown size and no track record starts at the medium level');
});

test('turning a helper off is measurable, and is undone afterwards', async (t) => {
  const runtime = await oracleRuntime(t);
  const tab = [taskById('tab-indented-edit')];
  const without = await runBenchmark({ runtime, modelRef: 'fixture-bench:oracle', tasks: tab, without: ['fuzzyEdits'] });
  assert.equal(without.summary.solved, 0, 'a byte-exact matcher cannot apply the model\'s space-indented edit');
  assert.equal(runtime.config.get().guardrails.features.fuzzyEdits, true, 'the switch is restored');
  const withHelper = await runBenchmark({ runtime, modelRef: 'fixture-bench:oracle', tasks: tab });
  assert.equal(withHelper.summary.solved, 1);
  const comparison = compareReports(without, withHelper);
  assert.deepEqual(comparison.fixes, ['tab-indented-edit']);
  assert.deepEqual(comparison.regressions, []);
  assert.equal(comparison.passRate.delta, 1);
});

test('repeat runs and unknown feature names are handled', async (t) => {
  const runtime = await oracleRuntime(t);
  const report = await runBenchmark({ runtime, modelRef: 'fixture-bench:oracle', tasks: [taskById('fix-off-by-one')], repeat: 2 });
  assert.deepEqual(report.results.map((entry) => entry.attempt), [1, 2]);
  await assert.rejects(runBenchmark({ runtime, modelRef: 'fixture-bench:oracle', tasks: [taskById('fix-off-by-one')], without: ['nonsense'] }), /Unknown feature 'nonsense'/);
  assert.deepEqual(FEATURES, ['callRepair', 'fuzzyEdits', 'observation', 'editFeedback']);
});

test('a model that does the wrong thing fails the check even if it claims success', async (t) => {
  const runtime = await oracleRuntime(t, { sabotage: (task) => [{ name: 'fs_write', args: { path: 'unrelated.txt', content: 'nothing useful\n' } }] });
  const report = await runBenchmark({ runtime, modelRef: 'fixture-bench:oracle', tasks: [taskById('fix-off-by-one'), taskById('config-value')] });
  assert.equal(report.summary.solved, 0);
  assert.ok(report.results.every((entry) => entry.status === 'completed' && entry.passed === false), 'the model said "Finished." and the check disagreed');
  assert.ok(report.results[0].checkOutput);
});
