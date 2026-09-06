// The MaskShift wordmark and other identity pieces used across CLI and TUI.

import { glyphs } from './box.mjs';
import { center, fit, repeat, visibleWidth } from './text.mjs';

// Full block wordmark for the CLI banner and the empty-state hero.
const WORDMARK = [
  '███╗   ███╗ █████╗ ███████╗██╗  ██╗███████╗██╗  ██╗██╗███████╗████████╗',
  '████╗ ████║██╔══██╗██╔════╝██║ ██╔╝██╔════╝██║  ██║██║██╔════╝╚══██╔══╝',
  '██╔████╔██║███████║███████╗█████╔╝ ███████╗███████║██║█████╗     ██║   ',
  '██║╚██╔╝██║██╔══██║╚════██║██╔═██╗ ╚════██║██╔══██║██║██╔══╝     ██║   ',
  '██║ ╚═╝ ██║██║  ██║███████║██║  ██╗███████║██║  ██║██║██║        ██║   ',
  '╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝        ╚═╝   ',
];

// Compact mark for narrow terminals.
const COMPACT = [
  '┌┬┐ ┌─┐ ┌─┐ ┬┌─ ┌─┐ ┬ ┬ ┬ ┌─┐ ┌┬┐',
  '│││ ├─┤ └─┐ ├┴┐ └─┐ ├─┤ │ ├┤   │ ',
  '┴ ┴ ┴ ┴ └─┘ ┴ ┴ └─┘ ┴ ┴ ┴ ┴    ┴ ',
];

// The phantom mask, drawn once for the idle hero.
const MASK = [
  '      ╱▔▔▔▔▔▔▔▔▔╲      ',
  '    ╱   ▄▄   ▄▄   ╲    ',
  '   │   ▝██▘ ▝██▘   │   ',
  '   │    ╲  ▁  ╱    │   ',
  '    ╲    ▔▔▔▔▔    ╱    ',
  '      ╲▁▁▁▁▁▁▁▁▁╱      ',
];

export function wordmark(theme, width) {
  const art = width >= visibleWidth(WORDMARK[0]) ? WORDMARK : COMPACT;
  if (!theme.unicode) return ['M A S K S H I F T'];
  return art.map((line, index) => theme.gradient(
    fit(line, Math.min(width, visibleWidth(line))),
    index < art.length / 2 ? theme.palette.crimson : theme.palette.blood,
    index < art.length / 2 ? theme.palette.gold : theme.palette.ember,
    { bold: true },
  ));
}

export function maskArt(theme) {
  if (!theme.unicode) return [];
  // The mask fades into the background from the brow down, so it sits behind
  // the wordmark instead of competing with it.
  return MASK.map((line, index) => theme.paint(line, {
    fg: theme.mixed(theme.roles.background, theme.roles.primary, 1 - (index / (MASK.length + 2))),
  }));
}

export const TAGLINE = 'EVERY MASK. ONLY WHEN NEEDED.';
export const SUBTITLE = 'MAXIMALIST CODING HARNESS';

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
  lines.push(center(theme.paint(TAGLINE, { fg: theme.roles.accent, bold: true }), width));
  lines.push(center(theme.paint(repeat(mark.tick, Math.min(width - 4, visibleWidth(TAGLINE))), { fg: theme.roles.borderStrong }), width));
  return lines;
}
