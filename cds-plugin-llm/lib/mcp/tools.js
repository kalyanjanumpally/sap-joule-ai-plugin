// Build the tool set exposed via MCP. Each tool wraps a provider method and
// declares its input schema for the MCP client to see.
//
// v1.18.0: tools take a `ProviderRegistry` (default provider + optional named
// aliases from --providers-config). Each tool grows a `provider: '<alias>'`
// argument; when supplied it routes the call to that alias's provider,
// otherwise it falls back to the session default set via `initialize._meta.provider`,
// and finally to the top-level default. Unknown aliases surface as tool errors
// with the list of configured aliases so the model can self-correct.

const { PROVIDER_KINDS, PROVIDER_DEFAULTS } = require('../cli/providerFactory');

// Common inputSchema fragment for the alias-selection arg. Kept as a helper
// so every tool's schema description stays consistent.
const providerArg = (registry) => ({
  type: 'string',
  description: registry.hasAliases()
    ? `Optional provider alias — one of: ${registry.list().map(a => a.alias).join(', ')}. Overrides the session default from initialize._meta.provider. Omit to use the top-level default.`
    : 'Optional provider alias. (No aliases configured — set --providers-config on the server to enable.)',
});

/**
 * @param {object} args
 * @param {ProviderRegistry} args.providers - resolve(alias?) -> {provider, kind, model}
 */
function buildTools({ providers }) {
  const resolveEntry = (argAlias, ctx) => {
    const alias = argAlias ?? ctx?.sessionState?.provider ?? null;
    return providers.resolve(alias);
  };

  return [
    {
      name: 'chat',
      description: describeChat(providers),
      inputSchema: {
        type: 'object',
        properties: {
          prompt:    { type: 'string', description: 'The user prompt.' },
          system:    { type: 'string', description: 'Optional system prompt.' },
          maxTokens: { type: 'number', description: 'Max output tokens (default 1024).' },
          provider:  providerArg(providers),
        },
        required: ['prompt'],
      },
      handler: async ({ prompt, system, maxTokens, provider: alias }, ctx) => {
        if (typeof prompt !== 'string' || prompt.length === 0) {
          throw new Error('prompt must be a non-empty string');
        }
        const { provider, kind, model } = resolveEntry(alias, ctx);
        const req = { messages: [{ role: 'user', content: prompt }], maxTokens: maxTokens ?? 1024 };
        if (system) req.system = system;
        const res = await provider.chat(req);
        return {
          text: res.text,
          model: res.model ?? model,
          provider: kind,
          usage: res.usage,
          stopReason: res.stopReason,
          cached: res.cached ?? false,
        };
      },
    },
    {
      name: 'embed',
      description: describeEmbed(providers),
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
          provider: providerArg(providers),
        },
        required: ['input'],
      },
      handler: async ({ input, provider: alias }, ctx) => {
        const { provider, kind } = resolveEntry(alias, ctx);
        if (kind === 'anthropic') {
          throw new Error(`provider '${kind}' does not support embed(); pick a different alias or reconfigure with an embedding-capable provider`);
        }
        if (input == null) throw new Error('input is required');
        const res = await provider.embed({ input });
        return {
          model: res.model,
          provider: kind,
          count: res.embeddings.length,
          dimension: res.embeddings[0]?.length ?? 0,
          embeddings: res.embeddings,
        };
      },
    },
    {
      name: 'verify',
      description:
        'Sanity-check a configured provider by sending a tiny probe. ' +
        'Returns latency, reply, and whether the response looked ok. Useful for health checks.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: providerArg(providers),
        },
      },
      handler: async ({ provider: alias }, ctx) => {
        const { provider, kind, model } = resolveEntry(alias, ctx);
        const start = Date.now();
        const res = await provider.chat({
          messages: [{ role: 'user', content: 'reply with a single word: ok' }],
          maxTokens: 32,
        });
        return {
          provider: kind,
          model: res.model ?? model,
          ok: /ok/i.test(res.text ?? ''),
          latencyMs: Date.now() - start,
          text: res.text?.trim().slice(0, 200) ?? '',
          usage: res.usage,
        };
      },
    },
    {
      name: 'list_providers',
      description: 'List every provider kind this plugin supports, the active default, and any configured aliases. Aliases are pickable via the `provider` arg on chat/embed/verify.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        return {
          activeProvider: providers.default.kind,
          activeModel: providers.default.model,
          aliases: providers.list(),
          supported: PROVIDER_KINDS.map(k => ({
            kind: k,
            defaultModel: PROVIDER_DEFAULTS[k].model,
          })),
        };
      },
    },
  ];
}

