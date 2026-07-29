const fs = require('node:fs');

/**
 * Assemble the user prompt from CLI opts + stdin + file. Precedence:
 *   --prompt then --file then stdin then first positional.
 * Multiple sources concatenate with a blank line between them.
 * Returns the empty string if nothing is supplied (caller decides what to do).
 */
async function readInput({ opts, positionals, stdin }) {
  const parts = [];
  if (opts.prompt) parts.push(opts.prompt);
  if (opts.file) parts.push(fs.readFileSync(opts.file, 'utf8'));
  if (!process.stdin.isTTY) {
    const piped = await slurp(stdin);
    if (piped.length > 0) parts.push(piped);
  }
  if (positionals && positionals.length > 0) parts.push(positionals.join(' '));
  return parts.filter(Boolean).join('\n\n').trim();
}

function slurp(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

module.exports = { readInput };
