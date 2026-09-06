// The MaskShift panel language.
//
// Every surface is a framed card with a quiet label on its top rail and an
// optional stamp on its bottom one. Two rules hold the language together:
//
//   1. A pane's frame states focus and nothing else. Focus is a warm, dark
//      line — not a saturated box. An earlier revision drew a full crimson
//      heavy frame around whichever pane held the keyboard, which put the
//      loudest thing on screen around the thing the operator was already
//      looking at.
//
//   2. A rail label is text, never a filled chip. The one filled chip in the
//      interface belongs to the active view tab; when panels drew one too,
//      three chips stacked in the top-left corner and the eye had no idea
//      which of them meant "you are here".

import { fit, padEnd, repeat, truncate, visibleWidth } from './text.mjs';
import { sweepLine } from './motion.mjs';
import { SPACE } from './tokens.mjs';
import { chip, label as typeLabel, pill } from './type.mjs';

export const FRAMES = {
  unicode: {
    heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', tabL: '┫', tabR: '┣' },
    light: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', tabL: '┤', tabR: '├' },
    square: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', tabL: '┤', tabR: '├' },
    double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', tabL: '╣', tabR: '╠' },
  },
  ascii: {
    heavy: { tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '|', tabL: '|', tabR: '|' },
    light: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', tabL: '|', tabR: '|' },
    square: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', tabL: '|', tabR: '|' },
    double: { tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '|', tabL: '|', tabR: '|' },
  },
};

export const MARKS = {
  unicode: {
    spine: '▌', spineRight: '▐', bar: '│', caret: '❯', dot: '·',
    bullet: '•', dash: '–', diamond: '◆',
    arrowRight: '›', arrowDown: '▾', arrowUp: '▴',
    check: '✓', cross: '✕', warn: '▲', ring: '○', lamp: '●',
    meterFull: '━', meterEmpty: '─', shade: '░',
    branch: '├', branchLast: '└', pipe: '│', tick: '─', rule: '╌',
    slash: '╱', mask: '⬢', lock: '⬤', search: '⌕',
  },
  ascii: {
    spine: '|', spineRight: '|', bar: '|', caret: '>', dot: '.',
    bullet: '*', dash: '-', diamond: '#',
    arrowRight: '>', arrowDown: 'v', arrowUp: '^',
    check: 'y', cross: 'x', warn: '!', ring: 'o', lamp: 'o',
    meterFull: '=', meterEmpty: '-', shade: ':',
    branch: '|', branchLast: '`', pipe: '|', tick: '-', rule: '-',
    slash: '/', mask: '#', lock: '@', search: '/',
  },
};

export function glyphs(theme) {
  return theme.unicode ? MARKS.unicode : MARKS.ascii;
}

export function frameSet(theme, weight = 'light') {
  return (theme.unicode ? FRAMES.unicode : FRAMES.ascii)[weight] || FRAMES.unicode.light;
}

/**
 * The colour of a pane's frame.
 *
 * Unfocused panes recede to a hairline. A focused pane's frame is the border
 * carried toward the *deep* end of the brand, not toward the accent: a frame
 * mixed with full crimson traces a bright pink rectangle around whatever the
 * operator is already looking at, which made the border the loudest element on
 * every screen. Dark red says "this one" without saying it twice.
 */
export function frameColour(theme, focused) {
  return focused
    ? theme.mixed(theme.roles.border, theme.roles.primaryDeep, 0.55)
    : theme.roles.border;
}

/**
 * The top rail: corner, stub, label, filler, right-aligned note, corner.
 *
 * `busy` runs a highlight along the filler while work is in flight, which is
 * the only place in the interface where a border moves. It reads as the pane
 * doing something, and it costs no rows.
 */
function topRail({ theme, width, chars, title, titleRaw, colour, focused, note = '', busy = false }) {
  const paint = (text) => theme.paint(text, { fg: colour });
  const lead = paint(`${chars.tl}${chars.h}`);
  const tail = paint(`${chars.h}${chars.tr}`);
  if (!title && !titleRaw && !note) {
    return lead + fillRule({ theme, chars, colour, width: Math.max(0, width - 4), busy }) + tail;
  }

  // `titleRaw` lets a pane put something interactive on its own top rail — a
  // section switcher, say — instead of spending a body row on it and leaving
  // the rail empty above.
  // The frame already says which pane holds the keyboard. A crimson title on
  // top of it says it a second time, in the one colour the active view tab is
  // using two rows above.
  const head = titleRaw
    ? ` ${titleRaw} `
    : (title
      ? ` ${typeLabel(theme, truncate(title, Math.max(1, width - 12)), { tone: focused ? theme.roles.text : theme.roles.muted })} `
      : '');
  const room = Math.max(0, width - visibleWidth(head) - 8);
  const stamp = note && room > 2 ? ` ${theme.paint(truncate(note, room), { fg: theme.roles.muted })} ` : '';
  const filler = Math.max(0, width - 4 - visibleWidth(head) - visibleWidth(stamp));
  return lead + head + fillRule({ theme, chars, colour, width: filler, busy }) + stamp + tail;
}

function fillRule({ theme, chars, colour, width, busy }) {
  if (width <= 0) return '';
  if (!busy) return theme.paint(repeat(chars.h, width), { fg: colour });
  return sweepLine(theme, chars.h, width, {
    base: colour,
    highlight: theme.roles.borderActive,
    phase: theme.motion.phase(1600),
  });
}

