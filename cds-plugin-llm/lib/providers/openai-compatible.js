const cds = require('@sap/cds');
const LLMService = require('../LLMService');
const { throwFromResponse } = require('../util');

/**
 * Generic OpenAI-compatible provider.
 *
 * Works with any endpoint speaking OpenAI's /chat/completions shape:
 *   Groq            https://api.groq.com/openai/v1
 *   OpenAI          https://api.openai.com/v1
 *   Together AI     https://api.together.xyz/v1
 *   Fireworks       https://api.fireworks.ai/inference/v1
 *   DeepSeek        https://api.deepseek.com
 *   LM Studio       http://localhost:1234/v1
 *
 * Configure via cds.requires.<name>:
 *   { "kind": "llm-groq", "modelId": "llama-3.3-70b-versatile" }
 *   { "kind": "llm-openai-compatible",
 *     "credentials": { "baseUrl": "...", "apiKey": "..." },
 *     "modelId": "..." }
 */
class OpenAICompatibleLLMService extends LLMService {
  async init() {
    await super.init();
    const creds = this.options.credentials ?? {};
    this.baseUrl = creds.baseUrl
      ?? this.options.baseUrl
      ?? process.env[this.options.apiKeyEnv ? `${this.options.apiKeyEnv}_BASE_URL` : 'OPENAI_BASE_URL']
      ?? 'https://api.openai.com/v1';
    const envKey = this.options.apiKeyEnv ?? 'OPENAI_API_KEY';
    this.apiKey = creds.apiKey ?? process.env[envKey];
    // Subclasses (e.g. GenAI Hub with OAuth) may not use apiKey at all;
    // they override _authHeader() and can skip this check by setting
    // options.skipApiKeyCheck = true.
    if (!this.apiKey && !this.options.skipApiKeyCheck) {
      throw new Error(`${this.constructor.name} requires credentials.apiKey or ${envKey} env var`);
    }
    this.log = cds.log(`llm:${this.options.kind ?? 'openai-compatible'}`);
  }

  /**
   * Hook: return the URL to POST /chat/completions to. Subclasses may override
   * for path variations (e.g. GenAI Hub uses .../deployments/{id}/chat/completions).
   */
  _endpoint() {
    return `${this.baseUrl}/chat/completions`;
  }

  /**
   * Hook: return the URL for POST /embeddings. Subclasses may override for
   * path variations (e.g. Azure OpenAI's per-deployment URL scheme).
   */
  _embedEndpoint() {
    return `${this.baseUrl}/embeddings`;
  }

