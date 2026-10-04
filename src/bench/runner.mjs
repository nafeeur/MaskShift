// Running the task suite against a model through the real engine, and scoring it by the checks'
// exit codes. Reports what matters for tuning a harness: not just pass rate but what it cost —
// turns, tokens (split by what caused them) and how often the harness had to step in.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../core/utils.mjs';
import { TASKS } from './tasks.mjs';

export const FEATURES = ['callRepair', 'fuzzyEdits', 'observation', 'editFeedback'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'max_steps', 'stagnated']);

export async function materialize(task, root) {
  const dir = await fsp.mkdtemp(path.join(root || os.tmpdir(), `maskshift-bench-${task.id}-`));
  for (const [name, content] of Object.entries(task.files)) {
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
  await runCommand('git init -q && git add -A && git -c user.email=bench@maskshift -c user.name=bench commit -qm base', { cwd: dir, timeoutMs: 20_000 }).catch(() => null);
  return dir;
}

export async function runCheck(task, dir, timeoutMs = 60_000) {
  const result = await runCommand(task.check, { cwd: dir, timeoutMs, maxOutputChars: 4000 });
  return { passed: result.code === 0, code: result.code, output: `${result.stdout}${result.stderr}`.trim().split('\n').slice(-6).join('\n') };
}

/** Confirms every task fails untouched and passes after its reference solution. */
export async function verifyTasks({ runtime, tasks = TASKS, root = null }) {
  const out = [];
  for (const task of tasks) {
    const dir = await materialize(task, root);
    try {
      const before = await runCheck(task, dir);
      const workspace = await runtime.workspaceManager.open(dir);
      const context = { workspaceId: workspace.id, workspacePath: dir, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
      let error = null;
      try { for (const call of task.reference) await runtime.toolRegistry.execute(call.name, call.args, context); } catch (caught) { error = caught.message; }
      const after = await runCheck(task, dir);
      out.push({ id: task.id, failsBefore: !before.passed, passesAfter: after.passed, error, ok: !before.passed && after.passed && !error, detail: after.passed ? null : after.output });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
  return out;
}

function countEvents(events) {
  const counts = { repairedCalls: 0, editChecks: 0, fuzzyEdits: 0, stagnation: 0, verification: 0, contextResets: 0, scaffoldRises: 0, toolErrors: 0, toolCalls: 0 };
  for (const event of events) {
    if (event.type === 'tool-call-repaired') counts.repairedCalls += 1;
    else if (event.type === 'edit-check') counts.editChecks += 1;
    else if (event.type === 'stagnation') counts.stagnation += 1;
    else if (event.type === 'verification') counts.verification += 1;
    else if (event.type === 'context-reset') counts.contextResets += 1;
    else if (event.type === 'scaffold-level') counts.scaffoldRises += 1;
    else if (event.type === 'tool-error') { counts.toolErrors += 1; counts.toolCalls += 1; }
    else if (event.type === 'tool-result') {
      counts.toolCalls += 1;
      if (/applied by a looser match/.test(event.payload?.content || '')) counts.fuzzyEdits += 1;
    }
  }
  return counts;
}

function summarize(results) {
  const solved = results.filter((entry) => entry.passed);
  const sum = (key, list = results) => list.reduce((total, entry) => total + (entry[key] || 0), 0);
  const tokens = sum('inputTokens') + sum('outputTokens');
  const bySource = {};
  for (const entry of results) {
    for (const [source, bucket] of Object.entries(entry.bySource || {})) {
      const slot = bySource[source] ||= { calls: 0, tokens: 0 };
      slot.calls += bucket.calls;
      slot.tokens += bucket.inputTokens + bucket.outputTokens;
    }
  }
  return {
    tasks: results.length, solved: solved.length,
    passRate: results.length ? Math.round((solved.length / results.length) * 1000) / 1000 : 0,
    avgSteps: results.length ? Math.round((sum('steps') / results.length) * 10) / 10 : 0,
    tokens, tokensPerSolved: solved.length ? Math.round(tokens / solved.length) : null,
    harnessInterventions: { repairedCalls: sum('repairedCalls'), fuzzyEdits: sum('fuzzyEdits'), editChecks: sum('editChecks'), stagnation: sum('stagnation'), contextResets: sum('contextResets'), scaffoldRises: sum('scaffoldRises') },
    bySource,
  };
}

/**
 * `without` turns individual helpers off for the whole run (see FEATURES), so two runs on the same
 * model — one with, one without — measure what a helper is actually worth.
 */
export async function runBenchmark({ runtime, modelRef, tasks = TASKS, maxSteps = 24, repeat = 1, without = [], signal = null, onTask = null, root = null }) {
  const config = runtime.config.get();
  const guard = (config.guardrails ||= {});
  const features = (guard.features ||= {});
  const saved = { ...features };
  for (const name of without) {
    if (!FEATURES.includes(name)) throw new Error(`Unknown feature '${name}'. Choose from: ${FEATURES.join(', ')}`);
    features[name] = false;
  }
  const profile = await runtime.providerManager.modelProfile(modelRef);
  const results = [];
  try {
    for (const task of tasks) {
      for (let attempt = 1; attempt <= repeat; attempt += 1) {
        if (signal?.aborted) throw signal.reason || new Error('Benchmark cancelled');
        const dir = await materialize(task, root);
        const started = Date.now();
        let entry;
        try {
          const workspace = await runtime.workspaceManager.open(dir);
          const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: task.prompt, modelRef, options: { maxSteps, skipCheckpoint: true } });
          const finished = await runtime.engine.waitForRun(run.id);
          const final = TERMINAL.has(finished.status) ? finished : runtime.store.getRun(run.id);
          const check = await runCheck(task, dir);
          const cost = final.meta?.costEstimate || {};
          entry = {
            id: task.id, attempt, passed: check.passed, status: final.status, steps: final.step_count || 0,
            inputTokens: cost.inputTokens || 0, outputTokens: cost.outputTokens || 0, cost: cost.cost ?? null, bySource: cost.bySource || {},
            durationMs: Date.now() - started, error: final.error || null, checkOutput: check.passed ? null : check.output,
            ...countEvents(runtime.store.listRunEvents(run.id, 5000)),
          };
        } catch (error) {
          entry = { id: task.id, attempt, passed: false, status: 'error', steps: 0, error: error.message, durationMs: Date.now() - started };
        } finally {
          await fsp.rm(dir, { recursive: true, force: true });
        }
        results.push(entry);
        onTask?.(entry);
      }
    }
  } finally {
    for (const name of FEATURES) { if (name in saved) features[name] = saved[name]; else delete features[name]; }
  }
  return {
    version: 1, at: new Date().toISOString(), model: profile.ref, tier: profile.tier, contextWindow: profile.contextWindow,
    level: runtime.engine.capabilities.decide(profile.ref, profile).level, without, maxSteps, repeat,
    summary: summarize(results), results,
  };
}

export function compareReports(a, b) {
  const rows = [];
  const left = new Map(a.results.map((entry) => [`${entry.id}#${entry.attempt}`, entry]));
  for (const entry of b.results) {
    const other = left.get(`${entry.id}#${entry.attempt}`);
    if (!other) continue;
    rows.push({ id: entry.id, before: other.passed ? 'pass' : 'FAIL', after: entry.passed ? 'pass' : 'FAIL', stepsDelta: (entry.steps || 0) - (other.steps || 0), tokensDelta: ((entry.inputTokens || 0) + (entry.outputTokens || 0)) - ((other.inputTokens || 0) + (other.outputTokens || 0)) });
  }
  return {
    passRate: { before: a.summary.passRate, after: b.summary.passRate, delta: Math.round((b.summary.passRate - a.summary.passRate) * 1000) / 1000 },
    tokensPerSolved: { before: a.summary.tokensPerSolved, after: b.summary.tokensPerSolved },
    avgSteps: { before: a.summary.avgSteps, after: b.summary.avgSteps },
    regressions: rows.filter((row) => row.before === 'pass' && row.after === 'FAIL').map((row) => row.id),
    fixes: rows.filter((row) => row.before === 'FAIL' && row.after === 'pass').map((row) => row.id),
    rows,
  };
}
