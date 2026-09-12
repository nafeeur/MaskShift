// Shared chrome for the catalogue views (arsenal, network, mod shop):
// a section switcher, a filter, a scrolling list and a detail pane.
//
// Three views render through this file, so it is where list rows earn their
// consistency. `listRow` owns the selection treatment and the column geometry;
// a view supplies cells and a marker and gets a row that lines up with every
// other row in the product. Before that each view hand-rolled `fit` calls with
// its own magic numbers, and no two lists shared a column edge.

import { MASK_HEIGHT, MASK_WIDTH, maskArt } from '../brand.mjs';
import { frameColour, glyphs, panel, rule } from '../box.mjs';
import { hstack, split } from '../layout.mjs';
import { LAYER, listZone, viewportZone } from '../regions.mjs';
import { center, fit, underlay, visibleWidth, wrap } from '../text.mjs';
import { FIELD_LABEL_WIDTH, SPACE } from '../tokens.mjs';
import { columns, field, gutter, label as typeLabel } from '../type.mjs';

/**
 * Centred filler for a catalogue with nothing in it. A blank rectangle under
 * a two-row header reads as broken; the mask glyph the idle heist screen
 * already uses reads as a considered state, so an empty Network or Mod Shop
 * pane feels like the same product instead of an unfinished corner of it.
 * The art only appears when the pane can actually fit it — a raster mark cut
 * off at the edges reads worse than the plain text alone.
 */
function emptyState(theme, width, height, { title, hint = '' } = {}) {
  const art = width >= MASK_WIDTH && height >= MASK_HEIGHT + 4 ? maskArt(theme) : [];
  const block = [...art, '', theme.paint(title, { fg: theme.roles.muted, bold: true })];
  if (hint) block.push('', theme.paint(hint, { fg: theme.roles.faint, italic: true }));
  const lines = block.map((line) => fit(center(line, width), width));
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  const out = [];
  for (let row = 0; row < height; row += 1) {
    const index = row - top;
    out.push(index >= 0 && index < lines.length ? lines[index] : ' '.repeat(width));
  }
  return out;
}

/**
 * The section switcher inside a pane.
 *
 * Marked by weight and an underline, never by a fill: the active view tab at
 * the top of the screen is the one filled chip in the interface, and a second
 * lit chip inside the pane below it made the pair ambiguous.
 *
 * `origin` is the screen cell of the row's first column, so each label can
 * claim the columns it lands on as a click target.
 */
export function tabRow(app, tabs, active, width, { origin = null, onPick = null } = {}) {
  const { theme } = app;
  const mark = glyphs(theme);

  // Counts are the first thing to go when the strip will not fit. The mod shop
  // carries five sections, and truncating the switcher mid-word — "BROWSER 0
  // ·…" — hides a section rather than a number.
  const cost = (withCounts) => tabs.reduce((sum, tab) => sum
    + visibleWidth(tab.label)
    + (withCounts && tab.count !== undefined ? String(tab.count).length + 1 : 0), 0)
    + 3 * Math.max(0, tabs.length - 1);
  const withCounts = cost(true) <= width;

  let column = origin?.column ?? 0;
  let out = '';
  for (const [index, tab] of tabs.entries()) {
    if (index > 0) {
      out += theme.paint(` ${mark.dot} `, { fg: theme.roles.border });
      column += 3;
    }
    const isActive = tab.id === active;
    const hovered = app.regions?.hoverId === `catalog:tab:${tab.id}`;
    const showCount = withCounts && tab.count !== undefined;
    out += theme.paint(tab.label, {
      fg: isActive ? theme.roles.heading : (hovered ? theme.roles.text : theme.roles.muted),
      bold: isActive,
      underline: isActive,
    });
    if (showCount) out += theme.paint(` ${tab.count}`, { fg: theme.roles.faint });

    const span = visibleWidth(tab.label) + (showCount ? String(tab.count).length + 1 : 0);
    if (origin && onPick) {
      app.regions?.add({
        row: origin.row, column, width: span, height: 1,
        id: `catalog:tab:${tab.id}`, layer: LAYER.body + 1,
        onPress: (target) => onPick(target, tab.id),
      });
    }
    column += span;
  }

  return fit(out, width);
}

