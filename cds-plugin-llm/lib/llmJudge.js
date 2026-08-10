// LLM-as-judge helper. Wraps the standard eval pattern: define
// pass/fail criteria in natural language, submit an LLM output for
// scoring, get a structured judgment back. Ideal for CI eval loops,
// regression detection, and response-quality dashboards.
//
//   const { llmJudge } = require('@saptarishi/cds-plugin-llm');
//
//   const j = await llmJudge({
//     llm,                        // LLMService or a chat function
//     criteria: [
//       { name: 'accuracy',  description: 'facts match source',     weight: 2 },
//       { name: 'brevity',   description: '2 sentences max',        weight: 1 },
//       { name: 'grounding', description: 'cites specific IDs',     weight: 3 },
//     ],
//     response: 'Steel contract CTR-2026-101 ends 2027-06-30.',
//     context:  'Source: contract CTR-2026-101 dated 2024-04-01.',
//     threshold: 0.75,
//   });
//   // {
//   //   score: 0.87, verdict: 'pass',
//   //   criteriaResults: [
//   //     { name: 'accuracy',  score: 1.0, passed: true,  rationale: '...' },
//   //     { name: 'brevity',   score: 0.7, passed: true,  rationale: '...' },
//   //     { name: 'grounding', score: 0.9, passed: true,  rationale: '...' },
//   //   ],
//   //   overallRationale: '...',
//   //   model: 'claude-opus-4-7',
//   //   usage: { input_tokens, output_tokens },
//   // }

// ---- Default prompts + schema ---------------------------------------

const DEFAULT_JUDGE_SYSTEM = `You are an impartial evaluator. Score the given RESPONSE against each CRITERION independently.
Rules:
- Score each criterion on a scale of 0.0 to 1.0 (0=fails completely, 1=fully satisfies).
- Cite specific evidence from the RESPONSE (and CONTEXT if provided) in every rationale.
- Never inflate scores to be "nice" — be strict about grounding, accuracy, and completeness.
- If CONTEXT is provided, cross-check facts. Any fabrication scores 0 on accuracy.
- Rationales must be 1-2 sentences.
- Return ONLY the JSON object matching the schema. No preamble, no code fences.`;

function judgmentSchema(criteriaNames) {
  return {
    type: 'object',
    properties: {
      criteriaResults: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:      { type: 'string', enum: criteriaNames },
            score:     { type: 'number', description: '0.0 to 1.0' },
            rationale: { type: 'string', description: '1-2 sentences citing specific evidence' },
          },
          required: ['name', 'score', 'rationale'],
          additionalProperties: false,
        },
      },
      overallRationale: { type: 'string', description: '2-3 sentence summary of the response quality.' },
    },
    required: ['criteriaResults', 'overallRationale'],
    additionalProperties: false,
  };
}

// ---- Normalization -------------------------------------------------

function normalizeCriteria(criteria) {
  if (typeof criteria === 'string') {
    return [{ name: 'default', description: criteria, weight: 1 }];
  }
  if (!Array.isArray(criteria)) {
    throw new Error('llmJudge: criteria must be a string or an array of { name, description, weight? }.');
  }
  if (criteria.length === 0) {
    throw new Error('llmJudge: criteria array cannot be empty.');
  }
  const seen = new Set();
  return criteria.map((c, i) => {
    if (typeof c === 'string') {
      const name = `criterion${i + 1}`;
      seen.add(name);
      return { name, description: c, weight: 1 };
    }
    if (!c || typeof c !== 'object') {
      throw new Error(`llmJudge: criteria[${i}] must be a string or object.`);
    }
    const name = c.name ?? `criterion${i + 1}`;
    if (seen.has(name)) throw new Error(`llmJudge: duplicate criterion name '${name}'.`);
    seen.add(name);
    if (typeof c.description !== 'string' || c.description.length === 0) {
      throw new Error(`llmJudge: criteria[${i}].description must be a non-empty string.`);
    }
    const weight = c.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`llmJudge: criteria[${i}].weight must be a positive number.`);
    }
    return { name, description: c.description, weight };
  });
}

function buildUserPrompt(criteria, response, context) {
  const criteriaBlock = criteria.map((c, i) =>
    `${i + 1}. ${c.name} — ${c.description}${c.weight !== 1 ? ` (weight: ${c.weight})` : ''}`
  ).join('\n');

  const contextBlock = context ? `CONTEXT (ground truth to cross-check against):\n${context}\n\n` : '';

  return `${contextBlock}RESPONSE (to be evaluated):\n${response}\n\nCRITERIA:\n${criteriaBlock}\n\nScore each criterion 0.0 to 1.0. Return the JSON object.`;
}

