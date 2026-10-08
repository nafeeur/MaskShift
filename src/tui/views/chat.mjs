// Chat — the transcript and the composer.
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

import path from 'node:path';
import { frameColour, glyphs, panel, rule } from '../box.mjs';
import { heroBlock } from '../brand.mjs';
import { diffLines, looksLikeDiff } from '../diff.mjs';
import { buildImagePreview, isImagePath } from '../image/render.mjs';
import { renderMarkdown } from '../markdown.mjs';
import { LAYER, Regions } from '../regions.mjs';
import { hexToRgb } from '../theme.mjs';
import { center, fit, oneLine, truncate, visibleWidth, wrap } from '../text.mjs';
import { CONTENT_OFFSET, SPACE } from '../tokens.mjs';
import { columns, gutter, key as typeKey, spread } from '../type.mjs';

const STARTERS = [
  ['Explore', 'Look through this workspace and summarize what is in it, what it is for, and what could be improved.'],
  ['Review changes', 'Review the current changes, fix any defects, add missing tests or checks, and run the relevant verification.'],
  ['Plan a task', 'Ask me what I want to get done, propose a short plan, and start on it once I agree.'],
];

const TOOL_NAME_WIDTH = 18;

/**
 * The speaker rail.
 *
 * `lead` is the row that names the speaker and takes the colour at full
 * strength; every other row of the turn gets the same rail softened toward the
 * panel, which groups the turn without fencing it in. The assistant's rail is
 * softened much further than the user's: the model's output is the page,
 * the user's input is the thing quoted onto it.
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
  // The left edge keeps a gutter's worth of margin before the speaker name;
  // the timestamp got none on the right, sitting one column off the frame
  // where every other line kept its full margin. Reserve the same column here.
  return fit(spread(head, tail, Math.max(0, width - 1)), width);
}

/**
 * A tool result is usually its return value JSON.stringified (see engine.mjs's
 * renderToolResult) — `browser_screenshot` and friends come back as
 * `{ file: "/abs/path/shot.png", ... }`. This is the same shape a tool that
 * just hands back a bare path would produce too, so both are recognised.
 */
export function detectImageResult(message, workspacePath) {
  if (message.role !== 'tool') return null;
  const raw = String(message.content || '').trim();
  let candidate = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') candidate = parsed.file || parsed.path || parsed.screenshot || parsed.image || null;
  } catch {
    if (isImagePath(raw)) candidate = raw;
  }
  if (typeof candidate !== 'string' || !isImagePath(candidate)) return null;
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspacePath, candidate);
}

/**
 * The unified diff behind a patch/diff tool's result — `fs_apply_patch`
 * never returns the diff itself (just `{applied, cwd}`), so it comes from
 * the *call* that produced this result instead, via `toolCallsById`
 * (built while walking the transcript in order — the assistant message
 * carrying that call always precedes its result). `file_diff`/`git_diff`
 * do return the diff, as one field of their own JSON result.
 */
