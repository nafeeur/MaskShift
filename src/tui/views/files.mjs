// 02 FILES — workspace map and source preview.

import { glyphs, panel } from '../box.mjs';
import { highlight } from '../markdown.mjs';
import { hstack } from '../layout.mjs';
import { split } from '../layout.mjs';
import { LAYER, listZone, viewportZone } from '../regions.mjs';
import { expandTabs, fit, truncate } from '../text.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter } from '../type.mjs';
import { filterRow, listRow, sidePane } from './catalog.mjs';

const ICONS = {
  directory: { unicode: '▾', ascii: '/' },
  file: { unicode: '·', ascii: '.' },
  symlink: { unicode: '↗', ascii: '>' },
  error: { unicode: '!', ascii: '!' },
};

const LANGUAGE_BY_EXT = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.jsx': 'js',
  '.json': 'json', '.py': 'py', '.rs': 'rust', '.go': 'go', '.sh': 'sh', '.bash': 'sh',
  '.md': 'md', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.css': 'css', '.html': 'html',
};

function sizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

const SIZE_WIDTH = 6;

function treeRow(app, item, selected, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const icon = (theme.unicode ? ICONS[item.type]?.unicode : ICONS[item.type]?.ascii) || mark.dot;
  const depth = (item.path.match(/[/\\]/g) || []).length;
  const indent = ' '.repeat(SPACE.indent * Math.min(6, depth));
  const isDirectory = item.type === 'directory';
  const collapsed = isDirectory && app.collapsedDirs.has(item.path);
  const glyph = isDirectory ? (collapsed ? mark.arrowRight : mark.arrowDown) : icon;
  // Depth is indentation and a directory is brighter and bolder than the files
  // it holds — a container that reads quieter than its contents inverts the
  // hierarchy the indentation just established. Neither needs a hue: a crimson
  // glyph on every folder made the tree look like an error list.
  const name = theme.paint(`${indent}${glyph} `, { fg: isDirectory ? theme.roles.label : theme.roles.faint })
    + theme.paint(item.name, { fg: isDirectory ? theme.roles.heading : theme.roles.text, bold: isDirectory });
  return listRow(app, {
    selected, width,
    cells: [
      { text: name },
      { text: item.type === 'file' ? sizeLabel(item.size) : '', width: SIZE_WIDTH, align: 'right', tone: theme.roles.faint },
    ],
  });
}

export function visibleEntries(app) {
  const collapsed = [...app.collapsedDirs];
  return app.fileEntries.filter((entry) => !collapsed.some((directory) => entry.path !== directory && entry.path.startsWith(`${directory}/`)));
}

export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  // The tree carries indentation, a glyph, a name and a size on one row, so it
  // needs enough width to show a real filename before the size column; at the
  // old minimum every path in a nested directory arrived pre-truncated.
  const [treeWidth, previewWidth] = split(width, [{ weight: 1, min: 34, max: 56 }, { weight: 2, min: 30 }]);

  const entries = visibleEntries(app);
  app.fileList.setItems(entries.map((entry) => ({ ...entry, id: entry.path })));
  const listHeight = height - 4;
  const filter = filterRow(app, app.fileFilter, app.focus === 'file-filter', treeWidth - 4, 'Filter paths');

  const rows = app.fileList.render(theme, treeWidth - 4, listHeight, (item, selected, itemWidth) => treeRow(app, item, selected, itemWidth));
  const tree = panel({
    theme, width: treeWidth, height, title: 'WORKSPACE',
    stamp: `${entries.length} NODES`, focused: app.focus === 'files',
    body: [filter, '', ...rows],
  });

  const current = app.fileList.current;
  const previewBody = [];
  if (app.previewError) {
    previewBody.push(gutter(theme) + theme.paint(app.previewError, { fg: theme.roles.danger }));
  } else if (!app.previewLines.length) {
    previewBody.push(gutter(theme) + theme.paint('Select a file to read it here.', { fg: theme.roles.muted, italic: true }));
  } else {
    const extension = (current?.name || app.previewPath || '').match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
    const language = LANGUAGE_BY_EXT[extension] || '';
    const gutterWidth = String(app.previewLines.length).length + 1;
    const painted = app.previewLines.map((line, index) => (
      theme.paint(fit(String(index + 1), gutterWidth), { fg: theme.roles.faint })
      + theme.paint(`${glyphs(theme).bar} `, { fg: theme.roles.border })
      + highlight(theme, expandTabs(line), language)
    ));
    app.preview.set(painted);
    previewBody.push(...app.preview.render(height - 1, previewWidth - 2));
  }

  // No frame here: the tree's own right-hand rule already divides the two.
  const preview = sidePane(app, {
    width: previewWidth, height,
    title: app.previewPath ? truncate(app.previewPath, 40) : 'SOURCE VIEW',
    stamp: app.previewLines.length ? `${app.previewLines.length} LINES` : '',
    focused: app.focus === 'preview',
    body: previewBody,
  });

  registerRegions(app, region, { treeWidth, previewWidth, listHeight });
  return { lines: hstack([{ lines: tree, width: treeWidth }, { lines: preview, width: previewWidth }], height), cursor: null };
}

