const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rrp__';
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

const testing = require('../lib/testing');
const { recording, replay, MissingFixtureError, defaultHash, fileStore } = testing;
const { LLMError } = require('../lib/errors');

// Helper — ctx factory
function ctx(method, req) {
  return { method, request: { model: 'test-model', ...req }, raw: req, meta: {} };
}

// Helper — invoke middleware with a mocked "provider" as next()
function invoke(mw, method, req, providerResponse = { text: 'from-provider' }) {
  let nextCalled = false;
  const next = async () => { nextCalled = true; return providerResponse; };
  return { promise: mw(ctx(method, req), next), getNextCalled: () => nextCalled };
}

// ---- fileStore --------------------------------------------------------

test('fileStore: loads empty schema when file does not exist', () => {
  const p = path.join(os.tmpdir(), `test-fs-empty-${Date.now()}.json`);
  const s = fileStore(p);
  assert.equal(s.size(), 0);
  assert.equal(s.get('nonexistent'), null);
});

test('fileStore: set + get round-trip through disk', () => {
  const p = path.join(os.tmpdir(), `test-fs-set-${Date.now()}.json`);
  const s1 = fileStore(p);
  s1.set('h1', { request: { messages: [] }, response: { text: 'a' }, recordedAt: 'now', method: 'chat' });
  // Second store loads from disk
  const s2 = fileStore(p);
  const e = s2.get('h1');
  assert.ok(e);
  assert.equal(e.response.text, 'a');
  fs.unlinkSync(p);
});

test('fileStore: throws on non-JSON content', () => {
  const p = path.join(os.tmpdir(), `test-fs-bad-${Date.now()}.json`);
  fs.writeFileSync(p, 'not json{', 'utf8');
  assert.throws(() => fileStore(p).all(), /failed to load/);
  fs.unlinkSync(p);
});

// ---- defaultHash ------------------------------------------------------

test('defaultHash: identical requests hash to same value', () => {
  const req = { model: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 };
  assert.equal(defaultHash(req, 'chat'), defaultHash(req, 'chat'));
});

test('defaultHash: different messages hash differently', () => {
  const a = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'x', messages: [{ role: 'user', content: 'bye' }] };
  assert.notEqual(defaultHash(a, 'chat'), defaultHash(b, 'chat'));
});

test('defaultHash: different method hashes differently', () => {
  const req = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  assert.notEqual(defaultHash(req, 'chat'), defaultHash(req, 'stream'));
});

test('defaultHash: irrelevant fields do not affect hash', () => {
  const a = { model: 'x', messages: [{ role: 'user', content: 'hi' }], correlationId: 'abc' };
  const b = { model: 'x', messages: [{ role: 'user', content: 'hi' }], correlationId: 'xyz' };
  assert.equal(defaultHash(a, 'chat'), defaultHash(b, 'chat'));
});

// ---- recording input validation --------------------------------------

test('recording: throws without store', () => {
  assert.throws(() => recording(), /store is required/);
});

test('recording: throws on invalid hashOn', () => {
  assert.throws(() => recording({ store: '/tmp/x.json', hashOn: 'not-fn' }), /hashOn must be a function/);
});

test('recording: throws on malformed store shape', () => {
  assert.throws(() => recording({ store: { foo: 1 } }), /file-path string or/);
});

// ---- recording behavior ----------------------------------------------

test('recording: successful call writes an entry to the store', async () => {
  const p = path.join(os.tmpdir(), `test-rec-${Date.now()}.json`);
  const rec = recording({ store: p });
  const { promise } = invoke(rec, 'chat', { messages: [{ role: 'user', content: 'hi' }] });
  const res = await promise;
  assert.equal(res.text, 'from-provider');
  assert.equal(rec.stats.recorded, 1);
  const store = fileStore(p);
  assert.equal(store.size(), 1);
  const entry = Object.values(store.all())[0];
  assert.equal(entry.method, 'chat');
  assert.equal(entry.response.text, 'from-provider');
  assert.match(entry.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  fs.unlinkSync(p);
});

test('recording: identical requests overwrite the fixture (same hash)', async () => {
  const p = path.join(os.tmpdir(), `test-rec-idem-${Date.now()}.json`);
  const rec = recording({ store: p });
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'hi' }] }, { text: 'first' }).promise;
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'hi' }] }, { text: 'second' }).promise;
  assert.equal(fileStore(p).size(), 1);
  const entry = Object.values(fileStore(p).all())[0];
  assert.equal(entry.response.text, 'second');
  fs.unlinkSync(p);
});

