// Request signing / HMAC receipts. Cryptographically signs each
// outbound LLM call + emits a hash-chained receipt on the response.
// The chain lets an offline verifier prove that request/response
// pairs weren't tampered with between capture and audit.
//
// Complements the shipped `sensitiveDataAudit` (1.96) — that primitive
// produces immutable hash-chained AUDIT LOGS; this one produces
// cryptographically-signed RECEIPTS keyed to a secret only the auditor
// (not the LLM provider) can verify. Together they give the full
// compliance story: audit log for what happened + signed receipts for
// non-repudiation.
//
//   const { requestSigning } = require('@saptarishi/cds-plugin-llm');
//
//   const receipts = [];
//   llm.use(requestSigning({
//     secret:     process.env.LLM_HMAC_KEY,   // Buffer or hex string
//     algorithm:  'sha256',                    // 'sha256' | 'sha384' | 'sha512'
//     onReceipt:  (r) => receipts.push(r),
//     includeRequestBody: false,               // opt-in — receipts stay small
//   }));
//
//   // Later, offline:
//   const { verifyReceiptChain } = require('@saptarishi/cds-plugin-llm');
//   const { valid, brokenIdx, reason } = verifyReceiptChain(receipts, secret);
//
// Every receipt is signed over (requestHash + responseHash +
// prevReceiptHash) so tampering with ANY field breaks the chain from
// that point forward. `prevReceiptHash` is the SHA hash of the prior
// receipt's `sig` field, so re-ordering also breaks the chain.

const crypto = require('crypto');

const ALLOWED_ALGORITHMS = Object.freeze(['sha256', 'sha384', 'sha512']);

// Deterministic serialization used for hashing. Objects walked in
// sorted-key order; functions and undefined dropped (matches JSON.stringify).
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

// Canonical serialization of a request — significant fields only.
// Ignores volatile / secret fields (credentials, retries config) so
// the same logical call produces the same signature across restarts.
function defaultCanonicalizeRequest(request) {
  if (!request || typeof request !== 'object') return stableStringify(null);
  const canonical = {
    model:       request.model,
    system:      request.system,
    prompt:      request.prompt,
    messages:    Array.isArray(request.messages) ? request.messages : undefined,
    tools:       Array.isArray(request.tools) ? request.tools : undefined,
    format:      request.format,
    temperature: request.temperature,
    maxTokens:   request.maxTokens,
    sessionId:   request.sessionId,
  };
  return stableStringify(canonical);
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

// ---- Verifier (standalone) -----------------------------------------
//
// Walk a receipt chain end-to-end. Reasons a chain can break:
//   * `sig-mismatch`      — signature doesn't match recomputed HMAC
//   * `chain-broken`      — prevReceiptHash doesn't match prior receipt's sig hash
//   * `algorithm-mismatch`— receipt claims a different algorithm than what verifier expects
//   * `missing-field`     — receipt is missing required fields

function verifyReceiptChain(receipts, secret) {
  if (!Array.isArray(receipts)) {
    return { valid: false, brokenIdx: -1, reason: 'not-an-array' };
  }
  if (receipts.length === 0) return { valid: true, brokenIdx: -1, reason: null };
  let prevSigHash = null;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (!r || typeof r !== 'object'
        || typeof r.requestHash !== 'string'
        || typeof r.responseHash !== 'string'
        || typeof r.sig !== 'string'
        || typeof r.algorithm !== 'string') {
      return { valid: false, brokenIdx: i, reason: 'missing-field' };
    }
    if (!ALLOWED_ALGORITHMS.includes(r.algorithm)) {
      return { valid: false, brokenIdx: i, reason: 'algorithm-mismatch' };
    }
    const expectedPrev = i === 0 ? null : prevSigHash;
    if ((r.prevReceiptHash ?? null) !== expectedPrev) {
      return { valid: false, brokenIdx: i, reason: 'chain-broken' };
    }
    const signedData = `${r.requestHash}|${r.responseHash}|${r.prevReceiptHash ?? ''}`;
    const expectedSig = hmac(r.algorithm, secret, signedData);
    if (expectedSig !== r.sig) {
      return { valid: false, brokenIdx: i, reason: 'sig-mismatch' };
    }
    prevSigHash = sha(r.algorithm, r.sig);
  }
  return { valid: true, brokenIdx: -1, reason: null };
}

// ---- Middleware -----------------------------------------------------

