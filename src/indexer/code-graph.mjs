import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, sha256 } from '../core/utils.mjs';

const DEF_PATTERNS = [
  { kind: 'class', pattern: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^\s*(?:export\s+)?(?:type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: 'function', pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
];

const IMPORT_PATTERNS = [
  /\b(?:import|export)\b[^'"\n]*\bfrom\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+([A-Za-z0-9_./-]+)/gm,
  /^\s*from\s+([A-Za-z0-9_./-]+)\s+import\s+/gm,
  /^\s*use\s+([A-Za-z0-9_:]+)/gm,
];

const CALL_PATTERN = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const CALL_EXCLUSIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'sizeof', 'new', 'super', 'describe', 'it', 'test']);

function nodeId(workspaceId, kind, file, name = '') {
  return `cgn_${sha256(`${workspaceId}:${kind}:${file}:${name}`).slice(0, 24)}`;
}

function edgeId(workspaceId, kind, sourceId, targetId) {
  return `cge_${sha256(`${workspaceId}:${kind}:${sourceId}:${targetId}`).slice(0, 24)}`;
}

function resolveImport(sourcePath, specifier, knownFiles) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [base, ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rs', '.go'].map((ext) => `${base}${ext}`),
    ...['index.js', 'index.mjs', 'index.ts', 'index.tsx', '__init__.py'].map((name) => path.posix.join(base, name))];
  return candidates.find((candidate) => knownFiles.has(candidate)) || null;
}

function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9_$.-]{2,}/g) || []);
}

export class CodeGraph {
  constructor({ store, workspaceManager, indexer, eventBus, logger }) {
    this.store = store;
    this.workspaceManager = workspaceManager;
    this.indexer = indexer;
    this.eventBus = eventBus;
    this.logger = logger;
    this.running = new Map();
  }

  stats(workspaceId) { return this.store.codeGraphStats(workspaceId); }

  async build(workspaceId) {
    if (this.running.has(workspaceId)) return this.running.get(workspaceId);
    const task = this.#build(workspaceId).finally(() => this.running.delete(workspaceId));
    this.running.set(workspaceId, task);
    return task;
  }

