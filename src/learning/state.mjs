// Working state, tracked by the harness rather than remembered by the model.
//
// When old turns are dropped to fit the window, a prose summary keeps the gist but loses exactly what a continuing run needs:
// which files were changed, which commands ran and how they ended, what errors are still open. That is read straight from the
// tool calls and results — deterministically, with no model — and appended to the summary, so it survives even when
// summarising fails, and a small model that summarises badly still keeps its place.

import { commandKey } from './trace.mjs';
import { errorSignature, parseErrorContent } from './lessons.mjs';
import { looksReadOnly, pathsOf } from './trace.mjs';

const clip = (text, max) => { const value = String(text ?? ''); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

export const emptyState = () => ({ goal: '', edited: [], read: [], commands: [], errors: [], decisions: [] });

export function extractState(messages, state = emptyState()) {
  const next = { ...state, edited: [...state.edited], read: [...state.read], commands: [...state.commands], errors: [...state.errors], decisions: [...state.decisions] };
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'user' && !next.goal && !/^\[(Harness|Summary)/.test(message.content || '')) next.goal = clip(message.content, 400);
    if (message.role === 'assistant') for (const call of message.toolCalls || []) calls.set(call.id, call);
    if (message.role === 'assistant' && /\b(?:decid\w*|chose|choose|will use|going to use|root cause)\b/i.test(message.content || '')) {
      const line = String(message.content).split('\n').find((item) => /\b(?:decid\w*|chose|choose|will use|going to use|root cause)\b/i.test(item));
      if (line) next.decisions.push(clip(line.trim(), 200));
    }
    if (message.role !== 'tool') continue;
    const call = calls.get(message.toolCallId) || { name: message.toolName, args: {} };
    const readOnly = looksReadOnly(call.name);
    for (const file of pathsOf(call.args)) (readOnly ? next.read : next.edited).push(file);
    if (call.name === 'shell_exec' && call.args?.command) next.commands.push({ command: clip(call.args.command, 120), key: commandKey(call.args.command), ok: !message.isError });
    if (message.isError) next.errors.push(`${call.name === 'shell_exec' && call.args?.command ? commandKey(call.args.command) : call.name}: ${errorSignature(parseErrorContent(message.content))}`);
  }
  next.edited = [...new Set(next.edited)];
  next.read = [...new Set(next.read)].filter((file) => !next.edited.includes(file));
  next.errors = [...new Set(next.errors)].slice(-6);
  next.decisions = [...new Set(next.decisions)].slice(-5);
  next.commands = next.commands.slice(-12);
  return next;
}

/** Keep a command only while it is the latest word on its kind: a later success supersedes an earlier failure. */
export function renderState(state, { max = 1800 } = {}) {
  const lines = ['## Working state (tracked by the harness; trust this over memory)'];
  if (state.goal) lines.push(`- Goal: ${state.goal}`);
  if (state.edited.length) lines.push(`- Files changed: ${state.edited.slice(-20).join(', ')}`);
  if (state.read.length) lines.push(`- Files read: ${state.read.slice(-15).join(', ')}`);
  const latest = new Map();
  for (const item of state.commands) latest.set(item.key, item);
  const commands = [...latest.values()].slice(-8);
  if (commands.length) lines.push(`- Commands: ${commands.map((item) => `\`${item.command}\` ${item.ok ? '✓' : '✗ failed'}`).join('; ')}`);
  const open = state.errors.filter((error) => !commands.some((item) => item.ok && error.startsWith(`${item.key}:`)));
  if (open.length) lines.push(`- Errors seen: ${open.join(' | ')}`);
  if (state.decisions.length) lines.push(`- Decisions: ${state.decisions.join(' | ')}`);
  return lines.length > 1 ? clip(lines.join('\n'), max) : '';
}
