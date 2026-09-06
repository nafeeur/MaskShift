// 01 HEIST — the transcript and composer.

import { glyphs, panel, rule } from '../box.mjs';
import { heroBlock, maskArt } from '../brand.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { LAYER, Regions } from '../regions.mjs';
import { center, fit, oneLine, truncate, visibleWidth, wrap } from '../text.mjs';

const STARTERS = [
  ['CASE THE REPO', 'Map this repository, identify architectural risks, and propose the highest-impact improvements.'],
  ['HUNT & ELIMINATE', 'Find the most important broken or incomplete feature, implement it fully, and verify the result.'],
  ['REVIEW THE TAKE', 'Review the current Git changes, repair defects, add missing tests, and run the relevant verification suite.'],
];

// A speaker is announced by a solid chip and a right-aligned stamp. An earlier
// revision ran a dashed rule between the two; at 130 columns that is seventy
// characters of noise per turn, so the space is simply left empty.
function speakerRule(theme, label, colour, width, meta = '') {
  const head = theme.paint(` ${label} `, { fg: theme.palette.ink, bg: colour, bold: true });
  const tail = meta ? theme.paint(truncate(meta, Math.max(0, width - visibleWidth(head) - 2)), { fg: theme.roles.border }) : '';
  const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(tail));
  return `${head}${' '.repeat(gap)}${tail}`;
}

function toolLine(theme, message, width, expanded) {
  const mark = glyphs(theme);
  const name = message.meta?.toolName || 'tool';
  const failed = Boolean(message.meta?.isError);
  const tone = failed ? theme.roles.danger : theme.roles.tool;
  const icon = failed ? mark.cross : mark.check;
  const head = theme.paint(`  ${icon} `, { fg: tone })
    + theme.paint(name, { fg: tone, bold: true })
    + theme.paint(`  ${oneLine(message.content, Math.max(10, width - visibleWidth(name) - 8))}`, { fg: theme.roles.muted });
  if (!expanded) return [fit(head, width)];
  const lines = [fit(head, width)];
  for (const raw of String(message.content || '').split('\n').slice(0, 60)) {
    for (const piece of wrap(raw, width - 6)) {
      lines.push(theme.paint('    ' + mark.pipe + ' ', { fg: theme.roles.border }) + theme.paint(piece, { fg: theme.roles.dim }));
    }
  }
  return lines;
}

export function transcriptLines(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const lines = [];
  // One blank line *before* each block rather than after, so the transcript
  // never ends on trailing whitespace and every gap is the same height.
  const openBlock = () => { if (lines.length) lines.push(''); };

  for (const message of app.messages) {
    if (message.role === 'user') {
      openBlock();
      lines.push(speakerRule(theme, 'OPERATOR', theme.palette.gold, width, app.stamp(message.created_at)));
      for (const piece of wrap(String(message.content || ''), width - 2)) {
        lines.push(theme.paint(`${mark.spine} `, { fg: theme.palette.gold }) + theme.paint(piece, { fg: theme.roles.text }));
      }
      continue;
    }
    if (message.role === 'assistant') {
      if (!String(message.content || '').trim()) continue;
      openBlock();
      lines.push(speakerRule(theme, 'MASKSHIFT', theme.palette.crimson, width, message.meta?.modelRef || ''));
      lines.push(...renderMarkdown(theme, message.content, width));
      continue;
    }
    if (message.role === 'tool') {
      openBlock();
      lines.push(...toolLine(theme, message, width, app.expandTools));
      continue;
    }
  }
  for (const entry of app.liveTrail) {
    if (lines.length) lines.push('');
    lines.push(...entry.render(theme, width, app));
  }
  return lines;
}

function emptyState(app, width, height) {
  const { theme } = app;
  const lines = [];
  const hero = heroBlock(theme, width);
  const art = maskArt(theme);
  const artBlock = art.map((line) => center(line, width));
  // The starter block is five rows: a caption, a gap, and one row per starter.
  const chrome = STARTERS.length + 2;
  const block = height > hero.length + art.length + chrome + 4 ? [...artBlock, '', ...hero] : hero;
  const pad = Math.max(0, Math.floor((height - block.length - chrome) / 2));
  for (let index = 0; index < pad; index += 1) lines.push('');
  lines.push(...block);
  lines.push('');
  lines.push(center(theme.paint(`TOTAL ARSENAL ACCESS  ${glyphs(theme).dot}  SUMMONED ONLY WHEN NEEDED`, { fg: theme.roles.muted }), width));
  lines.push('');

  // Remembered so the click zones land on the same rows the keys do.
  app.starterRows = [];
  const labelWidth = Math.max(...STARTERS.map(([label]) => visibleWidth(label)));
  for (const [index, [label, prompt]] of STARTERS.entries()) {
    const key = theme.paint(` F${index + 1} `, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true });
    const name = theme.paint(fit(label, labelWidth), { fg: theme.palette.gold, bold: true });
    const room = Math.max(10, width - labelWidth - 12);
    const body = `${key} ${name}  ${theme.paint(truncate(prompt, room), { fg: theme.roles.border })}`;
    app.starterRows.push(lines.length);
    lines.push(fit(`  ${body}`, width));
  }
  return lines;
}

