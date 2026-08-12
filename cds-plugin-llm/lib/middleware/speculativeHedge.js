// Speculative hedging. Fire the same request to N candidates with
// staggered delays; the first successful reply wins. Trades $ for
// tail latency — pay for hedges to guarantee p99. Useful when:
//
//   * You have multi-region / multi-provider deployment
//   * Your SLO is p99 (not p50), and one provider going slow ruins it
//   * You can afford roughly 1.2–2x the cost for a much tighter
//     latency distribution
//
//   const { speculativeHedge } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(speculativeHedge({
//     candidates: [
//       { name: 'primary'   /* fires immediately */ },
//       { name: 'us-east',  hedgeDelayMs: 200, modifyRequest: (r) => ({ ...r, model: 'us-east/gpt-4o' }) },
//       { name: 'eu-west',  hedgeDelayMs: 500, modifyRequest: (r) => ({ ...r, model: 'eu-west/gpt-4o' }) },
//     ],
//     hedgeDelayMs: 200,   // fallback stagger if candidate omits it
//     isSuccess: (r) => !!r?.text,
//   }));
//
// Cancellation policy:
//   The middleware attaches a fresh `AbortController` per candidate on
//   `ctx.signal`. Downstream code (or providers) that respect the
//   Web-standard AbortSignal will early-exit for losers. Providers that
//   don't respect it will keep running — their result is discarded, but
//   the token cost may still be billed. Choose `hedgeDelayMs`
//   conservatively.
//
// Placement: OUTSIDE any per-attempt retry / bulkhead. Each hedge should
// consume its own retry / concurrency budget.

const { LLMError } = require('../errors');

class AllHedgesFailedError extends LLMError {
  constructor({ errors, candidateNames }) {
    const list = errors.slice(0, 3).map((e, i) => `[${candidateNames[i] ?? i}] ${e?.message ?? e}`).join('; ');
    super(`speculativeHedge: all ${errors.length} hedges failed. First: ${list}`, 'ALL_HEDGES_FAILED');
    this.errors = errors;
    this.candidateNames = candidateNames;
  }
}

function defaultApplyCandidate(request, candidate) {
  if (typeof candidate.modifyRequest === 'function') {
    return candidate.modifyRequest(request);
  }
  return request;
}

