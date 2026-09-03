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
