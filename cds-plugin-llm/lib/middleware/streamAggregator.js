// Streaming chunk aggregator. Buffers per-token chunks from the
// provider and emits aggregated chunks either when the buffer reaches
// `minChars` OR when it's been sitting for `maxIdleMs`. Reduces
// cursor jitter in chat UIs when the provider emits per-character
// chunks (some OpenAI-compat endpoints, some local models) that make
// the cursor look drunk.
//
// Distinct from the shipped `streamThrottle` (1.97) — that primitive
// PACES existing chunks with a delay; this one COMBINES chunks so
// there are fewer to render. Use both together when you want:
//   1) fewer chunks (aggregator, this)
//   2) at a smooth cadence (throttle)
//
//   const { streamAggregator } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(streamAggregator({
//     minChars:  20,      // flush when buffer >= 20 chars
//     maxIdleMs: 100,     // flush anyway after 100ms idle
//   }));
//
// Preserves the 1.72 stream completion tracker — non-text chunks
// (including the `done` chunk) pass through untouched, so onComplete
// callbacks still fire correctly. Only text chunks are coalesced.

function defaultExtractText(chunk) {
  if (chunk == null) return null;
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk.text === 'string') return chunk.text;
  return null;
}

function defaultMakeAggregatedChunk(text) {
  return { text };
}

function isTerminalChunk(chunk) {
  // wrapStreamCompletion (1.72) yields a chunk with `.done: true` or
  // `.isDone: true` OR `.type === 'done'` as the last item. Don't
  // buffer these — pass through immediately so the completion tracker
  // sees them.
  if (!chunk || typeof chunk !== 'object') return false;
  return chunk.done === true
      || chunk.isDone === true
      || chunk.type === 'done'
      || chunk.finish_reason != null
      || chunk.stopReason != null;
}

