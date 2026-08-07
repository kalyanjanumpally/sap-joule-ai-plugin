// Sample tests using testing.fakeLLM (cds-plugin-llm 1.68.0).
//
// Demonstrates network-free unit tests of LLM-backed logic. Each test
// wires the middleware stack around a scripted LLMService and asserts
// on the actual response OR the middleware behavior (breaker opens,
// bulkhead rejects, etc.).
//
// Run: `npm test`

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  testing,
  circuitBreaker,
  bulkhead,
  autoRetry,
} = require('@saptarishi/cds-plugin-llm');

// ---- Basic scripted response ----

test('fakeLLM: matches by regex and returns scripted response', async () => {
  const fake = testing.fakeLLM({
    scripts: [
      {
        when: { method: 'chat', matches: /purchase order/i },
        respond: {
          text: 'PO-4823: Acme Steel, 5000 units. Delivery Rotterdam 2026-09-15.',
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      },
    ],
    defaultResponse: { text: 'fallback' },
  });
  const res = await fake.chat({
    messages: [{ role: 'user', content: 'summarize purchase order PO-4823' }],
  });
  assert.match(res.text, /Acme Steel/);
  assert.equal(res.usage.output_tokens, 20);
});

// ---- Full middleware chain around a fake ----

test('breaker + bulkhead around fakeLLM: circuit opens after N failures', async () => {
  const fake = testing.fakeLLM({
    failRate: 1.0,
    failWith: () => Object.assign(new Error('sim'), { status: 500 }),
  });
  const breaker = circuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const bh = bulkhead({ maxConcurrent: 10 });
  fake.use(breaker);
  fake.use(bh);

  await fake.chat({ messages: [{ role: 'user', content: 'a' }] }).catch(() => {});
  await fake.chat({ messages: [{ role: 'user', content: 'b' }] }).catch(() => {});

  // Third call: circuit open, short-circuits
  await assert.rejects(
    fake.chat({ messages: [{ role: 'user', content: 'c' }] }),
    /CIRCUIT_OPEN|circuit is OPEN/,
  );
  assert.equal(breaker.stats.opens, 1);
});

// ---- autoRetry recovery via fakeLLM ----

test('autoRetry recovers when fakeLLM eventually succeeds', async () => {
  let call = 0;
  const fake = testing.fakeLLM({
    scripts: [{
      when: () => true,
      respond: () => {
        call++;
        if (call < 3) throw Object.assign(new Error('rate limit'), {
          code: 'BULKHEAD_FULL', retriable: true,
        });
        return { text: 'succeeded on attempt 3' };
      },
    }],
  });
  const chat = autoRetry(fake.chat.bind(fake), { maxAttempts: 5, backoffMs: 1, jitterMs: 0 });
  const res = await chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.text, 'succeeded on attempt 3');
  assert.equal(call, 3);
});

// ---- Call history introspection ----

test('fakeLLM: call history captures every request + response', async () => {
  const fake = testing.fakeLLM({ defaultResponse: { text: 'ok' } });
  await fake.chat({ messages: [{ role: 'user', content: 'first' }] });
  await fake.chat({ messages: [{ role: 'user', content: 'second' }] });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].request.messages[0].content, 'first');
  assert.equal(fake.calls[1].response.text, 'ok');
  const chats = fake.callsMatching((c) => c.method === 'chat');
  assert.equal(chats.length, 2);
});
