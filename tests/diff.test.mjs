import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines, looksLikeDiff } from '../src/tui/diff.mjs';
import { detectDiffText } from '../src/tui/views/chat.mjs';
import { sanitizeTerminalLine, visibleWidth } from '../src/tui/text.mjs';
import { Theme } from '../src/tui/theme.mjs';

const SAMPLE_DIFF = [
  'diff --git a/src/foo.js b/src/foo.js',
  'index 1234567..89abcde 100644',
  '--- a/src/foo.js',
  '+++ b/src/foo.js',
  '@@ -1,3 +1,4 @@',
  ' function foo() {',
  '-  return 1;',
  '+  return 2;',
  '+  // note',
  ' }',
].join('\n');

test('looksLikeDiff recognises real unified diffs and rejects plain text', () => {
  assert.equal(looksLikeDiff(SAMPLE_DIFF), true);
  assert.equal(looksLikeDiff('4 files changed, 12 insertions(+)'), false); // a --stat summary
  assert.equal(looksLikeDiff(''), false);
  assert.equal(looksLikeDiff(null), false);
});

test('diffLines colours added/removed/context/header rows and stays inside the text pipeline', () => {
  const theme = new Theme({ depth: 24, unicode: true });
  const lines = diffLines(theme, SAMPLE_DIFF, 80);
  assert.equal(lines.length, SAMPLE_DIFF.split('\n').length);
  for (const line of lines) {
    assert.equal(sanitizeTerminalLine(line), line, 'a diff line should need no sanitizing');
    assert.ok(visibleWidth(line) > 0);
  }
});

test('diffLines caps output and says how much was cut', () => {
  const theme = new Theme({ depth: 24, unicode: true });
  const big = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n');
  const lines = diffLines(theme, big, 80, { maxLines: 10 });
  assert.equal(lines.length, 11); // 10 shown + one "N more lines" line
  assert.match(lines.at(-1), /90 more lines/);
});

test('detectDiffText finds fs_apply_patch\'s original patch via the preceding tool call', () => {
  const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
  const toolCallsById = new Map([['call_1', { id: 'call_1', name: 'fs_apply_patch', args: { patch } }]]);
  const message = { role: 'tool', meta: { toolName: 'fs_apply_patch', toolCallId: 'call_1' }, content: JSON.stringify({ applied: true }) };
  assert.equal(detectDiffText(message, toolCallsById), patch);
});

test('detectDiffText finds file_diff/git_diff\'s own diff field but not a --stat summary', () => {
  const toolCallsById = new Map();
  const withDiff = { role: 'tool', meta: { toolName: 'git_diff' }, content: JSON.stringify({ cwd: '/x', diff: SAMPLE_DIFF, empty: false }) };
  assert.equal(detectDiffText(withDiff, toolCallsById), SAMPLE_DIFF);

  const stat = { role: 'tool', meta: { toolName: 'git_diff' }, content: JSON.stringify({ cwd: '/x', diff: ' 1 file changed, 2 insertions(+)', empty: false }) };
  assert.equal(detectDiffText(stat, toolCallsById), null);
});

test('detectDiffText stays quiet for unrelated tools and missing calls', () => {
  const toolCallsById = new Map();
  assert.equal(detectDiffText({ role: 'tool', meta: { toolName: 'fs_read' }, content: 'hello' }, toolCallsById), null);
  assert.equal(detectDiffText({ role: 'tool', meta: { toolName: 'fs_apply_patch', toolCallId: 'missing' }, content: '{}' }, toolCallsById), null);
  assert.equal(detectDiffText({ role: 'assistant', content: SAMPLE_DIFF }, toolCallsById), null);
});
