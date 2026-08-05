// Default per-model pricing table. Prices are USD per 1,000,000 tokens
// (industry-standard billing unit as of 2026). Numbers are current as of
// 2026-08-04 based on the provider price pages; consumers should override
// via `usageMetering({ pricing: {...} })` for any model they care about
// with more precision (contract discounts, region variance, etc.).
//
// A missing model entry means "cost unknown" — the middleware still counts
// tokens for that request, but records $0 for it. Callers can spot-check
// `summary().byModel` for entries with cost=0 to catch missing pricing.

const DEFAULT_PRICING = {
  // ---- Anthropic (via direct API and Bedrock) ------------------------
  'claude-opus-4-7':     { input: 15,   output: 75 },
  'claude-sonnet-4-6':   { input: 3,    output: 15 },
  'claude-sonnet-4-7':   { input: 3,    output: 15 },
  'claude-haiku-4-5':    { input: 0.80, output: 4 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output: 4 },
  // Bedrock model-id forms — same prices, different string
  'anthropic.claude-opus-4-20250514-v1:0':   { input: 15,   output: 75 },
  'anthropic.claude-sonnet-4-20250514-v1:0': { input: 3,    output: 15 },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3,  output: 15 },
  'anthropic.claude-3-5-haiku-20241022-v1:0':  { input: 0.80, output: 4 },

  // ---- OpenAI (chat) --------------------------------------------------
  'gpt-4o':          { input: 5,    output: 20 },
  'gpt-4o-mini':     { input: 0.15, output: 0.60 },
  'gpt-4-turbo':     { input: 10,   output: 30 },
  'o1':              { input: 15,   output: 60 },
  'o1-mini':         { input: 3,    output: 12 },
  'o3-mini':         { input: 1.10, output: 4.40 },

  // ---- OpenAI (embeddings — cost is per input token only) -------------
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.10, output: 0 },

  // ---- Google Gemini (paid tier; free tier is free) -------------------
  'gemini-1.5-pro':   { input: 1.25,  output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10,  output: 0.40 },
  'gemini-2.0-pro':   { input: 1.25,  output: 5 },
  'text-embedding-004': { input: 0.15, output: 0 },

  // ---- Groq (rough estimates — check https://groq.com/pricing) --------
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':      { input: 0.24, output: 0.24 },

  // ---- Fireworks (per fireworks.ai/pricing as of 2026-08) -------------
  'accounts/fireworks/models/llama-v3p3-70b-instruct':  { input: 0.90, output: 0.90 },
  'accounts/fireworks/models/llama-v3p1-70b-instruct':  { input: 0.90, output: 0.90 },
  'accounts/fireworks/models/qwen2p5-72b-instruct':     { input: 0.90, output: 0.90 },
  'accounts/fireworks/models/deepseek-v3':              { input: 0.90, output: 0.90 },
  'accounts/fireworks/models/mixtral-8x22b-instruct':   { input: 1.20, output: 1.20 },
  'nomic-ai/nomic-embed-text-v1.5':                     { input: 0.008, output: 0 },

  // ---- DeepSeek (per platform.deepseek.com/api-docs/pricing as of 2026-08)
  'deepseek-chat':     { input: 0.27, output: 1.10 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },

  // ---- Mistral (per mistral.ai/pricing as of 2026-08) -----------------
  'mistral-large-latest':  { input: 2,    output: 6 },
  'mistral-large-2411':    { input: 2,    output: 6 },
  'mistral-small-latest':  { input: 0.20, output: 0.60 },
  'codestral-latest':      { input: 0.30, output: 0.90 },
  'mistral-embed':         { input: 0.10, output: 0 },

  // ---- Bedrock (non-Claude) -------------------------------------------
  'amazon.nova-pro-v1:0':       { input: 0.80, output: 3.20 },
  'amazon.nova-lite-v1:0':      { input: 0.06, output: 0.24 },
  'amazon.nova-micro-v1:0':     { input: 0.035, output: 0.14 },
  'meta.llama3-70b-instruct-v1:0':  { input: 2.65, output: 3.50 },
  'meta.llama3-8b-instruct-v1:0':   { input: 0.30, output: 0.60 },
  'mistral.mistral-large-2402-v1:0': { input: 4,   output: 12 },
  'amazon.titan-embed-text-v2:0':   { input: 0.02, output: 0 },
  'cohere.embed-english-v3':        { input: 0.10, output: 0 },
  'cohere.embed-multilingual-v3':   { input: 0.10, output: 0 },

  // ---- Azure OpenAI (deployment IDs vary per customer; users usually
  // ---- override with their own pricing map. Keeping this empty here.) -

  // ---- Ollama (local — always free) -----------------------------------
  // Ollama models have no cost. Explicitly listed here at $0 so that
  // consumers overriding a specific model don't accidentally hit the
  // "unknown model" path. Common ones only; others fall through to $0.
  'qwen2.5:14b':        { input: 0, output: 0 },
  'llama3.2':           { input: 0, output: 0 },
  'llama3.2:3b':        { input: 0, output: 0 },
  'nomic-embed-text':   { input: 0, output: 0 },
};

module.exports = { DEFAULT_PRICING };
