// Cost overrun predictor. Tracks spend against a fixed calendar billing
// window (typically end-of-month) and projects end-of-window spend
// based on the current burn rate. Warns rising-edge when the projected
// spend would exceed `targetUsd`.
//
// Distinct from `costForecast` (2.1) — that projects a ROLLING window
// forward (e.g., "the next hour"); this projects to a FIXED CALENDAR
// BOUNDARY (end of the month). Companion primitives:
//   * `costBudget` (1.x)      — GLOBAL cap (hard block)
//   * `quotaManager` (2.23)    — PER-USER cap
//   * `costForecast` (2.1)     — ROLLING-window projection
//   * `costOverrunPredictor` (this) — CALENDAR-window projection
//   * `costAwareRouter` (2.10) — cheap-first with quality escalation
//
//   const { costOverrunPredictor, startOfMonth, endOfMonth } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(costOverrunPredictor({
//     windowStart: () => startOfMonth(new Date()),
//     windowEnd:   () => endOfMonth(new Date()),
//     targetUsd:   1000,
//     costOf:      (ctx, result) => {
//       const inTok  = result.usage?.input_tokens  ?? 0;
//       const outTok = result.usage?.output_tokens ?? 0;
//       return (inTok / 1e6) * 0.15 + (outTok / 1e6) * 0.60;
//     },
//     warnAtRatio: 0.85,
//     onWarn:      (i) => cds.log('llm:cost').warn('overrun-projected', i),
//     onExhausted: (i) => cds.log('llm:cost').error('overrun-imminent', i),
//   }));

// ---- Calendar helpers ------------------------------------------------

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d = new Date()) {
  // Last millisecond of the month.
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0 - 1);
}

function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0 - 1);
}

function startOfQuarter(d = new Date()) {
  const q = Math.floor(d.getMonth() / 3) * 3;   // 0, 3, 6, 9
  return new Date(d.getFullYear(), q, 1, 0, 0, 0, 0);
}

function endOfQuarter(d = new Date()) {
  const q = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), q + 3, 1, 0, 0, 0, 0 - 1);
}

// ---- Middleware ----------------------------------------------------

function costOverrunPredictor(options = {}) {
  const {
    windowStart      = () => startOfMonth(),
    windowEnd        = () => endOfMonth(),
    targetUsd,
    costOf,
    warnAtRatio      = 0.85,
    minSampleSize    = 20,
    onProjection     = null,
    onWarn           = null,
    onExhausted      = null,
    onError          = null,
    now              = () => Date.now(),
  } = options;

  if (typeof windowStart !== 'function' || typeof windowEnd !== 'function') {
    throw new Error('costOverrunPredictor: windowStart + windowEnd must be functions returning Date.');
  }
  if (typeof targetUsd !== 'number' || targetUsd <= 0) {
    throw new Error(`costOverrunPredictor: targetUsd must be a positive number (got ${targetUsd}).`);
  }
  if (typeof costOf !== 'function') {
    throw new Error('costOverrunPredictor: costOf(ctx, result) must be a function.');
  }
  if (!Number.isFinite(warnAtRatio) || warnAtRatio <= 0 || warnAtRatio > 1) {
    throw new Error(`costOverrunPredictor: warnAtRatio must be in (0, 1] (got ${warnAtRatio}).`);
  }
  if (!Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new Error(`costOverrunPredictor: minSampleSize must be a positive integer (got ${minSampleSize}).`);
  }
  for (const cb of [onProjection, onWarn, onExhausted, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('costOverrunPredictor: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:      0,
    totalSpent:      0,
    windowStartMs:   0,
    windowEndMs:     0,
    warnCount:       0,
    exhaustedCount:  0,
    costErrors:      0,
    lastProjection:  null,
  };

  // Rising-edge state so we don't spam warn/exhausted callbacks.
  let warned = false;
  let exhausted = false;
  let currentWindowStart = null;

  function projection() {
    const t = now();
    const startMs = windowStart().getTime();
    const endMs   = windowEnd().getTime();
    const elapsedMs = Math.max(0, t - startMs);
    const remainingMs = Math.max(0, endMs - t);
    const fullWindowMs = endMs - startMs;
    // Linear projection: (spent / elapsed) * fullWindow.
    // If we haven't been running long, fall back to (spent + fair-share of remaining).
    const projectedUsd = elapsedMs > 0
      ? (stats.totalSpent / elapsedMs) * fullWindowMs
      : stats.totalSpent;
    return {
      spentUsd:         stats.totalSpent,
      projectedUsd,
      targetUsd,
      elapsedMs,
      remainingMs,
      fullWindowMs,
      utilizationRatio: stats.totalSpent / targetUsd,
      projectedRatio:   projectedUsd / targetUsd,
      windowStartMs:    startMs,
      windowEndMs:      endMs,
    };
  }

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  // If the calendar window has rolled over, reset spend + rising-edge state.
  function checkWindowRollover() {
    const startMs = windowStart().getTime();
    if (currentWindowStart !== null && startMs !== currentWindowStart) {
      stats.totalSpent = 0;
      stats.totalCalls = 0;
      stats.warnCount = 0;
      stats.exhaustedCount = 0;
      warned = false;
      exhausted = false;
    }
    currentWindowStart = startMs;
    stats.windowStartMs = startMs;
    stats.windowEndMs = windowEnd().getTime();
  }

  const mw = async (ctx, next) => {
    // Roll first so a window boundary reset doesn't nuke the counter we
    // just incremented.
    checkWindowRollover();
    stats.totalCalls++;

    const result = await next();

    let cost;
    try {
      cost = costOf(ctx, result);
    } catch (err) {
      stats.costErrors++;
      callHook(onError, { phase: 'costOf', error: err });
      return result;
    }
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      return result;
    }

    stats.totalSpent += cost;

    if (stats.totalCalls < minSampleSize) return result;

    const p = projection();
    stats.lastProjection = p;
    callHook(onProjection, p);

    // Rising-edge exhausted (projection ≥ target).
    if (p.projectedRatio >= 1 && !exhausted) {
      exhausted = true;
      stats.exhaustedCount++;
      callHook(onExhausted, p);
    }
    // Rising-edge warn (projection ≥ warnAtRatio × target, but not yet exhausted).
    if (p.projectedRatio >= warnAtRatio && p.projectedRatio < 1 && !warned) {
      warned = true;
      stats.warnCount++;
      callHook(onWarn, p);
    }
    // Reset warn edge if projection drops back below warn.
    if (p.projectedRatio < warnAtRatio) {
      warned = false;
    }
    // Reset exhausted edge if projection drops back below target.
    if (p.projectedRatio < 1) {
      exhausted = false;
    }

    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.totalSpent = 0;
    stats.warnCount = stats.exhaustedCount = stats.costErrors = 0;
    stats.lastProjection = null;
    warned = exhausted = false;
    // Don't touch currentWindowStart — that resets on next call.
  };
  mw.projection = projection;
  mw.asMcpResource = () => ({
    uri: 'config://cost-overrun-predictor',
    name: 'Cost overrun predictor',
    description: 'Projects end-of-calendar-window spend and warns on projected overruns. Companion to costForecast for FIXED (not rolling) windows.',
    mimeType: 'application/json',
    handler: () => ({
      targetUsd,
      warnAtRatio,
      minSampleSize,
      projection: projection(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  costOverrunPredictor,
  startOfMonth,
  endOfMonth,
  startOfDay,
  endOfDay,
  startOfQuarter,
  endOfQuarter,
};
