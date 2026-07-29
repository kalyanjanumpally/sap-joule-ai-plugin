const { MCPServer } = require('../../mcp/server');
const { buildTools, buildResources } = require('../../mcp/tools');
const { PromptRegistry, builtInPrompts } = require('../../promptRegistry');

async function mcp(ctx) {
  // Provider construction happens once at startup; provider.init() is called
  // BEFORE we start reading from stdin so any credential error surfaces
  // immediately and the MCP client sees the process die cleanly.
  const { provider, kind, model } = await ctx.buildProvider(ctx);
  await provider.init();

  const prompts = new PromptRegistry().registerAll(builtInPrompts());

  const pkg = require('../../../package.json');
  const server = new MCPServer({
    name: pkg.name,
    version: pkg.version,
    tools: buildTools({ provider, providerKind: kind, providerModel: model }),
    resources: buildResources({ provider, providerKind: kind, providerModel: model }),
    prompts,
    logger: (level, msg) => ctx.stderr.write(`[mcp:${level}] ${msg}\n`),
  });

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

Provider selection + credentials: same env vars as other subcommands
(SAPTARISHI_LLM_PROVIDER, ANTHROPIC_API_KEY, etc — see 'saptarishi-llm help').`;

module.exports = mcp;
