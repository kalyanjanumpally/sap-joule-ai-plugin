const cds = require('@sap/cds');
const LLMService = require('../LLMService');
const { parseAnthropicRateLimit } = require('../rateLimits');

class AnthropicLLMService extends LLMService {
  async init() {
    await super.init();
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const apiKey = this.options.credentials?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic provider requires credentials.apiKey or ANTHROPIC_API_KEY');
    // maxRetries: 0 — we handle retries in the base LLMService, avoid double-retry
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
    this.modelId = this.modelId ?? 'claude-opus-4-7';
    this.log = cds.log('llm:anthropic');
  }

  async _chat({ model, maxTokens, system, messages, tools, format, thinking, cache }) {
    rejectUnsupportedBlocks(messages);
    const params = {
      model,
      max_tokens: maxTokens,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    };

    if (system) {
      params.system = cache
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    if (tools) params.tools = tools;
    if (format) {
      // Anthropic's structured-output API: output_config.format
      params.output_config = {
        format: { type: 'json_schema', schema: format },
      };
    }
    if (thinking !== false) {
      params.thinking = thinking ?? { type: 'adaptive' };
    }

    const stream = this.client.messages.stream(params);
    const message = await stream.finalMessage();
    const _rateLimit = await extractAnthropicRateLimit(stream);

    const text = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Normalize tool_use blocks (matches OpenAI-compat shape: { id, name, input })
    const toolCalls = message.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    return {
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: message,
      usage: message.usage,
      stopReason: message.stop_reason,
      model: message.model,
      ...(_rateLimit ? { _rateLimit } : {}),
    };
  }
}

/**
 * Streaming: use the Anthropic SDK's stream() method, which returns an
 * async iterable of native events. We adapt to unified chunks.
 */
AnthropicLLMService.prototype._stream = async function* _stream(
  { model, maxTokens, system, messages, tools, format, thinking, cache },
) {
  rejectUnsupportedBlocks(messages);
  const params = {
    model,
    max_tokens: maxTokens,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };
  if (system) {
    params.system = cache
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  if (tools) params.tools = tools;
  if (format) params.output_config = { format: { type: 'json_schema', schema: format } };
  if (thinking !== false) params.thinking = thinking ?? { type: 'adaptive' };

  const stream = this.client.messages.stream(params);

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield { type: 'text_delta', text: event.delta.text };
    }
  }

  const message = await stream.finalMessage();
  const _rateLimit = await extractAnthropicRateLimit(stream);
  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Tool-use blocks on the done chunk (new in 1.42.0). Anthropic's SDK
  // already assembles the JSON input from input_json_delta events by the
  // time finalMessage() resolves — we just have to project them into the
  // unified { id, name, input } shape shared with the OpenAI-compat path.
  const toolCalls = message.content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input }));

  yield {
    type: 'done',
    text,
    usage: message.usage,
    stopReason: message.stop_reason,
    model: message.model,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(_rateLimit ? { _rateLimit } : {}),
  };
};

// ---- Message Batches API (2024-10) --------------------------------------
//
// https://docs.anthropic.com/en/api/creating-message-batches
// https://docs.anthropic.com/en/api/retrieving-message-batches
//
// ~50% cheaper than sync API, 24h SLA. Every request in the batch uses the
// same model unless overridden per-request. Results delivered as a JSONL
// stream at `results_url` once processing_status == 'ended'.

AnthropicLLMService.prototype._batchSubmit = async function _batchSubmit(req) {
  const requests = req.requests.map(r => ({
    custom_id: r.customId,
    params: {
      model: r.model ?? this.modelId,
      max_tokens: r.maxTokens ?? this.defaultMaxTokens ?? 1024,
      messages: r.messages.map(m => ({ role: m.role, content: m.content })),
      ...(r.system ? { system: r.system } : {}),
      ...(r.tools ? { tools: r.tools } : {}),
      ...(r.thinking !== false ? { thinking: r.thinking ?? { type: 'adaptive' } } : {}),
    },
  }));

  const created = await this.client.messages.batches.create({ requests });
  return normalizeBatchStatus(created);
};

