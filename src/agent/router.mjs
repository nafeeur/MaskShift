function classifyTask(prompt = '') {
  const text = String(prompt).toLowerCase();
  const tags = [];
  if (/\b(react|vue|svelte|css|frontend|ui|browser|component)\b/.test(text)) tags.push('frontend');
  if (/\b(c\+\+|cpp|rust|deadlock|thread|memory|performance)\b/.test(text)) tags.push('systems');
  if (/\b(test|verify|review|audit|regression|security)\b/.test(text)) tags.push('verification');
  if (/\b(refactor|migrat|architecture|multi-file|across the repo)\b/.test(text)) tags.push('large-change');
  if (/\b(research|compare|investigate|explain)\b/.test(text)) tags.push('research');
  if (!tags.length) tags.push('general-coding');
  const complexity = text.length > 1200 || tags.includes('large-change') ? 'high' : text.length < 160 ? 'low' : 'medium';
  return { tags, complexity };
}

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
    const ranked = candidates.map((candidate) => {
      const history = this.historicalScore(candidate.model, workspaceId, taskProfile);
      const tagMatch = (candidate.tags || []).filter((tag) => taskProfile.tags.includes(tag)).length;
      const score = (candidate.priority || 0) + tagMatch * 2 + history.score * Math.min(3, Math.log2(history.samples + 1));
      return { ...candidate, score, history };
    }).sort((a, b) => b.score - a.score || String(a.model).localeCompare(String(b.model)));
    return { selected: ranked[0].model, taskProfile, reason: ranked[0].history.samples ? 'Best task fit adjusted by historical completion outcomes.' : 'Best configured task-profile match.', candidates: ranked };
  }

  async routeAgent(prompt, { workspaceId } = {}) {
    const taskProfile = classifyTask(prompt);
    const available = (await this.bridgeManager.discover()).filter((bridge) => bridge.available);
    const preferences = this.config.get().routing?.agents || {};
    const defaults = {
      frontend: ['claude', 'codex'], systems: ['codex', 'claude'], verification: ['codex', 'claude'],
      research: ['hermes', 'claude'], 'large-change': ['codex', 'claude'], 'general-coding': ['codex', 'claude', 'aider'],
    };
    const ordered = taskProfile.tags.flatMap((tag) => preferences[tag] || defaults[tag] || []);
    const selected = ordered.find((name) => available.some((bridge) => bridge.name === name)) || null;
    return {
      selected: selected ? { type: 'bridge', name: selected } : { type: 'internal', name: 'maskshift-subagent' },
      taskProfile, available: available.map((bridge) => bridge.name), workspaceId,
      reason: selected ? `Available bridge preferred for ${taskProfile.tags.join(', ')} work.` : 'No preferred external bridge is installed; use an internal isolated subagent.',
    };
  }
}
