import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ensureDir, id, nowIso, safeJsonParse } from './utils.mjs';

function plain(row) {
  return row ? { ...row } : null;
}

function parseFields(row, fields = []) {
  if (!row) return null;
  const result = plain(row);
  for (const field of fields) {
    if (field in result && typeof result[field] === 'string') result[field] = safeJsonParse(result[field], result[field]);
  }
  return result;
}

function ftsQuery(query) {
  const tokens = String(query || '')
    .toLowerCase()
    .match(/[a-z0-9_+#.:-]{2,}/g) || [];
  return tokens.slice(0, 20).map((token) => `"${token.replaceAll('"', '""')}"*`).join(' OR ') || '""';
}

export class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  async init() {
    await ensureDir(path.dirname(this.file));
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        title TEXT NOT NULL,
        model_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model_id TEXT,
        step_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_started ON runs(session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        scope TEXT NOT NULL DEFAULT 'workspace',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        workspace_id UNINDEXED,
        title,
        content,
        tags,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS repo_chunks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        embedding TEXT,
        embedding_model TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_repo_chunks_workspace_path ON repo_chunks(workspace_id, path);

      CREATE VIRTUAL TABLE IF NOT EXISTS repo_fts USING fts5(
        chunk_id UNINDEXED,
        workspace_id UNINDEXED,
        path,
        language,
        content,
        tokenize = 'porter unicode61 tokenchars ''_+#.'''
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        ref TEXT,
        manifest TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);
    `);
    for (const statement of [
      'ALTER TABLE repo_chunks ADD COLUMN embedding TEXT',
      'ALTER TABLE repo_chunks ADD COLUMN embedding_model TEXT',
    ]) {
      try { this.db.exec(statement); } catch { /* column already present on an existing database */ }
    }
    return this;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertWorkspace(workspacePath, name = path.basename(workspacePath), meta = {}) {
    const existing = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(workspacePath);
    const timestamp = nowIso();
    if (existing) {
      this.db.prepare('UPDATE workspaces SET name = ?, last_opened_at = ?, meta = ? WHERE id = ?')
        .run(name, timestamp, JSON.stringify(meta), existing.id);
      return this.getWorkspace(existing.id);
    }
    const workspace = {
      id: id('ws'), name, path: workspacePath, created_at: timestamp, last_opened_at: timestamp, meta,
    };
    this.db.prepare('INSERT INTO workspaces(id, name, path, created_at, last_opened_at, meta) VALUES(?, ?, ?, ?, ?, ?)')
      .run(workspace.id, workspace.name, workspace.path, workspace.created_at, workspace.last_opened_at, JSON.stringify(meta));
    return workspace;
  }

  listWorkspaces() {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC').all().map((row) => parseFields(row, ['meta']));
  }

  getWorkspace(workspaceId) {
    return parseFields(this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId), ['meta']);
  }

  getWorkspaceByPath(workspacePath) {
    return parseFields(this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(workspacePath), ['meta']);
  }

  touchWorkspace(workspaceId) {
    this.db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(nowIso(), workspaceId);
  }

  createSession({ workspaceId, title = 'New run', modelId = null, meta = {} } = {}) {
    const timestamp = nowIso();
    const session = {
      id: id('ses'), workspace_id: workspaceId || null, title, model_id: modelId,
      status: 'idle', created_at: timestamp, updated_at: timestamp, meta,
    };
    this.db.prepare(`INSERT INTO sessions(id, workspace_id, title, model_id, status, created_at, updated_at, meta)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.workspace_id, session.title, session.model_id, session.status,
        session.created_at, session.updated_at, JSON.stringify(meta));
    return session;
  }

  updateSession(sessionId, patch = {}) {
    const allowed = ['title', 'model_id', 'status', 'workspace_id'];
    const pairs = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if ('meta' in patch) pairs.push(['meta', JSON.stringify(patch.meta)]);
    pairs.push(['updated_at', nowIso()]);
    const sql = `UPDATE sessions SET ${pairs.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...pairs.map(([, value]) => value), sessionId);
    return this.getSession(sessionId);
  }

  getSession(sessionId) {
    return parseFields(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId), ['meta']);
  }

  listSessions({ workspaceId, limit = 100 } = {}) {
    const rows = workspaceId
      ? this.db.prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?').all(workspaceId, limit)
      : this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
    return rows.map((row) => parseFields(row, ['meta']));
  }

  deleteSession(sessionId) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  addMessage({ sessionId, role, content = '', meta = {} }) {
    const message = { id: id('msg'), session_id: sessionId, role, content, created_at: nowIso(), meta };
    this.db.prepare('INSERT INTO messages(id, session_id, role, content, created_at, meta) VALUES(?, ?, ?, ?, ?, ?)')
      .run(message.id, sessionId, role, content, message.created_at, JSON.stringify(meta));
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(message.created_at, sessionId);
    return message;
  }

  listMessages(sessionId, limit = 1000) {
    return this.db.prepare(`SELECT * FROM (
      SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
    ) ORDER BY created_at ASC`).all(sessionId, limit).map((row) => parseFields(row, ['meta']));
  }

  createRun({ sessionId, workspaceId, prompt, modelId, meta = {} }) {
    const run = {
      id: id('run'), session_id: sessionId, workspace_id: workspaceId || null, status: 'queued',
      prompt, model_id: modelId, step_count: 0, started_at: nowIso(), ended_at: null, error: null, meta,
    };
    this.db.prepare(`INSERT INTO runs(id, session_id, workspace_id, status, prompt, model_id, step_count, started_at, ended_at, error, meta)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.session_id, run.workspace_id, run.status, run.prompt, run.model_id, run.step_count,
        run.started_at, null, null, JSON.stringify(meta));
    return run;
  }

  updateRun(runId, patch = {}) {
    const allowed = ['status', 'model_id', 'step_count', 'ended_at', 'error'];
    const pairs = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if ('meta' in patch) pairs.push(['meta', JSON.stringify(patch.meta)]);
    if (!pairs.length) return this.getRun(runId);
    this.db.prepare(`UPDATE runs SET ${pairs.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...pairs.map(([, value]) => value), runId);
    return this.getRun(runId);
  }

  getRun(runId) {
    return parseFields(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId), ['meta']);
  }

  listRuns({ sessionId, limit = 100 } = {}) {
    const rows = sessionId
      ? this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?').all(sessionId, limit)
      : this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
    return rows.map((row) => parseFields(row, ['meta']));
  }

  addRunEvent(runId, type, payload = {}) {
    const event = { id: id('rev'), run_id: runId, type, payload, created_at: nowIso() };
    this.db.prepare('INSERT INTO run_events(id, run_id, type, payload, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(event.id, runId, type, JSON.stringify(payload), event.created_at);
    return event;
  }

  listRunEvents(runId, limit = 2000) {
    return this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(runId, limit).map((row) => parseFields(row, ['payload']));
  }

  saveMemory({ id: memoryId, workspaceId = null, scope = 'workspace', title, content, tags = [], importance = 0.5, meta = {} }) {
    const existing = memoryId ? this.db.prepare('SELECT id, created_at FROM memories WHERE id = ?').get(memoryId) : null;
    const memory = {
      id: existing?.id || id('mem'), workspace_id: workspaceId, scope, title, content, tags,
      importance, created_at: existing?.created_at || nowIso(), updated_at: nowIso(), meta,
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO memories(id, workspace_id, scope, title, content, tags, importance, created_at, updated_at, meta)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, scope=excluded.scope, title=excluded.title,
          content=excluded.content, tags=excluded.tags, importance=excluded.importance, updated_at=excluded.updated_at, meta=excluded.meta`)
        .run(memory.id, memory.workspace_id, memory.scope, memory.title, memory.content, JSON.stringify(tags), importance,
          memory.created_at, memory.updated_at, JSON.stringify(meta));
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memory.id);
      this.db.prepare('INSERT INTO memory_fts(memory_id, workspace_id, title, content, tags) VALUES(?, ?, ?, ?, ?)')
        .run(memory.id, workspaceId || '', title, content, tags.join(' '));
    });
    return memory;
  }

  getMemory(memoryId) {
    return parseFields(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId), ['tags', 'meta']);
  }

  listMemories({ workspaceId, scope, limit = 200 } = {}) {
    const clauses = [];
    const args = [];
    if (workspaceId) { clauses.push('(workspace_id = ? OR scope = \'global\')'); args.push(workspaceId); }
    if (scope) { clauses.push('scope = ?'); args.push(scope); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM memories ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
      .all(...args, limit).map((row) => parseFields(row, ['tags', 'meta']));
  }

  searchMemories(query, { workspaceId, limit = 12 } = {}) {
    if (!String(query || '').trim()) return this.listMemories({ workspaceId, limit });
    const match = ftsQuery(query);
    try {
      const rows = workspaceId
        ? this.db.prepare(`SELECT memory_id, bm25(memory_fts) AS rank, snippet(memory_fts, 3, '<b>', '</b>', ' … ', 24) AS snippet
            FROM memory_fts WHERE memory_fts MATCH ? AND (workspace_id = ? OR workspace_id = '') ORDER BY rank LIMIT ?`)
          .all(match, workspaceId, limit)
        : this.db.prepare(`SELECT memory_id, bm25(memory_fts) AS rank, snippet(memory_fts, 3, '<b>', '</b>', ' … ', 24) AS snippet
            FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit);
      return rows.map((row) => ({ ...this.getMemory(row.memory_id), rank: row.rank, snippet: row.snippet }));
    } catch {
      return this.listMemories({ workspaceId, limit }).filter((item) =>
        `${item.title} ${item.content} ${(item.tags || []).join(' ')}`.toLowerCase().includes(String(query).toLowerCase()));
    }
  }

  deleteMemory(memoryId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
    });
  }

  replaceRepoChunks(workspaceId, chunks) {
    return this.transaction(() => {
      const reusable = new Map(
        this.db.prepare('SELECT content_hash, embedding, embedding_model FROM repo_chunks WHERE workspace_id = ? AND embedding IS NOT NULL')
          .all(workspaceId).map((row) => [row.content_hash, { embedding: row.embedding, model: row.embedding_model }]),
      );
      this.db.prepare('DELETE FROM repo_chunks WHERE workspace_id = ?').run(workspaceId);
      this.db.prepare('DELETE FROM repo_fts WHERE workspace_id = ?').run(workspaceId);
      const insertChunk = this.db.prepare(`INSERT INTO repo_chunks(id, workspace_id, path, language, start_line, end_line, content, content_hash, indexed_at, embedding, embedding_model)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertFts = this.db.prepare('INSERT INTO repo_fts(chunk_id, workspace_id, path, language, content) VALUES(?, ?, ?, ?, ?)');
      const pending = [];
      for (const chunk of chunks) {
        const reused = reusable.get(chunk.contentHash);
        insertChunk.run(chunk.id, workspaceId, chunk.path, chunk.language || '', chunk.startLine, chunk.endLine,
          chunk.content, chunk.contentHash, chunk.indexedAt, reused?.embedding ?? null, reused?.model ?? null);
        insertFts.run(chunk.id, workspaceId, chunk.path, chunk.language || '', chunk.content);
        if (!reused) pending.push({ id: chunk.id, content: chunk.content });
      }
      return { pending };
    });
  }

  searchRepo(workspaceId, query, limit = 20) {
    const match = ftsQuery(query);
    try {
      const rows = this.db.prepare(`SELECT chunk_id, path, language, bm25(repo_fts) AS rank,
          snippet(repo_fts, 4, '⟦', '⟧', ' … ', 36) AS snippet
        FROM repo_fts WHERE repo_fts MATCH ? AND workspace_id = ? ORDER BY rank LIMIT ?`)
        .all(match, workspaceId, limit);
      const statement = this.db.prepare('SELECT * FROM repo_chunks WHERE id = ?');
      return rows.map((row) => ({ ...plain(statement.get(row.chunk_id)), rank: row.rank, snippet: row.snippet }));
    } catch {
      return [];
    }
  }

  setChunkEmbedding(chunkId, model, embeddingText) {
    this.db.prepare('UPDATE repo_chunks SET embedding = ?, embedding_model = ? WHERE id = ?').run(embeddingText, model, chunkId);
  }

  chunksWithEmbeddings(workspaceId, model) {
    return this.db.prepare(`SELECT id, path, language, start_line, end_line, content, embedding
      FROM repo_chunks WHERE workspace_id = ? AND embedding IS NOT NULL AND embedding_model = ?`)
      .all(workspaceId, model).map(plain);
  }

  embeddingStats(workspaceId, model) {
    return plain(this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END) AS embedded
      FROM repo_chunks WHERE workspace_id = ?`).get(model, workspaceId));
  }

  repoIndexStats(workspaceId) {
    return plain(this.db.prepare(`SELECT COUNT(*) AS chunks, COUNT(DISTINCT path) AS files,
      COALESCE(SUM(length(content)), 0) AS characters, MAX(indexed_at) AS indexed_at
      FROM repo_chunks WHERE workspace_id = ?`).get(workspaceId));
  }

  saveCheckpoint({ workspaceId, runId = null, kind, ref = null, manifest = {} }) {
    const checkpoint = { id: id('cp'), workspace_id: workspaceId, run_id: runId, kind, ref, manifest, created_at: nowIso() };
    this.db.prepare('INSERT INTO checkpoints(id, workspace_id, run_id, kind, ref, manifest, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(checkpoint.id, workspaceId, runId, kind, ref, JSON.stringify(manifest), checkpoint.created_at);
    return checkpoint;
  }

  listCheckpoints(workspaceId, limit = 100) {
    return this.db.prepare('SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(workspaceId, limit).map((row) => parseFields(row, ['manifest']));
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), nowIso());
    return value;
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? safeJsonParse(row.value, fallback) : fallback;
  }

  saveAutomation(input = {}) {
    const automationId = input.id ?? null;
    const timestamp = nowIso();
    const existing = automationId ? this.db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) : null;
    const has = (...keys) => keys.some((key) => Object.hasOwn(input, key));
    const value = (keys, fallback = null) => {
      for (const key of keys) if (Object.hasOwn(input, key)) return input[key];
      return fallback;
    };
    const workspaceId = value(['workspaceId', 'workspace_id'], existing?.workspace_id ?? null);
    const enabled = has('enabled') ? Boolean(input.enabled) : existing ? Boolean(existing.enabled) : true;
    const schedule = value(['schedule'], existing ? safeJsonParse(existing.schedule, null) : null);
    const action = value(['action'], existing ? safeJsonParse(existing.action, null) : null);
    const nextRunAt = value(['nextRunAt', 'next_run_at'], existing?.next_run_at ?? null);
    const lastRunAt = value(['lastRunAt', 'last_run_at'], existing?.last_run_at ?? null);
    const lastStatus = value(['lastStatus', 'last_status'], existing?.last_status ?? null);
    const meta = value(['meta'], existing ? safeJsonParse(existing.meta, {}) : {});
    const automation = {
      id: existing?.id || id('auto'), workspace_id: workspaceId,
      name: input.name ?? existing?.name ?? 'Automation', enabled: enabled ? 1 : 0,
      schedule, action, next_run_at: nextRunAt, last_run_at: lastRunAt,
      last_status: lastStatus, created_at: existing?.created_at || timestamp,
      updated_at: timestamp, meta,
    };
    this.db.prepare(`INSERT INTO automations(id, workspace_id, name, enabled, schedule, action, next_run_at, last_run_at, last_status, created_at, updated_at, meta)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, name=excluded.name, enabled=excluded.enabled,
        schedule=excluded.schedule, action=excluded.action, next_run_at=excluded.next_run_at,
        last_run_at=excluded.last_run_at, last_status=excluded.last_status, updated_at=excluded.updated_at, meta=excluded.meta`)
      .run(automation.id, automation.workspace_id, automation.name, automation.enabled, JSON.stringify(schedule), JSON.stringify(action),
        automation.next_run_at, automation.last_run_at, automation.last_status, automation.created_at, automation.updated_at, JSON.stringify(meta));
    return this.getAutomation(automation.id);
  }

  getAutomation(automationId) {
    const row = parseFields(this.db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId), ['schedule', 'action', 'meta']);
    if (row) row.enabled = Boolean(row.enabled);
    return row;
  }

  listAutomations({ workspaceId, enabled, limit = 500 } = {}) {
    const clauses = [];
    const args = [];
    if (workspaceId) { clauses.push('workspace_id = ?'); args.push(workspaceId); }
    if (enabled !== undefined) { clauses.push('enabled = ?'); args.push(enabled ? 1 : 0); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM automations ${where} ORDER BY enabled DESC, next_run_at ASC, updated_at DESC LIMIT ?`)
      .all(...args, limit).map((row) => { const item = parseFields(row, ['schedule', 'action', 'meta']); item.enabled = Boolean(item.enabled); return item; });
  }

  listDueAutomations(at = nowIso(), limit = 20) {
    return this.db.prepare(`SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC LIMIT ?`).all(at, limit)
      .map((row) => { const item = parseFields(row, ['schedule', 'action', 'meta']); item.enabled = Boolean(item.enabled); return item; });
  }

  updateAutomation(automationId, patch = {}) {
    const current = this.getAutomation(automationId);
    if (!current) return null;
    return this.saveAutomation({ id: automationId, ...patch });
  }

  deleteAutomation(automationId) {
    this.db.prepare('DELETE FROM automations WHERE id = ?').run(automationId);
  }

  close() {
    this.db?.close();
  }
}
