// 01 HEIST — the transcript and composer.

import { glyphs, meter, panel } from '../box.mjs';
import { heroBlock, maskArt } from '../brand.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { center, fit, oneLine, repeat, truncate, visibleWidth, wrap } from '../text.mjs';

const STARTERS = [
  ['CASE THE REPO', 'Map this repository, identify architectural risks, and propose the highest-impact improvements.'],
  ['HUNT & ELIMINATE', 'Find the most important broken or incomplete feature, implement it fully, and verify the result.'],
  ['REVIEW THE TAKE', 'Review the current Git changes, repair defects, add missing tests, and run the relevant verification suite.'],
];

function speakerRule(theme, label, colour, width, meta = '') {
  const mark = glyphs(theme);
  const head = theme.paint(`${mark.spine}${label} `, { fg: colour, bold: true });
  const tail = meta ? theme.paint(` ${meta}`, { fg: theme.roles.border }) : '';
  const filler = Math.max(0, width - visibleWidth(head) - visibleWidth(tail));
  return `${head}${theme.paint(repeat(theme.unicode ? '╌' : '-', filler), { fg: theme.roles.border })}${tail}`;
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
  for (const message of app.messages) {
    if (message.role === 'user') {
      lines.push(speakerRule(theme, ' OPERATOR ', theme.palette.gold, width, app.stamp(message.created_at)));
      for (const piece of wrap(String(message.content || ''), width - 2)) {
        lines.push(theme.paint(`${mark.spine} `, { fg: theme.palette.gold }) + theme.paint(piece, { fg: theme.roles.text }));
      }
      lines.push('');
      continue;
    }
    if (message.role === 'assistant') {
      if (!String(message.content || '').trim()) continue;
      lines.push(speakerRule(theme, ' MASKSHIFT ', theme.palette.crimson, width, message.meta?.modelRef || ''));
      lines.push(...renderMarkdown(theme, message.content, width));
      lines.push('');
      continue;
    }
    if (message.role === 'tool') {
      lines.push(...toolLine(theme, message, width, app.expandTools));
      continue;
    }
  }
  for (const entry of app.liveTrail) {
    lines.push(...entry.render(theme, width, app));
  }
  return lines;
}

function emptyState(app, width, height) {
  const { theme } = app;
  const mark = glyphs(theme);
  const lines = [];
  const hero = heroBlock(theme, width);
  const art = maskArt(theme);
  const artBlock = art.map((line) => center(line, width));
  const block = height > hero.length + art.length + 10 ? [...artBlock, '', ...hero] : hero;
  const pad = Math.max(0, Math.floor((height - block.length - 8) / 2));
  for (let index = 0; index < pad; index += 1) lines.push('');
  lines.push(...block);
  lines.push('');
  lines.push(center(theme.paint('TOTAL ARSENAL ACCESS  ·  SUMMONED ONLY WHEN NEEDED', { fg: theme.roles.muted }), width));
  lines.push('');
  for (const [index, [label, prompt]] of STARTERS.entries()) {
    const key = theme.paint(` F${index + 1} `, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true });
    const body = theme.paint(` ${label}`, { fg: theme.palette.gold, bold: true })
      + theme.paint(`  ${truncate(prompt, Math.max(10, width - visibleWidth(label) - 16))}`, { fg: theme.roles.border });
    lines.push(fit(`  ${key}${body}`, width));
  }
  return lines;
}

