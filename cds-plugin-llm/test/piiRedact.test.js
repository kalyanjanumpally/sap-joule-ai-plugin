const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pii__';
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
  piiRedact,
  luhnValid,
  BUILT_IN_DETECTORS,
  makeRedactor,
  redactMessages,
} = require('../lib/middleware/piiRedact');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

function invoke(mw, {
  method = 'chat',
  request = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
  meta = {},
  next = async () => ({ text: 'ok' }),
} = {}) {
  const ctx = { method, request, raw: request, meta };
  return { ctx, promise: mw(ctx, next) };
}

// ---- luhnValid --------------------------------------------------------

test('luhnValid: passes valid card numbers', () => {
  assert.equal(luhnValid('4242424242424242'), true);   // Visa test
  assert.equal(luhnValid('5555555555554444'), true);   // Mastercard test
});
test('luhnValid: rejects invalid card numbers', () => {
  assert.equal(luhnValid('4242424242424241'), false);
  assert.equal(luhnValid('1234567890123456'), false);
});
test('luhnValid: rejects non-digits', () => {
  assert.equal(luhnValid('42-42'), false);
  assert.equal(luhnValid(''), false);
});

// ---- Detector patterns ------------------------------------------------

test('BUILT_IN.email pattern: catches typical addresses', () => {
  const text = 'contact alice@example.com or bob.smith+work@sub.example.co.uk';
  const matches = text.match(BUILT_IN_DETECTORS.email.pattern);
  assert.deepEqual(matches, ['alice@example.com', 'bob.smith+work@sub.example.co.uk']);
});
test('BUILT_IN.ssn pattern: catches valid SSN, rejects invalid area codes', () => {
  const text = 'valid 123-45-6789 invalid 000-12-3456 also invalid 666-45-6789';
  const matches = text.match(BUILT_IN_DETECTORS.ssn.pattern);
  assert.deepEqual(matches, ['123-45-6789']);
});
test('BUILT_IN.iban pattern: catches DE + FR + GB IBANs', () => {
  const text = 'wire to DE89370400440532013000 or GB33BUKB20201555555555';
  const matches = text.match(BUILT_IN_DETECTORS.iban.pattern);
  assert.equal(matches.length, 2);
});
test('BUILT_IN.creditCard pattern: catches formatted + unformatted, Luhn filters', () => {
  const text = 'valid 4242 4242 4242 4242, invalid 1234-5678-9012-3456';
  // pattern matches both, validate filters invalid.
  const raw = text.match(BUILT_IN_DETECTORS.creditCard.pattern);
  assert.equal(raw.length, 2);
  assert.equal(BUILT_IN_DETECTORS.creditCard.validate(raw[0]), true);
  assert.equal(BUILT_IN_DETECTORS.creditCard.validate(raw[1]), false);
});
test('BUILT_IN.phone pattern: 10+ digits required (validate filters short IDs)', () => {
  const validator = BUILT_IN_DETECTORS.phone.validate;
  assert.equal(validator('+1 415 555 1234'), true);
  assert.equal(validator('(415) 555-1234'), true);
  assert.equal(validator('4155551234'), true);
  assert.equal(validator('555-1234'), false);            // only 7 digits
  assert.equal(validator('123456789012345678'), false);  // too long
});

// ---- makeRedactor -----------------------------------------------------

test('makeRedactor: same original → same token', () => {
  const r = makeRedactor(
    { email: BUILT_IN_DETECTORS.email },
    (t, i) => `<${t}_${i}>`,
  );
  const out = r.redactString('call alice@x.com or alice@x.com');
  assert.equal(out, 'call <email_1> or <email_1>');
  assert.equal(r.mapSize, 1);
});
test('makeRedactor: different originals → distinct tokens', () => {
  const r = makeRedactor(
    { email: BUILT_IN_DETECTORS.email },
    (t, i) => `<${t}_${i}>`,
  );
  const out = r.redactString('alice@x.com then bob@y.com');
  assert.equal(out, '<email_1> then <email_2>');
});
test('makeRedactor: unmask reverses tokens', () => {
  const r = makeRedactor(
    { email: BUILT_IN_DETECTORS.email },
    (t, i) => `<${t}_${i}>`,
  );
  r.redactString('alice@x.com and bob@y.com');
  const back = r.unmask('reply to <email_1>; cc <email_2>');
  assert.equal(back, 'reply to alice@x.com; cc bob@y.com');
});
test('makeRedactor: unmask handles overlapping token lengths', () => {
  const r = makeRedactor(
    { email: BUILT_IN_DETECTORS.email },
    (t, i) => `<${t}_${i}>`,
  );
  // Create 10+ tokens so <email_1> is a substring of <email_10>.
  for (let i = 0; i < 12; i++) r.redactString(`user${i}@x.com`);
  const back = r.unmask('email <email_10> and <email_1>');
  assert.equal(back, 'email user9@x.com and user0@x.com');
});
test('makeRedactor: unmask no-op when nothing was redacted', () => {
  const r = makeRedactor({}, (t, i) => `<${t}_${i}>`);
  assert.equal(r.unmask('nothing here'), 'nothing here');
});

