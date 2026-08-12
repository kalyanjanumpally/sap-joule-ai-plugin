const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rs__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const {
  requestSigning,
  verifyReceiptChain,
  defaultCanonicalizeRequest,
  defaultCanonicalizeResponse,
  stableStringify,
  ALLOWED_ALGORITHMS,
} = require('../lib/middleware/requestSigning');

const SECRET = 'test-secret-key-32bytes-long-xxxxxxxxxx';

// ---- Helpers ----------------------------------------------------------

function ctxWith(request) { return { request }; }

// ---- ALLOWED_ALGORITHMS -----------------------------------------------

test('ALLOWED_ALGORITHMS is frozen', () => {
  assert.ok(Object.isFrozen(ALLOWED_ALGORITHMS));
  assert.deepEqual([...ALLOWED_ALGORITHMS], ['sha256', 'sha384', 'sha512']);
});

// ---- Canonicalization -------------------------------------------------

test('defaultCanonicalizeRequest: same content → same string', () => {
  const a = { model: 'x', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
  const b = { temperature: 0.7, messages: [{ role: 'user', content: 'hi' }], model: 'x' };
  assert.equal(defaultCanonicalizeRequest(a), defaultCanonicalizeRequest(b));
});

test('defaultCanonicalizeRequest: different content → different string', () => {
  const a = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'x', messages: [{ role: 'user', content: 'bye' }] };
  assert.notEqual(defaultCanonicalizeRequest(a), defaultCanonicalizeRequest(b));
});

test('defaultCanonicalizeRequest: ignores volatile fields (credentials, retries)', () => {
  const a = { model: 'x', prompt: 'hi', credentials: { apiKey: 'AAA' }, retries: { max: 3 } };
  const b = { model: 'x', prompt: 'hi', credentials: { apiKey: 'BBB' }, retries: { max: 5 } };
  assert.equal(defaultCanonicalizeRequest(a), defaultCanonicalizeRequest(b));
});

test('defaultCanonicalizeResponse: same content → same string', () => {
  const a = { text: 'hi', usage: { input_tokens: 10 } };
  const b = { usage: { input_tokens: 10 }, text: 'hi' };
  assert.equal(defaultCanonicalizeResponse(a), defaultCanonicalizeResponse(b));
});

// ---- Validation ------------------------------------------------------

test('requestSigning: throws without secret', () => {
  assert.throws(() => requestSigning({}), /secret/);
});
test('requestSigning: throws on empty secret', () => {
  assert.throws(() => requestSigning({ secret: '' }), /secret/);
});
test('requestSigning: throws on non-string non-Buffer secret', () => {
  assert.throws(() => requestSigning({ secret: 42 }), /secret/);
});
test('requestSigning: throws on unsupported algorithm', () => {
  assert.throws(() => requestSigning({ secret: SECRET, algorithm: 'md5' }), /algorithm/);
});
test('requestSigning: throws on non-function canonicalize', () => {
  assert.throws(() => requestSigning({ secret: SECRET, canonicalizeRequest: 'x' }), /canonicalize/);
});
test('requestSigning: throws on non-string attachTo', () => {
  assert.throws(() => requestSigning({ secret: SECRET, attachTo: 42 }), /attachTo/);
});
test('requestSigning: throws on non-function callback', () => {
  assert.throws(() => requestSigning({ secret: SECRET, onReceipt: 'x' }), /callbacks/);
});

// ---- Basic signing + receipt emission -----------------------------

test('requestSigning: emits a receipt per successful call', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  await mw(ctxWith({ model: 'm', prompt: 'hi' }), async () => ({ text: 'hello' }));
  await mw(ctxWith({ model: 'm', prompt: 'bye' }), async () => ({ text: 'goodbye' }));
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].index, 0);
  assert.equal(receipts[1].index, 1);
  assert.equal(receipts[0].algorithm, 'sha256');
});

test('requestSigning: attaches signature to outbound request', async () => {
  const mw = requestSigning({ secret: SECRET });
  const ctx = ctxWith({ model: 'm', prompt: 'hi' });
  let seenSig;
  await mw(ctx, async () => {
    seenSig = ctx.request.signature;
    return { text: 'ok' };
  });
  assert.ok(seenSig);
  assert.equal(seenSig.algorithm, 'sha256');
  assert.ok(typeof seenSig.hash === 'string' && seenSig.hash.length === 64);
});

test('requestSigning: attachTo=null skips outbound injection', async () => {
  const receipts = [];
  const mw = requestSigning({
    secret: SECRET, attachTo: null,
    onReceipt: (r) => receipts.push(r),
  });
  const ctx = ctxWith({ model: 'm', prompt: 'hi' });
  await mw(ctx, async () => { return { text: 'ok' }; });
  assert.equal(ctx.request.signature, undefined);
  assert.equal(receipts.length, 1);
});

test('requestSigning: restores ctx.request after call', async () => {
  const mw = requestSigning({ secret: SECRET });
  const ctx = ctxWith({ model: 'm', prompt: 'hi' });
  const original = ctx.request;
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.request, original);
});

// ---- Receipt shape ------------------------------------------

