const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { MCPServer, PROTOCOL_VERSION, ERROR_CODES } = require('../lib/mcp/server');
const { buildTools, buildResources, buildResourceTemplates } = require('../lib/mcp/tools');
const { PromptRegistry, builtInPrompts } = require('../lib/promptRegistry');

// ---- MCPServer.handleMessage: protocol correctness ------------------------

function makeServer(extraTools = []) {
  return new MCPServer({
    name: 'test-server',
    version: '0.0.1',
    tools: [
      {
        name: 'echo',
        description: 'echo the input',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        handler: async ({ msg }) => ({ echoed: msg }),
      },
      ...extraTools,
    ],
  });
}

test('MCPServer: initialize returns protocolVersion + serverInfo + capabilities', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(reply.result.serverInfo, { name: 'test-server', version: '0.0.1' });
  assert.ok(reply.result.capabilities.tools);
  assert.equal(s.initialized, true);
});

test('MCPServer: notifications/initialized returns null (no reply for notifications)', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  assert.equal(reply, null);
});

test('MCPServer: ping returns empty result', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(reply.result, {});
});

test('MCPServer: tools/list enumerates registered tools with schemas', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(reply.result.tools.length, 1);
  assert.equal(reply.result.tools[0].name, 'echo');
  assert.equal(reply.result.tools[0].description, 'echo the input');
  assert.equal(reply.result.tools[0].inputSchema.required[0], 'msg');
});

test('MCPServer: tools/call dispatches to handler + wraps result as text content', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'echo', arguments: { msg: 'hello' } },
  });
  assert.equal(reply.result.isError, false);
  assert.equal(reply.result.content[0].type, 'text');
  const parsed = JSON.parse(reply.result.content[0].text);
  assert.deepEqual(parsed, { echoed: 'hello' });
});

test('MCPServer: tools/call for unknown tool returns METHOD_NOT_FOUND', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'nosuchtool', arguments: {} },
  });
  assert.equal(reply.error.code, ERROR_CODES.METHOD_NOT_FOUND);
  assert.match(reply.error.message, /unknown tool: nosuchtool/);
});

test('MCPServer: tools/call handler throws => isError: true, no exception', async () => {
  const s = makeServer([{
    name: 'boom',
    description: 'always fails',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => { throw new Error('kaboom'); },
  }]);
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'boom', arguments: {} },
  });
  // Note: tool errors surface as result.isError, NOT as JSON-RPC errors
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, 'kaboom');
});

test('MCPServer: unknown method returns METHOD_NOT_FOUND', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 7, method: 'nonexistent' });
  assert.equal(reply.error.code, ERROR_CODES.METHOD_NOT_FOUND);
});

test('MCPServer: bad jsonrpc version rejected', async () => {
  const s = makeServer();
  const reply = await s.handleMessage({ jsonrpc: '1.0', id: 8, method: 'ping' });
  assert.equal(reply.error.code, ERROR_CODES.INVALID_REQUEST);
});

test('MCPServer: string tool result becomes plain text content', async () => {
  const s = makeServer([{
    name: 'greet',
    description: '', inputSchema: { type: 'object' },
    handler: async () => 'plain string reply',
  }]);
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'greet', arguments: {} },
  });
  assert.equal(reply.result.content[0].text, 'plain string reply');
});

test('MCPServer: registerTool rejects duplicate names', () => {
  const s = makeServer();
  assert.throws(() => s.registerTool({
    name: 'echo', handler: async () => 'x',
  }), /already registered/);
});

test('MCPServer: registerTool requires handler', () => {
  const s = makeServer();
  assert.throws(() => s.registerTool({ name: 'noimpl' }), /handler is required/);
});

// ---- run() over pipe streams ---------------------------------------------

test('MCPServer.run: end-to-end request over stdio pipes', async () => {
  const s = makeServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const outChunks = [];
  stdout.on('data', c => outChunks.push(c));

  const done = s.run({ stdin, stdout });

  const req = { jsonrpc: '2.0', id: 1, method: 'initialize' };
  stdin.write(JSON.stringify(req) + '\n');
  stdin.end();
  await done;

  const line = Buffer.concat(outChunks).toString('utf8').trim();
  const reply = JSON.parse(line);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.name, 'test-server');
});

