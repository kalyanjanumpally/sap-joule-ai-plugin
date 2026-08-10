// Content safety classifier middleware. Detects unsafe LLM output
// (violence, self-harm, sexual, hate, harassment) via two signals:
//
//   1. Anthropic's built-in safety refusal — surfaced as
//      stopReason: 'refusal' on the response (no extra call needed)
//   2. OpenAI's Moderation API — free, low-latency category
//      classification (violence, hate, sexual, etc.) with per-
//      category scores
//
// Different from guardrails (regex + PII scrubbing) and
// promptInjectionGuard (attack-pattern detection): this middleware
// does true model-based content classification.
//
//   const { safetyClassifier } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(safetyClassifier({
//     apiKey:    process.env.OPENAI_API_KEY,   // for moderation API
//     threshold: 0.5,
//     action:    'block',                       // or 'flag'
//     onFlag: (info) => cds.log('llm:safety').warn(info),
//   }));
//
//   // Response tripping any category > 0.5 → SafetyClassifierBlockedError
//   // Anthropic refusals → same error path
//
// Free-tier: pass no apiKey → skips moderation calls, still catches
// Anthropic refusals via stopReason.
//
// Non-destructive: reads only; never mutates ctx.request or result.

const { LLMError } = require('../errors');

class SafetyClassifierBlockedError extends LLMError {
  constructor({ reason, categories, scores, source }) {
    const catList = Array.isArray(categories) && categories.length > 0
      ? categories.join(', ')
      : 'unknown';
    super(
      `safetyClassifier: response blocked — ${reason} (categories: ${catList})`,
      'SAFETY_CLASSIFIER_BLOCKED',
    );
    this.reason     = reason;
    this.categories = categories;
    this.scores     = scores;
    this.source     = source;   // 'anthropic-refusal' | 'openai-moderation'
  }
}

const DEFAULT_MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const DEFAULT_MODERATION_MODEL    = 'omni-moderation-latest';