function requestSigning(options = {}) {
  const {
    secret,
    algorithm         = 'sha256',
    canonicalizeRequest  = defaultCanonicalizeRequest,
    canonicalizeResponse = defaultCanonicalizeResponse,
    onReceipt         = null,
    onError           = null,
    attachTo          = 'signature',
    includeRequestBody  = false,
    includeResponseBody = false,
    now               = () => Date.now(),
  } = options;

  if (secret == null || secret === '') {
    throw new Error('requestSigning: secret is required (Buffer or string).');
  }
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    throw new Error('requestSigning: secret must be a string or Buffer.');
  }
  if (!ALLOWED_ALGORITHMS.includes(algorithm)) {
    throw new Error(`requestSigning: algorithm must be one of ${ALLOWED_ALGORITHMS.join(', ')} (got ${JSON.stringify(algorithm)}).`);
  }
  if (typeof canonicalizeRequest !== 'function' || typeof canonicalizeResponse !== 'function') {
    throw new Error('requestSigning: canonicalizeRequest + canonicalizeResponse must be functions.');
  }
  if (attachTo != null && typeof attachTo !== 'string') {
    throw new Error('requestSigning: attachTo must be a string or null.');
  }
  for (const cb of [onReceipt, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('requestSigning: callbacks must be functions or null.');
    }
  }

  let index = 0;
  let prevSigHash = null;

  const stats = {
    totalCalls:       0,
    signedRequests:   0,
    receiptsEmitted:  0,
    signatureFailures: 0,
    onReceiptFailures: 0,
    downstreamErrors: 0,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch (err) {
      stats.onReceiptFailures++;
      /* swallow */
    }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    // Compute request signature.
    const originalRequest = ctx.request;
    let requestCanon;
    try { requestCanon = canonicalizeRequest(originalRequest); }
    catch (err) {
      stats.signatureFailures++;
      callHook(onError, { phase: 'canonicalizeRequest', error: err });
      return next();
    }
    const requestHash = sha(algorithm, requestCanon);
    stats.signedRequests++;

    // Attach signature to outbound request metadata.
    if (attachTo) {
      const signatureMeta = { hash: requestHash, algorithm, ts: now() };
      ctx.request = { ...originalRequest, [attachTo]: signatureMeta };
    }

    let result;
    try {
      result = await next();
    } catch (err) {
      stats.downstreamErrors++;
      // Emit a receipt for the error path too (audit trail must include failures).
      const responseHash = sha(algorithm, stableStringify({ error: err?.message ?? String(err), code: err?.code }));
      emitReceipt(originalRequest, result, requestHash, responseHash, /* isError */ true);
      ctx.request = originalRequest;
      throw err;
    }
    ctx.request = originalRequest;

    // Compute response hash + emit receipt.
    let responseHash;
    try {
      responseHash = sha(algorithm, canonicalizeResponse(result));
    } catch (err) {
      stats.signatureFailures++;
      callHook(onError, { phase: 'canonicalizeResponse', error: err });
      return result;
    }

    emitReceipt(originalRequest, result, requestHash, responseHash, /* isError */ false);
    return result;
  };

  function emitReceipt(request, result, requestHash, responseHash, isError) {
    const signedData = `${requestHash}|${responseHash}|${prevSigHash === null ? '' : prevSigHash}`;
    const sig = hmac(algorithm, secret, signedData);
    const receipt = {
      index,
      timestamp:      now(),
      algorithm,
      requestHash,
      responseHash,
      prevReceiptHash: prevSigHash,
      sig,
      isError:        !!isError,
    };
    if (includeRequestBody)  receipt.requestBody  = request;
    if (includeResponseBody) receipt.responseBody = result;

    prevSigHash = sha(algorithm, sig);
    index++;
    stats.receiptsEmitted++;
    callHook(onReceipt, receipt);
  }

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.signedRequests = stats.receiptsEmitted = 0;
    stats.signatureFailures = stats.onReceiptFailures = stats.downstreamErrors = 0;
    // Do NOT reset index or prevSigHash — that would break the chain
    // for observers reading a live receipt stream. Users who want a
    // fresh chain should construct a new middleware.
  };
  mw.chainCursor = () => ({ index, prevSigHash });
  mw.asMcpResource = () => ({
    uri: 'config://request-signing',
    name: 'Request signing / HMAC receipts',
    description: 'Cryptographic signatures + hash-chained receipts for LLM calls. Companion to sensitiveDataAudit.',
    mimeType: 'application/json',
    handler: () => ({
      algorithm,
      attachTo,
      includeRequestBody,
      includeResponseBody,
      chainIndex: index,
      hasPrevHash: prevSigHash !== null,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  requestSigning,
  verifyReceiptChain,
  // Exposed for tests + composition.
  defaultCanonicalizeRequest,
  defaultCanonicalizeResponse,
  stableStringify,
  ALLOWED_ALGORITHMS,
};
