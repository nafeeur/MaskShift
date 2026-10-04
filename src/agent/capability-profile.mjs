// What the harness believes a model can do, and how much help to give it.
//
// Help is a dial, not a mode. Level 0 is a capable model left to work as it likes; level 3 is a
// model the harness carries — a compact prompt, a short tool menu, tight output budgets, a plan
// asked for up front. Each level only ADDS assistance, and everything that is free for every
// model (call repair, forgiving edits, post-edit checks) stays on at all of them.
//
// The level comes from, in order of trust:
//   1. a calibration run, which measures the model on probes (see calibration.mjs);
//   2. what the model has actually done in past runs here, as a running average of how often it
//      needed the harness to step in;
//   3. a prior from its size and window, used until either exists.
// and within a run it moves up — never down, which would churn the prompt cache — when the model
// keeps stumbling. Nothing here names a model or a vendor.

export const CAPABILITIES = ['toolCalling', 'editing', 'planning', 'longContext'];
export const MAX_LEVEL = 3;

const LEVELS = [
  { level: 0, compactPrompt: false, coreTools: false, observationScale: 1, repairBudget: 2, stagnationRepeat: 3, planFirst: false },
  { level: 1, compactPrompt: false, coreTools: false, observationScale: 0.8, repairBudget: 3, stagnationRepeat: 3, planFirst: false },
  { level: 2, compactPrompt: true, coreTools: true, observationScale: 0.5, repairBudget: 3, stagnationRepeat: 2, planFirst: false },
  { level: 3, compactPrompt: true, coreTools: true, observationScale: 0.35, repairBudget: 4, stagnationRepeat: 2, planFirst: true },
];

// Used only until the model has been measured or observed.
const PRIOR_SCORE = { small: 0.55, medium: 0.75, large: 0.9 };

export const knobsFor = (level) => ({ ...LEVELS[Math.max(0, Math.min(MAX_LEVEL, Math.round(level)))] });

export function levelFromScore(score) {
  if (score >= 0.85) return 0;
  if (score >= 0.68) return 1;
  if (score >= 0.5) return 2;
  return 3;
}

export function compositeScore(scores = {}) {
  // Tool calling and editing decide whether an agent loop works at all, so they weigh most.
  const weights = { toolCalling: 0.35, editing: 0.3, planning: 0.15, longContext: 0.2 };
  let total = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(weights)) {
    if (Number.isFinite(scores[key])) { total += scores[key] * w; weight += w; }
  }
  return weight ? total / weight : null;
}

// How much each thing that goes wrong counts toward "this model needs more help right now".
const SIGNAL_WEIGHTS = {
  'parse-failure': 2,
  'repaired-call': 0.5,
  'fuzzy-edit': 0.5,
  'edit-miss': 1,
  'edit-problem': 0.75,
  'tool-error': 0.4,
  stagnation: 2,
  'verification-fail': 1.5,
};
const CLEAN_RELIEF = 0.15;
const PROMOTE_AT = 6;
const SMALL_WINDOW = 16_000;

export class ScaffoldController {
  constructor({ level, source, onChange = null }) {
    this.baseLevel = level;
    this.level = level;
    this.source = source;
    this.onChange = onChange;
    this.pressure = 0;
    this.accumulated = 0;
    this.toolCalls = 0;
    this.counts = {};
  }

  get knobs() { return knobsFor(this.level); }

  /** A tool call went through with nothing for the harness to fix. */
  clean() {
    this.toolCalls += 1;
    this.pressure = Math.max(0, this.pressure - CLEAN_RELIEF);
  }

  /** One tool call finished; `kinds` is whatever the harness had to fix about it (often nothing). */
  result(kinds = []) {
    if (!kinds.length) { this.clean(); return; }
    this.toolCalls += 1;
    for (const kind of kinds) this.signal(kind);
  }

  signal(kind) {
    const weight = SIGNAL_WEIGHTS[kind];
    if (!weight) return;
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    this.accumulated += weight;
    this.pressure += weight;
    if (this.pressure >= PROMOTE_AT && this.level < MAX_LEVEL) {
      const from = this.level;
      this.level += 1;
      this.pressure = PROMOTE_AT / 3;
      this.onChange?.({ from, to: this.level, reason: kind, counts: { ...this.counts } });
    }
  }

  summary() {
    return {
      baseLevel: this.baseLevel, level: this.level, toolCalls: this.toolCalls,
      rate: this.toolCalls ? this.accumulated / Math.max(5, this.toolCalls) : 0,
      counts: { ...this.counts },
    };
  }
}

export class CapabilityRegistry {
  constructor({ store }) {
    this.store = store;
  }

  profile(ref) { return this.store?.getSetting(`capability:profile:${ref}`, null) || null; }
  observed(ref) { return this.store?.getSetting(`capability:observed:${ref}`, null) || null; }

  saveProfile(ref, profile) {
    this.store?.setSetting(`capability:profile:${ref}`, profile);
    return profile;
  }

  /** The level to start a run at and why. */
  decide(ref, modelProfile = null) {
    const calibrated = this.profile(ref);
    const observed = this.observed(ref);
    const base = calibrated?.composite ?? PRIOR_SCORE[modelProfile?.tier] ?? PRIOR_SCORE.medium;
    // Only a track record of a few runs moves the level; one bad run does not.
    const adjustment = observed?.runs >= 2 ? Math.min(0.35, Math.max(0, observed.ema * 0.5)) : 0;
    const score = base - adjustment;
    // A small window is a hard limit, not a weakness: however well a model scores, the full
    // prompt and tool schemas do not fit in it, so it always gets the compact forms.
    const floor = modelProfile?.contextWindow && modelProfile.contextWindow < SMALL_WINDOW ? 2 : 0;
    return {
      level: Math.max(levelFromScore(score), floor), score, adjustment, floor,
      source: calibrated ? 'calibration' : (modelProfile?.tier ? 'prior' : 'default'),
      observedRuns: observed?.runs || 0,
    };
  }

  begin(ref, modelProfile, { onChange = null } = {}) {
    const decision = this.decide(ref, modelProfile);
    return new ScaffoldController({ level: decision.level, source: decision.source, onChange });
  }

  /** Folds a finished run into the model's track record. Runs that barely used tools say nothing. */
  record(ref, summary) {
    if (!this.store || !summary || summary.toolCalls < 3) return null;
    const previous = this.observed(ref);
    const ema = previous ? previous.ema * 0.7 + summary.rate * 0.3 : summary.rate;
    const next = { runs: (previous?.runs || 0) + 1, ema, lastRate: summary.rate, lastLevel: summary.level, updatedAt: new Date().toISOString() };
    this.store.setSetting(`capability:observed:${ref}`, next);
    return next;
  }

  describe(ref, modelProfile = null) {
    const decision = this.decide(ref, modelProfile);
    return {
      ref, tier: modelProfile?.tier || null, ...decision, knobs: knobsFor(decision.level),
      calibration: this.profile(ref), observed: this.observed(ref),
    };
  }
}