function streamAggregator(options = {}) {
  const {
    minChars      = 20,
    maxIdleMs     = 100,
    skipMethods   = ['chat', 'embed', 'batch'],
    extractText   = defaultExtractText,
    makeChunk     = defaultMakeAggregatedChunk,
    onFlush       = null,
    now           = () => Date.now(),
  } = options;

  if (!Number.isInteger(minChars) || minChars < 1) {
    throw new Error(`streamAggregator: minChars must be a positive integer (got ${minChars}).`);
  }
  if (!Number.isFinite(maxIdleMs) || maxIdleMs < 0) {
    throw new Error(`streamAggregator: maxIdleMs must be >= 0 (got ${maxIdleMs}).`);
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('streamAggregator: skipMethods must be an array.');
  }
  if (typeof extractText !== 'function' || typeof makeChunk !== 'function') {
    throw new Error('streamAggregator: extractText + makeChunk must be functions.');
  }
  if (onFlush != null && typeof onFlush !== 'function') {
    throw new Error('streamAggregator: onFlush must be a function or null.');
  }

  const skipSet = new Set(skipMethods);

  const stats = {
    totalStreams:       0,
    totalSourceChunks:  0,
    totalEmittedChunks: 0,
    totalChars:         0,
    idleFlushes:        0,
    threshFlushes:      0,
    finalFlushes:       0,
    passthroughChunks:  0,
    skippedStreams:     0,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function wrapIterator(source) {
    return (async function* aggregated() {
      stats.totalStreams++;
      const it = source[Symbol.asyncIterator]();
      let buffer = '';
      let firstBufferedAt = null;
      let pendingNext = it.next();

      const flush = (reason) => {
        const text = buffer;
        buffer = '';
        firstBufferedAt = null;
        stats.totalEmittedChunks++;
        stats.totalChars += text.length;
        if (reason === 'idle')     stats.idleFlushes++;
        else if (reason === 'threshold') stats.threshFlushes++;
        else if (reason === 'final')     stats.finalFlushes++;
        callHook(onFlush, { text, reason, size: text.length });
        return makeChunk(text);
      };

      while (true) {
        // If there's buffered text and maxIdleMs > 0, race the next
        // source chunk against an idle timer. Otherwise just await.
        let winner;
        if (firstBufferedAt !== null && maxIdleMs > 0) {
          const idleDelay = Math.max(0, maxIdleMs - (now() - firstBufferedAt));
          let timerId;
          const idlePromise = new Promise((resolve) => {
            timerId = setTimeout(() => resolve('timeout'), idleDelay);
            timerId.unref?.();
          });
          winner = await Promise.race([
            pendingNext.then((r) => ({ kind: 'chunk', r })),
            idlePromise.then(() => ({ kind: 'timeout' })),
          ]);
          clearTimeout(timerId);
        } else {
          winner = { kind: 'chunk', r: await pendingNext };
        }

        if (winner.kind === 'timeout') {
          if (buffer.length > 0) yield flush('idle');
          // pendingNext still in flight — loop and race again.
          continue;
        }

        const { value, done: srcDone } = winner.r;
        if (srcDone) {
          if (buffer.length > 0) yield flush('final');
          return;
        }

        // Kick off the next fetch immediately.
        pendingNext = it.next();
        stats.totalSourceChunks++;

        // Terminal chunk (done/stopReason) — flush buffer first, then
        // pass the terminal chunk through so the completion tracker
        // fires with the correct `doneChunk`.
        if (isTerminalChunk(value)) {
          if (buffer.length > 0) yield flush('final');
          stats.passthroughChunks++;
          yield value;
          continue;
        }

        const text = extractText(value);
        if (text == null || text.length === 0) {
          // Non-text chunk (e.g., tool_use delta, metadata) — flush any
          // pending buffer first, then pass the chunk through so ordering
          // is preserved.
          if (buffer.length > 0) yield flush('threshold');
          stats.passthroughChunks++;
          yield value;
          continue;
        }

        if (firstBufferedAt === null) firstBufferedAt = now();
        buffer += text;
        if (buffer.length >= minChars) {
          yield flush('threshold');
        }
      }
    })();
  }

  const mw = async (ctx, next) => {
    const result = await next();

    if (skipSet.has(ctx?.method)) return result;

    const { hasStreamCompletion } = require('../streamCompletion');
    if (!hasStreamCompletion(result)) {
      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        stats.skippedStreams++;
      }
      return result;
    }

    const wrapped = wrapIterator(result);
    // Preserve the completion tracker's onComplete + isCompleted APIs.
    wrapped.onComplete = result.onComplete.bind(result);
    Object.defineProperty(wrapped, 'completedInfo', { get() { return result.completedInfo; } });
    Object.defineProperty(wrapped, 'isCompleted',   { get() { return result.isCompleted; } });
    // Preserve the marker so subsequent hasStreamCompletion checks still
    // detect this as a wrapped stream.
    const MARKER = Symbol.for('cds-plugin-llm.streamCompletion');
    wrapped[MARKER] = true;

    return wrapped;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalStreams = stats.totalSourceChunks = stats.totalEmittedChunks = 0;
    stats.totalChars = stats.idleFlushes = stats.threshFlushes = stats.finalFlushes = 0;
    stats.passthroughChunks = stats.skippedStreams = 0;
  };
  mw.reductionRatio = () => {
    return stats.totalSourceChunks === 0 ? 0 : 1 - (stats.totalEmittedChunks / stats.totalSourceChunks);
  };
  mw.asMcpResource = () => ({
    uri: 'config://stream-aggregator',
    name: 'Streaming chunk aggregator',
    description: 'Buffers per-token chunks and emits aggregated batches when the buffer is full or idle. Reduces UI cursor jitter.',
    mimeType: 'application/json',
    handler: () => ({
      minChars, maxIdleMs,
      skipMethods: [...skipSet],
      reductionRatio: mw.reductionRatio(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  streamAggregator,
  // Exposed for tests + composition.
  defaultExtractText,
  defaultMakeAggregatedChunk,
  isTerminalChunk,
};
