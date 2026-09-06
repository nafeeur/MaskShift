// 05 MOD SHOP — automations, plugins, agent bridges, browsers, processes.

import { oneLine, truncate, wrap } from '../text.mjs';
import { statusGlyph, statusOf } from '../status.mjs';
import { SPACE } from '../tokens.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog } from './catalog.mjs';
import { fuzzy } from '../widgets.mjs';

const NAME_WIDTH = 30;
const STATUS_WIDTH = 11;

const TABS = [
  { id: 'automations', label: 'AUTOMATIONS' },
  { id: 'plugins', label: 'PLUGINS' },
  { id: 'bridges', label: 'BRIDGES' },
  { id: 'browser', label: 'BROWSER' },
  { id: 'processes', label: 'PROCESSES' },
];

function scheduleLabel(schedule) {
  if (!schedule) return 'manual';
  if (typeof schedule === 'string') return schedule;
  if (schedule.cron) return `cron ${schedule.cron}`;
  if (schedule.everyMs) return `every ${Math.round(schedule.everyMs / 1000)}s`;
  if (schedule.at) return `at ${schedule.at}`;
  return JSON.stringify(schedule).slice(0, 40);
}

export function items(app) {
  const query = app.modFilter.value.trim();
  let source = [];
  if (app.modTab === 'automations') {
    source = app.automations.map((automation) => ({
      id: `auto:${automation.id}`, kind: 'automation', name: automation.name,
      status: automation.enabled ? (automation.last_status || 'armed') : 'paused',
      description: `${scheduleLabel(automation.schedule)} · ${automation.action?.type || 'agent'}`,
      raw: automation,
    }));
  } else if (app.modTab === 'plugins') {
    source = app.plugins.map((plugin) => ({
      id: `plugin:${plugin.name}`, kind: 'plugin', name: plugin.name,
      status: plugin.status, description: plugin.description || plugin.root, raw: plugin,
    }));
  } else if (app.modTab === 'bridges') {
    source = app.bridges.map((bridge) => ({
      id: `bridge:${bridge.name}`, kind: 'bridge', name: bridge.title || bridge.name,
      status: bridge.available ? 'available' : 'missing',
      description: bridge.command + (bridge.version ? ` · ${oneLine(bridge.version, 40)}` : ''),
      raw: bridge,
    }));
  } else if (app.modTab === 'browser') {
    source = app.browsers.map((instance) => ({
      id: `browser:${instance.id}`, kind: 'browser', name: instance.profile || instance.id,
      status: instance.headless ? 'headless' : 'visible',
      description: `${instance.endpoint || ''} ${instance.tabs ?? ''}`.trim(), raw: instance,
    }));
  } else {
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
  const item = app.modList.current;
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
  } else if (item.kind === 'plugin') {
    sections.push(
      { field: 'version', value: raw.version },
      { field: 'status', value: raw.status },
      { field: 'root', value: raw.root },
      { field: 'entry', value: raw.entry || '' },
      { field: 'tools', value: (raw.tools || []).join(', ') || 'none' },
      { field: 'skill dirs', value: (raw.skills || []).join(', ') || 'none' },
      raw.error ? { field: 'error', value: raw.error, tone: theme.roles.danger } : null,
    );
  } else if (item.kind === 'bridge') {
    sections.push(
      { field: 'command', value: raw.command },
      { field: 'resolved', value: raw.executable || 'not found' },
      { field: 'args', value: (raw.args || []).join(' ') },
      { field: 'version', value: oneLine(raw.version || '', 200) },
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

export function render(app, region) {
  const list = items(app);
  app.modList.setItems(list);
  const counts = {
    automations: app.automations.length, plugins: app.plugins.length, bridges: app.bridges.length,
    browser: app.browsers.length, processes: app.processes.length,
  };
  return renderCatalog(app, region, {
    tabs: TABS.map((tab) => ({ ...tab, count: counts[tab.id] })),
    activeTab: app.modTab,
    filter: app.modFilter, filterFocus: 'mod-filter', listFocus: 'modshop',
    placeholder: 'Filter extensions and autonomy',
    list: app.modList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: `${list.length} ENTRIES`,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.modList.current?.name ? truncate(app.modList.current.name, 30) : 'DOSSIER',
    onTab: (target, id) => { target.modTab = id; target.modList.first(); void target.refreshModShop(); },
    onActivate: (target, item) => activate(target, item),
  });
}

// Enter, and a click on the already-selected row, do the same thing.
function activate(app, item) {
  if (item?.kind === 'automation') void app.runAutomation(item.raw.id);
  else if (item?.kind === 'plugin') void (item.status === 'active' ? app.deactivatePlugin(item.name) : app.activatePlugin(item.name));
  else if (item?.kind === 'bridge') app.openBridgeRunner(item.raw);
}

export function handle(app, event) {
  const item = app.modList.current;
  if (app.focus === 'modshop') {
    switch (true) {
      case event.name === 'n': app.openModCreate(); return true;
      case event.name === 'r' && !event.ctrl: void app.refreshModShop({ force: true }); return true;
      case event.name === 'enter': activate(app, item); return true;
      case event.name === 'space' && item?.kind === 'automation': void app.toggleAutomation(item.raw); return true;
      case event.name === 'delete' && item?.kind === 'automation': app.confirmDeleteAutomation(item.raw); return true;
      case event.name === 'l' && item?.kind === 'plugin': void app.reloadPlugin(item.name); return true;
      case event.name === 'delete' && item?.kind === 'browser': void app.closeBrowser(item.raw.id); return true;
      case event.name === 'delete' && item?.kind === 'process': void app.stopProcess(item.raw.id); return true;
      default: break;
    }
  }
  return handleCatalog(app, event, {
    filter: app.modFilter, filterFocus: 'mod-filter', listFocus: 'modshop',
    list: app.modList, tabs: TABS,
    cycleTab: (direction) => {
      const index = TABS.findIndex((tab) => tab.id === app.modTab);
      app.modTab = TABS[(index + direction + TABS.length) % TABS.length].id;
      app.modList.first();
      void app.refreshModShop();
    },
    onFilter: () => app.modList.first(),
  });
}

export const hints = (app) => {
  const base = [['tab', 'section'], ['n', 'new'], ['r', 'refresh'], ['/', 'filter']];
  if (app.modTab === 'automations') return [...base, ['↵', 'run now'], ['space', 'arm/pause'], ['del', 'delete']];
  if (app.modTab === 'plugins') return [...base, ['↵', 'toggle'], ['l', 'reload']];
  if (app.modTab === 'bridges') return [...base, ['↵', 'delegate']];
  return [...base, ['del', 'close']];
};

export const meta = { id: 'modshop', index: '05', title: 'MOD SHOP', shortcut: '5' };