test('requestSigning: receipt has all required fields', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  await mw(ctxWith({ model: 'm', prompt: 'hi' }), async () => ({ text: 'hello' }));
  const r = receipts[0];
  assert.equal(typeof r.index, 'number');
  assert.equal(typeof r.timestamp, 'number');
  assert.equal(r.algorithm, 'sha256');
  assert.equal(r.requestHash.length, 64);
  assert.equal(r.responseHash.length, 64);
  assert.equal(r.prevReceiptHash, null);   // first receipt
  assert.equal(r.sig.length, 64);
  assert.equal(r.isError, false);
});

// ---- Chain linking ----------------------------------------

test('requestSigning: chain links via prevReceiptHash', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith({ model: 'm', prompt: 'q' + i }), async () => ({ text: 'a' + i }));
  }
  assert.equal(receipts.length, 5);
  assert.equal(receipts[0].prevReceiptHash, null);
  // Each subsequent prevReceiptHash should equal SHA of prior receipt's sig.
  for (let i = 1; i < receipts.length; i++) {
    const expected = crypto.createHash('sha256').update(receipts[i - 1].sig).digest('hex');
    assert.equal(receipts[i].prevReceiptHash, expected);
  }
});

// ---- Verification -------------------------------------

test('verifyReceiptChain: valid chain passes', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith({ model: 'm', prompt: 'q' + i }), async () => ({ text: 'a' + i }));
  }
  const r = verifyReceiptChain(receipts, SECRET);
  assert.equal(r.valid, true);
  assert.equal(r.brokenIdx, -1);
  assert.equal(r.reason, null);
});

test('verifyReceiptChain: empty chain is valid', () => {
  const r = verifyReceiptChain([], SECRET);
  assert.equal(r.valid, true);
});

test('verifyReceiptChain: tampered requestHash detected', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith({ model: 'm', prompt: 'q' + i }), async () => ({ text: 'a' + i }));
  }
  // Tamper.
  receipts[2].requestHash = 'x'.repeat(64);
  const r = verifyReceiptChain(receipts, SECRET);
  assert.equal(r.valid, false);
  assert.equal(r.brokenIdx, 2);
  assert.equal(r.reason, 'sig-mismatch');
});

test('verifyReceiptChain: tampered responseHash detected', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith({ model: 'm', prompt: 'q' + i }), async () => ({ text: 'a' + i }));
  }
  receipts[1].responseHash = 'y'.repeat(64);
  const r = verifyReceiptChain(receipts, SECRET);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'sig-mismatch');
});

test('verifyReceiptChain: reordered receipts detected via chain-broken', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  for (let i = 0; i < 4; i++) {
    await mw(ctxWith({ model: 'm', prompt: 'q' + i }), async () => ({ text: 'a' + i }));
  }
  // Swap receipts[1] and receipts[2].
  const tmp = receipts[1]; receipts[1] = receipts[2]; receipts[2] = tmp;
  const r = verifyReceiptChain(receipts, SECRET);
  assert.equal(r.valid, false);
  // The chain-broken check happens BEFORE sig-mismatch (chain
  // integrity is checked first).
  assert.ok(r.reason === 'chain-broken' || r.reason === 'sig-mismatch');
});

test('verifyReceiptChain: wrong secret → sig-mismatch on first receipt', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  await mw(ctxWith({ model: 'm', prompt: 'x' }), async () => ({ text: 'y' }));
  const r = verifyReceiptChain(receipts, 'wrong-secret');
  assert.equal(r.valid, false);
  assert.equal(r.brokenIdx, 0);
  assert.equal(r.reason, 'sig-mismatch');
});

test('verifyReceiptChain: unknown algorithm rejected', () => {
  const bad = [{
    index: 0, timestamp: 0, algorithm: 'md5',
    requestHash: 'x', responseHash: 'y', prevReceiptHash: null, sig: 'z',
  }];
  const r = verifyReceiptChain(bad, SECRET);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'algorithm-mismatch');
});

test('verifyReceiptChain: missing field detected', () => {
  const bad = [{ index: 0 }];
  const r = verifyReceiptChain(bad, SECRET);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'missing-field');
});

test('verifyReceiptChain: non-array → invalid', () => {
  const r = verifyReceiptChain('not-an-array', SECRET);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'not-an-array');
});

// ---- Algorithm variants ----------------------------------

test('requestSigning: sha384 produces different signature than sha256', async () => {
  const rs256 = [];
  const mw256 = requestSigning({ secret: SECRET, onReceipt: (r) => rs256.push(r) });
  await mw256(ctxWith({ model: 'm', prompt: 'x' }), async () => ({ text: 'y' }));

  const rs384 = [];
  const mw384 = requestSigning({ secret: SECRET, algorithm: 'sha384', onReceipt: (r) => rs384.push(r) });
  await mw384(ctxWith({ model: 'm', prompt: 'x' }), async () => ({ text: 'y' }));

  assert.equal(rs256[0].requestHash.length, 64);   // sha256 = 32 bytes = 64 hex
  assert.equal(rs384[0].requestHash.length, 96);   // sha384 = 48 bytes = 96 hex
  assert.notEqual(rs256[0].sig, rs384[0].sig);
});

