// Prompt A/B experiment framework. Run N variants of a prompt / request
// against each other in production, traffic-split by consistent hash so
// the same user always sees the same variant. Captures per-variant
// score + latency + cost distributions using Welford's online algorithm
// so memory stays constant regardless of sample count.
//
// Complements the shipped 1.x eval primitives:
//   * `llmJudge` (1.84) / `judgeMany`      — qualitative LLM-as-judge scoring
//   * `promptRegression` (1.89)             — OFFLINE fixture-based CI eval
//   * `scoreResponse` (2.4)                 — mechanical response scoring
//   * `consensusVoting` (2.5)               — multi-model consensus
//
// This middleware handles the *ONLINE* half of the story — real
// production traffic split across prompt variants — that the offline
// primitives can't do alone.
//
//   const { promptExperiment, scoreResponse } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(promptExperiment({
//     name: 'invoice-summarization-2026Q3',
//     variants: [
//       { name: 'control', weight: 5 },
//       { name: 'terse',   weight: 3, apply: (req) => ({ ...req, system: 'Be terse. Bullet points only.' }) },
//       { name: 'chatty',  weight: 2, apply: (req) => ({ ...req, system: 'Be friendly + detailed.' }) },
//     ],
//     splitKeyOf: (ctx) => ctx.request.userId ?? ctx.request.sessionId,
//     scorer:     (result) => scoreResponse(result, { rubric }).score,
//     costEstimator: (result) => (result.usage?.output_tokens ?? 0) * 0.00001,
//     onSample: (i) => cds.log('llm:exp').debug('sample', i),
//   }));
//
// Later: `mw.getWinner()` returns the variant with the highest mean
// score, plus a 95% confidence-interval overlap test with the second-
// best. If the CIs don't overlap AND we have at least `minSampleSize`
// per variant, we declare a statistically-defensible winner.

const CONFIDENCE_Z = 1.96;   // 95% CI

