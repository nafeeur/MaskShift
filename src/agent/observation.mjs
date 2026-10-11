// Shaping what a tool returned before it goes into the conversation.
//
// A tool result is billed on every later turn, so what goes in is paid for repeatedly — and a
// small window can be filled by one noisy build log. Three things are done here, none of which
// costs a model call:
//
//   1. noise a model can't use is removed (ANSI colour, progress-bar redraws, repeated lines);
//   2. results are rendered compactly — a file's text raw rather than as an escaped JSON string;
//   3. output over budget keeps its head, its tail and the regions around errors, and the full
//      text is saved to a file the model can read a range of if the summary was not enough.

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const IMPORTANT = /\b(error|errors|fail|failed|failure|failures|fatal|exception|traceback|panic|assert(?:ion)?|not ok|denied|cannot|can't|unable|undefined|no such|not found|warning|deprecated)\b|✖|✗|✘|^\s*E\s{2,}|^\s*at .+\(.+:\d+:\d+\)|^\s*--- FAIL|^FAIL\b|expected|received|\d+ (?:passed|failed|passing|failing)/i;
const BULKY_FIELDS = ['content', 'stdout', 'stderr', 'output', 'text', 'diff', 'body', 'log', 'logs', 'result'];
// Only these are logs, where the lines around an error matter more than the lines between.
const LOG_FIELDS = new Set(['stdout', 'stderr', 'output', 'log', 'logs']);
const NOISY_SHELL_FIELDS = new Set(['pid', 'cwd', 'signal', 'aborted', 'command', 'stdout', 'stderr', 'durationMs', 'code', 'timedOut']);

export function cleanText(value) {
  let text = String(value ?? '').replace(ANSI, '');
  // A progress bar redrawn with \r leaves only its last frame visible in a terminal; keep that.
  if (text.includes('\r')) {
    text = text.split('\n').map((line) => {
      const frames = line.split('\r');
      return frames.filter((frame, index) => frame !== '' || index === frames.length - 1).at(-1) ?? '';
    }).join('\n');
  }
  return text;
}

/** Collapses runs of identical lines: `line` ×N becomes one line and a count. */
export function dedupeLines(lines) {
  const out = [];
  let run = 1;
  for (let index = 0; index < lines.length; index += 1) {
    if (index + 1 < lines.length && lines[index + 1] === lines[index] && lines[index].trim() !== '') { run += 1; continue; }
    out.push(run > 1 ? `${lines[index]}  [×${run}]` : lines[index]);
    run = 1;
  }
  return out;
}

const size = (lines) => lines.reduce((total, line) => total + line.length + 1, 0);

/**
 * Fits `text` in `budget` characters: the first lines (what started it), the lines around errors
 * (what went wrong), and the last lines (where it ended up, where a test summary lives).
 */
export function condenseText(text, budget, { headShare = 0.2, tailShare = 0.35, important = true } = {}) {
  const cleaned = cleanText(text);
  const lines = dedupeLines(cleaned.split('\n'));
  if (size(lines) <= budget) return { text: lines.join('\n'), omittedLines: 0, condensed: lines.length !== cleaned.split('\n').length };

  // Without error-hunting (source, diffs), what is kept is just the start and the end.
  const headBudget = Math.floor(budget * (important ? headShare : 0.55));
  const tailBudget = Math.floor(budget * (important ? tailShare : 0.4));
  const middleBudget = budget - headBudget - tailBudget - 120;
  const keep = new Set();

  let used = 0;
  let head = 0;
  while (head < lines.length && used + lines[head].length + 1 <= headBudget) { keep.add(head); used += lines[head].length + 1; head += 1; }
  used = 0;
  let tail = lines.length - 1;
  while (tail >= head && used + lines[tail].length + 1 <= tailBudget) { keep.add(tail); used += lines[tail].length + 1; tail -= 1; }

  // Error regions, earliest first, until the middle budget is spent.
  used = 0;
  for (let index = head; index <= tail && used < middleBudget; index += 1) {
    if (!important || !IMPORTANT.test(lines[index])) continue;
    for (let at = Math.max(head, index - 1); at <= Math.min(tail, index + 2); at += 1) {
      if (keep.has(at)) continue;
      const cost = Math.min(lines[at].length, 400) + 1;
      if (used + cost > middleBudget) break;
      keep.add(at);
      used += cost;
    }
  }

  const out = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!keep.has(index)) { skipped += 1; continue; }
    if (skipped) { out.push(`… [${skipped} line${skipped === 1 ? '' : 's'} omitted] …`); skipped = 0; }
    out.push(lines[index].length > 600 ? `${lines[index].slice(0, 600)}… [${lines[index].length - 600} chars cut]` : lines[index]);
  }
  if (skipped) out.push(`… [${skipped} line${skipped === 1 ? '' : 's'} omitted] …`);
  return { text: out.join('\n'), omittedLines: lines.length - keep.size, condensed: true };
}

function isShellResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && 'code' in value && ('stdout' in value || 'stderr' in value);
}

function compactJson(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

// Arrays are the usual cause of an enormous result; trim them evenly and say how much was cut.
function trimArrays(value, maxItems) {
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems).map((item) => trimArrays(item, maxItems));
    return value.length > maxItems ? [...kept, `… ${value.length - maxItems} more items`] : kept;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimArrays(entry, maxItems)]));
  return value;
}

function renderShell(value, budget) {
  const failed = value.code !== 0;
  const seconds = value.durationMs >= 1000 ? `${(value.durationMs / 1000).toFixed(1)}s` : `${value.durationMs ?? 0}ms`;
  const header = `$ ${String(value.command || '').split('\n')[0].slice(0, 300)}\n→ exit ${value.code}${value.timedOut ? ' (timed out)' : ''}${value.aborted ? ' (aborted)' : ''} in ${seconds}`;
  const stdout = cleanText(value.stdout).replace(/\s+$/, '');
  const stderr = cleanText(value.stderr).replace(/\s+$/, '');
  const room = Math.max(500, budget - header.length - 40);
  const sections = [];
  let omitted = 0;
  let condensed = false;
  const add = (label, text, share) => {
    if (!text) return;
    const result = condenseText(text, Math.floor(room * share));
    omitted += result.omittedLines;
    condensed ||= result.condensed;
    sections.push(`[${label}]\n${result.text}`);
  };
  // On failure the error stream is where the answer is; on success the output is.
  if (stdout && stderr) { add(failed ? 'stderr' : 'stdout', failed ? stderr : stdout, 0.6); add(failed ? 'stdout' : 'stderr', failed ? stdout : stderr, 0.4); }
  else add(stdout ? 'stdout' : 'stderr', stdout || stderr, 1);
  const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !NOISY_SHELL_FIELDS.has(key)));
  const tail = Object.keys(extras).length ? `\n${compactJson(extras)}` : '';
  return { text: `${header}${sections.length ? `\n${sections.join('\n')}` : '\n(no output)'}${tail}`, omittedLines: omitted, condensed };
}

// A file read that does not fit is cut at a line boundary with a pointer to where it continues:
// dropping lines from the middle of source code would be worse than not showing them.
function renderFileRead(value, budget) {
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'content'));
  const head = compactJson(rest);
  const room = Math.max(500, budget - head.length - 160);
  const lines = String(value.content).split('\n');
  let used = 0;
  let kept = 0;
  while (kept < lines.length && used + lines[kept].length + 1 <= room) { used += lines[kept].length + 1; kept += 1; }
  if (kept === lines.length) return { text: `${head}\ncontent:\n${value.content}`, omittedLines: 0, condensed: false };
  kept = Math.max(1, kept);
  const next = (Number(value.startLine) || 1) + kept;
  const note = `… [showing ${kept} of ${lines.length} lines; the file continues at line ${next} — read it with fs_read startLine=${next}]`;
  return { text: `${head}\ncontent:\n${lines.slice(0, kept).join('\n')}\n${note}`, omittedLines: 0, condensed: true };
}

