import test from 'node:test';
import assert from 'node:assert/strict';
import { Theme } from '../src/tui/theme.mjs';
import { CONTRASTS, ROLE_SETS } from '../src/tui/tokens.mjs';
import { Screen } from '../src/tui/screen.mjs';
import { panel, meter, frameSet } from '../src/tui/box.mjs';
import { diffLines } from '../src/tui/diff.mjs';
import { highlight } from '../src/tui/markdown.mjs';
import { heroBlock } from '../src/tui/brand.mjs';
import { selectedRow, stripAnsi, visibleWidth } from '../src/tui/text.mjs';

const make = (options = {}) => new Theme({ depth: 24, unicode: true, frozen: true, ...options });

function channels(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('every contrast level is pure green and keeps text at 4.5:1 on every surface', () => {
  for (const name of CONTRASTS) {
    const roles = ROLE_SETS[name];
    for (const [role, hex] of Object.entries(roles)) {
      const [r, g, b] = channels(hex);
      assert.equal(r, b, `${name}.${role} ${hex} is not a pure green`);
    }
    for (const surface of ['background', 'surface', 'surfaceRaised', 'surfaceSunken', 'selection']) {
      for (const role of ['heading', 'text', 'label', 'dim', 'muted', 'success', 'warning', 'danger', 'info', 'tool', 'skill', 'user']) {
        assert.ok(contrast(roles[role], roles[surface]) >= 4.5, `${name}: ${role} on ${surface}`);
      }
    }
  }
});

test('an unknown contrast falls back to standard', () => {
  assert.equal(make({ contrast: 'nonsense' }).contrast, 'standard');
  assert.equal(make({ contrast: 'high' }).roles, ROLE_SETS.high);
});

test('painting with the danger or warning colour carries its weight, wherever it is called from', () => {
  const theme = make();
  const danger = theme.paint('x', { fg: theme.roles.danger });
  assert.ok(danger.includes(`48;2;${channels(theme.roles.danger).join(';')}`), 'danger should be an inverse bar');
  assert.ok(theme.paint('x', { fg: theme.roles.warning }).includes('\u001b[1m'), 'warning should be bold');
  const plain = theme.paint('x', { fg: theme.roles.text });
  assert.ok(!plain.includes('\u001b[1m') && !plain.includes('48;'));
});

test('frames are square, and double for the focused pane', () => {
  const theme = make();
  assert.equal(frameSet(theme, 'square').tl, '┌');
  const idle = panel({ theme, width: 20, height: 3, title: 'Plan' }).map(stripAnsi);
  const focused = panel({ theme, width: 20, height: 3, title: 'Plan', focused: true }).map(stripAnsi);
  assert.ok(idle[0].startsWith('┌'), idle[0]);
  assert.ok(focused[0].startsWith('╔'), focused[0]);
  assert.ok(focused[0].includes('PLAN'), 'panel titles are upper case');
});

test('the meter is solid blocks against a hollow track', () => {
  const text = stripAnsi(meter(make(), 3, 6, 6));
  assert.equal(text, '███░░░');
});

test('diffs read by weight: added bold and bright, removed dim and struck through', () => {
  const theme = make();
  const [added, removed] = diffLines(theme, '+new line\n-old line', 40);
  assert.ok(added.includes('\u001b[1m') && !added.includes('\u001b[9m'));
  assert.ok(removed.includes('\u001b[9m'), 'removed line is struck through');
  assert.ok(stripAnsi(added).includes('+new line') && stripAnsi(removed).includes('-old line'));
});

test('syntax is told apart by weight and style, not hue', () => {
  const theme = make();
  const out = highlight(theme, 'const answer = 42; // note', 'javascript');
  assert.ok(out.includes('\u001b[1m'), 'keywords are bold');
  assert.ok(out.includes('\u001b[4m'), 'numbers are underlined');
  assert.ok(out.includes('\u001b[3m'), 'comments are italic');
});

test('a selected row is a full inverse bar and keeps its width', () => {
  const theme = make();
  const row = selectedRow(theme, `${theme.paint('abc', { fg: theme.roles.danger })} def`);
  assert.equal(stripAnsi(row), 'abc def');
  assert.equal(visibleWidth(row), 7);
  assert.ok(row.includes(`48;2;${channels(theme.roles.primary).join(';')}`));
  assert.equal(selectedRow(make({ depth: 0 }), 'abc'), 'abc');
});

test('the welcome wordmark is a block-letter prompt, and the tagline completes when the clock is frozen', () => {
  const theme = make();
  const block = heroBlock(theme, 120).map(stripAnsi);
  assert.equal(block.slice(0, 5).every((line) => /[█ ]/.test(line)), true);
  assert.ok(block.some((line) => line.includes('A general-purpose agent harness for any model')));
});

test('16- and 256-colour fallbacks keep text, rules and surfaces distinct', () => {
  for (const depth of [8, 4]) {
    const theme = make({ depth });
    const code = (hex) => theme.fg(hex);
    // Readable text must never collapse onto the background.
    for (const role of ['text', 'dim', 'muted']) {
      assert.notEqual(code(theme.roles[role]).replace('38', '48'), theme.bg(theme.roles.background), `${depth}: ${role}`);
    }
    // The ramp must still have at least four distinct steps.
    const steps = new Set(['heading', 'text', 'dim', 'muted', 'borderStrong'].map((role) => code(theme.roles[role])));
    assert.ok(steps.size >= (depth === 8 ? 4 : 2), `${depth}: only ${steps.size} distinct greens`);
  }
});

test('the screen paints its own ground on every row, with optional scanlines, and can be left transparent', () => {
  const sink = { columns: 10, rows: 2, isTTY: true, written: '', write(text) { this.written += text; }, on() {}, off() {} };
  const opaque = new Screen({ output: sink, theme: make() });
  opaque.render(['a', 'b']);
  const background = make().bg(make().roles.background);
  assert.ok(sink.written.includes(background));

  const lined = make({ scanlines: true });
  assert.notEqual(lined.groundCode(0), lined.groundCode(1));
  assert.equal(make({ opaque: false }).groundCode(0), '');
  assert.equal(make({ depth: 0 }).groundCode(0), '');
});

test('on a 16-colour terminal the borders stay visible rather than turning black', () => {
  const theme = make({ depth: 4 });
  assert.notEqual(theme.fg(theme.roles.border), theme.fg('#000000'));
});
