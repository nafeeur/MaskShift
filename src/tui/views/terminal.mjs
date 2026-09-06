// 06 TERMINAL — the host shell, with your full account permissions.

import { glyphs, panel } from '../box.mjs';
import { gutter } from '../type.mjs';

export function render(app, region) {
  const { theme } = app;
  const mark = glyphs(theme);
  const { width, height } = region;
  const inner = width - 4;

  app.terminalView.set(app.terminalLines);
  const body = app.terminalView.render(height - 3, inner, { anchor: 'bottom' });
  const prompt = app.terminalField.render(theme, inner - 2, { focused: app.focus === 'terminal' });

  const lines = [
    ...body,
    // The prompt sits in the same gutter the transcript uses, so a command and
    // its output share the left edge of every other pane in the product.
    gutter(theme, app.terminalBusy ? app.spinner.frame(theme) : mark.caret, {
      tone: app.terminalBusy ? theme.roles.accent : theme.roles.primary,
    }) + prompt.text,
  ];

  // The tab strip names this view; the rail carries where the shell actually is.
  const framed = panel({
    theme, width, height, title: app.terminalCwd || 'HOST SHELL',
    note: app.terminalBusy ? 'RUNNING' : '',
    busy: app.terminalBusy,
    focused: app.focus === 'terminal', body: lines,
  });

  return {
    lines: framed,
    cursor: app.focus === 'terminal'
      ? { row: region.row + height - 2, column: region.column + 2 + 2 + prompt.cursorColumn }
      : null,
  };
}

export function handle(app, event) {
  if (event.name === 'enter') { void app.runTerminalCommand(app.terminalField.value); return true; }
  if (event.ctrl && event.name === 'l') { app.terminalLines = []; return true; }
  if (event.name === 'pageup' || event.name === 'pagedown') {
    return app.terminalView.handle(event, app.bodyRegion.height - 3);
  }
  return app.terminalField.handle(event);
}

export const hints = () => [
  ['↵', 'run'], ['↑↓', 'history'], ['^L', 'clear'], ['pgup/pgdn', 'scroll'], ['esc', 'menu'],
];

export const meta = { id: 'terminal', index: '06', title: 'TERMINAL', shortcut: '6' };
