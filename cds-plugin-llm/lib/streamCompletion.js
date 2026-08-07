// Stream completion tracker. Wraps an async iterable so downstream
// middleware can hook into 'stream fully consumed' events. Fixes the
// long-standing gap where middleware relying on `finally` (bulkhead
// slot release, breaker success/failure, jsonLog completion) fired
// as soon as `next()` returned the iterable — NOT when the stream
// actually ended.
//
// The wrapper:
//   - Yields each chunk unchanged (preserves lazy streaming semantics)
//   - Tracks chunk count + captures the final 'done' chunk
//   - Fires all onComplete(info) callbacks when the stream finishes
//     (success or error path — always exactly once)
//
// Middleware pattern:
//
//   const mw = async (ctx, next) => {
//     const result = await next();
//     if (hasStreamCompletion(result)) {
//       result.onComplete((info) => {
//         // Fires when the stream is fully consumed.
//         // info = { ok, error, chunkCount, durationMs, doneChunk }
//         releaseResources();
//       });
//       return result;
//     }
//     releaseResources();   // non-stream: existing sync path
//     return result;
//   };
//
// Auto-applied to every llm.stream() call in LLMService — middleware
// authors just need to check hasStreamCompletion() and hook into it.

const STREAM_COMPLETION_MARKER = Symbol.for('cds-plugin-llm.streamCompletion');

function wrapStreamCompletion(iter) {
  if (iter && iter[STREAM_COMPLETION_MARKER]) {
    // Already wrapped — idempotent. Nested middleware wrapping
    // (e.g. two middleware both trying to wrap) safely no-ops.
    return iter;
  }

  const completionCbs = [];
  let completedInfo = null;   // { ok, error, doneChunk, chunkCount, durationMs }
  const startedAt = Date.now();
  let chunkCount = 0;
  let doneChunk = null;

  function fireCompletion(info) {
    completedInfo = info;
    for (const cb of completionCbs) {
      try { cb(info); } catch { /* swallow — never break the stream on a bad callback */ }
    }
    completionCbs.length = 0;
  }

  const wrapped = {
    [STREAM_COMPLETION_MARKER]: true,

    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of iter) {
          chunkCount++;
          if (chunk && chunk.type === 'done') doneChunk = chunk;
          yield chunk;
        }
        fireCompletion({
          ok:          true,
          error:       null,
          chunkCount,
          durationMs:  Date.now() - startedAt,
          doneChunk,
        });
      } catch (e) {
        fireCompletion({
          ok:          false,
          error:       e,
          chunkCount,
          durationMs:  Date.now() - startedAt,
          doneChunk,
        });
        throw e;
      }
    },

    /**
     * Register a callback fired exactly once when the stream is fully
     * consumed. If the stream has already completed by the time you
     * register, fires synchronously with the captured info. Callback
     * exceptions are swallowed — a broken subscriber never affects
     * the stream or other subscribers.
     */
    onComplete(cb) {
      if (typeof cb !== 'function') {
        throw new Error('wrapStreamCompletion.onComplete: callback must be a function');
      }
      if (completedInfo) {
        try { cb(completedInfo); } catch { /* swallow */ }
      } else {
        completionCbs.push(cb);
      }
    },

    /** Immutable snapshot — null until the stream finishes. */
    get completedInfo() { return completedInfo; },
    get isCompleted() { return completedInfo != null; },
  };

  return wrapped;
}

/**
 * Return true if `x` looks like a stream envelope from wrapStreamCompletion.
 * Middleware uses this to decide whether to defer 'finally' logic to
 * onComplete or run it immediately (chat/embed path).
 */
function hasStreamCompletion(x) {
  return !!(x && x[STREAM_COMPLETION_MARKER] === true && typeof x.onComplete === 'function');
}

module.exports = { wrapStreamCompletion, hasStreamCompletion, STREAM_COMPLETION_MARKER };
