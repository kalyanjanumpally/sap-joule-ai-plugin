const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_audit__';
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
  sensitiveDataAudit,
  InMemoryAuditStore,
  verifyChain,
  hashEntry,
  defaultDetector,
} = require('../lib/middleware/sensitiveDataAudit');
const { BUILT_IN_DETECTORS } = require('../lib/middleware/piiRedact');

function makeCtx({
  method = 'chat',
  request = { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  meta = {},
  raw = {},
} = {}) {
  return { method, request, raw, meta };
}

// ---- Input validation --------------------------------------------------

test('sensitiveDataAudit: throws without store', () => {
  assert.throws(() => sensitiveDataAudit({}), /store must expose/);
});
test('sensitiveDataAudit: throws on store missing append', () => {
  assert.throws(() => sensitiveDataAudit({ store: {} }), /store must expose/);
});
test('sensitiveDataAudit: throws on invalid trigger', () => {
  assert.throws(() => sensitiveDataAudit({
    store: new InMemoryAuditStore(), trigger: 'nope',
  }), /trigger must be/);
});
test('sensitiveDataAudit: throws on non-function detector', () => {
  assert.throws(() => sensitiveDataAudit({
    store: new InMemoryAuditStore(), detector: 'x',
  }), /detector must be a function/);
});
test('sensitiveDataAudit: throws on non-array skipMethods', () => {
  assert.throws(() => sensitiveDataAudit({
    store: new InMemoryAuditStore(), skipMethods: 'chat',
  }), /skipMethods must be an array/);
});
test('sensitiveDataAudit: throws on non-function callback', () => {
  assert.throws(() => sensitiveDataAudit({
    store: new InMemoryAuditStore(), enrich: 'x',
  }), /callbacks must be functions/);
});

// ---- InMemoryAuditStore ------------------------------------------------

test('InMemoryAuditStore: append + list', async () => {
  const s = new InMemoryAuditStore();
  await s.append({ sequence: 1, timestamp: '2026-08-10T00:00:00Z' });
  await s.append({ sequence: 2, timestamp: '2026-08-10T00:01:00Z' });
  const list = await s.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].sequence, 1);
});

test('InMemoryAuditStore: maxEntries ring-buffer', async () => {
  const s = new InMemoryAuditStore(3);
  for (let i = 1; i <= 5; i++) {
    await s.append({ sequence: i, timestamp: `2026-08-10T00:0${i}:00Z` });
  }
  const list = await s.list();
  assert.equal(list.length, 3);
  assert.equal(list[0].sequence, 3);   // 1 + 2 evicted
});

test('InMemoryAuditStore: list({ limit }) tails N', async () => {
  const s = new InMemoryAuditStore();
  for (let i = 1; i <= 5; i++) {
    await s.append({ sequence: i, timestamp: `2026-08-10T00:0${i}:00Z` });
  }
  const tail = await s.list({ limit: 2 });
  assert.equal(tail.length, 2);
  assert.equal(tail[0].sequence, 4);
});

