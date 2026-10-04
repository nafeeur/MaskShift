// 04 RUNTIME — the host shell (the default, full-account-permission terminal
// terminal.mjs used to be on its own), plus automations, background
// processes and browser instances behind a secondary tab strip. Those three
// used to be tabs of the old plugins view, alongside plugins and bridges — which
// moved to 03 CAPABILITIES instead, since they're catalogue browsing rather
// than runtime state.

import { glyphs, panel } from '../box.mjs';
import { oneLine, truncate, wrap } from '../text.mjs';
import { statusGlyph, statusOf } from '../status.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter, spread } from '../type.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog, tabRow } from './catalog.mjs';
import { fuzzy } from '../widgets.mjs';

const TABS = [
  { id: 'shell', label: 'Shell' },
  { id: 'automations', label: 'Automations' },
  { id: 'processes', label: 'Processes' },
  { id: 'browsers', label: 'Browser instances' },
];

const NAME_WIDTH = 30;
const STATUS_WIDTH = 11;

function scheduleLabel(schedule) {
  if (!schedule) return 'manual';
  if (typeof schedule === 'string') return schedule;
  if (schedule.cron) return `cron ${schedule.cron}`;
  if (schedule.everyMs) return `every ${Math.round(schedule.everyMs / 1000)}s`;
  if (schedule.at) return `at ${schedule.at}`;
  return JSON.stringify(schedule).slice(0, 40);
}

