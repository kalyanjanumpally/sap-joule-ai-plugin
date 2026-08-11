const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_caps__';
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
  capabilities,
  PROVIDER_MATRIX,
  MODEL_OVERRIDES,
  detectFamily,
  detectModel,
  detectBatchOverride,
} = require('../lib/capabilities');

const LLMService = require('../lib/LLMService');

// ---- Helpers ------------------------------------------------------------

function fakeLLM({ kind = null, modelId = null, cname = null, batchOverride = false } = {}) {
  class Fake {
    constructor() {
      this.options = { kind, modelId };
      this.modelId = modelId;
    }
    async chat(req) { return { text: 'ok', model: modelId, usage: {} }; }
    async embed(req) { return { embeddings: [[1, 2]], model: modelId, usage: {} }; }
  }
  if (batchOverride) Fake.prototype._batchSubmit = async () => ({ id: 'x' });
  if (cname) Object.defineProperty(Fake, 'name', { value: cname });
  return new Fake();
}

// ---- Input validation ---------------------------------------------------

test('capabilities: throws on missing llm', async () => {
  await assert.rejects(() => capabilities(), /llm is required/);
  await assert.rejects(() => capabilities(null), /llm is required/);
});

// ---- Provider matrix ----------------------------------------------------

test('PROVIDER_MATRIX: covers every shipped provider', () => {
  const expected = [
    'anthropic', 'openai-compatible', 'azure-openai', 'groq',
    'deepseek', 'fireworks', 'mistral', 'gemini', 'bedrock',
    'ollama', 'genai-hub',
  ];
  for (const p of expected) {
    assert.ok(PROVIDER_MATRIX[p], `missing provider entry ${p}`);
    // Sanity check on required fields
    for (const f of ['chat', 'stream', 'embed', 'batch', 'vision', 'tools',
                     'structuredOutput', 'promptCache',
                     'maxContextTokens', 'maxOutputTokens']) {
      assert.ok(f in PROVIDER_MATRIX[p], `${p} missing ${f}`);
    }
  }
});

// ---- detectFamily -------------------------------------------------------

test('detectFamily: reads llm.options.kind (llm-anthropic prefix)', () => {
  const llm = fakeLLM({ kind: 'llm-anthropic' });
  assert.equal(detectFamily(llm), 'anthropic');
});
test('detectFamily: reads llm.options.kind (bare slug)', () => {
  const llm = fakeLLM({ kind: 'bedrock' });
  assert.equal(detectFamily(llm), 'bedrock');
});
test('detectFamily: falls back to constructor.name', () => {
  const llm = fakeLLM({ cname: 'MistralLLMService' });
  assert.equal(detectFamily(llm), 'mistral');
});
test('detectFamily: null on unknown', () => {
  const llm = fakeLLM({ cname: 'CustomFooLLM' });
  assert.equal(detectFamily(llm), null);
});
test('detectFamily: null on missing llm.options', () => {
  assert.equal(detectFamily({}), null);
});

// ---- detectModel --------------------------------------------------------

test('detectModel: reads llm.modelId', () => {
  const llm = fakeLLM({ modelId: 'claude-opus-4-7' });
  assert.equal(detectModel(llm), 'claude-opus-4-7');
});
test('detectModel: falls back to options.modelId', () => {
  const llm = { options: { modelId: 'gpt-4o' } };
  assert.equal(detectModel(llm), 'gpt-4o');
});
test('detectModel: falls back to options.model', () => {
  const llm = { options: { model: 'legacy-name' } };
  assert.equal(detectModel(llm), 'legacy-name');
});
test('detectModel: null when absent', () => {
  assert.equal(detectModel({}), null);
});

// ---- detectBatchOverride -----------------------------------------------

