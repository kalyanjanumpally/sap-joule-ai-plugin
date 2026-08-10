const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_mr__';
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
  modelRouter,
  evaluateMatch,
  estimateTokens,
  hasContentType,
  textFromMessages,
} = require('../lib/middleware/modelRouter');

function makeCtx({
  method = 'chat',
  request = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
  meta = {},
  raw = null,
} = {}) {
  return { method, request, raw: raw ?? request, meta };
}

// ---- Input validation --------------------------------------------------

test('modelRouter: throws on non-array rules', () => {
  assert.throws(() => modelRouter({ rules: 'not-array' }), /rules must be an array/);
});
test('modelRouter: throws on malformed rule', () => {
  assert.throws(() => modelRouter({ rules: [{}] }), /rules\[0\]\.match/);
});
test('modelRouter: throws on rule missing route', () => {
  assert.throws(() => modelRouter({ rules: [{ match: {} }] }), /rules\[0\]\.route/);
});
test('modelRouter: throws on non-function onRoute', () => {
  assert.throws(() => modelRouter({ onRoute: 'x' }), /onRoute must be/);
});
test('modelRouter: throws on non-object fallback', () => {
  assert.throws(() => modelRouter({ fallback: 'bad' }), /fallback must be/);
});

// ---- textFromMessages / hasContentType / estimateTokens ---------------

test('textFromMessages: string content', () => {
  const t = textFromMessages([{ role: 'user', content: 'hello' }]);
  assert.equal(t, 'hello');
});
test('textFromMessages: array text blocks', () => {
  const t = textFromMessages([{
    role: 'user',
    content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
  }]);
  assert.equal(t, 'a b');
});
test('hasContentType: image', () => {
  assert.equal(hasContentType([{ role: 'user', content: [{ type: 'image' }] }], 'image'), true);
  assert.equal(hasContentType([{ role: 'user', content: 'text' }], 'image'), false);
});
test('hasContentType: audio (input_audio also matches)', () => {
  assert.equal(hasContentType([{ role: 'user', content: [{ type: 'input_audio' }] }], 'audio'), true);
  assert.equal(hasContentType([{ role: 'user', content: [{ type: 'audio' }] }], 'audio'), true);
});
test('estimateTokens: char/4 heuristic', () => {
  const est = estimateTokens({ system: 'abcd', messages: [{ role: 'user', content: 'efgh' }] });
  assert.equal(est, Math.ceil(8 / 4));   // "abcdefgh" == 8 chars → 2 tokens
});

// ---- evaluateMatch ----------------------------------------------------

test('evaluateMatch: method matches string', () => {
  assert.equal(evaluateMatch({ method: 'embed' }, makeCtx({ method: 'embed' })), true);
  assert.equal(evaluateMatch({ method: 'embed' }, makeCtx({ method: 'chat' })), false);
});
test('evaluateMatch: method matches array', () => {
  assert.equal(evaluateMatch({ method: ['embed', 'chat'] }, makeCtx({ method: 'chat' })), true);
});
test('evaluateMatch: hasTools', () => {
  assert.equal(evaluateMatch({ hasTools: true }, makeCtx({ request: { tools: [{}] } })), true);
  assert.equal(evaluateMatch({ hasTools: true }, makeCtx({ request: {} })), false);
  assert.equal(evaluateMatch({ hasTools: false }, makeCtx({ request: {} })), true);
});
test('evaluateMatch: hasFormat', () => {
  assert.equal(evaluateMatch({ hasFormat: true }, makeCtx({ request: { format: {} } })), true);
  assert.equal(evaluateMatch({ hasFormat: true }, makeCtx({ request: {} })), false);
});
test('evaluateMatch: hasImages / hasPdfs / hasAudio', () => {
  const withImg = makeCtx({ request: { messages: [{ role: 'user', content: [{ type: 'image' }] }] } });
  const withPdf = makeCtx({ request: { messages: [{ role: 'user', content: [{ type: 'document' }] }] } });
  const withAud = makeCtx({ request: { messages: [{ role: 'user', content: [{ type: 'audio' }] }] } });
  assert.equal(evaluateMatch({ hasImages: true }, withImg), true);
  assert.equal(evaluateMatch({ hasPdfs: true }, withPdf), true);
  assert.equal(evaluateMatch({ hasAudio: true }, withAud), true);
});
test('evaluateMatch: systemContains string', () => {
  const c = makeCtx({ request: { system: 'You summarize purchase orders.' } });
  assert.equal(evaluateMatch({ systemContains: 'summarize' }, c), true);
  assert.equal(evaluateMatch({ systemContains: 'translate' }, c), false);
});
test('evaluateMatch: systemContains RegExp', () => {
  const c = makeCtx({ request: { system: 'Assess supplier risk' } });
  assert.equal(evaluateMatch({ systemContains: /supplier/i }, c), true);
});
test('evaluateMatch: systemMatches RegExp', () => {
  const c = makeCtx({ request: { system: 'RISK-analyzer-v2' } });
  assert.equal(evaluateMatch({ systemMatches: /^RISK/ }, c), true);
});
test('evaluateMatch: model list', () => {
  const c = makeCtx({ request: { model: 'gpt-4o-mini' } });
  assert.equal(evaluateMatch({ model: ['gpt-4o-mini', 'claude-haiku'] }, c), true);
  assert.equal(evaluateMatch({ model: 'gpt-4o' }, c), false);
});
test('evaluateMatch: minInputTokens/maxInputTokens', () => {
  const big = makeCtx({ request: { messages: [{ role: 'user', content: 'x'.repeat(2000) }] } });
  assert.equal(evaluateMatch({ minInputTokens: 400 }, big), true);   // 2000/4 = 500
  assert.equal(evaluateMatch({ maxInputTokens: 400 }, big), false);
});
test('evaluateMatch: custom function', () => {
  const yes = (ctx) => ctx.raw?.tenant === 'enterprise';
  assert.equal(evaluateMatch(yes, makeCtx({ raw: { tenant: 'enterprise' } })), true);
  assert.equal(evaluateMatch(yes, makeCtx({ raw: { tenant: 'trial' } })), false);
});
test('evaluateMatch: custom function throwing → no match', () => {
  const throws = () => { throw new Error('boom'); };
  assert.equal(evaluateMatch(throws, makeCtx()), false);
});
test('evaluateMatch: multiple criteria (all must pass)', () => {
  const c = makeCtx({ method: 'chat', request: { tools: [{}], format: { type: 'object' } } });
  assert.equal(evaluateMatch({ method: 'chat', hasTools: true, hasFormat: true }, c), true);
  assert.equal(evaluateMatch({ method: 'chat', hasTools: true, hasFormat: false }, c), false);
});

