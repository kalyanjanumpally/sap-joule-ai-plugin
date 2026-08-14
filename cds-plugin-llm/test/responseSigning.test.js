const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rs2__';
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
  responseSigning,
  verifyResponseSignature,
  defaultCanonicalizeResponse,
  stableStringify,
  RESPONSE_SIGNING_ALGORITHMS,
} = require('../lib/middleware/responseSigning');

const SECRET = 'test-response-signing-key';

function ctxWith() { return { request: {} }; }

// ---- Exports ------------------------------------------------------

test('RESPONSE_SIGNING_ALGORITHMS is frozen', () => {
  assert.ok(Object.isFrozen(RESPONSE_SIGNING_ALGORITHMS));
  assert.deepEqual([...RESPONSE_SIGNING_ALGORITHMS], ['sha256', 'sha384', 'sha512']);
});

// ---- Canonicalization -------------------------------------------

test('defaultCanonicalizeResponse: same content → same string regardless of key order', () => {
  const a = { text: 'hi', usage: { input_tokens: 10 } };
  const b = { usage: { input_tokens: 10 }, text: 'hi' };
  assert.equal(defaultCanonicalizeResponse(a), defaultCanonicalizeResponse(b));
});

test('defaultCanonicalizeResponse: different text → different string', () => {
  assert.notEqual(defaultCanonicalizeResponse({ text: 'a' }), defaultCanonicalizeResponse({ text: 'b' }));
});

test('stableStringify: sorts keys deterministically', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

// ---- Validation --------------------------------------------------

test('responseSigning: throws without secret', () => {
  assert.throws(() => responseSigning({}), /secret/);
});
test('responseSigning: throws on empty secret', () => {
  assert.throws(() => responseSigning({ secret: '' }), /secret/);
});
test('responseSigning: throws on non-string non-Buffer secret', () => {
  assert.throws(() => responseSigning({ secret: 42 }), /secret/);
});
test('responseSigning: throws on unsupported algorithm', () => {
  assert.throws(() => responseSigning({ secret: SECRET, algorithm: 'md5' }), /algorithm/);
});
test('responseSigning: throws on non-function canonicalizeResponse', () => {
  assert.throws(() => responseSigning({ secret: SECRET, canonicalizeResponse: 'x' }), /canonicalize/);
});
test('responseSigning: throws on empty attachTo', () => {
  assert.throws(() => responseSigning({ secret: SECRET, attachTo: '' }), /attachTo/);
});
test('responseSigning: throws on non-function callback', () => {
  assert.throws(() => responseSigning({ secret: SECRET, onSigned: 'x' }), /callbacks/);
});

// ---- Basic signing ------------------------------------

test('responseSigning: attaches signature envelope to result', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => ({ text: 'hello' }));
  assert.ok(r.signature);
  assert.equal(r.signature.algorithm, 'sha256');
  assert.equal(r.signature.hash.length, 64);   // sha256 hex
  assert.equal(r.signature.sig.length, 64);
  assert.equal(typeof r.signature.ts, 'number');
});

test('responseSigning: signature omitted for non-object result', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => 'plain string');
  assert.equal(r, 'plain string');
  assert.equal(mw.stats.skippedNonObject, 1);
});

test('responseSigning: custom attachTo field', async () => {
  const mw = responseSigning({ secret: SECRET, attachTo: 'audit' });
  const r = await mw(ctxWith(), async () => ({ text: 'hi' }));
  assert.equal(r.signature, undefined);
  assert.ok(r.audit);
});

test('responseSigning: sha384 + sha512 produce larger hex', async () => {
  const mw384 = responseSigning({ secret: SECRET, algorithm: 'sha384' });
  const mw512 = responseSigning({ secret: SECRET, algorithm: 'sha512' });
  const r384 = await mw384(ctxWith(), async () => ({ text: 'x' }));
  const r512 = await mw512(ctxWith(), async () => ({ text: 'x' }));
  assert.equal(r384.signature.hash.length, 96);
  assert.equal(r512.signature.hash.length, 128);
});

// ---- Verifier: valid -----------------------------------

test('verifyResponseSignature: valid signature passes', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => ({ text: 'hello', usage: { input_tokens: 10 } }));
  const v = verifyResponseSignature(r, SECRET);
  assert.equal(v.valid, true);
  assert.equal(v.reason, null);
});

test('verifyResponseSignature: same secret across many responses', async () => {
  const mw = responseSigning({ secret: SECRET });
  for (let i = 0; i < 5; i++) {
    const r = await mw(ctxWith(), async () => ({ text: 'msg-' + i }));
    const v = verifyResponseSignature(r, SECRET);
    assert.equal(v.valid, true);
  }
});

// ---- Verifier: tamper detection -------------------

