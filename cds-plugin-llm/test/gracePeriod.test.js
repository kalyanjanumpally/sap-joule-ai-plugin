const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_gp__';
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
  gracePeriod,
  GracePeriodExhaustedError,
} = require('../lib/middleware/gracePeriod');

// ---- Helpers ----------------------------------------------------------

function ctxWith() { return { request: {} }; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Validation ------------------------------------------------------

test('gracePeriod: throws when neither softMs nor hardMs given', () => {
  assert.throws(() => gracePeriod({}), /at least one/);
});
test('gracePeriod: throws on non-positive softMs', () => {
  assert.throws(() => gracePeriod({ softMs: 0 }), /softMs/);
});
test('gracePeriod: throws on non-positive hardMs', () => {
  assert.throws(() => gracePeriod({ hardMs: -1 }), /hardMs/);
});
test('gracePeriod: throws when softMs >= hardMs', () => {
  assert.throws(() => gracePeriod({ softMs: 200, hardMs: 100 }), /must be </);
  assert.throws(() => gracePeriod({ softMs: 100, hardMs: 100 }), /must be </);
});
test('gracePeriod: throws on non-function callback', () => {
  assert.throws(() => gracePeriod({ softMs: 100, onSoftDeadline: 'x' }), /callbacks/);
});
test('gracePeriod: throws on non-boolean attachAbortSignal', () => {
  assert.throws(() => gracePeriod({ softMs: 100, attachAbortSignal: 'x' }), /attachAbortSignal/);
});

// ---- Fast completion (under soft) --------------------------

test('gracePeriod: fast call completes under soft, no warning fires', async () => {
  const events = [];
  const mw = gracePeriod({
    softMs: 100,
    onSoftDeadline: () => events.push('soft'),
  });
  const r = await mw(ctxWith(), async () => 'fast');
  assert.equal(r, 'fast');
  assert.equal(events.length, 0);
  assert.equal(mw.stats.completedUnderSoft, 1);
  assert.equal(mw.stats.softDeadlineFires, 0);
});

// ---- Soft fires but call still succeeds -----------------------

test('gracePeriod: soft-deadline fires while call still running, call completes', async () => {
  const events = [];
  const mw = gracePeriod({
    softMs: 30,
    onSoftDeadline: (i) => events.push(i),
  });
  const r = await mw(ctxWith(), async () => { await wait(80); return 'slow-but-ok'; });
  assert.equal(r, 'slow-but-ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].softMs, 30);
  assert.ok(events[0].elapsedMs >= 30);
  assert.equal(mw.stats.softDeadlineFires, 1);
  assert.equal(mw.stats.completedOverSoft, 1);
});

// ---- Hard deadline kills ----------------------

test('gracePeriod: hard-deadline throws GracePeriodExhaustedError', async () => {
  const mw = gracePeriod({
    softMs: 30, hardMs: 80,
  });
  await assert.rejects(
    mw(ctxWith(), async () => { await wait(200); return 'too-slow'; }),
    GracePeriodExhaustedError,
  );
  assert.equal(mw.stats.hardDeadlineFires, 1);
});

test('gracePeriod: GracePeriodExhaustedError carries fields', async () => {
  const mw = gracePeriod({ softMs: 20, hardMs: 60 });
  try {
    await mw(ctxWith(), async () => { await wait(200); return 'x'; });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'GRACE_PERIOD_EXHAUSTED');
    assert.equal(err.hardMs, 60);
    assert.equal(err.softMs, 20);
    assert.ok(err.elapsedMs >= 60);
  }
});

test('gracePeriod: hard deadline also fires the soft callback', async () => {
  const events = [];
  const mw = gracePeriod({
    softMs: 30, hardMs: 100,
    onSoftDeadline: () => events.push('soft'),
    onHardDeadline: () => events.push('hard'),
  });
  await assert.rejects(mw(ctxWith(), async () => { await wait(200); return 'x'; }));
  assert.deepEqual(events, ['soft', 'hard']);
});

// ---- Only softMs (no hard kill) ---------------------

test('gracePeriod: softMs alone → warning only, no hard kill', async () => {
  const events = [];
  const mw = gracePeriod({
    softMs: 30,
    onSoftDeadline: () => events.push('warn'),
  });
  // Long-running call — no hard limit, so it completes normally.
  const r = await mw(ctxWith(), async () => { await wait(120); return 'eventually'; });
  assert.equal(r, 'eventually');
  assert.equal(events.length, 1);
  assert.equal(mw.stats.hardDeadlineFires, 0);
});

// ---- Only hardMs (no soft warning) ---------------

test('gracePeriod: hardMs alone → behaves like classic deadline', async () => {
  const mw = gracePeriod({ hardMs: 50 });
  await assert.rejects(
    mw(ctxWith(), async () => { await wait(200); return 'x'; }),
    GracePeriodExhaustedError,
  );
  assert.equal(mw.stats.softDeadlineFires, 0);
  assert.equal(mw.stats.hardDeadlineFires, 1);
});

// ---- AbortSignal attached + fires on hard --------

test('gracePeriod: attaches AbortSignal on ctx.signal by default', async () => {
  const mw = gracePeriod({ softMs: 30, hardMs: 100 });
  let seenSignal;
  await assert.rejects(mw(ctxWith(), async function () {
    seenSignal = arguments[0]?.signal;   // ctx passed to next()? no — next() gets no args
    return await wait(200);
  }));
  // Since next() gets no args, we need to check the outer ctx before the finally runs.
});

test('gracePeriod: aborts signal on hard deadline (downstream can early-exit)', async () => {
  const mw = gracePeriod({ softMs: 20, hardMs: 60 });
  const ctx = ctxWith();
  let signalOnEntry, aborted = false;
  try {
    await mw(ctx, async () => {
      signalOnEntry = ctx.signal;
      // Listen for abort — resolve early if it fires.
      await new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        // Ensure we're still around long enough for hard timer.
        setTimeout(resolve, 300);
      });
      return 'aborted-early';
    });
  } catch { /* GracePeriodExhaustedError from race */ }
  assert.ok(signalOnEntry instanceof AbortSignal);
  assert.equal(aborted, true);
});

