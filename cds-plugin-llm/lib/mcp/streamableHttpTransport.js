// MCP Streamable HTTP transport (spec 2025-03-26). The spec-blessed
// replacement for the older HTTP+SSE transport (2024-11-05). One endpoint
// speaks the whole protocol: POST for client→server, GET for optional
// server-initiated SSE, DELETE for session termination.
//
// Wire protocol (default path: `/mcp`):
//
//   POST /mcp
//     Headers: Accept: application/json, text/event-stream
//              Mcp-Session-Id: <uuid>   (omitted only on the very first request)
//     Body:    a single JSON-RPC 2.0 message
//     Server responds:
//       - Notification (no id) → 202 Accepted, empty body
//       - Request (with id)    → 200 application/json with the reply
//       - Parse error          → 400
//     First request (initialize) with no Mcp-Session-Id: server assigns a UUID
//     and returns it via the `Mcp-Session-Id` response header; client echoes
//     it back on every subsequent request.
//
//   GET /mcp
//     Headers: Accept: text/event-stream
//              Mcp-Session-Id: <uuid>
//     Long-lived SSE stream. Server pushes broadcast notifications
//     (list_changed, resources_updated) + progress notifications for tool
//     calls in flight on the same session. Server responds 405 if a client
//     tries this without a valid session.
//
//   DELETE /mcp
//     Headers: Mcp-Session-Id: <uuid>
//     Explicit session termination. Returns 204. Unknown session → 404.
//
// Multi-session: N clients concurrently, each with its own session state
// carrying its subscriptions and provider alias.

const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Start the Streamable HTTP transport for an MCPServer.
 * Returns a Promise resolving to { url, port, close }.
 *
 * @param {object} params
 * @param {MCPServer} params.server         Existing MCPServer instance
 * @param {number}   [params.port=3333]     Listen port (0 for ephemeral)
 * @param {string}   [params.host='127.0.0.1']
 * @param {string}   [params.path='/mcp']   Endpoint path
 * @param {Function} [params.logger]        (level, msg) => void
 * @param {string}   [params.authToken]     Static bearer token (constant-time compare)
 * @param {Function} [params.authTokenVerifier]  Custom async (token) => claims|null
 * @param {string[]} [params.allowedOrigins]     Whitelist for Origin header (DNS-rebinding
 *                                               protection). null/[] = allow all (dev).
 */
