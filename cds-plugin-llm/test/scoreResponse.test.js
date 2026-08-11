const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_score__';
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
  scoreResponse,
  formatScoreReport,
  KNOWN_CHECK_KINDS,
  CHECKS,
  validateJsonSchema,
} = require('../lib/scoreResponse');

// ---- Input validation --------------------------------------------------

test('scoreResponse: throws on missing response', () => {
  assert.throws(() => scoreResponse(null, []), /response is required/);
});
test('scoreResponse: throws on non-array rubric', () => {
  assert.throws(() => scoreResponse('x', 'not-array'), /rubric must be an array/);
});
test('scoreResponse: throws on non-object criterion', () => {
  assert.throws(() => scoreResponse('x', ['bad']), /rubric\[0\] must be an object/);
});
test('scoreResponse: throws on unknown check kind', () => {
  assert.throws(() => scoreResponse('x', [{ name: 'q', check: 'no-such-check' }]),
    /unknown check kind 'no-such-check'/);
});
test('scoreResponse: throws when check missing', () => {
  assert.throws(() => scoreResponse('x', [{ name: 'q' }]),
    /must be a string kind or a function/);
});
test('scoreResponse: throws on non-positive weight', () => {
  assert.throws(() => scoreResponse('x', [{ name: 'q', check: 'contains', value: 'x', weight: 0 }]),
    /weight must be a positive number/);
});

// ---- Empty rubric ------------------------------------------------------

test('scoreResponse: empty rubric → ok true, score 0', () => {
  const r = scoreResponse('hello', []);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(r.score, 0);
});

// ---- contains / not-contains ------------------------------------------

test('contains: passes when present', () => {
  const r = scoreResponse('hello world', [{ name: 'greeting', check: 'contains', value: 'hello' }]);
  assert.equal(r.ok, true);
});
test('contains: fails when absent', () => {
  const r = scoreResponse('hi world', [{ name: 'greeting', check: 'contains', value: 'hello' }]);
  assert.equal(r.ok, false);
  assert.match(r.results[0].reason, /does not contain/);
});
test('contains: case-insensitive when opted in', () => {
  const r = scoreResponse('HELLO world',
    [{ name: 'greeting', check: 'contains', value: 'hello', caseInsensitive: true }]);
  assert.equal(r.ok, true);
});
test('not-contains: passes when absent', () => {
  const r = scoreResponse('safe text',
    [{ name: 'no-danger', check: 'not-contains', value: 'danger' }]);
  assert.equal(r.ok, true);
});
test('not-contains: fails when present', () => {
  const r = scoreResponse('danger zone',
    [{ name: 'no-danger', check: 'not-contains', value: 'danger' }]);
  assert.equal(r.ok, false);
});

// ---- regex / not-regex --------------------------------------------------

test('regex: passes on match', () => {
  const r = scoreResponse('order #INV-42',
    [{ name: 'has-inv', check: 'regex', pattern: /INV-\d+/ }]);
  assert.equal(r.ok, true);
});
test('regex: fails on no match', () => {
  const r = scoreResponse('no invoice number',
    [{ name: 'has-inv', check: 'regex', pattern: /INV-\d+/ }]);
  assert.equal(r.ok, false);
});
test('regex: rejects non-RegExp pattern', () => {
  const r = scoreResponse('x', [{ name: 'q', check: 'regex', pattern: 'not-a-regex' }]);
  assert.equal(r.ok, false);
  assert.match(r.results[0].reason, /pattern must be a RegExp/);
});
test('not-regex: passes when no match', () => {
  const r = scoreResponse('clean text',
    [{ name: 'no-marker', check: 'not-regex', pattern: /\[MARKER\]/ }]);
  assert.equal(r.ok, true);
});

// ---- json / json-schema ------------------------------------------------

test('json: passes on valid JSON', () => {
  const r = scoreResponse('{"x": 1}', [{ name: 'json', check: 'json' }]);
  assert.equal(r.ok, true);
});
test('json: fails on invalid', () => {
  const r = scoreResponse('{bad', [{ name: 'json', check: 'json' }]);
  assert.equal(r.ok, false);
  assert.match(r.results[0].reason, /invalid JSON/);
});

test('json-schema: matches shape', () => {
  const r = scoreResponse('{"vendor": "Acme", "total": 100}', [{
    name: 'invoice-shape',
    check: 'json-schema',
    schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string' },
        total:  { type: 'number' },
      },
      required: ['vendor', 'total'],
    },
  }]);
  assert.equal(r.ok, true);
});
test('json-schema: catches missing required field', () => {
  const r = scoreResponse('{"total": 100}', [{
    name: 'invoice-shape',
    check: 'json-schema',
    schema: { type: 'object', required: ['vendor'] },
  }]);
  assert.equal(r.ok, false);
  assert.match(r.results[0].reason, /missing required/);
});

