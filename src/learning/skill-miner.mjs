// Skill mining: find the workflows you keep repeating and offer them as skills.
//
// A run's tool calls form a sequence. A sequence that shows up, in the same order, across several different runs — and those
// runs mostly went well — is a workflow worth writing down. This finds them by counting repeated runs of steps, drops any
// that are merely a part of a longer one, and drafts a skill from what the supporting runs did. Nothing is installed
// unless you accept it (or set `learning.skills.autoAccept`), and an accepted skill is tracked afterwards: how its runs
// do against similar runs without it.

import { sha256 } from '../core/utils.mjs';
import { classifyTask } from './profile.mjs';
import { buildTrace, commandKey, looksReadOnly, pathsOf } from './trace.mjs';

const NOISE = /^(capability_|plan_|memory_|skill_|model_|agent_|user_|fleet_|storage_|learn_)/;
const SEP = '\u0001';
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** A run's calls as a list of short step names. Failed calls are left out: the workflow is what worked. */
export function stepsOf(trace) {
  const steps = [];
  for (const call of trace.calls) {
    if (NOISE.test(call.name) || call.ok === false) continue;
    const step = call.name === 'shell_exec' ? `shell:${commandKey(call.args.command)}` : call.name;
    if (steps.at(-1) !== step) steps.push(step);
  }
  return steps;
}

const readOnlyStep = (step) => (step.startsWith('shell:') ? /^shell:(ls|cat|pwd|echo|git (status|diff|log))\b/.test(step) : looksReadOnly(step));

export function minePatterns(runs, { minRuns = 3, minLength = 3, maxLength = 7, minRate = 0.6 } = {}) {
  const support = new Map();
  for (const run of runs) {
    const seen = new Set();
    for (let length = minLength; length <= Math.min(maxLength, run.steps.length); length += 1) {
      for (let start = 0; start + length <= run.steps.length; start += 1) seen.add(run.steps.slice(start, start + length).join(SEP));
    }
    for (const key of seen) {
      const entry = support.get(key) || { runs: [] };
      entry.runs.push(run);
      support.set(key, entry);
    }
  }
  let found = [...support.entries()].map(([key, entry]) => {
    const successes = entry.runs.filter((run) => run.success).length;
    return { steps: key.split(SEP), runs: entry.runs, support: entry.runs.length, successRate: successes / entry.runs.length };
  }).filter((item) => item.support >= minRuns && item.successRate >= minRate && !item.steps.every(readOnlyStep));
  // A pattern that is only a piece of a longer one seen just as often adds nothing.
  found = found.filter((item) => !found.some((other) => other !== item && other.steps.length > item.steps.length && other.support >= item.support
    && other.steps.join(SEP).includes(item.steps.join(SEP))));
  return found.map((item) => ({ ...item, score: item.support * item.steps.length * item.successRate })).sort((a, b) => b.score - a.score);
}

const mostCommon = (values, count = 1) => {
  const tally = new Map();
  for (const value of values) tally.set(value, (tally.get(value) || 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([value]) => value);
};

function describeStep(step, examples) {
  if (step.startsWith('shell:')) {
    const command = mostCommon(examples.flatMap((run) => run.commands.filter((item) => `shell:${item.key}` === step).map((item) => item.command)))[0];
    return `Run \`${command || step.slice(6)}\``;
  }
  const directories = examples.flatMap((run) => run.calls.filter((call) => call.name === step).flatMap((call) => pathsOf(call.args)).map((file) => file.split('/').slice(0, -1).join('/') || '.'));
  const where = mostCommon(directories)[0];
  const verb = { fs_read: 'Read', fs_patch: 'Patch', fs_write: 'Write', fs_list: 'List', search_text: 'Search for', symbol_read: 'Read the symbol in', symbol_replace: 'Replace the symbol in', git_diff: 'Review the diff with', git_status: 'Check', fs_replace_lines: 'Edit lines in' }[step] || 'Use';
  return `${verb} \`${step}\`${where && where !== '.' ? ` (usually under \`${where}/\`)` : ''}`;
}

export function draftSkill(pattern) {
  const tags = mostCommon(pattern.runs.flatMap((run) => run.tags), 2);
  const words = mostCommon(pattern.runs.flatMap((run) => run.tokens).filter((token) => token.length > 3), 3);
  const name = `mined-${slug([tags[0], ...words.slice(0, 2)].filter(Boolean).join('-')) || sha256(pattern.steps.join(SEP)).slice(0, 6)}`;
  const description = `A workflow you have repeated ${pattern.support} times (${Math.round(pattern.successRate * 100)}% went well): ${pattern.steps.map((step) => step.replace(/^shell:/, '')).join(' → ')}.`;
  const body = [
    `# ${name}`,
    '',
    `Use this for ${tags.join(' / ') || 'repeated'} tasks${words.length ? ` involving ${words.join(', ')}` : ''}.`,
    `It was found by watching ${pattern.support} earlier runs on this machine, ${Math.round(pattern.successRate * 100)}% of which finished well. Treat it as a starting point, not a script: adapt each step to the task in front of you.`,
    '',
    '## Steps',
    ...pattern.steps.map((step, index) => `${index + 1}. ${describeStep(step, pattern.runs)}`),
    '',
    '## Notes',
    '- Generated from your own history by MaskShift; edit it freely.',
  ].join('\n');
  return { id: sha256(pattern.steps.join(SEP)).slice(0, 10), name, description, body, steps: pattern.steps, support: pattern.support, successRate: pattern.successRate, tags };
}

