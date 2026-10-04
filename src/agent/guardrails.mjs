import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, runCommand, sha256, truncate } from '../core/utils.mjs';

export const PROGRESS_FILE = path.join('.maskshift', 'progress.md');

export function guardrailSettings(config = {}) {
  const raw = config.guardrails || {};
  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const stagnation = raw.stagnation || {};
  const verification = raw.verification || {};
  const handoff = raw.handoff || {};
  const repeatThreshold = number(stagnation.repeatThreshold, 3);
  return {
    stagnation: {
      enabled: stagnation.enabled !== false,
      window: number(stagnation.window, 16),
      repeatThreshold,
      stopThreshold: Math.max(repeatThreshold + 1, number(stagnation.stopThreshold, 6)),
    },
    verification: {
      commands: (Array.isArray(verification.commands) ? verification.commands : [])
        .map((entry) => (typeof entry === 'string' ? { command: entry } : entry))
        .filter((entry) => entry && typeof entry.command === 'string' && entry.command.trim()),
      maxAttempts: number(verification.maxAttempts, 3),
      timeoutMs: number(verification.timeoutMs, 300_000),
    },
    handoff: {
      enabled: handoff.enabled !== false,
      thresholdRatio: Math.min(0.95, Math.max(0.3, Number(handoff.thresholdRatio) || 0.75)),
      maxResets: Number.isFinite(Number(handoff.maxResets)) ? Math.max(0, Number(handoff.maxResets)) : 3,
    },
  };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/**
 * Notices a run that keeps doing the same thing and getting the same answer. A signature is the
 * tool, its arguments and a hash of what came back, so re-running a test after an edit (new
 * output) is progress while re-running it with no change (identical output) is not. Alternating
 * between two signatures (A,B,A,B…) is counted the same way, since an edit-and-revert cycle never
 * repeats a single call back to back.
 */
export class StagnationDetector {
  constructor({ window = 16, repeatThreshold = 3, stopThreshold = 6 } = {}) {
    this.window = window;
    this.repeatThreshold = repeatThreshold;
    this.stopThreshold = stopThreshold;
    this.signatures = [];
    this.warned = new Set();
  }

  signature(call, content) {
    return sha256(`${call.name}\n${stableJson(call.args || {})}\n${sha256(String(content ?? '').slice(0, 4000))}`).slice(0, 16);
  }

  observe(call, result) {
    this.signatures.push({ signature: this.signature(call, result.content), tool: call.name, isError: Boolean(result.isError) });
    if (this.signatures.length > this.window) this.signatures.shift();
  }

  // A repeated call with a different answer means the world changed; forget what came before.
  reset() {
    this.signatures = [];
    this.warned.clear();
  }

  check() {
    const counts = new Map();
    for (const entry of this.signatures) counts.set(entry.signature, (counts.get(entry.signature) || 0) + 1);
    let top = null;
    for (const [signature, count] of counts) if (!top || count > top.count) top = { signature, count };

    // Strict alternation over the tail of the window: A,B,A,B,A,B.
    const tail = this.signatures.slice(-this.repeatThreshold * 2).map((entry) => entry.signature);
    const oscillating = tail.length === this.repeatThreshold * 2
      && new Set(tail).size === 2
      && tail.every((signature, index) => index === 0 || signature !== tail[index - 1]);

    const count = Math.max(top?.count || 0, oscillating ? this.repeatThreshold * 2 : 0);
    if (count >= this.stopThreshold) {
      return { level: 'stop', count, reason: oscillating ? 'oscillation' : 'repeat', tool: this.#toolFor(top?.signature) };
    }
    if (count >= this.repeatThreshold) {
      const key = oscillating ? `osc:${tail.join('')}` : `rep:${top.signature}`;
      if (this.warned.has(key)) return null;
      this.warned.add(key);
      return { level: 'warn', count, reason: oscillating ? 'oscillation' : 'repeat', tool: this.#toolFor(top?.signature) };
    }
    return null;
  }

  #toolFor(signature) {
    return this.signatures.find((entry) => entry.signature === signature)?.tool || null;
  }
}

export function stagnationNudge(finding) {
  const what = finding.reason === 'oscillation'
    ? 'You are alternating between the same two actions with identical results'
    : `You have made the same ${finding.tool ? `\`${finding.tool}\` ` : ''}call ${finding.count} times and received the same result each time`;
  return `[Harness notice] ${what}. That is not making progress. Stop repeating it: re-read the actual error or output, form a different hypothesis, and try a different approach (inspect the cause, change a different file, or ask the user if you are blocked). If the task cannot be completed, say so plainly instead of retrying.`;
}

/**
 * Runs the project's own checks (tests, lint, typecheck). The exit code is the verdict, not the
 * model's opinion of its own work.
 */
export async function runVerification(commands, { cwd, timeoutMs = 300_000, signal, maxOutputChars = 6_000 } = {}) {
  const results = [];
  for (const entry of commands) {
    const started = Date.now();
    let result;
    try {
      result = await runCommand(entry.command, { cwd: entry.cwd ? path.resolve(cwd, entry.cwd) : cwd, timeoutMs: entry.timeoutMs || timeoutMs, signal, maxOutputChars: maxOutputChars * 4 });
    } catch (error) {
      result = { code: 1, stdout: '', stderr: error.message, timedOut: false };
    }
    if (signal?.aborted) break;
    results.push({
      command: entry.command,
      label: entry.label || entry.command,
      ok: result.code === 0,
      code: result.code,
      timedOut: Boolean(result.timedOut),
      output: truncate(`${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim().split('\n').slice(-120).join('\n'), maxOutputChars),
      durationMs: Date.now() - started,
    });
  }
  return { ok: results.every((entry) => entry.ok), results };
}