test('detectBatchOverride: base LLMService returns false', () => {
  class Base extends LLMService {}
  const llm = new Base('llm', null, { modelId: 'x' });
  assert.equal(detectBatchOverride(llm), false);
});
test('detectBatchOverride: subclass overriding _batchSubmit returns true', () => {
  class Base extends LLMService {}
  Base.prototype._batchSubmit = async () => ({ id: 'x' });
  const llm = new Base('llm', null, { modelId: 'x' });
  assert.equal(detectBatchOverride(llm), true);
});
test('detectBatchOverride: null llm returns false', () => {
  assert.equal(detectBatchOverride(null), false);
});

// ---- Static probe (default) ---------------------------------------------

test('capabilities: static probe for anthropic model', async () => {
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'claude-opus-4-7', batchOverride: true });
  const caps = await capabilities(llm);
  assert.equal(caps.provider, 'anthropic');
  assert.equal(caps.model, 'claude-opus-4-7');
  assert.equal(caps.chat, true);
  assert.equal(caps.stream, true);
  assert.equal(caps.embed, false);
  assert.equal(caps.batch, true);
  assert.equal(caps.vision, true);
  assert.equal(caps.pdf, true);
  assert.equal(caps.audio, false);
  assert.equal(caps.tools, true);
  assert.equal(caps.structuredOutput, true);
  assert.equal(caps.promptCache, true);
  assert.equal(caps.maxContextTokens, 200_000);
  // Live not requested → probes array empty, ran=false
  assert.equal(caps.live.ran, false);
  assert.deepEqual(caps.live.probes, []);
});

test('capabilities: model override — Haiku output cap', async () => {
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'claude-haiku-4-5' });
  const caps = await capabilities(llm);
  assert.equal(caps.maxOutputTokens, 4096);
});

test('capabilities: model override — embedding model has no chat', async () => {
  const llm = fakeLLM({ kind: 'llm-openai-compatible', modelId: 'text-embedding-3-small' });
  const caps = await capabilities(llm);
  assert.equal(caps.chat, false);
  assert.equal(caps.tools, false);
  assert.equal(caps.structuredOutput, false);
  assert.equal(caps.vision, false);
  assert.equal(caps.maxOutputTokens, 0);
  // embed stays true (openai-compatible family supports embed)
  assert.equal(caps.embed, true);
});

test('capabilities: gemini reports 1M context', async () => {
  const llm = fakeLLM({ kind: 'llm-gemini', modelId: 'gemini-1.5-pro' });
  const caps = await capabilities(llm);
  assert.equal(caps.maxContextTokens, 1_000_000);
});

test('capabilities: unknown provider yields all-false + null model', async () => {
  const llm = fakeLLM({ cname: 'CustomFoo' });
  const caps = await capabilities(llm);
  assert.equal(caps.provider, null);
  assert.equal(caps.chat, false);
  assert.equal(caps.embed, false);
  assert.equal(caps.batch, false);
});

test('capabilities: batch requires BOTH matrix support AND prototype override', async () => {
  // Anthropic matrix says batch:true but our fake has no override → false.
  const noOverride = fakeLLM({ kind: 'llm-anthropic', modelId: 'x' });
  const caps1 = await capabilities(noOverride);
  assert.equal(caps1.batch, false);

  // With override, batch is true.
  const withOverride = fakeLLM({ kind: 'llm-anthropic', modelId: 'x', batchOverride: true });
  const caps2 = await capabilities(withOverride);
  assert.equal(caps2.batch, true);

  // Groq matrix says batch:false → even with override, we report false.
  const groqWithOverride = fakeLLM({ kind: 'llm-groq', modelId: 'x', batchOverride: true });
  const caps3 = await capabilities(groqWithOverride);
  assert.equal(caps3.batch, false);
});

// ---- Live probes -------------------------------------------------------

test('capabilities: live probe succeeds when llm.chat resolves', async () => {
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'claude-opus-4-7' });
  const caps = await capabilities(llm, { live: true, probes: ['chat'] });
  assert.equal(caps.live.ran, true);
  assert.equal(caps.chat, true);
  assert.equal(caps.live.probes.length, 1);
  assert.equal(caps.live.probes[0].name, 'chat');
  assert.equal(caps.live.probes[0].ok, true);
});

