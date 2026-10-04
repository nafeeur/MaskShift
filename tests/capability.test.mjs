import assert from 'node:assert/strict';
import test from 'node:test';
import { calibrateModel } from '../src/agent/calibration.mjs';
import { CapabilityRegistry, ScaffoldController, compositeScore, knobsFor, levelFromScore } from '../src/agent/capability-profile.mjs';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, waitFor } from './helpers.mjs';

function memoryStore() {
  const map = new Map();
  return { getSetting: (key, fallback = null) => (map.has(key) ? structuredClone(map.get(key)) : fallback), setSetting: (key, value) => { map.set(key, structuredClone(value)); return value; } };
}

test('levels are monotone in how much help they give', () => {
  const levels = [0, 1, 2, 3].map(knobsFor);
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(levels[index].observationScale <= levels[index - 1].observationScale);
    assert.ok(levels[index].repairBudget >= levels[index - 1].repairBudget);
    assert.ok(levels[index].stagnationRepeat <= levels[index - 1].stagnationRepeat);
    if (levels[index - 1].compactPrompt) assert.ok(levels[index].compactPrompt, 'help is never taken away at a higher level');
    if (levels[index - 1].planFirst) assert.ok(levels[index].planFirst);
  }
  assert.equal(knobsFor(0).compactPrompt, false, 'a capable model is left alone');
  assert.equal(knobsFor(99).level, 3);
  assert.equal(knobsFor(-4).level, 0);
});

test('score thresholds map to levels and the composite ignores missing probes', () => {
  assert.deepEqual([0.95, 0.85, 0.7, 0.6, 0.5, 0.3].map(levelFromScore), [0, 0, 1, 2, 2, 3]);
  assert.equal(compositeScore({ toolCalling: 1, editing: 1, planning: 1, longContext: 1 }), 1);
  assert.equal(compositeScore({}), null);
  assert.equal(compositeScore({ toolCalling: 0.5 }), 0.5, 'a single probe is its own composite');
  assert.ok(compositeScore({ toolCalling: 0, editing: 0, planning: 1, longContext: 1 }) < 0.5, 'tool calling and editing weigh most');
});

test('a controller rises under repeated stumbles, relaxes pressure on clean calls, and stops at the top', () => {
  const changes = [];
  const controller = new ScaffoldController({ level: 0, source: 'prior', onChange: (change) => changes.push(change) });
  for (let index = 0; index < 5; index += 1) controller.signal('edit-miss');
  assert.equal(controller.level, 0, 'five stumbles are not yet enough');
  for (let index = 0; index < 40; index += 1) controller.clean();
  for (let index = 0; index < 5; index += 1) controller.signal('edit-miss');
  assert.equal(controller.level, 0, 'a run of clean calls forgives earlier stumbles');
  for (let index = 0; index < 40; index += 1) controller.clean();
  controller.signal('stagnation');
  controller.signal('stagnation');
  assert.equal(controller.level, 0);
  controller.signal('stagnation');
  assert.equal(controller.level, 1);
  assert.deepEqual([changes[0].from, changes[0].to, changes[0].reason], [0, 1, 'stagnation']);
  for (let index = 0; index < 60; index += 1) controller.signal('stagnation');
  assert.equal(controller.level, 3);
  assert.equal(changes.length, 3);
  controller.signal('not-a-signal');
  assert.equal(controller.level, 3);
  assert.ok(controller.summary().rate > 0);
});

test('the registry starts from a prior, prefers a measurement, and learns from a track record', () => {
  const registry = new CapabilityRegistry({ store: memoryStore() });
  assert.deepEqual(['small', 'medium', 'large'].map((tier) => registry.decide('m', { tier }).level), [2, 1, 0]);
  assert.equal(registry.decide('m', null).source, 'default');

  registry.saveProfile('m', { composite: 0.4 });
  const measured = registry.decide('m', { tier: 'large' });
  assert.equal(measured.level, 3, 'a measurement overrides what the size suggests');
  assert.equal(measured.source, 'calibration');

  const tracked = new CapabilityRegistry({ store: memoryStore() });
  assert.equal(tracked.record('x', { toolCalls: 2, rate: 5, level: 0 }), null, 'a run with almost no tool use says nothing');
  tracked.record('x', { toolCalls: 20, rate: 1.2, level: 0 });
  assert.equal(tracked.decide('x', { tier: 'large' }).level, 0, 'one bad run does not move the level');
  tracked.record('x', { toolCalls: 20, rate: 1.2, level: 0 });
  assert.ok(tracked.decide('x', { tier: 'large' }).level >= 1, 'a pattern does');
  assert.equal(tracked.observed('x').runs, 2);
});

function fakeProvider(behaviour) {
  return {
    modelProfile: async () => ({ ref: 'fake:m', contextWindow: 16000, maxOutputTokens: 1024 }),
    complete: async ({ messages, tools }) => behaviour(String(messages.at(-1).content), tools),
  };
}

