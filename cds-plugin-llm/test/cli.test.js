const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable, PassThrough } = require('node:stream');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cli__';
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

const { buildProvider, PROVIDER_KINDS } = require('../lib/cli/providerFactory');
const chatCmd = require('../lib/cli/commands/chat');
const streamCmd = require('../lib/cli/commands/stream');
const embedCmd = require('../lib/cli/commands/embed');
const verifyCmd = require('../lib/cli/commands/verify');
const providersCmd = require('../lib/cli/commands/providers');

// ---- providerFactory ------------------------------------------------------

test('providerFactory: knows every provider kind', () => {
  assert.deepEqual(PROVIDER_KINDS.sort(), ['anthropic', 'azure-openai', 'genai-hub', 'groq', 'ollama', 'openai-compatible']);
});

test('providerFactory: rejects unknown provider', async () => {
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'bogus' }, env: {} }),
    /unknown provider/,
  );
});

test('providerFactory: anthropic requires ANTHROPIC_API_KEY', async () => {
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'anthropic' }, env: {} }),
    /ANTHROPIC_API_KEY/,
  );
});

test('providerFactory: anthropic accepts CLI opts', async () => {
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    env: { ANTHROPIC_API_KEY: 'sk-test' },
  });
  assert.equal(kind, 'anthropic');
  assert.equal(model, 'claude-sonnet-4-6');
  assert.equal(provider.constructor.name, 'AnthropicLLMService');
});

test('providerFactory: groq requires GROQ_API_KEY', async () => {
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'groq' }, env: {} }),
    /GROQ_API_KEY/,
  );
});

test('providerFactory: ollama defaults base URL', async () => {
  const { provider } = await buildProvider({
    opts: { provider: 'ollama' },
    env: {},
  });
  assert.equal(provider.constructor.name, 'OllamaLLMService');
  assert.equal(provider.options.credentials.baseUrl, 'http://localhost:11434');
});

test('providerFactory: ollama uses --base-url', async () => {
  const { provider } = await buildProvider({
    opts: { provider: 'ollama', 'base-url': 'http://192.168.5.13:11434' },
    env: {},
  });
  assert.equal(provider.options.credentials.baseUrl, 'http://192.168.5.13:11434');
});

test('providerFactory: openai-compatible needs API key + defaults base URL', async () => {
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'openai-compatible' }, env: {} }),
    /OPENAI_API_KEY/,
  );
  const { provider } = await buildProvider({
    opts: { provider: 'openai-compatible' },
    env: { OPENAI_API_KEY: 'sk-x' },
  });
  assert.equal(provider.options.credentials.baseUrl, 'https://api.openai.com/v1');
});

test('providerFactory: genai-hub lists all missing env vars', async () => {
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'genai-hub' }, env: {} }),
    /AICORE_URL.*AICORE_TOKEN_URL.*AICORE_CLIENT_ID.*AICORE_CLIENT_SECRET.*AICORE_DEPLOYMENT_ID/s,
  );
});

test('providerFactory: env fallback for provider + model', async () => {
  const { kind, model } = await buildProvider({
    opts: {},
    env: {
      SAPTARISHI_LLM_PROVIDER: 'groq',
      SAPTARISHI_LLM_MODEL: 'llama-3.1-8b-instant',
      GROQ_API_KEY: 'gsk-x',
    },
  });
  assert.equal(kind, 'groq');
  assert.equal(model, 'llama-3.1-8b-instant');
});

// ---- commands (with stubbed provider) -------------------------------------

function stubBuildProvider(overrides = {}) {
  return async () => ({
    kind: 'stub',
    model: 'stub-model',
    provider: {
      async init() {},
      async chat(req) {
        return {
          text: `RESP:${req.messages[0].content}`,
          model: 'stub-model',
          usage: { input_tokens: 3, output_tokens: 5 },
          stopReason: 'end_turn',
          ...overrides.chat,
        };
      },
      async embed({ input }) {
        const arr = Array.isArray(input) ? input : [input];
        return { embeddings: arr.map(() => [0.1, 0.2, 0.3, 0.4]), model: 'stub-emb' };
      },
      async *stream(req) {
        yield { type: 'text_delta', text: 'chunk1 ' };
        yield { type: 'text_delta', text: 'chunk2' };
        yield { type: 'done', text: 'chunk1 chunk2', model: 'stub-model', usage: {}, stopReason: 'stop' };
      },
      constructor: { name: 'StubProvider' },
    },
  });
}

function makeCtx(overrides = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutBuf = [];
  const stderrBuf = [];
  stdout.on('data', c => stdoutBuf.push(c));
  stderr.on('data', c => stderrBuf.push(c));
  return {
    opts: {},
    positionals: [],
    env: {},
    stdin: Readable.from([]),
    stdout,
    stderr,
    buildProvider: stubBuildProvider(),
    readInput: async () => 'hello',
    ...overrides,
    _read: () => ({
      stdout: Buffer.concat(stdoutBuf).toString('utf8'),
      stderr: Buffer.concat(stderrBuf).toString('utf8'),
    }),
  };
}

