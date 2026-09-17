// Covers three token/latency fixes together, since they were diagnosed and fixed as one pass:
// (1) the first ContextBuilder.build() on a fresh workspace used to block the whole turn on
// indexing + code-graph building the entire repo; (2) the capability catalog rendered a full
// description per tool/skill/MCP server into the system prompt on every turn; (3) autoPrime()
// blind-loaded full skill bodies (tens of thousands of characters) for any skill that merely
// scored above zero against the prompt. All three inflated the very first request's token count
// and, for (1), its latency.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createProject, runtimeForTest, waitFor } from './helpers.mjs';

test('the first context build on a fresh workspace returns quickly instead of blocking on a full index', async (t) => {
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'extra.js'), 'export const total = (a, b) => a + b;\n');
  const runtime = await runtimeForTest(t, project, { autoIndex: true });
  const workspace = await runtime.workspaceManager.open(project);

  const started = Date.now();
  const first = await runtime.contextBuilder.build({ workspaceId: workspace.id, prompt: 'fix the bug', sessionId: null });
  const elapsedMs = Date.now() - started;

  // Generous relative to a full index+graph build, tight enough to catch a regression back to
  // blocking synchronously. A cold index+graph build on even this tiny fixture repo used to take
  // meaningfully longer than a background-kicked-off build returning immediately.
  assert.ok(elapsedMs < 2000, `expected the first build to return quickly, took ${elapsedMs}ms`);
  assert.ok(!first.indexStats?.chunks, 'the very first build should not have waited for indexing to finish');

  // The background job the first build kicked off should complete on its own and be reflected
  // the next time build() is called for the same workspace.
  await waitFor(() => (runtime.indexer.stats(workspace.id)?.chunks ? true : null), {
    timeoutMs: 5000, message: 'background indexing to finish',
  });
  const second = await runtime.contextBuilder.build({ workspaceId: workspace.id, prompt: 'fix the bug', sessionId: null });
  assert.ok(second.indexStats?.chunks > 0, 'a later build should see the index the background job finished');
});

test('the capability catalog lists tool and skill names, not a full description per entry', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const catalog = runtime.capabilityController.catalogSummary({ workspaceId: null });

  assert.ok(catalog.includes('fs_read'), 'expected a real tool name in the catalog');
  assert.ok(catalog.includes('### '), 'expected tools grouped under category headings');
  // A few real tool/skill descriptions, chosen because they are long enough that their presence
  // would be obvious — if the catalog is back to rendering full descriptions, one of these
  // distinctively-worded phrases will show up.
  assert.ok(!catalog.includes('without loading it all into model context'), 'expected no tool descriptions, only names');
  assert.ok(catalog.length < 8_000, `expected a names-only catalog to be compact, was ${catalog.length} chars`);
});

test('auto-primed skills carry a bounded preview, not their full body', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const state = runtime.capabilityController.createState({ runId: 'r1', workspaceId: workspace.id });

  // A prompt broad enough to score against several bundled skills, the same way a generic first
  // message would — this is what used to pull in multiple full (tens-of-thousands-of-character)
  // skill bodies before the model had asked for any of them.
  await runtime.capabilityController.autoPrime(state, 'help me with this project');

  for (const [name, skill] of state.skills) {
    assert.ok(skill.body.length <= 2_100, `auto-primed skill "${name}" carried ${skill.body.length} chars, expected a bounded preview`);
  }

  // Explicit activation — the model actually deciding it wants this skill — must still get the
  // real, un-capped body; only the blind auto-prime guess is bounded.
  if (state.skills.size) {
    const [name] = state.skills.keys();
    const { results } = await runtime.capabilityController.activate(state, [name], { kind: 'skill' });
    assert.ok(results.some((entry) => entry.activated));
    const full = state.skills.get(name);
    assert.ok(full.body.length > 0);
  }
});
