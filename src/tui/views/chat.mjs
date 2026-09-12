// 01 HEIST — the transcript and the composer.
//
// The transcript is the densest surface in the product, and it was the one
// that read worst: a user turn's text began two columns right of the model's,
// the model's prose began one column left of its own name, and tool results
// began two columns right of both. Four left edges in one pane.
//
// Every row here is now built the same way — `SPACE.gutter` columns of marker
// followed by text — so a speaker rail, a status tick, a bullet and a
// paragraph all put their first character on the same column. The gutter also
// carries the only per-turn ornament: a rail in the speaker's colour, full
// strength on the row that names them and softened down the body.

import { frameColour, glyphs, panel, rule } from '../box.mjs';
import { MASK_WIDTH, heroBlock, maskArt } from '../brand.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { spin } from '../motion.mjs';
import { LAYER, Regions } from '../regions.mjs';
import { center, fit, oneLine, truncate, visibleWidth, wrap } from '../text.mjs';
import { SPACE } from '../tokens.mjs';
import { columns, gutter, key as typeKey, spread } from '../type.mjs';

const STARTERS = [
  ['CASE THE REPO', 'Map this repository, identify architectural risks, and propose the highest-impact improvements.'],
  ['HUNT & ELIMINATE', 'Find the most important broken or incomplete feature, implement it fully, and verify the result.'],
  ['REVIEW THE TAKE', 'Review the current Git changes, repair defects, add missing tests, and run the relevant verification suite.'],
];

const TOOL_NAME_WIDTH = 18;

/**
 * The speaker rail.
 *
 * `lead` is the row that names the speaker and takes the colour at full
 * strength; every other row of the turn gets the same rail softened toward the
 * panel, which groups the turn without fencing it in. The assistant's rail is
 * softened much further than the operator's: the model's output is the page,
 * the operator's input is the thing quoted onto it.
 */
function rail(theme, colour, { lead = false, weight = 0.35 } = {}) {
  const mark = glyphs(theme);
  return lead
    ? gutter(theme, mark.spine, { tone: colour })
    : gutter(theme, mark.bar, { tone: theme.soften(colour, weight) });
}

/** `SPEAKER · qualifier` on the left, a timestamp on the right. */
function speakerRow(theme, name, colour, width, { qualifier = '', stamp = '' } = {}) {
  const mark = glyphs(theme);
  const head = theme.paint(name, { fg: colour, bold: true })
    + (qualifier
      ? theme.paint(` ${mark.dot} ${truncate(qualifier, Math.max(0, width - name.length - 12))}`, { fg: theme.roles.muted })
      : '');
  const tail = stamp ? theme.paint(stamp, { fg: theme.roles.faint }) : '';
  return spread(head, tail, width);
}

/**
 * A tool call: its outcome in the gutter, its name in a fixed column, its
 * result filling the rest. Fixed columns are what let a run of six calls read
 * as a table instead of as six unrelated sentences.
 */
function toolLines(app, message, width, expanded) {
  const { theme } = app;
  const mark = glyphs(theme);
  const name = message.meta?.toolName || 'tool';
  const failed = Boolean(message.meta?.isError);
  const tone = failed ? theme.roles.danger : theme.roles.success;
  const text = String(message.content || '');

  const head = gutter(theme, failed ? mark.cross : mark.check, { tone })
    + columns(theme, [
      { text: name, width: Math.min(TOOL_NAME_WIDTH, Math.max(8, width - 12)), tone: theme.roles.tool, bold: true },
      { text: oneLine(text, Math.max(6, width - TOOL_NAME_WIDTH - SPACE.columnGap)), tone: failed ? theme.roles.danger : theme.roles.dim },
    ], width);

  const lines = [fit(head, width + SPACE.gutter)];
  if (!expanded) return lines;
  for (const raw of text.split('\n').slice(0, 60)) {
    for (const piece of wrap(raw, Math.max(8, width - 2))) {
      lines.push(gutter(theme) + theme.paint(`${mark.bar} `, { fg: theme.roles.border }) + theme.paint(piece, { fg: theme.roles.muted }));
    }
  }
  return lines;
}

