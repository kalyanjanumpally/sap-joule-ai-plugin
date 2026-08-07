// Provider fallback chain — try providers in order, failing over to
// the next on retryable errors (5xx, network) OR when the previous
// provider's circuit breaker (1.49.0) short-circuits the call.
//
// Composes cleanly with everything already shipped:
//   - circuitBreaker: an open circuit throws CircuitOpenError → we treat
//     it as an immediate failover signal (no wait, no retry within
//     that provider — the breaker already decided this one is down).
//   - retryOnRateLimit: still handled INSIDE each provider's chain.
//     By the time chatWithFallback sees an error, retries have already
//     been exhausted for THIS provider — time to fail over.
//   - guardrails / costBudget / usageMetering: run per-provider,
//     inheriting each provider's own middleware chain.
//
// Signature:
//
//   const { chatWithFallback } = require('@saptarishi/cds-plugin-llm');
//
//   const { result, providerUsed, modelUsed, attempts } =
//     await chatWithFallback({
//       providers: [
//         { service: openaiSvc,     model: 'gpt-4o-mini' },
//         { service: anthropicSvc,  model: 'claude-3-5-sonnet-latest' },
//         { service: bedrockSvc,    model: 'anthropic.claude-3-haiku-20240307-v1:0' },
//       ],
//       request: { messages: [{ role: 'user', content: 'Hello' }], maxTokens: 200 },
//       isFallback: (err) => err?.status >= 500,   // custom predicate (optional)
//       onFailover: (info) => cds.log('llm:fallback').warn('failing over', info),
//     });

const { LLMError } = require('./errors');

class AllProvidersFailedError extends LLMError {
  constructor(lastError, attempts) {
    super(
      `chatWithFallback: all ${attempts.length} providers failed. Last error: ${lastError?.message ?? 'unknown'}`,
      'ALL_PROVIDERS_FAILED',
    );
    this.attempts = attempts;
    this.cause = lastError;
  }
}

// Default failover predicate. Matches the philosophy of circuitBreaker's
// default isFailure: transport / server errors get failed over, 4xx does
// NOT (same bad request will fail on all providers).
function defaultIsFallback(err) {
  if (err?.name === 'CircuitOpenError' || err?.code === 'CIRCUIT_OPEN') return true;
  if (err?.name === 'RateLimitGiveUpError' || err?.code === 'RATE_LIMIT_GIVE_UP') return true;
  const status = err?.status ?? err?.statusCode;
  if (status == null) return true;   // network / unknown transport → try next
  return status >= 500;
}

async function chatWithFallback(options = {}) {
  const {
    providers,
    request      = {},
    isFallback   = defaultIsFallback,
    onFailover   = null,
  } = options;

  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('chatWithFallback: providers must be a non-empty array.');
  }
  for (const p of providers) {
    if (!p || typeof p.service?.chat !== 'function') {
      throw new Error(
        'chatWithFallback: each provider entry must have a `service` with a `chat()` method.',
      );
    }
  }

  const attempts = [];
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    // Merge shared request with per-provider overrides. Per-provider fields
    // (`model`, per-provider `request`) win over the shared request.
    const perProvReq = p.request ?? {};
    const merged = { ...request, ...perProvReq };
    if (p.model) merged.model = p.model;
    const svcName = p.service?.name ?? p.service?.constructor?.name ?? `provider-${i}`;

    try {
      const result = await p.service.chat(merged);
      attempts.push({
        service:   svcName,
        model:     merged.model,
        ok:        true,
        skipped:   false,
      });
      return {
        result,
        providerUsed: svcName,
        modelUsed:    merged.model,
        attempts,
      };
    } catch (err) {
      lastError = err;
      const isCircuit = err?.name === 'CircuitOpenError' || err?.code === 'CIRCUIT_OPEN';
      let shouldFailover;
      try {
        shouldFailover = isFallback(err);
      } catch {
        shouldFailover = false;
      }

      attempts.push({
        service:   svcName,
        model:     merged.model,
        ok:        false,
        skipped:   isCircuit,                // true when short-circuit, not a live attempt
        error:     err?.message ?? String(err),
        errorName: err?.name ?? 'Error',
        status:    err?.status ?? err?.statusCode ?? null,
      });

      const nextName = providers[i + 1]
        ? (providers[i + 1].service?.name ?? providers[i + 1].service?.constructor?.name ?? `provider-${i + 1}`)
        : null;
      if (onFailover) {
        try {
          onFailover({
            from:       svcName,
            to:         nextName,
            error:      err,
            skipped:    isCircuit,
            willRetry:  shouldFailover && i < providers.length - 1,
          });
        } catch {
          /* swallow */
        }
      }

      // Non-retryable OR exhausted providers → give up.
      if (!shouldFailover || i === providers.length - 1) {
        throw new AllProvidersFailedError(err, attempts);
      }
      // Otherwise fall through to next provider.
    }
  }
  // Unreachable — loop either returns or throws.
  throw new AllProvidersFailedError(lastError, attempts);
}

module.exports = { chatWithFallback, AllProvidersFailedError, defaultIsFallback };
