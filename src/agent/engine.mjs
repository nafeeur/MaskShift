import { nowIso, runCommand, truncate } from '../core/utils.mjs';
import { estimateUsageCost, summarizeCosts } from '../core/pricing.mjs';

function titleFromPrompt(prompt) {
  return String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 78) || 'MaskShift run';
}

function messageForProvider(message) {
  const meta = message.meta || {};
  return {
    role: message.role,
    content: truncate(message.content || '', 180_000),
    ...(meta.toolCalls ? { toolCalls: meta.toolCalls } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId, toolName: meta.toolName, isError: meta.isError } : {}),
  };
}

function renderToolResult(value, maxChars) {
  if (typeof value === 'string') return truncate(value, maxChars);
  try { return truncate(JSON.stringify(value, null, 2), maxChars); } catch { return truncate(String(value), maxChars); }
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || /aborted|cancelled/i.test(error?.message || '');
}

export class AgentEngine {
  constructor({
    store, config, logger, eventBus, hooks, providerManager, workspaceManager,
    indexer, toolRegistry, capabilityController, promptBuilder, contextBuilder, mcpManager,
  }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.hooks = hooks;
    this.providerManager = providerManager;
    this.workspaceManager = workspaceManager;
    this.indexer = indexer;
    this.toolRegistry = toolRegistry;
    this.capabilityController = capabilityController;
    this.promptBuilder = promptBuilder;
    this.contextBuilder = contextBuilder;
    this.mcpManager = mcpManager;
    this.active = new Map();
    this.recentCompletions = new Map();
  }

  createSession({ workspaceId = null, title = 'New run', modelRef = null, meta = {} } = {}) {
    return this.store.createSession({ workspaceId, title, modelId: modelRef || this.config.get().defaultModel, meta });
  }

  async startRun({ sessionId = null, workspaceId = null, prompt, modelRef = null, options = {} } = {}) {
    if (!String(prompt || '').trim()) throw new Error('Run prompt cannot be empty');
    let session = sessionId ? this.store.getSession(sessionId) : null;
    if (sessionId && !session) throw new Error(`Unknown session: ${sessionId}`);
    if (!workspaceId) workspaceId = session?.workspace_id || this.store.getSetting('lastWorkspaceId', null);
    if (workspaceId) this.workspaceManager.get(workspaceId);
    if (!session) session = this.createSession({ workspaceId, title: titleFromPrompt(prompt), modelRef });
    else if (!session.workspace_id && workspaceId) session = this.store.updateSession(session.id, { workspace_id: workspaceId });
    if (/^new run$/i.test(session.title || '')) session = this.store.updateSession(session.id, { title: titleFromPrompt(prompt) });

    const selectedModel = modelRef || session.model_id || this.config.get().defaultModel;
    this.store.addMessage({ sessionId: session.id, role: 'user', content: String(prompt), meta: { source: options.source || 'user', parentRunId: options.parentRunId || null } });
    const run = this.store.createRun({
      sessionId: session.id, workspaceId, prompt: String(prompt), modelId: selectedModel,
      meta: { parentRunId: options.parentRunId || null, depth: options.depth || 0, source: options.source || 'user', isolated: Boolean(options.isolated) },
    });
    const controller = new AbortController();
    const entry = {
      runId: run.id, sessionId: session.id, workspaceId, controller,
      status: 'queued', startedAt: Date.now(), capabilityState: null,
      planState: { summary: '', steps: [], updatedAt: nowIso() },
      options,
    };
    this.active.set(run.id, entry);
    const promise = this.#execute(run, session, entry)
      .catch((error) => {
        this.logger.error('Uncaught agent execution failure', { runId: run.id, error: error.stack || error.message });
        return this.store.getRun(run.id);
      })
      .finally(() => {
        this.active.delete(run.id);
        setTimeout(() => this.recentCompletions.delete(run.id), 10 * 60_000).unref();
      });
    entry.promise = promise;
    this.recentCompletions.set(run.id, promise);
    return run;
  }

  async waitForRun(runId) {
    const promise = this.active.get(runId)?.promise || this.recentCompletions.get(runId);
    return promise ? promise : this.store.getRun(runId);
  }