// Content kinds a tool result can carry. JSON and code compress structurally — an MCP schema's
// repeated $defs blocks, a source file's function bodies — where line-based head/tail condensing
// would throw away exactly the information that makes the payload useful.
export function detectContentKind(text) {
  const sample = String(text).slice(0, 4096).trim();
  if (!sample) return 'text';
  const jsonFramed = sample.startsWith('{') || (sample.startsWith('[') && /^\[[\s\[{"]/.test(sample));
  if (jsonFramed) {
    try { JSON.parse(sample); return 'json'; } catch {
      // The 4KB sample may end mid-payload — only call it partial when the whole text also fails
      // to parse, so a large-but-valid JSON document is not misrouted.
      try { JSON.parse(String(text)); return 'json'; } catch { return 'json-partial'; }
    }
  }
  const codeSignals = /^(?:import|export|package |func |fn |def |class |#include|using namespace|public (?:static )?(?:class|void)|interface |type \w+ (?:struct|interface))/m.test(sample);
  if (codeSignals) return 'code';
  const lines = sample.split('\n');
  const logLines = lines.filter((line) => /^\[?\d{4}[-/]\d{2}[-/]\d{2}|^\d{2}:\d{2}:\d{2}|^\[(?:INFO|WARN|ERROR|DEBUG|TRACE)\]/i.test(line)).length;
  if (lines.length >= 4 && logLines >= lines.length / 2) return 'log';
  return 'text';
}

// Parses the longest valid JSON prefix of a broken payload: everything up to the point where the
// stream broke, with dangling open containers closed off. Returns null when nothing parses.
// Recovers the valid prefix of a broken JSON payload: scan with the string/escape rules, track
// the open container stack, and cut at the last complete value boundary, closing what is still
// open. Returns null when not even the outermost value completes.
// Recovers the valid prefix of a broken JSON payload with a real state machine: tracks whether
// the scanner is expecting a key, a colon, or a value at each depth, and cuts at the last point
// where closing the still-open containers yields parseable JSON. Returns null when nothing parses.
export function parseJsonPrefix(text) {
  const source = String(text);
  // frame: { container: '{' | '[', state: 'key' | 'colon' | 'value' | 'comma' }
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastComplete = 0;
  const top = () => stack.at(-1);
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') {
        inString = false;
        const frame = top();
        if (!frame) { lastComplete = i + 1; continue; } // top-level string is a value
        if (frame.container === '{' && frame.state === 'key') { frame.state = 'colon'; continue; }
        if (frame.state === 'value') { frame.state = 'comma'; lastComplete = i + 1; continue; }
        // A string where a key was expected but followed by ':' is handled above; anything else
        // leaves the position unsafe to cut at.
      }
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      stack.push({ container: ch, state: ch === '{' ? 'key' : 'value' });
      continue;
    }
    if (ch === '}' || ch === ']') {
      const frame = top();
      const open = ch === '}' ? '{' : '[';
      if (!frame || frame.container !== open) break;
      // Only close when the container holds complete entries, not a dangling key or half value.
      if (frame.state === 'comma' || (frame.container === '{' && frame.state === 'key') || (frame.container === '[' && frame.state === 'value')) {
        stack.pop();
        lastComplete = i + 1;
        const parent = top();
        if (parent) parent.state = 'comma';
        continue;
      }
      break;
    }
    if (ch === ':') {
      const frame = top();
      if (frame && frame.state === 'colon') frame.state = 'value';
      continue;
    }
    if (ch === ',') {
      const frame = top();
      if (frame && frame.state === 'comma') {
        frame.state = frame.container === '{' ? 'key' : 'value';
        lastComplete = i;
      }
      continue;
    }
    // A scalar (number, true, false, null, -): mark complete only when a value was expected.
    const frame = top();
    if (frame && frame.state === 'value') { frame.state = 'comma'; lastComplete = i + 1; }
  }
  if (!stack.length && lastComplete > 0) {
    try { return { value: JSON.parse(source.slice(0, lastComplete)), recovered: source.length - lastComplete }; } catch { /* fall through */ }
  }
  // Close whatever is still open at the last complete boundary.
  const prefix = source.slice(0, lastComplete);
  const closing = stack.slice().reverse().map((frame) => (frame.container === '{' ? '}' : ']')).join('');
  try { return { value: JSON.parse(prefix + closing), recovered: source.length - lastComplete }; } catch { return null; }
}

// JSON is compressed structurally: identical repeated object shapes are described once, arrays
// beyond the cap become a count, long scalar strings shorten with their length attached, and
// everything stays valid-JSON-parseable after rendering so the model can still reason over it.
function shapeSignature(value) {
  if (value === null || typeof value !== 'object') return typeof value;
  if (Array.isArray(value)) return `[${value.length ? shapeSignature(value[0]) : ''}]`;
  return `{${Object.keys(value).sort().map((key) => `${key}:${shapeSignature(value[key])}`).join(',')}}`;
}

const JSON_STRING_CAP = 160;
const JSON_ARRAY_CAP = 12;
const JSON_DEPTH_CAP = 6;

export function crushJson(value, { maxItems = JSON_ARRAY_CAP, maxString = JSON_STRING_CAP, maxDepth = JSON_DEPTH_CAP, retrievalHint = 'full payload is in the session transcript — re-run the tool or read earlier output for detail' } = {}) {
  let dedupedShapes = 0;
  let truncatedStrings = 0;
  const seenShapes = new Map();
  // Repeated siblings collapse once the list is long enough that the "more items" note costs
  // less than the uncapped entries would — short lists pass through whole.
  const arrayCap = (length) => Math.max(4, Math.min(maxItems, Math.ceil(length / 2)));
  const walk = (node, depth, inArray = false) => {
    if (typeof node === 'string') {
      if (node.length > maxString) { truncatedStrings += 1; return `${node.slice(0, maxString)}… [${node.length - maxString} chars cut]`; }
      return node;
    }
    if (node === null || typeof node !== 'object') return node;
    if (depth >= maxDepth) return { '…': `${Array.isArray(node) ? `array(${node.length})` : `object(${Object.keys(node).length} keys)`} — depth limit, ${retrievalHint}` };
    if (Array.isArray(node)) {
      const cap = arrayCap(node.length);
      const kept = node.slice(0, cap).map((item) => walk(item, depth + 1, true));
      if (node.length > cap) kept.push(`… ${node.length - cap} more items like item[0] — ${retrievalHint}`);
      return kept;
    }
    // Shape dedupe pays only for repeated siblings (a tool list, a schema registry): collapsing
    // every repeated object shape in a tree would strip distinct sections that merely look alike.
    if (inArray) {
      const signature = shapeSignature(node);
      const prior = seenShapes.get(signature);
      if (prior && Object.keys(node).length >= 3) {
        seenShapes.set(signature, prior + 1);
        dedupedShapes += 1;
        const idKeys = Object.keys(node).filter((key) => /^(name|id|title|type|command|path|url|method)$/i.test(key)).slice(0, 4);
        const identity = Object.fromEntries(idKeys.map((key) => [key, node[key]]));
        return { ...identity, '…': `same shape as earlier (${Object.keys(node).length} keys)` };
      }
      seenShapes.set(signature, 1);
    }
    return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, walk(entry, depth + 1, false)]));
  };
  let crushed = walk(value, 0);
  // Value interning: a long string that still appears more than once in the crushed output is
  // pooled into a "$values" table and replaced everywhere by a short "$v0" reference, so a
  // repeated $ref or URL costs its length once. Counting after the walk means strings that were
  // truncated or dropped never enter the pool, and singletons stay inline.
  const counts = new Map();
  const tally = (node) => {
    if (typeof node === 'string') { if (node.length >= 40) counts.set(node, (counts.get(node) || 0) + 1); return; }
    if (node && typeof node === 'object') Object.values(node).forEach(tally);
  };
  tally(crushed);
  const rootIsObject = crushed !== null && typeof crushed === 'object' && !Array.isArray(crushed);
  const poolKey = '$values';
  const repeated = [...counts].filter(([, n]) => n > 1).map(([text]) => text);
  let pooledStrings = 0;
  if (repeated.length && !(rootIsObject && poolKey in crushed)) {
    const refs = new Map(repeated.map((text, index) => [text, `$v${index}`]));
    const swap = (node) => {
      if (typeof node === 'string') return refs.get(node) ?? node;
      if (Array.isArray(node)) return node.map(swap);
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, swap(entry)]));
      return node;
    };
    const table = Object.fromEntries(repeated.map((text, index) => [`$v${index}`, text]));
    // An array root has nowhere to carry the table, so it is wrapped to keep the refs decodable.
    crushed = rootIsObject ? { ...swap(crushed), [poolKey]: table } : { $items: swap(crushed), [poolKey]: table };
    pooledStrings = repeated.length;
  }
  return { crushed, dedupedShapes, truncatedStrings, pooledStrings };
}

