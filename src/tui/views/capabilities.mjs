// 03 CAPABILITIES — every native tool and skill, MCP servers (installed and
// the official registry), plugins and agent bridges: one catalogue, five
// tabs. Used to be three separate views (tools, MCP, plugins) built
// on the same list+detail chrome with tabs bolted on for each; this merges
// them into the one shared tab switcher catalog.mjs already provides.

import { glyphs } from '../box.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { fit, oneLine, sentence, truncate, wrap } from '../text.mjs';
import { statusGlyph, statusOf } from '../status.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter, label as typeLabel } from '../type.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog } from './catalog.mjs';
import { fuzzy, highlightMatch } from '../widgets.mjs';

const RISK_TONES = { high: 'danger', elevated: 'warning', normal: 'muted', low: 'muted' };

const TABS = [
  { id: 'tools', label: 'Tools' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'bridges', label: 'Bridges' },
];

const NAME_WIDTH = 28;
const STATUS_WIDTH = 11;

function toolItems(app) {
  return app.tools.map((tool) => ({
    id: `tool:${tool.name}`, kind: 'tool', name: tool.name, description: tool.description,
    category: tool.category, risk: tool.risk, readOnly: tool.readOnly, schema: tool.inputSchema,
    alwaysAvailable: tool.alwaysAvailable,
  }));
}

function skillItems(app) {
  return app.skills.map((skill) => ({
    id: `skill:${skill.name}`, kind: 'skill', name: skill.name, description: skill.description,
    category: skill.source || 'skill', file: skill.file, meta: skill.meta,
  }));
}

function mcpItems(app) {
  return app.mcpMode === 'registry'
    ? app.registryResults.map((entry) => ({
      id: `reg:${entry.name}`, kind: 'registry', name: entry.name,
      description: entry.description || '', status: 'registry', raw: entry,
    }))
    : app.mcpServers.map((server) => ({
      id: `srv:${server.name}`, kind: 'server', name: server.name,
      description: server.description || server.title || '', status: server.status,
      toolCount: server.toolCount, raw: server,
    }));
}

function pluginItems(app) {
  return app.plugins.map((plugin) => ({
    id: `plugin:${plugin.name}`, kind: 'plugin', name: plugin.name,
    status: plugin.status, description: plugin.description || plugin.root, raw: plugin,
  }));
}

function bridgeItems(app) {
  return app.bridges.map((bridge) => ({
    id: `bridge:${bridge.name}`, kind: 'bridge', name: bridge.title || bridge.name,
    status: bridge.available ? 'available' : 'missing',
    description: bridge.command + (bridge.version ? ` · ${oneLine(bridge.version, 40)}` : ''),
    raw: bridge,
  }));
}

