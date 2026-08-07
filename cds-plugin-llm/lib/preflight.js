// Boot-time preflight validator. Runs a structured set of checks
// at startup so pods fail-fast if config is wrong, instead of failing
// on the first user request.
//
// Composable — each check is a named entry in the returned report so
// consumers can wire the same checks into k8s liveness probes / CI
// smoke tests / MCP resources.
//
//   const { preflight } = require('@saptarishi/cds-plugin-llm');
//
//   await preflight({
//     requiredEnv: ['GROQ_API_KEY'],
//     providers: [
//       { name: 'openai',    probe: async () => openaiSvc.chat({...}) },
//       { name: 'anthropic', probe: async () => anthropicSvc.chat({...}) },
//     ],
//     chain:        stack.chain,                     // from 1.55 resilience.bundle
//     budgetLimits: { total: 500 },
//     models:       ['gpt-4o-mini', 'claude-sonnet-4-6'],
//   });
//   // Throws PreflightError on missing pieces (default failFast: true).
//   // The error carries .report — full structured check output.
//
// Runs each check with a per-check timeout; probes are done in parallel.
// Consumers wanting a report WITHOUT throwing pass `failFast: false`.

const { validateMiddlewareOrder } = require('./validateMiddlewareOrder');
const { DEFAULT_PRICING } = require('./pricing');

const DEFAULT_TIMEOUT_MS = 10_000;

class PreflightError extends Error {
  constructor(report) {
    const summary = `preflight failed: ${report.errors.length} error(s), ${report.warnings.length} warning(s).`;
    super(summary);
    this.name = 'PreflightError';
    this.code = 'PREFLIGHT_FAILED';
    this.report = report;
  }
}

async function preflight(options = {}) {
  const {
    requiredEnv        = [],
    providers          = [],
    chain              = null,
    budgetLimits       = null,
    models             = [],
    onCheck            = null,
    failFast           = true,
    timeoutMsPerCheck  = DEFAULT_TIMEOUT_MS,
    pricing            = DEFAULT_PRICING,
  } = options;

  if (!Array.isArray(requiredEnv))    throw new Error('preflight: requiredEnv must be an array of env-var names.');
  if (!Array.isArray(providers))      throw new Error('preflight: providers must be an array of { name, probe }.');
  if (!Array.isArray(models))         throw new Error('preflight: models must be an array of model-id strings.');
  if (chain != null && !Array.isArray(chain))
                                       throw new Error('preflight: chain must be an array of { kind } entries (matches validateMiddlewareOrder).');
  if (!Number.isFinite(timeoutMsPerCheck) || timeoutMsPerCheck < 100)
                                       throw new Error(`preflight: timeoutMsPerCheck must be >= 100 (got ${timeoutMsPerCheck}).`);

  const startedAt = Date.now();
  const checks = [];

  function push(name, status, message = null, details = null) {
    const entry = { name, status };
    if (message) entry.message = message;
    if (details) entry.details = details;
    checks.push(entry);
    if (onCheck) {
      try { onCheck(entry); } catch { /* swallow */ }
    }
  }

  // ---- 1. env vars -----------------------------------------------------
  for (const name of requiredEnv) {
    if (process.env[name] && String(process.env[name]).length > 0) {
      push(`env:${name}`, 'ok');
    } else {
      push(`env:${name}`, 'error', `env var '${name}' is required but not set`);
    }
  }

  // ---- 2. middleware chain --------------------------------------------
  if (chain) {
    try {
      const result = validateMiddlewareOrder(chain);
      const nonInfo = result.warnings.filter((w) => w.severity !== 'info');
      const errors  = result.warnings.filter((w) => w.severity === 'error');
      if (errors.length > 0) {
        push('chain:validate', 'error', `chain has ${errors.length} ordering error(s)`, { warnings: result.warnings });
      } else if (nonInfo.length > 0) {
        push('chain:validate', 'warning', `chain has ${nonInfo.length} warning(s)`, { warnings: result.warnings });
      } else {
        push('chain:validate', 'ok', null, { warnings: result.warnings });
      }
    } catch (e) {
      push('chain:validate', 'error', `chain validation threw: ${e.message}`);
    }
  }

  // ---- 3. budget limits -----------------------------------------------
  if (budgetLimits) {
    const hasAnyLimit = budgetLimits.total != null
      || (budgetLimits.perTenant && Object.keys(budgetLimits.perTenant).length > 0)
      || (budgetLimits.perModel  && Object.keys(budgetLimits.perModel).length > 0);
    if (hasAnyLimit) {
      push('budget:limits', 'ok');
    } else {
      push('budget:limits', 'warning', 'budgetLimits provided but no total/perTenant/perModel entries — costBudget will be a no-op');
    }
  }

  // ---- 4. models in pricing table --------------------------------------
  for (const model of models) {
    if (pricing?.[model]) {
      push(`model:${model}`, 'ok');
    } else {
      push(`model:${model}`, 'warning', `model '${model}' not in pricing table — cost estimates + adaptiveMaxTokens will skip it`);
    }
  }

  // ---- 5. provider probes (parallel) -----------------------------------
  const probeResults = await Promise.all(providers.map(async (p) => {
    if (!p || typeof p.name !== 'string' || typeof p.probe !== 'function') {
      return { name: 'provider:?', status: 'error', message: 'provider entry must be { name: string, probe: async () => any }' };
    }
    try {
      await Promise.race([
        Promise.resolve().then(() => p.probe()),
        new Promise((_, reject) => setTimeout(
          () => reject(Object.assign(new Error(`provider probe '${p.name}' timed out after ${timeoutMsPerCheck}ms`), { code: 'PROBE_TIMEOUT' })),
          timeoutMsPerCheck,
        )),
      ]);
      return { name: `provider:${p.name}`, status: 'ok' };
    } catch (e) {
      return {
        name:    `provider:${p.name}`,
        status:  'error',
        message: `provider probe failed: ${e.message}`,
      };
    }
  }));
  for (const r of probeResults) {
    push(r.name, r.status, r.message);
  }

  // ---- assemble report -------------------------------------------------
  const errors   = checks.filter((c) => c.status === 'error');
  const warnings = checks.filter((c) => c.status === 'warning');
  const oks      = checks.filter((c) => c.status === 'ok');

  const report = {
    ok:         errors.length === 0,
    timestamp:  new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checks,
    counts: {
      ok:      oks.length,
      warning: warnings.length,
      error:   errors.length,
    },
    errors,
    warnings,
  };

  if (!report.ok && failFast) {
    throw new PreflightError(report);
  }

  return report;
}

module.exports = { preflight, PreflightError };