test('MCPServer.run: handles multiple line-delimited requests + parse errors', async () => {
  const s = makeServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const outChunks = [];
  stdout.on('data', c => outChunks.push(c));

  const done = s.run({ stdin, stdout });
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  stdin.write('not-valid-json\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  stdin.end();
  await done;

  const lines = Buffer.concat(outChunks).toString('utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const r1 = JSON.parse(lines[0]); assert.equal(r1.id, 1); assert.deepEqual(r1.result, {});
  const r2 = JSON.parse(lines[1]); assert.equal(r2.error.code, ERROR_CODES.PARSE_ERROR);
  const r3 = JSON.parse(lines[2]); assert.equal(r3.id, 2); assert.equal(r3.result.tools.length, 1);
});

// ---- buildTools -----------------------------------------------------------

const { ProviderRegistry } = require('../lib/cli/providerAliases');

function stubProvider(overrides = {}) {
  return {
    async chat(req) {
      return {
        text: overrides.chatText ?? 'ok',
        model: 'stub-model', usage: { input_tokens: 3, output_tokens: 2 },
        stopReason: 'end_turn', ...overrides.chatFields,
      };
    },
    async embed({ input }) {
      const arr = Array.isArray(input) ? input : [input];
      return { embeddings: arr.map(() => [0.1, 0.2, 0.3, 0.4]), model: 'stub-emb' };
    },
  };
}

function stubRegistry(kind = 'groq', model = 'x', overrides = {}) {
  return new ProviderRegistry({ provider: stubProvider(overrides), kind, model });
}

test('buildTools: exposes chat, embed, verify, list_providers', () => {
  const tools = buildTools({ providers: stubRegistry() });
  assert.deepEqual(tools.map(t => t.name).sort(), ['chat', 'embed', 'list_providers', 'verify']);
});

test('buildTools chat: forwards prompt + system + maxTokens to provider', async () => {
  const captured = {};
  const p = {
    async chat(req) { Object.assign(captured, req); return { text: 'reply', model: 'x', usage: {}, stopReason: 'end_turn' }; },
  };
  const providers = new ProviderRegistry({ provider: p, kind: 'groq', model: 'x' });
  const [chatTool] = buildTools({ providers });
  const result = await chatTool.handler({ prompt: 'hi', system: 'be nice', maxTokens: 42 });
  assert.equal(captured.system, 'be nice');
  assert.equal(captured.maxTokens, 42);
  assert.equal(captured.messages[0].content, 'hi');
  assert.equal(result.text, 'reply');
});

test('buildTools chat: rejects empty prompt', async () => {
  const [chatTool] = buildTools({ providers: stubRegistry() });
  await assert.rejects(() => chatTool.handler({ prompt: '' }), /non-empty/);
  await assert.rejects(() => chatTool.handler({}), /non-empty/);
});

test('buildTools embed: rejects when provider is anthropic', async () => {
  const tools = buildTools({ providers: stubRegistry('anthropic', 'claude-opus-4-7') });
  const embedTool = tools.find(t => t.name === 'embed');
  await assert.rejects(() => embedTool.handler({ input: 'x' }), /does not support embed/);
});

test('buildTools embed: returns dimension + count for array input', async () => {
  const tools = buildTools({ providers: stubRegistry('ollama') });
  const embedTool = tools.find(t => t.name === 'embed');
  const res = await embedTool.handler({ input: ['a', 'b', 'c'] });
  assert.equal(res.count, 3);
  assert.equal(res.dimension, 4);
});

test('buildTools verify: ok=true when reply matches /ok/i', async () => {
  const tools = buildTools({ providers: stubRegistry('groq', 'x', { chatText: 'ok' }) });
  const t = tools.find(t => t.name === 'verify');
  const res = await t.handler({});
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'groq');
  assert.ok(res.latencyMs >= 0);
});

test('buildTools verify: ok=false otherwise', async () => {
  const tools = buildTools({ providers: stubRegistry('groq', 'x', { chatText: 'no' }) });
  const t = tools.find(t => t.name === 'verify');
  const res = await t.handler({});
  assert.equal(res.ok, false);
});

// ---- resources + prompts (1.8.0) ------------------------------------------

test('MCPServer: initialize advertises resources capability when any registered', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'test://foo', read: async () => 'ok' }],
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok(reply.result.capabilities.resources);
  assert.ok(reply.result.capabilities.tools);
  assert.equal(reply.result.capabilities.prompts, undefined);
});

test('MCPServer: initialize advertises prompts capability when registry present', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    prompts: new PromptRegistry().registerAll(builtInPrompts()),
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok(reply.result.capabilities.prompts);
  assert.equal(reply.result.capabilities.resources, undefined);
});

