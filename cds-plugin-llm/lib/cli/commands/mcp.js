const { MCPServer } = require('../../mcp/server');
const { createHttpTransport } = require('../../mcp/httpTransport');
const { buildTools, buildResources, buildResourceTemplates } = require('../../mcp/tools');
const { PromptRegistry, builtInPrompts } = require('../../promptRegistry');

async function mcp(ctx) {
  // Provider construction happens once at startup; provider.init() is called
  // BEFORE we start reading from stdin so any credential error surfaces
  // immediately and the MCP client sees the process die cleanly.
  const { provider, kind, model } = await ctx.buildProvider(ctx);
  await provider.init();

  const prompts = new PromptRegistry().registerAll(builtInPrompts());
  const dir = ctx.opts['prompts-dir'] ?? ctx.env.SAPTARISHI_LLM_PROMPTS_DIR;
  if (dir) {
    const { loaded, registered } = await prompts.loadFromDir(dir);
    ctx.stderr.write(`[mcp] loaded ${registered} prompt template(s) from ${loaded} file(s) in ${dir}\n`);
  }

  const logger = (level, msg) => ctx.stderr.write(`[mcp:${level}] ${msg}\n`);
  const pkg = require('../../../package.json');
  const server = new MCPServer({
    name: pkg.name,
    version: pkg.version,
    tools: buildTools({ provider, providerKind: kind, providerModel: model }),
    resources: buildResources({ provider, providerKind: kind, providerModel: model }),
    resourceTemplates: buildResourceTemplates({ prompts }),
    prompts,
    logger,
  });

  // Hot-reload watch happens AFTER server construction so we can broadcast
  // notifications/prompts/list_changed to every connected client on reload.
  if (dir && ctx.opts['watch-prompts']) {
    prompts.watchDir(dir, {
      onReload: ({ loaded: l, registered: r, error }) => {
        if (error) {
          ctx.stderr.write(`[mcp:warn] hot-reload failed: ${error.message}\n`);
          return;
        }
        ctx.stderr.write(`[mcp] hot-reloaded ${r} prompt(s) from ${l} file(s)\n`);
        try { server.notifyListChanged('prompts'); }
        catch (e) { ctx.stderr.write(`[mcp:warn] list_changed notify failed: ${e.message}\n`); }
      },
    });
    ctx.stderr.write(`[mcp] watching ${dir} for changes\n`);
  }

  if (ctx.opts.http) {
    const port = ctx.opts.port ? parseInt(ctx.opts.port, 10) : 3333;
    const host = ctx.opts.host ?? '127.0.0.1';
    const authToken = ctx.opts['auth-token'] ?? ctx.env.SAPTARISHI_LLM_MCP_TOKEN ?? null;
    if (!authToken && host !== '127.0.0.1' && host !== 'localhost') {
      ctx.stderr.write(`[mcp:warn] binding to ${host} with no --auth-token — anyone on the network can call your provider. Set --auth-token or SAPTARISHI_LLM_MCP_TOKEN.\n`);
    }
    const transport = await createHttpTransport({ server, port, host, logger, authToken });
    ctx.stderr.write(`[mcp] ready (HTTP+SSE) — provider=${kind} model=${model}${authToken ? ' — auth: bearer token required' : ''}\n`);
    ctx.stderr.write(`[mcp] connect an MCP client to ${transport.url}/sse\n`);
    // Keep alive until SIGINT / SIGTERM
    await new Promise((resolve) => {
      const shutdown = () => { transport.close().then(resolve); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return 0;
  }

  ctx.stderr.write(`[mcp] ready — provider=${kind} model=${model}\n`);

  // stdout is reserved for MCP protocol messages ONLY; nothing else may
  // write there or the client will fail to parse.
  await server.run({ stdin: ctx.stdin, stdout: ctx.stdout });
  return 0;
}

mcp.help = `saptarishi-llm mcp — expose the configured provider as an MCP server

Speaks the Model Context Protocol (2024-11-05) over stdio JSON-RPC. Register
this as an MCP server in Claude Desktop / Cursor / Zed / any MCP client, and
those clients gain a chat / embed / verify tool backed by your configured
provider (with all its middleware, caching, rate limits, and tracing).

Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):

  {
    "mcpServers": {
      "saptarishi-llm": {
        "command": "npx",
        "args": ["-y", "@saptarishi/cds-plugin-llm", "mcp"],
        "env": {
          "SAPTARISHI_LLM_PROVIDER": "groq",
          "GROQ_API_KEY": "gsk-..."
        }
      }
    }
  }

Tools exposed:
  chat            — send prompt, return text
  embed           — embed input(s), return vectors
  verify          — tiny probe, return {ok, latencyMs, model, text}
  list_providers  — list every supported provider kind

Resources exposed (readable via resources/read):
  config://active-provider       — current provider + model + middleware count
  config://supported-providers   — every provider kind + default model

Prompts registered (invokable via prompts/get):
  summarize                — text -> N-sentence summary
  extract_json             — text + schema -> structured JSON
  classify                 — text + labels -> single label
  translate                — text + target language
  procurement_risk_scorer  — SAP-flavored risk analysis

Load extra prompts from a directory:
  --prompts-dir <path>     — .mjs/.js files exporting templates
                             (or set SAPTARISHI_LLM_PROMPTS_DIR env var)
  --watch-prompts          — hot-reload templates when files change

Transport:
  (default)                — stdio JSON-RPC (Claude Desktop / Cursor / Zed)
  --http [--port 3333]     — HTTP+SSE server. GET /sse for the event stream,
        [--host 127.0.0.1]   POST /messages?sessionId=X for client messages.
                             Handy for deploying as a network service.
        [--auth-token <t>]   Bearer token required on /sse + /messages
                             (or set SAPTARISHI_LLM_MCP_TOKEN env var).
                             /health stays public for load balancer probes.

Provider selection + credentials: same env vars as other subcommands
(SAPTARISHI_LLM_PROVIDER, ANTHROPIC_API_KEY, etc — see 'saptarishi-llm help').`;

module.exports = mcp;
