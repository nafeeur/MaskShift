// How a tool asks the person at the keyboard a question mid-run.
//
// A run can reach a point only a person can resolve — which restaurant, what password, did the
// bank text you a code, is it OK to place this order. Tools do not know whether they are running
// under the full-screen interface, a plain terminal session or a headless script, so they ask this
// broker, and whichever surface is attached answers. With no surface attached the request fails
// with a message that says what is needed, instead of hanging or guessing.
//
// Nothing an answer contains is ever logged or emitted: events and the audit trail record that a
// question of some kind was asked and whether it was answered, never the text, and never the
// content of a secret.

const MAX_OPTIONS = 60;
const clip = (value, max) => String(value ?? '').slice(0, max);

export class NoInteractiveSurfaceError extends Error {
  constructor(kind) {
    super(`This step needs a person (${kind}), but this run has no interactive surface attached. Run it in the interface (maskshift) or a plain session (maskshift --plain), where you can be asked.`);
    this.name = 'NoInteractiveSurfaceError';
    this.code = 'NO_INTERACTION';
    this.kind = kind;
  }
}

export function normalizeOptions(options = []) {
  if (!Array.isArray(options) || !options.length) throw new Error('At least one option is required');
  const seen = new Set();
  const out = [];
  for (const [index, option] of options.slice(0, MAX_OPTIONS).entries()) {
    const raw = typeof option === 'string' ? { label: option } : (option || {});
    let id = String(raw.id ?? raw.ref ?? index + 1);
    while (seen.has(id)) id = `${id}_${index}`;
    seen.add(id);
    const label = clip(raw.label ?? raw.title ?? raw.name ?? id, 140);
    out.push({
      id, label,
      detail: clip(raw.detail ?? raw.description ?? '', 400),
      ...(raw.price ? { price: clip(raw.price, 40) } : {}),
      ...(raw.rating ? { rating: clip(raw.rating, 40) } : {}),
      ...(raw.meta ? { meta: raw.meta } : {}),
    });
  }
  return out;
}

export class InteractionBroker {
  constructor({ eventBus = null, logger = null } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.handler = null;
  }

  /** `handler` may implement any of choose, text, secret, confirm, handoff. Pass null to detach. */
  attach(handler) {
    this.handler = handler;
    return () => { if (this.handler === handler) this.handler = null; };
  }

  supports(kind) {
    return typeof this.handler?.[kind] === 'function';
  }

  async #ask(kind, title, request) {
    if (!this.supports(kind)) throw new NoInteractiveSurfaceError(kind);
    const scope = request.scope || {};
    this.eventBus?.emit('interaction.requested', { kind, title: clip(title, 120) }, scope);
    this.logger?.audit?.('interaction.requested', { ...scope, kind, title: clip(title, 120) });
    let answer;
    try {
      answer = await this.handler[kind](request);
    } catch (error) {
      this.eventBus?.emit('interaction.answered', { kind, cancelled: true, error: true }, scope);
      throw error;
    }
    const cancelled = answer === null || answer === undefined || answer?.cancelled === true;
    this.eventBus?.emit('interaction.answered', { kind, cancelled }, scope);
    this.logger?.audit?.('interaction.answered', { ...scope, kind, cancelled });
    return answer;
  }

  /**
   * Pick one (or several) of `options`. Resolves `{ ids, other, cancelled }`; `ids` is always an
   * array (one element unless `multi`).
   */
  async choose({ title = 'Choose', question = '', options, multi = false, allowOther = false, otherLabel = 'Something else…', defaultId = null, scope = null }) {
    const normalized = normalizeOptions(options);
    const answer = await this.#ask('choose', title, { title, question, options: normalized, multi, allowOther, otherLabel, defaultId, scope });
    if (!answer || answer.cancelled) return { ids: [], other: null, cancelled: true };
    const valid = new Set(normalized.map((option) => option.id));
    const ids = (Array.isArray(answer.ids) ? answer.ids : [answer.id]).filter((id) => valid.has(String(id))).map(String);
    const other = allowOther && typeof answer.other === 'string' && answer.other.trim() ? answer.other.trim() : null;
    if (!ids.length && !other) return { ids: [], other: null, cancelled: true };
    return { ids: multi ? ids : ids.slice(0, 1), other, cancelled: false, options: normalized };
  }

  async text({ title = 'Question', question = '', placeholder = '', defaultValue = '', scope = null }) {
    const answer = await this.#ask('text', title, { title, question, placeholder, defaultValue, scope });
    if (answer === null || answer === undefined || answer?.cancelled) return { value: null, cancelled: true };
    return { value: String(typeof answer === 'string' ? answer : answer.value ?? ''), cancelled: false };
  }

  /** The value is returned to the caller and goes nowhere else. */
  async secret({ title = 'Secret', question = '', scope = null }) {
    const answer = await this.#ask('secret', title, { title, question, scope });
    if (answer === null || answer === undefined || answer?.cancelled) return { value: null, cancelled: true };
    return { value: String(typeof answer === 'string' ? answer : answer.value ?? ''), cancelled: false };
  }

  async confirm({ title = 'Confirm', message = '', danger = false, details = [], defaultYes = !danger, scope = null }) {
    const answer = await this.#ask('confirm', title, { title, message, danger, details, defaultYes, scope });
    return answer === true || answer?.confirmed === true;
  }

  /** Hand the browser to the person for a step no program should do (a CAPTCHA, a bank prompt). */
  async handoff({ title = 'Your turn', message = '', instanceId = null, tabId = null, scope = null }) {
    const answer = await this.#ask('handoff', title, { title, message, instanceId, tabId, scope });
    return { done: answer === true || answer?.done === true };
  }
}