test('MCPServer: resources/list enumerates registered resources', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [
      { uri: 'config://a', name: 'A', description: 'first', mimeType: 'application/json', read: async () => ({ ok: true }) },
      { uri: 'config://b', name: 'B', read: async () => 'plain' },
    ],
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.equal(reply.result.resources.length, 2);
  assert.equal(reply.result.resources[0].uri, 'config://a');
  assert.equal(reply.result.resources[0].mimeType, 'application/json');
  assert.equal(reply.result.resources[1].mimeType, 'text/plain'); // default
});

test('MCPServer: resources/read returns text content for known URI', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'config://demo', mimeType: 'application/json', read: async () => ({ hello: 'world' }) }],
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'resources/read',
    params: { uri: 'config://demo' },
  });
  const parsed = JSON.parse(reply.result.contents[0].text);
  assert.deepEqual(parsed, { hello: 'world' });
  assert.equal(reply.result.contents[0].mimeType, 'application/json');
});

test('MCPServer: resources/read for unknown URI returns INVALID_PARAMS', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', resources: [] });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'resources/read',
    params: { uri: 'nope://x' },
  });
  assert.equal(reply.error.code, ERROR_CODES.INVALID_PARAMS);
});

test('MCPServer: registerResource rejects duplicates + missing fields', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  s.registerResource({ uri: 'a://b', read: async () => 'x' });
  assert.throws(() => s.registerResource({ uri: 'a://b', read: async () => 'x' }), /already registered/);
  assert.throws(() => s.registerResource({ read: async () => 'x' }), /uri is required/);
  assert.throws(() => s.registerResource({ uri: 'c://d' }), /read must be a function/);
});

test('MCPServer: prompts/list returns [] when no registry', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.deepEqual(reply.result.prompts, []);
});

test('MCPServer: prompts/list returns registered templates with arguments', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    prompts: new PromptRegistry().registerAll(builtInPrompts()),
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.ok(reply.result.prompts.length >= 4);
  const summarize = reply.result.prompts.find(p => p.name === 'summarize');
  assert.ok(summarize);
  assert.equal(summarize.arguments[0].name, 'text');
  assert.equal(summarize.arguments[0].required, true);
});

test('MCPServer: prompts/get renders template into MCP message shape', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    prompts: new PromptRegistry().registerAll(builtInPrompts()),
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'prompts/get',
    params: { name: 'summarize', arguments: { text: 'long input', sentences: 2 } },
  });
  assert.match(reply.result.description, /Summarize/);
  // system prompt becomes a synthetic user turn tagged [system]
  const first = reply.result.messages[0];
  assert.equal(first.role, 'user');
  assert.equal(first.content.type, 'text');
  assert.match(first.content.text, /\[system\][\s\S]*at most 2 sentences/);
  // Actual user turn
  const second = reply.result.messages[1];
  assert.equal(second.role, 'user');
  assert.equal(second.content.text, 'long input');
});

test('MCPServer: prompts/get with no registry returns INVALID_PARAMS', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'prompts/get',
    params: { name: 'summarize', arguments: {} },
  });
  assert.equal(reply.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(reply.error.message, /no prompt registry/);
});

test('MCPServer: prompts/get for unknown name returns INVALID_PARAMS', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    prompts: new PromptRegistry().registerAll(builtInPrompts()),
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'prompts/get',
    params: { name: 'nosuch', arguments: {} },
  });
  assert.equal(reply.error.code, ERROR_CODES.INVALID_PARAMS);
});

test('buildResources: returns active-provider + supported-providers + providers by default', async () => {
  const providers = new ProviderRegistry({
    provider: { middleware: [1, 2], defaultMaxTokens: 512 },
    kind: 'groq',
    model: 'llama-3.3-70b-versatile',
  });
  const resources = buildResources({ providers });
  const uris = resources.map(r => r.uri);
  assert.deepEqual(uris, ['config://active-provider', 'config://supported-providers', 'config://providers']);

  const active = await resources[0].read();
  assert.equal(active.provider, 'groq');
  assert.equal(active.middleware.count, 2);
  assert.equal(active.defaultMaxTokens, 512);

  const supported = await resources[1].read();
  assert.equal(supported.supported.length, 6);

  const aliases = await resources[2].read();
  assert.equal(aliases.default.kind, 'groq');
  assert.deepEqual(aliases.aliases, []);
});

