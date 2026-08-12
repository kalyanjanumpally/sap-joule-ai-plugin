// Semantic router. Pick a model + system prompt + params by embedding
// the user's request and finding the nearest "route" (a route = a
// bucket of example prompts). Complements the shipped 1.x static
// `modelRouter` (regex / predicate routing) with *learned* routing:
// classify by meaning, not by keyword.
//
//   const { semanticRouter } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(semanticRouter({
//     embedder: async (text) => (await llm.embed({ input: text })).embeddings[0],
//     routes: [
//       {
//         name: 'code',
//         model: 'anthropic/claude-opus-4-7',
//         system: 'You are an expert engineer. Return runnable code.',
//         examples: [
//           'Write a Python function to reverse a string',
//           'Debug this TypeScript error: cannot find name X',
//           'Refactor this Go handler',
//         ],
//       },
//       {
//         name: 'procurement',
//         model: 'openai/gpt-4o',
//         system: 'You are an SAP procurement analyst.',
//         examples: [
//           'Analyze this vendor quote',
//           'Draft a PO for 500 units',
//           'What are the payment terms on this contract?',
//         ],
//       },
//       {
//         name: 'chit-chat',
//         model: 'openai/gpt-4o-mini',
//         temperature: 0.9,
//         examples: ['Hi', 'How are you?', 'Tell me a joke'],
//       },
//     ],
//     threshold: 0.75,        // below → defaultRoute (or passthrough)
//     defaultRoute: 'chit-chat',
//     onRoute: (i) => cds.log('llm:router').info('routed', i),
//   }));
//
// Route centroids are computed LAZILY on first call — construction is
// zero-latency. If you want deterministic startup latency, pre-embed
// your examples and pass `centroid: [...]` on each route.
//
// Placement: OUTSIDE any middleware that reads `request.model` /
// `request.system` (retry, providers). The router mutates those fields
// per call and restores them on exit.

const {
  cosineSimilarity,
} = require('./semanticCache');

function defaultExtractKey(ctx) {
  const req = ctx?.request ?? ctx ?? {};
  if (typeof req.prompt === 'string') return req.prompt;
  if (Array.isArray(req.messages)) {
    // Prefer the LATEST user message — that's what we're routing on.
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i];
      if (m?.role === 'user' && typeof m.content === 'string') return m.content;
    }
    // Fallback: any string content.
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (typeof req.messages[i]?.content === 'string') return req.messages[i].content;
    }
  }
  if (typeof req.input === 'string') return req.input;
  return null;
}

function defaultApplyRoute(request, route) {
  const out = { ...request };
  if (typeof route.model === 'string')       out.model       = route.model;
  if (typeof route.system === 'string')      out.system      = route.system;
  if (typeof route.temperature === 'number') out.temperature = route.temperature;
  if (typeof route.maxTokens === 'number')   out.maxTokens   = route.maxTokens;
  return out;
}

