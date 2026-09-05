// Terminal markdown renderer with lightweight syntax tinting.
//
// Model replies are markdown; this turns them into styled lines that fit the
// chat column, including fenced code, diffs, tables, lists and quotes.

import { glyphs } from './box.mjs';
import { fit, padEnd, repeat, stripAnsi, truncate, visibleWidth, wrap, expandTabs } from './text.mjs';

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

export function highlight(theme, line, language = '') {
  if (!theme.enabled) return line;
  const comment = theme.palette.ash;
  const string = theme.palette.toxic;
  const number = theme.palette.gold;
  const keyword = theme.palette.crimson;
  const symbol = theme.palette.smoke;
  const identifier = theme.palette.bone;
  if (['json', 'jsonc'].includes(language)) {
    return line.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|(\b-?\d[\d.eE+-]*\b)|\b(true|false|null)\b/g,
      (match, text, colon, digits, literal) => {
        if (text) return theme.paint(text, { fg: colon ? theme.palette.azure : string }) + (colon || '');
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
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => theme.paint(label, { fg: theme.palette.azure, underline: true }) + theme.paint(` ${href}`, { fg: theme.palette.ash }));
  value = value.replace(/`([^`]+)`/g, (match, code) => theme.paint(` ${code} `, { fg: theme.palette.cyanide, bg: theme.palette.raised }));
  value = value.replace(/\*\*([^*]+)\*\*/g, (match, bold) => theme.paint(bold, { fg: theme.palette.chalk, bold: true }));
  value = value.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (match, italics) => theme.paint(italics, { italic: true }));
  value = value.replace(/~~([^~]+)~~/g, (match, struck) => theme.paint(struck, { fg: theme.palette.ash }));
  return value;
}

function codeBlock(theme, width, language, lines) {
  const mark = glyphs(theme);
  const out = [];
  const label = (language || 'text').toUpperCase();
  const head = theme.paint(` ${label} `, { fg: theme.palette.ink, bg: theme.palette.hairline, bold: true });
  out.push(head + theme.paint(repeat(theme.unicode ? '┄' : '-', Math.max(0, width - visibleWidth(label) - 2)), { fg: theme.roles.border }));
  const gutterWidth = String(lines.length).length + 1;
  const isDiff = language === 'diff' || language === 'patch';
  for (const [index, raw] of lines.entries()) {
    const source = expandTabs(raw);
    let tint = null;
    let body = source;
    if (isDiff) {
      if (source.startsWith('+')) tint = theme.palette.toxic;
      else if (source.startsWith('-')) tint = theme.palette.crimson;
      else if (source.startsWith('@@')) tint = theme.palette.azure;
      body = theme.paint(source, { fg: tint || theme.palette.smoke });
    } else {
      body = highlight(theme, source, language);
    }
    const gutter = theme.paint(padEnd(String(index + 1), gutterWidth), { fg: theme.roles.border });
    const spine = theme.paint(mark.pipe, { fg: tint || theme.roles.border });
    for (const [wrapIndex, piece] of wrap(body, Math.max(8, width - gutterWidth - 2)).entries()) {
      out.push(wrapIndex === 0
        ? `${gutter}${spine} ${piece}`
        : `${' '.repeat(gutterWidth)}${spine} ${piece}`);
    }
  }
  out.push(theme.paint(repeat(theme.unicode ? '┄' : '-', width), { fg: theme.roles.border }));
  return out;
}

function tableBlock(theme, width, rows) {
  const cells = rows.map((row) => row.slice(1, -1).split('|').map((cell) => cell.trim()));
  const columns = Math.max(...cells.map((row) => row.length));
  const widths = new Array(columns).fill(3);
  for (const row of cells) {
    for (const [index, cell] of row.entries()) {
      if (/^:?-{2,}:?$/.test(cell)) continue;
      widths[index] = Math.max(widths[index], Math.min(38, visibleWidth(cell)));
    }
  }
  const total = widths.reduce((sum, value) => sum + value + 3, 1);
  if (total > width) {
    const excess = total - width;
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = Math.max(6, widths[widest] - excess);
  }
  const out = [];
  for (const [index, row] of cells.entries()) {
    if (row.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      out.push(theme.paint(widths.map((value) => repeat(theme.unicode ? '─' : '-', value + 2)).join(theme.unicode ? '┼' : '+'), { fg: theme.roles.border }));
      continue;
    }
    const separator = theme.paint(theme.unicode ? '│' : '|', { fg: theme.roles.border });
    const painted = row.map((cell, column) => {
      const text = fit(inline(theme, cell), widths[column] ?? 8);
      return ` ${index === 0 ? theme.paint(stripAnsi(text), { fg: theme.palette.crimson, bold: true }) : text} `;
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
      if (level === 1) {
        out.push(theme.gradient(truncate(label.toUpperCase(), width - 2), theme.palette.crimson, theme.palette.gold, { bold: true }));
        out.push(theme.paint(repeat(theme.unicode ? '━' : '=', Math.min(width, visibleWidth(label) + 2)), { fg: theme.palette.blood }));
      } else if (level === 2) {
        out.push(theme.paint(mark.spine, { fg: theme.palette.crimson }) + theme.paint(` ${truncate(label.toUpperCase(), width - 2)}`, { fg: theme.palette.chalk, bold: true }));
      } else {
        out.push(theme.paint(`${mark.arrowRight} ${truncate(label, width - 2)}`, { fg: theme.palette.gold, bold: true }));
      }
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && stripAnsi(line).replace(/[\s\-*_]/g, '') === '') {
      out.push(theme.paint(repeat(theme.unicode ? '╌' : '-', width), { fg: theme.roles.border }));
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      for (const piece of wrap(inline(theme, quote[1]), width - 2)) {
        out.push(theme.paint(`${mark.spine} `, { fg: theme.palette.violet }) + theme.paint(piece, { fg: theme.palette.smoke, italic: true }));
      }
      index += 1;
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const indent = '  '.repeat(depth);
      const isOrdered = /\d/.test(bullet[2]);
      const marker = isOrdered ? bullet[2] : mark.diamond;
      const prefix = `${indent}${theme.paint(marker, { fg: depth ? theme.palette.violet : theme.palette.crimson, bold: true })} `;
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
  // Collapse runs of blank lines so replies stay dense.
  return out.filter((value, position) => !(value === '' && out[position - 1] === ''));
}
