const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pvp__';
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

const {
  promptVersionPin,
  PromptVersionRegistry,
} = require('../lib/middleware/promptVersionPin');

// ---- PromptVersionRegistry ------------------------------------------

test('PromptVersionRegistry: register + getVersion round trip', () => {
  const r = new PromptVersionRegistry();
  const t1 = () => ({ tag: 'v1' });
  r.register('summarize', 1, t1);
  assert.equal(r.getVersion('summarize', 1), t1);
  assert.equal(r.getVersion('summarize', '1'), t1);   // string equivalence
});

test('PromptVersionRegistry: multiple versions coexist', () => {
  const r = new PromptVersionRegistry();
  const t1 = () => ({ tag: 'v1' });
  const t2 = () => ({ tag: 'v2' });
  r.register('summarize', 1, t1);
  r.register('summarize', 2, t2);
  assert.equal(r.getVersion('summarize', 1), t1);
  assert.equal(r.getVersion('summarize', 2), t2);
  assert.deepEqual(r.listVersions('summarize'), ['1', '2']);
});

test('PromptVersionRegistry: latestVersion tracks most recent register', () => {
  const r = new PromptVersionRegistry();
  r.register('summarize', 1, () => ({}));
  r.register('summarize', 2, () => ({}));
  assert.equal(r.latestVersion('summarize'), '2');
});

test('PromptVersionRegistry: setLatest overrides insertion order', () => {
  const r = new PromptVersionRegistry();
  r.register('summarize', 1, () => ({}));
  r.register('summarize', 2, () => ({}));
  r.setLatest('summarize', 1);
  assert.equal(r.latestVersion('summarize'), '1');
});

test('PromptVersionRegistry: setLatest throws for unknown version', () => {
  const r = new PromptVersionRegistry();
  r.register('summarize', 1, () => ({}));
  assert.throws(() => r.setLatest('summarize', 99), /unknown version/);
});

test('PromptVersionRegistry: getLatest returns latest template', () => {
  const r = new PromptVersionRegistry();
  const t2 = () => ({ tag: 'v2' });
  r.register('summarize', 1, () => ({}));
  r.register('summarize', 2, t2);
  assert.equal(r.getLatest('summarize'), t2);
});

test('PromptVersionRegistry: unknown template → null', () => {
  const r = new PromptVersionRegistry();
  assert.equal(r.getVersion('nope', 1), null);
  assert.equal(r.latestVersion('nope'), null);
  assert.deepEqual(r.listVersions('nope'), []);
});

test('PromptVersionRegistry: register throws on invalid inputs', () => {
  const r = new PromptVersionRegistry();
  assert.throws(() => r.register('', 1, () => ({})), /name/);
  assert.throws(() => r.register('n', null, () => ({})), /version/);
  assert.throws(() => r.register('n', 1, null), /template/);
});

test('PromptVersionRegistry: snapshot shape', () => {
  const r = new PromptVersionRegistry();
  r.register('summarize', 1, () => ({}));
  r.register('summarize', 2, () => ({}));
  r.register('classify', 1, () => ({}));
  const s = r.snapshot();
  assert.deepEqual(s.summarize.versions, ['1', '2']);
  assert.equal(s.summarize.latest, '2');
  assert.deepEqual(s.classify.versions, ['1']);
});

// ---- Middleware: validation ---------------------------------

test('promptVersionPin: throws without resolveTemplate', () => {
  assert.throws(() => promptVersionPin({}), /resolveTemplate/);
});
test('promptVersionPin: throws without latestVersionOf', () => {
  assert.throws(() => promptVersionPin({ resolveTemplate: () => null }), /latestVersionOf/);
});
test('promptVersionPin: throws without templateRefOf', () => {
  assert.throws(() => promptVersionPin({
    resolveTemplate: () => null, latestVersionOf: () => null,
  }), /templateRefOf/);
});
test('promptVersionPin: throws without applyTemplate', () => {
  assert.throws(() => promptVersionPin({
    resolveTemplate: () => null, latestVersionOf: () => null,
    templateRefOf: () => null,
  }), /applyTemplate/);
});
test('promptVersionPin: throws on non-function pinFor', () => {
  assert.throws(() => promptVersionPin({
    resolveTemplate: () => null, latestVersionOf: () => null,
    templateRefOf: () => null, applyTemplate: () => ({}), pinFor: 'x',
  }), /pinFor/);
});
test('promptVersionPin: throws on non-string metaField', () => {
  assert.throws(() => promptVersionPin({
    resolveTemplate: () => null, latestVersionOf: () => null,
    templateRefOf: () => null, applyTemplate: () => ({}), metaField: 42,
  }), /metaField/);
});
test('promptVersionPin: throws on non-function callback', () => {
  assert.throws(() => promptVersionPin({
    resolveTemplate: () => null, latestVersionOf: () => null,
    templateRefOf: () => null, applyTemplate: () => ({}), onPin: 'x',
  }), /callbacks/);
});

