// Model router middleware. Rewrites `ctx.request.model` (and
// optionally maxTokens / temperature / provider hint) based on
// declarative rules — first match wins.
//
// Use case: instead of every call site hand-picking a model,
// declare policy centrally.
//
//   const { modelRouter } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(modelRouter({
//     rules: [
//       // Embeddings → cheap
//       { match: { method: 'embed' },
//         route: { model: 'text-embedding-3-small' } },
//
//       // Structured extraction → JSON-mode-capable
//       { match: { hasFormat: true },
//         route: { model: 'gpt-4o' } },
//
//       // Multi-turn agents (tools) → strong reasoning
//       { match: { hasTools: true },
//         route: { model: 'claude-opus-4-7' } },
//
//       // Simple summarization by prompt sniff
//       { match: { systemContains: 'summarize' },
//         route: { model: 'claude-haiku-4-5' } },
//
//       // Enterprise tenant → premium
//       { match: (ctx) => ctx.raw?.tenant === 'enterprise',
//         route: { model: 'claude-opus-4-7' } },
//     ],
//     fallback: { model: 'gpt-4o-mini' },
//     onRoute:  (info) => cds.log('llm:router').info(info),
//   }));
//
// Non-destructive: mutates ctx.request only for the inner next()
// call, restores original before returning. Outer middleware sees
// the pre-router request; inner + provider see the routed one.
//
// Recommended placement: OUTER of adaptiveMaxTokens (so max-tokens
// adjustment reads the new model's price) and OUTER of
// responseCache (cache keyed on the routed model → higher hit
// rate for identical prompts across a policy family).

const { hasStreamCompletion } = require('../streamCompletion');   // unused today; imported for symmetry

// ---- Rule matching --------------------------------------------------

function textFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    if (typeof m?.content === 'string') parts.push(m.content);
    else if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
  }
  return parts.join(' ');
}

function hasContentType(messages, type) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === type) return true;
        if (type === 'image' && b?.type === 'image') return true;
        if (type === 'document' && b?.type === 'document') return true;
        if (type === 'audio' && (b?.type === 'audio' || b?.type === 'input_audio')) return true;
      }
    }
  }
  return false;
}

// Rough token estimate — 4 chars/token is a well-known heuristic.
function estimateTokens(request) {
  const parts = [];
  if (typeof request?.system === 'string') parts.push(request.system);
  if (Array.isArray(request?.messages)) parts.push(textFromMessages(request.messages));
  if (typeof request?.input === 'string') parts.push(request.input);
  if (Array.isArray(request?.input)) parts.push(request.input.join(' '));
  const totalChars = parts.reduce((s, p) => s + (p?.length ?? 0), 0);
  return Math.ceil(totalChars / 4);
}

function evaluateMatch(match, ctx) {
  if (typeof match === 'function') {
    try { return !!match(ctx); }
    catch { return false; }
  }
  if (!match || typeof match !== 'object') return false;

  const req = ctx?.request ?? {};

  if (match.method) {
    const methods = Array.isArray(match.method) ? match.method : [match.method];
    if (!methods.includes(ctx?.method)) return false;
  }
  if (match.hasTools === true  && !(Array.isArray(req.tools) && req.tools.length > 0)) return false;
  if (match.hasTools === false &&  (Array.isArray(req.tools) && req.tools.length > 0)) return false;
  if (match.hasFormat === true  && (req.format == null)) return false;
  if (match.hasFormat === false && (req.format != null)) return false;
  if (match.hasImages   === true  && !hasContentType(req.messages, 'image'))    return false;
  if (match.hasPdfs     === true  && !hasContentType(req.messages, 'document')) return false;
  if (match.hasAudio    === true  && !hasContentType(req.messages, 'audio'))    return false;
  if (match.model) {
    const models = Array.isArray(match.model) ? match.model : [match.model];
    if (!models.includes(req.model)) return false;
  }
  if (match.systemContains) {
    const sys = typeof req.system === 'string' ? req.system : '';
    if (match.systemContains instanceof RegExp) {
      if (!match.systemContains.test(sys)) return false;
    } else if (typeof match.systemContains === 'string') {
      if (!sys.includes(match.systemContains)) return false;
    }
  }
  if (match.systemMatches instanceof RegExp) {
    const sys = typeof req.system === 'string' ? req.system : '';
    if (!match.systemMatches.test(sys)) return false;
  }
  if (Number.isFinite(match.minInputTokens) || Number.isFinite(match.maxInputTokens)) {
    const est = estimateTokens(req);
    if (Number.isFinite(match.minInputTokens) && est < match.minInputTokens) return false;
    if (Number.isFinite(match.maxInputTokens) && est > match.maxInputTokens) return false;
  }
  return true;
}