// ---- redactMessages ---------------------------------------------------

test('redactMessages: string content path', () => {
  const r = makeRedactor(
    { email: BUILT_IN_DETECTORS.email },
    (t, i) => `<${t}_${i}>`,
  );
  const out = redactMessages(
    [{ role: 'user', content: 'email alice@x.com' }],
    r,
  );
  assert.equal(out[0].content, 'email <email_1>');
});
test('redactMessages: array content path (text blocks only)', () => {
  const r = makeRedactor(
    { email: BUILT_IN_DETECTORS.email },
    (t, i) => `<${t}_${i}>`,
  );
  const out = redactMessages(
    [{
      role: 'user',
      content: [
        { type: 'text', text: 'email alice@x.com' },
        { type: 'image', source: { type: 'base64' } },
      ],
    }],
    r,
  );
  assert.equal(out[0].content[0].text, 'email <email_1>');
  assert.equal(out[0].content[1].type, 'image');
});

// ---- Input validation -------------------------------------------------

test('piiRedact: throws on non-array detectors', () => {
  assert.throws(() => piiRedact({ detectors: 'email' }), /detectors must be an array/);
});
test('piiRedact: throws on unknown detector name', () => {
  assert.throws(() => piiRedact({ detectors: ['bogus'] }), /unknown built-in detector/);
});
test('piiRedact: throws on non-function tokenFor', () => {
  assert.throws(() => piiRedact({ tokenFor: 'not-fn' }), /tokenFor must be a function/);
});
test('piiRedact: throws on custom detector missing pattern', () => {
  assert.throws(
    () => piiRedact({ customDetectors: { foo: {} } }),
    /must have \{ pattern: RegExp \}/,
  );
});
test('piiRedact: throws on custom detector pattern missing g flag', () => {
  assert.throws(
    () => piiRedact({ customDetectors: { foo: { pattern: /x/ } } }),
    /must have the 'g' flag/,
  );
});

// ---- End-to-end request redaction --------------------------------------

