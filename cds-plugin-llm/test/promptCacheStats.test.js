const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pcs__';
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
  promptCacheStats,
  DEFAULT_CACHE_MULTIPLIERS,
  detectProvider,
  extractCacheTokens,
  computeCost,
} = require('../lib/middleware/promptCacheStats');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

function invoke(mw, {
  method = 'chat',
  request = { model: 'claude-opus-4-7', messages: [] },
  next = async () => ({ text: 'ok' }),
} = {}) {
  const ctx = { method, request, raw: request, meta: {} };
  return mw(ctx, next);
}

// ---- Input validation --------------------------------------------------

test('promptCacheStats: throws on non-function onCache', () => {
  assert.throws(() => promptCacheStats({ onCache: 'x' }), /onCache must be/);
});
test('promptCacheStats: throws on non-object pricing', () => {
  assert.throws(() => promptCacheStats({ pricing: 'x' }), /pricing must be/);
});
test('promptCacheStats: throws on non-object cacheMultipliers', () => {
  assert.throws(() => promptCacheStats({ cacheMultipliers: 'x' }), /cacheMultipliers must be/);
});

// ---- Provider detection ---------------------------------------------

test('detectProvider: anthropic via cache_read_input_tokens', () => {
  assert.equal(detectProvider({ cache_read_input_tokens: 100 }), 'anthropic');
});
test('detectProvider: anthropic via cache_creation_input_tokens', () => {
  assert.equal(detectProvider({ cache_creation_input_tokens: 50 }), 'anthropic');
});
test('detectProvider: openai via prompt_tokens_details.cached_tokens', () => {
  assert.equal(detectProvider({ prompt_tokens_details: { cached_tokens: 10 } }), 'openai');
});
test('detectProvider: deepseek via prompt_cache_hit_tokens', () => {
  assert.equal(detectProvider({ prompt_cache_hit_tokens: 100 }), 'deepseek');
});
test('detectProvider: gemini via cachedContentTokenCount', () => {
  assert.equal(detectProvider({ cachedContentTokenCount: 500 }), 'gemini');
});
test('detectProvider: null on no cache fields', () => {
  assert.equal(detectProvider({ input_tokens: 100, output_tokens: 50 }), null);
});
test('detectProvider: null on missing usage', () => {
  assert.equal(detectProvider(null), null);
  assert.equal(detectProvider(undefined), null);
});

// ---- Token extraction -----------------------------------------------

test('extractCacheTokens: anthropic', () => {
  const t = extractCacheTokens({
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 200,
    input_tokens: 100,
  }, 'anthropic');
  assert.deepEqual(t, { readTokens: 800, creationTokens: 200, normalTokens: 100 });
});

test('extractCacheTokens: openai (subtracts cached from prompt_tokens)', () => {
  const t = extractCacheTokens({
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 700 },
  }, 'openai');
  assert.deepEqual(t, { readTokens: 700, creationTokens: 0, normalTokens: 300 });
});

test('extractCacheTokens: deepseek', () => {
  const t = extractCacheTokens({
    prompt_cache_hit_tokens: 400,
    prompt_cache_miss_tokens: 100,
  }, 'deepseek');
  assert.deepEqual(t, { readTokens: 400, creationTokens: 0, normalTokens: 100 });
});

test('extractCacheTokens: gemini', () => {
  const t = extractCacheTokens({
    cachedContentTokenCount: 1000,
    promptTokenCount: 1200,
  }, 'gemini');
  assert.deepEqual(t, { readTokens: 1000, creationTokens: 0, normalTokens: 200 });
});

// ---- Cost math -------------------------------------------------------

test('computeCost: anthropic (90% savings on cache read)', () => {
  // claude-opus-4-7 input = $15/M
  const c = computeCost(
    { readTokens: 1_000_000, creationTokens: 0, normalTokens: 0 },
    { 'claude-opus-4-7': { input: 15 } },
    'claude-opus-4-7',
    DEFAULT_CACHE_MULTIPLIERS.anthropic,
  );
  // actual = 1M * 15/1M * 0.10 = 1.50
  // hypothetical = 1M * 15/1M = 15
  // savings = 15 - 1.5 = 13.50
  assert.ok(Math.abs(c.actual - 1.50) < 0.01);
  assert.ok(Math.abs(c.hypothetical - 15) < 0.01);
  assert.ok(Math.abs(c.savings - 13.50) < 0.01);
  assert.equal(c.priced, true);
});

