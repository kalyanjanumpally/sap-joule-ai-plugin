const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_dash__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const exportDashboard = require('../lib/cli/commands/exportDashboard');
const { toYaml } = exportDashboard;
const {
  grafanaDashboard,
  prometheusAlertRules,
  datadogDashboard,
  newrelicDashboard,
} = require('../lib/dashboards');

class BufferStream {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(s); return true; }
  toString() { return this.chunks.join(''); }
}

function makeCtx({ opts = {} } = {}) {
  return {
    opts,
    positionals: [],
    env: {},
    stdin: null,
    stdout: new BufferStream(),
    stderr: new BufferStream(),
    buildProvider: async () => { throw new Error('not needed'); },
    readInput: async () => '',
  };
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
}

// ---- Grafana dashboard structure --------------------------------------

test('grafanaDashboard: schemaVersion + title + uid present', () => {
  const d = grafanaDashboard();
  assert.equal(typeof d.title, 'string');
  assert.equal(d.uid, 'cds-plugin-llm');
  assert.ok(d.schemaVersion >= 40);
  assert.ok(Array.isArray(d.panels));
  assert.ok(d.panels.length >= 10);
});

test('grafanaDashboard: panels reference real metric names', () => {
  const d = grafanaDashboard();
  const exprs = d.panels
    .filter((p) => Array.isArray(p.targets))
    .flatMap((p) => p.targets.map((t) => t.expr));
  const joined = exprs.join('\n');
  // Sample of expected metric names shipped by promMetrics:
  for (const name of [
    'llm_usage_cost_dollars_total',
    'llm_budget_spent_dollars',
    'llm_cache_hit_rate',
    'llm_breaker_state',
    'llm_bulkhead_queued',
    'llm_json_log_failed_total',
    'llm_injection_scanned_total',
  ]) {
    assert.match(joined, new RegExp(name.replace(/_/g, '_')), `dashboard missing metric ${name}`);
  }
});

test('grafanaDashboard: honors custom datasource + job', () => {
  const d = grafanaDashboard({ datasource: 'MyProm', job: 'app-llm' });
  const target = d.panels.find((p) => Array.isArray(p.targets))?.targets[0];
  assert.equal(target.datasource.uid, 'MyProm');
  // Inspect raw expr, not JSON-serialized form (JSON escapes quotes).
  const exprs = d.panels
    .filter((p) => Array.isArray(p.targets))
    .flatMap((p) => p.targets.map((t) => t.expr));
  assert.ok(exprs.some((e) => e.includes('job="app-llm"')));
});

// ---- Prometheus alert rules -------------------------------------------

test('prometheusAlertRules: contains expected alerts', () => {
  const r = prometheusAlertRules();
  const names = r.groups[0].rules.map((rule) => rule.alert);
  for (const alert of [
    'LlmBudgetNearLimit',
    'LlmBudgetExhausted',
    'LlmCircuitBreakerOpen',
    'LlmHighErrorRate',
    'LlmBulkheadSaturation',
    'LlmRateLimitGiveUps',
    'LlmProviderUnhealthy',
  ]) {
    assert.ok(names.includes(alert), `missing alert ${alert}`);
  }
});

test('prometheusAlertRules: every rule has severity + annotations', () => {
  const r = prometheusAlertRules();
  for (const rule of r.groups[0].rules) {
    assert.ok(rule.labels?.severity, `${rule.alert} missing severity`);
    assert.ok(rule.annotations?.summary, `${rule.alert} missing summary`);
    assert.ok(rule.annotations?.description, `${rule.alert} missing description`);
  }
});

test('prometheusAlertRules: honors custom job', () => {
  const r = prometheusAlertRules({ job: 'app-llm' });
  const exprs = r.groups[0].rules.map((rule) => rule.expr);
  assert.ok(exprs.every((e) => e.includes('job="app-llm"')));
});

// ---- Datadog + New Relic ---------------------------------------------

test('datadogDashboard: has expected shape', () => {
  const d = datadogDashboard();
  assert.equal(typeof d.title, 'string');
  assert.equal(d.layout_type, 'ordered');
  assert.ok(Array.isArray(d.widgets));
  assert.ok(d.widgets.length >= 4);
});

test('datadogDashboard: honors custom job', () => {
  const d = datadogDashboard({ job: 'app-llm' });
  const joined = JSON.stringify(d);
  assert.match(joined, /job:app-llm/);
});

test('newrelicDashboard: has expected shape + account propagates', () => {
  const d = newrelicDashboard({ accountId: 42, job: 'app-llm' });
  assert.equal(typeof d.name, 'string');
  assert.ok(Array.isArray(d.pages));
  const widgets = d.pages[0].widgets;
  assert.ok(widgets.length >= 4);
  assert.equal(widgets[0].rawConfiguration.nrqlQueries[0].accountId, 42);
  assert.match(widgets[0].rawConfiguration.nrqlQueries[0].query, /job = 'app-llm'/);
});

