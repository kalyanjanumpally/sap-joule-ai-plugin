// `saptarishi-llm lint-prompts <dir>` — walks a directory of prompt
// template files (.txt / .md / .prompt), lints each, prints a
// human-readable report. Exit 0 if clean, 1 if any errors, 2 on usage.
//
// Companion to promptRegression (1.89) — the linter catches TEMPLATE
// issues (static analysis), the regression detector catches
// BEHAVIORAL drift (dynamic scoring).

const fs = require('node:fs');
const path = require('node:path');
const { lintPrompts, formatLintReport } = require('../../lintPrompt');

const DEFAULT_EXTENSIONS = new Set(['.txt', '.md', '.prompt']);

async function lintPromptsCmd(ctx) {
  const dir = ctx.positionals[0];
  if (!dir) {
    ctx.stderr.write('usage: saptarishi-llm lint-prompts <dir> [--max-tokens N] [--forbidden file] [--ignore CODE1,CODE2] [--json]\n');
    return 2;
  }

  if (!fs.existsSync(dir)) {
    ctx.stderr.write(`lint-prompts: directory not found: ${dir}\n`);
    return 2;
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    ctx.stderr.write(`lint-prompts: not a directory: ${dir}\n`);
    return 2;
  }

  // Collect prompts.
  const prompts = {};
  for (const entry of fs.readdirSync(dir)) {
    const ext = path.extname(entry).toLowerCase();
    if (!DEFAULT_EXTENSIONS.has(ext)) continue;
    const full = path.join(dir, entry);
    try {
      prompts[entry] = fs.readFileSync(full, 'utf8');
    } catch (e) {
      ctx.stderr.write(`lint-prompts: cannot read ${full}: ${e.message}\n`);
      return 2;
    }
  }
  if (Object.keys(prompts).length === 0) {
    ctx.stderr.write(`lint-prompts: no .txt/.md/.prompt files found in ${dir}\n`);
    return 2;
  }

  // Build options.
  const options = {};
  if (ctx.opts['max-tokens']) options.maxTokens = parseInt(ctx.opts['max-tokens'], 10);
  if (ctx.opts.ignore) options.ignore = ctx.opts.ignore.split(',').map((s) => s.trim());
  if (ctx.opts.forbidden) {
    try {
      const forbiddenText = fs.readFileSync(ctx.opts.forbidden, 'utf8');
      options.forbidden = forbiddenText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    } catch (e) {
      ctx.stderr.write(`lint-prompts: cannot read forbidden list: ${e.message}\n`);
      return 2;
    }
  }

  const report = lintPrompts(prompts, options);

  if (ctx.opts.json) {
    ctx.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const output = formatLintReport(report, { colors: !ctx.opts['no-colors'] && ctx.stdout.isTTY });
    ctx.stdout.write(output + '\n');
  }

  return report.summary.totalErrors > 0 ? 1 : 0;
}

lintPromptsCmd.help = `saptarishi-llm lint-prompts — lint prompt templates in a directory

Walks a directory of .txt / .md / .prompt files, runs the lintPrompt
static analyzer against each, prints a human-readable report.
Companion to promptRegression (1.89) — the linter catches TEMPLATE
issues (missing vars, mixed indent, injection patterns, etc.), the
regression detector catches BEHAVIORAL drift.

usage:
  saptarishi-llm lint-prompts <dir> [options]

options:
  --max-tokens <n>       flag prompts longer than N tokens (approx chars/4)
  --forbidden <file>     path to a file of forbidden phrases (one per line;
                         # prefix = comment)
  --ignore <codes>       comma-separated rule codes to suppress
  --json                 emit structured JSON
  --no-colors            disable ANSI colors in output

exit code:
  0  all prompts clean
  1  at least one error
  2  usage / missing directory / read error

examples:
  saptarishi-llm lint-prompts ./prompts
  saptarishi-llm lint-prompts ./prompts --max-tokens 2000
  saptarishi-llm lint-prompts ./prompts --forbidden ./banned.txt --ignore UNUSED_VAR,TRAILING_WHITESPACE
  saptarishi-llm lint-prompts ./prompts --json > lint.json`;

module.exports = lintPromptsCmd;
