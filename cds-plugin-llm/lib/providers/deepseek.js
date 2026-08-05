// DeepSeek — direct API access to DeepSeek-V3 (chat) and DeepSeek-R1
// (reasoning). OpenAI-compatible /chat/completions shape.
//
// Configuration (via credentials or env):
//   apiKey:  DEEPSEEK_API_KEY
//   baseUrl: default 'https://api.deepseek.com'
//
// Model shortcuts:
//   deepseek-chat      → DeepSeek-V3 (general-purpose)
//   deepseek-reasoner  → DeepSeek-R1 (reasoning; slower + pricier + more tokens)

const OpenAICompatibleLLMService = require('./openai-compatible');

class DeepSeekLLMService extends OpenAICompatibleLLMService {
  async init() {
    this.options.baseUrl = this.options.credentials?.baseUrl
      ?? this.options.baseUrl
      ?? 'https://api.deepseek.com';
    this.options.apiKeyEnv = 'DEEPSEEK_API_KEY';
    this.options.kind = 'deepseek';
    await super.init();
    this.modelId = this.modelId ?? 'deepseek-chat';
  }
}

module.exports = DeepSeekLLMService;
