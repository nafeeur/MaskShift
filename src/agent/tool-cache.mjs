// Two cheap ways to stop wasting turns on tool calls.
//
// Batching: a model often asks for several calls at once. Reads are independent, so consecutive read-only calls run together;
// anything that might change something runs alone, in the order it was asked for, so a write is still seen by the reads after it.
//
// Caching: asking again for something that has not changed is pure waste, and a model that does it is often going round in
// circles. A repeat of a deterministic read inside one run returns the same answer — with a note saying so — until a write,
// a changed file, or a short timeout makes it stale.

import fsp from 'node:fs/promises';
import path from 'node:path';

const CACHEABLE = new Set(['fs_read', 'fs_list', 'fs_stat', 'search_text', 'search_files', 'symbol_read', 'symbol_outline', 'git_status', 'git_diff', 'git_log', 'git_show',
  'lsp_hover', 'lsp_definition', 'lsp_references', 'lsp_symbols', 'code_graph_query', 'change_impact']);
const FILE_BOUND = new Set(['fs_read', 'fs_stat', 'symbol_read', 'symbol_outline']);

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

/** Groups of calls to run together: a run of read-only calls is one group, anything else stands alone. */
export function planBatches(calls, isReadOnly) {
  const batches = [];
  for (const call of calls) {
    const parallel = isReadOnly(call);
    const last = batches.at(-1);
    if (parallel && last?.parallel) last.calls.push(call);
    else batches.push({ parallel, calls: [call] });
  }
  return batches;
}

export class ToolCache {
  constructor({ ttlMs = 30_000, max = 300, enabled = true } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.enabled = enabled;
    this.entries = new Map();
    this.generation = 0;
    this.hits = 0;
  }

  cacheable(name) { return this.enabled && CACHEABLE.has(name); }

  /** Something that may change the workspace ran: nothing earlier can be trusted. */
  invalidate() { this.generation += 1; }

  key(name, args) { return `${name}:${stable(args)}`; }

  async #fingerprint(name, args, workspacePath) {
    if (!FILE_BOUND.has(name) || typeof args.path !== 'string') return null;
    const stat = await fsp.stat(path.resolve(workspacePath, args.path)).catch(() => null);
    return stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
  }

  async get(name, args, { workspacePath, now = Date.now() } = {}) {
    if (!this.cacheable(name)) return null;
    const entry = this.entries.get(this.key(name, args));
    if (!entry || entry.generation !== this.generation || now - entry.at > this.ttlMs) return null;
    if (entry.fingerprint !== await this.#fingerprint(name, args, workspacePath)) return null;
    this.hits += 1;
    entry.hits += 1;
    return entry;
  }

  async set(name, args, value, { workspacePath, step, now = Date.now() } = {}) {
    if (!this.cacheable(name)) return;
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(this.key(name, args), { value, step, at: now, generation: this.generation, fingerprint: await this.#fingerprint(name, args, workspacePath), hits: 0 });
  }
}
