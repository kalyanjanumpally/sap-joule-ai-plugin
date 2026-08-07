// Sample tests using testing.recording + testing.replay (cds-plugin-llm 1.69.0).
//
// Workflow:
//   1. Author-time: set RECORD=1 to capture real provider responses into
//      test/fixtures/*.json (requires a working llm alias + credentials).
//   2. CI-time: replay from fixtures (no network, no credentials needed).
//
// This test uses an in-memory store so it's self-contained. Real
// production tests would use `store: 'test/fixtures/....json'` to persist
// fixtures to disk and check them into git.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { testing } = require('@saptarishi/cds-plugin-llm');

// In-memory store simulates the on-disk file store for self-contained tests
function memStore() {
  const entries = {};
  return {
    get(hash)          { return entries[hash] ?? null; },
    set(hash, entry)   { entries[hash] = entry; },
    all()              { return { ...entries }; },
    size()             { return Object.keys(entries).length; },
  };
}

// ---- Record → replay round-trip ----

test('recording: captures real provider responses', async () => {
  const store = memStore();
  const rec = testing.recording({ store });

  // Simulate a "real" LLM by calling the middleware directly with a next()
  // that returns a scripted response.
  const req = { messages: [{ role: 'user', content: 'ping' }], model: 'gpt-4o-mini' };
  await rec(
    { method: 'chat', request: req, raw: req, meta: {} },
    async () => ({ text: 'real provider says pong', usage: { input_tokens: 5, output_tokens: 10 } }),
  );

  assert.equal(store.size(), 1);
  const entry = Object.values(store.all())[0];
  assert.equal(entry.response.text, 'real provider says pong');
  assert.equal(entry.method, 'chat');
});

test('replay: returns stored fixture without calling next()', async () => {
  const store = memStore();
  // Pre-populate a fixture
  const req = { messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o-mini' };
  const hash = testing.defaultHash(req, 'chat');
  store.set(hash, {
    request: req,
    response: { text: 'from fixture' },
    recordedAt: 'now',
    method: 'chat',
  });

  const rep = testing.replay({ store, strict: true });
  let nextCalled = false;
  const res = await rep(
    { method: 'chat', request: req, raw: req, meta: {} },
    async () => { nextCalled = true; return { text: 'never' }; },
  );
  assert.equal(res.text, 'from fixture');
  assert.equal(nextCalled, false);
});

test('replay strict mode: throws MissingFixtureError on cache miss', async () => {
  const rep = testing.replay({ store: memStore(), strict: true });
  await assert.rejects(
    rep(
      { method: 'chat', request: { messages: [{ role: 'user', content: 'unrecorded' }], model: 'x' }, raw: {}, meta: {} },
      async () => ({}),
    ),
    (err) => {
      assert.ok(err instanceof testing.MissingFixtureError);
      assert.equal(err.code, 'MISSING_FIXTURE');
      return true;
    },
  );
});

test('record → replay round-trip through the same in-memory store', async () => {
  const store = memStore();
  const rec = testing.recording({ store });
  const rep = testing.replay({ store, strict: true });

  const req = { messages: [{ role: 'user', content: 'round-trip' }], model: 'gpt-4o-mini' };

  // 1. Record
  await rec(
    { method: 'chat', request: req, raw: req, meta: {} },
    async () => ({ text: 'recorded response' }),
  );

  // 2. Replay same request → no next() call, returns recorded response
  let replayNextCalled = false;
  const res = await rep(
    { method: 'chat', request: req, raw: req, meta: {} },
    async () => { replayNextCalled = true; return { text: 'never' }; },
  );
  assert.equal(res.text, 'recorded response');
  assert.equal(replayNextCalled, false);
});