/** The bottom rail, carrying an optional right-aligned stamp. */
function bottomRail({ theme, width, chars, stamp, colour }) {
  const paint = (text) => theme.paint(text, { fg: colour });
  if (!stamp) return paint(`${chars.bl}${repeat(chars.h, Math.max(0, width - 2))}${chars.br}`);
  const text = ` ${theme.paint(truncate(stamp, Math.max(0, width - 8)), { fg: theme.roles.muted })} `;
  const filler = Math.max(0, width - 3 - visibleWidth(text));
  return paint(`${chars.bl}${repeat(chars.h, filler)}`) + text + paint(`${chars.h}${chars.br}`);
}

/**
 * Render a panel around pre-sized body lines.
 * Body lines should already be at most `width - 2 - padding * 2` columns wide.
 *
 * `seamRows` names body indices that are internal dividers: they are painted
 * edge to edge with junction glyphs instead of being inset by the gutter, so a
 * single panel can hold two panes without stacking two frames.
 */
export function panel({
  theme, width, height = null, title = '', titleRaw = '', stamp = '',
  body = [], focused = false, weight = null, colour = null, padding = SPACE.pad,
  seamRows = null, note = '', busy = false,
}) {
  const chars = frameSet(theme, weight || (focused ? 'heavy' : 'light'));
  const edge = colour || frameColour(theme, focused);
  const inner = Math.max(0, width - 2 - padding * 2);
  const lines = [topRail({ theme, width, chars, title, titleRaw, colour: edge, focused, note, busy })];
  const vertical = theme.paint(chars.v, { fg: edge });
  const gutter = ' '.repeat(padding);
  const seams = seamRows ? new Set(seamRows) : null;
  const rows = height === null ? body : body.slice(0, Math.max(0, height - 2));
  for (const [position, row] of rows.entries()) {
    if (seams?.has(position)) {
      lines.push(theme.paint(chars.tabR, { fg: edge })
        + fit(row, Math.max(0, width - 2))
        + theme.paint(chars.tabL, { fg: edge }));
      continue;
    }
    lines.push(`${vertical}${gutter}${fit(row, inner)}${gutter}${vertical}`);
  }
  if (height !== null) {
    while (lines.length < height - 1) lines.push(`${vertical}${gutter}${' '.repeat(inner)}${gutter}${vertical}`);
  }
  lines.push(bottomRail({ theme, width, chars, stamp, colour: edge }));
  return lines;
}

export function innerWidth(width, padding = SPACE.pad) {
  return Math.max(0, width - 2 - padding * 2);
}

/** Columns available to body text once the frame, padding and gutter are paid. */
export function contentWidth(width, padding = SPACE.pad) {
  return Math.max(0, innerWidth(width, padding) - SPACE.gutter);
}

/**
 * A labelled divider used inside panels and as a pane's opening rule.
 *
 * `stamp` is right-aligned on the same rule, so one row carries a section name
 * and its count without spending a second row on chrome.
 */
export function rule(theme, width, label = '', {
  colour = null, stamp = '', active = false, weight = 'light', busy = false,
} = {}) {
  const chars = frameSet(theme, weight);
  const tone = colour || theme.roles.border;
  if (!label && !stamp) return fillRule({ theme, chars, colour: tone, width, busy });

  const head = label ? ` ${typeLabel(theme, label, { tone: active ? theme.roles.text : theme.roles.muted })} ` : '';
  const tail = stamp
    ? ` ${theme.paint(truncate(stamp, Math.max(1, width - visibleWidth(head) - 6)), { fg: theme.roles.muted })} `
    : '';
  const lead = 2;
  const gap = Math.max(0, width - lead - visibleWidth(head) - visibleWidth(tail) - 2);
  return theme.paint(repeat(chars.h, lead), { fg: tone })
    + head
    + fillRule({ theme, chars, colour: tone, width: gap, busy })
    + tail
    + theme.paint(repeat(chars.h, 2), { fg: tone });
}

/**
 * A horizontal meter. Two tones of the same rule character rather than a bar
 * of solid blocks: it reads as a measurement instead of as a wall, and it sits
 * on the same optical weight as every other rule on screen.
 */
export function meter(theme, value, max, width, { colour = null, track = null } = {}) {
  const mark = glyphs(theme);
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = width > 0 ? Math.min(width, Math.round(ratio * width)) : 0;
  // The empty half of a meter has to be visible or the filled half reads as a
  // floating dash with no scale behind it.
  const tone = colour || theme.roles.primary;
  return theme.paint(repeat(mark.meterFull, filled), { fg: tone })
    + theme.paint(repeat(mark.meterEmpty, Math.max(0, width - filled)), { fg: theme.roles.borderStrong });
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(theme, values, width, colour = null) {
  if (!theme.unicode) return theme.paint(repeat('.', Math.min(width, values.length)), { fg: colour || theme.roles.muted });
  const points = values.slice(-width);
  const max = Math.max(1, ...points);
  const text = points.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / max) * (SPARK.length - 1)))]).join('');
  return theme.paint(padEnd(text, width), { fg: colour || theme.roles.info });
}

/** `⌘K` style key hint: bright key, muted label. */
export function keyHint(theme, key, label) {
  return theme.paint(key, { fg: theme.roles.accent, bold: true })
    + theme.paint(` ${label}`, { fg: theme.roles.muted });
}

export function hintBar(theme, pairs, width) {
  const mark = glyphs(theme);
  const separator = theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border });
  return fit(pairs.map(([key, label]) => keyHint(theme, key, label)).join(separator), width);
}

export { chip as badge, chip, pill };

/** An outlined marker used for a value that needs a colour but not a fill. */
export function tag(theme, text, colour) {
  const tone = colour || theme.roles.muted;
  return theme.paint(glyphs(theme).spine, { fg: tone }) + theme.paint(text, { fg: tone, bold: true });
}
