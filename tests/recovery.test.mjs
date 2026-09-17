import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli/main.mjs';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest, waitFor } from './helpers.mjs';

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  return { text: () => chunks.join(''), restore: () => { process.stdout.write = original; } };
}
async function cli(argv) {
  const capture = captureStdout();
  try { const code = await main(argv); return { code, output: capture.text() }; }
  finally { capture.restore(); }
}

/** A pid that has definitely already exited, for deterministic "owner is gone" tests. */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

function makeStaleRun(runtime, workspace, { ownerPid = deadPid(), status = 'running' } = {}) {
  const session = runtime.store.createSession({ workspaceId: workspace.id, title: 'stale' });
  const run = runtime.store.createRun({
    sessionId: session.id, workspaceId: workspace.id, prompt: 'do something', modelId: 'fixture:x',
    meta: { ownerPid },
  });
  runtime.store.updateRun(run.id, { status });
  return { session, run };
}

test('recoverableRuns finds a run left "running" by a dead process, with its unresolved intents', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace);

  runtime.store.addRunEvent(run.id, 'tool-intent', { toolCallId: 'call_1', tool: 'fs_write', argsHash: 'abc' });
  runtime.store.addRunEvent(run.id, 'tool-intent', { toolCallId: 'call_2', tool: 'shell_exec', argsHash: 'def' });
  runtime.store.addRunEvent(run.id, 'tool-result', { toolCallId: 'call_2', tool: 'shell_exec', content: 'ok' });

  const recoverable = runtime.engine.recoverableRuns();
  const found = recoverable.find((item) => item.id === run.id);
  assert.ok(found, 'expected the stale run to be listed as recoverable');
  assert.equal(found.pendingIntents.length, 1);
  assert.equal(found.pendingIntents[0].toolCallId, 'call_1');
});

test('recoverableRuns ignores a run whose owner is this process', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace, { ownerPid: process.pid });
  assert.ok(!runtime.engine.recoverableRuns().some((item) => item.id === run.id));
});

test('recoverableRuns ignores a run with no recorded owner but still active in this process', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace, { ownerPid: null });
  runtime.engine.active.set(run.id, { runId: run.id, sessionId: run.session_id, options: {}, controller: { abort() {} } });
  t.after(() => runtime.engine.active.delete(run.id));
  assert.ok(!runtime.engine.recoverableRuns().some((item) => item.id === run.id));
});

test('reconcile moves a stale run to "interrupted" and records the note', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace);

  const updated = runtime.engine.reconcile(run.id, 'Checked the worktree; no partial writes found.');
  assert.equal(updated.status, 'interrupted');
  assert.equal(updated.meta.recovery.note, 'Checked the worktree; no partial writes found.');
  assert.ok(!runtime.engine.recoverableRuns().some((item) => item.id === run.id));
});

test('reconcile refuses without a note', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace);
  assert.throws(() => runtime.engine.reconcile(run.id, ''), /note/);
});

test('reconcile refuses a run whose owning process might still be alive', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace, { ownerPid: process.pid });
  assert.throws(() => runtime.engine.reconcile(run.id, 'note'), /may still be alive/);
});

test('reconcile refuses a run that is still active in this process', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const { run } = makeStaleRun(runtime, workspace);
  runtime.engine.active.set(run.id, { runId: run.id, sessionId: run.session_id, options: {}, controller: { abort() {} } });
  t.after(() => runtime.engine.active.delete(run.id));
  assert.throws(() => runtime.engine.reconcile(run.id, 'note'), /still active/);
});

test('a real run records its owner pid and pairs tool intents with results', async (t) => {
  const modelServer = await jsonServer(t, async (request, response) => {
    const body = await readJsonBody(request);
    if (body.messages.some((m) => Array.isArray(m.tool_calls))) {
      return respondJson(response, 200, { id: 'r2', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} });
    }
    return respondJson(response, 200, {
      id: 'r1',
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'note.txt', content: 'hi' }) } }] }, finish_reason: 'tool_calls' }],
      usage: {},
    });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-intent:i-model',
    providers: [{
      id: 'fixture-intent', name: 'Intent', type: 'openai-compatible', baseUrl: modelServer.url,
      apiKey: 'test-key', enabled: true, autoDiscover: false, models: [{ id: 'i-model' }], timeoutMs: 15_000,
    }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'write a note', modelRef: 'fixture-intent:i-model' });
  const completed = await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'intent run completion' });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.meta.ownerPid, process.pid);
  const events = runtime.store.listRunEvents(run.id, 2000);
  const intent = events.find((event) => event.type === 'tool-intent');
  assert.ok(intent, 'expected a tool-intent event for the write tool call');
  assert.equal(intent.payload.tool, 'fs_write');
  const result = events.find((event) => event.type === 'tool-result' && event.payload.toolCallId === intent.payload.toolCallId);
  assert.ok(result, 'expected the intent to be resolved by a matching tool-result event');
  assert.ok(!runtime.engine.recoverableRuns().some((item) => item.id === run.id));
});

test('the CLI can list and reconcile a stale run', async (t) => {
  const project = await createProject(t);
  const home = path.join(project, '.maskshift-home');
  const config = path.join(home, 'config.json');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(config, `${JSON.stringify({
    home, autoIndex: false, autoCheckpoint: false,
    automations: { enabled: false, pollIntervalMs: 10_000, maxPerTick: 1 },
  }, null, 2)}\n`);
  const base = ['--config', config, '--workspace', project, '--json'];

  // Seed a stale run directly, the same way makeStaleRun does, but through a CLI-driven runtime.
  const openResult = JSON.parse((await cli(['workspace', 'open', project, ...base, '--no-index'])).output);
  const runtime = await import('../src/runtime.mjs').then((m) => m.createRuntime({ configPath: config, workspacePath: project, configOverrides: { home, autoIndex: false } }));
  const session = runtime.store.createSession({ workspaceId: openResult.id, title: 'stale-cli' });
  const run = runtime.store.createRun({ sessionId: session.id, workspaceId: openResult.id, prompt: 'go', modelId: 'fixture:x', meta: { ownerPid: deadPid() } });
  runtime.store.updateRun(run.id, { status: 'running' });
  await runtime.close();

  const pending = JSON.parse((await cli(['recovery', 'pending', ...base])).output);
  assert.ok(pending.some((item) => item.id === run.id));

  const reconciled = JSON.parse((await cli(['recovery', 'reconcile', run.id, '--note', 'Reviewed in test', ...base])).output);
  assert.equal(reconciled.status, 'interrupted');

  const afterward = JSON.parse((await cli(['recovery', 'pending', ...base])).output);
  assert.ok(!afterward.some((item) => item.id === run.id));
});