/**
 * The transcript and the composer share one frame, split by an internal seam.
 *
 * Two stacked frames spent four rows on chrome for two panes, put a doubled
 * rule through the middle of the view, and — because the lower frame was
 * trimmed to fit — dropped the composer's bottom rule entirely. One frame with
 * a seam costs three rows, cannot be clipped, and reads as a single surface.
 */
export function render(app, region) {
  const { theme } = app;
  const mark = glyphs(theme);
  const { width, height } = region;

  // Frame + seam is three rows; the composer takes what it needs from the rest.
  const composerWidth = Math.max(8, width - 6);
  const draftRows = app.composer.layout(composerWidth, 6).total;
  const composerRows = Math.max(1, Math.min(6, draftRows, Math.max(1, height - 8)));
  const transcriptHeight = Math.max(1, height - 3 - composerRows);

  // One column of scrollbar and one of breathing room sit to the right of the
  // text, so nothing ever butts against the track.
  const inner = width - 4;
  const textWidth = Math.max(8, inner - 2);

  const body = app.messages.length === 0 && app.liveTrail.length === 0
    ? emptyState(app, textWidth, transcriptHeight)
    : transcriptLines(app, textWidth);

  app.transcript.set(body);
  const visible = app.transcript.render(transcriptHeight, textWidth);
  const bar = app.transcript.scrollbar(theme, transcriptHeight);
  const transcriptRows = visible.map((line, index) => `${fit(line, textWidth + 1)}${bar[index] ?? ' '}`);

  const scrolled = !app.transcript.stick && body.length > transcriptHeight;
  const note = scrolled
    ? `${Math.round((app.transcript.offset / Math.max(1, body.length - transcriptHeight)) * 100)}% ${mark.arrowUp}`
    : `${app.messages.length} msg`;

  // The seam labels the composer and carries its keys, so the pane that owns
  // the keyboard is named on the rule that bounds it.
  const composerFocused = app.focus === 'composer';
  const paneFocused = composerFocused || app.focus === 'transcript';
  const seamLabel = app.busy ? `${app.spinner.frame(theme)} EXECUTING` : 'COMPOSER';
  const seam = rule(theme, width - 2, seamLabel, {
    active: composerFocused,
    // The seam is part of the frame, so it carries the frame's weight.
    weight: paneFocused ? 'heavy' : 'light',
    colour: paneFocused ? theme.roles.borderActive : theme.roles.border,
    stamp: composerFocused
      ? (app.busy ? `esc retreats ${mark.dot} ↵ queues` : `↵ execute ${mark.dot} ^J newline`)
      : 'tab or click to type',
  });

  const layout = app.composer.layout(composerWidth, composerRows);
  const composerBody = [];
  for (let index = 0; index < composerRows; index += 1) {
    const row = layout.rows[index];
    const gutter = index === 0
      ? theme.paint(`${mark.caret} `, { fg: app.busy ? theme.roles.border : theme.palette.crimson })
      : '  ';
    const text = index === 0 && !app.composer.value
      ? theme.paint(truncate(app.composerPlaceholder(), composerWidth), { fg: theme.roles.border, italic: true })
      : theme.paint(row ?? '', { fg: theme.roles.text });
    composerBody.push(fit(`${gutter}${text}`, inner));
  }

  // The old footer row carried an always-empty character meter. The same
  // information now costs no rows at all: it appears in the bottom stamp, and
  // only once the draft is long enough for the budget to matter.
  const drafted = app.composer.value.length;
  const stampParts = [];
  if (draftRows > composerRows) stampParts.push(`${draftRows} lines`);
  if (drafted > 1000) stampParts.push(`${Math.round((drafted / 4000) * 100)}% of budget`);
  if (!app.autoLoad) stampParts.push('MANUAL LOAD');

  const lines = panel({
    theme, width, height, title: 'HEIST', index: '01', note,
    stamp: stampParts.join(` ${mark.dot} `),
    body: [...transcriptRows, seam, ...composerBody],
    seamRows: [transcriptHeight],
    focused: paneFocused,
  });

  // Keyboard scrolling needs the same page size the mouse wheel uses.
  app.chatPanes = { transcriptHeight, composerRows };
  registerRegions(app, region, { transcriptHeight, composerRows, textWidth, body });

  const cursor = composerFocused
    ? {
      row: region.row + 1 + transcriptHeight + 1 + layout.caret.row,
      column: region.column + 2 + 2 + layout.caret.column,
    }
    : null;

  return { lines, cursor };
}

