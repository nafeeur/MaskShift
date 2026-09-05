// 03 ARSENAL — every native tool and skill, summoned on demand.

import { glyphs } from '../box.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { fit, truncate, wrap } from '../text.mjs';
import { detailBlock, handleCatalog, renderCatalog } from './catalog.mjs';
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

function row(app, item, selected, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const accent = item.kind === 'tool' ? theme.palette.cyanide : theme.palette.violet;
  const active = app.activeCapabilities.has(item.name);
  const name = highlightMatch(theme, truncate(item.name, 26), item.positions, theme.palette.gold);
  const badgeText = item.kind === 'tool'
    ? (item.readOnly ? 'READ' : 'WRITE')
    : (item.category || 'SKILL').slice(0, 5).toUpperCase();
  const tone = item.kind === 'tool' && !item.readOnly ? theme.palette.crimson : theme.roles.border;
  const head = theme.paint(active ? mark.diamond : mark.dot, { fg: active ? theme.palette.gold : theme.roles.border })
    + ' ' + theme.paint(fit(name, 26), { fg: accent, bold: true })
    + theme.paint(fit(badgeText, 6), { fg: tone })
    + (width - 36 >= 10 ? theme.paint(truncate(item.description || '', width - 36), { fg: theme.roles.muted }) : '');
  return selected
    ? theme.paint(mark.spine, { fg: theme.palette.crimson }) + theme.paint(fit(head, width - 1), { bg: theme.palette.raised })
    : ` ${fit(head, width - 1)}`;
}

function schemaLines(app, schema, width) {
  const { theme } = app;
  if (!schema?.properties) return [];
  const required = new Set(schema.required || []);
  const lines = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    const label = theme.paint(name, { fg: theme.palette.azure, bold: true })
      + theme.paint(` ${property.type || 'any'}`, { fg: theme.roles.border })
      + (required.has(name) ? theme.paint(' required', { fg: theme.palette.crimson }) : '');
    lines.push(fit(label, width));
    for (const piece of wrap(property.description || '', width - 2)) {
      lines.push(`  ${theme.paint(piece, { fg: theme.roles.muted })}`);
    }
  }
  return lines;
}

export function detail(app, width) {
  const item = app.arsenalList.current;
  if (!item) return null;
  const { theme } = app;
  if (item.kind === 'tool') {
    return detailBlock(app, width, [
      { heading: item.name },
      ...wrap(item.description || '', width).map((line) => line),
      { field: 'category', value: item.category },
      { field: 'access', value: item.readOnly ? 'read only' : 'writes / executes', tone: item.readOnly ? theme.roles.success : theme.roles.danger },
      { field: 'risk', value: item.risk || 'normal', tone: theme.role(RISK_TONES[item.risk] || 'muted') },
      { field: 'always on', value: item.alwaysAvailable ? 'yes' : 'summoned on demand' },
      { heading: 'parameters' },
      { raw: schemaLines(app, item.schema, width) },
    ]);
  }
  const body = app.skillBodies.get(item.name);
  return detailBlock(app, width, [
    { heading: item.name },
    ...wrap(item.description || '', width),
    { field: 'source', value: item.category },
    { field: 'file', value: item.file || '' },
    { heading: 'body' },
    { raw: body ? renderMarkdown(theme, body, width) : [theme.paint('Press ↵ to load the skill body.', { fg: theme.roles.border, italic: true })] },
  ]);
}

export function render(app, region) {
  const list = items(app);
  app.arsenalList.setItems(list);
  const tools = app.tools.length;
  const skills = app.skills.length;
  return renderCatalog(app, region, {
    title: 'ARSENAL', index: '03',
    tabs: [{ id: 'tools', label: 'TOOLS', count: tools }, { id: 'skills', label: 'SKILLS', count: skills }],
    activeTab: app.arsenalTab,
    filter: app.arsenalFilter, filterFocus: 'arsenal-filter', listFocus: 'arsenal',
    placeholder: 'SEARCH EVERY CAPABILITY',
    list: app.arsenalList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp: `${list.length} of ${app.arsenalTab === 'tools' ? tools : skills}`,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.arsenalList.current?.name ? truncate(app.arsenalList.current.name, 30) : 'DOSSIER',
  });
}

export function handle(app, event) {
  if (event.name === 'x' && app.focus === 'arsenal') {
    const item = app.arsenalList.current;
    if (item?.kind === 'tool') { app.openToolRunner(item); return true; }
    return true;
  }
  if (event.name === 'enter' && app.focus === 'arsenal') {
    const item = app.arsenalList.current;
    if (item?.kind === 'skill') { void app.loadSkillBody(item.name); return true; }
    if (item?.kind === 'tool') { app.openToolRunner(item); return true; }
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