test('InMemoryAuditStore: list({ since }) filters by timestamp', async () => {
  const s = new InMemoryAuditStore();
  await s.append({ sequence: 1, timestamp: '2026-08-10T00:00:00Z' });
  await s.append({ sequence: 2, timestamp: '2026-08-10T12:00:00Z' });
  const filtered = await s.list({ since: '2026-08-10T06:00:00Z' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sequence, 2);
});

// ---- defaultDetector ---------------------------------------------------

test('defaultDetector: detects email in request', () => {
  const ctx = makeCtx({ request: { messages: [{ role: 'user', content: 'contact alice@example.com' }] } });
  const d = defaultDetector(ctx, { text: 'ok' }, BUILT_IN_DETECTORS);
  assert.deepEqual(d.categories, ['email']);
  assert.equal(d.count, 1);
});

test('defaultDetector: detects multiple types', () => {
  const ctx = makeCtx({
    request: { messages: [{
      role: 'user',
      content: 'email a@b.co; ssn 123-45-6789; card 4242 4242 4242 4242',
    }] },
  });
  const d = defaultDetector(ctx, { text: '' }, BUILT_IN_DETECTORS);
  // Assert core categories detected (phone may also fire on the 16-digit run — that's fine).
  for (const cat of ['creditCard', 'email', 'ssn']) {
    assert.ok(d.categories.includes(cat), `missing ${cat}`);
  }
});

test('defaultDetector: detects in response text', () => {
  const ctx = makeCtx({ request: { messages: [{ role: 'user', content: 'clean' }] } });
  const d = defaultDetector(ctx, { text: 'sending to bob@company.com' }, BUILT_IN_DETECTORS);
  assert.equal(d.categories.length, 1);
  assert.equal(d.categories[0], 'email');
});

test('defaultDetector: no PII → empty', () => {
  const ctx = makeCtx({ request: { messages: [{ role: 'user', content: 'plain text' }] } });
  const d = defaultDetector(ctx, { text: 'reply' }, BUILT_IN_DETECTORS);
  assert.deepEqual(d.categories, []);
  assert.equal(d.count, 0);
});

// ---- hashEntry --------------------------------------------------------

test('hashEntry: deterministic across property order', () => {
  const a = { sequence: 1, timestamp: 't', method: 'chat' };
  const b = { method: 'chat', timestamp: 't', sequence: 1 };
  assert.equal(hashEntry(a), hashEntry(b));
});

test('hashEntry: different content → different hash', () => {
  const a = { sequence: 1, timestamp: 't' };
  const b = { sequence: 2, timestamp: 't' };
  assert.notEqual(hashEntry(a), hashEntry(b));
});

test('hashEntry: excludes hash field itself', () => {
  const a = { sequence: 1, timestamp: 't' };
  const b = { sequence: 1, timestamp: 't', hash: 'irrelevant' };
  assert.equal(hashEntry(a), hashEntry(b));
});

// ---- Skip paths --------------------------------------------------------

test('sensitiveDataAudit: skips embed method by default', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store });
  await mw(
    makeCtx({ method: 'embed', request: { input: ['alice@x.com'] } }),
    async () => ({ embeddings: [[1, 2]] }),
  );
  assert.equal(store.size(), 0);
  assert.equal(mw.stats.skipped, 1);
});

test('sensitiveDataAudit: passes through with no PII (trigger=pii-detected)', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store });
  await mw(
    makeCtx({ request: { messages: [{ role: 'user', content: 'plain' }] } }),
    async () => ({ text: 'reply' }),
  );
  assert.equal(store.size(), 0);
  assert.equal(mw.stats.audited, 0);
});

// ---- Audit trigger paths ----------------------------------------------

test('sensitiveDataAudit: PII detected → entry appended', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store });
  await mw(
    makeCtx({ request: { messages: [{ role: 'user', content: 'contact alice@example.com' }] } }),
    async () => ({ text: 'ok', model: 'x', usage: { input_tokens: 10, output_tokens: 5 } }),
  );
  assert.equal(store.size(), 1);
  const [entry] = await store.list();
  assert.equal(entry.sequence, 1);
  assert.equal(entry.method, 'chat');
  assert.equal(entry.model, 'x');
  assert.deepEqual(entry.piiCategories, ['email']);
  assert.equal(entry.piiCount, 1);
  assert.equal(entry.usage.input_tokens, 10);
  assert.ok(entry.hash);
  assert.equal(entry.prevHash, null);   // first entry
});

test('sensitiveDataAudit: trigger=always audits every call', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always' });
  await mw(makeCtx(), async () => ({ text: 'reply', model: 'x' }));
  await mw(makeCtx(), async () => ({ text: 'reply2', model: 'x' }));
  assert.equal(store.size(), 2);
});

test('sensitiveDataAudit: trigger=custom function', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({
    store,
    trigger: (ctx, result) => result?.text?.length > 100,
  });
  await mw(makeCtx(), async () => ({ text: 'short' }));
  assert.equal(store.size(), 0);
  await mw(makeCtx(), async () => ({ text: 'x'.repeat(200) }));
  assert.equal(store.size(), 1);
});

