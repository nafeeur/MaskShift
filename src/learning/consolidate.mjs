// Memory consolidation: fold near-duplicates into one, so recall stays sharp instead of filling with five phrasings of the
// same fact. `memory_optimize` only merged memories with identical titles; this also catches the same thing said
// differently, by comparing what the memories are about rather than what they are called.

import { jaccard, meaningful } from './profile.mjs';

const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);

const GROUP_CAP = 500; // memories compared within one scope/workspace/kind; the most recent win

const shared = (a, b) => { let count = 0; for (const item of a) if (b.has(item)) count += 1; return count; };

/** The same thing said differently shares most of its words even when each version adds a few of its own. */
function alike(a, b, threshold) {
  const common = shared(a, b);
  if (!common) return false;
  const jaccardScore = common / (a.size + b.size - common);
  return jaccardScore >= threshold || (common / Math.min(a.size, b.size) >= 0.85 && jaccardScore >= 0.45);
}

export function planConsolidation(memories, { threshold = 0.7 } = {}) {
  const items = memories.map((memory) => ({ memory, tokens: new Set(meaningful(`${memory.title} ${memory.content}`)) })).filter((item) => item.tokens.size >= 3);
  // Only memories of the same scope, workspace and kind can be merged, so compare only within those buckets.
  const buckets = new Map();
  for (const item of items) {
    const key = `${item.memory.scope}\u0000${item.memory.workspace_id || ''}\u0000${item.memory.meta?.kind || 'note'}`;
    buckets.set(key, [...(buckets.get(key) || []), item]);
  }
  const groupsOut = [];
  for (const bucket of buckets.values()) {
    const capped = [...bucket].sort((a, b) => Date.parse(b.memory.updated_at) - Date.parse(a.memory.updated_at)).slice(0, GROUP_CAP);
    const parent = capped.map((_, index) => index);
    const find = (index) => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
    for (let a = 0; a < capped.length; a += 1) {
      for (let b = a + 1; b < capped.length; b += 1) if (alike(capped[a].tokens, capped[b].tokens, threshold)) parent[find(b)] = find(a);
    }
    const found = new Map();
    for (const [index, item] of capped.entries()) found.set(find(index), [...(found.get(find(index)) || []), item.memory]);
    groupsOut.push(...found.values());
  }
  const groups = groupsOut;
  const plans = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => (b.importance - a.importance) || (Date.parse(b.updated_at) - Date.parse(a.updated_at)));
    const [survivor, ...extras] = ordered;
    const have = sentences(survivor.content).map((sentence) => meaningful(sentence));
    const additions = [];
    for (const extra of extras) {
      for (const sentence of sentences(extra.content)) {
        const tokens = meaningful(sentence);
        if (tokens.length >= 3 && !have.some((existing) => jaccard(existing, tokens) >= 0.7)) { additions.push(sentence); have.push(tokens); }
      }
    }
    const sum = (key) => group.reduce((total, memory) => total + (memory.meta?.[key] || 0), 0);
    plans.push({
      survivorId: survivor.id, title: survivor.title, mergedIds: extras.map((memory) => memory.id),
      content: [survivor.content, ...additions].join('\n').slice(0, 4000),
      tags: [...new Set(group.flatMap((memory) => memory.tags || []))],
      importance: Math.max(...group.map((memory) => memory.importance || 0)),
      meta: { ...survivor.meta, occurrences: sum('occurrences') || undefined, shown: sum('shown') || undefined, helped: sum('helped') || undefined, hurt: sum('hurt') || undefined,
        sources: [...new Map(group.flatMap((memory) => memory.meta?.sources || []).map((source) => [typeof source === 'string' ? source : source.path, source])).values()] },
    });
  }
  return plans;
}

export function applyConsolidation(store, plans) {
  let merged = 0;
  for (const plan of plans) {
    const survivor = store.getMemory(plan.survivorId);
    if (!survivor) continue;
    const meta = Object.fromEntries(Object.entries(plan.meta).filter(([, value]) => value !== undefined));
    store.saveMemory({ id: survivor.id, workspaceId: survivor.workspace_id, scope: survivor.scope, title: survivor.title, content: plan.content, tags: plan.tags, importance: plan.importance, meta, dedupe: false });
    for (const id of plan.mergedIds) { store.deleteMemory(id); merged += 1; }
  }
  return merged;
}
