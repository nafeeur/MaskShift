// 07 BROWSER — a live, clickable view of a running browser tab: the same
// CDP connection browser_screenshot/click/type already drive, polled on an
// interval and rendered through the same image pipeline as the Files
// preview and chat screenshots (see image/render.mjs).
//
// Two focus states, like a real remote-desktop view: normal (arrow keys/
// scroll move the terminal's own selection the way every other pane does;
// clicking the page focuses it) and "typing" (entered with `i`, left with
// escape — every keystroke goes to the page instead of MaskShift itself,
// the same shape terminal.mjs already uses for "this pane owns the
// keyboard now").

import { glyphs, panel } from '../box.mjs';
import { buildLiveFramePreview } from '../image/render.mjs';
import { LAYER } from '../regions.mjs';
import { fit, truncate } from '../text.mjs';
import { hexToRgb } from '../theme.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter } from '../type.mjs';

export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  const inner = width - 4; // panel frame + padding, both sides
  const bodyHeight = Math.max(1, height - 2 - 1); // frame rows + the status row

  const body = [];
  let imageOverlay = null;

  // The next poll (app.mjs's pollBrowserFrame) reads this to size its
  // screenshot request — see the half-block resolution cap there.
  app.browserRenderBudget = { cols: Math.max(1, inner), rows: Math.max(1, bodyHeight) };

  if (!app.browserTarget) {
    body.push(gutter(theme) + theme.paint('No browser tab selected.', { fg: theme.roles.muted, italic: true }));
    body.push(gutter(theme) + theme.paint('Press ↵ to pick one, or launch a browser from the mod shop first.', { fg: theme.roles.muted }));
  } else if (app.browserFrame?.error) {
    body.push(gutter(theme) + theme.paint(app.browserFrame.error, { fg: theme.roles.danger }));
  } else if (!app.browserFrame) {
    body.push(gutter(theme) + theme.paint('Connecting…', { fg: theme.roles.muted, italic: true }));
  } else {
    const built = buildLiveFramePreview(theme, app.browserFrame.buffer, app.browserFrameId, {
      maxCols: inner, maxRows: bodyHeight, hexToRgb,
    });
    if (built.error) {
      body.push(gutter(theme) + theme.paint(built.error, { fg: theme.roles.danger }));
    } else {
      body.push(...built.lines);
      app.browserFrame.cols = built.cols;
      app.browserFrame.rows = built.rows;
      if (built.overlay) {
        imageOverlay = {
          row: region.row + 2, // panel top rail (1) + this view's own status row (1)
          column: region.column + SPACE.frame + SPACE.pad,
          escape: built.overlay.escape,
          key: built.overlay.key,
          protocol: built.overlay.protocol,
        };
      }
    }
  }

  const statusLeft = app.browserTarget
    ? truncate(app.browserFrame?.title || `${app.browserTarget.instanceId} · ${app.browserTarget.tabId}`, Math.max(10, inner - 24))
    : 'no target';
  const mode = app.browserTyping
    ? theme.paint(' TYPING — esc to stop ', { fg: theme.roles.onPrimary, bg: theme.roles.accent, bold: true })
    : theme.paint(' i to type · click to focus ', { fg: theme.roles.muted });
  const status = fit(`${gutter(theme)}${theme.paint(statusLeft, { fg: theme.roles.label })}`, Math.max(0, inner - 30)) + mode;

  const framed = panel({
    theme, width, height, title: app.browserFrame?.title || app.browserFrame?.url || 'BROWSER',
    note: app.browserPollBusy ? 'LIVE' : '',
    busy: false,
    focused: app.focus === 'browser',
    body: [status, ...body],
  });

  registerRegions(app, region, { width, height, bodyHeight, inner });

  return { lines: framed, cursor: null, imageOverlay };
}

function registerRegions(app, region, { bodyHeight, inner }) {
  if (!app.regions || !app.browserTarget) return;
  // One region over the whole image area — a click or wheel anywhere in it
  // maps its cell offset into the page's own CSS-pixel coordinate space
  // (see app.mjs's browserPointToPage) rather than being routed like a
  // normal MaskShift list/button.
  app.regions.add({
    row: region.row + 2, column: region.column + SPACE.frame + SPACE.pad,
    width: Math.max(0, inner), height: Math.max(0, bodyHeight),
    id: 'browser:surface', layer: LAYER.body,
    onPress: (target, event, zone) => target.browserClick(event, zone),
    onWheel: (target, event, zone) => target.browserScroll(event, zone),
  });
}

export function handle(app, event) {
  // Escape out of typing mode is handled a level up, in app.mjs's
  // globalKey() — it runs before any view's own handle() ever sees the
  // key, so trying to catch it here would be dead code.
  if (app.browserTyping) {
    void app.forwardBrowserKey(event);
    return true;
  }
  if (event.name === 'i' && app.browserTarget) { app.browserTyping = true; return true; }
  if (event.name === 'enter') { app.openBrowserTargetPicker(); return true; }
  if (event.name === 'r' && !event.ctrl) { void app.pollBrowserFrame({ force: true }); return true; }
  return false;
}

export const hints = (app) => app.browserTyping
  ? [['esc', 'stop typing into the page']]
  : [['↵', 'pick a tab'], ['i', 'type into the page'], ['click', 'click the page'], ['scroll', 'scroll the page'], ['r', 'refresh now']];

export const meta = { id: 'browser', index: '07', title: 'BROWSER', shortcut: '7' };