const call = (name, args, id = 'c') => ({ id, name, args });
const answer = (content) => ({ content, toolCalls: [], usage: { input_tokens: 10, output_tokens: 3 } });
const calls = (...list) => ({ content: '', toolCalls: list, usage: { input_tokens: 10, output_tokens: 3 } });

const perfect = (prompt) => {
  if (/record_value tool with key 'alpha'/.test(prompt)) return calls(call('record_value', { key: 'alpha', count: 3 }));
  if (/twice in the same reply/.test(prompt)) return calls(call('record_value', { key: 'one', count: 1 }, 'a'), call('record_value', { key: 'two', count: 2 }, 'b'));
  if (/retries from 3 to 5/.test(prompt)) return calls(call('fs_patch', { path: 'src/load.js', edits: [{ oldText: 'const retries = 3;', newText: 'const retries = 5;' }] }));
  if (/numbered list/.test(prompt)) return answer('1. Search for getUser\n2. Rename it to fetchUser\n3. Run the tests');
  return answer(prompt.match(/release-token=(ZK-[A-Z0-9]{4})/)?.[1] || 'unknown');
};

test('calibration scores a model that does everything right as 1', async () => {
  const progress = [];
  const result = await calibrateModel({ providerManager: fakeProvider(perfect), modelRef: 'fake:m', onProbe: (probe) => progress.push(probe.name) });
  assert.deepEqual(result.scores, { toolCalling: 1, editing: 1, planning: 1, longContext: 1 });
  assert.equal(result.composite, 1);
  assert.equal(result.level, 0);
  assert.deepEqual(progress, ['toolCalling', 'editing', 'planning', 'longContext']);
  assert.ok(result.tokens.input > 0);
});

test('calibration gives partial credit for repairable output and none for failures', async () => {
  const sloppy = (prompt) => {
    if (/record_value tool with key 'alpha'/.test(prompt)) return calls(call('record_value', { Key: 'alpha', count: '3' }));
    if (/twice in the same reply/.test(prompt)) return calls(call('record_value', { key: 'one', count: 1 }));
    if (/retries from 3 to 5/.test(prompt)) return calls(call('edit_file', { file_path: 'src/load.js', old_string: 'const retries = 3;', new_string: 'const retries = 5;' }));
    if (/numbered list/.test(prompt)) return answer('Sure! I would first look around and then fix it.');
    return answer('I could not find it.');
  };
  const result = await calibrateModel({ providerManager: fakeProvider(sloppy), modelRef: 'fake:m' });
  assert.equal(result.scores.toolCalling, 0.56, 'single call needed repair (0.6) and only one of two parallel calls arrived');
  assert.equal(result.scores.editing, 0.8, 'correct, but only because the harness repaired the tool name and argument names');
  assert.ok(result.scores.planning < 0.3);
  assert.equal(result.scores.longContext, 0);
  assert.ok(result.level >= 2);
});

test('calibration notices an edit that changes the wrong thing, and survives a probe that throws', async () => {
  const wrong = (prompt) => {
    if (/retries from 3 to 5/.test(prompt)) return calls(call('fs_patch', { path: 'x', edits: [{ oldText: 'const timeoutMs = 3000;', newText: 'const timeoutMs = 5000;' }] }));
    if (/numbered list/.test(prompt)) throw new Error('model exploded');
    return perfect(prompt);
  };
  const result = await calibrateModel({ providerManager: fakeProvider(wrong), modelRef: 'fake:m' });
  assert.equal(result.scores.editing, 0.2);
  assert.equal(result.scores.planning, 0);
  assert.match(result.probes.find((probe) => probe.name === 'planning').detail, /model exploded/);
  assert.equal(result.scores.longContext, 1, 'later probes still run');
});

test('calibration throws when the model cannot be reached at all, and honours a probe filter', async () => {
  const dead = fakeProvider(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); });
  await assert.rejects(calibrateModel({ providerManager: dead, modelRef: 'fake:m' }), /ECONNREFUSED/);
  const only = await calibrateModel({ providerManager: fakeProvider(perfect), modelRef: 'fake:m', only: ['planning'] });
  assert.deepEqual(Object.keys(only.scores), ['planning']);
});

async function runWith(t, { handler, config = {}, prompt = 'work', beforeRun }) {
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    const body = await readJsonBody(request);
    requests.push(body);
    return handler(body, response, requests);
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-cap:cap-model',
    providers: [{ id: 'fixture-cap', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'cap-model', ...(config.model || {}) }], timeoutMs: 15_000 }],
    ...(config.overrides || {}),
  });
  const workspace = await runtime.workspaceManager.open(project);
  beforeRun?.(runtime);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt, modelRef: 'fixture-cap:cap-model' });
  const finished = await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps', 'stagnated'].includes(value.status) ? value : null;
  }, { timeoutMs: 20_000, message: 'run completion' });
  return { runtime, run, finished, requests };
}

const systemOf = (request) => (typeof request.messages[0].content === 'string' ? request.messages[0].content : JSON.stringify(request.messages[0].content));
const usage = { prompt_tokens: 5, completion_tokens: 2 };