function describeChat(providers) {
  const base = `Send a prompt to a configured LLM and return the text response. `
    + `Default: provider '${providers.default.kind}' with model '${providers.default.model}'.`;
  if (!providers.hasAliases()) return base;
  const aliases = providers.list().map(a => `${a.alias} (${a.kind}, ${a.model})`).join('; ');
  return `${base} Pick a different backend by passing \`provider: <alias>\`. Configured: ${aliases}.`;
}

function describeEmbed(providers) {
  return 'Embed one or more input strings into vectors using a configured provider. '
    + `Default: provider '${providers.default.kind}'. Override with \`provider: <alias>\`.`;
}

/**
 * Build the resource set — read-only introspection endpoints. Clients can
 * attach these to a conversation as context ("here is your active provider
 * config...") without invoking a tool.
 */
function buildResources({ providers, cacheStats }) {
  const resources = [
    {
      uri: 'config://active-provider',
      name: 'Active provider configuration',
      description: 'Which provider + model the server is currently backed by, and its middleware count.',
      mimeType: 'application/json',
      read: async () => ({
        provider: providers.default.kind,
        model: providers.default.model,
        middleware: {
          count: Array.isArray(providers.default.provider.middleware) ? providers.default.provider.middleware.length : 0,
        },
        defaultMaxTokens: providers.default.provider.defaultMaxTokens,
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
    {
      uri: 'config://providers',
      name: 'Configured provider aliases (1.18.0)',
      description: 'Every named provider alias this MCP server is serving, with its backing kind + model. Credentials are never returned. Pick one via the `provider` arg on chat/embed/verify or set as a session default via initialize._meta.provider.',
      mimeType: 'application/json',
      read: async () => ({
        default: { kind: providers.default.kind, model: providers.default.model },
        aliases: providers.list(),
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

/**
 * Build parametrized resource templates. Clients discover these via
 * `resources/templates/list`, substitute variables, and call `resources/read`
 * with the concrete URI.
 */
function buildResourceTemplates({ prompts }) {
  const templates = [];
  templates.push({
    uriTemplate: 'provider://{kind}',
    name: 'Provider defaults',
    description: 'Default model + credential env vars for a specific provider kind.',
    mimeType: 'application/json',
    read: ({ kind }) => {
      if (!PROVIDER_KINDS.includes(kind)) {
        throw new Error(`unknown provider kind: ${kind}. supported: ${PROVIDER_KINDS.join(', ')}`);
      }
      return { kind, defaultModel: PROVIDER_DEFAULTS[kind].model };
    },
  });
  if (prompts) {
    templates.push({
      uriTemplate: 'prompt://{name}',
      name: 'Prompt template metadata',
      description: 'Metadata (description + argument list) for a registered prompt template. To render, use prompts/get.',
      mimeType: 'application/json',
      read: ({ name }) => {
        if (!prompts.has(name)) {
          throw new Error(`unknown prompt: ${name}`);
        }
        const p = prompts.get(name);
        return { name: p.name, description: p.description, arguments: p.arguments };
      },
    });
  }
  return templates;
}

module.exports = { buildTools, buildResources, buildResourceTemplates };
