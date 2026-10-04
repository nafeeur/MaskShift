// Lessons: things a run learned the hard way, kept so the next similar run does not have to.
//
// They are derived from what actually happened — a command that failed and the one that then worked, a verification
// that had to be re-run, a loop the harness had to break — not from the model's own opinion of itself. Each is stored as
// an ordinary memory (so `memory_list` shows it and `memory_delete` removes it), tagged with the kind of task it came
// from. They are shown in later runs only when the task looks alike, and each carries a score: lessons that were shown
// and then the run went well gain trust; lessons that were shown and the run went badly lose it, and the untrusted ones
// are dropped.

import { sha256 } from '../core/utils.mjs';
import { commandKey, isVerifyCommand, pathsOf } from './trace.mjs';
import { classifyTask, similarity } from './profile.mjs';

const DAY = 86_400_000;
const FACT_TASKS = new Set(['verification', 'debugging', 'general-coding', 'large-change', 'frontend', 'systems']);
const clip = (text, max) => { const value = String(text ?? ''); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** An error reduced to what stays the same between occurrences: no ANSI, numbers, paths or hashes. */
export function errorSignature(text) {
  const line = String(text || '').replace(ANSI, '').split('\n').map((item) => item.trim()).find((item) => item && !/^\{?"?(error|tool)"?:?/i.test(item) && !/^at /.test(item))
    || String(text || '').replace(ANSI, '').replace(/[{}"\\]/g, ' ').trim();
  return clip(line.replace(/(?:\/[\w.@-]+){2,}/g, '<path>').replace(/\b[0-9a-f]{7,}\b/g, '<hash>').replace(/\d+/g, '#').replace(/\s+/g, ' '), 140);
}

export function parseErrorContent(content) {
  try { const value = JSON.parse(content); if (value?.error) return String(value.error); } catch { /* plain text */ }
  return String(content || '');
}

const summarizeArgs = (args) => clip(JSON.stringify(Object.fromEntries(Object.entries(args || {}).slice(0, 3).map(([key, value]) => [key, typeof value === 'string' ? clip(value, 60) : value]))), 140);

/** Candidate lessons from one finished run. Pure: no store, no model. */
export function deriveLessons(run, trace) {
  const out = [];
  const profile = classifyTask(run.prompt);
  const success = run.status === 'completed';

  // How this workspace is built and tested, learned from commands that passed in a run that finished.
  if (success) {
    const lastByKey = new Map();
    for (const item of trace.commands) if (isVerifyCommand(item.command) && item.ok) lastByKey.set(item.key, item);
    for (const [key, item] of lastByKey) {
      out.push({ kind: 'fact', key: `verify:${key}`, title: `How to check this project: ${key}`, importance: 0.65,
        content: `\`${clip(item.command, 160)}\` works in this workspace and passed at the end of a successful run. Run it to check your work before saying you are done.` });
    }
  }

  // A command that failed and was then fixed.
  for (const [index, failure] of trace.commands.entries()) {
    if (failure.ok !== false) continue;
    const fix = trace.commands.slice(index + 1).find((item) => item.key === failure.key && item.ok === true && item.command !== failure.command);
    if (!fix) continue;
    const call = trace.calls.find((candidate) => candidate.name === 'shell_exec' && candidate.args.command === failure.command && candidate.ok === false);
    const signature = errorSignature(parseErrorContent(call?.content));
    out.push({ kind: 'lesson', key: `fix:${failure.key}:${sha256(signature).slice(0, 8)}`, title: `Fixing a failing ${failure.key} command`, importance: 0.6,
      content: `\`${clip(failure.command, 140)}\` failed (${signature}). \`${clip(fix.command, 140)}\` worked instead.` });
  }

  // Editing from memory instead of from the file.
  const patchMisses = trace.calls.filter((call) => call.name === 'fs_patch' && call.ok === false && /not found|matched \d+ locations/i.test(call.content));
  if (patchMisses.length >= 2) {
    out.push({ kind: 'lesson', key: 'habit:read-before-patch', title: 'Read a file just before patching it', importance: 0.5,
      content: 'Patches failed to match when they were written from memory. Re-read the exact lines with fs_read, then patch.' });
  }

  // Verification that did not pass the first time.
  const failed = trace.verifications.filter((item) => !item.ok);
  if (failed.length) {
    const commands = [...new Set(failed.flatMap((item) => item.results.filter((result) => !result.ok).map((result) => result.command)))].slice(0, 3);
    const passedLater = trace.verifications.some((item) => item.ok);
    const files = [...trace.edited].slice(0, 5).join(', ');
    out.push({ kind: 'lesson', key: `verify-loop:${sha256(commands.join('|')).slice(0, 8)}`, title: `Run ${commands[0] || 'the checks'} before finishing`, importance: passedLater ? 0.55 : 0.45,
      content: passedLater
        ? `\`${commands.join('`, `')}\` failed on the first attempt of an earlier run${files ? ` after changing ${files}` : ''} and passed once fixed. Run it before declaring done.`
        : `\`${commands.join('`, `')}\` was still failing when an earlier run ended${files ? ` (changes in ${files})` : ''}. Treat it as the thing to get green first.` });
  }

  // A loop the harness had to break.
  if (trace.stagnation?.tool) {
    const call = trace.calls.filter((item) => item.name === trace.stagnation.tool).at(-1);
    out.push({ kind: 'lesson', key: `loop:${trace.stagnation.tool}:${sha256(JSON.stringify(call?.args || {})).slice(0, 8)}`, title: `Do not repeat ${trace.stagnation.tool} on this`, importance: 0.5,
      content: `An earlier run repeated ${trace.stagnation.tool}(${summarizeArgs(call?.args)}) with the same result until it was stopped. Change the approach instead of repeating it.` });
  }
  if (trace.stuck) {
    out.push({ kind: 'lesson', key: `stuck:${sha256(String(run.prompt).slice(0, 200)).slice(0, 8)}`, title: 'A task like this got stuck', importance: 0.45,
      content: `An earlier run on a similar task made no progress after ${trace.stuck.turns} turns (${trace.stuck.reason}). Read the error carefully, narrow the problem, and ask the user if blocked.` });
  }
  return out.map((lesson) => ({ ...lesson, profile }));
}

export class LessonStore {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  /** Save or reinforce. Reinforcing keeps the bookkeeping (how often it was shown and how those runs went). */
  save(lesson, { workspaceId, runId }) {
    const scope = lesson.scope || 'workspace';
    const title = `${lesson.kind === 'fact' ? 'Fact' : 'Lesson'} · ${lesson.key}`;
    const existing = this.store.listMemoriesByKind(lesson.kind, { workspaceId, limit: 1000 }).find((memory) => memory.meta?.key === lesson.key);
    const meta = existing?.meta || { kind: lesson.kind, key: lesson.key, occurrences: 0, shown: 0, helped: 0, hurt: 0, trigger: { tags: [], tokens: [] } };
    meta.occurrences = (meta.occurrences || 0) + 1;
    meta.lastRunId = runId;
    meta.lastSeen = new Date().toISOString();
    meta.trigger = {
      tags: [...new Set([...(meta.trigger?.tags || []), ...lesson.profile.tags])].slice(0, 8),
      tokens: [...new Set([...(meta.trigger?.tokens || []), ...lesson.profile.tokens])].slice(0, 30),
    };
    return this.store.saveMemory({
      id: existing?.id, workspaceId: scope === 'global' ? null : workspaceId, scope, title, content: lesson.content, tags: [lesson.kind, ...lesson.profile.tags],
      importance: Math.min(0.95, Math.max(lesson.importance, existing?.importance || 0) + (existing ? 0.03 : 0)), meta, dedupe: false,
    });
  }

  confidence(meta) {
    const judged = (meta.helped || 0) + (meta.hurt || 0);
    return judged ? ((meta.helped || 0) + 1) / (judged + 2) : 0.6;
  }

  /** The lessons worth showing for this task, best first, within a character budget. */
  relevant({ prompt, workspaceId, limit = 6, maxChars = 2400 }) {
    const profile = classifyTask(prompt);
    const candidates = [...this.store.listMemoriesByKind('lesson', { workspaceId }), ...this.store.listMemoriesByKind('fact', { workspaceId })];
    const scored = candidates.map((memory) => {
      const meta = memory.meta || {};
      const confidence = this.confidence(meta);
      if ((meta.hurt || 0) >= 3 && confidence < 0.3) return null;
      const alike = similarity(profile, meta.trigger || {});
      const factBase = meta.kind === 'fact' && profile.tags.some((tag) => FACT_TASKS.has(tag)) ? 0.35 : 0;
      const relevance = Math.max(alike, factBase);
      const score = relevance * confidence * (0.6 + 0.4 * Math.min(1, (meta.occurrences || 1) / 3));
      return score >= 0.1 ? { memory, score, confidence } : null;
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    const picked = [];
    let used = 0;
    for (const item of scored) {
      const cost = item.memory.content.length + 4;
      if (picked.length >= limit || used + cost > maxChars) continue;
      picked.push({ id: item.memory.id, kind: item.memory.meta.kind, text: item.memory.content, confidence: item.confidence, score: item.score });
      used += cost;
    }
    return picked;
  }

  /** The run those lessons were shown to ended; remember how it went. */
  credit(ids, success) {
    for (const id of new Set(ids || [])) {
      const memory = this.store.getMemory(id);
      if (!memory) continue;
      const meta = { ...memory.meta, shown: (memory.meta.shown || 0) + 1 };
      if (success) meta.helped = (meta.helped || 0) + 1; else meta.hurt = (meta.hurt || 0) + 1;
      this.store.saveMemory({ id, workspaceId: memory.workspace_id, scope: memory.scope, title: memory.title, content: memory.content, tags: memory.tags, importance: memory.importance, meta, dedupe: false });
    }
  }

  /** Drop what has been tried and found wanting, or never mattered, and keep the pile bounded. */
  prune({ now = Date.now(), cap = 200 } = {}) {
    let removed = 0;
    for (const kind of ['lesson', 'fact']) {
      const all = this.store.listMemoriesByKind(kind, { limit: 2000 });
      const keep = [];
      for (const memory of all) {
        const meta = memory.meta || {};
        const untrusted = (meta.shown || 0) >= 5 && this.confidence(meta) < 0.25;
        const forgotten = (meta.occurrences || 1) <= 1 && !(meta.shown || 0) && now - Date.parse(meta.lastSeen || memory.updated_at) > 150 * DAY;
        if (untrusted || forgotten) { this.store.deleteMemory(memory.id); removed += 1; } else keep.push(memory);
      }
      keep.sort((a, b) => (this.confidence(b.meta) * (b.meta.occurrences || 1)) - (this.confidence(a.meta) * (a.meta.occurrences || 1)));
      for (const memory of keep.slice(cap)) { this.store.deleteMemory(memory.id); removed += 1; }
    }
    return removed;
  }

  list({ workspaceId } = {}) {
    return [...this.store.listMemoriesByKind('lesson', { workspaceId }), ...this.store.listMemoriesByKind('fact', { workspaceId })]
      .map((memory) => ({ id: memory.id, kind: memory.meta.kind, text: memory.content, occurrences: memory.meta.occurrences || 1, shown: memory.meta.shown || 0, helped: memory.meta.helped || 0, hurt: memory.meta.hurt || 0, confidence: this.confidence(memory.meta), scope: memory.scope }))
      .sort((a, b) => b.confidence * b.occurrences - a.confidence * a.occurrences);
  }
}

export { pathsOf, commandKey };
