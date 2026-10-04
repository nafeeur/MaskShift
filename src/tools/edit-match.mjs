// Locating the text an edit means, even when the model reproduced it imperfectly.
//
// Models rarely get a code block wrong — they get its *whitespace* wrong: tabs vs spaces, a
// dropped indent level, CRLF line endings, a trailing space, or the `  12 | ` gutter that
// fs_read prints copied into the text. Each of those used to cost a failed edit and a whole
// extra turn. Strategies are tried strictest first, every one must resolve to exactly one
// location (an ambiguous match is never guessed at), and a genuine miss reports the closest
// region of the file so the next attempt can be right.

import { editDistance } from '../agent/call-repair.mjs';

const GUTTER = /^\s*\d+ \| ?/;
const FUZZY_THRESHOLD = 0.88;
const FUZZY_MARGIN = 0.08;
const MAX_FUZZY_WORK = 3_000_000;

export class EditMatchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EditMatchError';
    this.kind = details.kind || 'missing';
    this.closest = details.closest || null;
  }
}

const splitLines = (text) => String(text).split(/\r?\n/);
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const rtrim = (line) => line.replace(/\s+$/, '');
const squeeze = (line) => line.trim().replace(/\s+/g, ' ');
const indentOf = (line) => line.match(/^[ \t]*/)[0];

function lineNumberOf(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (content.charCodeAt(index) === 10) line += 1;
  return line;
}

function occurrences(content, needle) {
  const found = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at < 0) return found;
    found.push(at);
    from = at + Math.max(1, needle.length);
  }
}

function stripGutter(text) {
  const lines = splitLines(text);
  const filled = lines.filter((line) => line.trim() !== '');
  if (!filled.length || !filled.every((line) => GUTTER.test(line))) return null;
  return lines.map((line) => line.replace(GUTTER, '')).join('\n');
}

// A window of whole lines of `fileLines` equal to `oldLines` under `normalize`.
function windowMatches(fileLines, oldLines, normalize) {
  const wanted = oldLines.map(normalize);
  const hits = [];
  for (let start = 0; start + wanted.length <= fileLines.length; start += 1) {
    let ok = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (normalize(fileLines[start + offset]) !== wanted[offset]) { ok = false; break; }
    }
    if (ok) hits.push(start);
  }
  return hits;
}

function similarity(a, b) {
  if (a === b) return 1;
  const x = a.slice(0, 300);
  const y = b.slice(0, 300);
  const longest = Math.max(x.length, y.length);
  if (!longest) return 1;
  return 1 - editDistance(x, y, longest) / longest;
}

function windowScore(fileLines, oldLines, start) {
  let total = 0;
  for (let offset = 0; offset < oldLines.length; offset += 1) total += similarity(squeeze(fileLines[start + offset]), squeeze(oldLines[offset]));
  return total / oldLines.length;
}

function fuzzyWindows(fileLines, oldLines) {
  if (fileLines.length * oldLines.length > MAX_FUZZY_WORK) return [];
  const scored = [];
  for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
    scored.push({ start, score: windowScore(fileLines, oldLines, start) });
  }
  return scored.sort((a, b) => b.score - a.score || a.start - b.start);
}

// Rewrites newText to sit at the indentation the file actually uses.
function reindent(newLines, oldLines, fileLines, start) {
  const anchor = oldLines.findIndex((line) => line.trim() !== '');
  if (anchor < 0) return newLines;
  const oldIndent = indentOf(oldLines[anchor]);
  const fileIndent = indentOf(fileLines[start + anchor]);
  if (oldIndent === fileIndent) return newLines;
  return newLines.map((line) => {
    if (line.trim() === '') return line;
    if (line.startsWith(oldIndent)) return fileIndent + line.slice(oldIndent.length);
    return line;
  });
}

