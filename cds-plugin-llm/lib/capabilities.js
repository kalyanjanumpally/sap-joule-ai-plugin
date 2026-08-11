// Provider capability probe. Introspects a live LLMService and
// reports what features actually work against the configured
// provider + model. Fills the "which providers support what"
// matrix without hand-maintained tables.
//
// Two modes:
//
//   * Static probe (default) — reads only class shape (which _batch*
//     methods are overridden), the provider's `kind` on the CDS
//     options, and the configured modelId. Fast, no network calls,
//     safe to call at boot. Uses shipped constants for the
//     provider-family capability matrix.
//
//   * Live probe (`live: true`) — additionally issues small
//     verification calls: 1-token chat to verify the model is
//     reachable; single-embedding call to verify embed; a schema-
//     mode chat with format to verify structured output; a vision
//     probe when the model looks vision-capable. Each live check
//     has its own timeout + soft-fail (reports the probe result,
//     doesn't throw).
//
//   const { capabilities } = require('@saptarishi/cds-plugin-llm');
//   const caps = await capabilities(llm);
//   // {
//   //   provider: 'anthropic',
//   //   model:    'claude-opus-4-7',
//   //   chat:     true,
//   //   stream:   true,
//   //   embed:    false,
//   //   batch:    true,
//   //   vision:   true,
//   //   pdf:      true,
//   //   audio:    false,
//   //   tools:    true,
//   //   structuredOutput: true,
//   //   promptCache:      true,
//   //   maxContextTokens: 200_000,
//   //   maxOutputTokens:  4096,
//   // }
//
// Composes with modelRouter (1.81): route requests to the FIRST
// service whose `capabilities` say it supports the feature.

// ---- Provider-family capability matrix ------------------------------
//
// Sourced from public docs as of 2026-08. Kept in one place so the
// per-family assumptions are auditable and version-stable. Live
// probing can override any of these with an actual measurement.

const PROVIDER_MATRIX = Object.freeze({
  anthropic: {
    chat: true, stream: true, embed: false, batch: true,
    vision: true, pdf: true, audio: false, tools: true,
    structuredOutput: true,   // via `format:` schema
    promptCache: true,
    maxContextTokens: 200_000,
    maxOutputTokens:  8192,
  },
  'openai-compatible': {
    chat: true, stream: true, embed: true, batch: true,
    vision: true, pdf: true, audio: true, tools: true,
    structuredOutput: true,
    promptCache: true,        // auto for gpt-4o family
    maxContextTokens: 128_000,
    maxOutputTokens:  16_384,
  },
  'azure-openai': {
    chat: true, stream: true, embed: true, batch: false,
    vision: true, pdf: false, audio: true, tools: true,
    structuredOutput: true,
    promptCache: true,
    maxContextTokens: 128_000,
    maxOutputTokens:  4096,
  },
  groq: {
    chat: true, stream: true, embed: false, batch: false,
    vision: true, pdf: false, audio: false, tools: true,
    structuredOutput: true,
    promptCache: false,
    maxContextTokens: 32_768,
    maxOutputTokens:  8192,
  },
  deepseek: {
    chat: true, stream: true, embed: false, batch: false,
    vision: false, pdf: false, audio: false, tools: true,
    structuredOutput: true,
    promptCache: true,
    maxContextTokens: 64_000,
    maxOutputTokens:  8192,
  },
  fireworks: {
    chat: true, stream: true, embed: false, batch: false,
    vision: true, pdf: false, audio: false, tools: true,
    structuredOutput: true,
    promptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens:  4096,
  },
  mistral: {
    chat: true, stream: true, embed: true, batch: false,
    vision: false, pdf: false, audio: false, tools: true,
    structuredOutput: true,
    promptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens:  8192,
  },
  gemini: {
    chat: true, stream: true, embed: true, batch: false,
    vision: true, pdf: true, audio: true, tools: true,
    structuredOutput: true,
    promptCache: true,        // via context caching
    maxContextTokens: 1_000_000,
    maxOutputTokens:  8192,
  },
  bedrock: {
    chat: true, stream: true, embed: true, batch: false,
    vision: true, pdf: true, audio: false, tools: true,
    structuredOutput: true,
    promptCache: true,        // for Anthropic models on Bedrock
    maxContextTokens: 200_000,
    maxOutputTokens:  8192,
  },
  ollama: {
    chat: true, stream: true, embed: true, batch: false,
    vision: true, pdf: false, audio: false, tools: true,
    structuredOutput: true,
    promptCache: false,
    maxContextTokens: 128_000,   // depends on the pulled model
    maxOutputTokens:  8192,
  },
  'genai-hub': {
    chat: true, stream: true, embed: true, batch: false,
    vision: true, pdf: false, audio: false, tools: true,
    structuredOutput: true,
    promptCache: true,
    maxContextTokens: 128_000,
    maxOutputTokens:  4096,
  },
});

