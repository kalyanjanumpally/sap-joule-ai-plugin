const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_sov__';
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
  structuredOutputValidator,
  StructuredOutputInvalidError,
  validateBuiltIn,
  extractFromText,
} = require('../lib/middleware/structuredOutputValidator');
const { LLMError } = require('../lib/errors');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

const InvoiceSchema = {
  type: 'object',
  properties: {
    vendor:   { type: 'string' },
    currency: { type: 'string', enum: ['EUR', 'USD', 'GBP'] },
    total:    { type: 'number' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount:      { type: 'number' },
        },
        required: ['description', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: ['vendor', 'currency', 'total'],
  additionalProperties: false,
};

const validInvoice = {
  vendor: 'Acme Corp',
  currency: 'EUR',
  total: 1234.56,
  lineItems: [{ description: 'Widget', amount: 100 }],
};

function invoke(mw, {
  method  = 'chat',
  request = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }], format: InvoiceSchema },
  meta    = {},
  next,
} = {}) {
  const ctx = { method, request, raw: request, meta };
  return { ctx, promise: mw(ctx, next) };
}

// ---- Input validation --------------------------------------------------

test('sov: throws on invalid onInvalid', () => {
  assert.throws(() => structuredOutputValidator({ onInvalid: 'nope' }), /onInvalid must be/);
});
test('sov: throws on negative maxRetries', () => {
  assert.throws(() => structuredOutputValidator({ maxRetries: -1 }), /maxRetries must be/);
});
test('sov: throws on non-function validate', () => {
  assert.throws(() => structuredOutputValidator({ validate: 'not-fn' }), /validate must be/);
});
test('sov: throws on non-function extractJson', () => {
  assert.throws(() => structuredOutputValidator({ extractJson: 'not-fn' }), /extractJson must be/);
});

// ---- Built-in validator --------------------------------------------------

test('sov.validateBuiltIn: passes valid invoice', () => {
  assert.deepEqual(validateBuiltIn(validInvoice, InvoiceSchema), []);
});
test('sov.validateBuiltIn: catches missing required field', () => {
  const errs = validateBuiltIn({ vendor: 'A', total: 10 }, InvoiceSchema);
  assert.ok(errs.some((e) => /missing required field "currency"/.test(e)));
});
test('sov.validateBuiltIn: catches type mismatch', () => {
  const errs = validateBuiltIn({ vendor: 'A', currency: 'EUR', total: 'not-a-number' }, InvoiceSchema);
  assert.ok(errs.some((e) => /\$\.total: expected type number but got string/.test(e)));
});
test('sov.validateBuiltIn: catches enum violation', () => {
  const errs = validateBuiltIn({ vendor: 'A', currency: 'BTC', total: 1 }, InvoiceSchema);
  assert.ok(errs.some((e) => /\$\.currency: value "BTC" not in enum/.test(e)));
});
test('sov.validateBuiltIn: catches additionalProperties', () => {
  const errs = validateBuiltIn(
    { vendor: 'A', currency: 'EUR', total: 1, malicious: 'field' },
    InvoiceSchema,
  );
  assert.ok(errs.some((e) => /unexpected additional property "malicious"/.test(e)));
});
test('sov.validateBuiltIn: descends into nested items', () => {
  const errs = validateBuiltIn(
    { vendor: 'A', currency: 'EUR', total: 1, lineItems: [{ description: 'x' }] },
    InvoiceSchema,
  );
  assert.ok(errs.some((e) => /lineItems\[0\]: missing required field "amount"/.test(e)));
});
test('sov.validateBuiltIn: integer satisfies number', () => {
  assert.deepEqual(validateBuiltIn(42, { type: 'number' }), []);
});
test('sov.validateBuiltIn: null distinct from object', () => {
  const errs = validateBuiltIn(null, { type: 'object' });
  assert.ok(errs.length > 0);
});

// ---- Extract JSON --------------------------------------------------------