// ---- Scoring aggregation -------------------------------------------

function aggregateScore(criteriaResults, criteriaConfig) {
  const configByName = new Map(criteriaConfig.map((c) => [c.name, c]));
  let weightSum = 0;
  let weightedTotal = 0;
  const merged = [];

  // Preserve criteria order from config; fill in results as we find them.
  for (const c of criteriaConfig) {
    const r = criteriaResults.find((x) => x.name === c.name);
    const score = r ? clamp01(r.score) : 0;
    const rationale = r?.rationale ?? '(no rationale returned)';
    merged.push({
      name:        c.name,
      description: c.description,
      score,
      rationale,
      passed:      score >= 0.5,   // per-criterion default threshold
    });
    weightSum += c.weight;
    weightedTotal += score * c.weight;
  }
  const finalScore = weightSum > 0 ? weightedTotal / weightSum : 0;
  return { finalScore, merged };
}

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---- Main helper ---------------------------------------------------

async function llmJudge(options = {}) {
  const {
    llm,
    chat: chatFn,
    criteria,
    response,
    context,
    threshold  = 0.7,
    judgeModel,
    judgeSystem = DEFAULT_JUDGE_SYSTEM,
    judgeTemperature = 0.0,
    maxTokens = 2000,
  } = options;

  if (typeof response !== 'string' || response.length === 0) {
    throw new Error('llmJudge: response must be a non-empty string.');
  }
  if (criteria == null) {
    throw new Error('llmJudge: criteria is required.');
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('llmJudge: threshold must be a number between 0 and 1.');
  }
  const chat = chatFn ?? (llm && typeof llm.chat === 'function' ? llm.chat.bind(llm) : null);
  if (typeof chat !== 'function') {
    throw new Error('llmJudge: pass either { llm } (LLMService with .chat) or { chat } (function).');
  }

  const cfg = normalizeCriteria(criteria);
  const schema = judgmentSchema(cfg.map((c) => c.name));
  const userPrompt = buildUserPrompt(cfg, response, context);

  const req = {
    system: judgeSystem,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
    temperature: judgeTemperature,
    format: schema,
  };
  if (judgeModel) req.model = judgeModel;

  const result = await chat(req);

  // Prefer parsed data (LLMService fast path via `format:`); fall back to
  // extracting JSON from text so this works even against providers that
  // don't natively populate result.data.
  const raw = result?.data ?? tryParseJson(result?.text);
  if (!raw || !Array.isArray(raw.criteriaResults)) {
    throw new Error(`llmJudge: judge returned unparseable output. Raw text: ${(result?.text ?? '').slice(0, 300)}`);
  }

  const { finalScore, merged } = aggregateScore(raw.criteriaResults, cfg);

  return {
    score:            finalScore,
    verdict:          finalScore >= threshold ? 'pass' : 'fail',
    criteriaResults:  merged,
    overallRationale: raw.overallRationale ?? '',
    model:            result?.model ?? judgeModel ?? null,
    usage:            result?.usage ?? null,
    threshold,
    raw,
  };
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (block) { try { return JSON.parse(block[1].trim()); } catch { /* fall through */ } }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

// ---- Batch variant -------------------------------------------------

/**
 * Judge N responses against the same criteria in parallel. Useful for
 * eval-set scoring in CI: build a fixture of {response, expectedVerdict}
 * pairs, call judgeMany, compute pass rate.
 *
 *   const results = await judgeMany({ llm, criteria, responses: [...] });
 *   const passRate = results.filter((r) => r.verdict === 'pass').length / results.length;
 *
 * Concurrency is capped at options.concurrency (default 5) to avoid
 * flooding the provider — combine with bulkhead middleware for
 * production-grade fan-out control.
 */
async function judgeMany(options = {}) {
  const { responses, concurrency = 5, ...rest } = options;
  if (!Array.isArray(responses) || responses.length === 0) {
    throw new Error('judgeMany: responses must be a non-empty array.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('judgeMany: concurrency must be a positive integer.');
  }

  const results = new Array(responses.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= responses.length) return;
      const entry = responses[i];
      const resp = typeof entry === 'string' ? entry : entry.response;
      const ctx  = typeof entry === 'object' ? entry.context : rest.context;
      try {
        results[i] = await llmJudge({ ...rest, response: resp, context: ctx });
      } catch (err) {
        results[i] = { error: err.message, verdict: 'error', score: 0 };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, responses.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = {
  llmJudge,
  judgeMany,
  DEFAULT_JUDGE_SYSTEM,
  // Exposed for tests + composition.
  normalizeCriteria,
  buildUserPrompt,
  aggregateScore,
  judgmentSchema,
};
