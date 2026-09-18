// Colours a unified diff for the transcript — the same view `fs_apply_patch`,
// `file_diff` and `git_diff` results get, so a change reads as a change
// instead of another JSON blob to parse by eye.

import { fit, truncate } from './text.mjs';
import { gutter } from './type.mjs';

const DIFF_MAX_LINES = 40;

/** True if this looks like an actual unified diff rather than some other
 *  text a tool happened to return in a field also named "diff" (e.g.
 *  git_diff's own --stat summary). */
export function looksLikeDiff(text) {
  return typeof text === 'string' && /(^|\n)(@@ |diff --git |--- |\+\+\+ )/.test(text);
}

function classify(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'header';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/** Render a unified diff as coloured transcript lines, capped so one patch
 *  can't swallow the whole pane. Each line already carries the gutter every
 *  other transcript row uses, so it lines up under the tool-call summary
 *  above it. */
export function diffLines(theme, patchText, width, { maxLines = DIFF_MAX_LINES } = {}) {
  const raw = String(patchText || '').replace(/\n$/, '').split('\n');
  const shown = raw.slice(0, maxLines);
  const lines = shown.map((line) => {
    const kind = classify(line);
    const tone = {
      header: theme.roles.label,
      hunk: theme.roles.info,
      add: theme.roles.success,
      remove: theme.roles.danger,
      context: theme.roles.dim,
    }[kind];
    const bold = kind === 'header' || kind === 'hunk';
    return gutter(theme) + theme.paint(fit(truncate(line, width), width), { fg: tone, bold });
  });
  if (raw.length > maxLines) {
    lines.push(gutter(theme) + theme.paint(`… ${raw.length - maxLines} more line${raw.length - maxLines === 1 ? '' : 's'}`, { fg: theme.roles.faint, italic: true }));
  }
  return lines;
}
