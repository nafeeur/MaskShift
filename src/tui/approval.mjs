// What a gated tool call is about to do, drawn for the approval dialog. A yes/no over a bare
// tool name asks the operator to approve something they cannot see; this shows the command,
// the file and its new contents, or the exact edit as a diff.

import { diffLines, looksLikeDiff } from './diff.mjs';
import { oneLine, truncate, wrap } from './text.mjs';

const MAX_PREVIEW_LINES = 14;

function editsAsDiff(targetPath, edits) {
  const out = [`--- ${targetPath}`, `+++ ${targetPath}`];
  for (const edit of edits || []) {
    out.push(`@@ ${edit.replaceAll ? 'every match' : 'edit'} @@`);
    for (const line of String(edit.oldText ?? '').split('\n')) out.push(`-${line}`);
    for (const line of String(edit.newText ?? '').split('\n')) out.push(`+${line}`);
  }
  return out.join('\n');
}

function labelled(theme, label, value, width) {
  const head = theme.paint(`${label.padEnd(6)}`, { fg: theme.roles.muted });
  return wrap(String(value), Math.max(8, width - 6)).slice(0, 3)
    .map((piece, index) => (index ? ' '.repeat(6) : head) + theme.paint(piece, { fg: theme.roles.text }));
}

function capped(theme, lines, width) {
  if (lines.length <= MAX_PREVIEW_LINES) return lines;
  const hidden = lines.length - MAX_PREVIEW_LINES + 1;
  return [...lines.slice(0, MAX_PREVIEW_LINES - 1), theme.paint(truncate(`… ${hidden} more line${hidden === 1 ? '' : 's'}`, width), { fg: theme.roles.faint, italic: true })];
}

export function approvalPreview(theme, name, args = {}, width = 72) {
  const lines = [];
  if (typeof args.command === 'string') {
    const prompt = theme.paint('$ ', { fg: theme.roles.accent, bold: true });
    wrap(args.command, Math.max(8, width - 2)).forEach((piece, index) => {
      lines.push((index ? '  ' : prompt) + theme.paint(piece, { fg: theme.roles.heading || theme.roles.text, bold: true }));
    });
    if (args.cwd) lines.push('', ...labelled(theme, 'cwd', args.cwd, width));
    if (args.host) lines.push(...labelled(theme, 'host', args.host, width));
    return capped(theme, lines, width);
  }
  // diffLines draws its own two-column gutter inside the width it is given.
  if (Array.isArray(args.edits) && args.path) {
    return capped(theme, diffLines(theme, editsAsDiff(args.path, args.edits), width - 2, { maxLines: MAX_PREVIEW_LINES }), width);
  }
  if (typeof args.patch === 'string' && looksLikeDiff(args.patch)) {
    return capped(theme, diffLines(theme, args.patch, width - 2, { maxLines: MAX_PREVIEW_LINES }), width);
  }
  if (args.path && typeof args.content === 'string') {
    const body = args.content.split('\n');
    lines.push(...labelled(theme, 'file', args.path, width));
    lines.push(...labelled(theme, 'size', `${body.length} line${body.length === 1 ? '' : 's'}, ${args.content.length} chars${args.mode && args.mode !== 'overwrite' ? ` (${args.mode})` : ''}`, width), '');
    for (const line of body) lines.push(theme.paint(truncate(line, width), { fg: theme.roles.dim }));
    return capped(theme, lines, width);
  }
  const entries = Object.entries(args || {});
  if (!entries.length) return [theme.paint(`${name} takes no arguments.`, { fg: theme.roles.muted, italic: true })];
  for (const [key, value] of entries) {
    lines.push(...labelled(theme, key, typeof value === 'string' ? value : oneLine(JSON.stringify(value), 400), width));
  }
  return capped(theme, lines, width);
}
