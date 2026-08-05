// Mistral AI — direct API access to Mistral Large, Codestral, and the
// smaller open-weights family. OpenAI-compatible /chat/completions.
//
// Configuration (via credentials or env):
//   apiKey:  MISTRAL_API_KEY
//   baseUrl: default 'https://api.mistral.ai/v1'
//
// Model shortcuts:
//   mistral-large-latest    → flagship generalist
//   mistral-small-latest    → cheap/fast
//   codestral-latest        → code-specialized
//   mistral-embed           → embedding model

const OpenAICompatibleLLMService = require('./openai-compatible');

class MistralLLMService extends OpenAICompatibleLLMService {
  async init() {
    this.options.baseUrl = this.options.credentials?.baseUrl
      ?? this.options.baseUrl
      ?? 'https://api.mistral.ai/v1';
    this.options.apiKeyEnv = 'MISTRAL_API_KEY';
    this.options.kind = 'mistral';
    await super.init();
    this.modelId = this.modelId ?? 'mistral-large-latest';
  }
}

module.exports = MistralLLMService;
