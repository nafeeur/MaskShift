// Did the context that was handed to the model get used? Afterwards, compare the files the planner put in front of the model
// with the files the run actually opened and changed. Mostly unused context means the budget was spent badly (shrink it);
// files the run needed that were never offered mean it was too small or aimed wrong (grow it). The result nudges the source
// budget for that kind of task, slowly and within bounds, and only after enough runs to mean something.

const MIN_RUNS = 5;
const ALPHA = 0.2;

const normalize = (file, root) => String(file || '').replace(root ? `${root}/` : '\u0000', '').replace(/^\.\//, '');

export function measureUse(contextPlan, trace, { root = '', finalText = '' } = {}) {
  const included = [...new Set((contextPlan?.source?.items || []).map((item) => normalize(item.path, root)))];
  const touched = new Set([...trace.read, ...trace.edited].map((file) => normalize(file, root)));
  const mentioned = (file) => file && String(finalText).includes(file);
  const hit = (file) => touched.has(file) || mentioned(file) || [...touched].some((item) => item.endsWith(`/${file}`) || file.endsWith(`/${item}`));
  const used = included.filter(hit);
  return {
    profile: contextPlan?.profile || 'focused', included: included.length, used: used.length, touched: touched.size,
    precision: included.length ? used.length / included.length : null,
    recall: touched.size ? [...touched].filter((file) => included.some((item) => item === file || item.endsWith(`/${file}`) || file.endsWith(`/${item}`))).length / touched.size : null,
  };
}

export class ContextFeedback {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.key = 'learning:context';
  }

  state() { return this.store.getSetting(this.key, {}); }

  record(measure) {
    if (this.config.get().learning?.context?.adapt === false) return null;
    if (measure.precision === null && measure.recall === null) return null;
    const state = this.state();
    const entry = state[measure.profile] || { n: 0, precision: 0.5, recall: 0.5 };
    const blend = (old, value) => (value === null ? old : (entry.n ? old * (1 - ALPHA) + value * ALPHA : value));
    state[measure.profile] = { n: entry.n + 1, precision: blend(entry.precision, measure.precision), recall: blend(entry.recall, measure.recall) };
    this.store.setSetting(this.key, state);
    return state[measure.profile];
  }

  /** Multiplier for the source budget of a task profile. 1 until there is enough evidence. */
  multiplier(profile) {
    if (this.config.get().learning?.context?.adapt === false) return 1;
    const entry = this.state()[profile];
    if (!entry || entry.n < MIN_RUNS) return 1;
    const wantMore = Math.max(0, 0.5 - entry.recall);
    const wantLess = Math.max(0, 0.3 - entry.precision);
    return Math.min(1.4, Math.max(0.6, 1 + 0.8 * wantMore - 1.0 * wantLess));
  }
}