test('requestSigning: sha512 verifies with matching algorithm', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, algorithm: 'sha512', onReceipt: (r) => receipts.push(r) });
  for (let i = 0; i < 3; i++) {
    await mw(ctxWith({ prompt: 'q' + i }), async () => ({ text: 'a' + i }));
  }
  const r = verifyReceiptChain(receipts, SECRET);
  assert.equal(r.valid, true);
});

// ---- Downstream errors ---------------------------------

test('requestSigning: emits receipt on error path with isError=true', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  await assert.rejects(mw(ctxWith({ prompt: 'x' }), async () => { throw new Error('down'); }));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].isError, true);
});

test('requestSigning: chain continues correctly across error + success', async () => {
  const receipts = [];
  const mw = requestSigning({ secret: SECRET, onReceipt: (r) => receipts.push(r) });
  await mw(ctxWith({ prompt: 'a' }), async () => ({ text: 'a' }));
  await assert.rejects(mw(ctxWith({ prompt: 'b' }), async () => { throw new Error('down'); }));
  await mw(ctxWith({ prompt: 'c' }), async () => ({ text: 'c' }));
  assert.equal(receipts.length, 3);
  const r = verifyReceiptChain(receipts, SECRET);
  assert.equal(r.valid, true);
});

// ---- Body inclusion opt-in ------------------------

test('requestSigning: includeRequestBody attaches full request', async () => {
  const receipts = [];
  const mw = requestSigning({
    secret: SECRET, includeRequestBody: true,
    onReceipt: (r) => receipts.push(r),
  });
  await mw(ctxWith({ prompt: 'hi' }), async () => ({ text: 'ok' }));
  assert.deepEqual(receipts[0].requestBody, { prompt: 'hi' });
});

test('requestSigning: includeResponseBody attaches full response', async () => {
  const receipts = [];
  const mw = requestSigning({
    secret: SECRET, includeResponseBody: true,
    onReceipt: (r) => receipts.push(r),
  });
  await mw(ctxWith({ prompt: 'hi' }), async () => ({ text: 'ok' }));
  assert.deepEqual(receipts[0].responseBody, { text: 'ok' });
});

// ---- Buffer secret works ---------------------

test('requestSigning: Buffer secret works', async () => {
  const secretBuf = Buffer.from(SECRET);
  const receipts = [];
  const mw = requestSigning({ secret: secretBuf, onReceipt: (r) => receipts.push(r) });
  await mw(ctxWith({ prompt: 'x' }), async () => ({ text: 'y' }));
  const r = verifyReceiptChain(receipts, secretBuf);
  assert.equal(r.valid, true);
});

// ---- Callbacks ---------------------------

test('requestSigning: onReceipt callback throws swallowed', async () => {
  const mw = requestSigning({
    secret: SECRET, onReceipt: () => { throw new Error('bug'); },
  });
  const r = await mw(ctxWith({ prompt: 'x' }), async () => ({ text: 'y' }));
  assert.equal(r.text, 'y');
  assert.equal(mw.stats.onReceiptFailures, 1);
});

// ---- Stats + MCP + reset ---------------

test('requestSigning: stats accumulate', async () => {
  const mw = requestSigning({ secret: SECRET });
  for (let i = 0; i < 3; i++) {
    await mw(ctxWith({ prompt: 'x' }), async () => ({ text: 'y' }));
  }
  assert.equal(mw.stats.totalCalls, 3);
  assert.equal(mw.stats.signedRequests, 3);
  assert.equal(mw.stats.receiptsEmitted, 3);
});

test('requestSigning: reset preserves chain state', async () => {
  const mw = requestSigning({ secret: SECRET });
  await mw(ctxWith({ prompt: 'x' }), async () => ({ text: 'y' }));
  const cursorBefore = mw.chainCursor();
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  const cursorAfter = mw.chainCursor();
  // Chain cursor SHOULD be preserved.
  assert.equal(cursorAfter.index, cursorBefore.index);
});

test('requestSigning: asMcpResource', () => {
  const mw = requestSigning({
    secret: SECRET, algorithm: 'sha512', includeRequestBody: true,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://request-signing');
  const p = r.handler();
  assert.equal(p.algorithm, 'sha512');
  assert.equal(p.includeRequestBody, true);
  assert.equal(p.chainIndex, 0);
});

// ---- Determinism -------------------------

test('requestSigning: same request → same requestHash (deterministic)', async () => {
  const mw1 = requestSigning({ secret: SECRET });
  const mw2 = requestSigning({ secret: SECRET });
  const rs1 = [], rs2 = [];
  const mw1b = requestSigning({ secret: SECRET, onReceipt: (r) => rs1.push(r) });
  const mw2b = requestSigning({ secret: SECRET, onReceipt: (r) => rs2.push(r) });
  const req = { model: 'm', prompt: 'x', messages: [{ role: 'user', content: 'y' }] };
  await mw1b(ctxWith(req), async () => ({ text: 'r' }));
  await mw2b(ctxWith(req), async () => ({ text: 'r' }));
  assert.equal(rs1[0].requestHash, rs2[0].requestHash);
});
