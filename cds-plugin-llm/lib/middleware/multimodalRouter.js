// Multimodal attachment router. Inspects the request's message content
// blocks, detects which media types are present (text, vision, pdf,
// audio), and routes to the model configured for that capability set.
// Complements the shipped router primitives:
//   * `modelRouter` (1.x)        — static keyword rules
//   * `semanticRouter` (2.16)    — embedding-based routing
//   * `costAwareRouter` (2.10)   — quality-driven escalation
//   * `multimodalRouter` (this)  — CAPABILITY-aware routing
//
//   const { multimodalRouter } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(multimodalRouter({
//     routes: {
//       'text':           { model: 'openai/gpt-4o-mini' },
//       'vision':         { model: 'openai/gpt-4o' },
//       'pdf':            { model: 'anthropic/claude-opus-4-7' },
//       'audio':          { model: 'openai/whisper-1' },
//       // Combined capability keys (sorted, joined by '+'):
//       'vision+pdf':     { model: 'anthropic/claude-opus-4-7' },
//     },
//     fallbackKey: 'text',
//     onRoute: (i) => cds.log('llm:mm').info('routed', i),
//   }));
//
// Respects the shipped provider capability matrix (2.3.0) — if you
// route vision requests to a text-only model, `capabilities(llm)`
// will flag the mismatch and `preflight` (1.x) will refuse to boot.

// ---- Detection ------------------------------------------------------
//
// Canonical set of media types this router recognizes. Users can add
// custom types via `detectAttachments` override.

const KNOWN_TYPES = Object.freeze(['text', 'vision', 'pdf', 'audio', 'video']);

function defaultDetectAttachments(request) {
  const types = new Set();
  if (!request || typeof request !== 'object') { types.add('text'); return types; }

  // Prompt string → text.
  if (typeof request.prompt === 'string' && request.prompt.length > 0) types.add('text');

  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const msg of messages) {
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      types.add('text');
      continue;
    }
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      const bType = String(block.type ?? '').toLowerCase();
      // Vision: image, image_url, image_base64, or type=vision.
      if (bType === 'image' || bType === 'image_url' || bType === 'image_base64' || bType === 'vision') {
        types.add('vision');
      }
      // PDF: type=pdf OR document/file with pdf mime.
      else if (bType === 'pdf') {
        types.add('pdf');
      }
      else if (bType === 'document' || bType === 'file') {
        const mime = (block.mimeType ?? block.media_type ?? block.source?.media_type ?? '').toLowerCase();
        if (mime.startsWith('application/pdf')) types.add('pdf');
        else if (mime.startsWith('image/'))     types.add('vision');
        else if (mime.startsWith('audio/'))     types.add('audio');
        else if (mime.startsWith('video/'))     types.add('video');
        else if (mime === '')                    types.add('pdf');   // best guess for bare `document`
      }
      // Audio: type=audio or input_audio.
      else if (bType === 'audio' || bType === 'input_audio') {
        types.add('audio');
      }
      // Video: type=video.
      else if (bType === 'video') {
        types.add('video');
      }
      // Text block.
      else if (bType === 'text' || bType === 'input_text') {
        types.add('text');
      }
    }
  }
  // Nothing detected at all → treat as text (safest default).
  if (types.size === 0) types.add('text');
  return types;
}

function defaultApplyRoute(request, route) {
  const out = { ...request };
  if (typeof route.model === 'string') out.model = route.model;
  if (typeof route.system === 'string') out.system = route.system;
  if (typeof route.temperature === 'number') out.temperature = route.temperature;
  if (typeof route.maxTokens === 'number') out.maxTokens = route.maxTokens;
  return out;
}

// Canonical key for a set of types: sorted alphabetically, joined by '+'.
// e.g., {vision, pdf} → 'pdf+vision'.
function keyFor(types) {
  return [...types].sort().join('+');
}

// ---- Middleware -----------------------------------------------------

