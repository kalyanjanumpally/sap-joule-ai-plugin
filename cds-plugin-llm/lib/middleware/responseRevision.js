// Response revision loop. When the response scores below threshold,
// automatically re-asks the SAME model with the low-scoring response
// + rubric feedback inline, up to `maxRevisions` times. Returns the
// best-scoring response across all attempts even if none pass.
//
// Distinct from the other quality primitives:
//   * `structuredOutputRepair` (2.9)  — SCHEMA-driven repair
//   * `costAwareRouter` (2.10)         — escalates to a DIFFERENT model
//   * `consensusVoting` (2.5)          — fans out to N models in parallel
//   * `responseRevision` (this)        — iterates on the SAME model with
//                                        rubric feedback in the prompt
//
//   const { responseRevision, scoreResponse } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(responseRevision({
//     scorer: (result, ctx) => {
//       const report = scoreResponse(result, { rubric: myRubric });
//       return {
//         score:    report.score,
//         feedback: report.results
//           .filter((r) => !r.pass)
//           .map((r) => `- ${r.check}: ${r.reason}`)
//           .join('\n'),
//       };
//     },
//     scoreThreshold: 0.8,
//     maxRevisions:   2,
//     onRevision: (i) => cds.log('llm:revise').info('revision', i),
//   }));

const { LLMError } = require('../errors');

function defaultBuildRevisionPrompt({ previousText, score, feedback, revisionIndex, scoreThreshold }) {
  const feedbackBlock = feedback
    ? `\n\nSpecifically, these issues were flagged:\n${feedback}`
    : '';
  return `Your previous response scored ${(score * 100).toFixed(0)}% against the quality rubric (target: ${(scoreThreshold * 100).toFixed(0)}%).${feedbackBlock}\n\nPlease revise your response to address these issues. (Revision ${revisionIndex + 1})`;
}

function defaultApplyRevision(request, revisionPrompt, previousResponse) {
  const messages = Array.isArray(request.messages) ? [...request.messages] : [];
  // Append the assistant's previous (low-scoring) reply, then the user's revision request.
  if (previousResponse?.text) {
    messages.push({ role: 'assistant', content: previousResponse.text });
  }
  messages.push({ role: 'user', content: revisionPrompt });
  return { ...request, messages };
}

