const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_KINDS, PROVIDER_DEFAULTS } = require('../providerFactory');

const PROVIDER_ENV_VARS = {
  anthropic:          ['ANTHROPIC_API_KEY=sk-ant-your-key-here'],
  ollama:             ['OLLAMA_URL=http://localhost:11434'],
  groq:               ['GROQ_API_KEY=gsk-your-key-here'],
  'openai-compatible': ['OPENAI_API_KEY=sk-your-key-here', 'OPENAI_BASE_URL=https://api.openai.com/v1'],
  'genai-hub': [
    'AICORE_URL=https://api.ai.<region>.hana.ondemand.com',
    'AICORE_TOKEN_URL=https://<tenant>.authentication.<region>.hana.ondemand.com/oauth/token',
    'AICORE_CLIENT_ID=sb-...',
    'AICORE_CLIENT_SECRET=...',
    'AICORE_DEPLOYMENT_ID=d...',
    'AICORE_RESOURCE_GROUP=default',
  ],
};

function llmConfigFor(kind, model) {
  const base = { kind: `llm-${kind}`, modelId: model };
  switch (kind) {
    case 'anthropic':
      base.credentials = { apiKey: '${ANTHROPIC_API_KEY}' };
      break;
    case 'ollama':
      base.credentials = { baseUrl: '${OLLAMA_URL}' };
      break;
    case 'groq':
      base.credentials = { apiKey: '${GROQ_API_KEY}' };
      break;
    case 'openai-compatible':
      base.credentials = { apiKey: '${OPENAI_API_KEY}', baseUrl: '${OPENAI_BASE_URL}' };
      break;
    case 'genai-hub':
      base.credentials = {
        aiCoreUrl: '${AICORE_URL}',
        tokenUrl: '${AICORE_TOKEN_URL}',
        clientId: '${AICORE_CLIENT_ID}',
        clientSecret: '${AICORE_CLIENT_SECRET}',
        deploymentId: '${AICORE_DEPLOYMENT_ID}',
        resourceGroup: '${AICORE_RESOURCE_GROUP}',
      };
      break;
  }
  return base;
}

async function init(ctx) {
  const targetDir = ctx.positionals[0];
  if (!targetDir) {
    ctx.stderr.write("usage: saptarishi-llm init <directory> [--provider <kind>] [--model <id>] [--force]\n");
    return 2;
  }

  const provider = ctx.opts.provider ?? 'anthropic';
  if (!PROVIDER_KINDS.includes(provider)) {
    ctx.stderr.write(`unknown provider '${provider}'. supported: ${PROVIDER_KINDS.join(', ')}\n`);
    return 2;
  }
  const model = ctx.opts.model ?? PROVIDER_DEFAULTS[provider].model;
  const force = ctx.opts.force === true;
  const dryRun = ctx.opts['dry-run'] === true;

  const absDir = path.resolve(targetDir);
  if (fs.existsSync(absDir)) {
    const entries = fs.readdirSync(absDir).filter(e => !e.startsWith('.'));
    if (entries.length > 0 && !force) {
      ctx.stderr.write(`directory '${absDir}' is not empty. pass --force to overwrite.\n`);
      return 1;
    }
  }

  const appName = path.basename(absDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const pluginVersion = require('../../../package.json').version;
  const llmConfig = llmConfigFor(provider, model);
  const substitutions = {
    APP_NAME: appName,
    PROVIDER_KIND: provider,
    MODEL: model,
    PLUGIN_VERSION: pluginVersion,
    LLM_CONFIG_JSON: JSON.stringify(llmConfig, null, 6).replace(/\n/g, '\n    '),
    ENV_VARS: (PROVIDER_ENV_VARS[provider] ?? []).join('\n'),
  };

  const files = [
    { src: 'package.json.tpl',           dst: 'package.json' },
    { src: 'srv/ai-service.cds.tpl',     dst: 'srv/ai-service.cds' },
    { src: 'srv/ai-service.js.tpl',      dst: 'srv/ai-service.js' },
    { src: 'env.example.tpl',            dst: '.env.example' },
    { src: 'gitignore.tpl',              dst: '.gitignore' },
    { src: 'README.md.tpl',              dst: 'README.md' },
  ];
  const templatesDir = path.resolve(__dirname, '..', 'templates');

  if (dryRun) {
    ctx.stdout.write(`Would scaffold in: ${absDir}\n`);
    for (const f of files) ctx.stdout.write(`  + ${f.dst}\n`);
    return 0;
  }

  fs.mkdirSync(absDir, { recursive: true });
  fs.mkdirSync(path.join(absDir, 'srv'), { recursive: true });

  for (const { src, dst } of files) {
    const tpl = fs.readFileSync(path.join(templatesDir, src), 'utf8');
    const rendered = renderTemplate(tpl, substitutions);
    fs.writeFileSync(path.join(absDir, dst), rendered);
  }

  ctx.stdout.write(`
Scaffolded ${appName} in ${absDir}
  provider: ${provider}
  model:    ${model}

Next steps:
  cd ${targetDir}
  cp .env.example .env               # then edit with real credentials
  npm install
  npx cds watch

Then:
  curl 'http://localhost:4004/ai/chat(prompt='"'"'hello'"'"')'
`);
  return 0;
}

function renderTemplate(tpl, subs) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in subs)) throw new Error(`template: unknown placeholder '${key}'`);
    return subs[key];
  });
}

init.help = `saptarishi-llm init — scaffold a CAP app pre-wired to this plugin

usage:
  saptarishi-llm init <directory> [--provider <kind>] [--model <id>] [--force] [--dry-run]

options:
  --provider <kind>    anthropic (default) | ollama | groq | openai-compatible | genai-hub
  --model <id>         model id (defaults per provider)
  --force              overwrite non-empty target directory
  --dry-run            show what would be created; write nothing

examples:
  saptarishi-llm init joule-demo
  saptarishi-llm init contract-copilot --provider groq --model llama-3.3-70b-versatile
  saptarishi-llm init procurement-ai --provider genai-hub`;

module.exports = init;
module.exports._renderTemplate = renderTemplate;
module.exports._llmConfigFor = llmConfigFor;
