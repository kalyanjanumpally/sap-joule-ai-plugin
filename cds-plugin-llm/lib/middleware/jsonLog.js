// Structured JSON logging middleware. Emits ONE canonical JSON line per
// LLM call — a stable schema that ops teams can index / alert on / feed
// straight into ELK / Datadog / CloudWatch without a per-project mapping.
//
// Composable with any logger (cds.log, pino, winston, console).
// Reads what other middleware / providers wrote to ctx.meta / result:
//   - ctx.meta.costEstimate    (from 1.56.0 costGuard)
//   - result.usage             (from every provider)
//   - result.cached / .cachedHit (from responseCache)
//   - err.code / .primitive / .retriable  (from 1.57.0 LLMError taxonomy)
//
// Placement is flexible. Two useful positions:
//   1. OUTER — after deadline, before guardrails: logs the full
//      request duration (includes retry + queue wait + provider call)
//      and gets to see the raw request duration.
//   2. INNER of guardrails — logs the scrubbed content path only
//      (useful when you want to include a request preview but never
//      log PII).
//
// The default schema deliberately excludes request payload (no
// messages, no system prompt). Consumers who want a preview should
// opt in with `includeRequestPreview: true` which grabs the first
// `previewChars` characters of the last user message.
//
//   const log = jsonLog({
//     logger:     cds.log('llm:call'),
//     level:      'info',
//     errorLevel: 'warn',
//     correlationId: (ctx) => ctx.raw?.correlationId ?? cds.context?.id ?? null,
//   });
//   llm.use(log);

const DEFAULT_PREVIEW_CHARS = 200;

function jsonLog(options = {}) {
  const {
    logger                 = console,
    level                  = 'info',
    errorLevel             = 'warn',
    correlationId          = null,
    includeRequestPreview  = false,
    previewChars           = DEFAULT_PREVIEW_CHARS,
    includeMeta            = false,
    redactMetaFields       = ['messages', 'system'],
  } = options;

  if (!logger || (typeof logger.info !== 'function' && typeof logger.log !== 'function')) {
    throw new Error('jsonLog: logger must expose .info() or .log() method.');
  }
  if (typeof previewChars !== 'number' || previewChars < 0) {
    throw new Error(`jsonLog: previewChars must be a non-negative number (got ${previewChars}).`);
  }
  if (!Array.isArray(redactMetaFields)) {
    throw new Error('jsonLog: redactMetaFields must be an array of field names.');
  }
  const redactSet = new Set(redactMetaFields);

  // Dispatch to logger.<level>() when present, falling back to logger.log().
  const emit = (lvl, payload) => {
    try {
      const fn = logger[lvl] ?? logger.log ?? logger.info;
      if (typeof fn === 'function') fn.call(logger, payload);
    } catch { /* swallow — never let logging break the request path */ }
  };

  const stats = {
    requests:    0,
    ok:          0,
    failed:      0,
    byErrorCode: Object.create(null),
  };

  const mw = async (ctx, next) => {
    stats.requests++;
    const startedAt = Date.now();
    const tenant   = ctx?.raw?.tenant ?? ctx?.raw?.user?.tenant ?? null;
    const provider = ctx?.service?.name ?? null;
    const model    = ctx?.request?.model ?? ctx?.service?.modelId ?? null;
    const method   = ctx?.method ?? 'unknown';
    let corrId = null;
    if (correlationId) {
      try { corrId = correlationId(ctx); } catch { /* swallow */ }
    }

    let requestPreview;
    if (includeRequestPreview && Array.isArray(ctx?.request?.messages)) {
      const lastUser = [...ctx.request.messages].reverse().find((m) => m?.role === 'user');
      if (lastUser) {
        const text = typeof lastUser.content === 'string'
          ? lastUser.content
          : Array.isArray(lastUser.content)
            ? lastUser.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
            : '';
        if (text) requestPreview = text.slice(0, previewChars);
      }
    }

    try {
      const result = await next();
      const durationMs = Date.now() - startedAt;
      stats.ok++;
      const usage = result?.usage ?? {};
      // Cost — prefer the actual meter result if the metering middleware
      // wrote it; else the costGuard estimate; else null.
      const costEstimate = ctx?.meta?.costEstimate;
      const cost = result?.cost ?? costEstimate?.estimatedUsd ?? null;
      const payload = {
        ts:            new Date().toISOString(),
        method,
        ok:            true,
        durationMs,
        tenant,
        provider,
        model:         result?.model ?? model,
        tokensIn:      usage.input_tokens  ?? usage.inputTokens  ?? null,
        tokensOut:     usage.output_tokens ?? usage.outputTokens ?? null,
        cost,
        cachedHit:     !!(result?.cached ?? result?.cachedHit),
        correlationId: corrId,
      };
      if (requestPreview) payload.requestPreview = requestPreview;
      if (includeMeta && ctx?.meta) payload.meta = redactObject(ctx.meta, redactSet);
      emit(level, payload);
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      stats.failed++;
      const code = err?.code ?? 'UNKNOWN';
      stats.byErrorCode[code] = (stats.byErrorCode[code] ?? 0) + 1;
      const payload = {
        ts:            new Date().toISOString(),
        method,
        ok:            false,
        durationMs,
        tenant,
        provider,
        model,
        correlationId: corrId,
        error: {
          code,
          primitive: err?.primitive ?? null,
          retriable: !!err?.retriable,
          severity:  err?.severity ?? 'error',
          message:   err?.message ?? String(err),
        },
      };
      if (requestPreview) payload.requestPreview = requestPreview;
      if (includeMeta && ctx?.meta) payload.meta = redactObject(ctx.meta, redactSet);
      emit(errorLevel, payload);
      throw err;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.requests = stats.ok = stats.failed = 0;
    stats.byErrorCode = Object.create(null);
  };
  mw.asMcpResource = () => ({
    uri: 'config://json-log',
    name: 'JSON logger middleware',
    description: 'Per-call log emission counters + per-error-code breakdown.',
    mimeType: 'application/json',
    handler: () => ({
      level,
      errorLevel,
      includeRequestPreview,
      previewChars,
      includeMeta,
      redactMetaFields: [...redactSet],
      requests:         stats.requests,
      ok:               stats.ok,
      failed:           stats.failed,
      byErrorCode:      { ...stats.byErrorCode },
    }),
  });
  return mw;
}

function redactObject(obj, redactSet) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (redactSet.has(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { jsonLog };
