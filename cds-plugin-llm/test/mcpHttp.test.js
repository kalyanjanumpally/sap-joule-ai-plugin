const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { MCPServer, PROTOCOL_VERSION } = require('../lib/mcp/server');
const { createHttpTransport } = require('../lib/mcp/httpTransport');

function makeServer() {
  return new MCPServer({
    name: 'http-test',
    version: '1.0.0',
    tools: [{
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      handler: async ({ msg }) => ({ echoed: msg }),
    }],
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

/**
 * Open an SSE stream. `nextEvent()` returns the NEXT event since the last
 * call (not any already-seen one) — critical for tests that expect a specific
 * sequence like endpoint -> reply.
 */
function openSSE({ port, path = '/sse', headers = {} }) {
  return new Promise((resolve, reject) => {
    const events = [];
    let cursor = 0;
    let buffer = '';
    const waiters = [];
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { 'Accept': 'text/event-stream', ...headers },
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
          const parsed = parseSSEFrame(frame);
          events.push(parsed);
          if (waiters.length > 0) {
            const w = waiters.shift();
            cursor++;
            w(parsed);
          }
        }
      });
      resolve({
        req,
        events,
        nextEvent: () => new Promise((res2, rej2) => {
          if (cursor < events.length) {
            const e = events[cursor++];
            return res2(e);
          }
          waiters.push(res2);
          setTimeout(() => rej2(new Error('SSE event timeout')), 3000);
        }),
        close: () => { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseSSEFrame(frame) {
  const lines = frame.split('\n');
  const out = { event: 'message', data: '' };
  for (const line of lines) {
    if (line.startsWith('event:')) out.event = line.slice(6).trim();
    else if (line.startsWith('data:')) out.data = (out.data ? out.data + '\n' : '') + line.slice(5).trim();
  }
  return out;
}

test('httpTransport: starts on ephemeral port, health probe works', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    assert.ok(transport.url.startsWith('http://127.0.0.1:'));
    const res = await httpRequest({ method: 'GET', path: '/health', port: transport.port });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.server, 'http-test');
    assert.equal(parsed.transport, 'http+sse');
    assert.equal(parsed.sessions, 0);
  } finally { await transport.close(); }
});

test('httpTransport: GET /sse sends event: endpoint with sessionId', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const first = await sse.nextEvent();
    assert.equal(first.event, 'endpoint');
    assert.match(first.data, /^\/messages\?sessionId=[a-f0-9-]{36}$/);
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport: POST /messages routes reply back onto SSE stream', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const endpoint = await sse.nextEvent();
    const messagesPath = endpoint.data;

    const postRes = await httpRequest({
      method: 'POST', path: messagesPath, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(postRes.status, 202);

    const reply = await sse.nextEvent();
    assert.equal(reply.event, 'message');
    const parsed = JSON.parse(reply.data);
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(parsed.result.serverInfo.name, 'http-test');
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport: POST to unknown session returns 404', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/messages?sessionId=bogus', port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(res.status, 404);
    assert.match(res.body, /unknown or expired session/);
  } finally { await transport.close(); }
});

test('httpTransport: POST with bad JSON returns 400', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const endpoint = await sse.nextEvent();
    const res = await httpRequest({
      method: 'POST', path: endpoint.data, port: transport.port,
      body: 'not-json',
    });
    assert.equal(res.status, 400);
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport: session count grows and shrinks', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse1 = await openSSE({ port: transport.port });
    await sse1.nextEvent();
    const sse2 = await openSSE({ port: transport.port });
    await sse2.nextEvent();

    let health = await httpRequest({ method: 'GET', path: '/health', port: transport.port });
    assert.equal(JSON.parse(health.body).sessions, 2);

    sse1.close();
    await new Promise(res => setTimeout(res, 100));
    health = await httpRequest({ method: 'GET', path: '/health', port: transport.port });
    assert.equal(JSON.parse(health.body).sessions, 1);

    sse2.close();
  } finally { await transport.close(); }
});

test('httpTransport: tools/call round-trips over HTTP+SSE', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const endpoint = await sse.nextEvent();

    await httpRequest({
      method: 'POST', path: endpoint.data, port: transport.port,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'echo', arguments: { msg: 'roundtrip' } },
      }),
    });
    const reply = await sse.nextEvent();
    const parsed = JSON.parse(reply.data);
    assert.equal(parsed.result.isError, false);
    const content = JSON.parse(parsed.result.content[0].text);
    assert.equal(content.echoed, 'roundtrip');
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport: 404 for unknown routes', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const res = await httpRequest({ method: 'GET', path: '/nope', port: transport.port });
    assert.equal(res.status, 404);
  } finally { await transport.close(); }
});

