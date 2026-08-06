// Static validator for llm.use() middleware ordering.
//
// The plugin's middleware primitives (guardrails, costBudget, responseCache,
// usageMetering, promptInjectionGuard, retryOnRateLimit) compose freely, but
// certain orderings are known to be wrong for common use cases. This helper
// accepts a canonical chain description and flags mis-orderings with:
//
//   - `severity`: 'error' | 'warning' | 'info'
//   - `message`: a short one-line diagnosis
//   - `fixit`:   an actionable one-line remedy
//   - `involved`: the middleware kinds implicated
//   - `code`:    stable identifier for filtering / suppressing in tests
//
// Input shape (matches config://chain payload from the demo app + user-hand-built):
//
//   [
//     { kind: 'promptInjectionGuard' },
//     { kind: 'guardrails' },
//     { kind: 'costBudget' },
//     { kind: 'retryOnRateLimit' },
//     { kind: 'usageMeteringToCap' },   // or 'usageMetering'
//     { kind: 'responseCache' },
//   ]
//
// Order is OUTER→INNER (matches the emit order in ai-service.js's llm.use()
// sequence). Index 0 runs FIRST on the way DOWN into the request path.
//
// Return shape:
//   {
//     ok:       boolean,          // false iff any 'error'-severity warning
//     warnings: [{ code, severity, message, fixit, involved }],
//   }

const KNOWN_KINDS = new Set([
  'promptInjectionGuard',
  'guardrails',
  'costBudget',
  'retryOnRateLimit',
  'circuitBreaker',
  'usageMetering',
  'usageMeteringToCap',
  'responseCache',
]);