test('chat: writes plain text by default', async () => {
  const ctx = makeCtx({ readInput: async () => 'ping' });
  const code = await chatCmd(ctx);
  assert.equal(code, 0);
  assert.equal(ctx._read().stdout.trim(), 'RESP:ping');
});

test('chat: --json emits structured output', async () => {
  const ctx = makeCtx({ opts: { json: true }, readInput: async () => 'x' });
  await chatCmd(ctx);
  const parsed = JSON.parse(ctx._read().stdout);
  assert.equal(parsed.text, 'RESP:x');
  assert.equal(parsed.model, 'stub-model');
  assert.equal(parsed.usage.input_tokens, 3);
});

test('chat: exits 2 if no prompt', async () => {
  const ctx = makeCtx({ readInput: async () => '' });
  const code = await chatCmd(ctx);
  assert.equal(code, 2);
  assert.match(ctx._read().stderr, /no prompt supplied/);
});

test('stream: prints deltas then newline', async () => {
  const ctx = makeCtx({ readInput: async () => 'x' });
  const code = await streamCmd(ctx);
  assert.equal(code, 0);
  assert.equal(ctx._read().stdout, 'chunk1 chunk2\n');
});

test('stream: --json swallows deltas, prints done JSON', async () => {
  const ctx = makeCtx({ opts: { json: true }, readInput: async () => 'x' });
  await streamCmd(ctx);
  const parsed = JSON.parse(ctx._read().stdout);
  assert.equal(parsed.text, 'chunk1 chunk2');
  assert.equal(parsed.model, 'stub-model');
});

test('embed: default output shows model + count + dimension + preview', async () => {
  const ctx = makeCtx({ readInput: async () => 'a\n---\nb\n---\nc' });
  await embedCmd(ctx);
  const out = ctx._read().stdout;
  assert.match(out, /count: 3/);
  assert.match(out, /dimension: 4/);
  assert.match(out, /\[0\]/);
  assert.match(out, /\[2\]/);
});

test('embed: --json emits full vectors', async () => {
  const ctx = makeCtx({ opts: { json: true }, readInput: async () => 'x' });
  await embedCmd(ctx);
  const parsed = JSON.parse(ctx._read().stdout);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.dimension, 4);
  assert.deepEqual(parsed.embeddings[0], [0.1, 0.2, 0.3, 0.4]);
});

test('embed: rejects Anthropic provider', async () => {
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'anthropic', model: 'x',
      provider: { async init() {}, constructor: { name: 'AnthropicLLMService' } },
    }),
    readInput: async () => 'x',
  });
  const code = await embedCmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._read().stderr, /does not support embed/);
});

test('verify: returns 0 when reply matches "ok"', async () => {
  const ctx = makeCtx({
    buildProvider: stubBuildProvider({ chat: { text: 'ok' } }),
    readInput: async () => 'irrelevant',
  });
  const code = await verifyCmd(ctx);
  assert.equal(code, 0);
  const out = ctx._read().stdout;
  assert.match(out, /✓ stub responded/);
});

test('verify: returns 1 when reply does NOT match "ok"', async () => {
  const ctx = makeCtx({
    buildProvider: stubBuildProvider({ chat: { text: 'no way' } }),
    readInput: async () => 'irrelevant',
  });
  const code = await verifyCmd(ctx);
  assert.equal(code, 1);
});

test('providers: lists all kinds in default output', async () => {
  const ctx = makeCtx();
  const code = await providersCmd(ctx);
  assert.equal(code, 0);
  const out = ctx._read().stdout;
  for (const k of PROVIDER_KINDS) assert.match(out, new RegExp(k));
});

test('providers: --json returns structured rows', async () => {
  const ctx = makeCtx({ opts: { json: true } });
  await providersCmd(ctx);
  const parsed = JSON.parse(ctx._read().stdout);
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed.map(r => r.kind).sort(), ['anthropic', 'azure-openai', 'genai-hub', 'groq', 'ollama', 'openai-compatible']);
});

// ---- end-to-end via node subprocess ---------------------------------------

test('CLI: --version prints package name + version', () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'saptarishi-llm.js');
  const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.match(out, /@saptarishi\/cds-plugin-llm v\d+\.\d+\.\d+/);
});

test('CLI: --help lists commands', () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'saptarishi-llm.js');
  const out = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  for (const c of ['chat', 'stream', 'embed', 'verify', 'providers']) {
    assert.match(out, new RegExp(`\\b${c}\\b`));
  }
});

test('CLI: unknown command exits 2', () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'saptarishi-llm.js');
  try {
    execFileSync(process.execPath, [bin, 'nosuchcmd'], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /unknown command/);
  }
});
