// Prompt caching stats emitter.
//
// Turns provider prompt-caching savings (hidden in `usage` fields
// most callers ignore) into visible ops metrics — hit rate, tokens
// saved, USD saved, per-model breakdown, MCP resource, callback.
//
// Providers supported:
//
//   Anthropic
//     usage.cache_read_input_tokens       (0.10x of normal price)
//     usage.cache_creation_input_tokens   (1.25x of normal price)
//     usage.input_tokens                  (normal)
//
//   OpenAI (auto for GPT-4o, GPT-4o-mini, o1, o3-mini)
//     usage.prompt_tokens_details.cached_tokens  (0.50x)
//     usage.prompt_tokens                        (includes cached)
//
//   DeepSeek
//     usage.prompt_cache_hit_tokens       (0.10x)
//     usage.prompt_cache_miss_tokens      (normal)
//
//   Google Gemini
//     usage.cachedContentTokenCount       (0.25x, via context caching)
//
//   promptCacheStats({
//     onCache: (info) => cds.log('llm:cache').info(info),
//     // Overrides:
//     pricing: {},                // per-model normal rates
//     cacheMultipliers: {},       // per-provider multipliers
//   });
//
// Non-destructive to the result — reads only. Streams supported
// via 1.72 onComplete; final done chunk's usage populates stats.

const { DEFAULT_PRICING } = require('../pricing');

// ---- Provider defaults (multipliers vs normal input price) -----------

const DEFAULT_CACHE_MULTIPLIERS = {
  anthropic: { creation: 1.25, read: 0.10 },
  openai:    { creation: 1.00, read: 0.50 },
  deepseek:  { creation: 1.00, read: 0.10 },
  gemini:    { creation: 1.00, read: 0.25 },
};

// ---- Provider detection + token extraction ---------------------------

function detectProvider(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null) return 'anthropic';
  if (usage.prompt_tokens_details?.cached_tokens != null) return 'openai';
  if (usage.prompt_cache_hit_tokens != null || usage.prompt_cache_miss_tokens != null) return 'deepseek';
  if (usage.cachedContentTokenCount != null) return 'gemini';
  return null;
}

function extractCacheTokens(usage, provider) {
  switch (provider) {
    case 'anthropic':
      return {
        readTokens:     usage.cache_read_input_tokens ?? 0,
        creationTokens: usage.cache_creation_input_tokens ?? 0,
        normalTokens:   usage.input_tokens ?? 0,
      };
    case 'openai': {
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const total  = usage.prompt_tokens ?? 0;
      return {
        readTokens:     cached,
        creationTokens: 0,
        normalTokens:   Math.max(0, total - cached),
      };
    }
    case 'deepseek':
      return {
        readTokens:     usage.prompt_cache_hit_tokens ?? 0,
        creationTokens: 0,
        normalTokens:   usage.prompt_cache_miss_tokens ?? 0,
      };
    case 'gemini':
      return {
        readTokens:     usage.cachedContentTokenCount ?? 0,
        creationTokens: 0,
        // Gemini's `usage.promptTokenCount` includes cached; derive the rest.
        normalTokens:   Math.max(0, (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0)),
      };
    default:
      return null;
  }
}

// ---- Cost math -------------------------------------------------------

function pricePerToken(pricing, model) {
  const p = pricing[model];
  if (!p) return null;
  return (p.input ?? 0) / 1_000_000;   // pricing table stores USD per 1M tokens
}

function computeCost(tokens, pricing, model, multipliers) {
  const perToken = pricePerToken(pricing, model);
  if (perToken == null) return { actual: 0, hypothetical: 0, savings: 0, priced: false };
  const { readTokens, creationTokens, normalTokens } = tokens;
  const readMult = multipliers?.read ?? 1;
  const createMult = multipliers?.creation ?? 1;
  const actual = perToken * (readTokens * readMult + creationTokens * createMult + normalTokens);
  const hypothetical = perToken * (readTokens + creationTokens + normalTokens);
  return {
    actual,
    hypothetical,
    savings: Math.max(0, hypothetical - actual),
    priced: true,
  };
}

// ---- Main middleware -------------------------------------------------

