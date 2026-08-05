const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MCPServer, PROTOCOL_VERSION, ERROR_CODES } = require('../lib/mcp/server');

// Helper: run initialize on a fresh server, then dispatch the given tool
// with a mock transport that captures every server-initiated message and
// lets the test script the client's responses.
function scenario({ tools = [], initializeParams = null, clientMessages = [] }) {
  const server = new MCPServer({ name: 'sampling-test', version: '1.0.0', tools });
  const sent = [];
  const sessionState = {};
  const transportCtx = {
    sendMessage: (msg) => {
      sent.push(msg);
      // Any scripted response from `clientMessages` that MATCHES this outbound
      // request id is delivered back to the server on the next microtask.
      const idx = clientMessages.findIndex(
        (m) => m && m.matchMethod === msg.method && m.id === undefined,
      );
      if (idx >= 0) {
        const reply = clientMessages.splice(idx, 1)[0];
        queueMicrotask(() => {
          server.handleMessage(
            { jsonrpc: '2.0', id: msg.id, ...(reply.result ? { result: reply.result } : {}), ...(reply.error ? { error: reply.error } : {}) },
            transportCtx,
          );
        });
      }
    },
    sendNotification: (n) => sent.push(n),
    sessionState,
  };
  return { server, sent, sessionState, transportCtx };
}

// ---- Server-initiated request infrastructure --------------------------

test('sendRequest: throws when the transport does not expose sendMessage', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  await assert.rejects(() => s.sendRequest('sampling/createMessage', {}, {}), /sendMessage/);
});

test('sendRequest: correlates the response by id and resolves', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const ctx = {
    sendMessage: (msg) => {
      // Simulate the client replying to the same id with a result
      queueMicrotask(() => s.handleMessage({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }, ctx));
    },
  };
  const result = await s.sendRequest('roots/list', {}, ctx);
  assert.deepEqual(result, { ok: true });
});

test('sendRequest: propagates a JSON-RPC error response as a rejected promise', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const ctx = {
    sendMessage: (msg) => {
      queueMicrotask(() => s.handleMessage(
        { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'client refused' } },
        ctx,
      ));
    },
  };
  await assert.rejects(() => s.sendRequest('sampling/createMessage', {}, ctx), /client refused/);
});

test('sendRequest: times out cleanly when no response arrives', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const ctx = { sendMessage: () => {} }; // never replies
  await assert.rejects(
    () => s.sendRequest('roots/list', {}, ctx, { timeoutMs: 30 }),
    /timed out after 30ms/,
  );
});

test('handleMessage: response for an unknown id is dropped (no crash), warn logged', async () => {
  const logs = [];
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [], logger: (lvl, msg) => logs.push({ lvl, msg }) });
  const reply = await s.handleMessage({ jsonrpc: '2.0', id: 'nonexistent', result: {} });
  assert.equal(reply, null);
  assert.ok(logs.some(l => /unknown request id nonexistent/.test(l.msg)));
});

test('handleMessage: routing response frees the pending request entry', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const ctx = {
    sendMessage: (msg) => queueMicrotask(() => s.handleMessage({ jsonrpc: '2.0', id: msg.id, result: {} }, ctx)),
  };
  await s.sendRequest('roots/list', {}, ctx);
  assert.equal(s._pendingRequests.size, 0);
});

// ---- initialize captures client capabilities --------------------------

test('initialize: stashes params.capabilities on sessionState.clientCapabilities', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const sessionState = {};
  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { sampling: {}, roots: { listChanged: true } } } },
    { sessionState },
  );
  assert.deepEqual(sessionState.clientCapabilities, { sampling: {}, roots: { listChanged: true } });
});

test('initialize: missing capabilities defaults to empty object on sessionState', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const sessionState = {};
  await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { sessionState },
  );
  assert.deepEqual(sessionState.clientCapabilities, {});
});

// ---- ctx.sample() from a tool handler ---------------------------------

test('ctx.sample: routes through sendRequest, returns the client\'s completion', async () => {
  let observed;
  const tool = {
    name: 'consult',
    description: '',
    inputSchema: { type: 'object' },
    handler: async (args, ctx) => {
      observed = await ctx.sample({
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        maxTokens: 32,
      });
      return { text: observed.content?.text ?? '' };
    },
  };
  const scriptedReply = { text: 'echoed by client' };
  const { server, transportCtx } = scenario({
    tools: [tool],
    clientMessages: [{
      matchMethod: 'sampling/createMessage',
      result: { role: 'assistant', content: { type: 'text', text: 'echoed by client' }, model: 'client-side-model' },
    }],
  });
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { sampling: {} } } },
    transportCtx,
  );
  const reply = await server.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'consult', arguments: {} } },
    transportCtx,
  );
  assert.equal(reply.result.isError, false);
  const outText = JSON.parse(reply.result.content[0].text);
  assert.equal(outText.text, 'echoed by client');
  assert.equal(observed.model, 'client-side-model');
});

