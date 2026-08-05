// Fireworks AI — hosted OSS models (Llama, Qwen, Mixtral, DeepSeek, ...)
// behind an OpenAI-compatible /chat/completions endpoint. Full parity with
// chat, streaming, tools, structured outputs. Embeddings via nomic and
// mxbai models on the same base URL.
//
// Configuration (via credentials or env):
//   apiKey:  FIREWORKS_API_KEY
//   baseUrl: default 'https://api.fireworks.ai/inference/v1'

const OpenAICompatibleLLMService = require('./openai-compatible');

class FireworksLLMService extends OpenAICompatibleLLMService {
  async init() {
    this.options.baseUrl = this.options.credentials?.baseUrl
      ?? this.options.baseUrl
      ?? 'https://api.fireworks.ai/inference/v1';
    this.options.apiKeyEnv = 'FIREWORKS_API_KEY';
    this.options.kind = 'fireworks';
    await super.init();
    this.modelId = this.modelId ?? 'accounts/fireworks/models/llama-v3p3-70b-instruct';
  }
}

module.exports = FireworksLLMService;
