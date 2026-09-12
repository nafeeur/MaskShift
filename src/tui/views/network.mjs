// 04 NETWORK — MCP servers: installed, discovered and the official registry.

import { fit, truncate, wrap } from '../text.mjs';
import { statusGlyph, statusOf } from '../status.mjs';
import { SPACE } from '../tokens.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog } from './catalog.mjs';
import { fuzzy } from '../widgets.mjs';

const NAME_WIDTH = 28;
const STATUS_WIDTH = 11;
const COUNT_WIDTH = 9;

export function items(app) {
  const query = app.mcpFilter.value.trim();
  const source = app.mcpTab === 'registry'
    ? app.registryResults.map((entry) => ({
      id: `reg:${entry.name}`, kind: 'registry', name: entry.name,
      description: entry.description || '', status: 'registry', raw: entry,
    }))
    : app.mcpServers.map((server) => ({
      id: `srv:${server.name}`, kind: 'server', name: server.name,
      description: server.description || server.title || '', status: server.status,
      toolCount: server.toolCount, raw: server,
    }));
  if (!query || app.mcpTab === 'registry') return source;
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
  // Server state resolves through the shared vocabulary, so a connected server
  // wears the same green lamp as a completed run and a missing one the same
  // dark lamp as a paused automation.
  const state = statusOf(item.status);
  const tone = theme.role(state.tone);
  const count = item.toolCount ? `${item.toolCount} TOOLS` : '';
  return listRow(app, {
    selected, width,
    marker: statusGlyph(theme, item.status, { animate: false }),
    markerTone: tone,
    cells: [
      // The lamp in the gutter and the status column already carry this row's
      // state and its class; colouring the name as well put two blues on one
      // line saying the same thing.
      { text: truncate(item.name, NAME_WIDTH), width: NAME_WIDTH, tone: theme.roles.text, bold: true },
      { text: state.label, width: STATUS_WIDTH, tone },
      { text: count, width: COUNT_WIDTH, tone: theme.roles.faint },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
}

export function detail(app, width) {
  const item = app.mcpList.current;
  if (!item) return null;
  const { theme } = app;
  const server = item.raw || {};
  const state = statusOf(item.status);
  const sections = [
    item.description || 'No description published.',
    { field: 'status', value: state.label, tone: theme.role(state.tone) },
  ];
  if (item.kind === 'server') {
    sections.push(
      { field: 'transport', value: server.transport || (server.url ? 'http' : 'stdio') },
      { field: 'command', value: server.command ? [server.command, ...(server.args || [])].join(' ') : '' },
      { field: 'url', value: server.url || '' },
      { field: 'scope', value: server.scope || 'user' },
      { field: 'protocol', value: server.protocol || '' },
      { field: 'server', value: server.serverInfo ? `${server.serverInfo.name} ${server.serverInfo.version || ''}` : '' },
      { field: 'tools', value: String(server.toolCount ?? 0) },
    );
    const tools = app.mcpTools.get(item.name);
    if (tools?.length) {
      sections.push({ heading: 'exposed tools' });
      const room = Math.max(8, width - SPACE.gutter);
      sections.push({
        raw: tools.slice(0, 40).map((tool) => fit(
          theme.paint(tool.name, { fg: theme.roles.tool })
          + theme.paint(`  ${truncate(tool.description || '', Math.max(0, room - tool.name.length - 2))}`, { fg: theme.roles.muted }),
          room,
        )),
      });
    }
  } else {
    sections.push(
      { field: 'packages', value: (server.packages || []).map((entry) => entry.identifier || entry.name).join(', ') },
      { field: 'remotes', value: (server.remotes || []).map((entry) => entry.url).join(', ') },
      { field: 'version', value: server.version || '' },
    );
  }
  return detailBlock(app, width, sections);
}

export function render(app, region) {
  const list = items(app);
  app.mcpList.setItems(list);
  const connected = app.mcpServers.filter((server) => server.status === 'connected').length;
  const query = app.mcpFilter.value.trim();
  const empty = app.mcpTab === 'registry'
    ? { title: query ? `No registry matches for "${query}"` : 'Search the official registry above', hint: query ? '' : 'Every MCP server MaskShift can install lives here.' }
    : { title: query ? `No installed servers match "${query}"` : 'No MCP servers connected yet', hint: query ? '' : 'a adds one · tab browses the registry' };
  return renderCatalog(app, region, {
    tabs: [
      { id: 'installed', label: 'INSTALLED', count: app.mcpServers.length },
      { id: 'registry', label: 'REGISTRY', count: app.registryResults.length },
    ],
    activeTab: app.mcpTab,
    filter: app.mcpFilter, filterFocus: 'mcp-filter', listFocus: 'network',
    placeholder: app.mcpTab === 'registry' ? 'Search the official registry, then ↵' : 'Filter installed servers',
    list: app.mcpList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: `${connected} CONNECTED`,
    empty,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.mcpList.current?.name ? truncate(app.mcpList.current.name, 30) : 'SERVER',
    onTab: (target, id) => { target.mcpTab = id; target.mcpList.first(); },
    onActivate: (target, item) => activate(target, item),
  });
}

// Enter, and a click on the already-selected row, do the same thing.
function activate(app, item) {
  if (item?.kind === 'server') {
    void (item.status === 'connected' ? app.disconnectMcp(item.name) : app.connectMcp(item.name));
  } else if (item?.kind === 'registry') {
    void app.installRegistryServer(item.raw);
  }
}

export function handle(app, event) {
  if (app.focus === 'mcp-filter' && event.name === 'enter' && app.mcpTab === 'registry') {
    void app.searchRegistry(app.mcpFilter.value);
    app.focus = 'network';
    return true;
  }
  if (app.focus === 'network') {
    const item = app.mcpList.current;
    switch (true) {
      case event.name === 'enter': activate(app, item); return true;
      case event.name === 'c' && item?.kind === 'server': void app.connectMcp(item.name, true); return true;
      case event.name === 'd' && item?.kind === 'server': void app.disconnectMcp(item.name); return true;
      case event.name === 'a': app.openMcpDialog(); return true;
      case event.name === 'r' && !event.ctrl: void app.refreshMcp(); return true;
      case event.name === 'delete' && item?.kind === 'server': app.confirmRemoveMcp(item.name); return true;
      default: break;
    }
  }
  return handleCatalog(app, event, {
    filter: app.mcpFilter, filterFocus: 'mcp-filter', listFocus: 'network',
    list: app.mcpList, tabs: [{ id: 'installed' }, { id: 'registry' }],
    cycleTab: () => { app.mcpTab = app.mcpTab === 'installed' ? 'registry' : 'installed'; app.mcpList.first(); },
    onFilter: () => app.mcpList.first(),
  });
}

export const hints = () => [
  ['↵', 'connect/install'], ['a', 'add server'], ['d', 'disconnect'], ['del', 'remove'], ['tab', 'installed/registry'], ['/', 'search'],
];

export const meta = { id: 'network', index: '04', title: 'NETWORK', shortcut: '4' };
