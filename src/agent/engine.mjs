import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, runCommand, sha256, truncate } from '../core/utils.mjs';
import { estimateUsageCost, summarizeCosts } from '../core/pricing.mjs';
import { repairPrompt } from './tool-protocol.mjs';
import { elideStaleToolResults, estimateHistoryTokens, fitHistory, groupTurns, historyBudget } from './context-budget.mjs';
import { compactTurns } from './compaction.mjs';
import { shapeObservation } from './observation.mjs';
import { EditFeedback, EDIT_TOOLS } from './feedback.mjs';
import { CapabilityRegistry } from './capability-profile.mjs';
import { missingArgumentMessage, missingRequired, normalizeArgs, resolveToolName, unknownToolMessage } from './call-repair.mjs';
import {
  PROGRESS_FILE, StagnationDetector, fallbackSummary, guardrailSettings, handoffMessage, renderProgress,
  runVerification, stagnationNudge, verificationFeedback, verificationSummary, writeProgressFile,
} from './guardrails.mjs';

// Bounded (by the model's scaffolding level) so a model that cannot produce valid syntax ends the
// run instead of looping on it.

function titleFromPrompt(prompt) {
  return String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 78) || 'MaskShift run';
}

// Upper bound on messages read back per run. Far above any real session; it only exists so a
// pathological one cannot load unbounded rows into memory.
const HISTORY_LOAD_LIMIT = 20_000;

function messageForProvider(message) {
  const meta = message.meta || {};
  return {
    role: message.role,
    content: truncate(message.content || '', 180_000),
    ...(meta.toolCalls ? { toolCalls: meta.toolCalls } : {}),
    ...(meta.providerState ? { providerState: meta.providerState } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId, toolName: meta.toolName, isError: meta.isError } : {}),
  };
}

// A small model's window cannot afford ~30 tool schemas on every turn (measured: they alone can
// fill an 8k window), and it also chooses better from a short list. It gets a core set for
// reading, editing, searching and running code, plus anything it explicitly activates through
// capability_search/capability_activate — so the whole catalog stays reachable, just on demand.
const SMALL_MODEL_CORE_TOOLS = new Set([
  'fs_list', 'fs_read', 'fs_write', 'fs_patch', 'search_text', 'shell_exec',
  'git_status', 'git_diff', 'plan_update', 'capability_search', 'capability_activate',
]);

function compactToolsFor(knobs, tools, capabilityState) {
  if (!knobs?.coreTools) return tools;
  const activated = new Set((capabilityState?.activated || []).map((item) => item.name));
  return tools.filter((tool) => SMALL_MODEL_CORE_TOOLS.has(tool.name) || activated.has(tool.name)).map((tool) => {
    const schema = tool.inputSchema || {};
    const properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => {
      const { description, ...rest } = value || {};
      return [key, description ? { ...rest, description: truncate(String(description), 60) } : rest];
    }));
    return { ...tool, description: truncate(String(tool.description || ''), 140), inputSchema: { ...schema, properties } };
  });
}

function renderToolResult(value, maxChars) {
  if (typeof value === 'string') return truncate(value, maxChars);
  try { return truncate(JSON.stringify(value, null, 2), maxChars); } catch { return truncate(String(value), maxChars); }
}

function tagCost(entry, source) {
  return entry ? { ...entry, source } : entry;
}

function withNotes(content, notes) {
  return notes.length ? `${content}\n\n[Harness] ${notes.join(' ')}` : content;
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || /aborted|cancelled/i.test(error?.message || '');
}

