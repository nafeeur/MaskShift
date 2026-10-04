// The learning layer's single entry point. The engine calls into this at three moments and nowhere else:
//
//   before a run   contextSections()  — lessons and preferences worth showing, and the note if the request is thin
//   during a run   guard / hints      — the uncertainty and progress monitors, prefetch hints (called by the engine directly)
//   after a run    afterRun()         — record the outcome, derive lessons, learn preferences, measure context use
//
// Everything here is best-effort and must never change how a run ends: failures are logged and swallowed.

import { OutcomeLedger } from './ledger.mjs';
import { LearnedRouter } from './route.mjs';
import { LessonStore, deriveLessons } from './lessons.mjs';
import { PreferenceStore } from './preferences.mjs';
import { SkillMiner } from './skill-miner.mjs';
import { ContextFeedback, measureUse } from './context-feedback.mjs';
import { applyConsolidation, planConsolidation } from './consolidate.mjs';
import { ambiguityNote, assessPrompt } from './uncertainty.mjs';
import { buildTrace, correctionsIn } from './trace.mjs';

const DAY = 86_400_000;
const MAINTAIN_EVERY = 10; // runs between consolidation / pruning / skill mining passes

export function learningSettings(config) {
  const raw = config.get().learning || {};
  return {
    enabled: raw.enabled !== false,
    lessons: raw.lessons !== false,
    preferences: raw.preferences !== false,
    prefetch: raw.prefetch !== false,
    consolidate: raw.consolidate !== false,
    uncertainty: { mode: raw.uncertainty?.mode || 'guard', headless: raw.uncertainty?.headless || 'block', ambiguity: raw.uncertainty?.ambiguity !== false },
    routing: { learned: raw.routing?.learned !== false, escalate: raw.routing?.escalate !== false, maxEscalations: raw.routing?.maxEscalations ?? 1 },
    tools: { cache: raw.tools?.cache !== false, batch: raw.tools?.batch !== false },
  };
}

export class LearningManager {
  constructor({ store, config, logger, eventBus, skillManager, workspaceManager, getCodeGraph = () => null }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.workspaceManager = workspaceManager;
    this.getCodeGraph = getCodeGraph;
    this.ledger = new OutcomeLedger({ store });
    this.router = new LearnedRouter({ ledger: this.ledger, config });
    this.lessons = new LessonStore({ store, config });
    this.preferences = new PreferenceStore({ store });
    this.miner = new SkillMiner({ store, skillManager, config, logger });
    this.feedback = new ContextFeedback({ store, config });
    this.pending = new Set();
  }

  settings() { return learningSettings(this.config); }

  // ----------------------------------------------------------------- before

  /** What to put in front of the model for this task, beyond the repository itself. */
  contextSections({ workspaceId, prompt, hasHistory = false }) {
    const settings = this.settings();
    if (!settings.enabled) return { lessons: [], preferences: [], notes: [], text: '', ids: { lessons: [], preferences: [] } };
    const lessons = settings.lessons ? this.lessons.relevant({ prompt, workspaceId }) : [];
    const preferences = settings.preferences ? this.preferences.top({ workspaceId }) : [];
    const notes = [];
    if (settings.uncertainty.mode !== 'off' && settings.uncertainty.ambiguity) {
      const assessment = assessPrompt(prompt, { hasHistory });
      if (assessment.ambiguous) notes.push(ambiguityNote(assessment));
    }
    const sections = [];
    if (preferences.length) sections.push(`## What you have told me about how you like things done\n${preferences.map((item) => `- ${item.text}`).join('\n')}`);
    if (lessons.length) sections.push(`## Lessons from earlier runs on this machine\nLearned from what actually happened before; they may be out of date, so check them against what you see.\n${lessons.map((item) => `- ${item.text}`).join('\n')}`);
    return { lessons, preferences, notes, text: sections.join('\n\n'), ids: { lessons: lessons.map((item) => item.id), preferences: preferences.map((item) => item.id) } };
  }

  /** A short "related files" line for a file the run has just read: what depends on it, and its tests. */
  neighbourHint(workspaceId, relativePath) {
    if (!this.settings().prefetch) return null;
    const graph = this.getCodeGraph();
    if (!graph || !graph.stats(workspaceId)?.nodes) return null;
    try {
      const impact = graph.impact(workspaceId, [relativePath], { depth: 1, limit: 14 });
      const users = (impact.files || []).filter((file) => file !== relativePath && !(impact.tests || []).includes(file)).slice(0, 4);
      const tests = (impact.tests || []).slice(0, 3);
      if (!users.length && !tests.length) return null;
      return `[Harness] Related to ${relativePath}:${users.length ? ` used by ${users.join(', ')}` : ''}${users.length && tests.length ? ' ·' : ''}${tests.length ? ` tests ${tests.join(', ')}` : ''}.`;
    } catch { return null; }
  }

  // ------------------------------------------------------------------ after

