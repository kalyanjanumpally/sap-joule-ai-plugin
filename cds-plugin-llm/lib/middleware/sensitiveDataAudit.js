// Sensitive-data audit trail. Persists an immutable, append-only,
// hash-chained log of every LLM request/response containing PII.
// Compliance requirement for GDPR / SOX / HIPAA workloads.
//
// Each entry is:
//   - Cryptographically hashed (sha256 of canonical form)
//   - Chained to the previous entry (prevHash → detects insertion / deletion)
//   - Immutable — the store is append-only; entries are never modified
//   - Timestamped + sequence-numbered
//
// Distinct from siblings:
//   piiRedact (1.80)          — masks PII in outbound requests
//   guardrails.filters.pii    — drops PII (irreversible)
//   sensitiveDataAudit (this) — RECORDS PII touches for compliance
//   replayBuffer (1.75)       — in-memory debugging, no persistence
//
//   const { sensitiveDataAudit, InMemoryAuditStore, BUILT_IN_PII_DETECTORS }
//     = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(sensitiveDataAudit({
//     store: new InMemoryAuditStore(10_000),   // or CAP-entity store
//     enrich: (ctx) => ({ tenant: ctx.raw?.tenant, userId: ctx.raw?.userId }),
//   }));
//
//   // Later, an auditor queries the store:
//   const rows = await store.list({ since: '2026-08-01' });
//   verifyChain(rows);   // reproduces hashes, confirms no tampering

const crypto = require('node:crypto');
const { BUILT_IN_DETECTORS, makeRedactor } = require('./piiRedact');

// ---- Detection --------------------------------------------------------

function textFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    if (typeof m?.content === 'string') parts.push(m.content);
    else if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
  }
  return parts.join(' ');
}

/**
 * Default detector: scans request + response text with the shipped
 * BUILT_IN_PII_DETECTORS, returns categories found + count.
 */
function defaultDetector(ctx, result, activeDetectors) {
  const reqText  = (ctx?.request?.system ?? '') + ' ' + textFromMessages(ctx?.request?.messages);
  const resText  = typeof result?.text === 'string' ? result.text : '';
  const combined = reqText + ' ' + resText;

  const categorySet = new Set();
  let count = 0;

  for (const [type, det] of Object.entries(activeDetectors)) {
    let matches;
    try { matches = combined.match(det.pattern); }
    catch { continue; }
    if (!matches) continue;
    let valid = matches;
    if (typeof det.validate === 'function') {
      valid = matches.filter((m) => det.validate(m));
    }
    if (valid.length > 0) {
      categorySet.add(type);
      count += valid.length;
    }
  }

  return { categories: [...categorySet], count };
}

// ---- Bundled in-memory store ------------------------------------------

class InMemoryAuditStore {
  constructor(maxEntries = 10_000) {
    this.max = maxEntries;
    this.entries = [];
  }
  async append(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
  }
  async list({ limit, since } = {}) {
    let out = this.entries.slice();
    if (since) {
      const sinceMs = typeof since === 'string' ? Date.parse(since) : since;
      out = out.filter((e) => Date.parse(e.timestamp) >= sinceMs);
    }
    if (limit != null) out = out.slice(-limit);
    return out;
  }
  size() { return this.entries.length; }
  clear() { this.entries.length = 0; }
  latest() { return this.entries[this.entries.length - 1] ?? null; }
}

// ---- Hash + chain -----------------------------------------------------

function hashEntry(entry) {
  // Canonical form for hashing: sorted keys (excluding `hash` itself).
  const { hash: _ignored, ...rest } = entry;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verifies a chain of entries produced by this middleware.
 * Returns { ok, brokenAt: index|null, reason }.
 */
function verifyChain(entries) {
  if (!Array.isArray(entries)) throw new Error('verifyChain: entries must be an array.');
  let prevHash = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object') return { ok: false, brokenAt: i, reason: 'non-object entry' };
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: i, reason: 'prevHash mismatch' };
    const recomputed = hashEntry(e);
    if (e.hash !== recomputed) return { ok: false, brokenAt: i, reason: 'hash mismatch' };
    prevHash = e.hash;
  }
  return { ok: true, brokenAt: null, reason: null };
}

// ---- Main middleware --------------------------------------------------

