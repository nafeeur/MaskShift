// The fleet: any mix of coding-agent harnesses, run as named, persistent members that can message each other.
//
// BridgeManager can fire one prompt at one CLI and wait. That is delegation. The fleet is the layer above it:
//
//   member    a named seat held by a harness ("claude-1", "reviewer"), with a role, a working directory, a history
//             and an inbox. Several members may use the same harness; any combination of harnesses may coexist.
//   mailbox   members address each other with [[send]] blocks (see protocol.mjs). Messages are queued, de-duplicated,
//             hop-limited and recorded.
//   relay     a bounded loop that keeps delivering mail and running whoever has some until the team says it is done,
//             falls quiet, or runs out of budget.
//
// Everything here is written to fail soft: a missing CLI falls back to another harness, a flaky turn is retried, a
// stuck one times out and can be cancelled, and a pair of agents that start echoing each other is cut off.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { id as newId, nowIso, truncate } from '../core/utils.mjs';
import { buildBriefing, parseDirectives, slug, stripAnsi } from './protocol.mjs';

const INTERNAL = 'maskshift';
const STATE_KEY = 'fleet:state';
const MESSAGE_LOG_LIMIT = 600;
const INBOX_LIMIT = 200;
const HISTORY_LIMIT = 40;
const RELAY_LIMIT = 40;

const DEFAULTS = {
  maxMembers: 12,
  maxParallel: 4,
  maxRounds: 12,
  maxHops: 10,
  maxRetries: 1,
  retryDelayMs: 1500,
  turnTimeoutMs: 20 * 60 * 1000,
  relayTimeoutMs: 2 * 60 * 60 * 1000,
  historyChars: 6000,
  messageChars: 12000,
};

const INTERNAL_DEFINITION = {
  name: INTERNAL, title: 'MaskShift agent', command: 'maskshift', available: true, internal: true,
  description: 'MaskShift\'s own agent engine, with whatever model you have configured.',
};