// ---- list-changed notifications (1.13.0) ----------------------------------

test('MCPServer: addSubscriber requires a function', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  assert.throws(() => s.addSubscriber('not-a-fn'), /requires a function/);
});

test('MCPServer: notifyListChanged validates kind', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  assert.throws(() => s.notifyListChanged('bogus'), /unknown kind/);
});

test('MCPServer: notifyListChanged is a silent no-op with no subscribers', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  s.notifyListChanged('prompts'); // must not throw
  s.notifyListChanged('resources');
  s.notifyListChanged('tools');
});

test('MCPServer: addSubscriber returns unsubscribe function', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const received = [];
  const unsub = s.addSubscriber((n) => received.push(n));
  s.notifyListChanged('prompts');
  assert.equal(received.length, 1);
  unsub();
  s.notifyListChanged('prompts');
  assert.equal(received.length, 1); // no more after unsubscribe
});

test('MCPServer: notifyListChanged broadcasts to every subscriber', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx1 = []; const rx2 = []; const rx3 = [];
  s.addSubscriber((n) => rx1.push(n));
  s.addSubscriber((n) => rx2.push(n));
  s.addSubscriber((n) => rx3.push(n));
  s.notifyListChanged('prompts');
  assert.equal(rx1.length, 1);
  assert.equal(rx2.length, 1);
  assert.equal(rx3.length, 1);
  assert.equal(rx1[0].method, 'notifications/prompts/list_changed');
  assert.equal(rx1[0].jsonrpc, '2.0');
  assert.equal(rx1[0].id, undefined); // notifications have no id
});

test('MCPServer: notifyListChanged emits correct method for each kind', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx = [];
  s.addSubscriber((n) => rx.push(n));
  s.notifyListChanged('prompts');
  s.notifyListChanged('resources');
  s.notifyListChanged('tools');
  assert.deepEqual(rx.map(n => n.method), [
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/tools/list_changed',
  ]);
});

test('MCPServer: subscriber that throws does not break broadcast to others', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx = [];
  s.addSubscriber(() => { throw new Error('boom'); });
  s.addSubscriber((n) => rx.push(n));
  s.notifyListChanged('prompts'); // must not throw
  assert.equal(rx.length, 1);
});

test('MCPServer: initialize advertises listChanged: true on all present capabilities', async () => {
  const { PromptRegistry: PR, builtInPrompts: bip } = require('../lib/promptRegistry');
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'test://a', read: async () => 'ok' }],
    prompts: new PR().registerAll(bip()),
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.deepEqual(reply.result.capabilities.tools, { listChanged: true });
  assert.deepEqual(reply.result.capabilities.resources, { listChanged: true, subscribe: true });
  assert.deepEqual(reply.result.capabilities.prompts, { listChanged: true });
});

// ---- resource subscriptions (1.17.0) --------------------------------------

test('MCPServer: addSubscriber returns unsubscribe fn with .subscriptions Set', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const unsub = s.addSubscriber(() => {});
  assert.ok(unsub.subscriptions instanceof Set);
  assert.equal(unsub.subscriptions.size, 0);
  unsub();
});

test('MCPServer: resources/subscribe adds uri to transportCtx.subscriptions Set', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'config://a', read: async () => 'ok' }],
  });
  const subs = new Set();
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://a' } },
    { subscriptions: subs },
  );
  assert.deepEqual(reply.result, {});
  assert.ok(subs.has('config://a'));
});

test('MCPServer: resources/subscribe accepts templated URI matches', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resourceTemplates: [{
      uriTemplate: 'prompt://{name}',
      read: ({ name }) => ({ name }),
    }],
  });
  const subs = new Set();
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'prompt://summarize' } },
    { subscriptions: subs },
  );
  assert.deepEqual(reply.result, {});
  assert.ok(subs.has('prompt://summarize'));
});

test('MCPServer: resources/subscribe rejects unknown URI', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'config://a', read: async () => 'ok' }],
  });
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://does-not-exist' } },
    { subscriptions: new Set() },
  );
  assert.equal(reply.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(reply.error.message, /unknown resource/);
});

test('MCPServer: resources/subscribe rejects missing uri', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: {} },
    { subscriptions: new Set() },
  );
  assert.equal(reply.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(reply.error.message, /uri is required/);
});