test('verifyResponseSignature: tampered text detected', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => ({ text: 'original' }));
  r.text = 'tampered';
  const v = verifyResponseSignature(r, SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'hash-mismatch');
});

test('verifyResponseSignature: tampered usage detected', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => ({ text: 'x', usage: { input_tokens: 100 } }));
  r.usage.input_tokens = 999;
  const v = verifyResponseSignature(r, SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'hash-mismatch');
});

test('verifyResponseSignature: tampered signature detected', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  r.signature.sig = 'x'.repeat(64);
  const v = verifyResponseSignature(r, SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'sig-mismatch');
});

test('verifyResponseSignature: wrong secret → sig-mismatch', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  const v = verifyResponseSignature(r, 'wrong-secret');
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'sig-mismatch');
});

// ---- Verifier: shape errors ---------------

test('verifyResponseSignature: non-object → not-an-object', () => {
  const v = verifyResponseSignature('plain', SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'not-an-object');
});

test('verifyResponseSignature: no signature field → missing-signature', () => {
  const v = verifyResponseSignature({ text: 'x' }, SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'missing-signature');
});

test('verifyResponseSignature: unknown algorithm → algorithm-mismatch', () => {
  const bad = { text: 'x', signature: { hash: 'a', sig: 'b', algorithm: 'md5' } };
  const v = verifyResponseSignature(bad, SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'algorithm-mismatch');
});

test('verifyResponseSignature: missing hash/sig fields → missing-signature', () => {
  const bad = { text: 'x', signature: { algorithm: 'sha256' } };
  const v = verifyResponseSignature(bad, SECRET);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'missing-signature');
});

// ---- Verifier respects attachTo -------------------

test('verifyResponseSignature: custom attachTo respected', async () => {
  const mw = responseSigning({ secret: SECRET, attachTo: 'audit' });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  const v = verifyResponseSignature(r, SECRET, { attachTo: 'audit' });
  assert.equal(v.valid, true);
});

test('verifyResponseSignature: wrong attachTo → missing-signature', async () => {
  const mw = responseSigning({ secret: SECRET, attachTo: 'audit' });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  const v = verifyResponseSignature(r, SECRET, { attachTo: 'signature' });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'missing-signature');
});

// ---- Buffer secret ----------------

test('responseSigning: Buffer secret works', async () => {
  const buf = Buffer.from(SECRET);
  const mw = responseSigning({ secret: buf });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  const v = verifyResponseSignature(r, buf);
  assert.equal(v.valid, true);
});

// ---- Downstream error propagates without signing ----

test('responseSigning: downstream throw propagates', async () => {
  const mw = responseSigning({ secret: SECRET });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }), /down/);
});

// ---- Canonical serialization stability -----

test('responseSigning: signature stable across identical results', async () => {
  const mw = responseSigning({ secret: SECRET });
  const r1 = await mw(ctxWith(), async () => ({ text: 'same', usage: { input_tokens: 5 } }));
  const r2 = await mw(ctxWith(), async () => ({ text: 'same', usage: { input_tokens: 5 } }));
  // Signature hash should be identical (deterministic over content).
  assert.equal(r1.signature.hash, r2.signature.hash);
  assert.equal(r1.signature.sig, r2.signature.sig);
});

// ---- Callbacks ---------------

test('responseSigning: onSigned fires per response', async () => {
  const events = [];
  const mw = responseSigning({ secret: SECRET, onSigned: (i) => events.push(i) });
  await mw(ctxWith(), async () => ({ text: 'a' }));
  await mw(ctxWith(), async () => ({ text: 'b' }));
  assert.equal(events.length, 2);
});

test('responseSigning: callback throws swallowed', async () => {
  const mw = responseSigning({ secret: SECRET, onSigned: () => { throw new Error('x'); } });
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  assert.ok(r.signature);
});

// ---- Stats + MCP + reset -----

test('responseSigning: stats accumulate', async () => {
  const mw = responseSigning({ secret: SECRET });
  for (let i = 0; i < 3; i++) await mw(ctxWith(), async () => ({ text: 'x' }));
  await mw(ctxWith(), async () => 'plain');
  assert.equal(mw.stats.totalCalls, 4);
  assert.equal(mw.stats.signedResponses, 3);
  assert.equal(mw.stats.skippedNonObject, 1);
});

test('responseSigning: reset zeroes counters', async () => {
  const mw = responseSigning({ secret: SECRET });
  await mw(ctxWith(), async () => ({ text: 'x' }));
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
});

test('responseSigning: asMcpResource', () => {
  const mw = responseSigning({ secret: SECRET, algorithm: 'sha512', attachTo: 'audit' });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://response-signing');
  const p = r.handler();
  assert.equal(p.algorithm, 'sha512');
  assert.equal(p.attachTo, 'audit');
});
