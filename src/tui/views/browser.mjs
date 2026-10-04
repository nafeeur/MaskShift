// 05 BROWSER — a live, clickable view of a running browser tab: the same
// CDP connection browser_screenshot/click/type already drive, polled on an
// interval and rendered through the same image pipeline as the Files
// preview and chat screenshots (see image/render.mjs).
//
// Two focus states, like a real remote-desktop view: normal (arrow keys/
// scroll move the terminal's own selection the way every other pane does;
// clicking the page focuses it) and "typing" (entered with `i`, left with
// escape — every keystroke goes to the page instead of MaskShift itself,
// the same shape runtime.mjs's shell tab already uses for "this pane owns
// the keyboard now").
//
// The instance strip below used to be its own catalogue entry (the old plugins view's
// BROWSER tab, now 04 RUNTIME's) — picking which live instance to watch
// belongs here, next to the page it drives, rather than in a separate list.

import { glyphs, panel } from '../box.mjs';
import { buildLiveFramePreview } from '../image/render.mjs';
import { LAYER } from '../regions.mjs';
import { fit, truncate } from '../text.mjs';
import { hexToRgb } from '../theme.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter } from '../type.mjs';
import { tabRow } from './catalog.mjs';

export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  const inner = width - 4; // panel frame + padding, both sides
  const showStrip = app.browsers.length > 1;
  const bodyHeight = Math.max(1, height - 2 - 1 - (showStrip ? 1 : 0) - (app.handoff ? 1 : 0)); // frame rows + status (+ instance strip)

  const body = [];
  let imageOverlay = null;

  // The next poll (app.mjs's pollBrowserFrame) reads this to size its
  // screenshot request — see the half-block resolution cap there.
  app.browserRenderBudget = { cols: Math.max(1, inner), rows: Math.max(1, bodyHeight) };

  if (!app.browserTarget) {
    body.push(gutter(theme) + theme.paint('No browser tab selected.', { fg: theme.roles.muted, italic: true }));
    body.push(gutter(theme) + theme.paint('Press ↵ to pick one, or launch a browser from 04 RUNTIME first.', { fg: theme.roles.muted }));
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
          row: region.row + 2 + (showStrip ? 1 : 0) + (app.handoff ? 1 : 0), // panel top rail (1) + instance strip + this view's own status row (1)
          column: region.column + SPACE.frame + SPACE.pad,
          escape: built.overlay.escape,
          key: built.overlay.key,
          protocol: built.overlay.protocol,
        };
      }
    }
  }

  // The panel's own top rail already shows the page title (see the `panel({
  // title })` call below) — repeating it here too just put the same text on
  // screen twice, once upper-cased by the title chip and once not. The URL
  // is the thing that row can actually add.
  const statusLeft = app.browserTarget
    ? truncate(app.browserFrame?.url || `${app.browserTarget.instanceId} · ${app.browserTarget.tabId}`, Math.max(10, inner - 24))
    : 'no target';
  const mode = app.browserTyping
    ? theme.paint(' Typing — esc to stop ', { fg: theme.roles.onPrimary, bg: theme.roles.accent, bold: true })
    : theme.paint(' i to type · click to focus ', { fg: theme.roles.muted });
  const status = fit(`${gutter(theme)}${theme.paint(statusLeft, { fg: theme.roles.label })}`, Math.max(0, inner - 30)) + mode;

  const banner = app.handoff
    ? fit(gutter(theme) + theme.paint(' Your turn ', { fg: theme.roles.onPrimary, bg: theme.roles.accent, bold: true })
      + theme.paint(` ${truncate(app.handoff.message, Math.max(10, inner - 40))}  `, { fg: theme.roles.text })
      + theme.paint('ctrl+e done · ctrl+x cancel', { fg: theme.roles.muted }), inner)
    : null;

  const strip = showStrip
    ? tabRow(app, app.browsers.map((instance) => ({ id: instance.id, label: truncate(instance.profile || instance.id, 18) })), app.browserTarget?.instanceId, inner, {
      origin: { row: region.row + 1, column: region.column + SPACE.frame },
      onPick: (target, id) => void target.openBrowserView(id),
    })
    : '';

  const framed = panel({
    theme, width, height, title: app.browserFrame?.title || app.browserFrame?.url || 'Browser',
    note: app.browserPollBusy ? 'Live' : '',
    busy: false,
    focused: app.focus === 'browser',
    body: [...(showStrip ? [strip] : []), ...(banner ? [banner] : []), status, ...body],
  });

  registerRegions(app, region, { width, height, bodyHeight, inner, showStrip });

  return { lines: framed, cursor: null, imageOverlay };
}