/** The filter field. Its magnifier sits in the shared gutter like any marker. */
export function filterRow(app, field_, focused, width, placeholder) {
  const { theme } = app;
  const mark = glyphs(theme);
  const prefix = gutter(theme, mark.search, { tone: focused ? theme.roles.primary : theme.roles.muted });
  const room = Math.max(4, width - SPACE.gutter);
  if (!field_.value && !focused) {
    return fit(prefix + theme.paint(placeholder, { fg: theme.roles.muted }), width);
  }
  return fit(prefix + field_.render(theme, room, { focused }).text, width);
}

/**
 * One row of a catalogue list.
 *
 * Selection is a raised surface plus a rail in the gutter — not a colour on
 * the text, which would fight whatever the row's own tones are trying to say.
 * `marker` is the row's own state glyph and shows only when the row is not
 * selected, so the gutter never has to hold two things at once.
 */
export function listRow(app, { selected, marker = '', markerTone = null, cells, width }) {
  const { theme } = app;
  const mark = glyphs(theme);
  const lead = selected
    ? gutter(theme, mark.spine, { tone: theme.roles.primary })
    : gutter(theme, marker, { tone: markerTone || theme.roles.faint });
  const body = columns(theme, cells, Math.max(0, width - SPACE.gutter));
  const line = fit(`${lead}${body}`, width);
  return selected ? underlay(line, theme.bg(theme.roles.selection)) : line;
}

/**
 * The detail pane's contents.
 *
 * Sections are `{ heading }`, `{ field, value }`, `{ raw }` or a bare string.
 * Every one of them starts its text on the same column, which is why the
 * dossier no longer has its headings, its labels and its prose on three
 * different left edges.
 */
export function detailBlock(app, width, sections) {
  const { theme } = app;
  const text = Math.max(8, width - SPACE.gutter);
  const lines = [];
  for (const section of sections) {
    if (section === null || section === undefined) continue;
    if (typeof section === 'string') {
      for (const piece of wrap(section, text)) lines.push(gutter(theme) + theme.paint(piece, { fg: theme.roles.text }));
      continue;
    }
    if (section.heading) {
      if (lines.length) lines.push('');
      lines.push(gutter(theme) + typeLabel(theme, section.heading, { tone: theme.roles.label }));
      continue;
    }
    if (section.field) {
      const value = String(section.value ?? '');
      if (!value) continue;
      const room = Math.max(8, text - FIELD_LABEL_WIDTH);
      // A value that exactly fills its column leaves an empty continuation
      // behind, which showed up as a stray blank row between two fields.
      const body = wrap(value, room).filter((piece, index) => index === 0 || piece);
      lines.push(gutter(theme) + field(theme, section.field) + theme.paint(body[0] ?? '', { fg: section.tone || theme.roles.text }));
      for (const piece of body.slice(1)) {
        lines.push(gutter(theme) + ' '.repeat(FIELD_LABEL_WIDTH) + theme.paint(piece, { fg: section.tone || theme.roles.text }));
      }
      continue;
    }
    if (section.raw) { lines.push(...section.raw.map((line) => gutter(theme) + line)); continue; }
  }
  return lines;
}

/**
 * A secondary pane beside a framed one.
 *
 * It deliberately has no frame of its own: butting two boxes together drew two
 * vertical rules with nothing between them. The neighbouring frame is the
 * divider, a title rule opens the pane, and that rule is also where the pane
 * shows that it holds the keyboard.
 */
