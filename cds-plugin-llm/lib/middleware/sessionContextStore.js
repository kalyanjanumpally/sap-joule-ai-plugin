// Session context store. Multi-turn memory management for chat apps.
// On each call:
//   1. Extract session ID from ctx
//   2. Load prior messages from the store
//   3. Prepend them to `request.messages` (system prompt preserved at
//      the front)
//   4. Call downstream
//   5. Append the new user turn + assistant response to the store
//   6. Prune to `maxMessages` (drop oldest) or summarize via the
//      caller-supplied summarizer
//
//   const { sessionContextStore, inMemorySessionStore } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(sessionContextStore({
//     sessionOf:   (ctx) => ctx.request.sessionId,
//     store:       inMemorySessionStore({ maxSessions: 10_000, ttlMs: 3600_000 }),
//     maxMessages: 20,
//     // Optional: summarize dropped messages instead of just dropping them.
//     pruneStrategy: 'summarize',
//     summarizer: async (dropped) => (await llm.chat({
//       messages: [{ role: 'user', content: 'Summarize these messages briefly:\n' + JSON.stringify(dropped) }],
//     })).text,
//     onSessionHit:  (i) => cds.log('llm:session').debug('hit',  i),
//     onSessionMiss: (i) => cds.log('llm:session').debug('miss', i),
//   }));
//
// Streaming is skipped by default — appending to the store after the
// stream finishes requires stream-completion tracking (v1.72+) which
// this middleware doesn't wire in yet. Set `skipStreaming: false` if
// you handle the stream ↔ store dance yourself.

// ---- In-memory store -------------------------------------------------

function inMemorySessionStore(options = {}) {
  const {
    maxSessions = 10_000,
    ttlMs       = null,
    now         = () => Date.now(),
  } = options;

  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error(`inMemorySessionStore: maxSessions must be a positive integer (got ${maxSessions}).`);
  }
  if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new Error(`inMemorySessionStore: ttlMs must be null or > 0 (got ${ttlMs}).`);
  }

  // Map preserves insertion order → cheap LRU eviction.
  const sessions = new Map();

  function isExpired(entry) {
    return ttlMs != null && (now() - entry.ts) > ttlMs;
  }

  return {
    async get(sessionId) {
      const e = sessions.get(sessionId);
      if (!e) return null;
      if (isExpired(e)) { sessions.delete(sessionId); return null; }
      sessions.delete(sessionId); sessions.set(sessionId, e);   // refresh LRU
      return e.messages.slice();
    },
    async put(sessionId, messages) {
      if (sessions.has(sessionId)) sessions.delete(sessionId);
      if (sessions.size >= maxSessions) {
        sessions.delete(sessions.keys().next().value);
      }
      sessions.set(sessionId, { messages: messages.slice(), ts: now() });
    },
    async append(sessionId, ...newMessages) {
      const existing = (await this.get(sessionId)) ?? [];
      await this.put(sessionId, [...existing, ...newMessages]);
    },
    async delete(sessionId) { sessions.delete(sessionId); },
    async size() { return sessions.size; },
    _sessions: sessions,   // exposed for tests
  };
}

// ---- Prune helpers ---------------------------------------------------

function pruneOldest(messages, maxMessages) {
  if (messages.length <= maxMessages) return { kept: messages, dropped: [] };
  // Preserve a leading system message if present.
  const hasSystem = messages[0]?.role === 'system';
  const systemMsg = hasSystem ? messages[0] : null;
  const body      = hasSystem ? messages.slice(1) : messages;
  const budget    = hasSystem ? maxMessages - 1 : maxMessages;
  if (body.length <= budget) return { kept: messages, dropped: [] };
  const dropped = body.slice(0, body.length - budget);
  const kept    = hasSystem ? [systemMsg, ...body.slice(body.length - budget)] : body.slice(body.length - budget);
  return { kept, dropped };
}

// ---- Middleware -----------------------------------------------------

