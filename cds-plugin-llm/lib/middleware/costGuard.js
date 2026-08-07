// Pre-flight cost enforcement middleware. Wraps the 1.54.0 estimateCost
// helper and runs BEFORE the provider call — refuses over-budget requests
// WITHOUT spending a single token. Complements the reactive costBudget
// (post-call accumulator) with a proactive per-call ceiling.
//
//   const guard = costGuard({
//     maxPerCallUsd: 1.00,     // hard ceiling
//     warnAtUsd:     0.10,     // soft warning
//     onExceeded: (info) => cds.log('llm:cost-guard').warn(info),
//     onWarn:     (info) => cds.log('llm:cost-guard').info(info),
//   });
//   llm.use(guard);
//
// Recommended ordering (top = OUTERMOST):
//   deadline → guardrails → costGuard → costBudget → circuitBreaker →
//   bulkhead → retryOnRateLimit → provider
//
//   - AFTER guardrails: PII / injection scrubbing runs first, so the
//     estimate counts the scrubbed content (accurate to what the
//     provider actually sees).
//   - BEFORE costBudget: budget is a per-tenant/window accumulator;
//     costGuard is a per-call ceiling. Independent checks.
//
// Opt-outs:
//   - Non-chat methods (embed, batch, stream) skip the guard by default.
//     Set `applyTo: ['chat', 'stream']` (default) or add / remove.
//   - Caller can bypass a single request with `req.costGuard: 'skip'`.
//
// The estimated cost is stashed on ctx.meta.costEstimate so downstream
// middleware (usageMetering, custom logging, headers) can see the
// pre-flight number for comparison with the actual post-call cost.

const { estimateCost } = require('../estimateCost');
const { DEFAULT_PRICING } = require('../pricing');

const { LLMError } = require('../errors');

class CostGuardBlockedError extends LLMError {
  constructor(estimatedUsd, limitUsd, model) {
    super(
      `costGuard: estimated cost $${estimatedUsd.toFixed(6)} exceeds per-call limit $${limitUsd.toFixed(6)} for model '${model}'.`,
      'COST_GUARD_BLOCKED',
    );
    this.estimatedUsd = estimatedUsd;
    this.limitUsd = limitUsd;
    this.model = model;
  }
}

function costGuard(options = {}) {
  const {
    maxPerCallUsd,               // required
    warnAtUsd     = null,        // null = no warning tier
    pricing       = DEFAULT_PRICING,
    tokenizer     = null,
    applyTo       = ['chat', 'stream'],
    onExceeded    = null,
    onWarn        = null,
  } = options;

  if (!Number.isFinite(maxPerCallUsd) || maxPerCallUsd <= 0) {
    throw new Error(`costGuard: maxPerCallUsd must be a positive number (got ${maxPerCallUsd}).`);
  }
  if (warnAtUsd != null && (!Number.isFinite(warnAtUsd) || warnAtUsd < 0)) {
    throw new Error(`costGuard: warnAtUsd must be a non-negative number or null (got ${warnAtUsd}).`);
  }
  if (warnAtUsd != null && warnAtUsd > maxPerCallUsd) {
    throw new Error(`costGuard: warnAtUsd (${warnAtUsd}) cannot exceed maxPerCallUsd (${maxPerCallUsd}).`);
  }
  if (!Array.isArray(applyTo)) {
    throw new Error('costGuard: applyTo must be an array of method names.');
  }

  const applyToSet = new Set(applyTo);

  const stats = {
    requests:           0,   // total requests observed
    skipped:            0,   // non-chat/stream OR opt-out via req.costGuard='skip'
    checked:            0,   // requests actually cost-estimated
    warned:             0,   // requests over warnAtUsd
    blocked:            0,   // requests over maxPerCallUsd
    estimatedUsdTotal:  0,   // sum of estimated cost across all checked requests
  };

  const mw = async (ctx, next) => {
    stats.requests++;

    // Fast path skips: non-chat methods or explicit opt-out
    if (!applyToSet.has(ctx?.method) || ctx?.raw?.costGuard === 'skip') {
      stats.skipped++;
      return next();
    }

    // Extract enough of the request to estimate
    const req = ctx?.request ?? ctx?.raw ?? {};
    const model     = req.model ?? ctx?.service?.modelId;
    const messages  = req.messages ?? [];
    const system    = req.system ?? null;
    const maxTokens = req.maxTokens ?? req.max_tokens ?? 512;

    if (!model || !Array.isArray(messages)) {
      // Not enough to estimate — pass through without counting.
      stats.skipped++;
      return next();
    }

    let est;
    try {
      est = estimateCost({ model, messages, system, maxTokens, pricing, tokenizer });
    } catch (e) {
      // Estimator itself failed (e.g. tokenizer error). Don't block on
      // an internal error — pass through and record.
      stats.skipped++;
      return next();
    }

    stats.checked++;
    stats.estimatedUsdTotal += est.estimatedUsd;
    // Stash the estimate for downstream consumers (metering, logs, headers).
    if (ctx.meta) ctx.meta.costEstimate = est;

    if (est.estimatedUsd > maxPerCallUsd) {
      stats.blocked++;
      const info = {
        estimatedUsd: est.estimatedUsd,
        limitUsd:     maxPerCallUsd,
        model,
        tokensIn:     est.tokensIn,
        method:       ctx.method,
      };
      if (onExceeded) {
        try { onExceeded(info); } catch { /* swallow */ }
      }
      throw new CostGuardBlockedError(est.estimatedUsd, maxPerCallUsd, model);
    }

    if (warnAtUsd != null && est.estimatedUsd > warnAtUsd) {
      stats.warned++;
      const info = {
        estimatedUsd: est.estimatedUsd,
        warnAtUsd,
        limitUsd: maxPerCallUsd,
        model,
        tokensIn: est.tokensIn,
        method: ctx.method,
      };
      if (onWarn) {
        try { onWarn(info); } catch { /* swallow */ }
      }
    }

    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.requests = stats.skipped = stats.checked = stats.warned = stats.blocked = 0;
    stats.estimatedUsdTotal = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://cost-guard',
    name: 'Cost-guard middleware',
    description: 'Per-call cost ceiling counters + config.',
    mimeType: 'application/json',
    handler: () => ({
      maxPerCallUsd,
      warnAtUsd,
      applyTo:    [...applyToSet],
      ...stats,
    }),
  });
  return mw;
}

module.exports = { costGuard, CostGuardBlockedError };
