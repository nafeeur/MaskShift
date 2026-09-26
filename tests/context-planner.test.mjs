import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextPlanner } from '../src/agent/context-planner.mjs';

function planner(overrides = {}) {
  const config = {
    maxContextChars: 420_000,
    contextPlanner: { scale: { conversational: 0.04, focused: 0.12, broad: 1 }, minSourceOverlap: 0.2, minSemanticScore: 0.55, ...overrides },
  };
  return new ContextPlanner({ config: { get: () => config }, logger: null });
}

test('profile separates chat, focused edits and broad tasks', () => {
  const p = planner();
  assert.equal(p.profile('hi'), 'conversational');
  assert.equal(p.profile('thanks, what can you do?'), 'conversational');
  assert.equal(p.profile('fix the port_inspect exit code'), 'focused');
  assert.equal(p.profile('refactor the provider layer across the codebase'), 'broad');
  assert.equal(p.profile('x'.repeat(1300)), 'broad');
});

test('budgets shrink with the profile, drop source for chat, and keep an instructions floor', () => {
  const p = planner();
  const broad = p.budgets(420_000, 'broad');
  const focused = p.budgets(420_000, 'focused');
  const chat = p.budgets(420_000, 'conversational');
  assert.equal(chat.source, 0);
  assert.ok(focused.source > 0 && focused.source < broad.source);
  assert.ok(chat.instructions >= 12_000);
  assert.ok(chat.instructions <= broad.instructions);
});

test('select drops skill markdown, off-topic docs and low-relevance hits', () => {
  const p = planner();
  const budgets = p.budgets(420_000, 'focused');
  const hits = [
    { path: 'src/tools/platform-tools.mjs', language: 'javascript', content: 'port_inspect lsof exit code' },
    { path: 'skills/claude-api/SKILL.md', language: 'markdown', content: 'port_inspect exit code' },
    { path: 'docs/TOOLS.md', language: 'markdown', content: 'port_inspect exit code' },
    { path: 'src/tui/theme.mjs', language: 'javascript', content: 'palette colours' },
    { path: 'src/net/probe.mjs', language: 'javascript', content: 'unrelated wording', semanticScore: 0.8 },
  ];
  const { repoHits, report } = p.select({ prompt: 'fix the port_inspect exit code', repoHits: hits, budgets });
  assert.deepEqual(repoHits.map((hit) => hit.path).sort(), ['src/net/probe.mjs', 'src/tools/platform-tools.mjs']);
  assert.equal(report.source.excluded, 3);

  const withDocs = p.select({ prompt: 'update the port_inspect docs', repoHits: hits, budgets });
  assert.ok(withDocs.repoHits.some((hit) => hit.path === 'docs/TOOLS.md'));
  assert.ok(!withDocs.repoHits.some((hit) => hit.path.startsWith('skills/')));
});
