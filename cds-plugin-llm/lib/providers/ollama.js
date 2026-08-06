const cds = require('@sap/cds');
const LLMService = require('../LLMService');
const { throwFromResponse } = require('../util');

class OllamaLLMService extends LLMService {
  async init() {
    await super.init();
    this.baseUrl = this.options.credentials?.baseUrl
      ?? process.env.OLLAMA_BASE_URL
      ?? 'http://localhost:11434';
    this.modelId = this.modelId ?? 'llama3.2';
    this.log = cds.log('llm:ollama');
  }

  async _chat({ model, maxTokens, system, messages, format, tools }) {
    const body = {
      model,
      stream: false,
      options: { num_predict: maxTokens },
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map(translateMessage),
      ],
    };

    // Ollama supports 'json' string (loose) or a JSON-schema object (strict,
    // in recent Ollama versions). Pass the schema through if given.
    if (format) body.format = format;

    if (tools?.length) {
      // Ollama uses OpenAI-style tool shape (supported on tools-capable models
      // like qwen2.5, llama3.1+, mistral). Unified {name, description, input_schema}
      // -> OpenAI function shape.
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema ?? t.parameters,
        },
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwFromResponse(res, 'Ollama');
    }

    const data = await res.json();
    const toolCalls = (data.message?.tool_calls ?? []).map(tc => ({
      id: tc.id ?? `ollama_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.function?.name,
      input: tc.function?.arguments ?? {},
    }));
    return {
      text: data.message?.content ?? '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: data,
      usage: {
        input_tokens: data.prompt_eval_count,
        output_tokens: data.eval_count,
      },
      stopReason: toolCalls.length ? 'tool_use' : data.done_reason,
      model: data.model,
    };
  }

  async _embed({ model, input }) {
    const inputs = Array.isArray(input) ? input : [input];
    const embeddings = [];
    for (const text of inputs) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) await throwFromResponse(res, 'Ollama');
      const data = await res.json();
      embeddings.push(data.embedding);
    }
    return { embeddings, model };
  }
}

/**
 * Ollama message shape:
 *   { role, content: string, images?: [base64, ...] }
 * Multi-block content (text + image blocks) is decomposed: text parts joined,
 * image parts extracted to the `images` array (base64 required — Ollama does
 * not accept URLs directly).
 */
function translateMessage(m) {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  if (!Array.isArray(m.content)) return { role: m.role, content: '' };

  const textParts = [];
  const images = [];
  for (const block of m.content) {
    if (block?.type === 'text') textParts.push(block.text ?? '');
    else if (block?.type === 'image') {
      const src = block.source ?? {};
      if (src.type === 'base64') images.push(src.data);
      else if (src.type === 'url') {
        throw new Error(
          'Ollama images must be base64. Convert URLs client-side (e.g. via fetch + toString(\'base64\')), or use imageFromFile() for local files.'
        );
      }
    }
    else if (block?.type === 'document') {
      throw new Error(
        'PDF/document blocks are not supported on Ollama. Only Anthropic has native PDF ' +
        'understanding. For Ollama, render PDF pages to images (e.g. via poppler / pdftoppm) ' +
        'and pass them as image blocks to a vision model like llava or llama3.2-vision.'
      );
    }
    else if (block?.type === 'audio') {
      throw new Error(
        'Audio blocks are not supported on Ollama today. Transcribe the audio client-side ' +
        '(e.g. via whisper.cpp) and pass the transcript as a text block, or switch the '  +
        "provider to Gemini (native inline audio) or an OpenAI-compat GPT-4o Audio endpoint."
      );
    }
  }
  const out = { role: m.role, content: textParts.join('\n') };
  if (images.length) out.images = images;
  return out;
}

/**
 * Streaming: sets `stream:true` on the request, parses newline-delimited JSON
 * responses from Ollama, and yields unified chunks. Ollama's stream ends with
 * an object carrying `done:true` and totals.
 */
OllamaLLMService.prototype._stream = async function* _stream(
  { model, maxTokens, system, messages, format, tools },
) {
  const body = {
    model,
    stream: true,
    options: { num_predict: maxTokens },
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(translateMessage),
    ],
  };
  if (format) body.format = format;
  if (tools?.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? t.parameters },
    }));
  }

  const res = await fetch(`${this.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwFromResponse(res, 'Ollama');

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const delta = evt.message?.content;
      if (delta) {
        accumulatedText += delta;
        yield { type: 'text_delta', text: delta };
      }
      if (evt.done) {
        yield {
          type: 'done',
          text: accumulatedText,
          usage: { input_tokens: evt.prompt_eval_count, output_tokens: evt.eval_count },
          stopReason: evt.done_reason,
          model: evt.model,
        };
      }
    }
  }
};

module.exports = OllamaLLMService;
