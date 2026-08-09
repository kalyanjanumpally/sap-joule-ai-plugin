const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_bh__';
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
  waitForBatch,
  runBatch,
  BatchTimeoutError,
  TERMINAL_STATUSES,
} = require('../lib/batchHelpers');

// Fake svc that yields a scripted sequence of getBatch responses.
function fakeSvc(statusScript, { onSubmit, results, cancelled = false } = {}) {
  let i = 0;
  return {
    async batch(req) {
      if (onSubmit) onSubmit(req);
      return { id: 'batch-1', status: 'in_progress' };
    },
    async getBatch(id) {
      if (i >= statusScript.length) return statusScript[statusScript.length - 1];
      return statusScript[i++];
    },
    async getBatchResults(id) { return results ?? []; },
    async cancelBatch(id) { return { id, status: 'canceled' }; },
  };
}

// ---- Input validation --------------------------------------------------

test('waitForBatch: throws without svc or getBatch', async () => {
  await assert.rejects(waitForBatch(null, 'x'), /svc must be/);
  await assert.rejects(waitForBatch({}, 'x'), /svc must be/);
});
test('waitForBatch: throws on empty id', async () => {
  const svc = fakeSvc([]);
  await assert.rejects(waitForBatch(svc, ''), /non-empty string/);
});
test('waitForBatch: throws on negative pollIntervalMs', async () => {
  const svc = fakeSvc([]);
  await assert.rejects(waitForBatch(svc, 'x', { pollIntervalMs: -1 }), /pollIntervalMs/);
});
test('waitForBatch: throws on negative timeoutMs', async () => {
  const svc = fakeSvc([]);
  await assert.rejects(waitForBatch(svc, 'x', { timeoutMs: -1 }), /timeoutMs/);
});

// ---- Terminal status set -----------------------------------------------

test('TERMINAL_STATUSES contains completed/failed/canceled', () => {
  assert.equal(TERMINAL_STATUSES.has('completed'), true);
  assert.equal(TERMINAL_STATUSES.has('failed'), true);
  assert.equal(TERMINAL_STATUSES.has('canceled'), true);
  assert.equal(TERMINAL_STATUSES.has('in_progress'), false);
  assert.equal(TERMINAL_STATUSES.has('pending'), false);
});

// ---- Happy path --------------------------------------------------------

test('waitForBatch: returns immediately on terminal-first response', async () => {
  const svc = fakeSvc([{ id: 'x', status: 'completed', counts: { succeeded: 3 } }]);
  let clock = 0;
  let slept = false;
  const s = await waitForBatch(svc, 'x', {
    pollIntervalMs: 1000,
    timeoutMs: 60_000,
    now: () => clock,
    sleep: async () => { slept = true; },
  });
  assert.equal(s.status, 'completed');
  assert.equal(slept, false);   // never slept
});

test('waitForBatch: polls until completed', async () => {
  const svc = fakeSvc([
    { id: 'x', status: 'in_progress' },
    { id: 'x', status: 'in_progress', counts: { succeeded: 2 } },
    { id: 'x', status: 'completed', counts: { succeeded: 3 } },
  ]);
  let clock = 0;
  const sleeps = [];
  const s = await waitForBatch(svc, 'x', {
    pollIntervalMs: 1000,
    timeoutMs: 60_000,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  assert.equal(s.status, 'completed');
  assert.equal(sleeps.length, 2);   // 2 sleeps between 3 polls
});

test('waitForBatch: fires onProgress on every poll', async () => {
  const svc = fakeSvc([
    { id: 'x', status: 'in_progress' },
    { id: 'x', status: 'in_progress', counts: { succeeded: 1 } },
    { id: 'x', status: 'completed' },
  ]);
  const seen = [];
  await waitForBatch(svc, 'x', {
    pollIntervalMs: 100,
    now: () => 0,
    sleep: async () => {},
    onProgress: (s) => { seen.push(s.status); },
  });
  assert.deepEqual(seen, ['in_progress', 'in_progress', 'completed']);
});

test('waitForBatch: swallows onProgress errors', async () => {
  const svc = fakeSvc([{ id: 'x', status: 'completed' }]);
  const s = await waitForBatch(svc, 'x', {
    pollIntervalMs: 100,
    now: () => 0,
    sleep: async () => {},
    onProgress: () => { throw new Error('boom'); },
  });
  assert.equal(s.status, 'completed');
});

// ---- Terminal-failure paths --------------------------------------------

test('waitForBatch: returns on failed status', async () => {
  const svc = fakeSvc([
    { id: 'x', status: 'in_progress' },
    { id: 'x', status: 'failed' },
  ]);
  let clock = 0;
  const s = await waitForBatch(svc, 'x', {
    pollIntervalMs: 100, timeoutMs: 10_000,
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(s.status, 'failed');
});

test('waitForBatch: returns on canceled status', async () => {
  const svc = fakeSvc([{ id: 'x', status: 'canceled' }]);
  const s = await waitForBatch(svc, 'x', { pollIntervalMs: 100, now: () => 0, sleep: async () => {} });
  assert.equal(s.status, 'canceled');
});

// ---- Timeout -----------------------------------------------------------

test('waitForBatch: throws BatchTimeoutError past timeout', async () => {
  const svc = fakeSvc([
    { id: 'x', status: 'in_progress' },
    { id: 'x', status: 'in_progress' },
    { id: 'x', status: 'in_progress' },
    { id: 'x', status: 'in_progress' },
  ]);
  let clock = 0;
  await assert.rejects(
    waitForBatch(svc, 'x', {
      pollIntervalMs: 1000,
      timeoutMs: 2500,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    (err) => {
      assert.ok(err instanceof BatchTimeoutError);
      assert.equal(err.batchId, 'x');
      assert.equal(err.lastStatus, 'in_progress');
      assert.ok(err.elapsedMs >= 2000);
      return true;
    },
  );
});

// ---- runBatch ----------------------------------------------------------

test('runBatch: throws without svc or batch', async () => {
  await assert.rejects(runBatch(null, []), /svc must be/);
  await assert.rejects(runBatch({}, []), /svc must be/);
});

test('runBatch: submits, waits, returns results', async () => {
  let submitted;
  const svc = fakeSvc(
    [{ id: 'batch-1', status: 'completed' }],
    {
      onSubmit: (req) => { submitted = req; },
      results: [
        { customId: 'r1', text: 'A' },
        { customId: 'r2', text: 'B' },
      ],
    },
  );
  const rows = await runBatch(svc, [
    { customId: 'r1', messages: [] },
    { customId: 'r2', messages: [] },
  ], { pollIntervalMs: 100, now: () => 0, sleep: async () => {} });
  assert.deepEqual(submitted.requests.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, 'A');
});

test('runBatch: throws when batch ends non-completed', async () => {
  const svc = fakeSvc([{ id: 'batch-1', status: 'failed' }]);
  await assert.rejects(
    runBatch(svc, [{ customId: 'r1', messages: [] }], {
      pollIntervalMs: 100, now: () => 0, sleep: async () => {},
    }),
    (err) => {
      assert.match(err.message, /terminated in status 'failed'/);
      assert.equal(err.status.status, 'failed');
      return true;
    },
  );
});

test('BatchTimeoutError: shape', () => {
  const e = new BatchTimeoutError('bx', 12345, 'in_progress');
  assert.equal(e.name, 'BatchTimeoutError');
  assert.equal(e.batchId, 'bx');
  assert.equal(e.elapsedMs, 12345);
  assert.equal(e.lastStatus, 'in_progress');
  assert.match(e.message, /timed out after 12345ms/);
});
