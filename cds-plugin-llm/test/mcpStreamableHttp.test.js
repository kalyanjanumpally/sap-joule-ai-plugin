const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { MCPServer, PROTOCOL_VERSION } = require('../lib/mcp/server');
const { createStreamableHttpTransport } = require('../lib/mcp/streamableHttpTransport');

function makeServer(extraTools = []) {
  return new MCPServer({
    name: 'streamable-test',
    version: '1.0.0',
    tools: [
      {
        name: 'echo',
        description: 'echo',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
        handler: async ({ msg }) => ({ echoed: msg }),
      },
      ...extraTools,
    ],
  });
}

function httpRequest({ method, path, port, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function openStream({ port, path = '/mcp', sessionId, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const events = [];
    let cursor = 0;
    let buffer = '';
    const waiters = [];
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`GET ${path} -> ${res.statusCode}`));
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx === -1) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const raw = line.slice(5).trim();
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          events.push(parsed);
          if (waiters.length) {
            const w = waiters.shift();
            cursor++;
            w.resolve(parsed);
          }
        }
      });
      resolve({
        req, res, events,
        nextEvent: (timeoutMs = 5000) => new Promise((r, j) => {
          if (cursor < events.length) return r(events[cursor++]);
          const waiter = { resolve: r };
          waiters.push(waiter);
          const to = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i !== -1) { waiters.splice(i, 1); j(new Error(`stream event timeout after ${timeoutMs}ms`)); }
          }, timeoutMs);
          to.unref();
          waiter.resolve = (v) => { clearTimeout(to); r(v); };
        }),
        close: () => { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- health + basic routing ---------------------------------------------

test('streamableHttp: /health is public and reports transport=streamable-http', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({ method: 'GET', path: '/health', port: t.port });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.server, 'streamable-test');
    assert.equal(parsed.transport, 'streamable-http');
    assert.equal(parsed.endpoint, '/mcp');
    assert.equal(parsed.sessions, 0);
  } finally { await t.close(); }
});

test('streamableHttp: 404 for unknown paths', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({ method: 'GET', path: '/nope', port: t.port });
    assert.equal(res.status, 404);
  } finally { await t.close(); }
});

test('streamableHttp: 405 for unsupported methods on /mcp', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({ method: 'PUT', path: '/mcp', port: t.port });
    assert.equal(res.status, 405);
    assert.match(res.headers.allow, /POST/);
  } finally { await t.close(); }
});

// ---- session assignment via Mcp-Session-Id ------------------------------

test('streamableHttp: POST initialize with no Mcp-Session-Id → server assigns one in response header', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } }),
    });
    assert.equal(res.status, 200);
    const sid = res.headers['mcp-session-id'];
    assert.match(sid, /^[0-9a-f-]{36}$/);
    // Reply is a real JSON-RPC response
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result?.serverInfo?.name, 'streamable-test');
  } finally { await t.close(); }
});

test('streamableHttp: subsequent POST reuses Mcp-Session-Id', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const init = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sid = init.headers['mcp-session-id'];

    const call = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': sid },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'echo', arguments: { msg: 'hi' } },
      }),
    });
    assert.equal(call.status, 200);
    assert.equal(call.headers['mcp-session-id'], sid);
    const parsed = JSON.parse(call.body);
    assert.equal(parsed.id, 2);
    const content = JSON.parse(parsed.result.content[0].text);
    assert.equal(content.echoed, 'hi');
  } finally { await t.close(); }
});

test('streamableHttp: POST non-initialize with no session id → 400', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /Mcp-Session-Id/);
  } finally { await t.close(); }
});

test('streamableHttp: POST with unknown session id → 404 (client re-initializes)', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': '00000000-0000-0000-0000-000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(res.status, 404);
    assert.match(res.body, /re-initialize/);
  } finally { await t.close(); }
});

test('streamableHttp: POST with parse-error body → 400', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: 'not json',
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /parse error/);
  } finally { await t.close(); }
});

// ---- notification handling (no id → 202) --------------------------------

