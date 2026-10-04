// The MaskShift wordmark and the other identity pieces used across the CLI and TUI.

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

export function wordmark(theme, width) {
  const art = width >= visibleWidth(WORDMARK[0]) ? WORDMARK : COMPACT;
  if (!theme.unicode) return ['MaskShift'];
  // Reads from roles rather than the fixed "crimson"/"blood"/"gold"/"ember" palette names, so the
  // gradient re-tones itself for whichever theme is active instead of always being MaskShift red.
  return art.map((line, index) => theme.gradient(
    fit(line, Math.min(width, visibleWidth(line))),
    index < art.length / 2 ? theme.roles.primary : theme.roles.primaryDeep,
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
  lines.push(center(theme.paint(TAGLINE, { fg: theme.roles.accent, bold: true }), width));
  lines.push(center(theme.paint(repeat(mark.tick, Math.min(width - 4, visibleWidth(TAGLINE))), { fg: theme.roles.borderStrong }), width));
  return lines;
}
