const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pr__';
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
  promptRegression,
  loadFixtures,
  formatReport,
  validateFixture,
} = require('../lib/promptRegression');

function tmpDir(name) {
  const p = path.join(os.tmpdir(), `pr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Chat under test — returns whatever text you script.
function makeChat(script) {
  let n = 0;
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const entry = typeof script === 'function' ? script(req, n++) : (script[n++] ?? script[script.length - 1]);
    return {
      text: typeof entry === 'string' ? entry : entry.text,
      model: 'llm-under-test',
      usage: { input_tokens: 10, output_tokens: 20 },
    };
  };
  fn.calls = calls;
  return fn;
}

// Judge chat — returns a JSON verdict matching llmJudge expectations.
// script forms: function(req, n) | Array (indexed by call#) | plain object (returned every call)
function makeJudge(script) {
  let n = 0;
  const fn = async (req) => {
    let entry;
    if (typeof script === 'function') entry = script(req, n++);
    else if (Array.isArray(script))   entry = script[n++] ?? script[script.length - 1];
    else                              entry = script;
    return { data: entry, model: 'judge-model', usage: {} };
  };
  return fn;
}

// ---- validateFixture -------------------------------------------------

test('validateFixture: valid fixture passes', () => {
  validateFixture({
    request: { messages: [{ role: 'user', content: 'hi' }] },
    criteria: 'be nice',
  }, 0);
});
test('validateFixture: rejects missing request', () => {
  assert.throws(() => validateFixture({ criteria: 'x' }, 0), /missing request object/);
});
test('validateFixture: rejects empty messages', () => {
  assert.throws(
    () => validateFixture({ request: { messages: [] }, criteria: 'x' }, 0),
    /messages must be a non-empty array/,
  );
});
test('validateFixture: rejects missing criteria', () => {
  assert.throws(
    () => validateFixture({ request: { messages: [{ role: 'user', content: 'x' }] } }, 0),
    /missing criteria/,
  );
});
test('validateFixture: rejects out-of-range threshold', () => {
  assert.throws(
    () => validateFixture({
      request: { messages: [{ role: 'user', content: 'x' }] },
      criteria: 'x',
      threshold: 1.5,
    }, 0),
    /threshold must be a number in \[0, 1\]/,
  );
});

// ---- loadFixtures -----------------------------------------------------

test('loadFixtures: reads JSON files from dir', () => {
  const dir = tmpDir('load');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
    request: { messages: [{ role: 'user', content: 'hi' }] },
    criteria: 'x',
  }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({
    name: 'custom-name',
    request: { messages: [{ role: 'user', content: 'bye' }] },
    criteria: 'y',
  }));
  const out = loadFixtures(dir);
  fs.rmSync(dir, { recursive: true });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'a');            // sorted, filename basename
  assert.equal(out[1].name, 'custom-name');
  assert.ok(out[0].path.endsWith('a.json'));
});

test('loadFixtures: skips non-JSON files', () => {
  const dir = tmpDir('skip');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
    request: { messages: [{ role: 'user', content: 'x' }] }, criteria: 'x',
  }));
  fs.writeFileSync(path.join(dir, 'readme.md'), '# not a fixture');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const out = loadFixtures(dir);
  fs.rmSync(dir, { recursive: true });
  assert.equal(out.length, 1);
});

test('loadFixtures: throws on directory not found', () => {
  assert.throws(() => loadFixtures('/does-not-exist-xyz'), /directory not found/);
});

test('loadFixtures: throws on non-directory', () => {
  const p = path.join(os.tmpdir(), `pr-file-${Date.now()}.txt`);
  fs.writeFileSync(p, 'not a dir');
  assert.throws(() => loadFixtures(p), /not a directory/);
  fs.unlinkSync(p);
});

test('loadFixtures: throws on malformed JSON', () => {
  const dir = tmpDir('bad');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ not valid');
  assert.throws(() => loadFixtures(dir), /bad\.json/);
  fs.rmSync(dir, { recursive: true });
});

test('loadFixtures: throws on empty string dir', () => {
  assert.throws(() => loadFixtures(''), /non-empty string/);
});

// ---- promptRegression input validation -------------------------------

test('promptRegression: throws on empty fixtures', async () => {
  await assert.rejects(
    promptRegression({ chat: () => {}, fixtures: [] }),
    /fixtures must be a non-empty array/,
  );
});
test('promptRegression: throws on bad concurrency', async () => {
  await assert.rejects(
    promptRegression({ chat: () => {}, fixtures: [{ request: { messages: [{role:'user',content:'x'}] }, criteria: 'x' }], concurrency: 0 }),
    /concurrency must be/,
  );
});
test('promptRegression: throws without llm or chat', async () => {
  await assert.rejects(
    promptRegression({ fixtures: [{ request: { messages: [{role:'user',content:'x'}] }, criteria: 'x' }] }),
    /pass either.*llm.*or.*chat/,
  );
});

// ---- End-to-end runs ------------------------------------------------

test('promptRegression: all pass', async () => {
  const chat = makeChat(['response A', 'response B']);
  const judge = makeJudge((_, n) => ({
    criteriaResults: [{ name: 'default', score: 0.9, rationale: 'ok' }],
    overallRationale: 'strong',
  }));
  const report = await promptRegression({
    chat,
    judgeChat: judge,
    fixtures: [
      { name: 'a', request: { messages: [{ role: 'user', content: 'a' }] }, criteria: 'x' },
      { name: 'b', request: { messages: [{ role: 'user', content: 'b' }] }, criteria: 'x' },
    ],
  });
  assert.equal(report.total, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.passRate, 1);
  assert.equal(report.results[0].verdict, 'pass');
  assert.equal(report.results[0].score, 0.9);
  assert.equal(chat.calls.length, 2);
});

test('promptRegression: mixed pass/fail', async () => {
  const chat = makeChat(['strong', 'weak']);
  let n = 0;
  const judge = makeJudge(() => ({
    criteriaResults: [{ name: 'default', score: n++ === 0 ? 0.9 : 0.3, rationale: 'x' }],
    overallRationale: '',
  }));
  const report = await promptRegression({
    chat,
    judgeChat: judge,
    fixtures: [
      { name: 'a', request: { messages: [{ role: 'user', content: 'a' }] }, criteria: 'x' },
      { name: 'b', request: { messages: [{ role: 'user', content: 'b' }] }, criteria: 'x' },
    ],
    concurrency: 1,   // sequential so judge script order matches fixture order
  });
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.passRate, 0.5);
});

test('promptRegression: LLM error caught per-fixture', async () => {
  let n = 0;
  const chat = async (req) => {
    n++;
    if (n === 2) throw new Error('provider down');
    return { text: 'ok', model: 'x', usage: {} };
  };
  const judge = makeJudge({
    criteriaResults: [{ name: 'default', score: 0.9, rationale: '' }],
    overallRationale: '',
  });
  const report = await promptRegression({
    chat,
    judgeChat: judge,
    fixtures: [
      { name: 'a', request: { messages: [{ role: 'user', content: 'a' }] }, criteria: 'x' },
      { name: 'b', request: { messages: [{ role: 'user', content: 'b' }] }, criteria: 'x' },
      { name: 'c', request: { messages: [{ role: 'user', content: 'c' }] }, criteria: 'x' },
    ],
    concurrency: 1,
  });
  assert.equal(report.passed, 2);
  assert.equal(report.errors, 1);
  assert.equal(report.results[1].verdict, 'error');
  assert.match(report.results[1].error, /provider down/);
});

test('promptRegression: LLM response with no text → error', async () => {
  const chat = async () => ({ model: 'x', usage: {} });   // no text
  const report = await promptRegression({
    chat,
    judgeChat: makeJudge({}),
    fixtures: [
      { name: 'a', request: { messages: [{ role: 'user', content: 'a' }] }, criteria: 'x' },
    ],
  });
  assert.equal(report.errors, 1);
  assert.match(report.results[0].error, /no text field/);
});

test('promptRegression: per-fixture threshold overrides default', async () => {
  const chat = makeChat(['x']);
  const judge = makeJudge({
    criteriaResults: [{ name: 'default', score: 0.6, rationale: '' }],
    overallRationale: '',
  });
  const report = await promptRegression({
    chat,
    judgeChat: judge,
    fixtures: [
      { name: 'a',
        request: { messages: [{ role: 'user', content: 'x' }] },
        criteria: 'x',
        threshold: 0.5,   // 0.6 > 0.5 → pass
      },
    ],
    defaultThreshold: 0.9,   // ignored for this fixture
  });
  assert.equal(report.passed, 1);
});

test('promptRegression: onProgress fires per fixture', async () => {
  const events = [];
  const report = await promptRegression({
    chat: makeChat(['a', 'b']),
    judgeChat: makeJudge({
      criteriaResults: [{ name: 'default', score: 1, rationale: '' }],
      overallRationale: '',
    }),
    fixtures: [
      { name: 'A', request: { messages: [{ role: 'user', content: 'a' }] }, criteria: 'x' },
      { name: 'B', request: { messages: [{ role: 'user', content: 'b' }] }, criteria: 'x' },
    ],
    onProgress: (info) => events.push({ name: info.name, verdict: info.verdict, index: info.index, total: info.total }),
  });
  assert.equal(events.length, 2);
  const names = events.map((e) => e.name).sort();
  assert.deepEqual(names, ['A', 'B']);
  assert.equal(events[0].total, 2);
});

test('promptRegression: onProgress error swallowed', async () => {
  const report = await promptRegression({
    chat: makeChat(['a']),
    judgeChat: makeJudge({
      criteriaResults: [{ name: 'default', score: 1, rationale: '' }],
      overallRationale: '',
    }),
    fixtures: [
      { name: 'A', request: { messages: [{ role: 'user', content: 'a' }] }, criteria: 'x' },
    ],
    onProgress: () => { throw new Error('boom'); },
  });
  assert.equal(report.passed, 1);
});

test('promptRegression: concurrency > 1 runs in parallel', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const chat = async () => {
    inFlight++;
    if (inFlight > maxConcurrent) maxConcurrent = inFlight;
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return { text: 'x', model: 'x', usage: {} };
  };
  const judge = makeJudge({
    criteriaResults: [{ name: 'default', score: 1, rationale: '' }],
    overallRationale: '',
  });
  await promptRegression({
    chat,
    judgeChat: judge,
    fixtures: Array.from({ length: 6 }, (_, i) => ({
      name: `f${i}`,
      request: { messages: [{ role: 'user', content: `${i}` }] },
      criteria: 'x',
    })),
    concurrency: 3,
  });
  assert.equal(maxConcurrent, 3);
});

test('promptRegression: uses judgeLlm handle', async () => {
  let judgeCalls = 0;
  const judgeLlm = {
    chat: async () => {
      judgeCalls++;
      return {
        data: {
          criteriaResults: [{ name: 'default', score: 1, rationale: '' }],
          overallRationale: '',
        },
        usage: {},
      };
    },
  };
  await promptRegression({
    chat: makeChat(['x']),
    judgeLlm,
    fixtures: [{ name: 'a', request: { messages: [{ role: 'user', content: 'x' }] }, criteria: 'x' }],
  });
  assert.equal(judgeCalls, 1);
});

test('promptRegression: falls back to main chat as judge when no judgeLlm/judgeChat', async () => {
  let calls = 0;
  const chat = async () => {
    calls++;
    return {
      text: 'response',
      data: {
        criteriaResults: [{ name: 'default', score: 1, rationale: '' }],
        overallRationale: '',
      },
      model: 'x', usage: {},
    };
  };
  await promptRegression({
    chat,
    fixtures: [{ name: 'a', request: { messages: [{ role: 'user', content: 'x' }] }, criteria: 'x' }],
  });
  // 2 calls total: one for the response, one for the judge.
  assert.equal(calls, 2);
});

test('promptRegression: validates fixtures upfront', async () => {
  await assert.rejects(
    promptRegression({
      chat: makeChat(['x']),
      judgeChat: makeJudge({}),
      fixtures: [{ name: 'bad', request: {}, criteria: 'x' }],
    }),
    /messages must be a non-empty array/,
  );
});

// ---- formatReport -----------------------------------------------------

test('formatReport: renders summary with pass/fail markers', () => {
  const report = {
    total: 3, passed: 2, failed: 1, errors: 0, passRate: 2 / 3,
    results: [
      { name: 'a', verdict: 'pass', score: 0.9, durationMs: 100 },
      { name: 'b', verdict: 'pass', score: 0.85, durationMs: 150 },
      { name: 'c', verdict: 'fail', score: 0.3, durationMs: 200,
        criteriaResults: [{ name: 'accuracy', passed: false, rationale: 'wrong' }] },
    ],
  };
  const out = formatReport(report);
  assert.match(out, /✓ a/);
  assert.match(out, /✗ c/);
  assert.match(out, /accuracy: wrong/);
  assert.match(out, /2 passed, 1 failed, 0 errors/);
  assert.match(out, /66.7%/);
});

test('formatReport: colors:true adds ANSI codes', () => {
  const report = {
    total: 1, passed: 1, failed: 0, errors: 0, passRate: 1,
    results: [{ name: 'a', verdict: 'pass', score: 0.9, durationMs: 100 }],
  };
  const out = formatReport(report, { colors: true });
  assert.match(out, /\x1b\[32m/);   // green ANSI code
});

test('formatReport: renders error verdict', () => {
  const report = {
    total: 1, passed: 0, failed: 0, errors: 1, passRate: 0,
    results: [{ name: 'a', verdict: 'error', score: 0, durationMs: 50, error: 'network' }],
  };
  const out = formatReport(report);
  assert.match(out, /! a/);
  assert.match(out, /error: network/);
});
