import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { Keyboard, decode, matches } from '../src/tui/input.mjs';
import { panel } from '../src/tui/box.mjs';
import { sweepLine, spin } from '../src/tui/motion.mjs';
import { statusGlyph, statusOf } from '../src/tui/status.mjs';
import { SPACE } from '../src/tui/tokens.mjs';
import { transcriptLines } from '../src/tui/views/chat.mjs';
import { renderMarkdown } from '../src/tui/markdown.mjs';
import { Screen } from '../src/tui/screen.mjs';
import { split } from '../src/tui/layout.mjs';
import { Theme, detectDepth } from '../src/tui/theme.mjs';
import { fit, sanitizeTerminalLine, sliceAnsi, stripAnsi, truncate, visibleWidth, wrap } from '../src/tui/text.mjs';
import { Composer, ListView, TextField, Viewport, fuzzy } from '../src/tui/widgets.mjs';
import { Regions } from '../src/tui/regions.mjs';
import { resolveMouseMode } from '../src/tui/app.mjs';
import { ConfirmOverlay, FormOverlay, TextOverlay } from '../src/tui/overlays.mjs';
import { createProject, jsonServer, respondJson, runtimeForTest, tempDir, waitFor } from './helpers.mjs';

const ESC = String.fromCharCode(27);
const theme = new Theme({ depth: 24, unicode: true });

class FakeTerminal extends Writable {
  constructor(columns = 120, rows = 34) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = false;
    this.written = '';
  }

  _write(chunk, encoding, callback) {
    this.written += chunk.toString();
    callback();
  }
}

test('text measurement ignores ANSI and respects wide characters', () => {
  const painted = theme.paint('hello', { fg: theme.palette.crimson, bold: true });
  assert.equal(visibleWidth(painted), 5);
  assert.equal(stripAnsi(painted), 'hello');
  assert.equal(visibleWidth(fit(painted, 12)), 12);
  assert.equal(visibleWidth('日本語'), 6);
  assert.equal(visibleWidth(fit('日本語テスト', 8)), 8);
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(visibleWidth(sliceAnsi(painted, 1, 4)), 3);
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
});

test('panels render at an exact width in both focus states', () => {
  for (const focused of [true, false]) {
    const lines = panel({ theme, width: 40, height: 6, title: 'ARSENAL', stamp: '12', body: ['a', 'b'], focused });
    assert.equal(lines.length, 6);
    for (const line of lines) assert.equal(visibleWidth(line), 40);
  }

  // A pane may hand its top rail a pre-painted strip — a section switcher —
  // and the geometry has to survive it.
  const railed = panel({
    theme, width: 40, height: 5, titleRaw: theme.paint('TOOLS · SKILLS', { fg: theme.roles.label }),
    note: '9', stamp: '12', body: ['a'], focused: true,
  });
  assert.equal(railed.length, 5);
  for (const line of railed) assert.equal(visibleWidth(line), 40);
  assert.ok(stripAnsi(railed[0]).includes('TOOLS · SKILLS'));
});

test('markdown renders headings, lists, code and diffs inside the column', () => {
  const lines = renderMarkdown(theme, '# Title\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\n```diff\n+ added\n- removed\n```\n', 40);
  assert.ok(lines.length > 6);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, `"${stripAnsi(line)}" overflowed`);
  // Chrome is upper case; content keeps the case its author wrote. Shouting a
  // model's own headings back at the operator is what made replies read as
  // louder than the interface around them.
  assert.ok(lines.some((line) => stripAnsi(line).includes('Title')));
  assert.ok(!lines.some((line) => stripAnsi(line).includes('TITLE')));
  assert.ok(lines.some((line) => stripAnsi(line).includes('const a = 1;')));
  assert.ok(lines.some((line) => stripAnsi(line).includes('+ added')));
  // A reply never ends on whitespace: the transcript owns the gap between
  // turns, and a trailing blank doubled every one of them.
  assert.notEqual(lines.at(-1), '');
  assert.notEqual(lines[0], '');
});

test('every transcript row shares one left edge', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';
  app.messages = [
    { role: 'user', created_at: new Date().toISOString(), meta: {}, content: 'Refactor the renderer.' },
    {
      role: 'assistant',
      created_at: new Date().toISOString(),
      meta: { modelRef: 'ollama:qwen3-coder' },
      content: '## Plan\n\nDiff the frame instead.\n\n- read the module\n- add a test\n',
    },
    { role: 'tool', meta: { toolName: 'fs_read', isError: false }, content: '94 lines' },
  ];

  // The bug this replaced: a speaker chip, a user line, a model paragraph and
  // a tool result each began on a different column inside the same pane.
  //
  // The invariant is that the first `SPACE.gutter` columns of every row belong
  // to the marker — one glyph at most, then blanks — so text can only ever
  // begin at the gutter's far edge, whatever kind of row it is.
  // A blank row inside a turn keeps its rail and nothing else, which is how
  // the rail stays continuous down a reply; those aside, every row must clear
  // the gutter before it starts.
  const rows = transcriptLines(app, 80).map(stripAnsi).filter((line) => line.trim());
  for (const line of rows) {
    assert.equal(line.slice(1, SPACE.gutter), ' '.repeat(SPACE.gutter - 1), `row overran its gutter: "${line}"`);
  }
  // And the three kinds of row really do put their first character there.
  const starts = new Set(rows
    .filter((line) => /OPERATOR|MASKSHIFT|fs_read|Diff the frame/.test(line))
    .map((line) => line.slice(SPACE.gutter).length - line.slice(SPACE.gutter).trimStart().length));
  assert.deepEqual([...starts], [0], `speaker, prose and tool rows drifted apart: ${[...starts].join(', ')}`);
  assert.ok(rows.some((line) => line.includes('OPERATOR')));
  assert.ok(rows.some((line) => line.includes('MASKSHIFT')));
  assert.ok(rows.some((line) => line.includes('fs_read')));
});

test('the active view is named once per screen', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(132, 34), headless: true, theme,
  });
  await app.bootstrap();
  await app.loadFileTree();

  // Panels used to repeat the tab strip's own label one row beneath it, which
  // stacked two identical chips in the top-left corner of every view.
  for (const view of ['chat', 'arsenal', 'network', 'modshop', 'terminal']) {
    app.view = view;
    app.focus = app.defaultFocus();
    app.screen.invalidate();
    const frame = app.snapshot().map(stripAnsi);
    const title = app.views.find((entry) => entry.id === view).title;
    const hits = frame.filter((line) => line.includes(title)).length;
    assert.equal(hits, 1, `${view}: "${title}" appears on ${hits} rows`);
  }
});

