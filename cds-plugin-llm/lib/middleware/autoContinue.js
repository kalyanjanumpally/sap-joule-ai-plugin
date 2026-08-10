// Auto-continuation middleware. Detects responses that were cut
// off by the provider's maxTokens limit (stopReason: 'max_tokens'
// on Anthropic, 'length' on OpenAI-compat, 'MAX_TOKENS' on
// Gemini) and automatically re-invokes the chain with a "continue
// from where you left off" user message, stitching results.
//
// Handles the long-prose case (summaries, drafts, explanations)
// that hit the token cap. Structured extractions with `format:`
// are SKIPPED by default because you can't safely concatenate two
// halves of JSON output — bump `maxTokens` or use adaptiveMaxTokens
// (1.63) instead.
//
//   const { autoContinue } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(autoContinue({
//     maxContinuations: 2,
//     onContinue: (info) => cds.log('llm:continue').info(info),
//   }));
//
//   const res = await llm.chat({ maxTokens: 500, ... });
//   //  If model hit 500 → auto-continued transparently.
//   //  res.text contains the full stitched output.
//   //  res.usage sums tokens across all attempts.
//
// Non-destructive to ctx.request — mutates for inner next() calls
// only, restores in a finally block.
//
// Streams are NOT auto-continued in v1 — stream consumers see
// chunks live and can handle truncation themselves. Structured
// extractions (with `format:`) are also skipped — see above.

const DEFAULT_TRIGGERS = ['max_tokens', 'length', 'MAX_TOKENS'];
const DEFAULT_CONTINUE_PROMPT =
  'Continue from exactly where you left off. Do not repeat any content, do not add preamble, do not summarize. Just continue.';

function autoContinue(options = {}) {
  const {
    triggers          = DEFAULT_TRIGGERS,
    maxContinuations  = 3,
    continuePrompt    = DEFAULT_CONTINUE_PROMPT,
    onContinue        = null,
    onGiveUp          = null,
    methods           = ['chat'],
    skipStructured    = true,
    skipStreams       = true,
  } = options;

  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new Error('autoContinue: triggers must be a non-empty array of stopReason strings.');
  }
  if (!Number.isInteger(maxContinuations) || maxContinuations < 1) {
    throw new Error(`autoContinue: maxContinuations must be a positive integer (got ${maxContinuations}).`);
  }
  if (typeof continuePrompt !== 'string' || continuePrompt.length === 0) {
    throw new Error('autoContinue: continuePrompt must be a non-empty string.');
  }
  if (!Array.isArray(methods)) {
    throw new Error('autoContinue: methods must be an array.');
  }
  if (onContinue != null && typeof onContinue !== 'function') {
    throw new Error('autoContinue: onContinue must be a function.');
  }
  if (onGiveUp != null && typeof onGiveUp !== 'function') {
    throw new Error('autoContinue: onGiveUp must be a function.');
  }

  const triggerSet = new Set(triggers);
  const methodSet  = new Set(methods);

  const stats = {
    totalRequests:      0,
    requestsContinued:  0,
    totalContinuations: 0,
    giveUps:            0,
    byStopReason:       {},
  };

  function shouldContinue(result) {
    if (!result || typeof result !== 'object') return false;
    const reason = result.stopReason;
    if (!reason) return false;
    return triggerSet.has(reason);
  }

  function mergeText(a, b) {
    // Simple concatenation. The continuation prompt asks the model NOT to
    // repeat, so no dedup logic — the model is responsible.
    return (a ?? '') + (b ?? '');
  }

  function mergeUsage(a, b) {
    if (!a && !b) return null;
    if (!a) return { ...b };
    if (!b) return { ...a };
    const out = { ...a };
    // Sum numeric fields; keep first for non-numeric.
    for (const k of Object.keys(b)) {
      if (typeof a[k] === 'number' && typeof b[k] === 'number') {
        out[k] = a[k] + b[k];
      } else if (a[k] === undefined) {
        out[k] = b[k];
      }
    }
    return out;
  }

  const mw = async (ctx, next) => {
    stats.totalRequests++;

    if (!methodSet.has(ctx?.method)) return next();
    if (skipStructured && ctx?.request?.format != null) return next();

    const original = ctx.request;
    let merged = await next();

    // Streams: v1 doesn't attempt to continue.
    if (skipStreams) {
      const { hasStreamCompletion } = require('../streamCompletion');
      if (hasStreamCompletion(merged)) return merged;
    }

    let attempt = 0;
    while (attempt < maxContinuations && shouldContinue(merged)) {
      const reason = merged.stopReason;
      stats.byStopReason[reason] = (stats.byStopReason[reason] ?? 0) + 1;

      const priorMessages = Array.isArray(original.messages) ? original.messages : [];
      const priorAssistantText = merged.text ?? '';
      const nextMessages = [
        ...priorMessages,
        { role: 'assistant', content: priorAssistantText },
        { role: 'user',      content: continuePrompt },
      ];

      const patched = { ...original, messages: nextMessages };
      ctx.request = patched;

      let piece;
      try {
        piece = await next();
      } finally {
        ctx.request = original;
      }

      if (attempt === 0) stats.requestsContinued++;
      stats.totalContinuations++;
      attempt++;

      if (onContinue) {
        try {
          onContinue({
            attempt,
            triggeredBy: reason,
            addedChars: (piece?.text?.length ?? 0),
            totalChars: (merged.text?.length ?? 0) + (piece?.text?.length ?? 0),
            method: ctx.method,
          });
        } catch { /* swallow */ }
      }

      // Merge piece into merged.
      merged = {
        ...merged,
        text:       mergeText(merged.text, piece?.text),
        usage:      mergeUsage(merged.usage, piece?.usage),
        stopReason: piece?.stopReason ?? merged.stopReason,
        model:      piece?.model ?? merged.model,
      };
    }

    if (shouldContinue(merged)) {
      // Cap exhausted; caller can inspect merged.stopReason to know.
      stats.giveUps++;
      if (onGiveUp) {
        try { onGiveUp({ finalStopReason: merged.stopReason, attempts: attempt, method: ctx.method }); }
        catch { /* swallow */ }
      }
    }

    return merged;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.requestsContinued = stats.totalContinuations = stats.giveUps = 0;
    for (const k of Object.keys(stats.byStopReason)) delete stats.byStopReason[k];
  };
  mw.asMcpResource = () => ({
    uri: 'config://auto-continue',
    name: 'Auto-continuation middleware',
    description: 'Auto-continues truncated (max_tokens) responses. Counters + config.',
    mimeType: 'application/json',
    handler: () => ({
      maxContinuations,
      triggers:  [...triggerSet],
      methods:   [...methodSet],
      skipStructured,
      skipStreams,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  autoContinue,
  DEFAULT_TRIGGERS,
  DEFAULT_CONTINUE_PROMPT,
};
