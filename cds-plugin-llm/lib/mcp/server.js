// Hand-rolled MCP server over stdio JSON-RPC 2.0. No external deps.
//
// Speaks Model Context Protocol version 2024-11-05:
//   https://spec.modelcontextprotocol.io/specification/2024-11-05/
//
// Supported methods:
//   initialize                       - handshake + capability advertisement
//   notifications/initialized        - notification, no response
//   ping                             - empty response
//   tools/list                       - enumerate registered tools
//   tools/call                       - invoke a tool by name
//   resources/list, resources/read, resources/templates/list
//   resources/subscribe              - subscribe to notifications/resources/updated
//   resources/unsubscribe            - stop receiving updates for a URI
//   prompts/list, prompts/get
//
// Transport: line-delimited JSON on stdin/stdout. Anything else on stdout
// corrupts the protocol — every log line goes to stderr instead.
//
// Tools are plain objects: { name, description, inputSchema, handler }.
// handler(args) returns any JSON-serializable value; it is wrapped into a
// text content-block on the way out. Throwing marks the tool result as
// isError: true so the client can surface the error to the model.

const PROTOCOL_VERSION = '2024-11-05';
const JSONRPC_VERSION = '2.0';

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

class MCPServer {
  constructor({ name, version, tools = [], resources = [], resourceTemplates = [], prompts = null, logger }) {
    if (!name) throw new Error('MCPServer requires a name');
    if (!version) throw new Error('MCPServer requires a version');
    this.name = name;
    this.version = version;
    this.tools = new Map();
    this.resources = new Map();
    this.resourceTemplates = [];  // parametrized URIs (e.g. 'prompt://{name}')
    this.prompts = prompts; // PromptRegistry-like: has list()/get()/render() or null
    for (const t of tools) this.registerTool(t);
    for (const r of resources) this.registerResource(r);
    for (const rt of resourceTemplates) this.registerResourceTemplate(rt);
    this.log = logger ?? (() => {});
    this.initialized = false;
    // Transport-registered notification sinks. Each active connection adds
    // one entry here — `send` is the wire-level notification writer;
    // `subscriptions` is that connection's per-URI subscription set (populated
    // by resources/subscribe). Broadcast helpers (`notifyListChanged`) fan out
    // across every entry; `notifyResourceUpdated` only reaches entries whose
    // `subscriptions` set contains the updated URI.
    this._subscribers = new Set();

    // ---- Server-initiated requests (2025-03-26 sampling + roots) --------
    //
    // MCP allows the server to send REQUESTS to the client — used for
    // sampling/createMessage (server asks the client to run an LLM
    // completion) and roots/list (server queries the client's declared
    // filesystem scope). We correlate the pending responses by JSON-RPC
    // id. Ids for server-initiated requests are prefixed 'srv-' to keep
    // them distinct from client-initiated ids in logs.
    this._pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this._nextRequestId = 1;
  }

  /**
   * Transport-facing: register a notification sink for the lifetime of a
   * connection. Returns an unsubscribe function whose `subscriptions` property
   * is the per-connection URI subscription Set — transports pass it into
   * `handleMessage` via `transportCtx.subscriptions` so resources/subscribe
   * mutates the same Set that `notifyResourceUpdated` later reads. The
   * transport MUST call the returned function when the connection closes,
   * otherwise the sink (and its subscriptions) leaks.
   */
  addSubscriber(sendNotification) {
    if (typeof sendNotification !== 'function') {
      throw new Error('addSubscriber requires a function');
    }
    const entry = { send: sendNotification, subscriptions: new Set() };
    this._subscribers.add(entry);
    const unsubscribe = () => { this._subscribers.delete(entry); };
    unsubscribe.subscriptions = entry.subscriptions;
    return unsubscribe;
  }

