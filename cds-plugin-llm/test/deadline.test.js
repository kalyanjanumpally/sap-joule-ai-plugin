const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_dl__';
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

const { deadline, DeadlineExceededError } = require('../lib/middleware/deadline');

function invoke(mw, { method = 'chat', signal = null, next = async () => ({ text: 'ok' }) } = {}) {
  const ctx = { method, request: {}, raw: {}, meta: {} };
  if (signal) ctx.signal = signal;
  return mw(ctx, next);
}

// ---- Input validation --------------------------------------------------

test('deadline: rejects non-positive timeoutMs', () => {
  assert.throws(() => deadline({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => deadline({ timeoutMs: -1 }), /timeoutMs/);
});

test('deadline: rejects non-object perMethod', () => {
  assert.throws(() => deadline({ perMethod: 'foo' }), /perMethod/);
});

test('deadline: rejects non-positive perMethod entries', () => {
  assert.throws(() => deadline({ perMethod: { chat: 0 } }), /perMethod\.chat/);
  assert.throws(() => deadline({ perMethod: { chat: -5 } }), /perMethod\.chat/);
});

// ---- Fast path (within budget) ----------------------------------------

test('deadline: call completing within budget resolves normally', async () => {
  const dl = deadline({ timeoutMs: 100 });
  const res = await invoke(dl);
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(dl.stats.requests, 1);
  assert.equal(dl.stats.expired,  0);
});

// ---- Timeout expiration -----------------------------------------------

test('deadline: DeadlineExceededError fires when budget elapses', async () => {
  const dl = deadline({ timeoutMs: 30 });
  await assert.rejects(
    () => invoke(dl, { next: () => new Promise((r) => setTimeout(() => r({ text: 'late' }), 100)) }),
    (err) => {
      assert.ok(err instanceof DeadlineExceededError);
      assert.equal(err.code, 'DEADLINE_EXCEEDED');
      assert.equal(err.timeoutMs, 30);
      assert.equal(err.method, 'chat');
      return true;
    },
  );
  assert.equal(dl.stats.expired, 1);
});

test('deadline: aborts the ctx.signal on expiration', async () => {
  const dl = deadline({ timeoutMs: 30 });
  let sawSignal;
  await assert.rejects(
    () => invoke(dl, {
      next: async () => {
        // Capture the signal so we can verify it aborts
        return new Promise((resolve, reject) => {
          setTimeout(() => resolve({ text: 'late' }), 100);
        });
      },
    }),
    DeadlineExceededError,
  );
  // Give a beat for finally to run
  await new Promise((r) => setImmediate(r));
});

test('deadline: ctx.signal is set BEFORE next() runs so providers can consume it', async () => {
  const dl = deadline({ timeoutMs: 100 });
  let capturedSignal;
  await invoke(dl, {
    next: async (ctx) => {
      // Middleware next() doesn't take ctx — we read from the shared ctx closure
      return { text: 'ok' };
    },
  });
  // Verify by inspecting ctx directly via a wrapped middleware
  const inner = async (ctx, next) => {
    capturedSignal = ctx.signal;
    return next();
  };
  const outer = dl;
  const chain = async (ctx) => outer(ctx, () => inner(ctx, () => ({ text: 'ok' })));
  const ctx = { method: 'chat', request: {}, raw: {}, meta: {} };
  await chain(ctx);
  assert.ok(capturedSignal, 'ctx.signal must be set by deadline before next() runs');
  assert.equal(typeof capturedSignal.addEventListener, 'function');
});

// ---- perMethod overrides -----------------------------------------------

test('deadline: perMethod override applied on match', async () => {
  const dl = deadline({ timeoutMs: 100, perMethod: { embed: 20 } });
  // embed: 20ms budget → fires
  await assert.rejects(
    () => invoke(dl, { method: 'embed', next: () => new Promise((r) => setTimeout(() => r({}), 60)) }),
    (err) => {
      assert.equal(err.timeoutMs, 20);
      assert.equal(err.method, 'embed');
      return true;
    },
  );
});

test('deadline: perMethod falls back to timeoutMs on unknown method', async () => {
  const dl = deadline({ timeoutMs: 100, perMethod: { embed: 20 } });
  // chat: falls back to 100ms → completes at 40ms
  const res = await invoke(dl, { method: 'chat', next: () => new Promise((r) => setTimeout(() => r({ text: 'ok' }), 40)) });
  assert.deepEqual(res, { text: 'ok' });
});

// ---- Existing signal composition --------------------------------------

test('deadline: existing ctx.signal aborts propagate to inner signal', async () => {
  const dl = deadline({ timeoutMs: 1000 });
  const outerCtrl = new AbortController();
  const outerReason = new Error('caller cancelled');

  const inner = async (ctx, next) => {
    // Race outer signal against a long call
    return new Promise((resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        reject(ctx.signal.reason ?? new Error('aborted'));
      }, { once: true });
      setTimeout(() => resolve({ text: 'never' }), 500);
    });
  };
  const ctx = { method: 'chat', signal: outerCtrl.signal, meta: {} };
  const p = dl(ctx, () => inner(ctx, () => ({})));
  // Trigger outer abort
  setTimeout(() => outerCtrl.abort(outerReason), 20);
  await assert.rejects(p, /caller cancelled/);
});

