/**
 * RAG (retrieval-augmented generation) glue between a VectorStore and an
 * `@saptarishi/cds-plugin-llm` LLMService.
 *
 *   const rag = new RAG({ llm, store });
 *   const { answer, hits } = await rag.answer({ query: 'refund policy?' });
 *
 * Design principles:
 *  - Hits are ALWAYS returned alongside the answer — the whole point of RAG
 *    is that the caller can cite. There is no `answer`-only shape.
 *  - The default prompt tells the model to cite by hit id, so a UI can
 *    highlight the source paragraph in the retrieved chunk.
 *  - Zero new dependencies. `RAG` composes `store.search()` +
 *    `llm.chat()/stream()` and nothing else.
 */
class RAG {
  constructor(options = {}) {
    const { llm, store, systemInstructions, promptTemplate, mode, rerank } = options;
    if (!llm || typeof llm.chat !== 'function') {
      throw new Error('RAG requires an `llm` option — an LLMService with a chat() method.');
    }
    if (!store || typeof store.search !== 'function') {
      throw new Error(
        'RAG requires a `store` option — a VectorStore instance (SqliteVectorStore, ' +
        'HanaVectorStore, or any object with search()).'
      );
    }
    if (mode !== undefined && mode !== 'vector' && mode !== 'hybrid') {
      throw new Error(`RAG: mode must be 'vector' or 'hybrid' (got ${JSON.stringify(mode)})`);
    }
    if (rerank !== undefined && typeof rerank !== 'function') {
      throw new Error('RAG: rerank must be a function (hits, query) => Promise<hits> — or omit it.');
    }
    this.llm = llm;
    this.store = store;
    this.systemInstructions = systemInstructions ?? DEFAULT_SYSTEM_INSTRUCTIONS;
    this.promptTemplate = promptTemplate ?? defaultPromptTemplate;
    this.mode = mode ?? 'vector';
    this.rerank = rerank ?? null;
  }

  async retrieve({ query, topK = 5, filter, mode } = {}) {
    if (typeof query !== 'string' || query.length === 0) {
      throw new Error('retrieve() requires { query: non-empty string }');
    }
    const effectiveMode = mode ?? this.mode;
    let hits;
    if (effectiveMode === 'hybrid') {
      if (typeof this.store.hybridSearch !== 'function') {
        throw new Error(
          "RAG: mode='hybrid' requires a VectorStore with a hybridSearch() method (added in " +
          "cds-plugin-vector-hana 0.8.0). Older stores fall back with mode='vector'.",
        );
      }
      hits = await this.store.hybridSearch({ text: query, topK, filter });
    } else {
      hits = await this.store.search({ text: query, topK, filter });
    }
    if (this.rerank) {
      hits = await this.rerank(hits, query);
      // Rerankers are expected to return hits in the desired final order —
      // trim to topK in case they return more (some LLM rerankers over-fetch).
      if (Array.isArray(hits) && hits.length > topK) hits = hits.slice(0, topK);
    }
    return hits ?? [];
  }

  /**
   * Build the `{ system, messages }` payload for llm.chat() given a query and
   * a set of hits. Separate from `answer()` so callers can inspect / modify
   * the prompt before sending (e.g., append conversation history).
   */
  augment({ query, hits, systemInstructions } = {}) {
    if (typeof query !== 'string' || query.length === 0) {
      throw new Error('augment() requires { query: non-empty string }');
    }
    if (!Array.isArray(hits)) {
      throw new Error('augment() requires { hits: SearchHit[] }');
    }
    const sys = systemInstructions ?? this.systemInstructions;
    const contextBlock = this.promptTemplate(hits);
    return {
      system: sys,
      messages: [
        { role: 'user', content: `${contextBlock}\n\nQuestion: ${query}` },
      ],
    };
  }

  async answer(params = {}) {
    const { query, topK, filter, systemInstructions, mode, ...chatOpts } = params;
    const hits = await this.retrieve({ query, topK, filter, mode });
    const { system, messages } = this.augment({ query, hits, systemInstructions });
    const reply = await this.llm.chat({ ...chatOpts, system, messages });
    return { answer: extractText(reply), hits, raw: reply };
  }

  /**
   * Streaming RAG. Returns `{ hits, stream }` — `hits` resolves BEFORE the
   * first token so the UI can render citations while the answer streams in.
   * `stream` is the same async iterable that `llm.stream()` returns.
   */
  async stream(params = {}) {
    if (typeof this.llm.stream !== 'function') {
      throw new Error('RAG.stream() requires an LLMService with a stream() method.');
    }
    const { query, topK, filter, systemInstructions, mode, ...chatOpts } = params;
    const hits = await this.retrieve({ query, topK, filter, mode });
    const { system, messages } = this.augment({ query, hits, systemInstructions });
    return { hits, stream: this.llm.stream({ ...chatOpts, system, messages }) };
  }
}

const DEFAULT_SYSTEM_INSTRUCTIONS =
  'You are a helpful assistant that answers questions using ONLY the provided context. ' +
  'If the answer is not in the context, reply that you do not know — do not make up facts. ' +
  'Cite the sources you used with their bracketed id, e.g. [doc_42].';

function defaultPromptTemplate(hits) {
  if (!hits.length) return '<context>\n(no relevant sources found)\n</context>';
  const lines = ['<context>'];
  for (const h of hits) {
    const meta = h.metadata && Object.keys(h.metadata).length
      ? ` (metadata: ${JSON.stringify(h.metadata)})`
      : '';
    lines.push(`[${h.id}]${meta}: ${h.text}`);
  }
  lines.push('</context>');
  return lines.join('\n');
}

// LLMService.chat() returns provider-specific reply shapes. This normalizes
// the most common ones to a plain string so ordinary callers can just print
// the answer without knowing which backend they hit. Raw reply is still
// exposed on { raw } for callers that need the full envelope.
function extractText(reply) {
  if (!reply) return '';
  if (typeof reply === 'string') return reply;
  if (typeof reply.text === 'string') return reply.text;
  if (typeof reply.content === 'string') return reply.content;
  if (Array.isArray(reply.content)) {
    return reply.content
      .filter(b => b && (b.type === 'text' || typeof b.text === 'string'))
      .map(b => b.text ?? '')
      .join('');
  }
  if (reply.message && typeof reply.message.content === 'string') {
    return reply.message.content;
  }
  if (reply.choices?.[0]?.message?.content) return reply.choices[0].message.content;
  return '';
}

module.exports = RAG;
module.exports.defaultPromptTemplate = defaultPromptTemplate;
module.exports.DEFAULT_SYSTEM_INSTRUCTIONS = DEFAULT_SYSTEM_INSTRUCTIONS;