function registerRegions(app, region, { bodyHeight, inner, showStrip }) {
  if (!app.regions || !app.browserTarget) return;
  // One region over the whole image area — a click or wheel anywhere in it
  // maps its cell offset into the page's own CSS-pixel coordinate space
  // (see app.mjs's browserPointToPage) rather than being routed like a
  // normal MaskShift list/button.
  app.regions.add({
    row: region.row + 2 + (showStrip ? 1 : 0) + (app.handoff ? 1 : 0), column: region.column + SPACE.frame + SPACE.pad,
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

export const hints = (app) => app.handoff
  ? [['i', 'type into the page'], ['click', 'click the page'], ['ctrl+e', 'done — hand back'], ['ctrl+x', 'cancel']]
  : app.browserTyping
  ? [['esc', 'stop typing into the page']]
  : [['↵', 'pick a tab'], ['i', 'type into the page'], ['click', 'click the page'], ['scroll', 'scroll the page'], ['r', 'refresh now']];

export const meta = { id: 'browser', index: '5', title: 'Browser', shortcut: '5' };

// -------------------------------------------------------------------- rail
//
// A console/network tail for the current page — the same CDP buffers the
// browser_console/browser_network tools already read (browserManager's
// console()/network()), fetched alongside the frame itself (see app.mjs's
// pollBrowserFrame) since render() has to stay synchronous.
function consoleLine(theme, event) {
  const p = event.params || {};
  if (event.method === 'Runtime.consoleAPICalled') {
    const text = (p.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
    return { tone: p.type === 'error' ? theme.roles.danger : p.type === 'warning' ? theme.roles.warning : theme.roles.text, text: `[${p.type}] ${text}` };
  }
  if (event.method === 'Runtime.exceptionThrown') {
    return { tone: theme.roles.danger, text: `[exception] ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''}` };
  }
  if (event.method === 'Log.entryAdded') {
    return { tone: p.entry?.level === 'error' ? theme.roles.danger : theme.roles.text, text: `[${p.entry?.level}] ${p.entry?.text}` };
  }
  return { tone: theme.roles.muted, text: event.method };
}

function networkLine(theme, event) {
  const p = event.params || {};
  if (event.method === 'Network.requestWillBeSent') return { tone: theme.roles.tool, text: `→ ${p.request?.method} ${p.request?.url}` };
  if (event.method === 'Network.responseReceived') {
    const ok = p.response?.status && p.response.status < 400;
    return { tone: ok ? theme.roles.success : theme.roles.danger, text: `← ${p.response?.status} ${p.response?.url}` };
  }
  if (event.method === 'Network.loadingFailed') return { tone: theme.roles.danger, text: `✕ ${p.errorText || 'failed'}` };
  return { tone: theme.roles.muted, text: event.method };
}

export function rail(app, width) {
  const { theme } = app;
  if (!app.browserTarget) return [gutter(theme) + theme.paint('No browser tab selected.', { fg: theme.roles.muted, italic: true })];
  const lines = [];
  lines.push(theme.paint('Console', { fg: theme.roles.label, bold: true }));
  if (!app.browserConsoleLog.length) lines.push(gutter(theme) + theme.paint('Nothing logged yet.', { fg: theme.roles.muted, italic: true }));
  for (const event of app.browserConsoleLog.slice(-15)) {
    const { tone, text } = consoleLine(theme, event);
    lines.push(gutter(theme) + theme.paint(truncate(text, width - SPACE.gutter), { fg: tone }));
  }
  lines.push('');
  lines.push(theme.paint('Network', { fg: theme.roles.label, bold: true }));
  if (!app.browserNetworkLog.length) lines.push(gutter(theme) + theme.paint('Nothing captured yet.', { fg: theme.roles.muted, italic: true }));
  for (const event of app.browserNetworkLog.slice(-15)) {
    const { tone, text } = networkLine(theme, event);
    lines.push(gutter(theme) + theme.paint(truncate(text, width - SPACE.gutter), { fg: tone }));
  }
  return lines;
}
