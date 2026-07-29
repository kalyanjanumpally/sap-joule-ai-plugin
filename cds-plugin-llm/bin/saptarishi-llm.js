#!/usr/bin/env node
require('../lib/cli').run(process.argv.slice(2))
  .then(exitCode => process.exit(exitCode ?? 0))
  .catch(err => {
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    if (process.env.SAPTARISHI_LLM_DEBUG && err?.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  });
