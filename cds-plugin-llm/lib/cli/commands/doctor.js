// `saptarishi-llm doctor` — one-shot diagnostic. Runs a battery of
// checks and reports pass/warn/fail per check with remediation tips.
//
// Extends the CLI observability arc (chain-visualize, chain-diff,
// chain-validate, preflight → doctor). Where `verify` connects one
// specific provider, `doctor` sweeps the whole environment: node
// version, package version, detected env vars, every detected
// provider, MCP transports.
//
//   saptarishi-llm doctor
//   saptarishi-llm doctor --provider anthropic
//   saptarishi-llm doctor --skip-network       # env checks only
//   saptarishi-llm doctor --timeout 5000       # per-check timeout
//   saptarishi-llm doctor --json               # structured output
//
// Exit code:  0 = all ok, 1 = at least one error, 2 = usage / crash.

const { PROVIDER_KINDS } = require('../providerFactory');

const MIN_NODE_MAJOR = 18;

// Env var → provider it enables.
const ENV_TO_PROVIDER = {
  ANTHROPIC_API_KEY:      'anthropic',
  GROQ_API_KEY:           'groq',
  OPENAI_API_KEY:         'openai-compatible',
  GOOGLE_API_KEY:         'gemini',
  FIREWORKS_API_KEY:      'fireworks',
  DEEPSEEK_API_KEY:       'deepseek',
  MISTRAL_API_KEY:        'mistral',
  AZURE_OPENAI_API_KEY:   'azure-openai',
  AICORE_URL:             'genai-hub',
  OLLAMA_URL:             'ollama',
};

// Reverse: provider → env vars that would enable it.
const PROVIDER_TO_ENV = {};
for (const [envVar, prov] of Object.entries(ENV_TO_PROVIDER)) {
  (PROVIDER_TO_ENV[prov] ??= []).push(envVar);
}
// Ollama runs without a key.
PROVIDER_TO_ENV['ollama'] = ['OLLAMA_URL'];

function redactValue(v) {
  if (!v) return '';
  if (v.length <= 8) return '***';
  return v.slice(0, 4) + '...' + v.slice(-4);
}

function makeCheck(name, status, message = '', remediation = '') {
  return { name, status, message, remediation };
}

async function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

// ---- Individual checks --------------------------------------------------

function checkNodeVersion() {
  const version = process.versions.node;
  const [major] = version.split('.').map(Number);
  if (major >= MIN_NODE_MAJOR) {
    return makeCheck('node-version', 'ok', `v${version}`);
  }
  return makeCheck(
    'node-version',
    'error',
    `v${version} — plugin requires Node >= ${MIN_NODE_MAJOR}`,
    `Upgrade Node.js to v${MIN_NODE_MAJOR}+ (see nodejs.org or nvm)`,
  );
}

function checkPackageVersion() {
  try {
    const pkg = require('../../../package.json');
    return makeCheck('package-version', 'ok', `${pkg.name} v${pkg.version}`);
  } catch (e) {
    return makeCheck('package-version', 'error', e.message);
  }
}

function checkEnvironment(env) {
  const detected = [];
  const missing = [];
  for (const varName of Object.keys(ENV_TO_PROVIDER)) {
    if (env[varName]) detected.push(varName);
    else missing.push(varName);
  }
  if (detected.length === 0) {
    return makeCheck(
      'environment',
      'warning',
      'no provider credentials detected in environment',
      `Set at least one of: ${Object.keys(ENV_TO_PROVIDER).slice(0, 4).join(', ')}, ...`,
    );
  }
  const summary = detected
    .map((k) => `${k}=${redactValue(env[k])}`)
    .join(', ');
  return makeCheck('environment', 'ok', `${detected.length} credential(s) detected: ${summary}`);
}

function detectProviders(env, opts) {
  if (opts.provider) return [opts.provider];
  const detected = new Set();
  for (const [varName, prov] of Object.entries(ENV_TO_PROVIDER)) {
    if (env[varName]) detected.add(prov);
  }
  return [...detected];
}

async function checkProvider(kind, ctx, timeoutMs) {
  const started = Date.now();
  try {
    const provOpts = { ...ctx.opts, provider: kind };
    const { provider, model } = await ctx.buildProvider({ opts: provOpts, env: ctx.env });
    await provider.init();
    const probe = provider.chat({
      messages: [{ role: 'user', content: 'reply with a single word: ok' }],
      maxTokens: 32,
    });
    const res = await withTimeout(probe, timeoutMs, `${kind} probe`);
    const elapsed = Date.now() - started;
    const okBody = /ok/i.test(res.text ?? '');
    if (!okBody) {
      return makeCheck(
        `provider:${kind}`,
        'warning',
        `${model} responded in ${elapsed}ms but did not include 'ok': ${(res.text ?? '').slice(0, 60)}`,
      );
    }
    return makeCheck(`provider:${kind}`, 'ok', `${model} responded in ${elapsed}ms`);
  } catch (err) {
    const elapsed = Date.now() - started;
    const message = err?.message ?? String(err);
    const status = err?.status ?? err?.statusCode;
    let remediation = '';
    if (status === 401 || /unauthor/i.test(message)) {
      const envVars = PROVIDER_TO_ENV[kind] ?? [];
      remediation = `Credentials rejected. Verify ${envVars.join(' or ')} at the provider console.`;
    } else if (status === 429 || /rate/i.test(message)) {
      remediation = 'Rate-limited during probe. Retry, or your account may have exceeded its quota.';
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed/i.test(message)) {
      remediation = 'Network unreachable. Check DNS / firewall / VPN / proxy settings.';
    } else if (/missing.*API_KEY|missing.*env/i.test(message)) {
      const envVars = PROVIDER_TO_ENV[kind] ?? [];
      remediation = `Set ${envVars.join(' or ')} in your environment.`;
    } else if (/timed out/i.test(message)) {
      remediation = `Increase --timeout or check network path to provider.`;
    }
    return makeCheck(`provider:${kind}`, 'error', `failed in ${elapsed}ms: ${message}`, remediation);
  }
}