// Average N vectors of equal length into one centroid.
function averageVectors(vectors) {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

function semanticRouter(options = {}) {
  const {
    routes,
    embedder,
    extractKey       = defaultExtractKey,
    threshold        = 0.75,
    defaultRoute     = null,       // route name to use when no route scores above threshold
    applyRoute       = defaultApplyRoute,
    onRoute          = null,
    onFallback       = null,
    onError          = null,
  } = options;

  if (!Array.isArray(routes) || routes.length < 1) {
    throw new Error('semanticRouter: routes must be a non-empty array.');
  }
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') {
      throw new Error(`semanticRouter: routes[${i}] must be { name: string, ... }.`);
    }
    if (r.centroid == null && (!Array.isArray(r.examples) || r.examples.length < 1)) {
      throw new Error(`semanticRouter: routes[${i}] "${r.name}" needs either examples[] or a precomputed centroid.`);
    }
    if (r.centroid != null && !Array.isArray(r.centroid)) {
      throw new Error(`semanticRouter: routes[${i}] "${r.name}" centroid must be a numeric array.`);
    }
  }
  if (typeof embedder !== 'function') {
    throw new Error('semanticRouter: embedder must be an async function (text) => number[].');
  }
  if (typeof extractKey !== 'function') {
    throw new Error('semanticRouter: extractKey must be a function.');
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`semanticRouter: threshold must be in (0, 1] (got ${threshold}).`);
  }
  if (defaultRoute != null && typeof defaultRoute !== 'string') {
    throw new Error(`semanticRouter: defaultRoute must be a string or null (got ${defaultRoute}).`);
  }
  if (typeof applyRoute !== 'function') {
    throw new Error('semanticRouter: applyRoute must be a function.');
  }
  for (const cb of [onRoute, onFallback, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('semanticRouter: callbacks must be functions or null.');
    }
  }

  const routeMap = new Map();
  for (const r of routes) routeMap.set(r.name, r);
  if (defaultRoute != null && !routeMap.has(defaultRoute)) {
    throw new Error(`semanticRouter: defaultRoute "${defaultRoute}" not found in routes.`);
  }

  // Lazy centroids — computed on first call for routes that didn't ship
  // pre-computed vectors. Promise cached so concurrent callers don't
  // duplicate embedding calls.
  const centroidPromises = new Map();

  async function ensureCentroid(route) {
    if (Array.isArray(route.centroid) && route.centroid.length > 0) return route.centroid;
    if (centroidPromises.has(route.name)) return centroidPromises.get(route.name);
    const p = (async () => {
      const vectors = [];
      for (const ex of route.examples) {
        try { vectors.push(await embedder(ex)); }
        catch { /* skip bad embeddings; centroid still meaningful */ }
      }
      if (vectors.length === 0) return null;
      const c = averageVectors(vectors);
      route.centroid = c;   // cache back onto the route
      return c;
    })();
    centroidPromises.set(route.name, p);
    return p;
  }

  const stats = {
    totalCalls:      0,
    routedByName:    {},
    fallbacks:       0,
    passthroughs:    0,   // when neither threshold nor defaultRoute helps
    embedderErrors:  0,
    keyErrors:       0,
    lastRoute:       null,
    lastScore:       null,
  };
  for (const r of routes) stats.routedByName[r.name] = 0;
  if (defaultRoute) stats.routedByName[defaultRoute] = stats.routedByName[defaultRoute] ?? 0;

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    // Extract text; missing / empty → passthrough.
    let text;
    try { text = extractKey(ctx); }
    catch (err) {
      stats.keyErrors++;
      callHook(onError, { phase: 'extractKey', error: err });
      return next();
    }
    if (typeof text !== 'string' || text.length === 0) {
      stats.passthroughs++;
      return next();
    }

    // Embed the query.
    let queryVec;
    try { queryVec = await embedder(text); }
    catch (err) {
      stats.embedderErrors++;
      callHook(onError, { phase: 'embedder', error: err });
      return next();
    }
    if (!Array.isArray(queryVec) || queryVec.length === 0) {
      stats.passthroughs++;
      return next();
    }

    // Score every route.
    let bestRoute = null;
    let bestScore = -Infinity;
    const scoresByName = {};
    for (const r of routes) {
      let centroid;
      try { centroid = await ensureCentroid(r); }
      catch (err) {
        callHook(onError, { phase: 'centroid', route: r.name, error: err });
        continue;
      }
      if (!centroid) continue;
      const sim = cosineSimilarity(queryVec, centroid);
      scoresByName[r.name] = sim;
      if (sim > bestScore) { bestScore = sim; bestRoute = r; }
    }

    stats.lastScore = bestScore;

    let picked = bestRoute;
    if (!bestRoute || bestScore < threshold) {
      // Below threshold — fall back if configured.
      if (defaultRoute) {
        picked = routeMap.get(defaultRoute);
        stats.fallbacks++;
        callHook(onFallback, {
          bestScore, bestRoute: bestRoute?.name ?? null,
          threshold, defaultRoute, scoresByName,
        });
      } else {
        stats.passthroughs++;
        return next();
      }
    }

    stats.lastRoute = picked.name;
    stats.routedByName[picked.name] = (stats.routedByName[picked.name] ?? 0) + 1;
    callHook(onRoute, {
      route: picked.name, score: bestScore,
      belowThreshold: bestScore < threshold,
      scoresByName,
    });

    const originalRequest = ctx.request;
    ctx.request = applyRoute(originalRequest, picked);
    try {
      return await next();
    } finally {
      ctx.request = originalRequest;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.fallbacks = stats.passthroughs = 0;
    stats.embedderErrors = stats.keyErrors = 0;
    stats.lastRoute = stats.lastScore = null;
    for (const k of Object.keys(stats.routedByName)) stats.routedByName[k] = 0;
  };
  mw.routeDistribution = () => {
    const total = Object.values(stats.routedByName).reduce((a, b) => a + b, 0);
    if (total === 0) return {};
    const dist = {};
    for (const [k, v] of Object.entries(stats.routedByName)) dist[k] = v / total;
    return dist;
  };
  // For testing + eager warm-up: force centroid computation for all routes.
  mw.warmup = async () => {
    for (const r of routes) await ensureCentroid(r);
  };
  mw.asMcpResource = () => ({
    uri: 'config://semantic-router',
    name: 'Semantic router',
    description: 'Embedding-based routing to model + system prompt buckets. Cosine-similarity classification.',
    mimeType: 'application/json',
    handler: () => ({
      routes: routes.map((r) => ({
        name: r.name,
        model: r.model ?? null,
        exampleCount: Array.isArray(r.examples) ? r.examples.length : 0,
        centroidReady: Array.isArray(r.centroid) && r.centroid.length > 0,
      })),
      threshold, defaultRoute,
      distribution: mw.routeDistribution(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  semanticRouter,
  averageVectors,
  defaultExtractKey,
  defaultApplyRoute,
};
