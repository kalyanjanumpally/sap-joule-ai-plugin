const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const costPredict = require('../lib/cli/commands/costPredict');

function makeCtx(opts = {}, positionals = []) {
  const outChunks = [];
  const errChunks = [];
  return {
    ctx: {
      opts: {
        model: opts.model ?? undefined,
        json:  opts.json  ?? false,
        'output-factor': opts['output-factor'],
        percentile:      opts.percentile,
        'max-tokens':    opts['max-tokens'],
        file:            opts.file,
        provider:        opts.provider,
      },
      positionals,
      stdout: { write: (s) => outChunks.push(s) },
      stderr: { write: (s) => errChunks.push(s) },
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

function writeJsonl(rows) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-predict-'));
  const file = path.join(tmp, 'batch.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

// ---- Basic wiring -----------------------------------------------------

test('cost-predict: missing file → exit 2 with helpful stderr', async () => {
  const { ctx, err } = makeCtx();
  const code = await costPredict(ctx);
  assert.equal(code, 2);
  assert.match(err(), /pass a JSONL file/);
});

test('cost-predict: nonexistent file → exit 1', async () => {
  const { ctx, err } = makeCtx({}, ['/does/not/exist.jsonl']);
  const code = await costPredict(ctx);
  assert.equal(code, 1);
  assert.match(err(), /cannot read/);
});

test('cost-predict: empty file → exit 1', async () => {
  const file = writeJsonl([]);
  const { ctx, err } = makeCtx({}, [file]);
  const code = await costPredict(ctx);
  assert.equal(code, 1);
  assert.match(err(), /no valid JSON lines/);
});

// ---- Validation -------------------------------------------------------

test('cost-predict: invalid output-factor rejected', async () => {
  const file = writeJsonl([{ prompt: 'x' }]);
  const { ctx, err } = makeCtx({ 'output-factor': '1.5' }, [file]);
  assert.equal(await costPredict(ctx), 2);
  assert.match(err(), /output-factor/);
});

test('cost-predict: invalid percentile rejected', async () => {
  const file = writeJsonl([{ prompt: 'x' }]);
  const { ctx, err } = makeCtx({ percentile: '150' }, [file]);
  assert.equal(await costPredict(ctx), 2);
  assert.match(err(), /percentile/);
});

// ---- Malformed lines are reported but don't crash --------------------

test('cost-predict: malformed line reported but ignored', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-predict-'));
  const file = path.join(tmp, 'mixed.jsonl');
  fs.writeFileSync(file, '{"prompt":"good"}\nnot-json\n{"prompt":"also good"}\n', 'utf8');
  const { ctx, err } = makeCtx({ model: 'claude-opus-4-7', json: true }, [file]);
  const code = await costPredict(ctx);
  assert.equal(code, 0);
  assert.match(err(), /1 malformed/);
});

// ---- Per-model accounting --------------------------------------------

test('cost-predict: sums per-model cost via DEFAULT_PRICING', async () => {
  // claude-opus-4-7: $15/1M in, $75/1M out
  //   prompt "hello world" (11 chars) @ 3.5 char/tok = 4 tokens
  //   output = 1000 * 0.6 = 600 tokens
  //   cost = 4/1e6 × 15 + 600/1e6 × 75 = 0.00006 + 0.045 = 0.04506
  const file = writeJsonl([{ prompt: 'hello world', model: 'claude-opus-4-7', maxTokens: 1000 }]);
  const { ctx, out } = makeCtx({ json: true }, [file]);
  const code = await costPredict(ctx);
  assert.equal(code, 0);
  const payload = JSON.parse(out());
  const row = payload.models.find((m) => m.model === 'claude-opus-4-7');
  assert.ok(row);
  assert.equal(row.count, 1);
  assert.ok(Math.abs(row.totalCost - 0.04506) < 1e-4, `expected ~0.04506, got ${row.totalCost}`);
  assert.equal(row.priced, true);
});

test('cost-predict: unknown model → priced=false, cost=0, flagged in unpriced', async () => {
  const file = writeJsonl([{ prompt: 'x', model: 'unknown-model-42', maxTokens: 100 }]);
  const { ctx, out } = makeCtx({ json: true }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  assert.equal(p.totalCost, 0);
  assert.deepEqual(p.unpriced, ['unknown-model-42']);
});

test('cost-predict: --model default applied when row omits model', async () => {
  const file = writeJsonl([{ prompt: 'hello there' }, { prompt: 'another prompt' }]);
  const { ctx, out } = makeCtx({ model: 'claude-opus-4-7', json: true, 'max-tokens': '100' }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  assert.equal(p.models.length, 1);
  assert.equal(p.models[0].model, 'claude-opus-4-7');
  assert.equal(p.models[0].count, 2);
});

test('cost-predict: mixed models bucketed correctly', async () => {
  const file = writeJsonl([
    { prompt: 'a', model: 'claude-opus-4-7', maxTokens: 100 },
    { prompt: 'b', model: 'claude-opus-4-7', maxTokens: 100 },
    { prompt: 'c', model: 'gpt-4o',          maxTokens: 100 },
  ]);
  const { ctx, out } = makeCtx({ json: true }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  const claude = p.models.find((m) => m.model === 'claude-opus-4-7');
  const gpt    = p.models.find((m) => m.model === 'gpt-4o');
  assert.equal(claude.count, 2);
  assert.equal(gpt.count,    1);
});

// ---- output-factor & percentile ---------------------------------------

test('cost-predict: output-factor 0 → only input tokens priced', async () => {
  const file = writeJsonl([{ prompt: 'hello world', model: 'claude-opus-4-7', maxTokens: 1000 }]);
  const { ctx, out } = makeCtx({ 'output-factor': '0', json: true }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  // ~4 input tokens × $15/1M = 0.00006
  assert.ok(p.totalCost < 0.001);
  assert.equal(p.totalOutputTokens, 0);
});

test('cost-predict: percentile reported per model', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    prompt:   'x'.repeat(i * 10 + 10),   // varying input length
    model:    'claude-opus-4-7',
    maxTokens: 100,
  }));
  const file = writeJsonl(rows);
  const { ctx, out } = makeCtx({ json: true, percentile: '90' }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  const r = p.models[0];
  assert.ok(r.pctileIn >= r.p50In, 'p90 in >= p50 in');
  assert.ok(r.pctileCost >= r.p50Cost, 'p90 cost >= p50 cost');
});

// ---- Message shape variants ------------------------------------------

test('cost-predict: {system, messages: [...]} shape supported', async () => {
  const file = writeJsonl([{
    model: 'claude-opus-4-7',
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'summarize this document' },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'thanks!' },
    ],
    maxTokens: 500,
  }]);
  const { ctx, out } = makeCtx({ json: true }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  // Should aggregate system + all messages' content into input tokens
  assert.ok(p.totalInputTokens > 5, 'multi-message input should sum');
  assert.ok(p.totalCost > 0);
});

test('cost-predict: structured content-block messages supported', async () => {
  const file = writeJsonl([{
    model: 'claude-opus-4-7',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'first text block' },
        { type: 'text', text: 'second text block right after' },
      ],
    }],
    maxTokens: 200,
  }]);
  const { ctx, out } = makeCtx({ json: true }, [file]);
  assert.equal(await costPredict(ctx), 0);
  const p = JSON.parse(out());
  assert.ok(p.totalInputTokens > 5);
});

// ---- Human-readable output --------------------------------------------

test('cost-predict: human output has TOTAL row and per-model header', async () => {
  const file = writeJsonl([{ prompt: 'hello world', model: 'claude-opus-4-7', maxTokens: 500 }]);
  const { ctx, out } = makeCtx({}, [file]);
  assert.equal(await costPredict(ctx), 0);
  const s = out();
  assert.match(s, /MODEL/);
  assert.match(s, /TOTAL/);
  assert.match(s, /claude-opus-4-7/);
  assert.match(s, /\$/);
});

test('cost-predict: human output flags unpriced models with ?', async () => {
  const file = writeJsonl([{ prompt: 'x', model: 'my-custom-model', maxTokens: 100 }]);
  const { ctx, out } = makeCtx({}, [file]);
  assert.equal(await costPredict(ctx), 0);
  const s = out();
  assert.match(s, /\? my-custom-model/);
  assert.match(s, /unpriced/);
});