export function items(app) {
  const query = app.capabilitiesFilter.value.trim();
  const source = {
    tools: toolItems, skills: skillItems, mcp: mcpItems, plugins: pluginItems, bridges: bridgeItems,
  }[app.capabilitiesTab](app);
  // The registry is server-side search (see searchRegistry) rather than a local filter.
  if (!query || (app.capabilitiesTab === 'mcp' && app.mcpMode === 'registry')) return source;
  return source
    .map((item) => {
      const match = fuzzy(query, `${item.name} ${item.category || ''} ${item.description || ''}`);
      return match ? { ...item, score: match.score, positions: fuzzy(query, item.name)?.positions || [] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function toolRow(app, item, selected, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const accent = item.kind === 'tool' ? theme.roles.tool : theme.roles.skill;
  const loaded = app.activeCapabilities.has(item.name);
  const access = item.kind === 'tool'
    ? (item.readOnly ? 'Read' : 'Write')
    : sentence((item.category || 'Skill').slice(0, 5));
  return listRow(app, {
    selected, width,
    marker: loaded ? mark.lamp : '',
    markerTone: theme.roles.accent,
    cells: [
      { text: highlightMatch(theme, truncate(item.name, NAME_WIDTH + 2), item.positions, theme.roles.accent, accent), width: NAME_WIDTH + 2 },
      { text: access, width: 5, tone: item.kind === 'tool' && !item.readOnly ? theme.roles.warning : theme.roles.muted },
      { text: item.kind === 'tool' ? (item.category || '') : '', tone: theme.roles.faint },
    ],
  });
}

function mcpRow(app, item, selected, width) {
  const { theme } = app;
  const state = statusOf(item.status);
  const tone = theme.role(state.tone);
  const count = item.toolCount ? `${item.toolCount} tools` : '';
  return listRow(app, {
    selected, width,
    marker: statusGlyph(theme, item.status, { animate: false }),
    markerTone: tone,
    cells: [
      { text: truncate(item.name, NAME_WIDTH), width: NAME_WIDTH, tone: theme.roles.text, bold: true },
      { text: state.label, width: STATUS_WIDTH, tone },
      { text: count, width: 9, tone: theme.roles.faint },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
}

function statusRow(app, item, selected, width) {
  const { theme } = app;
  const state = statusOf(item.status);
  const tone = theme.role(state.tone);
  return listRow(app, {
    selected, width,
    marker: statusGlyph(theme, item.status, { animate: false }),
    markerTone: tone,
    cells: [
      { text: truncate(item.name, NAME_WIDTH + 2), width: NAME_WIDTH + 2, tone: theme.roles.text, bold: true },
      { text: state.label, width: STATUS_WIDTH, tone },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
}

function row(app, item, selected, width) {
  if (item.kind === 'tool' || item.kind === 'skill') return toolRow(app, item, selected, width);
  if (item.kind === 'server' || item.kind === 'registry') return mcpRow(app, item, selected, width);
  return statusRow(app, item, selected, width);
}

function schemaLines(app, schema, width) {
  const { theme } = app;
  if (!schema?.properties) return [];
  const required = new Set(schema.required || []);
  const lines = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    lines.push(theme.paint(name, { fg: theme.roles.info, bold: true })
      + theme.paint(` ${property.type || 'any'}`, { fg: theme.roles.faint })
      + (required.has(name) ? theme.paint('  required', { fg: theme.roles.warning }) : ''));
    for (const piece of wrap(property.description || '', Math.max(8, width - SPACE.indent))) {
      lines.push(' '.repeat(SPACE.indent) + theme.paint(piece, { fg: theme.roles.muted }));
    }
  }
  return lines;
}

function toolDetail(app, item, width) {
  const { theme } = app;
  return detailBlock(app, width, [
    item.description || '',
    { field: 'category', value: item.category },
    { field: 'access', value: item.readOnly ? 'read only' : 'writes / executes', tone: item.readOnly ? theme.roles.success : theme.roles.danger },
    { field: 'risk', value: item.risk || 'normal', tone: theme.role(RISK_TONES[item.risk] || 'muted') },
    { field: 'always on', value: item.alwaysAvailable ? 'yes' : 'loaded on demand' },
    { heading: 'parameters' },
    { raw: schemaLines(app, item.schema, Math.max(8, width - SPACE.gutter)) },
  ]);
}

function skillDetail(app, item, width) {
  const { theme } = app;
  const body = app.skillBodies.get(item.name);
  const text = Math.max(8, width - SPACE.gutter);
  return detailBlock(app, width, [
    item.description || '',
    { field: 'source', value: item.category },
    { field: 'file', value: item.file || '' },
    { heading: 'body' },
    { raw: body ? renderMarkdown(theme, body, text) : [theme.paint('Press ↵ to load the skill body.', { fg: theme.roles.muted, italic: true })] },
  ]);
}

function mcpDetail(app, item, width) {
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

function pluginDetail(app, item, width) {
  const { theme } = app;
  const raw = item.raw || {};
  return detailBlock(app, width, [
    item.description || '',
    { field: 'version', value: raw.version },
    { field: 'status', value: raw.status },
    { field: 'root', value: raw.root },
    { field: 'entry', value: raw.entry || '' },
    { field: 'tools', value: (raw.tools || []).join(', ') || 'none' },
    { field: 'skill dirs', value: (raw.skills || []).join(', ') || 'none' },
    raw.error ? { field: 'error', value: raw.error, tone: theme.roles.danger } : null,
  ]);
}

function bridgeDetail(app, item, width) {
  const raw = item.raw || {};
  return detailBlock(app, width, [
    item.description || '',
    { field: 'command', value: raw.command },
    { field: 'resolved', value: raw.executable || 'not found' },
    { field: 'args', value: (raw.args || []).join(' ') },
    { field: 'version', value: oneLine(raw.version || '', 200) },
  ]);
}

export function detail(app, width) {
  const item = app.capabilitiesList.current;
  if (!item) return null;
  if (item.kind === 'tool') return toolDetail(app, item, width);
  if (item.kind === 'skill') return skillDetail(app, item, width);
  if (item.kind === 'server' || item.kind === 'registry') return mcpDetail(app, item, width);
  if (item.kind === 'plugin') return pluginDetail(app, item, width);
  if (item.kind === 'bridge') return bridgeDetail(app, item, width);
  return null;
}

const EMPTY_HINTS = (app) => {
  const query = app.capabilitiesFilter.value.trim();
  if (app.capabilitiesTab === 'mcp') {
    return app.mcpMode === 'registry'
      ? { title: query ? `No registry matches for "${query}"` : 'Search the official registry above', hint: query ? '' : 'Every MCP server MaskShift can install lives here.' }
      : { title: query ? `No installed servers match "${query}"` : 'No MCP servers connected yet', hint: query ? '' : 'a adds one · g browses the registry' };
  }
  if (query) return { title: `No matches for "${query}"`, hint: '' };
  return {
    tools: { title: 'No tools registered', hint: '' },
    skills: { title: 'No skills found', hint: '' },
    plugins: { title: 'No plugins installed', hint: 'n scaffolds one' },
    bridges: { title: 'No coding-agent CLIs found on this machine', hint: 'r rescans' },
  }[app.capabilitiesTab];
};

export function render(app, region) {
  const list = items(app);
  app.capabilitiesList.setItems(list);
  const counts = {
    tools: app.tools.length, skills: app.skills.length, mcp: app.mcpServers.length,
    plugins: app.plugins.length, bridges: app.bridges.length,
  };
  const stamps = {
    tools: `${list.length} OF ${counts.tools}`,
    skills: `${list.length} OF ${counts.skills}`,
    mcp: app.mcpMode === 'registry' ? `${app.registryResults.length} found` : `${app.mcpServers.filter((s) => s.status === 'connected').length} connected`,
    plugins: `${list.length} OF ${counts.plugins}`,
    bridges: `${list.length} OF ${counts.bridges}`,
  };
  const placeholder = app.capabilitiesTab === 'mcp'
    ? (app.mcpMode === 'registry' ? 'Search the official registry, then ↵' : 'Filter installed servers')
    : 'Search every capability';
  return renderCatalog(app, region, {
    tabs: TABS.map((tab) => ({ ...tab, count: counts[tab.id] })),
    activeTab: app.capabilitiesTab,
    filter: app.capabilitiesFilter, filterFocus: 'capabilities-filter', listFocus: 'capabilities',
    placeholder,
    list: app.capabilitiesList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: stamps[app.capabilitiesTab],
    empty: EMPTY_HINTS(app),
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.capabilitiesList.current?.name ? truncate(app.capabilitiesList.current.name, 30) : 'Details',
    detailStamp: { tool: 'Tool', skill: 'Skill', server: 'MCP', registry: 'Registry', plugin: 'Plugin', bridge: 'Bridge' }[app.capabilitiesList.current?.kind] || '',
    onTab: (target, id) => { target.capabilitiesTab = id; target.capabilitiesFilter.clear(); target.capabilitiesList.first(); },
    onActivate: (target, item) => activate(target, item),
  });
}

// Enter, and a click on the already-selected row, do the same thing.
function activate(app, item) {
  if (item?.kind === 'skill') void app.loadSkillBody(item.name);
  else if (item?.kind === 'tool') app.openToolRunner(item);
  else if (item?.kind === 'server') void (item.status === 'connected' ? app.disconnectMcp(item.name) : app.connectMcp(item.name));
  else if (item?.kind === 'registry') void app.installRegistryServer(item.raw);
  else if (item?.kind === 'plugin') void (item.status === 'active' ? app.deactivatePlugin(item.name) : app.activatePlugin(item.name));
  else if (item?.kind === 'bridge') app.openBridgeRunner(item.raw);
}

export function handle(app, event) {
  const item = app.capabilitiesList.current;
  if (app.focus === 'capabilities-filter' && event.name === 'enter' && app.capabilitiesTab === 'mcp' && app.mcpMode === 'registry') {
    void app.searchRegistry(app.capabilitiesFilter.value);
    app.focus = 'capabilities';
    return true;
  }
  if (app.focus === 'capabilities') {
    switch (true) {
      case event.name === 'x' && item?.kind === 'tool': app.openToolRunner(item); return true;
      case event.name === 'enter': activate(app, item); return true;
      case event.name === 'g' && app.capabilitiesTab === 'mcp':
        app.mcpMode = app.mcpMode === 'installed' ? 'registry' : 'installed';
        app.capabilitiesList.first();
        return true;
      case event.name === 'c' && item?.kind === 'server': void app.connectMcp(item.name, true); return true;
      case event.name === 'd' && item?.kind === 'server': void app.disconnectMcp(item.name); return true;
      case event.name === 'a' && app.capabilitiesTab === 'mcp': app.openMcpDialog(); return true;
      case event.name === 'r' && !event.ctrl && app.capabilitiesTab === 'mcp': void app.refreshMcp(); return true;
      case event.name === 'delete' && item?.kind === 'server': app.confirmRemoveMcp(item.name); return true;
      case event.name === 'n' && app.capabilitiesTab === 'plugins': app.openPluginDialog(); return true;
      case event.name === 'r' && !event.ctrl && app.capabilitiesTab === 'bridges': void app.refreshCapabilitiesExtras({ force: true }); return true;
      case event.name === 'l' && item?.kind === 'plugin': void app.reloadPlugin(item.name); return true;
      default: break;
    }
  }
  return handleCatalog(app, event, {
    filter: app.capabilitiesFilter, filterFocus: 'capabilities-filter', listFocus: 'capabilities',
    list: app.capabilitiesList, tabs: TABS,
    cycleTab: (direction) => {
      const index = TABS.findIndex((tab) => tab.id === app.capabilitiesTab);
      app.capabilitiesTab = TABS[(index + direction + TABS.length) % TABS.length].id;
      app.capabilitiesFilter.clear();
      app.capabilitiesList.first();
    },
    onFilter: () => app.capabilitiesList.first(),
  });
}

export const hints = (app) => {
  const base = [['tab', 'section'], ['/', 'search']];
  if (app.capabilitiesTab === 'tools') return [...base, ['↵', 'load'], ['x', 'run tool'], ['→', 'details']];
  if (app.capabilitiesTab === 'skills') return [...base, ['↵', 'load'], ['→', 'details']];
  if (app.capabilitiesTab === 'mcp') return [...base, ['↵', 'connect/install'], ['a', 'add server'], ['d', 'disconnect'], ['del', 'remove'], ['g', 'installed/registry']];
  if (app.capabilitiesTab === 'plugins') return [...base, ['↵', 'toggle'], ['n', 'install'], ['l', 'reload']];
  return [...base, ['↵', 'delegate'], ['r', 'rescan']];
};

export const meta = { id: 'capabilities', index: '3', title: 'Capabilities', shortcut: '3' };

// -------------------------------------------------------------------- rail
//
// A usage panel for the selected capability: how often this session has
// called it, its error rate, and when it last ran. Only a tool's calls
// actually go through the tool registry (see src/tools/registry.mjs's
// tool.started/completed/failed events, which land in app.events like any
// other event) — a skill, plugin or bridge has no equivalent per-call
// telemetry yet, so those tabs say so rather than showing invented numbers.
export function rail(app, width) {
  const { theme } = app;
  const item = app.capabilitiesList.current;
  if (!item) return [gutter(theme) + theme.paint('Select a capability to see its usage.', { fg: theme.roles.muted, italic: true })];
  if (item.kind !== 'tool') {
    return [gutter(theme) + theme.paint('No per-call telemetry for this kind yet — only tool calls are tracked.', { fg: theme.roles.muted, italic: true })];
  }
  const events = app.events.filter((event) => event.payload?.tool === item.name
    && ['tool.started', 'tool.completed', 'tool.failed'].includes(event.type));
  const completed = events.filter((event) => event.type !== 'tool.started');
  const errors = completed.filter((event) => event.type === 'tool.failed');
  const last = events.at(-1);
  const lines = [];
  lines.push(typeLabel(theme, item.name, { tone: theme.roles.label }));
  lines.push('');
  lines.push(gutter(theme) + theme.paint('calls this session  ', { fg: theme.roles.muted }) + theme.paint(String(completed.length), { fg: theme.roles.text, bold: true }));
  lines.push(gutter(theme) + theme.paint('error rate          ', { fg: theme.roles.muted })
    + theme.paint(completed.length ? `${Math.round((errors.length / completed.length) * 100)}%` : '—', { fg: errors.length ? theme.roles.danger : theme.roles.text, bold: true }));
  lines.push(gutter(theme) + theme.paint('last invoked        ', { fg: theme.roles.muted }) + theme.paint(last ? (app.stamp(last.timestamp) || 'just now') : 'never', { fg: theme.roles.text }));
  if (last?.type === 'tool.failed') lines.push(gutter(theme) + theme.paint(`last error: ${oneLine(last.payload?.error || '', width - 14)}`, { fg: theme.roles.danger }));
  return lines;
}
