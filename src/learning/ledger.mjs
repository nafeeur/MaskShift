// A record of how every executor — a model, a harness — actually did on what kind of task. The router reads it;
// nothing here makes a decision.

import { classifyTask, similarity } from './profile.mjs';

const DAY = 86_400_000;

export const modelExecutor = (ref) => `model:${ref}`;
export const harnessExecutor = (name) => `harness:${name}`;

export class OutcomeLedger {
  constructor({ store }) {
    this.store = store;
  }

  record(entry) {
    return this.store.addOutcome(entry);
  }

  /** From a finished run row and a little of what happened in it. */
  recordRun(run, { corrections = 0, verified = null, tokens = 0, cost = 0, escalatedFrom = null, skills = [] } = {}) {
    const profile = classifyTask(run.prompt);
    const success = run.status === 'completed' && verified !== false;
    const started = Date.parse(run.started_at);
    const ended = Date.parse(run.ended_at || new Date().toISOString());
    return this.record({
      runId: run.id, workspaceId: run.workspace_id, executor: modelExecutor(run.model_id), kind: 'model',
      tags: profile.tags, tokens: profile.tokens, complexity: profile.complexity, status: run.status, success, verified,
      steps: run.step_count || 0, totalTokens: tokens, cost, durationMs: Number.isFinite(ended - started) ? ended - started : 0,
      corrections, escalatedFrom, meta: { skills },
    });
  }

  recordHarnessTurn({ harness, task, ok, durationMs = 0, retries = 0, workspaceId = null }) {
    const profile = classifyTask(task);
    return this.record({
      runId: null, workspaceId, executor: harnessExecutor(harness), kind: 'harness', tags: profile.tags, tokens: profile.tokens,
      complexity: profile.complexity, status: ok ? 'completed' : 'failed', success: ok, verified: null, steps: 0, totalTokens: 0,
      cost: 0, durationMs, corrections: retries, escalatedFrom: null, meta: {},
    });
  }

  /**
   * Weighted results for one executor on tasks like `profile`. Every past outcome counts in proportion to how much it
   * resembles the task, and older ones fade, so a model that has improved (or been swapped under the same name) is
   * not judged forever by its first week.
   */
  stats(executor, profile, { sinceDays = 120, halfLifeDays = 45, limit = 800 } = {}) {
    const since = new Date(Date.now() - sinceDays * DAY).toISOString();
    const rows = this.store.listOutcomes({ executor, since, limit });
    let n = 0; let successes = 0; let cost = 0; let steps = 0; let duration = 0; let corrections = 0; let all = 0; let allSuccess = 0;
    for (const row of rows) {
      const age = (Date.now() - Date.parse(row.created_at)) / DAY;
      const fade = Math.pow(0.5, age / halfLifeDays);
      all += fade;
      if (row.success) allSuccess += fade;
      const alike = similarity(profile, row);
      if (alike < 0.15) continue;
      const weight = alike * fade;
      n += weight;
      if (row.success) successes += weight;
      cost += weight * (row.cost || 0);
      steps += weight * (row.steps || 0);
      duration += weight * (row.duration_ms || 0);
      corrections += weight * (row.corrections || 0);
    }
    return {
      executor, samples: rows.length, effective: n, successes,
      rate: n ? successes / n : null, globalRate: all ? allSuccess / all : null,
      avgCost: n ? cost / n : null, avgSteps: n ? steps / n : null, avgDurationMs: n ? duration / n : null, avgCorrections: n ? corrections / n : null,
    };
  }

  /** Everything, for the status report: per executor totals. */
  summary({ sinceDays = 120 } = {}) {
    const since = new Date(Date.now() - sinceDays * DAY).toISOString();
    const rows = this.store.listOutcomes({ since, limit: 5000 });
    const byExecutor = new Map();
    for (const row of rows) {
      const item = byExecutor.get(row.executor) || { executor: row.executor, kind: row.kind, runs: 0, successes: 0, cost: 0, steps: 0 };
      item.runs += 1;
      if (row.success) item.successes += 1;
      item.cost += row.cost || 0;
      item.steps += row.steps || 0;
      byExecutor.set(row.executor, item);
    }
    return [...byExecutor.values()].map((item) => ({ ...item, rate: item.runs ? item.successes / item.runs : 0 })).sort((a, b) => b.runs - a.runs);
  }
}
