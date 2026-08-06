const crypto = require('node:crypto');

const DEFAULT_RETRY = { max: 3, baseMs: 500, maxMs: 20000 };
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Retryable error — throw this from a provider's _chat to signal
 * the outer retry loop that the failure is transient.
 *
 *   throw new RetryableError('rate limited', 429, retryAfterSec)
 */
class RetryableError extends Error {
  constructor(message, status, retryAfterSec) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Wrap an async fn with exponential-backoff retry.
 * Retries on RetryableError or on non-Retryable errors with matching status.
 * Honors Retry-After hint when provided.
 */
async function withRetry(fn, opts = {}) {
  const cfg = { ...DEFAULT_RETRY, ...opts };
  let attempt = 0;
  let lastErr;
  while (attempt <= cfg.max) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const status = err.status ?? err.statusCode;
      const isRetryable = err instanceof RetryableError || (status && RETRYABLE_STATUS.has(status));
      if (!isRetryable || attempt === cfg.max) throw err;

      const retryAfterMs = err.retryAfterSec ? err.retryAfterSec * 1000 : null;
      const backoffMs = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
      const jitterMs = Math.floor(Math.random() * backoffMs * 0.25);
      const waitMs = retryAfterMs ?? (backoffMs + jitterMs);

      await new Promise(r => setTimeout(r, waitMs));
      attempt++;
    }
  }
  throw lastErr;
}

/**
 * Given a Response object with a non-ok status, throw either a RetryableError
 * (for retryable statuses) or a plain Error (for permanent failures).
 * Callers should await this instead of manually branching on res.ok.
 */
async function throwFromResponse(res, providerName) {
  const body = await res.text();
  const retryAfter = res.headers.get('retry-after');
  const retryAfterSec = retryAfter ? parseFloat(retryAfter) : null;
  const message = `${providerName} ${res.status}: ${body.slice(0, 400)}`;
  if (RETRYABLE_STATUS.has(res.status)) {
    throw new RetryableError(message, res.status, retryAfterSec);
  }
  const err = new Error(message);
  err.status = res.status;
  throw err;
}

// ---------------------------------------------------------------------------
// Response caching (in-memory LRU with TTL)
// ---------------------------------------------------------------------------

/**
 * Small LRU with per-entry TTL. Insertion order via Map; on get, delete+reset
 * for LRU semantics. Not thread-safe (not needed in Node's event loop).
 */
class ResponseCache {
  constructor({ ttlMs = 5 * 60 * 1000, maxEntries = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // LRU: touch by re-inserting
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }
  set(key, value) {
    if (this.map.size >= this.maxEntries) {
      // Evict oldest (first-inserted)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
  clear() { this.map.clear(); this.hits = 0; this.misses = 0; }
  size() { return this.map.size; }
}

/**
 * Deterministic hash of a chat-request shape. Keys are sorted so equivalent
 * requests hash the same. Skips volatile fields (retries, cache).
 */
function hashChatRequest(req) {
  const stable = stableStringify({
    model: req.model,
    maxTokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    format: req.format,
    thinking: req.thinking,
  });
  return crypto.createHash('sha1').update(stable).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Image content-block helpers (vision)
// ---------------------------------------------------------------------------

const IMAGE_MEDIA_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

/**
 * Load an image from disk and return a plugin-shape image block.
 * Auto-detects media type from extension.
 *
 *   const img = await imageFromFile('/tmp/invoice.png');
 *   await llm.chat({ messages: [{ role: 'user', content: [img, { type: 'text', text: 'Extract line items' }] }] });
 */
async function imageFromFile(filePath) {
  const path = require('node:path');
  const fs = require('node:fs/promises');
  const ext = path.extname(filePath).toLowerCase();
  const media_type = IMAGE_MEDIA_TYPES[ext];
  if (!media_type) {
    throw new Error(
      `imageFromFile: unsupported extension '${ext}'. Supported: ${Object.keys(IMAGE_MEDIA_TYPES).join(', ')}`
    );
  }
  const buf = await fs.readFile(filePath);
  return {
    type: 'image',
    source: { type: 'base64', media_type, data: buf.toString('base64') },
  };
}

/**
 * Reference a remote image by URL. Works for Anthropic and OpenAI-compat.
 * Ollama does not accept URLs directly — use imageFromFile after downloading.
 */
function imageFromUrl(url) {
  return { type: 'image', source: { type: 'url', url } };
}

/**
 * Wrap raw base64 image data into a plugin-shape image block.
 * media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
 */
function imageFromBase64(base64Data, mediaType = 'image/png') {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64Data },
  };
}

// ---------------------------------------------------------------------------
// PDF document-block helpers (new in v0.8.0)
// ---------------------------------------------------------------------------

/**
 * Load a PDF from disk and return a plugin-shape document block.
 *
 *   const pdf = await pdfFromFile('/tmp/invoice.pdf');
 *   await llm.chat({
 *     model: 'claude-opus-4-7',
 *     messages: [{ role: 'user', content: [pdf, { type: 'text', text: 'Extract line items' }] }],
 *   });
 *
 * PDFs are only usable with Anthropic providers today — Claude 3.5+ has
 * native PDF understanding. OpenAI-compat + Ollama providers will throw
 * a clear error if a document block is passed.
 */
async function pdfFromFile(filePath) {
  const path = require('node:path');
  const fs = require('node:fs/promises');
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error(`pdfFromFile: expected .pdf extension, got '${ext}'`);
  }
  const buf = await fs.readFile(filePath);
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
  };
}

