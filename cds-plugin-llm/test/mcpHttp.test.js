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
function openSSE({ port, path = '/sse' }) {
  return new Promise((resolve, reject) => {
    const events = [];
    let cursor = 0;
    let buffer = '';
    const waiters = [];
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
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
