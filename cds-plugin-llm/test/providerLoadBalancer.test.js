const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_plb__';
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
  providerLoadBalancer,
  AllCredentialsUnhealthyError,
  STRATEGIES,
} = require('../lib/middleware/providerLoadBalancer');

// ---- Helpers ----------------------------------------------------------

function makeCreds() {
  return [
    { name: 'a', apiKey: 'AAA' },
    { name: 'b', apiKey: 'BBB' },
    { name: 'c', apiKey: 'CCC' },
  ];
}

function apply(request, cred) {
  return { ...request, credentials: { apiKey: cred.apiKey }, __credName: cred.name };
}

function ctxWith(request = {}) { return { request }; }

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---- STRATEGIES export ----------------------------------------

test('STRATEGIES is frozen and complete', () => {
  assert.ok(Object.isFrozen(STRATEGIES));
  assert.deepEqual([...STRATEGIES].sort(), ['least-loaded', 'round-robin', 'sticky', 'weighted-random']);
});

// ---- Validation -----------------------------------------------

test('providerLoadBalancer: throws on empty credentials', () => {
  assert.throws(() => providerLoadBalancer({ credentials: [], applyCredential: apply }), /non-empty/);
});
test('providerLoadBalancer: throws on credential without name', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: [{ apiKey: 'x' }], applyCredential: apply,
  }), /name: string/);
});
test('providerLoadBalancer: throws on invalid weight', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: [{ name: 'a', weight: 0 }, { name: 'b' }], applyCredential: apply,
  }), /weight/);
});
test('providerLoadBalancer: throws on unknown strategy', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: makeCreds(), strategy: 'bogus', applyCredential: apply,
  }), /strategy must be one of/);
});
test('providerLoadBalancer: throws without applyCredential', () => {
  assert.throws(() => providerLoadBalancer({ credentials: makeCreds() }), /applyCredential/);
});
test('providerLoadBalancer: sticky strategy requires stickyKeyOf', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: makeCreds(), strategy: 'sticky', applyCredential: apply,
  }), /stickyKeyOf/);
});
test('providerLoadBalancer: throws on invalid unhealthyThreshold', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply, unhealthyThreshold: 0,
  }), /unhealthyThreshold/);
});
test('providerLoadBalancer: throws on tiny unhealthyCooldownMs', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply, unhealthyCooldownMs: 50,
  }), /unhealthyCooldownMs/);
});
test('providerLoadBalancer: throws on non-function callback', () => {
  assert.throws(() => providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply, onSelect: 'x',
  }), /callbacks/);
});

// ---- Round-robin --------------------------------------------

test('providerLoadBalancer: round-robin cycles through credentials', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), strategy: 'round-robin', applyCredential: apply,
  });
  const picked = [];
  for (let i = 0; i < 7; i++) {
    const ctx = ctxWith();
    await mw(ctx, async () => { picked.push(ctx.request.__credName); });
  }
  assert.deepEqual(picked, ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
});

// ---- Least-loaded --------------------------------------------

test('providerLoadBalancer: least-loaded picks credential with fewest in-flight', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), strategy: 'least-loaded', applyCredential: apply,
  });
  const gates = [deferred(), deferred(), deferred()];
  const promises = [];
  // Fire 3 in parallel; each blocks on its own gate.
  for (let i = 0; i < 3; i++) {
    const ctx = ctxWith();
    promises.push(mw(ctx, async () => {
      await gates[i].promise;
      return ctx.request.__credName;
    }));
  }
  await new Promise((r) => setImmediate(r));
  const snap = mw.snapshotCredentials();
  // Each credential should have 1 in-flight.
  assert.equal(snap[0].inFlight, 1);
  assert.equal(snap[1].inFlight, 1);
  assert.equal(snap[2].inFlight, 1);
  gates.forEach((g) => g.resolve());
  await Promise.all(promises);
});

test('providerLoadBalancer: least-loaded prefers idle credential', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), strategy: 'least-loaded', applyCredential: apply,
  });
  const gate = deferred();
  // Load up credential 'a' with a hanging call.
  const holderP = mw(ctxWith(), async () => { await gate.promise; return 'a-held'; });
  await new Promise((r) => setImmediate(r));
  // Next call should NOT pick 'a' (it has inFlight=1); picks b or c.
  const ctx = ctxWith();
  let seenCred;
  await mw(ctx, async () => { seenCred = ctx.request.__credName; });
  assert.notEqual(seenCred, 'a');
  gate.resolve();
  await holderP;
});

