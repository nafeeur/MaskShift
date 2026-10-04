import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { StagnationDetector, guardrailSettings, runVerification } from '../src/agent/guardrails.mjs';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, waitFor } from './helpers.mjs';

const DONE = ['completed', 'failed', 'cancelled', 'max_steps', 'stagnated'];

async function fixtureRuntime(t, project, handler, { contextWindow, overrides = {} } = {}) {
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    const body = await readJsonBody(request);
    requests.push(body);
    return handler(body, response, requests);
  });
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-guard:guard-model',
    providers: [{
      id: 'fixture-guard', name: 'Fixture Guard', type: 'openai-compatible',
      baseUrl: modelServer.url, apiKey: 'test-key', enabled: true, autoDiscover: false,
      models: [{ id: 'guard-model', ...(contextWindow ? { contextWindow } : {}) }], timeoutMs: 15_000,
    }],
    ...overrides,
  });
  const workspace = await runtime.workspaceManager.open(project);
  return { runtime, workspace, requests };
}

async function finish(runtime, run) {
  return waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return DONE.includes(value.status) ? value : null;
  }, { timeoutMs: 20_000, message: 'run completion' });
}

const usage = { prompt_tokens: 10, completion_tokens: 2 };
const sizeOf = (message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content));

test('StagnationDetector warns on repeats, stops later, and treats a changed result as progress', () => {
  const detector = new StagnationDetector({ window: 16, repeatThreshold: 3, stopThreshold: 5 });
  const call = { name: 'shell_exec', args: { command: 'npm test' } };
  detector.observe(call, { content: 'FAIL' });
  detector.observe(call, { content: 'FAIL' });
  assert.equal(detector.check(), null);
  detector.observe(call, { content: 'FAIL' });
  assert.equal(detector.check().level, 'warn');
  assert.equal(detector.check(), null, 'the same warning is not repeated');
  detector.observe(call, { content: 'FAIL' });
  assert.equal(detector.check(), null);
  detector.observe(call, { content: 'FAIL' });
  const stop = detector.check();
  assert.equal(stop.level, 'stop');
  assert.equal(stop.tool, 'shell_exec');

  const progressing = new StagnationDetector({ repeatThreshold: 3, stopThreshold: 5 });
  for (let i = 0; i < 10; i++) progressing.observe(call, { content: `FAIL ${i}` });
  assert.equal(progressing.check(), null, 'a different result each time is not stagnation');

  const argOrder = new StagnationDetector({ repeatThreshold: 2, stopThreshold: 4 });
  argOrder.observe({ name: 't', args: { a: 1, b: 2 } }, { content: 'x' });
  argOrder.observe({ name: 't', args: { b: 2, a: 1 } }, { content: 'x' });
  assert.equal(argOrder.check().level, 'warn', 'argument key order does not hide a repeat');
});

test('StagnationDetector catches A,B,A,B alternation', () => {
  const detector = new StagnationDetector({ repeatThreshold: 3, stopThreshold: 8 });
  const a = { name: 'fs_write', args: { path: 'x', content: '1' } };
  const b = { name: 'fs_write', args: { path: 'x', content: '2' } };
  for (let i = 0; i < 3; i++) {
    detector.observe(a, { content: 'ok' });
    detector.observe(b, { content: 'ok' });
  }
  const finding = detector.check();
  assert.equal(finding.level, 'warn');
  assert.equal(finding.reason, 'oscillation');
});

test('guardrailSettings applies defaults and tolerates string commands', () => {
  const defaults = guardrailSettings({});
  assert.equal(defaults.stagnation.enabled, true);
  assert.deepEqual(defaults.verification.commands, []);
  assert.equal(defaults.handoff.maxResets, 3);
  const custom = guardrailSettings({ guardrails: { verification: { commands: ['npm test', { command: 'npm run lint', label: 'lint' }, '  ', null] }, handoff: { maxResets: 0 } } });
  assert.deepEqual(custom.verification.commands.map((entry) => entry.command), ['npm test', 'npm run lint']);
  assert.equal(custom.handoff.maxResets, 0);
});

test('runVerification reports pass/fail per command from the exit code', async (t) => {
  const project = await createProject(t);
  const outcome = await runVerification([
    { command: 'echo fine', label: 'good' },
    { command: 'echo broken >&2; exit 3', label: 'bad' },
  ], { cwd: project, timeoutMs: 10_000 });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.results.map((entry) => [entry.label, entry.ok]), [['good', true], ['bad', false]]);
  assert.equal(outcome.results[1].code, 3);
  assert.match(outcome.results[1].output, /broken/);
});