// Deterministic 32-bit hash of a string. Used to consistently map a
// split key to a variant so the same user always sees the same variant
// (both within a session and across restarts).
function hash32(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// Welford's online algorithm for mean + variance in a single pass.
// Adding a sample takes O(1) memory regardless of sample count.
function welfordUpdate(state, x) {
  state.count += 1;
  const delta  = x - state.mean;
  state.mean  += delta / state.count;
  const delta2 = x - state.mean;
  state.m2    += delta * delta2;
}

function welfordStats(state) {
  const variance = state.count > 1 ? state.m2 / (state.count - 1) : 0;
  return {
    count:    state.count,
    mean:     state.mean,
    variance,
    stddev:   Math.sqrt(variance),
  };
}

// Compute [lo, hi] confidence interval for the mean.
function ciAroundMean(mean, stddev, count, z = CONFIDENCE_Z) {
  if (count < 2) return [mean, mean];
  const halfWidth = z * (stddev / Math.sqrt(count));
  return [mean - halfWidth, mean + halfWidth];
}

function promptExperiment(options = {}) {
  const {
    name,
    variants,
    splitKeyOf,
    scorer,
    costEstimator     = null,
    minSampleSize     = 30,        // per-variant minimum before winner is declared
    onSample          = null,
    onWinner          = null,
    onError           = null,
    now               = () => Date.now(),
  } = options;

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('promptExperiment: name must be a non-empty string.');
  }
  if (!Array.isArray(variants) || variants.length < 2) {
    throw new Error('promptExperiment: variants must be an array with at least 2 entries.');
  }
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (!v || typeof v !== 'object' || typeof v.name !== 'string') {
      throw new Error(`promptExperiment: variants[${i}] must be { name: string, ... }.`);
    }
    if (v.weight != null && (!Number.isInteger(v.weight) || v.weight < 1)) {
      throw new Error(`promptExperiment: variants[${i}] "${v.name}" weight must be a positive integer.`);
    }
    if (v.apply != null && typeof v.apply !== 'function') {
      throw new Error(`promptExperiment: variants[${i}] "${v.name}" apply must be a function.`);
    }
  }
  const seenNames = new Set();
  for (const v of variants) {
    if (seenNames.has(v.name)) throw new Error(`promptExperiment: duplicate variant name "${v.name}".`);
    seenNames.add(v.name);
  }
  if (typeof splitKeyOf !== 'function') {
    throw new Error('promptExperiment: splitKeyOf must be a function (ctx) => string.');
  }
  if (typeof scorer !== 'function') {
    throw new Error('promptExperiment: scorer must be a function (result, ctx) => number.');
  }
  if (costEstimator != null && typeof costEstimator !== 'function') {
    throw new Error('promptExperiment: costEstimator must be a function or null.');
  }
  if (!Number.isInteger(minSampleSize) || minSampleSize < 2) {
    throw new Error(`promptExperiment: minSampleSize must be an integer >= 2 (got ${minSampleSize}).`);
  }
  for (const cb of [onSample, onWinner, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('promptExperiment: callbacks must be functions or null.');
    }
  }

  const totalWeight = variants.reduce((a, v) => a + (v.weight ?? 1), 0);

  // Per-variant Welford state.
  //   { name, weight, score: {count, mean, m2}, latency: {...}, cost: {...}, errors }
  const state = new Map();
  for (const v of variants) {
    state.set(v.name, {
      name:      v.name,
      weight:    v.weight ?? 1,
      apply:     v.apply ?? ((req) => req),
      score:    { count: 0, mean: 0, m2: 0 },
      latency:  { count: 0, mean: 0, m2: 0 },
      cost:     { count: 0, mean: 0, m2: 0 },
      totalCostUsd: 0,
      errors:    0,
    });
  }

  const stats = {
    totalCalls:      0,
    passthroughs:    0,     // no split key → skip experiment
    scorerErrors:    0,
    sampledCalls:    0,     // successfully scored calls
    lastVariant:     null,
    lastScore:       null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  // Consistent-hash variant selection: same splitKey always maps to the
  // same variant. The hash is prefixed with the experiment name so
  // multiple concurrent experiments don't collide on the same user
  // (a user in variant "control" of experiment A can be in variant
  // "v2" of experiment B — independent assignment).
  function pickVariant(splitKey) {
    const h = hash32(`${name}::${splitKey}`);
    const target = h % totalWeight;
    let cum = 0;
    for (const v of variants) {
      cum += v.weight ?? 1;
      if (target < cum) return state.get(v.name);
    }
    return state.get(variants[variants.length - 1].name);
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let splitKey;
    try { splitKey = splitKeyOf(ctx); }
    catch (err) {
      callHook(onError, { phase: 'splitKeyOf', error: err });
      throw err;
    }
    if (typeof splitKey !== 'string' || splitKey.length === 0) {
      stats.passthroughs++;
      return next();
    }

    const variant = pickVariant(splitKey);
    stats.lastVariant = variant.name;

    const originalRequest = ctx.request;
    ctx.request = variant.apply(originalRequest);

    const startedAt = now();
    let result, thrown;
    try {
      result = await next();
    } catch (err) {
      variant.errors++;
      thrown = err;
    } finally {
      ctx.request = originalRequest;
    }
    if (thrown) throw thrown;

    const latencyMs = now() - startedAt;
    welfordUpdate(variant.latency, latencyMs);

    // Score the response.
    let score = null;
    try { score = scorer(result, ctx); }
    catch (err) {
      stats.scorerErrors++;
      callHook(onError, { phase: 'scorer', error: err });
    }
    if (typeof score === 'number' && Number.isFinite(score)) {
      welfordUpdate(variant.score, score);
      stats.sampledCalls++;
      stats.lastScore = score;
    }

    // Cost.
    if (costEstimator) {
      try {
        const c = costEstimator(result);
        if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
          welfordUpdate(variant.cost, c);
          variant.totalCostUsd += c;
        }
      } catch (err) {
        callHook(onError, { phase: 'costEstimator', error: err });
      }
    }

    callHook(onSample, {
      variant: variant.name, score, latencyMs, splitKey,
    });
    return result;
  };

  function snapshotVariant(v) {
    const score   = welfordStats(v.score);
    const latency = welfordStats(v.latency);
    const cost    = welfordStats(v.cost);
    const [scoreLo, scoreHi] = ciAroundMean(score.mean, score.stddev, score.count);
    return {
      name:            v.name,
      weight:          v.weight,
      sampleCount:     score.count,
      scoreMean:       score.mean,
      scoreStddev:     score.stddev,
      scoreCI95:       [scoreLo, scoreHi],
      latencyMean:     latency.mean,
      latencyStddev:   latency.stddev,
      costMean:        cost.mean,
      totalCostUsd:    v.totalCostUsd,
      errors:          v.errors,
    };
  }

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.passthroughs = stats.scorerErrors = stats.sampledCalls = 0;
    stats.lastVariant = null;
    stats.lastScore = null;
    for (const v of state.values()) {
      v.score = { count: 0, mean: 0, m2: 0 };
      v.latency = { count: 0, mean: 0, m2: 0 };
      v.cost = { count: 0, mean: 0, m2: 0 };
      v.totalCostUsd = 0;
      v.errors = 0;
    }
  };
  mw.snapshotVariants = () => Array.from(state.values()).map(snapshotVariant);

  // Winner detection: sort variants by mean score, then check whether
  // the top variant's 95% CI overlaps with the runner-up's.
  //   * If it doesn't overlap AND both have at least minSampleSize samples,
  //     we have a statistically-defensible winner.
  //   * Otherwise report status: 'inconclusive' + reason.
  mw.getWinner = () => {
    const snaps = mw.snapshotVariants().filter((s) => s.sampleCount >= minSampleSize);
    if (snaps.length < 2) {
      return { winner: null, status: 'insufficient-samples', variants: mw.snapshotVariants() };
    }
    snaps.sort((a, b) => b.scoreMean - a.scoreMean);
    const top = snaps[0];
    const runnerUp = snaps[1];
    const topCI = top.scoreCI95;
    const rupCI = runnerUp.scoreCI95;
    // CIs overlap when top's lower bound <= runner-up's upper bound.
    const overlaps = topCI[0] <= rupCI[1];
    if (overlaps) {
      return {
        winner:      null,
        status:      'inconclusive-overlap',
        top:         top.name,
        topScore:    top.scoreMean,
        topCI:       topCI,
        runnerUp:    runnerUp.name,
        runnerUpScore: runnerUp.scoreMean,
        runnerUpCI:  rupCI,
        variants:    snaps,
      };
    }
    const info = {
      winner:      top.name,
      status:      'confident',
      topScore:    top.scoreMean,
      topCI:       topCI,
      runnerUp:    runnerUp.name,
      runnerUpScore: runnerUp.scoreMean,
      runnerUpCI:  rupCI,
      variants:    snaps,
    };
    callHook(onWinner, info);
    return info;
  };

  mw.asMcpResource = () => ({
    uri: `config://prompt-experiment/${name}`,
    name: `Prompt experiment: ${name}`,
    description: 'Live A/B testing framework. Consistent-hash variant assignment, Welford-online score / latency / cost stats, 95% CI winner detection.',
    mimeType: 'application/json',
    handler: () => ({
      experimentName:  name,
      variants:        mw.snapshotVariants(),
      totalWeight,
      minSampleSize,
      winner:          mw.getWinner(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  promptExperiment,
  // Exposed for tests + composition.
  hash32,
  welfordUpdate,
  welfordStats,
  ciAroundMean,
};