  /**
   * Broadcast a MCP list-changed notification to every connected client.
   * kind = 'prompts' | 'resources' | 'tools'. Silent no-op when there are
   * no subscribers.
   */
  notifyListChanged(kind) {
    if (!['prompts', 'resources', 'tools'].includes(kind)) {
      throw new Error(`notifyListChanged: unknown kind '${kind}'`);
    }
    const notif = {
      jsonrpc: JSONRPC_VERSION,
      method: `notifications/${kind}/list_changed`,
    };
    for (const entry of this._subscribers) {
      try { entry.send(notif); }
      catch (err) { this.log('warn', `list_changed notify failed: ${err.message}`); }
    }
  }

  /**
   * Return the distinct set of URIs any connected client has subscribed to,
   * optionally filtered by prefix. Useful when a broad invalidation event
   * (prompt hot-reload, config change) needs to fan out per-URI notifications
   * only to URIs someone actually cares about.
   */
  subscribedUris(prefix = null) {
    const seen = new Set();
    for (const entry of this._subscribers) {
      for (const uri of entry.subscriptions) {
        if (prefix && !uri.startsWith(prefix)) continue;
        seen.add(uri);
      }
    }
    return seen;
  }

  /**
   * Emit `notifications/resources/updated` for `uri` to every connection that
   * previously called `resources/subscribe` with the same URI. Silent no-op
   * when nobody is subscribed — safe to fire optimistically from hot-reload /
   * cache-invalidation hooks. Fans out per MCP 2024-11-05 subscriptions spec.
   */
  notifyResourceUpdated(uri) {
    if (typeof uri !== 'string' || !uri) {
      throw new Error('notifyResourceUpdated requires a non-empty string uri');
    }
    const notif = {
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/resources/updated',
      params: { uri },
    };
    for (const entry of this._subscribers) {
      if (!entry.subscriptions.has(uri)) continue;
      try { entry.send(notif); }
      catch (err) { this.log('warn', `resources/updated notify failed: ${err.message}`); }
    }
  }

