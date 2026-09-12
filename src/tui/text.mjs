// ANSI-aware text measurement and layout helpers.
// Everything the renderer draws passes through here so styled strings keep
// their alignment inside panels.

import { ESC } from './theme.mjs';

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g');

const RESET = `${ESC}[0m`;

const GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** Split text into user-perceived characters while retaining UTF-16 offsets. */
export function graphemes(text) {
  const value = String(text ?? '');
  if (!GRAPHEME_SEGMENTER) {
    let index = 0;
    return [...value].map((segment) => {
      const item = { segment, index };
      index += segment.length;
      return item;
    });
  }
  return [...GRAPHEME_SEGMENTER.segment(value)].map(({ segment, index }) => ({ segment, index }));
}

export function previousGraphemeBoundary(text, offset) {
  let previous = 0;
  for (const item of graphemes(text)) {
    if (item.index >= offset) break;
    previous = item.index;
  }
  return previous;
}

export function nextGraphemeBoundary(text, offset) {
  const value = String(text ?? '');
  for (const item of graphemes(value)) {
    if (item.index > offset) return item.index;
    if (item.index === offset) return item.index + item.segment.length;
  }
  return value.length;
}

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

// Zero-width: combining marks, variation selectors, zero-width joiners.
function isZeroWidth(code) {
  return (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0xfe00 && code <= 0xfe0f)
    || (code >= 0x20d0 && code <= 0x20f0)
    || code === 0xfeff;
}

// Full-width: CJK, Hangul, Kana, and the emoji planes.
function isWide(code) {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

export function charWidth(character) {
  const code = character.codePointAt(0);
  if (code === undefined) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (isZeroWidth(code)) return 0;
  return isWide(code) ? 2 : 1;
}

function graphemeWidth(grapheme) {
  // Emoji ZWJ sequences, skin-tone clusters and regional-indicator flags are
  // displayed as one two-column glyph by modern terminals.
  if (/\u200d|[\u{1f1e6}-\u{1f1ff}]|\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) width += charWidth(character);
  return width;
}

export function visibleWidth(text) {
  let width = 0;
  for (const { segment } of graphemes(stripAnsi(text))) width += graphemeWidth(segment);
  return width;
}

// Walk a styled string, yielding { character, width, ansi } where `ansi` is any
// escape sequence that immediately preceded the character.
function* walk(text) {
  const value = String(text ?? '');
  let pending = '';
  let index = 0;
  while (index < value.length) {
    ANSI_PATTERN.lastIndex = index;
    const match = ANSI_PATTERN.exec(value);
    if (match && match.index === index) {
      pending += match[0];
      index = ANSI_PATTERN.lastIndex;
      continue;
    }
    const nextAnsi = match?.index ?? value.length;
    const plain = value.slice(index, nextAnsi);
    for (const { segment } of graphemes(plain)) {
      yield { character: segment, width: graphemeWidth(segment), ansi: pending };
      pending = '';
    }
    index = nextAnsi;
  }
  if (pending) yield { character: '', width: 0, ansi: pending };
}

/**
 * Remove terminal controls from an already-rendered row while preserving the
 * SGR colour/style sequences emitted by Theme. This is the final trust
 * boundary for model text, tool output, filenames, file contents and paste.
 */
export function sanitizeTerminalLine(text) {
  let value = String(text ?? '');
  const safeSgr = [];
  value = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => (
    /^\x1b\[[0-9;]*m$/.test(sequence)
      ? `\ue000${safeSgr.push(sequence) - 1}\ue001`
      : ''
  ));
  value = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?/g, '');
  value = value.replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, '');
  value = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\x1b]/g, '');
  // Directional overrides can visually disguise filenames and commands.
  value = value.replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  value = value.replace(/\ue000(\d+)\ue001/g, (match, index) => safeSgr[Number(index)] || '');
  return value;
}

// Slice by *visible columns* while preserving styling.
export function sliceAnsi(text, start = 0, end = Number.POSITIVE_INFINITY) {
  let column = 0;
  let out = '';
  let carried = '';
  let opened = false;
  for (const { character, width, ansi } of walk(text)) {
    if (column >= end) break;
    if (ansi) { carried += ansi; if (column >= start) { out += ansi; opened = true; } }
    if (!character) continue;
    if (column + width > end) break;
    if (column >= start) {
      if (!opened && carried) { out += carried; opened = true; }
      out += character;
    }
    column += width;
  }
  return opened ? `${out}${RESET}` : out;
}

export function truncate(text, width, ellipsis = '…') {
  if (width <= 0) return '';
  const actual = visibleWidth(text);
  if (actual <= width) return String(text ?? '');
  const tailWidth = visibleWidth(ellipsis);
  if (width <= tailWidth) return ellipsis.slice(0, width);
  return `${sliceAnsi(text, 0, width - tailWidth)}${ellipsis}`;
}

export function padEnd(text, width, filler = ' ') {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${text}${filler.repeat(gap)}` : String(text ?? '');
}

export function padStart(text, width, filler = ' ') {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${filler.repeat(gap)}${text}` : String(text ?? '');
}

export function center(text, width, filler = ' ') {
  const gap = width - visibleWidth(text);
  if (gap <= 0) return String(text ?? '');
  const left = Math.floor(gap / 2);
  return `${filler.repeat(left)}${text}${filler.repeat(gap - left)}`;
}

// Fit a styled string into an exact column count.
export function fit(text, width, { align = 'left', ellipsis = '…' } = {}) {
  if (width <= 0) return '';
  const clipped = truncate(text, width, ellipsis);
  if (align === 'right') return padStart(clipped, width);
  if (align === 'center') return center(clipped, width);
  return padEnd(clipped, width);
}

// Word wrap that keeps ANSI styling and never splits mid-escape.
export function wrap(text, width) {
  if (width <= 0) return [''];
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') { lines.push(''); continue; }
    if (visibleWidth(paragraph) <= width) { lines.push(paragraph); continue; }
    let current = '';
    let currentWidth = 0;
    let word = '';
    let wordWidth = 0;
    const flushWord = () => {
      if (!word) return;
      if (currentWidth + wordWidth > width && currentWidth > 0) {
        lines.push(current);
        current = '';
        currentWidth = 0;
      }
      while (wordWidth > width) {
        const head = sliceAnsi(word, 0, width - currentWidth);
        lines.push(`${current}${head}`);
        word = sliceAnsi(word, width - currentWidth);
        wordWidth = visibleWidth(word);
        current = '';
        currentWidth = 0;
      }
      current += word;
      currentWidth += wordWidth;
      word = '';
      wordWidth = 0;
    };
    for (const { character, width: cw, ansi } of walk(paragraph)) {
      if (ansi) word += ansi;
      if (!character) continue;
      if (character === ' ') {
        flushWord();
        if (currentWidth + 1 <= width) { current += ' '; currentWidth += 1; }
        else { lines.push(current); current = ''; currentWidth = 0; }
        continue;
      }
      word += character;
      wordWidth += cw;
    }
    flushWord();
    lines.push(current);
  }
  return lines.length ? lines : [''];
}

export function repeat(character, count) {
  return count > 0 ? character.repeat(count) : '';
}

// Sanitise arbitrary text (tool output, file contents) for a single-line cell.
export function oneLine(text, width = 0) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return width > 0 ? truncate(flat, width) : flat;
}

export function expandTabs(text, size = 2) {
  return String(text ?? '').replace(/\t/g, ' '.repeat(size));
}
