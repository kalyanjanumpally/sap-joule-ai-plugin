// Cost-aware token budgeting middleware. Runs BEFORE the provider call
// and mutates `ctx.request.maxTokens` so the estimated cost fits under
// the caller's remaining budget * safetyFactor. Completes the cost
// story: budget → estimate → guard → adaptive tokens.
//
// Prevents the "one giant call ate my whole daily budget" failure mode:
//   - Caller asks for maxTokens=8000
//   - Remaining budget is $0.10; safetyFactor 0.5 → safe $ = $0.05
//   - Model is gpt-4o at $20/M output → safe output = ~2500 tokens
//   - Middleware shrinks req.maxTokens 8000 → 2500 before the provider sees it
//
// If the budget is so tight that even minTokens can't fit under the
// safe $ ceiling, throws AdaptiveMaxTokensBlockedError (LLMError with
// code BUDGET_TOO_TIGHT, HTTP 402, non-retriable — budget won't refund
// until window resets).
//
// Composes with the rest of the cost stack:
//   costBudget    — hard per-tenant / per-window accumulator ceiling
//   costGuard     — per-call ceiling (independent of budget window)
//   adaptiveMaxTokens — auto-shrinks maxTokens to fit remaining budget
//
// Usage:
//
//   const shrinker = adaptiveMaxTokens({
//     budget,                          // required — the costBudget middleware
//     scope:        'perTenant',        // which scope's remaining $ to check
//     safetyFactor: 0.5,                 // never use more than 50% of remaining
//     minTokens:    50,                  // never shrink below this
//     tenantOf:     (ctx) => ctx.raw?.tenant ?? 'default',
//     onAdjust:     (info) => cds.log('llm:adaptive-tokens').info(info),
//   });
//   llm.use(shrinker);

const { estimateCost } = require('../estimateCost');
const { DEFAULT_PRICING } = require('../pricing');
const { LLMError } = require('../errors');

class AdaptiveMaxTokensBlockedError extends LLMError {
  constructor(remainingUsd, minTokens, model) {
    super(
      `adaptiveMaxTokens: budget too tight — remaining $${remainingUsd.toFixed(6)} cannot fit minTokens=${minTokens} on model '${model}'.`,
      'BUDGET_TOO_TIGHT',
    );
    this.remainingUsd = remainingUsd;
    this.minTokens = minTokens;
    this.model = model;
  }
}

