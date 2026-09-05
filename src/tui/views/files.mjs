// 02 FILES — workspace map and source preview.

import { glyphs, panel } from '../box.mjs';
import { highlight } from '../markdown.mjs';
import { hstack } from '../layout.mjs';
import { split } from '../layout.mjs';
import { expandTabs, fit, padStart, truncate } from '../text.mjs';

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

function treeRow(app, item, selected, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const icon = (theme.unicode ? ICONS[item.type]?.unicode : ICONS[item.type]?.ascii) || mark.dot;
  const depth = (item.path.match(/[/\\]/g) || []).length;
  const indent = '  '.repeat(Math.min(6, depth));
  const isDirectory = item.type === 'directory';
  const colour = isDirectory ? theme.palette.gold : theme.roles.text;
  const collapsed = isDirectory && app.collapsedDirs.has(item.path);
  const glyph = isDirectory ? (collapsed ? mark.arrowRight : mark.arrowDown) : icon;
  const name = truncate(item.name, Math.max(6, width - indent.length - 10));
  const size = item.type === 'file' ? theme.paint(padStart(sizeLabel(item.size), 6), { fg: theme.roles.border }) : '      ';
  const body = `${indent}${theme.paint(glyph, { fg: isDirectory ? theme.palette.crimson : theme.roles.border })} ${theme.paint(name, { fg: colour, bold: isDirectory })}`;
  const line = fit(body, Math.max(0, width - 7)) + size;
  return selected
    ? theme.paint(`${mark.spine}`, { fg: theme.palette.crimson }) + theme.paint(fit(line, width - 1), { bg: theme.palette.raised })
    : ` ${fit(line, width - 1)}`;
}

export function visibleEntries(app) {
  const collapsed = [...app.collapsedDirs];
  return app.fileEntries.filter((entry) => !collapsed.some((directory) => entry.path !== directory && entry.path.startsWith(`${directory}/`)));
}

export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  const [treeWidth, previewWidth] = split(width, [{ weight: 1, min: 26, max: 52 }, { weight: 2, min: 30 }]);

  const entries = visibleEntries(app);
  app.fileList.setItems(entries.map((entry) => ({ ...entry, id: entry.path })));
  const listHeight = height - 4;
  const filterRow = app.fileFilter.value || app.focus === 'file-filter'
    ? theme.paint(' ⌕ ', { fg: theme.palette.crimson }) + app.fileFilter.render(theme, treeWidth - 7, { focused: app.focus === 'file-filter' }).text
    : theme.paint(' ⌕ FILTER PATHS', { fg: theme.roles.border });

  const rows = app.fileList.render(theme, treeWidth - 4, listHeight, (item, selected, itemWidth) => treeRow(app, item, selected, itemWidth));
  const tree = panel({
    theme, width: treeWidth, height, title: 'WORKSPACE MAP', index: '02',
    stamp: `${entries.length} nodes`, focused: app.focus === 'files',
    body: [fit(filterRow, treeWidth - 4), '', ...rows],
  });

  const current = app.fileList.current;
  const previewBody = [];
  if (app.previewError) {
    previewBody.push(theme.paint(app.previewError, { fg: theme.roles.danger }));
  } else if (!app.previewLines.length) {
    previewBody.push(theme.paint('Select a file to read it here.', { fg: theme.roles.border, italic: true }));
  } else {
    const extension = (current?.name || app.previewPath || '').match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
    const language = LANGUAGE_BY_EXT[extension] || '';
    const gutterWidth = String(app.previewLines.length).length + 1;
    const painted = app.previewLines.map((line, index) => (
      theme.paint(fit(String(index + 1), gutterWidth), { fg: theme.roles.border })
      + theme.paint(theme.unicode ? '│ ' : '| ', { fg: theme.roles.border })
      + highlight(theme, expandTabs(line), language)
    ));
    app.preview.set(painted);
    previewBody.push(...app.preview.render(height - 2, previewWidth - 4));
  }

  const preview = panel({
    theme, width: previewWidth, height, title: app.previewPath ? truncate(app.previewPath, 40) : 'SOURCE VIEW', index: '',
    stamp: app.previewLines.length ? `${app.previewLines.length} lines` : '', focused: app.focus === 'preview',
    body: previewBody,
  });

  return { lines: hstack([{ lines: tree, width: treeWidth }, { lines: preview, width: previewWidth }], height), cursor: null };
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