test('a run that keeps repeating the same call is nudged, then stopped as stagnated', async (t) => {
  const project = await createProject(t);
  const { runtime, workspace, requests } = await fixtureRuntime(t, project, (body, response) => respondOpenAIChatSSE(response, {
    toolCalls: [{ id: `call_${Math.random().toString(36).slice(2)}`, name: 'fs_read', args: { path: 'index.js' } }],
    finishReason: 'tool_calls', usage,
  }), { overrides: { guardrails: { stagnation: { repeatThreshold: 3, stopThreshold: 5 } } } });

  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'Read index.js', modelRef: 'fixture-guard:guard-model' });
  const finished = await finish(runtime, run);
  assert.equal(finished.status, 'stagnated');
  assert.match(finished.error, /repeated actions/);
  assert.equal(requests.length, 5, 'stops the turn the threshold is crossed rather than burning the step budget');
  const events = runtime.store.listRunEvents(run.id, 500).filter((event) => event.type === 'stagnation');
  assert.deepEqual(events.map((event) => event.payload.level), ['warn', 'stop']);
  assert.ok(requests[3].messages.some((message) => typeof message.content === 'string' && message.content.startsWith('[Harness notice]')), 'the model sees the nudge before it is stopped');
});

test('a finished run is held to the project checks and fed their failures until they pass', async (t) => {
  const project = await createProject(t);
  let turn = 0;
  const { runtime, workspace, requests } = await fixtureRuntime(t, project, (body, response) => {
    turn += 1;
    if (turn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_write', args: { path: 'other.txt', content: 'x\n' } }], finishReason: 'tool_calls', usage });
    if (turn === 3) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c2', name: 'fs_write', args: { path: 'flag.txt', content: 'x\n' } }], finishReason: 'tool_calls', usage });
    return respondOpenAIChatSSE(response, { content: 'Done.', finishReason: 'stop', usage });
  }, { overrides: { guardrails: { verification: { commands: [{ command: 'test -f flag.txt || { echo flag.txt missing; exit 1; }', label: 'flag check' }], maxAttempts: 3 } } } });

  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'Create flag.txt', modelRef: 'fixture-guard:guard-model' });
  const finished = await finish(runtime, run);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(requests.length, 4);
  const feedback = requests[2].messages.find((message) => typeof message.content === 'string' && message.content.startsWith('[Harness verification failed'));
  assert.ok(feedback, 'the failing check output went back to the model');
  assert.match(feedback.content, /flag\.txt missing/);
  assert.equal(finished.meta.verification.ok, true);
  assert.equal(finished.meta.verification.attempts, 2);
  const outcomes = runtime.store.listRunEvents(run.id, 500).filter((event) => event.type === 'verification').map((event) => event.payload.ok);
  assert.deepEqual(outcomes, [false, true]);
});

test('verification gives up after maxAttempts and says so instead of looping forever', async (t) => {
  const project = await createProject(t);
  let turn = 0;
  const { runtime, workspace } = await fixtureRuntime(t, project, (body, response) => {
    turn += 1;
    if (turn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_write', args: { path: 'a.txt', content: 'x\n' } }], finishReason: 'tool_calls', usage });
    return respondOpenAIChatSSE(response, { content: 'Done.', finishReason: 'stop', usage });
  }, { overrides: { guardrails: { verification: { commands: ['exit 1'], maxAttempts: 2 } } } });

  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'Write a.txt', modelRef: 'fixture-guard:guard-model' });
  const finished = await finish(runtime, run);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.meta.verification.ok, false);
  assert.equal(finished.meta.verification.attempts, 2);
  assert.equal(turn, 3);
});

test('read-only runs skip verification entirely', async (t) => {
  const project = await createProject(t);
  const marker = path.join(project, 'verified.marker');
  const { runtime, workspace } = await fixtureRuntime(t, project, (body, response) => respondOpenAIChatSSE(response, { content: 'It is 4.', finishReason: 'stop', usage }), {
    overrides: { guardrails: { verification: { commands: [`touch ${marker}`] } } },
  });
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'What is 2+2?', modelRef: 'fixture-guard:guard-model' });
  const finished = await finish(runtime, run);
  assert.equal(finished.status, 'completed');
  await assert.rejects(fsp.access(marker));
  assert.equal(finished.meta.verification, undefined);
});

