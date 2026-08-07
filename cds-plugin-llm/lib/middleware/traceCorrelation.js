// Trace correlation middleware. Extracts (or generates) a correlation ID
// per request and stashes it on `ctx.meta.correlationId` so every
// downstream middleware — jsonLog (1.59), usageMetering, provider calls
// — surfaces the same ID. Optionally propagates into `cds.context` so
// CAP's own logging + persisted rows carry it too.
//
// The lookup precedence (default `fromCtx`):
//   1. ctx.raw.correlationId       (caller-supplied)
//   2. ctx.raw.headers['x-correlation-id']
//   3. ctx.raw.headers['x-request-id']
//   4. traceparent header trace-id (W3C Trace Context — the 32-char
//      hex ID from the middle of the header value)
//   5. cds.context?.id             (CAP's per-request UUID)
//   6. generator() — a fresh UUID (default v4 via crypto.randomUUID)
//
// Enables end-to-end distributed tracing: an incoming HTTP request
// carrying `traceparent` → LLM call → downstream provider log lines all
// share the same trace-id, and can be joined across logs / spans / DB
// rows with a simple correlation-id filter.
//
// Placement: OUTER of jsonLog (so the JSON log line carries the correct
// ID) and OUTER of usageMetering (so LlmSpend rows are tagged with it).
// Recommended:
//   deadline → traceCorrelation → jsonLog → ... → provider
//
//   const trace = traceCorrelation({
//     generator: traceCorrelation.uuidv7,   // time-ordered, k-sortable
//     onExtract: (info) => cds.log('llm:trace').debug(info),
//   });
//   llm.use(trace);

const { randomUUID, randomBytes } = require('node:crypto');

// UUIDv7 — 48-bit big-endian Unix ms timestamp + 4-bit version + 74 bits
// random. Time-ordered (k-sortable), unique enough for distributed use.
// RFC-9562 layout. Exported as traceCorrelation.uuidv7 for consumers who
// want time-ordered IDs (better index locality in a log store than v4).
function uuidv7() {
  const now = Date.now();
  const buf = Buffer.alloc(16);
  // 48-bit timestamp: bytes 0..5
  buf.writeUIntBE(Math.floor(now / 0x10000), 0, 4);   // high 32 bits
  buf.writeUIntBE(now & 0xffff, 4, 2);                 // low 16 bits
  // 74 bits random into bytes 6..15
  randomBytes(10).copy(buf, 6);
  // Version 7 in the high 4 bits of byte 6
  buf[6] = (buf[6] & 0x0f) | 0x70;
  // Variant 10 in the high 2 bits of byte 8
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Extract the W3C traceparent trace-id — the second dash-delimited field
// of a header value like `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
// Returns null if the header is missing / malformed.
function parseTraceparent(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const parts = headerValue.trim().split('-');
  if (parts.length !== 4) return null;
  const traceId = parts[1];
  if (!/^[a-f0-9]{32}$/i.test(traceId)) return null;
  return traceId;
}

// Best-effort CAP context lookup. Returns null if the plugin is used
// outside a CAP context (e.g. bare script test rigs).
function getCdsContext() {
  try {
    const cds = require('@sap/cds');
    return cds?.context ?? null;
  } catch {
    return null;
  }
}

function defaultFromCtx(ctx) {
  if (ctx?.raw?.correlationId) return String(ctx.raw.correlationId);
  const headers = ctx?.raw?.headers ?? ctx?.raw?.req?.headers;
  if (headers && typeof headers === 'object') {
    if (headers['x-correlation-id']) return String(headers['x-correlation-id']);
    if (headers['x-request-id'])     return String(headers['x-request-id']);
    if (headers['traceparent']) {
      const traceId = parseTraceparent(headers['traceparent']);
      if (traceId) return traceId;
    }
  }
  const cdsCtx = getCdsContext();
  if (cdsCtx?.id) return String(cdsCtx.id);
  return null;
}

function traceCorrelation(options = {}) {
  const {
    fromCtx              = defaultFromCtx,
    generator            = randomUUID,
    metaField            = 'correlationId',
    injectIntoCdsContext = true,
    onExtract            = null,
  } = options;

  if (typeof fromCtx !== 'function') {
    throw new Error('traceCorrelation: fromCtx must be a function.');
  }
  if (typeof generator !== 'function') {
    throw new Error('traceCorrelation: generator must be a function.');
  }
  if (typeof metaField !== 'string' || metaField.length === 0) {
    throw new Error('traceCorrelation: metaField must be a non-empty string.');
  }

  const stats = {
    requests:  0,
    extracted: 0,   // came from ctx / headers / cds.context
    generated: 0,   // fresh UUID
  };

  const mw = async (ctx, next) => {
    stats.requests++;
    let id = null;
    let source = 'generated';
    try {
      id = fromCtx(ctx);
    } catch { /* swallow */ }
    if (id) {
      source = 'extracted';
      stats.extracted++;
    } else {
      id = generator();
      stats.generated++;
    }
    if (ctx?.meta) {
      ctx.meta[metaField] = id;
    }
    if (injectIntoCdsContext) {
      const cdsCtx = getCdsContext();
      if (cdsCtx && !cdsCtx[metaField]) {
        try { cdsCtx[metaField] = id; } catch { /* swallow (read-only in some contexts) */ }
      }
    }
    if (onExtract) {
      try { onExtract({ id, source, method: ctx?.method }); }
      catch { /* swallow */ }
    }
    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.requests = stats.extracted = stats.generated = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://trace-correlation',
    name: 'Trace correlation middleware',
    description: 'Per-request correlation ID extraction + generation counters.',
    mimeType: 'application/json',
    handler: () => ({
      metaField,
      injectIntoCdsContext,
      ...stats,
    }),
  });
  return mw;
}

// Exposed for consumers who want time-ordered IDs (better log-store index locality).
traceCorrelation.uuidv7 = uuidv7;
// Exposed for consumers who want to reuse the parser (e.g. custom fromCtx).
traceCorrelation.parseTraceparent = parseTraceparent;
// Default extractor exposed for composition with a custom fromCtx.
traceCorrelation.defaultFromCtx = defaultFromCtx;

module.exports = { traceCorrelation, uuidv7, parseTraceparent };