  async #build(workspaceId) {
    const workspace = this.workspaceManager.get(workspaceId);
    const started = Date.now();
    this.eventBus.emit('code-graph.started', { path: workspace.path }, { workspaceId });
    const files = await this.indexer.fileList(workspace.path);
    const records = [];
    for (const relativeRaw of files.slice(0, 100_000)) {
      const relative = relativeRaw.split(path.sep).join('/');
      const full = path.join(workspace.path, relativeRaw);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat?.isFile() || !this.indexer.shouldIndex(relativeRaw, stat.size)) continue;
      const buffer = await fsp.readFile(full).catch(() => null);
      if (!buffer || buffer.includes(0)) continue;
      records.push({ path: relative, language: this.indexer.language(relative), content: buffer.toString('utf8') });
    }
    const knownFiles = new Set(records.map((record) => record.path));
    const nodes = [];
    const edges = [];
    const definitions = new Map();
    const fileNodes = new Map();

    for (const record of records) {
      const fileNode = { id: nodeId(workspaceId, 'file', record.path), kind: 'file', name: path.posix.basename(record.path), path: record.path, line: 1, language: record.language, meta: {} };
      nodes.push(fileNode);
      fileNodes.set(record.path, fileNode);
      const lines = record.content.split('\n');
      lines.forEach((line, index) => {
        for (const { kind, pattern } of DEF_PATTERNS) {
          const match = line.match(pattern);
          if (!match) continue;
          const symbol = { id: nodeId(workspaceId, kind, record.path, match[1]), kind, name: match[1], path: record.path, line: index + 1, language: record.language, meta: {} };
          nodes.push(symbol);
          const bucket = definitions.get(symbol.name) || [];
          bucket.push(symbol);
          definitions.set(symbol.name, bucket);
          edges.push({ id: edgeId(workspaceId, 'contains', fileNode.id, symbol.id), sourceId: fileNode.id, targetId: symbol.id, kind: 'contains', confidence: 1, meta: {} });
          break;
        }
      });
    }

    for (const record of records) {
      const source = fileNodes.get(record.path);
      for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of record.content.matchAll(pattern)) {
          const targetPath = resolveImport(record.path, match[1], knownFiles);
          const target = targetPath ? fileNodes.get(targetPath) : null;
          if (target) edges.push({ id: edgeId(workspaceId, 'imports', source.id, target.id), sourceId: source.id, targetId: target.id, kind: 'imports', confidence: 1, meta: { specifier: match[1] } });
        }
      }
      const seenCalls = new Set();
      for (const match of record.content.matchAll(CALL_PATTERN)) {
        const name = match[1];
        if (CALL_EXCLUSIONS.has(name) || seenCalls.has(name)) continue;
        const targets = definitions.get(name) || [];
        for (const target of targets.slice(0, 5)) {
          if (target.path === record.path && target.name === name) continue;
          const key = `${source.id}:${target.id}`;
          if (seenCalls.has(key)) continue;
          seenCalls.add(key);
          edges.push({ id: edgeId(workspaceId, 'calls', source.id, target.id), sourceId: source.id, targetId: target.id, kind: 'calls', confidence: targets.length === 1 ? 0.9 : 0.55, meta: { name } });
        }
      }
    }

    const uniqueEdges = [...new Map(edges.map((edge) => [edge.id, edge])).values()];
    this.store.replaceCodeGraph(workspaceId, { nodes, edges: uniqueEdges });
    const builtAt = nowIso();
    this.store.setSetting(`codeGraph:${workspaceId}:builtAt`, builtAt);
    const stats = { nodes: nodes.length, edges: uniqueEdges.length, files: records.length, builtAt, durationMs: Date.now() - started };
    this.eventBus.emit('code-graph.completed', stats, { workspaceId });
    this.logger.info('Code graph completed', { workspaceId, ...stats });
    return stats;
  }

  query(workspaceId, query, { kind, limit = 50 } = {}) {
    const graph = this.store.codeGraph(workspaceId);
    const wanted = tokens(query);
    return graph.nodes
      .filter((node) => !kind || node.kind === kind)
      .map((node) => {
        const haystack = tokens(`${node.name} ${node.path} ${node.kind}`);
        const overlap = [...wanted].filter((token) => haystack.has(token)).length;
        const exact = node.name.toLowerCase() === String(query || '').toLowerCase() ? 10 : 0;
        return { ...node, score: exact + overlap };
      })
      .filter((node) => node.score > 0 || !String(query || '').trim())
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((node) => ({ ...node, incoming: graph.edges.filter((edge) => edge.targetId === node.id).length, outgoing: graph.edges.filter((edge) => edge.sourceId === node.id).length }));
  }

  impact(workspaceId, targets, { depth = 3, limit = 200 } = {}) {
    const graph = this.store.codeGraph(workspaceId);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const seeds = graph.nodes.filter((node) => targets.some((target) => node.name === target || node.path === target || node.path.startsWith(`${target}/`)));
    const reverse = new Map();
    for (const edge of graph.edges) {
      const bucket = reverse.get(edge.targetId) || [];
      bucket.push(edge);
      reverse.set(edge.targetId, bucket);
    }
    const affected = new Map(seeds.map((node) => [node.id, { node, depth: 0, via: 'target', confidence: 1 }]));
    let frontier = seeds.map((node) => node.id);
    for (let level = 1; level <= depth && frontier.length; level += 1) {
      const next = [];
      for (const targetId of frontier) {
        for (const edge of reverse.get(targetId) || []) {
          if (affected.has(edge.sourceId)) continue;
          const node = byId.get(edge.sourceId);
          if (!node) continue;
          affected.set(node.id, { node, depth: level, via: edge.kind, confidence: edge.confidence * (1 / level) });
          next.push(node.id);
          if (affected.size >= limit) break;
        }
      }
      frontier = next;
    }
    const items = [...affected.values()].sort((a, b) => a.depth - b.depth || b.confidence - a.confidence);
    const files = [...new Set(items.map((item) => item.node.path))];
    const tests = files.filter((file) => /(^|\/)(test|tests|spec|specs)(\/|\.)|\.(test|spec)\./i.test(file));
    return { targets, seeds: seeds.map((node) => ({ id: node.id, kind: node.kind, name: node.name, path: node.path, line: node.line })), affected: items, files, tests, truncated: affected.size >= limit };
  }
}
