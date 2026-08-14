// Grace-period / soft-deadline middleware. Complements the shipped
// `deadline` (1.x hard timeout) with a SOFT deadline that fires a
// warning callback while the request keeps running — plus an optional
// hard deadline that DOES kill. Useful for SLO monitoring: catch
// tail-latency spikes early, before they become full timeouts.
//
//   const { gracePeriod } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(gracePeriod({
//     softMs: 5000,          // warn at 5s
//     hardMs: 15000,          // kill at 15s
//     onSoftDeadline: (i) => cds.log('llm:slo').warn('slow', i),
//     onHardDeadline: (i) => cds.log('llm:slo').error('killed', i),
//   }));
//
// Semantics:
//   * `softMs` alone → warnings only, no kill; call runs until natural
//     completion or downstream timeout
//   * `softMs` + `hardMs` → warns at soft, kills at hard
//   * `hardMs` alone → equivalent to the shipped `deadline`
//
// Composition with `speculativeHedge` (2.12): use `onSoftDeadline` as a
// signal to fire a late hedge — soft deadline says "the primary is
// probably going to be slow, start a backup."

const { LLMError } = require('../errors');

class GracePeriodExhaustedError extends LLMError {
  constructor({ elapsedMs, hardMs, softMs }) {
    super(
      `gracePeriod: hard deadline exceeded — call took ${elapsedMs}ms, limit ${hardMs}ms (soft was ${softMs}ms).`,
      'GRACE_PERIOD_EXHAUSTED',
    );
    this.elapsedMs = elapsedMs;
    this.hardMs    = hardMs;
    this.softMs    = softMs;
  }
}

function gracePeriod(options = {}) {
  const {
    softMs,
    hardMs             = null,
    onSoftDeadline     = null,
    onHardDeadline     = null,
    onComplete         = null,
    attachAbortSignal  = true,
    now                = () => Date.now(),
  } = options;

  if (softMs == null && hardMs == null) {
    throw new Error('gracePeriod: at least one of softMs or hardMs is required.');
  }
  if (softMs != null && (!Number.isFinite(softMs) || softMs <= 0)) {
    throw new Error(`gracePeriod: softMs must be > 0 (got ${softMs}).`);
  }
  if (hardMs != null && (!Number.isFinite(hardMs) || hardMs <= 0)) {
    throw new Error(`gracePeriod: hardMs must be > 0 (got ${hardMs}).`);
  }
  if (softMs != null && hardMs != null && softMs >= hardMs) {
    throw new Error(`gracePeriod: softMs (${softMs}) must be < hardMs (${hardMs}).`);
  }
  for (const cb of [onSoftDeadline, onHardDeadline, onComplete]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('gracePeriod: callbacks must be functions or null.');
    }
  }
  if (typeof attachAbortSignal !== 'boolean') {
    throw new Error('gracePeriod: attachAbortSignal must be a boolean.');
  }

  const stats = {
    totalCalls:          0,
    softDeadlineFires:   0,
    hardDeadlineFires:   0,
    completedUnderSoft:  0,
    completedOverSoft:   0,
    completedOverHard:   0,   // shouldn't happen (killed at hardMs)
    totalLatencyMs:      0,
    lastLatencyMs:       null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const startedAt = now();

    let softTimer = null;
    let hardTimer = null;
    let softFired = false;
    let hardFired = false;

    // Fresh AbortController per call so we can signal a hard-deadline
    // abort. Downstream fetch()/providers that respect ctx.signal
    // early-exit.
    const originalSignal = ctx.signal;
    let controller = null;
    if (attachAbortSignal) {
      controller = new AbortController();
      ctx.signal = controller.signal;
    }

    if (softMs != null) {
      softTimer = setTimeout(() => {
        softFired = true;
        stats.softDeadlineFires++;
        callHook(onSoftDeadline, { elapsedMs: now() - startedAt, softMs, hardMs });
      }, softMs);
    }

    let hardDeadlinePromise = null;
    if (hardMs != null) {
      hardDeadlinePromise = new Promise((_, reject) => {
        hardTimer = setTimeout(() => {
          hardFired = true;
          stats.hardDeadlineFires++;
          const elapsedMs = now() - startedAt;
          callHook(onHardDeadline, { elapsedMs, softMs, hardMs });
          if (controller) {
            try { controller.abort(); } catch { /* swallow */ }
          }
          reject(new GracePeriodExhaustedError({ elapsedMs, hardMs, softMs }));
        }, hardMs);
      });
    }

    try {
      const result = hardDeadlinePromise
        ? await Promise.race([next(), hardDeadlinePromise])
        : await next();

      const elapsedMs = now() - startedAt;
      stats.totalLatencyMs += elapsedMs;
      stats.lastLatencyMs = elapsedMs;
      if (softFired) stats.completedOverSoft++;
      else stats.completedUnderSoft++;
      callHook(onComplete, { elapsedMs, softFired, hardFired: false });
      return result;
    } finally {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (attachAbortSignal) ctx.signal = originalSignal;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.softDeadlineFires = stats.hardDeadlineFires = 0;
    stats.completedUnderSoft = stats.completedOverSoft = stats.completedOverHard = 0;
    stats.totalLatencyMs = 0;
    stats.lastLatencyMs = null;
  };
  mw.avgLatencyMs = () => {
    const denom = stats.completedUnderSoft + stats.completedOverSoft;
    return denom === 0 ? 0 : stats.totalLatencyMs / denom;
  };
  mw.softDeadlineRate = () => {
    return stats.totalCalls === 0 ? 0 : stats.softDeadlineFires / stats.totalCalls;
  };
  mw.asMcpResource = () => ({
    uri: 'config://grace-period',
    name: 'Grace period / soft deadline',
    description: 'Soft deadline warns while call runs; optional hard deadline kills. SLO monitoring primitive.',
    mimeType: 'application/json',
    handler: () => ({
      softMs,
      hardMs,
      attachAbortSignal,
      avgLatencyMs: mw.avgLatencyMs(),
      softDeadlineRate: mw.softDeadlineRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  gracePeriod,
  GracePeriodExhaustedError,
};