test('sensitiveDataAudit: custom detector', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({
    store,
    detector: (ctx) => {
      const text = ctx.request.messages[0].content;
      return text.includes('SECRET')
        ? { categories: ['classified'], count: 1 }
        : { categories: [], count: 0 };
    },
  });
  await mw(
    makeCtx({ request: { messages: [{ role: 'user', content: 'SECRET data here' }] } }),
    async () => ({ text: 'ack' }),
  );
  assert.equal(store.size(), 1);
  const [entry] = await store.list();
  assert.deepEqual(entry.piiCategories, ['classified']);
});

// ---- Chain integrity --------------------------------------------------

test('sensitiveDataAudit: chained entries link prevHash → hash', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always' });
  for (let i = 0; i < 5; i++) {
    await mw(makeCtx(), async () => ({ text: 'ok', model: 'x' }));
  }
  const rows = await store.list();
  assert.equal(rows.length, 5);
  const result = verifyChain(rows);
  assert.equal(result.ok, true);
});

test('sensitiveDataAudit: verifyChain detects tampering', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always' });
  await mw(makeCtx(), async () => ({ text: 'a', model: 'x' }));
  await mw(makeCtx(), async () => ({ text: 'b', model: 'x' }));
  await mw(makeCtx(), async () => ({ text: 'c', model: 'x' }));
  const rows = await store.list();
  // Tamper with the middle entry's data.
  rows[1].piiCount = 999;
  const result = verifyChain(rows);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.equal(result.reason, 'hash mismatch');
});

test('sensitiveDataAudit: verifyChain detects insertion (broken prevHash)', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always' });
  await mw(makeCtx(), async () => ({ text: 'a', model: 'x' }));
  await mw(makeCtx(), async () => ({ text: 'b', model: 'x' }));
  const rows = await store.list();
  // Insert a synthetic row in the middle without recomputing hashes.
  const fake = { sequence: 999, timestamp: 'x', method: 'chat', model: 'x',
    correlationId: null, piiCategories: [], piiCount: 0, requestChars: 0,
    responseChars: 0, usage: null, prevHash: 'wrong', hash: 'wrong' };
  rows.splice(1, 0, fake);
  const result = verifyChain(rows);
  assert.equal(result.ok, false);
});

test('sensitiveDataAudit: chained:false skips prevHash chaining', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always', chained: false });
  await mw(makeCtx(), async () => ({ text: 'a', model: 'x' }));
  await mw(makeCtx(), async () => ({ text: 'b', model: 'x' }));
  const rows = await store.list();
  assert.equal(rows[0].prevHash, null);
  assert.equal(rows[1].prevHash, null);
});

// ---- Payload inclusion ------------------------------------------------

test('sensitiveDataAudit: includePayload:false omits preview by default', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store });
  await mw(
    makeCtx({ request: { messages: [{ role: 'user', content: 'email alice@x.com' }] } }),
    async () => ({ text: 'sent to alice@x.com' }),
  );
  const [entry] = await store.list();
  assert.equal(entry.requestPreview, undefined);
  assert.equal(entry.responsePreview, undefined);
});

test('sensitiveDataAudit: includePayload:true stores redacted preview', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, includePayload: true });
  await mw(
    makeCtx({ request: { messages: [{ role: 'user', content: 'email alice@x.com now' }] } }),
    async () => ({ text: 'sent to alice@x.com now' }),
  );
  const [entry] = await store.list();
  assert.match(entry.requestPreview, /<PII_EMAIL_1>/);
  assert.doesNotMatch(entry.requestPreview, /alice@x\.com/);
  assert.match(entry.responsePreview, /<PII_EMAIL_1>/);
});

test('sensitiveDataAudit: redactPayload:false stores raw preview', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, includePayload: true, redactPayload: false });
  await mw(
    makeCtx({ request: { messages: [{ role: 'user', content: 'alice@x.com' }] } }),
    async () => ({ text: 'ack' }),
  );
  const [entry] = await store.list();
  assert.match(entry.requestPreview, /alice@x\.com/);
});

