// Google Gemini provider — talks to the Google AI Studio API directly via
// fetch (no SDK). Works with any Gemini generation-content endpoint.
//
//   Endpoint pattern:
//     <baseUrl>/v1beta/models/<model>:generateContent?key=<apiKey>
//     <baseUrl>/v1beta/models/<model>:streamGenerateContent?alt=sse&key=<apiKey>
//     <baseUrl>/v1beta/models/<embedModel>:embedContent?key=<apiKey>
//     <baseUrl>/v1beta/models/<embedModel>:batchEmbedContents?key=<apiKey>
//
// Configuration (via credentials):
//   apiKey:         Google AI Studio API key (or env GOOGLE_API_KEY / GEMINI_API_KEY)
//   baseUrl:        default 'https://generativelanguage.googleapis.com'
//   embeddingModel: e.g. 'text-embedding-004' (default: 'text-embedding-004')

const cds = require('@sap/cds');
const LLMService = require('../LLMService');
const { throwFromResponse } = require('../util');
const { parseGeminiRateLimit } = require('../rateLimits');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';

class GeminiLLMService extends LLMService {
  async init() {
    await super.init();
    const creds = this.options.credentials ?? {};
    this.baseUrl = (creds.baseUrl ?? process.env.GEMINI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = creds.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!this.apiKey && !this.options.skipApiKeyCheck) {
      throw new Error(
        'GeminiLLMService requires credentials.apiKey or GOOGLE_API_KEY / GEMINI_API_KEY env var',
      );
    }
    this.embeddingModel = creds.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.modelId = this.modelId ?? 'gemini-1.5-flash';
    this.log = cds.log('llm:gemini');
  }

