const PROVIDER_KINDS = [
  'anthropic', 'ollama', 'groq', 'openai-compatible', 'azure-openai',
  'gemini', 'bedrock', 'fireworks', 'deepseek', 'mistral', 'genai-hub',
];

const PROVIDER_DEFAULTS = {
  anthropic:          { model: 'claude-opus-4-7', envKey: 'ANTHROPIC_API_KEY' },
  ollama:             { model: 'qwen2.5:14b',     envBaseUrl: 'OLLAMA_URL', defaultBaseUrl: 'http://localhost:11434' },
  groq:               { model: 'llama-3.3-70b-versatile', envKey: 'GROQ_API_KEY' },
  'openai-compatible': { model: 'gpt-4o', envKey: 'OPENAI_API_KEY', envBaseUrl: 'OPENAI_BASE_URL' },
  'azure-openai':     { model: '(deployment-pinned)' },
  gemini:             { model: 'gemini-1.5-flash', envKey: 'GOOGLE_API_KEY' },
  bedrock:            { model: 'anthropic.claude-opus-4-20250514-v1:0' },
  fireworks:          { model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', envKey: 'FIREWORKS_API_KEY' },
  deepseek:           { model: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY' },
  mistral:            { model: 'mistral-large-latest', envKey: 'MISTRAL_API_KEY' },
  'genai-hub':        { model: 'gpt-4o' },
};

/**
 * Build a provider instance from CLI opts + env. Returns { provider, kind, model }
 * without connecting or calling init() — that's the caller's job.
 */
async function buildProvider({ opts, env }) {
  const kind = opts.provider ?? env.SAPTARISHI_LLM_PROVIDER ?? 'anthropic';
  if (!PROVIDER_KINDS.includes(kind)) {
    throw new Error(`unknown provider '${kind}'. supported: ${PROVIDER_KINDS.join(', ')}`);
  }
  const defaults = PROVIDER_DEFAULTS[kind];
  const model = opts.model ?? env.SAPTARISHI_LLM_MODEL ?? defaults.model;
  const maxTokens = opts['max-tokens'] ? parseInt(opts['max-tokens'], 10) : 1024;

  const providerOpts = { modelId: model, maxTokens, credentials: {} };

  if (kind === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("missing ANTHROPIC_API_KEY env var (get one at console.anthropic.com)");
    providerOpts.credentials.apiKey = apiKey;
    const AnthropicLLMService = require('../providers/anthropic');
    return { provider: makeProvider(AnthropicLLMService, providerOpts), kind, model };
  }

  if (kind === 'ollama') {
    const baseUrl = opts['base-url'] ?? env[defaults.envBaseUrl] ?? defaults.defaultBaseUrl;
    providerOpts.credentials.baseUrl = baseUrl;
    const OllamaLLMService = require('../providers/ollama');
    return { provider: makeProvider(OllamaLLMService, providerOpts), kind, model };
  }

  if (kind === 'groq') {
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) throw new Error("missing GROQ_API_KEY env var (get one at console.groq.com)");
    providerOpts.credentials.apiKey = apiKey;
    const GroqLLMService = require('../providers/groq');
    return { provider: makeProvider(GroqLLMService, providerOpts), kind, model };
  }

  if (kind === 'openai-compatible') {
    const apiKey = env.OPENAI_API_KEY;
    const baseUrl = opts['base-url'] ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    if (!apiKey) throw new Error("missing OPENAI_API_KEY env var");
    providerOpts.credentials.apiKey = apiKey;
    providerOpts.credentials.baseUrl = baseUrl;
    const OpenAICompatibleLLMService = require('../providers/openai-compatible');
    return { provider: makeProvider(OpenAICompatibleLLMService, providerOpts), kind, model };
  }

  if (kind === 'azure-openai') {
    const missing = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT']
      .filter(k => !env[k]);
    if (missing.length > 0) throw new Error(`missing env vars: ${missing.join(', ')}`);
    providerOpts.credentials = {
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiKey: env.AZURE_OPENAI_API_KEY,
      deployment: env.AZURE_OPENAI_DEPLOYMENT,
      embeddingDeployment: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
    };
    const AzureOpenAILLMService = require('../providers/azure-openai');
    // For Azure, the deployment pins the model — display it as the model
    // in `verify` and `providers` output.
    const displayModel = env.AZURE_OPENAI_DEPLOYMENT;
    return { provider: makeProvider(AzureOpenAILLMService, providerOpts), kind, model: displayModel };
  }

  if (kind === 'gemini') {
    const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("missing GOOGLE_API_KEY / GEMINI_API_KEY env var (get one at aistudio.google.com)");
    providerOpts.credentials.apiKey = apiKey;
    if (env.GEMINI_BASE_URL) providerOpts.credentials.baseUrl = env.GEMINI_BASE_URL;
    if (env.GEMINI_EMBEDDING_MODEL) providerOpts.credentials.embeddingModel = env.GEMINI_EMBEDDING_MODEL;
    const GeminiLLMService = require('../providers/gemini');
    return { provider: makeProvider(GeminiLLMService, providerOpts), kind, model };
  }

  if (kind === 'bedrock') {
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!region) throw new Error("missing AWS_REGION / AWS_DEFAULT_REGION env var (Bedrock is regional)");
    providerOpts.credentials.region = region;
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      providerOpts.credentials.accessKeyId = env.AWS_ACCESS_KEY_ID;
      providerOpts.credentials.secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (env.AWS_SESSION_TOKEN) providerOpts.credentials.sessionToken = env.AWS_SESSION_TOKEN;
    }
    if (env.BEDROCK_EMBEDDING_MODEL) providerOpts.credentials.embeddingModel = env.BEDROCK_EMBEDDING_MODEL;
    const BedrockLLMService = require('../providers/bedrock');
    return { provider: makeProvider(BedrockLLMService, providerOpts), kind, model };
  }

  if (kind === 'fireworks') {
    const apiKey = env.FIREWORKS_API_KEY;
    if (!apiKey) throw new Error("missing FIREWORKS_API_KEY env var (get one at fireworks.ai/account/api-keys)");
    providerOpts.credentials.apiKey = apiKey;
    if (opts['base-url']) providerOpts.credentials.baseUrl = opts['base-url'];
    const FireworksLLMService = require('../providers/fireworks');
    return { provider: makeProvider(FireworksLLMService, providerOpts), kind, model };
  }

  if (kind === 'deepseek') {
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("missing DEEPSEEK_API_KEY env var (get one at platform.deepseek.com/api_keys)");
    providerOpts.credentials.apiKey = apiKey;
    if (opts['base-url']) providerOpts.credentials.baseUrl = opts['base-url'];
    const DeepSeekLLMService = require('../providers/deepseek');
    return { provider: makeProvider(DeepSeekLLMService, providerOpts), kind, model };
  }

  if (kind === 'mistral') {
    const apiKey = env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("missing MISTRAL_API_KEY env var (get one at console.mistral.ai)");
    providerOpts.credentials.apiKey = apiKey;
    if (opts['base-url']) providerOpts.credentials.baseUrl = opts['base-url'];
    const MistralLLMService = require('../providers/mistral');
    return { provider: makeProvider(MistralLLMService, providerOpts), kind, model };
  }

  if (kind === 'genai-hub') {
    const missing = ['AICORE_URL', 'AICORE_TOKEN_URL', 'AICORE_CLIENT_ID', 'AICORE_CLIENT_SECRET', 'AICORE_DEPLOYMENT_ID']
      .filter(k => !env[k]);
    if (missing.length > 0) throw new Error(`missing env vars: ${missing.join(', ')}`);
    providerOpts.credentials = {
      aiCoreUrl: env.AICORE_URL,
      tokenUrl: env.AICORE_TOKEN_URL,
      clientId: env.AICORE_CLIENT_ID,
      clientSecret: env.AICORE_CLIENT_SECRET,
      deploymentId: env.AICORE_DEPLOYMENT_ID,
      resourceGroup: env.AICORE_RESOURCE_GROUP ?? 'default',
    };
    const GenAIHubLLMService = require('../providers/genai-hub');
    return { provider: makeProvider(GenAIHubLLMService, providerOpts), kind, model };
  }

  throw new Error(`unreachable: kind=${kind}`);
}

function makeProvider(Cls, options) {
  return new Cls('llm', null, options);
}

module.exports = { buildProvider, PROVIDER_KINDS, PROVIDER_DEFAULTS };