// ---- Enrichment -------------------------------------------------------

test('sensitiveDataAudit: enrich adds custom fields', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({
    store, trigger: 'always',
    enrich: (ctx) => ({ tenant: ctx.raw?.tenant, userId: ctx.raw?.userId }),
  });
  await mw(
    makeCtx({ raw: { tenant: 'acme', userId: 'u-42' } }),
    async () => ({ text: 'ok', model: 'x' }),
  );
  const [entry] = await store.list();
  assert.equal(entry.tenant, 'acme');
  assert.equal(entry.userId, 'u-42');
});

test('sensitiveDataAudit: enrich error swallowed', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({
    store, trigger: 'always',
    enrich: () => { throw new Error('broken enricher'); },
  });
  await mw(makeCtx(), async () => ({ text: 'ok', model: 'x' }));
  assert.equal(store.size(), 1);   // still stored
});

// ---- Callbacks + soft-fail -------------------------------------------

test('sensitiveDataAudit: onAudit fires on successful append', async () => {
  const events = [];
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({
    store, trigger: 'always',
    onAudit: (entry) => events.push(entry),
  });
  await mw(makeCtx(), async () => ({ text: 'ok', model: 'x' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'chat');
});

test('sensitiveDataAudit: store append error → stats.storeErrors++, chain rollback', async () => {
  const errors = [];
  const badStore = {
    append: async () => { throw new Error('store down'); },
  };
  const mw = sensitiveDataAudit({
    store: badStore, trigger: 'always',
    onError: (info) => errors.push(info),
  });
  await mw(makeCtx(), async () => ({ text: 'ok', model: 'x' }));
  assert.equal(mw.stats.storeErrors, 1);
  assert.equal(mw.stats.audited, 0);
  assert.equal(mw.stats.lastSequence, 0);   // rolled back
  assert.equal(mw.stats.lastHash, null);    // rolled back
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'append');
});

test('sensitiveDataAudit: store error does NOT suppress result', async () => {
  const badStore = { append: async () => { throw new Error('boom'); } };
  const mw = sensitiveDataAudit({ store: badStore, trigger: 'always' });
  const result = await mw(makeCtx(), async () => ({ text: 'ok', model: 'x' }));
  assert.equal(result.text, 'ok');
});

// ---- Skip streams -----------------------------------------------------

test('sensitiveDataAudit: skips streams (v1)', async () => {
  const { wrapStreamCompletion } = require('../lib/streamCompletion');
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always' });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: 'ok' };
  }());
  await mw(makeCtx(), async () => stream);
  assert.equal(store.size(), 0);
  assert.equal(mw.stats.skipped, 1);
});

// ---- MCP + reset ------------------------------------------------------

test('sensitiveDataAudit: asMcpResource', () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'pii-detected', includePayload: true });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://sensitive-data-audit');
  const p = r.handler();
  assert.equal(p.trigger, 'pii-detected');
  assert.equal(p.includePayload, true);
  assert.equal(p.chained, true);
});

test('sensitiveDataAudit: reset clears counters (but not store)', async () => {
  const store = new InMemoryAuditStore();
  const mw = sensitiveDataAudit({ store, trigger: 'always' });
  await mw(makeCtx(), async () => ({ text: 'ok', model: 'x' }));
  assert.equal(mw.stats.audited, 1);
  assert.equal(store.size(), 1);
  mw.reset();
  assert.equal(mw.stats.audited, 0);
  assert.equal(mw.stats.lastSequence, 0);
  assert.equal(store.size(), 1);   // store untouched
});

// ---- verifyChain input validation ------------------------------------

test('verifyChain: throws on non-array', () => {
  assert.throws(() => verifyChain('x'), /entries must be an array/);
});

test('verifyChain: empty array → ok', () => {
  const r = verifyChain([]);
  assert.equal(r.ok, true);
});