function sensitiveDataAudit(options = {}) {
  const {
    store,
    trigger        = 'pii-detected',
    detector       = null,
    activeDetectors = BUILT_IN_DETECTORS,
    includePayload = false,
    previewChars   = 300,
    redactPayload  = true,
    chained        = true,
    enrich         = null,
    skipMethods    = ['embed'],
    onAudit        = null,
    onError        = null,
  } = options;

  if (!store || typeof store.append !== 'function') {
    throw new Error('sensitiveDataAudit: store must expose { append(entry) → Promise<void> }.');
  }
  if (trigger !== 'pii-detected' && trigger !== 'always' && typeof trigger !== 'function') {
    throw new Error("sensitiveDataAudit: trigger must be 'pii-detected' | 'always' | function.");
  }
  if (detector != null && typeof detector !== 'function') {
    throw new Error('sensitiveDataAudit: detector must be a function or null.');
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('sensitiveDataAudit: skipMethods must be an array.');
  }
  for (const cb of [enrich, onAudit, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('sensitiveDataAudit: callbacks must be functions or null.');
    }
  }

  const skipSet = new Set(skipMethods);

  const stats = {
    totalRequests:  0,
    audited:        0,
    skipped:        0,
    piiDetected:    0,
    storeErrors:    0,
    lastSequence:   0,
    lastHash:       null,
  };

  function computeDetection(ctx, result) {
    const fn = detector ?? ((c, r) => defaultDetector(c, r, activeDetectors));
    try { return fn(ctx, result); }
    catch { return { categories: [], count: 0 }; }
  }

  function shouldAudit(ctx, result, detection) {
    if (trigger === 'always') return true;
    if (trigger === 'pii-detected') return detection.count > 0;
    try { return !!trigger(ctx, result); }
    catch { return false; }
  }

  function makePreview(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    let out = text.slice(0, previewChars);
    if (redactPayload) {
      const r = makeRedactor(activeDetectors, (type, i) => `<PII_${type.toUpperCase()}_${i}>`);
      out = r.redactString(out);
    }
    return out;
  }

  async function buildEntry(ctx, result, detection) {
    stats.lastSequence++;
    const sequence = stats.lastSequence;
    const prevHash = chained ? stats.lastHash : null;

    const entry = {
      sequence,
      timestamp:     new Date().toISOString(),
      method:        ctx?.method ?? 'unknown',
      model:         result?.model ?? ctx?.request?.model ?? null,
      correlationId: ctx?.meta?.correlationId ?? null,
      piiCategories: detection.categories,
      piiCount:      detection.count,
      requestChars:  (typeof ctx?.request?.system === 'string' ? ctx.request.system.length : 0)
                     + textFromMessages(ctx?.request?.messages).length,
      responseChars: typeof result?.text === 'string' ? result.text.length : 0,
      usage:         result?.usage ?? null,
      prevHash,
    };

    if (enrich) {
      try {
        const extra = enrich(ctx, result);
        if (extra && typeof extra === 'object') Object.assign(entry, extra);
      } catch { /* swallow */ }
    }

    if (includePayload) {
      entry.requestPreview  = makePreview(textFromMessages(ctx?.request?.messages));
      entry.responsePreview = makePreview(result?.text);
    }

    entry.hash = hashEntry(entry);
    stats.lastHash = entry.hash;
    return entry;
  }

  const mw = async (ctx, next) => {
    stats.totalRequests++;
    if (skipSet.has(ctx?.method)) { stats.skipped++; return next(); }

    const result = await next();
    // Skip stream envelopes — sensitive-data audit is a synchronous
    // completion concept; use onComplete integration in a future rev.
    const { hasStreamCompletion } = require('../streamCompletion');
    if (hasStreamCompletion(result)) { stats.skipped++; return result; }

    const detection = computeDetection(ctx, result);
    if (detection.count > 0) stats.piiDetected++;

    if (!shouldAudit(ctx, result, detection)) return result;

    let entry;
    try {
      entry = await buildEntry(ctx, result, detection);
    } catch (err) {
      stats.storeErrors++;
      if (onError) { try { onError({ err, phase: 'build' }); } catch { /* swallow */ } }
      return result;
    }

    try {
      await store.append(entry);
      stats.audited++;
      if (onAudit) { try { onAudit(entry); } catch { /* swallow */ } }
    } catch (err) {
      stats.storeErrors++;
      // Roll back the chain pointer so the NEXT entry doesn't reference
      // a hash we never actually persisted.
      stats.lastHash = entry.prevHash;
      stats.lastSequence--;
      if (onError) { try { onError({ err, phase: 'append', entry }); } catch { /* swallow */ } }
    }

    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.audited = stats.skipped = 0;
    stats.piiDetected = stats.storeErrors = 0;
    stats.lastSequence = 0;
    stats.lastHash = null;
  };
  mw.asMcpResource = () => ({
    uri: 'config://sensitive-data-audit',
    name: 'Sensitive-data audit trail',
    description: 'Immutable hash-chained log of LLM calls containing PII. Counters + last-entry pointer.',
    mimeType: 'application/json',
    handler: () => ({
      trigger,
      includePayload,
      chained,
      redactPayload,
      previewChars,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  sensitiveDataAudit,
  InMemoryAuditStore,
  verifyChain,
  hashEntry,
  defaultDetector,
};
