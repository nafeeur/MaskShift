import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresConfirmation } from '../src/tools/permissions.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

function contextFor(runtime, workspace, project) {
  return { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
}

test('requiresConfirmation never gates readOnly tools or overdrive mode', () => {
  const readOnlyTool = { readOnly: true, risk: 'host-exec' };
  assert.equal(requiresConfirmation(readOnlyTool, 'review'), false);
  const writeTool = { readOnly: false, risk: 'write' };
  assert.equal(requiresConfirmation(writeTool, 'overdrive'), false);
});

test('balanced gates only high-risk tiers; review gates every non-readOnly tool', () => {
  const shellExec = { readOnly: false, risk: 'host-exec' };
  const fileWrite = { readOnly: false, risk: 'write' };
  assert.equal(requiresConfirmation(shellExec, 'balanced'), true);
  assert.equal(requiresConfirmation(fileWrite, 'balanced'), false);
  assert.equal(requiresConfirmation(shellExec, 'review'), true);
  assert.equal(requiresConfirmation(fileWrite, 'review'), true);
});

test('a gated tool call fails closed with no confirmHandler wired up', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { permissionMode: 'review' });
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);
  await assert.rejects(
    runtime.toolRegistry.execute('fs_write', { path: 'blocked.txt', content: 'nope' }, context),
    /requires confirmation under permission mode "review"/,
  );
});

test('a gated tool call runs once confirmHandler approves it, and is blocked when it declines', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { permissionMode: 'balanced' });
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  let allow = false;
  const seen = [];
  runtime.toolRegistry.confirmHandler = async ({ name, tool }) => { seen.push({ name, risk: tool.risk }); return allow; };

  await assert.rejects(
    runtime.toolRegistry.execute('shell_exec', { command: 'echo hi' }, context),
    /requires confirmation under permission mode "balanced"/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'shell_exec');

  allow = true;
  const result = await runtime.toolRegistry.execute('shell_exec', { command: 'echo hi' }, context);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hi/);

  // A plain file write is below balanced's gated tiers, so it never consults confirmHandler.
  await runtime.toolRegistry.execute('fs_write', { path: 'ok.txt', content: 'fine' }, context);
  assert.equal(seen.length, 2);
});
