const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so LLMService loads without the real package.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_usage_cap__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const LLMService = require('../lib/LLMService');
const { usageMeteringToCap, DEFAULT_ENTITY } = require('../lib/middleware/usageMeteringToCap');

// ---- test doubles ------------------------------------------------------

class StubProvider extends LLMService {
  async _chat(params) {
    const usage = this._nextUsage ?? { input_tokens: 100, output_tokens: 200 };
    return { text: 'ok', raw: null, usage, model: params.model, stopReason: 'end_turn' };
  }
}

/**
 * Fake cds. Emulates cds.ql.INSERT.into(name).entries(record), cds.run(query),
 * cds.utils.uuid(), cds.log(). Records every INSERT for assertions.
 */
function makeFakeCds({ runImpl, uuid = () => 'uuid-fixed' } = {}) {
  const inserts = [];
  const logs = { info: [], warn: [], error: [] };
  const run = runImpl ?? (async (query) => {
    inserts.push(query);
    return { affectedRows: 1 };
  });
  return {
    run,
    utils: { uuid },
    ql: {
      INSERT: {
        into(entityName) {
          const spec = { _type: 'INSERT', entity: entityName, rows: [] };
          return {
            _spec: spec,
            entries(row) { spec.rows.push(row); return this; },
          };
        },
      },
    },
    log(ns) {
      return {
        info: (m) => logs.info.push({ ns, m }),
        warn: (m) => logs.warn.push({ ns, m }),
        error: (m) => logs.error.push({ ns, m }),
        debug: () => {},
      };
    },
    _inserts: inserts,
    _logs: logs,
  };
}

async function flushMicrotasks() { await new Promise((r) => setImmediate(r)); }

function makeSvc(modelId = 'claude-opus-4-7') {
  return new StubProvider('llm', null, { modelId, maxTokens: 500 });
}

// ---- constructor validation --------------------------------------------

test('usageMeteringToCap: rejects a first arg that is not a cds instance', () => {
  assert.throws(() => usageMeteringToCap(null), /@sap\/cds/);
  assert.throws(() => usageMeteringToCap({}), /cds\.run/);
  assert.throws(() => usageMeteringToCap({ run: 'not a function' }), /cds\.run/);
});

// ---- basic persist path ------------------------------------------------

test('usageMeteringToCap: persists a record to the default entity per chat', async () => {
  const cds = makeFakeCds();
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const meter = usageMeteringToCap(cds);
  svc.use(meter);

  svc._nextUsage = { input_tokens: 1000, output_tokens: 500 };
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await flushMicrotasks();

  assert.equal(cds._inserts.length, 1);
  const spec = cds._inserts[0]._spec;
  assert.equal(spec._type, 'INSERT');
  assert.equal(spec.entity, DEFAULT_ENTITY);
  assert.equal(spec.entity, 'saptarishi.llm.usage.LlmUsage');
  const row = spec.rows[0];
  assert.equal(row.ID, 'uuid-fixed');
  assert.equal(row.model, 'claude-opus-4-7');
  assert.equal(row.method, 'chat');
  assert.equal(row.inputTokens, 1000);
  assert.equal(row.outputTokens, 500);
  assert.equal(row.currency, 'USD');
  assert.equal(row.pricingKnown, true);
  assert.ok(Math.abs(row.totalCost - 0.0525) < 1e-9);
});

test('usageMeteringToCap: custom entity name honored', async () => {
  const cds = makeFakeCds();
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds, { entity: 'MyApp.Finance.LlmSpend' });
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  await flushMicrotasks();

  assert.equal(cds._inserts[0]._spec.entity, 'MyApp.Finance.LlmSpend');
});

test('usageMeteringToCap: uses cds.utils.uuid when available', async () => {
  let uuidCalls = 0;
  const cds = makeFakeCds({ uuid: () => `custom-${++uuidCalls}` });
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds);
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'b' }] });
  await flushMicrotasks();

  assert.equal(cds._inserts[0]._spec.rows[0].ID, 'custom-1');
  assert.equal(cds._inserts[1]._spec.rows[0].ID, 'custom-2');
});

test('usageMeteringToCap: falls back to crypto.randomUUID when cds.utils absent', async () => {
  const cds = makeFakeCds();
  delete cds.utils;
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds);
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await flushMicrotasks();

  const id = cds._inserts[0]._spec.rows[0].ID;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ---- INSERT lookup resilience ------------------------------------------

test('usageMeteringToCap: falls back to cds.INSERT when cds.ql absent', async () => {
  const cds = makeFakeCds();
  cds.INSERT = cds.ql.INSERT;   // move it to the top level
  delete cds.ql;
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds);
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await flushMicrotasks();

  assert.equal(cds._inserts.length, 1);
});

