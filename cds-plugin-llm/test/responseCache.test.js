const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so LLMService loads without the real package.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cache__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const LLMService = require('../lib/LLMService');
const { responseCache, InMemoryLRU, defaultKeyFn } = require('../lib/middleware/responseCache');
const { usageMetering } = require('../lib/middleware/usageMetering');

// Stub provider that counts real LLM calls so we can prove cache hits
class Counter extends LLMService {
  async init() { await super.init(); this.calls = 0; }
  async _chat(params) {
    this.calls++;
    return {
      text: `answer ${this.calls}`,
      model: params.model,
      usage: { input_tokens: 100, output_tokens: 50 },
      stopReason: 'end_turn',
    };
  }
}

function makeSvc(modelId = 'claude-opus-4-7') {
  return new Counter('llm', null, { modelId, maxTokens: 500 });
}

// ---- basic caching -----------------------------------------------------

test('responseCache: second identical chat returns cached response, real LLM called once', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  const r1 = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const r2 = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 1, 'real LLM should only be called once');
  assert.equal(r1.text, 'answer 1');
  assert.equal(r2.text, 'answer 1', 'second call should return the cached first response');
  assert.equal(r1.cached, undefined, 'first response was NOT cached');
  assert.equal(r2.cached, true, 'second response WAS cached');
  assert.ok(r2.cacheKey, 'cache hit response carries cacheKey for targeted invalidation');
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
});

test('responseCache: differing messages → distinct cache entries', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'bye' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 2, 'two distinct queries → two LLM calls; third is a hit');
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 2);
});

test('responseCache: differing system prompt → distinct cache entries', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ system: 'be terse',   messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ system: 'be verbose', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 2, 'different system → different cache key');
});

test('responseCache: differing tools/format also distinguish entries', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'get_weather', input_schema: {} }] });
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], format: { type: 'object', properties: {} } });

  assert.equal(svc.calls, 3);
});

// ---- opt-out + method filtering ---------------------------------------

test('responseCache: chat({ cache: false }) skips the cache', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }], cache: false });

  assert.equal(svc.calls, 2);
  assert.equal(cache.stats.skips, 1);
  assert.equal(cache.stats.hits, 0);
});

test('responseCache: embeds are NOT cached', async () => {
  class WithEmbed extends Counter {
    async _embed({ input }) {
      this.calls++;
      const inputs = Array.isArray(input) ? input : [input];
      return { embeddings: inputs.map(() => [0.1]), model: 'x' };
    }
  }
  const svc = new WithEmbed('llm', null, { modelId: 'x', maxTokens: 100 });
  await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.embed({ input: 'hi' });
  await svc.embed({ input: 'hi' });

  assert.equal(svc.calls, 2, 'embed is not memoized');
  assert.equal(cache.stats.skips, 2);
});

test('responseCache: tool-call results are NOT cached', async () => {
  class WithTools extends LLMService {
    async init() { await super.init(); this.calls = 0; }
    async _chat(params) {
      this.calls++;
      return {
        text: '', model: params.model,
        toolCalls: [{ id: 't1', name: 'lookup', input: {} }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stopReason: 'tool_use',
      };
    }
  }
  const svc = new WithTools('llm', null, { modelId: 'x', maxTokens: 100 });
  await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 2, 'tool-turn responses are not cached — always regenerate');
});

// ---- TTL ---------------------------------------------------------------

test('responseCache: expired entries force a re-fetch', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({ ttl: 25 });
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await new Promise(r => setTimeout(r, 40));
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 2, 'TTL expired → second call reaches LLM');
  assert.equal(cache.stats.hits, 0);
  assert.equal(cache.stats.misses, 2);
});

test('responseCache: within TTL, cache hit', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({ ttl: 5000 });
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(cache.stats.hits, 1);
});

// ---- LRU eviction ------------------------------------------------------

test('InMemoryLRU: evicts the oldest entry when over maxEntries', () => {
  const lru = new InMemoryLRU({ maxEntries: 3 });
  lru.set('a', 1, 10_000);
  lru.set('b', 2, 10_000);
  lru.set('c', 3, 10_000);
  lru.set('d', 4, 10_000);   // evicts 'a'
  assert.equal(lru.get('a'), null);
  assert.equal(lru.get('b'), 2);
  assert.equal(lru.get('c'), 3);
  assert.equal(lru.get('d'), 4);
  assert.equal(lru.size(), 3);
});

test('InMemoryLRU: get() touches recency — the touched entry survives eviction', () => {
  const lru = new InMemoryLRU({ maxEntries: 3 });
  lru.set('a', 1, 10_000);
  lru.set('b', 2, 10_000);
  lru.set('c', 3, 10_000);
  lru.get('a');              // touch 'a' — now most recent
  lru.set('d', 4, 10_000);   // evicts 'b' (the actual oldest now)
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.get('b'), null);
});

test('InMemoryLRU: expired entries returned as null and deleted', () => {
  const lru = new InMemoryLRU({ maxEntries: 3 });
  lru.set('x', 'v', 5);
  const original = Date.now;
  Date.now = () => original() + 100;
  try {
    assert.equal(lru.get('x'), null);
    assert.equal(lru.has('x'), false);
  } finally { Date.now = original; }
});

