const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_doctor__';
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

const doctor = require('../lib/cli/commands/doctor');
const {
  checkNodeVersion,
  checkPackageVersion,
  checkEnvironment,
  checkMcpTransports,
  detectProviders,
  checkProvider,
  redactValue,
} = doctor;

class BufferStream {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(s); return true; }
  toString() { return this.chunks.join(''); }
}

function makeCtx({ opts = {}, env = {}, buildProvider } = {}) {
  return {
    opts,
    positionals: [],
    env,
    stdin: null,
    stdout: new BufferStream(),
    stderr: new BufferStream(),
    buildProvider: buildProvider ?? (async () => { throw new Error('buildProvider not stubbed'); }),
    readInput: async () => '',
  };
}

// ---- redactValue -------------------------------------------------------

test('doctor.redactValue: short string masked entirely', () => {
  assert.equal(redactValue('short'), '***');
});
test('doctor.redactValue: long string shows first + last', () => {
  assert.equal(redactValue('sk-abc123456789xyz'), 'sk-a...9xyz');
});
test('doctor.redactValue: empty returns empty', () => {
  assert.equal(redactValue(''), '');
});

// ---- checkNodeVersion --------------------------------------------------

test('doctor.checkNodeVersion: reports ok on current node', () => {
  const c = checkNodeVersion();
  assert.equal(c.name, 'node-version');
  assert.equal(c.status, 'ok');
  assert.match(c.message, /^v\d+/);
});

// ---- checkPackageVersion -----------------------------------------------

test('doctor.checkPackageVersion: reads package.json', () => {
  const c = checkPackageVersion();
  assert.equal(c.status, 'ok');
  assert.match(c.message, /@saptarishi\/cds-plugin-llm v\d+\.\d+/);
});

// ---- checkEnvironment --------------------------------------------------

test('doctor.checkEnvironment: warns on empty env', () => {
  const c = checkEnvironment({});
  assert.equal(c.status, 'warning');
  assert.match(c.message, /no provider credentials/);
});

test('doctor.checkEnvironment: reports detected + redacts', () => {
  const c = checkEnvironment({
    ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop-secret',
    GROQ_API_KEY: 'gsk_abcdefghijkxyz',
  });
  assert.equal(c.status, 'ok');
  assert.match(c.message, /ANTHROPIC_API_KEY=sk-a\.\.\..{4}/);
  assert.match(c.message, /GROQ_API_KEY=gsk_\.\.\..{4}/);
  assert.doesNotMatch(c.message, /secret/);       // full 'secret' not shown (only 'cret' as last 4)
});

// ---- detectProviders ---------------------------------------------------

test('doctor.detectProviders: infers from env vars', () => {
  const list = detectProviders({ ANTHROPIC_API_KEY: 'x', GROQ_API_KEY: 'y' }, {});
  assert.deepEqual(list.sort(), ['anthropic', 'groq']);
});

test('doctor.detectProviders: --provider forces single', () => {
  const list = detectProviders({ ANTHROPIC_API_KEY: 'x', GROQ_API_KEY: 'y' }, { provider: 'anthropic' });
  assert.deepEqual(list, ['anthropic']);
});

test('doctor.detectProviders: empty when no env', () => {
  assert.deepEqual(detectProviders({}, {}), []);
});

// ---- checkMcpTransports ------------------------------------------------

test('doctor.checkMcpTransports: loads both transports', () => {
  const c = checkMcpTransports();
  assert.equal(c.status, 'ok');
  assert.match(c.message, /httpTransport/);
  assert.match(c.message, /streamableHttpTransport/);
});

// ---- checkProvider -----------------------------------------------------

test('doctor.checkProvider: reports ok on successful probe', async () => {
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'anthropic',
      model: 'claude-test',
      provider: {
        async init() {},
        async chat() { return { text: 'ok', model: 'claude-test' }; },
      },
    }),
  });
  const c = await checkProvider('anthropic', ctx, 5000);
  assert.equal(c.status, 'ok');
  assert.match(c.message, /claude-test responded/);
});

test('doctor.checkProvider: warns when reply lacks "ok"', async () => {
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'anthropic',
      model: 'claude-test',
      provider: {
        async init() {},
        async chat() { return { text: 'sorry I refuse' }; },
      },
    }),
  });
  const c = await checkProvider('anthropic', ctx, 5000);
  assert.equal(c.status, 'warning');
});

test('doctor.checkProvider: reports error with 401 remediation', async () => {
  const err = Object.assign(new Error('Unauthorized'), { status: 401 });
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'anthropic',
      model: 'claude-test',
      provider: { async init() {}, async chat() { throw err; } },
    }),
  });
  const c = await checkProvider('anthropic', ctx, 5000);
  assert.equal(c.status, 'error');
  assert.match(c.remediation, /Credentials rejected/);
  assert.match(c.remediation, /ANTHROPIC_API_KEY/);
});

