import { runCommand, safeJsonParse, shellQuote, truncate } from '../core/utils.mjs';

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function matches(rule, payload) {
  if (!rule.match) return true;
  const target = `${payload.tool || ''} ${payload.command || ''} ${payload.workspacePath || ''}`;
  try { return new RegExp(rule.match, 'i').test(target); } catch { return target.toLowerCase().includes(String(rule.match).toLowerCase()); }
}

export class HookManager {
  constructor({ config, logger, eventBus }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  definitions(eventName) {
    return asArray(this.config.get().hooks?.[eventName]).map((entry) => {
      if (typeof entry === 'string') return { type: 'command', command: entry };
      return { type: entry.type || (entry.url ? 'http' : 'command'), ...entry };
    });
  }

  list() {
    return Object.fromEntries(Object.keys(this.config.get().hooks || {}).map((name) => [name, this.definitions(name)]));
  }

  async run(eventName, payload = {}) {
    const rules = this.definitions(eventName).filter((rule) => rule.enabled !== false && matches(rule, payload));
    if (!rules.length) return [];
    const results = [];
    for (const rule of rules) {
      const started = Date.now();
      this.eventBus.emit('hook.started', { eventName, type: rule.type }, {
        runId: payload.runId, sessionId: payload.sessionId, workspaceId: payload.workspaceId,
      });
      try {
        const result = rule.type === 'http'
          ? await this.#http(eventName, rule, payload)
          : await this.#command(eventName, rule, payload);
        results.push(result);
        this.eventBus.emit('hook.completed', { eventName, type: rule.type, durationMs: Date.now() - started }, {
          runId: payload.runId, sessionId: payload.sessionId, workspaceId: payload.workspaceId,
        });
      } catch (error) {
        const blocking = rule.blocking === true;
        this.logger.warn('Hook failed', { eventName, blocking, error: error.message });
        this.eventBus.emit('hook.failed', { eventName, type: rule.type, blocking, error: error.message }, {
          runId: payload.runId, sessionId: payload.sessionId, workspaceId: payload.workspaceId,
        });
        results.push({ ok: false, error: error.message, blocking });
        if (blocking) throw error;
      }
    }
    return results;
  }

  async #command(eventName, rule, payload) {
    if (!rule.command) throw new Error(`Command hook for ${eventName} is missing command`);
    const json = JSON.stringify({ event: eventName, ...payload });
    const env = {
      MASKSHIFT_HOOK_EVENT: eventName,
      MASKSHIFT_HOOK_PAYLOAD: json,
      MASKSHIFT_RUN_ID: payload.runId || '',
      MASKSHIFT_SESSION_ID: payload.sessionId || '',
      MASKSHIFT_WORKSPACE_ID: payload.workspaceId || '',
      MASKSHIFT_WORKSPACE: payload.workspacePath || '',
      ...(rule.env || {}),
    };
    const command = rule.stdin === true
      ? `printf %s ${shellQuote(json)} | ${rule.command}`
      : rule.command;
    const result = await runCommand(command, {
      cwd: rule.cwd || payload.workspacePath || process.cwd(),
      env,
      timeoutMs: rule.timeoutMs || 30_000,
      maxOutputChars: rule.maxOutputChars || 40_000,
    });
    if (result.code !== 0) throw new Error(truncate(result.stderr || result.stdout || `Hook exited ${result.code}`, 4000));
    const parsed = safeJsonParse(result.stdout.trim(), null);
    return { ok: true, code: result.code, stdout: truncate(result.stdout, 20_000), data: parsed };
  }

  async #http(eventName, rule, payload) {
    if (!rule.url) throw new Error(`HTTP hook for ${eventName} is missing URL`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rule.timeoutMs || 30_000);
    timer.unref();
    try {
      const response = await fetch(rule.url, {
        method: rule.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...(rule.headers || {}) },
        body: JSON.stringify({ event: eventName, ...payload }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(text, 2000)}`);
      return { ok: true, status: response.status, body: truncate(text, 20_000) };
    } finally {
      clearTimeout(timer);
    }
  }
}