test('usageMeteringToCap: falls back to global.INSERT when neither cds.ql nor cds.INSERT present', async () => {
  const cds = makeFakeCds();
  const savedGlobal = global.INSERT;
  global.INSERT = cds.ql.INSERT;
  delete cds.ql;
  try {
    const svc = makeSvc(); await svc.init();
    const meter = usageMeteringToCap(cds);
    svc.use(meter);
    await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
    await flushMicrotasks();
    assert.equal(cds._inserts.length, 1);
  } finally {
    if (savedGlobal === undefined) delete global.INSERT;
    else global.INSERT = savedGlobal;
  }
});

test('usageMeteringToCap: warns to cds.log when INSERT is truly unavailable', async () => {
  const cds = makeFakeCds();
  delete cds.ql;
  delete cds.INSERT;
  const savedGlobal = global.INSERT;
  delete global.INSERT;
  try {
    const svc = makeSvc(); await svc.init();
    const meter = usageMeteringToCap(cds);
    svc.use(meter);
    await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
    await flushMicrotasks();
    assert.equal(cds._inserts.length, 0);
    assert.ok(cds._logs.warn.some(l => /INSERT not available/.test(l.m)));
  } finally {
    if (savedGlobal !== undefined) global.INSERT = savedGlobal;
  }
});

// ---- error handling ----------------------------------------------------

test('usageMeteringToCap: swallows persist errors and logs warn by default', async () => {
  const cds = makeFakeCds({
    runImpl: async () => { throw new Error('duplicate key'); },
  });
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds);
  svc.use(meter);

  // Should NOT throw despite the persist failing.
  const res = await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await flushMicrotasks();
  assert.equal(res.text, 'ok');
  assert.ok(cds._logs.warn.some(l => /persist failed.*duplicate key/.test(l.m)));
});

test('usageMeteringToCap: onError hook receives the error + record', async () => {
  const cds = makeFakeCds({ runImpl: async () => { throw new Error('boom'); } });
  const seen = [];
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds, {
    onError: (err, record) => seen.push({ err: err.message, model: record.model }),
  });
  svc.use(meter);

  svc._nextUsage = { input_tokens: 5, output_tokens: 5 };
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await flushMicrotasks();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].err, 'boom');
  assert.equal(seen[0].model, 'claude-opus-4-7');
  // No warn logged when onError is set
  assert.equal(cds._logs.warn.filter(l => /persist/.test(l.m)).length, 0);
});

test('usageMeteringToCap: onError throwing does not crash the request', async () => {
  const cds = makeFakeCds({ runImpl: async () => { throw new Error('boom'); } });
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds, {
    onError: () => { throw new Error('onError also boom'); },
  });
  svc.use(meter);

  const res = await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.equal(res.text, 'ok');
});

// ---- ignored onRecord + full aggregation still works -------------------

test('usageMeteringToCap: warns if caller passes onRecord (which is ignored)', async () => {
  const cds = makeFakeCds();
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds, {
    onRecord: async () => { /* would-be custom sink */ },
  });
  svc.use(meter);

  assert.ok(cds._logs.warn.some(l => /options\.onRecord is ignored/.test(l.m)));
});

test('usageMeteringToCap: full aggregation surface still works (summary, byTenant, reset)', async () => {
  const cds = makeFakeCds();
  const svc = makeSvc(); await svc.init();
  const meter = usageMeteringToCap(cds, {
    tenantOf: (ctx) => ctx.raw?.tenant ?? null,
  });
  svc.use(meter);

  svc._nextUsage = { input_tokens: 1e6, output_tokens: 0 };
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  await svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'globex' });
  await flushMicrotasks();

  const s = meter.summary();
  assert.equal(s.totalRequests, 2);
  assert.equal(meter.byTenant('acme').requests, 1);
  assert.equal(meter.byTenant('globex').requests, 1);
  // Both persisted as separate rows
  assert.equal(cds._inserts.length, 2);
  // Reset clears in-memory summary but does NOT delete persisted rows
  meter.reset();
  assert.equal(meter.summary().totalRequests, 0);
});

// ---- passes through custom pricing + currency --------------------------

test('usageMeteringToCap: user-supplied pricing + currency are honored end-to-end', async () => {
  const cds = makeFakeCds();
  const svc = makeSvc('contract-model'); await svc.init();
  const meter = usageMeteringToCap(cds, {
    currency: 'EUR',
    pricing: { 'contract-model': { input: 0.001, output: 0.005 } },
  });
  svc.use(meter);

  svc._nextUsage = { input_tokens: 1e6, output_tokens: 1e6 };
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await flushMicrotasks();

  const row = cds._inserts[0]._spec.rows[0];
  assert.equal(row.currency, 'EUR');
  // 1e6/1e6 * 0.001 + 1e6/1e6 * 0.005 = 0.006
  assert.ok(Math.abs(row.totalCost - 0.006) < 1e-9);
});