test('json-schema: extracts JSON from prose response', () => {
  const r = scoreResponse('Here is your answer: {"x": 1} thanks!', [{
    name: 'parse-embedded',
    check: 'json-schema',
    schema: { type: 'object', required: ['x'] },
  }]);
  assert.equal(r.ok, true);
});
test('json-schema: extracts JSON from code fence', () => {
  const r = scoreResponse('```json\n{"a":1}\n```', [{
    name: 'fence',
    check: 'json-schema',
    schema: { type: 'object', required: ['a'] },
  }]);
  assert.equal(r.ok, true);
});

// ---- validateJsonSchema (internal, exposed for advanced use) ------------

test('validateJsonSchema: catches additional properties when strict', () => {
  const errs = validateJsonSchema(
    { a: 1, sneaky: 'yes' },
    { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false },
  );
  assert.ok(errs.some((e) => /unexpected property "sneaky"/.test(e)));
});

// ---- word-count-range --------------------------------------------------

test('word-count-range: passes when in range', () => {
  const r = scoreResponse('one two three',
    [{ name: 'w', check: 'word-count-range', min: 2, max: 5 }]);
  assert.equal(r.ok, true);
});
test('word-count-range: catches too short', () => {
  const r = scoreResponse('hi',
    [{ name: 'w', check: 'word-count-range', min: 5, max: 20 }]);
  assert.equal(r.ok, false);
});
test('word-count-range: catches too long', () => {
  const r = scoreResponse('one two three four five six',
    [{ name: 'w', check: 'word-count-range', max: 3 }]);
  assert.equal(r.ok, false);
});

// ---- char-count-range + sentence-count-range ----------------------------

test('char-count-range: works', () => {
  const r = scoreResponse('abcde',
    [{ name: 'c', check: 'char-count-range', min: 3, max: 10 }]);
  assert.equal(r.ok, true);
});

test('sentence-count-range: counts periods correctly', () => {
  const r = scoreResponse('First. Second. Third.',
    [{ name: 's', check: 'sentence-count-range', min: 3, max: 3 }]);
  assert.equal(r.ok, true);
});

// ---- no-hallucinated-numbers -------------------------------------------

test('no-hallucinated-numbers: passes with allowed numbers only', () => {
  const r = scoreResponse('Total was 1234.56 in 2026.', [{
    name: 'facts', check: 'no-hallucinated-numbers',
    allowed: ['1234.56', '2026'],
  }]);
  assert.equal(r.ok, true);
});
test('no-hallucinated-numbers: catches unknown number', () => {
  const r = scoreResponse('Total was 9999.99 in 2026.', [{
    name: 'facts', check: 'no-hallucinated-numbers',
    allowed: ['1234.56', '2026'],
  }]);
  assert.equal(r.ok, false);
  assert.match(r.results[0].reason, /unknown number: 9999\.99/);
});
test('no-hallucinated-numbers: allows thousands separators', () => {
  const r = scoreResponse('Total was 1,234.56 in 2026.', [{
    name: 'facts', check: 'no-hallucinated-numbers',
    allowed: ['1234.56', '2026'],
  }]);
  assert.equal(r.ok, true);
});
test('no-hallucinated-numbers: ignores single digits', () => {
  const r = scoreResponse('one, 2, three; the total is 100.', [{
    name: 'facts', check: 'no-hallucinated-numbers',
    allowed: ['100'],
  }]);
  assert.equal(r.ok, true);
});

// ---- starts-with / ends-with / one-of ---------------------------------

test('starts-with / ends-with', () => {
  const r1 = scoreResponse('SELECT * FROM t',
    [{ name: 's', check: 'starts-with', value: 'SELECT' }]);
  assert.equal(r1.ok, true);
  const r2 = scoreResponse('hi world!',
    [{ name: 'e', check: 'ends-with', value: '!' }]);
  assert.equal(r2.ok, true);
});
test('one-of', () => {
  const r = scoreResponse('low', [{ name: 'level', check: 'one-of', options: ['low', 'medium', 'high'] }]);
  assert.equal(r.ok, true);
  const r2 = scoreResponse('very-high', [{ name: 'level', check: 'one-of', options: ['low', 'medium', 'high'] }]);
  assert.equal(r2.ok, false);
});
test('one-of: case-insensitive', () => {
  const r = scoreResponse('LOW',
    [{ name: 'level', check: 'one-of', options: ['low', 'medium', 'high'], caseInsensitive: true }]);
  assert.equal(r.ok, true);
});