export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  const composerRows = Math.min(8, Math.max(3, app.composer.layout(width - 8, 8).total + 1));
  const composerHeight = composerRows + 2;
  const transcriptHeight = Math.max(4, height - composerHeight);
  const inner = width - 4;

  const body = app.messages.length === 0 && app.liveTrail.length === 0
    ? emptyState(app, inner - 1, transcriptHeight - 2)
    : transcriptLines(app, inner - 1);

  app.transcript.set(body);
  const visible = app.transcript.render(transcriptHeight - 2, inner - 1);
  const bar = app.transcript.scrollbar(theme, transcriptHeight - 2);
  const merged = visible.map((line, index) => `${line}${bar[index] ?? ' '}`);

  const stamp = app.transcript.stick
    ? `${app.messages.length} msg`
    : `${Math.round((app.transcript.offset / Math.max(1, body.length)) * 100)}%`;

  const transcript = panel({
    theme, width, height: transcriptHeight, title: 'TRANSCRIPT', index: '01',
    stamp, body: merged, focused: app.focus === 'transcript',
  });

  const layout = app.composer.layout(width - 8, composerRows);
  const mark = glyphs(theme);
  const composerBody = [];
  for (const [index, row] of layout.rows.entries()) {
    const gutter = index === 0
      ? theme.paint(`${mark.caret} `, { fg: app.busy ? theme.roles.border : theme.palette.crimson })
      : theme.paint('  ', { fg: theme.roles.border });
    const text = row === '' && index === 0 && !app.composer.value
      ? theme.paint(app.composerPlaceholder(), { fg: theme.roles.border, italic: true })
      : theme.paint(row, { fg: theme.roles.text });
    composerBody.push(fit(`${gutter}${text}`, width - 4));
  }
  while (composerBody.length < composerRows) composerBody.push('');
  const usage = Math.min(1, app.composer.value.length / 4000);
  composerBody.push(
    theme.paint(app.busy ? `${app.spinner.frame(theme)} EXECUTING` : 'READY', { fg: app.busy ? theme.palette.gold : theme.roles.success, bold: true })
    + theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border })
    + theme.paint(`${layout.total} line${layout.total === 1 ? '' : 's'}`, { fg: theme.roles.muted })
    + theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border })
    + meter(theme, usage, 1, Math.max(6, Math.min(24, width - 46)))
    + theme.paint(app.autoLoad ? '  AUTO-LOAD' : '  MANUAL', { fg: app.autoLoad ? theme.palette.cyanide : theme.roles.muted }),
  );

  const composer = panel({
    theme, width, height: composerHeight + 1, title: 'COMPOSER', index: app.busy ? '••' : '↵',
    stamp: app.busy ? 'esc cancels' : 'ctrl+s executes', body: composerBody,
    focused: app.focus === 'composer',
  });

  const cursor = app.focus === 'composer'
    ? {
      row: region.row + transcriptHeight + 1 + layout.caret.row,
      column: region.column + 4 + layout.caret.column,
    }
    : null;

  return { lines: [...transcript, ...composer].slice(0, height), cursor };
}

export function handle(app, event) {
  const height = app.bodyRegion.height;
  if (app.focus === 'transcript') {
    if (app.transcript.handle(event, height - 8)) return true;
    if (event.name === 'tab') { app.focus = 'composer'; return true; }
    if (event.name === 't' && !event.ctrl) { app.expandTools = !app.expandTools; return true; }
    if (event.printable && !event.ctrl && !event.alt) { app.focus = 'composer'; app.composer.handle(event); return true; }
    return false;
  }

  if (event.name === 'tab' && !event.ctrl) { app.focus = 'transcript'; return true; }
  if (event.name === 'enter' && !event.alt && !event.ctrl) { void app.submitPrompt(); return true; }
  if (event.ctrl && event.name === 's') { void app.submitPrompt(); return true; }
  if (event.ctrl && event.name === 'j') { app.composer.insert('\n'); return true; }
  if (event.name === 'pageup' || event.name === 'pagedown') { app.transcript.handle(event, height - 8); return true; }
  if (/^f[1-3]$/.test(event.name) && app.messages.length === 0) {
    const starter = STARTERS[Number(event.name.slice(1)) - 1];
    if (starter) { app.composer.set(starter[1]); return true; }
  }
  return app.composer.handle(event);
}

export const hints = (app) => (app.focus === 'composer'
  ? [['↵', 'execute'], ['^J', 'newline'], ['tab', 'transcript'], ['^K', 'palette'], ['esc', app.busy ? 'cancel run' : 'menu']]
  : [['↑↓', 'scroll'], ['t', 'tool output'], ['tab', 'composer'], ['^K', 'palette'], ['?', 'help']]);

export const meta = { id: 'chat', index: '01', title: 'HEIST', shortcut: '1' };
