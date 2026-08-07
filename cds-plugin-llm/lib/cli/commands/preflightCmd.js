// `saptarishi-llm preflight <config.json>` — runs the 1.66 preflight
// validator against a config file. Exit code 0 on pass, 1 on error,
// 2 on usage / file errors. --json emits structured output.
//
// Config file shape:
//   {
//     "requiredEnv":  ["GROQ_API_KEY"],
//     "budgetLimits": { "total": 500 },
//     "models":       ["gpt-4o-mini", "claude-sonnet-4-6"],
//     "chain":        [{ "kind": "deadline" }, { "kind": "guardrails" }, ...]
//     // Note: providers[] probes are NOT supported by the CLI — those
//     // need runtime handles. Preflight from your app code for probes.
//   }

const fs = require('node:fs');
const { preflight } = require('../../preflight');

async function preflightCmd({ opts, positionals, stdout, stderr }) {
  if (positionals.length !== 1) {
    stderr.write('usage: saptarishi-llm preflight <config.json> [--json]\n');
    return 2;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(positionals[0], 'utf8'));
  } catch (e) {
    stderr.write(`preflight: failed to read ${positionals[0]}: ${e.message}\n`);
    return 2;
  }

  const report = await preflight({
    requiredEnv:  config.requiredEnv,
    chain:        config.chain,
    budgetLimits: config.budgetLimits,
    models:       config.models,
    failFast:     false,   // always collect the full report
  });

  if (opts.json) {
    stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const check of report.checks) {
      const marker = check.status === 'error' ? '✗' :
                     check.status === 'warning' ? '⚠' : '✓';
      stdout.write(`${marker} ${check.status.padEnd(7)} ${check.name}${check.message ? '  ' + check.message : ''}\n`);
    }
    stdout.write('\n');
    stdout.write(`summary: ${report.counts.ok} ok, ${report.counts.warning} warnings, ${report.counts.error} errors  (${report.durationMs}ms)\n`);
  }

  return report.errors.length > 0 ? 1 : 0;
}

module.exports = preflightCmd;