// ---- Function-check with ctx ------------------------------------------

test('function check receives (text, ctx, response)', () => {
  let seenCtx, seenResponse;
  const rubric = [{
    name: 'tenant-mention',
    check: (text, ctx, response) => {
      seenCtx = ctx; seenResponse = response;
      return { ok: text.includes(ctx.tenantId), reason: `looking for ${ctx.tenantId}` };
    },
  }];
  const r = scoreResponse('Hi acme users!', rubric, { tenantId: 'acme' });
  assert.equal(r.ok, true);
  assert.equal(seenCtx.tenantId, 'acme');
  assert.equal(seenResponse, 'Hi acme users!');
});
test('function check that throws yields ok:false with reason', () => {
  const rubric = [{ name: 'q', check: () => { throw new Error('boom'); } }];
  const r = scoreResponse('x', rubric);
  assert.equal(r.ok, false);
  assert.match(r.results[0].reason, /check threw: boom/);
});
test('function check that returns nothing yields ok:false', () => {
  const rubric = [{ name: 'q', check: () => undefined }];
  const r = scoreResponse('x', rubric);
  assert.equal(r.ok, false);
});

// ---- Response shapes --------------------------------------------------

test('scoreResponse: accepts { text: ... } object', () => {
  const r = scoreResponse({ text: 'hello world' },
    [{ name: 'has-hello', check: 'contains', value: 'hello' }]);
  assert.equal(r.ok, true);
});
test('scoreResponse: object without text field → empty string', () => {
  const r = scoreResponse({ data: {} },
    [{ name: 'has-hello', check: 'contains', value: 'hello' }]);
  assert.equal(r.ok, false);
});

// ---- Weighted scoring -------------------------------------------------

test('scoreResponse: weighted checks contribute proportionally', () => {
  const r = scoreResponse('hello', [
    { name: 'trivial', check: 'contains', value: 'hello', weight: 1 },
    { name: 'critical', check: 'contains', value: 'MISSING', weight: 3 },
  ]);
  assert.equal(r.ok, false);
  // 1 passed (weight 1), 1 failed (weight 3). Score = 1 / 4 = 0.25.
  assert.equal(r.score, 0.25);
});

test('scoreResponse: all-pass → score 1.0, ok true', () => {
  const r = scoreResponse('hello world', [
    { name: 'a', check: 'contains', value: 'hello' },
    { name: 'b', check: 'contains', value: 'world' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.score, 1.0);
  assert.equal(r.passed, 2);
});

// ---- KNOWN_CHECK_KINDS --------------------------------------------------

test('KNOWN_CHECK_KINDS lists shipped checks', () => {
  for (const kind of [
    'contains', 'not-contains', 'regex', 'json-schema',
    'word-count-range', 'no-hallucinated-numbers', 'one-of',
  ]) {
    assert.ok(KNOWN_CHECK_KINDS.includes(kind), `missing ${kind}`);
  }
});

test('CHECKS map is frozen (safe to import)', () => {
  // Non-strict Node silently rejects the assignment; strict mode throws.
  // Either way, the property never lands — assert the state directly.
  try { CHECKS['brand-new-check'] = () => {}; } catch { /* silently ignored is fine */ }
  assert.equal(CHECKS['brand-new-check'], undefined);
  assert.equal(Object.isFrozen(CHECKS), true);
});

// ---- formatScoreReport ------------------------------------------------

test('formatScoreReport: renders + summary', () => {
  const r = scoreResponse('hello world', [
    { name: 'has-hello', check: 'contains', value: 'hello' },
    { name: 'has-goodbye', check: 'contains', value: 'goodbye' },
  ]);
  const s = formatScoreReport(r);
  assert.match(s, /✓ has-hello/);
  assert.match(s, /✗ has-goodbye/);
  assert.match(s, /1\/2 passed/);
  assert.match(s, /score 50\.0%/);
});
test('formatScoreReport: colors:true adds ANSI codes', () => {
  const r = scoreResponse('x', [{ name: 'q', check: 'contains', value: 'y' }]);
  const s = formatScoreReport(r, { colors: true });
  assert.match(s, /\x1b\[31m/);   // red
});
test('formatScoreReport: shows weight when != 1', () => {
  const r = scoreResponse('x', [{ name: 'q', check: 'contains', value: 'x', weight: 3 }]);
  const s = formatScoreReport(r);
  assert.match(s, /weight 3/);
});