function numbered(lines, startLine, limit = 14) {
  const shown = lines.slice(0, limit);
  const body = shown.map((line, index) => `${String(startLine + index).padStart(6)} | ${line}`).join('\n');
  return lines.length > limit ? `${body}\n       … (${lines.length - limit} more lines)` : body;
}

function closestRegion(fileLines, oldLines) {
  if (!oldLines.length || oldLines.every((line) => line.trim() === '')) return null;
  const windows = fuzzyWindows(fileLines, oldLines);
  const best = windows[0];
  if (!best || best.score < 0.5) return null;
  return {
    score: best.score,
    startLine: best.start + 1,
    endLine: best.start + oldLines.length,
    text: numbered(fileLines.slice(best.start, best.start + oldLines.length), best.start + 1),
  };
}

function spliceLines(content, fileLines, start, count, replacement) {
  const eol = eolOf(content);
  const next = [...fileLines.slice(0, start), ...replacement, ...fileLines.slice(start + count)];
  return next.join(eol);
}

const LINE_STRATEGIES = [
  { name: 'trailing-whitespace', normalize: rtrim, reindent: false },
  { name: 'indentation', normalize: (line) => line.trim(), reindent: true },
  { name: 'whitespace', normalize: squeeze, reindent: true },
];

/**
 * Applies one edit. Returns `{ content, replacements, strategy, startLine, endLine }` where
 * `strategy` is `exact` or the looser rule that matched. Throws EditMatchError when the text is
 * missing or matches more than one place.
 */
export function applyEdit(content, oldText, newText, { replaceAll = false, exactOnly = false } = {}) {
  if (!oldText) throw new EditMatchError('oldText is empty', { kind: 'empty' });
  const exact = occurrences(content, oldText);
  if (exact.length > 1 && !replaceAll) throw ambiguous(content, exact.map((at) => lineNumberOf(content, at)));
  if (exact.length) {
    const next = replaceAll ? content.split(oldText).join(newText) : content.slice(0, exact[0]) + newText + content.slice(exact[0] + oldText.length);
    return { content: next, replacements: replaceAll ? exact.length : 1, strategy: 'exact', startLine: lineNumberOf(content, exact[0]), endLine: lineNumberOf(content, exact[0]) + splitLines(oldText).length - 1 };
  }

  if (exactOnly) throw new EditMatchError('oldText was not found', { kind: 'missing' });

  // Everything below is a repair of an almost-right edit; it never fans out to replaceAll.
  const eol = eolOf(content);
  const variants = [{ old: oldText, new: newText, label: null }];
  if (eol === '\r\n' && !oldText.includes('\r\n')) variants.push({ old: oldText.replace(/\n/g, '\r\n'), new: newText.replace(/\r?\n/g, '\r\n'), label: 'line-endings' });
  const gutterless = stripGutter(oldText);
  if (gutterless !== null) variants.push({ old: gutterless, new: stripGutter(newText) ?? newText, label: 'line-number-gutter' });

  for (const variant of variants.slice(1)) {
    const hits = occurrences(content, variant.old);
    if (hits.length > 1) throw ambiguous(content, hits.map((at) => lineNumberOf(content, at)));
    if (hits.length === 1) {
      const startLine = lineNumberOf(content, hits[0]);
      return { content: content.slice(0, hits[0]) + variant.new + content.slice(hits[0] + variant.old.length), replacements: 1, strategy: variant.label, startLine, endLine: startLine + splitLines(variant.old).length - 1 };
    }
  }

  const fileLines = splitLines(content);
  for (const variant of variants) {
    let oldLines = splitLines(variant.old);
    let newLines = splitLines(variant.new);
    // A trailing newline means "these whole lines", not "plus an empty line".
    if (oldLines.length > 1 && oldLines.at(-1) === '') { oldLines = oldLines.slice(0, -1); if (newLines.at(-1) === '') newLines = newLines.slice(0, -1); }
    if (oldLines.every((line) => line.trim() === '')) continue;
    for (const strategy of LINE_STRATEGIES) {
      const hits = windowMatches(fileLines, oldLines, strategy.normalize);
      if (hits.length > 1) throw ambiguous(content, hits.map((start) => start + 1));
      if (hits.length === 1) {
        const [start] = hits;
        const replacement = strategy.reindent ? reindent(newLines, oldLines, fileLines, start) : newLines;
        return {
          content: spliceLines(content, fileLines, start, oldLines.length, replacement), replacements: 1,
          strategy: variant.label ? `${variant.label}+${strategy.name}` : strategy.name, startLine: start + 1, endLine: start + oldLines.length,
        };
      }
    }
  }

  // Last resort: a near match, accepted only when it is clearly the best by a safe margin.
  const baseOld = variants.at(-1).old;
  const baseNew = variants.at(-1).new;
  let oldLines = splitLines(baseOld);
  let newLines = splitLines(baseNew);
  if (oldLines.length > 1 && oldLines.at(-1) === '') { oldLines = oldLines.slice(0, -1); if (newLines.at(-1) === '') newLines = newLines.slice(0, -1); }
  const substantial = oldLines.join('').replace(/\s/g, '').length >= 20;
  if (substantial) {
    const windows = fuzzyWindows(fileLines, oldLines);
    const best = windows[0];
    if (best && best.score >= FUZZY_THRESHOLD) {
      const rival = windows.find((entry) => Math.abs(entry.start - best.start) >= oldLines.length);
      if (!rival || rival.score <= best.score - FUZZY_MARGIN) {
        return {
          content: spliceLines(content, fileLines, best.start, oldLines.length, reindent(newLines, oldLines, fileLines, best.start)), replacements: 1,
          strategy: `fuzzy ${Math.round(best.score * 100)}%`, startLine: best.start + 1, endLine: best.start + oldLines.length,
        };
      }
    }
  }

  const closest = closestRegion(fileLines, oldLines);
  throw new EditMatchError(
    `oldText was not found.${closest ? ` Closest match (${Math.round(closest.score * 100)}% similar) is lines ${closest.startLine}–${closest.endLine}:\n${closest.text}\nCopy oldText from the file exactly (without the line-number gutter) and retry.` : ' Re-read the file and copy oldText from it exactly.'}`,
    { kind: 'missing', closest },
  );
}