export function verificationFeedback(verification, { attempt, maxAttempts }) {
  const failed = verification.results.filter((entry) => !entry.ok);
  const sections = failed.map((entry) => `### ${entry.label} (${entry.timedOut ? 'timed out' : `exit ${entry.code}`})\n\`\`\`\n${entry.output || '(no output)'}\n\`\`\``);
  return `[Harness verification failed — attempt ${attempt} of ${maxAttempts}] You said the task was done, but the project's own checks disagree:\n\n${sections.join('\n\n')}\n\nFix the underlying problem, then finish again. Do not claim success while these fail.`;
}

export function verificationSummary(verification) {
  return verification.results.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.label}`).join('; ');
}

function renderPlan(planState) {
  const steps = planState?.steps || [];
  if (!steps.length) return '(no plan recorded)';
  return steps.map((step) => `- [${step.status || 'pending'}] ${step.text || step.id}`).join('\n');
}

export function renderProgress({ runId, prompt, planState, summary, verification, workingTree, resets }) {
  return [
    '# MaskShift progress hand-off',
    '',
    `Updated: ${nowIso()}  ·  Run: ${runId}  ·  Context resets so far: ${resets}`,
    '',
    '## Goal',
    truncate(String(prompt || '').trim(), 4_000),
    '',
    '## Plan',
    renderPlan(planState),
    '',
    '## Progress so far',
    summary || '(no summary available)',
    '',
    '## Last verification',
    verification || '(not run)',
    '',
    '## Working tree',
    workingTree ? `\`\`\`\n${workingTree}\n\`\`\`` : '(clean or not a git repository)',
    '',
  ].join('\n');
}

/** Deterministic fallback when no model summary is available: what was asked and what ran last. */
export function fallbackSummary(history, limit = 12) {
  const actions = [];
  for (const message of history) {
    for (const call of message.toolCalls || []) actions.push(`- ${call.name}(${truncate(stableJson(call.args || {}), 140)})`);
  }
  return actions.length
    ? `Most recent actions (oldest first):\n${actions.slice(-limit).join('\n')}`
    : 'No tool actions recorded yet.';
}

export async function writeProgressFile(workspacePath, content) {
  const file = path.join(workspacePath, PROGRESS_FILE);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, content);
  await fsp.rename(temp, file);
  return file;
}

export function handoffMessage({ prompt, progress, file }) {
  return `[Context reset — hand-off] Your earlier turns were cleared to give you a fresh context window. Nothing was lost: the state of the work is below and in \`${file}\`. Re-read it, check the working tree against it, and continue from where you left off. Do not start over.\n\nOriginal request:\n${truncate(String(prompt || '').trim(), 4_000)}\n\n${progress}`;
}