function validateMiddlewareOrder(chain) {
  if (!Array.isArray(chain)) {
    throw new Error('validateMiddlewareOrder: chain must be an array of { kind } entries.');
  }
  const warnings = [];
  const norm = chain.map((m, i) => ({ kind: m?.kind, position: i }));
  const idxOf = (kind) => norm.findIndex((m) => m.kind === kind);
  const idxOfAny = (...kinds) => {
    for (const k of kinds) {
      const i = norm.findIndex((m) => m.kind === k);
      if (i !== -1) return i;
    }
    return -1;
  };

  // Duplicate-kind detection. Not always wrong (e.g. two costBudgets with
  // different scopes) but usually a bug. Fire as `warning`, not `error`.
  const seen = new Map();
  for (const m of norm) {
    if (!m.kind) continue;
    const prev = seen.get(m.kind);
    if (prev !== undefined) {
      warnings.push({
        code:     'DUPLICATE_KIND',
        severity: 'warning',
        message:  `Middleware kind '${m.kind}' appears at positions ${prev} AND ${m.position}.`,
        fixit:    `If intentional (multiple ${m.kind}s with different scopes), suppress with ignore: ['DUPLICATE_KIND'].`,
        involved: [m.kind],
      });
    } else {
      seen.set(m.kind, m.position);
    }
    if (!KNOWN_KINDS.has(m.kind)) {
      warnings.push({
        code:     'UNKNOWN_KIND',
        severity: 'info',
        message:  `Middleware kind '${m.kind}' at position ${m.position} is not one the plugin ships.`,
        fixit:    'The validator has no ordering rules for third-party middleware — ordering advice below assumes it behaves like a metering / logging layer.',
        involved: [m.kind],
      });
    }
  }

  // Rule: responseCache OUTER of usageMetering → cache hits become invisible
  // to the metering counter (no $0 rows in LlmSpend for hits, no
  // totalCostSaved tracking, no cache-hit observability from meter).
  // Info-severity because it's a legitimate choice for high-throughput
  // deployments that want zero metering overhead on cache-served requests.
  const meteringIdx = idxOfAny('usageMetering', 'usageMeteringToCap');
  const cacheIdx    = idxOf('responseCache');
  if (meteringIdx !== -1 && cacheIdx !== -1 && cacheIdx < meteringIdx) {
    warnings.push({
      code:     'CACHE_OUTER_OF_METERING',
      severity: 'info',
      message:  'responseCache is OUTER of usageMetering — cache-hit responses skip the metering counter entirely (no $0 rows in LlmSpend, no totalCostSaved tracking).',
      fixit:    'For cache-hit observability, move usageMetering OUTER of responseCache. Then metering sees `cached: true` and records $0 rows + increments totalCostSaved.',
      involved: ['usageMetering', 'responseCache'],
    });
  }

  // Rule: costBudget INNER of retryOnRateLimit → retries bypass the ceiling.
  const budgetIdx = idxOf('costBudget');
  const retryIdx  = idxOf('retryOnRateLimit');
  if (budgetIdx !== -1 && retryIdx !== -1 && budgetIdx > retryIdx) {
    warnings.push({
      code:     'BUDGET_INNER_OF_RETRY',
      severity: 'warning',
      message:  'costBudget is INNER of retryOnRateLimit — retries hit the provider without a re-check against the budget, meaning a budget-exhausted flow can burn through retries.',
      fixit:    'Move costBudget OUTER of retryOnRateLimit so the pre-flight ceiling check fires on every attempt.',
      involved: ['costBudget', 'retryOnRateLimit'],
    });
  }

  // Rule: promptInjectionGuard INNER of guardrails → NFKC normalization
  // in `filters.pii` etc. can erase homoglyph + zero-width signals before
  // the injection guard sees them (see 1.31.0 CHANGELOG discussion).
  const injectionIdx  = idxOf('promptInjectionGuard');
  const guardrailsIdx = idxOf('guardrails');
  if (injectionIdx !== -1 && guardrailsIdx !== -1 && injectionIdx > guardrailsIdx) {
    warnings.push({
      code:     'INJECTION_INNER_OF_GUARDRAILS',
      severity: 'warning',
      message:  'promptInjectionGuard is INNER of guardrails — PII / NFKC normalization in guardrails can erase homoglyph + zero-width signals before the injection guard sees them.',
      fixit:    'Move promptInjectionGuard OUTER of guardrails so it sees raw request text.',
      involved: ['promptInjectionGuard', 'guardrails'],
    });
  }

  // Rule: responseCache OUTER of costBudget → cache hits skip the budget
  // check entirely. Sometimes desired (cache hits are $0, budget doesn't
  // care), sometimes not (per-tenant cache-hit ceilings). Info-severity.
  if (cacheIdx !== -1 && budgetIdx !== -1 && cacheIdx < budgetIdx) {
    warnings.push({
      code:     'CACHE_OUTER_OF_BUDGET',
      severity: 'info',
      message:  'responseCache is OUTER of costBudget — cache hits skip the pre-flight budget check entirely.',
      fixit:    'That is often desired (cache hits cost $0). If you WANT per-tenant cache-hit ceilings, move costBudget OUTER of responseCache.',
      involved: ['responseCache', 'costBudget'],
    });
  }

  // Rule: circuitBreaker INNER of retryOnRateLimit → retries fire even
  // when the provider is objectively down (the breaker never gets to
  // short-circuit before retries burn budget). Warning-severity.
  const breakerIdx = idxOf('circuitBreaker');
  if (breakerIdx !== -1 && retryIdx !== -1 && breakerIdx > retryIdx) {
    warnings.push({
      code:     'BREAKER_INNER_OF_RETRY',
      severity: 'warning',
      message:  'circuitBreaker is INNER of retryOnRateLimit — retries hit the provider even when the circuit is open (breaker never gets to short-circuit).',
      fixit:    'Move circuitBreaker OUTER of retryOnRateLimit so an open circuit avoids burning retry budget on a known-down provider.',
      involved: ['circuitBreaker', 'retryOnRateLimit'],
    });
  }

  // Missing-primitive advisories (info-severity — not always applicable).
  if (retryIdx === -1) {
    warnings.push({
      code:     'NO_RETRY',
      severity: 'info',
      message:  'No retryOnRateLimit in the chain — throttled requests (429/503) fail immediately with no automatic recovery.',
      fixit:    'Add `llm.use(retryOnRateLimit({ maxAttempts: 3 }))` for automated retry on rate-limit responses.',
      involved: ['retryOnRateLimit'],
    });
  }
  if (breakerIdx === -1) {
    warnings.push({
      code:     'NO_CIRCUIT_BREAKER',
      severity: 'info',
      message:  'No circuitBreaker in the chain — sustained provider outage will burn through retry + budget on every request instead of short-circuiting.',
      fixit:    'Add `llm.use(circuitBreaker({ threshold: 5, cooldownMs: 30_000 }))` for automatic short-circuit on repeated 5xx / network failures.',
      involved: ['circuitBreaker'],
    });
  }
  if (idxOfAny('usageMetering', 'usageMeteringToCap') === -1) {
    warnings.push({
      code:     'NO_METERING',
      severity: 'info',
      message:  'No usageMetering / usageMeteringToCap in the chain — cost accounting + per-tenant/model breakdowns are missing.',
      fixit:    'Add `llm.use(usageMetering({...}))` for observability; usageMeteringToCap also persists rows into a CAP entity.',
      involved: ['usageMetering'],
    });
  }
  if (guardrailsIdx === -1 && injectionIdx === -1) {
    warnings.push({
      code:     'NO_SECURITY_LAYER',
      severity: 'info',
      message:  'Neither guardrails nor promptInjectionGuard is wired — PII, blocklist, and prompt-injection defenses are all off.',
      fixit:    'At minimum, add `llm.use(guardrails({ inputFilters: [filters.pii(), filters.promptInjection()] }))`.',
      involved: ['guardrails', 'promptInjectionGuard'],
    });
  }

  const hasError = warnings.some((w) => w.severity === 'error');
  return { ok: !hasError, warnings };
}

/**
 * Convenience: filter warnings by suppressing certain codes. Useful in tests
 * or when you're deliberately using an unusual ordering.
 */
function filterWarnings(result, ignoredCodes = []) {
  const ignore = new Set(ignoredCodes);
  const filtered = result.warnings.filter((w) => !ignore.has(w.code));
  return {
    ok:       !filtered.some((w) => w.severity === 'error'),
    warnings: filtered,
  };
}

module.exports = { validateMiddlewareOrder, filterWarnings, KNOWN_KINDS };