test('computeCost: unpriced model returns zeros', () => {
  const c = computeCost(
    { readTokens: 1000, creationTokens: 0, normalTokens: 0 },
    {},
    'unknown-model',
    DEFAULT_CACHE_MULTIPLIERS.anthropic,
  );
  assert.equal(c.actual, 0);
  assert.equal(c.hypothetical, 0);
  assert.equal(c.savings, 0);
  assert.equal(c.priced, false);
});

// ---- Middleware end-to-end ------------------------------------------

test('promptCacheStats: skips call with no usage', async () => {
  const mw = promptCacheStats();
  await invoke(mw, { next: async () => ({ text: 'ok' }) });
  assert.equal(mw.stats.totalCalls, 1);
  assert.equal(mw.stats.callsWithCache, 0);
});

test('promptCacheStats: skips provider-less usage', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    next: async () => ({ text: 'ok', usage: { input_tokens: 100, output_tokens: 50 } }),
  });
  assert.equal(mw.stats.callsWithCache, 0);
});

test('promptCacheStats: skips provider that supports caching but no hits', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    next: async () => ({
      text: 'ok', model: 'claude-opus-4-7',
      usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  });
  // Anthropic-shaped usage but no cache activity → no stats change.
  assert.equal(mw.stats.callsWithCache, 0);
});

test('promptCacheStats: records anthropic cache hit + savings', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    next: async () => ({
      text: 'ok', model: 'claude-opus-4-7',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        output_tokens: 500,
      },
    }),
  });
  assert.equal(mw.stats.callsWithCache, 1);
  assert.equal(mw.stats.totalCacheReadTokens, 1_000_000);
  assert.equal(mw.stats.totalNormalInputTokens, 100);
  assert.ok(mw.stats.totalSavingsUsd > 13);   // ~13.50 saved
  assert.equal(mw.stats.byProvider.anthropic, 1);
  assert.ok(mw.stats.byModel['claude-opus-4-7']);
  assert.equal(mw.stats.byModel['claude-opus-4-7'].readTokens, 1_000_000);
});

test('promptCacheStats: records openai cache hit', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    request: { model: 'gpt-4o', messages: [] },
    next: async () => ({
      text: 'ok', model: 'gpt-4o',
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens: 200,
      },
    }),
  });
  assert.equal(mw.stats.callsWithCache, 1);
  assert.equal(mw.stats.totalCacheReadTokens, 800);
  assert.equal(mw.stats.totalNormalInputTokens, 200);
  assert.equal(mw.stats.byProvider.openai, 1);
  assert.ok(mw.stats.totalSavingsUsd > 0);
});

test('promptCacheStats: records deepseek cache hit', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    request: { model: 'deepseek-chat', messages: [] },
    next: async () => ({
      text: 'ok', model: 'deepseek-chat',
      usage: { prompt_cache_hit_tokens: 5000, prompt_cache_miss_tokens: 100 },
    }),
  });
  assert.equal(mw.stats.byProvider.deepseek, 1);
  assert.equal(mw.stats.totalCacheReadTokens, 5000);
});

test('promptCacheStats: records gemini cache hit', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    request: { model: 'gemini-1.5-pro', messages: [] },
    next: async () => ({
      text: 'ok', model: 'gemini-1.5-pro',
      usage: { cachedContentTokenCount: 800, promptTokenCount: 1000 },
    }),
  });
  assert.equal(mw.stats.byProvider.gemini, 1);
  assert.equal(mw.stats.totalCacheReadTokens, 800);
  assert.equal(mw.stats.totalNormalInputTokens, 200);
});

