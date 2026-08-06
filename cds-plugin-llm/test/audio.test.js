const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_audio__';
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

const { audioFromFile, audioFromUrl, audioFromBase64 } = require('../lib/util');

function writeAudio(ext, bytes = Buffer.from([0x00, 0x01, 0x02, 0x03])) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
  const p = path.join(tmp, 'note' + ext);
  fs.writeFileSync(p, bytes);
  return p;
}

// ---- audioFromBase64 --------------------------------------------------

test('audioFromBase64: requires mediaType', () => {
  assert.throws(() => audioFromBase64('AAAA'), /mediaType is required/);
});

test('audioFromBase64: builds a plugin-shape audio block', () => {
  const b = audioFromBase64('AAAAAA==', 'audio/mpeg');
  assert.deepEqual(b, {
    type: 'audio',
    source: { type: 'base64', media_type: 'audio/mpeg', data: 'AAAAAA==' },
  });
});

// ---- audioFromUrl -----------------------------------------------------

test('audioFromUrl: builds a plugin-shape audio block with media_type', () => {
  const b = audioFromUrl('gs://bucket/note.mp3', 'audio/mpeg');
  assert.equal(b.type, 'audio');
  assert.equal(b.source.type, 'url');
  assert.equal(b.source.url, 'gs://bucket/note.mp3');
  assert.equal(b.source.media_type, 'audio/mpeg');
});

test('audioFromUrl: media_type is optional (undefined for HTTP URLs)', () => {
  const b = audioFromUrl('https://example.com/note.mp3');
  assert.equal(b.source.type, 'url');
  assert.equal(b.source.media_type, undefined);
});

// ---- audioFromFile ---------------------------------------------------

test('audioFromFile: unsupported extension throws', async () => {
  const p = writeAudio('.xyz');
  await assert.rejects(() => audioFromFile(p), /unsupported extension/);
});

test('audioFromFile: reads a .mp3 and returns base64 with audio/mpeg', async () => {
  const bytes = Buffer.from([0xFF, 0xFB, 0x90, 0x40]);   // mp3 magic bytes
  const p = writeAudio('.mp3', bytes);
  const b = await audioFromFile(p);
  assert.equal(b.type, 'audio');
  assert.equal(b.source.type, 'base64');
  assert.equal(b.source.media_type, 'audio/mpeg');
  assert.equal(b.source.data, bytes.toString('base64'));
});

test('audioFromFile: reads a .wav and returns audio/wav', async () => {
  const p = writeAudio('.wav');
  const b = await audioFromFile(p);
  assert.equal(b.source.media_type, 'audio/wav');
});

test('audioFromFile: reads a .m4a and returns audio/mp4 (m4a = AAC in MP4)', async () => {
  const p = writeAudio('.m4a');
  const b = await audioFromFile(p);
  assert.equal(b.source.media_type, 'audio/mp4');
});

test('audioFromFile: reads a .flac and returns audio/flac', async () => {
  const p = writeAudio('.flac');
  const b = await audioFromFile(p);
  assert.equal(b.source.media_type, 'audio/flac');
});

// ---- Provider dispatch: Anthropic rejects audio --------------------

test('Anthropic: audio block throws before dispatch (message-level guard)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-fake';
  const AnthropicLLMService = require('../lib/providers/anthropic');
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  await assert.rejects(
    () => svc._chat({
      model: 'claude-opus-4-7', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: [{ type: 'audio', source: { type: 'base64', media_type: 'audio/mpeg', data: 'AAA=' } }] }],
    }),
    /Anthropic.*Claude Voice/,
  );
});

// ---- Provider dispatch: OpenAI-compat emits input_audio -------------

test('OpenAI-compat: audio block translates to input_audio content-block', () => {
  // Reach into the internal translateBlock via mocked call — the provider
  // module doesn't export it, so we round-trip through a stub _chat and
  // capture the payload the fetch would receive.
  const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:65535/v1' },
    modelId: 'gpt-4o-audio-preview',
  });
  // Monkey-patch fetch so we can inspect the body without hitting the network.
  let capturedBody;
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    // Return a minimal happy response so _chat resolves cleanly.
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        model: 'gpt-4o-audio-preview',
        choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
  return svc.init().then(() => svc._chat({
    model: 'gpt-4o-audio-preview', maxTokens: 100, system: 'x',
    messages: [{
      role: 'user',
      content: [
        { type: 'audio', source: { type: 'base64', media_type: 'audio/mpeg', data: 'AUDIO_B64' } },
        { type: 'text',  text: 'transcribe' },
      ],
    }],
  })).then(() => {
    global.fetch = origFetch;
    const blocks = capturedBody.messages.find((m) => m.role === 'user').content;
    const audioBlock = blocks.find((b) => b.type === 'input_audio');
    assert.ok(audioBlock, 'audio should become an input_audio block');
    assert.equal(audioBlock.input_audio.data, 'AUDIO_B64');
    assert.equal(audioBlock.input_audio.format, 'mp3');
  }).catch((e) => { global.fetch = origFetch; throw e; });
});

test('OpenAI-compat: URL-source audio throws (must fetch client-side first)', async () => {
  const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:65535/v1' },
    modelId: 'gpt-4o-audio-preview',
  });
  await svc.init();
  await assert.rejects(
    () => svc._chat({
      model: 'gpt-4o-audio-preview', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: [{ type: 'audio', source: { type: 'url', url: 'https://x/y.mp3' } }] }],
    }),
    /do not accept audio by URL/,
  );
});