  registerTool(tool) {
    if (!tool?.name) throw new Error('tool.name is required');
    if (typeof tool.handler !== 'function') throw new Error(`tool ${tool.name}: handler is required`);
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name}: already registered`);
    this.tools.set(tool.name, tool);
  }

  registerResource(resource) {
    if (!resource?.uri) throw new Error('resource.uri is required');
    // Accept either `read` (canonical, per MCP spec) or `handler` (the shape
    // returned by middleware.asMcpResource() across this plugin). Canonicalize
    // internally to `read` so the request handlers below stay simple.
    // @since 1.40.1
    const read = resource.read ?? resource.handler;
    if (typeof read !== 'function') {
      throw new Error(`resource ${resource.uri}: read (or handler) must be a function`);
    }
    if (this.resources.has(resource.uri)) throw new Error(`resource ${resource.uri}: already registered`);
    this.resources.set(resource.uri, { ...resource, read });
  }

  registerResourceTemplate(template) {
    if (!template?.uriTemplate) throw new Error('resourceTemplate.uriTemplate is required');
    // Same handler/read shim as registerResource (new in 1.40.1).
    const read = template.read ?? template.handler;
    if (typeof read !== 'function') {
      throw new Error(`resourceTemplate ${template.uriTemplate}: read (or handler) must be a function`);
    }
    const paramNames = extractTemplateParams(template.uriTemplate);
    if (paramNames.length === 0) {
      throw new Error(`resourceTemplate ${template.uriTemplate}: no {param} placeholders found — register as a plain resource instead`);
    }
    const regex = templateToRegex(template.uriTemplate, paramNames);
    this.resourceTemplates.push({
      uriTemplate: template.uriTemplate,
      name: template.name ?? template.uriTemplate,
      description: template.description ?? '',
      mimeType: template.mimeType ?? 'text/plain',
      read,
      _paramNames: paramNames,
      _regex: regex,
    });
  }

  _matchTemplate(uri) {
    for (const t of this.resourceTemplates) {
      const match = uri.match(t._regex);
      if (!match) continue;
      const params = {};
      for (let i = 0; i < t._paramNames.length; i++) {
        params[t._paramNames[i]] = decodeURIComponent(match[i + 1]);
      }
      return { template: t, params };
    }
    return null;
  }

  /**
   * Handle a single JSON-RPC message and return the reply (or null for
   * notifications). Exposed for testing — the run() loop wires this to stdio.
   *
   * `transportCtx.sendNotification(msg)` — optional. When supplied, tool
   * handlers can send `notifications/progress` back to the client mid-call
   * (MCP 2024-11-05 progress spec). The transport binds this to the specific
   * connection/session so notifications reach the right client.
   *
   * `transportCtx.sessionState` — optional plain object scoped to a single
   * MCP connection. Populated by `initialize` (e.g. `_meta.provider`) and
   * read by tool handlers to route calls to per-session defaults. Reset
   * naturally when the transport closes and re-opens the connection.
   */
  async handleMessage(msg, transportCtx = {}) {
    if (!msg || typeof msg !== 'object') {
      return this._errorReply(null, ERROR_CODES.INVALID_REQUEST, 'invalid message');
    }
    if (msg.jsonrpc !== JSONRPC_VERSION) {
      return this._errorReply(msg.id ?? null, ERROR_CODES.INVALID_REQUEST, 'jsonrpc must be "2.0"');
    }
    // Response to a server-initiated request (has id + result/error, no method).
    // Route to whichever pending sendRequest is awaiting this id.
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      const pending = this._pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(_rpcErrorAsError(msg.error));
        else pending.resolve(msg.result);
      } else {
        this.log('warn', `response for unknown request id ${msg.id} — dropped`);
      }
      return null;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this._dispatch(msg.method, msg.params ?? {}, transportCtx);
      if (isNotification) return null;
      return { jsonrpc: JSONRPC_VERSION, id: msg.id, result };
    } catch (err) {
      if (isNotification) return null;
      const code = err.code && Number.isInteger(err.code) ? err.code : ERROR_CODES.INTERNAL_ERROR;
      return this._errorReply(msg.id, code, err.message ?? String(err));
    }
  }

  /**
   * Send a server-initiated JSON-RPC request to the client and await the
   * response. Used by sampling/createMessage + roots/list.
   *
   * Requires the transport to expose `transportCtx.sendMessage(msg)` — the
   * wire-level writer that pushes a full JSON-RPC envelope to the connected
   * client. stdio, HTTP+SSE, and Streamable HTTP all support this.
   *
   *   const result = await server.sendRequest('sampling/createMessage', params, transportCtx);
   *
   * @param {string} method     JSON-RPC method name (e.g. 'sampling/createMessage')
   * @param {object} params     Method params
   * @param {object} transportCtx  Transport context; must have sendMessage(msg)
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=60000]
   */
  sendRequest(method, params, transportCtx, opts = {}) {
    const { timeoutMs = 60000 } = opts;
    if (!transportCtx || typeof transportCtx.sendMessage !== 'function') {
      return Promise.reject(new Error(
        'MCPServer.sendRequest: transportCtx.sendMessage is not available — the current transport does not support server-initiated requests.'
      ));
    }
    return new Promise((resolve, reject) => {
      const id = `srv-${this._nextRequestId++}`;
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`server request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pendingRequests.set(id, { resolve, reject, timer });
      const msg = { jsonrpc: JSONRPC_VERSION, id, method, params };
      try {
        transportCtx.sendMessage(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  async _dispatch(method, params, transportCtx = {}) {
    switch (method) {
      case 'initialize': {
        this.initialized = true;
        // Capture per-session defaults from the initialize handshake.
        // MCP `_meta` is a spec-blessed extension slot for cross-cutting
        // metadata like this (1.18.0 — session-scoped provider alias).
        // Validation is deferred to tools/call so a bad alias doesn't
        // wedge the handshake and hide the list_providers tool that would
        // help the user recover.
        const metaProvider = params?._meta?.provider;
        if (typeof metaProvider === 'string' && metaProvider && transportCtx.sessionState) {
          transportCtx.sessionState.provider = metaProvider;
        }
        // Stash the client's declared capabilities on sessionState so tool
        // handlers can gate `ctx.sample()` and `ctx.getRoots()` on the
        // client actually supporting them (spec 2025-03-26).
        if (transportCtx.sessionState) {
          transportCtx.sessionState.clientCapabilities = params?.capabilities ?? {};
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: this.name, version: this.version },
          capabilities: {
            tools: { listChanged: true },
            ...(this.resources.size > 0 || this.resourceTemplates.length > 0
              ? { resources: { listChanged: true, subscribe: true } } : {}),
            ...(this.prompts ? { prompts: { listChanged: true } } : {}),
          },
        };
      }

      case 'notifications/initialized':
        return {};

      case 'notifications/roots/list_changed': {
        // Client is telling us its filesystem roots changed. Invalidate any
        // cached list on this session so the next ctx.getRoots() call
        // re-fetches. Fetching eagerly would race — leave it lazy.
        if (transportCtx.sessionState) {
          transportCtx.sessionState.roots = null;
          transportCtx.sessionState.rootsFetchedAt = null;
        }
        return {};
      }

      case 'ping':
        return {};

      case 'tools/list':
        return {
          tools: Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          })),
        };

