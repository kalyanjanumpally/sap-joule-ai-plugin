const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_sor__';
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
  structuredOutputRepair,
  jsonAutoFix,
  BUILT_IN_STRATEGIES,
  StructuredOutputInvalidError,
} = require('../lib/middleware/structuredOutputRepair');

// ---- Helpers -----------------------------------------------------------

function ctxWithFormat(schema) {
  return { request: { messages: [{ role: 'user', content: 'go' }], format: schema } };
}

const INVOICE_SCHEMA = {
  type: 'object',
  required: ['invoice_number', 'amount'],
  properties: {
    invoice_number: { type: 'string' },
    amount:         { type: 'number' },
    vendor:         { type: 'string' },
  },
};

// ---- jsonAutoFix -------------------------------------------------------

test('jsonAutoFix: valid JSON pass-through', () => {
  const r = jsonAutoFix('{"a":1}');
  assert.deepEqual(r, { a: 1 });
});
test('jsonAutoFix: strips ```json fences', () => {
  const r = jsonAutoFix('```json\n{"a":1}\n```');
  assert.deepEqual(r, { a: 1 });
});
test('jsonAutoFix: strips plain ``` fences', () => {
  const r = jsonAutoFix('```\n{"a":1}\n```');
  assert.deepEqual(r, { a: 1 });
});
test('jsonAutoFix: extracts from surrounding prose', () => {
  const r = jsonAutoFix('Sure! Here is the JSON:\n{"a": 1, "b": 2}\nHope that helps.');
  assert.deepEqual(r, { a: 1, b: 2 });
});
test('jsonAutoFix: removes trailing commas', () => {
  const r = jsonAutoFix('{"a":1,"b":2,}');
  assert.deepEqual(r, { a: 1, b: 2 });
});
test('jsonAutoFix: removes trailing commas in arrays', () => {
  const r = jsonAutoFix('{"a":[1,2,3,]}');
  assert.deepEqual(r, { a: [1, 2, 3] });
});
test('jsonAutoFix: quotes unquoted keys', () => {
  const r = jsonAutoFix('{a:1,b:"two"}');
  assert.deepEqual(r, { a: 1, b: 'two' });
});
test('jsonAutoFix: converts single-quoted values to double-quoted', () => {
  const r = jsonAutoFix(`{"name": 'Alice'}`);
  assert.deepEqual(r, { name: 'Alice' });
});
test('jsonAutoFix: strips // line comments', () => {
  const r = jsonAutoFix(`{
    "a": 1, // this is a comment
    "b": 2
  }`);
  assert.deepEqual(r, { a: 1, b: 2 });
});
test('jsonAutoFix: strips /* block comments */', () => {
  const r = jsonAutoFix('{"a":1, /* comment */ "b":2}');
  assert.deepEqual(r, { a: 1, b: 2 });
});
test('jsonAutoFix: preserves // inside strings', () => {
  const r = jsonAutoFix('{"url":"https://example.com"}');
  assert.deepEqual(r, { url: 'https://example.com' });
});
test('jsonAutoFix: preserves /* inside strings', () => {
  const r = jsonAutoFix('{"pattern":"/*test*/"}');
  assert.deepEqual(r, { pattern: '/*test*/' });
});
test('jsonAutoFix: handles multiple fixes together', () => {
  const raw = "```json\n{ name: 'Widget', tags: ['a', 'b',], count: 3, }\n```";
  const r = jsonAutoFix(raw);
  assert.deepEqual(r, { name: 'Widget', tags: ['a', 'b'], count: 3 });
});
test('jsonAutoFix: returns null on unrepairable garbage', () => {
  assert.equal(jsonAutoFix('literally not JSON at all &&&'), null);
});
test('jsonAutoFix: empty string returns null', () => {
  assert.equal(jsonAutoFix(''), null);
});
test('jsonAutoFix: non-string returns null', () => {
  assert.equal(jsonAutoFix(null), null);
  assert.equal(jsonAutoFix(42), null);
});