/** Reference a remote PDF by URL. Works with Anthropic providers. */
function pdfFromUrl(url) {
  return { type: 'document', source: { type: 'url', url } };
}

/** Wrap raw base64 PDF bytes into a plugin-shape document block. */
function pdfFromBase64(base64Data) {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: base64Data },
  };
}

// ---------------------------------------------------------------------------
// Audio content-block helpers (new in v1.36.0)
// ---------------------------------------------------------------------------
//
// Provider matrix (as of shipping):
//
//   Gemini              base64 native (inlineData with audio/*)
//   OpenAI-compat       base64 via `input_audio` content block; requires a
//                       model that speaks it (GPT-4o Audio, and OpenAI-compat
//                       gateways that mirror the shape). Others 400 upstream.
//   Anthropic           NOT supported — Claude Voice is a separate API surface.
//   Ollama              NOT supported — no audio input in vision models today.
//   Bedrock             partial (Nova has audio); other models 400 upstream.
//
// URL sources: only Gemini can reference remote audio when the URL is a
// Google Cloud Storage URI (gs://...). HTTP URLs are NOT fetched by providers
// today — download client-side and use audioFromFile / audioFromBase64.

const AUDIO_MEDIA_TYPES = {
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',        // .m4a = AAC in an MP4 container
  '.ogg':  'audio/ogg',
  '.flac': 'audio/flac',
  '.aac':  'audio/aac',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
};

/**
 * Load an audio file from disk and return a plugin-shape audio block.
 * Auto-detects media type from extension.
 *
 *   const audio = await audioFromFile('/tmp/voice-note.mp3');
 *   const { text } = await llm.chat({
 *     model: 'gemini-2.5-flash',
 *     messages: [{
 *       role: 'user',
 *       content: [audio, { type: 'text', text: 'Transcribe and extract action items.' }],
 *     }],
 *   });
 *
 * Provider support: Gemini (native), OpenAI-compat with GPT-4o Audio (input_audio
 * block). Anthropic / Ollama / most Bedrock models will throw a clear error.
 */
async function audioFromFile(filePath) {
  const path = require('node:path');
  const fs = require('node:fs/promises');
  const ext = path.extname(filePath).toLowerCase();
  const media_type = AUDIO_MEDIA_TYPES[ext];
  if (!media_type) {
    throw new Error(
      `audioFromFile: unsupported extension '${ext}'. Supported: ${Object.keys(AUDIO_MEDIA_TYPES).join(', ')}`
    );
  }
  const buf = await fs.readFile(filePath);
  return {
    type: 'audio',
    source: { type: 'base64', media_type, data: buf.toString('base64') },
  };
}

/**
 * Reference remote audio by URL.
 *
 * Google Cloud Storage URIs (gs://bucket/key.mp3) work with Gemini natively.
 * HTTP URLs are NOT fetched by any provider today — download client-side and
 * use audioFromBase64 or audioFromFile. Wired here for future compatibility.
 */
function audioFromUrl(url, mediaType) {
  return {
    type: 'audio',
    source: { type: 'url', url, media_type: mediaType },
  };
}

/**
 * Wrap raw base64 audio bytes into a plugin-shape audio block. mediaType is
 * required (audio formats don't self-describe from bytes alone the way image
 * magic numbers do; provider APIs need it in the payload).
 */
function audioFromBase64(base64Data, mediaType) {
  if (!mediaType) {
    throw new Error(
      "audioFromBase64: mediaType is required (e.g. 'audio/mpeg', 'audio/wav', 'audio/mp4')."
    );
  }
  return {
    type: 'audio',
    source: { type: 'base64', media_type: mediaType, data: base64Data },
  };
}

module.exports = {
  withRetry,
  RetryableError,
  throwFromResponse,
  DEFAULT_RETRY,
  ResponseCache,
  hashChatRequest,
  imageFromFile,
  imageFromUrl,
  imageFromBase64,
  pdfFromFile,
  pdfFromUrl,
  pdfFromBase64,
  audioFromFile,
  audioFromUrl,
  audioFromBase64,
};
