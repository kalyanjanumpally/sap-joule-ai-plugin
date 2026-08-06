// Peer-optional tokenizer bridge for the cost-predict CLI (and any consumer
// who wants precise token counts). Real tokenizers when installed; deferred
// require() so the plugin's install size stays tiny for the 99% of users who
// only need the char/token heuristic.
//
// Detection order (per model family):
//   OpenAI / Groq / DeepSeek / Mistral / Fireworks / Azure OpenAI:
//     tiktoken → js-tiktoken → heuristic
//   Anthropic:
//     @anthropic-ai/tokenizer → tiktoken cl100k_base → heuristic
//   Others (Gemini / Llama-on-Groq / Bedrock non-Anthropic):
//     heuristic
//
// Results are memoized per (encoder, model) pair for speed on large batches.
// The `heuristic` fallback matches the char/token factors shipped in
// cost-predict since 1.33.0 so switching modes doesn't spike variance.

const CHARS_PER_TOKEN = {
  default:  4.0,
  claude:   3.5,
  gpt:      4.0,
  llama:    4.2,
  mistral:  4.1,
  gemini:   4.0,
  qwen:     3.2,
  deepseek: 3.8,
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

function isOpenAIFamily(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  return m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
}
function isAnthropicFamily(model) {
  return typeof model === 'string' && model.toLowerCase().includes('claude');
}

// Lazy singletons — remembered across calls so we only pay the WASM boot
// cost once per process. `undefined` = not tried yet; `null` = unavailable.
let _tiktoken;      // real `tiktoken` (WASM)
let _jsTiktoken;    // pure-JS `js-tiktoken`
let _anthropicTok;  // `@anthropic-ai/tokenizer`

function tryLoadTiktoken() {
  if (_tiktoken !== undefined) return _tiktoken;
  try { _tiktoken = require('tiktoken'); }
  catch { _tiktoken = null; }
  return _tiktoken;
}
function tryLoadJsTiktoken() {
  if (_jsTiktoken !== undefined) return _jsTiktoken;
  try { _jsTiktoken = require('js-tiktoken'); }
  catch { _jsTiktoken = null; }
  return _jsTiktoken;
}
function tryLoadAnthropicTokenizer() {
  if (_anthropicTok !== undefined) return _anthropicTok;
  try { _anthropicTok = require('@anthropic-ai/tokenizer'); }
  catch { _anthropicTok = null; }
  return _anthropicTok;
}

/**
 * Pick the best available tokenizer for a given model. Returns
 * `{ name, countTokens(text) }`.
 *
 * `name` values: 'tiktoken' | 'js-tiktoken' | 'anthropic-tokenizer' | 'heuristic'.
 */
function getTokenizer(model) {
  if (isOpenAIFamily(model)) {
    const tt = tryLoadTiktoken();
    if (tt) {
      const enc = safeEncFor(tt, model);
      if (enc) return { name: 'tiktoken', countTokens: (t) => enc.encode(t ?? '').length };
    }
    const jstt = tryLoadJsTiktoken();
    if (jstt) {
      const enc = safeJsEncFor(jstt, model);
      if (enc) return { name: 'js-tiktoken', countTokens: (t) => enc.encode(t ?? '').length };
    }
  }
  if (isAnthropicFamily(model)) {
    const at = tryLoadAnthropicTokenizer();
    if (at && typeof at.countTokens === 'function') {
      return { name: 'anthropic-tokenizer', countTokens: at.countTokens };
    }
    // Fallback for Claude when only tiktoken is available — cl100k_base is a
    // reasonable approximation (Anthropic's older tokenizer was BPE too).
    const tt = tryLoadTiktoken();
    if (tt && typeof tt.get_encoding === 'function') {
      try {
        const enc = tt.get_encoding('cl100k_base');
        return { name: 'tiktoken', countTokens: (t) => enc.encode(t ?? '').length };
      } catch { /* fall through */ }
    }
  }
  return {
    name: 'heuristic',
    countTokens: (t) => (t ? Math.ceil(t.length / charsPerTokenFor(model)) : 0),
  };
}

function safeEncFor(tt, model) {
  if (typeof tt.encoding_for_model === 'function') {
    try { return tt.encoding_for_model(model); } catch { /* unknown model */ }
  }
  if (typeof tt.get_encoding === 'function') {
    try { return tt.get_encoding('cl100k_base'); } catch { /* not available */ }
  }
  return null;
}
function safeJsEncFor(jstt, model) {
  // js-tiktoken (Node port) exposes `encodingForModel` or `getEncoding`.
  if (typeof jstt.encodingForModel === 'function') {
    try { return jstt.encodingForModel(model); } catch { /* unknown model */ }
  }
  if (typeof jstt.getEncoding === 'function') {
    try { return jstt.getEncoding('cl100k_base'); } catch { /* not available */ }
  }
  return null;
}

/**
 * Reset the internal tokenizer cache. Useful in tests that swap the
 * available peer deps between runs.
 */
function _resetCache() { _tiktoken = _jsTiktoken = _anthropicTok = undefined; }

module.exports = { getTokenizer, charsPerTokenFor, _resetCache };