// ---- Validation ---------------------------------------------------

test('structuredOutputRepair: throws on empty strategies', () => {
  assert.throws(() => structuredOutputRepair({ strategies: [] }), /strategies/);
});
test('structuredOutputRepair: throws on unknown built-in strategy', () => {
  assert.throws(() => structuredOutputRepair({ strategies: ['bogus'] }), /unknown built-in strategy/);
});
test('structuredOutputRepair: throws on invalid strategy object', () => {
  assert.throws(() => structuredOutputRepair({ strategies: [{ name: 'x' }] }), /string or/);
});
test('structuredOutputRepair: throws on negative maxLlmRetries', () => {
  assert.throws(() => structuredOutputRepair({ maxLlmRetries: -1 }), /maxLlmRetries/);
});
test('structuredOutputRepair: throws on non-function validate', () => {
  assert.throws(() => structuredOutputRepair({ validate: 'x' }), /validate/);
});
test('structuredOutputRepair: throws on non-function callback', () => {
  assert.throws(() => structuredOutputRepair({ onRepair: 1 }), /functions/);
});

// ---- No schema → passthrough --------------------------------------

test('structuredOutputRepair: no schema → skipped', async () => {
  const mw = structuredOutputRepair();
  const r = await mw({ request: {} }, async () => ({ text: 'anything' }));
  assert.deepEqual(r, { text: 'anything' });
  assert.equal(mw.stats.skipped, 1);
});

// ---- Fast path: valid on first try -------------------------------

test('structuredOutputRepair: valid first try → validFirstTry counter', async () => {
  const mw = structuredOutputRepair();
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{"invoice_number":"INV-1","amount":100.5,"vendor":"Acme"}',
  }));
  assert.equal(mw.stats.validFirstTry, 1);
  assert.equal(mw.stats.repaired, 0);
  assert.deepEqual(r.parsed, { invoice_number: 'INV-1', amount: 100.5, vendor: 'Acme' });
});

test('structuredOutputRepair: attaches parsed under custom key', async () => {
  const mw = structuredOutputRepair({ attachParsedAs: 'invoice' });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{"invoice_number":"INV-1","amount":100.5}',
  }));
  assert.deepEqual(r.invoice, { invoice_number: 'INV-1', amount: 100.5 });
});

test('structuredOutputRepair: does not overwrite existing parsed', async () => {
  const mw = structuredOutputRepair();
  const preExisting = { pre: 'existing' };
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{"invoice_number":"INV-1","amount":100.5}',
    parsed: preExisting,
  }));
  assert.equal(r.parsed, preExisting);
});

// ---- Repair via json-fix ------------------------------------------

test('structuredOutputRepair: json-fix repairs unquoted-key response', async () => {
  const mw = structuredOutputRepair({ strategies: ['json-fix'] });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{invoice_number:"INV-9",amount:50}',
  }));
  assert.equal(mw.stats.repaired, 1);
  assert.equal(mw.stats.byStrategy['json-fix'], 1);
  assert.deepEqual(r.parsed, { invoice_number: 'INV-9', amount: 50 });
});

test('structuredOutputRepair: json-fix repairs trailing-comma response', async () => {
  const mw = structuredOutputRepair({ strategies: ['json-fix'] });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{"invoice_number":"INV-9","amount":50,}',
  }));
  assert.equal(mw.stats.repaired, 1);
  assert.deepEqual(r.parsed, { invoice_number: 'INV-9', amount: 50 });
});

test('structuredOutputRepair: json-fix repairs single-quoted-string response', async () => {
  const mw = structuredOutputRepair({ strategies: ['json-fix'] });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: `{'invoice_number': 'INV-9', 'amount': 50}`,
  }));
  assert.equal(mw.stats.repaired, 1);
  assert.deepEqual(r.parsed, { invoice_number: 'INV-9', amount: 50 });
});