test('doctor.checkProvider: reports error with 429 remediation', async () => {
  const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'groq',
      model: 'llama',
      provider: { async init() {}, async chat() { throw err; } },
    }),
  });
  const c = await checkProvider('groq', ctx, 5000);
  assert.equal(c.status, 'error');
  assert.match(c.remediation, /Rate-limited/);
});

test('doctor.checkProvider: reports network error with remediation', async () => {
  const err = Object.assign(new Error('fetch failed: ENOTFOUND'), {});
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'ollama',
      model: 'llama',
      provider: { async init() {}, async chat() { throw err; } },
    }),
  });
  const c = await checkProvider('ollama', ctx, 5000);
  assert.equal(c.status, 'error');
  assert.match(c.remediation, /Network unreachable/);
});

test('doctor.checkProvider: reports timeout with remediation', async () => {
  const ctx = makeCtx({
    buildProvider: async () => ({
      kind: 'anthropic',
      model: 'x',
      provider: {
        async init() {},
        async chat() { return new Promise(() => {}); },   // never resolves
      },
    }),
  });
  const c = await checkProvider('anthropic', ctx, 50);
  assert.equal(c.status, 'error');
  assert.match(c.message, /timed out/);
  assert.match(c.remediation, /Increase --timeout/);
});

// ---- doctor (main) -----------------------------------------------------

test('doctor: --skip-network + empty env → warnings, exit 0', async () => {
  const ctx = makeCtx({ opts: { 'skip-network': true }, env: {} });
  const code = await doctor(ctx);
  const out = ctx.stdout.toString();
  assert.equal(code, 0);
  assert.match(out, /node-version/);
  assert.match(out, /package-version/);
  assert.match(out, /skipped \(--skip-network\)/);
  assert.match(out, /summary:/);
});

test('doctor: full run all-green', async () => {
  const ctx = makeCtx({
    opts: { 'skip-network': false },
    env: { ANTHROPIC_API_KEY: 'sk-ant-testkeyabcdefghij' },
    buildProvider: async () => ({
      kind: 'anthropic',
      model: 'claude-test',
      provider: {
        async init() {},
        async chat() { return { text: 'ok', model: 'claude-test' }; },
      },
    }),
  });
  const code = await doctor(ctx);
  assert.equal(code, 0);
  const out = ctx.stdout.toString();
  assert.match(out, /✓/);
  assert.match(out, /provider:anthropic/);
});

test('doctor: --json emits structured report', async () => {
  const ctx = makeCtx({ opts: { 'skip-network': true, json: true }, env: {} });
  const code = await doctor(ctx);
  assert.equal(code, 0);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.counts);
  assert.equal(typeof parsed.durationMs, 'number');
  assert.ok(parsed.checks.some((c) => c.name === 'node-version'));
});

test('doctor: exit 1 on provider error, with remediation section', async () => {
  const ctx = makeCtx({
    env: { GROQ_API_KEY: 'gsk_badkey12345' },
    buildProvider: async () => ({
      kind: 'groq',
      model: 'llama',
      provider: {
        async init() {},
        async chat() { throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
      },
    }),
  });
  const code = await doctor(ctx);
  assert.equal(code, 1);
  const out = ctx.stdout.toString();
  assert.match(out, /✗ error/);
  assert.match(out, /remediation:/);
  assert.match(out, /Credentials rejected/);
});

test('doctor: --provider forces single provider probe', async () => {
  let seenKind;
  const ctx = makeCtx({
    opts: { provider: 'gemini' },
    env: { ANTHROPIC_API_KEY: 'x', GROQ_API_KEY: 'y', GOOGLE_API_KEY: 'z' },
    buildProvider: async ({ opts }) => {
      seenKind = opts.provider;
      return { kind: opts.provider, model: 'gemini-test',
        provider: { async init() {}, async chat() { return { text: 'ok' }; } } };
    },
  });
  await doctor(ctx);
  assert.equal(seenKind, 'gemini');
  const out = ctx.stdout.toString();
  assert.match(out, /provider:gemini/);
  assert.doesNotMatch(out, /provider:anthropic/);
});

test('doctor: no credentials, no --provider → provider-probes warning', async () => {
  const ctx = makeCtx({ env: {} });
  const code = await doctor(ctx);
  assert.equal(code, 0);
  const out = ctx.stdout.toString();
  assert.match(out, /provider-probes/);
  assert.match(out, /no providers to probe/);
});

test('doctor: help text present', () => {
  assert.ok(typeof doctor.help === 'string');
  assert.match(doctor.help, /environment diagnostic/);
});