// Every pane, the scrollbar track and each starter prompt become click targets.
function registerRegions(app, region, { transcriptHeight, composerRows, textWidth, body }) {
  const regions = app.regions;
  if (!regions) return;
  const transcriptTop = region.row + 1;

  regions.add({
    row: transcriptTop,
    column: region.column + 1,
    width: Math.max(0, region.width - 2),
    height: transcriptHeight,
    id: 'chat:transcript',
    layer: LAYER.body,
    onPress: (target) => { target.focus = 'transcript'; },
    onWheel: (target, event) => {
      target.transcript.scroll(event.button === 'wheelup' ? -3 : 3, transcriptHeight);
    },
  });

  // The scrollbar column: press or drag anywhere on the track to jump there.
  const jump = (target, event, zone) => {
    const local = Regions.local(zone, event);
    const span = Math.max(1, body.length - transcriptHeight);
    const ratio = transcriptHeight > 1 ? local.row / (transcriptHeight - 1) : 0;
    target.transcript.offset = Math.round(Math.max(0, Math.min(1, ratio)) * span);
    target.transcript.clampOffset(transcriptHeight);
  };
  regions.add({
    row: transcriptTop,
    column: region.column + region.width - 2,
    width: 1,
    height: transcriptHeight,
    id: 'chat:scrollbar',
    layer: LAYER.body,
    onPress: jump,
    onDrag: jump,
  });

  const seamRow = transcriptTop + transcriptHeight;
  regions.add({
    row: seamRow,
    column: region.column,
    width: region.width,
    height: 1 + composerRows,
    id: 'chat:composer',
    layer: LAYER.body,
    onPress: (target) => { target.focus = 'composer'; },
  });

  // Starter prompts are only on screen while the transcript is empty. Their
  // recorded positions are indices into the buffer, so translate by whatever
  // the viewport settled on.
  if (app.messages.length === 0 && !app.liveTrail.length && app.starterRows) {
    const scroll = Number.isFinite(app.transcript.offset) ? app.transcript.offset : 0;
    for (const [index, position] of app.starterRows.entries()) {
      const offset = position - scroll;
      if (offset < 0 || offset >= transcriptHeight) continue;
      regions.add({
        row: transcriptTop + offset,
        column: region.column + 2,
        width: Math.max(0, textWidth),
        height: 1,
        id: `chat:starter:${index}`,
        layer: LAYER.body + 1,
        onPress: (target) => {
          const starter = STARTERS[index];
          if (!starter) return;
          target.composer.set(starter[1]);
          target.focus = 'composer';
        },
      });
    }
  }
}

export function handle(app, event) {
  const height = app.chatPanes?.transcriptHeight ?? Math.max(1, app.bodyRegion.height - 6);
  if (app.focus === 'transcript') {
    if (app.transcript.handle(event, height)) return true;
    if (event.name === 'tab') { app.focus = 'composer'; return true; }
    if (event.name === 't' && !event.ctrl) { app.expandTools = !app.expandTools; return true; }
    if (event.printable && !event.ctrl && !event.alt) { app.focus = 'composer'; app.composer.handle(event); return true; }
    return false;
  }

  if (event.name === 'tab' && !event.ctrl) { app.focus = 'transcript'; return true; }
  if (event.name === 'enter' && !event.alt && !event.ctrl) { void app.submitPrompt(); return true; }
  if (event.ctrl && event.name === 's') { void app.submitPrompt(); return true; }
  if (event.ctrl && event.name === 'j') { app.composer.insert('\n'); return true; }
  if (event.name === 'pageup' || event.name === 'pagedown') { app.transcript.handle(event, height); return true; }
  if (/^f[1-3]$/.test(event.name) && app.messages.length === 0) {
    const starter = STARTERS[Number(event.name.slice(1)) - 1];
    if (starter) { app.composer.set(starter[1]); return true; }
  }
  return app.composer.handle(event);
}

export const hints = (app) => (app.focus === 'composer'
  ? [
    ['↵', 'execute', (target) => void target.submitPrompt()],
    ['^J', 'newline', (target) => target.composer.insert('\n')],
    ['tab', 'transcript', (target) => { target.focus = 'transcript'; }],
    ['^K', 'palette', (target) => target.openPalette()],
    ['esc', app.busy ? 'cancel run' : 'menu', (target) => (target.busy ? target.cancelRun() : target.openPalette())],
  ]
  : [
    ['↑↓', 'scroll'],
    ['t', 'tool output', (target) => { target.expandTools = !target.expandTools; }],
    ['tab', 'composer', (target) => { target.focus = 'composer'; }],
    ['^K', 'palette', (target) => target.openPalette()],
    ['?', 'help', (target) => target.openHelp()],
  ]);

export const meta = { id: 'chat', index: '01', title: 'HEIST', shortcut: '1' };