// ---- End-to-end routing -----------------------------------------------

test('modelRouter: applies first matching rule', async () => {
  const mw = modelRouter({
    rules: [
      { match: { method: 'embed' }, route: { model: 'text-embed-3-small' } },
      { match: { hasFormat: true }, route: { model: 'gpt-4o' } },
      { match: { hasTools: true },  route: { model: 'claude-opus-4-7' } },
    ],
  });
  let seen;
  const ctx = makeCtx({ request: { messages: [], tools: [{}], format: {}, model: 'orig' } });
  await mw(ctx, async () => { seen = ctx.request.model; return { text: 'ok' }; });
  assert.equal(seen, 'gpt-4o');           // hasFormat rule wins (rule[1] before rule[2])
  assert.equal(mw.stats.byRuleIndex[1], 1);
  assert.equal(mw.stats.byModel['gpt-4o'], 1);
});

test('modelRouter: leaves ctx.request unchanged when no rule matches', async () => {
  const mw = modelRouter({
    rules: [{ match: { method: 'embed' }, route: { model: 'x' } }],
  });
  const original = { model: 'orig', messages: [] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.request.model, 'orig');
  assert.equal(mw.stats.routed, 0);
  assert.equal(mw.stats.unrouted, 1);
});

test('modelRouter: fallback applied when no rule matches', async () => {
  const mw = modelRouter({
    rules: [{ match: { method: 'embed' }, route: { model: 'e' } }],
    fallback: { model: 'gpt-4o-mini' },
  });
  let seen;
  const ctx = makeCtx({ method: 'chat', request: { model: 'orig', messages: [] } });
  await mw(ctx, async () => { seen = ctx.request.model; return { text: 'ok' }; });
  assert.equal(seen, 'gpt-4o-mini');
  assert.equal(mw.stats.fallbackApplied, 1);
  assert.equal(mw.stats.byRuleIndex[-1], undefined);   // fallback tracked separately
});

test('modelRouter: overrides maxTokens + temperature', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm', maxTokens: 500, temperature: 0.2 } }],
  });
  let seen;
  const ctx = makeCtx({ request: { model: 'orig', format: {}, maxTokens: 2000, temperature: 0.9 } });
  await mw(ctx, async () => { seen = { ...ctx.request }; return { text: 'ok' }; });
  assert.equal(seen.model, 'm');
  assert.equal(seen.maxTokens, 500);
  assert.equal(seen.temperature, 0.2);
});

test('modelRouter: restores ctx.request after next() returns', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm' } }],
  });
  const original = { model: 'orig', format: {}, messages: [] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.request, original);
  assert.equal(ctx.request.model, 'orig');
});

test('modelRouter: restores ctx.request on error too', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm' } }],
  });
  const original = { model: 'orig', format: {}, messages: [] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  await assert.rejects(mw(ctx, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(ctx.request, original);
});

test('modelRouter: stamps ctx.meta.routed + routedRule + routedTo', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm-new' } }],
  });
  const ctx = makeCtx({ request: { model: 'orig', format: {}, messages: [] } });
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.meta.routed, true);
  assert.equal(ctx.meta.routedRule, 0);
  assert.equal(ctx.meta.routedFrom, 'orig');
  assert.equal(ctx.meta.routedTo, 'm-new');
});

