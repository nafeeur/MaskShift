import { truncate } from '../core/utils.mjs';

// Conservative UTF-8-bytes-per-token estimate; not a real tokenizer, just enough to stay
// safely under a small model's context window without an extra dependency.
const CHARS_PER_TOKEN = 4;

export class ContextBudgetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContextBudgetError';
    this.code = 'CONTEXT_BUDGET_EXCEEDED';
    this.details = details;
  }
}

function estimateTokens(text) {
  return text ? Math.ceil(Buffer.byteLength(String(text), 'utf8') / CHARS_PER_TOKEN) : 0;
}

function messageTokens(message) {
  let total = 24 + estimateTokens(message.content);
  if (message.toolCalls?.length) total += estimateTokens(JSON.stringify(message.toolCalls)) + 16 * message.toolCalls.length;
  return total;
}

/**
 * Groups raw history into atomic turns so a tool call and its result are never split apart:
 * a plain user/assistant message, or an assistant tool-call message plus its immediate
 * tool-result messages.
 */
function groupTurns(history) {
  const turns = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === 'tool') { turns.at(-1)?.push(message); continue; } // orphaned result: attach defensively
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const group = [message];
      let j = i + 1;
      while (j < history.length && history[j].role === 'tool') group.push(history[j++]);
      turns.push(group);
      i = j - 1;
    } else {
      turns.push([message]);
    }
  }
  return turns;
}

/**
 * Trims conversation history to fit a model's declared context window, dropping the oldest
 * whole turns first. The system message and tool schemas are the caller's responsibility and
 * are never touched here. The latest turn is never dropped — a model whose context is too
 * small even for that fails loudly via ContextBudgetError rather than sending a corrupt or
 * silently-incomplete request.
 */
export function fitHistory({ history, contextTokens, outputTokens = 4096, systemTokens = 0, toolTokens = 0 }) {
  const headroom = Math.max(256, Math.floor(contextTokens * 0.1));
  const budget = contextTokens - outputTokens - headroom - systemTokens - toolTokens;
  if (budget < 256) {
    throw new ContextBudgetError('This model\'s context window is too small to fit the required system prompt and tool schemas.', { contextTokens, outputTokens, systemTokens, toolTokens });
  }

  const turns = groupTurns(history);
  if (!turns.length) return { history: [], omitted: 0 };

  const latest = turns.at(-1);
  const latestCost = latest.reduce((sum, message) => sum + messageTokens(message), 0);
  if (latestCost > budget) {
    throw new ContextBudgetError('The latest exchange does not fit this model\'s context window even after dropping all earlier history.', { contextTokens, latestCost, budget });
  }

  const kept = [latest];
  let used = latestCost;
  for (let i = turns.length - 2; i >= 0; i--) {
    const cost = turns[i].reduce((sum, message) => sum + messageTokens(message), 0);
    if (used + cost > budget) break;
    kept.unshift(turns[i]);
    used += cost;
  }

  const omitted = turns.length - kept.length;
  let flattened = kept.flat();
  if (omitted > 0) {
    const digest = {
      role: 'assistant',
      content: truncate(`(${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted from this request to fit the model's context window; still recorded in the session history.)`, 300),
    };
    flattened = [digest, ...flattened];
  }
  return { history: flattened, omitted };
}
