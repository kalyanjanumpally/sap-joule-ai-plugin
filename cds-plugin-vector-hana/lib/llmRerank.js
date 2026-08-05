// Built-in LLM reranker — pluggable factory that produces a `Reranker`
// function compatible with the RAG.rerank hook shipped in 0.8.0.
//
//   const { llmRerank, RAG } = require('@saptarishi/cds-plugin-vector-hana');
//   const rerank = llmRerank({ llm });
//   const rag = new RAG({ llm, store, mode: 'hybrid', rerank });
//
// Given a query and a list of retrieved hits, asks the LLM to score each
// hit's relevance on a 0-10 scale (via structured output) and returns the
// hits re-sorted descending by score. Robust to malformed / partial LLM
// output: hits missing from the response fall back to their original rank
// (score 5, the neutral midpoint); malformed JSON returns the input order
// unchanged so nothing worse than "vanilla hybrid" ever ships.
//
// Batching: for long candidate lists, chunk into `batchSize` slices per
// LLM call (default 20, which fits comfortably in a small structured-
// output response and stays under most models' JSON-mode limits).

const DEFAULT_BATCH_SIZE = 20;

const DEFAULT_SYSTEM = `You are a relevance scorer for retrieval augmentation.
For each passage, score how relevant it is to the user's query on a 0-10 integer scale.

Rules:
- 10 = passage directly answers the query.
- 7-9 = strongly relevant; contains key facts the answer would cite.
- 4-6 = tangentially related; useful context but not a direct answer.
- 1-3 = weakly related; only shares a word or theme.
- 0 = irrelevant.

Return JSON only. No prose. Match the requested schema exactly.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0 },
          score: { type: 'integer', minimum: 0, maximum: 10 },
        },
        required: ['index', 'score'],
      },
    },
  },
  required: ['scores'],
};

function llmRerank(options = {}) {
  const {
    llm,
    model,
    batchSize = DEFAULT_BATCH_SIZE,
    systemInstructions = DEFAULT_SYSTEM,
    maxTokens = 512,
    // Escape hatch — a caller can inject their own prompt builder, useful
    // for domain-specific scoring criteria ("prefer contracts still valid
    // this quarter", etc.) without forking the whole factory.
    buildUserPrompt = defaultUserPrompt,
  } = options;

  if (!llm || typeof llm.chat !== 'function') {
    throw new Error('llmRerank: `llm` option required — must be an LLMService with chat().');
  }
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error(`llmRerank: batchSize must be a positive integer (got ${batchSize})`);
  }

  return async function rerank(hits, query) {
    if (!Array.isArray(hits) || hits.length === 0) return hits ?? [];
    if (typeof query !== 'string' || query.length === 0) return hits;

    // Score each hit. Batches process in parallel — the LLM scores don't
    // depend on each other, and small batches keep latency down.
    const batches = chunk(hits, batchSize);
    const batchResults = await Promise.all(batches.map(async (batchHits, batchIdx) => {
      const globalStart = batchIdx * batchSize;
      return scoreBatch({ llm, model, maxTokens, systemInstructions, buildUserPrompt, batchHits, globalStart, query });
    }));

    // Merge per-batch scores keyed by original hit index (before any batching).
    const scoreByIndex = new Map();
    for (const partial of batchResults) {
      for (const [idx, score] of partial) scoreByIndex.set(idx, score);
    }

    // Sort hits by score descending. Missing indices default to 5 (neutral)
    // so we don't drop them; secondary sort preserves original order.
    return hits
      .map((h, idx) => ({ h, idx, score: scoreByIndex.get(idx) ?? 5 }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map(({ h, score }) => ({ ...h, rerankScore: score }));
  };
}

async function scoreBatch({ llm, model, maxTokens, systemInstructions, buildUserPrompt, batchHits, globalStart, query }) {
  const user = buildUserPrompt({ query, hits: batchHits, startIndex: 0 });
  const req = {
    system: systemInstructions,
    messages: [{ role: 'user', content: user }],
    format: RESPONSE_SCHEMA,
    maxTokens,
  };
  if (model) req.model = model;
  let reply;
  try {
    reply = await llm.chat(req);
  } catch {
    return []; // On any error, fall back to original order (all defaults)
  }
  const scores = parseScores(reply);
  // Translate batch-local indices back to global hit indices.
  return scores.map(({ index, score }) => [globalStart + index, score])
    .filter(([globalIdx]) => globalIdx < globalStart + batchHits.length);
}

function defaultUserPrompt({ query, hits, startIndex }) {
  const lines = [`Query: ${query}`, '', 'Passages:'];
  for (let i = 0; i < hits.length; i++) {
    lines.push(`${startIndex + i}: ${truncate(hits[i].text ?? '', 500)}`);
  }
  lines.push('');
  lines.push('Score every passage. Return JSON { "scores": [{ "index": N, "score": 0-10 }, ...] }.');
  return lines.join('\n');
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Provider chat replies come in many shapes (see rag.js extractText). Pull
// the first JSON object we can find in the text and return its `scores`
// array. Silently returns [] on any parse failure so the caller falls back
// to the original ordering.
function parseScores(reply) {
  if (!reply) return [];
  // Anthropic-shaped structured output — the plugin already parses into
  // `data` if `format` was given. Prefer that when present.
  if (reply.data && Array.isArray(reply.data.scores)) {
    return sanitize(reply.data.scores);
  }
  const text = extractText(reply);
  if (!text) return [];
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) return [];
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    if (Array.isArray(parsed?.scores)) return sanitize(parsed.scores);
  } catch { /* fall through */ }
  return [];
}

function sanitize(scores) {
  return scores
    .filter(s => s && Number.isInteger(s.index) && Number.isFinite(s.score))
    .map(s => ({ index: s.index, score: Math.max(0, Math.min(10, s.score)) }));
}

function extractText(reply) {
  if (typeof reply === 'string') return reply;
  if (typeof reply.text === 'string') return reply.text;
  if (typeof reply.content === 'string') return reply.content;
  if (Array.isArray(reply.content)) {
    return reply.content
      .filter(b => b && (b.type === 'text' || typeof b.text === 'string'))
      .map(b => b.text ?? '').join('');
  }
  if (reply.message?.content) return reply.message.content;
  if (reply.choices?.[0]?.message?.content) return reply.choices[0].message.content;
  return '';
}

module.exports = { llmRerank, DEFAULT_BATCH_SIZE };