// ---- Model-family overrides -----------------------------------------
//
// A few model IDs deviate from their provider's family defaults —
// e.g. Claude Haiku has smaller output caps than Sonnet; older gpt-3.5
// caps are 16k not 128k; embedding models don't do chat. Kept
// deliberately short and additive; live probing overrides.

const MODEL_OVERRIDES = Object.freeze({
  // Embedding models — chat/stream/tools all false
  'text-embedding-3-small': { chat: false, stream: false, tools: false, structuredOutput: false, vision: false, pdf: false, audio: false, maxOutputTokens: 0 },
  'text-embedding-3-large': { chat: false, stream: false, tools: false, structuredOutput: false, vision: false, pdf: false, audio: false, maxOutputTokens: 0 },
  'text-embedding-ada-002': { chat: false, stream: false, tools: false, structuredOutput: false, vision: false, pdf: false, audio: false, maxOutputTokens: 0 },
  'text-embedding-004':     { chat: false, stream: false, tools: false, structuredOutput: false, vision: false, pdf: false, audio: false, maxOutputTokens: 0 },
  'nomic-embed-text':       { chat: false, stream: false, tools: false, structuredOutput: false, vision: false, pdf: false, audio: false, maxOutputTokens: 0 },
  // Haiku output cap
  'claude-haiku-4-5':          { maxOutputTokens: 4096 },
  'claude-3-5-haiku-20241022': { maxOutputTokens: 4096 },
  // Older gpt-3.5 context
  'gpt-3.5-turbo':      { maxContextTokens: 16_385 },
  // GPT-4o vision + audio native
  'gpt-4o-audio-preview': { audio: true },
});

// ---- Detection helpers ----------------------------------------------

/**
 * Best-effort detection of the provider "family" from an LLMService
 * instance. Reads:
 *   - options.kind      (set by CDS profile-based configuration)
 *   - constructor.name  (each provider ships a distinctly-named class)
 *   - the shipped `kind` slug when neither is present
 */
function detectFamily(llm, matrix = PROVIDER_MATRIX) {
  const kind = llm?.options?.kind ?? llm?.kind ?? null;
  if (typeof kind === 'string') {
    // "llm-anthropic" → "anthropic"
    const stripped = kind.startsWith('llm-') ? kind.slice(4) : kind;
    if (matrix[stripped]) return stripped;
  }
  const cname = llm?.constructor?.name;
  if (typeof cname === 'string') {
    const known = {
      AnthropicLLMService:        'anthropic',
      OpenAICompatibleLLMService: 'openai-compatible',
      AzureOpenAILLMService:      'azure-openai',
      GroqLLMService:             'groq',
      DeepSeekLLMService:         'deepseek',
      FireworksLLMService:        'fireworks',
      MistralLLMService:          'mistral',
      GeminiLLMService:           'gemini',
      BedrockLLMService:          'bedrock',
      OllamaLLMService:           'ollama',
      GenAIHubLLMService:         'genai-hub',
    };
    if (known[cname]) return known[cname];
  }
  return null;
}

/** Returns the effective modelId — respects options.modelId if set. */
function detectModel(llm) {
  return llm?.modelId
    ?? llm?.options?.modelId
    ?? llm?.options?.model
    ?? null;
}