test('piiRedact: redacts email in string content, un-masks response', async () => {
  const pii = piiRedact();
  const original = { model: 'm', messages: [{ role: 'user', content: 'email alice@x.com' }] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let seenRequest;
  const result = await pii(ctx, async () => {
    seenRequest = JSON.parse(JSON.stringify(ctx.request));
    return { text: 'ack from <PII_EMAIL_1>' };
  });
  assert.equal(seenRequest.messages[0].content, 'email <PII_EMAIL_1>');
  assert.equal(ctx.request.messages[0].content, 'email alice@x.com');
  assert.equal(result.text, 'ack from alice@x.com');
  assert.equal(pii.stats.requestsWithPii, 1);
  assert.equal(pii.stats.tokensReplaced, 1);
  assert.equal(pii.stats.responsesUnmasked, 1);
  assert.equal(pii.stats.byType.email, 1);
});

test('piiRedact: passes through when no PII detected', async () => {
  const pii = piiRedact();
  const next = async () => ({ text: 'ok' });
  const { ctx, promise } = invoke(pii, {
    request: { model: 'm', messages: [{ role: 'user', content: 'nothing sensitive here' }] },
    next,
  });
  await promise;
  assert.equal(pii.stats.requestsWithPii, 0);
  assert.equal(pii.stats.tokensReplaced, 0);
  assert.equal(pii.stats.totalRequests, 1);
});

test('piiRedact: redacts system field', async () => {
  const pii = piiRedact();
  const original = {
    model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    system: 'oncall is bob@company.com',
  };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let seen;
  await pii(ctx, async () => {
    seen = JSON.parse(JSON.stringify(ctx.request));
    return { text: 'ok' };
  });
  assert.match(seen.system, /oncall is <PII_EMAIL_1>/);
});

test('piiRedact: multiple detectors + all types counted', async () => {
  const pii = piiRedact();
  const next = async () => ({ text: 'ok' });
  const { promise } = invoke(pii, {
    request: {
      model: 'm',
      messages: [{
        role: 'user',
        content: 'card 4242 4242 4242 4242, ssn 123-45-6789, iban DE89370400440532013000, email a@b.co, phone +1 415 555 1234',
      }],
    },
    next,
  });
  await promise;
  assert.equal(pii.stats.byType.email, 1);
  assert.equal(pii.stats.byType.ssn, 1);
  assert.equal(pii.stats.byType.creditCard, 1);
  assert.equal(pii.stats.byType.iban, 1);
  assert.equal(pii.stats.byType.phone, 1);
});

test('piiRedact: selective detectors', async () => {
  const pii = piiRedact({ detectors: ['email'] });
  const next = async () => ({ text: 'ok' });
  const { ctx, promise } = invoke(pii, {
    request: {
      model: 'm',
      messages: [{ role: 'user', content: 'email a@b.co ssn 123-45-6789' }],
    },
    next: async () => { return next(); },
  });
  await promise;
  assert.equal(pii.stats.byType.email, 1);
  assert.equal(pii.stats.byType.ssn, undefined);
});

test('piiRedact: custom detector', async () => {
  const pii = piiRedact({
    detectors: [],
    customDetectors: { empId: { pattern: /EMP\d{6}/g } },
  });
  const next = async () => ({ text: 'ok EMP123456 handled' });
  const { promise } = invoke(pii, {
    request: { model: 'm', messages: [{ role: 'user', content: 'check EMP123456' }] },
    next,
  });
  const res = await promise;
  assert.equal(pii.stats.byType.empId, 1);
  assert.equal(res.text, 'ok EMP123456 handled');   // un-masked
});

test('piiRedact: custom tokenFor', async () => {
  const pii = piiRedact({ tokenFor: (type, i) => `[[${type}#${i}]]` });
  const original = { model: 'm', messages: [{ role: 'user', content: 'a@b.co' }] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let seen;
  await pii(ctx, async () => {
    seen = JSON.parse(JSON.stringify(ctx.request));
    return { text: 'ok' };
  });
  assert.equal(seen.messages[0].content, '[[email#1]]');
});

test('piiRedact: unmaskResponse:false leaves tokens', async () => {
  const pii = piiRedact({ unmaskResponse: false });
  const next = async () => ({ text: 'ack <PII_EMAIL_1>' });
  const { promise } = invoke(pii, {
    request: { model: 'm', messages: [{ role: 'user', content: 'a@b.co' }] },
    next,
  });
  const res = await promise;
  assert.equal(res.text, 'ack <PII_EMAIL_1>');   // NOT un-masked
  assert.equal(pii.stats.responsesUnmasked, 0);
});

test('piiRedact: same PII appears twice → single token', async () => {
  const pii = piiRedact();
  const original = {
    model: 'm',
    messages: [{ role: 'user', content: 'email alice@x.com and alice@x.com again' }],
  };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let seen;
  await pii(ctx, async () => {
    seen = JSON.parse(JSON.stringify(ctx.request));
    return { text: 'ok' };
  });
  const content = seen.messages[0].content;
  const matches = content.match(/PII_EMAIL_\d+/g);
  assert.equal(matches.length, 2);
  assert.equal(matches[0], matches[1]);
  assert.equal(pii.stats.tokensReplaced, 1);
});

test('piiRedact: restores ctx.request even on error', async () => {
  const pii = piiRedact();
  const original = { model: 'm', messages: [{ role: 'user', content: 'a@b.co' }] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  await assert.rejects(
    pii(ctx, async () => { throw new Error('provider down'); }),
    /provider down/,
  );
  assert.equal(ctx.request, original);
});

test('piiRedact: array-content path', async () => {
  const pii = piiRedact();
  const original = {
    model: 'm',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'email is a@b.co' },
        { type: 'image', source: { type: 'base64', data: '...' } },
      ],
    }],
  };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let seen;
  await pii(ctx, async () => {
    seen = JSON.parse(JSON.stringify(ctx.request));
    return { text: 'ok' };
  });
  assert.equal(seen.messages[0].content[0].text, 'email is <PII_EMAIL_1>');
  assert.equal(seen.messages[0].content[1].type, 'image');
});

// ---- Streams -----------------------------------------------------------

test('piiRedact: streams — request redacted, response NOT un-masked', async () => {
  const pii = piiRedact();
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'ack <PII_EMAIL_1>' };
    yield { type: 'done', text: 'ack <PII_EMAIL_1>' };
  }());
  const original = { model: 'm', messages: [{ role: 'user', content: 'a@b.co' }] };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let seen;
  const result = await pii(ctx, async () => {
    seen = JSON.parse(JSON.stringify(ctx.request));
    return stream;
  });
  assert.equal(seen.messages[0].content, '<PII_EMAIL_1>');
  assert.equal(result, stream);
  assert.equal(pii.stats.streamsSkipped, 1);
  assert.equal(pii.stats.responsesUnmasked, 0);
});

// ---- MCP + reset ------------------------------------------------------

test('piiRedact: asMcpResource', () => {
  const pii = piiRedact({ detectors: ['email', 'phone'] });
  const r = pii.asMcpResource();
  assert.equal(r.uri, 'config://pii-redact');
  const payload = r.handler();
  assert.deepEqual(payload.detectors, ['email', 'phone']);
  assert.equal(payload.unmaskResponse, true);
});

test('piiRedact: reset() zeroes stats', async () => {
  const pii = piiRedact();
  await invoke(pii, {
    request: { model: 'm', messages: [{ role: 'user', content: 'a@b.co' }] },
    next: async () => ({ text: 'ok' }),
  }).promise;
  assert.equal(pii.stats.requestsWithPii, 1);
  pii.reset();
  assert.equal(pii.stats.requestsWithPii, 0);
  assert.equal(pii.stats.tokensReplaced, 0);
  assert.deepEqual(pii.stats.byType, {});
});