// ---- Repair via re-ask ------------------------------------------

test('structuredOutputRepair: re-ask sends correction and returns retry result', async () => {
  const mw = structuredOutputRepair({ strategies: ['re-ask'], maxLlmRetries: 1 });
  let call = 0;
  const captured = [];
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => {
    call++;
    captured.push(call);
    if (call === 1) return { text: 'I refuse to answer.' };
    return { text: '{"invoice_number":"INV-2","amount":75}' };
  });
  assert.equal(call, 2);
  assert.equal(mw.stats.repaired, 1);
  assert.equal(mw.stats.byStrategy['re-ask'], 1);
  assert.equal(mw.stats.llmRetries, 1);
  assert.deepEqual(r.parsed, { invoice_number: 'INV-2', amount: 75 });
});

test('structuredOutputRepair: re-ask restores original request on success', async () => {
  const mw = structuredOutputRepair({ strategies: ['re-ask'], maxLlmRetries: 1 });
  const ctx = ctxWithFormat(INVOICE_SCHEMA);
  const originalRequest = ctx.request;
  let call = 0;
  await mw(ctx, async () => {
    call++;
    if (call === 1) return { text: 'nope' };
    return { text: '{"invoice_number":"X","amount":1}' };
  });
  assert.equal(ctx.request, originalRequest);
});

test('structuredOutputRepair: re-ask budget exhausted → throws', async () => {
  const mw = structuredOutputRepair({ strategies: ['re-ask'], maxLlmRetries: 1 });
  await assert.rejects(
    mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({ text: 'always nope' })),
    (err) => err instanceof StructuredOutputInvalidError,
  );
  assert.equal(mw.stats.gaveUp, 1);
  assert.equal(mw.stats.llmRetries, 1);
});

// ---- Strategy order matters -----------------------------------------

test('structuredOutputRepair: json-fix succeeds → re-ask not attempted', async () => {
  const mw = structuredOutputRepair({ strategies: ['json-fix', 're-ask'], maxLlmRetries: 3 });
  let call = 0;
  await mw(ctxWithFormat(INVOICE_SCHEMA), async () => {
    call++;
    return { text: '{invoice_number:"INV-1",amount:1,}' };   // trailing comma + unquoted keys → json-fix material
  });
  assert.equal(call, 1);   // no LLM re-ask
  assert.equal(mw.stats.byStrategy['json-fix'], 1);
  assert.equal(mw.stats.byStrategy['re-ask'], 0);
  assert.equal(mw.stats.llmRetries, 0);
});

test('structuredOutputRepair: json-fix fails → re-ask kicks in', async () => {
  const mw = structuredOutputRepair({ strategies: ['json-fix', 're-ask'], maxLlmRetries: 1 });
  let call = 0;
  await mw(ctxWithFormat(INVOICE_SCHEMA), async () => {
    call++;
    if (call === 1) return { text: 'literally no JSON here at all' };
    return { text: '{"invoice_number":"INV-A","amount":1}' };
  });
  assert.equal(call, 2);
  assert.equal(mw.stats.byStrategy['json-fix'], 0);
  assert.equal(mw.stats.byStrategy['re-ask'], 1);
});

// ---- Custom strategy ------------------------------------------------

test('structuredOutputRepair: custom strategy runs', async () => {
  const mw = structuredOutputRepair({
    strategies: [{
      name: 'upper-caser',
      apply: (raw, { errors }) => {
        // Fake repair: return a hardcoded object regardless.
        return { invoice_number: 'FAKE', amount: 1 };
      },
    }],
  });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({ text: 'garbage' }));
  assert.equal(mw.stats.byStrategy['upper-caser'], 1);
  assert.deepEqual(r.parsed, { invoice_number: 'FAKE', amount: 1 });
});