test('recording: skipMethods bypasses recording', async () => {
  const p = path.join(os.tmpdir(), `test-rec-skip-${Date.now()}.json`);
  const rec = recording({ store: p, skipMethods: ['stream'] });
  const { promise: p1, getNextCalled: n1 } = invoke(rec, 'stream', { messages: [{ role: 'user', content: 'x' }] });
  await p1;
  assert.equal(n1(), true);
  assert.equal(rec.stats.skipped, 1);
  assert.equal(rec.stats.recorded, 0);
  // File never created because no write happened; guard the unlink
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

test('recording: onWrite callback fires with { hash, method }', async () => {
  const p = path.join(os.tmpdir(), `test-rec-cb-${Date.now()}.json`);
  const events = [];
  const rec = recording({ store: p, onWrite: (info) => events.push(info) });
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'hi' }] }).promise;
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'chat');
  assert.match(events[0].hash, /^[a-f0-9]{64}$/);
  fs.unlinkSync(p);
});

test('recording: write failure does not break the request (returns response, records skip)', async () => {
  // Store that fails on set
  const badStore = {
    get: () => null,
    set: () => { throw new Error('disk full'); },
    all: () => ({}),
  };
  const rec = recording({ store: badStore });
  const { promise } = invoke(rec, 'chat', { messages: [{ role: 'user', content: 'hi' }] });
  const res = await promise;
  assert.equal(res.text, 'from-provider');
  assert.equal(rec.stats.skipped, 1);
});

// ---- replay input validation -----------------------------------------

test('replay: throws without store', () => {
  assert.throws(() => replay(), /store is required/);
});

test('replay: throws on invalid hashOn', () => {
  assert.throws(() => replay({ store: '/tmp/x.json', hashOn: 42 }), /hashOn must be a function/);
});

// ---- replay behavior --------------------------------------------------

test('replay: returns fixture without calling next() (cache hit)', async () => {
  const p = path.join(os.tmpdir(), `test-rep-hit-${Date.now()}.json`);
  // Pre-populate
  const req = { messages: [{ role: 'user', content: 'hi' }] };
  const hash = defaultHash({ model: 'test-model', ...req }, 'chat');
  const s = fileStore(p);
  s.set(hash, { request: req, response: { text: 'from-fixture', cached: true }, recordedAt: 'now', method: 'chat' });

  const rep = replay({ store: p });
  const { promise, getNextCalled } = invoke(rep, 'chat', req);
  const res = await promise;
  assert.equal(res.text, 'from-fixture');
  assert.equal(res.cached, true);
  assert.equal(getNextCalled(), false, 'next() should NOT be called on hit');
  assert.equal(rep.stats.hits, 1);
  fs.unlinkSync(p);
});

test('replay: strict mode throws MissingFixtureError on cache miss', async () => {
  const p = path.join(os.tmpdir(), `test-rep-miss-${Date.now()}.json`);
  const rep = replay({ store: p, strict: true });
  const { promise } = invoke(rep, 'chat', { messages: [{ role: 'user', content: 'unmatched' }] });
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof MissingFixtureError);
    assert.ok(err instanceof LLMError);
    assert.equal(err.code, 'MISSING_FIXTURE');
    assert.equal(err.methodName, 'chat');
    assert.equal(err.model, 'test-model');
    assert.match(err.hash, /^[a-f0-9]{64}$/);
    return true;
  });
  assert.equal(rep.stats.misses, 1);
});

test('replay: non-strict mode falls through to next() on miss', async () => {
  const p = path.join(os.tmpdir(), `test-rep-through-${Date.now()}.json`);
  const rep = replay({ store: p, strict: false });
  const { promise, getNextCalled } = invoke(rep, 'chat', { messages: [{ role: 'user', content: 'x' }] });
  const res = await promise;
  assert.equal(res.text, 'from-provider');   // real provider response
  assert.equal(getNextCalled(), true);
  assert.equal(rep.stats.fallthroughs, 1);
});

