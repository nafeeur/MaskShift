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

function renderObject(value, budget) {
  if (typeof value.content === 'string' && value.content.length > 300 && 'totalLines' in value) return renderFileRead(value, budget);
  const bulky = BULKY_FIELDS.find((key) => typeof value[key] === 'string' && value[key].length > 300);
  if (bulky) {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== bulky));
    const head = compactJson(rest);
    const body = condenseText(value[bulky], Math.max(500, budget - head.length - 20), { important: LOG_FIELDS.has(bulky) });
    return { text: `${head}\n${bulky}:\n${body.text}`, omittedLines: body.omittedLines, condensed: body.condensed };
  }
  let text = compactJson(value);
  if (text.length <= budget) return { text, omittedLines: 0, condensed: false };
  for (const maxItems of [200, 100, 50, 25, 12, 6]) {
    text = compactJson(trimArrays(value, maxItems));
    if (text.length <= budget) return { text, omittedLines: 0, condensed: true };
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
    const condensed = condenseText(value, budget);
    result = { text: condensed.text, omittedLines: condensed.omittedLines, condensed: condensed.condensed };
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