AnthropicLLMService.prototype._batchStatus = async function _batchStatus(id) {
  const b = await this.client.messages.batches.retrieve(id);
  return normalizeBatchStatus(b);
};

AnthropicLLMService.prototype._batchResults = async function _batchResults(id) {
  const b = await this.client.messages.batches.retrieve(id);
  if (b.processing_status !== 'ended') {
    throw new Error(`batch ${id} is still ${b.processing_status} — poll until 'ended' before retrieving results.`);
  }
  // The SDK exposes .results() which returns an async iterable of parsed JSONL.
  const out = [];
  for await (const r of await this.client.messages.batches.results(id)) {
    out.push(normalizeBatchResultEntry(r));
  }
  return out;
};

AnthropicLLMService.prototype._batchCancel = async function _batchCancel(id) {
  const b = await this.client.messages.batches.cancel(id);
  return normalizeBatchStatus(b);
};

// Anthropic → unified status shape. Their `processing_status` is 'in_progress'
// or 'ended'; we surface the finer breakdown from `request_counts` so callers
// know how many succeeded / errored / were canceled.
function normalizeBatchStatus(b) {
  const counts = b.request_counts ?? {};
  const status = b.processing_status === 'in_progress' ? 'in_progress' : 'completed';
  return {
    id: b.id,
    provider: 'anthropic',
    status,
    submittedAt: b.created_at,
    endedAt: b.ended_at ?? null,
    counts: {
      processing: counts.processing ?? 0,
      succeeded:  counts.succeeded  ?? 0,
      errored:    counts.errored    ?? 0,
      canceled:   counts.canceled   ?? 0,
      expired:    counts.expired    ?? 0,
    },
    raw: b,
  };
}

// One line of the results JSONL → unified BatchResult.
function normalizeBatchResultEntry(entry) {
  const customId = entry.custom_id;
  const r = entry.result ?? {};
  if (r.type === 'succeeded' && r.message) {
    const msg = r.message;
    const text = (msg.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    const toolCalls = (msg.content ?? [])
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));
    return {
      customId,
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: msg.usage,
      stopReason: msg.stop_reason,
      model: msg.model,
      raw: msg,
    };
  }
  // errored | canceled | expired
  return {
    customId,
    error: r.error?.message ?? r.type,
    errorType: r.type,
    raw: entry,
  };
}

/**
 * Grab response headers from an Anthropic SDK MessageStream and parse
 * rate-limit headers out of them. Defensive across SDK versions — different
 * releases expose the response object differently:
 *   v0.36 → `stream.response()` async method returning a fetch Response
 *   v0.34+ → `stream.response` property that is a Promise<Response>
 *   Older → not exposed; we skip and return null.
 * Any failure returns null — rate-limit tracking is best-effort observability,
 * never a reason to fail a chat call.
 * @since 1.40.0
 */
async function extractAnthropicRateLimit(stream) {
  try {
    let response;
    if (stream && typeof stream.response === 'function') {
      response = await stream.response();
    } else if (stream && stream.response && typeof stream.response.then === 'function') {
      response = await stream.response;
    }
    if (!response?.headers) return null;
    return parseAnthropicRateLimit(response.headers, response.status);
  } catch {
    return null;
  }
}

/**
 * Anthropic supports text + image + document + tool_use content blocks.
 * Audio isn't in scope (Claude Voice is a separate API surface). Throw a
 * clear error at dispatch so users get a diagnostic instead of a cryptic
 * 400 from the SDK.
 */
function rejectUnsupportedBlocks(messages) {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === 'audio') {
        throw new Error(
          'Audio blocks are not supported on Anthropic (Claude Voice is a separate API surface). ' +
          'Transcribe the audio client-side (whisper.cpp, Deepgram, etc.) and pass the transcript ' +
          'as a text block, or switch the provider to Gemini or an OpenAI-compat GPT-4o Audio endpoint.',
        );
      }
    }
  }
}

module.exports = AnthropicLLMService;