test('replay: skipMethods bypasses replay (falls through)', async () => {
  const p = path.join(os.tmpdir(), `test-rep-skip-${Date.now()}.json`);
  const rep = replay({ store: p, skipMethods: ['embed'], strict: true });
  const { promise, getNextCalled } = invoke(rep, 'embed', { input: 'hi' });
  const res = await promise;
  assert.equal(res.text, 'from-provider');
  assert.equal(getNextCalled(), true);
  assert.equal(rep.stats.skipped, 1);
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

test('replay: onHit / onMiss callbacks fire with { hash, method }', async () => {
  const p = path.join(os.tmpdir(), `test-rep-cb-${Date.now()}.json`);
  const req = { messages: [{ role: 'user', content: 'hi' }] };
  const hash = defaultHash({ model: 'test-model', ...req }, 'chat');
  fileStore(p).set(hash, { request: req, response: { text: 'x' }, recordedAt: 'now', method: 'chat' });

  const hits = [], misses = [];
  const rep = replay({ store: p, strict: false, onHit: (i) => hits.push(i), onMiss: (i) => misses.push(i) });
  await invoke(rep, 'chat', req).promise;
  await invoke(rep, 'chat', { messages: [{ role: 'user', content: 'other' }] }).promise;
  assert.equal(hits.length, 1);
  assert.equal(misses.length, 1);
  assert.equal(hits[0].method, 'chat');
  assert.equal(misses[0].method, 'chat');
  fs.unlinkSync(p);
});

// ---- Full record → replay round-trip ---------------------------------

test('record → replay round-trip via file store', async () => {
  const p = path.join(os.tmpdir(), `test-rt-${Date.now()}.json`);
  // Step 1: record real responses
  const rec = recording({ store: p });
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'req 1' }] }, { text: 'response 1' }).promise;
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'req 2' }] }, { text: 'response 2' }).promise;

  // Step 2: replay against a fresh store (simulates test rerun after commit)
  const rep = replay({ store: p, strict: true });
  const r1 = await invoke(rep, 'chat', { messages: [{ role: 'user', content: 'req 1' }] }).promise;
  const r2 = await invoke(rep, 'chat', { messages: [{ role: 'user', content: 'req 2' }] }).promise;
  assert.equal(r1.text, 'response 1');
  assert.equal(r2.text, 'response 2');
  assert.equal(rep.stats.hits, 2);
  fs.unlinkSync(p);
});

// ---- Custom hashOn ----------------------------------------------------

test('recording + replay: custom hashOn works end-to-end', async () => {
  const p = path.join(os.tmpdir(), `test-custom-hash-${Date.now()}.json`);
  const custom = (req, method) => `${method}:${req.messages?.[0]?.content ?? ''}`;
  const rec = recording({ store: p, hashOn: custom });
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'hi' }] }, { text: 'answer' }).promise;
  const rep = replay({ store: p, hashOn: custom, strict: true });
  const r = await invoke(rep, 'chat', { messages: [{ role: 'user', content: 'hi' }] }).promise;
  assert.equal(r.text, 'answer');
  fs.unlinkSync(p);
});

// ---- Custom in-memory store ------------------------------------------

test('recording + replay: custom in-memory store', async () => {
  const inMem = {
    _entries: {},
    get(hash) { return this._entries[hash] ?? null; },
    set(hash, entry) { this._entries[hash] = entry; },
    all()     { return { ...this._entries }; },
    size()    { return Object.keys(this._entries).length; },
  };
  const rec = recording({ store: inMem });
  await invoke(rec, 'chat', { messages: [{ role: 'user', content: 'x' }] }, { text: 'y' }).promise;
  const rep = replay({ store: inMem, strict: true });
  const r = await invoke(rep, 'chat', { messages: [{ role: 'user', content: 'x' }] }).promise;
  assert.equal(r.text, 'y');
});

// ---- MissingFixtureError inherits from LLMError ---------------------

test('MissingFixtureError: is LLMError with code MISSING_FIXTURE', () => {
  const err = new MissingFixtureError('abcdef', 'chat', 'gpt-4o');
  assert.ok(err instanceof LLMError);
  assert.equal(err.code, 'MISSING_FIXTURE');
  assert.equal(err.primitive, 'testing.replay');
  assert.equal(err.retriable, false);
  assert.equal(err.httpStatus, 500);
});
