// Enhanced OpenTelemetry spans middleware — 2nd-gen enrichment
// of the shipped 1.3 `otel` middleware. Adds:
//
//   * Cost attributes (input / output / total USD) via shipped pricing.js
//   * Correlation ID from ctx.meta.correlationId (traceCorrelation 1.64)
//   * Routing meta from ctx.meta.routed / routedRule / routedFrom / routedTo
//     (modelRouter 1.81)
//   * Error taxonomy — llm.error.code / .primitive / .retriable — populated
//     from LLMError subclasses (1.57)
//   * Cache attribution — llm.cache.hit / llm.cache.source distinguishing
//     exact / semantic / provider-side prompt caching (1.83)
//   * Custom enrichment callback
//   * OTel semantic conventions v1.29+ where applicable
//
// Duck-typed against @opentelemetry/api — no hard dependency. Ship your
// own tracer + optional context; the middleware just calls startSpan /
// setAttribute / setStatus / end / recordException.
//
//   const { trace, context } = require('@opentelemetry/api');
//   const { otelSpans } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(otelSpans({
//     tracer:  trace.getTracer('cap-app', '0.1.0'),
//     costs:   true,
//     correlation: true,
//     routing: true,
//     errorTaxonomy: true,
//   }));
//
// Backward compat: safe to use ALONGSIDE the existing `otel` middleware —
// both will emit spans (different name prefixes recommended). Most users
// should pick one; otelSpans is the enhanced choice.

const { DEFAULT_PRICING } = require('../pricing');
const { isLLMError } = require('../errors');

