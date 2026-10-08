// The MaskShift wordmark and the other identity pieces used across the CLI and TUI.

import { glyphs } from './box.mjs';
import { center, fit, repeat, visibleWidth } from './text.mjs';

// The wordmark: a prompt, the name in a five-row block face, and a cursor. Same idea as the
// README banner (`> maskshift_`), drawn with full blocks so it reads as a terminal's own type.
const FACE = {
  '>': ['██   ', ' ██  ', '  ██ ', ' ██  ', '██   '],
  m: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  a: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  s: [' ████', '█    ', ' ███ ', '    █', '████ '],
  k: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  h: ['█    ', '█    ', '████ ', '█   █', '█   █'],
  i: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  f: [' ████', '█    ', '███  ', '█    ', '█    '],
  t: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  _: ['     ', '     ', '     ', '     ', '█████'],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

const WORD = ['>', ' ', 'm', 'a', 's', 'k', 's', 'h', 'i', 'f', 't', '_'];

function blockLines() {
  return [0, 1, 2, 3, 4].map((row) => WORD.map((ch) => FACE[ch][row]).join(' '));
}

const WORDMARK = blockLines();

// Compact mark for narrow terminals.
const COMPACT = ['> maskshift_'];

export function wordmark(theme, width) {
  const art = width >= visibleWidth(WORDMARK[0]) ? WORDMARK : COMPACT;
  if (!theme.unicode) return ['> maskshift_'];
  // The prompt chevron and the name in bright green, "shift" and the cursor a step lower, each row
  // fading a little toward the bottom like phosphor — all read from roles.
  return art.map((line, index) => theme.gradient(
    fit(line, Math.min(width, visibleWidth(line))),
    index < art.length / 2 ? theme.roles.heading : theme.roles.primary,
    index < art.length / 2 ? theme.roles.accent : theme.roles.accentDeep,
    { bold: true },
  ));
}

export const TAGLINE = 'A general-purpose agent harness for any model';
export const SUBTITLE = 'General-purpose agent harness';

/**
 * The front door.
 *
 * The wordmark is the one place a gradient is allowed: it is the identity, it
 * appears once, and it is gone the moment there is work on screen. The rule
 * beneath the tagline is set to the tagline's own width so the block reads as
 * one object rather than as a caption with a stray line under it.
 */
export function heroBlock(theme, width) {
  const mark = glyphs(theme);
  const lines = [];
  for (const line of wordmark(theme, width)) lines.push(center(line, width));
  lines.push('');
  // The tagline types itself out the first moment the interface is up (the clock is frozen for
  // captures and tests, which see it complete), with a block cursor riding the last character.
  const typed = theme.motion.frozen ? TAGLINE.length : Math.min(TAGLINE.length, Math.floor(theme.motion.elapsed / 28));
  const shown = TAGLINE.slice(0, typed);
  const tail = typed < TAGLINE.length ? theme.paint(mark.spineRight, { fg: theme.roles.primary }) : '';
  lines.push(center(theme.paint(shown, { fg: theme.roles.accent, bold: true }) + tail + ' '.repeat(Math.max(0, TAGLINE.length - typed - (tail ? 1 : 0))), width));
  lines.push(center(theme.paint(repeat(mark.tick, Math.min(width - 4, visibleWidth(TAGLINE))), { fg: theme.roles.borderStrong }), width));
  return lines;
}
