const { parseArgs } = require('node:util');
const { buildProvider, PROVIDER_KINDS } = require('./providerFactory');
const { readInput } = require('./input');

const COMMANDS = {
  chat: require('./commands/chat'),
  stream: require('./commands/stream'),
  embed: require('./commands/embed'),
  verify: require('./commands/verify'),
  providers: require('./commands/providers'),
  init: require('./commands/init'),
  mcp: require('./commands/mcp'),
  help: async () => { printHelp(); return 0; },
};

const GLOBAL_OPTS = {
  provider:    { type: 'string' },
  model:       { type: 'string' },
  'base-url':  { type: 'string' },
  'max-tokens': { type: 'string' },
  prompt:      { type: 'string', short: 'p' },
  system:      { type: 'string', short: 's' },
  file:        { type: 'string', short: 'f' },
  json:        { type: 'boolean' },
  help:        { type: 'boolean', short: 'h' },
  version:     { type: 'boolean' },
  force:       { type: 'boolean' },
  'dry-run':   { type: 'boolean' },
  'prompts-dir': { type: 'string' },
  'watch-prompts': { type: 'boolean' },
  http:          { type: 'boolean' },
  port:          { type: 'string' },
  host:          { type: 'string' },
  'auth-token':  { type: 'string' },
  'jwks-url':    { type: 'string' },
  'jwt-issuer':  { type: 'string' },
  'jwt-audience': { type: 'string' },
};

async function run(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    printVersion();
    return 0;
  }

  const [name, ...rest] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`unknown command: ${name}\nrun 'saptarishi-llm help' to see available commands.\n`);
    return 2;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: GLOBAL_OPTS,
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printHelp(name);
    return 0;
  }

  return cmd({
    opts: values,
    positionals,
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    buildProvider,
    readInput,
  });
}

function printVersion() {
  const pkg = require('../../package.json');
  process.stdout.write(`${pkg.name} v${pkg.version}\n`);
}

function printHelp(command) {
  if (command && command !== 'help') {
    const helpText = COMMANDS[command]?.help;
    if (helpText) {
      process.stdout.write(helpText + '\n');
      return;
    }
  }
  process.stdout.write(`saptarishi-llm — CLI for @saptarishi/cds-plugin-llm

usage:
  saptarishi-llm <command> [options]

commands:
  chat        Send a prompt, print the response
  stream      Send a prompt, stream tokens to stdout
  embed       Embed input text(s), print vectors
  verify      Sanity-check provider config (connect + tiny chat)
  providers   List supported provider kinds
  init        Scaffold a CAP app pre-wired to this plugin
  mcp         Expose the configured provider as an MCP server (stdio)
  help        Show this help

common options:
  --provider <kind>       ${PROVIDER_KINDS.join(' | ')}
                          (or env SAPTARISHI_LLM_PROVIDER)
  --model <id>            model id (or env SAPTARISHI_LLM_MODEL)
  --base-url <url>        endpoint override (Ollama / OpenAI-compat)
  --max-tokens <n>        max output tokens (default 1024)
  --prompt, -p <text>     user prompt (or read stdin if omitted)
  --file, -f <path>       read prompt from file
  --system, -s <text>     system prompt
  --json                  emit JSON instead of plain text
  --help, -h              show help
  --version, -v           show version

credentials (env vars):
  ANTHROPIC_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL,
  OLLAMA_URL, AICORE_URL, AICORE_TOKEN_URL, AICORE_CLIENT_ID,
  AICORE_CLIENT_SECRET, AICORE_DEPLOYMENT_ID, AICORE_RESOURCE_GROUP

examples:
  saptarishi-llm chat -p "hello"
  saptarishi-llm chat --provider groq -p "summarize this"
  echo "explain this code" | saptarishi-llm stream -f app.js
  saptarishi-llm embed -p "purchase order for steel coils" --json
  saptarishi-llm verify --provider anthropic
  saptarishi-llm init joule-demo --provider groq
  saptarishi-llm mcp                    # register in Claude Desktop config
`);
}

module.exports = { run };
