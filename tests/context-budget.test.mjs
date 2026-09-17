import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextBudgetError, fitHistory } from '../src/agent/context-budget.mjs';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest, waitFor } from './helpers.mjs';

function longMessage(role, label) {
  return { role, content: `${label} `.repeat(80) };
}

test('fitHistory keeps everything when it already fits the budget', () => {
  const history = [longMessage('user', 'hello'), longMessage('assistant', 'hi')];
  const fitted = fitHistory({ history, contextTokens: 100_000, outputTokens: 4096 });
  assert.equal(fitted.omitted, 0);
  assert.deepEqual(fitted.history, history);
});

test('fitHistory drops the oldest turns first and keeps tool-call/result pairs atomic', () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push(longMessage('user', `question ${i}`));
    history.push({
      role: 'assistant', content: '', toolCalls: [{ id: `call_${i}`, name: 'fs_read', args: { path: `f${i}.txt` } }],
    });
    history.push({ role: 'tool', toolCallId: `call_${i}`, toolName: 'fs_read', content: `result ${i} `.repeat(80) });
  }
  const latestQuestion = longMessage('user', 'final question');
  history.push(latestQuestion);

  const fitted = fitHistory({ history, contextTokens: 2000, outputTokens: 256, systemTokens: 100, toolTokens: 50 });
  assert.ok(fitted.omitted > 0, 'expected at least one turn to be omitted');
  // The latest turn is always present.
  assert.equal(fitted.history.at(-1).content, latestQuestion.content);
  // No tool-result message survives without its assistant tool-call immediately before it.
  for (let i = 0; i < fitted.history.length; i++) {
    if (fitted.history[i].role === 'tool') assert.ok(fitted.history[i - 1]?.role === 'assistant' && fitted.history[i - 1].toolCalls?.length);
  }
  // A digest note about the omission is prepended.
  assert.ok(fitted.history[0].content.includes('omitted'));
});

test('fitHistory throws instead of silently dropping the latest exchange when it cannot fit', () => {
  const history = [longMessage('user', 'x'.repeat(2000))];
  assert.throws(() => fitHistory({ history, contextTokens: 512, outputTokens: 256 }), ContextBudgetError);
});

test('fitHistory throws when the system prompt and tools alone exceed the budget', () => {
  assert.throws(
    () => fitHistory({ history: [{ role: 'user', content: 'hi' }], contextTokens: 1024, outputTokens: 512, systemTokens: 2000, toolTokens: 0 }),
    ContextBudgetError,
  );
});

test('adaptive context budgeting trims old session history for a model with a small declared context window', async (t) => {
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    return respondJson(response, 200, {
      id: 'chatcmpl_1',
      choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  });

  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-tiny:tiny-model',
    providers: [{
      id: 'fixture-tiny', name: 'Fixture Tiny', type: 'openai-compatible',
      baseUrl: modelServer.url, apiKey: 'test-key', enabled: true, autoDiscover: false,
      // MaskShift's own system prompt (capability catalog etc.) can run to several thousand
      // tokens even for a tiny fixture project, so this window is chosen generously above that
      // (see the "no declared window" test below for the untouched baseline) while the seeded
      // history below is made large enough to dominate whatever budget remains for it.
      models: [{ id: 'tiny-model', contextWindow: 60_000 }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id });

  const seededMessages = 300;
  for (let i = 0; i < seededMessages / 2; i++) {
    runtime.store.addMessage({ sessionId: session.id, role: 'user', content: `Old message number ${i} `.repeat(150) });
    runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: `Old reply number ${i} `.repeat(150) });
  }

  const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'What is 2+2?', modelRef: 'fixture-tiny:tiny-model', options: { maxTokens: 512 } });
  const completed = await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'tiny-context run completion' });

  assert.equal(completed.status, 'completed', completed.error || 'run should complete');
  assert.equal(requests.length, 1);
  // The 300 seeded messages plus the new prompt must not all have gone out untrimmed.
  assert.ok(requests[0].messages.length < seededMessages, `expected history to be trimmed, saw ${requests[0].messages.length} messages`);
  const events = runtime.store.listRunEvents(run.id, 2000);
  const trimmed = events.find((event) => event.type === 'context-trimmed');
  assert.ok(trimmed, 'expected a context-trimmed run event to have been recorded');
  assert.ok(trimmed.payload.omittedTurns > 0);
});

test('a model with no declared context window sends full history untouched, as before', async (t) => {
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    return respondJson(response, 200, {
      id: 'chatcmpl_1',
      choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-plain:plain-model',
    providers: [{
      id: 'fixture-plain', name: 'Fixture Plain', type: 'openai-compatible',
      baseUrl: modelServer.url, apiKey: 'test-key', enabled: true, autoDiscover: false,
      models: [{ id: 'plain-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  for (let i = 0; i < 10; i++) runtime.store.addMessage({ sessionId: session.id, role: 'user', content: `note ${i}` });

  const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'ping', modelRef: 'fixture-plain:plain-model' });
  await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'plain run completion' });

  assert.equal(requests.length, 1);
  assert.ok(!requests[0].messages.some((m) => typeof m.content === 'string' && m.content.includes('to fit the model')));
});