test('promptCacheStats: onCache callback fires with info', async () => {
  const events = [];
  const mw = promptCacheStats({ onCache: (info) => events.push(info) });
  await invoke(mw, {
    next: async () => ({
      model: 'claude-opus-4-7',
      usage: { cache_read_input_tokens: 500, input_tokens: 100 },
    }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].provider, 'anthropic');
  assert.equal(events[0].model, 'claude-opus-4-7');
  assert.equal(events[0].readTokens, 500);
  assert.equal(events[0].normalTokens, 100);
  assert.ok(events[0].savingsUsd > 0);
});

test('promptCacheStats: onCache error swallowed', async () => {
  const mw = promptCacheStats({ onCache: () => { throw new Error('boom'); } });
  const r = await invoke(mw, {
    next: async () => ({
      model: 'claude-opus-4-7', text: 'ok',
      usage: { cache_read_input_tokens: 100 },
    }),
  });
  assert.equal(r.text, 'ok');
});

test('promptCacheStats: custom multipliers override defaults', async () => {
  const mw = promptCacheStats({
    cacheMultipliers: { anthropic: { read: 0.5 } },   // hypothetical 50% off
  });
  await invoke(mw, {
    next: async () => ({
      model: 'claude-opus-4-7',
      usage: { cache_read_input_tokens: 1_000_000 },
    }),
  });
  // With 0.5 multiplier: actual = 1M * 15/1M * 0.5 = 7.50; savings = 15 - 7.5 = 7.50
  assert.ok(Math.abs(mw.stats.totalSavingsUsd - 7.5) < 0.1);
});

test('promptCacheStats: custom pricing overrides default table', async () => {
  const mw = promptCacheStats({
    pricing: { 'my-custom-model': { input: 100 } },
  });
  await invoke(mw, {
    next: async () => ({
      model: 'my-custom-model',
      usage: { cache_read_input_tokens: 1_000_000 },
    }),
  });
  // 100/M input × 1M read × 0.10 = 10 actual; savings = 100 - 10 = 90
  assert.ok(Math.abs(mw.stats.totalSavingsUsd - 90) < 0.1);
});

test('promptCacheStats: unpriced model still counts tokens', async () => {
  const mw = promptCacheStats({ pricing: {} });
  await invoke(mw, {
    next: async () => ({
      model: 'unknown-model',
      usage: { cache_read_input_tokens: 500 },
    }),
  });
  assert.equal(mw.stats.callsWithCache, 1);
  assert.equal(mw.stats.totalCacheReadTokens, 500);
  assert.equal(mw.stats.totalSavingsUsd, 0);
  assert.equal(mw.stats.unpricedCalls, 1);
});

test('promptCacheStats: accumulates over multiple calls', async () => {
  const mw = promptCacheStats();
  for (let i = 0; i < 3; i++) {
    await invoke(mw, {
      next: async () => ({
        model: 'claude-opus-4-7',
        usage: { cache_read_input_tokens: 1000 },
      }),
    });
  }
  assert.equal(mw.stats.callsWithCache, 3);
  assert.equal(mw.stats.totalCacheReadTokens, 3000);
});

test('promptCacheStats: manual provider override', async () => {
  const mw = promptCacheStats({ provider: 'anthropic' });
  await invoke(mw, {
    next: async () => ({
      model: 'claude-opus-4-7',
      // Unusual usage shape that wouldn't auto-detect
      usage: { cache_read_input_tokens: 100 },
    }),
  });
  assert.equal(mw.stats.byProvider.anthropic, 1);
});

// ---- Streams --------------------------------------------------------

test('promptCacheStats: captures via stream onComplete', async () => {
  const mw = promptCacheStats();
  const stream = wrapStreamCompletion(async function* () {
    yield {
      type: 'done',
      model: 'claude-opus-4-7',
      usage: { cache_read_input_tokens: 500, input_tokens: 100 },
    };
  }());
  const result = await invoke(mw, {
    request: { model: 'claude-opus-4-7', messages: [] },
    next: async () => stream,
  });
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mw.stats.callsWithCache, 1);
  assert.equal(mw.stats.totalCacheReadTokens, 500);
});

test('promptCacheStats: captureStreams:false skips streams', async () => {
  const mw = promptCacheStats({ captureStreams: false });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', model: 'claude-opus-4-7', usage: { cache_read_input_tokens: 500 } };
  }());
  const result = await invoke(mw, { next: async () => stream });
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mw.stats.callsWithCache, 0);
});

// ---- MCP + reset ----------------------------------------------------

test('promptCacheStats: asMcpResource has hitRate + callsWithCacheRatio', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    next: async () => ({
      model: 'claude-opus-4-7',
      usage: { cache_read_input_tokens: 700, input_tokens: 300 },
    }),
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://prompt-cache-stats');
  const payload = r.handler();
  assert.equal(payload.hitRate, 0.7);      // 700 / 1000
  assert.equal(payload.callsWithCacheRatio, 1);
});

test('promptCacheStats: reset clears everything', async () => {
  const mw = promptCacheStats();
  await invoke(mw, {
    next: async () => ({ model: 'claude-opus-4-7', usage: { cache_read_input_tokens: 100 } }),
  });
  assert.equal(mw.stats.callsWithCache, 1);
  mw.reset();
  assert.equal(mw.stats.callsWithCache, 0);
  assert.deepEqual(mw.stats.byProvider, {});
  assert.deepEqual(mw.stats.byModel, {});
});
