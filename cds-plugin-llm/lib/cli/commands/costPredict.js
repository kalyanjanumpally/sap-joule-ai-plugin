const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PRICING } = require('../../pricing');

// Rough per-model token-per-character factors. English averages ~4 chars/token
// for GPT-family tokenizers; Anthropic runs slightly denser; multilingual is
// looser. These are HEURISTICS meant for pre-batch cost sizing, not billing.
// If you need precision, call your provider's /count_tokens endpoint.
const CHARS_PER_TOKEN = {
  default:              4.0,
  'claude':             3.5,   // Anthropic tokenizer runs a bit denser
  'gpt':                4.0,
  'llama':              4.2,
  'mistral':            4.1,
  'gemini':             4.0,
  'qwen':               3.2,   // multilingual → denser tokens
  'deepseek':           3.8,
};

function charsPerTokenFor(model) {
  if (!model) return CHARS_PER_TOKEN.default;
  const m = model.toLowerCase();
  for (const key of Object.keys(CHARS_PER_TOKEN)) {
    if (key === 'default') continue;
    if (m.includes(key)) return CHARS_PER_TOKEN[key];
  }
  return CHARS_PER_TOKEN.default;
}

function extractInputText(row) {
  // Accept:
  //   { prompt: "..." }
  //   { system, messages: [{role, content}, ...] }
  //   { text: "..." } — legacy shorthand
  const parts = [];
  if (typeof row?.system === 'string') parts.push(row.system);
  if (typeof row?.prompt === 'string') parts.push(row.prompt);
  if (typeof row?.text   === 'string') parts.push(row.text);
  if (Array.isArray(row?.messages)) {
    for (const m of row.messages) {
      if (typeof m?.content === 'string') parts.push(m.content);
      else if (Array.isArray(m?.content)) {
        for (const b of m.content) {
          if (b && typeof b.text === 'string') parts.push(b.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function estimateTokens(text, model) {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerTokenFor(model));
}

function percentile(sortedNumbers, p) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.min(sortedNumbers.length - 1, Math.floor((p / 100) * sortedNumbers.length));
  return sortedNumbers[idx];
}

function parseJsonl(content) {
  const rows = [];
  const errors = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      errors.push({ line: i + 1, error: e.message });
    }
  }
  return { rows, errors };
}

async function costPredict(ctx) {
  const positionals = ctx.positionals ?? [];
  const inputPath = positionals[0] ?? ctx.opts.file;
  if (!inputPath) {
    ctx.stderr.write('cost-predict: pass a JSONL file path as the first arg (or --file)\n');
    return 2;
  }
  const absolute = path.resolve(inputPath);
  let content;
  try {
    content = fs.readFileSync(absolute, 'utf8');
  } catch (e) {
    ctx.stderr.write(`cost-predict: cannot read '${absolute}': ${e.message}\n`);
    return 1;
  }

  const { rows, errors } = parseJsonl(content);
  if (errors.length > 0) {
    ctx.stderr.write(`cost-predict: ${errors.length} malformed line(s):\n`);
    for (const e of errors.slice(0, 5)) {
      ctx.stderr.write(`  line ${e.line}: ${e.error}\n`);
    }
    if (errors.length > 5) ctx.stderr.write(`  … and ${errors.length - 5} more\n`);
  }
  if (rows.length === 0) {
    ctx.stderr.write('cost-predict: no valid JSON lines to process\n');
    return 1;
  }

  const defaultModel   = ctx.opts.model ?? ctx.opts.provider ?? null;
  const outputFactor   = parseFloat(ctx.opts['output-factor'] ?? '0.6');
  const pctileArg      = parseInt(ctx.opts.percentile ?? '95', 10);
  const defaultMaxTok  = parseInt(ctx.opts['max-tokens'] ?? '1024', 10);
  const pricingUnit    = 1_000_000;

  if (!Number.isFinite(outputFactor) || outputFactor < 0 || outputFactor > 1) {
    ctx.stderr.write(`cost-predict: --output-factor must be in [0, 1] (got ${ctx.opts['output-factor']})\n`);
    return 2;
  }
  if (!Number.isInteger(pctileArg) || pctileArg < 1 || pctileArg > 99) {
    ctx.stderr.write(`cost-predict: --percentile must be an integer in [1, 99] (got ${ctx.opts.percentile})\n`);
    return 2;
  }

  // Per-model aggregates
  const perModel = new Map();
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const row of rows) {
    const model     = row.model ?? defaultModel;
    const text      = extractInputText(row);
    const inTokens  = estimateTokens(text, model);
    const maxTokens = Number.isInteger(row.maxTokens) ? row.maxTokens : defaultMaxTok;
    const outTokens = Math.round(maxTokens * outputFactor);
    const price     = model ? DEFAULT_PRICING[model] : null;
    const inputCost  = price ? (inTokens  / pricingUnit) * price.input  : 0;
    const outputCost = price ? (outTokens / pricingUnit) * price.output : 0;
    const cost       = inputCost + outputCost;

    const bucketKey = model ?? '(unspecified model)';
    if (!perModel.has(bucketKey)) {
      perModel.set(bucketKey, {
        count: 0, priced: !!price,
        inputTokens: [], outputTokens: [], costs: [],
        totalIn: 0, totalOut: 0, totalCost: 0,
      });
    }
    const b = perModel.get(bucketKey);
    b.count++;
    b.inputTokens.push(inTokens);
    b.outputTokens.push(outTokens);
    b.costs.push(cost);
    b.totalIn   += inTokens;
    b.totalOut  += outTokens;
    b.totalCost += cost;

    totalCost         += cost;
    totalInputTokens  += inTokens;
    totalOutputTokens += outTokens;
  }

  // Build per-model output rows with sorted percentiles.
  const modelRows = [];
  for (const [name, b] of perModel) {
    const sortedIn   = b.inputTokens.slice().sort((a, c) => a - c);
    const sortedOut  = b.outputTokens.slice().sort((a, c) => a - c);
    const sortedCost = b.costs.slice().sort((a, c) => a - c);
    modelRows.push({
      model:      name,
      priced:     b.priced,
      count:      b.count,
      totalIn:    b.totalIn,
      totalOut:   b.totalOut,
      totalCost:  b.totalCost,
      p50Cost:    percentile(sortedCost, 50),
      pctileCost: percentile(sortedCost, pctileArg),
      p50In:      percentile(sortedIn, 50),
      pctileIn:   percentile(sortedIn, pctileArg),
      p50Out:     percentile(sortedOut, 50),
      pctileOut:  percentile(sortedOut, pctileArg),
    });
  }
  modelRows.sort((a, b) => b.totalCost - a.totalCost);

  const summary = {
    file:                 absolute,
    rows:                 rows.length,
    outputFactor,
    percentile:           pctileArg,
    totalInputTokens,
    totalOutputTokens,
    totalCost,
    currency:             'USD',
    models:               modelRows,
    unpriced:             modelRows.filter((r) => !r.priced).map((r) => r.model),
  };

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  }

  // Human-friendly table
  const w = (s, n) => String(s).padEnd(n, ' ');
  const money = (n) => `$${n.toFixed(4)}`;
  ctx.stdout.write(`cost-predict: ${rows.length} request(s) in ${path.basename(absolute)}\n`);
  ctx.stdout.write(`  output-factor=${outputFactor}  (predicted output tokens = maxTokens × ${outputFactor})\n`);
  ctx.stdout.write(`  percentile   =p${pctileArg}\n`);
  ctx.stdout.write(`\n`);
  ctx.stdout.write(w('MODEL', 40) + w('#', 6) + w('IN tot', 10) + w('OUT tot', 10) + w('COST tot', 14) + w(`COST p${pctileArg}`, 14) + '\n');
  ctx.stdout.write('─'.repeat(94) + '\n');
  for (const r of modelRows) {
    const flag = r.priced ? ' ' : '?';
    ctx.stdout.write(w(`${flag} ${r.model}`, 40) + w(r.count, 6) + w(r.totalIn, 10) + w(r.totalOut, 10) + w(money(r.totalCost), 14) + w(money(r.pctileCost), 14) + '\n');
  }
  ctx.stdout.write('─'.repeat(94) + '\n');
  ctx.stdout.write(w('TOTAL', 40) + w(rows.length, 6) + w(totalInputTokens, 10) + w(totalOutputTokens, 10) + w(money(totalCost), 14) + '\n');
  if (summary.unpriced.length > 0) {
    ctx.stdout.write(`\nunpriced models (charged as $0 — pass --pricing overrides in code, or update DEFAULT_PRICING):\n`);
    for (const m of summary.unpriced) ctx.stdout.write(`  ? ${m}\n`);
  }
  return 0;
}

