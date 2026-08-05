// Query-side expansion for RAG. Two strategies:
//
//   - 'hyde'        — Hypothetical Document Embeddings. The LLM writes a
//                     short passage that would answer the question, then
//                     BOTH the question and the hypothetical answer are
//                     embedded + retrieved on. Works because a plausible
//                     answer clusters near real source documents in
//                     embedding space, even when the question doesn't.
//                     Boosts recall on abstract / under-specified queries.
//
//   - 'multi-query' — Ask the LLM to generate N paraphrases of the query,
//                     each a different angle. Retrieve for each, fuse via
//                     RRF. Boosts recall on ambiguous queries by covering
//                     multiple phrasings the user might not have used.
//
// Usage — standalone:
//   const expand = createQueryExpander({ llm, strategy: 'hyde' });
//   const queries = await expand('refund policy?');  // [original, hypothetical]
//
// Usage — inside RAG:
//   new RAG({ llm, store, expand: createQueryExpander({ llm, strategy: 'hyde' }) });
//   // rag.retrieve runs each expanded query through the store, fuses via
//   // RRF, then (optionally) runs the reranker on the fused list.
//
// Robust to LLM failures — any error returns `[query]` (identity) so the
// expander never regresses the retrieval quality below "no expansion".
// Nothing worse than the baseline ever ships.

const DEFAULT_HYDE_SYSTEM = `You write plausible short passages that would answer a user's question.
Do not hedge, explain, or refuse. Write the passage confidently, in the third person, using the vocabulary a corporate/business document would use. Under 100 words. No preamble.`;

const DEFAULT_MULTI_QUERY_SYSTEM = `You paraphrase a user's question into N distinct reformulations.
Each paraphrase covers a different angle or vocabulary — synonyms, related concepts, alternate phrasings. Return one paraphrase per line, no numbering, no preamble, no explanation. Exactly N lines.`;

function createQueryExpander(options = {}) {
  const {
    llm,
    strategy = 'hyde',
    n = 3,
    model,
    maxTokens = 200,
    systemInstructions,
    buildUserPrompt,
  } = options;

  if (!llm || typeof llm.chat !== 'function') {
    throw new Error('createQueryExpander: `llm` option required — must be an LLMService with chat().');
  }
  if (strategy !== 'hyde' && strategy !== 'multi-query') {
    throw new Error(`createQueryExpander: strategy must be 'hyde' or 'multi-query' (got '${strategy}').`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`createQueryExpander: n must be a positive integer (got ${n}).`);
  }

  const sys = systemInstructions ?? (strategy === 'hyde' ? DEFAULT_HYDE_SYSTEM : DEFAULT_MULTI_QUERY_SYSTEM);
  const buildPrompt = buildUserPrompt ?? (strategy === 'hyde' ? defaultHydePrompt : defaultMultiQueryPrompt);

  return async function expand(query) {
    if (typeof query !== 'string' || query.length === 0) return [];
    const userPrompt = buildPrompt({ query, n });
    let reply;
    try {
      const req = {
        system: sys,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens,
      };
      if (model) req.model = model;
      reply = await llm.chat(req);
    } catch {
      return [query]; // fall back to original query — never regress
    }
    const text = extractText(reply);
    if (!text || !text.trim()) return [query];

    if (strategy === 'hyde') {
      return [query, text.trim()];
    }
    // multi-query: split into non-empty lines, take up to N
    const lines = text
      .split(/\r?\n/)
      .map(l => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim()) // strip bullets/numbering
      .filter(l => l.length > 0)
      .slice(0, n);
    if (lines.length === 0) return [query];
    return [query, ...lines];
  };
}

function defaultHydePrompt({ query }) {
  return `Question: ${query}\n\nWrite the short passage now.`;
}

function defaultMultiQueryPrompt({ query, n }) {
  return `Question: ${query}\n\nWrite ${n} distinct paraphrases, one per line.`;
}

function extractText(reply) {
  if (!reply) return '';
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

module.exports = { createQueryExpander };