// ---- bearer token auth (1.11.0) ------------------------------------------

test('httpTransport auth: /health remains public even with token set', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'sekret' });
  try {
    const res = await httpRequest({ method: 'GET', path: '/health', port: transport.port });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.authRequired, true);
  } finally { await transport.close(); }
});

test('httpTransport auth: /sse rejected without token', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'sekret' });
  try {
    const res = await httpRequest({ method: 'GET', path: '/sse', port: transport.port });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer realm="mcp"');
  } finally { await transport.close(); }
});

test('httpTransport auth: /sse rejected with wrong token', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'sekret' });
  try {
    const res = await httpRequest({
      method: 'GET', path: '/sse', port: transport.port,
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(res.status, 401);
  } finally { await transport.close(); }
});

test('httpTransport auth: /sse accepted with correct bearer token', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'sekret' });
  try {
    const sse = await openSSE({
      port: transport.port,
      path: '/sse',
      headers: { Authorization: 'Bearer sekret' },
    });
    const first = await sse.nextEvent();
    assert.equal(first.event, 'endpoint');
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport auth: /messages rejected without token', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'sekret' });
  try {
    const res = await httpRequest({
      method: 'POST', path: '/messages?sessionId=x', port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(res.status, 401);
  } finally { await transport.close(); }
});

test('httpTransport auth: round-trip with token works end-to-end', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'sekret' });
  try {
    const sse = await openSSE({
      port: transport.port,
      headers: { Authorization: 'Bearer sekret' },
    });
    const endpoint = await sse.nextEvent();

    const postRes = await httpRequest({
      method: 'POST', path: endpoint.data, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      headers: { Authorization: 'Bearer sekret' },
    });
    assert.equal(postRes.status, 202);

    const reply = await sse.nextEvent();
    const parsed = JSON.parse(reply.data);
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.serverInfo.name, 'http-test');
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport: notifyListChanged broadcasts to every connected session', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse1 = await openSSE({ port: transport.port });
    await sse1.nextEvent(); // consume endpoint
    const sse2 = await openSSE({ port: transport.port });
    await sse2.nextEvent(); // consume endpoint

    server.notifyListChanged('prompts');

    const [n1, n2] = await Promise.all([sse1.nextEvent(), sse2.nextEvent()]);
    const p1 = JSON.parse(n1.data);
    const p2 = JSON.parse(n2.data);
    assert.equal(p1.method, 'notifications/prompts/list_changed');
    assert.equal(p2.method, 'notifications/prompts/list_changed');
    sse1.close();
    sse2.close();
  } finally { await transport.close(); }
});

test('httpTransport: subscriber unregistered when session closes', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    await sse.nextEvent();

    assert.equal(server._subscribers.size, 1);
    sse.close();
    await new Promise(res => setTimeout(res, 100));
    assert.equal(server._subscribers.size, 0);
  } finally { await transport.close(); }
});

