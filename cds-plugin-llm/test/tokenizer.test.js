const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_tokz__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor() {} async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const { getTokenizer, charsPerTokenFor, _resetCache } = require('../lib/tokenizer');

// Stub optional tokenizer packages via require.cache so we can test the
// resolver without actually installing tiktoken.
function stubPackage(name, exports) {
  const stubPath = `/tmp/__stub_${name.replace(/[@\/]/g, '_')}__`;
  require.cache[stubPath] = { exports, loaded: true };
  const orig = Module._resolveFilename;
  const wrapped = function(request, ...rest) {
    if (request === name) return stubPath;
    return orig.call(this, request, ...rest);
  };
  Module._resolveFilename = wrapped;
  return () => { Module._resolveFilename = orig; delete require.cache[stubPath]; };
}

// ---- Heuristic fallback (default; no tokenizer installed) ------------

test('getTokenizer: falls back to heuristic when no tokenizer is installed', () => {
  _resetCache();
  const t = getTokenizer('gpt-4o');
  assert.equal(t.name, 'heuristic');
  // "hello world" is 11 chars; gpt-family uses 4 chars/token → 3 tokens
  assert.equal(t.countTokens('hello world'), 3);
});

test('getTokenizer: heuristic handles null/empty text as 0', () => {
  _resetCache();
  const t = getTokenizer('gpt-4o');
  assert.equal(t.countTokens(''), 0);
  assert.equal(t.countTokens(null), 0);
  assert.equal(t.countTokens(undefined), 0);
});

test('getTokenizer: model-specific chars/token — claude denser than gpt', () => {
  _resetCache();
  const gpt = getTokenizer('gpt-4o');
  const claude = getTokenizer('claude-opus-4-7');
  // Same text: 20 chars
  const text = 'abcdefghijabcdefghij';
  const gptCount = gpt.countTokens(text);
  const claudeCount = claude.countTokens(text);
  assert.ok(claudeCount >= gptCount, 'claude 3.5 chars/tok denser than gpt 4.0');
});

test('charsPerTokenFor: matches per-family factors', () => {
  assert.equal(charsPerTokenFor(''), 4.0);
  assert.equal(charsPerTokenFor(null), 4.0);
  assert.equal(charsPerTokenFor('claude-3-5-sonnet'), 3.5);
  assert.equal(charsPerTokenFor('gpt-4-turbo'), 4.0);
  assert.equal(charsPerTokenFor('llama-3-70b'), 4.2);
  assert.equal(charsPerTokenFor('unknown-model-xyz'), 4.0);
});

// ---- tiktoken path ---------------------------------------------------

test('getTokenizer: uses tiktoken when available for OpenAI-family models', () => {
  _resetCache();
  const restore = stubPackage('tiktoken', {
    encoding_for_model: (model) => ({
      encode: (text) => new Array(Math.ceil(text.length / 3)).fill(0),  // fake tighter tokenization
    }),
  });
  try {
    const t = getTokenizer('gpt-4o');
    assert.equal(t.name, 'tiktoken');
    // "hello world" = 11 chars → 4 tokens with our fake tokenizer (11/3 = 4)
    assert.equal(t.countTokens('hello world'), 4);
  } finally {
    restore();
    _resetCache();
  }
});

test('getTokenizer: tiktoken.encoding_for_model failure falls back to get_encoding cl100k_base', () => {
  _resetCache();
  const restore = stubPackage('tiktoken', {
    encoding_for_model: () => { throw new Error('unknown model'); },
    get_encoding: (name) => {
      assert.equal(name, 'cl100k_base');
      return { encode: (text) => new Array(Math.ceil(text.length / 4)).fill(0) };
    },
  });
  try {
    const t = getTokenizer('gpt-4o');
    assert.equal(t.name, 'tiktoken');
    assert.equal(t.countTokens('abcdefgh'), 2);  // 8 chars / 4
  } finally {
    restore();
    _resetCache();
  }
});

// ---- js-tiktoken fallback --------------------------------------------

test('getTokenizer: js-tiktoken used when tiktoken is unavailable', () => {
  _resetCache();
  const restore = stubPackage('js-tiktoken', {
    encodingForModel: () => ({
      encode: (text) => new Array(Math.ceil(text.length / 5)).fill(0),
    }),
  });
  try {
    const t = getTokenizer('gpt-4o');
    assert.equal(t.name, 'js-tiktoken');
    assert.equal(t.countTokens('helloworld'), 2);  // 10 chars / 5
  } finally {
    restore();
    _resetCache();
  }
});

// ---- Anthropic tokenizer -----------------------------------------------

test('getTokenizer: @anthropic-ai/tokenizer used for Claude models when available', () => {
  _resetCache();
  const restore = stubPackage('@anthropic-ai/tokenizer', {
    countTokens: (text) => Math.ceil((text ?? '').length / 3.7),
  });
  try {
    const t = getTokenizer('claude-opus-4-7');
    assert.equal(t.name, 'anthropic-tokenizer');
    assert.equal(t.countTokens('claude sonnet high performance!'), Math.ceil(31 / 3.7));
  } finally {
    restore();
    _resetCache();
  }
});

test('getTokenizer: Claude falls back to tiktoken cl100k_base if anthropic-tokenizer missing', () => {
  _resetCache();
  const restore = stubPackage('tiktoken', {
    get_encoding: (name) => {
      assert.equal(name, 'cl100k_base');
      return { encode: (text) => new Array(Math.ceil(text.length / 3.5)).fill(0) };
    },
  });
  try {
    const t = getTokenizer('claude-opus-4-7');
    assert.equal(t.name, 'tiktoken');
  } finally {
    restore();
    _resetCache();
  }
});

// ---- Model families that don't get real tokenization ------------------

test('getTokenizer: Gemini falls straight to heuristic (no tiktoken lookup)', () => {
  _resetCache();
  // Even if tiktoken were installed, Gemini isn't OpenAI-family and Anthropic-
  // family — so it goes straight to heuristic.
  const restore = stubPackage('tiktoken', {
    encoding_for_model: () => { throw new Error('should not be called'); },
  });
  try {
    const t = getTokenizer('gemini-2.5-flash');
    assert.equal(t.name, 'heuristic');
  } finally {
    restore();
    _resetCache();
  }
});

test('getTokenizer: unspecified model → heuristic with default char/token factor', () => {
  _resetCache();
  const t = getTokenizer(null);
  assert.equal(t.name, 'heuristic');
  assert.equal(t.countTokens('abcd'), 1);   // 4 chars / 4.0 = 1
});