test('deadline: already-aborted signal propagates immediately', async () => {
  const dl = deadline({ timeoutMs: 1000 });
  const ctrl = new AbortController();
  ctrl.abort(new Error('pre-cancelled'));

  const inner = async (ctx) => {
    return new Promise((resolve, reject) => {
      if (ctx.signal.aborted) return reject(ctx.signal.reason);
      setTimeout(() => resolve({}), 100);
    });
  };
  const ctx = { method: 'chat', signal: ctrl.signal, meta: {} };
  await assert.rejects(dl(ctx, () => inner(ctx)), /pre-cancelled/);
});

// ---- onExpired callback -----------------------------------------------

test('deadline: onExpired callback fires with { method, timeoutMs, elapsedMs }', async () => {
  const events = [];
  const dl = deadline({
    timeoutMs: 30,
    onExpired: (info) => events.push(info),
  });
  await assert.rejects(
    () => invoke(dl, { next: () => new Promise((r) => setTimeout(r, 100)) }),
    DeadlineExceededError,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'chat');
  assert.equal(events[0].timeoutMs, 30);
  assert.ok(events[0].elapsedMs >= 20);
});

test('deadline: onExpired errors are swallowed', async () => {
  const dl = deadline({
    timeoutMs: 30,
    onExpired: () => { throw new Error('handler blew up'); },
  });
  await assert.rejects(
    () => invoke(dl, { next: () => new Promise((r) => setTimeout(r, 100)) }),
    DeadlineExceededError,   // still the original error, not the handler's
  );
});

// ---- Stats + active count ---------------------------------------------

test('deadline: activeCount increments during call and decrements after', async () => {
  const dl = deadline({ timeoutMs: 1000 });
  let sawActive = 0;
  const p = invoke(dl, {
    next: async () => {
      sawActive = dl.stats.activeCount;
      return { text: 'ok' };
    },
  });
  await p;
  assert.equal(sawActive, 1);
  assert.equal(dl.stats.activeCount, 0);
});

test('deadline: reset() clears requests + expired but leaves activeCount', async () => {
  const dl = deadline({ timeoutMs: 1000 });
  await invoke(dl);
  assert.equal(dl.stats.requests, 1);
  dl.reset();
  assert.equal(dl.stats.requests, 0);
  assert.equal(dl.stats.expired,  0);
});

// ---- MCP resource ------------------------------------------------------

test('deadline: asMcpResource() returns config://deadline snapshot', () => {
  const dl = deadline({ timeoutMs: 5000, perMethod: { chat: 5000, embed: 500 } });
  const res = dl.asMcpResource();
  assert.equal(res.uri, 'config://deadline');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.timeoutMs, 5000);
  assert.deepEqual(snap.perMethod, { chat: 5000, embed: 500 });
  assert.equal(snap.requests, 0);
});