function multimodalRouter(options = {}) {
  const {
    routes,
    fallbackKey        = 'text',
    detectAttachments  = defaultDetectAttachments,
    applyRoute         = defaultApplyRoute,
    onRoute            = null,
    onFallback         = null,
    onError            = null,
  } = options;

  if (!routes || typeof routes !== 'object') {
    throw new Error('multimodalRouter: routes must be an object mapping capability keys → route config.');
  }
  const routeKeys = Object.keys(routes);
  if (routeKeys.length === 0) {
    throw new Error('multimodalRouter: routes must have at least one entry.');
  }
  for (const [key, r] of Object.entries(routes)) {
    if (!r || typeof r !== 'object') {
      throw new Error(`multimodalRouter: routes.${key} must be an object.`);
    }
    // Validate that the key is a canonical sorted+joined string.
    const parts = key.split('+');
    const sorted = [...parts].sort().join('+');
    if (sorted !== key) {
      throw new Error(`multimodalRouter: routes key "${key}" must be sorted (expected "${sorted}").`);
    }
  }
  if (typeof fallbackKey !== 'string') {
    throw new Error('multimodalRouter: fallbackKey must be a string.');
  }
  if (!(fallbackKey in routes)) {
    throw new Error(`multimodalRouter: fallbackKey "${fallbackKey}" not found in routes.`);
  }
  if (typeof detectAttachments !== 'function' || typeof applyRoute !== 'function') {
    throw new Error('multimodalRouter: detectAttachments + applyRoute must be functions.');
  }
  for (const cb of [onRoute, onFallback, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('multimodalRouter: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:    0,
    routedByKey:   {},
    fallbacks:     0,
    detectErrors:  0,
    lastKey:       null,
    lastDetected:  null,
  };
  for (const k of routeKeys) stats.routedByKey[k] = 0;

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let types;
    try { types = detectAttachments(ctx?.request); }
    catch (err) {
      stats.detectErrors++;
      callHook(onError, { phase: 'detectAttachments', error: err });
      return next();
    }
    if (!types || typeof types.has !== 'function' || typeof types[Symbol.iterator] !== 'function') {
      stats.detectErrors++;
      callHook(onError, { phase: 'detectAttachments', error: new Error('detectAttachments must return a Set') });
      return next();
    }

    const detectedKey = keyFor(types);
    stats.lastDetected = detectedKey;

    let route = routes[detectedKey];
    let pickedKey = detectedKey;
    let usedFallback = false;
    if (!route) {
      route = routes[fallbackKey];
      pickedKey = fallbackKey;
      usedFallback = true;
      stats.fallbacks++;
      callHook(onFallback, { detectedKey, fallbackKey, detectedTypes: [...types] });
    }

    stats.lastKey = pickedKey;
    stats.routedByKey[pickedKey] = (stats.routedByKey[pickedKey] ?? 0) + 1;
    callHook(onRoute, {
      key: pickedKey,
      detectedKey,
      detectedTypes: [...types],
      usedFallback,
      route,
    });

    const originalRequest = ctx.request;
    ctx.request = applyRoute(originalRequest, route);
    try {
      return await next();
    } finally {
      ctx.request = originalRequest;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.fallbacks = stats.detectErrors = 0;
    stats.lastKey = stats.lastDetected = null;
    for (const k of Object.keys(stats.routedByKey)) stats.routedByKey[k] = 0;
  };
  mw.listRouteKeys = () => routeKeys.slice();
  mw.routeDistribution = () => {
    const total = Object.values(stats.routedByKey).reduce((a, b) => a + b, 0);
    if (total === 0) return {};
    const dist = {};
    for (const [k, v] of Object.entries(stats.routedByKey)) dist[k] = v / total;
    return dist;
  };
  mw.asMcpResource = () => ({
    uri: 'config://multimodal-router',
    name: 'Multimodal attachment router',
    description: 'Routes by attachment type (text/vision/pdf/audio/video). Canonical sorted-set keys.',
    mimeType: 'application/json',
    handler: () => ({
      routes: Object.fromEntries(routeKeys.map((k) => [k, {
        model:  routes[k].model ?? null,
        system: typeof routes[k].system === 'string',
      }])),
      fallbackKey,
      distribution: mw.routeDistribution(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  multimodalRouter,
  KNOWN_TYPES,
  defaultDetectAttachments,
  defaultApplyRoute,
  keyFor,
};