function promptCacheStats(options = {}) {
  const {
    pricing          = DEFAULT_PRICING,
    cacheMultipliers = {},
    onCache          = null,
    captureStreams   = true,
    provider         = null,   // manual override
  } = options;

  if (onCache != null && typeof onCache !== 'function') {
    throw new Error('promptCacheStats: onCache must be a function or null.');
  }
  if (typeof pricing !== 'object' || pricing === null) {
    throw new Error('promptCacheStats: pricing must be an object.');
  }
  if (typeof cacheMultipliers !== 'object' || cacheMultipliers === null) {
    throw new Error('promptCacheStats: cacheMultipliers must be an object.');
  }

  // Merge user overrides with defaults, per-provider deep merge.
  const multipliers = {};
  for (const p of Object.keys(DEFAULT_CACHE_MULTIPLIERS)) {
    multipliers[p] = { ...DEFAULT_CACHE_MULTIPLIERS[p], ...(cacheMultipliers[p] ?? {}) };
  }
  // Allow custom providers too.
  for (const [p, v] of Object.entries(cacheMultipliers)) {
    if (!multipliers[p]) multipliers[p] = { creation: 1, read: 1, ...v };
  }

  const stats = {
    totalCalls:               0,
    callsWithCache:           0,
    totalCacheReadTokens:     0,
    totalCacheCreationTokens: 0,
    totalNormalInputTokens:   0,
    totalSavingsUsd:          0,
    totalCostUsd:             0,
    unpricedCalls:            0,
    byProvider:               {},
    byModel:                  {},
  };

  function processUsage(usage, model, ctx) {
    const detectedProvider = provider ?? detectProvider(usage);
    if (!detectedProvider) return;

    const tokens = extractCacheTokens(usage, detectedProvider);
    if (!tokens) return;
    if ((tokens.readTokens + tokens.creationTokens) === 0) {
      // Provider supports caching but this call had no cache activity.
      return;
    }

    stats.callsWithCache++;
    stats.totalCacheReadTokens     += tokens.readTokens;
    stats.totalCacheCreationTokens += tokens.creationTokens;
    stats.totalNormalInputTokens   += tokens.normalTokens;

    const cost = computeCost(tokens, pricing, model, multipliers[detectedProvider]);
    if (!cost.priced) stats.unpricedCalls++;
    stats.totalSavingsUsd += cost.savings;
    stats.totalCostUsd    += cost.actual;

    stats.byProvider[detectedProvider] = (stats.byProvider[detectedProvider] ?? 0) + 1;

    const key = model ?? 'unknown';
    const bucket = stats.byModel[key] ??= {
      calls: 0, readTokens: 0, creationTokens: 0, normalTokens: 0,
      savingsUsd: 0, costUsd: 0,
    };
    bucket.calls++;
    bucket.readTokens     += tokens.readTokens;
    bucket.creationTokens += tokens.creationTokens;
    bucket.normalTokens   += tokens.normalTokens;
    bucket.savingsUsd     += cost.savings;
    bucket.costUsd        += cost.actual;

    if (onCache) {
      try {
        onCache({
          provider: detectedProvider,
          model,
          readTokens:     tokens.readTokens,
          creationTokens: tokens.creationTokens,
          normalTokens:   tokens.normalTokens,
          actualCostUsd:  cost.actual,
          savingsUsd:     cost.savings,
          method:         ctx?.method ?? null,
        });
      } catch { /* swallow — never break the chain on a bad listener */ }
    }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const result = await next();

    const { hasStreamCompletion } = require('../streamCompletion');
    if (captureStreams && hasStreamCompletion(result)) {
      result.onComplete((info) => {
        if (!info?.ok || !info.doneChunk) return;
        const usage = info.doneChunk.usage ?? info.doneChunk;
        const model = info.doneChunk.model ?? ctx?.request?.model ?? null;
        processUsage(usage, model, ctx);
      });
      return result;
    }

    if (result && typeof result === 'object' && result.usage) {
      const model = result.model ?? ctx?.request?.model ?? null;
      processUsage(result.usage, model, ctx);
    }

    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.callsWithCache = 0;
    stats.totalCacheReadTokens = stats.totalCacheCreationTokens = stats.totalNormalInputTokens = 0;
    stats.totalSavingsUsd = stats.totalCostUsd = 0;
    stats.unpricedCalls = 0;
    for (const k of Object.keys(stats.byProvider)) delete stats.byProvider[k];
    for (const k of Object.keys(stats.byModel))    delete stats.byModel[k];
  };
  mw.asMcpResource = () => ({
    uri: 'config://prompt-cache-stats',
    name: 'Prompt cache stats',
    description: 'Cache-hit rate + USD savings from provider prompt-caching features (Anthropic / OpenAI / DeepSeek / Gemini).',
    mimeType: 'application/json',
    handler: () => {
      const totalTokens = stats.totalCacheReadTokens + stats.totalCacheCreationTokens + stats.totalNormalInputTokens;
      return {
        hitRate: totalTokens > 0
          ? +(stats.totalCacheReadTokens / totalTokens).toFixed(4)
          : 0,
        callsWithCacheRatio: stats.totalCalls > 0
          ? +(stats.callsWithCache / stats.totalCalls).toFixed(4)
          : 0,
        ...stats,
      };
    },
  });

  return mw;
}

module.exports = {
  promptCacheStats,
  DEFAULT_CACHE_MULTIPLIERS,
  detectProvider,
  extractCacheTokens,
  computeCost,
};
