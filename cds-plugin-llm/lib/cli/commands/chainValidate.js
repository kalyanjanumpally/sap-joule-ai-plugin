// `saptarishi-llm chain-validate <chain.json>` — runs the 1.48
// validateMiddlewareOrder against a chain snapshot. Exit 0 if no
// error-severity findings; exit 1 on error; use --strict to treat
// warnings as errors. --json emits structured output.

const fs = require('node:fs');
const { validateMiddlewareOrder } = require('../../validateMiddlewareOrder');

async function chainValidate({ opts, positionals, stdout, stderr }) {
  if (positionals.length !== 1) {
    stderr.write('usage: saptarishi-llm chain-validate <chain.json> [--json] [--strict]\n');
    return 2;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(positionals[0], 'utf8'));
  } catch (e) {
    stderr.write(`chain-validate: failed to read ${positionals[0]}: ${e.message}\n`);
    return 2;
  }
  if (!snapshot || !Array.isArray(snapshot.order)) {
    stderr.write('chain-validate: input must be a chain snapshot with an `order` array.\n');
    return 2;
  }

  const chain = snapshot.order.map((m) => ({ kind: m.kind }));
  const result = validateMiddlewareOrder(chain);

  if (opts.json) {
    stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (result.warnings.length === 0) {
      stdout.write(`chain-validate: OK (${chain.length} middleware, no findings)\n`);
    } else {
      const bySev = { error: [], warning: [], info: [] };
      for (const w of result.warnings) {
        (bySev[w.severity] ?? bySev.info).push(w);
      }
      for (const sev of ['error', 'warning', 'info']) {
        for (const w of bySev[sev]) {
          const marker = sev === 'error' ? '✗' : sev === 'warning' ? '⚠' : 'ℹ';
          stdout.write(`${marker} ${sev.padEnd(7)} ${w.code.padEnd(30)}  ${w.message}\n`);
          if (w.fixit) {
            stdout.write(`   fixit: ${w.fixit}\n`);
          }
        }
      }
      stdout.write(`\nsummary: ${bySev.error.length} errors, ${bySev.warning.length} warnings, ${bySev.info.length} info\n`);
    }
  }

  const errorCount   = result.warnings.filter((w) => w.severity === 'error').length;
  const warningCount = result.warnings.filter((w) => w.severity === 'warning').length;
  if (errorCount > 0) return 1;
  if (opts.strict && warningCount > 0) return 1;
  return 0;
}

module.exports = chainValidate;
