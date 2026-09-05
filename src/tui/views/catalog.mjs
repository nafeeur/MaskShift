// Shared chrome for the catalogue views (arsenal, network, mod shop):
// a tab row, a filter, a scrolling list and a detail pane.

import { glyphs, panel } from '../box.mjs';
import { hstack, split } from '../layout.mjs';
import { fit, wrap } from '../text.mjs';

export function tabRow(app, tabs, active, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const parts = tabs.map((tab) => {
    const label = tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`;
    return tab.id === active
      ? theme.paint(` ${label} `, { fg: theme.palette.ink, bg: theme.palette.gold, bold: true })
      : theme.paint(` ${label} `, { fg: theme.roles.muted });
  });
  return fit(parts.join(theme.paint(mark.pipe, { fg: theme.roles.border })), width);
}

export function filterRow(app, field, focused, width, placeholder) {
  const { theme } = app;
  const prefix = theme.paint(theme.unicode ? ' ⌕ ' : ' / ', { fg: focused ? theme.palette.crimson : theme.roles.border });
  if (!field.value && !focused) return fit(prefix + theme.paint(placeholder, { fg: theme.roles.border }), width);
  const rendered = field.render(theme, Math.max(4, width - 4), { focused });
  return fit(prefix + rendered.text, width);
}

export function detailBlock(app, width, sections) {
  const { theme } = app;
  const mark = glyphs(theme);
  const lines = [];
  for (const section of sections) {
    if (section === null || section === undefined) continue;
    if (typeof section === 'string') { lines.push(...wrap(section, width)); continue; }
    if (section.heading) {
      if (lines.length) lines.push('');
      lines.push(theme.paint(`${mark.spine} ${section.heading.toUpperCase()}`, { fg: theme.palette.crimson, bold: true }));
      continue;
    }
    if (section.field) {
      const label = theme.paint(fit(section.field.toUpperCase(), 15), { fg: theme.roles.muted });
      const body = wrap(String(section.value ?? ''), Math.max(8, width - 15));
      lines.push(`${label}${theme.paint(body[0] ?? '', { fg: section.tone || theme.roles.text })}`);
      for (const piece of body.slice(1)) lines.push(`${' '.repeat(15)}${theme.paint(piece, { fg: section.tone || theme.roles.text })}`);
      continue;
    }
    if (section.raw) { lines.push(...section.raw); continue; }
  }
  return lines;
}

export function renderCatalog(app, region, spec) {
  const { theme } = app;
  const { width, height } = region;
  const hasDetail = spec.detail !== null && width >= 92;
  const [listWidth, detailWidth] = hasDetail
    ? split(width, [{ weight: 3, min: 34 }, { weight: 2, min: 34, max: 70 }])
    : [width, 0];

  const header = [];
  if (spec.tabs?.length) header.push(tabRow(app, spec.tabs, spec.activeTab, listWidth - 4));
  header.push(filterRow(app, spec.filter, app.focus === spec.filterFocus, listWidth - 4, spec.placeholder || 'FILTER'));
  header.push('');

  const listHeight = Math.max(1, height - 2 - header.length);
  const rows = spec.list.render(theme, listWidth - 4, listHeight, spec.row);

  const listPanel = panel({
    theme, width: listWidth, height, title: spec.title, index: spec.index,
    stamp: spec.stamp, focused: app.focus === spec.listFocus || app.focus === spec.filterFocus,
    body: [...header, ...rows],
  });

  if (!hasDetail) return { lines: listPanel, cursor: null };

  const detailLines = spec.detail ?? [theme.paint('Nothing selected.', { fg: theme.roles.border, italic: true })];
  app.detail.set(detailLines);
  const detailPanel = panel({
    theme, width: detailWidth, height, title: spec.detailTitle || 'DOSSIER', index: '',
    stamp: spec.detailStamp || '', focused: app.focus === 'detail',
    body: app.detail.render(height - 2, detailWidth - 4),
  });

  return { lines: hstack([{ lines: listPanel, width: listWidth }, { lines: detailPanel, width: detailWidth }], height), cursor: null };
}

/** Shared key handling for filter fields and list movement. */
export function handleCatalog(app, event, spec) {
  const viewport = app.bodyRegion.height - 6;
  if (app.focus === spec.filterFocus) {
    if (event.name === 'escape') { spec.filter.clear(); app.focus = spec.listFocus; spec.onFilter?.(); return true; }
    if (event.name === 'enter' || event.name === 'down') { app.focus = spec.listFocus; return true; }
    if (spec.filter.handle(event)) { spec.onFilter?.(); return true; }
    return true;
  }
  if (app.focus === 'detail') {
    if (['tab', 'left', 'escape'].includes(event.name)) { app.focus = spec.listFocus; return true; }
    return app.detail.handle(event, app.bodyRegion.height - 2);
  }
  if (event.name === '/') { app.focus = spec.filterFocus; return true; }
  if (event.name === 'tab' && spec.tabs?.length && !event.shift) { spec.cycleTab?.(1); return true; }
  if (event.name === 'tab' && event.shift) { spec.cycleTab?.(-1); return true; }
  if (event.name === 'right') { app.focus = 'detail'; return true; }
  return spec.list.handle(event, viewport);
}