/** True when batch(*) will succeed structurally — provider overrode _batchSubmit. */
function detectBatchOverride(llm) {
  if (!llm) return false;
  const proto = Object.getPrototypeOf(llm);
  if (!proto) return false;
  // The base class defines `_batchSubmit` which throws. If the instance
  // has any prototype in its chain that overrides it, batch works.
  let cur = proto;
  while (cur && cur !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(cur, '_batchSubmit')) {
      // If we're on a subclass prototype (not LLMService.prototype), batch is overridden.
      if (cur.constructor?.name !== 'LLMService') return true;
      break;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return false;
}

// ---- Live probe helpers ---------------------------------------------

async function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function safeProbe(fn, label, timeoutMs) {
  try {
    await withTimeout(fn(), timeoutMs, label);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ---- Main API --------------------------------------------------------

/**
 * Probe an LLMService for its capabilities.
 *
 * @param llm — an LLMService instance (created via cds.connect.to('llm')
 *              or a direct subclass instantiation).
 * @param opts
 * @param opts.live     — Boolean. If true, issue small verification
 *                        calls to confirm the static assumptions.
 *                        Each check has its own timeout + soft-fail.
 *                        Default false.
 * @param opts.timeoutMs — per-probe cap in ms. Default 8000.
 * @param opts.probes   — Which live checks to run. Default all of:
 *                        ['chat', 'embed', 'structuredOutput'].
 * @param opts.matrix   — Override the provider matrix (advanced).
 */
async function capabilities(llm, opts = {}) {
  if (!llm) throw new Error('capabilities: llm is required.');

  const {
    live         = false,
    timeoutMs    = 8000,
    probes       = ['chat', 'embed', 'structuredOutput'],
    matrix       = PROVIDER_MATRIX,
    modelOverrides = MODEL_OVERRIDES,
  } = opts;

  const family = detectFamily(llm, matrix);
  const model  = detectModel(llm);
  const base   = family && matrix[family] ? { ...matrix[family] } : {
    chat: false, stream: false, embed: false, batch: false,
    vision: false, pdf: false, audio: false, tools: false,
    structuredOutput: false, promptCache: false,
    maxContextTokens: null, maxOutputTokens: null,
  };
  const modelPatch = model && modelOverrides[model] ? modelOverrides[model] : null;

  const caps = {
    provider: family,
    model,
    ...base,
    ...(modelPatch ?? {}),
    batch: detectBatchOverride(llm) && base.batch !== false,
    live: {
      ran: live,
      probes: [],
    },
  };

  if (!live) return caps;

  // ---- Live probes ---------------------------------------------------

  const results = {};

  if (probes.includes('chat') && caps.chat) {
    const r = await safeProbe(
      () => llm.chat({
        messages: [{ role: 'user', content: 'ok' }],
        maxTokens: 8,
      }),
      'chat probe', timeoutMs,
    );
    results.chat = r;
    if (!r.ok) caps.chat = false;
  }
  if (probes.includes('embed') && caps.embed) {
    const r = await safeProbe(
      () => llm.embed({ input: ['probe'] }),
      'embed probe', timeoutMs,
    );
    results.embed = r;
    if (!r.ok) caps.embed = false;
  }
  if (probes.includes('structuredOutput') && caps.structuredOutput && caps.chat) {
    const r = await safeProbe(
      () => llm.chat({
        messages: [{ role: 'user', content: 'Reply with JSON {"ok": true}.' }],
        maxTokens: 32,
        format: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      }),
      'structuredOutput probe', timeoutMs,
    );
    results.structuredOutput = r;
    if (!r.ok) caps.structuredOutput = false;
  }
  // tools probe — quick sanity check with an unused tool
  if (probes.includes('tools') && caps.tools && caps.chat) {
    const r = await safeProbe(
      () => llm.chat({
        messages: [{ role: 'user', content: 'Just say hi. Do not call the tool.' }],
        maxTokens: 16,
        tools: [{
          name:        'unused_tool',
          description: 'A tool the model should not call for this prompt.',
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      }),
      'tools probe', timeoutMs,
    );
    results.tools = r;
    if (!r.ok) caps.tools = false;
  }

  caps.live.probes = Object.entries(results).map(([name, r]) => ({
    name, ok: r.ok, error: r.error,
  }));

  return caps;
}

module.exports = {
  capabilities,
  PROVIDER_MATRIX,
  MODEL_OVERRIDES,
  // Exposed for tests + advanced composition
  detectFamily,
  detectModel,
  detectBatchOverride,
};