test('a small-window model still starts with the compact prompt, as it did before levels existed', async (t) => {
  const { requests, runtime, run } = await runWith(t, {
    config: { model: { contextWindow: 8192 } },
    handler: (body, response) => respondOpenAIChatSSE(response, { content: 'ok', finishReason: 'stop', usage }),
  });
  assert.match(systemOf(requests[0]), /Finish the task end to end: inspect, act, and verify/);
  const started = runtime.store.listRunEvents(run.id, 100).find((event) => event.type === 'scaffold');
  assert.deepEqual([started.payload.level, started.payload.source], [2, 'prior']);
});

test('a calibrated weak model is carried further: a plan is asked for up front', async (t) => {
  const { requests } = await runWith(t, {
    beforeRun: (runtime) => runtime.engine.capabilities.saveProfile('fixture-cap:cap-model', { composite: 0.2 }),
    handler: (body, response) => respondOpenAIChatSSE(response, { content: 'ok', finishReason: 'stop', usage }),
  });
  assert.match(systemOf(requests[0]), /Before editing anything, call plan_update/);
});

test('a window too small for the full prompt forces the compact one however well the model scored', async (t) => {
  const registry = new CapabilityRegistry({ store: memoryStore() });
  registry.saveProfile('tiny', { composite: 0.99 });
  const decision = registry.decide('tiny', { tier: 'small', contextWindow: 8192 });
  assert.equal(decision.level, 2);
  assert.equal(decision.floor, 2);
  assert.equal(registry.decide('tiny', { tier: 'large', contextWindow: 128000 }).level, 0);
  const { finished, requests } = await runWith(t, {
    config: { model: { contextWindow: 8192 } },
    beforeRun: (runtime) => runtime.engine.capabilities.saveProfile('fixture-cap:cap-model', { composite: 0.97 }),
    handler: (body, response) => respondOpenAIChatSSE(response, { content: 'ok', finishReason: 'stop', usage }),
  });
  assert.equal(finished.status, 'completed', finished.error);
  assert.match(systemOf(requests[0]), /Finish the task end to end: inspect, act, and verify/);
});

test('a calibrated strong model gets neither the compact prompt nor a plan requirement', async (t) => {
  const { requests } = await runWith(t, {
    config: { model: { contextWindow: 64000 } },
    beforeRun: (runtime) => runtime.engine.capabilities.saveProfile('fixture-cap:cap-model', { composite: 0.97 }),
    handler: (body, response) => respondOpenAIChatSSE(response, { content: 'ok', finishReason: 'stop', usage }),
  });
  const system = systemOf(requests[0]);
  assert.ok(!/Finish the task end to end: inspect, act, and verify/.test(system), 'measurement beats the size heuristic');
  assert.ok(!/Before editing anything/.test(system));
});

test('a model that keeps missing its edits is moved up mid-run, and the run is remembered', async (t) => {
  let turn = 0;
  const { runtime, run, finished, requests } = await runWith(t, {
    handler: (body, response) => {
      turn += 1;
      if (turn <= 8) return respondOpenAIChatSSE(response, { toolCalls: [{ id: `c${turn}`, name: 'fs_patch', args: { path: 'index.js', edits: [{ oldText: `a line that is not in the file number ${turn} with enough text`, newText: 'x' }] } }], finishReason: 'tool_calls', usage });
      return respondOpenAIChatSSE(response, { content: 'gave up', finishReason: 'stop', usage });
    },
  });
  assert.equal(finished.status, 'completed', finished.error);
  const events = runtime.store.listRunEvents(run.id, 500);
  const change = events.find((event) => event.type === 'scaffold-level');
  assert.ok(change, 'the level rose during the run');
  assert.deepEqual([change.payload.from, change.payload.to, change.payload.reason], [1, 2, 'edit-miss']);
  assert.ok(!/Finish the task end to end: inspect, act, and verify/.test(systemOf(requests[0])), 'started at the medium level');
  assert.match(systemOf(requests.at(-1)), /Finish the task end to end: inspect, act, and verify/, 'ended with the compact prompt');
  const observed = runtime.engine.capabilities.observed('fixture-cap:cap-model');
  assert.equal(observed.runs, 1);
  assert.ok(observed.lastRate > 0.5);
});

test('token accounting separates what the harness caused from ordinary turns', async (t) => {
  let turn = 0;
  const { finished } = await runWith(t, {
    prompt: 'write a.txt',
    config: { overrides: { guardrails: { verification: { commands: ['exit 1'], maxAttempts: 2 } } } },
    handler: (body, response) => {
      turn += 1;
      if (turn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_write', args: { path: 'a.txt', content: 'x\n' } }], finishReason: 'tool_calls', usage });
      return respondOpenAIChatSSE(response, { content: 'done', finishReason: 'stop', usage });
    },
  });
  const { bySource } = finished.meta.costEstimate;
  assert.equal(bySource.turn.calls, 2, 'the first turn and the first "done"');
  assert.equal(bySource.verification.calls, 1, 'the turn that answered a failed check is attributed to it');
});