test('a long run is handed off to a fresh context seeded from a progress file', async (t) => {
  const project = await createProject(t);
  let realTurn = 0;
  const { runtime, workspace, requests } = await fixtureRuntime(t, project, (body, response) => {
    if (body.messages[0]?.role !== 'system') {
      return respondOpenAIChatSSE(response, { content: '## Goal\nSUMMARY: refactor underway, index.js inspected.', finishReason: 'stop', usage });
    }
    realTurn += 1;
    if (realTurn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_read', args: { path: 'index.js' } }], finishReason: 'tool_calls', usage });
    return respondOpenAIChatSSE(response, { content: 'Done.', finishReason: 'stop', usage });
  }, { contextWindow: 60_000 });

  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  for (let i = 0; i < 150; i++) {
    runtime.store.addMessage({ sessionId: session.id, role: 'user', content: `Old message number ${i} `.repeat(150) });
    runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: `Old reply number ${i} `.repeat(150) });
  }
  const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'Refactor velocity()', modelRef: 'fixture-guard:guard-model', options: { maxTokens: 512 } });
  const finished = await finish(runtime, run);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.meta.contextResets, 1);

  const reset = runtime.store.listRunEvents(run.id, 500).find((event) => event.type === 'context-reset');
  assert.ok(reset, 'expected a context-reset event');
  assert.equal(reset.payload.summarized, true);

  const progress = await fsp.readFile(path.join(project, '.maskshift', 'progress.md'), 'utf8');
  assert.match(progress, /## Goal\nRefactor velocity\(\)/);
  assert.match(progress, /SUMMARY: refactor underway/);

  const lastTurn = requests.filter((body) => body.messages[0]?.role === 'system').at(-1);
  const handoff = lastTurn.messages.find((message) => typeof message.content === 'string' && message.content.startsWith('[Context reset'));
  assert.ok(handoff, 'the fresh context opens with the hand-off');
  assert.ok(lastTurn.messages.length < 10, `old turns were cleared, saw ${lastTurn.messages.length} messages`);
  assert.ok(!lastTurn.messages.some((message) => sizeOf(message).includes('Old message number 3 ')));
});

test('hand-off can be disabled', async (t) => {
  const project = await createProject(t);
  let realTurn = 0;
  const { runtime, workspace } = await fixtureRuntime(t, project, (body, response) => {
    if (body.messages[0]?.role !== 'system') return respondOpenAIChatSSE(response, { content: 'SUMMARY', finishReason: 'stop', usage });
    realTurn += 1;
    if (realTurn === 1) return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_read', args: { path: 'index.js' } }], finishReason: 'tool_calls', usage });
    return respondOpenAIChatSSE(response, { content: 'Done.', finishReason: 'stop', usage });
  }, { contextWindow: 60_000, overrides: { guardrails: { handoff: { enabled: false } } } });
  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  for (let i = 0; i < 150; i++) {
    runtime.store.addMessage({ sessionId: session.id, role: 'user', content: `Old message number ${i} `.repeat(150) });
    runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: `Old reply number ${i} `.repeat(150) });
  }
  const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'Go', modelRef: 'fixture-guard:guard-model', options: { maxTokens: 512 } });
  const finished = await finish(runtime, run);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.meta.contextResets, undefined);
  await assert.rejects(fsp.access(path.join(project, '.maskshift', 'progress.md')));
});

test('the harness state directory ignores itself so it never dirties a foreign repository', async (t) => {
  const { ensureStateDir } = await import('../src/agent/guardrails.mjs');
  const project = await createProject(t);
  const dir = await ensureStateDir(project, 'outputs');
  await fsp.writeFile(path.join(dir, 'x.txt'), 'noise');
  const { runCommand } = await import('../src/core/utils.mjs');
  const status = await runCommand('git status --porcelain', { cwd: project });
  assert.ok(!status.stdout.includes('.maskshift'), `git saw: ${status.stdout}`);
  await ensureStateDir(project, 'outputs');
  assert.equal(await fsp.readFile(path.join(project, '.maskshift', '.gitignore'), 'utf8'), '*\n', 'a second call leaves it alone');
});