export function sidePane(app, { width, height, title, stamp, focused, body }) {
  const { theme } = app;
  const inner = Math.max(4, width - 2);
  const lines = [
    rule(theme, inner, title, {
      stamp,
      active: focused,
      colour: frameColour(theme, focused),
      weight: focused ? 'heavy' : 'light',
    }),
    ...body,
  ];
  return lines.slice(0, height).concat(new Array(Math.max(0, height - lines.length)).fill(''))
    .map((line) => ` ${fit(line, inner)}`);
}

export function renderCatalog(app, region, spec) {
  const { theme } = app;
  const { width, height } = region;
  const hasDetail = spec.detail !== null && width >= 92;
  const [listWidth, detailWidth] = hasDetail
    ? split(width, [{ weight: 3, min: 34 }, { weight: 2, min: 34, max: 70 }])
    : [width, 0];

  // Panel frame plus one column of padding on each side.
  const listInner = listWidth - 4;

  // The section switcher rides the panel's own top rail. It used to sit on the
  // first body row, which left the rail above it blank and cost a row of list.
  // The rail's capacity is the panel width less its two corners and the space
  // on either side of the label.
  const railWidth = Math.max(8, listWidth - 6);
  const sections = spec.tabs?.length
    ? tabRow(app, spec.tabs, spec.activeTab, railWidth, {
      origin: { row: region.row, column: region.column + 3 },
      onPick: (target, id) => spec.onTab?.(target, id),
    }).trimEnd()
    : '';

  const header = [
    filterRow(app, spec.filter, app.focus === spec.filterFocus, listInner, spec.placeholder || 'Filter'),
    '',
  ];

  const listHeight = Math.max(1, height - 2 - header.length);
  const rows = spec.list.items.length === 0 && spec.empty
    ? emptyState(theme, listInner, listHeight, spec.empty)
    : spec.list.render(theme, listInner, listHeight, spec.row);

  // No title on the rail: the view tab at the top of the screen already names
  // this pane, and printing "03 ARSENAL" one row under an "03 ARSENAL" chip
  // was the single most repetitive thing on screen.
  const listPanel = panel({
    theme, width: listWidth, height, titleRaw: sections, note: spec.note || '',
    stamp: spec.stamp, focused: app.focus === spec.listFocus || app.focus === spec.filterFocus,
    body: [...header, ...rows],
  });

  const filterRowIndex = region.row + 1 + header.length - 2;
  app.regions?.add({
    row: filterRowIndex,
    column: region.column + 2,
    width: listInner,
    height: 1,
    id: `catalog:filter:${spec.filterFocus}`,
    layer: LAYER.body + 1,
    onPress: (target) => { target.focus = spec.filterFocus; },
  });

  listZone(app, {
    row: region.row + 1 + header.length,
    column: region.column + 1,
    width: Math.max(0, listWidth - 2),
    height: listHeight,
    list: spec.list,
    id: `catalog:list:${spec.listFocus}`,
    focus: spec.listFocus,
    onSelect: (target, item, index) => spec.onSelect?.(target, item, index),
    onActivate: (target, item, index) => spec.onActivate?.(target, item, index),
  });

  if (!hasDetail) return { lines: listPanel, cursor: null };

  const detailLines = spec.detail ?? [gutter(theme) + theme.paint('Nothing selected.', { fg: theme.roles.muted, italic: true })];
  app.detail.set(detailLines);
  const detailBody = app.detail.render(height - 1, detailWidth - 2);
  const detail = sidePane(app, {
    width: detailWidth, height,
    title: spec.detailTitle || 'DOSSIER',
    stamp: spec.detailStamp || '',
    focused: app.focus === 'detail',
    body: detailBody,
  });

  viewportZone(app, {
    row: region.row + 1,
    column: region.column + listWidth,
    width: detailWidth,
    height: height - 1,
    viewport: app.detail,
    id: 'catalog:detail',
    focus: 'detail',
  });

  return { lines: hstack([{ lines: listPanel, width: listWidth }, { lines: detail, width: detailWidth }], height), cursor: null };
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
