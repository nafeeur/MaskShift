// 03 ARSENAL — every native tool and skill, summoned on demand.

import { glyphs } from '../box.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { truncate, wrap } from '../text.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter } from '../type.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog } from './catalog.mjs';
import { fuzzy, highlightMatch } from '../widgets.mjs';

const RISK_TONES = { high: 'danger', elevated: 'warning', normal: 'muted', low: 'muted' };

export function items(app) {
  const query = app.arsenalFilter.value.trim();
  const source = app.arsenalTab === 'tools'
    ? app.tools.map((tool) => ({
      id: `tool:${tool.name}`, kind: 'tool', name: tool.name, description: tool.description,
      category: tool.category, risk: tool.risk, readOnly: tool.readOnly, schema: tool.inputSchema,
      alwaysAvailable: tool.alwaysAvailable,
    }))
    : app.skills.map((skill) => ({
      id: `skill:${skill.name}`, kind: 'skill', name: skill.name, description: skill.description,
      category: skill.source || 'skill', file: skill.file, meta: skill.meta,
    }));
  if (!query) return source;
  return source
    .map((item) => {
      const match = fuzzy(query, `${item.name} ${item.category || ''} ${item.description || ''}`);
      return match ? { ...item, score: match.score, positions: fuzzy(query, item.name)?.positions || [] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

const NAME_WIDTH = 24;
const ACCESS_WIDTH = 5;

function row(app, item, selected, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  // A capability's class is a constant: cyan is a tool wherever it appears,
  // violet is a skill. Access is a caution, not a failure, so writes are gold
  // rather than the crimson that belongs to focus.
  const accent = item.kind === 'tool' ? theme.roles.tool : theme.roles.skill;
  const loaded = app.activeCapabilities.has(item.name);
  const access = item.kind === 'tool'
    ? (item.readOnly ? 'READ' : 'WRITE')
    : (item.category || 'SKILL').slice(0, ACCESS_WIDTH).toUpperCase();
  return listRow(app, {
    selected, width,
    marker: loaded ? mark.lamp : '',
    markerTone: theme.roles.accent,
    cells: [
      { text: highlightMatch(theme, truncate(item.name, NAME_WIDTH), item.positions, theme.roles.accent, accent), width: NAME_WIDTH },
      { text: access, width: ACCESS_WIDTH, tone: item.kind === 'tool' && !item.readOnly ? theme.roles.warning : theme.roles.muted },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
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

export function detail(app, width) {
  const item = app.arsenalList.current;
  if (!item) return null;
  const { theme } = app;
  // The pane's own rule already carries the item's name; repeating it as the
  // first heading inside was the same duplication the panel titles had.
  if (item.kind === 'tool') {
    return detailBlock(app, width, [
      item.description || '',
      { field: 'category', value: item.category },
      { field: 'access', value: item.readOnly ? 'read only' : 'writes / executes', tone: item.readOnly ? theme.roles.success : theme.roles.danger },
      { field: 'risk', value: item.risk || 'normal', tone: theme.role(RISK_TONES[item.risk] || 'muted') },
      { field: 'always on', value: item.alwaysAvailable ? 'yes' : 'summoned on demand' },
      { heading: 'parameters' },
      { raw: schemaLines(app, item.schema, Math.max(8, width - SPACE.gutter)) },
    ]);
  }
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

export function render(app, region) {
  const list = items(app);
  app.arsenalList.setItems(list);
  const tools = app.tools.length;
  const skills = app.skills.length;
  return renderCatalog(app, region, {
    tabs: [{ id: 'tools', label: 'TOOLS', count: tools }, { id: 'skills', label: 'SKILLS', count: skills }],
    activeTab: app.arsenalTab,
    filter: app.arsenalFilter, filterFocus: 'arsenal-filter', listFocus: 'arsenal',
    placeholder: 'Search every capability',
    list: app.arsenalList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: `${list.length} OF ${app.arsenalTab === 'tools' ? tools : skills}`,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.arsenalList.current?.name ? truncate(app.arsenalList.current.name, 30) : 'DOSSIER',
    detailStamp: app.arsenalList.current?.kind === 'tool' ? 'TOOL' : 'SKILL',
    onTab: (target, id) => { target.arsenalTab = id; target.arsenalList.first(); },
    onActivate: (target, item) => activate(target, item),
  });
}

// Enter, and a click on the already-selected row, do the same thing.
function activate(app, item) {
  if (item?.kind === 'skill') void app.loadSkillBody(item.name);
  else if (item?.kind === 'tool') app.openToolRunner(item);
}

export function handle(app, event) {
  if (event.name === 'x' && app.focus === 'arsenal') {
    const item = app.arsenalList.current;
    if (item?.kind === 'tool') { app.openToolRunner(item); return true; }
    return true;
  }
  if (event.name === 'enter' && app.focus === 'arsenal') {
    activate(app, app.arsenalList.current);
    return true;
  }
  return handleCatalog(app, event, {
    filter: app.arsenalFilter, filterFocus: 'arsenal-filter', listFocus: 'arsenal',
    list: app.arsenalList, tabs: [{ id: 'tools' }, { id: 'skills' }],
    cycleTab: () => { app.arsenalTab = app.arsenalTab === 'tools' ? 'skills' : 'tools'; app.arsenalList.first(); },
    onFilter: () => app.arsenalList.first(),
  });
}

export const hints = () => [
  ['↑↓', 'browse'], ['tab', 'tools/skills'], ['/', 'search'], ['↵', 'load'], ['x', 'run tool'], ['→', 'dossier'],
];

export const meta = { id: 'arsenal', index: '03', title: 'ARSENAL', shortcut: '3' };