test('httpTransport: progress notifications delivered to session SSE stream', async () => {
  const server = new MCPServer({
    name: 'progress-test', version: '1.0.0',
    tools: [{
      name: 'slow',
      description: 'reports progress',
      inputSchema: { type: 'object' },
      handler: async (args, ctx) => {
        ctx.reportProgress(1, 3);
        ctx.reportProgress(2, 3);
        ctx.reportProgress(3, 3);
        return 'complete';
      },
    }],
  });
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const endpoint = await sse.nextEvent();

    await httpRequest({
      method: 'POST', path: endpoint.data, port: transport.port,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'slow', arguments: {}, _meta: { progressToken: 'p1' } },
      }),
    });

    // Expect 3 notifications then 1 reply
    const events = [];
    for (let i = 0; i < 4; i++) events.push(await sse.nextEvent());
    const progressEvents = events.slice(0, 3).map(e => JSON.parse(e.data));
    for (const p of progressEvents) {
      assert.equal(p.method, 'notifications/progress');
      assert.equal(p.params.progressToken, 'p1');
      assert.equal(p.params.total, 3);
    }
    assert.deepEqual(progressEvents.map(p => p.params.progress), [1, 2, 3]);
    const reply = JSON.parse(events[3].data);
    assert.equal(reply.id, 1);
    assert.equal(reply.result.isError, false);
    sse.close();
  } finally { await transport.close(); }
});

// ---- pluggable authTokenVerifier (1.16.0) --------------------------------

test('httpTransport authTokenVerifier: accepts token when verifier returns truthy', async () => {
  const server = makeServer();
  const seen = [];
  const transport = await createHttpTransport({
    server, port: 0,
    authTokenVerifier: async (token) => {
      seen.push(token);
      return token === 'ok-token' ? { sub: 'alice' } : null;
    },
  });
  try {
    const sse = await openSSE({ port: transport.port, headers: { Authorization: 'Bearer ok-token' } });
    const first = await sse.nextEvent();
    assert.equal(first.event, 'endpoint');
    assert.deepEqual(seen, ['ok-token']);
    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport authTokenVerifier: rejects token when verifier returns null', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({
    server, port: 0,
    authTokenVerifier: async () => null,
  });
  try {
    const res = await httpRequest({
      method: 'GET', path: '/sse', port: transport.port,
      headers: { Authorization: 'Bearer whatever' },
    });
    assert.equal(res.status, 401);
  } finally { await transport.close(); }
});

test('httpTransport authTokenVerifier: throws are treated as rejections', async () => {
  const server = makeServer();
  const logs = [];
  const transport = await createHttpTransport({
    server, port: 0,
    authTokenVerifier: async () => { throw new Error('verifier boom'); },
    logger: (level, msg) => logs.push({ level, msg }),
  });
  try {
    const res = await httpRequest({
      method: 'GET', path: '/sse', port: transport.port,
      headers: { Authorization: 'Bearer x' },
    });
    assert.equal(res.status, 401);
    assert.ok(logs.some(l => /verifier threw/.test(l.msg)));
  } finally { await transport.close(); }
});

test('httpTransport authTokenVerifier: /health public even with verifier configured', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({
    server, port: 0,
    authTokenVerifier: async () => null,
  });
  try {
    const res = await httpRequest({ method: 'GET', path: '/health', port: transport.port });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).authRequired, true);
  } finally { await transport.close(); }
});

test('httpTransport authTokenVerifier: rejects missing Authorization header', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({
    server, port: 0,
    authTokenVerifier: async () => ({}),
  });
  try {
    const res = await httpRequest({ method: 'GET', path: '/sse', port: transport.port });
    assert.equal(res.status, 401);
  } finally { await transport.close(); }
});

test('httpTransport: verifier wins when both authToken and authTokenVerifier supplied (warning logged)', async () => {
  const server = makeServer();
  const logs = [];
  const seen = [];
  const transport = await createHttpTransport({
    server, port: 0,
    authToken: 'static',
    authTokenVerifier: async (t) => { seen.push(t); return t === 'verifier-token' ? { sub: 'x' } : null; },
    logger: (level, msg) => logs.push({ level, msg }),
  });
  try {
    // Static token should NOT work — verifier is in charge
    const staticRes = await httpRequest({
      method: 'GET', path: '/sse', port: transport.port,
      headers: { Authorization: 'Bearer static' },
    });
    assert.equal(staticRes.status, 401);
    // Verifier's token DOES work
    const sse = await openSSE({ port: transport.port, headers: { Authorization: 'Bearer verifier-token' } });
    await sse.nextEvent();
    assert.ok(logs.some(l => /both authToken and authTokenVerifier/.test(l.msg)));
    sse.close();
  } finally { await transport.close(); }
});

