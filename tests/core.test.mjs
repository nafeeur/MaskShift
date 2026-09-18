import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ConfigManager } from '../src/core/config.mjs';
import { Store } from '../src/core/store.mjs';
import { tempDir } from './helpers.mjs';

test('configuration overrides are isolated and persisted under the requested home', async (t) => {
  const home = await tempDir(t, 'maskshift-config-');
  const config = new ConfigManager({
    configPath: path.join(home, 'config.json'),
    overrides: { home, port: 0, permissionMode: 'overdrive', automations: { enabled: false } },
  });
  await config.load();
  assert.equal(config.get().home, home);
  assert.equal(config.get().dataFile, path.join(home, 'maskshift.sqlite'));
  assert.equal(config.get().permissionMode, 'overdrive');
  assert.equal(config.get().automations.enabled, false);
  // Both off/unset by default — an external notify command and a spend
  // guardrail are things an operator opts into, never a silent default.
  assert.equal(config.get().notifications.enabled, false);
  assert.equal(config.get().costBudget.session, null);
});

test('SQLite store provides FTS memory and exact nullable automation updates', async (t) => {
  const root = await tempDir(t, 'maskshift-store-');
  const store = new Store(path.join(root, 'state.sqlite'));
  await store.init();
  t.after(() => store.close());

  const workspace = store.upsertWorkspace(path.join(root, 'repo'), 'repo', {});
  const memory = store.saveMemory({
    workspaceId: workspace.id,
    title: 'Build convention',
    content: 'Always run the deterministic velocity regression suite.',
    tags: ['testing', 'velocity'],
  });
  assert.equal(store.searchMemories('velocity regression', { workspaceId: workspace.id })[0].id, memory.id);

  const future = new Date(Date.now() + 60_000).toISOString();
  const automation = store.saveAutomation({
    workspaceId: workspace.id,
    name: 'One shot',
    enabled: true,
    schedule: { type: 'once', at: future },
    action: { type: 'shell', command: 'true' },
    nextRunAt: future,
    lastRunAt: future,
    lastStatus: 'queued',
  });
  const updated = store.updateAutomation(automation.id, {
    enabled: false,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.next_run_at, null);
  assert.equal(updated.last_run_at, null);
  assert.equal(updated.last_status, null);
});

test('searchMessages greps every session in a workspace, not just the open one', async (t) => {
  const root = await tempDir(t, 'maskshift-search-');
  const store = new Store(path.join(root, 'state.sqlite'));
  await store.init();
  t.after(() => store.close());

  const workspace = store.upsertWorkspace(path.join(root, 'repo'), 'repo', {});
  const other = store.upsertWorkspace(path.join(root, 'other'), 'other', {});

  const sessionA = store.createSession({ workspaceId: workspace.id, title: 'First heist' });
  const sessionB = store.createSession({ workspaceId: workspace.id, title: 'Second heist' });
  const sessionC = store.createSession({ workspaceId: other.id, title: 'Different target' });

  store.addMessage({ sessionId: sessionA.id, role: 'user', content: 'How do I configure the vault door widget?' });
  store.addMessage({ sessionId: sessionB.id, role: 'assistant', content: 'The widget takes a keycode prop.' });
  store.addMessage({ sessionId: sessionC.id, role: 'user', content: 'widget question from a different workspace' });

  const scoped = store.searchMessages('widget', { workspaceId: workspace.id });
  assert.equal(scoped.length, 2);
  assert.deepEqual(new Set(scoped.map((r) => r.sessionId)), new Set([sessionA.id, sessionB.id]));
  assert.ok(scoped.every((r) => r.sessionTitle));

  const unscoped = store.searchMessages('widget');
  assert.equal(unscoped.length, 3);

  assert.deepEqual(store.searchMessages(''), []);
  assert.deepEqual(store.searchMessages('nothing-matches-this-phrase'), []);

  // A LIKE wildcard in the query itself is a literal character to search for, not a wildcard.
  store.addMessage({ sessionId: sessionA.id, role: 'user', content: 'discount: 50%_off applies' });
  assert.equal(store.searchMessages('50%_off', { workspaceId: workspace.id }).length, 1);
});
