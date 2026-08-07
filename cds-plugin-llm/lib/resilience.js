// One-liner that wires the full resilience stack in canonical order:
//
//   deadline → costBudget → circuitBreaker → bulkhead → retryOnRateLimit → provider
//
// Instead of five separate llm.use() calls with per-primitive option
// objects, consumers can call:
//
//   const stack = resilience.bundle({ deadlineMs: 30_000, retryAttempts: 3 });
//   stack.apply(llm);
//
// The bundle returns each primitive as a named field so callers can
// inspect stats, force-open a circuit, etc. It also exposes
// prometheusBundle() and healthBundle() helpers that pre-shape the
// arguments for `prometheusHandler` and `healthHandler`, so Prometheus
// and /health wiring becomes one call each.
//
// Every option has a defensible default. Bare `resilience.bundle()`
// gives you production-reasonable settings.

const { deadline }          = require('./middleware/deadline');
const { costBudget }        = require('./middleware/costBudget');
const { circuitBreaker }    = require('./middleware/circuitBreaker');
const { bulkhead }          = require('./middleware/bulkhead');
const { retryOnRateLimit }  = require('./middleware/retryOnRateLimit');

const CANONICAL_ORDER = ['deadline', 'costBudget', 'circuitBreaker', 'bulkhead', 'retryOnRateLimit'];

function bundle(options = {}) {
  const {
    // Deadline
    deadlineMs        = 30_000,
    perMethodDeadline = null,
    // Cost budget
    budgetLimits      = null,          // pass an object → costBudget wires up; null → skip
    budgetWindow      = 'day',
    budgetCurrency    = 'USD',
    budgetAction      = 'throw',
    // Circuit breaker
    breakerThreshold  = 5,
    breakerCooldownMs = 30_000,
    breakerHalfOpenAttempts = 1,
    breakerPerProvider = true,
    // Bulkhead
    bulkheadMax       = 10,
    bulkheadQueue     = 50,
    bulkheadTimeoutMs = 5_000,
    bulkheadPerProvider = true,
    // Retry
    retryAttempts     = 3,
    retryFallbackMs   = 2_000,
    retryJitterMs     = 500,
    // Composition control
    include           = null,          // subset of CANONICAL_ORDER; null = all
    exclude           = null,          // subset of CANONICAL_ORDER; null = none
    // Callback hooks — forwarded per-primitive
    onDeadlineExpired = null,
    onRetry           = null,
    onRetryGiveUp     = null,
    onBreakerOpen     = null,
    onBreakerClose    = null,
    onBudgetExceeded  = null,
    onBulkheadReject  = null,
  } = options;

  // Compute the effective set of primitives to include.
  const included = new Set(include ?? CANONICAL_ORDER);
  if (exclude) for (const k of exclude) included.delete(k);

  // Instantiate the primitives that were requested (deadline is always
  // built unless explicitly excluded; costBudget requires limits to be
  // provided since it makes no sense with zero limits).
  const instances = {};

  if (included.has('deadline')) {
    instances.deadline = deadline({
      timeoutMs: deadlineMs,
      perMethod: perMethodDeadline,
      onExpired: onDeadlineExpired,
    });
  }
  if (included.has('costBudget') && budgetLimits != null) {
    instances.costBudget = costBudget({
      limits:   budgetLimits,
      window:   budgetWindow,
      action:   budgetAction,
      currency: budgetCurrency,
      onExceeded: onBudgetExceeded,
    });
  }
  if (included.has('circuitBreaker')) {
    instances.circuitBreaker = circuitBreaker({
      threshold:        breakerThreshold,
      cooldownMs:       breakerCooldownMs,
      halfOpenAttempts: breakerHalfOpenAttempts,
      perProvider:      breakerPerProvider,
      onOpen:  onBreakerOpen,
      onClose: onBreakerClose,
    });
  }
  if (included.has('bulkhead')) {
    instances.bulkhead = bulkhead({
      maxConcurrent:  bulkheadMax,
      maxQueued:      bulkheadQueue,
      queueTimeoutMs: bulkheadTimeoutMs,
      perProvider:    bulkheadPerProvider,
      onReject:       onBulkheadReject,
    });
  }
  if (included.has('retryOnRateLimit')) {
    instances.retryOnRateLimit = retryOnRateLimit({
      maxAttempts:    retryAttempts,
      fallbackWaitMs: retryFallbackMs,
      jitterMs:       retryJitterMs,
      onRetry,
      onGiveUp: onRetryGiveUp,
    });
  }

  // Canonical chain description — usable by validateMiddlewareOrder + the
  // demo app's config://chain snapshot.
  const chain = CANONICAL_ORDER
    .filter((kind) => instances[kind])
    .map((kind) => ({ kind }));

  const stack = {
    // Named primitive access. Any that were excluded / skipped are undefined.
    deadline:         instances.deadline,
    budget:           instances.costBudget,
    breaker:          instances.circuitBreaker,
    bh:               instances.bulkhead,
    bulkhead:         instances.bulkhead,      // alias for the healthHandler-shape
    retry:            instances.retryOnRateLimit,
    // Description of the wired chain — feeds validateMiddlewareOrder.
    chain,
    /**
     * Attach every included primitive to the given service in canonical
     * order (OUTERMOST first). Idempotent: calling apply() a second time
     * on the same service will register the middleware AGAIN — bundle
     * once, apply once.
     */
    apply(llm) {
      if (typeof llm?.use !== 'function') {
        throw new Error('resilience.bundle().apply(llm): llm must expose .use(middleware)');
      }
      for (const kind of CANONICAL_ORDER) {
        const mw = instances[kind];
        if (mw) llm.use(mw);
      }
      return llm;
    },
    /**
     * Shape ready to pass to `prometheusHandler({ ... })`. Includes only
     * the primitives that were instantiated.
     */
    prometheusBundle() {
      return {
        deadline: instances.deadline,
        budget:   instances.costBudget,
        breaker:  instances.circuitBreaker,
        bh:       instances.bulkhead,
        retry:    instances.retryOnRateLimit,
      };
    },
    /**
     * Shape ready to pass to `healthHandler({ ... })`. Same primitive
     * subset as prometheusBundle().
     */
    healthBundle() {
      return {
        deadline: instances.deadline,
        budget:   instances.costBudget,
        breaker:  instances.circuitBreaker,
        bh:       instances.bulkhead,
        retry:    instances.retryOnRateLimit,
      };
    },
  };

  return stack;
}

module.exports = { bundle, CANONICAL_ORDER };