// ---- toYaml -----------------------------------------------------------

test('toYaml: simple object', () => {
  const y = toYaml({ a: 1, b: 'hello' });
  assert.match(y, /a: 1/);
  assert.match(y, /b: hello/);
});
test('toYaml: nested object', () => {
  const y = toYaml({ outer: { inner: 42 } });
  assert.match(y, /outer:/);
  assert.match(y, /^ +inner: 42$/m);
});
test('toYaml: array of objects renders as list', () => {
  const y = toYaml({ items: [{ x: 1 }, { x: 2 }] });
  assert.match(y, /- x: 1/);
  assert.match(y, /- x: 2/);
});
test('toYaml: quoted string when special chars', () => {
  const y = toYaml({ msg: 'hello: world' });
  assert.match(y, /msg: "hello: world"/);
});
test('toYaml: multiline uses folded block scalar', () => {
  const y = toYaml({ desc: 'line one\nline two' });
  assert.match(y, /desc: \|-/);
  assert.match(y, /^ +line one$/m);
  assert.match(y, /^ +line two$/m);
});
test('toYaml: empty array + object literals', () => {
  const y = toYaml({ arr: [], obj: {} });
  assert.match(y, /arr: \[\]/);
  assert.match(y, /obj: \{\}/);
});

// ---- CLI command ------------------------------------------------------

test('exportDashboard: --format missing → usage + exit 2', async () => {
  const ctx = makeCtx();
  const code = await exportDashboard(ctx);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /usage:/);
});

test('exportDashboard: unknown --format → usage + exit 2', async () => {
  const ctx = makeCtx({ opts: { format: 'bogus' } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /unknown --format/);
});

test('exportDashboard: --format grafana → valid JSON on stdout', async () => {
  const ctx = makeCtx({ opts: { format: 'grafana' } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 0);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.equal(parsed.uid, 'cds-plugin-llm');
});

test('exportDashboard: --format alerts → valid YAML on stdout', async () => {
  const ctx = makeCtx({ opts: { format: 'alerts' } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 0);
  const out = ctx.stdout.toString();
  assert.match(out, /groups:/);
  assert.match(out, /alert: LlmBudgetNearLimit/);
});

test('exportDashboard: --format datadog → valid JSON', async () => {
  const ctx = makeCtx({ opts: { format: 'datadog' } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 0);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.equal(parsed.layout_type, 'ordered');
});

test('exportDashboard: --format newrelic without --account → exit 2', async () => {
  const ctx = makeCtx({ opts: { format: 'newrelic' } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 2);
  assert.match(ctx.stderr.toString(), /--account.*required/);
});

test('exportDashboard: --format newrelic + --account → valid JSON', async () => {
  const ctx = makeCtx({ opts: { format: 'newrelic', account: '42' } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 0);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.equal(parsed.pages[0].widgets[0].rawConfiguration.nrqlQueries[0].accountId, 42);
});

test('exportDashboard: --out writes to file + reports bytes', async () => {
  const outFile = tmpFile('grafana.json');
  const ctx = makeCtx({ opts: { format: 'grafana', out: outFile } });
  const code = await exportDashboard(ctx);
  assert.equal(code, 0);
  const contents = fs.readFileSync(outFile, 'utf8');
  fs.unlinkSync(outFile);
  const parsed = JSON.parse(contents);
  assert.equal(parsed.uid, 'cds-plugin-llm');
  assert.match(ctx.stderr.toString(), /wrote grafana JSON to/);
  assert.match(ctx.stderr.toString(), /bytes/);
});

test('exportDashboard: --datasource + --job propagate to grafana', async () => {
  const ctx = makeCtx({ opts: { format: 'grafana', datasource: 'MyProm', job: 'joule-llm' } });
  await exportDashboard(ctx);
  const parsed = JSON.parse(ctx.stdout.toString());
  assert.equal(parsed.panels.find((p) => p.targets)?.targets[0].datasource.uid, 'MyProm');
  const exprs = parsed.panels.filter((p) => p.targets).flatMap((p) => p.targets.map((t) => t.expr));
  assert.ok(exprs.some((e) => e.includes('job="joule-llm"')));
});

test('exportDashboard: alerts YAML round-trips (basic structure preserved)', async () => {
  const ctx = makeCtx({ opts: { format: 'alerts' } });
  await exportDashboard(ctx);
  const out = ctx.stdout.toString();
  // Verify the YAML has the expected structure — must be indented properly.
  assert.match(out, /groups:\n {2}- name: cds-plugin-llm/);
  assert.match(out, /rules:\n {6}- alert: LlmBudgetNearLimit/);
});

test('exportDashboard: help text present', () => {
  assert.ok(typeof exportDashboard.help === 'string');
  assert.match(exportDashboard.help, /Grafana workflow/);
  assert.match(exportDashboard.help, /Prometheus/);
});