test('sov.extractFromText: parses raw JSON', () => {
  assert.deepEqual(extractFromText('{"x":1}'), { x: 1 });
});
test('sov.extractFromText: extracts from code fence', () => {
  assert.deepEqual(extractFromText('Sure!\n```json\n{"x":2}\n```\nDone.'), { x: 2 });
});
test('sov.extractFromText: extracts from bare fence', () => {
  assert.deepEqual(extractFromText('```\n{"x":3}\n```'), { x: 3 });
});
test('sov.extractFromText: extracts first-brace-to-last-brace', () => {
  assert.deepEqual(extractFromText('Here is your answer: {"x":4} thanks!'), { x: 4 });
});
test('sov.extractFromText: extracts array', () => {
  assert.deepEqual(extractFromText('[1,2,3]'), [1, 2, 3]);
});
test('sov.extractFromText: returns null on garbage', () => {
  assert.equal(extractFromText('no json here at all'), null);
});
test('sov.extractFromText: returns null on empty', () => {
  assert.equal(extractFromText(''), null);
});

// ---- Skip when no schema --------------------------------------------------

test('sov: skips when no schema present', async () => {
  const sov = structuredOutputValidator();
  const next = async () => ({ text: 'anything' });
  const result = await invoke(sov, {
    request: { model: 'gpt-4o-mini' },
    next,
  }).promise;
  assert.equal(result.text, 'anything');
  assert.equal(sov.stats.skipped, 1);
  assert.equal(sov.stats.totalValidated, 0);
});

// ---- Happy path: valid response -----------------------------------------

test('sov: passes valid response + attaches result.parsed', async () => {
  const sov = structuredOutputValidator();
  const next = async () => ({ text: JSON.stringify(validInvoice) });
  const result = await invoke(sov, { next }).promise;
  assert.deepEqual(result.parsed, validInvoice);
  assert.equal(sov.stats.valid, 1);
  assert.equal(sov.stats.invalid, 0);
});

test('sov: prefers result.data over result.text', async () => {
  const sov = structuredOutputValidator();
  const next = async () => ({ data: validInvoice, text: 'ignored garbage' });
  const result = await invoke(sov, { next }).promise;
  assert.deepEqual(result.parsed, validInvoice);
});

test('sov: custom attachParsedAs field', async () => {
  const sov = structuredOutputValidator({ attachParsedAs: 'obj' });
  const next = async () => ({ text: JSON.stringify(validInvoice) });
  const result = await invoke(sov, { next }).promise;
  assert.deepEqual(result.obj, validInvoice);
  assert.equal(result.parsed, undefined);
});

// ---- Invalid: throw path -------------------------------------------------

test('sov: onInvalid=throw surfaces StructuredOutputInvalidError', async () => {
  const sov = structuredOutputValidator();
  const badInvoice = { vendor: 'A' /* missing currency + total */ };
  const next = async () => ({ text: JSON.stringify(badInvoice) });
  await assert.rejects(
    invoke(sov, { next }).promise,
    (err) => {
      assert.ok(err instanceof StructuredOutputInvalidError);
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'STRUCTURED_OUTPUT_INVALID');
      assert.equal(err.primitive, 'structuredOutputValidator');
      assert.equal(err.httpStatus, 502);
      assert.equal(err.retriable, false);
      assert.ok(err.errors.length > 0);
      assert.ok(err.rawText.includes('vendor'));
      assert.equal(err.attempts, 1);
      return true;
    },
  );
  assert.equal(sov.stats.invalid, 1);
});

test('sov: onInvalid=throw when response has no parseable JSON', async () => {
  const sov = structuredOutputValidator();
  const next = async () => ({ text: 'I refuse to output JSON.' });
  await assert.rejects(
    invoke(sov, { next }).promise,
    (err) => err.code === 'STRUCTURED_OUTPUT_INVALID'
      && err.errors.some((e) => /did not contain parseable JSON/.test(e)),
  );
});

// ---- Invalid: retry path -------------------------------------------------

test('sov: onInvalid=retry corrects and succeeds on 2nd attempt', async () => {
  const sov = structuredOutputValidator({ onInvalid: 'retry', maxRetries: 1 });
  const ctx = {
    method: 'chat',
    request: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }], format: InvoiceSchema },
    meta: {},
  };
  let callCount = 0;
  const seen = [];
  const next = async () => {
    seen.push(JSON.parse(JSON.stringify(ctx.request)));
    callCount++;
    if (callCount === 1) return { text: '{"vendor":"A"}' };
    return { text: JSON.stringify(validInvoice) };
  };
  const result = await sov(ctx, next);
  assert.equal(callCount, 2);
  assert.deepEqual(result.parsed, validInvoice);
  assert.equal(sov.stats.retries, 1);
  assert.equal(sov.stats.valid, 1);
  assert.equal(sov.stats.invalid, 1);
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[1].messages.length, 2);
  assert.match(seen[1].messages[1].content, /previous response could not be parsed/);
});