// ---- pluggable backend -------------------------------------------------

test('responseCache: pluggable store — user-provided { get, set }', async () => {
  const backing = new Map();
  const store = {
    get: (k) => backing.get(k)?.value ?? null,
    set: (k, v) => { backing.set(k, { value: v }); },
  };
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({ store });
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 1);
  assert.equal(backing.size, 1);
});

// ---- custom keyFn ------------------------------------------------------

test('responseCache: custom keyFn — coarse key merges near-duplicate queries', async () => {
  const svc = makeSvc(); await svc.init();
  // Very coarse: use just the LAST message.role — everything collapses to
  // one entry. Demonstration; not a real strategy.
  const keyFn = (ctx) => 'k:' + (ctx.request.messages[ctx.request.messages.length - 1]?.role ?? 'none');
  const cache = responseCache({ keyFn });
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'query 1' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'a different query' }] });

  assert.equal(svc.calls, 1, 'coarse key collapses both to one cached entry');
});

test('responseCache: keyFn throwing → falls through to live call (no crash)', async () => {
  const svc = makeSvc(); await svc.init();
  const keyFn = () => { throw new Error('boom'); };
  const cache = responseCache({ keyFn });
  svc.use(cache);

  const res = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.text, 'answer 1');
  assert.equal(cache.stats.skips, 1);
});

// ---- integration with usageMetering ------------------------------------

test('cache hit → usageMetering records 0 cost + increments totalCachedHits + totalCostSaved', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  // Order matters: usageMetering must be OUTER (attached first) so it sees
  // cache-hit responses on the way back up the middleware chain. If cache
  // ran outer, cache hits would short-circuit before meter's next() returned.
  const meter = usageMetering();
  const cache = responseCache();
  svc.use(meter);
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.totalCachedHits, 1);
  // First call: 100 input × $15/1M + 50 output × $75/1M = 0.0015 + 0.00375 = 0.00525
  assert.ok(Math.abs(s.totalCost - 0.00525) < 1e-9, `expected 0.00525, got ${s.totalCost}`);
  assert.ok(Math.abs(s.totalCostSaved - 0.00525) < 1e-9, `expected 0.00525 saved, got ${s.totalCostSaved}`);
});

test('cache miss (no responseCache attached) leaves totalCachedHits at 0', async () => {
  const svc = makeSvc(); await svc.init();
  const meter = usageMetering();
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'bye' }] });

  const s = meter.summary();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.totalCachedHits, 0);
  assert.equal(s.totalCostSaved, 0);
});

test('reset() zeroes the new cached-hit counters too', async () => {
  const svc = makeSvc(); await svc.init();
  // Same ordering rule — meter OUTER, cache INNER.
  const meter = usageMetering();
  const cache = responseCache();
  svc.use(meter);
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(meter.summary().totalCachedHits, 1);
  meter.reset();
  const s = meter.summary();
  assert.equal(s.totalCachedHits, 0);
  assert.equal(s.totalCostSaved, 0);
});

// ---- hooks + clear + asMcpResource -------------------------------------

test('responseCache: onHit + onMiss hooks fire', async () => {
  const svc = makeSvc(); await svc.init();
  const events = [];
  const cache = responseCache({
    onHit: () => events.push('hit'),
    onMiss: () => events.push('miss'),
  });
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.deepEqual(events, ['miss', 'hit']);
});

test('responseCache: clear() empties the store', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(cache.size(), 1);
  await cache.clear();
  assert.equal(cache.size(), 0);
});

test('responseCache: delete(key) removes a specific entry', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  const r = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const cached = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await cache.delete(cached.cacheKey);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(svc.calls, 2, 'first call + one refetch after delete');
});

test('responseCache: asMcpResource() reports hit/miss + hitRate + size', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache();
  svc.use(cache);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const resource = cache.asMcpResource();
  assert.equal(resource.uri, 'config://cache');
  const payload = resource.handler();
  assert.equal(payload.hits, 1);
  assert.equal(payload.misses, 1);
  assert.equal(payload.hitRate, 0.5);
  assert.equal(payload.size, 1);
});

// ---- validation --------------------------------------------------------

test('responseCache: invalid ttl throws', () => {
  assert.throws(() => responseCache({ ttl: 0 }), /ttl/);
  assert.throws(() => responseCache({ ttl: -1 }), /ttl/);
  assert.throws(() => responseCache({ ttl: 'nope' }), /ttl/);
});

test('responseCache: non-function keyFn throws', () => {
  assert.throws(() => responseCache({ keyFn: 'not a fn' }), /keyFn/);
});

// ---- default key fn ---------------------------------------------------

test('defaultKeyFn: identical requests produce the same key', () => {
  const ctx = {
    request: {
      model: 'x', system: null, messages: [{ role: 'user', content: 'hi' }],
      tools: null, format: null, maxTokens: 100,
    },
  };
  assert.equal(defaultKeyFn(ctx), defaultKeyFn(ctx));
  assert.match(defaultKeyFn(ctx), /^[0-9a-f]{64}$/);
});
