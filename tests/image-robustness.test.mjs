import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DELETE_ALL, DIACRITICS, PLACEHOLDER, deleteEscape, imageIdFor, placeholderRows, transmitEscape } from '../src/tui/image/kitty.mjs';
import { detectImageProtocol } from '../src/tui/image/protocol.mjs';
import { Screen } from '../src/tui/screen.mjs';
import { sanitizeTerminalLine, sliceAnsi, visibleWidth } from '../src/tui/text.mjs';
import { Theme } from '../src/tui/theme.mjs';

class FakeOutput extends EventEmitter {
  constructor() { super(); this.columns = 40; this.rows = 8; this.writes = []; }
  write(text) { this.writes.push(text); }
}

function screenFor() {
  const output = new FakeOutput();
  const screen = new Screen({ output, theme: new Theme() });
  screen.active = true;
  return { screen, output };
}

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const overlayFor = (key, cols = 4, rows = 2) => {
  const id = imageIdFor(key);
  return { protocol: 'kitty-unicode', id, key, escape: transmitEscape(id, png, cols, rows), rows };
};
const rowsFor = (overlay, cols = 4, rows = 2) => placeholderRows(overlay.id, cols, rows);

test('placeholder rows are text of exactly the image width that survive the screen\'s sanitizer', () => {
  assert.equal(DIACRITICS.length, 297);
  const rows = placeholderRows(0x010203, 5, 3);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(visibleWidth(row), 5);
    assert.equal(sanitizeTerminalLine(row), row, 'nothing in a placeholder row is stripped');
    assert.equal([...row].filter((character) => character === PLACEHOLDER).length, 5);
  }
  assert.match(rows[0], /\x1b\[38;2;1;2;3m/, 'the foreground colour carries the image id');
  assert.equal(visibleWidth(sliceAnsi(rows[0], 0, 2)), 2, 'a row can be clipped by columns like any text');
});

test('the image id is stable per picture and never zero', () => {
  assert.equal(imageIdFor('a'), imageIdFor('a'));
  assert.notEqual(imageIdFor('a'), imageIdFor('b'));
  assert.ok(imageIdFor('x') > 0 && imageIdFor('x') <= 0xffffff);
});

test('transmission is quiet and precedes the rows that use it; an unchanged image is never resent', () => {
  const { screen, output } = screenFor();
  const overlay = overlayFor('shot');
  screen.render(rowsFor(overlay), null, [overlay]);
  const first = output.writes.join('');
  assert.ok(first.includes(overlay.escape));
  assert.ok(first.indexOf(overlay.escape) < first.indexOf(PLACEHOLDER), 'picture first, cells second');
  assert.match(overlay.escape, /q=2/, 'terminal replies are suppressed so they are not read as keystrokes');
  output.writes.length = 0;
  screen.render(rowsFor(overlay), null, [overlay]);
  screen.render(rowsFor(overlay), null, [overlay]);
  assert.equal(output.writes.join(''), '', 'identical frames write nothing');
});

test('an image no row refers to any more is freed, and so is the whole set on exit', () => {
  const { screen, output } = screenFor();
  const a = overlayFor('a');
  const b = overlayFor('b');
  screen.render(rowsFor(a), null, [a]);
  output.writes.length = 0;
  screen.render(rowsFor(b), null, [b]);
  const swapped = output.writes.join('');
  assert.ok(swapped.includes(b.escape));
  assert.ok(swapped.includes(deleteEscape(a.id)), 'the old picture is deleted');
  output.writes.length = 0;
  screen.render([], null, null);
  assert.ok(output.writes.join('').includes(deleteEscape(b.id)), 'switching to a view without images removes it');
  const c = overlayFor('c');
  screen.render(rowsFor(c), null, [c]);
  output.writes.length = 0;
  screen.leave();
  assert.ok(output.writes.join('').includes(DELETE_ALL));
});

test('resync (terminal regained focus, resume, resize) repaints and sends the picture again', () => {
  const { screen, output } = screenFor();
  const overlay = overlayFor('shot');
  screen.render(rowsFor(overlay), null, [overlay]);
  output.writes.length = 0;
  screen.resync();
  screen.render(rowsFor(overlay), null, [overlay]);
  const again = output.writes.join('');
  assert.ok(again.includes(overlay.escape), 'transmitted again');
  assert.ok(again.includes(PLACEHOLDER), 'cells repainted');
  output.writes.length = 0;
  screen.handleResize();
  screen.render(rowsFor(overlay), null, [overlay]);
  assert.ok(output.writes.join('').includes(overlay.escape), 'a resize also re-sends it');
});

test('several images can be on screen at once and are tracked independently', () => {
  const { screen, output } = screenFor();
  const a = overlayFor('a', 2, 1);
  const b = overlayFor('b', 2, 1);
  screen.render([...rowsFor(a, 2, 1), ...rowsFor(b, 2, 1)], null, [a, b]);
  output.writes.length = 0;
  screen.render([...rowsFor(a, 2, 1), ...rowsFor(b, 2, 1)], null, [a]);
  const text = output.writes.join('');
  assert.ok(text.includes(deleteEscape(b.id)));
  assert.ok(!text.includes(deleteEscape(a.id)));
});

test('a classic placement is withdrawn when it disappears, even after a modal cleared the key', () => {
  const { screen, output } = screenFor();
  screen.render([], null, { protocol: 'kitty', row: 1, column: 1, escape: 'IMG', key: 'k' });
  output.writes.length = 0;
  screen.render([], null, null);
  assert.ok(output.writes.join('').includes('\x1b_Ga=d'));
});

test('protocol choice: placeholders on Kitty and Ghostty, text-only under tmux, overridable', () => {
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' }), 'kitty-unicode');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'ghostty' }), 'kitty-unicode');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'WezTerm' }), 'kitty');
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1', TMUX: '/tmp/tmux-0/default,1,0' }), 'halfblock');
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1', TMUX: 'x', MASKSHIFT_IMAGE: 'kitty-unicode' }), 'kitty-unicode');
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1', MASKSHIFT_IMAGE: 'halfblock' }), 'halfblock');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
});
