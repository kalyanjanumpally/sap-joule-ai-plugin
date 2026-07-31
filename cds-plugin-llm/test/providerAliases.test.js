const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadProviderAliases, ProviderRegistry, resolveConfigPath } = require('../lib/cli/providerAliases');
const { buildTools } = require('../lib/mcp/tools');

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sllm-aliases-'));
  const p = path.join(dir, 'providers.json');
  fs.writeFileSync(p, contents);
  return p;
}

function stubProvider(overrides = {}) {
  return {
    async chat() { return { text: overrides.chatText ?? 'ok', model: 'stub', usage: {}, stopReason: 'end_turn' }; },
    async embed({ input }) {
      const arr = Array.isArray(input) ? input : [input];
      return { embeddings: arr.map(() => [1, 2, 3]), model: 'stub-emb' };
    },
    async init() { /* no-op */ },
  };
}

function stubEntry(kind = 'groq', model = 'default-model', chatText = 'ok') {
  return { provider: stubProvider({ chatText }), kind, model };
}

// ---- ProviderRegistry ------------------------------------------------------

test('ProviderRegistry: requires a default entry with a provider', () => {
  assert.throws(() => new ProviderRegistry(null), /defaultEntry/);
  assert.throws(() => new ProviderRegistry({}), /defaultEntry/);
});

test('ProviderRegistry.resolve: null / undefined / empty string returns default', () => {
  const reg = new ProviderRegistry(stubEntry('groq'));
  assert.equal(reg.resolve(null).kind, 'groq');
  assert.equal(reg.resolve(undefined).kind, 'groq');
  assert.equal(reg.resolve('').kind, 'groq');
});

test('ProviderRegistry.resolve: known alias returns that entry', () => {
  const aliases = new Map([['cheap', stubEntry('groq', 'llama-3.1-8b')]]);
  const reg = new ProviderRegistry(stubEntry('anthropic'), aliases);
  assert.equal(reg.resolve('cheap').kind, 'groq');
  assert.equal(reg.resolve('cheap').model, 'llama-3.1-8b');
});

test('ProviderRegistry.resolve: unknown alias throws with configured list', () => {
  const aliases = new Map([['cheap', stubEntry('groq')], ['smart', stubEntry('anthropic')]]);
  const reg = new ProviderRegistry(stubEntry('anthropic'), aliases);
  assert.throws(() => reg.resolve('nope'), /unknown provider alias 'nope' — configured aliases: cheap, smart/);
});

test('ProviderRegistry.resolve: unknown alias with zero aliases points at --providers-config', () => {
  const reg = new ProviderRegistry(stubEntry('groq'));
  assert.throws(() => reg.resolve('nope'), /no provider aliases configured/);
});

test('ProviderRegistry.resolve: non-string alias rejected', () => {
  const reg = new ProviderRegistry(stubEntry('groq'));
  assert.throws(() => reg.resolve(42), /must be a string/);
  assert.throws(() => reg.resolve({}), /must be a string/);
});

test('ProviderRegistry.list: returns alias + kind + model (no credentials)', () => {
  const aliases = new Map([
    ['cheap', stubEntry('groq', 'llama-3.1-8b')],
    ['smart', stubEntry('anthropic', 'claude-opus-4-7')],
  ]);
  const reg = new ProviderRegistry(stubEntry('anthropic'), aliases);
  assert.deepEqual(reg.list(), [
    { alias: 'cheap', kind: 'groq', model: 'llama-3.1-8b' },
    { alias: 'smart', kind: 'anthropic', model: 'claude-opus-4-7' },
  ]);
});

test('ProviderRegistry.hasAliases: false when empty, true otherwise', () => {
  assert.equal(new ProviderRegistry(stubEntry()).hasAliases(), false);
  const aliases = new Map([['cheap', stubEntry('groq')]]);
  assert.equal(new ProviderRegistry(stubEntry(), aliases).hasAliases(), true);
});

// ---- loadProviderAliases ---------------------------------------------------

test('loadProviderAliases: parses valid JSON and builds a registry', async () => {
  const p = tmpFile(JSON.stringify({
    local: { kind: 'ollama', model: 'qwen2.5:14b', credentials: { baseUrl: 'http://localhost:11434' } },
  }));
  const reg = await loadProviderAliases(p, stubEntry('groq'));
  assert.equal(reg.hasAliases(), true);
  const entry = reg.resolve('local');
  assert.equal(entry.kind, 'ollama');
  assert.equal(entry.model, 'qwen2.5:14b');
});

