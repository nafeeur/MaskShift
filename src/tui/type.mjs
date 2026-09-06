// The type ramp.
//
// A terminal has one typeface, so hierarchy has to come from case, weight,
// colour and position instead. Four levels, and only four:
//
//   title     what this pane is            bold, chalk, upper
//   label     what this group is           upper, silver, regular
//   field     what this value is           upper, muted, fixed width
//   body      the thing itself             bone
//   meta      provenance, counts, times    smoke
//
// Chrome is upper case; content keeps whatever case its author wrote. That one
// rule is why the transcript no longer shouts a model's prose back in capitals
// while the panel around it stays quiet.

import { fit, padEnd, padStart, truncate, visibleWidth } from './text.mjs';
import { FIELD_LABEL_WIDTH, SPACE } from './tokens.mjs';

export function title(theme, text, { tone = null } = {}) {
  return theme.paint(String(text).toUpperCase(), { fg: tone || theme.roles.heading, bold: true });
}

export function label(theme, text, { tone = null } = {}) {
  return theme.paint(String(text).toUpperCase(), { fg: tone || theme.roles.label });
}

export function field(theme, text, width = FIELD_LABEL_WIDTH) {
  return theme.paint(fit(String(text).toUpperCase(), width), { fg: theme.roles.muted });
}

export function body(theme, text, { tone = null, bold = false } = {}) {
  return theme.paint(text, { fg: tone || theme.roles.text, bold });
}

export function meta(theme, text, { tone = null } = {}) {
  return theme.paint(text, { fg: tone || theme.roles.dim });
}

export function hint(theme, text) {
  return theme.paint(text, { fg: theme.roles.muted, italic: true });
}

/** A key the operator can press. Gold, everywhere, always. */
export function key(theme, text) {
  return theme.paint(text, { fg: theme.roles.accent, bold: true });
}

/**
 * The only solid-filled label in the interface, reserved for the one thing
 * that is currently selected in a strip of peers — the active view tab, the
 * active section. Using it anywhere else is what made every earlier screen
 * look like four things were selected at once.
 */
export function chip(theme, text, { tone = null } = {}) {
  return theme.paint(` ${text} `, {
    fg: theme.roles.onPrimary, bg: tone || theme.roles.primary, bold: true,
  });
}

/**
 * The unselected form: coloured text on the raised surface. Carries a value
 * (a count, a class, an access level) without competing with a real chip.
 */
export function pill(theme, text, { tone = null, surface = null } = {}) {
  return theme.paint(` ${text} `, {
    fg: tone || theme.roles.dim, bg: surface || theme.roles.surfaceRaised,
  });
}

/**
 * The alignment primitive.
 *
 * Every content row in every pane begins with exactly `SPACE.gutter` columns,
 * whether or not it has a marker to put there. A speaker rail, a status tick,
 * a bullet and a plain paragraph therefore all start their text on the same
 * column, which is the single change that took the ragged left edge out of the
 * transcript.
 */
export function gutter(theme, marker = '', { tone = null, width = SPACE.gutter } = {}) {
  if (!marker) return ' '.repeat(width);
  const painted = theme.paint(marker, { fg: tone || theme.roles.muted });
  return padEnd(painted, width);
}

/** `gutter + body`, clipped to `width`. */
export function row(theme, marker, text, { tone = null, width = null } = {}) {
  const line = `${gutter(theme, marker, { tone })}${text}`;
  return width === null ? line : fit(line, width);
}

/** A label/value pair on one aligned column, wrapping into the label's indent. */
export function pair(theme, name, value, width, { tone = null, labelWidth = FIELD_LABEL_WIDTH } = {}) {
  const room = Math.max(8, width - labelWidth);
  const text = String(value ?? '');
  return { label: field(theme, name, labelWidth), room, text, tone: tone || theme.roles.text };
}

/**
 * A tabular row. Cells are `{ text, width, align, tone, bold }`; a cell with no
 * width takes whatever is left. Views used to hand-roll these with bare `fit`
 * calls and drifting magic numbers, which is why no two lists lined up.
 */
export function columns(theme, cells, total, { gap = SPACE.columnGap } = {}) {
  const fixed = cells.filter((cell) => cell.width !== undefined);
  const flexible = cells.filter((cell) => cell.width === undefined);
  const gaps = gap * Math.max(0, cells.length - 1);
  const used = fixed.reduce((sum, cell) => sum + cell.width, 0) + gaps;
  const share = flexible.length ? Math.max(0, Math.floor((total - used) / flexible.length)) : 0;

  const parts = [];
  for (const cell of cells) {
    const width = cell.width === undefined ? share : cell.width;
    if (width <= 0) { parts.push(''); continue; }
    const painted = cell.tone || cell.bold
      ? theme.paint(truncate(cell.text ?? '', width), { fg: cell.tone, bold: cell.bold })
      : truncate(cell.text ?? '', width);
    parts.push(cell.align === 'right' ? padStart(painted, width) : padEnd(painted, width));
  }
  return fit(parts.join(' '.repeat(gap)), total);
}

/**
 * Right-align `tail` against `head` across `width`.
 *
 * When the two cannot both fit, the tail is dropped rather than pushing the
 * head off the end: the tail is always the secondary half of the pair — a
 * count, a timestamp, a stamp — and a truncated section switcher reading
 * "PLAN · LOADOUT · EVE…" is worse than one with no count beside it.
 */
export function spread(head, tail, width) {
  const headWidth = visibleWidth(head);
  const tailWidth = visibleWidth(tail);
  if (!tailWidth || headWidth + tailWidth + 1 > width) return fit(head, width);
  return `${head}${' '.repeat(width - headWidth - tailWidth)}${tail}`;
}
