const {
  imageFromFile, imageFromUrl, imageFromBase64,
  pdfFromFile, pdfFromUrl, pdfFromBase64,
} = require('./util');
const { runTools } = require('./toolRunner');

module.exports = {
  LLMService: require('./LLMService'),
  AnthropicLLMService: require('./providers/anthropic'),
  OllamaLLMService: require('./providers/ollama'),
  GenAIHubLLMService: require('./providers/genai-hub'),
  OpenAICompatibleLLMService: require('./providers/openai-compatible'),
  AzureOpenAILLMService: require('./providers/azure-openai'),
  GroqLLMService: require('./providers/groq'),
  // Vision helpers
  imageFromFile,
  imageFromUrl,
  imageFromBase64,
  // PDF helpers (Anthropic-only + OpenAI-compat since 0.9.0)
  pdfFromFile,
  pdfFromUrl,
  pdfFromBase64,
  // Tool runner — automatic multi-turn agent loop (new in 1.1.0)
  runTools,
  // Built-in middleware helpers (new in 1.3.0)
  rateLimit: require('./middleware/rateLimit').rateLimit,
  otel: require('./middleware/otel').otel,
  // Redis-backed rate limit (new in 1.4.0)
  redisRateLimit: require('./middleware/redisRateLimit').redisRateLimit,
  // Prompt-template registry (new in 1.8.0)
  PromptRegistry: require('./promptRegistry').PromptRegistry,
  builtInPrompts: require('./promptRegistry').builtInPrompts,
  // OpenAI Files API helper (new in 1.14.0)
  uploadPdfFromUrl: require('./openaiFiles').uploadPdfFromUrl,
  // MCP HTTP transport helpers (new in 1.16.0)
  createJwtVerifier: require('./mcp/jwtVerifier').createJwtVerifier,
};