// Code keeps imports/exports/signatures; function bodies longer than a few lines collapse to a
// marker naming how much was hidden. String/comment text is blanked before brace counting so a
// literal like "}}{{" or a regex /}/ cannot poison the depth; the original line text is what gets
// emitted, the blanked copy only drives the structural walk.
export function blankCodeText(line) {
  let out = '';
  let mode = null; // null | "'" | '"' | '`' | '//'
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (mode === '//') break;
    if (mode) {
      if (ch === '\\') { out += '  '; i += 1; continue; }
      if (ch === mode) mode = null;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') { mode = '//'; out += '  '; i += 1; continue; }
    // A regex literal follows an operator or open delimiter, never an operand. A slash after
    // whitespace is division when the last non-space character is an identifier/close paren —
    // only a keyword boundary (return, case, typeof…) can precede a regex there.
    if (ch === '/' && next !== '/' && /[=(:,;!&|?{}+\-*%<>^~\[\s]|^$/.test(out.at(-1) ?? '')) {
      if (next === '*') { out += ch; continue; }
      if (/\s/.test(out.at(-1) ?? '')) {
        const prev = out.match(/(\S)\s*$/)?.[1] || '';
        if (prev && /[\w)\]]/.test(prev)) {
          const word = out.match(/(\w+)\s*$/)?.[1] || '';
          if (!/^(return|case|typeof|instanceof|in|of|new|delete|void|throw|else|do|yield|await)$/.test(word)) { out += ch; continue; }
        }
      }
      let j = i + 1;
      while (j < line.length && line[j] !== '/') j += line[j] === '\\' ? 2 : 1;
      if (j < line.length && j > i + 1) { out += ' '.repeat(j - i + 1); i = j; continue; }
    }
    if (ch === "'" || ch === '"' || ch === '`') { mode = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}

const SIGNATURE_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s+)?function|func\s+(?:\([^)]*\)\s*)?\w+|fn\s+\w+|def\s+\w+|interface\s+\w+|type\s+\w+|public|private|protected|static|#include|import\s|package\s)|^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*[:{]/;
export function skeletonCode(text, { bodyLineCap = 4 } = {}) {
  const lines = String(text).split('\n');
  const blanked = lines.map(blankCodeText);
  const out = [];
  let hiddenLines = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const structure = blanked[i];
    out.push(line);
    if (SIGNATURE_LINE.test(structure) && (structure.includes('{') || structure.trimEnd().endsWith(':'))) {
      const opener = structure.includes('{') ? '{' : ':';
      const braceDelta = (s) => (s.split('{').length - 1) - (s.split('}').length - 1);
      let depth = opener === '{' ? braceDelta(structure) : 1;
      let bodyLines = 0;
      let j = i + 1;
      const bodyStart = j;
      while (j < lines.length && depth > 0) {
        if (opener === '{') depth += braceDelta(blanked[j]);
        else if (blanked[j].trim() !== '' && !/^\s/.test(lines[j])) depth = 0;
        bodyLines += 1;
        j += 1;
      }
      if (bodyLines > bodyLineCap) {
        // Keep the first couple of body lines so control flow is visible, collapse the rest.
        const kept = lines.slice(bodyStart, bodyStart + Math.min(2, bodyLineCap - 1));
        out.push(...kept);
        const hidden = bodyLines - kept.length;
        hiddenLines += hidden;
        out.push(`  … [${hidden} body line${hidden === 1 ? '' : 's'} collapsed — read the file for the full function]`);
      } else {
        out.push(...lines.slice(bodyStart, bodyStart + bodyLines));
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { text: out.join('\n'), hiddenLines, condensed: hiddenLines > 0 };
}

function renderObject(value, budget) {
  if (typeof value.content === 'string' && value.content.length > 300 && 'totalLines' in value) return renderFileRead(value, budget);
  const bulky = BULKY_FIELDS.find((key) => typeof value[key] === 'string' && value[key].length > 300);
  if (bulky) {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== bulky));
    const head = compactJson(rest);
    const bodyText = value[bulky];
    const kind = LOG_FIELDS.has(bulky) ? 'log' : detectContentKind(bodyText);
    if (kind === 'code' && bodyText.length > 4000) {
      const skeleton = skeletonCode(bodyText);
      if (skeleton.condensed) {
        const text = `${head}\n${bulky} (code skeleton — bodies collapsed):\n${skeleton.text}`;
        if (text.length <= budget) return { text, omittedLines: skeleton.hiddenLines, condensed: true };
      }
    }
    const body = condenseText(bodyText, Math.max(500, budget - head.length - 20), { important: LOG_FIELDS.has(bulky) });
    return { text: `${head}\n${bulky}:\n${body.text}`, omittedLines: body.omittedLines, condensed: body.condensed };
  }
  let text = compactJson(value);
  if (text.length <= budget) return { text, omittedLines: 0, condensed: false };
  // Structured crush before array trimming: repeated schemas and long string values go first,
  // so a compact payload that survives whole beats a bigger one silently decapitated.
  const { crushed, dedupedShapes, truncatedStrings, pooledStrings } = crushJson(value);
  if (dedupedShapes + truncatedStrings > 0 || pooledStrings > 0) {
    const crushedText = compactJson(crushed);
    if (crushedText.length <= budget) return { text: crushedText, omittedLines: 0, condensed: true };
    text = crushedText;
  }
  for (const maxItems of [200, 100, 50, 25, 12, 6]) {
    const attempt = compactJson(trimArrays(crushed, maxItems));
    if (attempt.length <= budget) return { text: attempt, omittedLines: 0, condensed: true };
  }
  return { text: `${text.slice(0, budget)}… [${text.length - budget} chars cut]`, omittedLines: 0, condensed: true };
}

