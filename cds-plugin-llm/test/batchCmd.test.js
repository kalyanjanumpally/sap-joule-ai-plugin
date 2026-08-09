const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_bcmd__';
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

const batchCmd = require('../lib/cli/commands/batch');
const { parseJsonl } = batchCmd;

class BufferStream {
  constructor(isTTY = false) { this.chunks = []; this.isTTY = isTTY; }
  write(s) { this.chunks.push(s); return true; }
  toString() { return this.chunks.join(''); }
}

function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), `batch-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  if (content !== undefined) fs.writeFileSync(p, content, 'utf8');
  return p;
}

function makeCtx({
  opts = {},
  positionals = [],
  env = {},
  buildProvider,
} = {}) {
  return {
    opts,
    positionals,
    env,
    stdin: null,
    stdout: new BufferStream(),
    stderr: new BufferStream(),
    buildProvider: buildProvider ?? (async () => { throw new Error('buildProvider not stubbed'); }),
    readInput: async () => '',
  };
}

// Fake provider with the batch surface.
function fakeProvider(overrides = {}) {
  return {
    async init() {},
    async batch(req) { return { id: 'batch-99', status: 'in_progress', requestCount: req.requests.length }; },
    async getBatch(id) { return { id, status: 'completed', counts: { succeeded: 2 } }; },
    async getBatchResults(id) { return [
      { customId: 'r1', text: 'answer 1' },
      { customId: 'r2', text: 'answer 2' },
    ]; },
    async cancelBatch(id) { return { id, status: 'canceled' }; },
    ...overrides,
  };
}

// ---- parseJsonl --------------------------------------------------------

test('parseJsonl: parses valid multi-line', () => {
  const rows = parseJsonl('{"a":1}\n{"a":2}\n', 'test');
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
});
test('parseJsonl: skips blank lines', () => {
  const rows = parseJsonl('{"a":1}\n\n\n{"a":2}', 'test');
  assert.equal(rows.length, 2);
});
test('parseJsonl: reports line number on syntax error', () => {
  assert.throws(
    () => parseJsonl('{"a":1}\n{bad}\n', 'file.jsonl'),
    /file.jsonl: invalid JSON on line 2/,
  );
});

// ---- Dispatch ----------------------------------------------------------

test('batch: prints usage on missing subcommand', async () => {
  const ctx = makeCtx();
  const code = await batchCmd(ctx);
  assert.equal(code, 0);
  assert.match(ctx.stderr.toString(), /usage:/);
});
test('batch: exits 2 on unknown subcommand', async () => {
  const ctx = makeCtx({ positionals: ['bogus'] });
  const code = await batchCmd(ctx);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /usage:/);
});

// ---- submit -----------------------------------------------------------

test('batch submit: reads JSONL, defaults model, prints id', async () => {
  const input = tmpFile('reqs.jsonl',
    '{"customId":"r1","messages":[{"role":"user","content":"a"}]}\n' +
    '{"customId":"r2","messages":[{"role":"user","content":"b"}]}\n');
  let seenReq;
  const ctx = makeCtx({
    positionals: ['submit', input],
    buildProvider: async () => ({
      kind: 'anthropic', model: 'claude-opus-4-7',
      provider: fakeProvider({
        async batch(req) { seenReq = req; return { id: 'batch-xyz', status: 'in_progress' }; },
      }),
    }),
  });
  const code = await batchCmd(ctx);
  fs.unlinkSync(input);
  assert.equal(code, 0);
  assert.equal(seenReq.requests.length, 2);
  // Default model injected on each request
  assert.equal(seenReq.requests[0].model, 'claude-opus-4-7');
  assert.match(ctx.stdout.toString(), /batch-xyz/);
  assert.match(ctx.stderr.toString(), /submitted 2 request/);
});

test('batch submit: --out writes id to file', async () => {
  const input = tmpFile('reqs.jsonl',
    '{"customId":"r1","messages":[{"role":"user","content":"a"}]}\n');
  const outFile = tmpFile('id.txt');
  const ctx = makeCtx({
    positionals: ['submit', input],
    opts: { out: outFile },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  await batchCmd(ctx);
  const written = fs.readFileSync(outFile, 'utf8').trim();
  fs.unlinkSync(input);
  fs.unlinkSync(outFile);
  assert.equal(written, 'batch-99');
});

test('batch submit: --json emits handle', async () => {
  const input = tmpFile('reqs.jsonl',
    '{"customId":"r1","messages":[{"role":"user","content":"a"}]}\n');
  const ctx = makeCtx({
    positionals: ['submit', input],
    opts: { json: true },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  await batchCmd(ctx);
  fs.unlinkSync(input);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.equal(parsed.id, 'batch-99');
});

test('batch submit: exit 2 on missing file', async () => {
  const ctx = makeCtx({
    positionals: ['submit', '/tmp/does-not-exist-xyz.jsonl'],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  const code = await batchCmd(ctx);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /cannot read/);
});

test('batch submit: exit 2 on empty file', async () => {
  const input = tmpFile('empty.jsonl', '');
  const ctx = makeCtx({
    positionals: ['submit', input],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  const code = await batchCmd(ctx);
  fs.unlinkSync(input);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /empty/);
});

test('batch submit: exit 2 on malformed JSONL', async () => {
  const input = tmpFile('bad.jsonl', '{ bad json\n');
  const ctx = makeCtx({
    positionals: ['submit', input],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  const code = await batchCmd(ctx);
  fs.unlinkSync(input);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /invalid JSON on line 1/);
});

test('batch submit: preserves request-level model over default', async () => {
  const input = tmpFile('reqs.jsonl',
    '{"customId":"r1","model":"custom-model","messages":[{"role":"user","content":"a"}]}\n');
  let seenReq;
  const ctx = makeCtx({
    positionals: ['submit', input],
    buildProvider: async () => ({
      kind: 'anthropic', model: 'default-model',
      provider: fakeProvider({ async batch(req) { seenReq = req; return { id: 'x', status: 'in_progress' }; } }),
    }),
  });
  await batchCmd(ctx);
  fs.unlinkSync(input);
  assert.equal(seenReq.requests[0].model, 'custom-model');
});

// ---- status ------------------------------------------------------------

test('batch status: prints status', async () => {
  const ctx = makeCtx({
    positionals: ['status', 'batch-99'],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  const code = await batchCmd(ctx);
  assert.equal(code, 0);
  assert.match(ctx.stdout.toString(), /batch-99: completed/);
  assert.match(ctx.stdout.toString(), /succeeded=2/);
});

test('batch status: --json emits full status', async () => {
  const ctx = makeCtx({
    positionals: ['status', 'batch-99'],
    opts: { json: true },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  await batchCmd(ctx);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.equal(parsed.status, 'completed');
});

test('batch status: exit 1 on failed status', async () => {
  const ctx = makeCtx({
    positionals: ['status', 'batch-99'],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm',
      provider: fakeProvider({ async getBatch() { return { id: 'x', status: 'failed' }; } }),
    }),
  });
  const code = await batchCmd(ctx);
  assert.equal(code, 1);
});

test('batch status: exit 1 on canceled status', async () => {
  const ctx = makeCtx({
    positionals: ['status', 'batch-99'],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm',
      provider: fakeProvider({ async getBatch() { return { id: 'x', status: 'canceled' }; } }),
    }),
  });
  const code = await batchCmd(ctx);
  assert.equal(code, 1);
});

// ---- results -----------------------------------------------------------

test('batch results: writes JSONL to stdout by default', async () => {
  const ctx = makeCtx({
    positionals: ['results', 'batch-99'],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  await batchCmd(ctx);
  const out = ctx.stdout.toString();
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.customId, 'r1');
  assert.equal(first.text, 'answer 1');
});

test('batch results: --out writes to file', async () => {
  const outFile = tmpFile('results.jsonl');
  const ctx = makeCtx({
    positionals: ['results', 'batch-99'],
    opts: { out: outFile },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  await batchCmd(ctx);
  const written = fs.readFileSync(outFile, 'utf8');
  fs.unlinkSync(outFile);
  const lines = written.trim().split('\n');
  assert.equal(lines.length, 2);
});

test('batch results: --json emits array', async () => {
  const ctx = makeCtx({
    positionals: ['results', 'batch-99'],
    opts: { json: true },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  await batchCmd(ctx);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

// ---- wait --------------------------------------------------------------

test('batch wait: polls, prints progress on stderr, writes results', async () => {
  let n = 0;
  const outFile = tmpFile('results.jsonl');
  const ctx = makeCtx({
    positionals: ['wait', 'batch-99'],
    opts: { poll: '1', timeout: '60', out: outFile },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm',
      provider: fakeProvider({
        async getBatch() { n++; return n < 3 ? { id: 'x', status: 'in_progress' } : { id: 'x', status: 'completed' }; },
      }),
    }),
  });
  const code = await batchCmd(ctx);
  const written = fs.readFileSync(outFile, 'utf8');
  fs.unlinkSync(outFile);
  assert.equal(code, 0);
  assert.match(ctx.stderr.toString(), /\[wait\] in_progress/);
  assert.match(ctx.stderr.toString(), /\[wait\] completed/);
  assert.ok(written.length > 0);
});

test('batch wait: exit 1 when batch ends failed', async () => {
  const ctx = makeCtx({
    positionals: ['wait', 'batch-99'],
    opts: { poll: '1', timeout: '60' },
    buildProvider: async () => ({ kind: 'anthropic', model: 'm',
      provider: fakeProvider({ async getBatch() { return { id: 'x', status: 'failed' }; } }),
    }),
  });
  const code = await batchCmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx.stderr.toString(), /ended in status 'failed'/);
});

// ---- cancel ------------------------------------------------------------

test('batch cancel: reports canceled status', async () => {
  const ctx = makeCtx({
    positionals: ['cancel', 'batch-99'],
    buildProvider: async () => ({ kind: 'anthropic', model: 'm', provider: fakeProvider() }),
  });
  const code = await batchCmd(ctx);
  assert.equal(code, 0);
  assert.match(ctx.stdout.toString(), /batch-99: canceled/);
});

// ---- Help --------------------------------------------------------------

test('batch: help text present', () => {
  assert.ok(typeof batchCmd.help === 'string');
  assert.match(batchCmd.help, /offline batch workflows/);
  assert.match(batchCmd.help, /input JSONL/);
  assert.match(batchCmd.help, /output JSONL/);
});
