// Provider-alias registry (v1.18.0). Lets one `saptarishi-llm mcp` process
// serve multiple named provider configurations behind a single MCP endpoint.
// Clients pick which one to use per session (via `initialize._meta.provider`)
// or per tool-call (via the `provider` arg on `chat`/`embed`/`verify`).
//
// Config file shape (JSON):
//
//   {
//     "cheap": {
//       "kind": "groq",
//       "model": "llama-3.1-8b-instant",
//       "credentials": { "apiKey": "gsk_..." }
//     },
//     "smart": {
//       "kind": "anthropic",
//       "model": "claude-opus-4-7",
//       "credentials": { "apiKey": "sk-ant-..." }
//     }
//   }
//
// Every entry is instantiated eagerly at load time — a bad credential or
// missing field surfaces at `saptarishi-llm mcp` startup, not on the first
// tool call from a client.
//
// Credentials NEVER leak from the registry. `list()` returns kind + model
// only; `config://providers` mirrors that. The provider instance holds the
// secret internally, same as the top-level provider.

const fs = require('node:fs/promises');
const path = require('node:path');
const { PROVIDER_KINDS } = require('./providerFactory');

/**
 * Parse a providers-config JSON file (or the parsed object) and eagerly
 * instantiate a provider for each alias. Returns a ProviderRegistry.
 *
 * @param {object|string} source - Absolute path to a JSON file, or an
 *   already-parsed config object.
 * @param {object} defaultEntry - The top-level provider entry
 *   `{ provider, kind, model }` used when no alias is selected.
 * @returns {Promise<ProviderRegistry>}
 */
async function loadProviderAliases(source, defaultEntry) {
  let config;
  if (typeof source === 'string') {
    const raw = await fs.readFile(source, 'utf8');
    try { config = JSON.parse(raw); }
    catch (e) { throw new Error(`providers-config: invalid JSON at ${source}: ${e.message}`); }
  } else if (source && typeof source === 'object') {
    config = source;
  } else {
    throw new Error('providers-config: expected a file path or config object');
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('providers-config: root must be an object mapping alias -> { kind, ... }');
  }

  const aliases = new Map();
  for (const [alias, spec] of Object.entries(config)) {
    if (alias === 'default') {
      throw new Error("providers-config: alias 'default' is reserved");
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(alias)) {
      throw new Error(`providers-config: invalid alias '${alias}' — must match /^[a-zA-Z][a-zA-Z0-9_-]*$/`);
    }
    if (!spec || typeof spec !== 'object') {
      throw new Error(`providers-config: alias '${alias}' must be an object`);
    }
    const { kind, model, credentials, maxTokens } = spec;
    if (!PROVIDER_KINDS.includes(kind)) {
      throw new Error(`providers-config: alias '${alias}' has unknown kind '${kind}'. supported: ${PROVIDER_KINDS.join(', ')}`);
    }
    if (!credentials || typeof credentials !== 'object') {
      throw new Error(`providers-config: alias '${alias}' is missing 'credentials' object`);
    }
    const provider = instantiate(kind, { modelId: model, maxTokens: maxTokens ?? 1024, credentials });
    aliases.set(alias, { provider, kind, model: model ?? '(default)' });
  }

  return new ProviderRegistry(defaultEntry, aliases);
}

/**
 * Runtime registry. Wraps the default provider + zero-or-more aliased
 * providers with a single `resolve()` API.
 *
 * Not persisted anywhere — held in closure by the MCP command.
 */
class ProviderRegistry {
  constructor(defaultEntry, aliases = new Map()) {
    if (!defaultEntry?.provider) {
      throw new Error('ProviderRegistry requires a defaultEntry with a .provider');
    }
    this.default = defaultEntry;
    this.aliases = aliases;
  }

  /**
   * Return the alias entry `{provider, kind, model}` for `alias`, or the
   * default entry when `alias` is null/undefined/empty. Throws with an
   * actionable message on unknown alias so tool errors surface the typo
   * (they land as `isError: true` on the tool result, which the MCP client
   * shows to the model — this message gets read).
   */
  resolve(alias) {
    if (alias == null || alias === '') return this.default;
    if (typeof alias !== 'string') {
      throw new Error(`provider alias must be a string, got ${typeof alias}`);
    }
    if (!this.aliases.has(alias)) {
      const available = [...this.aliases.keys()];
      const suffix = available.length > 0
        ? ` — configured aliases: ${available.join(', ')}`
        : ' — no provider aliases configured (set --providers-config to enable)';
      throw new Error(`unknown provider alias '${alias}'${suffix}`);
    }
    return this.aliases.get(alias);
  }

  /**
   * Enumerate configured aliases (excluding the default). Used by the
   * `list_providers` tool and the `config://providers` resource.
   * Credentials are NEVER returned.
   */
  list() {
    return [...this.aliases.entries()].map(([alias, e]) => ({
      alias, kind: e.kind, model: e.model,
    }));
  }

  hasAliases() { return this.aliases.size > 0; }

  /** Call `init()` on every aliased provider. Concurrent — fails fast. */
  async initAll() {
    await Promise.all([...this.aliases.values()].map(e => e.provider.init()));
  }
}

function instantiate(kind, opts) {
  const modules = {
    anthropic: '../providers/anthropic',
    ollama: '../providers/ollama',
    groq: '../providers/groq',
    'openai-compatible': '../providers/openai-compatible',
    'azure-openai': '../providers/azure-openai',
    'genai-hub': '../providers/genai-hub',
  };
  const Cls = require(modules[kind]);
  return new Cls('llm', null, opts);
}

/**
 * Resolve `--providers-config <path>` / `SAPTARISHI_LLM_PROVIDERS_CONFIG`
 * to an absolute path, or null when neither is set.
 */
function resolveConfigPath(opts, env, cwd = process.cwd()) {
  const raw = opts['providers-config'] ?? env.SAPTARISHI_LLM_PROVIDERS_CONFIG ?? null;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

module.exports = { loadProviderAliases, ProviderRegistry, resolveConfigPath };
