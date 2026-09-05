// MaskShift panel language: the "stencil card".
//
// Every surface in the TUI is a notched frame with an inset title tab on the
// top rail and an optional count stamped into the bottom rail. Focus is shown
// by promoting the frame from a hairline to a heavy crimson rule, so the eye
// always knows which panel owns the keyboard.

import { fit, padEnd, repeat, truncate, visibleWidth } from './text.mjs';

export const FRAMES = {
  unicode: {
    heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', tabL: '┫', tabR: '┣' },
    light: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', tabL: '┤', tabR: '├' },
    double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', tabL: '╣', tabR: '╠' },
  },
  ascii: {
    heavy: { tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '|', tabL: '|', tabR: '|' },
    light: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', tabL: '|', tabR: '|' },
    double: { tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '|', tabL: '|', tabR: '|' },
  },
};

export const MARKS = {
  unicode: {
    spine: '▌', spineRight: '▐', caret: '❯', bullet: '•', diamond: '◆', dot: '·',
    arrowRight: '›', arrowDown: '▾', arrowUp: '▴', check: '✓', cross: '✕', warn: '▲',
    meterFull: '█', meterHalf: '▌', meterEmpty: '░', shade: '▒',
    branch: '├', branchLast: '└', pipe: '│', tick: '─',
    lamp: '●', ring: '◍', slash: '╱', mask: '⬢', lock: '⬤',
  },
  ascii: {
    spine: '|', spineRight: '|', caret: '>', bullet: '*', diamond: '#', dot: '.',
    arrowRight: '>', arrowDown: 'v', arrowUp: '^', check: 'y', cross: 'x', warn: '!',
    meterFull: '#', meterHalf: '=', meterEmpty: '.', shade: ':',
    branch: '|', branchLast: '`', pipe: '|', tick: '-',
    lamp: 'o', ring: 'o', slash: '/', mask: '#', lock: '@',
  },
};

export function glyphs(theme) {
  return theme.unicode ? MARKS.unicode : MARKS.ascii;
}

export function frameSet(theme, weight = 'light') {
  return (theme.unicode ? FRAMES.unicode : FRAMES.ascii)[weight] || FRAMES.unicode.light;
}

// The top rail: corner, stub, notched title tab, filler, corner.
function topRail({ theme, width, chars, title, index, colour, focused }) {
  const paint = (text, options) => theme.paint(text, { fg: colour, ...options });
  if (!title) return paint(`${chars.tl}${repeat(chars.h, Math.max(0, width - 2))}${chars.tr}`);
  const label = index ? `${index} ${title}` : String(title);
  const tabWidth = Math.min(visibleWidth(label) + 2, Math.max(0, width - 6));
  const tabText = ` ${truncate(label, Math.max(0, tabWidth - 2))} `;
  const painted = focused
    ? theme.paint(tabText, { fg: theme.palette.ink, bg: colour, bold: true })
    : theme.paint(tabText, { fg: theme.palette.smoke, bold: true });
  const used = 2 + 1 + visibleWidth(tabText) + 1 + 1;
  return paint(`${chars.tl}${chars.h}${chars.tabL}`)
    + painted
    + paint(`${chars.tabR}${repeat(chars.h, Math.max(0, width - used))}${chars.tr}`);
}

// The bottom rail can carry a right-aligned stamp (a count, a path, a status).
function bottomRail({ theme, width, chars, stamp, colour }) {
  const paint = (text) => theme.paint(text, { fg: colour });
  if (!stamp) return paint(`${chars.bl}${repeat(chars.h, Math.max(0, width - 2))}${chars.br}`);
  const text = ` ${truncate(stamp, Math.max(0, width - 8))} `;
  const filler = Math.max(0, width - 4 - visibleWidth(text));
  return paint(`${chars.bl}${repeat(chars.h, filler)}`)
    + theme.paint(text, { fg: theme.palette.smoke })
    + paint(`${repeat(chars.h, 2)}${chars.br}`);
}

