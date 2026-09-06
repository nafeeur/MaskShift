// Terminal markdown renderer with lightweight syntax tinting.
//
// Model replies are markdown; this turns them into styled lines that fit the
// chat column, including fenced code, diffs, tables, lists and quotes.
//
// Two rules separate this from the chrome that surrounds it. Content keeps the
// case its author wrote — an earlier revision upper-cased every heading, so a
// model's prose shouted back at the operator from inside a quiet panel. And
// content never borrows crimson: identity and focus own that colour, so
// keywords, headings and table headers are drawn from the code palette below.

import { glyphs } from './box.mjs';
import { fit, padEnd, repeat, stripAnsi, truncate, visibleWidth, wrap, expandTabs } from './text.mjs';
import { SPACE } from './tokens.mjs';

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while', 'break',
  'continue', 'new', 'await', 'async', 'import', 'from', 'export', 'default', 'try', 'catch',
  'finally', 'throw', 'typeof', 'instanceof', 'extends', 'yield', 'switch', 'case', 'delete',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'as', 'in', 'is', 'not', 'and', 'or', 'None',
  'True', 'False', 'self', 'fn', 'let', 'mut', 'pub', 'impl', 'struct', 'enum', 'trait', 'match',
  'type', 'interface', 'package', 'func', 'go', 'defer', 'range', 'map', 'nil', 'null', 'true',
  'false', 'undefined', 'this', 'super', 'static', 'public', 'private', 'end', 'do', 'then', 'fi',
  'esac', 'echo', 'local', 'readonly', 'source', 'require', 'module',
]);

const TOKEN = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\w.]*\b)|(\b[A-Za-z_$][\w$]*\b)|([{}()[\].,;:=+\-*/%<>!&|?^~])/g;

// The code palette. Calm, conventional, and deliberately free of crimson.
export function highlight(theme, line, language = '') {
  if (!theme.enabled) return line;
  const comment = theme.roles.muted;
  const string = theme.roles.success;
  const number = theme.roles.accent;
  const keyword = theme.roles.skill;
  const symbol = theme.roles.dim;
  const identifier = theme.roles.text;
  if (['json', 'jsonc'].includes(language)) {
    return line.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|(\b-?\d[\d.eE+-]*\b)|\b(true|false|null)\b/g,
      (match, text, colon, digits, literal) => {
        if (text) return theme.paint(text, { fg: colon ? theme.roles.info : string }) + (colon || '');
        if (digits) return theme.paint(digits, { fg: number });
        return theme.paint(literal, { fg: keyword });
      });
  }
  return line.replace(TOKEN, (match, remark, quoted, digits, word, punctuation) => {
    if (remark) return theme.paint(remark, { fg: comment, italic: true });
    if (quoted) return theme.paint(quoted, { fg: string });
    if (digits) return theme.paint(digits, { fg: number });
    if (word) return KEYWORDS.has(word) ? theme.paint(word, { fg: keyword, bold: true }) : theme.paint(word, { fg: identifier });
    if (punctuation) return theme.paint(punctuation, { fg: symbol });
    return match;
  });
}