test('MCPServer: resources/unsubscribe removes uri', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'config://a', read: async () => 'ok' }],
  });
  const subs = new Set(['config://a', 'config://b']);
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/unsubscribe', params: { uri: 'config://a' } },
    { subscriptions: subs },
  );
  assert.deepEqual(reply.result, {});
  assert.equal(subs.has('config://a'), false);
  assert.ok(subs.has('config://b'));
});

test('MCPServer: resources/unsubscribe is idempotent for unknown uri', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const subs = new Set();
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/unsubscribe', params: { uri: 'never-subscribed' } },
    { subscriptions: subs },
  );
  assert.deepEqual(reply.result, {});
});

test('MCPServer: notifyResourceUpdated requires a non-empty string uri', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  assert.throws(() => s.notifyResourceUpdated(''), /non-empty string/);
  assert.throws(() => s.notifyResourceUpdated(null), /non-empty string/);
  assert.throws(() => s.notifyResourceUpdated(42), /non-empty string/);
});

test('MCPServer: notifyResourceUpdated only reaches subscribers of that URI', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rxA = []; const rxB = []; const rxNone = [];
  const uA = s.addSubscriber((n) => rxA.push(n));
  const uB = s.addSubscriber((n) => rxB.push(n));
  s.addSubscriber((n) => rxNone.push(n)); // no subscriptions

  uA.subscriptions.add('config://a');
  uB.subscriptions.add('config://b');

  s.notifyResourceUpdated('config://a');
  assert.equal(rxA.length, 1);
  assert.equal(rxB.length, 0);
  assert.equal(rxNone.length, 0);
  assert.equal(rxA[0].method, 'notifications/resources/updated');
  assert.deepEqual(rxA[0].params, { uri: 'config://a' });
  assert.equal(rxA[0].jsonrpc, '2.0');
  assert.equal(rxA[0].id, undefined);
});

test('MCPServer: notifyResourceUpdated is a silent no-op when nobody is subscribed', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx = [];
  s.addSubscriber((n) => rx.push(n));
  s.notifyResourceUpdated('config://a'); // no subs on the subscriber
  assert.equal(rx.length, 0);
});

test('MCPServer: notifyResourceUpdated fans out to multiple subscribers of same URI', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx1 = []; const rx2 = [];
  const u1 = s.addSubscriber((n) => rx1.push(n));
  const u2 = s.addSubscriber((n) => rx2.push(n));
  u1.subscriptions.add('config://a');
  u2.subscriptions.add('config://a');
  s.notifyResourceUpdated('config://a');
  assert.equal(rx1.length, 1);
  assert.equal(rx2.length, 1);
});

test('MCPServer: notifyResourceUpdated survives a throwing subscriber', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx = [];
  const u1 = s.addSubscriber(() => { throw new Error('boom'); });
  const u2 = s.addSubscriber((n) => rx.push(n));
  u1.subscriptions.add('config://a');
  u2.subscriptions.add('config://a');
  s.notifyResourceUpdated('config://a'); // must not throw
  assert.equal(rx.length, 1);
});

test('MCPServer: unsubscribe drops the sink and its subscriptions', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const rx = [];
  const unsub = s.addSubscriber((n) => rx.push(n));
  unsub.subscriptions.add('config://a');
  unsub();
  s.notifyResourceUpdated('config://a');
  assert.equal(rx.length, 0);
});

test('MCPServer: subscribedUris returns distinct URIs across subscribers, optionally filtered by prefix', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  const u1 = s.addSubscriber(() => {});
  const u2 = s.addSubscriber(() => {});
  u1.subscriptions.add('prompt://summarize');
  u1.subscriptions.add('config://active-provider');
  u2.subscriptions.add('prompt://summarize'); // duplicate across clients
  u2.subscriptions.add('prompt://translate');

  const all = s.subscribedUris();
  assert.equal(all.size, 3);
  assert.ok(all.has('prompt://summarize'));
  assert.ok(all.has('prompt://translate'));
  assert.ok(all.has('config://active-provider'));

  const promptsOnly = s.subscribedUris('prompt://');
  assert.equal(promptsOnly.size, 2);
  assert.ok(promptsOnly.has('prompt://summarize'));
  assert.ok(promptsOnly.has('prompt://translate'));
  assert.equal(promptsOnly.has('config://active-provider'), false);
});

