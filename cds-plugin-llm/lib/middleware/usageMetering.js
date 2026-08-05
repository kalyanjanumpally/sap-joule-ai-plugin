// Per-request cost + token accounting middleware for llm.use().
//
//   const { usageMetering } = require('@saptarishi/cds-plugin-llm');
//   const meter = usageMetering({
//     pricing: {
//       // per 1M tokens in USD — sensible defaults ship in lib/pricing.js,
//       // but override for any model you have a contract price on
//       'claude-opus-4-7': { input: 12, output: 60 },
//     },
//     currency: 'USD',
//     tenantOf:   (ctx) => ctx.request?.tenant ?? null,
//     providerOf: (ctx) => ctx.request?.provider ?? 'default',
//     onRecord:   async (rec) => await db.run(INSERT.into(LlmUsage).entries(rec)),
//   });
//   llm.use(meter);
//
//   // Later, query totals:
//   meter.summary();                // full breakdown
//   meter.byModel('gpt-4o');        // one model
//   meter.byTenant('acme-corp');    // one tenant
//   meter.reset();                  // zero the counters
//
// Wraps chat, stream (via done-chunk usage), and embed. Zero cost when the
// model's usage numbers are missing — but the request is still counted.
// Unknown models cost $0 but appear in `byModel` so you can spot missing
// pricing entries.

const { DEFAULT_PRICING } = require('../pricing');

function usageMetering(options = {}) {
  const {
    pricing = {},
    currency = 'USD',
    tenantOf = () => null,
    providerOf = () => null,
    onRecord = null,
    // Explicit list of unit multiplier — some contract prices are per-1K
    // rather than per-1M. Default matches the built-in DEFAULT_PRICING.
    pricingUnit = 1_000_000,
  } = options;

  // Merge user-provided pricing over the defaults so consumers only need to
  // list the models they want to override.
  const priceTable = { ...DEFAULT_PRICING, ...pricing };

  const summary = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    currency,
    // Cache-hit tracking (new in 1.26.0). When responseCache is stacked
    // BEFORE usageMetering in the middleware chain and a cache hit
    // returns `result.cached: true`, we record the request but charge
    // $0 — and separately count how much we would have paid without
    // the cache. Gives finance a "cache savings" line item.
    totalCachedHits: 0,
    totalCostSaved: 0,
    byModel: {},
    byTenant: {},
    byProvider: {},
  };

  function recordUsage({ provider, model, tenant, inputTokens, outputTokens, method, cached }) {
    const p = priceTable[model];
    const iTok = inputTokens || 0;
    const oTok = outputTokens || 0;
    const wouldBeInputCost  = p ? (iTok / pricingUnit) * p.input  : 0;
    const wouldBeOutputCost = p ? (oTok / pricingUnit) * p.output : 0;
    const wouldBeTotalCost  = wouldBeInputCost + wouldBeOutputCost;

    // Cache-hit accounting: bill $0, credit the would-be cost to savings.
    const actualInputCost  = cached ? 0 : wouldBeInputCost;
    const actualOutputCost = cached ? 0 : wouldBeOutputCost;
    const actualTotalCost  = cached ? 0 : wouldBeTotalCost;

    summary.totalRequests += 1;
    summary.totalInputTokens += iTok;
    summary.totalOutputTokens += oTok;
    summary.totalCost += actualTotalCost;
    if (cached) {
      summary.totalCachedHits += 1;
      summary.totalCostSaved += wouldBeTotalCost;
    }

    incrBucket(summary.byModel, model, { iTok, oTok, cost: actualTotalCost });
    if (tenant) incrBucket(summary.byTenant, tenant, { iTok, oTok, cost: actualTotalCost });
    if (provider) incrBucket(summary.byProvider, provider, { iTok, oTok, cost: actualTotalCost });

    if (onRecord) {
      const record = {
        timestamp: new Date().toISOString(),
        provider: provider ?? null,
        model,
        tenant: tenant ?? null,
        method,
        inputTokens: iTok,
        outputTokens: oTok,
        inputCost: actualInputCost,
        outputCost: actualOutputCost,
        totalCost: actualTotalCost,
        currency,
        pricingKnown: !!p,
        cached: !!cached,
      };
      // Fire-and-forget — the sink shouldn't slow down the request path.
      // Consumers who need durability should await their own writes inside.
      Promise.resolve(onRecord(record)).catch(err => {
        // No cds.log() here — the middleware is transport-agnostic. Attach
        // an OTel span, own logger, or wrap onRecord to trap errors.
      });
    }
  }

  const mw = async (ctx, next) => {
    const provider = providerOf(ctx);
    const tenant = tenantOf(ctx);

    if (ctx.method === 'stream') {
      const iter = await next();
      return (async function* wrapped() {
        for await (const chunk of iter) {
          if (chunk?.type === 'done' && chunk.usage) {
            recordUsage({
              provider, tenant,
              model: chunk.model ?? ctx.request.model,
              inputTokens: chunk.usage.input_tokens,
              outputTokens: chunk.usage.output_tokens,
              method: 'stream',
            });
          }
          yield chunk;
        }
      })();
    }

    const result = await next();

    if (ctx.method === 'chat' && result?.usage) {
      recordUsage({
        provider, tenant,
        model: result.model ?? ctx.request.model,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cached: result.cached === true,
        method: 'chat',
      });
    } else if (ctx.method === 'embed') {
      // Embed usage varies by provider — most don't report tokens back. We
      // count the request + model; input token count is approximated from
      // the request input length (~4 chars/token industry average) only
      // when the provider didn't tell us. Consumers who want precise embed
      // cost should hook `onRecord` and swap in tiktoken.
      const inputs = Array.isArray(ctx.request.input) ? ctx.request.input : [ctx.request.input];
      const approxTokens = inputs.reduce((a, s) => a + Math.ceil(String(s ?? '').length / 4), 0);
      recordUsage({
        provider, tenant,
        model: result?.model ?? ctx.request.model,
        inputTokens: approxTokens,
        outputTokens: 0,
        method: 'embed',
      });
    }

    return result;
  };

  mw.summary = () => structuredClone(summary);
  mw.byModel = (modelId) => summary.byModel[modelId] ? structuredClone(summary.byModel[modelId]) : null;
  mw.byTenant = (tenantId) => summary.byTenant[tenantId] ? structuredClone(summary.byTenant[tenantId]) : null;
  mw.byProvider = (providerId) => summary.byProvider[providerId] ? structuredClone(summary.byProvider[providerId]) : null;
  mw.reset = () => {
    summary.totalRequests = 0;
    summary.totalInputTokens = 0;
    summary.totalOutputTokens = 0;
    summary.totalCost = 0;
    summary.totalCachedHits = 0;
    summary.totalCostSaved = 0;
    summary.byModel = {};
    summary.byTenant = {};
    summary.byProvider = {};
  };
  // Test / integration hook: consumers can drop this into an MCPServer
  // as a resource handler for `config://usage`.
  mw.asMcpResource = () => ({
    uri: 'config://usage',
    name: 'LLM usage',
    description: 'Aggregate token counts + cost across all requests since the process (or reset) started.',
    mimeType: 'application/json',
    handler: () => mw.summary(),
  });
  return mw;
}

function incrBucket(bucket, key, { iTok, oTok, cost }) {
  const b = bucket[key] ?? { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  b.requests += 1;
  b.inputTokens += iTok;
  b.outputTokens += oTok;
  b.cost += cost;
  bucket[key] = b;
}

module.exports = { usageMetering };
