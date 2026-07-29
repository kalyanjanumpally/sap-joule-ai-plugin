const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pdf__';
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

const { pdfFromFile, pdfFromUrl, pdfFromBase64 } = require('../lib/util');
const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
const OllamaLLMService = require('../lib/providers/ollama');

// ---- helpers ------------------------------------------------------------

test('pdfFromUrl builds a plugin-shape document block', () => {
  const pdf = pdfFromUrl('https://example.com/invoice.pdf');
  assert.deepEqual(pdf, {
    type: 'document',
    source: { type: 'url', url: 'https://example.com/invoice.pdf' },
  });
});

test('pdfFromBase64 uses application/pdf media_type', () => {
  const pdf = pdfFromBase64('JVBERi0xLjQ=');
  assert.deepEqual(pdf, {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
  });
});

test('pdfFromFile reads + base64-encodes; requires .pdf extension', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(os.tmpdir(), `pdf-test-${Date.now()}.pdf`);
  await fs.writeFile(tmp, Buffer.from('%PDF-1.4', 'utf8'));
  try {
    const pdf = await pdfFromFile(tmp);
    assert.equal(pdf.type, 'document');
    assert.equal(pdf.source.type, 'base64');
    assert.equal(pdf.source.media_type, 'application/pdf');
    assert.equal(Buffer.from(pdf.source.data, 'base64').toString('utf8'), '%PDF-1.4');
  } finally {
    await fs.unlink(tmp);
  }
});

test('pdfFromFile rejects non-PDF extensions', async () => {
  await assert.rejects(() => pdfFromFile('/tmp/foo.png'), /expected \.pdf/);
});

// ---- provider rejection --------------------------------------------------

const origFetch = global.fetch;
beforeEach(() => { global.fetch = async () => ({ ok: true, json: async () => ({}) }); });
afterEach(() => { global.fetch = origFetch; });

test('OpenAI-compat: base64 PDF is translated to inline file content-block', async () => {
  let captured;
  global.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: {},
      }),
      text: async () => '',
    };
  };
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { baseUrl: 'https://x/v1', apiKey: 'k' },
    modelId: 'gpt-4o',
  });
  await svc.init();
  await svc.chat({
    messages: [{
      role: 'user',
      content: [pdfFromBase64('JVBERi0='), { type: 'text', text: 'summarize' }],
    }],
  });
  const userMsg = captured.messages.find(m => m.role === 'user');
  assert.deepEqual(userMsg.content[0], {
    type: 'file',
    file: {
      filename: 'document.pdf',
      file_data: 'data:application/pdf;base64,JVBERi0=',
    },
  });
  assert.deepEqual(userMsg.content[1], { type: 'text', text: 'summarize' });
});

test('OpenAI-compat: URL PDF throws with actionable message', async () => {
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { baseUrl: 'https://x/v1', apiKey: 'k' },
    modelId: 'gpt-4o',
  });
  await svc.init();
  await assert.rejects(
    () => svc.chat({
      messages: [{
        role: 'user',
        content: [pdfFromUrl('https://example.com/x.pdf'), { type: 'text', text: 'q' }],
      }],
    }),
    /do not accept PDFs by URL/,
  );
});

test('OpenAI-compat: document block with source.type=file_id passes through as file.file_id', async () => {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }],
        model: 'gpt-4o', usage: {},
      }),
      text: async () => '',
    };
  };
  try {
    const svc = new OpenAICompatibleLLMService('llm', null, {
      credentials: { baseUrl: 'https://x/v1', apiKey: 'k' },
      modelId: 'gpt-4o',
    });
    await svc.init();
    await svc.chat({
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file_id', file_id: 'file-abc123', mediaType: 'application/pdf' } },
          { type: 'text', text: 'summarize' },
        ],
      }],
    });
    const userMsg = captured.messages.find(m => m.role === 'user');
    assert.deepEqual(userMsg.content[0], { type: 'file', file: { file_id: 'file-abc123' } });
    assert.deepEqual(userMsg.content[1], { type: 'text', text: 'summarize' });
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compat: URL PDF error message now suggests uploadPdfFromUrl helper', async () => {
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { baseUrl: 'https://x/v1', apiKey: 'k' },
    modelId: 'gpt-4o',
  });
  await svc.init();
  await assert.rejects(
    () => svc.chat({
      messages: [{
        role: 'user',
        content: [pdfFromUrl('https://example.com/x.pdf'), { type: 'text', text: 'q' }],
      }],
    }),
    /uploadPdfFromUrl/,
  );
});

test('Ollama throws when a document block is passed', async () => {
  const svc = new OllamaLLMService('llm', null, {
    credentials: { baseUrl: 'http://localhost:11434' },
    modelId: 'llava',
  });
  await svc.init();
  await assert.rejects(
    () => svc.chat({
      messages: [{
        role: 'user',
        content: [pdfFromBase64('AAAA'), { type: 'text', text: 'summarize' }],
      }],
    }),
    /not supported on Ollama/,
  );
});