function createStreamableHttpTransport({
  server,
  port = 3333,
  host = '127.0.0.1',
  path = '/mcp',
  logger = () => {},
  authToken = null,
  authTokenVerifier = null,
  allowedOrigins = null,
}) {
  const sessions = new Map(); // sessionId -> { streams: Set<res>, subscriptions, unsubscribe, sessionState, createdAt }

  // Pluggable bearer-token auth — same shape as httpTransport.js.
  if (authToken && authTokenVerifier) {
    logger('warn', 'both authToken and authTokenVerifier supplied; using verifier');
    authToken = null;
  }
  const verifier = authTokenVerifier ?? (authToken
    ? (async (token) => safeEqual(token, authToken) ? { sub: 'static' } : null)
    : null);

  const authorize = async (req) => {
    if (!verifier) return { ok: true };
    const header = req.headers['authorization'];
    if (!header) return { ok: false };
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return { ok: false };
    try {
      const claims = await verifier(m[1].trim());
      return claims ? { ok: true, claims } : { ok: false };
    } catch (err) {
      logger('warn', `token verifier threw: ${err.message}`);
      return { ok: false };
    }
  };

  const validateOrigin = (req) => {
    if (!allowedOrigins || allowedOrigins.length === 0) return true;
    const origin = req.headers['origin'];
    // Missing Origin is fine — server-to-server, curl, native clients don't send it.
    if (!origin) return true;
    return allowedOrigins.includes(origin);
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // Health probe stays public + on a separate path.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: server.name,
        version: server.version,
        transport: 'streamable-http',
        endpoint: path,
        sessions: sessions.size,
        authRequired: !!verifier,
      }));
      return;
    }

    if (url.pathname !== path) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Origin validation — spec requires this to prevent DNS rebinding attacks.
    if (!validateOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }

    // Auth check applies to POST / GET / DELETE on the MCP endpoint.
    const authResult = await authorize(req);
    if (!authResult.ok) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'POST') {
      return handlePost(req, res);
    }
    if (req.method === 'GET') {
      return handleGet(req, res);
    }
    if (req.method === 'DELETE') {
      return handleDelete(req, res);
    }

    res.writeHead(405, { 'Allow': 'POST, GET, DELETE' });
    res.end();
  });

  async function handlePost(req, res) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'parse error' }));
      return;
    }

    // Session resolution:
    //   - initialize with no session id → create a new session
    //   - initialize with an existing session id → reuse it (client reconnect)
    //   - any other request with no session id → 400
    //   - any request with an unknown session id → 404 (client must re-init)
    let sessionId = req.headers['mcp-session-id'];
    const isInitialize = msg?.method === 'initialize';
    let session;

    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session && !isInitialize) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown or expired session — re-initialize' }));
        return;
      }
    }
    if (!session) {
      if (!isInitialize) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Mcp-Session-Id required on non-initialize requests' }));
        return;
      }
      sessionId = crypto.randomUUID();
      session = createSession();
      sessions.set(sessionId, session);
      logger('info', `session ${sessionId.slice(0, 8)} opened (${sessions.size} active)`);
    }

    const transportCtx = {
      // Progress + list_changed notifications from tool handlers get routed
      // to every long-lived GET stream open on this session (typically 1).
      // If the client has no GET stream open, notifications are dropped —
      // same trade-off as the HTTP+SSE transport when no /sse is open.
      sendNotification: (notif) => {
        for (const stream of session.streams) {
          try { stream.write(`data: ${JSON.stringify(notif)}\n\n`); }
          catch (err) {
            logger('warn', `session ${sessionId.slice(0, 8)} notification write failed: ${err.message}`);
            session.streams.delete(stream);
          }
        }
      },
      subscriptions: session.subscriptions,
      sessionState: session.sessionState,
    };

    const reply = await server.handleMessage(msg, transportCtx);

    // Notifications (no id) — 202 Accepted, no body, per spec.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202, { 'Mcp-Session-Id': sessionId });
      res.end();
      return;
    }

    // Requests — 200 with JSON body. Session id echoed in header so client
    // can pick it up on the initialize response.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    });
    res.end(reply ? JSON.stringify(reply) : '');
  }

  function handleGet(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Mcp-Session-Id required on GET' }));
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      // 405 signals "session unknown or SSE not supported" — client should re-init.
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown session — re-initialize' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': sessionId,
    });
    res.flushHeaders?.();
    session.streams.add(res);
    logger('info', `session ${sessionId.slice(0, 8)} stream opened (${session.streams.size} streams)`);

    req.on('close', () => {
      session.streams.delete(res);
      logger('info', `session ${sessionId.slice(0, 8)} stream closed`);
    });
  }

  function handleDelete(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Mcp-Session-Id required on DELETE' }));
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end();
      return;
    }
    closeSession(sessionId, session);
    res.writeHead(204);
    res.end();
  }

  function createSession() {
    // One broadcast subscriber per session — server.notifyListChanged /
    // notifyResourceUpdated calls fan out to every stream open on this
    // session (typically 1, but can be more if the client reconnects).
    const streams = new Set();
    const broadcast = (notif) => {
      for (const stream of streams) {
        try { stream.write(`data: ${JSON.stringify(notif)}\n\n`); }
        catch { streams.delete(stream); }
      }
    };
    const unsubscribe = server.addSubscriber(broadcast);
    return {
      streams,
      subscriptions: unsubscribe.subscriptions,
      unsubscribe,
      sessionState: {},
      createdAt: Date.now(),
    };
  }

  function closeSession(sessionId, session) {
    for (const s of session.streams) { try { s.end(); } catch {} }
    session.streams.clear();
    try { session.unsubscribe?.(); } catch {}
    sessions.delete(sessionId);
    logger('info', `session ${sessionId.slice(0, 8)} terminated (${sessions.size} active)`);
  }

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' ? addr.port : port;
      const bindUrl = `http://${host}:${actualPort}`;
      logger('info', `MCP Streamable HTTP listening on ${bindUrl}${path}`);
      resolve({
        url: bindUrl,
        port: actualPort,
        close: () => new Promise(done => {
          for (const [sid, s] of sessions) closeSession(sid, s);
          httpServer.close(done);
        }),
      });
    });
    httpServer.on('error', reject);
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = { createStreamableHttpTransport };
