// In-memory replay buffer. Captures the last N request/response pairs
// in a rolling buffer for live inspection. Zero persistence; different
// from the 1.69 testing.recording (which writes fixture files for
// test replay).
//
// Debugging use case: "the LLM said something weird — pull the last 10
// exchanges from memory and see what actually flowed."
//
// Usage:
//
//   const { replayBuffer } = require('@saptarishi/cds-plugin-llm');
//
//   const rb = replayBuffer({
//     size:           100,
//     redactFields:   ['messages', 'system'],   // strip from stored request
//   });
//   llm.use(rb);
//
//   // Later — e.g. from a /debug endpoint:
//   const recent = rb.dumpLastN(10);
//   res.json(recent);
//
// Every entry:
//   {
//     timestamp:     1691234567890,
//     method:        'chat',
//     model:         'gpt-4o-mini',
//     request:       { ...redacted },
//     response:      { text, usage, model } | null,
//     error:         { code, message, name } | null,
//     durationMs:    1234,
//     correlationId: 'req-abc-123' | null,
//     ok:            true | false,
//   }

const DEFAULT_SIZE = 100;
const DEFAULT_REDACT = ['messages', 'system', 'input'];

function replayBuffer(options = {}) {
  const {
    size          = DEFAULT_SIZE,
    redactFields  = DEFAULT_REDACT,
    captureStreams = true,
    includeRedactedPreview = false,
    previewChars  = 200,
  } = options;

  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`replayBuffer: size must be a positive integer (got ${size}).`);
  }
  if (!Array.isArray(redactFields)) {
    throw new Error('replayBuffer: redactFields must be an array of field names.');
  }
  if (!Number.isInteger(previewChars) || previewChars < 0) {
    throw new Error(`replayBuffer: previewChars must be a non-negative integer (got ${previewChars}).`);
  }
  const redactSet = new Set(redactFields);

  // Circular buffer: fixed-size array + write index.
  const buf = new Array(size);
  let writeIdx = 0;
  let count = 0;   // total entries ever inserted (capped display via dump())

  const stats = {
    totalCaptured: 0,
    successes:     0,
    failures:      0,
  };

  function insert(entry) {
    buf[writeIdx % size] = entry;
    writeIdx++;
    count++;
    stats.totalCaptured++;
    if (entry.ok) stats.successes++;
    else          stats.failures++;
  }

  function redactRequest(req) {
    const out = {};
    for (const [k, v] of Object.entries(req ?? {})) {
      if (redactSet.has(k)) {
        if (includeRedactedPreview && k === 'messages' && Array.isArray(v)) {
          const lastUser = [...v].reverse().find((m) => m?.role === 'user');
          if (lastUser) {
            const text = typeof lastUser.content === 'string' ? lastUser.content
              : Array.isArray(lastUser.content)
                ? lastUser.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
                : '';
            if (text) out[`${k}_preview`] = text.slice(0, previewChars);
          }
        } else {
          out[`${k}_redacted`] = true;
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function makeEntry(ctx, response, error, durationMs) {
    return {
      timestamp:     Date.now(),
      method:        ctx?.method ?? 'unknown',
      model:         ctx?.request?.model ?? null,
      request:       redactRequest(ctx?.request),
      response:      response == null ? null : summarizeResponse(response),
      error:         error == null ? null : summarizeError(error),
      durationMs,
      correlationId: ctx?.meta?.correlationId ?? null,
      ok:            error == null,
    };
  }

  function summarizeResponse(res) {
    // Store a compact summary — no full messages, no embeddings, no
    // model responses. Consumers debugging can reconstruct from usage +
    // model + text preview.
    const out = {};
    if (typeof res.text === 'string') {
      out.textPreview = res.text.length > 200 ? res.text.slice(0, 197) + '...' : res.text;
      out.textLength  = res.text.length;
    }
    if (res.model) out.model = res.model;
    if (res.usage) out.usage = { ...res.usage };
    if (res.cached != null) out.cached = res.cached;
    if (res.stopReason) out.stopReason = res.stopReason;
    return out;
  }

  function summarizeError(err) {
    return {
      name:      err?.name ?? 'Error',
      code:      err?.code ?? null,
      message:   err?.message ?? String(err),
      primitive: err?.primitive ?? null,
      retriable: !!err?.retriable,
    };
  }

  const mw = async (ctx, next) => {
    const startedAt = Date.now();
    try {
      const result = await next();
      // Stream (1.72+): defer capture until stream fully consumed.
      const { hasStreamCompletion } = require('../streamCompletion');
      if (captureStreams && hasStreamCompletion(result)) {
        result.onComplete((info) => {
          const doneChunk = info.doneChunk;
          if (info.ok && doneChunk) {
            insert(makeEntry(ctx, doneChunk, null, info.durationMs));
          } else {
            insert(makeEntry(ctx, null, info.error ?? new Error('stream failed'), info.durationMs));
          }
        });
        return result;
      }
      insert(makeEntry(ctx, result, null, Date.now() - startedAt));
      return result;
    } catch (err) {
      insert(makeEntry(ctx, null, err, Date.now() - startedAt));
      throw err;
    }
  };

  // ---- Public introspection API ----

  /** Return everything currently in the buffer, oldest → newest. */
  mw.dump = () => {
    const out = [];
    const total = Math.min(count, size);
    for (let i = 0; i < total; i++) {
      const idx = (writeIdx - total + i + size) % size;
      out.push(buf[idx]);
    }
    return out;
  };

  /** Return the last N entries, oldest → newest. */
  mw.dumpLastN = (n) => {
    if (!Number.isInteger(n) || n < 1) return [];
    const total = Math.min(count, size, n);
    const out = [];
    for (let i = 0; i < total; i++) {
      const idx = (writeIdx - total + i + size) % size;
      out.push(buf[idx]);
    }
    return out;
  };

  /** Return entries matching a predicate. */
  mw.dumpMatching = (pred) => mw.dump().filter(pred);

  /** Clear the buffer + stats. */
  mw.clear = () => {
    for (let i = 0; i < size; i++) buf[i] = undefined;
    writeIdx = 0;
    count = 0;
    stats.totalCaptured = stats.successes = stats.failures = 0;
  };

  mw.stats = stats;
  mw.size = () => Math.min(count, size);
  mw.capacity = () => size;

  mw.asMcpResource = () => ({
    uri: 'config://replay-buffer',
    name: 'Replay buffer',
    description: 'Rolling in-memory log of the last N LLM request/response pairs (redacted).',
    mimeType: 'application/json',
    handler: () => ({
      capacity:       size,
      current:        Math.min(count, size),
      redactFields:   [...redactSet],
      ...stats,
      entries:        mw.dump(),
    }),
  });

  return mw;
}

module.exports = { replayBuffer };
