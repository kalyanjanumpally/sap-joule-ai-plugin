// RAG orchestration helper. Encapsulates the retrieve → dedupe →
// rerank → truncate → answer pattern that every RAG action ends
// up reimplementing. One-liner for the common case; slots for
// query expansion, reranking, and custom prompts when you need
// them.
//
//   const { ragChain } = require('@saptarishi/cds-plugin-llm');
//
//   const ask = ragChain({
//     llm,                                    // for the final answer
//     retriever:  async (q, { topK }) => vec.search(q, { topK }),
//     reranker:   async (q, chunks) => llmRerank(q, chunks),   // optional
//     queryExpander: createQueryExpander({ llm }),             // optional
//     maxChunks:       6,
//     maxCharsPerChunk: 1500,
//   });
//
//   const { answer, chunks, usage } = await ask('What are the payment terms in CTR-2026-101?', {
//     topK: 12,
//     filter: { region: 'EMEA' },
//   });
//
// Returns:
//   {
//     answer:         string,     // the LLM's final answer
//     chunks:         [...],      // chunks used (after rerank + truncation)
//     retrievedCount: number,     // total retrieved BEFORE dedupe
//     dedupedCount:   number,     // after dedupe (before rerank + truncation)
//     queriesUsed:    string[],   // original + expanded queries
//     usage:          {...},      // LLM usage counters
//     model:          string,
//   }

const DEFAULT_RAG_SYSTEM = `You are a research assistant. Answer the user's question using ONLY the provided context.
Rules:
- Cite specific facts by their [chunk number] in the context.
- If the context does not contain the answer, say "The provided context does not answer this question." — do NOT invent facts.
- Keep the answer to 2-4 sentences unless the user asks for more.
- Never repeat the context verbatim; synthesize.`;

function defaultTemplate({ question, context }) {
  return `QUESTION:\n${question}\n\nCONTEXT (numbered chunks, use these citations in your answer):\n${context}\n\nAnswer using ONLY the provided context.`;
}

function formatChunksForPrompt(chunks) {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.text}`)
    .join('\n\n');
}

/**
 * Build the ask() function for a retrieve → rerank → answer pipeline.
 */
function ragChain(options = {}) {
  const {
    llm,
    chat: chatFn,
    retriever,
    reranker         = null,
    queryExpander    = null,
    systemPrompt     = DEFAULT_RAG_SYSTEM,
    template         = defaultTemplate,
    defaultTopK      = 8,
    maxChunks        = 5,
    maxCharsPerChunk = 1500,
    defaultMaxTokens = 1000,
    onEmptyRetrieval = 'error',
  } = options;

  if (typeof retriever !== 'function') {
    throw new Error('ragChain: retriever must be a function (query, opts) => Chunk[].');
  }
  const chat = chatFn ?? (llm && typeof llm.chat === 'function' ? llm.chat.bind(llm) : null);
  if (typeof chat !== 'function') {
    throw new Error('ragChain: pass either { llm } (LLMService) or { chat } (function).');
  }
  if (reranker != null && typeof reranker !== 'function') {
    throw new Error('ragChain: reranker must be a function or null.');
  }
  if (queryExpander != null && typeof queryExpander !== 'function') {
    throw new Error('ragChain: queryExpander must be a function or null.');
  }
  if (typeof template !== 'function') {
    throw new Error('ragChain: template must be a function ({question, context, chunks}) => string.');
  }
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new Error(`ragChain: maxChunks must be a positive integer (got ${maxChunks}).`);
  }
  if (!Number.isInteger(maxCharsPerChunk) || maxCharsPerChunk < 1) {
    throw new Error(`ragChain: maxCharsPerChunk must be a positive integer (got ${maxCharsPerChunk}).`);
  }
  if (typeof onEmptyRetrieval !== 'function'
      && onEmptyRetrieval !== 'error' && onEmptyRetrieval !== 'answer-anyway') {
    throw new Error(`ragChain: onEmptyRetrieval must be 'error' | 'answer-anyway' | function (got ${JSON.stringify(onEmptyRetrieval)}).`);
  }

  return async function ask(question, opts = {}) {
    if (typeof question !== 'string' || question.length === 0) {
      throw new Error('ragChain: question must be a non-empty string.');
    }
    const topK = opts.topK ?? defaultTopK;
    const filter = opts.filter;
    const maxTokens = opts.maxTokens ?? defaultMaxTokens;

    // 1. Optional query expansion.
    let queries = [question];
    if (queryExpander) {
      const expanded = await queryExpander(question);
      queries = Array.isArray(expanded) && expanded.length > 0 ? expanded : [question];
    }

    // 2. Retrieve for each query.
    let allChunks = [];
    for (const q of queries) {
      const chunks = await retriever(q, { topK, filter });
      if (Array.isArray(chunks)) allChunks = allChunks.concat(chunks);
    }
    const retrievedCount = allChunks.length;

    // 3. Dedupe by id (fall back to text if id missing).
    const seen = new Set();
    const unique = [];
    for (const c of allChunks) {
      if (!c || typeof c !== 'object') continue;
      const key = c.id != null ? String(c.id) : (typeof c.text === 'string' ? c.text : JSON.stringify(c));
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    const dedupedCount = unique.length;

    // 4. Optional rerank.
    let ranked = unique;
    if (reranker && ranked.length > 0) {
      const out = await reranker(question, ranked);
      if (Array.isArray(out)) ranked = out;
    }

    // 5. Truncate: cap chunk count + per-chunk text length.
    ranked = ranked.slice(0, maxChunks).map((c) => ({
      ...c,
      text: typeof c.text === 'string' ? c.text.slice(0, maxCharsPerChunk) : '',
    }));

    // 6. Empty-retrieval branch.
    if (ranked.length === 0) {
      if (typeof onEmptyRetrieval === 'function') {
        return onEmptyRetrieval(question);
      }
      if (onEmptyRetrieval === 'error') {
        const err = new Error(`ragChain: no context retrieved for "${question.slice(0, 80)}${question.length > 80 ? '…' : ''}".`);
        err.code = 'RAG_EMPTY_RETRIEVAL';
        err.question = question;
        throw err;
      }
      // onEmptyRetrieval === 'answer-anyway' → fall through with empty context.
    }

    // 7. Build prompt.
    const context = formatChunksForPrompt(ranked);
    const userContent = template({ question, context, chunks: ranked });

    // 8. LLM call.
    const res = await chat({
      system:   systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      maxTokens,
    });

    return {
      answer:         res?.text ?? '',
      chunks:         ranked,
      retrievedCount,
      dedupedCount,
      queriesUsed:    queries,
      usage:          res?.usage ?? null,
      model:          res?.model ?? null,
    };
  };
}

module.exports = {
  ragChain,
  DEFAULT_RAG_SYSTEM,
  defaultTemplate,
  formatChunksForPrompt,
};