      case 'tools/call': {
        const { name, arguments: args } = params;
        const tool = this.tools.get(name);
        if (!tool) {
          const err = new Error(`unknown tool: ${name}`);
          err.code = ERROR_CODES.METHOD_NOT_FOUND;
          throw err;
        }
        // Build progress reporter — no-op unless the client sent a
        // `_meta.progressToken` AND the transport supplied a notification
        // sink. Progress spec: 2024-11-05.
        const progressToken = params._meta?.progressToken;
        const canSendProgress = progressToken != null && typeof transportCtx.sendNotification === 'function';
        const reportProgress = canSendProgress
          ? (progress, total) => {
              const notif = {
                jsonrpc: JSONRPC_VERSION,
                method: 'notifications/progress',
                params: { progressToken, progress },
              };
              if (typeof total === 'number') notif.params.total = total;
              try { transportCtx.sendNotification(notif); }
              catch (err) { this.log('warn', `progress notification failed: ${err.message}`); }
            }
          : () => {};
        // ctx.sample({ messages, systemPrompt?, maxTokens?, modelPreferences? })
        // and ctx.getRoots() — server-initiated MCP requests. Both require
        // the transport to support server → client messaging (sendMessage
        // on transportCtx) AND the client to have declared the matching
        // capability in initialize. Otherwise they throw a specific error
        // so tool authors can gracefully fall back to a local LLM.
        const clientCaps = transportCtx.sessionState?.clientCapabilities ?? {};
        const canSend = typeof transportCtx.sendMessage === 'function';

        const sample = async (samplingParams) => {
          if (!canSend) {
            throw new Error(
              'ctx.sample() requires a bidirectional transport — this transport does not expose sendMessage(). Use stdio, HTTP+SSE, or Streamable HTTP.'
            );
          }
          if (!clientCaps.sampling) {
            throw new Error(
              'ctx.sample() unavailable — the connected client did not declare a sampling capability in its initialize handshake.'
            );
          }
          return this.sendRequest('sampling/createMessage', samplingParams, transportCtx);
        };

        const getRoots = async () => {
          if (!canSend) {
            throw new Error(
              'ctx.getRoots() requires a bidirectional transport — this transport does not expose sendMessage(). Use stdio, HTTP+SSE, or Streamable HTTP.'
            );
          }
          if (!clientCaps.roots) {
            throw new Error(
              'ctx.getRoots() unavailable — the connected client did not declare a roots capability in its initialize handshake.'
            );
          }
          // Cache per-session; the client will send
          // notifications/roots/list_changed if the list changes and we
          // invalidate the cache there.
          if (transportCtx.sessionState?.roots) return transportCtx.sessionState.roots;
          const result = await this.sendRequest('roots/list', {}, transportCtx);
          const roots = Array.isArray(result?.roots) ? result.roots : [];
          if (transportCtx.sessionState) {
            transportCtx.sessionState.roots = roots;
            transportCtx.sessionState.rootsFetchedAt = Date.now();
          }
          return roots;
        };

        const handlerCtx = {
          reportProgress,
          progressToken: progressToken ?? null,
          sessionState: transportCtx.sessionState ?? {},
          sample,
          getRoots,
        };
        try {
          const value = await tool.handler(args ?? {}, handlerCtx);
          return { content: [{ type: 'text', text: stringify(value) }], isError: false };
        } catch (toolErr) {
          this.log('error', `tool ${name} failed: ${toolErr?.message}`);
          return {
            content: [{ type: 'text', text: toolErr?.message ?? String(toolErr) }],
            isError: true,
          };
        }
      }