// Inline spans: `code`, **bold**, *italic*, ~~strike~~, [text](url).
export function inline(theme, text) {
  let value = String(text ?? '');
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => theme.paint(label, { fg: theme.roles.info, underline: true }) + theme.paint(` ${href}`, { fg: theme.roles.faint }));
  // Inline code is a raised surface, not a colour: it has to survive next to a
  // green string literal and a violet keyword without claiming to be either.
  value = value.replace(/`([^`]+)`/g, (match, code) => theme.paint(` ${code} `, { fg: theme.roles.text, bg: theme.roles.surfaceRaised }));
  value = value.replace(/\*\*([^*]+)\*\*/g, (match, bold) => theme.paint(bold, { fg: theme.roles.heading, bold: true }));
  value = value.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (match, italics) => theme.paint(italics, { italic: true }));
  value = value.replace(/~~([^~]+)~~/g, (match, struck) => theme.paint(struck, { fg: theme.roles.muted }));
  return value;
}

function codeBlock(theme, width, language, lines) {
  const mark = glyphs(theme);
  const out = [];
  const label = (language || 'text').toUpperCase();
  // The language is a caption on the opening rule, not a filled chip: a solid
  // block on every fenced block put three of them in a single reply.
  const head = theme.paint(`${label} `, { fg: theme.roles.muted });
  out.push(head + theme.paint(repeat(mark.tick, Math.max(0, width - visibleWidth(label) - 1)), { fg: theme.roles.border }));
  const gutterWidth = String(lines.length).length + 1;
  const isDiff = language === 'diff' || language === 'patch';
  for (const [index, raw] of lines.entries()) {
    const source = expandTabs(raw);
    let tint = null;
    let body = source;
    if (isDiff) {
      if (source.startsWith('+')) tint = theme.roles.success;
      else if (source.startsWith('-')) tint = theme.roles.danger;
      else if (source.startsWith('@@')) tint = theme.roles.info;
      body = theme.paint(source, { fg: tint || theme.roles.dim });
    } else {
      body = highlight(theme, source, language);
    }
    const gutter = theme.paint(padEnd(String(index + 1), gutterWidth), { fg: theme.roles.faint });
    const spine = theme.paint(mark.bar, { fg: tint ? theme.soften(tint, 0.55) : theme.roles.border });
    for (const [wrapIndex, piece] of wrap(body, Math.max(8, width - gutterWidth - 2)).entries()) {
      out.push(wrapIndex === 0
        ? `${gutter}${spine} ${piece}`
        : `${' '.repeat(gutterWidth)}${spine} ${piece}`);
    }
  }
  out.push(theme.paint(repeat(mark.tick, width), { fg: theme.roles.border }));
  return out;
}

/**
 * Tables are laid out as ` cell │ cell │ cell `, so a column of width w owns
 * w + 2 columns and each of the (n - 1) separators owns one more.
 *
 * The separator row has to be built from exactly those numbers or the crossings
 * drift out of line with the pipes above them — which is what happened when it
 * was assembled independently of the leading pad.
 */
function tableBlock(theme, width, rows) {
  const cells = rows.map((row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim()));
  const columns = Math.max(...cells.map((row) => row.length));
  const widths = new Array(columns).fill(1);
  for (const row of cells) {
    for (let index = 0; index < columns; index += 1) {
      const cell = row[index];
      if (cell === undefined || /^:?-{2,}:?$/.test(cell)) continue;
      widths[index] = Math.max(widths[index], Math.min(38, visibleWidth(inline(theme, cell))));
    }
  }

  // Shrink from the widest column down until the row fits, so one long cell
  // cannot squeeze every other column into uselessness.
  const measure = () => widths.reduce((sum, value) => sum + value + 2, 0) + (columns - 1);
  let guard = 0;
  while (measure() > width && guard < 500) {
    guard += 1;
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 3) break;
    widths[widest] -= 1;
  }

  const cross = theme.unicode ? '┼' : '+';
  const dash = theme.unicode ? '─' : '-';
  const pipe = theme.unicode ? '│' : '|';
  const out = [];
  for (const [index, row] of cells.entries()) {
    if (row.length && row.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      out.push(theme.paint(widths.map((value) => repeat(dash, value + 2)).join(cross), { fg: theme.roles.border }));
      continue;
    }
    const separator = theme.paint(pipe, { fg: theme.roles.border });
    const painted = widths.map((value, column) => {
      const cell = row[column] ?? '';
      const text = index === 0
        ? theme.paint(fit(cell, value), { fg: theme.roles.label, bold: true })
        : fit(inline(theme, cell), value);
      return ` ${text} `;
    });
    out.push(painted.join(separator));
  }
  return out;
}

/** Render markdown into an array of styled lines no wider than `width`. */
export function renderMarkdown(theme, text, width) {
  const mark = glyphs(theme);
  const source = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let index = 0;
  while (index < source.length) {
    const line = source[index];

    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1].toLowerCase();
      const body = [];
      index += 1;
      while (index < source.length && !/^\s*```+\s*$/.test(source[index])) { body.push(source[index]); index += 1; }
      index += 1;
      out.push(...codeBlock(theme, width, language, body));
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (index < source.length && /^\s*\|.*\|\s*$/.test(source[index])) { rows.push(source[index].trim()); index += 1; }
      out.push(...tableBlock(theme, width, rows));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const label = heading[2].trim();
      // Three weights, no ornament and no case change. A gradient wordmark
      // belongs on the front door; inside a reply it is just loud.
      if (level === 1) {
        out.push(theme.paint(truncate(label, width), { fg: theme.roles.heading, bold: true }));
        out.push(theme.paint(repeat(mark.tick, Math.min(width, visibleWidth(label))), { fg: theme.roles.borderStrong }));
      } else if (level === 2) {
        out.push(theme.paint(truncate(label, width), { fg: theme.roles.text, bold: true }));
      } else {
        out.push(theme.paint(truncate(label, width), { fg: theme.roles.label, bold: true }));
      }
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && stripAnsi(line).replace(/[\s\-*_]/g, '') === '') {
      out.push(theme.paint(repeat(mark.rule, width), { fg: theme.roles.border }));
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      for (const piece of wrap(inline(theme, quote[1]), width - SPACE.indent)) {
        out.push(theme.paint(`${mark.bar} `, { fg: theme.roles.borderStrong }) + theme.paint(piece, { fg: theme.roles.dim, italic: true }));
      }
      index += 1;
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / SPACE.indent);
      const indent = ' '.repeat(SPACE.indent * depth);
      const isOrdered = /\d/.test(bullet[2]);
      // Depth reads from the marker, not from a colour: a solid crimson
      // diamond on every top-level bullet made a four-item list the loudest
      // thing in the reply.
      const marker = isOrdered ? bullet[2] : [mark.bullet, mark.dash, mark.dot][Math.min(2, depth)];
      const prefix = `${indent}${theme.paint(marker, { fg: depth ? theme.roles.faint : theme.roles.muted })} `;
      const body = wrap(inline(theme, bullet[3]), Math.max(4, width - visibleWidth(stripAnsi(prefix))));
      out.push(`${prefix}${body[0] ?? ''}`);
      for (const piece of body.slice(1)) out.push(`${' '.repeat(visibleWidth(stripAnsi(prefix)))}${piece}`);
      index += 1;
      continue;
    }

    if (line.trim() === '') { out.push(''); index += 1; continue; }
    out.push(...wrap(inline(theme, line), width));
    index += 1;
  }
  // Collapse runs of blank lines so replies stay dense, and never hand back a
  // trailing one: the transcript owns the space between turns, and a reply
  // that ends in whitespace doubled every gap after a fenced block.
  const dense = out.filter((value, position) => !(value === '' && out[position - 1] === ''));
  while (dense.length && dense[dense.length - 1] === '') dense.pop();
  while (dense.length && dense[0] === '') dense.shift();
  return dense;
}
