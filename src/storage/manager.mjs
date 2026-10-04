// Keeps MaskShift's footprint inside a budget worked out from the host (see budget.mjs).
//
// What may be deleted, and what never is:
//
//   reclaimable   checkpoints past their retention (the git ref and copied files go with them), search indexes for
//                 workspaces nobody has opened lately or whose folder is gone (rebuilt on next open), old run events,
//                 rolled-over logs, free pages inside the database file
//   never touched chats, messages, runs, memories, workspaces, skills, config, the audit log's newest generation, any
//                 file inside a workspace, browser profiles (reported, not pruned), and any checkpoint younger than
//                 `protectHours`, or the newest one of its workspace
//
// `plan()` says what would go and why; `prune()` does it. Both are safe to run at any time.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { computeBudget, formatBytes, probeHost } from './budget.mjs';
import { directorySize, fileSize } from './size.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN_GAP_MS = 15 * 60_000;

export class StorageManager {
  constructor({ config, store, logger, eventBus, workspaceManager }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.eventBus = eventBus;
    this.workspaceManager = workspaceManager;
    this.timers = [];
    this.unsubscribe = null;
    this.lastRun = 0;
    this.running = null;
    this.cached = null;
    this.lastWarning = '';
  }

  settings() {
    return this.config.get().storage || {};
  }

  // ----------------------------------------------------------------- budget