function sessionContextStore(options = {}) {
  const {
    sessionOf,
    store,
    maxMessages     = 20,
    pruneStrategy   = 'oldest',      // 'oldest' | 'summarize'
    summarizer      = null,          // async (dropped) => string
    summaryTag      = 'Summary of earlier conversation',
    skipStreaming   = true,
    onSessionHit    = null,
    onSessionMiss   = null,
    onPrune         = null,
    onError         = null,
  } = options;

  if (typeof sessionOf !== 'function') {
    throw new Error('sessionContextStore: sessionOf must be a function (ctx) => sessionId.');
  }
  if (!store || typeof store.get !== 'function' || typeof store.append !== 'function' || typeof store.put !== 'function') {
    throw new Error('sessionContextStore: store must implement { get, put, append }.');
  }
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new Error(`sessionContextStore: maxMessages must be a positive integer (got ${maxMessages}).`);
  }
  if (!['oldest', 'summarize'].includes(pruneStrategy)) {
    throw new Error(`sessionContextStore: pruneStrategy must be 'oldest' or 'summarize' (got ${JSON.stringify(pruneStrategy)}).`);
  }
  if (pruneStrategy === 'summarize' && typeof summarizer !== 'function') {
    throw new Error('sessionContextStore: pruneStrategy=summarize requires a summarizer function.');
  }
  if (typeof summaryTag !== 'string') {
    throw new Error('sessionContextStore: summaryTag must be a string.');
  }
  for (const cb of [onSessionHit, onSessionMiss, onPrune, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('sessionContextStore: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:          0,
    sessionHits:         0,
    sessionMisses:       0,
    passthroughs:        0,      // no session ID → skip
    skippedStreaming:    0,
    turnsAppended:       0,
    prunes:              0,
    summarizations:      0,
    storeErrors:         0,
    lastSession:         null,
    lastPriorTurnCount:  null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  // Extract the LATEST user message from an outbound request. Used
  // when appending: we want to persist the new user turn (not the
  // whole history we just prepended).
  function extractNewUserTurn(request, priorLen) {
    if (!Array.isArray(request?.messages)) return null;
    // The prepended prior messages sit at indices [0, priorLen). The
    // new user turn is anywhere from priorLen onward. Prefer the last
    // user-role message overall.
    for (let i = request.messages.length - 1; i >= priorLen; i--) {
      const m = request.messages[i];
      if (m?.role === 'user') return m;
    }
    return null;
  }

  // Build the assistant reply message to persist.
  function extractAssistantTurn(result) {
    if (!result || typeof result !== 'object') return null;
    const content = typeof result.text === 'string' ? result.text : null;
    if (content == null && !Array.isArray(result.toolCalls)) return null;
    const msg = { role: 'assistant' };
    if (content != null) msg.content = content;
    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) msg.toolCalls = result.toolCalls;
    return msg;
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    if (skipStreaming && (ctx?.method === 'stream' || ctx?.method === 'streamCompletion')) {
      stats.skippedStreaming++;
      return next();
    }

    let sessionId;
    try { sessionId = sessionOf(ctx); }
    catch (err) {
      callHook(onError, { phase: 'sessionOf', error: err });
      throw err;
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      stats.passthroughs++;
      return next();
    }
    stats.lastSession = sessionId;

    // Load prior history.
    let prior = null;
    try { prior = await store.get(sessionId); }
    catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store.get', error: err });
      return next();
    }
    prior = Array.isArray(prior) ? prior : [];
    stats.lastPriorTurnCount = prior.length;

    if (prior.length > 0) {
      stats.sessionHits++;
      callHook(onSessionHit, { sessionId, priorTurnCount: prior.length });
    } else {
      stats.sessionMisses++;
      callHook(onSessionMiss, { sessionId });
    }

    // Prepend prior messages to the request. Preserve any leading
    // system message from the caller's request.
    const originalRequest = ctx.request;
    let priorLen = 0;
    if (prior.length > 0 && Array.isArray(originalRequest?.messages)) {
      const hasCallerSystem = originalRequest.messages[0]?.role === 'system';
      const callerMessages  = originalRequest.messages;
      const priorNoSystem   = prior[0]?.role === 'system' ? prior.slice(1) : prior;
      let mergedMessages;
      if (hasCallerSystem) {
        mergedMessages = [callerMessages[0], ...priorNoSystem, ...callerMessages.slice(1)];
        priorLen = 1 + priorNoSystem.length;
      } else {
        mergedMessages = [...prior, ...callerMessages];
        priorLen = prior.length;
      }
      ctx.request = { ...originalRequest, messages: mergedMessages };
    }

    // Call downstream.
    let result;
    try {
      result = await next();
    } finally {
      ctx.request = originalRequest;
    }

    // Extract the new turn(s) and append to the store.
    const newUserTurn      = extractNewUserTurn(originalRequest, 0);
    const newAssistantTurn = extractAssistantTurn(result);
    const toAppend = [];
    if (newUserTurn && !prior.some((m) => m === newUserTurn)) toAppend.push(newUserTurn);
    if (newAssistantTurn) toAppend.push(newAssistantTurn);

    if (toAppend.length > 0) {
      try {
        await store.append(sessionId, ...toAppend);
        stats.turnsAppended += toAppend.length;
      } catch (err) {
        stats.storeErrors++;
        callHook(onError, { phase: 'store.append', error: err });
        return result;   // don't fail the caller if the store is broken
      }
    }

    // Prune / summarize.
    let all = null;
    try { all = await store.get(sessionId); }
    catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store.get(post-append)', error: err });
      return result;
    }
    if (!all || all.length <= maxMessages) return result;

    const { kept, dropped } = pruneOldest(all, maxMessages);
    if (dropped.length === 0) return result;

    stats.prunes++;
    callHook(onPrune, {
      sessionId, droppedCount: dropped.length, keptCount: kept.length, strategy: pruneStrategy,
    });

    if (pruneStrategy === 'summarize') {
      try {
        const summary = await summarizer(dropped);
        if (typeof summary === 'string' && summary.length > 0) {
          stats.summarizations++;
          // Replace dropped messages with a synthetic assistant summary
          // at the front (below any system prompt).
          const summaryMessage = { role: 'assistant', content: `${summaryTag}:\n${summary}` };
          const hasSystem = kept[0]?.role === 'system';
          const rebuilt = hasSystem ? [kept[0], summaryMessage, ...kept.slice(1)] : [summaryMessage, ...kept];
          try { await store.put(sessionId, rebuilt); }
          catch (err) {
            stats.storeErrors++;
            callHook(onError, { phase: 'store.put(summary)', error: err });
          }
          return result;
        }
      } catch (err) {
        callHook(onError, { phase: 'summarizer', error: err });
        // Fall through to plain drop.
      }
    }

    // Plain drop.
    try { await store.put(sessionId, kept); }
    catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store.put(prune)', error: err });
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.sessionHits = stats.sessionMisses = 0;
    stats.passthroughs = stats.skippedStreaming = 0;
    stats.turnsAppended = stats.prunes = stats.summarizations = stats.storeErrors = 0;
    stats.lastSession = null;
    stats.lastPriorTurnCount = null;
  };
  mw.hitRate = () => {
    const denom = stats.sessionHits + stats.sessionMisses;
    return denom === 0 ? 0 : stats.sessionHits / denom;
  };
  mw.asMcpResource = () => ({
    uri: 'config://session-context-store',
    name: 'Session context store',
    description: 'Per-session message history with sliding-window prune or summarization.',
    mimeType: 'application/json',
    handler: () => ({
      maxMessages, pruneStrategy,
      hasSummarizer: typeof summarizer === 'function',
      skipStreaming,
      hitRate: mw.hitRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  sessionContextStore,
  inMemorySessionStore,
  pruneOldest,
};
