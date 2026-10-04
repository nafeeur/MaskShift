import { classifyTask } from '../learning/profile.mjs';
import { harnessExecutor, modelExecutor } from '../learning/ledger.mjs';

function matchesProfile(profile, task) {
  const wanted = profile.tags || [];
  return wanted.length ? wanted.some((tag) => task.tags.includes(tag)) : true;
}

export class IntelligenceRouter {
  constructor({ config, store, providerManager, bridgeManager }) {
    this.config = config;
    this.store = store;
    this.providerManager = providerManager;
    this.bridgeManager = bridgeManager;
    // Set by the runtime once the learning layer exists. Without it routing is exactly what configuration says.
    this.learning = null;
  }

  taskProfile(prompt) { return classifyTask(prompt); }

  modelCandidates() {
    const configured = this.config.get().routing?.models || [];
    if (configured.length) return configured;
    return this.config.get().providers.flatMap((provider) => (provider.models || []).map((model) => ({
      model: `${provider.id}:${typeof model === 'string' ? model : model.id}`,
      tags: [], priority: 0,
    })));
  }

  historicalScore(model, workspaceId, task) {
    const runs = this.store.listRuns({ workspaceId, limit: 500 }).filter((run) => run.model_id === model);
    const relevant = runs.filter((run) => {
      const prior = run.meta?.route?.taskProfile || classifyTask(run.prompt);
      return prior.tags.some((tag) => task.tags.includes(tag));
    });
    if (!relevant.length) return { score: 0.5, samples: 0 };
    const successes = relevant.filter((run) => run.status === 'completed' && run.meta?.verification?.passed !== false).length;
    return { score: successes / relevant.length, samples: relevant.length };
  }

  routeModel(prompt, { workspaceId, fallback } = {}) {
    const taskProfile = classifyTask(prompt);
    const candidates = this.modelCandidates().filter((candidate) => matchesProfile(candidate, taskProfile));
    if (!candidates.length) return { selected: fallback || this.config.get().defaultModel, taskProfile, reason: 'No routing profiles matched; using configured default.', candidates: [] };
    const learned = this.learning?.router.rank(candidates.map((candidate) => ({ ...candidate, executor: modelExecutor(candidate.model) })), taskProfile);
    const learnedBy = new Map((learned?.ranked || []).map((item) => [item.model, item.learned]));
    const informed = Boolean(learned?.informed);
    const ranked = candidates.map((candidate) => {
      const history = this.historicalScore(candidate.model, workspaceId, taskProfile);
      const tagMatch = (candidate.tags || []).filter((tag) => taskProfile.tags.includes(tag)).length;
      const l = learnedBy.get(candidate.model);
      // With real evidence the learned estimate (success on similar tasks, minus what it costs, plus a little curiosity
      // about under-tried candidates) replaces the cruder completion-rate term.
      const experience = informed && l
        ? (l.successRate - 0.5) * 6 + (l.value - l.successRate) * 3
        : history.score * Math.min(3, Math.log2(history.samples + 1));
      const score = (candidate.priority || 0) + tagMatch * 2 + experience;
      return { ...candidate, score, history, learned: l || null };
    }).sort((a, b) => b.score - a.score || String(a.model).localeCompare(String(b.model)));
    return {
      selected: ranked[0].model, taskProfile, candidates: ranked, informed,
      reason: informed ? 'Chosen from how each model has actually done on similar tasks (success, cost), within the configured profiles.'
        : ranked[0].history.samples ? 'Best task fit adjusted by historical completion outcomes.' : 'Best configured task-profile match.',
      explanation: informed ? this.learning.router.explain((learned.ranked || []).map((item) => ({ ...item }))) : [],
    };
  }

  /** The next model worth trying when `tried` did not get there: the best-ranked candidate not yet used. */
  escalation(route, tried = []) {
    const used = new Set(tried);
    const next = (route?.candidates || []).find((candidate) => !used.has(candidate.model));
    return next ? { model: next.model, reason: `${[...used].at(-1) || 'the previous model'} did not finish; ${next.model} is the next best match for this kind of task.` } : null;
  }

  async routeAgent(prompt, { workspaceId } = {}) {
    const taskProfile = classifyTask(prompt);
    const available = (await this.bridgeManager.discover()).filter((bridge) => bridge.available);
    const preferences = this.config.get().routing?.agents || {};
    const defaults = {
      frontend: ['claude', 'codex'], systems: ['codex', 'claude'], verification: ['codex', 'claude'],
      research: ['hermes', 'claude'], 'large-change': ['codex', 'claude'], 'general-coding': ['codex', 'claude', 'aider'],
      debugging: ['codex', 'claude'], docs: ['claude', 'hermes'], data: ['claude', 'codex'], devops: ['codex', 'claude'], web: ['hermes', 'claude'],
    };
    const ordered = taskProfile.tags.flatMap((tag) => preferences[tag] || defaults[tag] || []);
    const configured = ordered.find((name) => available.some((bridge) => bridge.name === name)) || null;

    // Who has actually done well on this kind of task, among the harnesses that are installed.
    const learned = this.learning?.router.rank(available.map((bridge) => ({ name: bridge.name, executor: harnessExecutor(bridge.name) })), taskProfile);
    const best = learned?.informed ? learned.ranked[0] : null;
    const selectedName = best?.name || configured;
    return {
      selected: selectedName ? { type: 'bridge', name: selectedName } : { type: 'internal', name: 'maskshift-subagent' },
      taskProfile, available: available.map((bridge) => bridge.name), workspaceId, informed: Boolean(best),
      ranking: learned?.informed ? this.learning.router.explain(learned.ranked) : [],
      reason: best ? `${best.name} has the best record on similar tasks (${Math.round(best.learned.successRate * 100)}% expected).`
        : selectedName ? `Available bridge preferred for ${taskProfile.tags.join(', ')} work.` : 'No preferred external bridge is installed; use an internal isolated subagent.',
    };
  }
}