  /**
   * The current budget. Probing the disk costs a syscall and measuring usage walks directories, so the result is
   * reused for a minute: the indexer and checkpointer ask for limits on every run.
   */
  async budget({ fresh = false } = {}) {
    if (!fresh && this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value;
    const home = this.config.get().home;
    const host = await probeHost(home);
    const usage = await this.measure();
    const value = computeBudget(host, usage.total, this.settings());
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** Limits the indexer and checkpointer read synchronously; they are refreshed whenever the budget is. */
  syncLimits() {
    const value = this.cached?.value;
    return value ? { index: value.index, checkpoints: value.checkpoints } : null;
  }

  // ------------------------------------------------------------------ usage

  async measure() {
    const home = this.config.get().home;
    const cfg = this.config.get();
    const sqlite = cfg.dataFile;
    const database = (await fileSize(sqlite)) + (await fileSize(`${sqlite}-wal`)) + (await fileSize(`${sqlite}-shm`));
    const checkpoints = await directorySize(path.join(home, 'checkpoints'));
    const browser = await directorySize(path.join(home, 'browser'));
    const artifacts = await directorySize(path.join(home, 'artifacts'));
    const cache = await directorySize(path.join(home, 'cache'));
    let logs = await directorySize(path.dirname(cfg.logFile));
    if (path.dirname(cfg.auditFile) !== path.dirname(cfg.logFile)) logs += await directorySize(path.dirname(cfg.auditFile));
    const other = browser + artifacts + cache + logs;
    return { database, checkpoints, browser, artifacts, cache, logs, other, total: database + checkpoints + other };
  }

  async status() {
    const budget = await this.budget({ fresh: true });
    const usage = await this.measure();
    const info = this.store.dbInfo();
    const areas = this.store.usageByArea();
    const indexed = this.store.indexedWorkspaces();
    const checkpoints = this.store.allCheckpoints();
    const free = info.freePages * info.pageSize;
    const over = {
      total: usage.total > budget.total,
      database: usage.database > budget.share.index + budget.share.other * 0.5,
      checkpoints: usage.checkpoints > budget.share.checkpoints,
    };
    const advice = [];
    if (budget.pressure === 'critical') advice.push(`Free disk space is critically low (${formatBytes(budget.host.diskFree)}); retention is at its shortest.`);
    else if (budget.pressure === 'tight') advice.push(`Free disk space is getting low (${formatBytes(budget.host.diskFree)}); retention is shortened.`);
    if (over.total) advice.push(`MaskShift uses ${formatBytes(usage.total)}, over its ${formatBytes(budget.total)} budget. Run: maskshift storage prune`);
    if (free > 100 * 1024 ** 2 && free / (info.pages * info.pageSize) > 0.2) advice.push(`${formatBytes(free)} of the database file is free space. Run: maskshift storage vacuum`);
    if (info.autoVacuum !== 2 && usage.database > 256 * 1024 ** 2) advice.push('The database does not return deleted space to the disk. Run: maskshift storage vacuum (once) to fix that.');
    return {
      usage, budget: this.describeBudget(budget), pressure: budget.pressure,
      database: { ...info, freeBytes: free, areas, indexedWorkspaces: indexed.length, checkpoints: checkpoints.length },
      overBudget: over, advice,
    };
  }

  describeBudget(budget) {
    return {
      total: budget.total, share: budget.share, pressure: budget.pressure,
      host: { diskTotal: budget.host.diskTotal, diskFree: budget.host.diskFree, memTotal: budget.host.memTotal, cpus: budget.host.cpus, platform: budget.host.platform },
      index: budget.index, checkpoints: budget.checkpoints, runEventDays: budget.runEventDays, logs: budget.logs,
      overrides: Object.fromEntries(Object.entries(this.settings()).filter(([key, value]) => value !== null && value !== undefined && key !== 'auto')),
    };
  }

  // -------------------------------------------------------------------- plan

  /** Everything that could be reclaimed right now, and why. Does not change anything. */
  async plan() {
    const budget = await this.budget({ fresh: true });
    const home = this.config.get().home;
    const now = Date.now();
    const actions = [];
    const rows = this.store.allCheckpoints();
    const byWorkspace = new Map();
    for (const checkpoint of rows) {
      const list = byWorkspace.get(checkpoint.workspace_id) || [];
      list.push(checkpoint);
      byWorkspace.set(checkpoint.workspace_id, list); // already newest first
    }
    const protectedBefore = now - budget.checkpoints.protectHours * HOUR;
    const marked = new Set();
    const sizeOf = new Map();
    const measureCheckpoint = async (checkpoint) => {
      if (!sizeOf.has(checkpoint.id)) {
        const dir = this.workspaceManager.checkpointStorageDir(checkpoint);
        sizeOf.set(checkpoint.id, dir ? await directorySize(dir) : 0);
      }
      return sizeOf.get(checkpoint.id);
    };
    const mark = async (checkpoint, reason) => {
      if (marked.has(checkpoint.id)) return;
      marked.add(checkpoint.id);
      actions.push({ type: 'checkpoint', id: checkpoint.id, workspaceId: checkpoint.workspace_id, reason, bytes: await measureCheckpoint(checkpoint), at: checkpoint.created_at, checkpoint });
    };
    const protectedCheckpoint = (checkpoint, index) => index === 0 || Date.parse(checkpoint.created_at) > protectedBefore;

    // 1. Checkpoints past their age or count.
    for (const list of byWorkspace.values()) {
      for (const [index, checkpoint] of list.entries()) {
        if (protectedCheckpoint(checkpoint, index)) continue;
        if (index >= budget.checkpoints.keepPerWorkspace) await mark(checkpoint, `beyond the newest ${budget.checkpoints.keepPerWorkspace} for its workspace`);
        else if (now - Date.parse(checkpoint.created_at) > budget.checkpoints.maxAgeDays * DAY) await mark(checkpoint, `older than ${budget.checkpoints.maxAgeDays} days`);
      }
    }
    // 2. Still over the checkpoint share: oldest first, across workspaces.
    let held = 0;
    for (const checkpoint of rows) if (!marked.has(checkpoint.id)) held += await measureCheckpoint(checkpoint);
    if (held > budget.share.checkpoints) {
      for (const checkpoint of [...rows].reverse()) {
        if (held <= budget.share.checkpoints) break;
        const list = byWorkspace.get(checkpoint.workspace_id);
        if (marked.has(checkpoint.id) || protectedCheckpoint(checkpoint, list.indexOf(checkpoint))) continue;
        await mark(checkpoint, 'checkpoints exceed their share of the budget');
        held -= await measureCheckpoint(checkpoint);
      }
    }
    // 3. Directories under checkpoints/ that no checkpoint row owns (a removed workspace, a crashed run).
    const known = new Set(rows.map((checkpoint) => this.workspaceManager.checkpointStorageDir(checkpoint)).filter(Boolean).map((dir) => path.resolve(dir)));
    const root = path.join(home, 'checkpoints');
    for (const entry of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (known.has(path.resolve(full))) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || now - stat.mtimeMs < DAY) continue; // may belong to a checkpoint being written right now
      actions.push({ type: 'orphan-checkpoint', path: full, reason: 'not referenced by any checkpoint', bytes: await directorySize(full), at: stat.mtime.toISOString() });
    }

    // 4. Search indexes: for folders that are gone, folders not opened lately, then (if still over) least recently opened.
    const indexed = this.store.indexedWorkspaces();
    const staleBefore = now - budget.index.staleDays * DAY;
    const indexMarked = new Set();
    for (const workspace of indexed) {
      const missing = !(await fsp.stat(workspace.path).catch(() => null));
      const opened = Date.parse(workspace.last_opened_at);
      if (missing) { indexMarked.add(workspace.id); actions.push(this.#indexAction(workspace, budget, 'its folder no longer exists')); }
      else if (opened < staleBefore) { indexMarked.add(workspace.id); actions.push(this.#indexAction(workspace, budget, `not opened for ${budget.index.staleDays} days`)); }
    }
    const indexCap = budget.share.index / budget.index.overheadFactor;
    let indexText = indexed.filter((workspace) => !indexMarked.has(workspace.id)).reduce((sum, workspace) => sum + workspace.text_bytes, 0);
    for (const workspace of indexed) { // oldest-opened first
      if (indexText <= indexCap) break;
      if (indexMarked.has(workspace.id) || now - Date.parse(workspace.last_opened_at) < DAY) continue;
      indexMarked.add(workspace.id);
      indexText -= workspace.text_bytes;
      actions.push(this.#indexAction(workspace, budget, 'search indexes exceed their share of the budget'));
    }

    // 5. Run events (tool outputs and streamed deltas; the runs and chats themselves stay).
    const eventCutoff = new Date(now - budget.runEventDays * DAY).toISOString();
    const stale = this.store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(payload)), 0) AS bytes FROM run_events WHERE created_at < ?').get(eventCutoff);
    if (Number(stale.n)) actions.push({ type: 'run-events', before: eventCutoff, reason: `older than ${budget.runEventDays} days`, count: Number(stale.n), bytes: Number(stale.bytes) });

    // 6. Logs.
    for (const [which, file] of [['log', this.config.get().logFile], ['audit', this.config.get().auditFile]]) {
      const size = await fileSize(file);
      if (size > budget.logs.maxBytes) actions.push({ type: 'rotate-log', which, path: file, reason: `larger than ${formatBytes(budget.logs.maxBytes)}`, bytes: 0, currentBytes: size });
    }

    const reclaimable = actions.reduce((sum, action) => sum + (action.bytes || 0), 0);
    return { actions, reclaimableBytes: reclaimable, pressure: budget.pressure };
  }

  #indexAction(workspace, budget, reason) {
    return {
      type: 'index', workspaceId: workspace.id, name: workspace.name, path: workspace.path, chunks: workspace.chunks,
      reason, bytes: Math.round(workspace.text_bytes * budget.index.overheadFactor), at: workspace.last_opened_at,
    };
  }

  // ------------------------------------------------------------------- prune

  /** Carry out the plan (or just report it with `dryRun`). Re-entrant calls share one run. */
  prune({ dryRun = false } = {}) {
    if (this.running && !dryRun) return this.running;
    const task = this.#prune({ dryRun }).finally(() => { if (!dryRun) this.running = null; });
    if (!dryRun) this.running = task;
    return task;
  }

  async #prune({ dryRun }) {
    const plan = await this.plan();
    const done = [];
    let freed = 0;
    const failures = [];
    if (!dryRun) {
      for (const action of plan.actions) {
        try {
          if (action.type === 'checkpoint') {
            freed += await this.workspaceManager.removeCheckpointArtifacts(action.checkpoint);
            this.store.deleteCheckpoint(action.id);
          } else if (action.type === 'orphan-checkpoint') {
            await fsp.rm(action.path, { recursive: true, force: true });
            freed += action.bytes;
          } else if (action.type === 'index') {
            this.store.dropWorkspaceIndex(action.workspaceId);
            freed += action.bytes;
          } else if (action.type === 'run-events') {
            this.store.pruneRunEvents(action.before);
            freed += action.bytes;
          } else if (action.type === 'rotate-log') {
            const logger = this.logger;
            const budget = await this.budget();
            await logger.rotate(action.which, { maxBytes: budget.logs.maxBytes, keep: action.which === 'audit' ? 8 : budget.logs.keep });
          }
          done.push(action);
        } catch (error) {
          failures.push({ action: action.type, id: action.id || action.path || action.workspaceId, error: error.message });
        }
      }
      try { this.store.compact(); } catch (error) { failures.push({ action: 'compact', error: error.message }); }
      this.lastRun = Date.now();
      this.cached = null;
      this.logger.audit('storage.prune', { actions: done.length, freedBytes: freed, failures: failures.length });
      this.eventBus.emit('storage.pruned', { actions: done.length, freedBytes: freed, failures });
    }
    const summary = {};
    for (const action of dryRun ? plan.actions : done) summary[action.type] = (summary[action.type] || 0) + 1;
    return {
      dryRun, pressure: plan.pressure, summary,
      freedBytes: dryRun ? 0 : freed, wouldFreeBytes: dryRun ? plan.reclaimableBytes : 0,
      actions: (dryRun ? plan.actions : done).map(({ checkpoint, ...rest }) => rest), failures,
    };
  }

  // ------------------------------------------------------------------ vacuum

  /** Rebuild the database file so deleted space returns to the disk and future deletions do too. */
  async vacuum() {
    const info = this.store.dbInfo();
    const size = (await fileSize(this.config.get().dataFile));
    const free = (await probeHost(this.config.get().home)).diskFree;
    // VACUUM writes a full copy before it replaces the original.
    if (free && free < size * 1.15 + 64 * 1024 ** 2) {
      throw new Error(`Not enough free disk to compact safely: need about ${formatBytes(size * 1.15)}, have ${formatBytes(free)}. Run "maskshift storage prune" first or free some space.`);
    }
    const before = size + (await fileSize(`${this.config.get().dataFile}-wal`));
    this.store.vacuumFull();
    const after = (await fileSize(this.config.get().dataFile)) + (await fileSize(`${this.config.get().dataFile}-wal`));
    this.cached = null;
    this.logger.audit('storage.vacuum', { beforeBytes: before, afterBytes: after });
    return { beforeBytes: before, afterBytes: after, freedBytes: Math.max(0, before - after), autoVacuumWas: info.autoVacuum, autoVacuumNow: this.store.dbInfo().autoVacuum };
  }

  // -------------------------------------------------------------- scheduling

  /** Quietly keep things in bounds: shortly after start, every few hours, and after a run (at most every 15 minutes). */
  start() {
    if (this.settings().auto === false || this.timers.length) return;
    this.syncBudget();
    this.timers.push(setTimeout(() => void this.maintain('startup'), 10_000));
    this.timers.push(setInterval(() => void this.maintain('interval'), 6 * HOUR));
    for (const timer of this.timers) timer.unref?.();
    this.unsubscribe = this.eventBus.subscribe((event) => {
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type) && Date.now() - this.lastRun > MIN_GAP_MS) void this.maintain('run');
    });
  }