  /**
   * Hook: return request headers. Async so subclasses can fetch OAuth tokens.
   * Subclasses override to add resource-group headers, replace Bearer auth, etc.
   */
  async _headers() {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.apiKey}`,
    };
  }

  async _chat({ model, maxTokens, system, messages, format, tools }) {
    // For structured output on OpenAI-compat providers, use json_object mode
    // (widely supported: OpenAI, Groq, Together, DeepSeek, Fireworks, LM Studio)
    // and prepend the schema to the system prompt so the model knows the shape.
    // json_schema strict mode is limited to a subset of models; we opt for
    // broader compatibility here.
    const effectiveSystem = format
      ? `${system ?? ''}\n\nRespond with ONLY a JSON object matching this schema:\n${JSON.stringify(format, null, 2)}`.trim()
      : system;

    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        ...(effectiveSystem ? [{ role: 'system', content: effectiveSystem }] : []),
        ...messages.map(translateMessage),
      ],
    };

    if (format) body.response_format = { type: 'json_object' };

    if (tools?.length) {
      // Unified {name, description, input_schema} -> OpenAI's function shape
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema ?? t.parameters,
        },
      }));
    }

    const res = await fetch(this._endpoint(), {
      method: 'POST',
      headers: await this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwFromResponse(res, `OpenAI-compatible provider (${this.options.kind ?? 'openai-compatible'})`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];

    // Normalize tool calls into { id, name, input } shape (matches Anthropic)
    const toolCalls = (choice?.message?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      input: safeParseJson(tc.function?.arguments) ?? {},
    }));

    return {
      text: choice?.message?.content ?? '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: data,
      usage: {
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
      },
      stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : choice?.finish_reason,
      model: data.model,
    };
  }
}

function safeParseJson(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Translate a message into OpenAI-compat shape. Handles:
 *  - Plain { role, content: string }
 *  - Assistant with tool calls: { role:'assistant', content, toolCalls:[{id,name,input}] }
 *  - Tool result: { role:'tool', tool_use_id, content } (Anthropic-ish) ->
 *                 { role:'tool', tool_call_id, content } (OpenAI)
 *  - Multi-block content (text + image blocks) preserved as OpenAI's multi-part
 *    array: [{type:'text',text},{type:'image_url',image_url:{url}}, ...]
 */
function translateMessage(m) {
  // Tool result feedback
  if (m.role === 'tool' || m.role === 'tool_result') {
    const content = Array.isArray(m.content)
      ? m.content.map(b => b.text ?? b.content ?? '').join('')
      : String(m.content ?? '');
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id ?? m.tool_use_id,
      content,
    };
  }
  // Assistant with tool calls
  if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
    return {
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
      })),
    };
  }
  // Multi-block content (mix of text + image + document blocks)
  if (Array.isArray(m.content)) {
    const hasNonText = m.content.some(b => b?.type && b.type !== 'text');
    if (hasNonText) {
      // Any non-text block triggers the multi-part path. translateBlock rejects
      // document blocks with a clear error (Anthropic-only feature).
      return {
        role: m.role,
        content: m.content.map(translateBlock).filter(Boolean),
      };
    }
    // Text-only array: flatten to string (matches prior behavior)
    return { role: m.role, content: m.content.map(b => b.text ?? '').join('') };
  }
  // Plain string content
  return { role: m.role, content: m.content };
}

function translateBlock(block) {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    const src = block.source ?? {};
    if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
    if (src.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
    }
    throw new Error(`Unsupported image source type: ${src.type}`);
  }
  if (block.type === 'document') {
    const src = block.source ?? {};
    if (src.type === 'base64') {
      // OpenAI inline file shape (works with GPT-4o and newer models that
      // accept document input). Other OpenAI-compat providers (Groq,
      // DeepSeek, LM Studio, Together) will 400 upstream if they don't
      // support it — that's the honest signal to the caller.
      return {
        type: 'file',
        file: {
          filename: 'document.pdf',
          file_data: `data:${src.media_type || 'application/pdf'};base64,${src.data}`,
        },
      };
    }
    if (src.type === 'file_id') {
      // Reference a file previously uploaded via /v1/files (see
      // uploadPdfFromUrl helper). Wire format matches OpenAI's chat.completions
      // file content-block for prior uploads.
      return { type: 'file', file: { file_id: src.file_id } };
    }
    if (src.type === 'url') {
      throw new Error(
        'OpenAI-compat providers do not accept PDFs by URL directly. Either ' +
        'fetch the file client-side and pass via pdfFromBase64(), or upload ' +
        'via the Files API using uploadPdfFromUrl(url, {apiKey, baseUrl}). ' +
        'Anthropic providers do accept URL PDFs natively.'
      );
    }
    throw new Error(`Unsupported document source type: ${src.type}`);
  }
  if (block.type === 'audio') {
    const src = block.source ?? {};
    if (src.type === 'base64') {
      // OpenAI-compat audio content-block. GPT-4o Audio + gateways that mirror
      // that shape accept this. Format value is the extension without the
      // leading dot: 'wav', 'mp3', 'flac', etc. Other providers 400 upstream —
      // that's the honest signal that the model doesn't speak audio.
      const format = mediaTypeToOpenAiFormat(src.media_type);
      return { type: 'input_audio', input_audio: { data: src.data, format } };
    }
    if (src.type === 'url') {
      throw new Error(
        'OpenAI-compat providers do not accept audio by URL directly. Fetch client-side and pass via audioFromBase64() or audioFromFile().',
      );
    }
    throw new Error(`Unsupported audio source type: ${src.type}`);
  }
  return null;
}

function mediaTypeToOpenAiFormat(mediaType) {
  // OpenAI's input_audio.format expects the codec/container name, not the
  // MIME type. Map the media types we support in audioFromFile.
  const map = {
    'audio/wav':  'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4':  'mp4',
    'audio/ogg':  'ogg',
    'audio/flac': 'flac',
    'audio/aac':  'aac',
    'audio/opus': 'opus',
    'audio/webm': 'webm',
  };
  return map[mediaType] ?? 'mp3';
}

/**
 * Streaming: adds `stream:true` to the request body, parses the SSE response
 * (`data: {json}\n\n` lines terminated by `data: [DONE]`), and yields unified
 * chunks.
 */
OpenAICompatibleLLMService.prototype._stream = async function* _stream(
  { model, maxTokens, system, messages, format, tools },
) {
  const effectiveSystem = format
    ? `${system ?? ''}\n\nRespond with ONLY a JSON object matching this schema:\n${JSON.stringify(format, null, 2)}`.trim()
    : system;

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },  // OpenAI + Groq honor this
    messages: [
      ...(effectiveSystem ? [{ role: 'system', content: effectiveSystem }] : []),
      ...messages.map(translateMessage),
    ],
  };
  if (format) body.response_format = { type: 'json_object' };
  if (tools?.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? t.parameters },
    }));
  }

  const res = await fetch(this._endpoint(), {
    method: 'POST',
    headers: await this._headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwFromResponse(res, `OpenAI-compatible provider (${this.options.kind ?? 'openai-compatible'})`);

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';
  let usage = {};
  let stopReason;
  let respModel = model;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE events are separated by blank lines. Keep the tail as it may be partial.
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const eventBlock of events) {
      // Each event may have multiple `data:` lines; the SSE spec concatenates them.
      const dataLines = eventBlock
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(dataStr); } catch { continue; }
      const choice = evt.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        accumulatedText += delta;
        yield { type: 'text_delta', text: delta };
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
      if (evt.usage) {
        usage = {
          input_tokens: evt.usage.prompt_tokens,
          output_tokens: evt.usage.completion_tokens,
        };
      }
      if (evt.model) respModel = evt.model;
    }
  }

  yield { type: 'done', text: accumulatedText, usage, stopReason, model: respModel };
};

/**
 * Embeddings via the OpenAI-compatible /embeddings endpoint. Works with:
 *   OpenAI       (text-embedding-3-small, text-embedding-3-large, ada-002)
 *   Groq         (embedding models when available; check console.groq.com)
 *   Together AI  (togethercomputer/m2-bert-80M-8k-retrieval, etc.)
 *   DeepSeek     (limited)
 *   LM Studio    (whatever embedding model is loaded)
 *
 * Providers that don't support embeddings will throw with the upstream 400.
 */
OpenAICompatibleLLMService.prototype._embed = async function _embed({ model, input }) {
  const body = { model, input };
  const res = await fetch(this._embedEndpoint(), {
    method: 'POST',
    headers: await this._headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await throwFromResponse(res, `OpenAI-compatible provider (${this.options.kind ?? 'openai-compatible'}) [embeddings]`);
  }
  const data = await res.json();
  // OpenAI returns { data: [{ embedding: [...] }, ...], model, usage: {...} }
  const embeddings = (data.data ?? []).map(d => d.embedding);
  return { embeddings, model: data.model ?? model };
};

// ---- Batch API (2024-04) -----------------------------------------------
//
// https://platform.openai.com/docs/api-reference/batch
//
// OpenAI's batch flow needs two calls: upload a JSONL file (each line is a
// full /v1/chat/completions request with a custom_id) via POST /v1/files,
// then create a batch pointing at that file via POST /v1/batches. Poll
// GET /v1/batches/{id} until status='completed', then download the output
// via the returned output_file_id from GET /v1/files/{id}/content.
//
// This code path uses the OpenAI URL scheme rooted at `this.baseUrl` — Groq
// / Together / Fireworks / DeepSeek / Mistral currently do NOT support the
// batch endpoints, so calling batch() there will surface the upstream 404
// or 400 clearly. Users on those providers should stick to chat().

OpenAICompatibleLLMService.prototype._batchSubmit = async function _batchSubmit(req) {
  const url = this.baseUrl;
  const headers = await this._headers();
  const bearerHeaders = { ...headers };
  delete bearerHeaders['content-type'];

  // ---- 1. Upload JSONL --------------------------------------------------
  const jsonl = req.requests.map(r => JSON.stringify({
    custom_id: r.customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: {
      model: r.model ?? this.modelId,
      messages: r.messages,
      ...(r.system ? { messages: [{ role: 'system', content: r.system }, ...r.messages] } : {}),
      ...(r.maxTokens ? { max_tokens: r.maxTokens } : {}),
      ...(r.tools ? { tools: r.tools.map(t => ({ type: 'function', function: t })) } : {}),
      ...(r.format ? { response_format: { type: 'json_object' } } : {}),
    },
  })).join('\n');

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl');

  const filesRes = await fetch(`${url}/files`, {
    method: 'POST',
    headers: bearerHeaders,
    body: form,
  });
  if (!filesRes.ok) {
    await throwFromResponse(filesRes, `${this.options.kind ?? 'openai-compatible'} [files]`);
  }
  const fileData = await filesRes.json();

  // ---- 2. Create batch --------------------------------------------------
  const batchRes = await fetch(`${url}/batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input_file_id: fileData.id,
      endpoint: '/v1/chat/completions',
      completion_window: req.completionWindow ?? '24h',
    }),
  });
  if (!batchRes.ok) {
    await throwFromResponse(batchRes, `${this.options.kind ?? 'openai-compatible'} [batches]`);
  }
  const batch = await batchRes.json();
  return normalizeOpenAIBatchStatus(batch);
};

