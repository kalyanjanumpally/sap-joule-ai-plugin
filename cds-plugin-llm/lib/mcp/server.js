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
    if (typeof resource.read !== 'function') throw new Error(`resource ${resource.uri}: read must be a function`);
    if (this.resources.has(resource.uri)) throw new Error(`resource ${resource.uri}: already registered`);
    this.resources.set(resource.uri, resource);
  }

  registerResourceTemplate(template) {
    if (!template?.uriTemplate) throw new Error('resourceTemplate.uriTemplate is required');
    if (typeof template.read !== 'function') throw new Error(`resourceTemplate ${template.uriTemplate}: read must be a function`);
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
      read: template.read,
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
        const handlerCtx = {
          reportProgress,
          progressToken: progressToken ?? null,
          sessionState: transportCtx.sessionState ?? {},
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
            const transportCtx = {
              sendNotification: (notif) => stdout.write(JSON.stringify(notif) + '\n'),
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

module.exports = { MCPServer, PROTOCOL_VERSION, ERROR_CODES };