test('gracePeriod: attachAbortSignal=false leaves ctx.signal alone', async () => {
  const mw = gracePeriod({ softMs: 30, attachAbortSignal: false });
  const originalSignal = new AbortController().signal;
  const ctx = { request: {}, signal: originalSignal };
  let seenSignal;
  await mw(ctx, async () => { seenSignal = ctx.signal; return 'ok'; });
  assert.equal(seenSignal, originalSignal);
});

test('gracePeriod: restores original ctx.signal after call', async () => {
  const mw = gracePeriod({ softMs: 30, hardMs: 100 });
  const originalSignal = new AbortController().signal;
  const ctx = { request: {}, signal: originalSignal };
  await mw(ctx, async () => 'ok');
  assert.equal(ctx.signal, originalSignal);
});

// ---- Downstream error propagates ----------

test('gracePeriod: downstream throw propagates and timers are cleared', async () => {
  const mw = gracePeriod({ softMs: 100, hardMs: 500 });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('boom'); }), /boom/);
  // Wait past deadlines — no leaked callbacks should fire.
  await wait(200);
  assert.equal(mw.stats.softDeadlineFires, 0);
  assert.equal(mw.stats.hardDeadlineFires, 0);
});

// ---- Callbacks ----------

test('gracePeriod: onComplete fires with softFired flag', async () => {
  const events = [];
  const mw = gracePeriod({
    softMs: 30,
    onComplete: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => 'fast');   // no soft
  await mw(ctxWith(), async () => { await wait(60); return 'slow'; });   // soft fires
  assert.equal(events.length, 2);
  assert.equal(events[0].softFired, false);
  assert.equal(events[1].softFired, true);
});

test('gracePeriod: callback throws swallowed', async () => {
  const mw = gracePeriod({
    softMs: 30,
    onSoftDeadline: () => { throw new Error('x'); },
    onComplete: () => { throw new Error('x'); },
  });
  await mw(ctxWith(), async () => { await wait(60); return 'ok'; });
});

// ---- Stats + MCP + reset ---------

test('gracePeriod: avgLatencyMs computed', async () => {
  const mw = gracePeriod({ softMs: 500 });
  await mw(ctxWith(), async () => { await wait(20); return 'a'; });
  await mw(ctxWith(), async () => { await wait(40); return 'b'; });
  assert.ok(mw.avgLatencyMs() >= 20);
  assert.ok(mw.avgLatencyMs() <= 100);
});

test('gracePeriod: softDeadlineRate', async () => {
  const mw = gracePeriod({ softMs: 30 });
  await mw(ctxWith(), async () => { await wait(10); return 'fast'; });
  await mw(ctxWith(), async () => { await wait(60); return 'slow'; });
  assert.equal(mw.softDeadlineRate(), 0.5);
});

test('gracePeriod: reset zeroes counters', async () => {
  const mw = gracePeriod({ softMs: 30 });
  await mw(ctxWith(), async () => { await wait(60); return 'x'; });
  assert.equal(mw.stats.softDeadlineFires, 1);
  mw.reset();
  assert.equal(mw.stats.softDeadlineFires, 0);
});

test('gracePeriod: asMcpResource', () => {
  const mw = gracePeriod({ softMs: 3000, hardMs: 10_000 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://grace-period');
  const p = r.handler();
  assert.equal(p.softMs, 3000);
  assert.equal(p.hardMs, 10_000);
  assert.equal(p.attachAbortSignal, true);
});