/**
 * Render a panel around pre-sized body lines.
 * Body lines should already be at most `width - 4` visible columns wide.
 */
export function panel({
  theme, width, height = null, title = '', index = '', stamp = '',
  body = [], focused = false, weight = null, colour = null, padding = 1,
}) {
  const chars = frameSet(theme, weight || (focused ? 'heavy' : 'light'));
  const edge = colour || (focused ? theme.roles.borderActive : theme.roles.border);
  const inner = Math.max(0, width - 2 - padding * 2);
  const lines = [topRail({ theme, width, chars, title, index, colour: edge, focused })];
  const vertical = theme.paint(chars.v, { fg: edge });
  const gutter = ' '.repeat(padding);
  const rows = height === null ? body : body.slice(0, Math.max(0, height - 2));
  for (const row of rows) lines.push(`${vertical}${gutter}${fit(row, inner)}${gutter}${vertical}`);
  if (height !== null) {
    while (lines.length < height - 1) lines.push(`${vertical}${gutter}${' '.repeat(inner)}${gutter}${vertical}`);
  }
  lines.push(bottomRail({ theme, width, chars, stamp, colour: edge }));
  return lines;
}

export function innerWidth(width, padding = 1) {
  return Math.max(0, width - 2 - padding * 2);
}

// A labelled divider used inside panels.
export function rule(theme, width, label = '', { colour = null } = {}) {
  const line = theme.unicode ? '─' : '-';
  const tone = colour || theme.roles.border;
  if (!label) return theme.paint(repeat(line, width), { fg: tone });
  const text = ` ${label} `;
  const lead = 2;
  const rest = Math.max(0, width - lead - visibleWidth(text));
  return theme.paint(repeat(line, lead), { fg: tone })
    + theme.paint(text, { fg: theme.roles.muted, bold: true })
    + theme.paint(repeat(line, rest), { fg: tone });
}

// A solid chip. Used for statuses, modes, and key hints.
export function badge(theme, text, { fg = null, bg = null, bold = true } = {}) {
  const background = bg || theme.roles.primary;
  return theme.paint(` ${text} `, { fg: fg || theme.palette.ink, bg: background, bold });
}

// An outlined chip that keeps the background transparent.
export function tag(theme, text, colour) {
  const mark = glyphs(theme);
  const tone = colour || theme.roles.muted;
  return theme.paint(`${mark.spine}`, { fg: tone }) + theme.paint(text, { fg: tone, bold: true });
}

// Horizontal meter, e.g. context usage or plan progress.
export function meter(theme, value, max, width, { colour = null, track = null } = {}) {
  const mark = glyphs(theme);
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const tone = colour || theme.roles.primary;
  return theme.paint(repeat(mark.meterFull, filled), { fg: tone })
    + theme.paint(repeat(mark.meterEmpty, Math.max(0, width - filled)), { fg: track || theme.roles.border });
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(theme, values, width, colour = null) {
  if (!theme.unicode) return theme.paint(repeat('.', Math.min(width, values.length)), { fg: colour || theme.roles.muted });
  const points = values.slice(-width);
  const max = Math.max(1, ...points);
  const text = points.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / max) * (SPARK.length - 1)))]).join('');
  return theme.paint(padEnd(text, width), { fg: colour || theme.roles.info });
}

// `⌘K` style key hint: bright key, muted label.
export function keyHint(theme, key, label) {
  return theme.paint(key, { fg: theme.roles.accent, bold: true })
    + theme.paint(` ${label}`, { fg: theme.roles.muted });
}

export function hintBar(theme, pairs, width) {
  const mark = glyphs(theme);
  const separator = theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border });
  return fit(pairs.map(([key, label]) => keyHint(theme, key, label)).join(separator), width);
}

// Two-column key/value row used by detail panes.
export function field(theme, label, value, width, labelWidth = 14) {
  return theme.paint(fit(label.toUpperCase(), labelWidth), { fg: theme.roles.muted })
    + fit(value, Math.max(0, width - labelWidth));
}