export function detectDiffText(message, toolCallsById) {
  if (message.role !== 'tool') return null;
  const name = message.meta?.toolName;
  if (name === 'fs_apply_patch') {
    const patch = toolCallsById.get(message.meta?.toolCallId)?.args?.patch;
    return typeof patch === 'string' && patch.trim() ? patch : null;
  }
  if (name === 'file_diff' || name === 'git_diff') {
    try {
      const diff = JSON.parse(message.content)?.diff;
      return looksLikeDiff(diff) ? diff : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** A tool result is usually `JSON.stringify`d with no spacing — readable
 *  enough flattened onto one short line, but a wall of run-together tokens
 *  once it's long enough to wrap. Indented back out, it wraps at meaningful
 *  boundaries instead of an arbitrary column. Anything that isn't valid JSON
 *  (plain text, a stack trace) is returned exactly as the tool sent it. */
function prettyToolText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
  } catch { /* not JSON — show as sent */ }
  return text;
}

function wrappedDetailLines(theme, text, width, mark) {
  const lines = [];
  for (const raw of text.split('\n')) {
    for (const piece of wrap(raw, Math.max(8, width - 2))) {
      lines.push(gutter(theme) + theme.paint(`${mark.bar} `, { fg: theme.roles.border }) + theme.paint(piece, { fg: theme.roles.muted }));
    }
  }
  return lines;
}

// How many more wrapped detail lines one click on a collapsed/partly-expanded
// result reveals — a screenful-sized bite, not "everything at once". Read by
// app.mjs's toggleToolExpansion, the click handler that actually advances it.
export const TOOL_EXPAND_STEP = 8;

/**
 * A tool call: its outcome in the gutter, its name in a fixed column, its
 * result filling the rest. Fixed columns are what let a run of six calls read
 * as a table instead of as six unrelated sentences. A result too long for
 * that one row is truncated there with "…", same as it always was — but that
 * row (or, once expanded, the "N more — click to expand" line beneath it) is
 * a click target: press it and another `TOOL_EXPAND_STEP` lines of the result
 * unfold underneath, pretty-printed if it's JSON so it wraps at real
 * structural boundaries instead of an arbitrary column. Keep clicking and it
 * keeps growing until there's nothing left to reveal. `t` still expands (or
 * collapses) every call in the transcript at once, same as before.
 *
 * Returns `{ lines, triggerRow }` — `triggerRow` is the index into `lines`
 * the caller should register a click region on to advance this call's own
 * expansion, or null once there is nothing more this call could reveal.
 */
function toolLines(app, message, width, key, globalExpanded) {
  const { theme } = app;
  const mark = glyphs(theme);
  const name = message.meta?.toolName || 'tool';
  const failed = Boolean(message.meta?.isError);
  const tone = failed ? theme.roles.danger : theme.roles.success;
  const text = String(message.content || '');
  const nameWidth = Math.min(TOOL_NAME_WIDTH, Math.max(8, width - 12));
  const resultWidth = Math.max(6, width - nameWidth - SPACE.columnGap);
  const flat = oneLine(text);
  const fitsInline = visibleWidth(flat) <= resultWidth;
  const shown = globalExpanded ? Infinity : (app.toolExpansion.get(key) || 0);

  const head = gutter(theme, failed ? mark.cross : mark.check, { tone })
    + columns(theme, [
      { text: name.startsWith('shell_') ? `$ ${name}` : name, width: nameWidth, tone: theme.roles.tool, bold: true },
      {
        text: fitsInline ? flat : (shown > 0 ? '' : oneLine(text, resultWidth)),
        tone: failed ? theme.roles.danger : theme.roles.dim,
      },
    ], width);

  const lines = [fit(head, width + SPACE.gutter)];
  if (fitsInline) return { lines, triggerRow: null };
  if (shown === 0) return { lines, triggerRow: 0 };

  const detail = wrappedDetailLines(theme, prettyToolText(text), width, mark);
  const visible = Math.min(detail.length, shown);
  lines.push(...detail.slice(0, visible));
  if (visible >= detail.length) return { lines, triggerRow: null };
  lines.push(gutter(theme) + theme.paint(`… ${detail.length - visible} more — click to expand`, { fg: theme.roles.faint, italic: true }));
  return { lines, triggerRow: lines.length - 1 };
}

// Rendering a whole transcript — every persisted message's markdown, freshly parsed — is not
// cheap, and transcriptLines() runs on every repaint. During a streaming reply that can be over
// a dozen times a second, and until now it meant re-rendering the *entire* history behind a
// growing bubble on every single one of those, even though nothing about it had changed. This
// caches the persisted-message portion, keyed on `app.messages`'s own identity (reassigned, not
// mutated, whenever it actually changes — see onRunEvent) and the render width, so a repaint
// triggered by nothing but a new streaming delta reuses that work and only builds the small,
// genuinely-changing tail (the in-progress bubble and any live tool-call rows).
const CHAT_IMAGE_MAX_ROWS = 16;

function buildMessageLines(app, theme, text) {
  const lines = [];
  const imageBlocks = [];
  // One entry per tool call whose result has more to reveal than its
  // current expansion shows — the row within `lines` a click should land on
  // to advance it. Read by registerRegions below.
  const toolTriggers = [];
  // Populated as every assistant message is walked (including one with no
  // prose of its own, just tool calls) so that by the time a 'tool' message
  // is reached, the call that produced it — and its original arguments,
  // which a result alone doesn't carry — is already known.
  const toolCallsById = new Map();
  let previousKind = null;
  const openBlock = (kind) => {
    if (lines.length && !(kind === 'tool' && previousKind === 'tool')) lines.push('');
    previousKind = kind;
  };

  // Where the session's saved summary ends (see engine.mjs). Everything above it no longer
  // reaches the model verbatim, so the transcript says so at that exact point instead of letting
  // the model's later "forgetfulness" look like a bug.
  const summarizedThrough = app.compaction?.summary ? app.compaction.throughMessageId : null;
  const summaryIndex = summarizedThrough ? app.messages.findIndex((message) => message.id === summarizedThrough) : -1;
  let summaryRow = null;
  const pushSummaryMarker = (count) => {
    if (lines.length) lines.push('');
    summaryRow = lines.length;
    lines.push(summaryMarker(theme, text, count));
    previousKind = 'marker';
  };
  if (summarizedThrough && summaryIndex < 0) pushSummaryMarker(null);

  for (const [messageIndex, message] of app.messages.entries()) {
    if (messageIndex > 0 && messageIndex - 1 === summaryIndex) pushSummaryMarker(summaryIndex + 1);
    if (message.role === 'user') {
      openBlock('user');
      const colour = theme.roles.user;
      lines.push(rail(theme, colour, { lead: true })
        + speakerRow(theme, 'You', colour, text, {
          qualifier: message.meta?.source === 'steer' ? 'steered mid-run' : '',
          stamp: app.stamp(message.created_at),
        }));
      for (const piece of wrap(String(message.content || ''), text)) {
        lines.push(rail(theme, colour) + theme.paint(piece, { fg: theme.roles.text }));
      }
      continue;
    }

    if (message.role === 'assistant') {
      for (const call of message.meta?.toolCalls || []) toolCallsById.set(call.id, call);
      if (!String(message.content || '').trim()) continue;
      openBlock('assistant');
      const colour = theme.roles.primary;
      lines.push(rail(theme, colour, { lead: true })
        + speakerRow(theme, 'MaskShift', colour, text, {
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
      const key = message.meta?.toolCallId || message.id || `tool:${messageIndex}`;
      const startRow = lines.length;
      const built = toolLines(app, message, text, key, app.expandTools);
      lines.push(...built.lines);
      if (built.triggerRow !== null) toolTriggers.push({ row: startRow + built.triggerRow, key });
      // A screenshot (or any tool that hands back an image path) is worth
      // more inline than as another JSON blob — the same renderer that
      // powers the Files preview draws it straight into the transcript.
      const imagePath = app.workspace?.path ? detectImageResult(message, app.workspace.path) : null;
      if (imagePath) {
        const built = buildImagePreview(theme, imagePath, { maxCols: text, maxRows: CHAT_IMAGE_MAX_ROWS, hexToRgb });
        if (!built.error && built.lines.length) {
          const startLine = lines.length;
          lines.push(...built.lines.map((line) => gutter(theme) + line));
          if (built.overlay) imageBlocks.push({ startLine, rows: built.lines.length, overlay: built.overlay });
        }
      }
      // A patch is the actual change, not a description of one — showing it
      // colourised is what makes a run reviewable after the fact without
      // switching to Files and diffing the working tree by hand.
      const diffText = detectDiffText(message, toolCallsById);
      if (diffText) lines.push(...diffLines(theme, diffText, text));
      continue;
    }
  }
  if (summaryIndex === app.messages.length - 1 && summaryIndex >= 0) pushSummaryMarker(summaryIndex + 1);
  return { lines, lastKind: previousKind, imageBlocks, toolTriggers, summaryRow };
}

function summaryMarker(theme, width, count) {
  const mark = glyphs(theme);
  const label = ` ${count ? `${count} earlier message${count === 1 ? '' : 's'}` : 'Earlier messages'} summarized ${mark.dot} s to read `;
  const side = Math.max(2, Math.floor((width - visibleWidth(label)) / 2));
  const line = theme.unicode ? '─' : '-';
  const rule = (n) => theme.paint(line.repeat(Math.max(0, n)), { fg: theme.mixed(theme.roles.border, theme.roles.info, 0.6) });
  return rule(side) + theme.paint(label, { fg: theme.roles.info, bold: true }) + rule(width - side - visibleWidth(label));
}

export function transcriptLines(app, width) {
  const { theme } = app;
  const text = Math.max(8, width - SPACE.gutter);

  const cache = (app._transcriptCache ||= {
    messages: null, text: null, expandTools: null, toolExpansionVersion: null, compaction: null,
    lines: null, lastKind: null, imageBlocks: [], toolTriggers: [], summaryRow: null,
  });
  if (cache.messages !== app.messages || cache.text !== text || cache.compaction !== app.compaction
    || cache.expandTools !== app.expandTools || cache.toolExpansionVersion !== app.toolExpansionVersion) {
    const built = buildMessageLines(app, theme, text);
    cache.messages = app.messages;
    cache.text = text;
    cache.expandTools = app.expandTools;
    cache.toolExpansionVersion = app.toolExpansionVersion;
    cache.lines = built.lines;
    cache.lastKind = built.lastKind;
    cache.imageBlocks = built.imageBlocks;
    cache.toolTriggers = built.toolTriggers;
    cache.summaryRow = built.summaryRow;
    cache.compaction = app.compaction;
  }
  app._transcriptSummaryRow = cache.summaryRow;
  // Read by render() below, once it knows which of these logical lines the
  // transcript's current scroll position actually has on screen.
  app._transcriptToolTriggers = cache.toolTriggers;
  app._transcriptImageBlocks = cache.imageBlocks;
  const lines = cache.lines.slice();
  let previousKind = cache.lastKind;

  const openBlock = (kind) => {
    if (lines.length && !(kind === 'tool' && previousKind === 'tool')) lines.push('');
    previousKind = kind;
  };

  // The turn in progress: not a message yet (it becomes one, and this block simply stops
  // rendering, the instant `run.assistant` lands and `app.messages` reloads with it), but shown
  // exactly like one — same speaker row, same markdown — with a caret standing in for the
  // timestamp a finished message would carry, to read as "still being written" rather than done.
  if (app.streamingText) {
    openBlock('assistant');
    const colour = theme.roles.primary;
    const mark = glyphs(theme);
    lines.push(rail(theme, colour, { lead: true })
      + speakerRow(theme, 'MaskShift', colour, text, { qualifier: app.modelRef || '' }));
    const body = renderMarkdown(theme, app.streamingText, text);
    // A block cursor that blinks on a one-second beat (solid whenever the clock is frozen).
    const blinkOn = theme.motion.frozen || theme.motion.phase(1000) < 0.6;
    const cursor = theme.paint(mark.spineRight, { fg: blinkOn ? colour : theme.roles.surface });
    body.forEach((piece, index) => {
      const isLast = index === body.length - 1;
      lines.push(rail(theme, colour, { weight: 0.14 }) + (isLast && visibleWidth(piece) < text ? piece + cursor : piece));
      if (isLast && visibleWidth(piece) >= text) lines.push(rail(theme, colour, { weight: 0.14 }) + cursor);
    });
    if (!body.length) lines.push(rail(theme, colour, { weight: 0.14 }) + cursor);
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
  const block = heroBlock(theme, width);
  const chrome = STARTERS.length + 3;
  const pad = Math.max(0, Math.floor((height - block.length - chrome) / 2));
  for (let index = 0; index < pad; index += 1) lines.push('');
  lines.push(...block);
  lines.push('');
  lines.push(center(theme.paint(
    `${app.counts.tools} tools  ${mark.dot}  ${app.counts.skills} skills  ${mark.dot}  ${app.counts.mcp} MCP servers  ${mark.dot}  loaded only when needed`,
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

  // Frame + seam is three rows; the composer takes what it needs from the
  // rest. No blank row between the seam and the draft — every other labelled
  // divider in the app (the rail's section row, a pane's own title rule) sits
  // directly above its content with no gap, and a pad row here just read as
  // dead space above the caret while starving the transcript of a row.
  const composerWidth = Math.max(8, width - 6);
  const draftRows = app.composer.layout(composerWidth, 6).total;
  const draftVisibleRows = Math.max(1, Math.min(6, draftRows, Math.max(1, height - 8)));
  const composerRows = draftVisibleRows;
  // A pending question (a choice, a confirmation, a tool approval) sits between the transcript and
  // the composer and takes the rows it needs from the transcript while it is open.
  const promptView = app.prompt && !app.prompt.answered
    ? app.prompt.render(app, width - 4, Math.max(5, Math.min(18, height - 8)))
    : null;
  const promptRows = promptView ? promptView.lines.length : 0;
  const transcriptHeight = Math.max(1, height - 3 - composerRows - promptRows);

  // One column of scrollbar and one of breathing room sit to the right of the
  // text, so nothing ever butts against the track.
  const inner = width - 4;
  const textWidth = Math.max(8, inner - 2);

  const isEmpty = app.messages.length === 0 && app.liveTrail.length === 0;
  if (isEmpty) app._transcriptImageBlocks = [];
  const body = isEmpty ? emptyState(app, textWidth, transcriptHeight) : transcriptLines(app, textWidth);

  app.transcript.set(body);
  const visible = app.transcript.render(transcriptHeight, textWidth);
  const bar = app.transcript.scrollbar(theme, transcriptHeight);
  const transcriptRows = visible.map((line, index) => `${fit(line, textWidth + 1)}${bar[index] ?? ' '}`);

  // A classic Kitty/iTerm2 placement (see image/render.mjs) floats above the text, so it only goes
  // out when its whole block is on screen at once — half of one cannot be clipped. A placeholder
  // image (Kitty, Ghostty) is ordinary text and clips like any other line, so every block that
  // shows even one row needs its picture transmitted. A half-block image needs nothing at all.
  const scrollOffset = app.transcript.offset;
  const imageOverlay = [];
  for (const block of app._transcriptImageBlocks || []) {
    const end = block.startLine + block.rows;
    if (block.overlay.protocol === 'kitty-unicode') {
      if (end > scrollOffset && block.startLine < scrollOffset + transcriptHeight) imageOverlay.push(block.overlay);
    } else if (!imageOverlay.length && block.startLine >= scrollOffset && end <= scrollOffset + transcriptHeight) {
      imageOverlay.push({
        ...block.overlay,
        row: region.row + 1 + (block.startLine - scrollOffset),
        column: region.column + CONTENT_OFFSET,
      });
    }
  }

  // The rail reports where you are when you have scrolled away from the live
  // edge, and how much there is when you have not.
  const scrolled = !app.transcript.stick && body.length > transcriptHeight;
  const note = scrolled
    ? `${mark.arrowUp} ${Math.round((app.transcript.offset / Math.max(1, body.length - transcriptHeight)) * 100)}%`
    : `${app.messages.length} message${app.messages.length === 1 ? '' : 's'}`;

  // The seam labels the composer and carries its keys, so the pane that owns
  // the keyboard is named on the rule that bounds it.
  const composerFocused = app.focus === 'composer' && !promptView;
  const paneFocused = composerFocused || app.focus === 'transcript';
  // No text label here: the seam's rule line already sweeps/animates while
  // busy (see `busy` in rule()/fillRule() in box.mjs), so a word on top of it
  // would just repeat the same signal.
  const seamLabel = '';
  const seam = rule(theme, width - 2, seamLabel, {
    active: composerFocused,
    // The seam is part of the frame, so it carries the frame's weight.
    weight: paneFocused ? 'double' : 'square',
    colour: frameColour(theme, paneFocused),
    busy: app.busy,
    stamp: promptView
      ? 'answer the question above'
      : composerFocused
      ? (app.busy ? `^T steers ${mark.dot} ↵ queues ${mark.dot} esc cancels` : `↵ execute ${mark.dot} ^J newline`)
      : 'tab or click to type',
  });

  // One extra column beyond the usual gutter width, so the caret has more
  // breathing room before the draft text starts than a list row's marker does.
  const composerGutterWidth = SPACE.gutter + 1;
  const layout = app.composer.layout(composerWidth, draftVisibleRows);
  const composerBody = [];
  for (let index = 0; index < draftVisibleRows; index += 1) {
    const row = layout.rows[index];
    // The caret lives in the same gutter every other row in the pane uses, so
    // a draft lines up with the transcript above it.
    const marker = index === 0
      ? gutter(theme, mark.caret, { tone: app.busy ? theme.roles.muted : theme.roles.primary, width: composerGutterWidth })
      : gutter(theme, '', { width: composerGutterWidth });
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
  if (draftRows > draftVisibleRows) stampParts.push(`${draftRows} lines`);
  if (drafted > 1000) stampParts.push(`${Math.round((drafted / 4000) * 100)}% of budget`);
  if (!app.autoLoad) stampParts.push('Manual loading');

  // The tab strip already says which view this is; repeating "Chat" on the
  // rail directly beneath it stacked two identical chips one row apart. The
  // rail now carries the one thing the tab cannot: what this chat is about.
  const lines = panel({
    theme, width, height, title: app.sessionTitle || 'New chat', note,
    busy: app.busy && paneFocused,
    stamp: stampParts.join(` ${mark.dot} `),
    body: [...transcriptRows, ...(promptView ? promptView.lines : []), seam, ...composerBody],
    seamRows: [transcriptHeight + promptRows],
    focused: paneFocused,
  });

  // Keyboard scrolling needs the same page size the mouse wheel uses.
  app.chatPanes = { transcriptHeight, composerRows, promptRows };
  registerRegions(app, region, { transcriptHeight, composerRows, promptRows, textWidth, body });
  if (promptView) {
    for (const { offset, index } of promptView.hit) {
      app.regions.add({
        row: region.row + 1 + transcriptHeight + offset, column: region.column + 1, width: Math.max(0, region.width - 2), height: 1,
        id: `chat:prompt:${index}`, layer: LAYER.body + 2,
        onPress: (target) => { target.prompt?.activate(index); target.afterPromptChange(); },
      });
    }
  }

  const cursor = promptView
    ? (promptView.cursor ? { row: region.row + 1 + transcriptHeight + promptView.cursor.row, column: region.column + 2 + promptView.cursor.column } : null)
    : composerFocused
      ? {
        row: region.row + 1 + transcriptHeight + 1 + layout.caret.row,
        column: region.column + 2 + composerGutterWidth + layout.caret.column,
      }
      : null;

  return { lines, cursor, imageOverlay };
}

// Every pane, the scrollbar track and each starter prompt become click targets.
function registerRegions(app, region, { transcriptHeight, composerRows, promptRows = 0, textWidth, body }) {
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

  const seamRow = transcriptTop + transcriptHeight + promptRows;
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

  if (Number.isInteger(app._transcriptSummaryRow)) {
    const scroll = Number.isFinite(app.transcript.offset) ? app.transcript.offset : 0;
    const offset = app._transcriptSummaryRow - scroll;
    if (offset >= 0 && offset < transcriptHeight) {
      regions.add({
        row: transcriptTop + offset, column: region.column + 1, width: Math.max(0, textWidth), height: 1,
        id: 'chat:summary', layer: LAYER.body + 1,
        onPress: (target) => target.openSessionSummary(),
      });
    }
  }

  // A collapsed or partly-expanded tool result's trigger row (see toolLines)
  // is recorded as a position into the same logical buffer starterRows uses,
  // so it translates by the current scroll offset the same way.
  if (app._transcriptToolTriggers?.length) {
    const scroll = Number.isFinite(app.transcript.offset) ? app.transcript.offset : 0;
    for (const [index, trigger] of app._transcriptToolTriggers.entries()) {
      const offset = trigger.row - scroll;
      if (offset < 0 || offset >= transcriptHeight) continue;
      regions.add({
        row: transcriptTop + offset,
        column: region.column + 1,
        width: Math.max(0, textWidth),
        height: 1,
        id: `chat:tool-expand:${index}`,
        layer: LAYER.body + 1,
        onPress: (target) => target.toggleToolExpansion(trigger.key),
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
    if (event.name === 's' && !event.ctrl && app.compaction?.summary) { app.openSessionSummary(); return true; }
    if (event.printable && !event.ctrl && !event.alt) { app.focus = 'composer'; app.composer.handle(event); return true; }
    return false;
  }

  if (event.name === 'tab' && !event.ctrl) {
    // Complete to the top suggestion instead of leaving the composer, so the
    // command the suggestion panel is already showing is one keystroke away
    // rather than something the user has to keep typing out by hand.
    const matches = app.matchingSlashCommands();
    if (matches?.length) { app.composer.set(`/${matches[0].name} `); return true; }
    app.focus = 'transcript';
    return true;
  }
  if (event.ctrl && event.name === 't') { app.steerPrompt(); return true; }
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

export const hints = (app) => (app.prompt && !app.prompt.answered
  ? [['↵', 'answer'], ['esc', 'decline']]
  : app.focus === 'composer'
  ? [
    ...(app.busy
      ? [['↵', 'queue', (target) => void target.submitPrompt()], ['^T', 'steer now', (target) => target.steerPrompt()]]
      : [['↵', 'execute', (target) => void target.submitPrompt()]]),
    ['^J', 'newline', (target) => target.composer.insert('\n')],
    ['tab', 'transcript', (target) => { target.focus = 'transcript'; }],
    ['^K', 'palette', (target) => target.openPalette()],
    ['esc', app.busy ? 'cancel run' : 'menu', (target) => (target.busy ? target.cancelRun() : target.openPalette())],
  ]
  : [
    ['↑↓', 'scroll'],
    ['t', 'tool output', (target) => { target.expandTools = !target.expandTools; }],
    ...(app.compaction?.summary ? [['s', 'summary', (target) => target.openSessionSummary()]] : []),
    ['tab', 'composer', (target) => { target.focus = 'composer'; }],
    ['^K', 'palette', (target) => target.openPalette()],
    ['?', 'help', (target) => target.openHelp()],
  ]);

export const meta = { id: 'chat', index: '1', title: 'Chat', shortcut: '1' };