// ---- Passthrough when no templateRef ------------------

test('promptVersionPin: no templateRef → passthrough', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { messages: [{ role: 'user', content: 'hi' }] } };
  const r = await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(mw.stats.passthroughs, 1);
});

// ---- Explicit version --------------------

test('promptVersionPin: templateRef.version → uses explicit version', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({ system: 'V1' }));
  registry.register('summarize', 2, () => ({ system: 'V2' }));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { templateRef: { name: 'summarize', version: 1 } } };
  let seenSystem;
  await mw(ctx, async () => { seenSystem = ctx.request.system; return {}; });
  assert.equal(seenSystem, 'V1');
  assert.equal(mw.stats.explicit, 1);
});

// ---- Latest fallback ------------------

test('promptVersionPin: no version + no pin → uses latest', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({ system: 'V1' }));
  registry.register('summarize', 2, () => ({ system: 'V2' }));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  let seenSystem;
  await mw(ctx, async () => { seenSystem = ctx.request.system; return {}; });
  assert.equal(seenSystem, 'V2');
  assert.equal(mw.stats.latestFallback, 1);
});

// ---- Pin override --------------

test('promptVersionPin: pinFor overrides templateRef.version', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({ system: 'V1' }));
  registry.register('summarize', 2, () => ({ system: 'V2' }));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    pinFor:          (ctx, name) => name === 'summarize' ? 1 : null,   // pin to v1
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { templateRef: { name: 'summarize', version: 2 } } };
  let seenSystem;
  await mw(ctx, async () => { seenSystem = ctx.request.system; return {}; });
  assert.equal(seenSystem, 'V1');
  assert.equal(mw.stats.pinned, 1);
  assert.equal(mw.stats.explicit, 0);
});

test('promptVersionPin: pinFor returning null → falls through to templateRef.version', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 2, () => ({ system: 'V2' }));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    pinFor:          () => null,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { templateRef: { name: 'summarize', version: 2 } } };
  await mw(ctx, async () => ({}));
  assert.equal(mw.stats.explicit, 1);
  assert.equal(mw.stats.pinned, 0);
});

// ---- Audit metadata ------------------

test('promptVersionPin: attaches ctx.meta.promptVersion for audit', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 2, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    pinFor:          () => 2,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  await mw(ctx, async () => ({}));
  assert.deepEqual(ctx.meta.promptVersion, { name: 'summarize', version: '2', source: 'pin' });
});

test('promptVersionPin: custom metaField', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
    metaField: 'templateAudit',
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  await mw(ctx, async () => ({}));
  assert.equal(ctx.meta.promptVersion, undefined);
  assert.ok(ctx.meta.templateAudit);
});

// ---- Restores original request ----------

test('promptVersionPin: restores ctx.request after call', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({ system: 'X' }));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  const original = ctx.request;
  await mw(ctx, async () => ({}));
  assert.equal(ctx.request, original);
});

// ---- Missing template ---------

test('promptVersionPin: resolveTemplate returns null → passthrough + onMissing', async () => {
  const missings = [];
  const mw = promptVersionPin({
    resolveTemplate: () => null,
    latestVersionOf: () => 1,
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   () => ({}),
    onMissing:       (i) => missings.push(i),
  });
  const ctx = { request: { templateRef: { name: 'nope' } } };
  await mw(ctx, async () => ({ text: 'unmutated' }));
  assert.equal(mw.stats.missing, 1);
  assert.equal(missings[0].name, 'nope');
});

