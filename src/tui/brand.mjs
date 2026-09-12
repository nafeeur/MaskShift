// The MaskShift wordmark and other identity pieces used across CLI and TUI.

import { glyphs } from './box.mjs';
import { smooth } from './motion.mjs';
import { center, fit, repeat, visibleWidth } from './text.mjs';
import { DURATION } from './tokens.mjs';

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

// The phantom mask, drawn once for the idle hero — a raster rendering of the
// brand mark rather than typed line art, so it reads as the same mask
// wherever the logo appears.
const MASK = [
  '                               P                               ',
  '                             PAAA                              ',
  '                           gAAAAAAA               11           ',
  '                          AAAAAAAAAAA             11           ',
  '                        AAAAAAAAAAAAAAA                        ',
  '                      AAAAAAAAAAAAAAAAAAA                      ',
  '                    AAAH11IAAAAAAAAAAAAAAA0                    ',
  '                  F   J11111111XAAAAAAAAA                      ',
  '                J       g111112 11111E       A                 ',
  '              oA           11     13           A               ',
  '             A           4           6          BA             ',
  '           AA       311111          111111e       12           ',
  '         AA         1111111        31111114        312         ',
  '       AAAA          111 1111    11114 112         11111       ',
  '         AAAAW         2111111111111111          11111         ',
  '          kAAL1      11111111111111111111r     11111           ',
  '            d1111e 1111111111111111111111113 11111             ',
  '              3111111111111111111111111111111111               ',
  '                111111111111111111111111111111l                ',
  '                  111111111111111111111111110                  ',
  '                    11111111111111111111113                    ',
  '                      1111111111111111111                      ',
  '                        111111111111111                        ',
  '                         411111111111                          ',
  '                           31111111                            ',
  '                             2111j                             ',
  '                               1                               ',
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

export const MASK_WIDTH = Math.max(...MASK.map((line) => line.length));
export const MASK_HEIGHT = MASK.length;

/**
 * `busy` answers "is a heist running right now, even off-screen?" — the mask
 * is the one mark visible from every idle view, so it is where that question
 * gets answered without a status line. Otherwise it just breathes, the same
 * "still alive, nothing new" signal `breathe()` gives the run lamp.
 */
export function maskArt(theme, { busy = false } = {}) {
  const period = busy ? DURATION.sweep : DURATION.breath;
  const floor = busy ? 0.5 : 0.28;
  const pulse = floor + (1 - floor) * smooth(theme.motion.pulse(period));
  // Plain ASCII, so it renders the same with MASKSHIFT_ASCII set as without.
  // The mask fades into the background from the brow down, so it sits behind
  // the wordmark instead of competing with it; the pulse scales that same
  // fade rather than replacing it, so the shape never flattens out.
  return MASK.map((line, index) => theme.paint(line, {
    fg: theme.mixed(theme.roles.background, theme.roles.primary, pulse * (1 - (index / (MASK.length + 2)))),
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