function checkMcpTransports() {
  const results = [];
  try {
    require('../../mcp/httpTransport');
    results.push('httpTransport');
  } catch (e) {
    return makeCheck('mcp-transports', 'error', `httpTransport load failed: ${e.message}`);
  }
  try {
    require('../../mcp/streamableHttpTransport');
    results.push('streamableHttpTransport');
  } catch (e) {
    return makeCheck('mcp-transports', 'error', `streamableHttpTransport load failed: ${e.message}`);
  }
  return makeCheck('mcp-transports', 'ok', results.join(', '));
}

// ---- Main --------------------------------------------------------------

async function doctor(ctx) {
  const started = Date.now();
  const checks = [];
  const timeoutMs = ctx.opts.timeout ? parseInt(ctx.opts.timeout, 10) : 15_000;

  // Static checks — always run.
  checks.push(checkNodeVersion());
  checks.push(checkPackageVersion());
  checks.push(checkEnvironment(ctx.env));
  checks.push(checkMcpTransports());

  // Provider probes — unless --skip-network.
  const skipNetwork = !!ctx.opts['skip-network'];
  if (skipNetwork) {
    checks.push(makeCheck('provider-probes', 'ok', 'skipped (--skip-network)'));
  } else {
    const providers = detectProviders(ctx.env, ctx.opts);
    if (providers.length === 0) {
      checks.push(makeCheck(
        'provider-probes',
        'warning',
        'no providers to probe (no credentials detected). Use --provider <kind> to force one.',
      ));
    } else {
      for (const kind of providers) {
        if (!PROVIDER_KINDS.includes(kind)) {
          checks.push(makeCheck(`provider:${kind}`, 'error', `unknown provider — supported: ${PROVIDER_KINDS.join(', ')}`));
          continue;
        }
        checks.push(await checkProvider(kind, ctx, timeoutMs));
      }
    }
  }

  const durationMs = Date.now() - started;
  const counts = {
    ok:      checks.filter((c) => c.status === 'ok').length,
    warning: checks.filter((c) => c.status === 'warning').length,
    error:   checks.filter((c) => c.status === 'error').length,
  };
  const errors = checks.filter((c) => c.status === 'error');

  const report = { checks, counts, durationMs };

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const c of checks) {
      const marker = c.status === 'error' ? '✗' : c.status === 'warning' ? '⚠' : '✓';
      ctx.stdout.write(`${marker} ${c.status.padEnd(7)} ${c.name}${c.message ? '  ' + c.message : ''}\n`);
    }
    ctx.stdout.write('\n');
    ctx.stdout.write(`summary: ${counts.ok} ok, ${counts.warning} warnings, ${counts.error} errors  (${durationMs}ms)\n`);

    const withRem = checks.filter((c) => c.remediation);
    if (withRem.length > 0) {
      ctx.stdout.write('\nremediation:\n');
      for (const c of withRem) {
        const marker = c.status === 'error' ? '✗' : '⚠';
        ctx.stdout.write(`  ${marker} ${c.name}: ${c.remediation}\n`);
      }
    }
  }

  return errors.length > 0 ? 1 : 0;
}

doctor.help = `saptarishi-llm doctor — one-shot environment diagnostic

Runs Node/package/env checks then probes every detected provider with
a tiny chat. Pass/warn/fail per check with remediation tips.

options:
  --provider <kind>     probe only this provider (default: every one with credentials)
  --skip-network        skip provider probes; env / static checks only
  --timeout <ms>        per-provider probe timeout (default 15000)
  --json                emit structured report

examples:
  saptarishi-llm doctor
  saptarishi-llm doctor --provider anthropic
  saptarishi-llm doctor --skip-network
  saptarishi-llm doctor --json > diagnostic.json`;

module.exports = doctor;
// Exposed for tests.
module.exports.checkNodeVersion   = checkNodeVersion;
module.exports.checkPackageVersion = checkPackageVersion;
module.exports.checkEnvironment    = checkEnvironment;
module.exports.checkMcpTransports  = checkMcpTransports;
module.exports.detectProviders     = detectProviders;
module.exports.checkProvider       = checkProvider;
module.exports.redactValue         = redactValue;