test('MCPServer: end-to-end subscribe -> notify -> unsubscribe over stdio-style transportCtx', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'config://a', read: async () => 'ok' }],
  });
  // Simulate a single connection: one send sink, one shared subscriptions Set.
  const rx = [];
  const unsub = s.addSubscriber((n) => rx.push(n));
  const ctx = { subscriptions: unsub.subscriptions };

  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://a' } },
    ctx,
  );
  s.notifyResourceUpdated('config://a');
  assert.equal(rx.length, 1);
  assert.equal(rx[0].method, 'notifications/resources/updated');

  await s.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'resources/unsubscribe', params: { uri: 'config://a' } },
    ctx,
  );
  s.notifyResourceUpdated('config://a');
  assert.equal(rx.length, 1); // no further notifications after unsubscribe
});

// ---- progress notifications (1.12.0) --------------------------------------

test('MCPServer: tool handler receives ctx with reportProgress no-op when no token', async () => {
  let capturedCtx = null;
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'p', description: '', inputSchema: { type: 'object' },
      handler: async (args, ctx) => { capturedCtx = ctx; ctx.reportProgress(5, 10); return 'ok'; },
    }],
  });
  // No progressToken, no transport sink -> reportProgress is a no-op (no throw)
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'p', arguments: {} },
  });
  assert.equal(reply.result.isError, false);
  assert.equal(capturedCtx.progressToken, null);
  assert.equal(typeof capturedCtx.reportProgress, 'function');
});

test('MCPServer: tool with _meta.progressToken emits notifications via transportCtx', async () => {
  const notifs = [];
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'p', description: '', inputSchema: { type: 'object' },
      handler: async (args, ctx) => {
        ctx.reportProgress(1, 3);
        ctx.reportProgress(2, 3);
        ctx.reportProgress(3, 3);
        return 'done';
      },
    }],
  });
  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'p', arguments: {}, _meta: { progressToken: 'tok-42' } } },
    { sendNotification: (n) => notifs.push(n) },
  );
  assert.equal(notifs.length, 3);
  for (const n of notifs) {
    assert.equal(n.jsonrpc, '2.0');
    assert.equal(n.method, 'notifications/progress');
    assert.equal(n.params.progressToken, 'tok-42');
    assert.equal(n.params.total, 3);
  }
  assert.deepEqual(notifs.map(n => n.params.progress), [1, 2, 3]);
});

test('MCPServer: progressToken without transport sink still no-ops (does not throw)', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'p', description: '', inputSchema: { type: 'object' },
      handler: async (args, ctx) => { ctx.reportProgress(1); return 'ok'; },
    }],
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'p', _meta: { progressToken: 'x' } },
  });
  assert.equal(reply.result.isError, false);
});

test('MCPServer: reportProgress supports omitting total', async () => {
  const notifs = [];
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'p', description: '', inputSchema: { type: 'object' },
      handler: async (args, ctx) => { ctx.reportProgress(7); return 'ok'; },
    }],
  });
  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'p', arguments: {}, _meta: { progressToken: 't' } } },
    { sendNotification: (n) => notifs.push(n) },
  );
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].params.progress, 7);
  assert.equal(notifs[0].params.total, undefined);
});

test('MCPServer: existing tools still work without ctx (backwards compat)', async () => {
  // Old-style handler that ignores the ctx argument
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'p', description: '', inputSchema: { type: 'object' },
      handler: async ({ x }) => ({ result: x * 2 }),
    }],
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'p', arguments: { x: 5 } },
  });
  assert.equal(reply.result.isError, false);
  assert.equal(JSON.parse(reply.result.content[0].text).result, 10);
});

// ---- resource templates (1.9.0) -------------------------------------------

test('MCPServer: registerResourceTemplate rejects invalid templates', () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0' });
  assert.throws(() => s.registerResourceTemplate({ read: async () => 'x' }), /uriTemplate is required/);
  assert.throws(() => s.registerResourceTemplate({ uriTemplate: 'foo://bar' }), /read must be a function/);
  assert.throws(() => s.registerResourceTemplate({
    uriTemplate: 'foo://static', read: async () => 'x',
  }), /no \{param\} placeholders/);
});

test('MCPServer: resources/templates/list returns registered templates', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resourceTemplates: [{
      uriTemplate: 'user://{id}',
      name: 'User by id',
      description: 'Read a user',
      mimeType: 'application/json',
      read: () => ({}),
    }],
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list' });
  assert.equal(reply.result.resourceTemplates.length, 1);
  assert.equal(reply.result.resourceTemplates[0].uriTemplate, 'user://{id}');
  assert.equal(reply.result.resourceTemplates[0].name, 'User by id');
});

