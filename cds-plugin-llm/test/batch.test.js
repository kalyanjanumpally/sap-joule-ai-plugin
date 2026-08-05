const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so LLMService loads without the real package.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_batch__';
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
const AnthropicLLMService = require('../lib/providers/anthropic');
const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');

// ---- LLMService base — argument validation ----------------------------

test('LLMService.batch: rejects missing / empty requests', async () => {
  class Bare extends LLMService {}
  const svc = new Bare('llm', null, { modelId: 'x' });
  await svc.init();
  await assert.rejects(() => svc.batch({}), /requests/);
  await assert.rejects(() => svc.batch({ requests: [] }), /requests/);
});

test('LLMService.batch: rejects requests without customId', async () => {
  class Bare extends LLMService {}
  const svc = new Bare('llm', null, { modelId: 'x' });
  await svc.init();
  await assert.rejects(
    () => svc.batch({ requests: [{ messages: [{ role: 'user', content: 'hi' }] }] }),
    /customId/,
  );
});

test('LLMService.batch: rejects requests without messages', async () => {
  class Bare extends LLMService {}
  const svc = new Bare('llm', null, { modelId: 'x' });
  await svc.init();
  await assert.rejects(
    () => svc.batch({ requests: [{ customId: 'a' }] }),
    /messages/,
  );
});

test('LLMService.getBatch: rejects non-string id', async () => {
  class Bare extends LLMService {}
  const svc = new Bare('llm', null, { modelId: 'x' });
  await svc.init();
  await assert.rejects(() => svc.getBatch(''), /non-empty string id/);
  await assert.rejects(() => svc.getBatch(null), /non-empty string id/);
});

test('LLMService.batch: default provider throws a helpful "not supported" error', async () => {
  class Bare extends LLMService {}
  const svc = new Bare('llm', null, { modelId: 'x' });
  await svc.init();
  await assert.rejects(
    () => svc.batch({ requests: [{ customId: 'a', messages: [{ role: 'user', content: 'hi' }] }] }),
    /does not support batch/,
  );
});

// ---- Anthropic Message Batches -----------------------------------------

// Anthropic ships as ESM and is loaded via `await import(...)` inside
// AnthropicLLMService.init(), which bypasses `require.cache`. So we do the
// simpler thing: init the service (which builds a real Anthropic client),
// then REPLACE svc.client with our stub before the batch method runs.
async function makeAnthropicSvcWithClient(batchesStub) {
  const svc = new AnthropicLLMService('llm', null, {
    modelId: 'claude-opus-4-7',
    credentials: { apiKey: 'sk-ant-fake-for-init-only' },
  });
  await svc.init();
  svc.client = { messages: { batches: batchesStub } };
  return svc;
}

test('Anthropic batch: submit translates unified requests to Message Batches shape', async () => {
  let capturedBody;
  const svc = await makeAnthropicSvcWithClient({
    create: async (body) => { capturedBody = body; return {
      id: 'msgbatch_test',
      processing_status: 'in_progress',
      request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      created_at: '2026-08-05T10:00:00Z',
    }; },
  });
  const handle = await svc.batch({
    requests: [
      { customId: 'a', system: 'be terse', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
      { customId: 'b', messages: [{ role: 'user', content: 'hello' }] },
    ],
  });
  assert.equal(capturedBody.requests.length, 2);
  assert.equal(capturedBody.requests[0].custom_id, 'a');
  assert.equal(capturedBody.requests[0].params.model, 'claude-opus-4-7');
  assert.equal(capturedBody.requests[0].params.max_tokens, 50);
  assert.equal(capturedBody.requests[0].params.system, 'be terse');
  assert.equal(capturedBody.requests[1].custom_id, 'b');
  assert.equal(handle.id, 'msgbatch_test');
  assert.equal(handle.provider, 'anthropic');
  assert.equal(handle.status, 'in_progress');
  assert.equal(handle.counts.processing, 2);
});

test('Anthropic batch: getBatch normalizes processing_status=ended → completed', async () => {
  const svc = await makeAnthropicSvcWithClient({
    retrieve: async (id) => ({
      id, processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 3, errored: 1, canceled: 0, expired: 0 },
      created_at: '2026-08-05T10:00:00Z', ended_at: '2026-08-05T10:15:00Z',
    }),
  });
  const status = await svc.getBatch('msgbatch_test');
  assert.equal(status.status, 'completed');
  assert.equal(status.counts.succeeded, 3);
  assert.equal(status.counts.errored, 1);
  assert.equal(status.endedAt, '2026-08-05T10:15:00Z');
});

test('Anthropic batch: getBatchResults returns unified BatchResult[] with succeeded + errored', async () => {
  const svc = await makeAnthropicSvcWithClient({
    retrieve: async () => ({
      id: 'x', processing_status: 'ended',
      request_counts: { succeeded: 1, errored: 1 },
    }),
    results: async () => (async function*() {
      yield {
        custom_id: 'a',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: 'ok' }],
            model: 'claude-opus-4-7', stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      };
      yield {
        custom_id: 'b',
        result: { type: 'errored', error: { message: 'invalid input' } },
      };
    })(),
  });
  const results = await svc.getBatchResults('x');
  assert.equal(results.length, 2);
  assert.equal(results[0].customId, 'a');
  assert.equal(results[0].text, 'ok');
  assert.equal(results[0].model, 'claude-opus-4-7');
  assert.equal(results[0].usage.input_tokens, 5);
  assert.equal(results[1].customId, 'b');
  assert.equal(results[1].error, 'invalid input');
  assert.equal(results[1].errorType, 'errored');
  assert.equal(results[1].text, undefined);
});