/**
 * Renders a tool result for the model. `spill(text)` is called with the complete output when
 * something had to be left out, and returns where it was saved (or null).
 */
export async function shapeObservation(value, { budget = 60_000, spill = null, isError = false } = {}) {
  let result;
  if (typeof value === 'string') {
    // Content-kind routing for bare strings: big code payloads keep their structure instead of
    // being decapitated line-wise; JSON strings crush structurally; logs and prose keep the
    // existing error-aware condense path.
    const kind = value.length > 4000 ? detectContentKind(value) : 'text';
    if (kind === 'code') {
      const skeleton = skeletonCode(value);
      if (skeleton.condensed && skeleton.text.length <= budget) {
        result = { text: skeleton.text, omittedLines: skeleton.hiddenLines, condensed: true };
      }
    } else if (kind === 'json-partial') {
      const prefix = parseJsonPrefix(value);
      if (prefix && prefix.value && typeof prefix.value === 'object') {
        const { crushed } = crushJson(prefix.value);
        const note = `[truncated JSON — recovered the parseable prefix, ${prefix.recovered} chars lost; full payload may be in the session transcript]`;
        const body = compactJson(crushed);
        if (body.length + note.length + 2 <= budget) {
          result = { text: `${note}\n${body}`, omittedLines: 0, condensed: true };
        }
      }
    }
    if (!result) {
      const condensed = condenseText(value, budget);
      result = { text: condensed.text, omittedLines: condensed.omittedLines, condensed: condensed.condensed };
    }
  } else if (isShellResult(value)) result = renderShell(value, budget);
  else if (value && typeof value === 'object' && !Array.isArray(value)) result = renderObject(value, budget);
  else {
    const text = compactJson(value);
    result = text.length <= budget ? { text, omittedLines: 0, condensed: false } : renderObject({ items: value }, budget);
  }

  let { text } = result;
  if (result.omittedLines && spill && !isError) {
    const full = typeof value === 'string' ? value : (isShellResult(value) ? `${value.stdout || ''}${value.stderr ? `\n--- stderr ---\n${value.stderr}` : ''}` : compactJson(value));
    const saved = await spill(cleanText(full)).catch(() => null);
    if (saved) text += `\n[${result.omittedLines} lines omitted — full output saved to ${saved}; read part of it with fs_read startLine/endLine or search it with search_text]`;
  }
  if (text.length > budget + 600) text = `${text.slice(0, budget)}… [${text.length - budget} chars cut]`;
  return { text, condensed: result.condensed, omittedLines: result.omittedLines };
}