  cancel(runId) {
    const entry = this.active.get(runId);
    if (!entry) return { runId, cancelled: false, reason: 'not-active' };
    entry.controller.abort(new Error('Cancelled by user or parent agent'));
    this.eventBus.emit('run.cancelling', { runId }, { runId, sessionId: entry.sessionId, workspaceId: entry.workspaceId });
    return { runId, cancelled: true };
  }

  listActiveRuns() {
    return [...this.active.values()].map((entry) => ({
      ...this.store.getRun(entry.runId),
      live: true,
      elapsedMs: Date.now() - entry.startedAt,
      capabilities: entry.capabilityState ? this.capabilityController.snapshot(entry.capabilityState) : null,
      plan: entry.planState,
    }));
  }

  getRunState(runId) {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const entry = this.active.get(runId);
    return {
      ...run,
      live: Boolean(entry),
      elapsedMs: entry ? Date.now() - entry.startedAt : null,
      capabilities: entry?.capabilityState ? this.capabilityController.snapshot(entry.capabilityState) : run.meta?.capabilities || null,
      plan: entry?.planState || run.meta?.plan || null,
      events: this.store.listRunEvents(runId, 2000),
    };
  }

  async delegate(args, parentContext) {
    const parent = this.store.getRun(parentContext.runId);
    const depth = Number(parent?.meta?.depth || 0) + 1;
    if (depth > this.config.get().maxSubagentDepth) throw new Error(`Subagent depth ${depth} exceeds configured maximum`);
    let workspaceId = parentContext.workspaceId;
    let isolation = null;
    if (args.isolated) {
      isolation = await this.workspaceManager.createWorktree(workspaceId, {
        name: args.name || `subagent-${Date.now()}`,
        branch: args.name ? `maskshift/${args.name.replace(/[^a-zA-Z0-9._-]/g, '-')}` : undefined,
      });
      workspaceId = isolation.workspace.id;
    }
    const task = [
      `You are a delegated MaskShift subagent. Focus only on this task:\n\n${args.task}`,
      args.mode === 'edit' ? 'Implement and verify the requested changes.' : 'Inspect, reason, and report findings. Do not modify files unless necessary to verify.',
      `Parent run: ${parentContext.runId}`,
    ].join('\n\n');
    const session = this.createSession({ workspaceId, title: `Subagent: ${titleFromPrompt(args.task)}`, modelRef: args.model || parent?.model_id });
    const run = await this.startRun({
      sessionId: session.id, workspaceId, prompt: task, modelRef: args.model || parent?.model_id,
      options: { parentRunId: parentContext.runId, depth, source: 'subagent', isolated: Boolean(args.isolated), skipCheckpoint: Boolean(args.isolated) },
    });
    this.eventBus.emit('subagent.started', { childRunId: run.id, task: args.task, isolated: Boolean(args.isolated) }, parentContext.scope);
    const completed = await this.waitForRun(run.id);
    const messages = this.store.listMessages(session.id, 500);
    const final = [...messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content || '';
    let diff = null;
    if (isolation) {
      const result = await runCommand('git diff --stat && git diff', { cwd: isolation.path, timeoutMs: 60_000, maxOutputChars: 160_000 });
      diff = result.stdout;
    }
    const response = {
      task: args.task, runId: run.id, sessionId: session.id, status: completed?.status,
      final: truncate(final, 80_000), isolation: isolation ? { path: isolation.path, branch: isolation.branch, workspaceId } : null,
      diff: truncate(diff || '', 100_000), error: completed?.error || null,
    };
    this.eventBus.emit('subagent.completed', response, parentContext.scope);
    return response;
  }

  async #execute(run, session, entry) {
    const signal = entry.controller.signal;
    const scope = { runId: run.id, sessionId: session.id, workspaceId: run.workspace_id };
    const workspacePath = run.workspace_id ? this.workspaceManager.get(run.workspace_id).path : process.cwd();
    entry.status = 'running';
    this.store.updateRun(run.id, { status: 'running' });
    this.store.updateSession(session.id, { status: 'running', model_id: run.model_id });
    this.#event(run.id, 'started', { model: run.model_id, workspacePath, parentRunId: run.meta?.parentRunId }, scope);

    try {
      await this.hooks?.run('SessionStart', { ...scope, workspacePath, prompt: run.prompt });
      await this.hooks?.run('UserPromptSubmit', { ...scope, workspacePath, prompt: run.prompt });
      let checkpoint = null;
      if (run.workspace_id && this.config.get().autoCheckpoint && !entry.options.skipCheckpoint) {
        try {
          checkpoint = await this.workspaceManager.createCheckpoint(run.workspace_id, { runId: run.id, label: `before ${titleFromPrompt(run.prompt)}` });
          this.#event(run.id, 'checkpoint', checkpoint, scope);
        } catch (error) {
          this.logger.warn('Automatic checkpoint failed', { runId: run.id, error: error.message });
          this.#event(run.id, 'warning', { message: `Checkpoint failed: ${error.message}` }, scope);
        }
      }

      const workspaceContext = await this.contextBuilder.build({ workspaceId: run.workspace_id, prompt: run.prompt, sessionId: session.id });
      const capabilityState = this.capabilityController.createState({ runId: run.id, workspaceId: run.workspace_id });
      entry.capabilityState = capabilityState;
      await this.capabilityController.autoPrime(capabilityState, run.prompt);

      const history = this.store.listMessages(session.id, 240).map(messageForProvider);
      const maxSteps = entry.options.maxSteps || this.config.get().maxAgentSteps;
      let finalContent = '';
      let step = 0;
      let usage = [];
      let costs = [];

      while (step < maxSteps) {
        if (signal.aborted) throw signal.reason || new Error('Run cancelled');
        step += 1;
        this.store.updateRun(run.id, { step_count: step });
        const currentRun = this.store.getRun(run.id);
        const currentSession = this.store.getSession(session.id);
        const system = this.promptBuilder.system({ workspaceContext, capabilityState, planState: entry.planState, run: currentRun, session: currentSession });
        const tools = await this.capabilityController.descriptors(capabilityState);
        this.#event(run.id, 'model-turn', { step, tools: tools.map((tool) => tool.name), skillCount: capabilityState.skills.size }, scope);
        const response = await this.providerManager.complete({
          modelRef: currentRun.model_id,
          messages: [{ role: 'system', content: system.text, blocks: system.blocks }, ...history],
          tools,
          signal,
          temperature: entry.options.temperature ?? 0.1,
          maxTokens: entry.options.maxTokens || 16_384,
        });
        usage.push(response.usage);
        costs.push(estimateUsageCost(this.config.get(), response.providerId, response.providerType, response.model, response.usage));
        const assistantMessage = {
          role: 'assistant', content: response.content || '', toolCalls: response.toolCalls || [],
        };
        history.push(assistantMessage);
        this.store.addMessage({
          sessionId: session.id, role: 'assistant', content: response.content || '',
          meta: { runId: run.id, modelRef: response.modelRef, toolCalls: response.toolCalls || [], finishReason: response.finishReason, usage: response.usage },
        });
        this.#event(run.id, 'assistant', { content: response.content || '', toolCalls: response.toolCalls || [], modelRef: response.modelRef, usage: response.usage }, scope);
        if (response.content) finalContent = response.content;

        if (!response.toolCalls?.length) {
          const meta = {
            ...currentRun.meta, checkpointId: checkpoint?.id || null,
            capabilities: this.capabilityController.snapshot(capabilityState), plan: entry.planState,
            usage, costEstimate: summarizeCosts(costs),
          };
          const completed = this.store.updateRun(run.id, { status: 'completed', ended_at: nowIso(), meta });
          this.store.updateSession(session.id, { status: 'idle', model_id: response.modelRef || currentRun.model_id });
          this.#event(run.id, 'completed', { final: finalContent, steps: step, capabilities: meta.capabilities }, scope);
          await this.hooks?.run('Stop', { ...scope, workspacePath, status: 'completed', final: finalContent });
          await this.hooks?.run('RunCompleted', { ...scope, workspacePath, status: 'completed', final: finalContent });
          if (run.workspace_id && this.config.get().autoIndex) void this.indexer.index(run.workspace_id, { force: true }).catch(() => {});
          return completed;
        }

        const results = await this.#executeToolCalls(response.toolCalls, {
          run, session, entry, workspacePath, signal, scope, capabilityState,
        });
        for (const result of results) {
          const toolMessage = {
            role: 'tool', toolCallId: result.call.id, toolName: result.call.name,
            content: result.content, isError: result.isError,
          };
          history.push(toolMessage);
          this.store.addMessage({
            sessionId: session.id, role: 'tool', content: result.content,
            meta: { runId: run.id, toolCallId: result.call.id, toolName: result.call.name, isError: result.isError },
          });
          this.#event(run.id, result.isError ? 'tool-error' : 'tool-result', {
            toolCallId: result.call.id, tool: result.call.name, content: result.content,
          }, scope);
        }
      }

      const message = `Run reached the configured maximum of ${maxSteps} model turns.`;
      if (!finalContent) {
        finalContent = message;
        this.store.addMessage({ sessionId: session.id, role: 'assistant', content: message, meta: { runId: run.id, synthetic: true } });
      }
      const current = this.store.getRun(run.id);
      const completed = this.store.updateRun(run.id, {
        status: 'max_steps', ended_at: nowIso(), error: message,
        meta: { ...current.meta, capabilities: this.capabilityController.snapshot(capabilityState), plan: entry.planState, usage, costEstimate: summarizeCosts(costs) },
      });
      this.store.updateSession(session.id, { status: 'idle' });
      this.#event(run.id, 'max-steps', { message, final: finalContent }, scope);
      await this.hooks?.run('Stop', { ...scope, workspacePath, status: 'max_steps', final: finalContent });
      return completed;
    } catch (error) {
      const cancelled = isAbort(error, signal);
      const status = cancelled ? 'cancelled' : 'failed';
      const current = this.store.getRun(run.id);
      const failed = this.store.updateRun(run.id, {
        status, ended_at: nowIso(), error: error.message,
        meta: { ...current?.meta, capabilities: entry.capabilityState ? this.capabilityController.snapshot(entry.capabilityState) : null, plan: entry.planState },
      });
      this.store.updateSession(session.id, { status: 'idle' });
      this.#event(run.id, status, { error: error.message, stack: this.config.get().permissionMode === 'overdrive' ? error.stack : undefined }, scope);
      await this.hooks?.run('Stop', { ...scope, workspacePath, status, error: error.message }).catch(() => {});
      return failed;
    }
  }

  async #executeToolCalls(calls, context) {
    const allReadOnly = calls.every((call) => {
      const descriptor = this.toolRegistry.descriptor(call.name);
      return descriptor?.readOnly === true;
    });
    if (allReadOnly && calls.length > 1) return Promise.all(calls.map((call) => this.#executeToolCall(call, context)));
    const results = [];
    for (const call of calls) results.push(await this.#executeToolCall(call, context));
    return results;
  }

  async #executeToolCall(call, context) {
    const { run, session, entry, workspacePath, signal, scope, capabilityState } = context;
    const toolContext = {
      runId: run.id, sessionId: session.id, workspaceId: run.workspace_id, workspacePath,
      signal, scope, eventBus: this.eventBus, store: this.store,
      capabilityState, planState: entry.planState, engine: this,
    };
    try {
      let value;
      if (this.toolRegistry.has(call.name)) value = await this.toolRegistry.execute(call.name, call.args || {}, toolContext);
      else if (call.name.startsWith('mcp__')) value = await this.mcpManager.callQualified(call.name, call.args || {}, { workspaceId: run.workspace_id, signal });
      else throw new Error(`Tool '${call.name}' is not active or does not exist. Search and activate the capability first.`);
      return { call, content: renderToolResult(value, this.config.get().maxToolOutputChars), isError: false };
    } catch (error) {
      return { call, content: renderToolResult({ error: error.message, tool: call.name }, this.config.get().maxToolOutputChars), isError: true };
    }
  }

  #event(runId, type, payload, scope) {
    this.store.addRunEvent(runId, type, payload);
    this.eventBus.emit(`run.${type}`, payload, scope);
  }

  async close() {
    for (const runId of this.active.keys()) this.cancel(runId);
    await Promise.allSettled([...this.recentCompletions.values()]);
  }
}
