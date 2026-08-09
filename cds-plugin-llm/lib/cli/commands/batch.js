// `saptarishi-llm batch <sub>` — offline batch workflows on top of
// the LLMService batch API. Subcommands:
//
//   submit  <file.jsonl> [--out batch.id]  submit JSONL, print/write batch id
//   status  <id> [--json]                  poll one shot, print status
//   results <id> [--out results.jsonl]     download JSONL results
//   wait    <id> [--poll 30] [--timeout 3600] [--out results.jsonl]
//                                          poll until done then download
//   cancel  <id>                           cancel in-flight batch
//
// The JSONL input for `submit` must be one request per line:
//   {"customId":"r1","messages":[{"role":"user","content":"..."}],"maxTokens":200}
//   {"customId":"r2","messages":[{"role":"user","content":"..."}]}
//
// The JSONL output from `results` is one BatchResult per line:
//   {"customId":"r1","text":"...","model":"...","usage":{...}}
//   {"customId":"r2","error":"..."}

const fs = require('node:fs');
const { waitForBatch } = require('../../batchHelpers');

const USAGE = `usage:
  saptarishi-llm batch submit  <requests.jsonl> [--out batch.id]
  saptarishi-llm batch status  <id> [--json]
  saptarishi-llm batch results <id> [--out results.jsonl] [--json]
  saptarishi-llm batch wait    <id> [--poll 30] [--timeout 3600] [--out results.jsonl]
  saptarishi-llm batch cancel  <id>

--provider <kind>   provider to run against (or SAPTARISHI_LLM_PROVIDER)
--model    <id>     model to use for submitted requests (or SAPTARISHI_LLM_MODEL)`;