export function transcriptLines(app, width) {
  const { theme } = app;
  const text = Math.max(8, width - SPACE.gutter);
  const lines = [];
  let previousKind = null;

  // One blank line *before* each block rather than after, so the transcript
  // never ends on trailing whitespace and every gap is the same height. Two
  // adjacent tool calls are a single block: they belong to one another, and
  // padding between them turned a six-step run into a page of whitespace.
  const openBlock = (kind) => {
    if (lines.length && !(kind === 'tool' && previousKind === 'tool')) lines.push('');
    previousKind = kind;
  };

  for (const message of app.messages) {
    if (message.role === 'user') {
      openBlock('user');
      const colour = theme.roles.user;
      lines.push(rail(theme, colour, { lead: true })
        + speakerRow(theme, 'OPERATOR', colour, text, { stamp: app.stamp(message.created_at) }));
      for (const piece of wrap(String(message.content || ''), text)) {
        lines.push(rail(theme, colour) + theme.paint(piece, { fg: theme.roles.text }));
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (!String(message.content || '').trim()) continue;
      openBlock('assistant');
      const colour = theme.roles.primary;
      lines.push(rail(theme, colour, { lead: true })
        + speakerRow(theme, 'MASKSHIFT', colour, text, {
          qualifier: message.meta?.modelRef || '',
          stamp: app.stamp(message.created_at),
        }));
      for (const piece of renderMarkdown(theme, message.content, text)) {
        lines.push(rail(theme, colour, { weight: 0.14 }) + piece);
      }
      continue;
    }

    if (message.role === 'tool') {
      openBlock('tool');
      lines.push(...toolLines(app, message, text, app.expandTools));
      continue;
    }
  }

  for (const entry of app.liveTrail) {
    if (lines.length) lines.push('');
    previousKind = 'live';
    lines.push(...entry.render(theme, text, app));
  }
  return lines;
}

/**
 * The idle screen.
 *
 * It is the first thing anyone sees, so it does exactly three things: say what
 * this is, say what it can reach, and offer three ways in. The starters are
 * laid out on fixed columns so the key, the name and the description form
 * three straight edges rather than three ragged ones.
 */
function emptyState(app, width, height) {
  const { theme } = app;
  const mark = glyphs(theme);
  const lines = [];
  const hero = heroBlock(theme, width);
  const art = width >= MASK_WIDTH ? maskArt(theme) : [];
  const artBlock = art.map((line) => center(line, width));
  const chrome = STARTERS.length + 3;
  const block = art.length && height > hero.length + art.length + chrome + 4 ? [...artBlock, '', ...hero] : hero;
  const pad = Math.max(0, Math.floor((height - block.length - chrome) / 2));
  for (let index = 0; index < pad; index += 1) lines.push('');
  lines.push(...block);
  lines.push('');
  lines.push(center(theme.paint(
    `${app.counts.tools} TOOLS  ${mark.dot}  ${app.counts.skills} SKILLS  ${mark.dot}  ${app.counts.mcp} MCP SERVERS  ${mark.dot}  SUMMONED ONLY WHEN NEEDED`,
    { fg: theme.roles.muted },
  ), width));
  lines.push('');

  // Remembered so the click zones land on the same rows the keys do.
  app.starterRows = [];
  const labelWidth = Math.max(...STARTERS.map(([label]) => visibleWidth(label)));
  // One centred block, sized once: the key, the name and the description then
  // form three straight edges under a centred wordmark instead of a short
  // ragged column adrift in the middle of the pane.
  const strip = Math.min(Math.max(52, width - 8), 96);
  const indent = Math.max(0, Math.floor((width - strip) / 2));
  const keyWidth = 2;
  for (const [index, [label, prompt]] of STARTERS.entries()) {
    const body = typeKey(theme, `F${index + 1}`)
      + '  ' + columns(theme, [
        { text: label, width: labelWidth, tone: theme.roles.text, bold: true },
        { text: prompt, tone: theme.roles.muted },
      ], Math.max(10, strip - keyWidth - 2));
    app.starterRows.push(lines.length);
    lines.push(fit(`${' '.repeat(indent)}${body}`, width));
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

  // The rail reports where you are when you have scrolled away from the live
  // edge, and how much there is when you have not.
  const scrolled = !app.transcript.stick && body.length > transcriptHeight;
  const note = scrolled
    ? `${mark.arrowUp} ${Math.round((app.transcript.offset / Math.max(1, body.length - transcriptHeight)) * 100)}%`
    : `${app.messages.length} MESSAGES`;

  // The seam labels the composer and carries its keys, so the pane that owns
  // the keyboard is named on the rule that bounds it.
  const composerFocused = app.focus === 'composer';
  const paneFocused = composerFocused || app.focus === 'transcript';
  const seamLabel = app.busy ? `${spin(theme, 'dots')} EXECUTING` : 'COMPOSER';
  const seam = rule(theme, width - 2, seamLabel, {
    active: composerFocused,
    // The seam is part of the frame, so it carries the frame's weight.
    weight: paneFocused ? 'heavy' : 'light',
    colour: frameColour(theme, paneFocused),
    busy: app.busy,
    stamp: composerFocused
      ? (app.busy ? `esc cancels ${mark.dot} ↵ queues` : `↵ execute ${mark.dot} ^J newline`)
      : 'tab or click to type',
  });

  const layout = app.composer.layout(composerWidth, composerRows);
  const composerBody = [];
  for (let index = 0; index < composerRows; index += 1) {
    const row = layout.rows[index];
    // The caret lives in the same gutter every other row in the pane uses, so
    // a draft lines up with the transcript above it.
    const marker = index === 0
      ? gutter(theme, mark.caret, { tone: app.busy ? theme.roles.muted : theme.roles.primary })
      : gutter(theme);
    const text = index === 0 && !app.composer.value
      ? theme.paint(truncate(app.composerPlaceholder(), composerWidth), { fg: theme.roles.muted, italic: true })
      : theme.paint(row ?? '', { fg: theme.roles.text });
    composerBody.push(fit(`${marker}${text}`, inner));
  }

  // The old footer row carried an always-empty character meter. The same
  // information now costs no rows at all: it appears in the bottom stamp, and
  // only once the draft is long enough for the budget to matter.
  const drafted = app.composer.value.length;
  const stampParts = [];
  if (draftRows > composerRows) stampParts.push(`${draftRows} lines`);
  if (drafted > 1000) stampParts.push(`${Math.round((drafted / 4000) * 100)}% of budget`);
  if (!app.autoLoad) stampParts.push('MANUAL LOAD');

  // The tab strip already says which view this is; repeating "01 HEIST" on the
  // rail directly beneath it stacked two identical chips one row apart. The
  // rail now carries the one thing the tab cannot: what this session is about.
  const lines = panel({
    theme, width, height, title: app.sessionTitle || 'NEW SESSION', note,
    busy: app.busy && paneFocused,
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
