// Batch orchestration helpers on top of the LLMService batch API
// (1.25.0). Reduces boilerplate around the poll-until-done pattern
// and adds one-shot `runBatch()` for the common submit → wait →
// results flow used by evals and offline pipelines.
//
//   const { waitForBatch, runBatch } = require('@saptarishi/cds-plugin-llm');
//
//   // Poll an existing batch until terminal state:
//   const status = await waitForBatch(llm, 'batch-abc', {
//     pollIntervalMs: 30_000,
//     timeoutMs:      6 * 60 * 60 * 1000,
//     onProgress: (s) => console.log(`${s.status} — ${s.counts?.succeeded ?? 0} done`),
//   });
//
//   // Submit + wait + fetch results in one call:
//   const rows = await runBatch(llm, [
//     { customId: 'r1', messages: [...] },
//     { customId: 'r2', messages: [...] },
//   ], { pollIntervalMs: 30_000 });
//   // → BatchResult[] with { customId, text, model, usage, error? }

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

class BatchTimeoutError extends Error {
  constructor(id, elapsedMs, lastStatus) {
    super(`waitForBatch(${id}): timed out after ${elapsedMs}ms (last status: ${lastStatus})`);
    this.name = 'BatchTimeoutError';
    this.batchId = id;
    this.elapsedMs = elapsedMs;
    this.lastStatus = lastStatus;
  }
}

/**
 * Poll `svc.getBatch(id)` until the batch reaches a terminal state
 * (completed / failed / canceled) or the timeout elapses. Returns the
 * final status object. Fires `onProgress` on every poll (including the
 * first).
 *
 * @param {LLMService} svc                — provider with batch support
 * @param {string}     id                  — batch id from an earlier submit
 * @param {object}     [opts]
 * @param {number}     [opts.pollIntervalMs=30_000]
 * @param {number}     [opts.timeoutMs=6*3600_000]  6h by default (batch APIs' typical SLA is 24h)
 * @param {(s) => void|Promise<void>} [opts.onProgress]
 * @param {() => number} [opts.now]        clock override for tests
 * @param {(ms) => Promise<void>} [opts.sleep] delay override for tests
 * @returns {Promise<object>}              — final batch status
 */
async function waitForBatch(svc, id, opts = {}) {
  const {
    pollIntervalMs = 30_000,
    timeoutMs      = 6 * 60 * 60 * 1000,
    onProgress,
    now            = () => Date.now(),
    sleep          = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  if (!svc || typeof svc.getBatch !== 'function') {
    throw new Error('waitForBatch: svc must be an LLMService with batch support.');
  }
  if (typeof id !== 'string' || !id) {
    throw new Error('waitForBatch: id must be a non-empty string.');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error(`waitForBatch: pollIntervalMs must be a non-negative number (got ${pollIntervalMs}).`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`waitForBatch: timeoutMs must be a non-negative number (got ${timeoutMs}).`);
  }

  const startedAt = now();
  let lastStatus = null;
  while (true) {
    const status = await svc.getBatch(id);
    lastStatus = status?.status;
    if (onProgress) {
      try { await onProgress(status); } catch { /* swallow — never crash the poll loop */ }
    }
    if (TERMINAL_STATUSES.has(lastStatus)) return status;
    const elapsed = now() - startedAt;
    if (elapsed + pollIntervalMs >= timeoutMs) {
      throw new BatchTimeoutError(id, elapsed, lastStatus);
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * One-shot: submit a batch, wait for completion, return the results.
 * Convenience for the very common "kick off + block until done" flow.
 * Throws immediately if the terminal status is not 'completed'.
 *
 *   const rows = await runBatch(llm, requests, { pollIntervalMs: 30_000 });
 *   for (const r of rows) {
 *     if (r.error) log.warn(r);
 *     else         db.write(r.customId, r.text);
 *   }
 */
async function runBatch(svc, requests, opts = {}) {
  if (!svc || typeof svc.batch !== 'function') {
    throw new Error('runBatch: svc must be an LLMService with batch support.');
  }
  const handle = await svc.batch({ requests });
  const finalStatus = await waitForBatch(svc, handle.id, opts);
  if (finalStatus.status !== 'completed') {
    const err = new Error(`runBatch(${handle.id}): terminated in status '${finalStatus.status}' — no results to fetch.`);
    err.batchId = handle.id;
    err.status = finalStatus;
    throw err;
  }
  return svc.getBatchResults(handle.id);
}

module.exports = { waitForBatch, runBatch, BatchTimeoutError, TERMINAL_STATUSES };