  /** Learn from a finished run. Tracked in `pending` so tests and shutdown can wait for it. */
  afterRun(runId) {
    const task = this.#afterRun(runId).catch((error) => this.logger.warn('Learning from a run failed', { runId, error: error.message })).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return task;
  }

  async idle() { await Promise.allSettled([...this.pending]); }

  async #afterRun(runId) {
    const settings = this.settings();
    if (!settings.enabled) return null;
    const run = this.store.getRun(runId);
    if (!run || !['completed', 'failed', 'stagnated', 'max_steps'].includes(run.status)) return null;
    const trace = buildTrace(this.store.listRunEvents(runId, 4000));
    const verified = trace.verifications.length ? Boolean(trace.verifications.at(-1).ok) : (run.meta?.verification?.ok ?? null);
    const success = run.status === 'completed' && verified !== false;
    const corrections = correctionsIn(trace);
    const costs = run.meta?.costEstimate || {};
    const skills = (run.meta?.capabilities?.skills || []).map((skill) => (typeof skill === 'string' ? skill : skill.name)).filter(Boolean);
    const outcome = this.ledger.recordRun(run, {
      corrections, verified, tokens: (costs.inputTokens || 0) + (costs.outputTokens || 0), cost: costs.cost || 0,
      escalatedFrom: run.meta?.escalatedFrom || null, skills,
    });

    const workspace = run.workspace_id ? this.workspaceManager.get(run.workspace_id) : null;
    const learned = { lessons: [], preferences: [], fresh: 0 };
    if (settings.lessons) {
      for (const lesson of deriveLessons(run, trace)) {
        try {
          const saved = this.lessons.save(lesson, { workspaceId: run.workspace_id, runId });
          learned.lessons.push(lesson.key);
          if (!saved.merged) learned.fresh += 1;
        } catch (error) { this.logger.warn('Could not save a lesson', { error: error.message }); }
      }
      this.lessons.credit(run.meta?.learned?.lessonIds, success);
    }
    if (settings.preferences) {
      const messages = this.store.listMessages(run.session_id, 2000).filter((message) => message.role === 'user' && message.created_at >= run.started_at);
      learned.preferences = this.preferences.learnFrom(messages, { workspaceId: run.workspace_id });
    }
    const finalText = [...this.store.listMessages(run.session_id, 200)].reverse().find((message) => message.role === 'assistant' && message.content)?.content || '';
    const measure = measureUse(run.meta?.contextPlan, trace, { root: workspace?.path || '', finalText });
    this.feedback.record(measure);

    const count = (this.store.getSetting('learning:runs', 0) || 0) + 1;
    this.store.setSetting('learning:runs', count);
    if (count % MAINTAIN_EVERY === 0) await this.maintain({ workspaceId: run.workspace_id });
    this.eventBus.emit('learning.updated', { runId, success, corrections, lessons: learned.lessons.length, newLessons: learned.fresh, preferences: learned.preferences.filter((item) => !item.merged).length }, { runId, workspaceId: run.workspace_id });
    return { outcome, learned, measure };
  }

  /** The slower housekeeping: fold near-duplicates, drop distrusted lessons, look for repeated workflows, trim old outcomes. */
  async maintain({ workspaceId = null } = {}) {
    const settings = this.settings();
    const result = { merged: 0, pruned: 0, skills: 0, outcomes: 0 };
    try {
      if (settings.consolidate) {
        const memories = ['lesson', 'fact', 'preference'].flatMap((kind) => this.store.listMemoriesByKind(kind, { limit: 1000 }));
        result.merged = applyConsolidation(this.store, planConsolidation(memories));
      }
      result.pruned = this.lessons.prune();
      result.outcomes = this.store.pruneOutcomes(new Date(Date.now() - 365 * DAY).toISOString());
      if (workspaceId) {
        const found = this.miner.mine({ workspaceId });
        result.skills = found.filter((item) => item.status === 'proposed').length;
        if (this.miner.settings().autoAccept) for (const item of found.filter((candidate) => candidate.status === 'proposed')) await this.miner.accept(workspaceId, item.id).catch(() => {});
      }
    } catch (error) { this.logger.warn('Learning upkeep failed', { error: error.message }); }
    return result;
  }

  // ------------------------------------------------------------------ report

  status({ workspaceId = null } = {}) {
    const lessons = this.lessons.list({ workspaceId });
    const preferences = this.preferences.list({ workspaceId });
    return {
      settings: this.settings(),
      runs: this.store.getSetting('learning:runs', 0) || 0,
      executors: this.ledger.summary(),
      lessons, preferences,
      skills: workspaceId ? this.miner.candidates(workspaceId) : [],
      context: this.feedback.state(),
    };
  }

  forget(id) {
    const memory = this.store.getMemory(id);
    if (!memory || !['lesson', 'fact', 'preference'].includes(memory.meta?.kind)) throw new Error(`"${id}" is not a learned lesson or preference`);
    this.store.deleteMemory(id);
    return { forgotten: id, kind: memory.meta.kind, text: memory.content };
  }
}
