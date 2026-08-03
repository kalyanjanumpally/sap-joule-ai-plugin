// AWS Bedrock provider — uses the Converse API (Bedrock's provider-agnostic
// chat surface) and Invoke API for embeddings. Depends on
// @aws-sdk/client-bedrock-runtime as an optional peer; users install it only
// when they configure this provider.
//
//   modelId patterns (Converse):
//     anthropic.claude-opus-4-20250514-v1:0
//     meta.llama3-70b-instruct-v1:0
//     mistral.mistral-large-2402-v1:0
//     amazon.nova-pro-v1:0
//
//   modelId patterns (Embed via Invoke):
//     amazon.titan-embed-text-v2:0   (default embedding model — 1024-dim)
//     cohere.embed-english-v3
//     cohere.embed-multilingual-v3
//
// Configuration (via credentials):
//   region:            AWS region, e.g. 'us-east-1' (or env AWS_REGION)
//   accessKeyId:       optional — SDK falls back to env / profile / IAM role
//   secretAccessKey:   optional — same
//   sessionToken:      optional — for temporary creds
//   embeddingModel:    default 'amazon.titan-embed-text-v2:0'
//
// The SDK handles SigV4 signing, retry backoff, and endpoint resolution.

const cds = require('@sap/cds');
const LLMService = require('../LLMService');

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';

class BedrockLLMService extends LLMService {
  async init() {
    await super.init();
    const creds = this.options.credentials ?? {};
    let mod;
    try {
      mod = require('@aws-sdk/client-bedrock-runtime');
    } catch (e) {
      throw new Error(
        'BedrockLLMService requires the optional peer dependency ' +
        '`@aws-sdk/client-bedrock-runtime`. Install it: ' +
        '  npm install @aws-sdk/client-bedrock-runtime',
      );
    }
    this._sdk = mod;
    this.region = creds.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!this.region) {
      throw new Error(
        'BedrockLLMService requires a region. Set credentials.region or AWS_REGION / AWS_DEFAULT_REGION env.',
      );
    }
    const clientOpts = { region: this.region };
    if (creds.accessKeyId && creds.secretAccessKey) {
      clientOpts.credentials = {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      };
    }
    // SDK-driven retries would race with our base LLMService withRetry;
    // opt out so we don't double-retry.
    clientOpts.maxAttempts = 1;
    this.client = new mod.BedrockRuntimeClient(clientOpts);
    this.embeddingModel = creds.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.modelId = this.modelId ?? 'anthropic.claude-opus-4-20250514-v1:0';
    this.log = cds.log('llm:bedrock');
  }

  async _chat({ model, maxTokens, system, messages, tools, format }) {
    const cmd = new this._sdk.ConverseCommand({
      modelId: model,
      messages: messages.map(translateMessage),
      ...(system ? { system: [{ text: system }] } : {}),
      inferenceConfig: { maxTokens },
      ...(tools?.length ? { toolConfig: buildToolConfig(tools) } : {}),
    });
    // Structured output: Bedrock Converse doesn't have a first-class
    // response-format flag across all models. Fall back to a system-prompt
    // instruction when format is set. (Same policy as openai-compatible.js
    // for consistency across providers that lack strict json_schema mode.)
    if (format) {
      cmd.input.system = [
        { text: `${system ?? ''}\n\nRespond with ONLY a JSON object matching this schema:\n${JSON.stringify(format, null, 2)}`.trim() },
      ];
    }
    const out = await this.client.send(cmd);
    return normalizeChatResponse(out, model);
  }

  async _embed({ model, input }) {
    const modelId = model === this.modelId ? this.embeddingModel : model;
    const inputs = Array.isArray(input) ? input : [input];
    // Bedrock embeddings go through InvokeModelCommand — the request body
    // shape is model-specific. Titan v2 and Cohere embed shapes both handled.
    const embeddings = [];
    for (const text of inputs) {
      const body = titanOrCohereEmbedBody(modelId, text);
      const cmd = new this._sdk.InvokeModelCommand({
        modelId,
        body: JSON.stringify(body),
        contentType: 'application/json',
        accept: 'application/json',
      });
      const out = await this.client.send(cmd);
      const parsed = JSON.parse(new TextDecoder().decode(out.body));
      embeddings.push(extractEmbedding(modelId, parsed));
    }
    return { embeddings, model: modelId };
  }
}