function ambiguous(content, lines) {
  const shown = [...new Set(lines)].slice(0, 6);
  return new EditMatchError(
    `oldText matched ${lines.length} locations (lines ${shown.join(', ')}${lines.length > shown.length ? ', …' : ''}); include more surrounding lines to make it unique, or set replaceAll`,
    { kind: 'ambiguous' },
  );
}

/** Replaces whole lines `startLine..endLine` (1-based, inclusive). */
export function replaceLines(content, startLine, endLine, newText, { expect = null } = {}) {
  const eol = eolOf(content);
  const lines = splitLines(content);
  const trailing = lines.at(-1) === '' ? 1 : 0;
  const total = lines.length - trailing;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) throw new Error(`Invalid line range ${startLine}–${endLine}`);
  if (startLine > total + 1) throw new Error(`startLine ${startLine} is past the end of the file (${total} lines)`);
  const last = Math.min(endLine, total);
  if (expect !== null && startLine <= total) {
    const actual = lines[startLine - 1].trim();
    if (actual !== String(expect).trim()) {
      throw new Error(`Line ${startLine} is \`${actual.slice(0, 120)}\`, not \`${String(expect).trim().slice(0, 120)}\` — the file has changed or the line number is off. Re-read it.`);
    }
  }
  const replacement = newText === '' ? [] : splitLines(newText.endsWith('\n') ? newText.slice(0, -1) : newText);
  const next = [...lines.slice(0, startLine - 1), ...replacement, ...lines.slice(last)];
  return { content: next.join(eol), replacedLines: Math.max(0, last - startLine + 1), insertedLines: replacement.length };
}
