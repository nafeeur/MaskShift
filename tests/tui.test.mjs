import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { decode, matches } from '../src/tui/input.mjs';
import { panel } from '../src/tui/box.mjs';
import { sweepLine, spin } from '../src/tui/motion.mjs';
import { statusGlyph, statusOf } from '../src/tui/status.mjs';
import { SPACE } from '../src/tui/tokens.mjs';
import { transcriptLines } from '../src/tui/views/chat.mjs';
import { renderMarkdown } from '../src/tui/markdown.mjs';
import { Screen } from '../src/tui/screen.mjs';
import { Theme, detectDepth } from '../src/tui/theme.mjs';
import { fit, sliceAnsi, stripAnsi, truncate, visibleWidth, wrap } from '../src/tui/text.mjs';
import { Composer, ListView, TextField, Viewport, fuzzy } from '../src/tui/widgets.mjs';
import { Regions } from '../src/tui/regions.mjs';
import { resolveMouseMode } from '../src/tui/app.mjs';
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

test('a streaming turn renders in place of the spinner without breaking the frame', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(120, 32), headless: true, theme,
  });
  await app.bootstrap();
  app.view = 'chat';
  app.activeRun = { id: 'run_fixture', status: 'running' };

  // No tokens yet: the spinner label still holds the row.
  assert.ok(app.snapshot().map(stripAnsi).some((line) => line.includes('Thinking')));

  app.onRunEvent({ type: 'run.assistant-delta', sessionId: app.sessionId, payload: { text: 'Reading the renderer ' } });
  app.onRunEvent({ type: 'run.assistant-delta', sessionId: app.sessionId, payload: { text: 'and diffing the frame. '.repeat(40) } });
  app.screen.invalidate();

  const frame = app.snapshot();
  const plain = frame.map(stripAnsi);
  assert.ok(plain.some((line) => line.includes('Reading the renderer')), 'streamed text should be on screen');
  assert.ok(!plain.some((line) => line.includes('Thinking')), 'the spinner label gives way to the text');
  // The renderer's contract: every row is exactly the terminal width.
  for (const line of frame) assert.equal(visibleWidth(line), 120);

  // A completed turn hands the content to the transcript and clears the live view.
  app.onRunEvent({ type: 'run.assistant', sessionId: app.sessionId, payload: { content: 'done', toolCalls: [], streamed: true } });
  assert.equal(app.streamingText, '');
});

test('deltas from a subagent never reach the parent transcript', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, {
    workspacePath: project, output: new FakeTerminal(100, 24), headless: true, theme,
  });
  await app.bootstrap();
  app.activeRun = { id: 'run_fixture', status: 'running' };
  app.onRunEvent({ type: 'run.assistant-delta', sessionId: 'ses_some_subagent', payload: { text: 'subagent chatter' } });
  assert.equal(app.streamingText, '');
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
  at(34, 20);
  assert.equal(app.focus, 'composer');

  // Rail sections are tabs now, not just a ctrl+r cycle.
  at(2, 108);
  assert.equal(app.railTab, 'telemetry');
  at(2, 100);
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
  // the stage is 99 columns wide, so its track sits at column 97.
  at(3, 97);
  const top = app.transcript.offset;
  app.onMouse(decode(`${ESC}[<32;98;30M`).events[0]);
  assert.ok(app.transcript.offset > top, 'dragging the track should scroll down');
  app.onMouse(decode(`${ESC}[<0;98;30m`).events[0]);
  assert.equal(app.dragging, null, 'release should end the drag');

  // A click outside an overlay dismisses it; one inside does not.
  app.openPalette();
  app.snapshot();
  at(18, 66);
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
    const body = frame.slice(2, frame.length - 2).map(stripAnsi);
    assert.ok(body.at(-1).startsWith('┗'), `frame should close, got "${body.at(-1)}"`);
    assert.equal(body.filter((line) => line.startsWith('┏')).length, 1, 'exactly one frame opens');
    for (const line of frame) assert.equal(visibleWidth(line), 120);
  }
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