test('MCPServer: resources/read matches URI against a template', async () => {
  let captured = null;
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resourceTemplates: [{
      uriTemplate: 'user://{id}',
      mimeType: 'application/json',
      read: (params) => { captured = params; return { id: params.id, name: 'Alice' }; },
    }],
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'resources/read',
    params: { uri: 'user://42' },
  });
  assert.deepEqual(captured, { id: '42' });
  const parsed = JSON.parse(reply.result.contents[0].text);
  assert.equal(parsed.id, '42');
  assert.equal(parsed.name, 'Alice');
});

test('MCPServer: resources/read prefers static resource over matching template', async () => {
  let templateCalled = false;
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resources: [{ uri: 'user://special', read: async () => 'STATIC' }],
    resourceTemplates: [{
      uriTemplate: 'user://{id}',
      read: () => { templateCalled = true; return 'TEMPLATE'; },
    }],
  });
  const reply = await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'resources/read',
    params: { uri: 'user://special' },
  });
  assert.equal(reply.result.contents[0].text, 'STATIC');
  assert.equal(templateCalled, false);
});

test('MCPServer: initialize advertises resources when only templates registered', async () => {
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resourceTemplates: [{ uriTemplate: 'a://{b}', read: () => 'x' }],
  });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok(reply.result.capabilities.resources);
});

test('MCPServer: template with multiple params captures all of them', async () => {
  let captured = null;
  const s = new MCPServer({
    name: 'x', version: '1.0.0',
    resourceTemplates: [{
      uriTemplate: 'org://{orgId}/repo/{repoName}',
      read: (params) => { captured = params; return params; },
    }],
  });
  await s.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'resources/read',
    params: { uri: 'org://acme/repo/hello-world' },
  });
  assert.deepEqual(captured, { orgId: 'acme', repoName: 'hello-world' });
});

test('buildResourceTemplates: exposes provider://{kind} always', () => {
  const templates = buildResourceTemplates({ prompts: null });
  const p = templates.find(t => t.uriTemplate === 'provider://{kind}');
  assert.ok(p);
  assert.deepEqual(p.read({ kind: 'groq' }), { kind: 'groq', defaultModel: 'llama-3.3-70b-versatile' });
});

test('buildResourceTemplates: provider template rejects unknown kinds', () => {
  const templates = buildResourceTemplates({ prompts: null });
  const p = templates.find(t => t.uriTemplate === 'provider://{kind}');
  assert.throws(() => p.read({ kind: 'bogus' }), /unknown provider kind/);
});

test('buildResourceTemplates: includes prompt://{name} when prompts registry present', () => {
  const { PromptRegistry, builtInPrompts: bip } = require('../lib/promptRegistry');
  const prompts = new PromptRegistry().registerAll(bip());
  const templates = buildResourceTemplates({ prompts });
  const p = templates.find(t => t.uriTemplate === 'prompt://{name}');
  assert.ok(p);
  const meta = p.read({ name: 'summarize' });
  assert.equal(meta.name, 'summarize');
  assert.ok(meta.arguments.length >= 1);
});

test('buildResources: includes cache-stats resource when cacheStats supplied', async () => {
  const providers = new ProviderRegistry({
    provider: { middleware: [], defaultMaxTokens: 1024 },
    kind: 'anthropic', model: 'x',
  });
  const resources = buildResources({
    providers,
    cacheStats: () => ({ hits: 5, misses: 2, size: 7 }),
  });
  const cache = resources.find(r => r.uri === 'usage://cache-stats');
  assert.ok(cache);
  assert.deepEqual(await cache.read(), { hits: 5, misses: 2, size: 7 });
});

test('buildTools list_providers: includes activeProvider + all provider kinds', async () => {
  const tools = buildTools({ providers: stubRegistry('groq', 'llama-3.3-70b-versatile') });
  const t = tools.find(t => t.name === 'list_providers');
  const res = await t.handler({});
  assert.equal(res.activeProvider, 'groq');
  assert.equal(res.activeModel, 'llama-3.3-70b-versatile');
  assert.equal(res.supported.length, 6);
  assert.deepEqual(res.aliases, []);
});

// ---- end-to-end via saptarishi-llm mcp subprocess -------------------------

