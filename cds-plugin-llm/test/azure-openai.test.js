const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_azure__';
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

const AzureOpenAILLMService = require('../lib/providers/azure-openai');

function makeSvc(credsOverrides = {}) {
  return new AzureOpenAILLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: {
      endpoint: 'https://my-aoai.openai.azure.com',
      apiKey: 'azure-key-123',
      deployment: 'my-gpt4o',
      embeddingDeployment: 'my-embed-3-small',
      apiVersion: '2024-10-21',
      ...credsOverrides,
    },
  });
}

test('AzureOpenAI: init requires endpoint + apiKey + deployment', async () => {
  const svc = new AzureOpenAILLMService('llm', null, { modelId: 'gpt-4o', credentials: {} });
  await assert.rejects(() => svc.init(), /endpoint.*apiKey.*deployment/s);
});

test('AzureOpenAI: init defaults embeddingDeployment to deployment when not set', async () => {
  const svc = new AzureOpenAILLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: {
      endpoint: 'https://x.openai.azure.com',
      apiKey: 'k', deployment: 'my-gpt4o',
    },
  });
  await svc.init();
  assert.equal(svc.embeddingDeployment, 'my-gpt4o');
});

test('AzureOpenAI: init defaults apiVersion when not set', async () => {
  const svc = new AzureOpenAILLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: { endpoint: 'https://x.openai.azure.com', apiKey: 'k', deployment: 'd' },
  });
  await svc.init();
  assert.match(svc.apiVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('AzureOpenAI: init strips trailing slash on endpoint', async () => {
  const svc = new AzureOpenAILLMService('llm', null, {
    modelId: 'gpt-4o',
    credentials: {
      endpoint: 'https://x.openai.azure.com/',
      apiKey: 'k', deployment: 'd',
    },
  });
  await svc.init();
  assert.equal(svc.endpoint, 'https://x.openai.azure.com');
});

test('AzureOpenAI: _endpoint builds per-deployment URL with api-version', async () => {
  const svc = makeSvc();
  await svc.init();
  assert.equal(
    svc._endpoint(),
    'https://my-aoai.openai.azure.com/openai/deployments/my-gpt4o/chat/completions?api-version=2024-10-21',
  );
});

test('AzureOpenAI: _embedEndpoint uses embeddingDeployment', async () => {
  const svc = makeSvc();
  await svc.init();
  assert.equal(
    svc._embedEndpoint(),
    'https://my-aoai.openai.azure.com/openai/deployments/my-embed-3-small/embeddings?api-version=2024-10-21',
  );
});

test('AzureOpenAI: _headers uses api-key not Bearer', async () => {
  const svc = makeSvc();
  await svc.init();
  const headers = await svc._headers();
  assert.equal(headers['api-key'], 'azure-key-123');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['content-type'], 'application/json');
});

test('AzureOpenAI: chat POSTs to per-deployment URL with api-key header', async () => {
  const captured = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.url = url;
    captured.headers = opts.headers;
    captured.body = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: 'hello', role: 'assistant' }, finish_reason: 'stop' }],
        model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      text: async () => '',
    };
  };
  try {
    const svc = makeSvc();
    await svc.init();
    const res = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.text, 'hello');
    assert.match(captured.url, /\/openai\/deployments\/my-gpt4o\/chat\/completions\?api-version=2024-10-21$/);
    assert.equal(captured.headers['api-key'], 'azure-key-123');
    assert.equal(captured.headers.authorization, undefined);
    assert.equal(captured.body.messages[0].content, 'hi');
  } finally { globalThis.fetch = originalFetch; }
});

test('AzureOpenAI: embed POSTs to per-embedding-deployment URL', async () => {
  const captured = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.url = url;
    captured.headers = opts.headers;
    return {
      ok: true, status: 200,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        model: 'text-embedding-3-small',
      }),
      text: async () => '',
    };
  };
  try {
    const svc = makeSvc();
    await svc.init();
    const res = await svc.embed({ input: ['hello', 'world'] });
    assert.equal(res.embeddings.length, 2);
    assert.deepEqual(res.embeddings[0], [0.1, 0.2, 0.3]);
    assert.match(captured.url, /\/openai\/deployments\/my-embed-3-small\/embeddings\?api-version=2024-10-21$/);
    assert.equal(captured.headers['api-key'], 'azure-key-123');
  } finally { globalThis.fetch = originalFetch; }
});

test('AzureOpenAI: custom apiVersion honored on both endpoints', async () => {
  const svc = makeSvc({ apiVersion: '2024-12-01-preview' });
  await svc.init();
  assert.ok(svc._endpoint().endsWith('?api-version=2024-12-01-preview'));
  assert.ok(svc._embedEndpoint().endsWith('?api-version=2024-12-01-preview'));
});

// ---- CLI providerFactory integration -------------------------------------

test('providerFactory: azure-openai kind builds AzureOpenAILLMService', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'azure-openai' },
    env: {
      AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
      AZURE_OPENAI_API_KEY: 'k',
      AZURE_OPENAI_DEPLOYMENT: 'my-deployment',
    },
  });
  assert.equal(kind, 'azure-openai');
  assert.equal(model, 'my-deployment'); // deployment IS the model on Azure
  assert.equal(provider.constructor.name, 'AzureOpenAILLMService');
  assert.equal(provider.options.credentials.endpoint, 'https://x.openai.azure.com');
});

test('providerFactory: azure-openai lists all missing env vars', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'azure-openai' }, env: {} }),
    /AZURE_OPENAI_ENDPOINT.*AZURE_OPENAI_API_KEY.*AZURE_OPENAI_DEPLOYMENT/s,
  );
});
