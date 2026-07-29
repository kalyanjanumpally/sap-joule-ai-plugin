// Build the tool set exposed via MCP. Each tool wraps a provider method and
// declares its input schema for the MCP client to see.

const { PROVIDER_KINDS, PROVIDER_DEFAULTS } = require('../cli/providerFactory');

function buildTools({ provider, providerKind, providerModel }) {
  return [
    {
      name: 'chat',
      description:
        'Send a prompt to the configured LLM and return the text response. ' +
        `Currently backed by provider '${providerKind}' with model '${providerModel}'.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt:    { type: 'string', description: 'The user prompt.' },
          system:    { type: 'string', description: 'Optional system prompt.' },
          maxTokens: { type: 'number', description: 'Max output tokens (default 1024).' },
        },
        required: ['prompt'],
      },
      handler: async ({ prompt, system, maxTokens }) => {
        if (typeof prompt !== 'string' || prompt.length === 0) {
          throw new Error('prompt must be a non-empty string');
        }
        const req = { messages: [{ role: 'user', content: prompt }], maxTokens: maxTokens ?? 1024 };
        if (system) req.system = system;
        const res = await provider.chat(req);
        return {
          text: res.text,
          model: res.model,
          usage: res.usage,
          stopReason: res.stopReason,
          cached: res.cached ?? false,
        };
      },
    },
    {
      name: 'embed',
      description:
        'Embed one or more input strings into vectors using the configured provider. ' +
        `Backed by provider '${providerKind}'.`,
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Text to embed. String or array of strings.',
          },
        },
        required: ['input'],
      },
      handler: async ({ input }) => {
        if (providerKind === 'anthropic') {
          throw new Error("provider 'anthropic' does not support embed(); reconfigure with an embedding-capable provider");
        }
        if (input == null) throw new Error('input is required');
        const res = await provider.embed({ input });
        return {
          model: res.model,
          count: res.embeddings.length,
          dimension: res.embeddings[0]?.length ?? 0,
          embeddings: res.embeddings,
        };
      },
    },
    {
      name: 'verify',
      description:
        'Sanity-check the configured provider by sending a tiny probe. ' +
        'Returns latency, reply, and whether the response looked ok. Useful for health checks.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const start = Date.now();
        const res = await provider.chat({
          messages: [{ role: 'user', content: 'reply with a single word: ok' }],
          maxTokens: 32,
        });
        return {
          provider: providerKind,
          model: res.model ?? providerModel,
          ok: /ok/i.test(res.text ?? ''),
          latencyMs: Date.now() - start,
          text: res.text?.trim().slice(0, 200) ?? '',
          usage: res.usage,
        };
      },
    },
    {
      name: 'list_providers',
      description: 'List every provider kind this plugin supports, with default model + required env vars.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        return {
          activeProvider: providerKind,
          activeModel: providerModel,
          supported: PROVIDER_KINDS.map(k => ({
            kind: k,
            defaultModel: PROVIDER_DEFAULTS[k].model,
          })),
        };
      },
    },
  ];
}

/**
 * Build the resource set — read-only introspection endpoints. Clients can
 * attach these to a conversation as context ("here is your active provider
 * config...") without invoking a tool.
 */
function buildResources({ provider, providerKind, providerModel, cacheStats }) {
  const resources = [
    {
      uri: 'config://active-provider',
      name: 'Active provider configuration',
      description: 'Which provider + model the server is currently backed by, and its middleware count.',
      mimeType: 'application/json',
      read: async () => ({
        provider: providerKind,
        model: providerModel,
        middleware: {
          count: Array.isArray(provider.middleware) ? provider.middleware.length : 0,
        },
        defaultMaxTokens: provider.defaultMaxTokens,
      }),
    },
    {
      uri: 'config://supported-providers',
      name: 'Supported provider kinds',
      description: 'All provider kinds the plugin can be configured with, plus their default models.',
      mimeType: 'application/json',
      read: async () => ({
        supported: PROVIDER_KINDS.map(k => ({
          kind: k,
          defaultModel: PROVIDER_DEFAULTS[k].model,
        })),
      }),
    },
  ];

  if (cacheStats) {
    resources.push({
      uri: 'usage://cache-stats',
      name: 'Response cache stats',
      description: 'Hits, misses, and current size of the LLM response cache (if enabled).',
      mimeType: 'application/json',
      read: async () => cacheStats(),
    });
  }

  return resources;
}

module.exports = { buildTools, buildResources };
