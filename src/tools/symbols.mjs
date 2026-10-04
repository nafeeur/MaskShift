// Finds a named definition in a source file and the exact lines it spans, with no parser: the
// definition patterns the code graph already uses, then bracket matching (or indentation for
// Python). Good enough to let a model say "replace function velocity" instead of reproducing
// the old body character for character.

import path from 'node:path';
import { DEF_PATTERNS } from '../indexer/code-graph.mjs';

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'super', 'with', 'else', 'do']);
const METHOD = /^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly|abstract)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{\s*$/;
const INDENT_LANGUAGES = new Set(['.py', '.pyi']);
const UNSUPPORTED = new Set(['.rb', '.lua', '.sh', '.bash', '.ex', '.exs', '.erl', '.hs', '.ml']);

function definitionOf(line) {
  for (const { kind, pattern } of DEF_PATTERNS) {
    const match = line.match(pattern);
    if (match) return { kind, name: match[1] };
  }
  const method = line.match(METHOD);
  if (method && !KEYWORDS.has(method[1])) return { kind: 'method', name: method[1] };
  return null;
}

const indentWidth = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

function indentationEnd(lines, start) {
  const base = indentWidth(lines[start]);
  let end = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    if (indentWidth(lines[index]) <= base) break;
    end = index;
  }
  return end;
}

// Walks characters from `start`, skipping strings and comments, until the definition's own
// brackets close. A line that ends on an operator or `=>` carries on; so does an Allman `{`.
function bracketEnd(lines, start) {
  let depth = 0;
  let opened = false;
  let mode = null; // null | "'" | '"' | '`' | '/*'
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    let last = '';
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      const pair = line.slice(at, at + 2);
      if (mode === '/*') { if (pair === '*/') { mode = null; at += 1; } continue; }
      if (mode) {
        if (char === '\\') { at += 1; continue; }
        if (char === mode) mode = null;
        continue;
      }
      if (pair === '//') break;
      if (pair === '/*') { mode = '/*'; at += 1; continue; }
      if (char === '"' || char === "'" || char === '`') { mode = char; continue; }
      if (char === '{' || char === '(' || char === '[') { depth += 1; opened = true; }
      else if (char === '}' || char === ')' || char === ']') depth -= 1;
      if (!/\s/.test(char)) last = char;
    }
    if (mode === "'" || mode === '"') mode = null; // single-line strings do not continue
    if (mode) continue;
    if (depth > 0) continue;
    if (/[=,+\-*/&|?:<>(]$/.test(line.trim()) && !line.trim().endsWith('*/')) continue;
    if (opened) {
      const next = lines.slice(index + 1).find((entry) => entry.trim() !== '');
      if (next && next.trim().startsWith('{') && last !== '}') continue;
    }
    return index;
  }
  return lines.length - 1;
}

/**
 * `name` may be `function`, `Class.method`, or `method`. Returns the 1-based inclusive line range
 * and its text, or throws with the definitions it did find so the model can correct itself.
 */
export function findSymbol(content, name, { file = '' } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (UNSUPPORTED.has(extension)) throw new Error(`Symbol ranges are not supported for ${extension} files; use fs_replace_lines with the line numbers from fs_read`);
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
  const definitions = [];
  lines.forEach((line, index) => {
    const found = definitionOf(line);
    if (found) definitions.push({ ...found, index });
  });
  const parts = String(name).split('.').filter(Boolean);
  const target = parts.at(-1);
  let scope = { from: 0, to: lines.length - 1 };
  const span = (definition) => (INDENT_LANGUAGES.has(extension) ? indentationEnd(lines, definition.index) : bracketEnd(lines, definition.index));
  if (parts.length > 1) {
    const owner = definitions.find((definition) => definition.name === parts.at(-2) && ['class', 'interface', 'type'].includes(definition.kind));
    if (!owner) throw new Error(`No class named \`${parts.at(-2)}\` found; definitions here: ${definitions.slice(0, 12).map((entry) => entry.name).join(', ') || '(none)'}`);
    scope = { from: owner.index + 1, to: span(owner) };
  }
  const matches = definitions.filter((definition) => definition.name === target && definition.index >= scope.from && definition.index <= scope.to);
  if (!matches.length) {
    const near = definitions.map((entry) => entry.name).filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 15);
    throw new Error(`No definition named \`${name}\` found${file ? ` in ${path.basename(file)}` : ''}. Definitions found: ${near.join(', ') || '(none)'}`);
  }
  if (matches.length > 1) throw new Error(`\`${name}\` is defined ${matches.length} times (lines ${matches.map((entry) => entry.index + 1).join(', ')}); qualify it as Class.method or use fs_replace_lines`);
  const [match] = matches;
  let startIndex = match.index;
  if (INDENT_LANGUAGES.has(extension)) while (startIndex > 0 && lines[startIndex - 1].trim().startsWith('@')) startIndex -= 1;
  const endIndex = Math.max(match.index, span(match));
  return { name, kind: match.kind, startLine: startIndex + 1, endLine: endIndex + 1, text: lines.slice(startIndex, endIndex + 1).join('\n') };
}

export function listSymbols(content) {
  const lines = content.split('\n');
  const out = [];
  lines.forEach((line, index) => {
    const found = definitionOf(line);
    if (found) out.push({ ...found, line: index + 1 });
  });
  return out;
}