      case 'resources/list':
        return {
          resources: Array.from(this.resources.values()).map(r => ({
            uri: r.uri,
            name: r.name ?? r.uri,
            description: r.description ?? '',
            mimeType: r.mimeType ?? 'text/plain',
          })),
        };

      case 'resources/templates/list':
        return {
          resourceTemplates: this.resourceTemplates.map(t => ({
            uriTemplate: t.uriTemplate,
            name: t.name,
            description: t.description,
            mimeType: t.mimeType,
          })),
        };

      case 'resources/read': {
        const uri = params?.uri;
        // Exact match first (static resources)
        const resource = this.resources.get(uri);
        if (resource) {
          const value = await resource.read();
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          return {
            contents: [{ uri, mimeType: resource.mimeType ?? 'text/plain', text }],
          };
        }
        // Fall through to templated resources
        const matched = this._matchTemplate(uri);
        if (matched) {
          const value = await matched.template.read(matched.params);
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          return {
            contents: [{ uri, mimeType: matched.template.mimeType, text }],
          };
        }
        const err = new Error(`unknown resource: ${uri}`);
        err.code = ERROR_CODES.INVALID_PARAMS;
        throw err;
      }

      case 'resources/subscribe': {
        const uri = params?.uri;
        if (typeof uri !== 'string' || !uri) {
          const err = new Error('resources/subscribe: uri is required');
          err.code = ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        // Validate the URI is known — either a static resource or matches a
        // registered template. Reject unknowns so clients notice typos early
        // instead of silently subscribing to a URI that will never fire.
        const exists = this.resources.has(uri) || this._matchTemplate(uri) !== null;
        if (!exists) {
          const err = new Error(`unknown resource: ${uri}`);
          err.code = ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        // No transport sink → subscribe is a silent no-op. The spec is silent
        // on this edge, but rejecting would break the pattern of subscribe
        // being harmless for stateless clients / test harnesses.
        transportCtx.subscriptions?.add(uri);
        return {};
      }

      case 'resources/unsubscribe': {
        const uri = params?.uri;
        if (typeof uri !== 'string' || !uri) {
          const err = new Error('resources/unsubscribe: uri is required');
          err.code = ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        // Idempotent — unsubscribing a URI you never subscribed to succeeds.
        // Matches MCP 2024-11-05 subscriptions spec.
        transportCtx.subscriptions?.delete(uri);
        return {};
      }

      case 'prompts/list':
        if (!this.prompts) return { prompts: [] };
        return { prompts: this.prompts.list() };

      case 'prompts/get': {
        if (!this.prompts) {
          const err = new Error('no prompt registry configured');
          err.code = ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (!this.prompts.has(name)) {
          const err = new Error(`unknown prompt: ${name}`);
          err.code = ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        const rendered = this.prompts.render(name, args);
        // MCP prompts/get returns { description, messages: [...] } where
        // messages are { role, content: {type: 'text', text: '...'} }.
        // Translate the plugin's ChatRequest shape into that.
        const promptDef = this.prompts.get(name);
        const messages = [];
        if (rendered.system) {
          messages.push({ role: 'user', content: { type: 'text', text: `[system]\n${rendered.system}` } });
        }
        for (const m of rendered.messages) {
          const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map(c => c.text ?? '').filter(Boolean).join('\n')
              : String(m.content);
          messages.push({ role: m.role, content: { type: 'text', text } });
        }
        return { description: promptDef.description, messages };
      }

      default: {
        const err = new Error(`method not found: ${method}`);
        err.code = ERROR_CODES.METHOD_NOT_FOUND;
        throw err;
      }
    }
  }

  _errorReply(id, code, message) {
    return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
  }

  /**
   * Wire the server to a stdio-style transport. `stdin` yields chunks;
   * `stdout.write(line + '\n')` sends the reply. Resolves when stdin closes.
   */
  async run({ stdin, stdout }) {
    let buffer = '';
    let queue = Promise.resolve();
    const enqueue = (fn) => { queue = queue.then(fn).catch(() => {}); return queue; };
    // Register a subscriber so broadcast notifications (list_changed etc)
    // reach this stdio client while the connection is live.
    const send = (notif) => stdout.write(JSON.stringify(notif) + '\n');
    const unsubscribe = this.addSubscriber(send);
    // Per-connection scratch bag. `initialize` writes defaults here (e.g.
    // provider alias); tool handlers read them.
    const sessionState = {};
    return new Promise((resolve, reject) => {
      stdin.setEncoding?.('utf8');
      stdin.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          enqueue(async () => {
            let msg;
            try { msg = JSON.parse(line); }
            catch (e) {
              stdout.write(JSON.stringify(this._errorReply(null, ERROR_CODES.PARSE_ERROR, 'parse error')) + '\n');
              return;
            }
            // Wire sendNotification so tools can push progress upstream
            // on the same stdout stream. Subscriptions Set is shared with
            // this connection's addSubscriber entry so resources/subscribe
            // updates the same Set that notifyResourceUpdated reads.
            // sendMessage is the generic wire writer used for server-
            // initiated requests (sampling/createMessage, roots/list).
            const sendMessage = (m) => stdout.write(JSON.stringify(m) + '\n');
            const transportCtx = {
              sendNotification: sendMessage,
              sendMessage,
              subscriptions: unsubscribe.subscriptions,
              sessionState,
            };
            const reply = await this.handleMessage(msg, transportCtx);
            if (reply) stdout.write(JSON.stringify(reply) + '\n');
          });
        }
      });
      stdin.on('end', () => { queue.then(() => { unsubscribe(); resolve(); }); });
      stdin.on('error', (err) => { unsubscribe(); reject(err); });
    });
  }
}

function stringify(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// RFC 6570 Level 1 style: replace {name} with a capturing group.
function extractTemplateParams(tpl) {
  const names = [];
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let m;
  while ((m = re.exec(tpl)) !== null) names.push(m[1]);
  return names;
}

function templateToRegex(tpl, paramNames) {
  // Escape regex meta chars in the literal portions, then substitute
  // {param} with a lazy match up to the next literal.
  let escaped = tpl.replace(/[.*+?^${}()|[\]\\]/g, s => (s === '{' || s === '}' ? s : '\\' + s));
  for (const n of paramNames) {
    escaped = escaped.replace(`{${n}}`, '([^/?#]+)');
  }
  return new RegExp('^' + escaped + '$');
}

function _rpcErrorAsError(rpc) {
  const err = new Error(rpc?.message ?? 'server request rejected');
  if (rpc?.code != null) err.code = rpc.code;
  if (rpc?.data != null) err.data = rpc.data;
  return err;
}

module.exports = { MCPServer, PROTOCOL_VERSION, ERROR_CODES };