OpenAICompatibleLLMService.prototype._batchStatus = async function _batchStatus(id) {
  const res = await fetch(`${this.baseUrl}/batches/${id}`, {
    headers: await this._headers(),
  });
  if (!res.ok) {
    await throwFromResponse(res, `${this.options.kind ?? 'openai-compatible'} [batches]`);
  }
  return normalizeOpenAIBatchStatus(await res.json());
};

OpenAICompatibleLLMService.prototype._batchResults = async function _batchResults(id) {
  // First fetch the batch to get output_file_id.
  const batch = await this._batchStatus(id);
  if (batch.status !== 'completed') {
    throw new Error(`batch ${id} is still ${batch.status} — poll until 'completed' before retrieving results.`);
  }
  const outputFileId = batch.raw?.output_file_id;
  if (!outputFileId) return [];

  const res = await fetch(`${this.baseUrl}/files/${outputFileId}/content`, {
    headers: await this._headers(),
  });
  if (!res.ok) {
    await throwFromResponse(res, `${this.options.kind ?? 'openai-compatible'} [files/content]`);
  }
  const text = await res.text();
  return text
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(line => {
      try { return normalizeOpenAIBatchResultLine(JSON.parse(line)); }
      catch { return null; }
    })
    .filter(Boolean);
};