  /** Warm the synchronous limits the indexer and checkpointer read. */
  async syncBudget() {
    try { await this.budget({ fresh: true }); } catch (error) { this.logger.warn(`Storage budget unavailable: ${error.message}`); }
  }

  async maintain(reason = 'manual') {
    if (this.running || this.settings().auto === false) return null;
    try {
      const status = await this.status();
      const needs = status.overBudget.total || status.overBudget.checkpoints || status.pressure === 'critical' || status.pressure === 'tight';
      let result = null;
      // Over budget or short of disk: prune. Otherwise only the cheap, always-safe parts (old events, logs, WAL).
      result = await this.prune({ dryRun: false });
      this.lastRun = Date.now();
      const after = await this.status();
      const warning = after.advice.filter((line) => !line.includes('storage vacuum')).join(' ');
      if (warning && warning !== this.lastWarning) {
        this.lastWarning = warning;
        this.eventBus.emit('storage.warning', { message: warning, pressure: after.pressure, usage: after.usage, budget: after.budget.total, reason });
        this.logger.warn(`Storage: ${warning}`);
      } else if (!warning) this.lastWarning = '';
      return { needs, result };
    } catch (error) {
      this.logger.warn(`Storage maintenance failed: ${error.message}`);
      return null;
    }
  }

  async close() {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    try { await this.running; } catch { /* reported when it ran */ }
  }
}
