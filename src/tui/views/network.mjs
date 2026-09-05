// 04 NETWORK — MCP servers: installed, discovered and the official registry.

import { glyphs } from '../box.mjs';
import { fit, truncate, wrap } from '../text.mjs';
import { detailBlock, handleCatalog, renderCatalog } from './catalog.mjs';
import { fuzzy } from '../widgets.mjs';

const STATUS_TONES = {
  connected: 'success', available: 'info', disabled: 'muted', disconnected: 'warning',
};

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
  const mark = glyphs(theme);
  const tone = theme.role(STATUS_TONES[item.status] || 'muted');
  const lamp = item.status === 'connected' ? mark.lamp : mark.ring;
  const count = item.toolCount ? `${item.toolCount} tools` : (item.kind === 'registry' ? 'registry' : '');
  const room = width - 54;
  const head = theme.paint(` ${lamp} `, { fg: tone })
    + theme.paint(fit(truncate(item.name, 28), 29), { fg: theme.palette.azure, bold: true })
    + theme.paint(fit(String(item.status).toUpperCase(), 12), { fg: tone })
    + theme.paint(fit(count, 10), { fg: theme.roles.border })
    + (room >= 10 ? theme.paint(truncate(item.description, room), { fg: theme.roles.muted }) : '');
  return selected
    ? theme.paint(mark.spine, { fg: theme.palette.crimson }) + theme.paint(fit(head, width - 1), { bg: theme.palette.raised })
    : ` ${fit(head, width - 1)}`;
}

export function detail(app, width) {
  const item = app.mcpList.current;
  if (!item) return null;
  const { theme } = app;
  const server = item.raw || {};
  const sections = [
    { heading: item.name },
    ...wrap(item.description || 'No description published.', width),
    { field: 'status', value: String(item.status).toUpperCase(), tone: theme.role(STATUS_TONES[item.status] || 'muted') },
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
      sections.push({
        raw: tools.slice(0, 40).map((tool) => fit(
          theme.paint(` ${tool.name}`, { fg: theme.palette.cyanide })
          + theme.paint(`  ${truncate(tool.description || '', Math.max(0, width - tool.name.length - 4))}`, { fg: theme.roles.muted }),
          width,
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
  return renderCatalog(app, region, {
    title: 'NETWORK', index: '04',
    tabs: [
      { id: 'installed', label: 'INSTALLED', count: app.mcpServers.length },
      { id: 'registry', label: 'REGISTRY', count: app.registryResults.length },
    ],
    activeTab: app.mcpTab,
    filter: app.mcpFilter, filterFocus: 'mcp-filter', listFocus: 'network',
    placeholder: app.mcpTab === 'registry' ? 'SEARCH THE OFFICIAL REGISTRY, THEN ↵' : 'FILTER INSTALLED SERVERS',
    list: app.mcpList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: `${connected} connected`,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.mcpList.current?.name ? truncate(app.mcpList.current.name, 30) : 'SERVER',
  });
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
      case event.name === 'enter' && item?.kind === 'server':
        void (item.status === 'connected' ? app.disconnectMcp(item.name) : app.connectMcp(item.name));
        return true;
      case event.name === 'enter' && item?.kind === 'registry':
        void app.installRegistryServer(item.raw);
        return true;
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