test('capabilities: live probe flips chat to false when llm.chat throws', async () => {
  class FailingLLM {
    constructor() { this.options = { kind: 'llm-anthropic', modelId: 'x' }; this.modelId = 'x'; }
    async chat() { throw new Error('provider auth failed'); }
    async embed() { return { embeddings: [[1]] }; }
  }
  const llm = new FailingLLM();
  const caps = await capabilities(llm, { live: true, probes: ['chat'] });
  assert.equal(caps.chat, false);
  const p = caps.live.probes.find((p) => p.name === 'chat');
  assert.equal(p.ok, false);
  assert.match(p.error, /provider auth failed/);
});

test('capabilities: live probe respects timeoutMs', async () => {
  class SlowLLM {
    constructor() { this.options = { kind: 'llm-anthropic', modelId: 'x' }; this.modelId = 'x'; }
    async chat() { return new Promise(() => {}); }   // never resolves
  }
  const llm = new SlowLLM();
  const caps = await capabilities(llm, { live: true, probes: ['chat'], timeoutMs: 50 });
  assert.equal(caps.chat, false);
  const p = caps.live.probes[0];
  assert.match(p.error, /timed out after 50ms/);
});

test('capabilities: live embed probe', async () => {
  const llm = fakeLLM({ kind: 'llm-openai-compatible', modelId: 'text-embedding-3-small' });
  const caps = await capabilities(llm, { live: true, probes: ['embed'] });
  assert.equal(caps.embed, true);
  assert.equal(caps.live.probes[0].name, 'embed');
  assert.equal(caps.live.probes[0].ok, true);
});

test('capabilities: skips embed probe when matrix says false', async () => {
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'claude-opus-4-7' });
  const caps = await capabilities(llm, { live: true, probes: ['chat', 'embed'] });
  // Anthropic doesn't do embed, so no embed probe should run.
  const embedProbe = caps.live.probes.find((p) => p.name === 'embed');
  assert.equal(embedProbe, undefined);
});

test('capabilities: structuredOutput live probe fires', async () => {
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'claude-opus-4-7' });
  const caps = await capabilities(llm, { live: true, probes: ['structuredOutput'] });
  const p = caps.live.probes.find((p) => p.name === 'structuredOutput');
  assert.ok(p);
  assert.equal(p.ok, true);
});

test('capabilities: tools live probe fires when opted in', async () => {
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'claude-opus-4-7' });
  const caps = await capabilities(llm, { live: true, probes: ['tools'] });
  const p = caps.live.probes.find((p) => p.name === 'tools');
  assert.ok(p);
});

// ---- Matrix override -----------------------------------------------------

test('capabilities: custom matrix override', async () => {
  const llm = fakeLLM({ kind: 'llm-custom-provider', modelId: 'x' });
  const customMatrix = {
    'custom-provider': {
      chat: true, stream: false, embed: false, batch: false,
      vision: false, pdf: false, audio: false, tools: false,
      structuredOutput: false, promptCache: false,
      maxContextTokens: 4096, maxOutputTokens: 1024,
    },
  };
  const caps = await capabilities(llm, { matrix: customMatrix });
  assert.equal(caps.provider, 'custom-provider');
  assert.equal(caps.chat, true);
  assert.equal(caps.embed, false);
  assert.equal(caps.maxContextTokens, 4096);
});

test('capabilities: model override table can be supplemented', async () => {
  const customOverrides = {
    'x': { audio: true },
  };
  const llm = fakeLLM({ kind: 'llm-anthropic', modelId: 'x' });
  const caps = await capabilities(llm, { modelOverrides: customOverrides });
  assert.equal(caps.audio, true);   // custom override wins
});
