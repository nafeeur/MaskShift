import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runCommand } from '../src/core/utils.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

test('runtime exposes maximal lazy capabilities and executes host tools', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);

  assert.ok(runtime.toolRegistry.list().length >= 140);
  assert.ok(runtime.skillManager.list().length >= 36);
  assert.equal(runtime.config.get().permissionMode, 'overdrive');

  const context = {
    workspaceId: workspace.id,
    workspacePath: project,
    eventBus: runtime.eventBus,
    scope: { workspaceId: workspace.id },
  };
  await runtime.toolRegistry.execute('fs_write', { path: 'tool-output.txt', content: 'MASKSHIFT_TOOL_OK\n' }, context);
  const read = await runtime.toolRegistry.execute('fs_read', { path: 'tool-output.txt', withLineNumbers: false }, context);
  assert.match(read.content, /MASKSHIFT_TOOL_OK/);
  const shell = await runtime.toolRegistry.execute('shell_exec', { command: 'printf HOST_EXEC_OK' }, context);
  assert.equal(shell.code, 0);
  assert.equal(shell.stdout, 'HOST_EXEC_OK');

  const index = await runtime.indexer.index(workspace.id, { force: true });
  assert.ok(index.indexedFiles >= 3);
  assert.ok((await runtime.indexer.search(workspace.id, 'velocity distance time')).some((hit) => hit.path === 'index.js'));
});

test('plugins hot-load tools and one-shot automations clear their schedule after execution', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);

  const scaffold = await runtime.pluginManager.scaffold({ name: 'race-telemetry', description: 'Fixture plugin' });
  assert.equal(scaffold.plugin.status, 'active');
  assert.equal(runtime.toolRegistry.has('race_telemetry_hello'), true);
  const pluginResult = await runtime.toolRegistry.execute('race_telemetry_hello', { name: 'Redline' }, {});
  assert.deepEqual(pluginResult, { message: 'Hello, Redline' });

  const automation = runtime.automationScheduler.create({
    workspaceId: workspace.id,
    name: 'Write finish flag',
    schedule: new Date(Date.now() + 60_000).toISOString(),
    action: { type: 'shell', command: 'printf AUTOMATION_OK > automation.txt' },
  });
  const execution = await runtime.automationScheduler.execute(automation.id, { manual: true });
  assert.equal(execution.status, 'completed');
  assert.equal(await fsp.readFile(path.join(project, 'automation.txt'), 'utf8'), 'AUTOMATION_OK');
  const finished = runtime.automationScheduler.get(automation.id);
  assert.equal(finished.enabled, false);
  assert.equal(finished.next_run_at, null);
  assert.equal(finished.last_status, 'completed');
});

test('Git checkpoints restore a clean repository state, not only dirty stashes', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const before = await fsp.readFile(path.join(project, 'index.js'), 'utf8');
  const checkpoint = await runtime.workspaceManager.createCheckpoint(workspace.id, { label: 'clean baseline' });
  assert.ok(checkpoint.manifest.commit, 'clean checkpoint should point at HEAD');

  await fsp.writeFile(path.join(project, 'index.js'), 'BROKEN\n');
  await runtime.workspaceManager.restoreCheckpoint(workspace.id, checkpoint);
  assert.equal(await fsp.readFile(path.join(project, 'index.js'), 'utf8'), before);
  assert.equal((await runCommand('git status --porcelain', { cwd: project })).stdout.trim(), '');
});