export class SkillMiner {
  constructor({ store, skillManager, config, logger }) {
    this.store = store;
    this.skillManager = skillManager;
    this.config = config;
    this.logger = logger;
  }

  settings() {
    const skills = this.config.get().learning?.skills || {};
    return { mine: skills.mine !== false, minRuns: skills.minRuns ?? 3, autoAccept: Boolean(skills.autoAccept), window: skills.window ?? 80 };
  }

  key(workspaceId) { return `learning:skillCandidates:${workspaceId || 'global'}`; }

  candidates(workspaceId) { return this.store.getSetting(this.key(workspaceId), []); }

  /** Look through recent runs for repeated workflows. Existing decisions (accepted, dismissed) are kept. */
  mine({ workspaceId }) {
    const settings = this.settings();
    if (!settings.mine) return this.candidates(workspaceId);
    const rows = this.store.listRuns({ workspaceId, limit: settings.window }).filter((run) => ['completed', 'failed', 'stagnated'].includes(run.status));
    const runs = [];
    for (const run of rows) {
      const trace = buildTrace(this.store.listRunEvents(run.id, 2000));
      const steps = stepsOf(trace);
      if (steps.length < 3) continue;
      const profile = classifyTask(run.prompt);
      runs.push({ id: run.id, steps, calls: trace.calls, commands: trace.commands, tags: profile.tags, tokens: profile.tokens,
        success: run.status === 'completed' && run.meta?.verification?.ok !== false });
    }
    const known = new Map(this.candidates(workspaceId).map((item) => [item.id, item]));
    const existingSkills = new Set(this.skillManager.list().map((skill) => skill.name));
    const fresh = minePatterns(runs, { minRuns: settings.minRuns }).slice(0, 6).map(draftSkill)
      .filter((draft) => !existingSkills.has(draft.name) || known.get(draft.id)?.status === 'accepted');
    const merged = fresh.map((draft) => ({ ...draft, status: known.get(draft.id)?.status || 'proposed', foundAt: known.get(draft.id)?.foundAt || new Date().toISOString() }));
    for (const old of known.values()) if (['accepted', 'dismissed'].includes(old.status) && !merged.some((item) => item.id === old.id)) merged.push(old);
    this.store.setSetting(this.key(workspaceId), merged);
    return merged;
  }

  async accept(workspaceId, nameOrId) {
    const list = this.candidates(workspaceId);
    const item = list.find((candidate) => candidate.name === nameOrId || candidate.id === nameOrId);
    if (!item) throw new Error(`No skill candidate "${nameOrId}". Run a mining pass first.`);
    const skill = await this.skillManager.create({ name: item.name, description: item.description, body: item.body, metadata: { mined: true, support: item.support, successRate: item.successRate }, overwrite: false });
    item.status = 'accepted';
    this.store.setSetting(this.key(workspaceId), list);
    return skill;
  }

  dismiss(workspaceId, nameOrId) {
    const list = this.candidates(workspaceId);
    const item = list.find((candidate) => candidate.name === nameOrId || candidate.id === nameOrId);
    if (!item) throw new Error(`No skill candidate "${nameOrId}"`);
    item.status = 'dismissed';
    this.store.setSetting(this.key(workspaceId), list);
    return item;
  }

  /** How runs that loaded a mined skill did compared with similar runs that did not. */
  impact(skillName) {
    const rows = this.store.listOutcomes({ kind: 'model', limit: 2000 });
    const withSkill = rows.filter((row) => (row.meta?.skills || []).includes(skillName));
    if (!withSkill.length) return { uses: 0, rate: null, baseline: null };
    const tags = new Set(withSkill.flatMap((row) => row.tags));
    const others = rows.filter((row) => !(row.meta?.skills || []).includes(skillName) && row.tags.some((tag) => tags.has(tag)));
    const rate = (items) => (items.length ? items.filter((row) => row.success).length / items.length : null);
    return { uses: withSkill.length, rate: rate(withSkill), baseline: rate(others), baselineRuns: others.length };
  }
}