function parseJsonl(text, sourceName) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const [i, line] of lines.entries()) {
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${sourceName}: invalid JSON on line ${i + 1}: ${e.message}`);
    }
  }
  return out;
}

async function subSubmit(ctx, id) {
  if (!id) { ctx.stderr.write(USAGE + '\n'); return 2; }
  let text;
  try { text = fs.readFileSync(id, 'utf8'); }
  catch (e) { ctx.stderr.write(`batch submit: cannot read ${id}: ${e.message}\n`); return 2; }

  let requests;
  try { requests = parseJsonl(text, id); }
  catch (e) { ctx.stderr.write(`batch submit: ${e.message}\n`); return 2; }

  if (requests.length === 0) {
    ctx.stderr.write(`batch submit: ${id} is empty\n`);
    return 2;
  }

  const { provider, model } = await ctx.buildProvider(ctx);
  await provider.init();

  // Default model onto requests that don't specify one.
  for (const r of requests) if (!r.model && model) r.model = model;

  const handle = await provider.batch({ requests });

  const outPath = ctx.opts.out;
  if (outPath) {
    fs.writeFileSync(outPath, handle.id + '\n', 'utf8');
    ctx.stderr.write(`batch submit: id written to ${outPath}\n`);
  }
  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(handle, null, 2) + '\n');
  } else {
    ctx.stdout.write(`${handle.id}\n`);
    ctx.stderr.write(`submitted ${requests.length} request(s), status: ${handle.status}\n`);
  }
  return 0;
}

async function subStatus(ctx, id) {
  if (!id) { ctx.stderr.write(USAGE + '\n'); return 2; }
  const { provider } = await ctx.buildProvider(ctx);
  await provider.init();
  const s = await provider.getBatch(id);
  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(s, null, 2) + '\n');
  } else {
    ctx.stdout.write(`${id}: ${s.status}\n`);
    if (s.counts) {
      ctx.stdout.write(`  counts: ` +
        Object.entries(s.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') + '\n');
    }
    if (s.endedAt) ctx.stdout.write(`  endedAt: ${s.endedAt}\n`);
  }
  // Exit 0 for terminal-success, 1 for failed / canceled, 0 for in_progress (still healthy).
  if (s.status === 'failed' || s.status === 'canceled') return 1;
  return 0;
}

async function writeResults(ctx, results, outPath) {
  const jsonl = results.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (outPath) {
    fs.writeFileSync(outPath, jsonl, 'utf8');
    ctx.stderr.write(`wrote ${results.length} row(s) to ${outPath}\n`);
    return;
  }
  ctx.stdout.write(jsonl);
}

async function subResults(ctx, id) {
  if (!id) { ctx.stderr.write(USAGE + '\n'); return 2; }
  const { provider } = await ctx.buildProvider(ctx);
  await provider.init();
  const results = await provider.getBatchResults(id);
  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    await writeResults(ctx, results, ctx.opts.out);
  }
  return 0;
}

async function subWait(ctx, id) {
  if (!id) { ctx.stderr.write(USAGE + '\n'); return 2; }
  const { provider } = await ctx.buildProvider(ctx);
  await provider.init();

  const pollSec = ctx.opts.poll ? parseInt(ctx.opts.poll, 10) : 30;
  const timeoutSec = ctx.opts.timeout ? parseInt(ctx.opts.timeout, 10) : 6 * 3600;

  const finalStatus = await waitForBatch(provider, id, {
    pollIntervalMs: pollSec * 1000,
    timeoutMs:      timeoutSec * 1000,
    onProgress: (s) => {
      const counts = s.counts
        ? Object.entries(s.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ')
        : '';
      ctx.stderr.write(`[wait] ${s.status}${counts ? ' — ' + counts : ''}\n`);
    },
  });

  if (finalStatus.status !== 'completed') {
    ctx.stderr.write(`batch ${id} ended in status '${finalStatus.status}' — no results to fetch\n`);
    if (ctx.opts.json) ctx.stdout.write(JSON.stringify(finalStatus, null, 2) + '\n');
    return 1;
  }

  const results = await provider.getBatchResults(id);
  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    await writeResults(ctx, results, ctx.opts.out);
  }
  return 0;
}

async function subCancel(ctx, id) {
  if (!id) { ctx.stderr.write(USAGE + '\n'); return 2; }
  const { provider } = await ctx.buildProvider(ctx);
  await provider.init();
  const s = await provider.cancelBatch(id);
  ctx.stdout.write(`${id}: ${s.status}\n`);
  return 0;
}

const SUBCOMMANDS = {
  submit:  subSubmit,
  status:  subStatus,
  results: subResults,
  wait:    subWait,
  cancel:  subCancel,
};

async function batchCmd(ctx) {
  const [sub, id] = ctx.positionals;
  if (!sub || !SUBCOMMANDS[sub]) {
    ctx.stderr.write(USAGE + '\n');
    return sub ? 2 : 0;
  }
  return SUBCOMMANDS[sub](ctx, id);
}

batchCmd.help = `saptarishi-llm batch — offline batch workflows

subcommands:
  submit  <requests.jsonl> [--out batch.id]              submit + print id
  status  <id> [--json]                                  one-shot poll
  results <id> [--out results.jsonl] [--json]            download JSONL
  wait    <id> [--poll 30] [--timeout 3600] [--out ...]  poll until done
  cancel  <id>                                           cancel in-flight batch

input JSONL (submit) — one request per line:
  {"customId":"r1","messages":[{"role":"user","content":"..."}],"maxTokens":200}
  {"customId":"r2","messages":[{"role":"user","content":"..."}]}

output JSONL (results) — one BatchResult per line:
  {"customId":"r1","text":"...","model":"...","usage":{...}}
  {"customId":"r2","error":"..."}

examples:
  saptarishi-llm batch submit reqs.jsonl --provider anthropic --model claude-opus-4-7 --out b.id
  saptarishi-llm batch wait $(cat b.id) --poll 60 --out results.jsonl
  saptarishi-llm batch cancel $(cat b.id)`;

module.exports = batchCmd;
module.exports.parseJsonl = parseJsonl;
module.exports.SUBCOMMANDS = SUBCOMMANDS;
