// What MaskShift needs to know about a model to size everything around it: how big its
// context window is, how much it may write back, and roughly how capable it is. Resolved in
// order of trust — explicit config, what the provider itself reports, what an earlier
// context-overflow error taught us, the model's family, and finally a conservative default —
// so an unknown model still gets a working, if cautious, setup instead of none at all.

export const DEFAULT_CONTEXT_WINDOW = 32_768;
const MIN_CONTEXT_WINDOW = 2_048;

// Fallback only: discovery and learned limits win whenever they exist. Kept to limits that are
// published for the family as a whole; ordered most specific first.
const FAMILY_WINDOWS = [
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-5/i, 272_000],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/gpt-3\.5/i, 16_385],
  [/(^|[/:])o[134](-mini|-pro)?\b/i, 200_000],
  [/gemini-(1\.5|2|3)/i, 1_000_000],
  [/llama-?3\.[1-9]/i, 128_000],
  [/llama-?3\b/i, 8_192],
  [/mistral-large|mistral-medium/i, 128_000],
  [/qwen-?2\.5|qwen-?3/i, 32_768],
  [/deepseek/i, 64_000],
  [/gemma-?3/i, 32_768],
  [/gemma-?2/i, 8_192],
  [/phi-?3/i, 4_096],
];

export function familyContextWindow(model) {
  const name = String(model || '');
  // A size baked into the name ("phi-3-mini-128k", "yarn-64k") beats the family default.
  const hinted = name.match(/(?:^|[-_:])(\d{1,4})k(?:$|[-_:.])/i);
  if (hinted) {
    const tokens = Number(hinted[1]) * 1024;
    if (tokens >= MIN_CONTEXT_WINDOW) return tokens;
  }
  for (const [pattern, tokens] of FAMILY_WINDOWS) if (pattern.test(name)) return tokens;
  return null;
}

// "7B", "8x7B", "70.6B", "1.5b" → billions of parameters, from a model name or Ollama's
// details.parameter_size. Null when it cannot be read.
export function parameterBillions(value) {
  const text = String(value || '');
  const moe = text.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*b\b/gi)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

const CONTEXT_ERROR = /context[_ ]length[_ ]exceeded|maximum context length|context (?:window|size|limit)|too many tokens|prompt is too long|exceeds? the (?:maximum|available|model'?s?) (?:context|number of tokens)|input (?:is )?too long|reduce the length of the messages|context (?:length|size) of only|context overflow/i;

const LIMIT_PATTERNS = [
  /maximum context length is (\d[\d,]*)/i,
  /(\d[\d,]*)\s*(?:tokens?)?\s*>\s*(\d[\d,]*)\s*maximum/i,
  /exceed context limit:[^>]*>\s*(\d[\d,]*)/i,
  /maximum number of tokens allowed \((\d[\d,]*)\)/i,
  /context (?:length|size|window) of (?:only )?(\d[\d,]*)/i,
  /available context size \((\d[\d,]*)/i,
  /n_ctx[^\d]{0,8}(\d[\d,]*)/i,
  /limit of (\d[\d,]*) tokens/i,
];

/**
 * Recognises a provider's "your prompt did not fit" error and, when the message states it, the
 * real limit. Returns null for any other error. `limit` is null when the error only says the
 * prompt was too long without naming a number.
 */
export function parseContextOverflow(error) {
  const text = `${error?.message || ''} ${typeof error?.data === 'string' ? error.data : JSON.stringify(error?.data || {})}`;
  if (!CONTEXT_ERROR.test(text)) return null;
  for (const pattern of LIMIT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    // For "N tokens > M maximum" the limit is the second number.
    const raw = match[2] && /maximum/i.test(pattern.source) ? match[2] : match[1];
    const limit = Number(String(raw).replaceAll(',', ''));
    if (Number.isFinite(limit) && limit >= MIN_CONTEXT_WINDOW) return { limit };
  }
  return { limit: null };
}

export function tierFor({ contextWindow, parameters }) {
  if (contextWindow < 16_000 || (parameters !== null && parameters <= 9)) return 'small';
  if (contextWindow >= 100_000 && (parameters === null || parameters >= 30)) return 'large';
  return 'medium';
}

/** Output-token cap that leaves the bulk of the window for the prompt. */
export function outputTokensFor({ contextWindow, declaredOutput, configured }) {
  const cap = Math.floor(contextWindow * 0.25);
  const candidates = [configured || 16_384, cap];
  if (declaredOutput) candidates.push(declaredOutput);
  return Math.max(512, Math.min(...candidates));
}

export function normalizeWindow(value) {
  const tokens = Math.floor(Number(value));
  return Number.isFinite(tokens) && tokens >= MIN_CONTEXT_WINDOW ? tokens : null;
}