test('loadProviderAliases: reads a parsed object directly', async () => {
  const reg = await loadProviderAliases({
    local: { kind: 'ollama', model: 'qwen2.5:14b', credentials: { baseUrl: 'http://localhost:11434' } },
  }, stubEntry('groq'));
  assert.equal(reg.hasAliases(), true);
});

test('loadProviderAliases: unknown kind rejected', async () => {
  await assert.rejects(
    () => loadProviderAliases({
      bogus: { kind: 'not-a-real-provider', credentials: {} },
    }, stubEntry('groq')),
    /unknown kind 'not-a-real-provider'/,
  );
});

test('loadProviderAliases: missing credentials rejected', async () => {
  await assert.rejects(
    () => loadProviderAliases({ x: { kind: 'ollama' } }, stubEntry('groq')),
    /missing 'credentials'/,
  );
});

test('loadProviderAliases: reserved alias "default" rejected', async () => {
  await assert.rejects(
    () => loadProviderAliases({ default: { kind: 'ollama', credentials: {} } }, stubEntry('groq')),
    /reserved/,
  );
});

test('loadProviderAliases: invalid alias name rejected', async () => {
  await assert.rejects(
    () => loadProviderAliases({ '123bad': { kind: 'ollama', credentials: {} } }, stubEntry('groq')),
    /invalid alias/,
  );
  await assert.rejects(
    () => loadProviderAliases({ 'has space': { kind: 'ollama', credentials: {} } }, stubEntry('groq')),
    /invalid alias/,
  );
});

test('loadProviderAliases: invalid JSON surfaces file path', async () => {
  const p = tmpFile('{not-json');
  await assert.rejects(
    () => loadProviderAliases(p, stubEntry('groq')),
    /invalid JSON/,
  );
});

test('loadProviderAliases: root must be an object', async () => {
  await assert.rejects(
    () => loadProviderAliases([{ kind: 'ollama' }], stubEntry('groq')),
    /root must be an object/,
  );
});

// ---- resolveConfigPath -----------------------------------------------------

test('resolveConfigPath: returns null when neither flag nor env set', () => {
  assert.equal(resolveConfigPath({}, {}), null);
});

test('resolveConfigPath: --providers-config wins over env', () => {
  const got = resolveConfigPath(
    { 'providers-config': '/tmp/from-flag.json' },
    { SAPTARISHI_LLM_PROVIDERS_CONFIG: '/tmp/from-env.json' },
  );
  assert.equal(got, '/tmp/from-flag.json');
});

test('resolveConfigPath: env fallback', () => {
  const got = resolveConfigPath({}, { SAPTARISHI_LLM_PROVIDERS_CONFIG: '/tmp/from-env.json' });
  assert.equal(got, '/tmp/from-env.json');
});

test('resolveConfigPath: relative path resolved against cwd', () => {
  const got = resolveConfigPath({ 'providers-config': './providers.json' }, {}, '/work/dir');
  assert.equal(got, '/work/dir/providers.json');
});

// ---- tools/call routing through aliases ------------------------------------

function makeRegistryWithAliases() {
  const aliases = new Map([
    ['cheap', stubEntry('groq', 'llama-3.1-8b', 'cheap-reply')],
    ['smart', stubEntry('anthropic', 'claude-opus-4-7', 'smart-reply')],
  ]);
  return new ProviderRegistry(stubEntry('ollama', 'qwen2.5:14b', 'default-reply'), aliases);
}

test('chat tool: no provider arg + no sessionState -> default', async () => {
  const providers = makeRegistryWithAliases();
  const [chatTool] = buildTools({ providers });
  const res = await chatTool.handler({ prompt: 'hi' }, { sessionState: {} });
  assert.equal(res.text, 'default-reply');
  assert.equal(res.provider, 'ollama');
});

test('chat tool: per-call provider arg wins over default', async () => {
  const providers = makeRegistryWithAliases();
  const [chatTool] = buildTools({ providers });
  const res = await chatTool.handler({ prompt: 'hi', provider: 'cheap' }, { sessionState: {} });
  assert.equal(res.text, 'cheap-reply');
  assert.equal(res.provider, 'groq');
});