test('modelRouter: onRoute callback fires with info', async () => {
  const events = [];
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm', reason: 'schema-mode', tags: ['schema'] } }],
    onRoute: (info) => events.push(info),
  });
  await mw(makeCtx({ request: { model: 'orig', format: {}, messages: [] } }), async () => ({ text: 'ok' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].ruleIndex, 0);
  assert.equal(events[0].fromModel, 'orig');
  assert.equal(events[0].toModel, 'm');
  assert.equal(events[0].reason, 'schema-mode');
  assert.deepEqual(events[0].tags, ['schema']);
});

test('modelRouter: onRoute error swallowed', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm' } }],
    onRoute: () => { throw new Error('broken listener'); },
  });
  const ctx = makeCtx({ request: { model: 'orig', format: {}, messages: [] } });
  const result = await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
});

test('modelRouter: passthrough when rules empty and no fallback', async () => {
  const mw = modelRouter({ rules: [] });
  const ctx = makeCtx({ request: { model: 'orig', messages: [] } });
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.request.model, 'orig');
  assert.equal(mw.stats.unrouted, 1);
});

test('modelRouter: custom directive keys flow through', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm', topP: 0.9, seed: 42 } }],
  });
  let seen;
  await mw(makeCtx({ request: { model: 'orig', format: {}, messages: [] } }),
    async (ctx) => ({ text: 'ok' }));
  const ctx = makeCtx({ request: { model: 'orig', format: {}, messages: [] } });
  await mw(ctx, async () => { seen = { ...ctx.request }; return { text: 'ok' }; });
  assert.equal(seen.topP, 0.9);
  assert.equal(seen.seed, 42);
});

// ---- MCP + reset -----------------------------------------------------

test('modelRouter: asMcpResource', () => {
  const mw = modelRouter({
    rules: [{ match: { method: 'chat' }, route: { model: 'm' } }],
    fallback: { model: 'fb' },
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://model-router');
  const payload = r.handler();
  assert.equal(payload.ruleCount, 1);
  assert.equal(payload.hasFallback, true);
  assert.equal(payload.fallbackModel, 'fb');
});

test('modelRouter: reset clears counters', async () => {
  const mw = modelRouter({
    rules: [{ match: { hasFormat: true }, route: { model: 'm' } }],
  });
  await mw(makeCtx({ request: { model: 'orig', format: {}, messages: [] } }),
    async () => ({ text: 'ok' }));
  assert.equal(mw.stats.routed, 1);
  mw.reset();
  assert.equal(mw.stats.routed, 0);
  assert.deepEqual(mw.stats.byRuleIndex, {});
  assert.deepEqual(mw.stats.byModel, {});
});

test('modelRouter: no ctx.request short-circuits to next()', async () => {
  const mw = modelRouter({ rules: [{ match: { method: 'chat' }, route: { model: 'm' } }] });
  const result = await mw({ method: 'chat' }, async () => ({ text: 'passthrough' }));
  assert.equal(result.text, 'passthrough');
  assert.equal(mw.stats.totalRequests, 1);
});

test('modelRouter: multi-rule cost policy end-to-end', async () => {
  // Realistic policy:
  //  embeddings   → cheap
  //  format+tools → premium
  //  format only  → structured-mode
  //  else         → fallback
  const mw = modelRouter({
    rules: [
      { match: { method: 'embed' }, route: { model: 'text-embed-3-small' } },
      { match: { hasFormat: true, hasTools: true }, route: { model: 'claude-opus-4-7' } },
      { match: { hasFormat: true },  route: { model: 'gpt-4o' } },
    ],
    fallback: { model: 'gpt-4o-mini' },
  });

  // Embed → cheap
  const c1 = makeCtx({ method: 'embed', request: { model: 'x', input: 'hi' } });
  await mw(c1, async () => ({ text: 'ok' }));
  assert.equal(mw.stats.byModel['text-embed-3-small'], 1);

  // Chat with format + tools → premium
  const c2 = makeCtx({ request: { model: 'x', format: {}, tools: [{}], messages: [] } });
  await mw(c2, async () => ({ text: 'ok' }));
  assert.equal(mw.stats.byModel['claude-opus-4-7'], 1);

  // Chat with format only → structured
  const c3 = makeCtx({ request: { model: 'x', format: {}, messages: [] } });
  await mw(c3, async () => ({ text: 'ok' }));
  assert.equal(mw.stats.byModel['gpt-4o'], 1);

  // Chat with nothing → fallback
  const c4 = makeCtx({ request: { model: 'x', messages: [] } });
  await mw(c4, async () => ({ text: 'ok' }));
  assert.equal(mw.stats.byModel['gpt-4o-mini'], 1);
  assert.equal(mw.stats.fallbackApplied, 1);
});