test('sov: onInvalid=retry throws after maxRetries exhausted', async () => {
  const sov = structuredOutputValidator({ onInvalid: 'retry', maxRetries: 2 });
  const next = async () => ({ text: '{"vendor":"A"}' });   // always invalid
  await assert.rejects(
    invoke(sov, { next }).promise,
    (err) => {
      assert.equal(err.code, 'STRUCTURED_OUTPUT_INVALID');
      assert.equal(err.attempts, 3);   // initial + 2 retries
      return true;
    },
  );
  assert.equal(sov.stats.retries, 2);
  assert.equal(sov.stats.retriesGivenUp, 1);
  assert.equal(sov.stats.invalid, 3);
});

test('sov: restores ctx.request after successful retry', async () => {
  const sov = structuredOutputValidator({ onInvalid: 'retry', maxRetries: 1 });
  let call = 0;
  const next = async () => (call++ === 0 ? { text: '{}' } : { text: JSON.stringify(validInvoice) });
  const { ctx, promise } = invoke(sov, { next });
  const originalMessages = ctx.request.messages;
  await promise;
  assert.equal(ctx.request.messages, originalMessages);
  assert.equal(ctx.request.messages.length, 1);
});

test('sov: restores ctx.request after retry-and-throw', async () => {
  const sov = structuredOutputValidator({ onInvalid: 'retry', maxRetries: 1 });
  const next = async () => ({ text: '{}' });
  const { ctx, promise } = invoke(sov, { next });
  const originalMessages = ctx.request.messages;
  await assert.rejects(promise);
  assert.equal(ctx.request.messages, originalMessages);
});

// ---- Custom hooks -------------------------------------------------------

test('sov: custom schemaFrom overrides format', async () => {
  const OtherSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
  const sov = structuredOutputValidator({ schemaFrom: () => OtherSchema });
  const next = async () => ({ text: '{"x": 1}' });
  const result = await invoke(sov, {
    request: { model: 'm', messages: [] },   // no format
    next,
  }).promise;
  assert.deepEqual(result.parsed, { x: 1 });
});

test('sov: static schema fallback when no per-request schema', async () => {
  const StaticSchema = { type: 'object', properties: { y: { type: 'string' } }, required: ['y'] };
  const sov = structuredOutputValidator({ schema: StaticSchema });
  const next = async () => ({ text: '{"y":"hi"}' });
  const result = await invoke(sov, {
    request: { model: 'm', messages: [] },
    next,
  }).promise;
  assert.deepEqual(result.parsed, { y: 'hi' });
});

test('sov: ctx.request.responseSchema also honored', async () => {
  const sov = structuredOutputValidator();
  const S = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
  const next = async () => ({ text: '{"a":42}' });
  const result = await invoke(sov, {
    request: { model: 'm', responseSchema: S, messages: [] },
    next,
  }).promise;
  assert.deepEqual(result.parsed, { a: 42 });
});

test('sov: custom validate function respected', async () => {
  const alwaysFail = () => ['nope: always fails'];
  const sov = structuredOutputValidator({ validate: alwaysFail });
  const next = async () => ({ text: JSON.stringify(validInvoice) });
  await assert.rejects(
    invoke(sov, { next }).promise,
    (err) => err.errors.includes('nope: always fails'),
  );
});

test('sov: custom extractJson respected', async () => {
  const sov = structuredOutputValidator({
    extractJson: (result) => result?.myCustomField,
  });
  const next = async () => ({ text: '', myCustomField: validInvoice });
  const result = await invoke(sov, { next }).promise;
  assert.deepEqual(result.parsed, validInvoice);
});

test('sov: custom buildCorrection used on retry', async () => {
  const sov = structuredOutputValidator({
    onInvalid: 'retry',
    maxRetries: 1,
    buildCorrection: () => 'PLEASE FIX YOUR OUTPUT',
  });
  const ctx = {
    method: 'chat',
    request: { model: 'm', messages: [{ role: 'user', content: 'go' }], format: InvoiceSchema },
    meta: {},
  };
  let call = 0;
  const captured = [];
  const next = async () => {
    captured.push(JSON.parse(JSON.stringify(ctx.request)));
    return call++ === 0 ? { text: '{}' } : { text: JSON.stringify(validInvoice) };
  };
  await sov(ctx, next);
  assert.equal(captured[1].messages[1].content, 'PLEASE FIX YOUR OUTPUT');
});