function adaptiveMaxTokens(options = {}) {
  const {
    budget,                                    // required — costBudget middleware
    scope         = 'total',                    // 'total' | 'perTenant' | 'perModel'
    safetyFactor  = 0.5,                         // 0..1 — fraction of remaining $ to allow
    minTokens     = 50,                          // floor on the shrunk maxTokens
    maxTokens     = 4_000,                       // ceiling when caller supplies no maxTokens
    pricing       = DEFAULT_PRICING,
    tenantOf      = (ctx) => ctx?.raw?.tenant ?? null,
    modelOf       = (ctx) => ctx?.request?.model ?? null,
    applyTo       = ['chat', 'stream'],
    onAdjust      = null,
    onBlock       = null,
  } = options;

  if (!budget || typeof budget.snapshot !== 'function' || typeof budget.limitFor !== 'function') {
    throw new Error('adaptiveMaxTokens: budget must be a costBudget middleware (with .snapshot() + .limitFor()).');
  }
  if (!['total', 'perTenant', 'perModel'].includes(scope)) {
    throw new Error(`adaptiveMaxTokens: scope must be 'total' | 'perTenant' | 'perModel' (got ${scope}).`);
  }
  if (!Number.isFinite(safetyFactor) || safetyFactor <= 0 || safetyFactor > 1) {
    throw new Error(`adaptiveMaxTokens: safetyFactor must be in (0, 1] (got ${safetyFactor}).`);
  }
  if (!Number.isInteger(minTokens) || minTokens < 1) {
    throw new Error(`adaptiveMaxTokens: minTokens must be a positive integer (got ${minTokens}).`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < minTokens) {
    throw new Error(`adaptiveMaxTokens: maxTokens must be an integer >= minTokens (got ${maxTokens}).`);
  }
  if (!Array.isArray(applyTo)) {
    throw new Error('adaptiveMaxTokens: applyTo must be an array of method names.');
  }
  const applyToSet = new Set(applyTo);

  const stats = {
    requests:          0,
    skipped:           0,
    adjusted:          0,
    rejected:          0,
    unchanged:         0,
    totalSavedTokens:  0,
  };

  // Resolve the remaining $ under `scope`. Returns null if no limit is
  // configured for the key (unlimited → skip the adjustment).
  async function remainingUsdFor(ctx) {
    let key;
    if (scope === 'total') key = 'total';
    else if (scope === 'perTenant') key = tenantOf(ctx) ?? 'default';
    else key = modelOf(ctx) ?? 'default';
    const limit = budget.limitFor(scope, key);
    if (limit == null) return null;   // no limit → nothing to enforce

    const snap = await budget.snapshot();
    let spent = 0;
    if (scope === 'total') spent = snap.total ?? 0;
    else if (scope === 'perTenant') spent = snap.perTenant?.[key] ?? 0;
    else spent = snap.perModel?.[key] ?? 0;
    return Math.max(0, limit - spent);
  }

  const mw = async (ctx, next) => {
    stats.requests++;

    if (!applyToSet.has(ctx?.method)) {
      stats.skipped++;
      return next();
    }
    const req = ctx?.request;
    if (!req) {
      stats.skipped++;
      return next();
    }
    const model = req.model;
    if (!model) {
      stats.skipped++;
      return next();
    }
    const priceEntry = pricing?.[model];
    if (!priceEntry || !priceEntry.output || priceEntry.output <= 0) {
      // Unknown model or zero-cost output (e.g. embeddings). Nothing to shrink.
      stats.skipped++;
      return next();
    }

    const remainingUsd = await remainingUsdFor(ctx);
    if (remainingUsd == null) {
      stats.skipped++;
      return next();
    }

    // Estimate input cost first — output tokens are what we can adjust.
    let est;
    try {
      est = estimateCost({
        model,
        messages:  req.messages ?? [],
        system:    req.system ?? null,
        maxTokens: 0,                // don't count output yet
        pricing,
      });
    } catch {
      stats.skipped++;
      return next();
    }
    const safeUsd     = remainingUsd * safetyFactor;
    const safeOutputBudget = safeUsd - est.inputUsd;
    const outputPricePerToken = priceEntry.output / 1_000_000;

    if (safeOutputBudget <= 0 || outputPricePerToken <= 0) {
      // Even the input tokens are too expensive for the safety budget →
      // no output allowed. Refuse instead of setting maxTokens to 0.
      stats.rejected++;
      if (onBlock) {
        try { onBlock({ remainingUsd, safeUsd, inputUsd: est.inputUsd, minTokens, model }); }
        catch { /* swallow */ }
      }
      throw new AdaptiveMaxTokensBlockedError(remainingUsd, minTokens, model);
    }

    const safeOutputTokens = Math.floor(safeOutputBudget / outputPricePerToken);
    if (safeOutputTokens < minTokens) {
      stats.rejected++;
      if (onBlock) {
        try { onBlock({ remainingUsd, safeUsd, inputUsd: est.inputUsd, safeOutputTokens, minTokens, model }); }
        catch { /* swallow */ }
      }
      throw new AdaptiveMaxTokensBlockedError(remainingUsd, minTokens, model);
    }

    // Determine the requested maxTokens (fall back to the middleware's ceiling).
    const requested = Number.isInteger(req.maxTokens) && req.maxTokens > 0
      ? req.maxTokens
      : maxTokens;
    // Cap it at safeOutputTokens if smaller.
    const newMaxTokens = Math.min(requested, safeOutputTokens);

    if (newMaxTokens < requested) {
      // Shrink applied.
      stats.adjusted++;
      stats.totalSavedTokens += (requested - newMaxTokens);
      req.maxTokens = newMaxTokens;
      if (ctx.meta) {
        ctx.meta.adaptiveMaxTokens = {
          requested,
          adjusted: newMaxTokens,
          remainingUsd,
          safeUsd,
          model,
        };
      }
      if (onAdjust) {
        try {
          onAdjust({
            requested, adjusted: newMaxTokens,
            remainingUsd, safeUsd, inputUsd: est.inputUsd,
            model, method: ctx.method,
          });
        } catch { /* swallow */ }
      }
    } else {
      stats.unchanged++;
    }

    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.requests = stats.skipped = stats.adjusted = stats.rejected = stats.unchanged = 0;
    stats.totalSavedTokens = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://adaptive-max-tokens',
    name: 'Adaptive max-tokens middleware',
    description: 'Per-call maxTokens auto-shrink based on remaining budget.',
    mimeType: 'application/json',
    handler: () => ({
      scope, safetyFactor, minTokens, maxTokens,
      applyTo: [...applyToSet],
      ...stats,
    }),
  });
  return mw;
}

module.exports = { adaptiveMaxTokens, AdaptiveMaxTokensBlockedError };