BedrockLLMService.prototype._stream = async function* _stream(
  { model, maxTokens, system, messages, tools, format },
) {
  const effectiveSystem = format
    ? `${system ?? ''}\n\nRespond with ONLY a JSON object matching this schema:\n${JSON.stringify(format, null, 2)}`.trim()
    : system;
  const cmd = new this._sdk.ConverseStreamCommand({
    modelId: model,
    messages: messages.map(translateMessage),
    ...(effectiveSystem ? { system: [{ text: effectiveSystem }] } : {}),
    inferenceConfig: { maxTokens },
    ...(tools?.length ? { toolConfig: buildToolConfig(tools) } : {}),
  });
  const response = await this.client.send(cmd);

  let accumulatedText = '';
  let usage;
  let stopReason;

  for await (const event of response.stream) {
    if (event.contentBlockDelta?.delta?.text) {
      const delta = event.contentBlockDelta.delta.text;
      accumulatedText += delta;
      yield { type: 'text_delta', text: delta };
    }
    if (event.messageStop) stopReason = event.messageStop.stopReason;
    if (event.metadata?.usage) usage = event.metadata.usage;
  }
  yield {
    type: 'done',
    text: accumulatedText,
    usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : {},
    stopReason,
    model,
  };
};

// ---- request/response translation ----------------------------------------

/**
 * Bedrock Converse message shape:
 *   { role: 'user' | 'assistant', content: [{ text } | { image: { format, source: { bytes } } } | { toolUse } | { toolResult }] }
 */
function translateMessage(m) {
  if (m.role === 'system') {
    throw new Error(
      "Bedrock: system messages belong in the `system` field, not `messages`. " +
      "Pass the system prompt as chat({ system: '...', messages: [...] }).",
    );
  }
  if (typeof m.content === 'string') {
    return { role: m.role, content: [{ text: m.content }] };
  }
  if (!Array.isArray(m.content)) return { role: m.role, content: [{ text: '' }] };

  const content = [];
  for (const block of m.content) {
    if (block?.type === 'text') {
      content.push({ text: block.text ?? '' });
    } else if (block?.type === 'image') {
      const src = block.source ?? {};
      if (src.type === 'base64') {
        const format = mimeToBedrockFormat(src.media_type);
        content.push({
          image: { format, source: { bytes: bytesFromBase64(src.data) } },
        });
      } else if (src.type === 'url') {
        throw new Error(
          'Bedrock images must be base64 (Converse API does not fetch URLs). ' +
          'Convert the URL client-side or use imageFromFile() for local files.',
        );
      }
    } else if (block?.type === 'tool_use') {
      content.push({
        toolUse: { toolUseId: block.id, name: block.name, input: block.input },
      });
    } else if (block?.type === 'tool_result') {
      const result = typeof block.content === 'string'
        ? [{ text: block.content }]
        : Array.isArray(block.content) ? block.content : [{ json: block.content }];
      content.push({
        toolResult: {
          toolUseId: block.tool_use_id,
          content: result,
          ...(block.is_error ? { status: 'error' } : {}),
        },
      });
    } else if (block?.type === 'document') {
      throw new Error(
        'PDF/document blocks are not supported via the Bedrock Converse API. ' +
        'For Claude-on-Bedrock PDFs, use the InvokeModelCommand path directly.',
      );
    }
  }
  return { role: m.role, content };
}

function normalizeChatResponse(out, model) {
  const content = out.output?.message?.content ?? [];
  const text = content.filter(b => typeof b.text === 'string').map(b => b.text).join('');
  const toolCalls = content
    .filter(b => b.toolUse)
    .map(b => ({ id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input }));
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: out,
    usage: out.usage ? { input_tokens: out.usage.inputTokens, output_tokens: out.usage.outputTokens } : {},
    stopReason: toolCalls.length ? 'tool_use' : out.stopReason,
    model,
  };
}

function buildToolConfig(tools) {
  return {
    tools: tools.map(t => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.input_schema ?? t.parameters ?? {} },
      },
    })),
  };
}

function mimeToBedrockFormat(mediaType) {
  if (!mediaType) return 'png';
  const m = mediaType.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  throw new Error(`Bedrock supports png/jpeg/gif/webp, got media_type=${mediaType}`);
}

function bytesFromBase64(b64) {
  // Buffer is used to preserve interop with the AWS SDK, which will accept a
  // Uint8Array / Buffer wherever `bytes` appears.
  return Buffer.from(b64, 'base64');
}

function titanOrCohereEmbedBody(modelId, text) {
  if (modelId.startsWith('cohere.embed')) {
    return { texts: [text], input_type: 'search_document' };
  }
  // Amazon Titan embed v1/v2 shape
  return { inputText: text };
}

function extractEmbedding(modelId, parsed) {
  if (modelId.startsWith('cohere.embed')) {
    // Cohere: { embeddings: [[...], ...], response_type: 'embeddings_by_type' | ... }
    // For a single input, take the first vector.
    if (Array.isArray(parsed.embeddings)) return parsed.embeddings[0];
    if (Array.isArray(parsed.embeddings?.float)) return parsed.embeddings.float[0];
    throw new Error('Cohere embed response missing embeddings');
  }
  // Titan: { embedding: [...], inputTextTokenCount: ... }
  if (Array.isArray(parsed.embedding)) return parsed.embedding;
  throw new Error(`Bedrock embed: unexpected response shape for ${modelId}`);
}

module.exports = BedrockLLMService;
