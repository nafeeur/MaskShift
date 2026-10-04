import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { truncate } from '../core/utils.mjs';
import { chunkFile, fileList, language, ollamaEmbed, prioritise, shouldIndex } from './scan.mjs';

const WORKER_PATH = fileURLToPath(new URL('./index-worker.mjs', import.meta.url));

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function fuseResults(ftsHits, semanticHits, limit) {
  const RRF_K = 60;
  const scores = new Map();
  const byId = new Map();
  const accumulate = (hits) => hits.forEach((hit, index) => {
    if (!byId.has(hit.id)) byId.set(hit.id, hit);
    scores.set(hit.id, (scores.get(hit.id) || 0) + 1 / (RRF_K + index + 1));
  });
  accumulate(ftsHits);
  accumulate(semanticHits);
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([chunkId, score]) => ({ ...byId.get(chunkId), fusedScore: score }));
}

export class RepositoryIndexer {
  constructor({ store, workspaceManager, config, logger, eventBus }) {
    this.store = store;
    this.workspaceManager = workspaceManager;
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.running = new Map();
    // Set by the runtime once the storage budget exists: () => { maxFiles, maxTextBytes, maxFileBytes }.
    this.limits = null;
  }

  // Kept as instance methods — code-graph.mjs calls these directly to reuse
  // the same "what counts as source, what doesn't" rules for its own walk.
  language(file) { return language(file); }

  shouldIndex(relative, size) { return shouldIndex(relative, size); }

  fileList(root) { return fileList(root); }

  prioritise(files) { return prioritise(files); }

  chunkFile(relative, content) { return chunkFile(relative, content); }

  async index(workspaceId, { force = false } = {}) {
    if (this.running.has(workspaceId)) return this.running.get(workspaceId);
    const task = Promise.resolve(this.prepareLimits?.()).catch(() => {}).then(() => this.#runIndex(workspaceId, { force })).finally(() => this.running.delete(workspaceId));
    this.running.set(workspaceId, task);
    return task;
  }

  // Runs the walk/stat/read/hash/chunk/embed work in index-worker.mjs, off
  // this thread, so scanning a large repository doesn't stall the TUI's own
  // repaint loop (or anything else sharing this process) for the duration.
  #runIndex(workspaceId) {
    const workspace = this.workspaceManager.get(workspaceId);
    this.eventBus.emit('index.started', { path: workspace.path }, { workspaceId });
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: {
          dbFile: this.store.file,
          workspaceId,
          workspacePath: workspace.path,
          indexing: this.config.get().indexing || {},
          ollamaBaseUrl: this.ollamaBaseUrl(),
          limits: this.limits?.() || {},
        },
      });
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          this.eventBus.emit('index.progress', message.payload, { workspaceId });
          return;
        }
        if (message.type === 'done') {
          this.logger.info('Repository index completed', { workspaceId, ...message.payload });
          if (message.payload.truncated) this.logger.warn(`Repository index stopped at its ${message.payload.truncated.reason}; ${message.payload.truncated.skipped} files were not indexed`, { workspaceId });
          this.eventBus.emit('index.completed', message.payload, { workspaceId });
          resolve(message.payload);
        } else if (message.type === 'error') {
          reject(Object.assign(new Error(message.payload.message), { stack: message.payload.stack }));
        }
        void worker.terminate();
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Index worker exited with code ${code}`));
      });
    });
  }

  embedModel() {
    return this.config.get().indexing?.embedModel || 'nomic-embed-text';
  }

  ollamaBaseUrl() {
    return this.config.get().providers.find((provider) => provider.id === 'ollama')?.baseUrl || null;
  }

  async search(workspaceId, query, limit = 20) {
    const ftsHits = this.store.searchRepo(workspaceId, query, Math.max(limit, 40));
    const model = this.embedModel();
    const embeddingStats = this.store.embeddingStats(workspaceId, model);
    const baseUrl = this.ollamaBaseUrl();
    if (this.config.get().indexing?.embeddings === false || !embeddingStats?.embedded || !baseUrl) {
      return ftsHits.slice(0, limit);
    }
    let queryVector;
    try {
      [queryVector] = await ollamaEmbed(baseUrl, model, [query], { timeoutMs: 10_000 });
    } catch {
      return ftsHits.slice(0, limit);
    }
    const semanticHits = this.store.chunksWithEmbeddings(workspaceId, model)
      .map((row) => ({ ...row, score: cosineSimilarity(queryVector, JSON.parse(row.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit, 40));
    const semanticScores = new Map(semanticHits.map((hit) => [hit.id, hit.score]));
    return fuseResults(ftsHits, semanticHits, limit).map((hit) => ({ ...hit, semanticScore: semanticScores.get(hit.id) ?? null }));
  }

  stats(workspaceId) {
    const base = this.store.repoIndexStats(workspaceId);
    const model = this.embedModel();
    const embeddingStats = this.store.embeddingStats(workspaceId, model);
    return {
      ...base,
      embeddingModel: model,
      embeddedChunks: embeddingStats?.embedded || 0,
      semanticSearchAvailable: Boolean(embeddingStats?.embedded),
    };
  }

  async contextFor(workspaceId, prompt, { limit = 12, maxChars = 90_000 } = {}) {
    const hits = await this.search(workspaceId, prompt, limit);
    let used = 0;
    const selected = [];
    for (const hit of hits) {
      if (used >= maxChars) break;
      const text = truncate(hit.content, Math.min(20_000, maxChars - used));
      selected.push({ path: hit.path, startLine: hit.start_line, endLine: hit.end_line, language: hit.language, content: text, semanticScore: hit.semanticScore ?? null });
      used += text.length;
    }
    return selected;
  }
}