function responseRevision(options = {}) {
  const {
    scorer,
    scoreThreshold      = 0.7,
    maxRevisions        = 2,
    buildRevisionPrompt = defaultBuildRevisionPrompt,
    applyRevision       = defaultApplyRevision,
    onRevision          = null,
    onFinalize          = null,
    onGiveUp            = null,
    onError             = null,
  } = options;

  if (typeof scorer !== 'function') {
    throw new Error('responseRevision: scorer must be a function (result, ctx) => { score, feedback? } | number.');
  }
  if (!Number.isFinite(scoreThreshold) || scoreThreshold <= 0 || scoreThreshold > 1) {
    throw new Error(`responseRevision: scoreThreshold must be in (0, 1] (got ${scoreThreshold}).`);
  }
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) {
    throw new Error(`responseRevision: maxRevisions must be a non-negative integer (got ${maxRevisions}).`);
  }
  if (typeof buildRevisionPrompt !== 'function' || typeof applyRevision !== 'function') {
    throw new Error('responseRevision: buildRevisionPrompt + applyRevision must be functions.');
  }
  for (const cb of [onRevision, onFinalize, onGiveUp, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('responseRevision: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:        0,
    passedFirstTry:    0,
    passedAfterRevision: 0,
    gaveUp:            0,   // exhausted revisions with score still below threshold
    scoreErrors:       0,
    totalRevisions:    0,
    revisionsByCount:  {},   // '0': n, '1': n, '2': n, ...
    lastScore:         null,
    lastRevisionCount: null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function normalizeScorerOutput(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { score: raw, feedback: '' };
    if (raw && typeof raw === 'object' && typeof raw.score === 'number' && Number.isFinite(raw.score)) {
      return { score: raw.score, feedback: typeof raw.feedback === 'string' ? raw.feedback : '' };
    }
    return null;
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const originalRequest = ctx.request;

    // Track the best result across attempts so we can return it if
    // nothing passes the threshold.
    let best = null;

    for (let attempt = 0; attempt <= maxRevisions; attempt++) {
      let result;
      try {
        result = await next();
      } finally {
        // Only restore on the final iteration; leave mutated for retries.
      }

      let scorerOut;
      try {
        scorerOut = normalizeScorerOutput(scorer(result, ctx));
      } catch (err) {
        stats.scoreErrors++;
        callHook(onError, { phase: 'scorer', error: err });
        scorerOut = null;
      }

      if (scorerOut == null) {
        // Can't score → accept the result as-is.
        ctx.request = originalRequest;
        stats.lastRevisionCount = attempt;
        stats.revisionsByCount[attempt] = (stats.revisionsByCount[attempt] ?? 0) + 1;
        callHook(onFinalize, { revisions: attempt, result, score: null, passed: false, unscorable: true });
        return result;
      }

      stats.lastScore = scorerOut.score;

      // Track best.
      if (best === null || scorerOut.score > best.score) {
        best = { result, score: scorerOut.score, revisionIndex: attempt };
      }

      // Pass — return.
      if (scorerOut.score >= scoreThreshold) {
        ctx.request = originalRequest;
        stats.lastRevisionCount = attempt;
        stats.revisionsByCount[attempt] = (stats.revisionsByCount[attempt] ?? 0) + 1;
        if (attempt === 0) stats.passedFirstTry++;
        else stats.passedAfterRevision++;
        callHook(onFinalize, {
          revisions: attempt, result, score: scorerOut.score,
          passed: true, unscorable: false,
        });
        return result;
      }

      // Below threshold. Are we out of revisions?
      if (attempt >= maxRevisions) {
        ctx.request = originalRequest;
        stats.gaveUp++;
        stats.lastRevisionCount = attempt;
        stats.revisionsByCount[attempt] = (stats.revisionsByCount[attempt] ?? 0) + 1;
        callHook(onGiveUp, {
          revisions: attempt,
          bestScore: best.score,
          scoreThreshold,
          feedback: scorerOut.feedback,
        });
        callHook(onFinalize, {
          revisions: attempt, result: best.result, score: best.score,
          passed: false, unscorable: false,
        });
        return best.result;
      }

      // Build revision prompt + apply.
      let revisionPrompt;
      try {
        revisionPrompt = buildRevisionPrompt({
          previousText: result?.text ?? null,
          score: scorerOut.score,
          feedback: scorerOut.feedback,
          revisionIndex: attempt,
          scoreThreshold,
          originalRequest,
        });
      } catch (err) {
        callHook(onError, { phase: 'buildRevisionPrompt', error: err });
        // Fall back: accept the best result we have.
        ctx.request = originalRequest;
        return best.result;
      }

      let revisedRequest;
      try {
        revisedRequest = applyRevision(originalRequest, revisionPrompt, result);
      } catch (err) {
        callHook(onError, { phase: 'applyRevision', error: err });
        ctx.request = originalRequest;
        return best.result;
      }

      ctx.request = revisedRequest;
      stats.totalRevisions++;
      callHook(onRevision, {
        revisionIndex: attempt,
        score: scorerOut.score,
        feedback: scorerOut.feedback,
        scoreThreshold,
      });
    }

    // Unreachable — the loop always returns.
    ctx.request = originalRequest;
    return best?.result ?? null;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.passedFirstTry = stats.passedAfterRevision = 0;
    stats.gaveUp = stats.scoreErrors = stats.totalRevisions = 0;
    stats.lastScore = stats.lastRevisionCount = null;
    for (const k of Object.keys(stats.revisionsByCount)) delete stats.revisionsByCount[k];
  };
  mw.avgRevisions = () => {
    const denom = stats.passedFirstTry + stats.passedAfterRevision + stats.gaveUp;
    return denom === 0 ? 0 : stats.totalRevisions / denom;
  };
  mw.passRate = () => {
    const passed = stats.passedFirstTry + stats.passedAfterRevision;
    const denom = passed + stats.gaveUp;
    return denom === 0 ? 0 : passed / denom;
  };
  mw.asMcpResource = () => ({
    uri: 'config://response-revision',
    name: 'Response revision loop',
    description: 'Re-asks same model with feedback when score is below threshold. Iterates up to maxRevisions, returns best-scoring response.',
    mimeType: 'application/json',
    handler: () => ({
      scoreThreshold,
      maxRevisions,
      avgRevisions: mw.avgRevisions(),
      passRate: mw.passRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  responseRevision,
  defaultBuildRevisionPrompt,
  defaultApplyRevision,
};
