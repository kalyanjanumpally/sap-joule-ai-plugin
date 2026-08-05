const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so tests run without installing it.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_newproviders__';
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

const FireworksLLMService = require('../lib/providers/fireworks');
const DeepSeekLLMService  = require('../lib/providers/deepseek');
const MistralLLMService   = require('../lib/providers/mistral');
const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');

// Each new provider is a light subclass of OpenAICompatibleLLMService with
// only its `init()` customized: baseUrl, apiKeyEnv, default modelId. Tests
// pin exactly those points.

for (const {
  Cls, kind, defaultBaseUrl, defaultModel, envKey, envSample, envFallbackKey,
} of [
  {
    Cls: FireworksLLMService, kind: 'fireworks',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    envKey: 'FIREWORKS_API_KEY', envSample: 'fw_sample',
  },
  {
    Cls: DeepSeekLLMService, kind: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY', envSample: 'ds_sample',
  },
  {
    Cls: MistralLLMService, kind: 'mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    envKey: 'MISTRAL_API_KEY', envSample: 'mi_sample',
  },
]) {
  test(`${kind}: extends OpenAICompatibleLLMService`, () => {
    const svc = new Cls('llm', null, { credentials: { apiKey: 'x' } });
    assert.ok(svc instanceof OpenAICompatibleLLMService);
  });

  test(`${kind}: default baseUrl is ${defaultBaseUrl}`, async () => {
    const svc = new Cls('llm', null, { credentials: { apiKey: 'x' } });
    await svc.init();
    assert.equal(svc.baseUrl, defaultBaseUrl);
  });

  test(`${kind}: default modelId is ${defaultModel}`, async () => {
    const svc = new Cls('llm', null, { credentials: { apiKey: 'x' } });
    await svc.init();
    assert.equal(svc.modelId, defaultModel);
  });

  test(`${kind}: caller-provided modelId wins over default`, async () => {
    const svc = new Cls('llm', null, {
      modelId: 'custom-model',
      credentials: { apiKey: 'x' },
    });
    await svc.init();
    assert.equal(svc.modelId, 'custom-model');
  });

  test(`${kind}: caller-provided baseUrl wins over default`, async () => {
    const svc = new Cls('llm', null, {
      credentials: { apiKey: 'x', baseUrl: 'https://proxy.example.com/v1' },
    });
    await svc.init();
    assert.equal(svc.baseUrl, 'https://proxy.example.com/v1');
  });

  test(`${kind}: picks up ${envKey} env when credentials.apiKey omitted`, async () => {
    const saved = process.env[envKey];
    process.env[envKey] = envSample;
    try {
      const svc = new Cls('llm', null, { credentials: {} });
      await svc.init();
      assert.equal(svc.apiKey, envSample);
    } finally {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    }
  });

  test(`${kind}: init throws when no apiKey anywhere`, async () => {
    const saved = process.env[envKey];
    delete process.env[envKey];
    try {
      const svc = new Cls('llm', null, { credentials: {} });
      await assert.rejects(() => svc.init(), new RegExp(envKey));
    } finally {
      if (saved !== undefined) process.env[envKey] = saved;
    }
  });

  test(`${kind}: chat POSTs to the default /chat/completions endpoint (Bearer auth)`, async () => {
    const captured = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      captured.url = url;
      captured.headers = opts.headers;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: 'hello', role: 'assistant' }, finish_reason: 'stop' }],
          model: 'the-model', usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        text: async () => '',
      };
    };
    try {
      const svc = new Cls('llm', null, { credentials: { apiKey: 'sk-test-abc' } });
      await svc.init();
      await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(captured.url, `${defaultBaseUrl}/chat/completions`);
      assert.equal(captured.headers['authorization'], 'Bearer sk-test-abc');
      assert.equal(captured.headers['content-type'], 'application/json');
    } finally { globalThis.fetch = originalFetch; }
  });
}

// ---- CLI providerFactory integration -----------------------------------

test('providerFactory: fireworks kind builds FireworksLLMService with FIREWORKS_API_KEY', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'fireworks' },
    env: { FIREWORKS_API_KEY: 'fw_env' },
  });
  assert.equal(kind, 'fireworks');
  assert.match(model, /^accounts\/fireworks\/models\//);
  assert.equal(provider.constructor.name, 'FireworksLLMService');
  assert.equal(provider.options.credentials.apiKey, 'fw_env');
});

test('providerFactory: fireworks throws with a helpful pointer when the key is missing', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'fireworks' }, env: {} }),
    /FIREWORKS_API_KEY.*fireworks\.ai/,
  );
});

test('providerFactory: deepseek kind builds DeepSeekLLMService with DEEPSEEK_API_KEY', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'deepseek' },
    env: { DEEPSEEK_API_KEY: 'ds_env' },
  });
  assert.equal(kind, 'deepseek');
  assert.equal(model, 'deepseek-chat');
  assert.equal(provider.constructor.name, 'DeepSeekLLMService');
});

test('providerFactory: mistral kind builds MistralLLMService with MISTRAL_API_KEY', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'mistral' },
    env: { MISTRAL_API_KEY: 'mi_env' },
  });
  assert.equal(kind, 'mistral');
  assert.equal(model, 'mistral-large-latest');
  assert.equal(provider.constructor.name, 'MistralLLMService');
});

test('providerFactory: --base-url on any new provider overrides the default', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider } = await buildProvider({
    opts: { provider: 'deepseek', 'base-url': 'https://proxy.example/v1' },
    env: { DEEPSEEK_API_KEY: 'x' },
  });
  assert.equal(provider.options.credentials.baseUrl, 'https://proxy.example/v1');
});

// ---- DEFAULT_PRICING sanity -------------------------------------------

test('DEFAULT_PRICING: covers the new providers\' default models', () => {
  const { DEFAULT_PRICING } = require('../lib/pricing');
  const shipped = [
    'accounts/fireworks/models/llama-v3p3-70b-instruct',
    'deepseek-chat',
    'deepseek-reasoner',
    'mistral-large-latest',
    'codestral-latest',
    'mistral-embed',
  ];
  for (const m of shipped) {
    assert.ok(DEFAULT_PRICING[m], `expected DEFAULT_PRICING entry for '${m}'`);
    assert.equal(typeof DEFAULT_PRICING[m].input, 'number');
    assert.equal(typeof DEFAULT_PRICING[m].output, 'number');
  }
});