test('structuredOutputRepair: custom strategy that throws is skipped', async () => {
  const mw = structuredOutputRepair({
    strategies: [
      { name: 'buggy', apply: () => { throw new Error('boom'); } },
      'json-fix',
    ],
  });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{"invoice_number":"INV-2","amount":9,}',
  }));
  assert.deepEqual(r.parsed, { invoice_number: 'INV-2', amount: 9 });
  assert.equal(mw.stats.byStrategy['json-fix'], 1);
});

// ---- Callbacks -------------------------------------------------

test('structuredOutputRepair: onRepair + onSuccess fire on repair', async () => {
  const events = [];
  const mw = structuredOutputRepair({
    strategies: ['json-fix'],
    onRepair:  (i) => events.push(['repair', i.strategy]),
    onSuccess: (i) => events.push(['success', i.strategy, i.attempts]),
  });
  await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{invoice_number:"X",amount:1}',   // needs json-fix (unquoted key)
  }));
  assert.deepEqual(events, [
    ['repair', 'json-fix'],
    ['success', 'json-fix', 1],
  ]);
});

test('structuredOutputRepair: onSuccess only on first-try valid', async () => {
  const events = [];
  const mw = structuredOutputRepair({
    onSuccess: (i) => events.push(i),
  });
  await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{"invoice_number":"X","amount":1}',
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].strategy, null);
  assert.equal(events[0].attempts, 1);
});

test('structuredOutputRepair: onGiveUp fires when all strategies exhausted', async () => {
  const events = [];
  const mw = structuredOutputRepair({
    strategies: ['json-fix'],
    onGiveUp: (i) => events.push(i),
  });
  await assert.rejects(
    mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({ text: 'nope nope nope' })),
    StructuredOutputInvalidError,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].strategiesTried, ['json-fix']);
});

test('structuredOutputRepair: callback throws are swallowed', async () => {
  const mw = structuredOutputRepair({
    strategies: ['json-fix'],
    onRepair: () => { throw new Error('x'); },
    onSuccess: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({
    text: '{invoice_number:"X",amount:1}',
  }));
  assert.ok(r.parsed);
});

// ---- Reset + MCP -------------------------------------------------

test('structuredOutputRepair: reset clears counters', async () => {
  const mw = structuredOutputRepair({ strategies: ['json-fix'] });
  await mw(ctxWithFormat(INVOICE_SCHEMA), async () => ({ text: '{invoice_number:"X",amount:1}' }));
  assert.equal(mw.stats.repaired, 1);
  mw.reset();
  assert.equal(mw.stats.repaired, 0);
  assert.equal(mw.stats.byStrategy['json-fix'], 0);
});

test('structuredOutputRepair: asMcpResource', () => {
  const mw = structuredOutputRepair({
    strategies: ['json-fix', 're-ask'],
    schema: INVOICE_SCHEMA,
    maxLlmRetries: 2,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://structured-output-repair');
  const p = r.handler();
  assert.deepEqual(p.strategies, ['json-fix', 're-ask']);
  assert.equal(p.maxLlmRetries, 2);
  assert.equal(p.hasStaticSchema, true);
});

test('structuredOutputRepair: BUILT_IN_STRATEGIES is frozen', () => {
  assert.ok(Object.isFrozen(BUILT_IN_STRATEGIES));
  assert.deepEqual([...BUILT_IN_STRATEGIES].sort(), ['json-fix', 're-ask']);
});

// ---- Schema from ctx dynamically --------------------------------

test('structuredOutputRepair: schemaFrom callback picks per-request', async () => {
  const mw = structuredOutputRepair({
    schemaFrom: (ctx) => ctx.request.mySchema,
    strategies: ['json-fix'],
  });
  const r = await mw({ request: { mySchema: INVOICE_SCHEMA } },
                     async () => ({ text: '{invoice_number:"X",amount:1}' }));
  assert.deepEqual(r.parsed, { invoice_number: 'X', amount: 1 });
});
