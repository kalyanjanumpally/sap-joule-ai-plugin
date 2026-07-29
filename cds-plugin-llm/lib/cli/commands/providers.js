const { PROVIDER_KINDS, PROVIDER_DEFAULTS } = require('../providerFactory');

async function providers(ctx) {
  if (ctx.opts.json) {
    const rows = PROVIDER_KINDS.map(k => ({
      kind: k,
      defaultModel: PROVIDER_DEFAULTS[k].model,
      envVars: envVarsFor(k),
    }));
    ctx.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }

  ctx.stdout.write('Supported providers:\n\n');
  for (const kind of PROVIDER_KINDS) {
    const d = PROVIDER_DEFAULTS[kind];
    ctx.stdout.write(`  ${kind.padEnd(20)} default model: ${d.model}\n`);
    ctx.stdout.write(`  ${' '.repeat(20)} env: ${envVarsFor(kind).join(', ') || '(none)'}\n\n`);
  }
  ctx.stdout.write("Select via --provider <kind> or SAPTARISHI_LLM_PROVIDER env var.\n");
  return 0;
}

function envVarsFor(kind) {
  switch (kind) {
    case 'anthropic':          return ['ANTHROPIC_API_KEY'];
    case 'ollama':             return ['OLLAMA_URL (optional, default http://localhost:11434)'];
    case 'groq':               return ['GROQ_API_KEY'];
    case 'openai-compatible':  return ['OPENAI_API_KEY', 'OPENAI_BASE_URL (optional)'];
    case 'genai-hub':          return ['AICORE_URL', 'AICORE_TOKEN_URL', 'AICORE_CLIENT_ID', 'AICORE_CLIENT_SECRET', 'AICORE_DEPLOYMENT_ID', 'AICORE_RESOURCE_GROUP (optional)'];
    default: return [];
  }
}

providers.help = `saptarishi-llm providers — list supported provider kinds

Shows each provider's default model and the env vars it reads for credentials.

examples:
  saptarishi-llm providers
  saptarishi-llm providers --json`;

module.exports = providers;