test('ctx.sample: throws helpful error when the client did not declare sampling capability', async () => {
  const tool = {
    name: 't', description: '', inputSchema: { type: 'object' },
    handler: async (_args, ctx) => ctx.sample({ messages: [] }),
  };
  const { server, transportCtx } = scenario({ tools: [tool] });
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
    transportCtx,
  );
  const reply = await server.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', arguments: {} } },
    transportCtx,
  );
  // Tool errors surface as isError: true, not JSON-RPC errors.
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /did not declare a sampling capability/);
});

test('ctx.sample: throws helpful error when transport lacks sendMessage (unsupported)', async () => {
  const tool = {
    name: 't', description: '', inputSchema: { type: 'object' },
    handler: async (_args, ctx) => ctx.sample({ messages: [] }),
  };
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [tool] });
  const ctx = { sessionState: { clientCapabilities: { sampling: {} } } };
  const reply = await s.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } },
    ctx,
  );
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /bidirectional transport/);
});

// ---- ctx.getRoots() ---------------------------------------------------

test('ctx.getRoots: server-side roots/list fetches once, then caches on sessionState', async () => {
  let sawRoots;
  const tool = {
    name: 'ls', description: '', inputSchema: { type: 'object' },
    handler: async (_args, ctx) => {
      sawRoots = await ctx.getRoots();
      return { count: sawRoots.length };
    },
  };
  const roots = [{ uri: 'file:///workspace', name: 'ws' }];
  const { server, sent, transportCtx } = scenario({
    tools: [tool],
    clientMessages: [{ matchMethod: 'roots/list', result: { roots } }],
  });
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: {} } } },
    transportCtx,
  );
  const reply = await server.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ls', arguments: {} } },
    transportCtx,
  );
  assert.equal(reply.result.isError, false);
  assert.deepEqual(sawRoots, roots);
  // Cached
  assert.deepEqual(transportCtx.sessionState.roots, roots);
  // Only ONE roots/list request was sent (initial call), tools/call did the caching
  const sentRoots = sent.filter(m => m.method === 'roots/list');
  assert.equal(sentRoots.length, 1);
});

test('ctx.getRoots: notifications/roots/list_changed invalidates the cache', async () => {
  const initialRoots = [{ uri: 'file:///a' }];
  const updatedRoots = [{ uri: 'file:///a' }, { uri: 'file:///b' }];
  let callIdx = 0;

  const server = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'ls', description: '', inputSchema: { type: 'object' },
      handler: async (_args, ctx) => ({ roots: await ctx.getRoots() }),
    }],
  });
  const sessionState = {};
  const transportCtx = {
    sendMessage: (msg) => {
      const reply = { roots: callIdx++ === 0 ? initialRoots : updatedRoots };
      queueMicrotask(() => server.handleMessage({ jsonrpc: '2.0', id: msg.id, result: reply }, transportCtx));
    },
    sessionState,
  };
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } },
    transportCtx,
  );

  const first = await server.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ls', arguments: {} } },
    transportCtx,
  );
  assert.deepEqual(JSON.parse(first.result.content[0].text).roots, initialRoots);

  // Client tells us the roots changed
  await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }, transportCtx);
  assert.equal(sessionState.roots, null, 'cache should be invalidated');

  // Next tools/call re-fetches — sees the updated list
  const second = await server.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ls', arguments: {} } },
    transportCtx,
  );
  assert.deepEqual(JSON.parse(second.result.content[0].text).roots, updatedRoots);
});

test('ctx.getRoots: throws when client did not declare roots capability', async () => {
  const tool = {
    name: 't', description: '', inputSchema: { type: 'object' },
    handler: async (_args, ctx) => ctx.getRoots(),
  };
  const { server, transportCtx } = scenario({ tools: [tool] });
  await server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
    transportCtx,
  );
  const reply = await server.handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', arguments: {} } },
    transportCtx,
  );
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /did not declare a roots capability/);
});

// ---- notifications/roots/list_changed pre-init ------------------------

test('notifications/roots/list_changed: pre-init (no sessionState.roots) is a safe no-op', async () => {
  const s = new MCPServer({ name: 'x', version: '1.0.0', tools: [] });
  const reply = await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  assert.equal(reply, null);
});