test('chat tool: sessionState.provider used when no per-call arg', async () => {
  const providers = makeRegistryWithAliases();
  const [chatTool] = buildTools({ providers });
  const res = await chatTool.handler({ prompt: 'hi' }, { sessionState: { provider: 'smart' } });
  assert.equal(res.text, 'smart-reply');
  assert.equal(res.provider, 'anthropic');
});

test('chat tool: per-call provider wins over sessionState default', async () => {
  const providers = makeRegistryWithAliases();
  const [chatTool] = buildTools({ providers });
  const res = await chatTool.handler(
    { prompt: 'hi', provider: 'cheap' },
    { sessionState: { provider: 'smart' } },
  );
  assert.equal(res.text, 'cheap-reply');
  assert.equal(res.provider, 'groq');
});

test('chat tool: unknown alias yields tool error listing configured aliases', async () => {
  const providers = makeRegistryWithAliases();
  const [chatTool] = buildTools({ providers });
  await assert.rejects(
    () => chatTool.handler({ prompt: 'hi', provider: 'nope' }, { sessionState: {} }),
    /unknown provider alias 'nope' — configured aliases: cheap, smart/,
  );
});

test('embed tool: routes through alias', async () => {
  const providers = makeRegistryWithAliases();
  const embedTool = buildTools({ providers }).find(t => t.name === 'embed');
  const res = await embedTool.handler({ input: 'x', provider: 'cheap' }, { sessionState: {} });
  assert.equal(res.provider, 'groq');
  assert.equal(res.count, 1);
});

test('embed tool: anthropic alias rejected', async () => {
  const providers = makeRegistryWithAliases();
  const embedTool = buildTools({ providers }).find(t => t.name === 'embed');
  await assert.rejects(
    () => embedTool.handler({ input: 'x', provider: 'smart' }, { sessionState: {} }),
    /does not support embed/,
  );
});

test('verify tool: uses session default when no per-call arg', async () => {
  const providers = makeRegistryWithAliases();
  const verifyTool = buildTools({ providers }).find(t => t.name === 'verify');
  const res = await verifyTool.handler({}, { sessionState: { provider: 'smart' } });
  assert.equal(res.provider, 'anthropic');
  assert.equal(res.ok, false); // stub says 'smart-reply', doesn't match /ok/i
});

test('list_providers tool: includes configured aliases', async () => {
  const providers = makeRegistryWithAliases();
  const lp = buildTools({ providers }).find(t => t.name === 'list_providers');
  const res = await lp.handler({});
  assert.equal(res.activeProvider, 'ollama');
  assert.equal(res.aliases.length, 2);
  assert.deepEqual(res.aliases.map(a => a.alias).sort(), ['cheap', 'smart']);
});

// ---- MCPServer: initialize captures _meta.provider into sessionState -------

test('MCPServer: initialize with _meta.provider stores it in sessionState', async () => {
  const { MCPServer } = require('../lib/mcp/server');
  const server = new MCPServer({ name: 'x', version: '1.0.0' });
  const sessionState = {};
  const reply = await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: { provider: 'cheap' } } },
    { sessionState },
  );
  assert.equal(reply.result.protocolVersion, '2024-11-05');
  assert.equal(sessionState.provider, 'cheap');
});

test('MCPServer: initialize without _meta.provider leaves sessionState empty', async () => {
  const { MCPServer } = require('../lib/mcp/server');
  const server = new MCPServer({ name: 'x', version: '1.0.0' });
  const sessionState = {};
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { sessionState },
  );
  assert.equal(sessionState.provider, undefined);
});

test('MCPServer: initialize with non-string _meta.provider ignored', async () => {
  const { MCPServer } = require('../lib/mcp/server');
  const server = new MCPServer({ name: 'x', version: '1.0.0' });
  const sessionState = {};
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: { provider: 42 } } },
    { sessionState },
  );
  assert.equal(sessionState.provider, undefined);
});

test('MCPServer: tools/call handlerCtx exposes sessionState', async () => {
  const { MCPServer } = require('../lib/mcp/server');
  let seen;
  const server = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'peek', description: '', inputSchema: { type: 'object' },
      handler: async (args, ctx) => { seen = ctx.sessionState; return 'ok'; },
    }],
  });
  const reply = await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'peek', arguments: {} } },
    { sessionState: { provider: 'cheap', otherStuff: 42 } },
  );
  assert.equal(reply.result.isError, false);
  assert.equal(seen.provider, 'cheap');
  assert.equal(seen.otherStuff, 42);
});
