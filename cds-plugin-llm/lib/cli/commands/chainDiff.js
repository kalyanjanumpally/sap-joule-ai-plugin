// `saptarishi-llm chain-diff <a.json> <b.json>` — diff two middleware
// chain snapshots. Exit code 0 if identical, 1 if drift, 2 on error.
// Use --json for structured output; default is human-readable.

const fs = require('node:fs');
const { chainDiff, formatChainDiff } = require('../../chainDiff');

async function chainDiffCmd({ opts, positionals, stdout, stderr }) {
  if (positionals.length !== 2) {
    stderr.write('usage: saptarishi-llm chain-diff <baseline.json> <live.json> [--json] [--no-colors]\n');
    return 2;
  }

  let a, b;
  try {
    a = JSON.parse(fs.readFileSync(positionals[0], 'utf8'));
    b = JSON.parse(fs.readFileSync(positionals[1], 'utf8'));
  } catch (e) {
    stderr.write(`chain-diff: failed to read snapshot file: ${e.message}\n`);
    return 2;
  }

  const diff = chainDiff(a, b);

  if (opts.json) {
    stdout.write(JSON.stringify(diff, null, 2) + '\n');
  } else {
    stdout.write(formatChainDiff(diff, { colors: !opts['no-colors'] && stdout.isTTY }) + '\n');
  }
  return diff.ok ? 0 : 1;
}

module.exports = chainDiffCmd;
