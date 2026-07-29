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
  constructor({ name, version, tools = [], resources = [], prompts = null, logger }) {
    if (!name) throw new Error('MCPServer requires a name');
    if (!version) throw new Error('MCPServer requires a version');
    this.name = name;
    this.version = version;
    this.tools = new Map();
    this.resources = new Map();
    this.prompts = prompts; // PromptRegistry-like: has list()/get()/render() or null
    for (const t of tools) this.registerTool(t);
    for (const r of resources) this.registerResource(r);
    this.log = logger ?? (() => {});
    this.initialized = false;
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

  /**
   * Handle a single JSON-RPC message and return the reply (or null for
   * notifications). Exposed for testing — the run() loop wires this to stdio.
   */
  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return this._errorReply(null, ERROR_CODES.INVALID_REQUEST, 'invalid message');
    }
    if (msg.jsonrpc !== JSONRPC_VERSION) {
      return this._errorReply(msg.id ?? null, ERROR_CODES.INVALID_REQUEST, 'jsonrpc must be "2.0"');
    }
    // Notifications have no id — no response.
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this._dispatch(msg.method, msg.params ?? {});
      if (isNotification) return null;
      return { jsonrpc: JSONRPC_VERSION, id: msg.id, result };
    } catch (err) {
      if (isNotification) return null;
      const code = err.code && Number.isInteger(err.code) ? err.code : ERROR_CODES.INTERNAL_ERROR;
      return this._errorReply(msg.id, code, err.message ?? String(err));
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize':
        this.initialized = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: this.name, version: this.version },
          capabilities: {
            tools: {},
            ...(this.resources.size > 0 ? { resources: {} } : {}),
            ...(this.prompts ? { prompts: {} } : {}),
          },
        };

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
        try {
          const value = await tool.handler(args ?? {});
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

      case 'resources/read': {
        const uri = params?.uri;
        const resource = this.resources.get(uri);
        if (!resource) {
          const err = new Error(`unknown resource: ${uri}`);
          err.code = ERROR_CODES.INVALID_PARAMS;
          throw err;
        }
        const value = await resource.read();
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return {
          contents: [{ uri, mimeType: resource.mimeType ?? 'text/plain', text }],
        };
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
    // Serialize message processing so replies stay in order and 'end'
    // waits for pending work before resolving.
    let queue = Promise.resolve();
    const enqueue = (fn) => { queue = queue.then(fn).catch(() => {}); return queue; };
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
            const reply = await this.handleMessage(msg);
            if (reply) stdout.write(JSON.stringify(reply) + '\n');
          });
        }
      });
      stdin.on('end', () => { queue.then(resolve); });
      stdin.on('error', reject);
    });
  }
}

function stringify(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

module.exports = { MCPServer, PROTOCOL_VERSION, ERROR_CODES };
