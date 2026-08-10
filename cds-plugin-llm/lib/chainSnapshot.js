// Chain snapshot builder. Walks a live LLMService.middleware array
// and emits the { order: [{ position, kind, config }] } shape
// consumed by chainDiff (1.73) + validateMiddlewareOrder (1.48).
// Enables GitOps workflows: commit a baseline snapshot,
// diff against live on every deploy, fail CI when the chain
// drifts.
//
//   const { chainSnapshot } = require('@saptarishi/cds-plugin-llm');
//
//   // In your app:
//   const snap = chainSnapshot(llm);
//   fs.writeFileSync('chain-baseline.json', JSON.stringify(snap, null, 2));
//
//   // In CI (against a running instance):
//   const live = await fetch('https://api.myapp.com/chain-snapshot').then(r => r.json());
//   const baseline = JSON.parse(fs.readFileSync('chain-baseline.json', 'utf8'));
//   const diff = chainDiff(baseline, live);
//   if (!diff.ok) { console.error(formatChainDiff(diff)); process.exit(1); }
//
// Kind detection: prefers explicit `mw.kind`, falls back to a
// URI→kind lookup table over `mw.asMcpResource().uri`. Custom
// middleware not in the shipped table get a heuristic
// `unknown-<N>` name; users can override via `kindMap`.
//
// Config extraction: reads `mw.asMcpResource().handler()`, then
// strips well-known stats fields so snapshots are stable for
// diffing (counters change on every call and would cause noise).
// `includeStats: true` opts out of the filter.

// ---- URI → kind lookup (shipped middleware) ---------------------------

const URI_TO_KIND = Object.freeze({
  'config://cache':                       'responseCache',
  'config://budget':                      'costBudget',
  'config://guardrails':                  'guardrails',
  'config://prompt-injection-guard':      'promptInjectionGuard',
  'config://rate-limit-retry':            'retryOnRateLimit',
  'config://usage':                       'usageMetering',
  'config://circuit-breaker':             'circuitBreaker',
  'config://bulkhead':                    'bulkhead',
  'config://deadline':                    'deadline',
  'config://cost-guard':                  'costGuard',
  'config://json-log':                    'jsonLog',
  'config://adaptive-bulkhead':           'adaptiveBulkhead',
  'config://provider-health-probe':       'providerHealthProbe',
  'config://adaptive-max-tokens':         'adaptiveMaxTokens',
  'config://trace-correlation':           'traceCorrelation',
  'config://tenant-isolate':              'tenantIsolate',
  'config://replay-buffer':               'replayBuffer',
  'config://structured-output-validator': 'structuredOutputValidator',
  'config://idempotency':                 'idempotency',
  'config://pii-redact':                  'piiRedact',
  'config://model-router':                'modelRouter',
  'config://embedding-dedup':             'embeddingDedup',
  'config://prompt-cache-stats':          'promptCacheStats',
  'config://auto-continue':               'autoContinue',
  'config://safety-classifier':           'safetyClassifier',
  'config://compact-history':             'compactHistory',
  'config://distributed-lock':            'distributedLock',
  'config://retry-after-propagation':     'retryAfterPropagation',
});

// ---- Stats fields to strip from config (heuristic) --------------------
//
// These are the fields shipped middleware include in their
// asMcpResource() handler for observability. They change on every
// call and would produce noisy diffs — strip by default.