// ---- Weighted-random -----------------------------------------

test('providerLoadBalancer: weighted-random honors weights', async () => {
  const creds = [
    { name: 'heavy', weight: 9 },
    { name: 'light', weight: 1 },
  ];
  // Deterministic table-based PRNG. Values 0.05, 0.15, ..., 0.95.
  // With total=10, r values are 0.5, 1.5, ..., 9.5. Nine land in
  // heavy (r-9 ≤ 0), one lands in light (r=9.5 → r-9=0.5 → r-1=-0.5).
  const seq = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  let idx = 0;
  const random = () => seq[idx++ % seq.length];
  const mw = providerLoadBalancer({
    credentials: creds, strategy: 'weighted-random',
    applyCredential: apply, random,
  });
  const picked = [];
  for (let i = 0; i < 100; i++) {
    const ctx = ctxWith();
    // Capture INSIDE the downstream — mw restores ctx.request on exit.
    await mw(ctx, async () => { picked.push(ctx.request.__credName); });
  }
  const heavy = picked.filter((n) => n === 'heavy').length;
  const light = picked.filter((n) => n === 'light').length;
  // 9 heavy + 1 light per PRNG cycle of 10 → 90 + 10 over 100 calls.
  assert.equal(heavy, 90);
  assert.equal(light, 10);
});

// ---- Sticky ---------------------------------------------------

test('providerLoadBalancer: sticky routes same key to same credential', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(),
    strategy: 'sticky',
    stickyKeyOf: (ctx) => ctx.request.tenantId,
    applyCredential: apply,
  });
  const firstPicked = [];
  for (const tenant of ['t1', 't2', 't3', 't1', 't2', 't3']) {
    const ctx = ctxWith({ tenantId: tenant });
    let seenCred;
    await mw(ctx, async () => { seenCred = ctx.request.__credName; });
    firstPicked.push({ tenant, cred: seenCred });
  }
  // Same tenant should always land on the same credential.
  assert.equal(firstPicked[0].cred, firstPicked[3].cred);
  assert.equal(firstPicked[1].cred, firstPicked[4].cred);
  assert.equal(firstPicked[2].cred, firstPicked[5].cred);
  // And they must actually be defined.
  assert.ok(firstPicked[0].cred);
});

// ---- Health tracking ------------------------------------------

test('providerLoadBalancer: N consecutive errors mark credential unhealthy', async () => {
  const mw = providerLoadBalancer({
    credentials: [{ name: 'a' }, { name: 'b' }],
    strategy: 'round-robin', applyCredential: apply,
    unhealthyThreshold: 2,
  });
  // Call twice against 'a' (first two round-robin picks are a, b).
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));   // a errors
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));   // b errors
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));   // a errors (2nd)
  const snap = mw.snapshotCredentials();
  const a = snap.find((s) => s.name === 'a');
  assert.equal(a.healthy, false);
  assert.ok(a.unhealthySince != null);
});

test('providerLoadBalancer: unhealthy credential skipped in round-robin', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(),
    strategy: 'round-robin', applyCredential: apply,
    unhealthyThreshold: 1,
  });
  // First pick 'a', it fails → unhealthy.
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  // Next picks should skip 'a'.
  const picked = [];
  for (let i = 0; i < 5; i++) {
    const ctx = ctxWith();
    await mw(ctx, async () => { picked.push(ctx.request.__credName); });
  }
  assert.ok(!picked.includes('a'));
  assert.ok(picked.every((p) => p === 'b' || p === 'c'));
});

test('providerLoadBalancer: unhealthy recovers after cooldown', async () => {
  let t = 1000;
  const mw = providerLoadBalancer({
    credentials: makeCreds(),
    strategy: 'round-robin', applyCredential: apply,
    unhealthyThreshold: 1, unhealthyCooldownMs: 500,
    now: () => t,
  });
  // 'a' fails → unhealthy at t=1000.
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  let snap = mw.snapshotCredentials();
  assert.equal(snap.find((s) => s.name === 'a').healthy, false);
  // Advance past cooldown.
  t = 2000;
  // Next call triggers cool-down check; 'a' should be healthy again.
  const ctx = ctxWith();
  await mw(ctx, async () => {});
  snap = mw.snapshotCredentials();
  assert.equal(snap.find((s) => s.name === 'a').healthy, true);
});

