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
    // One hue, so the cue is brightness and weight: an added line is bright and bold, a removed
    // line is dim and struck through, context recedes. The +/- markers say the same in text.
    const style = {
      header: { fg: theme.roles.label, bold: true },
      hunk: { fg: theme.roles.info, bold: true },
      add: { fg: theme.roles.heading, bold: true },
      remove: { fg: theme.roles.muted, strike: true },
      context: { fg: theme.roles.dim },
    }[kind];
    return gutter(theme) + theme.paint(fit(truncate(line, width), width), style);
  });
  if (raw.length > maxLines) {
    lines.push(gutter(theme) + theme.paint(`… ${raw.length - maxLines} more line${raw.length - maxLines === 1 ? '' : 's'}`, { fg: theme.roles.faint, italic: true }));
  }
  return lines;
}