test('a headless render is a still, and a live one moves', () => {
  const frozen = new Theme({ depth: 24, unicode: true, frozen: true });
  assert.equal(frozen.motion.elapsed, 0);
  assert.equal(spin(frozen, 'dots'), spin(frozen, 'dots'));
  // The sweep is a pure function of phase, so a moving band really moves and a
  // frozen one really does not.
  const still = sweepLine(frozen, '-', 20, { base: '#111111', highlight: '#ffffff', phase: 0 });
  const moved = sweepLine(frozen, '-', 20, { base: '#111111', highlight: '#ffffff', phase: 0.5 });
  assert.notEqual(still, moved);
  assert.equal(visibleWidth(still), 20);
  assert.equal(visibleWidth(moved), 20);
});

test('one status vocabulary answers for every subsystem', () => {
  // A failed run, a failed plan step and a failed tool used to be three
  // different reds with three different glyphs.
  for (const value of ['failed', 'error', 'FAILED']) {
    assert.equal(statusOf(value).kind, 'fail');
    assert.equal(statusOf(value).tone, 'danger');
  }
  assert.equal(statusOf('connected').kind, 'done');
  assert.equal(statusOf('in_progress').kind, 'active');
  assert.equal(statusOf('max steps').label, 'STEP LIMIT');
  // Anything a subsystem invents still renders legibly rather than silently.
  assert.equal(statusOf('reticulating').label, 'RETICULATING');
  assert.equal(visibleWidth(stripAnsi(statusGlyph(theme, 'running', { animate: false }))), 1);
});

