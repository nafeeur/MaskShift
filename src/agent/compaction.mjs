import { truncate } from '../core/utils.mjs';

function renderTurn(turn) {
  return turn.map((message) => {
    if (message.role === 'tool') return `[tool result: ${message.toolName || 'tool'}]\n${truncate(String(message.content || ''), 2000)}`;
    if (message.role === 'assistant') {
      const calls = (message.toolCalls || []).map((call) => `${call.name}(${truncate(JSON.stringify(call.args || {}), 300)})`).join(', ');
      return `Assistant: ${truncate(String(message.content || ''), 2000)}${calls ? `\nTool calls: ${calls}` : ''}`;
    }
    return `${message.role === 'user' ? 'User' : message.role}: ${truncate(String(message.content || ''), 2000)}`;
  }).join('\n\n');
}

/**
 * Summarizes the turns being dropped from history into a compact note, instead of just
 * discarding them the way fitHistory's own generic "(N turns omitted)" placeholder does. Cheap
 * and bounded by design: only the *newly* dropped turns since the last call are ever rendered
 * into the summarization request — the running summary from a previous call, if any, is folded
 * in as a short starting point the model consolidates, never re-derived from the full history
 * again. A run's compaction cost therefore stays roughly constant per drop event rather than
 * growing with how far the run has gotten.
 *
 * Best-effort: any failure (a flaky provider, a model that refuses) falls back to the previous
 * summary (or null), which the caller then treats exactly like compaction was never available —
 * the generic digest placeholder still does its job either way.
 */
export async function compactTurns(providerManager, { modelRef, newlyDropped, previousSummary, signal, maxSummaryTokens = 400 }) {
  if (!newlyDropped.length) return { summary: previousSummary || null, usage: null };
  const rendered = newlyDropped.map(renderTurn).join('\n\n---\n\n');
  const instructions = previousSummary
    ? `You are maintaining a running summary of an in-progress coding session so older turns can be safely dropped from context without losing anything a continuing assistant would still need. Here is the summary so far:\n\n${previousSummary}\n\nHere is additional earlier conversation to fold into it. Produce one updated, consolidated summary — merge redundant points rather than appending. Preserve concrete facts: file paths touched, decisions made, values discovered, errors hit and how they were resolved. Drop pleasantries and narration. Keep it under ${maxSummaryTokens} tokens.\n\nAdditional conversation:\n\n${rendered}`
    : `Summarize the following earlier portion of an in-progress coding session so it can be safely dropped from context without losing anything a continuing assistant would still need. Preserve concrete facts: file paths touched, decisions made, values discovered, errors hit and how they were resolved. Drop pleasantries and narration. Keep it under ${maxSummaryTokens} tokens.\n\n${rendered}`;
  try {
    const result = await providerManager.complete({
      modelRef, messages: [{ role: 'user', content: instructions }], tools: [], signal, temperature: 0, maxTokens: maxSummaryTokens,
    });
    const summary = (result.content || '').trim();
    return { summary: summary || previousSummary || null, usage: result.usage, providerId: result.providerId, providerType: result.providerType, model: result.model };
  } catch {
    return { summary: previousSummary || null, usage: null };
  }
}