function speculativeHedge(options = {}) {
  const {
    candidates,
    hedgeDelayMs   = 200,
    applyCandidate = defaultApplyCandidate,
    isSuccess      = () => true,
    onLaunch       = null,
    onWin          = null,
    onLoss         = null,   // fired for hedges that lost the race
    onError        = null,
    onGiveUp       = null,
    sleep          = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
    now            = () => Date.now(),
  } = options;

  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw new Error('speculativeHedge: candidates must be a non-empty array.');
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== 'object' || typeof c.name !== 'string') {
      throw new Error(`speculativeHedge: candidates[${i}] must be { name: string, ... }.`);
    }
    if (c.hedgeDelayMs != null && (!Number.isFinite(c.hedgeDelayMs) || c.hedgeDelayMs < 0)) {
      throw new Error(`speculativeHedge: candidates[${i}].hedgeDelayMs must be >= 0.`);
    }
    if (c.modifyRequest != null && typeof c.modifyRequest !== 'function') {
      throw new Error(`speculativeHedge: candidates[${i}].modifyRequest must be a function.`);
    }
  }
  if (!Number.isFinite(hedgeDelayMs) || hedgeDelayMs < 0) {
    throw new Error(`speculativeHedge: hedgeDelayMs must be >= 0 (got ${hedgeDelayMs}).`);
  }
  if (typeof applyCandidate !== 'function') {
    throw new Error('speculativeHedge: applyCandidate must be a function.');
  }
  if (typeof isSuccess !== 'function') {
    throw new Error('speculativeHedge: isSuccess must be a function.');
  }
  for (const cb of [onLaunch, onWin, onLoss, onError, onGiveUp]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('speculativeHedge: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:       0,
    hedgesLaunched:   0,
    hedgesWon:        0,
    hedgesLost:       0,      // launched but lost the race
    hedgesErrored:    0,
    givenUp:          0,      // every candidate errored / non-success
    winsByCandidate:  {},
    launchesByCandidate: {},
    lastWinner:       null,
    lastLatencyMs:    null,
  };
  for (const c of candidates) {
    stats.winsByCandidate[c.name] = 0;
    stats.launchesByCandidate[c.name] = 0;
  }

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    // Fast path — single candidate means no hedging.
    if (candidates.length === 1) {
      const c = candidates[0];
      const originalRequest = ctx.request;
      ctx.request = applyCandidate(originalRequest, c);
      stats.hedgesLaunched++;
      stats.launchesByCandidate[c.name] = (stats.launchesByCandidate[c.name] ?? 0) + 1;
      callHook(onLaunch, { candidate: c.name, index: 0, delayMs: 0 });
      try {
        const result = await next();
        stats.hedgesWon++;
        stats.winsByCandidate[c.name]++;
        stats.lastWinner = c.name;
        callHook(onWin, { candidate: c.name, index: 0, latencyMs: 0, result });
        return result;
      } finally {
        ctx.request = originalRequest;
      }
    }

    const originalRequest = ctx.request;
    const originalSignal  = ctx.signal;
    const startedAt       = now();

    // One AbortController per hedge — losers get signalled so
    // AbortSignal-respecting downstream code can early-exit.
    const controllers = candidates.map(() => new AbortController());
    const errors      = new Array(candidates.length).fill(null);
    const launched    = new Array(candidates.length).fill(false);
    let winnerIdx     = -1;
    let winnerResult  = null;

    function launchOne(i) {
      const c = candidates[i];
      launched[i] = true;
      stats.hedgesLaunched++;
      stats.launchesByCandidate[c.name] = (stats.launchesByCandidate[c.name] ?? 0) + 1;
      callHook(onLaunch, { candidate: c.name, index: i, delayMs: now() - startedAt });

      // Each hedge sees its own request + signal. We restore ctx.request
      // per-hedge because they run interleaved.
      const perHedgeCtx = { ...ctx, request: applyCandidate(originalRequest, c), signal: controllers[i].signal };
      return (async () => {
        try {
          const result = await next.call(null, perHedgeCtx);   // some middlewares expect ctx passed to next
          if (winnerIdx !== -1) return null;   // race already lost
          if (!isSuccess(result)) {
            const err = new Error(`speculativeHedge: candidate "${c.name}" returned non-success result`);
            err.code = 'HEDGE_NOT_SUCCESS';
            throw err;
          }
          return { i, result };
        } catch (err) {
          stats.hedgesErrored++;
          errors[i] = err;
          callHook(onError, { candidate: c.name, index: i, error: err });
          throw err;
        }
      })();
    }

    // Kick off the first hedge immediately; schedule the rest.
    const promises = [];
    promises.push(launchOne(0));
    const scheduled = [];
    for (let i = 1; i < candidates.length; i++) {
      const delay = candidates[i].hedgeDelayMs ?? (hedgeDelayMs * i);
      const p = sleep(delay).then(() => {
        if (winnerIdx !== -1) return null;   // race won already; don't launch
        return launchOne(i);
      });
      scheduled.push(p);
      promises.push(p);
    }

    // Wait for either any hedge to succeed OR all to fail.
    try {
      const outcome = await Promise.any(promises.map((p) => p.catch((e) => Promise.reject(e))));
      if (outcome == null) {
        // The scheduled launcher resolved with null (race already won),
        // but Promise.any accepted its resolution. Fall through — this
        // shouldn't happen because a real winner sets winnerIdx first.
      }
      winnerIdx = outcome.i;
      winnerResult = outcome.result;
    } catch (aggregate) {
      // AggregateError — all hedges failed / cancelled.
      stats.givenUp++;
      const errList = errors.filter(Boolean);
      const names   = candidates.map((c) => c.name);
      ctx.request = originalRequest;
      ctx.signal  = originalSignal;
      callHook(onGiveUp, { errors: errList, candidateNames: names });
      throw new AllHedgesFailedError({ errors: errList, candidateNames: names });
    }

    // Signal losers to abort (they'll finish in background if they don't
    // respect the signal — we discard the result either way).
    for (let i = 0; i < controllers.length; i++) {
      if (i !== winnerIdx && launched[i]) {
        stats.hedgesLost++;
        callHook(onLoss, { candidate: candidates[i].name, index: i });
        try { controllers[i].abort(); } catch { /* swallow */ }
      }
    }

    const winner = candidates[winnerIdx];
    stats.hedgesWon++;
    stats.winsByCandidate[winner.name]++;
    stats.lastWinner    = winner.name;
    stats.lastLatencyMs = now() - startedAt;
    callHook(onWin, {
      candidate: winner.name, index: winnerIdx,
      latencyMs: stats.lastLatencyMs, result: winnerResult,
    });

    ctx.request = originalRequest;
    ctx.signal  = originalSignal;
    return winnerResult;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.hedgesLaunched = stats.hedgesWon = 0;
    stats.hedgesLost = stats.hedgesErrored = stats.givenUp = 0;
    stats.lastWinner = stats.lastLatencyMs = null;
    for (const k of Object.keys(stats.winsByCandidate)) stats.winsByCandidate[k] = 0;
    for (const k of Object.keys(stats.launchesByCandidate)) stats.launchesByCandidate[k] = 0;
  };
  mw.hedgeRatio = () => {
    return stats.totalCalls === 0 ? 0 : stats.hedgesLaunched / stats.totalCalls;
  };
  mw.asMcpResource = () => ({
    uri: 'config://speculative-hedge',
    name: 'Speculative hedge',
    description: 'Staggered-delay hedging across N candidates. First success wins; losers are signalled to abort.',
    mimeType: 'application/json',
    handler: () => ({
      candidates: candidates.map((c, i) => ({
        name: c.name, index: i,
        hedgeDelayMs: c.hedgeDelayMs ?? (hedgeDelayMs * i),
      })),
      defaultHedgeDelayMs: hedgeDelayMs,
      hedgeRatio: mw.hedgeRatio(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  speculativeHedge,
  AllHedgesFailedError,
  defaultApplyCandidate,
};
