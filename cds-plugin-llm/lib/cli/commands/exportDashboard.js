// `saptarishi-llm export-dashboard` — ships pre-built observability
// dashboards + Prometheus alert rules matching the shipped
// `promMetrics` output. Turns "you have metrics" into "you have a
// working dashboard in 30 seconds."
//
//   saptarishi-llm export-dashboard --format grafana  > dashboard.json
//   saptarishi-llm export-dashboard --format alerts   > alerts.yml
//   saptarishi-llm export-dashboard --format datadog  --out dd.json
//   saptarishi-llm export-dashboard --format newrelic --account 1234567 --out nr.json
//
// Options:
//   --format <grafana|alerts|datadog|newrelic>   required
//   --out    <file>       write to file (default: stdout)
//   --datasource <uid>    Grafana Prometheus datasource UID (default: 'Prometheus')
//   --job    <name>       Prometheus `job` label to match (default: 'llm')
//   --account <id>        New Relic account id (required for --format newrelic)

const fs = require('node:fs');
const {
  grafanaDashboard,
  prometheusAlertRules,
  datadogDashboard,
  newrelicDashboard,
} = require('../../dashboards');

const USAGE = `usage:
  saptarishi-llm export-dashboard --format <grafana|alerts|datadog|newrelic> [options]

options:
  --format <fmt>       required — one of: grafana, alerts, datadog, newrelic
  --out <file>         write to file (default: stdout)
  --datasource <uid>   Grafana Prometheus datasource UID (default: 'Prometheus')
  --job <name>         Prometheus job label to match (default: 'llm')
  --account <id>       New Relic account id (required for --format newrelic)

examples:
  saptarishi-llm export-dashboard --format grafana > dashboard.json
  saptarishi-llm export-dashboard --format alerts  --out alerts.yml
  saptarishi-llm export-dashboard --format datadog --out dashboard.json
  saptarishi-llm export-dashboard --format newrelic --account 1234567 > nr.json`;

// ---- Minimal YAML emitter for Prometheus rules (no dep) ---------------
// The rules structure is a fixed shape; a tiny hand-rolled emitter beats
// pulling in js-yaml just for this one file. Handles: nested objects,
// arrays, single-line strings, multi-line via '>-' folded.

function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return yamlString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '\n' + value.map((v) => {
      const inner = toYaml(v, indent + 1);
      // For an object item, `inner` is a multi-line block already indented
      // for level `indent + 1`. We replace the leading indent of the first
      // line with `- ` and leave the remaining lines untouched (they're
      // already at the correct column for content nested under `- `).
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const lines = inner.trimStart().split('\n');
        const rest = lines.slice(1).join('\n');
        return `${pad}- ${lines[0]}${rest ? '\n' + rest : ''}`;
      }
      return `${pad}- ${inner.trimStart()}`;
    }).join('\n');
  }
  // object
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return '\n' + keys.map((k) => {
    const v = value[k];
    if (v && typeof v === 'object') {
      const inner = toYaml(v, indent + 1);
      if (Array.isArray(v) && v.length === 0)   return `${pad}${k}: []`;
      if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${k}: {}`;
      return `${pad}${k}:${inner}`;
    }
    return `${pad}${k}: ${toYaml(v, indent)}`;
  }).join('\n');
}

function yamlString(s) {
  // Multiline → folded-strip block scalar.
  if (s.includes('\n')) {
    const lines = s.split('\n');
    const pad = ' '.repeat(2);
    return '|-\n' + lines.map((l) => pad + l).join('\n');
  }
  // Quote when the string could be mis-parsed as YAML structure:
  //  * starts with a structure char (- : { [ ] etc) or whitespace
  //  * ends with whitespace or a colon
  //  * contains ": " (would look like a nested key)
  //  * contains " #" (inline comment)
  //  * matches YAML bool/null keywords
  //  * looks purely numeric
  //  * contains a bare quote / backslash
  const needsQuote =
    /^[\s\-:{}\[\],&*#?|<>=!%@`"']/.test(s) ||
    /\s$/.test(s) ||
    /:$/.test(s) ||
    s.includes(': ') ||
    s.includes(' #') ||
    /^(true|false|null|yes|no|~|off|on)$/i.test(s) ||
    /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ||
    /["\\]/.test(s);
  if (needsQuote) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

async function exportDashboard(ctx) {
  const fmt = ctx.opts.format;
  if (!fmt) {
    ctx.stderr.write(USAGE + '\n');
    return 2;
  }

  const datasource = ctx.opts.datasource ?? 'Prometheus';
  const job        = ctx.opts.job        ?? 'llm';

  let payload;
  let contentType = 'json';

  switch (fmt) {
    case 'grafana':
      payload = grafanaDashboard({ datasource, job });
      break;
    case 'alerts':
      payload = prometheusAlertRules({ job });
      contentType = 'yaml';
      break;
    case 'datadog':
      payload = datadogDashboard({ job });
      break;
    case 'newrelic': {
      const account = ctx.opts.account;
      if (!account) {
        ctx.stderr.write('export-dashboard(newrelic): --account <id> is required\n');
        return 2;
      }
      payload = newrelicDashboard({ accountId: parseInt(account, 10) || account, job });
      break;
    }
    default:
      ctx.stderr.write(`export-dashboard: unknown --format '${fmt}'. Use grafana, alerts, datadog, or newrelic.\n`);
      return 2;
  }

  const serialized = contentType === 'yaml'
    ? '# saptarishi-llm export-dashboard --format alerts\n' + toYaml(payload).replace(/^\n+/, '') + '\n'
    : JSON.stringify(payload, null, 2) + '\n';

  if (ctx.opts.out) {
    fs.writeFileSync(ctx.opts.out, serialized, 'utf8');
    ctx.stderr.write(`wrote ${fmt} ${contentType.toUpperCase()} to ${ctx.opts.out} (${serialized.length} bytes)\n`);
  } else {
    ctx.stdout.write(serialized);
  }
  return 0;
}

exportDashboard.help = `saptarishi-llm export-dashboard — ship pre-built dashboards + alert rules

Emits a ready-to-import dashboard (Grafana / Datadog / New Relic) or
Prometheus alert rules YAML, all wired to the metrics the shipped
promMetrics + prometheusHandler expose.

${USAGE}

Grafana workflow:
  saptarishi-llm export-dashboard --format grafana > dashboard.json
  # Import in Grafana: Dashboards → New → Import → paste JSON.

Prometheus alert workflow:
  saptarishi-llm export-dashboard --format alerts --out alerts.yml
  # Place under /etc/prometheus/rules/ and reload Prometheus.`;

module.exports = exportDashboard;
module.exports.toYaml = toYaml;
