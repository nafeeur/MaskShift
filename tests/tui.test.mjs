import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { decode, matches } from '../src/tui/input.mjs';
import { panel } from '../src/tui/box.mjs';
import { renderMarkdown } from '../src/tui/markdown.mjs';
import { Screen } from '../src/tui/screen.mjs';
import { Theme, detectDepth } from '../src/tui/theme.mjs';
import { fit, sliceAnsi, stripAnsi, truncate, visibleWidth, wrap } from '../src/tui/text.mjs';
import { Composer, ListView, TextField, Viewport, fuzzy } from '../src/tui/widgets.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

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
    const lines = panel({ theme, width: 40, height: 6, title: 'ARSENAL', index: '03', stamp: '12', body: ['a', 'b'], focused });
    assert.equal(lines.length, 6);
    for (const line of lines) assert.equal(visibleWidth(line), 40);
  }
});

test('markdown renders headings, lists, code and diffs inside the column', () => {
  const lines = renderMarkdown(theme, '# Title\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\n```diff\n+ added\n- removed\n```\n', 40);
  assert.ok(lines.length > 6);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, `"${stripAnsi(line)}" overflowed`);
  assert.ok(lines.some((line) => stripAnsi(line).includes('TITLE')));
  assert.ok(lines.some((line) => stripAnsi(line).includes('const a = 1;')));
  assert.ok(lines.some((line) => stripAnsi(line).includes('+ added')));
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