test('CLI mcp: --prompts-dir loads custom templates that appear in prompts/list', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'sllm-mcp-'));
  const tplPath = require('node:path').join(dir, 'custom.mjs');
  fs.writeFileSync(tplPath, `
    export default {
      name: 'my_custom_from_disk',
      description: 'loaded via --prompts-dir',
      arguments: [{ name: 'x', required: true }],
      render: ({ x }) => ({ messages: [{ role: 'user', content: 'custom: ' + x }] }),
    };
  `);
  const bin = path.resolve(__dirname, '..', 'bin', 'saptarishi-llm.js');
  const child = spawn(process.execPath, [bin, 'mcp', '--provider', 'ollama', '--prompts-dir', dir], {
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const readOne = () => new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        child.stdout.off('data', onData);
        resolve(buf.slice(0, idx));
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => { child.stdout.off('data', onData); reject(new Error('timeout')); }, 5000);
  });

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await readOne();

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list' }) + '\n');
    const line = await readOne();
    const reply = JSON.parse(line);
    const names = reply.result.prompts.map(p => p.name);
    assert.ok(names.includes('my_custom_from_disk'), `expected custom prompt loaded; got: ${names.join(', ')}`);
    assert.ok(names.includes('summarize'), 'built-ins should still be present');
  } finally {
    child.stdin.end();
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI mcp: subprocess handshake works over stdio', async () => {
  const bin = path.resolve(__dirname, '..', 'bin', 'saptarishi-llm.js');
  // Ollama provider needs no credentials, tolerates being unreachable until
  // the first chat() call — so `saptarishi-llm mcp --provider ollama` starts
  // up and processes MCP messages without ever touching the network.
  const child = spawn(process.execPath, [bin, 'mcp', '--provider', 'ollama'], {
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const readOne = () => new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        child.stdout.off('data', onData);
        resolve(buf.slice(0, idx));
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => { child.stdout.off('data', onData); reject(new Error('timeout waiting for reply')); }, 5000);
  });

  try {
    // initialize
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    const initLine = await readOne();
    const init = JSON.parse(initLine);
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, '@saptarishi/cds-plugin-llm');
    assert.equal(init.result.protocolVersion, PROTOCOL_VERSION);

    // tools/list
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const listLine = await readOne();
    const list = JSON.parse(listLine);
    assert.equal(list.id, 2);
    const names = list.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['chat', 'embed', 'list_providers', 'verify']);

    // list_providers should work without network
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_providers', arguments: {} },
    }) + '\n');
    const lpLine = await readOne();
    const lp = JSON.parse(lpLine);
    assert.equal(lp.id, 3);
    assert.equal(lp.result.isError, false);
    const payload = JSON.parse(lp.result.content[0].text);
    assert.equal(payload.activeProvider, 'ollama');
    assert.equal(payload.supported.length, 6);

    // resources/list should include the three config:// resources
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }) + '\n');
    const rlLine = await readOne();
    const rl = JSON.parse(rlLine);
    const uris = rl.result.resources.map(r => r.uri).sort();
    assert.deepEqual(uris, [
      'config://active-provider',
      'config://providers',
      'config://supported-providers',
    ]);

    // prompts/list should include the 5 built-in prompts
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'prompts/list' }) + '\n');
    const plLine = await readOne();
    const pl = JSON.parse(plLine);
    const promptNames = pl.result.prompts.map(p => p.name).sort();
    assert.ok(promptNames.includes('summarize'));
    assert.ok(promptNames.includes('procurement_risk_scorer'));

    // prompts/get for summarize
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'prompts/get',
      params: { name: 'summarize', arguments: { text: 'hello' } },
    }) + '\n');
    const pgLine = await readOne();
    const pg = JSON.parse(pgLine);
    assert.match(pg.result.description, /Summarize/);

    // resources/templates/list should include provider:// and prompt://
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'resources/templates/list' }) + '\n');
    const rtLine = await readOne();
    const rt = JSON.parse(rtLine);
    const tplUris = rt.result.resourceTemplates.map(t => t.uriTemplate).sort();
    assert.deepEqual(tplUris, ['prompt://{name}', 'provider://{kind}']);

    // resources/read against a template URI (provider://ollama)
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'resources/read',
      params: { uri: 'provider://ollama' },
    }) + '\n');
    const rrLine = await readOne();
    const rr = JSON.parse(rrLine);
    const payload2 = JSON.parse(rr.result.contents[0].text);
    assert.equal(payload2.kind, 'ollama');
    assert.equal(payload2.defaultModel, 'qwen2.5:14b');
  } finally {
    child.stdin.end();
    child.kill();
  }
});
