import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest, waitFor } from './helpers.mjs';

function textResponse(content = 'Done.') {
  return { id: 'resp_1', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
}

test('starting a second run on a session that already has one active is refused', async (t) => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const modelServer = await jsonServer(t, async (request, response) => {
    await gate;
    return respondJson(response, 200, textResponse());
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-slow:slow-model',
    providers: [{
      id: 'fixture-slow', name: 'Slow', type: 'openai-compatible', baseUrl: modelServer.url,
      apiKey: 'test-key', enabled: true, autoDiscover: false, models: [{ id: 'slow-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id });

  const first = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'go', modelRef: 'fixture-slow:slow-model' });
  await assert.rejects(
    runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'again', modelRef: 'fixture-slow:slow-model' }),
    /already has an active run/,
  );
  releaseFirst();
  const completed = await runtime.engine.waitForRun(first.id);
  assert.equal(completed.status, 'completed');
});

test('cancelling a run cancels its active delegated subagents too', async (t) => {
  const requests = [];
  let releaseAll;
  const gate = new Promise((resolve) => { releaseAll = resolve; });
  const modelServer = await jsonServer(t, async (request, response) => {
    requests.push(await readJsonBody(request));
    await gate;
    return respondJson(response, 200, textResponse());
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-block:block-model',
    providers: [{
      id: 'fixture-block', name: 'Block', type: 'openai-compatible', baseUrl: modelServer.url,
      apiKey: 'test-key', enabled: true, autoDiscover: false, models: [{ id: 'block-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);

  const parentRun = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'parent task', modelRef: 'fixture-block:block-model' });
  await waitFor(() => requests.length >= 1 || null, { timeoutMs: 5000, message: 'parent request issued' });

  const delegatePromise = runtime.engine.delegate({ task: 'child work' }, { runId: parentRun.id, workspaceId: workspace.id, scope: {} });
  await waitFor(() => requests.length >= 2 || null, { timeoutMs: 5000, message: 'child request issued' });

  const active = runtime.engine.listActiveRuns();
  const child = active.find((run) => run.meta?.parentRunId === parentRun.id);
  assert.ok(child, 'expected a delegated child run to be active');

  runtime.engine.cancel(parentRun.id);
  releaseAll();

  const [parentResult, childResult] = await Promise.all([runtime.engine.waitForRun(parentRun.id), runtime.engine.waitForRun(child.id)]);
  assert.equal(parentResult.status, 'cancelled');
  assert.equal(childResult.status, 'cancelled');
  await delegatePromise.catch(() => {});
});

test('a parent run refuses to delegate beyond its configured concurrent-subagent limit', async (t) => {
  let releaseAll;
  const gate = new Promise((resolve) => { releaseAll = resolve; });
  const requests = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    requests.push(await readJsonBody(request));
    await gate;
    return respondJson(response, 200, textResponse());
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-narrow:n-model',
    maxParallelSubagents: 1,
    providers: [{
      id: 'fixture-narrow', name: 'Narrow', type: 'openai-compatible', baseUrl: modelServer.url,
      apiKey: 'test-key', enabled: true, autoDiscover: false, models: [{ id: 'n-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const parentRun = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'parent task', modelRef: 'fixture-narrow:n-model' });
  await waitFor(() => requests.length >= 1 || null, { timeoutMs: 5000, message: 'parent request issued' });

  const firstChild = runtime.engine.delegate({ task: 'first child' }, { runId: parentRun.id, workspaceId: workspace.id, scope: {} });
  await waitFor(() => requests.length >= 2 || null, { timeoutMs: 5000, message: 'first child request issued' });

  await assert.rejects(
    runtime.engine.delegate({ task: 'second child' }, { runId: parentRun.id, workspaceId: workspace.id, scope: {} }),
    /active subagent/,
  );

  releaseAll();
  runtime.engine.cancel(parentRun.id);
  await Promise.allSettled([firstChild, runtime.engine.waitForRun(parentRun.id)]);
});

test('a run is aborted once it exceeds its configured wall-clock deadline', async (t) => {
  const modelServer = await jsonServer(t, async (request, response) => {
    // The engine floors any configured deadline at 1000ms, so this response must outlast that.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return respondJson(response, 200, textResponse('too late'));
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-deadline:d-model',
    maxRunDurationMs: 50,
    providers: [{
      id: 'fixture-deadline', name: 'Deadline', type: 'openai-compatible', baseUrl: modelServer.url,
      apiKey: 'test-key', enabled: true, autoDiscover: false, models: [{ id: 'd-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'ping', modelRef: 'fixture-deadline:d-model' });
  const completed = await runtime.engine.waitForRun(run.id);
  assert.equal(completed.status, 'cancelled');
  assert.match(completed.error, /wall-clock deadline/);
});

test('a run is stopped once it exceeds its configured token budget', async (t) => {
  let turn = 0;
  const modelServer = await jsonServer(t, async (request, response) => {
    turn += 1;
    if (turn === 1) {
      return respondJson(response, 200, {
        id: 'resp_1',
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      });
    }
    return respondJson(response, 200, textResponse('finishing up'));
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-budget:b-model',
    maxRunTokens: 500,
    providers: [{
      id: 'fixture-budget', name: 'Budget', type: 'openai-compatible', baseUrl: modelServer.url,
      apiKey: 'test-key', enabled: true, autoDiscover: false, models: [{ id: 'b-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'write a file', modelRef: 'fixture-budget:b-model' });
  const completed = await runtime.engine.waitForRun(run.id);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error, /token budget/);
});
