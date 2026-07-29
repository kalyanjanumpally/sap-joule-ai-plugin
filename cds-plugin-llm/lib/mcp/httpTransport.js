// MCP HTTP+SSE transport (spec 2024-11-05). Exposes an MCPServer over
// network so any HTTP-capable MCP client can connect. Same handleMessage()
// as the stdio transport — only the wire format differs.
//
// Wire protocol:
//   GET /sse
//     Client opens an SSE stream. Server responds with:
//       event: endpoint
//       data: /messages?sessionId=<UUID>
//     Then keeps the stream open. All subsequent responses to that client
//     are written as `data: <json-rpc>\n\n` events on this stream.
//
//   POST /messages?sessionId=<UUID>   Content-Type: application/json
//     Body is a single JSON-RPC 2.0 message. Server acknowledges with 202,
//     processes the message, and pushes the reply (if any) to the matching
//     SSE stream.
//
// Multi-session: N clients can be connected concurrently, each with its
// own session. Client disconnect (SSE stream close) cleans up the session.

const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Start the HTTP+SSE transport for an MCPServer.
 * Returns a Promise resolving to { url, close() }.
 *
 * @param {object} params
 * @param {MCPServer} params.server        Existing MCPServer instance
 * @param {number}   [params.port=3333]    Listen port (0 for ephemeral)
 * @param {string}   [params.host='127.0.0.1']
 * @param {Function} [params.logger]       (level, msg) => void
 */
function createHttpTransport({ server, port = 3333, host = '127.0.0.1', logger = () => {} }) {
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      // Best-effort flush for Express-style compression proxies
      res.flushHeaders?.();
      sessions.set(sessionId, { res, connectedAt: Date.now() });
      logger('info', `session ${sessionId.slice(0, 8)} opened (${sessions.size} active)`);

      req.on('close', () => {
        sessions.delete(sessionId);
        logger('info', `session ${sessionId.slice(0, 8)} closed (${sessions.size} active)`);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown or expired session' }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'parse error' }));
          return;
        }
        res.writeHead(202);
        res.end();
        // Process and push reply on the SSE stream — asynchronously so the
        // POST response isn't blocked on tool execution.
        const reply = await server.handleMessage(msg);
        if (reply) {
          try {
            session.res.write(`data: ${JSON.stringify(reply)}\n\n`);
          } catch (err) {
            logger('warn', `session ${sessionId.slice(0, 8)} write failed: ${err.message}`);
            sessions.delete(sessionId);
          }
        }
      });
      return;
    }

    // Health probe
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: server.name,
        version: server.version,
        transport: 'http+sse',
        sessions: sessions.size,
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' ? addr.port : port;
      const bindUrl = `http://${host}:${actualPort}`;
      logger('info', `MCP HTTP+SSE listening on ${bindUrl}/sse`);
      resolve({
        url: bindUrl,
        port: actualPort,
        close: () => new Promise(res => {
          for (const s of sessions.values()) { try { s.res.end(); } catch {} }
          sessions.clear();
          httpServer.close(res);
        }),
      });
    });
    httpServer.on('error', reject);
  });
}

module.exports = { createHttpTransport };