test('streamableHttp: notification (no id) → 202 with empty body', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const init = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sid = init.headers['mcp-session-id'];

    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(res.status, 202);
    assert.equal(res.body, '');
    assert.equal(res.headers['mcp-session-id'], sid);
  } finally { await t.close(); }
});

// ---- GET stream ---------------------------------------------------------

test('streamableHttp: GET without session id → 400', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({ method: 'GET', path: '/mcp', port: t.port });
    assert.equal(res.status, 400);
    assert.match(res.body, /Mcp-Session-Id required/);
  } finally { await t.close(); }
});

test('streamableHttp: GET with unknown session id → 405 (client re-initializes)', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'GET', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(res.status, 405);
  } finally { await t.close(); }
});

test('streamableHttp: GET with valid session id → SSE stream', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const init = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sid = init.headers['mcp-session-id'];

    const stream = await openStream({ port: t.port, sessionId: sid });
    // Trigger a broadcast — every open stream should receive it.
    server.notifyListChanged('tools');
    const evt = await stream.nextEvent();
    assert.equal(evt.method, 'notifications/tools/list_changed');
    stream.close();
  } finally { await t.close(); }
});

test('streamableHttp: broadcast fans out to all open streams', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const initA = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sidA = initA.headers['mcp-session-id'];
    const initB = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sidB = initB.headers['mcp-session-id'];

    const sA = await openStream({ port: t.port, sessionId: sidA });
    const sB = await openStream({ port: t.port, sessionId: sidB });
    server.notifyListChanged('prompts');
    const [eA, eB] = await Promise.all([sA.nextEvent(), sB.nextEvent()]);
    assert.equal(eA.method, 'notifications/prompts/list_changed');
    assert.equal(eB.method, 'notifications/prompts/list_changed');
    sA.close(); sB.close();
  } finally { await t.close(); }
});

// ---- DELETE / session termination ---------------------------------------

test('streamableHttp: DELETE terminates the session (subsequent POST → 404)', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const init = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sid = init.headers['mcp-session-id'];

    const del = await httpRequest({
      method: 'DELETE', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': sid },
    });
    assert.equal(del.status, 204);

    const followUp = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(followUp.status, 404);
  } finally { await t.close(); }
});

test('streamableHttp: DELETE with no session id → 400', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({ method: 'DELETE', path: '/mcp', port: t.port });
    assert.equal(res.status, 400);
  } finally { await t.close(); }
});

test('streamableHttp: DELETE with unknown session id → 404', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'DELETE', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(res.status, 404);
  } finally { await t.close(); }
});

// ---- session state isolation --------------------------------------------

test('streamableHttp: sessionState is scoped per-session (independent providers)', async () => {
  const seen = [];
  const server = new MCPServer({
    name: 'x', version: '1.0.0',
    tools: [{
      name: 'peek', description: '', inputSchema: { type: 'object' },
      handler: async (_args, ctx) => { seen.push(ctx.sessionState.provider ?? null); return 'ok'; },
    }],
  });
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    // A initializes with _meta.provider = 'cheap', B does not
    const initA = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { _meta: { provider: 'cheap' } },
      }),
    });
    const sidA = initA.headers['mcp-session-id'];
    const initB = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sidB = initB.headers['mcp-session-id'];

    await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': sidA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peek', arguments: {} } }),
    });
    await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Mcp-Session-Id': sidB },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peek', arguments: {} } }),
    });
    assert.deepEqual(seen, ['cheap', null]);
  } finally { await t.close(); }
});

// ---- progress notifications via GET stream ------------------------------

