// Content-length gate. Pre-flight validation that rejects (or trims)
// prompts exceeding a configured char/token budget BEFORE they hit the
// provider. Prevents 400 errors on over-limit contexts + saves tokens
// on obviously-too-large inputs.
//
// Distinct from time-based limiters:
//   * `deadline` (1.x)         — hard TIME timeout
//   * `gracePeriod` (2.28)      — soft TIME warning + optional hard
//   * `contentLengthGate` (this) — SIZE-based pre-flight validation
//
// Complements `compactHistory` (1.91) which SUMMARIZES rolling
// conversations: gate catches too-large single requests; compact
// history keeps long conversations bounded.
//
//   const { contentLengthGate } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(contentLengthGate({
//     modelLimits: {
//       'gpt-4o':          128_000,
//       'gpt-4o-mini':     128_000,
//       'claude-opus-4-7': 200_000,
//       'default':          64_000,
//     },
//     overageMode: 'truncate-oldest',   // 'throw' | 'truncate-oldest' | 'log'
//     onOverage:   (i) => cds.log('llm:size').warn('over-limit', i),
//   }));

const { LLMError } = require('../errors');

const OVERAGE_MODES = Object.freeze(['throw', 'truncate-oldest', 'log']);

class ContentLengthExceededError extends LLMError {
  constructor({ tokens, chars, limitTokens, model }) {
    super(
      `contentLengthGate: request over limit — ${tokens} tokens (~${chars} chars) > ${limitTokens} for model "${model}".`,
      'CONTENT_LENGTH_EXCEEDED',
    );
    this.tokens      = tokens;
    this.chars       = chars;
    this.limitTokens = limitTokens;
    this.model       = model;
  }
}

