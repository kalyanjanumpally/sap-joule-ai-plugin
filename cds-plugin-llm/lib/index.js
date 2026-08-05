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
  GeminiLLMService: require('./providers/gemini'),
  BedrockLLMService: require('./providers/bedrock'),
  FireworksLLMService: require('./providers/fireworks'),
  DeepSeekLLMService: require('./providers/deepseek'),
  MistralLLMService: require('./providers/mistral'),
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
  // Multi-agent orchestration (new in 1.27.0)
  Agent: require('./agents').Agent,
  runAgents: require('./agents').runAgents,
  DEFAULT_COORDINATOR_SYSTEM: require('./agents').DEFAULT_COORDINATOR_SYSTEM,
  // Built-in middleware helpers (new in 1.3.0)
  rateLimit: require('./middleware/rateLimit').rateLimit,
  otel: require('./middleware/otel').otel,
  // Redis-backed rate limit (new in 1.4.0)
  redisRateLimit: require('./middleware/redisRateLimit').redisRateLimit,
  // Per-request cost + token metering (new in 1.21.0)
  usageMetering: require('./middleware/usageMetering').usageMetering,
  DEFAULT_PRICING: require('./pricing').DEFAULT_PRICING,
  // Auto-persist metering records to a CAP entity (new in 1.22.0)
  usageMeteringToCap: require('./middleware/usageMeteringToCap').usageMeteringToCap,
  DEFAULT_LLM_USAGE_ENTITY: require('./middleware/usageMeteringToCap').DEFAULT_ENTITY,
  // Response cache middleware — memoizes identical chat() calls (new in 1.26.0)
  responseCache: require('./middleware/responseCache').responseCache,
  InMemoryLRU: require('./middleware/responseCache').InMemoryLRU,
  // Guardrails — input/output filters for PII, injection, blocklists (new in 1.28.0)
  guardrails: require('./middleware/guardrails').guardrails,
  GuardrailBlockedError: require('./middleware/guardrails').GuardrailBlockedError,
  filters: require('./filters'),
  // Cost budgets + alerts — per-tenant/model/total ceilings (new in 1.29.0)
  costBudget: require('./middleware/costBudget').costBudget,
  BudgetExceededError: require('./middleware/costBudget').BudgetExceededError,
  // Pluggable budget counter stores — Redis for multi-instance (new in 1.30.0)
  InMemoryCounterStore: require('./middleware/costBudget').InMemoryCounterStore,
  RedisCounterStore: require('./middleware/costBudget').RedisCounterStore,
  // Prompt-template registry (new in 1.8.0)
  PromptRegistry: require('./promptRegistry').PromptRegistry,
  builtInPrompts: require('./promptRegistry').builtInPrompts,
  // OpenAI Files API helper (new in 1.14.0)
  uploadPdfFromUrl: require('./openaiFiles').uploadPdfFromUrl,
  // MCP HTTP transport helpers (new in 1.16.0)
  createJwtVerifier: require('./mcp/jwtVerifier').createJwtVerifier,
  // MCP transport factories (new in 1.20.0 — Streamable HTTP)
  createHttpTransport: require('./mcp/httpTransport').createHttpTransport,
  createStreamableHttpTransport: require('./mcp/streamableHttpTransport').createStreamableHttpTransport,
};