function registerRegions(app, region, { treeWidth, previewWidth, listHeight }) {
  if (!app.regions) return;

  app.regions.add({
    row: region.row + 1,
    column: region.column + 2,
    width: Math.max(0, treeWidth - 4),
    height: 1,
    id: 'files:filter',
    layer: LAYER.body + 1,
    onPress: (target) => { target.focus = 'file-filter'; },
  });

  // A directory folds on a click; a file previews on the first click and
  // opens on the second, matching the catalogue views.
  listZone(app, {
    row: region.row + 3,
    column: region.column + 1,
    width: Math.max(0, treeWidth - 2),
    height: listHeight,
    list: app.fileList,
    id: 'files:tree',
    focus: 'files',
    onSelect: (target, item) => { if (item?.type === 'file') target.schedulePreview(item.path); },
    onClick: (target, item) => {
      if (item?.type !== 'directory') return false;
      // Folding is what a click on a directory means everywhere else.
      if (target.collapsedDirs.has(item.path)) target.collapsedDirs.delete(item.path);
      else target.collapsedDirs.add(item.path);
      return true;
    },
    onActivate: (target, item) => { if (item?.type === 'file') void target.openFile(item.path); },
  });

  viewportZone(app, {
    row: region.row + 1,
    column: region.column + treeWidth,
    width: previewWidth,
    height: region.height - 1,
    viewport: app.preview,
    id: 'files:preview',
    focus: 'preview',
  });
}

export function handle(app, event) {
  const height = app.bodyRegion.height;
  if (app.focus === 'file-filter') {
    if (event.name === 'escape') { app.fileFilter.clear(); app.focus = 'files'; void app.loadFileTree(); return true; }
    if (event.name === 'enter') { app.focus = 'files'; return true; }
    if (app.fileFilter.handle(event)) { void app.loadFileTree({ keepFilter: true }); return true; }
    return true;
  }
  if (app.focus === 'preview') {
    if (event.name === 'tab' || event.name === 'left') { app.focus = 'files'; return true; }
    return app.preview.handle(event, height - 2);
  }
  switch (true) {
    case event.name === '/' : app.focus = 'file-filter'; return true;
    case event.name === 'tab' || event.name === 'right': app.focus = 'preview'; return true;
    case event.name === 'enter' || event.name === 'space': {
      const item = app.fileList.current;
      if (!item) return true;
      if (item.type === 'directory') {
        if (app.collapsedDirs.has(item.path)) app.collapsedDirs.delete(item.path);
        else app.collapsedDirs.add(item.path);
        return true;
      }
      void app.openFile(item.path);
      return true;
    }
    case event.name === 'r' && !event.ctrl: void app.loadFileTree({ force: true }); return true;
    case event.name === 'h' && !event.ctrl: app.showHidden = !app.showHidden; void app.loadFileTree({ force: true }); return true;
    case event.name === 'a' && !event.ctrl: {
      const item = app.fileList.current;
      if (item?.type === 'file') app.attachContext(item.path);
      return true;
    }
    default: {
      const handled = app.fileList.handle(event, height - 4);
      if (handled) {
        const item = app.fileList.current;
        if (item?.type === 'file') app.schedulePreview(item.path);
      }
      return handled;
    }
  }
}

export const hints = () => [
  ['↑↓', 'browse'], ['↵', 'open/fold'], ['/', 'filter'], ['a', 'attach'], ['h', 'hidden'], ['r', 'refresh'], ['tab', 'preview'],
];

export const meta = { id: 'files', index: '02', title: 'FILES', shortcut: '2' };