test('providerLoadBalancer: all unhealthy → AllCredentialsUnhealthyError', async () => {
  const mw = providerLoadBalancer({
    credentials: [{ name: 'a' }, { name: 'b' }],
    strategy: 'round-robin', applyCredential: apply,
    unhealthyThreshold: 1,
  });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  await assert.rejects(mw(ctxWith(), async () => 'ok'), AllCredentialsUnhealthyError);
  assert.equal(mw.stats.unhealthyAtSelect, 1);
});

test('providerLoadBalancer: markUnhealthy + markHealthy work manually', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), strategy: 'round-robin',
    applyCredential: apply, unhealthyThreshold: 100,   // never auto-trip
  });
  assert.equal(mw.markUnhealthy('a'), true);
  const snap = mw.snapshotCredentials();
  assert.equal(snap.find((s) => s.name === 'a').healthy, false);
  assert.equal(mw.markHealthy('a'), true);
  const snap2 = mw.snapshotCredentials();
  assert.equal(snap2.find((s) => s.name === 'a').healthy, true);
});

test('providerLoadBalancer: onHealthChange fires', async () => {
  const events = [];
  const mw = providerLoadBalancer({
    credentials: makeCreds(),
    applyCredential: apply, unhealthyThreshold: 1,
    onHealthChange: (i) => events.push(i),
  });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  assert.equal(events.length, 1);
  assert.equal(events[0].credential, 'a');
  assert.equal(events[0].healthy, false);
});

// ---- Success resets consecutive errors --------------------------

test('providerLoadBalancer: success resets consecutiveErrors', async () => {
  const mw = providerLoadBalancer({
    credentials: [{ name: 'a' }, { name: 'b' }],
    strategy: 'round-robin', applyCredential: apply,
    unhealthyThreshold: 3,
  });
  // a fails, b fails, a fails.
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  let snap = mw.snapshotCredentials();
  const aBefore = snap.find((s) => s.name === 'a').consecutiveErrors;
  assert.equal(aBefore, 2);
  // Now succeed on a.
  await mw(ctxWith(), async () => 'ok');
  await mw(ctxWith(), async () => 'ok');
  snap = mw.snapshotCredentials();
  assert.equal(snap.find((s) => s.name === 'a').consecutiveErrors, 0);
});

// ---- Callbacks + stats -----------------------------------

test('providerLoadBalancer: onSelect fires with credential + strategy', async () => {
  const events = [];
  const mw = providerLoadBalancer({
    credentials: makeCreds(), strategy: 'round-robin', applyCredential: apply,
    onSelect: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => {});
  assert.equal(events.length, 1);
  assert.equal(events[0].credential, 'a');
  assert.equal(events[0].strategy, 'round-robin');
});

test('providerLoadBalancer: onCredentialError fires with error', async () => {
  const events = [];
  const mw = providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply,
    onCredentialError: (i) => events.push(i),
  });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('boom'); }));
  assert.equal(events.length, 1);
  assert.equal(events[0].credential, 'a');
});

test('providerLoadBalancer: callback throws swallowed', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply,
    onSelect: () => { throw new Error('x'); },
  });
  await mw(ctxWith(), async () => 'ok');   // shouldn't crash
});

// ---- Restore ctx.request -----------------------------

test('providerLoadBalancer: restores ctx.request after call', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply,
  });
  const ctx = ctxWith({ prompt: 'x' });
  const original = ctx.request;
  await mw(ctx, async () => 'ok');
  assert.equal(ctx.request, original);
});

// ---- Reset + MCP -----------------------------------

test('providerLoadBalancer: reset clears counters + re-heals', async () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), applyCredential: apply,
    unhealthyThreshold: 1,
  });
  await mw(ctxWith(), async () => 'ok');
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  const snap = mw.snapshotCredentials();
  for (const s of snap) assert.equal(s.healthy, true);
});

test('providerLoadBalancer: asMcpResource', () => {
  const mw = providerLoadBalancer({
    credentials: makeCreds(), strategy: 'least-loaded',
    applyCredential: apply, unhealthyThreshold: 3, unhealthyCooldownMs: 10_000,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://provider-load-balancer');
  const p = r.handler();
  assert.equal(p.strategy, 'least-loaded');
  assert.equal(p.credentialCount, 3);
  assert.equal(p.unhealthyThreshold, 3);
  assert.equal(p.unhealthyCooldownMs, 10_000);
  assert.equal(p.credentials.length, 3);
  assert.equal(p.credentials[0].name, 'a');
});