const KNOWN_STATS_FIELDS = new Set([
  // Common counters
  'totalRequests', 'totalCalls', 'totalErrors', 'totalChecks', 'totalTexts',
  'totalMessagesRemoved', 'totalMessagesReplacedWith', 'totalContinuations',
  'totalMessagesReplacedWith', 'totalCaptured', 'totalValidated',
  'requestsContinued', 'requestsWithPii',
  // Success/failure counters
  'hits', 'misses', 'semanticHits', 'semanticMisses', 'embedderErrors',
  'successes', 'failures', 'blocked', 'refusals',
  'valid', 'invalid', 'passed', 'failed', 'errors',
  'compacted', 'summarizerErrors', 'skipped', 'skippedTooLong',
  'allHitRequests', 'flagged', 'sanitized', 'warned', 'redacted',
  // Distributed lock / idempotency
  'acquired', 'rejected', 'timedOut', 'waited', 'totalWaitMs',
  'released', 'releaseErrors', 'errorsBypassed', 'streamsBypassed',
  'streamsSkipped', 'inFlightCoalesced', 'evictions',
  // Routing
  'routed', 'unrouted', 'fallbackApplied',
  // Cost / caching
  'callsWithCache', 'unpricedCalls', 'tokensReplaced', 'responsesUnmasked',
  'moderationCalls', 'moderationErrors', 'totalSavingsUsd', 'totalCostUsd',
  'totalCacheReadTokens', 'totalCacheCreationTokens', 'totalNormalInputTokens',
  // Retries / continuations
  'retries', 'retriesGivenUp', 'giveUps', 'totalRetries', 'retriedRequests',
  'hintsCaptured', 'unknownProvider',
  // By-* histograms
  'byProvider', 'byModel', 'byRuleIndex', 'byCategory', 'bySource',
  'byStopReason', 'byType', 'byField',
  // Live state
  'current', 'currentSize', 'currentHeld', 'size', 'inFlight', 'queued',
  'consecutiveFailures', 'cooldownRemainingSeconds', 'state',
  // Router-specific
  'sinceLast', 'lastRun', 'startedAt', 'endedAt',
]);

function stripStats(config) {
  if (!config || typeof config !== 'object') return config;
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (KNOWN_STATS_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---- Kind detection ---------------------------------------------------

function detectKind(mw, kindMap) {
  // 1. Explicit kind property (best; middleware factory sets it).
  if (typeof mw.kind === 'string' && mw.kind.length > 0) return mw.kind;

  // 2. asMcpResource().uri lookup.
  if (typeof mw.asMcpResource === 'function') {
    try {
      const r = mw.asMcpResource();
      if (r && typeof r.uri === 'string') {
        if (kindMap && kindMap[r.uri]) return kindMap[r.uri];
        if (URI_TO_KIND[r.uri]) return URI_TO_KIND[r.uri];
      }
    } catch { /* swallow */ }
  }

  return null;
}

function extractConfig(mw, options) {
  if (typeof mw.asMcpResource !== 'function') return null;
  let resource;
  try { resource = mw.asMcpResource(); } catch { return null; }
  if (!resource || typeof resource.handler !== 'function') return null;
  let payload;
  try { payload = resource.handler(); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (options.includeStats) return payload;
  if (typeof options.extractConfig === 'function') {
    return options.extractConfig(payload, mw);
  }
  return stripStats(payload);
}

// ---- Main API ---------------------------------------------------------

function chainSnapshot(llm, options = {}) {
  if (!llm || !Array.isArray(llm.middleware)) {
    throw new Error('chainSnapshot: llm must be an LLMService with a `middleware` array (call llm.use() first).');
  }
  if (options.kindMap != null && (typeof options.kindMap !== 'object' || Array.isArray(options.kindMap))) {
    throw new Error('chainSnapshot: kindMap must be an object of { uri: kind } pairs.');
  }
  if (options.extractConfig != null && typeof options.extractConfig !== 'function') {
    throw new Error('chainSnapshot: extractConfig must be a function or null.');
  }

  const {
    kindMap,
    includeStats  = false,
    includeVersion = true,
    versionSource  = null,   // override for tests
  } = options;

  let unknownCounter = 0;

  const order = llm.middleware.map((mw, position) => {
    let kind = detectKind(mw, kindMap);
    if (!kind) kind = `unknown-${unknownCounter++}`;
    const config = extractConfig(mw, { includeStats, extractConfig: options.extractConfig });
    const entry = { position, kind };
    if (config != null) entry.config = config;
    return entry;
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    order,
  };
  if (unknownCounter > 0) snapshot.unknownCount = unknownCounter;

  if (includeVersion) {
    try {
      snapshot.version = versionSource ?? require('../package.json').version;
    } catch {
      // package.json not resolvable in some bundled contexts — skip.
    }
  }

  return snapshot;
}

module.exports = {
  chainSnapshot,
  URI_TO_KIND,
  KNOWN_STATS_FIELDS,
  stripStats,
  // Exposed for tests + composition.
  detectKind,
  extractConfig,
};