export function items(app) {
  const query = app.runtimeFilter.value.trim();
  let source = [];
  if (app.runtimeTab === 'automations') {
    source = app.automations.map((automation) => ({
      id: `auto:${automation.id}`, kind: 'automation', name: automation.name,
      status: automation.enabled ? (automation.last_status || 'armed') : 'paused',
      description: `${scheduleLabel(automation.schedule)} · ${automation.action?.type || 'agent'}`,
      raw: automation,
    }));
  } else if (app.runtimeTab === 'browsers') {
    source = app.browsers.map((instance) => ({
      id: `browser:${instance.id}`, kind: 'browser', name: instance.profile || instance.id,
      status: instance.headless ? 'headless' : 'visible',
      description: `${instance.endpoint || ''} ${instance.tabs ?? ''}`.trim(), raw: instance,
    }));
  } else if (app.runtimeTab === 'processes') {
    source = app.processes.map((process_) => ({
      id: `proc:${process_.id}`, kind: 'process', name: oneLine(process_.command, 40),
      status: process_.status || (process_.running ? 'running' : 'exited'),
      description: `${process_.cwd || ''} ${process_.exitCode === null || process_.exitCode === undefined ? '' : `exit ${process_.exitCode}`}`.trim(),
      raw: process_,
    }));
  }
  if (!query) return source;
  return source
    .map((item) => {
      const match = fuzzy(query, `${item.name} ${item.description}`);
      return match ? { ...item, score: match.score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function row(app, item, selected, width) {
  const { theme } = app;
  const state = statusOf(item.status);
  const tone = theme.role(state.tone);
  return listRow(app, {
    selected, width,
    marker: statusGlyph(theme, item.status, { animate: false }),
    markerTone: tone,
    cells: [
      { text: truncate(item.name, NAME_WIDTH), width: NAME_WIDTH, tone: theme.roles.text, bold: true },
      { text: state.label, width: STATUS_WIDTH, tone },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
}

export function detail(app, width) {
  const item = app.runtimeList.current;
  if (!item) return null;
  const { theme } = app;
  const raw = item.raw || {};
  const text = Math.max(8, width - SPACE.gutter);
  const sections = [item.description || ''];
  if (item.kind === 'automation') {
    sections.push(
      { field: 'enabled', value: raw.enabled ? 'yes' : 'no', tone: raw.enabled ? theme.roles.success : theme.roles.muted },
      { field: 'schedule', value: scheduleLabel(raw.schedule) },
      { field: 'action', value: raw.action?.type || 'agent' },
      { field: 'next run', value: raw.next_run_at || '—' },
      { field: 'last run', value: raw.last_run_at || 'never' },
      { field: 'last status', value: raw.last_status || '—' },
      { heading: 'payload' },
      { raw: wrap(JSON.stringify(raw.action || {}, null, 2), text).map((line) => theme.paint(line, { fg: theme.roles.dim })) },
    );
  } else if (item.kind === 'browser') {
    sections.push(
      { field: 'id', value: raw.id },
      { field: 'endpoint', value: raw.endpoint || '' },
      { field: 'profile', value: raw.profile || '' },
      { field: 'headless', value: raw.headless ? 'yes' : 'no' },
      { field: 'pid', value: String(raw.pid ?? '') },
    );
  } else if (item.kind === 'process') {
    sections.push(
      { field: 'id', value: raw.id },
      { field: 'pid', value: String(raw.pid ?? '') },
      { field: 'cwd', value: raw.cwd || '' },
      { field: 'exit', value: String(raw.exitCode ?? '') },
      { heading: 'stdout' },
      { raw: wrap(oneLine(raw.stdout || '', 4000), text).slice(0, 40).map((line) => theme.paint(line, { fg: theme.roles.dim })) },
    );
  }
  return detailBlock(app, width, sections);
}

const EMPTY_HINTS = {
  automations: { title: 'No automations scheduled', hint: 'n creates one' },
  browsers: { title: 'No browser instances running', hint: 'n launches one' },
  processes: { title: 'No background processes running', hint: '' },
};

// Enter, and a click on the already-selected row, do the same thing.
function activate(app, item) {
  if (item?.kind === 'automation') void app.runAutomation(item.raw.id);
  else if (item?.kind === 'browser') void app.openBrowserView(item.raw.id);
}

function renderCatalogTab(app, region) {
  const list = items(app);
  app.runtimeList.setItems(list);
  const counts = { shell: 0, automations: app.automations.length, processes: app.processes.length, browsers: app.browsers.length };
  const query = app.runtimeFilter.value.trim();
  const empty = query ? { title: `No matches for "${query}"`, hint: '' } : EMPTY_HINTS[app.runtimeTab];
  return renderCatalog(app, region, {
    tabs: TABS.map((tab) => ({ ...tab, count: counts[tab.id] })),
    activeTab: app.runtimeTab,
    filter: app.runtimeFilter, filterFocus: 'runtime-filter', listFocus: 'runtime',
    placeholder: 'Filter automations, processes and browser instances',
    list: app.runtimeList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`,
    empty,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.runtimeList.current?.name ? truncate(app.runtimeList.current.name, 30) : 'Details',
    onTab: (target, id) => {
      target.runtimeTab = id;
      target.focus = id === 'shell' ? 'terminal' : 'runtime';
      if (id !== 'shell') { target.runtimeList.first(); void target.refreshRuntimeExtras(); }
    },
    onActivate: (target, item) => activate(target, item),
  });
}

function renderShell(app, region) {
  const { theme } = app;
  const mark = glyphs(theme);
  const { width, height } = region;
  const inner = width - 4;

  // The title rail's own budget (see box.mjs's topRail) is narrower than the
  // body's — the same margin renderCatalog leaves for its section switcher.
  const railWidth = Math.max(8, width - 6);
  const tabs = tabRow(app, TABS, 'shell', railWidth, {
    origin: { row: region.row, column: region.column + 3 },
    onPick: (target, id) => { target.runtimeTab = id; target.focus = 'runtime'; target.runtimeList.first(); void target.refreshRuntimeExtras(); },
  }).trimEnd();

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

  // The tab strip carries this view's own name and its other sections; the
  // rail carries where the shell actually is.
  const framed = panel({
    theme, width, height, titleRaw: tabs, note: app.terminalBusy ? 'Running' : (app.terminalCwd || ''),
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

export function render(app, region) {
  return app.runtimeTab === 'shell' ? renderShell(app, region) : renderCatalogTab(app, region);
}

function handleShell(app, event) {
  if (event.name === 'enter') { void app.runTerminalCommand(app.terminalField.value); return true; }
  if (event.ctrl && event.name === 'l') { app.terminalLines = []; return true; }
  if (event.name === 'tab' && !event.shift) { app.runtimeTab = TABS[1].id; void app.refreshRuntimeExtras(); return true; }
  if (event.name === 'tab' && event.shift) { app.runtimeTab = TABS.at(-1).id; void app.refreshRuntimeExtras(); return true; }
  if (event.name === 'pageup' || event.name === 'pagedown') {
    return app.terminalView.handle(event, app.bodyRegion.height - 3);
  }
  return app.terminalField.handle(event);
}

function handleCatalogTab(app, event) {
  const item = app.runtimeList.current;
  if (app.focus === 'runtime') {
    switch (true) {
      case event.name === 'n' && app.runtimeTab === 'automations': app.openAutomationDialog(); return true;
      case event.name === 'n' && app.runtimeTab === 'browsers': app.openBrowserDialog(); return true;
      case event.name === 'r' && !event.ctrl: void app.refreshRuntimeExtras({ force: true }); return true;
      case event.name === 'enter': activate(app, item); return true;
      case event.name === 'space' && item?.kind === 'automation': void app.toggleAutomation(item.raw); return true;
      case event.name === 'delete' && item?.kind === 'automation': app.confirmDeleteAutomation(item.raw); return true;
      case event.name === 'delete' && item?.kind === 'browser': void app.closeBrowser(item.raw.id); return true;
      case event.name === 'delete' && item?.kind === 'process': void app.stopProcess(item.raw.id); return true;
      default: break;
    }
  }
  return handleCatalog(app, event, {
    filter: app.runtimeFilter, filterFocus: 'runtime-filter', listFocus: 'runtime',
    list: app.runtimeList, tabs: TABS,
    cycleTab: (direction) => {
      const index = TABS.findIndex((tab) => tab.id === app.runtimeTab);
      const next = TABS[(index + direction + TABS.length) % TABS.length].id;
      app.runtimeTab = next;
      app.focus = next === 'shell' ? 'terminal' : 'runtime';
      if (next !== 'shell') { app.runtimeList.first(); void app.refreshRuntimeExtras(); }
    },
    onFilter: () => app.runtimeList.first(),
  });
}

export function handle(app, event) {
  return app.runtimeTab === 'shell' ? handleShell(app, event) : handleCatalogTab(app, event);
}

export const hints = (app) => {
  if (app.runtimeTab === 'shell') return [['↵', 'run'], ['↑↓', 'history'], ['^L', 'clear'], ['tab', 'section'], ['pgup/pgdn', 'scroll']];
  const base = [['tab', 'section'], ['r', 'refresh'], ['/', 'filter']];
  if (app.runtimeTab === 'automations') return [...base, ['↵', 'run now'], ['n', 'new'], ['space', 'arm/pause'], ['del', 'delete']];
  if (app.runtimeTab === 'browsers') return [...base, ['↵', 'watch'], ['n', 'launch'], ['del', 'close']];
  return [...base, ['del', 'stop']];
};

export const meta = { id: 'runtime', index: '4', title: 'Runtime', shortcut: '4' };

// -------------------------------------------------------------------- rail
//
// Exit-code / duration history for commands run from the shell tab this
// session (see app.pushTerminalHistory, called from runTerminalCommand).
export function rail(app, width) {
  const { theme } = app;
  if (!app.terminalHistory.length) {
    return [gutter(theme) + theme.paint('No commands run yet this session.', { fg: theme.roles.muted, italic: true })];
  }
  const lines = [];
  for (const entry of app.terminalHistory.slice(-40).reverse()) {
    const ok = entry.code === 0;
    const codeLabel = entry.code === null ? 'err' : String(entry.code);
    const tone = ok ? theme.roles.success : theme.roles.danger;
    const durationLabel = entry.durationMs !== undefined ? `${entry.durationMs}ms` : '';
    lines.push(spread(
      theme.paint(codeLabel, { fg: tone, bold: true }) + theme.paint(`  ${truncate(entry.command, Math.max(4, width - codeLabel.length - durationLabel.length - 6))}`, { fg: theme.roles.text }),
      theme.paint(durationLabel, { fg: theme.roles.faint }),
      width,
    ));
  }
  return lines;
}
