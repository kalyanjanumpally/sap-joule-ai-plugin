const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { MCPServer, PROTOCOL_VERSION, ERROR_CODES } = require('../lib/mcp/server');
const { buildTools } = require('../lib/mcp/tools');

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

test('buildTools: exposes chat, embed, verify, list_providers', () => {
  const tools = buildTools({ provider: stubProvider(), providerKind: 'groq', providerModel: 'x' });
  assert.deepEqual(tools.map(t => t.name).sort(), ['chat', 'embed', 'list_providers', 'verify']);
});

test('buildTools chat: forwards prompt + system + maxTokens to provider', async () => {
  const captured = {};
  const p = {
    async chat(req) { Object.assign(captured, req); return { text: 'reply', model: 'x', usage: {}, stopReason: 'end_turn' }; },
  };
  const [chatTool] = buildTools({ provider: p, providerKind: 'groq', providerModel: 'x' });
  const result = await chatTool.handler({ prompt: 'hi', system: 'be nice', maxTokens: 42 });
  assert.equal(captured.system, 'be nice');
  assert.equal(captured.maxTokens, 42);
  assert.equal(captured.messages[0].content, 'hi');
  assert.equal(result.text, 'reply');
});

test('buildTools chat: rejects empty prompt', async () => {
  const [chatTool] = buildTools({ provider: stubProvider(), providerKind: 'groq', providerModel: 'x' });
  await assert.rejects(() => chatTool.handler({ prompt: '' }), /non-empty/);
  await assert.rejects(() => chatTool.handler({}), /non-empty/);
});

test('buildTools embed: rejects when provider is anthropic', async () => {
  const tools = buildTools({ provider: stubProvider(), providerKind: 'anthropic', providerModel: 'claude-opus-4-7' });
  const embedTool = tools.find(t => t.name === 'embed');
  await assert.rejects(() => embedTool.handler({ input: 'x' }), /does not support embed/);
});

test('buildTools embed: returns dimension + count for array input', async () => {
  const tools = buildTools({ provider: stubProvider(), providerKind: 'ollama', providerModel: 'x' });
  const embedTool = tools.find(t => t.name === 'embed');
  const res = await embedTool.handler({ input: ['a', 'b', 'c'] });
  assert.equal(res.count, 3);
  assert.equal(res.dimension, 4);
});

test('buildTools verify: ok=true when reply matches /ok/i', async () => {
  const tools = buildTools({ provider: stubProvider({ chatText: 'ok' }), providerKind: 'groq', providerModel: 'x' });
  const t = tools.find(t => t.name === 'verify');
  const res = await t.handler({});
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'groq');
  assert.ok(res.latencyMs >= 0);
});

test('buildTools verify: ok=false otherwise', async () => {
  const tools = buildTools({ provider: stubProvider({ chatText: 'no' }), providerKind: 'groq', providerModel: 'x' });
  const t = tools.find(t => t.name === 'verify');
  const res = await t.handler({});
  assert.equal(res.ok, false);
});

test('buildTools list_providers: includes activeProvider + all 5 kinds', async () => {
  const tools = buildTools({ provider: stubProvider(), providerKind: 'groq', providerModel: 'llama-3.3-70b-versatile' });
  const t = tools.find(t => t.name === 'list_providers');
  const res = await t.handler({});
  assert.equal(res.activeProvider, 'groq');
  assert.equal(res.activeModel, 'llama-3.3-70b-versatile');
  assert.equal(res.supported.length, 5);
});

// ---- end-to-end via saptarishi-llm mcp subprocess -------------------------

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
    assert.equal(payload.supported.length, 5);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
