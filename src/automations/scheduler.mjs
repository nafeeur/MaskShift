import { nowIso } from '../core/utils.mjs';

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function normalizeSchedule(value) {
  if (typeof value === 'object' && value) return value;
  const text = String(value || '').trim();
  if (!text) throw new Error('Schedule is required');
  const interval = text.match(/^every\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (interval) return { type: 'interval', everyMs: Math.max(1000, Number(interval[1]) * UNIT_MS[interval[2].toLowerCase()]) };
  const shortcuts = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
  if (shortcuts[text.toLowerCase()]) return { type: 'cron', expression: shortcuts[text.toLowerCase()] };
  if (/^(\S+\s+){4}\S+$/.test(text)) return { type: 'cron', expression: text };
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return { type: 'once', at: date.toISOString() };
  throw new Error(`Unsupported schedule: ${text}`);
}

function fieldMatches(field, value, min, max) {
  const pieces = String(field).split(',');
  return pieces.some((piece) => {
    const [base, stepRaw] = piece.split('/');
    const step = Math.max(1, Number(stepRaw || 1));
    let start = min;
    let end = max;
    if (base !== '*') {
      if (base.includes('-')) {
        const [a, b] = base.split('-').map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        start = a; end = b;
      } else {
        const exact = Number(base);
        if (!Number.isFinite(exact)) return false;
        start = exact; end = exact;
      }
    }
    return value >= start && value <= end && ((value - start) % step === 0);
  });
}

function cronMatches(expression, date) {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron requires five fields: ${expression}`);
  const [minute, hour, day, month, weekday] = fields;
  return fieldMatches(minute, date.getMinutes(), 0, 59)
    && fieldMatches(hour, date.getHours(), 0, 23)
    && fieldMatches(day, date.getDate(), 1, 31)
    && fieldMatches(month, date.getMonth() + 1, 1, 12)
    && fieldMatches(weekday, date.getDay(), 0, 6);
}

export function nextRunAt(scheduleValue, from = new Date()) {
  const schedule = normalizeSchedule(scheduleValue);
  if (schedule.type === 'once') {
    const at = new Date(schedule.at);
    return at.getTime() > from.getTime() ? at.toISOString() : null;
  }
  if (schedule.type === 'interval') return new Date(from.getTime() + Math.max(1000, Number(schedule.everyMs))).toISOString();
  if (schedule.type === 'cron') {
    const candidate = new Date(from.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);
    const deadline = candidate.getTime() + 366 * 24 * 60 * 60_000;
    while (candidate.getTime() <= deadline) {
      if (cronMatches(schedule.expression, candidate)) return candidate.toISOString();
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    throw new Error(`No cron occurrence found within one year: ${schedule.expression}`);
  }
  throw new Error(`Unknown schedule type: ${schedule.type}`);
}

export class AutomationScheduler {
  constructor({ store, config, eventBus, logger, toolRegistry, workspaceManager, getEngine }) {
    this.store = store;
    this.config = config;
    this.eventBus = eventBus;
    this.logger = logger;
    this.toolRegistry = toolRegistry;
    this.workspaceManager = workspaceManager;
    this.getEngine = getEngine;
    this.timer = null;
    this.running = new Set();
  }

  start() {
    if (this.timer || this.config.get().automations?.enabled === false) return;
    const intervalMs = Math.max(500, Number(this.config.get().automations?.pollIntervalMs || 1000));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  list(options = {}) { return this.store.listAutomations(options); }
  get(automationId) { return this.store.getAutomation(automationId); }

  create({ workspaceId = null, name, enabled = true, schedule, action, meta = {} }) {
    if (!name) throw new Error('Automation name is required');
    if (!action?.type) throw new Error('Automation action.type is required');
    const normalized = normalizeSchedule(schedule);
    const next = enabled ? nextRunAt(normalized, new Date(Date.now() - 1000)) : null;
    const automation = this.store.saveAutomation({ workspaceId, name, enabled, schedule: normalized, action, nextRunAt: next, meta });
    this.eventBus?.emit('automation.created', automation, { workspaceId });
    return automation;
  }

  update(automationId, patch = {}) {
    const current = this.get(automationId);
    if (!current) throw new Error(`Unknown automation: ${automationId}`);
    const schedule = patch.schedule ? normalizeSchedule(patch.schedule) : current.schedule;
    const enabled = patch.enabled ?? current.enabled;
    const next = enabled ? nextRunAt(schedule, new Date(Date.now() - 1000)) : null;
    const updated = this.store.updateAutomation(automationId, { ...patch, schedule, enabled, nextRunAt: next });
    this.eventBus?.emit('automation.updated', updated, { workspaceId: updated.workspace_id });
    return updated;
  }

  remove(automationId) {
    const current = this.get(automationId);
    if (!current) return false;
    this.store.deleteAutomation(automationId);
    this.eventBus?.emit('automation.deleted', { id: automationId, name: current.name }, { workspaceId: current.workspace_id });
    return true;
  }

  async tick() {
    const due = this.store.listDueAutomations(nowIso(), Number(this.config.get().automations?.maxPerTick || 10));
    for (const automation of due) {
      if (this.running.has(automation.id)) continue;
      this.running.add(automation.id);
      void this.execute(automation.id).finally(() => this.running.delete(automation.id));
    }
  }

  async execute(automationId, { manual = false } = {}) {
    const automation = this.get(automationId);
    if (!automation) throw new Error(`Unknown automation: ${automationId}`);
    const startedAt = nowIso();
    const next = automation.schedule.type === 'once' ? null : nextRunAt(automation.schedule, new Date());
    this.store.updateAutomation(automation.id, { lastRunAt: startedAt, lastStatus: 'running', nextRunAt: next });
    const scope = { workspaceId: automation.workspace_id || null };
    this.eventBus?.emit('automation.started', { ...automation, manual }, scope);
    try {
      const result = await this.#runAction(automation);
      this.store.updateAutomation(automation.id, {
        lastRunAt: startedAt,
        lastStatus: 'completed',
        nextRunAt: next,
        enabled: automation.schedule.type === 'once' ? false : automation.enabled,
        meta: { ...(automation.meta || {}), lastResult: result, lastError: null },
      });
      this.eventBus?.emit('automation.completed', { id: automation.id, name: automation.name, result }, scope);
      return { automationId: automation.id, status: 'completed', result };
    } catch (error) {
      this.store.updateAutomation(automation.id, {
        lastRunAt: startedAt,
        lastStatus: 'failed',
        nextRunAt: next,
        enabled: automation.schedule.type === 'once' ? false : automation.enabled,
        meta: { ...(automation.meta || {}), lastError: error.message },
      });
      this.logger?.warn('Automation failed', { automationId, name: automation.name, error: error.stack || error.message });
      this.eventBus?.emit('automation.failed', { id: automation.id, name: automation.name, error: error.message }, scope);
      throw error;
    }
  }

  async #runAction(automation) {
    const action = automation.action || {};
    const workspace = automation.workspace_id ? this.workspaceManager.get(automation.workspace_id) : null;
    const context = { workspaceId: automation.workspace_id || null, workspacePath: workspace?.path || process.cwd(), automationId: automation.id };
    if (action.type === 'agent') {
      const engine = this.getEngine();
      if (!engine) throw new Error('Agent engine is not available');
      const session = action.sessionId ? engine.store.getSession(action.sessionId) : engine.createSession({
        workspaceId: automation.workspace_id || null,
        title: action.sessionTitle || `[AUTO] ${automation.name}`,
        modelRef: action.modelRef || null,
        meta: { automationId: automation.id },
      });
      if (!session) throw new Error(`Automation session not found: ${action.sessionId}`);
      const run = await engine.startRun({
        sessionId: session.id, workspaceId: automation.workspace_id || null,
        prompt: action.prompt, modelRef: action.modelRef || null,
        options: { ...(action.options || {}), source: 'automation', automationId: automation.id },
      });
      const completed = await engine.waitForRun(run.id);
      return { type: 'agent', runId: run.id, sessionId: session.id, status: completed.status, error: completed.error || null };
    }
    if (action.type === 'tool') {
      return { type: 'tool', tool: action.name, result: await this.toolRegistry.execute(action.name, action.arguments || {}, context) };
    }
    if (action.type === 'shell') {
      return { type: 'shell', result: await this.toolRegistry.execute('shell_exec', { command: action.command, cwd: action.cwd || '.' }, context) };
    }
    throw new Error(`Unsupported automation action type: ${action.type}`);
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
