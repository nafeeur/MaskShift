// Noticing a run that is busy but getting nowhere, and stopping it with something useful.
//
// The stagnation detector catches repeating the same call. This catches the other way to waste a budget: trying many
// different things, none of which teach it anything — turn after turn of failing commands, re-reading files already read,
// with no new file understood, no change made, no check passing. Progress is counted as new information (a file, a result, an
// error not seen before), a change, or a passing check. When there has been none for a while the run is nudged to change
// tack; if that does not help it is stopped with a plain report of what was tried, instead of burning the rest of its budget.

import { commandKey, looksReadOnly, pathsOf } from './trace.mjs';
import { errorSignature, parseErrorContent } from './lessons.mjs';

const clip = (text, max) => { const value = String(text ?? ''); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

export function progressSettings(config = {}) {
  const raw = config.learning?.progress || {};
  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const warnAfter = number(raw.warnAfter, 8);
  return { enabled: raw.enabled !== false, warnAfter, stopAfter: Math.max(warnAfter + 2, number(raw.stopAfter, 16)), errorStreak: number(raw.errorStreak, 5) };
}

export class ProgressMonitor {
  constructor({ warnAfter = 8, stopAfter = 16, errorStreak = 5 } = {}) {
    this.warnAfter = warnAfter;
    this.stopAfter = stopAfter;
    this.errorStreakLimit = errorStreak;
    this.known = new Set();
    this.lastProgress = 0;
    this.errorStreak = 0;
    this.warned = false;
    this.log = [];
    this.files = new Set();
  }

  /** Feed one turn's tool calls and their results. */
  observe(step, results) {
    let progressed = false;
    let allFailed = results.length > 0;
    for (const { call, content, isError, name } of results) {
      const tool = name || call.name;
      const args = call.args || {};
      this.log.push({ step, tool, summary: clip(tool === 'shell_exec' ? args.command : JSON.stringify(args), 90), ok: !isError });
      if (!isError) {
        allFailed = false;
        const paths = pathsOf(args);
        for (const file of paths) {
          const key = `${looksReadOnly(tool) ? 'read' : 'edit'}:${file}`;
          if (!this.known.has(key)) { this.known.add(key); progressed = true; this.files.add(file); }
        }
        if (!looksReadOnly(tool)) progressed = true;
        if (tool === 'shell_exec') {
          const key = `ran:${commandKey(args.command)}:${String(content).slice(0, 200)}`;
          if (!this.known.has(key)) { this.known.add(key); progressed = true; }
        } else if (!paths.length) {
          const key = `${tool}:${JSON.stringify(args)}`;
          if (!this.known.has(key)) { this.known.add(key); progressed = true; }
        }
      } else {
        const key = `err:${tool}:${errorSignature(parseErrorContent(content))}`;
        if (!this.known.has(key)) { this.known.add(key); progressed = true; } // a new kind of failure is still something learned
      }
    }
    this.errorStreak = allFailed ? this.errorStreak + 1 : 0;
    if (progressed && !allFailed) { this.lastProgress = step; this.warned = false; }
  }

  /** A verification that passed counts for a great deal. */
  verificationPassed(step) { this.lastProgress = step; this.warned = false; this.errorStreak = 0; }

  reset(step) { this.lastProgress = step; this.warned = false; this.errorStreak = 0; }

  check(step) {
    const idle = step - this.lastProgress;
    if (idle >= this.stopAfter || this.errorStreak >= this.errorStreakLimit * 2) {
      return { level: 'stop', turns: idle, reason: this.errorStreak >= this.errorStreakLimit * 2 ? `${this.errorStreak} turns in a row where every tool call failed` : `${idle} turns without new information, a change or a passing check` };
    }
    if (!this.warned && (idle >= this.warnAfter || this.errorStreak >= this.errorStreakLimit)) {
      this.warned = true;
      return { level: 'warn', turns: idle, reason: this.errorStreak >= this.errorStreakLimit ? `${this.errorStreak} turns in a row where every tool call failed` : `${idle} turns without new information, a change or a passing check` };
    }
    return null;
  }

  report(finding) {
    const recent = this.log.slice(-10).map((item) => `- step ${item.step}: ${item.tool} ${item.summary}${item.ok ? '' : ' ✗'}`);
    return [
      `I stopped because I was not making progress: ${finding.reason}.`,
      '',
      'What I tried most recently:',
      ...recent,
      '',
      this.files.size ? `Files I have looked at or changed: ${[...this.files].slice(0, 12).join(', ')}.` : 'I have not yet found the relevant files.',
      '',
      'Where this leaves things: the approach above is not working. Tell me what I am missing (a different file, a constraint, the exact error you see), or give me a narrower task, and I will pick it up from here.',
    ].join('\n');
  }
}

export function stuckNudge(finding) {
  return `[Harness notice] ${finding.reason}. Stop and take stock before the next call: write down in two or three lines what you know for certain, what you assumed, and what you have ruled out. Then choose something you have not tried — read the actual error text, look at a different file, reduce the problem to its smallest failing case — or, if you are blocked on information only the user has, ask them. Do not repeat a variation of the last few attempts.`;
}