function otelSpans(options = {}) {
  const {
    tracer,
    spanNamePrefix   = 'llm.',
    systemAttribute  = null,
    costs            = true,
    pricing          = DEFAULT_PRICING,
    correlation      = true,
    routing          = true,
    errorTaxonomy    = true,
    cacheAttribution = true,
    enrich           = null,
  } = options;

  if (!tracer || typeof tracer.startSpan !== 'function') {
    throw new Error('otelSpans: options.tracer is required and must implement startSpan().');
  }
  if (enrich != null && typeof enrich !== 'function') {
    throw new Error('otelSpans: enrich must be a function or null.');
  }
  if (typeof pricing !== 'object' || pricing === null) {
    throw new Error('otelSpans: pricing must be an object.');
  }

  // ---- Cost math (per-model USD) ---------------------------------

  function computeCostUsd(model, usage) {
    if (!model || !usage) return null;
    const p = pricing[model];
    if (!p) return null;
    const inTok  = usage.input_tokens  ?? usage.prompt_tokens        ?? 0;
    const outTok = usage.output_tokens ?? usage.completion_tokens    ?? 0;
    const inputUsd  = (inTok  * (p.input  ?? 0)) / 1_000_000;
    const outputUsd = (outTok * (p.output ?? 0)) / 1_000_000;
    return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd, priced: true };
  }

  // ---- Cache-source detection ------------------------------------

  function detectCacheSource(usage, result) {
    if (result?.cached === true) return 'response-cache';
    if (usage?.cache_read_input_tokens > 0)     return 'prompt-cache-anthropic';
    if (usage?.prompt_tokens_details?.cached_tokens > 0) return 'prompt-cache-openai';
    if (usage?.prompt_cache_hit_tokens > 0)     return 'prompt-cache-deepseek';
    if (usage?.cachedContentTokenCount > 0)     return 'prompt-cache-gemini';
    return null;
  }

  // ---- Common attribute setter helpers ------------------------

  function setAttr(span, k, v) {
    if (v === undefined || v === null) return;
    if (typeof span.setAttribute === 'function') span.setAttribute(k, v);
  }

  function setCommonRequestAttrs(span, ctx) {
    setAttr(span, 'gen_ai.operation.name', ctx.method);
    setAttr(span, 'gen_ai.request.model',  ctx.request?.model);
    if (systemAttribute) setAttr(span, 'gen_ai.system', systemAttribute);
    if (ctx.request?.maxTokens != null)   setAttr(span, 'gen_ai.request.max_tokens', ctx.request.maxTokens);
    if (ctx.request?.temperature != null) setAttr(span, 'gen_ai.request.temperature', ctx.request.temperature);

    if (correlation && ctx.meta?.correlationId) {
      setAttr(span, 'llm.correlation_id', ctx.meta.correlationId);
    }
    if (routing && ctx.meta?.routed === true) {
      setAttr(span, 'llm.routing.rule_index',    ctx.meta.routedRule);
      setAttr(span, 'llm.routing.model.from',    ctx.meta.routedFrom);
      setAttr(span, 'llm.routing.model.to',      ctx.meta.routedTo);
    }
  }

  function setResponseAttrs(span, result) {
    if (!result || typeof result !== 'object') return;
    setAttr(span, 'gen_ai.response.model', result.model);
    setAttr(span, 'gen_ai.response.stop_reason', result.stopReason);
    if (result.usage) {
      const usage = result.usage;
      setAttr(span, 'gen_ai.usage.input_tokens',  usage.input_tokens  ?? usage.prompt_tokens);
      setAttr(span, 'gen_ai.usage.output_tokens', usage.output_tokens ?? usage.completion_tokens);
    }
    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
      setAttr(span, 'llm.tool_calls.count', result.toolCalls.length);
    }
    if (Array.isArray(result.embeddings)) {
      setAttr(span, 'llm.embed.count', result.embeddings.length);
    }
    // Costs
    if (costs) {
      const cost = computeCostUsd(result.model, result.usage);
      if (cost?.priced) {
        setAttr(span, 'llm.cost.input_usd',  cost.inputUsd);
        setAttr(span, 'llm.cost.output_usd', cost.outputUsd);
        setAttr(span, 'llm.cost.total_usd',  cost.totalUsd);
      }
    }
    // Cache attribution
    if (cacheAttribution) {
      const source = detectCacheSource(result.usage, result);
      if (source) {
        setAttr(span, 'llm.cache.hit', true);
        setAttr(span, 'llm.cache.source', source);
      } else {
        setAttr(span, 'llm.cache.hit', false);
      }
    }
  }

  function recordSpanError(span, err) {
    if (typeof span.recordException === 'function') span.recordException(err);
    if (typeof span.setStatus === 'function') {
      span.setStatus({ code: 2, message: err?.message ?? String(err) });
    }
    if (errorTaxonomy && err && isLLMError(err)) {
      setAttr(span, 'llm.error.code',      err.code);
      setAttr(span, 'llm.error.primitive', err.primitive);
      setAttr(span, 'llm.error.retriable', !!err.retriable);
    }
  }

  function endSpan(span) {
    if (typeof span.end === 'function') span.end();
  }

  // ---- Middleware ------------------------------------------------

  const mw = async (ctx, next) => {
    const span = tracer.startSpan(spanNamePrefix + (ctx.method ?? 'unknown'));
    setCommonRequestAttrs(span, ctx);

    let result;
    try {
      result = await next();
    } catch (err) {
      recordSpanError(span, err);
      endSpan(span);
      throw err;
    }

    // Stream (1.72+): defer span end to onComplete.
    const { hasStreamCompletion } = require('../streamCompletion');
    if (hasStreamCompletion(result)) {
      result.onComplete((info) => {
        try {
          if (!info?.ok) {
            recordSpanError(span, info?.error ?? new Error('stream failed'));
          } else if (info?.doneChunk) {
            setResponseAttrs(span, info.doneChunk);
            setAttr(span, 'llm.stream.chunks', info.chunkCount ?? null);
            setAttr(span, 'llm.stream.duration_ms', info.durationMs ?? null);
          }
          if (enrich) {
            try { enrich(ctx, info?.doneChunk ?? null, span); } catch { /* swallow */ }
          }
        } finally {
          endSpan(span);
        }
      });
      return result;
    }

    setResponseAttrs(span, result);
    if (enrich) {
      try { enrich(ctx, result, span); } catch { /* swallow */ }
    }
    endSpan(span);
    return result;
  };

  return mw;
}

module.exports = { otelSpans };