costPredict.help = `saptarishi-llm cost-predict — estimate spend for a batch of requests

usage:
  saptarishi-llm cost-predict <file.jsonl> [options]

Reads a JSONL file (one JSON object per line). Each object may be:
  { model, system?, messages: [...], maxTokens? }         — full chat request
  { model?, prompt: "...", maxTokens? }                    — shorthand
  { model?, text:   "...", maxTokens? }                    — legacy shorthand

For each row: heuristically estimates input tokens (chars ÷ per-model
chars/token factor), predicts output tokens as maxTokens × output-factor,
and prices via DEFAULT_PRICING. Prints a per-model breakdown +
percentiles + grand total.

options:
  --model <id>          default model if a row doesn't specify one
  --output-factor <n>   predicted-output ÷ maxTokens ratio (default 0.6)
  --percentile <n>      cost/token percentile to report (default 95)
  --max-tokens <n>      default maxTokens if a row doesn't set it (default 1024)
  --json                emit machine-readable JSON

examples:
  saptarishi-llm cost-predict batch.jsonl --model claude-opus-4-7
  saptarishi-llm cost-predict batch.jsonl --output-factor 0.4 --percentile 99
  saptarishi-llm cost-predict batch.jsonl --json > estimate.json
`;

module.exports = costPredict;
