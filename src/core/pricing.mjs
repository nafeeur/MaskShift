const FREE_PROVIDER_TYPES = new Set(['ollama']);

function tokenCounts(usage) {
  return {
    inputTokens: Number(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount ?? 0) || 0,
    outputTokens: Number(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.candidatesTokenCount ?? 0) || 0,
    cacheWriteTokens: Number(usage?.cache_creation_input_tokens ?? 0) || 0,
    cacheReadTokens: Number(usage?.cache_read_input_tokens ?? usage?.cachedContentTokenCount ?? 0) || 0,
  };
}

/**
 * Estimate the USD (or configured currency) cost of one model response's token usage.
 * Pricing is read from config.pricing.models (keyed by "providerId:model" or bare "model") and is
 * never guessed: a model missing from that table comes back with priced:false and token counts only.
 * Local providers (Ollama) have no per-token provider charge and are always priced at 0.
 */
export function estimateUsageCost(config, providerId, providerType, model, usage) {
  if (!usage) return null;
  const counts = tokenCounts(usage);
  const currency = config?.pricing?.currency || 'USD';

  if (FREE_PROVIDER_TYPES.has(providerType)) {
    return { ...counts, cost: 0, currency, priced: true, note: 'Local inference has no per-token provider charge.' };
  }

  const table = config?.pricing?.models || {};
  const rate = table[`${providerId}:${model}`] || table[model];
  if (!rate) return { ...counts, cost: null, currency, priced: false };

  const cost =
    (counts.inputTokens / 1_000_000) * (rate.inputPerMTok || 0) +
    (counts.outputTokens / 1_000_000) * (rate.outputPerMTok || 0) +
    (counts.cacheWriteTokens / 1_000_000) * (rate.cacheWritePerMTok ?? rate.inputPerMTok ?? 0) +
    (counts.cacheReadTokens / 1_000_000) * (rate.cacheReadPerMTok ?? 0);
  return { ...counts, cost, currency, priced: true };
}

export function summarizeCosts(entries) {
  const totals = {
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
    cost: 0, pricedEntries: 0, unpricedEntries: 0, currency: 'USD',
  };
  for (const entry of entries) {
    if (!entry) continue;
    totals.inputTokens += entry.inputTokens || 0;
    totals.outputTokens += entry.outputTokens || 0;
    totals.cacheWriteTokens += entry.cacheWriteTokens || 0;
    totals.cacheReadTokens += entry.cacheReadTokens || 0;
    totals.currency = entry.currency || totals.currency;
    if (entry.priced) { totals.cost += entry.cost || 0; totals.pricedEntries += 1; } else totals.unpricedEntries += 1;
  }
  totals.complete = totals.unpricedEntries === 0;
  return totals;
}