test('streamableHttp: tool-call progress delivered to session GET stream', async () => {
  const server = new MCPServer({
    name: 'progress-test', version: '1.0.0',
    tools: [{
      name: 'slow',
      description: 'reports progress',
      inputSchema: { type: 'object' },
      handler: async (_args, ctx) => {
        ctx.reportProgress(1, 3);
        ctx.reportProgress(2, 3);
        ctx.reportProgress(3, 3);
        return 'complete';
      },
    }],
  });
  const t = await createStreamableHttpTransport({ server, port: 0 });
  try {
    const init = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sid = init.headers['mcp-session-id'];

    const stream = await openStream({ port: t.port, sessionId: sid });
    // POST tools/call while the stream is open — progress notifications
    // should arrive on the stream. The POST response itself is JSON (not SSE).
    const [, ...progressEvents] = await Promise.all([
      httpRequest({
        method: 'POST', path: '/mcp', port: t.port,
        headers: { 'Mcp-Session-Id': sid },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'slow', arguments: {}, _meta: { progressToken: 'p1' } },
        }),
      }),
      stream.nextEvent(),
      stream.nextEvent(),
      stream.nextEvent(),
    ]);
    for (let i = 0; i < progressEvents.length; i++) {
      assert.equal(progressEvents[i].method, 'notifications/progress');
      assert.equal(progressEvents[i].params.progressToken, 'p1');
      assert.equal(progressEvents[i].params.progress, i + 1);
    }
    stream.close();
  } finally { await t.close(); }
});

// ---- auth ---------------------------------------------------------------

test('streamableHttp auth: /mcp rejects requests without a bearer token', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0, authToken: 'secret' });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer realm="mcp"');
  } finally { await t.close(); }
});

test('streamableHttp auth: /mcp accepts a matching bearer token', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0, authToken: 'secret' });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Authorization': 'Bearer secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(res.status, 200);
  } finally { await t.close(); }
});

test('streamableHttp auth: /health remains public even with token set', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0, authToken: 'secret' });
  try {
    const res = await httpRequest({ method: 'GET', path: '/health', port: t.port });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).authRequired, true);
  } finally { await t.close(); }
});

test('streamableHttp auth: pluggable authTokenVerifier is honored', async () => {
  const server = makeServer();
  const seen = [];
  const t = await createStreamableHttpTransport({
    server, port: 0,
    authTokenVerifier: async (token) => { seen.push(token); return token === 'ok' ? { sub: 'alice' } : null; },
  });
  try {
    const ok = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Authorization': 'Bearer ok' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(ok.status, 200);
    const bad = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Authorization': 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(seen, ['ok', 'nope']);
  } finally { await t.close(); }
});

// ---- Origin validation (DNS rebinding protection) ----------------------

test('streamableHttp: allowedOrigins accepts a whitelisted Origin', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({
    server, port: 0,
    allowedOrigins: ['https://app.example.com'],
  });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Origin': 'https://app.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(res.status, 200);
  } finally { await t.close(); }
});

test('streamableHttp: allowedOrigins rejects a non-whitelisted Origin with 403', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({
    server, port: 0,
    allowedOrigins: ['https://app.example.com'],
  });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      headers: { 'Origin': 'https://evil.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /origin not allowed/);
  } finally { await t.close(); }
});

test('streamableHttp: missing Origin header is allowed (server-to-server, curl)', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({
    server, port: 0,
    allowedOrigins: ['https://app.example.com'],
  });
  try {
    // No Origin header — this is a native / server client, spec-conforming to allow.
    const res = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(res.status, 200);
  } finally { await t.close(); }
});

// ---- custom path --------------------------------------------------------

test('streamableHttp: custom endpoint path (path option)', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0, path: '/api/mcp' });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/api/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(res.status, 200);
    // Old default path is now 404
    const stale = await httpRequest({
      method: 'POST', path: '/mcp', port: t.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(stale.status, 404);
  } finally { await t.close(); }
});

// ---- close() cleanup ----------------------------------------------------

test('streamableHttp: close() cleans up all sessions + streams', async () => {
  const server = makeServer();
  const t = await createStreamableHttpTransport({ server, port: 0 });
  const init = await httpRequest({
    method: 'POST', path: '/mcp', port: t.port,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  const sid = init.headers['mcp-session-id'];
  const stream = await openStream({ port: t.port, sessionId: sid });
  // Verify server tracked a subscriber before close
  assert.equal(server._subscribers.size, 1);
  await t.close();
  assert.equal(server._subscribers.size, 0);
  stream.close();
});