// ---- resource subscriptions (1.17.0) --------------------------------------

function makeSubServer() {
  return new MCPServer({
    name: 'sub-test', version: '1.0.0',
    resources: [
      { uri: 'config://a', read: async () => ({ v: 1 }) },
      { uri: 'config://b', read: async () => ({ v: 2 }) },
    ],
  });
}

test('httpTransport: resources/subscribe + notifyResourceUpdated routes only to that session', async () => {
  const server = makeSubServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    // Session A subscribes to config://a
    const sseA = await openSSE({ port: transport.port });
    const epA = await sseA.nextEvent();
    await httpRequest({
      method: 'POST', path: epA.data, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://a' } }),
    });
    // Read subscribe reply off the stream
    const subReply = await sseA.nextEvent();
    assert.deepEqual(JSON.parse(subReply.data).result, {});

    // Session B subscribes to config://b only
    const sseB = await openSSE({ port: transport.port });
    const epB = await sseB.nextEvent();
    await httpRequest({
      method: 'POST', path: epB.data, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://b' } }),
    });
    await sseB.nextEvent(); // consume subscribe reply

    // Snapshot the raw event-buffer lengths so we can assert quiet channels
    // without leaving an outstanding waiter behind.
    const bLenBefore = sseB.events.length;

    // Fire an update for config://a — only A should hear it
    server.notifyResourceUpdated('config://a');
    const nA = await sseA.nextEvent();
    const parsedA = JSON.parse(nA.data);
    assert.equal(parsedA.method, 'notifications/resources/updated');
    assert.equal(parsedA.params.uri, 'config://a');
    // After a brief pause, B's buffer must not have grown.
    await new Promise(res => setTimeout(res, 150));
    assert.equal(sseB.events.length, bLenBefore, 'session B must not receive updates for config://a');

    // Fire an update for config://b — only B should hear it
    server.notifyResourceUpdated('config://b');
    const nB = await sseB.nextEvent();
    const parsedB = JSON.parse(nB.data);
    assert.equal(parsedB.params.uri, 'config://b');

    sseA.close();
    sseB.close();
  } finally { await transport.close(); }
});

test('httpTransport: resources/unsubscribe stops delivery to that session', async () => {
  const server = makeSubServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const ep = await sse.nextEvent();

    await httpRequest({
      method: 'POST', path: ep.data, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://a' } }),
    });
    await sse.nextEvent(); // subscribe reply

    server.notifyResourceUpdated('config://a');
    await sse.nextEvent(); // first update lands

    await httpRequest({
      method: 'POST', path: ep.data, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/unsubscribe', params: { uri: 'config://a' } }),
    });
    await sse.nextEvent(); // unsubscribe reply

    const lenBefore = sse.events.length;
    server.notifyResourceUpdated('config://a');
    await new Promise(res => setTimeout(res, 150));
    assert.equal(sse.events.length, lenBefore, 'update leaked after unsubscribe');

    sse.close();
  } finally { await transport.close(); }
});

test('httpTransport: subscriptions cleared when session closes', async () => {
  const server = makeSubServer();
  const transport = await createHttpTransport({ server, port: 0 });
  try {
    const sse = await openSSE({ port: transport.port });
    const ep = await sse.nextEvent();
    await httpRequest({
      method: 'POST', path: ep.data, port: transport.port,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'config://a' } }),
    });
    await sse.nextEvent();

    assert.equal(server.subscribedUris().size, 1);
    sse.close();
    await new Promise(res => setTimeout(res, 100));
    assert.equal(server._subscribers.size, 0);
    assert.equal(server.subscribedUris().size, 0);
  } finally { await transport.close(); }
});

test('httpTransport auth: constant-time comparison rejects length-mismatched tokens', async () => {
  const server = makeServer();
  const transport = await createHttpTransport({ server, port: 0, authToken: 'exactly-16chars!' });
  try {
    const res = await httpRequest({
      method: 'GET', path: '/sse', port: transport.port,
      headers: { Authorization: 'Bearer short' },
    });
    assert.equal(res.status, 401);
  } finally { await transport.close(); }
});