export class AgentEngine {
  constructor({
    store, config, logger, eventBus, hooks, providerManager, workspaceManager,
    indexer, toolRegistry, capabilityController, promptBuilder, contextBuilder, mcpManager, intelligenceRouter, personaManager, lspManager = null,
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
    this.intelligenceRouter = intelligenceRouter;
    this.personaManager = personaManager;
    this.feedback = new EditFeedback({ config, lspManager, logger });
    this.capabilities = new CapabilityRegistry({ store });
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

    // A session processes one run at a time; a fresh session (the common subagent case, which
    // always creates its own) never collides here.
    const collision = [...this.active.values()].find((entry) => entry.sessionId === session.id);
    if (collision) throw new Error(`Session ${session.id} already has an active run (${collision.runId}); wait for it to finish or cancel it first`);

    let selectedModel = modelRef || session.model_id || this.config.get().defaultModel;
    let route = null;
    if (selectedModel === 'router:auto' || (this.config.get().routing?.autoSelect && !modelRef)) {
      route = this.intelligenceRouter.routeModel(prompt, { workspaceId, fallback: this.config.get().defaultModel });
      selectedModel = route.selected;
    }
    this.store.addMessage({ sessionId: session.id, role: 'user', content: String(prompt), meta: { source: options.source || 'user', parentRunId: options.parentRunId || null } });
    const run = this.store.createRun({
      sessionId: session.id, workspaceId, prompt: String(prompt), modelId: selectedModel,
      meta: { parentRunId: options.parentRunId || null, depth: options.depth || 0, source: options.source || 'user', isolated: Boolean(options.isolated), route },
    });
    const controller = new AbortController();
    const entry = {
      runId: run.id, sessionId: session.id, workspaceId, controller,
      status: 'queued', startedAt: Date.now(), capabilityState: null,
      planState: { summary: '', steps: [], updatedAt: nowIso() },
      options,
      // Operator messages sent while the run is working; delivered at the next step.
      steering: [],
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
    // Cancelling a parent must reach its delegated subagents too, or they keep running (and
    // spending budget) unsupervised after the run that requested them has already stopped.
    for (const child of this.active.values()) if (child.options?.parentRunId === runId) this.cancel(child.runId);
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

  #unresolvedIntents(runId) {
    const events = this.store.listRunEvents(runId, 5000);
    const resolved = new Set(events.filter((event) => event.type === 'tool-result' || event.type === 'tool-error').map((event) => event.payload?.toolCallId));
    return events.filter((event) => event.type === 'tool-intent' && !resolved.has(event.payload?.toolCallId)).map((event) => event.payload);
  }

  /** True when a pid is neither this process nor confirmed alive. Not a distributed lease: a
   *  reused OS pid can produce a false "alive", which is why reconcile() is still a manual step. */
  #ownerGone(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    if (pid === process.pid) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }

  /**
   * Runs left marked "running" whose owning process is gone — most likely a crash or a killed
   * host process, not this process's own in-flight work. Each includes any tool-call intents
   * that were recorded but never got a matching tool-result/tool-error, i.e. effects that may or
   * may not have actually happened and were never confirmed either way.
   */
  recoverableRuns() {
    return this.store.listRuns({ limit: 500 })
      .filter((run) => run.status === 'running' && !this.active.has(run.id) && this.#ownerGone(run.meta?.ownerPid))
      .map((run) => ({ ...run, pendingIntents: this.#unresolvedIntents(run.id) }));
  }

  /**
   * Records that a stale "running" run has been manually inspected, and moves it to a terminal
   * "interrupted" status. This never executes or replays anything — it only updates the journal
   * so the run stops showing as unresolved. Refuses a run that is still active in this process,
   * or whose owning process might still be alive.
   */
  reconcile(runId, note) {
    if (!String(note || '').trim()) throw new Error('A reconciliation note describing what was inspected and repaired is required');
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (this.active.has(runId)) throw new Error(`Run ${runId} is still active in this process; cancel it instead of reconciling`);
    if (run.status !== 'running') throw new Error(`Run ${runId} is not in an interrupted state (status: ${run.status})`);
    if (!this.#ownerGone(run.meta?.ownerPid)) throw new Error(`Run ${runId}'s owning process (pid ${run.meta.ownerPid}) may still be alive; refusing to reconcile`);
    const updated = this.store.updateRun(runId, {
      status: 'interrupted', ended_at: nowIso(), error: run.error || 'Process ended without completing this run',
      meta: { ...run.meta, recovery: { reviewedAt: nowIso(), note: String(note) } },
    });
    this.store.updateSession(run.session_id, { status: 'idle' });
    this.#event(runId, 'reconciled', { note }, { runId, sessionId: run.session_id, workspaceId: run.workspace_id });
    return updated;
  }

  /**
   * Summarizes a session's older turns now (the TUI's /compact), keeping the most recent ones
   * verbatim. Later runs send the summary in place of the turns it covers.
   */
  async compactSession(sessionId, { modelRef = null, keepRecentTurns = 2, signal } = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if ([...this.active.values()].some((entry) => entry.sessionId === sessionId && !['completed', 'failed', 'cancelled'].includes(entry.status))) {
      throw new Error('Wait for the running heist to finish before compacting it');
    }
    const saved = session.meta?.compaction || {};
    const rows = this.store.listMessages(sessionId, HISTORY_LOAD_LIMIT);
    const start = saved.throughMessageId ? rows.findIndex((row) => row.id === saved.throughMessageId) + 1 : 0;
    const ids = new WeakMap();
    const pending = rows.slice(start).map((row) => { const message = messageForProvider(row); ids.set(message, row.id); return message; });
    const turns = groupTurns(pending);
    if (turns.length <= keepRecentTurns) return { compacted: false, turns: 0, reason: 'Nothing old enough to summarize yet' };
    const toSummarize = turns.slice(0, turns.length - keepRecentTurns);
    const model = modelRef || session.model_id;
    const profile = await this.providerManager.modelProfile(model).catch(() => null);
    const result = await compactTurns(this.providerManager, {
      modelRef: model, newlyDropped: toSummarize, previousSummary: saved.summary || null, signal,
      maxSummaryTokens: Math.max(400, Math.min(2_000, Math.floor((profile?.contextWindow || 32_768) * 0.03))),
    });
    if (!result.usage || !result.summary) throw new Error('The model could not produce a summary; try again or switch models');
    const compaction = { summary: result.summary, throughMessageId: ids.get(toSummarize.at(-1).at(-1)), forced: true, updatedAt: nowIso() };
    this.store.updateSession(sessionId, { meta: { ...(session.meta || {}), compaction } });
    this.eventBus.emit('session.compacted', { sessionId, turns: toSummarize.length }, { sessionId });
    return { compacted: true, turns: toSummarize.length, summary: result.summary };
  }

  /**
   * Adds an operator message to a run that is still working. It reaches the model at the next
   * step boundary — after any tool call already in flight — instead of waiting for the run to
   * finish the way a queued prompt does.
   */
  steer(runId, text) {
    const entry = this.active.get(runId);
    const message = String(text || '').trim();
    if (!entry || !message || ['completed', 'failed', 'cancelled'].includes(entry.status)) return { accepted: false };
    entry.steering.push(message);
    this.#event(runId, 'steer-queued', { message, pending: entry.steering.length }, { runId, sessionId: entry.sessionId, workspaceId: entry.workspaceId });
    return { accepted: true, pending: entry.steering.length };
  }

  async delegate(args, parentContext) {
    const parent = this.store.getRun(parentContext.runId);
    const depth = Number(parent?.meta?.depth || 0) + 1;
    if (depth > this.config.get().maxSubagentDepth) throw new Error(`Subagent depth ${depth} exceeds configured maximum`);
    const siblings = [...this.active.values()].filter((entry) => entry.options?.parentRunId === parentContext.runId).length;
    const maxParallel = this.config.get().maxParallelSubagents;
    if (siblings >= maxParallel) throw new Error(`This run already has ${siblings} active subagent(s), at the configured maximum of ${maxParallel}`);
    let workspaceId = args.workspaceId || parentContext.workspaceId;
    let isolation = null;
    if (args.isolated) {
      isolation = await this.workspaceManager.createWorktree(workspaceId, {
        name: args.name || `subagent-${Date.now()}`,
        branch: args.name ? `maskshift/${args.name.replace(/[^a-zA-Z0-9._-]/g, '-')}` : undefined,
      });
      workspaceId = isolation.workspace.id;
    }
    const persona = args.persona ? await this.personaManager?.load(args.persona).catch(() => null) : null;
    const task = [
      persona ? persona.body : `You are a delegated MaskShift subagent. Focus only on this task:`,
      persona ? `Your task:\n\n${args.task}` : args.task,
      args.mode === 'edit' ? 'Implement and verify the requested changes.' : 'Inspect, reason, and report findings. Do not modify files unless necessary to verify.',
      `Parent run: ${parentContext.runId}`,
    ].join('\n\n');
    const session = this.createSession({
      workspaceId, title: `${persona ? `${persona.name}: ` : 'Subagent: '}${titleFromPrompt(args.task)}`,
      modelRef: args.model || persona?.model || parent?.model_id,
    });
    const run = await this.startRun({
      sessionId: session.id, workspaceId, prompt: task, modelRef: args.model || persona?.model || parent?.model_id,
      options: { parentRunId: parentContext.runId, depth, source: 'subagent', isolated: Boolean(args.isolated), skipCheckpoint: Boolean(args.isolated) },
    });
    this.eventBus.emit('subagent.started', { childRunId: run.id, task: args.task, persona: persona?.name || null, isolated: Boolean(args.isolated) }, parentContext.scope);
    const completed = await this.waitForRun(run.id);
    const messages = this.store.listMessages(session.id, 500);
    const final = [...messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content || '';
    let diff = null;
    if (isolation) {
      const result = await runCommand('git diff --stat && git diff', { cwd: isolation.path, timeoutMs: 60_000, maxOutputChars: 160_000 });
      diff = result.stdout;
    }
    const response = {
      task: args.task, runId: run.id, sessionId: session.id, workspaceId, status: completed?.status,
      persona: persona?.name || null,
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
    // Recorded so a later process (after a crash/restart) can tell whether a run left marked
    // "running" belonged to a process that is actually gone, rather than guessing or replaying it.
    this.store.updateRun(run.id, { status: 'running', meta: { ...run.meta, ownerPid: process.pid } });
    this.store.updateSession(session.id, { status: 'running', model_id: run.model_id });
    this.#event(run.id, 'started', { model: run.model_id, workspacePath, parentRunId: run.meta?.parentRunId }, scope);

    const deadlineMs = Math.max(1000, Number(this.config.get().maxRunDurationMs) || 8 * 60 * 60 * 1000);
    const deadlineTimer = setTimeout(
      () => entry.controller.abort(Object.assign(new Error(`Run exceeded its configured ${deadlineMs} ms wall-clock deadline`), { code: 'RUN_DEADLINE_EXCEEDED' })),
      deadlineMs,
    );
    deadlineTimer.unref?.();
    let sessionEndOutcome = null;

    let scaffoldRef = null;
    let scaffoldController = null;
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

      // Everything below is sized to the model actually running: its window bounds the injected
      // repository context, its tier picks the prompt's verbosity, its output cap bounds replies.
      let modelProfile = await this.providerManager.modelProfile(run.model_id).catch(() => null);
      // How much help this model gets: measured, else observed, else a prior from its size; and it
      // can rise during the run if the model keeps stumbling.
      const scaffold = this.capabilities.begin(modelProfile?.ref || run.model_id, modelProfile, {
        onChange: (change) => this.#event(run.id, 'scaffold-level', change, scope),
      });
      entry.scaffold = scaffold;
      scaffoldRef = modelProfile?.ref || run.model_id;
      scaffoldController = scaffold;
      this.#event(run.id, 'scaffold', { level: scaffold.level, source: scaffold.source }, scope);
      // Share of the window (in ~4-char tokens) spent on injected repository context. A small
      // model keeps more of its window for the conversation itself.
      const contextCharsFor = (profile) => (profile
        ? Math.min(this.config.get().maxContextChars, Math.floor(profile.contextWindow * 4 * (scaffold.knobs.compactPrompt ? 0.2 : 0.35)))
        : undefined);
      let workspaceContext = await this.contextBuilder.build({ workspaceId: run.workspace_id, prompt: run.prompt, sessionId: session.id, maxChars: contextCharsFor(modelProfile) });
      const capabilityState = this.capabilityController.createState({ runId: run.id, workspaceId: run.workspace_id });
      entry.capabilityState = capabilityState;
      await this.capabilityController.autoPrime(capabilityState, run.prompt);

      // The whole session, not a recent slice: fitHistory and compaction decide what fits, so
      // nothing older silently disappears without being summarized first.
      const messageIds = new WeakMap();
      const positions = new Map();
      const history = [];
      const remember = (message, stored) => {
        history.push(message);
        if (stored?.id) { messageIds.set(message, stored.id); positions.set(stored.id, history.length - 1); }
      };
      const savedCompaction = this.store.getSession(session.id)?.meta?.compaction || {};
      const rows = this.store.listMessages(session.id, HISTORY_LOAD_LIMIT);
      // A summary the operator asked for (/compact) replaces the turns it covers outright, even
      // when they would still fit; an automatic one only stands in for turns that do not.
      const forcedCut = savedCompaction.forced && savedCompaction.throughMessageId
        ? rows.findIndex((row) => row.id === savedCompaction.throughMessageId)
        : -1;
      for (const row of rows.slice(forcedCut + 1)) remember(messageForProvider(row), row);
      const maxSteps = entry.options.maxSteps || this.config.get().maxAgentSteps;
      let finalContent = '';
      let step = 0;
      let usage = [];
      let costs = [];
      let repairAttempts = 0;
      // Persists across this run's turns: once some of the oldest turns have been folded into a
      // summary, later turns extend that same summary with only what's newly been dropped since,
      // rather than re-summarizing the whole drop set from scratch every time it grows.
      // Saved on the session, so the next prompt in a long session starts from this summary
      // instead of losing it when the run ends.
      const compaction = {
        summary: savedCompaction.summary || null,
        throughMessageId: savedCompaction.throughMessageId || null,
        forced: Boolean(savedCompaction.forced && forcedCut >= 0),
        lastFailedStep: -Infinity,
      };
      let overflowRetries = 0;

      // Harness guardrails: none of these trust the model's own sense of progress.
      const guardrails = guardrailSettings(this.config.get());
      const detector = new StagnationDetector(guardrails.stagnation);
      let stagnated = null;
      let verificationAttempts = 0;
      let lastVerification = null;
      let unverifiedChanges = false;
      let contextResets = 0;
      // What caused the next model call: an ordinary turn, or one the harness's own correction forced.
      let turnSource = 'turn';

      // Replaces the whole conversation with a compact hand-off, written to disk as well so the
      // state survives a crash and is inspectable. Compaction folds old turns into a summary but
      // keeps the rest; this is the full reset for runs that outlive even that.
      const resetContext = async () => {
        const turns = groupTurns(history);
        const compacted = await compactTurns(this.providerManager, {
          modelRef: this.store.getRun(run.id).model_id, newlyDropped: turns, previousSummary: compaction.summary, signal,
          maxSummaryTokens: 1_500,
        });
        if (compacted.usage) {
          usage.push(compacted.usage);
          costs.push(tagCost(estimateUsageCost(this.config.get(), compacted.providerId, compacted.providerType, compacted.model, compacted.usage), 'handoff'));
        }
        const tree = await runCommand('git status --short', { cwd: workspacePath, timeoutMs: 15_000, maxOutputChars: 6_000 }).catch(() => null);
        contextResets += 1;
        const progress = renderProgress({
          runId: run.id, prompt: run.prompt, planState: entry.planState,
          summary: compacted.usage ? compacted.summary : fallbackSummary(history),
          verification: lastVerification ? verificationSummary(lastVerification) : null,
          workingTree: tree?.code === 0 ? tree.stdout.trim() : '',
          resets: contextResets,
        });
        let file = PROGRESS_FILE;
        try { file = path.relative(workspacePath, await writeProgressFile(workspacePath, progress)) || PROGRESS_FILE; } catch (error) {
          this.logger.warn('Could not write progress file', { runId: run.id, error: error.message });
        }
        const content = handoffMessage({ prompt: run.prompt, progress, file });
        history.length = 0;
        positions.clear();
        compaction.summary = null;
        compaction.throughMessageId = null;
        compaction.forced = false;
        detector.reset();
        remember({ role: 'user', content }, this.store.addMessage({
          sessionId: session.id, role: 'user', content, meta: { runId: run.id, synthetic: true, handoff: contextResets },
        }));
        this.#event(run.id, 'context-reset', { resets: contextResets, file, summarized: Boolean(compacted.usage) }, scope);
      };

      while (step < maxSteps) {
        if (signal.aborted) throw signal.reason || new Error('Run cancelled');
        while (entry.steering.length) {
          const text = entry.steering.shift();
          remember({ role: 'user', content: text }, this.store.addMessage({
            sessionId: session.id, role: 'user', content: text, meta: { runId: run.id, source: 'steer' },
          }));
          this.#event(run.id, 'steered', { message: text }, scope);
        }
        step += 1;
        this.store.updateRun(run.id, { step_count: step });
        const currentRun = this.store.getRun(run.id);
        const currentSession = this.store.getSession(session.id);
        const system = this.promptBuilder.system({ workspaceContext, capabilityState, planState: entry.planState, run: currentRun, session: currentSession, modelProfile, knobs: scaffold.knobs });
        const tools = compactToolsFor(scaffold.knobs, await this.capabilityController.descriptors(capabilityState), capabilityState);
        this.#event(run.id, 'model-turn', { step, tools: tools.map((tool) => tool.name), skillCount: capabilityState.skills.size }, scope);
        const maxTokens = entry.options.maxTokens || modelProfile?.maxOutputTokens || 16_384;
        let outboundHistory = history;
        const contextTokens = await this.providerManager.contextWindowFor(currentRun.model_id).catch(() => modelProfile?.contextWindow || null);
        if (contextTokens) {
          const sizes = {
            contextTokens,
            outputTokens: maxTokens,
            systemTokens: Math.ceil(Buffer.byteLength(system.text, 'utf8') / 4),
            toolTokens: Math.ceil(Buffer.byteLength(JSON.stringify(tools), 'utf8') / 4),
          };
          // Past this share of the budget a long run is handed off to a fresh context rather than
          // left to be summarized turn by turn.
          if (guardrails.handoff.enabled && contextResets < guardrails.handoff.maxResets && step > 1
            && estimateHistoryTokens(history) > historyBudget(sizes) * guardrails.handoff.thresholdRatio) {
            await resetContext();
          }
          // Old tool output is the cheapest thing to give up: shrink it before dropping turns.
          const candidate = estimateHistoryTokens(history) > historyBudget(sizes) * 0.5
            ? elideStaleToolResults(history, { onReplace: (original, replacement) => messageIds.set(replacement, messageIds.get(original)) })
            : history;
          const fitted = fitHistory({ history: candidate, ...sizes });
          outboundHistory = fitted.history;
          if (fitted.omitted) {
            this.#event(run.id, 'context-trimmed', { omittedTurns: fitted.omitted, contextTokens }, scope);
            const positionOf = (turn) => positions.get(messageIds.get(turn.at(-1))) ?? -1;
            const coveredThrough = compaction.throughMessageId ? (positions.get(compaction.throughMessageId) ?? -1) : -1;
            const newlyDropped = fitted.droppedTurns.filter((turn) => positionOf(turn) > coveredThrough);
            if (newlyDropped.length && step - compaction.lastFailedStep >= 5) {
              await this.hooks?.run('PreCompact', { ...scope, workspacePath, omittedTurns: fitted.omitted, droppedTurns: newlyDropped, previousSummary: compaction.summary });
              const compacted = await compactTurns(this.providerManager, {
                modelRef: currentRun.model_id, newlyDropped, previousSummary: compaction.summary, signal,
                maxSummaryTokens: Math.max(400, Math.min(2_000, Math.floor(contextTokens * 0.03))),
              });
              if (compacted.usage) {
                compaction.summary = compacted.summary;
                compaction.throughMessageId = messageIds.get(newlyDropped.at(-1).at(-1)) || compaction.throughMessageId;
                const sessionMeta = this.store.getSession(session.id)?.meta || {};
                this.store.updateSession(session.id, {
                  meta: { ...sessionMeta, compaction: { summary: compaction.summary, throughMessageId: compaction.throughMessageId, forced: compaction.forced, updatedAt: nowIso() } },
                });
                usage.push(compacted.usage);
                costs.push(tagCost(estimateUsageCost(this.config.get(), compacted.providerId, compacted.providerType, compacted.model, compacted.usage), 'compaction'));
              } else {
                compaction.lastFailedStep = step;
              }
              this.#event(run.id, 'context-compacted', { omittedTurns: fitted.omitted, summarized: Boolean(compacted.usage) }, scope);
            }
            // fitted.history[0] is fitHistory's own generic "(N turns omitted)" placeholder —
            // replaced with the real summary when there is one, so the model keeps the concrete
            // facts from those turns instead of just being told they existed.
            if (compaction.summary) {
              outboundHistory = [
                { role: 'user', content: `[Summary of ${fitted.omitted} earlier turn${fitted.omitted === 1 ? '' : 's'}, dropped to fit this model's context window]\n\n${compaction.summary}` },
                ...fitted.history.slice(1),
              ];
            }
          } else if (compaction.forced && compaction.summary) {
            outboundHistory = [{ role: 'user', content: `[Summary of this session's earlier turns]\n\n${compaction.summary}` }, ...fitted.history];
          }
        }
        // Throttled rather than forwarded 1:1: a fast provider can emit dozens of fragments a
        // second, and every one of those would otherwise (a) push into the event bus's shared,
        // bounded history ring — crowding out everything else recorded around the same time —
        // and (b) ask every listener (TUI, any SSE client) to do work for a change too small to
        // see. The full, untruncated text still always reaches the transcript: it's `response`'s
        // own return value below, persisted as the `assistant` message regardless of how many
        // deltas were dropped here.
        let lastDeltaEmitAt = 0;
        let response;
        try {
          response = await this.providerManager.complete({
            modelRef: currentRun.model_id,
            messages: [{ role: 'system', content: system.text, blocks: system.blocks }, ...outboundHistory],
            tools,
            signal,
            temperature: entry.options.temperature ?? 0.1,
            maxTokens,
            onDelta: (content) => {
              const now = Date.now();
              if (now - lastDeltaEmitAt < 60) return;
              lastDeltaEmitAt = now;
              this.eventBus.emit('run.assistant-delta', { step, content }, scope);
            },
          });
        } catch (error) {
          // The provider says the request did not fit. Learn the real limit, resize everything
          // to it, and retry this same turn rather than failing a long session outright.
          const overflow = signal.aborted ? null : this.providerManager.isContextOverflow?.(error);
          if (!overflow || overflowRetries >= 2) throw error;
          overflowRetries += 1;
          const previous = contextTokens;
          modelProfile = await this.providerManager.learnContextWindow(currentRun.model_id, overflow.limit);
          workspaceContext = await this.contextBuilder.build({ workspaceId: run.workspace_id, prompt: run.prompt, sessionId: session.id, maxChars: contextCharsFor(modelProfile) });
          this.#event(run.id, 'context-window-learned', { previous, next: modelProfile.contextWindow, stated: overflow.limit }, scope);
          step -= 1;
          continue;
        }
        overflowRetries = 0;
        usage.push(response.usage);
        costs.push(tagCost(estimateUsageCost(this.config.get(), response.providerId, response.providerType, response.model, response.usage), turnSource));
        turnSource = 'turn';
        const maxRunTokens = Number(this.config.get().maxRunTokens) || 5_000_000;
        const tokensSoFar = summarizeCosts(costs);
        if (tokensSoFar.inputTokens + tokensSoFar.outputTokens > maxRunTokens) {
          throw Object.assign(new Error(`Run exceeded its configured ${maxRunTokens}-token budget`), { code: 'RUN_TOKEN_BUDGET_EXCEEDED' });
        }
        const assistantMessage = {
          role: 'assistant', content: response.content || '', toolCalls: response.toolCalls || [], providerState: response.providerState,
        };
        remember(assistantMessage, this.store.addMessage({
          sessionId: session.id, role: 'assistant', content: response.content || '',
          meta: { runId: run.id, modelRef: response.modelRef, toolCalls: response.toolCalls || [], finishReason: response.finishReason, usage: response.usage, providerState: response.providerState },
        }));
        this.#event(run.id, 'assistant', { content: response.content || '', toolCalls: response.toolCalls || [], modelRef: response.modelRef, usage: response.usage }, scope);
        if (response.content) finalContent = response.content;

        // A text-protocol model wrote something call-shaped that would not parse. Correct it
        // rather than reading the malformed turn as "finished and no tools needed".
        if (!response.toolCalls?.length && response.parseErrors?.length && repairAttempts < scaffold.knobs.repairBudget) {
          repairAttempts += 1;
          turnSource = 'repair';
          scaffold.signal('parse-failure');
          const correction = repairPrompt(response.parseErrors, tools);
          remember({ role: 'user', content: correction }, this.store.addMessage({
            sessionId: session.id, role: 'user', content: correction,
            meta: { runId: run.id, synthetic: true, toolCallRepair: repairAttempts },
          }));
          this.#event(run.id, 'tool-call-repair', { attempt: repairAttempts, errors: response.parseErrors }, scope);
          continue;
        }

        // The model thinks it is done, but the operator said something it has not seen yet.
        if (!response.toolCalls?.length && entry.steering.length) continue;

        // The model says it is done. For runs that changed something, the project's own checks
        // decide whether that is true.
        if (!response.toolCalls?.length && unverifiedChanges && guardrails.verification.commands.length && !entry.options.skipVerification) {
          const outcome = await runVerification(guardrails.verification.commands, { cwd: workspacePath, timeoutMs: guardrails.verification.timeoutMs, signal });
          if (signal.aborted) throw signal.reason || new Error('Run cancelled');
          verificationAttempts += 1;
          lastVerification = outcome;
          this.#event(run.id, 'verification', {
            ok: outcome.ok, attempt: verificationAttempts, results: outcome.results.map(({ command, label, ok, code, timedOut }) => ({ command, label, ok, code, timedOut })),
          }, scope);
          if (outcome.ok) {
            unverifiedChanges = false;
          } else if (verificationAttempts < guardrails.verification.maxAttempts) {
            scaffold.signal('verification-fail');
            const feedback = verificationFeedback(outcome, { attempt: verificationAttempts, maxAttempts: guardrails.verification.maxAttempts });
            remember({ role: 'user', content: feedback }, this.store.addMessage({
              sessionId: session.id, role: 'user', content: feedback, meta: { runId: run.id, synthetic: true, verification: verificationAttempts },
            }));
            turnSource = 'verification';
            continue;
          } else {
            const note = `\n\n[Harness] Verification still failing after ${verificationAttempts} attempts: ${verificationSummary(outcome)}.`;
            finalContent += note;
            this.store.addMessage({ sessionId: session.id, role: 'assistant', content: note.trim(), meta: { runId: run.id, synthetic: true } });
          }
        }

        if (!response.toolCalls?.length) {
          const meta = {
            ...currentRun.meta, checkpointId: checkpoint?.id || null,
            capabilities: this.capabilityController.snapshot(capabilityState), plan: entry.planState,
            usage, costEstimate: summarizeCosts(costs), contextPlan: workspaceContext.contextPlan,
            ...(lastVerification ? { verification: { ok: lastVerification.ok, attempts: verificationAttempts, summary: verificationSummary(lastVerification) } } : {}),
            ...(contextResets ? { contextResets } : {}),
          };
          const completed = this.store.updateRun(run.id, { status: 'completed', ended_at: nowIso(), meta });
          this.store.updateSession(session.id, { status: 'idle', model_id: response.modelRef || currentRun.model_id });
          this.#event(run.id, 'completed', { final: finalContent, steps: step, capabilities: meta.capabilities }, scope);
          await this.hooks?.run('Stop', { ...scope, workspacePath, status: 'completed', final: finalContent });
          await this.hooks?.run('RunCompleted', { ...scope, workspacePath, status: 'completed', final: finalContent });
          sessionEndOutcome = { status: 'completed', final: finalContent };
          if (run.workspace_id && this.config.get().autoIndex) void this.indexer.index(run.workspace_id, { force: true })
            .then(() => this.config.get().codeGraph?.enabled !== false ? this.contextBuilder.codeGraph?.build(run.workspace_id) : null)
            .catch(() => {});
          return completed;
        }

        const maxToolChars = this.config.get().maxToolOutputChars;
        const observation = {
          budget: Math.max(2_000, Math.floor((modelProfile?.contextWindow ? Math.max(3_000, Math.min(maxToolChars, Math.floor(modelProfile.contextWindow * 4 * 0.1))) : maxToolChars) * scaffold.knobs.observationScale)),
          spill: (text, where) => this.#spill(text, where),
        };
        const results = await this.#executeToolCalls(response.toolCalls, {
          run, session, entry, workspacePath, signal, scope, capabilityState, observation,
        });
        for (const result of results) {
          const toolMessage = {
            role: 'tool', toolCallId: result.call.id, toolName: result.call.name,
            content: result.content, isError: result.isError,
          };
          remember(toolMessage, this.store.addMessage({
            sessionId: session.id, role: 'tool', content: result.content,
            meta: { runId: run.id, toolCallId: result.call.id, toolName: result.call.name, isError: result.isError },
          }));
          this.#event(run.id, result.isError ? 'tool-error' : 'tool-result', {
            toolCallId: result.call.id, tool: result.call.name, content: result.content,
          }, scope);
          if (this.toolRegistry.descriptor(result.call.name)?.readOnly !== true) unverifiedChanges = true;
          const stumbled = [];
          if (result.isError) stumbled.push(EDIT_TOOLS.has(result.call.name) && /oldText|not found|matched \d+ locations/.test(result.content) ? 'edit-miss' : 'tool-error');
          if (result.repaired) stumbled.push('repaired-call');
          if (result.value?.applied?.some?.((entry) => entry.matchedBy)) stumbled.push('fuzzy-edit');
          if (result.checkProblems) stumbled.push('edit-problem');
          scaffold.result(stumbled);
          if (guardrails.stagnation.enabled) detector.observe(result.call, result);
        }

        // A model that needs more help is also given less rope before the harness steps in.
        detector.repeatThreshold = Math.min(guardrails.stagnation.repeatThreshold, scaffold.knobs.stagnationRepeat);
        detector.stopThreshold = Math.max(detector.repeatThreshold + 1, guardrails.stagnation.stopThreshold);
        const finding = guardrails.stagnation.enabled ? detector.check() : null;
        if (finding?.level === 'stop') {
          stagnated = finding;
          break;
        }
        if (finding?.level === 'warn') {
          const nudge = stagnationNudge(finding);
          remember({ role: 'user', content: nudge }, this.store.addMessage({
            sessionId: session.id, role: 'user', content: nudge, meta: { runId: run.id, synthetic: true, stagnation: finding.count },
          }));
          turnSource = 'nudge';
          this.#event(run.id, 'stagnation', { level: 'warn', ...finding }, scope);
          scaffold.signal('stagnation');
        }
      }

      const message = stagnated
        ? `Run stopped after ${stagnated.count} repeated ${stagnated.reason === 'oscillation' ? 'alternating ' : ''}actions with no change in result${stagnated.tool ? ` (${stagnated.tool})` : ''}.`
        : `Run reached the configured maximum of ${maxSteps} model turns.`;
      if (!finalContent) {
        finalContent = message;
        this.store.addMessage({ sessionId: session.id, role: 'assistant', content: message, meta: { runId: run.id, synthetic: true } });
      }
      const current = this.store.getRun(run.id);
      const completed = this.store.updateRun(run.id, {
        status: stagnated ? 'stagnated' : 'max_steps', ended_at: nowIso(), error: message,
        meta: { ...current.meta, capabilities: this.capabilityController.snapshot(capabilityState), plan: entry.planState, usage, costEstimate: summarizeCosts(costs) },
      });
      this.store.updateSession(session.id, { status: 'idle' });
      this.#event(run.id, stagnated ? 'stagnation' : 'max-steps', { ...(stagnated ? { level: 'stop', ...stagnated } : {}), message, final: finalContent }, scope);
      const endStatus = stagnated ? 'stagnated' : 'max_steps';
      await this.hooks?.run('Stop', { ...scope, workspacePath, status: endStatus, final: finalContent });
      sessionEndOutcome = { status: endStatus, final: finalContent };
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
      sessionEndOutcome = { status, error: error.message };
      return failed;
    } finally {
      clearTimeout(deadlineTimer);
      if (scaffoldController) this.capabilities.record(scaffoldRef, scaffoldController.summary());
      if (sessionEndOutcome) {
        await this.hooks?.run('SessionEnd', { ...scope, workspacePath, ...sessionEndOutcome }).catch(() => {});
      }
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
    // Record the intent to run an effectful tool before it executes. If the process dies before
    // the matching tool-result/tool-error event lands, this is what makes that interruption
    // visible on restart instead of silently unresolved.
    if (this.toolRegistry.descriptor(call.name)?.readOnly !== true) {
      this.#event(run.id, 'tool-intent', { toolCallId: call.id, tool: call.name, argsHash: sha256(JSON.stringify(call.args || {})) }, scope);
    }
    try {
      let name = call.name;
      let args = call.args || {};
      const notes = [];
      let repaired = false;
      const repairOn = this.config.get().guardrails?.features?.callRepair !== false;
      if (repairOn && (!name.startsWith('mcp__') || !this.toolRegistry.has(name))) {
        // A near-miss on the name is resolved here rather than sent back as an error: the error
        // would cost a whole model turn, and the model already knew which tool it meant.
        if (!this.toolRegistry.has(name) && !name.startsWith('mcp__')) {
          const resolved = resolveToolName(name, this.toolRegistry.list({ includeSchema: false }).map((tool) => tool.name));
          if (!resolved.name) throw new Error(unknownToolMessage(name, resolved.suggestions));
          notes.push(`"${name}" is not a tool; ran \`${resolved.name}\` instead — use that name next time.`);
          name = resolved.name;
        }
      }
      if (this.toolRegistry.has(name)) {
        const schema = this.toolRegistry.descriptor(name)?.inputSchema;
        const normalized = repairOn ? normalizeArgs(args, schema) : { args, repairs: [] };
        args = normalized.args;
        repaired = normalized.repairs.length > 0 || notes.length > 0;
        if (normalized.repairs.length) this.#event(run.id, 'tool-call-repaired', { tool: name, requested: call.name, repairs: normalized.repairs.slice(0, 12) }, scope);
        const missing = repairOn ? missingRequired(args, schema) : [];
        if (missing.length) throw new Error(missingArgumentMessage(name, schema, missing, args));
        const value = await this.toolRegistry.execute(name, args, toolContext);
        let content = withNotes(await this.#observe(value, context), notes);
        let checkProblems = 0;
        const check = await this.feedback.check({ name, args, value, workspaceId: run.workspace_id, workspacePath, signal });
        if (check) {
          content += `\n\n${check.text}`;
          checkProblems = check.problems;
          this.#event(run.id, 'edit-check', { tool: name, problems: check.problems }, scope);
        }
        return { call, content, isError: false, name, args, value, repaired, checkProblems };
      }
      if (name.startsWith('mcp__')) {
        const value = await this.mcpManager.callQualified(name, args, { workspaceId: run.workspace_id, signal });
        return { call, content: await this.#observe(value, context), isError: false, name, args, value };
      }
      throw new Error(unknownToolMessage(name, []));
    } catch (error) {
      return { call, content: renderToolResult({ error: error.message, tool: call.name }, this.config.get().maxToolOutputChars), isError: true };
    }
  }

  // What the model sees of a tool result: noise removed, rendered compactly, kept within what the
  // model's window can afford, with the complete text saved to disk when something was left out.
  async #observe(value, context) {
    const maxChars = this.config.get().maxToolOutputChars;
    const { observation, workspacePath, run } = context;
    try {
      if (this.config.get().guardrails?.features?.observation === false) return renderToolResult(value, maxChars);
      const shaped = await shapeObservation(value, {
        budget: observation?.budget || maxChars,
        spill: observation?.spill && workspacePath ? (text) => observation.spill(text, { workspacePath, runId: run.id }) : null,
      });
      return shaped.text;
    } catch {
      return renderToolResult(value, maxChars);
    }
  }

  async #spill(text, { workspacePath, runId }) {
    const dir = path.join(workspacePath, '.maskshift', 'outputs');
    await fsp.mkdir(dir, { recursive: true });
    this.spillCounter = (this.spillCounter || 0) + 1;
    const file = path.join(dir, `${runId}-${this.spillCounter}.txt`);
    await fsp.writeFile(file, text);
    // Bounded: this is a convenience for re-reading, not an archive.
    const names = (await fsp.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.txt'));
    if (names.length > 200) {
      const stats = await Promise.all(names.map(async (name) => ({ name, mtime: (await fsp.stat(path.join(dir, name)).catch(() => null))?.mtimeMs || 0 })));
      stats.sort((a, b) => a.mtime - b.mtime);
      await Promise.all(stats.slice(0, names.length - 150).map((entry) => fsp.rm(path.join(dir, entry.name), { force: true })));
    }
    return path.relative(workspacePath, file);
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