test('promptVersionPin: latestVersionOf returns null → passthrough + onMissing', async () => {
  const missings = [];
  const mw = promptVersionPin({
    resolveTemplate: () => (() => ({})),
    latestVersionOf: () => null,
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   () => ({}),
    onMissing:       (i) => missings.push(i),
  });
  const ctx = { request: { templateRef: { name: 'nope' } } };
  await mw(ctx, async () => ({}));
  assert.equal(missings.length, 1);
  assert.equal(missings[0].reason, 'no-latest-version');
});

// ---- Error handling --------------

test('promptVersionPin: applyTemplate throws → passthrough + onError', async () => {
  const errors = [];
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   () => { throw new Error('render broke'); },
    onError:         (i) => errors.push(i),
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  await mw(ctx, async () => ({ text: 'raw' }));
  assert.equal(errors[0].phase, 'applyTemplate');
  assert.equal(mw.stats.errors, 1);
});

test('promptVersionPin: applyTemplate returns non-object → passthrough + error', async () => {
  const errors = [];
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   () => 'not-an-object',
    onError:         (i) => errors.push(i),
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  await mw(ctx, async () => ({}));
  assert.equal(errors[0].phase, 'applyTemplate');
});

test('promptVersionPin: pinFor throws → falls through to explicit/latest', async () => {
  const errors = [];
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({ system: 'V1' }));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    pinFor:          () => { throw new Error('bad pin'); },
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
    onError:         (i) => errors.push(i),
  });
  const ctx = { request: { templateRef: { name: 'summarize' } } };
  let seenSystem;
  await mw(ctx, async () => { seenSystem = ctx.request.system; return {}; });
  assert.equal(seenSystem, 'V1');
  assert.equal(errors[0].phase, 'pinFor');
});

// ---- Callbacks -----------

test('promptVersionPin: onPin fires for pinned resolution', async () => {
  const events = [];
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    pinFor:          () => 1,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
    onPin:           (i) => events.push(i),
  });
  await mw({ request: { templateRef: { name: 'summarize' } } }, async () => ({}));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'pin');
});

test('promptVersionPin: onUnpinned fires for latest / explicit resolution', async () => {
  const events = [];
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
    onUnpinned:      (i) => events.push(i),
  });
  await mw({ request: { templateRef: { name: 'summarize' } } }, async () => ({}));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'latest');
});

test('promptVersionPin: callback throws swallowed', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
    onPin:      () => { throw new Error('x'); },
    onUnpinned: () => { throw new Error('x'); },
  });
  await mw({ request: { templateRef: { name: 'summarize' } } }, async () => ({}));
});

// ---- Stats + MCP + reset -----------

test('promptVersionPin: byTemplate counts per version', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  registry.register('summarize', 2, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  await mw({ request: { templateRef: { name: 'summarize', version: 1 } } }, async () => ({}));
  await mw({ request: { templateRef: { name: 'summarize', version: 1 } } }, async () => ({}));
  await mw({ request: { templateRef: { name: 'summarize', version: 2 } } }, async () => ({}));
  assert.deepEqual(mw.stats.byTemplate.summarize, { '1': 2, '2': 1 });
});

test('promptVersionPin: pinRate computes correctly', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    pinFor:          (ctx) => ctx.request.pinTo ?? null,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  await mw({ request: { templateRef: { name: 'summarize' }, pinTo: 1 } }, async () => ({}));
  await mw({ request: { templateRef: { name: 'summarize' } } }, async () => ({}));
  assert.equal(mw.pinRate(), 0.5);
});

test('promptVersionPin: reset clears counters', async () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  await mw({ request: { templateRef: { name: 'summarize' } } }, async () => ({}));
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.stats.byTemplate.summarize, undefined);
});

test('promptVersionPin: asMcpResource', () => {
  const registry = new PromptVersionRegistry();
  registry.register('summarize', 1, () => ({}));
  const mw = promptVersionPin({
    resolveTemplate: (n, v) => registry.getVersion(n, v),
    latestVersionOf: (n) => registry.latestVersion(n),
    templateRefOf:   (ctx) => ctx.request.templateRef,
    applyTemplate:   (req, tpl) => ({ ...req, ...tpl() }),
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://prompt-version-pin');
  const p = r.handler();
  assert.equal(p.metaField, 'promptVersion');
  assert.equal(p.pinRate, 0);
});