test('sov: custom applyCorrection can inject via system', async () => {
  const sov = structuredOutputValidator({
    onInvalid: 'retry',
    maxRetries: 1,
    applyCorrection: (req, correction) => ({ ...req, system: `${req.system ?? ''}\nFIX: ${correction}` }),
  });
  const ctx = {
    method: 'chat',
    request: {
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      system: 'orig sys',
      format: InvoiceSchema,
    },
    meta: {},
  };
  let call = 0;
  const captured = [];
  const next = async () => {
    captured.push(JSON.parse(JSON.stringify(ctx.request)));
    return call++ === 0 ? { text: '{}' } : { text: JSON.stringify(validInvoice) };
  };
  await sov(ctx, next);
  assert.equal(captured[0].system, 'orig sys');
  assert.match(captured[1].system, /orig sys\nFIX:/);
  assert.equal(captured[1].messages.length, 1);
});

// ---- Pluggable {ok,errors} validator shape ------------------------------

test('sov: accepts {ok:false, errors} shape from Ajv/Zod adapters', async () => {
  const adapter = () => ({ ok: false, errors: ['from-adapter'] });
  const sov = structuredOutputValidator({ validate: adapter });
  const next = async () => ({ text: JSON.stringify(validInvoice) });
  await assert.rejects(
    invoke(sov, { next }).promise,
    (err) => err.errors.includes('from-adapter'),
  );
});

// ---- Streams -----------------------------------------------------------

test('sov: stream + captureStreams:true validates on completion', async () => {
  const sov = structuredOutputValidator();
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: '{}' };
    yield { type: 'done', text: '{}' };
  }());
  const next = async () => stream;
  const result = await invoke(sov, { next }).promise;
  const chunks = [];
  for await (const c of result) chunks.push(c);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sov.stats.totalValidated, 1);
  assert.equal(sov.stats.invalid, 1);
  assert.equal(sov.stats.invalidStreams, 1);
});

test('sov: stream + captureStreams:false treats stream as non-JSON response', async () => {
  const sov = structuredOutputValidator({ captureStreams: false });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: '{}' };
  }());
  const next = async () => stream;
  // captureStreams:false takes the non-stream path, which will try to extract
  // JSON from the stream envelope (has no .text/.data) → invalid.
  await assert.rejects(
    invoke(sov, { next }).promise,
    (err) => err.code === 'STRUCTURED_OUTPUT_INVALID',
  );
});

test('sov: stream valid chunk counts as valid', async () => {
  const sov = structuredOutputValidator();
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: JSON.stringify(validInvoice) };
    yield { type: 'done', text: JSON.stringify(validInvoice) };
  }());
  const next = async () => stream;
  const result = await invoke(sov, { next }).promise;
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sov.stats.valid, 1);
  assert.equal(sov.stats.invalidStreams, 0);
});

// ---- MCP resource + introspection --------------------------------------

test('sov: asMcpResource exposes counters + config', () => {
  const sov = structuredOutputValidator({ onInvalid: 'retry', maxRetries: 2 });
  const r = sov.asMcpResource();
  assert.equal(r.uri, 'config://structured-output-validator');
  const payload = r.handler();
  assert.equal(payload.onInvalid, 'retry');
  assert.equal(payload.maxRetries, 2);
  assert.equal(payload.totalValidated, 0);
  assert.equal(payload.hasSchemaFrom, false);
});

test('sov: reset() zeroes counters', async () => {
  const sov = structuredOutputValidator();
  await invoke(sov, {
    next: async () => ({ text: JSON.stringify(validInvoice) }),
  }).promise;
  assert.equal(sov.stats.valid, 1);
  sov.reset();
  assert.equal(sov.stats.valid, 0);
  assert.equal(sov.stats.totalValidated, 0);
});

test('sov: does not overwrite pre-existing result.parsed', async () => {
  const sov = structuredOutputValidator();
  const preExisting = { pre: true };
  const next = async () => ({ text: JSON.stringify(validInvoice), parsed: preExisting });
  const result = await invoke(sov, { next }).promise;
  assert.equal(result.parsed, preExisting);
});