test('the key decoder handles control, escape, modifier and paste sequences', () => {
  const names = (input) => decode(input).events.map((event) => `${event.ctrl ? 'C-' : ''}${event.alt ? 'M-' : ''}${event.shift ? 'S-' : ''}${event.name}`);
  assert.deepEqual(names('ab'), ['a', 'b']);
  assert.deepEqual(names(String.fromCharCode(11)), ['C-k']);
  assert.deepEqual(names(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`), ['up', 'down', 'right', 'left']);
  assert.deepEqual(names(`${ESC}[1;5A`), ['C-up']);
  assert.deepEqual(names(`${ESC}[3~`), ['delete']);
  assert.deepEqual(names(`${ESC}[Z`), ['S-tab']);
  assert.deepEqual(names(`${ESC}x`), ['M-x']);
  const paste = decode(`${ESC}[200~two words${ESC}[201~`).events[0];
  assert.equal(paste.name, 'paste');
  assert.equal(paste.text, 'two words');
  assert.equal(decode(`ab${ESC}[`).rest, `${ESC}[`);
  assert.ok(matches(decode(String.fromCharCode(11)).events[0], 'ctrl+k'));
  assert.ok(matches(decode(String.fromCharCode(10)).events[0], 'ctrl+j'));
});

test('the key decoder reports DEC 1004 focus in/out without confusing it for SS3 function keys', () => {
  const focusIn = decode(`${ESC}[I`).events[0];
  assert.equal(focusIn.name, 'focus');
  assert.equal(focusIn.focused, true);
  const focusOut = decode(`${ESC}[O`).events[0];
  assert.equal(focusOut.name, 'focus');
  assert.equal(focusOut.focused, false);
  // SS3-encoded F1 (`ESC O P`) on a terminal that sends it that way must
  // never be misread as a focus event just because it also involves 'O'.
  const f1 = decode(`${ESC}OP`).events[0];
  assert.notEqual(f1.name, 'focus');
});

test('text editing moves and deletes whole grapheme clusters', () => {
  const field = new TextField({ value: 'A👨‍👩‍👧‍👦e\u0301界' });
  field.cursor = 1 + '👨‍👩‍👧‍👦'.length;
  field.handle({ name: 'backspace' });
  assert.equal(field.value, 'Ae\u0301界');
  assert.equal(field.cursor, 1);

  const composer = new Composer({ value: 'x🇧🇩y' });
  composer.cursor = 1 + '🇧🇩'.length;
  composer.handle({ name: 'left' });
  assert.equal(composer.cursor, 1);
  composer.handle({ name: 'delete' });
  assert.equal(composer.value, 'xy');
  assert.equal(visibleWidth('👨‍👩‍👧‍👦🇧🇩e\u0301'), 5);
  assert.deepEqual(new Composer({ value: '界界' }).layout(2, 4).rows, ['界', '界']);
  assert.match(stripAnsi(new TextField({ value: '界' }).render(theme, 2).text), /界/);
});

test('the composer edits, wraps and tracks the caret across lines', () => {
  const composer = new Composer();
  composer.insert('first line');
  composer.insert('\n');
  composer.insert('second');
  assert.equal(composer.value, 'first line\nsecond');
  const layout = composer.layout(20, 5);
  assert.deepEqual(layout.rows, ['first line', 'second']);
  assert.deepEqual(layout.caret, { row: 1, column: 6 });
  composer.handle({ name: 'up', printable: false });
  assert.equal(composer.cursor, 6);
  composer.handle({ name: 'backspace', printable: false });
  assert.equal(composer.value, 'firstline\nsecond');
});

test('the text field supports word motions and kill rings', () => {
  const field = new TextField({ value: 'alpha beta gamma' });
  field.cursor = field.value.length;
  assert.equal(field.wordLeft(), 11);
  field.handle({ name: 'w', ctrl: true });
  assert.equal(field.value, 'alpha beta ');
  field.handle({ name: 'u', ctrl: true });
  assert.equal(field.value, '');
});

test('list and viewport scrolling stay inside their bounds', () => {
  const list = new ListView({ items: Array.from({ length: 30 }, (value, index) => ({ id: index, label: `row ${index}` })) });
  list.move(40, 10);
  assert.equal(list.selected, 29);
  assert.ok(list.offset <= 20);
  list.first();
  assert.equal(list.selected, 0);

  const viewport = new Viewport();
  viewport.set(Array.from({ length: 50 }, (value, index) => `line ${index}`));
  assert.equal(viewport.render(10, 20).length, 10);
  viewport.toTop();
  assert.equal(viewport.render(10, 20)[0].trim(), 'line 0');
  viewport.toBottom();
  assert.equal(viewport.render(10, 20)[9].trim(), 'line 49');
});

test('fuzzy matching prefers word boundaries and consecutive hits', () => {
  assert.equal(fuzzy('xyz', 'abc'), null);
  const boundary = fuzzy('mc', 'mcp connect');
  const scattered = fuzzy('mc', 'my caption');
  assert.ok(boundary.score > scattered.score);
});

test('colour degrades cleanly for NO_COLOR and dumb terminals', () => {
  const plain = new Theme({ depth: 0 });
  assert.equal(plain.paint('text', { fg: '#ff2d55', bold: true }), 'text');
  assert.equal(plain.fg('#ff2d55'), '');
  const basic = new Theme({ depth: 4 });
  const sequence = basic.fg('#ff2d55');
  assert.ok(sequence.startsWith(`${ESC}[`));
  assert.ok(/[0-9]+m$/.test(sequence));
  assert.equal(detectDepth({ isTTY: false }), 0);
});

test('colour depth detection trusts tmux/screen as truecolor-capable, not 256-colour', () => {
  const saved = { TERM: process.env.TERM, TMUX: process.env.TMUX, COLORTERM: process.env.COLORTERM, TERM_PROGRAM: process.env.TERM_PROGRAM, FORCE_COLOR: process.env.FORCE_COLOR, MASKSHIFT_COLOR: process.env.MASKSHIFT_COLOR, NO_COLOR: process.env.NO_COLOR };
  const reset = () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    // Plain xterm-256color outside tmux still degrades — nothing here claims truecolor for it.
    process.env.TERM = 'xterm-256color';
    assert.equal(detectDepth({ isTTY: true }), 8);

    // tmux reporting a 256-colour TERM, with $TMUX confirming we're actually inside a session,
    // is trusted as truecolor — that's the whole point of this detection path.
    process.env.TERM = 'tmux-256color';
    process.env.TMUX = '/tmp/tmux-0/default,1234,0';
    assert.equal(detectDepth({ isTTY: true }), 24);

    process.env.TERM = 'screen-256color';
    assert.equal(detectDepth({ isTTY: true }), 24);

    // The same TERM value without $TMUX set (e.g. someone exported it by hand outside tmux)
    // gets no special treatment.
    delete process.env.TMUX;
    process.env.TERM = 'tmux-256color';
    assert.equal(detectDepth({ isTTY: true }), 8);

    // The explicit override still wins over the heuristic either way.
    process.env.TMUX = '/tmp/tmux-0/default,1234,0';
    process.env.MASKSHIFT_COLOR = 'basic';
    assert.equal(detectDepth({ isTTY: true }), 4);
  } finally {
    reset();
  }
});

test('the screen only rewrites rows that changed', () => {
  const output = new FakeTerminal(20, 4);
  const screen = new Screen({ theme, output });
  screen.render(['one', 'two', 'three', 'four']);
  output.written = '';
  screen.render(['one', 'CHANGED', 'three', 'four']);
  assert.match(output.written, /CHANGED/);
  assert.doesNotMatch(output.written, /three/);
  output.written = '';
  screen.render(['one', 'CHANGED', 'three', 'four']);
  assert.equal(output.written, '');
});

test('the screen sends a Kitty image overlay once, skips an unchanged resend, and clears it when it disappears', () => {
  const output = new FakeTerminal(40, 6);
  const screen = new Screen({ theme, output });
  const overlay = { row: 1, column: 2, escape: '\x1b_Gfake-image-bytes\x1b\\', key: 'file.png|kitty', protocol: 'kitty' };

  screen.render(['a', 'b', 'c'], null, overlay);
  assert.match(output.written, /fake-image-bytes/, 'first paint should send the image');

  output.written = '';
  screen.render(['a', 'b', 'c'], null, overlay); // same overlay object/key, nothing else changed
  assert.equal(output.written, '', 'an unchanged overlay should not be re-sent');

  output.written = '';
  screen.render(['a', 'b', 'c'], null, null); // switched to a view with no image
  assert.match(output.written, /\x1b_Ga=d\x1b\\/, 'switching away should explicitly delete the Kitty placement');
  assert.doesNotMatch(output.written, /fake-image-bytes/, 'should not resend the image just to clear it');
});

test('an image overlay is resent after invalidate() even with an unchanged key, since a full repaint can disturb it', () => {
  const output = new FakeTerminal(40, 6);
  const screen = new Screen({ theme, output });
  const overlay = { row: 1, column: 2, escape: '\x1b_Gfake-image-bytes\x1b\\', key: 'file.png|kitty', protocol: 'kitty' };

  screen.render(['a', 'b', 'c'], null, overlay);
  output.written = '';
  screen.invalidate();
  screen.render(['a', 'b', 'c'], null, overlay);
  assert.match(output.written, /fake-image-bytes/, 'a full repaint should resend an image even with the same key');
});

test('scrolling a still-visible Kitty image to a new row resends its placement instead of leaving a ghost behind', () => {
  // Reported live: scrolling the transcript up/down while an inline image
  // (a browser_screenshot result, say) is on screen left the old image
  // frozen at its original terminal position while the text around it kept
  // scrolling. Root cause: the overlay's dedupe key is purely content-based
  // (see image/render.mjs) — it doesn't change just because the same image
  // moved to a different row — so the old "unchanged key, skip the resend"
  // fast path from the test above was *also* skipping a real move. Kitty's
  // placement is a cell-coordinate overlay outside the normal text grid, so
  // redrawing that row's text alone (which does happen every scroll tick)
  // never touches it.
  const output = new FakeTerminal(40, 6);
  const screen = new Screen({ theme, output });
  const overlay = { row: 1, column: 2, escape: '\x1b_Gfake-image-bytes\x1b\\', key: 'file.png|kitty', protocol: 'kitty' };

  screen.render(['a', 'b', 'c'], null, overlay);
  output.written = '';

  // Same key (same image), scrolled up by one row — exactly what a
  // transcript scroll while the image stays partly on screen looks like.
  const scrolled = { ...overlay, row: 0 };
  screen.render(['b', 'c', 'd'], null, scrolled);
  assert.match(output.written, /fake-image-bytes/, 'a moved (but still visible) image must be resent, not silently skipped');
  assert.match(output.written, new RegExp(`\\x1b\\[1;3H.*fake-image-bytes`), 'it should be redrawn at its new row, not the old one');
});

test('leaving the screen clears a Kitty image left on screen instead of stranding it after exit', () => {
  const output = new FakeTerminal(40, 6);
  const screen = new Screen({ theme, output });
  const overlay = { row: 1, column: 2, escape: '\x1b_Gfake-image-bytes\x1b\\', key: 'file.png|kitty', protocol: 'kitty' };
  screen.enter();
  screen.render(['a', 'b', 'c'], null, overlay);
  output.written = '';
  screen.leave();
  assert.match(output.written, /\x1b_Ga=d\x1b\\/);
});

test('the screen strips terminal injection while retaining internal SGR styles', () => {
  const output = new FakeTerminal(80, 2);
  const screen = new Screen({ theme, output });
  const styled = theme.paint('safe', { fg: theme.roles.text });
  screen.render([`${styled}\u001b]52;c;ZXhmaWx0cmF0ZQ==\u0007\u001b[2Jvisible`, 'ok\u202evil']);
  assert.match(output.written, /safe/);
  assert.match(output.written, /visible/);
  assert.doesNotMatch(output.written, /52;c|\u001b\[2J|\u0007|\u202e/);
  assert.match(sanitizeTerminalLine(styled), /\u001b\[[0-9;]+m/);
});

test('small terminals render within their real dimensions', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const output = new FakeTerminal(20, 8);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output, headless: true, theme });
  await app.bootstrap();
  const frame = app.snapshot();
  assert.equal(frame.length, 8);
  for (const line of frame) assert.equal(visibleWidth(line), 20);
  // At 20 columns the full sentence doesn't fit, so the fallback drops down
  // to its shortest form — but it must still surface the one fact that
  // matters: the terminal's actual current size.
  assert.ok(frame.some((line) => stripAnsi(line).includes('20×8')));
});

test('the undersized-terminal fallback keeps the current size legible at any width', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  for (const [columns, rows] of [[39, 20], [20, 8], [8, 3]]) {
    const output = new FakeTerminal(columns, rows);
    const app = new MaskShiftTui(runtime, { workspacePath: project, output, headless: true, theme });
    await app.bootstrap();
    const frame = app.snapshot();
    assert.ok(frame.some((line) => stripAnsi(line).includes(`${columns}×${rows}`)),
      `expected the current size ${columns}x${rows} to survive at ${columns} columns`);
  }
});

test('split() never returns columns that overflow the total, even below every minimum', () => {
  // files.mjs asks for two panes with minimums (34 and 30) that add up to
  // more than a 40-column terminal can give them — the absolute floor the
  // rest of the interface promises to render at.
  assert.deepEqual(
    split(40, [{ weight: 1, min: 34, max: 56 }, { weight: 2, min: 30 }]).reduce((a, b) => a + b, 0),
    40,
  );
  for (const total of [1, 5, 20, 39, 40, 64, 65, 200]) {
    const sizes = split(total, [{ weight: 1, min: 34, max: 56 }, { weight: 2, min: 30 }]);
    assert.deepEqual(sizes.reduce((a, b) => a + b, 0), total, `total=${total}`);
    for (const size of sizes) assert.ok(size >= 0, `negative column width at total=${total}`);
  }
});

test('every view renders exactly to size across the full range of real terminals', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const sizes = [[1, 1], [8, 3], [20, 8], [40, 12], [60, 20], [107, 30], [108, 30], [300, 12], [40, 200]];
  const views = ['chat', 'files', 'arsenal', 'network', 'modshop', 'terminal'];
  for (const [columns, rows] of sizes) {
    const output = new FakeTerminal(columns, rows);
    const app = new MaskShiftTui(runtime, { workspacePath: project, output, headless: true, theme });
    await app.bootstrap();
    for (const view of views) {
      app.view = view;
      app.screen.invalidate();
      const frame = app.snapshot();
      assert.equal(frame.length, rows, `${view} at ${columns}x${rows}: wrong row count`);
      for (const [index, line] of frame.entries()) {
        assert.equal(visibleWidth(stripAnsi(line)), columns, `${view} at ${columns}x${rows}: row ${index} wrong width`);
      }
    }
  }
});

test('async forms and confirmations stay open and report failures inline', async () => {
  const app = { overlay: null, renders: 0, requestRender() { this.renders += 1; }, closeOverlay() { this.overlay = null; } };
  let release;
  const form = new FormOverlay({
    title: 'ASYNC', fields: [{ name: 'value', label: 'value', value: 'x' }],
    onSubmit: () => new Promise((resolve) => { release = resolve; }),
  });
  app.overlay = form;
  const pending = form.submit(app);
  assert.equal(app.overlay, form);
  assert.equal(form.pending, true);
  release();
  await pending;
  assert.equal(app.overlay, null);

  const confirm = new ConfirmOverlay({ title: 'FAIL', message: 'fail?', onConfirm: async () => { throw new Error('restore failed'); } });
  app.overlay = confirm;
  await confirm.confirm(app);
  assert.equal(app.overlay, confirm);
  assert.equal(confirm.pending, false);
  assert.equal(confirm.error, 'restore failed');
});

test('prompts submitted during a run are queued and drained sequentially', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();
  const started = [];
  runtime.engine.startRun = async ({ prompt, sessionId, workspaceId }) => {
    started.push(prompt);
    return { id: `run-${started.length}`, session_id: sessionId, workspace_id: workspaceId, status: 'queued' };
  };
  app.activeRun = { id: 'active', status: 'running' };
  app.runId = 'active';
  app.composer.set('second order');
  await app.submitPrompt();
  assert.deepEqual(started, []);
  assert.equal(app.promptQueue.length, 1);
  assert.ok(app.liveTrail.some((entry) => stripAnsi(entry.render(theme, 80)[0]).includes('QUEUED')));
  app.activeRun = null;
  app.runId = null;
  await app.drainPromptQueue();
  assert.deepEqual(started, ['second order']);
  assert.equal(app.promptQueue.length, 0);
});

test('session switching is workspace-scoped and guarded when work is active', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();
  const other = runtime.store.upsertWorkspace(`${project}-other`, 'other');
  runtime.store.createSession({ workspaceId: other.id, title: 'foreign' });
  app.openSessionPicker();
  assert.ok(app.overlay.items.every((session) => session.label !== 'foreign'));

  app.closeOverlay();
  app.composer.set('draft');
  app.requestNewSession();
  assert.equal(app.overlay?.constructor.name, 'ConfirmOverlay');
});

test('opening the model or session picker starts on the currently active choice, not the top of the list', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();

  app.providers = [
    { id: 'alpha', name: 'Alpha', status: 'online', models: [{ id: 'one' }] },
    { id: 'beta', name: 'Beta', status: 'online', models: [{ id: 'two' }, { id: 'three' }] },
  ];
  app.modelRef = 'beta:three';
  app.openModelPicker();
  assert.equal(app.overlay.list.current.id, 'beta:three', 'the picker should open with the active model already highlighted');

  app.closeOverlay();
  // The session currently in view stays as-is; a newer one is created afterward with an
  // unambiguously later updated_at so it — not the active session — sorts first, regardless
  // of how coarse the clock is between the two creations.
  const current = app.sessionId;
  const later = runtime.store.createSession({ workspaceId: app.workspaceId, title: 'second heist' });
  runtime.store.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() + 60_000).toISOString(), later.id);
  app.openSessionPicker();
  assert.equal(app.overlay.list.current.id, current, 'the picker should open on the session currently in view');
  assert.notEqual(current, app.overlay.items[0]?.id, 'sanity: the active session is not already first in the list');
});

test('a form field can hide itself based on another field, and navigation skips it', () => {
  const submitted = [];
  const form = new FormOverlay({
    title: 'TEST FORM',
    fields: [
      { name: 'mode', label: 'mode', type: 'select', value: 'a', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
      { name: 'onlyA', label: 'only for a', value: '', visible: (values) => values.mode === 'a' },
      { name: 'onlyB', label: 'only for b', value: '', visible: (values) => values.mode === 'b' },
    ],
    onSubmit: (values) => submitted.push(values),
  });

  const rendered = () => form.render({ theme }, { columns: 100, rows: 30 }).lines.map(stripAnsi).join('\n');
  assert.ok(rendered().includes('ONLY FOR A'));
  assert.ok(!rendered().includes('ONLY FOR B'));
  assert.equal(form.visibleFields().length, 2, 'the hidden field should not count toward the visible total');

  // Tab from the mode field should skip the hidden "only for b" field entirely and land
  // on "only for a", not get stuck cycling through an invisible one.
  form.handle(null, { name: 'tab' });
  assert.equal(form.fields[form.index].name, 'onlyA');
  form.handle(null, { name: 'tab' });
  assert.equal(form.fields[form.index].name, 'mode', 'wrapping back around should also skip the hidden field');

  // Switch mode to "b": the visibility should flip live.
  form.fields[0].optionIndex = 1;
  assert.ok(rendered().includes('ONLY FOR B'));
  assert.ok(!rendered().includes('ONLY FOR A'));
});

test('the Add MCP Server dialog shows COMMAND for stdio and URL for streamable HTTP, never both', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();

  app.openMcpDialog();
  let frame = app.snapshot().map(stripAnsi).join('\n');
  assert.ok(frame.includes('COMMAND'), 'stdio (the default transport) should show COMMAND');
  assert.ok(!frame.includes('URL'), 'stdio should not show URL');

  const transportField = app.overlay.fields.find((field) => field.name === 'transport');
  transportField.optionIndex = 1; // streamable http
  app.screen.invalidate();
  frame = app.snapshot().map(stripAnsi).join('\n');
  assert.ok(frame.includes('URL'), 'streamable http should show URL');
  assert.ok(!frame.includes('COMMAND'), 'streamable http should not show COMMAND');
});

test('stale file previews and duplicate operations cannot replace current state', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();
  const resolvers = new Map();
  runtime.toolRegistry.execute = async (name, args) => new Promise((resolve) => resolvers.set(args.path, resolve));
  const first = app.openFile('first.txt', { quiet: true });
  const second = app.openFile('second.txt', { quiet: true });
  resolvers.get('second.txt')('second');
  await second;
  resolvers.get('first.txt')('first');
  await first;
  assert.equal(app.previewPath, 'second.txt');
  assert.deepEqual(app.previewLines, ['second']);

  let release;
  let calls = 0;
  const one = app.withOperation('same', 'Same action', async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
  });
  const duplicate = await app.withOperation('same', 'Same action', async () => { calls += 1; });
  assert.equal(duplicate, null);
  assert.equal(calls, 1);
  release();
  await one;
});

test('the interface paints every view and overlay at the terminal size', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const columns = 132;
  const rows = 36;
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(columns, rows), headless: true, theme,
  });
  await app.bootstrap();
  await app.loadFileTree();
  await app.refreshModShop({ force: false });

  const check = (label, frame) => {
    assert.equal(frame.length, rows, `${label} produced ${frame.length} rows`);
    for (const line of frame) assert.equal(visibleWidth(line), columns, `${label}: "${stripAnsi(line)}"`);
  };

  for (const view of ['chat', 'files', 'arsenal', 'network', 'modshop', 'terminal']) {
    app.view = view;
    app.focus = app.defaultFocus();
    app.screen.invalidate();
    check(view, app.snapshot());
  }

  app.view = 'chat';
  for (const railTab of ['plan', 'telemetry', 'events', 'git']) {
    app.railTab = railTab;
    app.screen.invalidate();
    check(`rail:${railTab}`, app.snapshot());
  }

  const overlays = [
    () => app.openPalette(), () => app.openHelp(), () => app.openSettings(),
    () => app.openWorkspaceDialog(), () => app.openAutomationDialog(), () => app.openMcpDialog(),
    () => app.openPluginDialog(), () => app.openBrowserDialog(), () => app.openSessionPicker(),
    () => app.openModelPicker(), () => app.confirmDeleteSession(),
  ];
  for (const open of overlays) {
    open();
    assert.ok(app.overlay, 'overlay should open');
    app.screen.invalidate();
    check('overlay', app.snapshot());
    app.closeOverlay();
  }

  // A narrow terminal drops the rail rather than overflowing.
  app.screen.output.columns = 72;
  app.screen.output.rows = 20;
  app.screen.invalidate();
  const narrow = app.snapshot();
  assert.equal(narrow.length, 20);
  for (const line of narrow) assert.equal(visibleWidth(line), 72);
});

test('a scrollable TextOverlay (e.g. the help reference) shows a live position marker', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  // Short enough that the real help reference content cannot possibly fit.
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(100, 18), headless: true, theme });
  await app.bootstrap();

  app.openHelp();
  assert.equal(app.overlay?.constructor.name, 'TextOverlay');
  const frame = app.snapshot().map(stripAnsi);
  assert.ok(frame.some((line) => /\d+%/.test(line)), 'expected a scroll percentage in the overlay title rail');

  // Scrolling to the very end should still show a live indicator, not silently drop it.
  app.overlay.offset = 10_000;
  app.screen.invalidate();
  const scrolled = app.snapshot().map(stripAnsi);
  assert.ok(scrolled.some((line) => /100%/.test(line)), 'expected the marker to reach 100% at the bottom');

  // A short overlay that already fits entirely should not show a meaningless "0%".
  const tiny = new TextOverlay({ title: 'TINY', lines: ['one line'] });
  app.overlay = tiny;
  app.screen.invalidate();
  const tinyFrame = app.snapshot().map(stripAnsi);
  assert.ok(!tinyFrame.some((line) => line.includes('%')), 'a fully visible overlay should not show a scroll percentage');
});

test('typing a slash in the composer shows matching command suggestions, and only there', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';
  app.focus = 'composer';

  app.composer.set('/');
  let frame = app.snapshot().map(stripAnsi);
  assert.ok(frame.some((line) => line.includes('COMMANDS')), 'expected a suggestion panel for a bare slash');
  assert.ok(frame.some((line) => line.includes('/model')), 'expected /model among the suggestions');

  app.composer.set('/h');
  frame = app.snapshot().map(stripAnsi);
  assert.ok(frame.some((line) => line.includes('/help')), 'expected /help to match the "h" prefix');

  // Narrowing the prefix should narrow the list to matching commands only.
  app.composer.set('/mo');
  frame = app.snapshot().map(stripAnsi);
  assert.ok(frame.some((line) => line.includes('/model')), 'expected /model to still match the "mo" prefix');
  assert.ok(!frame.some((line) => line.includes('/mcp')), '/mcp should not match the "mo" prefix');

  // A prefix matching nothing shows no suggestion panel at all.
  app.composer.set('/zzz');
  frame = app.snapshot().map(stripAnsi);
  assert.ok(!frame.some((line) => line.includes('COMMANDS')), 'expected no suggestion panel when nothing matches');

  // Ordinary prose (not starting with a bare slash-word) never triggers it.
  app.composer.set('hello /model');
  frame = app.snapshot().map(stripAnsi);
  assert.ok(!frame.some((line) => line.includes('COMMANDS')), 'expected no suggestion panel mid-sentence');

  // Leaving the composer (e.g. focus moves to the transcript) hides it even
  // though the composer text is untouched.
  app.composer.set('/mo');
  app.focus = 'transcript';
  frame = app.snapshot().map(stripAnsi);
  assert.ok(!frame.some((line) => line.includes('COMMANDS')), 'expected the panel to disappear once focus leaves the composer');
});

test('the slash-command suggestion panel stays inside the chat panel and never bleeds into the rail', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  // Wide enough (>=108) that the side rail is shown alongside the chat panel.
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(140, 32), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';
  app.focus = 'composer';
  app.railVisible = true;

  app.composer.set('/');
  const frame = app.snapshot().map(stripAnsi);
  const railStart = app.lastRegion.width;
  const suggestionRow = frame.find((line) => line.includes('┏━ COMMANDS'));
  assert.ok(suggestionRow, 'expected the suggestion panel to be visible');
  // The panel's own right border must land at or before the chat panel's
  // right edge, not spill into the columns the rail owns.
  const rightBorder = suggestionRow.lastIndexOf('┓');
  assert.ok(rightBorder > 0 && rightBorder < railStart, `suggestion panel border at column ${rightBorder} should stay left of the rail at ${railStart}`);
});

test('tab completes to the top slash-command suggestion instead of just leaving the composer', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';
  app.focus = 'composer';

  app.composer.set('/mo');
  app.onKey({ name: 'tab' });
  assert.equal(app.composer.value, '/model ', 'expected tab to complete to the single matching command');
  assert.equal(app.focus, 'composer', 'tab-completing should keep focus in the composer');

  // With no suggestions active, tab keeps its old behaviour of moving focus
  // to the transcript instead of being swallowed.
  app.composer.set('hello there');
  app.onKey({ name: 'tab' });
  assert.equal(app.focus, 'transcript', 'expected tab to fall back to switching focus when nothing is suggested');
});

test('the interface routes keys, slash commands and view switches', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();

  app.onKey({ name: 'h', printable: true });
  app.onKey({ name: 'i', printable: true });
  assert.equal(app.composer.value, 'hi');

  app.onKey({ name: 'k', ctrl: true });
  assert.equal(app.overlay?.constructor.name, 'PaletteOverlay');
  app.onKey({ name: 'escape' });
  assert.equal(app.overlay, null);

  app.onKey({ name: '3', alt: true });
  assert.equal(app.view, 'arsenal');
  app.onKey({ name: '/' });
  assert.equal(app.focus, 'arsenal-filter');
  app.onKey({ name: 'escape' });
  assert.equal(app.focus, 'arsenal');
  app.onKey({ name: '1' });
  assert.equal(app.view, 'chat');

  app.composer.set('/tools fs_');
  await app.submitPrompt();
  assert.equal(app.view, 'arsenal');
  assert.equal(app.arsenalFilter.value, 'fs_');

  app.composer.set('/help');
  await app.submitPrompt();
  assert.equal(app.overlay?.constructor.name, 'TextOverlay');
  app.closeOverlay();

  app.view = 'chat';
  app.railVisible = true;
  app.onKey({ name: 'r', ctrl: true });
  assert.equal(app.railTab, 'telemetry');
  app.onKey({ name: 'b', ctrl: true });
  assert.equal(app.railVisible, false);

  app.toast('unit test', 'success');
  assert.equal(app.toasts.items.length, 1);
});

test('escaping back to chat from another view lands on the transcript, not the composer', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();

  // Land on a non-chat view with a non-typing focus, the state a user is in right
  // before pressing Escape to go back — matching how the number-key navigation itself lands.
  app.onKey({ name: '3', alt: true });
  assert.equal(app.view, 'arsenal');
  assert.equal(app.focus, 'arsenal');

  app.onKey({ name: 'escape' });
  assert.equal(app.view, 'chat');
  // If this were 'composer', the very next digit key below would be typed as a literal
  // character instead of switching views — silently corrupting whatever the user types next.
  assert.equal(app.focus, 'transcript');
  assert.equal(app.composer.value, '');

  app.onKey({ name: '3' });
  assert.equal(app.view, 'arsenal', 'a digit right after Escape should still switch views');
  assert.equal(app.composer.value, '', 'the digit must not leak into the composer');
});

test('ctrl+v is wired to voice capture and transcribes a prompt into the composer', async (t) => {
  const project = await createProject(t);
  const scripts = await tempDir(t, 'maskshift-voice-scripts-');
  const recordScript = path.join(scripts, 'record.mjs');
  const transcribeScript = path.join(scripts, 'transcribe.mjs');
  await fsp.writeFile(recordScript, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'fake-audio');\n");
  await fsp.writeFile(transcribeScript, "process.stdout.write('open the vault');\n");

  const runtime = await runtimeForTest(t, project, {
    voice: {
      recordCommand: `node ${recordScript} {audio}`,
      transcribeCommand: `node ${transcribeScript} {audio}`,
      durationSeconds: 1,
    },
  });
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();

  let dispatched = null;
  const original = app.startVoiceCapture.bind(app);
  app.startVoiceCapture = (...args) => { dispatched = original(...args); return dispatched; };
  app.onKey({ name: 'v', ctrl: true });
  assert.ok(dispatched);
  await dispatched;

  assert.equal(app.composer.value, 'open the vault');
  assert.equal(app.focus, 'composer');
  assert.ok(app.toasts.items.some((toast) => toast.message.includes('transcribed')));

  app.composer.set('draft: ');
  await app.startVoiceCapture();
  assert.equal(app.composer.value, 'draft: open the vault');
});

test('voice capture refuses to record when no speech-to-text command is configured', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { voice: { transcribeCommand: null, recordCommand: null } });
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();

  app.composer.set('untouched');
  await app.startVoiceCapture();
  assert.equal(app.composer.value, 'untouched');
  assert.ok(app.toasts.items.some((toast) => toast.message.includes('No speech-to-text command configured')));
});

test('Keyboard.stop() releases the input handle instead of just pausing it', () => {
  // A paused stream still keeps the underlying handle referenced; only unref() lets the
  // process exit naturally once nothing else needs it. Without this, quitting the TUI left
  // stdin (and stdout, via Screen.leave()) referenced forever, so the process never exited.
  const calls = [];
  const fakeInput = {
    isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode(value) { calls.push(['setRawMode', value]); },
    setEncoding() { calls.push(['setEncoding']); },
    resume() { calls.push(['resume']); },
    pause() { calls.push(['pause']); },
    on() { calls.push(['on']); },
    off() { calls.push(['off']); },
    ref() { calls.push(['ref']); },
    unref() { calls.push(['unref']); },
  };
  const keyboard = new Keyboard({ input: fakeInput });
  keyboard.start();
  assert.ok(calls.some(([name]) => name === 'ref'), 'start() should ref the handle');
  keyboard.stop();
  assert.ok(calls.some(([name]) => name === 'pause'), 'stop() should still pause the stream');
  assert.ok(calls.some(([name]) => name === 'unref'), 'stop() should release the handle, not just pause it');
  // unref must be the last thing done to the handle — refing it again afterward would
  // silently undo the release.
  assert.equal(calls.at(-1)[0], 'unref');
});

test('Screen.leave() releases the output handle instead of just leaving it referenced', () => {
  const calls = [];
  const fakeOutput = {
    columns: 80, rows: 24, isTTY: true,
    write() { calls.push(['write']); return true; },
    on() { calls.push(['on']); },
    off() { calls.push(['off']); },
    ref() { calls.push(['ref']); },
    unref() { calls.push(['unref']); },
  };
  const screen = new Screen({ theme, output: fakeOutput });
  screen.enter();
  assert.ok(calls.some(([name]) => name === 'ref'), 'enter() should ref the handle');
  screen.leave();
  assert.ok(calls.some(([name]) => name === 'unref'), 'leave() should release the handle');
  assert.equal(calls.at(-1)[0], 'unref');
});

test('the decoder turns SGR and legacy mouse reports into positioned events', () => {
  const only = (input) => decode(input).events;

  const [press] = only(`${ESC}[<0;15;2M`);
  assert.equal(press.name, 'mouse');
  assert.equal(press.type, 'press');
  assert.equal(press.button, 'left');
  // Reports are 1-based; the renderer addresses cells from zero.
  assert.equal(press.row, 1);
  assert.equal(press.column, 14);

  assert.equal(only(`${ESC}[<0;15;2m`)[0].type, 'release');
  assert.equal(only(`${ESC}[<2;15;2M`)[0].button, 'right');
  assert.equal(only(`${ESC}[<32;15;2M`)[0].type, 'drag');
  assert.equal(only(`${ESC}[<35;15;2M`)[0].type, 'move');
  assert.equal(only(`${ESC}[<64;15;2M`)[0].button, 'wheelup');
  assert.equal(only(`${ESC}[<65;15;2M`)[0].button, 'wheeldown');
  assert.equal(only(`${ESC}[<16;15;2M`)[0].ctrl, true);
  assert.equal(only(`${ESC}[<4;15;2M`)[0].shift, true);

  // Legacy X10: ESC [ M then three bytes biased by 32.
  const legacy = only(`${ESC}[M${String.fromCharCode(32, 40, 34)}`)[0];
  assert.equal(legacy.type, 'press');
  assert.equal(legacy.column, 7);
  assert.equal(legacy.row, 1);

  // A mouse report must not be mistaken for keystrokes, and must not stall the
  // buffer the way an unrecognised CSI sequence would.
  assert.deepEqual(only(`${ESC}[<0;15;2M`).filter((event) => event.name !== 'mouse'), []);
  assert.equal(decode(`${ESC}[<0;15;2M`).rest, '');
  assert.equal(decode(`${ESC}[<0;15`).rest, `${ESC}[<0;15`);
  assert.deepEqual(only(`${ESC}[<0;15;2Mx`).map((event) => event.name), ['mouse', 'x']);
  assert.equal(only(`${ESC}[A`)[0].name, 'up');
});

test('hit testing resolves the topmost zone and honours layers', () => {
  const regions = new Regions();
  regions.add({ row: 2, column: 2, width: 10, height: 3, id: 'under' });
  regions.add({ row: 3, column: 3, width: 2, height: 1, id: 'over', layer: 100 });

  assert.equal(regions.hit(2, 2)?.id, 'under');
  assert.equal(regions.hit(3, 3)?.id, 'over');
  assert.equal(regions.hit(1, 2), null);
  assert.equal(regions.hit(2, 12), null);
  assert.equal(regions.covered(3, 3, 100), true);
  assert.equal(regions.covered(2, 2, 100), false);

  // A zone is only a candidate if it carries the handler being looked for.
  regions.add({ row: 8, column: 0, width: 4, height: 1, id: 'wheelable', onWheel: () => {} });
  assert.equal(regions.hit(8, 1, { need: 'onPress' }), null);
  assert.equal(regions.hit(8, 1, { need: 'onWheel' })?.id, 'wheelable');

  regions.clear();
  assert.equal(regions.hit(3, 3), null);
});

test('the mouse mode resolves from the environment before stored preferences', () => {
  const previous = process.env.MASKSHIFT_MOUSE;
  delete process.env.MASKSHIFT_MOUSE;
  try {
    assert.equal(resolveMouseMode({}), 'click');
    assert.equal(resolveMouseMode({ mouse: 'hover' }), 'hover');
    assert.equal(resolveMouseMode({ mouse: false }), 'off');
    assert.equal(resolveMouseMode({ mouse: 'nonsense' }), 'click');
    process.env.MASKSHIFT_MOUSE = 'off';
    assert.equal(resolveMouseMode({ mouse: 'hover' }), 'off');
    process.env.MASKSHIFT_MOUSE = 'hover';
    assert.equal(resolveMouseMode({}), 'hover');
  } finally {
    if (previous === undefined) delete process.env.MASKSHIFT_MOUSE;
    else process.env.MASKSHIFT_MOUSE = previous;
  }
});

test('the interface routes clicks, wheels and drags to what it painted', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(132, 38), headless: true, theme,
  });
  await app.bootstrap();
  await app.loadFileTree();

  // Zones describe the frame the user was looking at, so paint before clicking.
  const at = (row, column, mask = 0, final = 'M') => {
    app.snapshot();
    app.onMouse(decode(`${ESC}[<${mask};${column + 1};${row + 1}${final}`).events[0]);
  };

  // The tab strip: " 01 HEIST " opens at column 1, so 02 FILES starts at 12.
  app.view = 'chat';
  at(1, 14);
  assert.equal(app.view, 'files');
  at(1, 3);
  assert.equal(app.view, 'chat');

  // The two panes of the heist view take focus from a click.
  app.focus = 'composer';
  at(4, 20);
  assert.equal(app.focus, 'transcript');
  at(31, 20);
  assert.equal(app.focus, 'composer');

  // Rail sections are tabs now, not just a ctrl+r cycle.
  at(3, 108);
  assert.equal(app.railTab, 'telemetry');
  at(3, 100);
  assert.equal(app.railTab, 'plan');

  // The wheel scrolls the pane under the pointer without moving focus.
  app.view = 'chat';
  app.focus = 'composer';
  app.messages = Array.from({ length: 200 }, (value, index) => ({ role: 'user', content: `line ${index}`, created_at: Date.now() }));
  app.transcript.toBottom();
  app.snapshot();
  const bottom = app.transcript.offset;
  at(10, 40, 64);
  assert.ok(app.transcript.offset < bottom, 'wheel should scroll the transcript up');
  assert.equal(app.focus, 'composer');

  // Dragging the scrollbar track jumps to that position. With the rail shown
  // the stage is 98 columns wide, so its track sits at column 97.
  at(4, 97);
  const top = app.transcript.offset;
  app.onMouse(decode(`${ESC}[<32;98;30M`).events[0]);
  assert.ok(app.transcript.offset > top, 'dragging the track should scroll down');
  app.onMouse(decode(`${ESC}[<0;98;30m`).events[0]);
  assert.equal(app.dragging, null, 'release should end the drag');

  // A click outside an overlay dismisses it; one inside does not.
  app.openPalette();
  app.snapshot();
  // Row 8 is the palette's own search-input row (above where its list of
  // actions starts) — inside the overlay's surface, but not one of its rows,
  // so clicking it can never itself trigger an action and close the palette.
  at(8, 30);
  assert.ok(app.overlay, 'a click on the overlay should not dismiss it');
  at(0, 0);
  assert.equal(app.overlay, null);

  // Turning the mouse off makes every report inert.
  app.screen.setMouse('off');
  app.view = 'chat';
  at(1, 14);
  assert.equal(app.view, 'chat');
  app.screen.setMouse('click');
});

test('the heist view keeps the composer inside one unclipped frame', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';

  // A composer that grew past the pane used to push its own bottom rule off
  // the end of the frame.
  for (const draft of ['', 'one line', Array.from({ length: 40 }, (value, i) => `line ${i}`).join('\n')]) {
    app.composer.set(draft);
    app.screen.invalidate();
    const frame = app.snapshot();
    // Trim the header/tab strip above and status/hint rail below — a blank
    // breathing-room row can sit on either side of the panel now, so an
    // assumed fixed offset isn't reliable, but the panel's own open/close
    // border rows still are.
    const stripped = frame.map(stripAnsi);
    const openIndex = stripped.findIndex((line) => line.trimStart().startsWith('┏'));
    const closeIndex = stripped.findIndex((line) => line.trimStart().startsWith('┗'));
    assert.ok(openIndex >= 0 && closeIndex > openIndex, `frame should open and close, got open=${openIndex} close=${closeIndex}`);
    const body = stripped.slice(openIndex, closeIndex + 1);
    assert.ok(body.at(-1).trimStart().startsWith('┗'), `frame should close, got "${body.at(-1)}"`);
    assert.equal(body.filter((line) => line.trimStart().startsWith('┏')).length, 1, 'exactly one frame opens');
    for (const line of frame) assert.equal(visibleWidth(line), 120);
  }
});

test('a toast never overlaps the composer\'s own border or input row', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(90, 26), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';
  app.composer.set('');
  app.screen.invalidate();
  app.snapshot(); // populate app.lastRegion/app.chatPanes for this frame size

  // A two-line toast is tall enough to have previously reached past the seam and into the
  // composer row when anchored a fixed distance from the bottom of the screen.
  app.toast('Checkpoint git-ref checkpoint_deadbeef', 'info');
  app.screen.invalidate();
  const frame = app.snapshot().map(stripAnsi);

  const seamIndex = frame.findIndex((line) => line.includes('COMPOSER'));
  assert.ok(seamIndex >= 0, 'composer seam row should be present');
  assert.ok(seamIndex >= 1, 'sanity: the seam is not the very first row');
  assert.ok(frame[seamIndex].includes('━━ COMPOSER'), 'the seam divider must render intact, not be cut by a toast');

  // One blank row of padding sits between the seam and the draft itself —
  // see chat.mjs's render(). Not a second one below the draft too: the
  // panel's own border already closes the box there.
  const blankRow = frame[seamIndex + 1];
  assert.ok(blankRow.trimEnd().endsWith('┃'), `composer's top padding row should keep its right border, got "${blankRow}"`);

  const inputRow = frame[seamIndex + 2];
  assert.ok(inputRow.trimEnd().endsWith('┃'), `composer input row should keep its right border, got "${inputRow}"`);
  assert.ok(inputRow.includes('❯'), 'composer prompt marker should still be visible');

  const bottomBorder = frame[seamIndex + 3];
  assert.ok(bottomBorder.trimEnd().endsWith('┛'), `composer bottom border should be intact, got "${bottomBorder}"`);
});

test('a streaming reply grows word by word in the transcript, then settles into the finished message', async (t) => {
  const text = 'Hello there, this streams in gradually.';
  const words = text.split(' ');
  const server = await jsonServer(t, async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      respondJson(response, 200, { data: [{ id: 'stream-coder' }] });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const [index, word] of words.entries()) {
      const delta = index === 0 ? word : ` ${word}`;
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = {
      response: {
        id: 'resp_stream', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      },
    };
    response.write(`event: response.completed\ndata: ${JSON.stringify(final)}\n\n`);
    response.end();
  });

  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture-stream:stream-coder',
    providers: [{
      id: 'fixture-stream', name: 'Streaming fixture', type: 'openai-responses',
      baseUrl: server.url, apiKey: 'test-key', enabled: true, autoDiscover: false,
      models: [{ id: 'stream-coder' }], timeoutMs: 15_000,
    }],
  });
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();
  // Headless instances skip start()'s terminal takeover entirely, including the eventBus
  // subscription it normally wires up — so a headless test that wants live run events has to
  // hook the bus itself, same as the CLI's headless run path does independently of this class.
  const unsubscribe = runtime.eventBus.subscribe((event) => app.onEvent(event));
  t.after(unsubscribe);
  app.view = 'chat';
  app.modelRef = 'fixture-stream:stream-coder';

  app.composer.set('Say hello gradually');
  await app.submitPrompt();

  // Partway through, the transcript should show a growing prefix of the final text — not
  // nothing (still "thinking"), and not the whole thing (not yet a finished message).
  await waitFor(() => {
    const frame = app.snapshot().map(stripAnsi);
    const hasFirstWord = frame.some((line) => line.includes(words[0]));
    const hasFullText = frame.some((line) => line.includes(text));
    return hasFirstWord && !hasFullText ? true : null;
  }, { timeoutMs: 3000, message: 'partial streamed text to appear before the reply finishes' });

  const midFrame = app.snapshot().map(stripAnsi);
  assert.ok(midFrame.some((line) => line.includes('MASKSHIFT')), 'expected the speaker row to appear as soon as text starts streaming');
  assert.ok(app.streamingText && text.startsWith(app.streamingText), 'app.streamingText should be a prefix of the final text while streaming');
  // A spinner "thinking" row would be redundant once real text is already visible.
  assert.ok(!midFrame.some((line) => /Thinking…|THINKING/i.test(line)), 'the thinking spinner should stand down once text is streaming');

  await waitFor(() => (app.busy ? null : true), { timeoutMs: 5000, message: 'run to finish' });

  assert.equal(app.streamingText, null, 'streamingText should clear once the turn is persisted');
  const finalFrame = app.snapshot().map(stripAnsi);
  assert.ok(finalFrame.some((line) => line.includes(text)), 'expected the full final text in the settled transcript');
  const persisted = app.messages.filter((message) => message.role === 'assistant');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].content, text);
});

test('markdown tables line their separators up with their columns', () => {
  const source = '| # | File | Size |\n|---|------|------|\n| 1 | a.png | 436K |\n| 11 | b.png | 216K |\n';
  const lines = renderMarkdown(theme, source, 60).map(stripAnsi).filter((line) => line.trim());
  const [header, divider, ...rows] = lines;

  const pipes = (line) => [...line].flatMap((character, index) => (character === '│' ? [index] : []));
  const crosses = (line) => [...line].flatMap((character, index) => (character === '┼' ? [index] : []));

  assert.deepEqual(crosses(divider), pipes(header), 'crossings must sit under the pipes');
  for (const row of rows) assert.deepEqual(pipes(row), pipes(header), `"${row}" drifted`);
  for (const line of lines) assert.ok(visibleWidth(line) <= 60);
});
