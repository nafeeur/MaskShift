// Preferences: what you have told MaskShift about how you want things done, noticed from your own messages.
//
// Only your words are read, never a model's guess about you: statements like "always …", "never …", "I prefer …",
// "don't …", "use X instead of Y". An explicit standing instruction is kept straight away; a one-off correction ("no, don't
// touch the tests") only starts to count once it has been said more than once, because it may have been about that task
// alone. Preferences are stored as ordinary memories, so `memory_list` shows them and `memory_delete` (or
// `maskshift learn forget`) removes them, and they stay on this machine.

import { sha256 } from '../core/utils.mjs';
import { jaccard, meaningful } from './profile.mjs';

const EXPLICIT = /\b(always|never|from now on|going forward|in (?:the )?future|i prefer|i'd rather|i would rather|i like it when|remember (?:that|to)|don'?t ever|do not ever|every time)\b/i;
const CORRECTION = /^(?:no|nope|wrong|incorrect|not quite|that'?s not|that isn'?t|actually)\b[\s,.:;!-]*\S|\b(?:don'?t|do not|stop|avoid)\s+\w+|\binstead of\b|\brather than\b|\buse\s+\S+\s+(?:not|instead)\b/i;
const PATHISH = /[\\/][\w.-]+\.\w{1,6}\b|`[^`]+`|\b\w+\.(?:js|mjs|ts|py|rs|go|md|json)\b/;

export function extractPreferences(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 1500 || /```/.test(text)) return [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
  const found = [];
  for (const sentence of sentences) {
    if (sentence.length < 12 || sentence.length > 240) continue;
    const explicit = EXPLICIT.test(sentence);
    if (!explicit && /\?\s*$/.test(sentence)) continue;
    if (!explicit && !CORRECTION.test(sentence)) continue;
    found.push({ text: sentence.replace(/^(?:no|nope|wrong|actually)[\s,.:;!-]+/i, '').replace(/^\w/, (c) => c.toUpperCase()), strength: explicit ? 0.9 : 0.55, explicit });
  }
  return found.slice(0, 3);
}

export class PreferenceStore {
  constructor({ store }) {
    this.store = store;
  }

  confidence(meta) {
    return (meta.strength || 0.5) * 0.6 + Math.min(1, (meta.occurrences || 1) / 3) * 0.4;
  }

  learnFrom(messages, { workspaceId }) {
    const saved = [];
    const existing = this.store.listMemoriesByKind('preference', { workspaceId, limit: 1000 });
    for (const message of messages) {
      if (message.role !== 'user' || message.meta?.synthetic) continue;
      for (const found of extractPreferences(message.content)) {
        const tokens = meaningful(found.text);
        if (tokens.length < 2) continue;
        const match = existing.find((memory) => jaccard(memory.meta.tokens || [], tokens) >= 0.6);
        const scope = found.explicit && !PATHISH.test(found.text) ? 'global' : 'workspace';
        const meta = match
          ? { ...match.meta, occurrences: (match.meta.occurrences || 1) + 1, strength: Math.max(match.meta.strength || 0, found.strength), lastSeen: new Date().toISOString() }
          : { kind: 'preference', occurrences: 1, strength: found.strength, tokens, lastSeen: new Date().toISOString() };
        const record = this.store.saveMemory({
          id: match?.id, workspaceId: (match ? match.scope : scope) === 'global' ? null : workspaceId, scope: match ? match.scope : scope,
          title: match?.title || `Preference · ${sha256(tokens.join(' ')).slice(0, 8)}`, content: match?.content || found.text, tags: ['preference'],
          importance: Math.min(0.9, 0.5 + meta.strength * 0.3), meta, dedupe: false,
        });
        if (!match) existing.push({ ...record, meta });
        saved.push({ id: record.id, text: record.content, occurrences: meta.occurrences, merged: Boolean(match) });
      }
    }
    return saved;
  }

  /** Preferences confident enough to act on, strongest first. */
  top({ workspaceId, limit = 8, maxChars = 1200, minConfidence = 0.5 } = {}) {
    const picked = [];
    let used = 0;
    const ranked = this.store.listMemoriesByKind('preference', { workspaceId, limit: 500 })
      .map((memory) => ({ memory, confidence: this.confidence(memory.meta || {}) }))
      .filter((item) => item.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    for (const item of ranked) {
      if (picked.length >= limit || used + item.memory.content.length > maxChars) continue;
      picked.push({ id: item.memory.id, text: item.memory.content, confidence: item.confidence, scope: item.memory.scope });
      used += item.memory.content.length;
    }
    return picked;
  }

  list({ workspaceId } = {}) {
    return this.store.listMemoriesByKind('preference', { workspaceId, limit: 500 }).map((memory) => ({
      id: memory.id, text: memory.content, occurrences: memory.meta.occurrences || 1, confidence: this.confidence(memory.meta), scope: memory.scope,
      active: this.confidence(memory.meta) >= 0.5,
    })).sort((a, b) => b.confidence - a.confidence);
  }
}