function safetyClassifier(options = {}) {
  const {
    apiKey             = null,
    moderationEndpoint = DEFAULT_MODERATION_ENDPOINT,
    moderationModel    = DEFAULT_MODERATION_MODEL,
    threshold          = 0.5,
    action             = 'block',
    categories         = null,     // null = all categories
    checkInput         = false,
    checkOutput        = true,
    skipMethods        = ['embed'],
    onFlag             = null,
    fetch              = globalThis.fetch,
    captureStreams     = true,
  } = options;

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('safetyClassifier: threshold must be a number in [0, 1].');
  }
  if (action !== 'block' && action !== 'flag') {
    throw new Error(`safetyClassifier: action must be 'block' or 'flag' (got ${JSON.stringify(action)}).`);
  }
  if (categories != null && !Array.isArray(categories)) {
    throw new Error('safetyClassifier: categories must be an array or null.');
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('safetyClassifier: skipMethods must be an array.');
  }
  if (onFlag != null && typeof onFlag !== 'function') {
    throw new Error('safetyClassifier: onFlag must be a function.');
  }

  const skipSet = new Set(skipMethods);
  const categorySet = categories ? new Set(categories) : null;

  const stats = {
    totalChecks:      0,
    moderationCalls:  0,
    moderationErrors: 0,
    flagged:          0,
    blocked:          0,
    refusals:         0,
    bySource:         {},
    byCategory:       {},
  };

  // ---- Anthropic refusal detection ---------------------------------

  function detectAnthropicRefusal(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.stopReason === 'refusal') {
      return { source: 'anthropic-refusal', categories: ['refusal'], scores: null };
    }
    return null;
  }

  // ---- OpenAI moderation call ---------------------------------

  async function callModeration(text) {
    if (!apiKey || !text) return null;
    stats.moderationCalls++;
    try {
      const resp = await fetch(moderationEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: moderationModel, input: text }),
      });
      if (!resp.ok) {
        stats.moderationErrors++;
        return null;
      }
      const data = await resp.json();
      const r = data?.results?.[0];
      if (!r) return null;
      const flaggedCats = [];
      const scoreMap = r.category_scores ?? {};
      for (const [cat, score] of Object.entries(scoreMap)) {
        if (categorySet && !categorySet.has(cat)) continue;
        if (typeof score === 'number' && score >= threshold) flaggedCats.push(cat);
      }
      if (flaggedCats.length === 0) return null;
      return { source: 'openai-moderation', categories: flaggedCats, scores: scoreMap };
    } catch {
      stats.moderationErrors++;
      return null;
    }
  }

  // ---- Text extraction ---------------------------------------------

  function textOf(msgs) {
    if (!Array.isArray(msgs)) return '';
    const parts = [];
    for (const m of msgs) {
      if (typeof m?.content === 'string') parts.push(m.content);
      else if (Array.isArray(m?.content)) {
        for (const b of m.content) {
          if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        }
      }
    }
    return parts.join(' ');
  }

  function applyFlag(info, method, ctx, streamMode = false) {
    stats.flagged++;
    stats.bySource[info.source] = (stats.bySource[info.source] ?? 0) + 1;
    for (const c of info.categories ?? []) {
      stats.byCategory[c] = (stats.byCategory[c] ?? 0) + 1;
    }
    if (info.source === 'anthropic-refusal') stats.refusals++;

    if (onFlag) {
      try {
        onFlag({
          source:     info.source,
          categories: info.categories,
          scores:     info.scores,
          method,
          action:     streamMode ? 'flag' : action,
          streamMode,
        });
      } catch { /* swallow */ }
    }

    // Streams can't be blocked mid-flight; always flag-only.
    if (streamMode) return;

    if (action === 'block') {
      stats.blocked++;
      throw new SafetyClassifierBlockedError({
        reason:     info.source === 'anthropic-refusal' ? 'anthropic refused' : 'moderation category exceeded threshold',
        categories: info.categories,
        scores:     info.scores,
        source:     info.source,
      });
    }
  }

  const mw = async (ctx, next) => {
    if (skipSet.has(ctx?.method)) return next();
    stats.totalChecks++;

    // Optional input pre-check.
    if (checkInput && ctx?.request) {
      const inputText = typeof ctx.request.system === 'string'
        ? ctx.request.system + ' ' + textOf(ctx.request.messages)
        : textOf(ctx.request.messages);
      if (inputText) {
        const inputFlag = await callModeration(inputText);
        if (inputFlag) applyFlag(inputFlag, ctx.method, ctx);
      }
    }

    const result = await next();

    // Streams: defer to onComplete + always flag-only.
    const { hasStreamCompletion } = require('../streamCompletion');
    if (captureStreams && hasStreamCompletion(result)) {
      result.onComplete(async (info) => {
        if (!info?.ok || !info.doneChunk) return;
        const refusal = detectAnthropicRefusal(info.doneChunk);
        if (refusal) { try { applyFlag(refusal, ctx.method, ctx, true); } catch { /* stream cannot throw */ } return; }
        if (!checkOutput) return;
        const text = info.doneChunk.text ?? '';
        if (!text) return;
        const flag = await callModeration(text);
        if (flag) { try { applyFlag(flag, ctx.method, ctx, true); } catch { /* stream */ } }
      });
      return result;
    }

    // Non-stream: check refusal first (free), then moderation.
    const refusal = detectAnthropicRefusal(result);
    if (refusal) applyFlag(refusal, ctx.method, ctx);

    if (checkOutput && result && typeof result.text === 'string' && result.text) {
      const flag = await callModeration(result.text);
      if (flag) applyFlag(flag, ctx.method, ctx);
    }

    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalChecks = stats.moderationCalls = stats.moderationErrors = 0;
    stats.flagged = stats.blocked = stats.refusals = 0;
    for (const k of Object.keys(stats.bySource))   delete stats.bySource[k];
    for (const k of Object.keys(stats.byCategory)) delete stats.byCategory[k];
  };
  mw.asMcpResource = () => ({
    uri: 'config://safety-classifier',
    name: 'Content safety classifier',
    description: 'Moderation-API + Anthropic-refusal detection with per-category counters.',
    mimeType: 'application/json',
    handler: () => ({
      threshold,
      action,
      checkInput,
      checkOutput,
      hasApiKey:    !!apiKey,
      moderationModel,
      categories:   categories ?? '(all)',
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  safetyClassifier,
  SafetyClassifierBlockedError,
  DEFAULT_MODERATION_ENDPOINT,
  DEFAULT_MODERATION_MODEL,
};
