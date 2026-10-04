// Choosing who should do a task from what has actually worked.
//
// Each candidate gets a success estimate shaped like a Beta posterior: its weighted record on similar tasks, pulled toward
// its own overall record by a few pseudo-trials so one lucky run proves nothing. A small exploration bonus keeps an
// under-tried candidate from being starved forever, and cost (what its runs have really cost) is subtracted so that
// among equals the cheaper one wins. Nothing is invented: with no history it says so and defers to configuration.

const PRIOR_STRENGTH = 4;

export function scoreCandidate(stats, { totalSamples = 0, explore = 0.1, costWeight = 0.15, maxCost = 0 } = {}) {
  // An executor's overall record says something about how good it is, but not everything about this kind of task, so it
  // is trusted only halfway: a model that fails at poems is not thereby worse at parsers.
  const prior = 0.5 + 0.5 * ((stats.globalRate ?? 0.5) - 0.5);
  const n = stats.effective || 0;
  const successRate = (stats.successes + PRIOR_STRENGTH * prior) / (n + PRIOR_STRENGTH);
  const bonus = explore * Math.sqrt(2 * Math.log(totalSamples + 2) / (n + 1));
  const costTerm = maxCost > 0 && stats.avgCost != null ? costWeight * (stats.avgCost / maxCost) : 0;
  const correctionTerm = Math.min(0.1, (stats.avgCorrections || 0) * 0.03);
  return { successRate, value: successRate + bonus - costTerm - correctionTerm, bonus, costTerm, correctionTerm, evidence: n };
}

export class LearnedRouter {
  constructor({ ledger, config }) {
    this.ledger = ledger;
    this.config = config;
  }

  settings() {
    const routing = this.config.get().learning?.routing || {};
    return { learned: routing.learned !== false, explore: routing.explore ?? 0.1, costWeight: routing.costWeight ?? 0.15, minEvidence: routing.minEvidence ?? 3 };
  }

  /**
   * @param candidates  [{ executor, ...anything the caller wants back }]
   * @returns ranked best first, each with `learned: { successRate, value, evidence, ... }`; `informed` says whether any
   *          candidate had enough history for the ranking to mean something
   */
  rank(candidates, profile) {
    const settings = this.settings();
    const stats = candidates.map((candidate) => ({ candidate, stats: this.ledger.stats(candidate.executor, profile) }));
    const totalSamples = stats.reduce((sum, item) => sum + item.stats.effective, 0);
    const maxCost = Math.max(0, ...stats.map((item) => item.stats.avgCost || 0));
    const ranked = stats.map(({ candidate, stats: s }) => ({
      ...candidate, stats: s, learned: scoreCandidate(s, { totalSamples, explore: settings.explore, costWeight: settings.costWeight, maxCost }),
    })).sort((a, b) => b.learned.value - a.learned.value);
    const informed = settings.learned && ranked.some((item) => item.learned.evidence >= settings.minEvidence);
    return { ranked, informed };
  }

  /** Best first, with the rest as the order to fall back to when the first one is not getting there. */
  plan(candidates, profile) {
    const { ranked, informed } = this.rank(candidates, profile);
    return { primary: ranked[0] || null, escalation: ranked.slice(1), informed, ranked };
  }

  explain(ranked) {
    return ranked.map((item, index) => {
      const s = item.stats;
      const record = s.effective >= 1 ? `${Math.round(s.successRate * 100)}% of ${s.effective.toFixed(1)} similar runs` : 'no similar history';
      return `${index + 1}. ${item.executor}: ${Math.round(item.learned.successRate * 100)}% expected (${record})${s.avgCost ? `, ~$${s.avgCost.toFixed(3)}/run` : ''}`;
    });
  }
}
