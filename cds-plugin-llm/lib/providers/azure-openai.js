// Azure OpenAI provider. Same request/response shapes as OpenAI, but URL
// scheme is per-deployment and auth is `api-key` header (not Bearer).
//
//   Endpoint pattern:
//     <endpoint>/openai/deployments/<deployment>/chat/completions?api-version=<v>
//     <endpoint>/openai/deployments/<deployment>/embeddings?api-version=<v>
//
// The `model` field in the request body is ignored by Azure — the deployment
// itself pins the model. We still send it for compatibility with logs.
//
// Configuration (via credentials):
//   endpoint:           e.g. 'https://my-aoai.openai.azure.com'
//   apiKey:             Azure API key (from Azure Portal -> Keys)
//   deployment:         deployment name (from Azure Foundry)
//   embeddingDeployment: separate deployment for embeddings (optional)
//   apiVersion:         e.g. '2024-10-21' (default: '2024-10-21')

const cds = require('@sap/cds');
const OpenAICompatibleLLMService = require('./openai-compatible');

const DEFAULT_API_VERSION = '2024-10-21';

class AzureOpenAILLMService extends OpenAICompatibleLLMService {
  async init() {
    // Validate Azure-specific fields BEFORE calling super.init — Azure uses a
    // per-deployment URL scheme and `api-key` header, so the parent's apiKey/
    // baseUrl validation doesn't apply. Set skipApiKeyCheck + provide a stub
    // baseUrl so the parent init runs (for cds.log setup, retries, etc.)
    // without throwing.
    const c = this.options.credentials ?? {};
    this.endpoint = c.endpoint;
    this.apiKey = c.apiKey;
    this.deployment = c.deployment;
    this.embeddingDeployment = c.embeddingDeployment ?? c.deployment;
    this.apiVersion = c.apiVersion ?? DEFAULT_API_VERSION;

    const missing = [];
    if (!this.endpoint) missing.push('endpoint');
    if (!this.apiKey) missing.push('apiKey');
    if (!this.deployment) missing.push('deployment');
    if (missing.length > 0) {
      throw new Error(
        `AzureOpenAILLMService: missing required credentials: ${missing.join(', ')}. ` +
        `Set via cds.requires.<name>.credentials.{endpoint,apiKey,deployment} or the ` +
        `equivalent env vars (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, ` +
        `AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_EMBEDDING_DEPLOYMENT?).`
      );
    }
    // Normalize: trim trailing slash
    this.endpoint = this.endpoint.replace(/\/$/, '');

    // Now that our fields are set + validated, invoke parent init safely:
    // stub baseUrl (we override _endpoint / _embedEndpoint anyway) and
    // opt out of the parent's apiKey check.
    this.options.skipApiKeyCheck = true;
    this.options.credentials = { ...c, baseUrl: c.baseUrl ?? this.endpoint };
    await super.init();
    // Restore our own values (super.init may have set this.apiKey to undefined
    // because Azure doesn't use OPENAI_API_KEY env).
    this.apiKey = c.apiKey;
    this.log = cds.log('llm:azure-openai');
  }

  _endpoint() {
    return `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
  }

  _embedEndpoint() {
    return `${this.endpoint}/openai/deployments/${this.embeddingDeployment}/embeddings?api-version=${this.apiVersion}`;
  }

  async _headers() {
    return {
      'content-type': 'application/json',
      'api-key': this.apiKey,
    };
  }
}

module.exports = AzureOpenAILLMService;