  async _chat({ model, maxTokens, system, messages, tools, format }) {
    const body = buildRequestBody({ maxTokens, system, messages, tools, format });
    const res = await fetch(this._chatEndpoint(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) await throwFromResponse(res, 'Gemini');

    const data = await res.json();
    // Rate-limit headers (new in 1.44.0). Non-fatal parse — Gemini's direct
    // Generative Language API often omits these; Vertex + API-Gateway
    // deployments emit them.
    const _rateLimit = parseGeminiRateLimit(res.headers, res.status);
    const result = normalizeChatResponse(data, model);
    if (_rateLimit) result._rateLimit = _rateLimit;
    return result;
  }

  async _embed({ model, input }) {
    const modelId = model === this.modelId ? this.embeddingModel : model;
    const inputs = Array.isArray(input) ? input : [input];
    // Gemini exposes both single (:embedContent) and batch (:batchEmbedContents)
    // endpoints. Use the batch endpoint for arrays — one round-trip instead of N.
    if (inputs.length === 1) {
      const res = await fetch(this._embedEndpoint(modelId), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({ content: { parts: [{ text: inputs[0] }] } }),
      });
      if (!res.ok) await throwFromResponse(res, 'Gemini');
      const data = await res.json();
      return { embeddings: [data.embedding.values], model: modelId };
    }
    const res = await fetch(this._batchEmbedEndpoint(modelId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        requests: inputs.map(text => ({
          model: `models/${modelId}`,
          content: { parts: [{ text }] },
        })),
      }),
    });
    if (!res.ok) await throwFromResponse(res, 'Gemini');
    const data = await res.json();
    return { embeddings: data.embeddings.map(e => e.values), model: modelId };
  }

  _chatEndpoint(model) {
    return `${this.baseUrl}/v1beta/models/${model}:generateContent`;
  }
  _streamEndpoint(model) {
    return `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  }
  _embedEndpoint(model) {
    return `${this.baseUrl}/v1beta/models/${model}:embedContent`;
  }
  _batchEmbedEndpoint(model) {
    return `${this.baseUrl}/v1beta/models/${model}:batchEmbedContents`;
  }
}

GeminiLLMService.prototype._stream = async function* _stream(
  { model, maxTokens, system, messages, tools, format },
) {
  const body = buildRequestBody({ maxTokens, system, messages, tools, format });
  const res = await fetch(this._streamEndpoint(model), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwFromResponse(res, 'Gemini');
  // Rate-limit headers on the initial stream response (new in 1.44.0).
  const _rateLimit = parseGeminiRateLimit(res.headers, res.status);

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';
  let lastEvt = null;
  // Gemini emits complete functionCall parts per stream chunk (unlike
  // OpenAI-compat which fragments arguments across deltas). Collect them
  // as we go; surface on the done chunk. New in 1.43.0.
  const collectedFunctionCalls = [];

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // Gemini SSE frames are `data: {json}\n\n`. Split on double-newline.
    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx === -1) break;
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      lastEvt = evt;
      const parts = evt.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          accumulatedText += p.text;
          yield { type: 'text_delta', text: p.text };
        } else if (p.functionCall) {
          collectedFunctionCalls.push(p.functionCall);
        }
      }
    }
  }
  const toolCalls = collectedFunctionCalls.map(fc => ({
    id: `gemini_${Math.random().toString(36).slice(2, 10)}`,
    name: fc.name,
    input: fc.args ?? {},
  }));
  yield {
    type: 'done',
    text: accumulatedText,
    usage: mapUsage(lastEvt?.usageMetadata),
    stopReason: toolCalls.length ? 'tool_use' : lastEvt?.candidates?.[0]?.finishReason,
    model,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(_rateLimit ? { _rateLimit } : {}),
  };
};

// ---- request/response translation ----------------------------------------

function buildRequestBody({ maxTokens, system, messages, tools, format }) {
  const body = {
    contents: messages.map(translateMessage),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (format) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = sanitizeSchemaForGemini(format);
  }
  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? t.parameters,
      })),
    }];
  }
  return body;
}

/**
 * Gemini message shape:
 *   { role: 'user' | 'model', parts: [{ text | inlineData: { mimeType, data } | functionCall | functionResponse }] }
 * Unified role 'assistant' → 'model'. Unified 'system' role should be in
 * systemInstruction — reject if it appears here (caller error).
 */
function translateMessage(m) {
  if (m.role === 'system') {
    throw new Error(
      "Gemini: system messages belong in the `system` field, not `messages`. " +
      "Pass the system prompt as chat({ system: '...', messages: [...] }).",
    );
  }
  const role = m.role === 'assistant' ? 'model' : m.role;
  if (typeof m.content === 'string') {
    return { role, parts: [{ text: m.content }] };
  }
  if (!Array.isArray(m.content)) return { role, parts: [{ text: '' }] };

  const parts = [];
  for (const block of m.content) {
    if (block?.type === 'text') {
      parts.push({ text: block.text ?? '' });
    } else if (block?.type === 'image') {
      const src = block.source ?? {};
      if (src.type === 'base64') {
        parts.push({ inlineData: { mimeType: src.media_type ?? 'image/png', data: src.data } });
      } else if (src.type === 'url') {
        throw new Error(
          'Gemini images must be base64 (Google AI Studio does not fetch URLs). ' +
          'Convert the URL client-side or use imageFromFile() for local files.',
        );
      }
    } else if (block?.type === 'audio') {
      const src = block.source ?? {};
      if (src.type === 'base64') {
        // Gemini supports inline audio (wav / mp3 / m4a / ogg / flac / aac) up
        // to the request-size limit. Same wire shape as inline images.
        parts.push({ inlineData: { mimeType: src.media_type ?? 'audio/mpeg', data: src.data } });
      } else if (src.type === 'url') {
        // Google Cloud Storage URIs (gs://...) are the only URL scheme Gemini
        // will fetch. HTTP URLs get a clear error so users know to download.
        if (typeof src.url === 'string' && src.url.startsWith('gs://')) {
          parts.push({ fileData: { mimeType: src.media_type ?? 'audio/mpeg', fileUri: src.url } });
        } else {
          throw new Error(
            'Gemini fetches audio only from gs:// URIs. For HTTP URLs, download client-side and pass via audioFromBase64() or audioFromFile().',
          );
        }
      }
    } else if (block?.type === 'tool_use') {
      parts.push({ functionCall: { name: block.name, args: block.input } });
    } else if (block?.type === 'tool_result') {
      // Gemini expects the tool result as a functionResponse part with the
      // called tool's name — plumb it back through here.
      const result = typeof block.content === 'string'
        ? { output: block.content }
        : block.content;
      parts.push({ functionResponse: { name: block.tool_use_id ?? 'tool', response: result } });
    } else if (block?.type === 'document') {
      throw new Error(
        'PDF/document blocks are not yet supported on Gemini via this provider. ' +
        'Only Anthropic has native PDF understanding; on Gemini, render pages to images.',
      );
    }
  }
  return { role, parts };
}

function normalizeChatResponse(data, model) {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
  const toolCalls = parts
    .filter(p => p.functionCall)
    .map(p => ({
      id: `gemini_${Math.random().toString(36).slice(2, 10)}`,
      name: p.functionCall.name,
      input: p.functionCall.args ?? {},
    }));
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: data,
    usage: mapUsage(data.usageMetadata),
    stopReason: toolCalls.length ? 'tool_use' : data.candidates?.[0]?.finishReason,
    model,
  };
}

function mapUsage(u) {
  if (!u) return {};
  return { input_tokens: u.promptTokenCount, output_tokens: u.candidatesTokenCount };
}

/**
 * Gemini's structured-output schema is JSON-Schema-ish but rejects several
 * fields (e.g. `$schema`, `additionalProperties`, `title`, `default`). Strip
 * them so users can pass the same schema they'd use with OpenAI / Anthropic.
 */
function sanitizeSchemaForGemini(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties' || k === 'title' || k === 'default') continue;
    out[k] = sanitizeSchemaForGemini(v);
  }
  return out;
}

module.exports = GeminiLLMService;
