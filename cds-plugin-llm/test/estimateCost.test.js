const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ec__';
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

const { estimateCost } = require('../lib/estimateCost');
const { DEFAULT_PRICING } = require('../lib/pricing');
const LLMService = require('../lib/LLMService');

// ---- Input validation --------------------------------------------------

test('estimateCost: throws when model missing', () => {
  assert.throws(() => estimateCost({ messages: [] }), /model is required/);
});

test('estimateCost: throws when messages is not an array', () => {
  assert.throws(() => estimateCost({ model: 'gpt-4o-mini', messages: 'foo' }), /must be an array/);
});

test('estimateCost: throws on negative maxTokens', () => {
  assert.throws(() => estimateCost({ model: 'gpt-4o-mini', messages: [], maxTokens: -1 }), /maxTokens/);
});

// ---- Happy path --------------------------------------------------------

test('estimateCost: known priced model returns positive estimatedUsd', () => {
  const est = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello world, this is a test message.' }],
    maxTokens: 200,
  });
  assert.equal(est.model, 'gpt-4o-mini');
  assert.equal(est.priced, true);
  assert.equal(est.currency, 'USD');
  assert.ok(est.tokensIn > 0);
  assert.equal(est.estMaxTokensOut, 200);
  assert.ok(est.estimatedUsd > 0);
  assert.equal(est.estimatedUsd, est.inputUsd + est.outputUsd);
});

test('estimateCost: input tokens increase with system prompt', () => {
  const base = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    maxTokens: 100,
  });
  const withSystem = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    system: 'You are a helpful assistant that specializes in procurement analytics.',
    maxTokens: 100,
  });
  assert.ok(withSystem.tokensIn > base.tokensIn, 'system prompt should raise tokensIn');
});

test('estimateCost: cost scales roughly linearly with input length', () => {
  const short = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Short prompt.' }],
    maxTokens: 100,
  });
  const long = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'A '.repeat(500) }],
    maxTokens: 100,
  });
  assert.ok(long.tokensIn > short.tokensIn * 3, 'much longer prompt should have much larger tokensIn');
  assert.ok(long.inputUsd > short.inputUsd * 3, 'inputUsd scales with tokensIn');
});

test('estimateCost: cost scales linearly with maxTokens', () => {
  const req = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] };
  const small = estimateCost({ ...req, maxTokens: 100 });
  const large = estimateCost({ ...req, maxTokens: 1000 });
  // outputUsd should scale ~10x since output token count is 10x
  assert.ok(Math.abs(large.outputUsd / small.outputUsd - 10) < 0.01, 'outputUsd should scale linearly');
});

// ---- Unknown model -----------------------------------------------------

test('estimateCost: unknown model returns priced=false with note', () => {
  const est = estimateCost({
    model: 'made-up-model-v99',
    messages: [{ role: 'user', content: 'Hi' }],
    maxTokens: 100,
  });
  assert.equal(est.priced, false);
  assert.equal(est.estimatedUsd, 0);
  assert.equal(est.inputUsd, 0);
  assert.equal(est.outputUsd, 0);
  assert.ok(est.tokensIn > 0, 'still counts tokens even when unpriced');
  assert.match(est.notes.join('\n'), /not in pricing table/);
});

// ---- Multimodal blocks -------------------------------------------------

test('estimateCost: content array counts text blocks, skips image blocks with a note', () => {
  const est = estimateCost({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text',  text: 'Describe this image.' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/pic.png' } },
      ],
    }],
    maxTokens: 200,
  });
  assert.ok(est.tokensIn > 0);
  assert.match(est.notes.join('\n'), /skipped 1 non-text content block/);
});

test('estimateCost: multiple text blocks in a content array all counted', () => {
  const single = estimateCost({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Word one two three.' }] }],
    maxTokens: 50,
  });
  const multi = estimateCost({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Word one two three.' },
        { type: 'text', text: 'Word four five six.' },
      ],
    }],
    maxTokens: 50,
  });
  assert.ok(multi.tokensIn > single.tokensIn, 'multiple text blocks should stack');
});

// ---- Custom pricing overrides ------------------------------------------

test('estimateCost: custom pricing overrides DEFAULT_PRICING', () => {
  const est = estimateCost({
    model: 'my-private-model',
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],   // ~1000 tokens
    maxTokens: 500,
    pricing: { 'my-private-model': { input: 10, output: 20 } },
  });
  assert.equal(est.priced, true);
  assert.ok(est.estimatedUsd > 0);
  // input=~1000 tokens * $10/M = ~$0.01; output=500 tokens * $20/M = $0.01; total ~$0.02
  assert.ok(est.estimatedUsd > 0.01 && est.estimatedUsd < 0.05);
});

test('estimateCost: currency label is passed through for display', () => {
  const est = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    currency: 'EUR',
  });
  assert.equal(est.currency, 'EUR');
});

// ---- Tokenizer selection -----------------------------------------------

test('estimateCost: reports which tokenizer was used', () => {
  const est = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.ok(['tiktoken', 'js-tiktoken', 'anthropic-tokenizer', 'heuristic'].includes(est.tokenizerUsed));
});

test('estimateCost: accepts a caller-supplied tokenizer', () => {
  let called = 0;
  const fakeTok = {
    name: 'fake',
    countTokens: (t) => { called++; return t.length; },   // 1 token per char
  };
  const est = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'abcdef' }],
    tokenizer: fakeTok,
  });
  assert.equal(est.tokenizerUsed, 'fake');
  assert.ok(called > 0);
  assert.ok(est.tokensIn >= 6);  // at least the 6 chars, plus frame tokens
});

// ---- LLMService method -------------------------------------------------

test('LLMService.estimateCost: uses this.modelId as default', () => {
  const svc = new LLMService('llm', null, { modelId: 'gpt-4o-mini' });
  const est = svc.estimateCost({
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 100,
  });
  assert.equal(est.model, 'gpt-4o-mini');
  assert.ok(est.tokensIn > 0);
});

test('LLMService.estimateCost: explicit model overrides this.modelId', () => {
  const svc = new LLMService('llm', null, { modelId: 'gpt-4o-mini' });
  const est = svc.estimateCost({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 100,
  });
  assert.equal(est.model, 'claude-sonnet-4-6');
});

// ---- Empty messages ----------------------------------------------------

test('estimateCost: empty messages array still returns valid estimate', () => {
  const est = estimateCost({
    model: 'gpt-4o-mini',
    messages: [],
    maxTokens: 100,
  });
  // Just the reply-frame overhead
  assert.ok(est.tokensIn > 0);
  assert.equal(est.estMaxTokensOut, 100);
});

// ---- Return shape --------------------------------------------------------

test('estimateCost: return shape carries all documented fields', () => {
  const est = estimateCost({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hi' }],
    maxTokens: 100,
  });
  for (const k of ['model', 'tokensIn', 'estMaxTokensOut', 'inputUsd', 'outputUsd', 'estimatedUsd', 'currency', 'priced', 'tokenizerUsed', 'notes']) {
    assert.ok(k in est, `missing field: ${k}`);
  }
  assert.ok(Array.isArray(est.notes));
});