// Rough tokenizer: 1 token ≈ 4 characters (GPT-family heuristic).
// Callers with real tokenizers pass `tokenEstimator`.
function defaultTokenEstimator(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

// Walks the request and returns an array of `{ path, text }` entries
// for every text-bearing string field. Same shape as
// reversibleTokenization's extractor so the two compose cleanly.
function defaultExtractText(request) {
  const strings = [];
  if (!request || typeof request !== 'object') return strings;
  if (typeof request.prompt === 'string') strings.push({ path: 'prompt', text: request.prompt });
  if (typeof request.system === 'string') strings.push({ path: 'system', text: request.system });
  if (Array.isArray(request.messages)) {
    for (let i = 0; i < request.messages.length; i++) {
      const m = request.messages[i];
      if (typeof m?.content === 'string') {
        strings.push({ path: `messages[${i}].content`, text: m.content, role: m.role });
      } else if (Array.isArray(m?.content)) {
        for (let j = 0; j < m.content.length; j++) {
          const block = m.content[j];
          if (typeof block?.text === 'string') {
            strings.push({ path: `messages[${i}].content[${j}].text`, text: block.text, role: m.role });
          }
        }
      }
    }
  }
  return strings;
}

function contentLengthGate(options = {}) {
  const {
    modelLimits          = { default: 64_000 },
    modelOf              = (ctx) => ctx?.request?.model,
    tokenEstimator       = defaultTokenEstimator,
    extractText          = defaultExtractText,
    overageMode          = 'throw',
    preserveSystem       = true,      // don't truncate system messages
    preserveLatestUser   = true,      // don't truncate the latest user message
    onOverage            = null,
    onTruncate           = null,
    onError              = null,
  } = options;

  if (modelLimits == null || typeof modelLimits !== 'object') {
    throw new Error('contentLengthGate: modelLimits must be an object mapping modelName → maxTokens.');
  }
  for (const [k, v] of Object.entries(modelLimits)) {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`contentLengthGate: modelLimits.${k} must be a positive integer (got ${v}).`);
    }
  }
  if (typeof modelOf !== 'function') {
    throw new Error('contentLengthGate: modelOf must be a function.');
  }
  if (typeof tokenEstimator !== 'function') {
    throw new Error('contentLengthGate: tokenEstimator must be a function.');
  }
  if (typeof extractText !== 'function') {
    throw new Error('contentLengthGate: extractText must be a function.');
  }
  if (!OVERAGE_MODES.includes(overageMode)) {
    throw new Error(`contentLengthGate: overageMode must be one of ${OVERAGE_MODES.join(', ')} (got ${JSON.stringify(overageMode)}).`);
  }
  for (const cb of [onOverage, onTruncate, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('contentLengthGate: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:       0,
    underLimit:       0,
    overageCount:     0,
    thrownCount:      0,
    truncatedCount:   0,
    loggedCount:      0,
    unknownModelCount: 0,
    messagesDropped:  0,
    lastModel:        null,
    lastTokens:       null,
    lastLimit:        null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function limitFor(model) {
    if (typeof model === 'string' && modelLimits[model] != null) return modelLimits[model];
    return modelLimits.default ?? null;
  }

  function totalSize(entries) {
    let chars = 0;
    let tokens = 0;
    for (const e of entries) {
      chars += e.text.length;
      tokens += tokenEstimator(e.text);
    }
    return { chars, tokens };
  }

  function truncateRequest(request, limitTokens) {
    // Only messages[] can be truncated. Drop oldest messages one by
    // one until under limit, preserving system + latest user.
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      return { request, dropped: 0, finalTokens: totalSize(extractText(request)).tokens };
    }
    const messages = request.messages.slice();
    // Identify indices we must NOT drop.
    const preservedIdx = new Set();
    if (preserveSystem) {
      // Preserve ALL system messages (typically only one at index 0).
      messages.forEach((m, i) => { if (m?.role === 'system') preservedIdx.add(i); });
    }
    if (preserveLatestUser) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') { preservedIdx.add(i); break; }
      }
    }

    // Walk from oldest to newest, dropping non-preserved messages until
    // we're under the limit.
    let dropped = 0;
    let dropIndices = [];
    for (let i = 0; i < messages.length; i++) {
      if (preservedIdx.has(i)) continue;
      dropIndices.push(i);
    }

    let currentTokens = totalSize(extractText({ ...request, messages })).tokens;
    while (currentTokens > limitTokens && dropIndices.length > 0) {
      const dropIdx = dropIndices.shift();   // oldest droppable
      // Actually drop it from messages by nulling; we'll compact at end.
      messages[dropIdx] = null;
      dropped++;
      const rebuilt = messages.filter((m) => m !== null);
      currentTokens = totalSize(extractText({ ...request, messages: rebuilt })).tokens;
    }
    const finalMessages = messages.filter((m) => m !== null);
    return {
      request:     { ...request, messages: finalMessages },
      dropped,
      finalTokens: currentTokens,
    };
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let model;
    try { model = modelOf(ctx); }
    catch (err) {
      callHook(onError, { phase: 'modelOf', error: err });
      return next();
    }
    stats.lastModel = model ?? null;

    const limit = limitFor(model);
    if (limit == null) {
      stats.unknownModelCount++;
      return next();   // no limit configured → passthrough
    }

    let entries;
    try { entries = extractText(ctx?.request); }
    catch (err) {
      callHook(onError, { phase: 'extractText', error: err });
      return next();
    }
    if (!Array.isArray(entries)) entries = [];

    const size = totalSize(entries);
    stats.lastTokens = size.tokens;
    stats.lastLimit  = limit;

    if (size.tokens <= limit) {
      stats.underLimit++;
      return next();
    }

    // Over limit — apply policy.
    stats.overageCount++;
    callHook(onOverage, {
      chars: size.chars, tokens: size.tokens,
      limitTokens: limit, model, mode: overageMode,
    });

    if (overageMode === 'throw') {
      stats.thrownCount++;
      throw new ContentLengthExceededError({
        tokens: size.tokens, chars: size.chars, limitTokens: limit, model,
      });
    }

    if (overageMode === 'log') {
      stats.loggedCount++;
      return next();   // pass through untouched — let the provider decide
    }

    // 'truncate-oldest'
    const originalRequest = ctx.request;
    const { request: truncated, dropped, finalTokens } = truncateRequest(originalRequest, limit);
    stats.truncatedCount++;
    stats.messagesDropped += dropped;
    callHook(onTruncate, {
      chars: size.chars, tokens: size.tokens,
      limitTokens: limit, model,
      messagesDropped: dropped, finalTokens,
    });
    ctx.request = truncated;
    try {
      return await next();
    } finally {
      ctx.request = originalRequest;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.underLimit = stats.overageCount = 0;
    stats.thrownCount = stats.truncatedCount = stats.loggedCount = 0;
    stats.unknownModelCount = stats.messagesDropped = 0;
    stats.lastModel = stats.lastTokens = stats.lastLimit = null;
  };
  mw.overageRate = () => {
    return stats.totalCalls === 0 ? 0 : stats.overageCount / stats.totalCalls;
  };
  mw.asMcpResource = () => ({
    uri: 'config://content-length-gate',
    name: 'Content-length gate',
    description: 'Pre-flight rejection or truncation of over-limit prompts. Prevents 400 errors + saves tokens.',
    mimeType: 'application/json',
    handler: () => ({
      modelLimits,
      overageMode,
      preserveSystem,
      preserveLatestUser,
      overageRate: mw.overageRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  contentLengthGate,
  ContentLengthExceededError,
  defaultTokenEstimator,
  defaultExtractText,
  OVERAGE_MODES,
};
