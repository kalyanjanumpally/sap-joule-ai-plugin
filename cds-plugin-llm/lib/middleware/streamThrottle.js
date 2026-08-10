// Streaming token throttler. Rate-limits stream chunk emission so
// UI cursor doesn't jitter. Some providers (Groq, DeepSeek at
// certain hours) emit tokens in tight bursts of 200+ tok/sec then
// pause — the visible result is a stuttering cursor. Throttling
// to a steady 30-50 tok/sec matches natural reading speed and
// produces smooth output.
//
// Only affects `stream` method calls; non-stream calls (chat,
// embed, batch) pass through untouched.
//
//   const { streamThrottle } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(streamThrottle({
//     maxTokensPerSecond: 40,   // typical natural-reading pace
//   }));
//
// Preserves the 1.72 stream completion tracker — the wrapped
// iterator keeps yielding the same chunks (including the `done`
// chunk); only the pacing changes. Downstream middleware relying
// on onComplete still fire correctly.
//
// Cost: adds up to (totalTokens / maxTokensPerSecond) - actualDuration
// seconds to total stream time. Zero cost when the provider is
// already SLOWER than the target rate.

function streamThrottle(options = {}) {
  const {
    maxTokensPerSecond = 50,
    countTokens        = defaultCountTokens,
    skipMethods        = ['chat', 'embed', 'batch'],
    onDelay            = null,
    now                = () => Date.now(),
    sleep              = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (!Number.isFinite(maxTokensPerSecond) || maxTokensPerSecond <= 0) {
    throw new Error(`streamThrottle: maxTokensPerSecond must be > 0 (got ${maxTokensPerSecond}).`);
  }
  if (typeof countTokens !== 'function') {
    throw new Error('streamThrottle: countTokens must be a function.');
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('streamThrottle: skipMethods must be an array.');
  }
  if (onDelay != null && typeof onDelay !== 'function') {
    throw new Error('streamThrottle: onDelay must be a function or null.');
  }

  const skipSet = new Set(skipMethods);
  const msPerToken = 1000 / maxTokensPerSecond;

  const stats = {
    totalStreams:   0,
    totalChunks:    0,
    totalTokens:    0,
    totalDelayMs:   0,
    skippedStreams: 0,
  };

  function wrapIterator(source, wrappedInfo) {
    return (async function* throttled() {
      const startedAt = now();
      let tokensEmitted = 0;
      stats.totalStreams++;

      for await (const chunk of source) {
        stats.totalChunks++;
        const tokens = Math.max(0, countTokens(chunk) ?? 0);
        tokensEmitted += tokens;
        stats.totalTokens += tokens;

        const targetElapsedMs = tokensEmitted * msPerToken;
        const actualElapsedMs = now() - startedAt;
        const delayMs = Math.max(0, targetElapsedMs - actualElapsedMs);

        if (delayMs > 0) {
          stats.totalDelayMs += delayMs;
          if (onDelay) {
            try { onDelay({ delayMs, tokensEmitted, tokensThisChunk: tokens }); }
            catch { /* swallow */ }
          }
          await sleep(delayMs);
        }

        yield chunk;
      }
    })();
  }

  const mw = async (ctx, next) => {
    const result = await next();

    if (skipSet.has(ctx?.method)) return result;

    const { hasStreamCompletion } = require('../streamCompletion');
    if (!hasStreamCompletion(result)) {
      // Not a wrapped stream — either non-stream call or an unwrapped iterable.
      // Bail out; we only throttle wrapped streams to preserve onComplete semantics.
      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        stats.skippedStreams++;
      }
      return result;
    }

    // Wrap the async iterator without touching the completion machinery.
    // The onComplete callbacks fire from the ORIGINAL source's iteration —
    // by delaying yields upstream we keep the completion event as the last
    // thing that fires. But we also need consumers who iterate the throttled
    // wrapper to correctly trigger the source's Symbol.asyncIterator, which
    // is what runs the completion tracker. Fortunately, our throttled
    // generator awaits `for await (const chunk of source)` — that IS the
    // source's Symbol.asyncIterator invocation. So the completion tracker
    // still fires on the original schedule, just paced.
    const throttled = wrapIterator(result, result);
    // Preserve the completion tracker's onComplete + isCompleted APIs.
    throttled.onComplete   = result.onComplete.bind(result);
    Object.defineProperty(throttled, 'completedInfo', {
      get() { return result.completedInfo; },
    });
    Object.defineProperty(throttled, 'isCompleted', {
      get() { return result.isCompleted; },
    });
    // Preserve the marker so subsequent hasStreamCompletion checks still
    // detect this as a wrapped stream.
    const MARKER = Symbol.for('cds-plugin-llm.streamCompletion');
    throttled[MARKER] = true;

    return throttled;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalStreams = stats.totalChunks = stats.totalTokens = 0;
    stats.totalDelayMs = stats.skippedStreams = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://stream-throttle',
    name: 'Streaming token throttler',
    description: 'Rate-limits stream chunk emission for smooth UI cursor. Counters + config.',
    mimeType: 'application/json',
    handler: () => ({
      maxTokensPerSecond,
      msPerToken,
      skipMethods: [...skipSet],
      ...stats,
    }),
  });

  return mw;
}

// ---- Default token counter ------------------------------------------

/**
 * Rough character-count heuristic: 4 chars ≈ 1 token. Good enough for
 * throttling purposes; users who want proper token counts should pass
 * a real tokenizer.
 */
function defaultCountTokens(chunk) {
  if (!chunk) return 0;
  if (typeof chunk.text === 'string') return chunk.text.length / 4;
  if (typeof chunk === 'string')       return chunk.length / 4;
  return 0;
}

module.exports = {
  streamThrottle,
  defaultCountTokens,
};
