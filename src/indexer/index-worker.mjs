// Runs RepositoryIndexer's full-repository walk off the main thread — see
// repository-indexer.mjs's #runIndex(), which used to do this file-by-file
// stat/read/hash/chunk work inline and block whatever else Node was doing,
// including the TUI's own repaint loop, for the whole scan on a large repo.
//
// Opens its own connection to the same SQLite file rather than sharing the
// main thread's: node:sqlite's DatabaseSync isn't transferable across
// threads, and the database is already in WAL mode (see store.mjs's init())
// specifically so a second writer here doesn't need anything more than the
// busy_timeout it's already configured with.

import { parentPort, workerData } from 'node:worker_threads';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../core/store.mjs';
import { id, nowIso, sha256, truncate } from '../core/utils.mjs';
import { chunkFile, fileList, language, ollamaEmbed, shouldIndex } from './scan.mjs';

const { dbFile, workspaceId, workspacePath, indexing, ollamaBaseUrl } = workerData;

async function embedPending(store, pending) {
  if (indexing.embeddings === false || !pending?.length || !ollamaBaseUrl) return { embeddedChunks: 0, embedAttempted: 0 };
  const model = indexing.embedModel || 'nomic-embed-text';
  const batchSize = indexing.embedBatchSize || 32;
  const items = pending.slice(0, indexing.embedMaxChunks || 4000);
  let embeddedChunks = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    try {
      const vectors = await ollamaEmbed(ollamaBaseUrl, model, batch.map((item) => truncate(item.content, 8000)));
      vectors.forEach((vector, index) => {
        store.setChunkEmbedding(batch[index].id, model, JSON.stringify(vector.map((value) => Math.round(value * 1e6) / 1e6)));
        embeddedChunks += 1;
      });
    } catch {
      break; // Leaves the remaining chunks on lexical-only search, same as the old inline path.
    }
  }
  return { embeddedChunks, embedAttempted: items.length };
}

async function run() {
  const store = new Store(dbFile);
  await store.init();
  try {
    const started = Date.now();
    const files = await fileList(workspacePath);
    const chunks = [];
    let scanned = 0;
    let indexedFiles = 0;

    for (const relative of files.slice(0, 100_000)) {
      scanned += 1;
      const full = path.join(workspacePath, relative);
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (!stat.isFile() || !shouldIndex(relative, stat.size)) continue;
      let buffer;
      try { buffer = await fsp.readFile(full); } catch { continue; }
      if (buffer.includes(0)) continue;
      const content = buffer.toString('utf8');
      if (!content.trim()) continue;
      indexedFiles += 1;
      const lang = language(relative);
      for (const chunk of chunkFile(relative, content)) {
        chunks.push({
          id: id('chunk'),
          path: relative,
          language: lang,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: truncate(chunk.content, 80_000),
          contentHash: sha256(chunk.content),
          indexedAt: nowIso(),
        });
      }
      if (indexedFiles % 100 === 0) {
        parentPort.postMessage({ type: 'progress', payload: { scanned, indexedFiles, chunks: chunks.length, totalFiles: files.length } });
      }
    }

    const { pending } = store.replaceRepoChunks(workspaceId, chunks);
    const embedding = await embedPending(store, pending);
    const stats = { scanned, indexedFiles, chunks: chunks.length, durationMs: Date.now() - started, ...embedding };
    parentPort.postMessage({ type: 'done', payload: stats });
  } catch (error) {
    parentPort.postMessage({ type: 'error', payload: { message: error?.message || String(error), stack: error?.stack } });
  } finally {
    store.close();
  }
}

run();