test('Anthropic batch: getBatchResults throws when the batch is still in progress', async () => {
  const svc = await makeAnthropicSvcWithClient({
    retrieve: async () => ({ id: 'x', processing_status: 'in_progress' }),
  });
  await assert.rejects(
    () => svc.getBatchResults('x'),
    /still in_progress/,
  );
});

test('Anthropic batch: cancelBatch normalizes the response', async () => {
  const svc = await makeAnthropicSvcWithClient({
    cancel: async (id) => ({
      id, processing_status: 'in_progress',
      request_counts: { processing: 1, canceled: 2 },
    }),
  });
  const s = await svc.cancelBatch('msgbatch_test');
  assert.equal(s.id, 'msgbatch_test');
  assert.equal(s.counts.canceled, 2);
});

// ---- OpenAI-compatible Batch API ---------------------------------------

function makeOpenAISvc(overrides = {}) {
  return new OpenAICompatibleLLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', ...overrides },
  });
}

test('OpenAI batch: submit uploads JSONL then creates batch pointing at file', async () => {
  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body });
    if (url.endsWith('/files')) {
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: 'file_abc123', object: 'file', purpose: 'batch' }),
        text: async () => '',
      };
    }
    if (url.endsWith('/batches')) {
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          id: 'batch_xyz', status: 'validating',
          input_file_id: 'file_abc123', created_at: 1725489000,
          request_counts: { total: 2, completed: 0, failed: 0 },
        }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const svc = makeOpenAISvc(); await svc.init();
    const handle = await svc.batch({
      requests: [
        { customId: 'a', messages: [{ role: 'user', content: 'hi' }] },
        { customId: 'b', messages: [{ role: 'user', content: 'hello' }] },
      ],
    });
    assert.equal(captured[0].url, 'https://api.openai.com/v1/files');
    assert.equal(captured[0].method, 'POST');
    assert.equal(captured[1].url, 'https://api.openai.com/v1/batches');
    const batchBody = JSON.parse(captured[1].body);
    assert.equal(batchBody.input_file_id, 'file_abc123');
    assert.equal(batchBody.endpoint, '/v1/chat/completions');
    assert.equal(batchBody.completion_window, '24h');
    assert.equal(handle.id, 'batch_xyz');
    assert.equal(handle.provider, 'openai');
    // validating → normalized to in_progress
    assert.equal(handle.status, 'in_progress');
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI batch: getBatch normalizes each upstream status', async () => {
  const originalFetch = globalThis.fetch;
  const svc = makeOpenAISvc(); await svc.init();
  const cases = [
    { upstream: 'validating', unified: 'in_progress' },
    { upstream: 'in_progress', unified: 'in_progress' },
    { upstream: 'finalizing', unified: 'in_progress' },
    { upstream: 'completed', unified: 'completed' },
    { upstream: 'failed', unified: 'failed' },
    { upstream: 'expired', unified: 'failed' },
    { upstream: 'cancelling', unified: 'canceled' },
    { upstream: 'cancelled', unified: 'canceled' },
  ];
  for (const c of cases) {
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ id: 'b', status: c.upstream, request_counts: {} }),
      text: async () => '',
    });
    const status = await svc.getBatch('b');
    assert.equal(status.status, c.unified, `${c.upstream} should map to ${c.unified}`);
  }
  globalThis.fetch = originalFetch;
});

test('OpenAI batch: getBatchResults throws when status is not completed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ id: 'b', status: 'in_progress', request_counts: {} }),
    text: async () => '',
  });
  try {
    const svc = makeOpenAISvc(); await svc.init();
    await assert.rejects(() => svc.getBatchResults('b'), /still in_progress/);
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI batch: getBatchResults parses the output JSONL', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/batches/b')) {
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          id: 'b', status: 'completed', output_file_id: 'file_out', request_counts: { total: 2, completed: 1, failed: 1 },
        }),
        text: async () => '',
      };
    }
    if (url.endsWith('/files/file_out/content')) {
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => [
          JSON.stringify({ custom_id: 'a', response: { body: {
            model: 'gpt-4o',
            choices: [{ message: { content: 'answer a' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          } } }),
          JSON.stringify({ custom_id: 'b', error: { message: 'bad request' } }),
        ].join('\n'),
        json: async () => null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const svc = makeOpenAISvc(); await svc.init();
    const results = await svc.getBatchResults('b');
    assert.equal(results.length, 2);
    assert.equal(results[0].customId, 'a');
    assert.equal(results[0].text, 'answer a');
    assert.equal(results[0].model, 'gpt-4o');
    assert.equal(results[0].usage.input_tokens, 3);
    assert.equal(results[0].usage.output_tokens, 2);
    assert.equal(results[1].customId, 'b');
    assert.equal(results[1].error, 'bad request');
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI batch: cancelBatch posts to /batches/{id}/cancel', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl;
  globalThis.fetch = async (url, opts) => {
    calledUrl = url;
    assert.equal(opts.method, 'POST');
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ id: 'b', status: 'cancelling', request_counts: {} }),
      text: async () => '',
    };
  };
  try {
    const svc = makeOpenAISvc(); await svc.init();
    const s = await svc.cancelBatch('b');
    assert.equal(calledUrl, 'https://api.openai.com/v1/batches/b/cancel');
    assert.equal(s.status, 'canceled');
  } finally { globalThis.fetch = originalFetch; }
});
