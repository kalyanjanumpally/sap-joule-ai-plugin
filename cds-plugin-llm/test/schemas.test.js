const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_schemas__';
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

const schemas = require('../lib/schemas');
const LLMService = require('../lib/LLMService');

// ---- Shape validation ------------------------------------------------

test('schemas: every business-object schema is a valid JSON Schema (object with properties)', () => {
  for (const name of ['Invoice', 'PurchaseOrder', 'SupplierRisk', 'ContractSummary', 'ExpenseReport', 'EmailDraft']) {
    const s = schemas[name];
    assert.equal(s.type, 'object', `${name}: type=object`);
    assert.ok(s.properties, `${name}: has properties`);
    assert.ok(Array.isArray(s.required), `${name}: has required array`);
    assert.equal(s.additionalProperties, false, `${name}: additionalProperties=false`);
    for (const r of s.required) {
      assert.ok(s.properties[r], `${name}: required field '${r}' must be defined in properties`);
    }
  }
});

test('schemas: sub-schemas (LineItem, IsoDate, CurrencyCode) are exported', () => {
  assert.equal(schemas.LineItem.type, 'object');
  assert.equal(schemas.IsoDate.type, 'string');
  assert.equal(schemas.CurrencyCode.type, 'string');
});

// ---- Registry --------------------------------------------------------

test('schemas.list() enumerates every business-object schema', () => {
  const names = schemas.list();
  assert.deepEqual(names.sort(), ['ContractSummary', 'EmailDraft', 'ExpenseReport', 'Invoice', 'PurchaseOrder', 'SupplierRisk']);
});

test('schemas.byName() returns the schema or undefined for unknown names', () => {
  assert.equal(schemas.byName('Invoice'), schemas.Invoice);
  assert.equal(schemas.byName('DoesNotExist'), undefined);
});

// ---- extend() --------------------------------------------------------

test('schemas.extend: merges properties and required non-mutatively', () => {
  const custom = schemas.extend(schemas.Invoice, {
    properties: { glAccount: { type: 'string' }, costCenter: { type: 'string' } },
    required:   ['glAccount'],
  });
  assert.ok(custom.properties.glAccount);
  assert.ok(custom.properties.costCenter);
  assert.ok(custom.required.includes('glAccount'));
  assert.ok(custom.required.includes('vendor'), 'existing required preserved');
  // Base unchanged
  assert.equal(schemas.Invoice.properties.glAccount, undefined, 'base schema must NOT be mutated');
});

test('schemas.extend: de-duplicates required entries', () => {
  const custom = schemas.extend(schemas.Invoice, { required: ['vendor', 'total'] });
  const uniq = Array.from(new Set(custom.required));
  assert.deepEqual(custom.required.sort(), uniq.sort());
});

test('schemas.extend: rejects non-object base', () => {
  assert.throws(() => schemas.extend(schemas.IsoDate, { properties: { x: {} } }), /must be an object schema/);
  assert.throws(() => schemas.extend(null, {}), /must be an object schema/);
});

// ---- Integration with chat() -----------------------------------------

// Stub provider that echoes back structured data — proves the plugin
// accepts our schemas as `format` without complaint.
class Stub extends LLMService {
  async init() { await super.init(); this.lastRequest = null; }
  async _chat(params) {
    this.lastRequest = params;
    return {
      text: '{"vendor":"Acme","currency":"EUR","total":100,"lineItems":[]}',
      data: { vendor: 'Acme', currency: 'EUR', total: 100, lineItems: [] },
      model: params.model,
      usage: { input_tokens: 5, output_tokens: 10 },
      stopReason: 'end_turn',
    };
  }
}

test('schemas.Invoice: usable as chat({ format }) argument', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 500 });
  await svc.init();
  const res = await svc.chat({
    messages: [{ role: 'user', content: 'extract this invoice' }],
    format: schemas.Invoice,
  });
  assert.equal(res.data.vendor, 'Acme');
  assert.equal(svc.lastRequest.format, schemas.Invoice, 'format param reaches the provider unchanged');
});

test('schemas.extend result is usable as chat({ format }) argument', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 500 });
  await svc.init();
  const custom = schemas.extend(schemas.Invoice, {
    properties: { glAccount: { type: 'string' } },
    required:   ['glAccount'],
  });
  await svc.chat({
    messages: [{ role: 'user', content: 'x' }],
    format: custom,
  });
  assert.ok(svc.lastRequest.format.properties.glAccount);
  assert.ok(svc.lastRequest.format.required.includes('glAccount'));
});

// ---- SupplierRisk shape sanity ---------------------------------------

test('schemas.SupplierRisk: risk enum is strict, factors is an array of objects', () => {
  const s = schemas.SupplierRisk;
  assert.deepEqual(s.properties.risk.enum, ['low', 'medium', 'high']);
  assert.equal(s.properties.factors.type, 'array');
  assert.equal(s.properties.factors.items.type, 'object');
  assert.deepEqual(s.properties.factors.items.properties.impact.enum, ['increases', 'decreases', 'neutral']);
});

// ---- ContractSummary obligations shape -------------------------------

test('schemas.ContractSummary: obligations items require party + obligation', () => {
  const s = schemas.ContractSummary;
  const obl = s.properties.obligations.items;
  assert.ok(obl.required.includes('party'));
  assert.ok(obl.required.includes('obligation'));
  assert.equal(obl.additionalProperties, false);
});

// ---- ExpenseReport line-item categories ------------------------------

test('schemas.ExpenseReport: line item requires date/category/amount', () => {
  const s = schemas.ExpenseReport;
  const li = s.properties.lineItems.items;
  assert.deepEqual(li.required.sort(), ['amount', 'category', 'date']);
});

// ---- EmailDraft tone enum -------------------------------------------

test('schemas.EmailDraft: tone enum is bounded', () => {
  assert.deepEqual(schemas.EmailDraft.properties.tone.enum, ['formal', 'neutral', 'friendly', 'urgent']);
});

// ---- LineItem reuse --------------------------------------------------

test('schemas.LineItem: shared between Invoice and PurchaseOrder', () => {
  assert.equal(schemas.Invoice.properties.lineItems.items,        schemas.LineItem);
  assert.equal(schemas.PurchaseOrder.properties.lineItems.items,  schemas.LineItem);
});
