// `saptarishi-llm chain-visualize [file]` — ASCII box-drawing diagram
// of a middleware chain snapshot. Reads from file path OR stdin if no
// argument given. Snapshot shape matches config://chain from 1.48.

const fs = require('node:fs');

async function readSnapshot(sourcePath, stdin) {
  let raw;
  if (!sourcePath || sourcePath === '-') {
    raw = await new Promise((resolve, reject) => {
      const chunks = [];
      stdin.on('data', (c) => chunks.push(c));
      stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stdin.on('error', reject);
    });
  } else {
    raw = fs.readFileSync(sourcePath, 'utf8');
  }
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.order)) {
    throw new Error('chain-visualize: input must be a chain snapshot with an `order` array.');
  }
  return parsed;
}

function summarizeConfig(config) {
  if (!config || typeof config !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(config)) {
    if (parts.length >= 3) break;
    if (v == null) continue;
    let val;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      val = String(v);
    } else if (Array.isArray(v)) {
      val = `[${v.slice(0, 3).join(',')}${v.length > 3 ? '…' : ''}]`;
    } else {
      continue;
    }
    if (val.length > 20) val = val.slice(0, 17) + '…';
    parts.push(`${k}=${val}`);
  }
  return parts.join(' ');
}

function render(snapshot) {
  const out = [];
  const entries = snapshot.order;
  const maxKindLen = Math.max(...entries.map((e) => e.kind?.length ?? 0), 12);
  const boxWidth = Math.max(maxKindLen + 30, 50);

  out.push('┌' + '─'.repeat(boxWidth) + '┐');
  out.push('│' + centerPad(' OUTER (request enters here)', boxWidth) + '│');
  out.push('└' + '─'.repeat(boxWidth) + '┘');

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const kind = e.kind ?? '(unknown)';
    const summary = summarizeConfig(e.config);
    const label = `[${String(i).padStart(2, ' ')}] ${kind.padEnd(maxKindLen)}  ${summary}`.slice(0, boxWidth - 2);
    out.push('  │' + ' '.repeat(boxWidth - 2) + '│');
    out.push('  ▼' + ' '.repeat(boxWidth - 2));
    out.push('┌' + '─'.repeat(boxWidth) + '┐');
    out.push('│ ' + label.padEnd(boxWidth - 2) + ' │');
    out.push('└' + '─'.repeat(boxWidth) + '┘');
  }

  out.push('  │' + ' '.repeat(boxWidth - 2) + '│');
  out.push('  ▼' + ' '.repeat(boxWidth - 2));
  out.push('┌' + '─'.repeat(boxWidth) + '┐');
  out.push('│' + centerPad(' PROVIDER (LLM API call)', boxWidth) + '│');
  out.push('└' + '─'.repeat(boxWidth) + '┘');

  out.push('');
  out.push(`chain: ${entries.length} middleware (OUTER → INNER)`);
  return out.join('\n');
}

function centerPad(s, width) {
  const total = Math.max(0, width - s.length);
  const left  = Math.floor(total / 2);
  const right = total - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}

async function chainVisualize({ positionals, stdin, stdout }) {
  const [source] = positionals;
  const snapshot = await readSnapshot(source, stdin);
  stdout.write(render(snapshot) + '\n');
  return 0;
}

module.exports = chainVisualize;