function messageKey(item) {
  return `${item.from}\u0000${item.to}\u0000${item.body.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export class FleetManager {
  constructor({ config, logger, eventBus, store, bridgeManager, workspaceManager, getEngine }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.store = store;
    this.bridgeManager = bridgeManager;
    this.workspaceManager = workspaceManager;
    this.getEngine = getEngine;
    this.members = new Map();
    this.messages = [];
    this.relays = [];
    this.relayControllers = new Map();
    this.loaded = false;
    this.closed = false;
  }

  // ------------------------------------------------------------------ settings

  settings() {
    return { ...DEFAULTS, ...(this.config.get().fleet || {}) };
  }

  // --------------------------------------------------------------- persistence

  load() {
    if (this.loaded) return;
    this.loaded = true;
    const saved = this.store.getSetting(STATE_KEY, null);
    if (!saved) return;
    for (const entry of saved.members || []) {
      // Nothing survives a restart mid-turn; whoever was running is simply idle again.
      this.members.set(entry.id, this.#hydrate({ ...entry, status: entry.status === 'running' ? 'idle' : entry.status }));
    }
    this.messages = (saved.messages || []).slice(-MESSAGE_LOG_LIMIT);
    this.relays = (saved.relays || []).map((relay) => (relay.status === 'running' ? { ...relay, status: 'interrupted' } : relay)).slice(-RELAY_LIMIT);
  }

  #hydrate(entry) {
    return {
      ...entry,
      inbox: entry.inbox || [],
      history: entry.history || [],
      stats: { turns: 0, failures: 0, retries: 0, fallbacks: 0, ms: 0, ...(entry.stats || {}) },
      queue: Promise.resolve(),
      controller: null,
    };
  }

  #save() {
    if (this.closed) return;
    try {
      this.store.setSetting(STATE_KEY, {
        // Only the recent past is worth keeping across a restart; a full transcript would bloat the settings row.
        members: [...this.members.values()].map(({ queue, controller, history, ...rest }) => ({
          ...rest, history: history.slice(-10).map((turn) => ({ ...turn, reply: truncate(turn.reply, 4000), prompt: truncate(turn.prompt, 600) })),
        })),
        messages: this.messages.slice(-MESSAGE_LOG_LIMIT),
        relays: this.relays.slice(-RELAY_LIMIT),
      });
    } catch (error) {
      this.logger?.warn?.(`Fleet state was not saved: ${error.message}`);
    }
  }

  #emit(type, payload = {}) {
    this.eventBus?.emit(`fleet.${type}`, payload, {});
  }

  // ---------------------------------------------------------------- harnesses

  /** Every harness a member can use: the installed CLIs, the configured custom ones, and MaskShift itself. */
  async harnesses({ force = false } = {}) {
    const bridges = await this.bridgeManager.discover({ force });
    return [
      INTERNAL_DEFINITION,
      ...bridges.map((bridge) => ({
        name: bridge.name, title: bridge.title || bridge.name, command: bridge.command, available: bridge.available,
        version: bridge.version || null, description: bridge.description || '',
      })),
    ];
  }

  async #resolveHarness(wanted, fallbacks = []) {
    const harnesses = await this.harnesses();
    const chain = [wanted, ...fallbacks].filter(Boolean);
    for (const [index, name] of chain.entries()) {
      const found = harnesses.find((item) => item.name === name);
      if (found?.available) return { harness: found, fellBackFrom: index > 0 ? wanted : null };
    }
    const known = harnesses.find((item) => item.name === wanted);
    if (!known) throw new Error(`Unknown harness "${wanted}". Known: ${harnesses.map((item) => item.name).join(', ')}`);
    return { harness: null, missing: known };
  }

  // ------------------------------------------------------------------ members

  list() {
    this.load();
    return [...this.members.values()].map((member) => this.#view(member));
  }

  #view(member) {
    const { queue, controller, history, inbox, ...rest } = member;
    return {
      ...rest,
      unread: inbox.length,
      lastReply: history.at(-1)?.reply || '',
      lastAt: history.at(-1)?.at || null,
      turns: rest.stats.turns,
    };
  }

  get(ref) {
    this.load();
    if (!ref) throw new Error('A fleet member name is required');
    const key = String(ref).trim();
    const found = this.members.get(key)
      || [...this.members.values()].find((member) => member.name === key || member.name === slug(key));
    if (!found) throw new Error(`No fleet member "${ref}". Members: ${[...this.members.values()].map((member) => member.name).join(', ') || '(none)'}`);
    return found;
  }

  details(ref) {
    const member = this.get(ref);
    return { ...this.#view(member), history: member.history, inbox: member.inbox };
  }

  #uniqueName(base) {
    const root = slug(base) || 'agent';
    const taken = new Set([...this.members.values()].map((member) => member.name));
    if (!taken.has(root)) return root;
    for (let index = 2; index < 1000; index += 1) if (!taken.has(`${root}-${index}`)) return `${root}-${index}`;
    return `${root}-${newId('m').slice(-6)}`;
  }

  async spawn({
    harness = INTERNAL, name = '', role = '', cwd = null, workspaceId = null, model = null, mode = 'edit',
    isolated = false, fallbacks = [], timeoutMs = null,
  } = {}) {
    this.load();
    const settings = this.settings();
    if (this.members.size >= settings.maxMembers) throw new Error(`The fleet is at its limit of ${settings.maxMembers} members`);
    if (!['inspect', 'edit'].includes(mode)) throw new Error('mode must be "inspect" or "edit"');
    const resolved = await this.#resolveHarness(harness, fallbacks);
    if (!resolved.harness) {
      throw new Error(`${resolved.missing.title || harness} is not installed (${resolved.missing.command}). Install it, or give this member a fallback harness.`);
    }
    const memberName = this.#uniqueName(name || (resolved.fellBackFrom ? resolved.harness.name : harness));

    let directory = cwd ? path.resolve(cwd) : (workspaceId ? this.workspaceManager.get(workspaceId).path : process.cwd());
    let isolation = null;
    let memberWorkspaceId = workspaceId;
    if (isolated) {
      if (!workspaceId) throw new Error('Isolated members need a workspace (worktrees are made from a Git workspace)');
      const worktree = await this.workspaceManager.createWorktree(workspaceId, { name: `fleet-${memberName}`, branch: `maskshift/fleet-${memberName}` });
      directory = worktree.path;
      memberWorkspaceId = worktree.workspace.id;
      isolation = { path: worktree.path, branch: worktree.branch, workspaceId: worktree.workspace.id };
    } else {
      try { await fsp.access(directory); } catch { throw new Error(`Working directory does not exist: ${directory}`); }
    }

    const member = this.#hydrate({
      id: newId('mem'), name: memberName, harness: resolved.harness.name, title: resolved.harness.title,
      requestedHarness: harness, fellBackFrom: resolved.fellBackFrom, fallbacks, role: String(role || '').trim(),
      cwd: directory, workspaceId: memberWorkspaceId, model: model || null, mode, isolation,
      timeoutMs: timeoutMs || null, status: 'idle', error: null, createdAt: nowIso(),
    });
    this.members.set(member.id, member);
    this.#save();
    this.#emit('member.created', { member: this.#view(member) });
    return this.#view(member);
  }

  /** Spawn several at once from loose specs: "claude", "codex:reviewer", or objects. */
  async spawnMany(specs, defaults = {}) {
    const out = [];
    for (const spec of specs) {
      const base = typeof spec === 'string'
        ? (() => { const [harness, name] = spec.split(':'); return { harness: harness.trim(), name: name?.trim() || '' }; })()
        : spec;
      out.push(await this.spawn({ ...defaults, ...base }));
    }
    return out;
  }

  async remove(ref) {
    const member = this.get(ref);
    this.stop(member.name);
    this.members.delete(member.id);
    this.#save();
    this.#emit('member.removed', { id: member.id, name: member.name });
    return { removed: member.name };
  }

  reset(ref) {
    const member = this.get(ref);
    member.history = [];
    member.inbox = [];
    member.sessionId = null;
    member.error = null;
    if (member.status !== 'running') member.status = 'idle';
    this.#save();
    this.#emit('member.updated', { member: this.#view(member) });
    return this.#view(member);
  }

  update(ref, patch = {}) {
    const member = this.get(ref);
    for (const key of ['role', 'model', 'mode', 'timeoutMs']) if (key in patch) member[key] = patch[key] || (key === 'mode' ? member.mode : null);
    this.#save();
    this.#emit('member.updated', { member: this.#view(member) });
    return this.#view(member);
  }

  /** Cancel whatever the member is doing right now. */
  stop(ref) {
    const member = this.get(ref);
    const wasRunning = Boolean(member.controller);
    member.controller?.abort(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
    return { name: member.name, stopped: wasRunning };
  }

  stopAll() {
    for (const controller of this.relayControllers.values()) controller.abort(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
    return [...this.members.values()].map((member) => this.stop(member.id));
  }

  // ----------------------------------------------------------------- mailbox

  /** Queue a message. Returns the delivery record, or one with `dropped` explaining why it was not delivered. */
  send({ from = 'user', to, body, kind = 'message', hops = 0, relayId = null }) {
    this.load();
    const text = String(body ?? '').trim();
    if (!to) throw new Error('A recipient is required');
    if (!text) throw new Error('A message body is required');
    if (to === '*') {
      return [...this.members.values()].filter((member) => member.name !== from)
        .map((member) => this.send({ from, to: member.name, body: text, kind, hops, relayId }));
    }
    const record = { id: newId('msg'), at: nowIso(), from, to: String(to), body: truncate(text, this.settings().messageChars * 2), kind, hops, relayId, status: 'queued' };
    let target;
    try { target = to === 'user' ? null : this.get(to); } catch (error) {
      record.status = 'dropped';
      record.dropped = error.message;
      this.#log(record);
      return record;
    }
    if (!target) { record.status = 'delivered'; this.#log(record); return record; }
    if (hops > this.settings().maxHops) {
      record.status = 'dropped';
      record.dropped = `Exceeded the ${this.settings().maxHops}-hop limit; the agents appear to be going in circles.`;
    } else if (target.inbox.some((item) => messageKey(item) === messageKey(record))
      || this.messages.slice(-30).some((item) => item.relayId && item.relayId === relayId && item.status !== 'dropped' && messageKey(item) === messageKey(record))) {
      record.status = 'dropped';
      record.dropped = 'Duplicate of a message already sent.';
    } else if (target.inbox.length >= INBOX_LIMIT) {
      record.status = 'dropped';
      record.dropped = 'Recipient inbox is full.';
    } else {
      target.inbox.push(record);
    }
    this.#log(record);
    this.#save();
    this.#emit('message', { message: record });
    return record;
  }

  #log(record) {
    this.messages.push(record);
    if (this.messages.length > MESSAGE_LOG_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LOG_LIMIT);
  }

  conversation({ member = null, limit = 100 } = {}) {
    this.load();
    const name = member ? this.get(member).name : null;
    const items = name ? this.messages.filter((item) => item.from === name || item.to === name) : this.messages;
    return items.slice(-limit);
  }

  // ------------------------------------------------------------------- turns

  /** One member takes one turn: consume its inbox (plus `message`), run its harness, route what it says. */
  ask(ref, { message = '', from = 'user', objective = '', relayId = null, signal = null } = {}) {
    const member = this.get(ref);
    // A member does one thing at a time; further asks wait their turn rather than racing for its working directory.
    const run = member.queue.then(() => this.#turn(member, { message, from, objective, relayId, signal }));
    member.queue = run.catch(() => {});
    return run;
  }

  async #turn(member, { message, from, objective, relayId, signal }) {
    const settings = this.settings();
    const taken = member.inbox.splice(0, member.inbox.length);
    for (const item of taken) item.status = 'delivered';
    if (!message && !taken.length) return { name: member.name, skipped: true, reply: '', sends: [] };
    if (message) this.#log({ id: newId('msg'), at: nowIso(), from, to: member.name, body: truncate(message, settings.messageChars), kind: 'task', hops: 0, relayId, status: 'delivered' });
    const hops = Math.max(0, ...taken.map((item) => item.hops || 0));
    const controller = new AbortController();
    const abortFromOutside = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason); else signal?.addEventListener('abort', abortFromOutside, { once: true });
    member.controller = controller;
    member.status = 'running';
    member.error = null;
    member.currentTask = truncate(message || taken.at(-1)?.body || '', 200);
    member.startedAt = nowIso();
    this.#emit('turn.started', { member: this.#view(member), from, relayId });
    this.#save();

    const started = Date.now();
    let outcome;
    try {
      outcome = await this.#runWithRecovery(member, {
        prompt: buildBriefing({
          member, roster: this.list(), objective, inbox: taken, history: member.history, message,
          limits: { historyChars: settings.historyChars, messageChars: settings.messageChars },
        }),
        signal: controller.signal, timeoutMs: member.timeoutMs || settings.turnTimeoutMs,
      });
    } catch (error) {
      outcome = { ok: false, text: '', error: error.message, cancelled: controller.signal.aborted };
    } finally {
      signal?.removeEventListener('abort', abortFromOutside);
      member.controller = null;
    }

    const durationMs = Date.now() - started;
    const parsed = parseDirectives(outcome.text);
    const turn = {
      id: newId('turn'), at: nowIso(), durationMs, ok: outcome.ok, harness: outcome.harness || member.harness,
      prompt: truncate(message || taken.map((item) => `${item.from}: ${item.body}`).join('\n'), 2000),
      reply: truncate(parsed.text || parsed.done || stripAnsi(outcome.text).trim(), 20_000), error: outcome.error || null,
      sends: parsed.sends.map((item) => ({ to: item.to, body: truncate(item.body, 600) })), done: parsed.done,
      from, retries: outcome.retries || 0,
    };
    member.history.push(turn);
    if (member.history.length > HISTORY_LIMIT) member.history.splice(0, member.history.length - HISTORY_LIMIT);
    member.stats.turns += 1;
    member.stats.ms += durationMs;
    member.stats.retries += outcome.retries || 0;
    member.currentTask = '';
    if (outcome.ok) {
      member.status = 'idle';
    } else {
      member.stats.failures += 1;
      member.status = outcome.cancelled ? 'stopped' : 'failed';
      member.error = outcome.error;
      // The mail never got read; put it back so a retry (or a different member) does not lose it.
      if (!outcome.cancelled) {
        for (const item of taken) item.status = 'queued';
        member.inbox.unshift(...taken);
      }
    }

    const delivered = [];
    if (outcome.ok) {
      for (const item of parsed.sends) delivered.push(this.send({ from: member.name, to: item.to, body: item.body, hops: hops + 1, relayId }));
      // A member that just answers, instead of writing a [[send]], is still answering someone. Route a plain reply
      // back to whoever asked (another member only; never the user, never in answer to a reply), so loosely
      // instruction-following CLIs still take part in the conversation.
      if (!parsed.sends.length && !parsed.done && parsed.text) {
        const askers = [...new Set(taken.filter((item) => item.kind === 'message' && item.from !== 'user' && item.from !== member.name).map((item) => item.from))];
        for (const asker of askers) delivered.push(this.send({ from: member.name, to: asker, body: parsed.text, kind: 'reply', hops: hops + 1, relayId }));
      }
    }
    this.#save();
    this.#emit('turn.completed', { member: this.#view(member), turn, relayId });
    return {
      name: member.name, harness: turn.harness, ok: outcome.ok, cancelled: Boolean(outcome.cancelled), reply: turn.reply, done: parsed.done,
      sends: delivered.flat(), error: outcome.error || null, durationMs, retries: outcome.retries || 0, fellBackTo: outcome.fellBackTo || null,
    };
  }

  /** Run the harness, retrying a flaky turn and switching to a fallback harness if this one has vanished. */
  async #runWithRecovery(member, { prompt, signal, timeoutMs }) {
    const settings = this.settings();
    let retries = 0;
    let harness = member.harness;
    let fellBackTo = null;
    let lastError = 'The harness produced no output';
    for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
      if (signal.aborted) return { ok: false, text: '', error: 'Cancelled', cancelled: true, retries, harness };
      const found = (await this.harnesses()).find((item) => item.name === harness);
      if (!found?.available) {
        // Installed when the member was created, gone now (or never was, for a restored member): walk the fallbacks.
        // Only harnesses the member was given: silently handing work to a paid model run would be a surprise.
        const order = member.fallbacks || [];
        const available = (await this.harnesses()).filter((item) => item.available && item.name !== harness);
        const replacement = order.map((name) => available.find((item) => item.name === name)).find(Boolean);
        if (!replacement) return { ok: false, text: '', error: `${member.title || harness} is not available and no fallback is installed`, retries, harness };
        member.stats.fallbacks += 1;
        this.#emit('member.fallback', { name: member.name, from: harness, to: replacement.name });
        harness = replacement.name;
        fellBackTo = replacement.name;
        member.harness = replacement.name;
        member.title = replacement.title;
      }
      const result = await this.#invoke(member, harness, { prompt, signal, timeoutMs });
      if (result.ok || result.cancelled) return { ...result, retries, harness, fellBackTo };
      lastError = result.error;
      if (attempt < settings.maxRetries) {
        retries += 1;
        await new Promise((resolve) => { const timer = setTimeout(resolve, settings.retryDelayMs * (attempt + 1)); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
    }
    return { ok: false, text: '', error: lastError, retries, harness, fellBackTo };
  }

  async #invoke(member, harness, { prompt, signal, timeoutMs }) {
    if (harness === INTERNAL) return this.#invokeInternal(member, { prompt, signal, timeoutMs });
    try {
      const result = await this.bridgeManager.run(harness, {
        prompt, cwd: member.cwd, workspaceId: member.workspaceId, model: member.model, wait: true,
        timeoutMs, signal, edit: member.mode === 'edit',
      });
      const text = stripAnsi(result.stdout || '').trim();
      if (result.aborted || signal.aborted) return { ok: false, text, error: 'Cancelled', cancelled: true };
      if (result.timedOut) return { ok: false, text, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` };
      // Some CLIs exit non-zero after producing a perfectly good answer; a reply is a reply.
      if (result.code !== 0 && !text) return { ok: false, text: '', error: truncate(stripAnsi(result.stderr || '').trim() || `Exited with code ${result.code}`, 1500) };
      return { ok: true, text: text || stripAnsi(result.stderr || '').trim() };
    } catch (error) {
      return { ok: false, text: '', error: error.message };
    }
  }

  async #invokeInternal(member, { prompt, signal }) {
    const engine = this.getEngine();
    if (!member.sessionId) {
      member.sessionId = engine.createSession({ workspaceId: member.workspaceId, title: `Fleet: ${member.name}`, modelRef: member.model, meta: { fleetMember: member.name } }).id;
    }
    let run;
    try {
      run = await engine.startRun({
        sessionId: member.sessionId, workspaceId: member.workspaceId, prompt, modelRef: member.model || null,
        options: { source: 'fleet', skipCheckpoint: member.mode !== 'edit' },
      });
    } catch (error) {
      return { ok: false, text: '', error: error.message };
    }
    const cancel = () => { try { engine.cancel(run.id); } catch { /* already finished */ } };
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    try {
      const done = await engine.waitForRun(run.id);
      const messages = this.store.listMessages(member.sessionId, 200);
      const final = [...messages].reverse().find((item) => item.role === 'assistant' && item.content)?.content || '';
      if (signal.aborted || done?.status === 'cancelled') return { ok: false, text: final, error: 'Cancelled', cancelled: true };
      if (done?.status !== 'completed') return { ok: false, text: final, error: done?.error || `Run ${done?.status || 'ended abnormally'}` };
      return { ok: true, text: final };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  // ------------------------------------------------------------------- relay

  /**
   * Run the team on a task until it is done.
   *
   * `lead` receives the task first. After each round, every member with mail takes a turn (up to `maxParallel` at
   * once). The relay ends when someone writes [[done]], when no one has mail (the lead's last reply is the answer),
   * or when it reaches its round, time or cancellation limit.
   */
  async relay({ task, lead = null, members = null, maxRounds = null, maxParallel = null, timeoutMs = null, signal = null, background = false } = {}) {
    this.load();
    const text = String(task ?? '').trim();
    if (!text) throw new Error('A task is required');
    const settings = this.settings();
    const roster = (members?.length ? members.map((ref) => this.get(ref)) : [...this.members.values()]);
    if (!roster.length) throw new Error('The fleet has no members. Spawn some first.');
    const leader = lead ? this.get(lead) : roster[0];
    if (!roster.includes(leader)) roster.unshift(leader);
    const names = new Set(roster.map((member) => member.name));

    const relay = {
      id: newId('relay'), task: truncate(text, 4000), lead: leader.name, members: [...names], status: 'running',
      startedAt: nowIso(), finishedAt: null, rounds: 0, final: '', reason: '', turns: [],
    };
    this.relays.push(relay);
    if (this.relays.length > RELAY_LIMIT) this.relays.splice(0, this.relays.length - RELAY_LIMIT);
    const controller = new AbortController();
    this.relayControllers.set(relay.id, controller);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason); else signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => controller.abort(Object.assign(new Error('Relay time limit reached'), { code: 'RELAY_DEADLINE' })), timeoutMs || settings.relayTimeoutMs);
    deadline.unref?.();
    this.#emit('relay.started', { relay });

    const execute = async () => {
      const limit = Math.max(1, maxRounds || settings.maxRounds);
      const width = Math.max(1, maxParallel || settings.maxParallel);
      let lastLeadReply = '';
      let kickoff = true;
      const failures = new Map();
      try {
        for (let round = 1; round <= limit; round += 1) {
          if (controller.signal.aborted) { relay.reason = controller.signal.reason?.code === 'RELAY_DEADLINE' ? 'time-limit' : 'cancelled'; break; }
          // A member that has failed twice in this relay is given up on, so its unread mail cannot spin the loop.
          const runnable = roster.filter((member) => (failures.get(member.name) || 0) < 2 && (member.inbox.length || (kickoff && member === leader)));
          if (!runnable.length) { relay.reason = 'quiet'; break; }
          relay.rounds = round;
          const outcomes = [];
          for (let index = 0; index < runnable.length; index += width) {
            const batch = runnable.slice(index, index + width);
            outcomes.push(...await Promise.all(batch.map((member) => this.ask(member.name, {
              message: kickoff && member === leader ? text : '', from: 'user', objective: text, relayId: relay.id, signal: controller.signal,
            }).catch((error) => ({ name: member.name, ok: false, error: error.message, reply: '', sends: [] })))));
          }
          kickoff = false;
          for (const outcome of outcomes) {
            if (!outcome.ok) failures.set(outcome.name, (failures.get(outcome.name) || 0) + 1);
            relay.turns.push({ round, name: outcome.name, ok: outcome.ok, reply: truncate(outcome.reply || '', 1500), error: outcome.error || null, sends: (outcome.sends || []).map((item) => `${item.from}→${item.to}`) });
            if (outcome.name === leader.name && outcome.reply) lastLeadReply = outcome.reply;
          }
          const finisher = outcomes.find((outcome) => outcome.done);
          if (finisher) { relay.final = finisher.done; relay.reason = `done by ${finisher.name}`; relay.status = 'completed'; break; }
          if (outcomes.length && outcomes.every((outcome) => !outcome.ok)) {
            relay.reason = 'every member failed this round';
            relay.status = controller.signal.aborted ? 'cancelled' : 'failed';
            break;
          }
          if (round === limit && roster.some((member) => member.inbox.length)) relay.reason = 'round-limit';
        }
        if (relay.status === 'running') {
          relay.status = relay.reason === 'cancelled' ? 'cancelled' : relay.reason === 'time-limit' || relay.reason === 'round-limit' ? 'incomplete' : 'completed';
          if (!relay.final) relay.final = lastLeadReply || [...relay.turns].reverse().find((turn) => turn.reply)?.reply || '';
          relay.reason ||= 'quiet';
        }
      } catch (error) {
        relay.status = 'failed';
        relay.reason = error.message;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        this.relayControllers.delete(relay.id);
        relay.finishedAt = nowIso();
        // Mail that outlived the relay stays in inboxes; a later relay or `ask` will deliver it.
        this.#save();
        this.#emit('relay.completed', { relay });
      }
      return relay;
    };
    if (background) { void execute(); return relay; }
    return execute();
  }

  cancelRelay(id) {
    const controller = this.relayControllers.get(id);
    if (!controller) return { id, cancelled: false };
    controller.abort(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
    return { id, cancelled: true };
  }

  getRelay(id) {
    this.load();
    return this.relays.find((relay) => relay.id === id) || null;
  }

  listRelays() {
    this.load();
    return [...this.relays].reverse();
  }

  // ---------------------------------------------------------------- overview

  async snapshot({ force = false } = {}) {
    this.load();
    return {
      harnesses: await this.harnesses({ force }),
      members: this.list(),
      messages: this.messages.slice(-200),
      relays: this.listRelays(),
    };
  }

  async close() {
    this.stopAll();
    this.closed = true;
  }
}
