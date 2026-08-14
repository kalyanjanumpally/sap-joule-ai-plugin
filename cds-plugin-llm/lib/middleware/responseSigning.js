// Response signing. Signs the LLM response with HMAC before returning
// it to the caller, so downstream consumers (SAP Event Mesh, message
// queues, service mesh hops) can verify authenticity + integrity later
// with a shared secret.
//
// Complements `requestSigning` (2.21) — that middleware signs OUTBOUND
// requests to the LLM provider AND emits per-call receipts for
// after-the-fact audit; `responseSigning` signs the RETURNED response
// so it can be verified anywhere it later travels.
//
//   const { responseSigning, verifyResponseSignature } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(responseSigning({
//     secret:    process.env.LLM_RESPONSE_HMAC_KEY,
//     algorithm: 'sha256',
//   }));
//
//   // Downstream (possibly in a different process / service):
//   const { valid, reason } = verifyResponseSignature(result, secret);
//
// The signature is attached under `result.signature` (configurable via
// `attachTo`). Consumers who don't care about signing just ignore the
// field; it doesn't interfere with `result.text` / `result.data` etc.

const crypto = require('crypto');

const ALLOWED_ALGORITHMS = Object.freeze(['sha256', 'sha384', 'sha512']);

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    if (v[k] === undefined || typeof v[k] === 'function') continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

function defaultCanonicalizeResponse(result) {
  if (!result || typeof result !== 'object') return stableStringify(null);
  const canonical = {
    text:       typeof result.text === 'string' ? result.text : null,
    data:       result.data ?? null,
    toolCalls:  Array.isArray(result.toolCalls) ? result.toolCalls : undefined,
    stopReason: result.stopReason,
    model:      result.model,
    usage:      result.usage,
  };
  return stableStringify(canonical);
}

function hmac(algorithm, key, data) {
  return crypto.createHmac(algorithm, key).update(data).digest('hex');
}

function sha(algorithm, data) {
  return crypto.createHash(algorithm).update(data).digest('hex');
}

// ---- Standalone verifier -------------------------------------------

function verifyResponseSignature(result, secret, options = {}) {
  const { attachTo = 'signature', canonicalizeResponse = defaultCanonicalizeResponse } = options;
  if (!result || typeof result !== 'object') {
    return { valid: false, reason: 'not-an-object' };
  }
  const sig = result[attachTo];
  if (!sig || typeof sig !== 'object'
      || typeof sig.hash !== 'string'
      || typeof sig.sig !== 'string'
      || typeof sig.algorithm !== 'string') {
    return { valid: false, reason: 'missing-signature' };
  }
  if (!ALLOWED_ALGORITHMS.includes(sig.algorithm)) {
    return { valid: false, reason: 'algorithm-mismatch' };
  }
  // Rebuild the canonical string from the result WITH the signature
  // field stripped so signing is stable.
  const stripped = { ...result };
  delete stripped[attachTo];
  const expectedHash = sha(sig.algorithm, canonicalizeResponse(stripped));
  if (expectedHash !== sig.hash) {
    return { valid: false, reason: 'hash-mismatch' };
  }
  const expectedSig = hmac(sig.algorithm, secret, expectedHash);
  if (expectedSig !== sig.sig) {
    return { valid: false, reason: 'sig-mismatch' };
  }
  return { valid: true, reason: null };
}

// ---- Middleware ---------------------------------------------------

function responseSigning(options = {}) {
  const {
    secret,
    algorithm            = 'sha256',
    canonicalizeResponse = defaultCanonicalizeResponse,
    attachTo             = 'signature',
    onSigned             = null,
    onError              = null,
    now                  = () => Date.now(),
  } = options;

  if (secret == null || secret === '') {
    throw new Error('responseSigning: secret is required (Buffer or string).');
  }
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    throw new Error('responseSigning: secret must be a string or Buffer.');
  }
  if (!ALLOWED_ALGORITHMS.includes(algorithm)) {
    throw new Error(`responseSigning: algorithm must be one of ${ALLOWED_ALGORITHMS.join(', ')} (got ${JSON.stringify(algorithm)}).`);
  }
  if (typeof canonicalizeResponse !== 'function') {
    throw new Error('responseSigning: canonicalizeResponse must be a function.');
  }
  if (typeof attachTo !== 'string' || attachTo.length === 0) {
    throw new Error('responseSigning: attachTo must be a non-empty string.');
  }
  for (const cb of [onSigned, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('responseSigning: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:       0,
    signedResponses:  0,
    skippedNonObject: 0,
    signatureErrors:  0,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const result = await next();

    // Skip non-object results (nothing to sign).
    if (!result || typeof result !== 'object') {
      stats.skippedNonObject++;
      return result;
    }

    let hash, sig;
    try {
      const canonical = canonicalizeResponse(result);
      hash = sha(algorithm, canonical);
      sig = hmac(algorithm, secret, hash);
    } catch (err) {
      stats.signatureErrors++;
      callHook(onError, { phase: 'sign', error: err });
      return result;
    }

    result[attachTo] = {
      hash, sig, algorithm, ts: now(),
    };
    stats.signedResponses++;
    callHook(onSigned, { hash, algorithm, ts: result[attachTo].ts });
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.signedResponses = 0;
    stats.skippedNonObject = stats.signatureErrors = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://response-signing',
    name: 'Response signing',
    description: 'HMAC-signs the response so downstream consumers can verify authenticity + integrity offline.',
    mimeType: 'application/json',
    handler: () => ({
      algorithm,
      attachTo,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  responseSigning,
  verifyResponseSignature,
  defaultCanonicalizeResponse,
  stableStringify,
  RESPONSE_SIGNING_ALGORITHMS: ALLOWED_ALGORITHMS,
};
