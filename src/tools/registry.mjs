import { textScore, truncate } from '../core/utils.mjs';
import { requiresConfirmation } from './permissions.mjs';

export class ToolRegistry {
  constructor({ logger, eventBus, hooks = null, config }) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.hooks = hooks;
    this.config = config;
    this.tools = new Map();
    // Set by an interactive surface (the TUI, an interactive CLI prompt) to
    // gate tool calls under permissionMode "balanced"/"review". Left null in
    // headless contexts (automations, `mcp serve`, plugin-driven runs), where
    // a gated call fails closed rather than executing unattended with no one
    // to ask — see #authorize below.
    this.confirmHandler = null;
  }

  register(tool) {
    if (!tool?.name || !/^[a-zA-Z0-9_-]+$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool?.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, {
      category: 'general',
      keywords: [],
      readOnly: false,
      risk: 'normal',
      alwaysAvailable: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      ...tool,
    });
    return this;
  }

  has(name) { return this.tools.has(name); }
  get(name) { return this.tools.get(name) || null; }
  unregister(name) { return this.tools.delete(name); }

  descriptor(name) {
    const tool = this.get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema,
      category: tool.category,
      readOnly: Boolean(tool.readOnly),
      risk: tool.risk,
      alwaysAvailable: Boolean(tool.alwaysAvailable),
    };
  }

  list({ category, includeSchema = true } = {}) {
    return [...this.tools.values()]
      .filter((tool) => !category || tool.category === category)
      .map((tool) => ({
        name: tool.name,
        title: tool.title || tool.name,
        description: tool.description || '',
        category: tool.category,
        readOnly: Boolean(tool.readOnly),
        risk: tool.risk,
        alwaysAvailable: Boolean(tool.alwaysAvailable),
        ...(includeSchema ? { inputSchema: tool.inputSchema } : {}),
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  search(query, { limit = 20, category = null } = {}) {
    return [...this.tools.values()]
      .filter((tool) => !category || tool.category === category)
      .map((tool) => ({
        ...this.descriptor(tool.name),
        score: textScore(query, `${tool.name} ${tool.title || ''} ${tool.description || ''} ${tool.category}`, tool.keywords || []),
      }))
      .filter((tool) => tool.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async execute(name, args, context = {}) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const scope = { runId: context.runId, sessionId: context.sessionId, workspaceId: context.workspaceId };
    await this.#authorize(tool, name, args, context, scope);
    const started = Date.now();
    const event = { tool: name, args, category: tool.category, risk: tool.risk };
    this.eventBus.emit('tool.started', event, scope);
    this.logger.audit('tool.start', { ...scope, tool: name, args });
    await this.hooks?.run('PreToolUse', { ...event, ...scope, workspacePath: context.workspacePath });
    try {
      const result = await tool.execute(args || {}, context);
      const bounded = typeof result === 'string'
        ? truncate(result, this.config.get().maxToolOutputChars)
        : result;
      const durationMs = Date.now() - started;
      this.eventBus.emit('tool.completed', { tool: name, durationMs, result: bounded }, scope);
      this.logger.audit('tool.complete', { ...scope, tool: name, durationMs, ok: true });
      await this.hooks?.run('PostToolUse', { ...event, ...scope, durationMs, result: bounded, workspacePath: context.workspacePath });
      return bounded;
    } catch (error) {
      const durationMs = Date.now() - started;
      this.eventBus.emit('tool.failed', { tool: name, durationMs, error: error.message }, scope);
      this.logger.audit('tool.complete', { ...scope, tool: name, durationMs, ok: false, error: error.message });
      await this.hooks?.run('PostToolUseFailure', { ...event, ...scope, durationMs, error: error.message, workspacePath: context.workspacePath });
      throw error;
    }
  }

  async #authorize(tool, name, args, context, scope) {
    const permissionMode = this.config.get().permissionMode || 'autonomous';
    if (!requiresConfirmation(tool, permissionMode)) return;
    let allowed = false;
    let reason = 'declined';
    if (!this.confirmHandler) {
      reason = 'no-confirm-handler';
    } else {
      allowed = await this.confirmHandler({ name, tool: this.descriptor(name), args, context });
    }
    if (allowed) return;
    this.logger.audit('tool.blocked', { ...scope, tool: name, risk: tool.risk, permissionMode, reason });
    this.eventBus.emit('tool.blocked', { tool: name, risk: tool.risk, permissionMode, reason }, scope);
    const detail = reason === 'no-confirm-handler'
      ? 'no confirmation handler is available in this context (a headless automation, plugin, or `mcp serve` run) — switch to "autonomous" or run it where a human can confirm'
      : 'the confirmation was declined';
    const error = new Error(`"${name}" requires confirmation under permission mode "${permissionMode}", and ${detail}.`);
    error.code = 'PERMISSION_DENIED';
    throw error;
  }
}
