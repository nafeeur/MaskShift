// 06 TERMINAL — the host shell, with your full account permissions.

import { glyphs, panel } from '../box.mjs';

export function render(app, region) {
  const { theme } = app;
  const mark = glyphs(theme);
  const { width, height } = region;
  const inner = width - 4;

  app.terminalView.set(app.terminalLines);
  const body = app.terminalView.render(height - 3, inner, { anchor: 'bottom' });
  const prompt = app.terminalField.render(theme, inner - 3, { focused: app.focus === 'terminal' });

  const lines = [
    ...body,
    theme.paint(app.terminalBusy ? `${app.spinner.frame(theme)}  ` : `${mark.caret}  `, {
      fg: app.terminalBusy ? theme.palette.gold : theme.palette.crimson, bold: true,
    }) + prompt.text,
  ];

  const framed = panel({
    theme, width, height, title: 'HOST TERMINAL', index: '06',
    stamp: app.terminalCwd, focused: app.focus === 'terminal', body: lines,
  });

  return {
    lines: framed,
    cursor: app.focus === 'terminal'
      ? { row: region.row + height - 2, column: region.column + 5 + prompt.cursorColumn }
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