// ---- Main middleware ------------------------------------------------

function modelRouter(options = {}) {
  const {
    rules      = [],
    fallback   = null,
    onRoute    = null,
    exposeMetaOn = 'meta',   // where to stamp routing info: 'meta' or 'raw'
  } = options;

  if (!Array.isArray(rules)) {
    throw new Error('modelRouter: rules must be an array.');
  }
  for (const [i, r] of rules.entries()) {
    if (!r || typeof r !== 'object') {
      throw new Error(`modelRouter: rules[${i}] must be { match, route }.`);
    }
    if (r.match == null || (typeof r.match !== 'function' && typeof r.match !== 'object')) {
      throw new Error(`modelRouter: rules[${i}].match must be a function or object.`);
    }
    if (!r.route || typeof r.route !== 'object') {
      throw new Error(`modelRouter: rules[${i}].route must be a directive object.`);
    }
  }
  if (fallback != null && typeof fallback !== 'object') {
    throw new Error('modelRouter: fallback must be a directive object or null.');
  }
  if (onRoute != null && typeof onRoute !== 'function') {
    throw new Error('modelRouter: onRoute must be a function or null.');
  }

  const stats = {
    totalRequests:   0,
    routed:          0,
    unrouted:        0,
    fallbackApplied: 0,
    byRuleIndex:     {},   // ruleIndex → hit count
    byModel:         {},   // final model → hit count
  };

  function selectRule(ctx) {
    for (const [i, r] of rules.entries()) {
      if (evaluateMatch(r.match, ctx)) return { rule: r, index: i };
    }
    return null;
  }

  function applyRoute(request, route) {
    const patched = { ...request };
    if (route.model != null)       patched.model = route.model;
    if (route.maxTokens != null)   patched.maxTokens = route.maxTokens;
    if (route.temperature != null) patched.temperature = route.temperature;
    // Any additional overrides pass through untouched.
    for (const [k, v] of Object.entries(route)) {
      if (['model', 'maxTokens', 'temperature', 'provider', 'tags', 'reason'].includes(k)) continue;
      patched[k] = v;
    }
    return patched;
  }

  const mw = async (ctx, next) => {
    stats.totalRequests++;
    if (!ctx?.request) return next();

    const original = ctx.request;
    const hit = selectRule(ctx);
    let route = null;
    let ruleIndex = null;

    if (hit) {
      route = hit.rule.route;
      ruleIndex = hit.index;
      stats.routed++;
      stats.byRuleIndex[ruleIndex] = (stats.byRuleIndex[ruleIndex] ?? 0) + 1;
    } else if (fallback) {
      route = fallback;
      ruleIndex = -1;
      stats.routed++;
      stats.fallbackApplied++;
    } else {
      stats.unrouted++;
    }

    if (!route) return next();

    const patched = applyRoute(original, route);
    ctx.request = patched;

    const finalModel = patched.model ?? original.model ?? null;
    if (finalModel != null) stats.byModel[finalModel] = (stats.byModel[finalModel] ?? 0) + 1;

    // Stamp routing info onto the ctx so downstream observability
    // (jsonLog, replayBuffer, etc.) can attribute the choice.
    const target = exposeMetaOn === 'raw' && ctx.raw ? ctx.raw : (ctx.meta ??= {});
    target.routed = true;
    target.routedRule = ruleIndex;
    target.routedFrom = original.model ?? null;
    target.routedTo = finalModel;

    if (onRoute) {
      try {
        onRoute({
          ruleIndex,
          fromModel: original.model ?? null,
          toModel: finalModel,
          reason: route.reason ?? null,
          tags: route.tags ?? null,
          method: ctx.method,
        });
      } catch { /* swallow — never break the chain on a bad listener */ }
    }

    try {
      return await next();
    } finally {
      ctx.request = original;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.routed = stats.unrouted = stats.fallbackApplied = 0;
    for (const k of Object.keys(stats.byRuleIndex)) delete stats.byRuleIndex[k];
    for (const k of Object.keys(stats.byModel))     delete stats.byModel[k];
  };
  mw.asMcpResource = () => ({
    uri: 'config://model-router',
    name: 'Model router middleware',
    description: 'Task-aware model routing with counters and configured rule set.',
    mimeType: 'application/json',
    handler: () => ({
      ruleCount:     rules.length,
      hasFallback:   !!fallback,
      fallbackModel: fallback?.model ?? null,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  modelRouter,
  // Exposed for tests + composition.
  evaluateMatch,
  estimateTokens,
  hasContentType,
  textFromMessages,
};