OpenAICompatibleLLMService.prototype._batchCancel = async function _batchCancel(id) {
  const res = await fetch(`${this.baseUrl}/batches/${id}/cancel`, {
    method: 'POST',
    headers: await this._headers(),
  });
  if (!res.ok) {
    await throwFromResponse(res, `${this.options.kind ?? 'openai-compatible'} [batches/cancel]`);
  }
  return normalizeOpenAIBatchStatus(await res.json());
};

// OpenAI batch status → unified shape.
// Their statuses: validating, in_progress, finalizing, completed, expired,
// failed, cancelling, cancelled. We collapse to: in_progress | completed |
// failed | canceled to match Anthropic's shape.
function normalizeOpenAIBatchStatus(b) {
  const status = mapOpenAIStatus(b.status);
  const counts = b.request_counts ?? {};
  return {
    id: b.id,
    provider: 'openai',
    status,
    submittedAt: b.created_at,
    endedAt: b.completed_at ?? b.failed_at ?? b.cancelled_at ?? b.expired_at ?? null,
    counts: {
      processing: (b.request_counts?.total ?? 0) - (b.request_counts?.completed ?? 0) - (b.request_counts?.failed ?? 0),
      succeeded:  counts.completed ?? 0,
      errored:    counts.failed    ?? 0,
      canceled:   0,
      expired:    0,
    },
    raw: b,
  };
}

function mapOpenAIStatus(s) {
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'expired') return 'failed';
  if (s === 'cancelling' || s === 'cancelled') return 'canceled';
  return 'in_progress';
}

function normalizeOpenAIBatchResultLine(line) {
  const customId = line.custom_id;
  if (line.error) {
    return { customId, error: line.error.message ?? String(line.error), errorType: 'errored', raw: line };
  }
  const body = line.response?.body;
  if (!body) return { customId, error: 'no response body', errorType: 'errored', raw: line };
  const text = body.choices?.[0]?.message?.content ?? '';
  return {
    customId,
    text,
    usage: body.usage
      ? { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens }
      : undefined,
    stopReason: body.choices?.[0]?.finish_reason,
    model: body.model,
    raw: body,
  };
}

module.exports = OpenAICompatibleLLMService;
