import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256, truncate } from '../core/utils.mjs';

function queryTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9_.$/-]{2,}/g) || []);
}

function overlapScore(query, value) {
  const haystack = queryTokens(value);
  if (!query.size) return 0;
  return [...query].filter((token) => haystack.has(token)).length / query.size;
}

function allocate(total, weights) {
  const sum = Object.values(weights).reduce((value, weight) => value + weight, 0) || 1;
  return Object.fromEntries(Object.entries(weights).map(([key, weight]) => [key, Math.floor(total * weight / sum)]));
}

export class ContextPlanner {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  budgets(maxChars = this.config.get().maxContextChars) {
    const configured = this.config.get().contextPlanner?.weights || {};
    return allocate(Math.floor(maxChars * 0.72), {
      snapshot: configured.snapshot ?? 0.12,
      tree: configured.tree ?? 0.10,
      instructions: configured.instructions ?? 0.16,
      memories: configured.memories ?? 0.12,
      source: configured.source ?? 0.42,
      reserve: configured.reserve ?? 0.08,
    });
  }

  async validateMemories(memories, workspacePath) {
    const results = [];
    for (const memory of memories) {
      const sources = Array.isArray(memory.meta?.sources) ? memory.meta.sources : [];
      if (memory.meta?.validUntil && Date.parse(memory.meta.validUntil) < Date.now()) {
        results.push({ ...memory, provenanceStatus: 'stale', provenance: [{ status: 'expired', validUntil: memory.meta.validUntil }] });
        continue;
      }
      if (!sources.length || !workspacePath) {
        results.push({ ...memory, provenanceStatus: sources.length ? 'unverified' : 'none' });
        continue;
      }
      let valid = true;
      const checked = [];
      for (const source of sources) {
        const relative = typeof source === 'string' ? source : source.path;
        const expectedHash = typeof source === 'object' ? source.hash : null;
        const full = path.resolve(workspacePath, relative || '');
        if (!full.startsWith(`${path.resolve(workspacePath)}${path.sep}`) && full !== path.resolve(workspacePath)) {
          valid = false;
          checked.push({ path: relative, status: 'outside-workspace' });
          continue;
        }
        const content = await fsp.readFile(full).catch(() => null);
        const actualHash = content ? sha256(content) : null;
        const status = !content ? 'missing' : expectedHash && expectedHash !== actualHash ? 'changed' : 'valid';
        if (status !== 'valid') valid = false;
        checked.push({ path: relative, expectedHash, actualHash, status });
      }
      results.push({ ...memory, provenanceStatus: valid ? 'valid' : 'stale', provenance: checked });
    }
    return results;
  }

  select({ prompt, repoHits = [], memories = [], budgets }) {
    const query = queryTokens(prompt);
    const sourceCandidates = repoHits.map((hit, rank) => ({
      ...hit,
      score: overlapScore(query, `${hit.path} ${hit.content}`) * 0.55 + (1 / (rank + 1)) * 0.30 + (/test|spec/i.test(hit.path) ? 0.05 : 0.10),
      reason: { lexical: overlapScore(query, `${hit.path} ${hit.content}`), retrievalRank: rank + 1 },
    })).sort((a, b) => b.score - a.score);
    const memoryCandidates = memories
      .filter((memory) => memory.provenanceStatus !== 'stale')
      .map((memory) => ({ ...memory, score: (memory.blendedScore ?? memory.effectiveImportance ?? memory.importance ?? 0.5) * (memory.meta?.confidence ?? 1) + (memory.provenanceStatus === 'valid' ? 0.1 : 0) }))
      .sort((a, b) => b.score - a.score);

    const fit = (items, budget, render) => {
      const selected = [];
      let used = 0;
      for (const item of items) {
        const cost = render(item).length;
        const remaining = Math.max(0, budget - used);
        if (!remaining) break;
        if (cost > remaining && selected.length && remaining < 1000) continue;
        const contextChars = Math.min(cost, remaining);
        selected.push({ ...item, _contextChars: contextChars });
        used += contextChars;
        if (used >= budget) break;
      }
      return { selected, used, considered: items.length };
    };
    const source = fit(sourceCandidates, budgets.source, (item) => item.content || '');
    const memory = fit(memoryCandidates, budgets.memories, (item) => `${item.title}\n${item.content}`);
    return {
      repoHits: source.selected.map(({ _contextChars, ...item }) => ({ ...item, content: truncate(item.content, _contextChars) })),
      memories: memory.selected.map(({ _contextChars, ...item }) => ({ ...item, content: truncate(item.content, Math.max(0, _contextChars - String(item.title || '').length)) })),
      report: {
        budgets,
        source: { considered: source.considered, selected: source.selected.length, usedChars: source.used, items: source.selected.map((item) => ({ path: item.path, score: item.score, reason: item.reason })) },
        memories: { considered: memory.considered, selected: memory.selected.length, usedChars: memory.used, staleExcluded: memories.filter((item) => item.provenanceStatus === 'stale').length },
      },
    };
  }
}
