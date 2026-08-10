const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_judge__';
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
  llmJudge,
  judgeMany,
  normalizeCriteria,
  buildUserPrompt,
  aggregateScore,
  judgmentSchema,
  DEFAULT_JUDGE_SYSTEM,
} = require('../lib/llmJudge');

// ---- normalizeCriteria ------------------------------------------------

test('normalizeCriteria: string form → single default criterion', () => {
  const r = normalizeCriteria('answer must cite a source');
  assert.deepEqual(r, [{ name: 'default', description: 'answer must cite a source', weight: 1 }]);
});
test('normalizeCriteria: array of strings → auto-named', () => {
  const r = normalizeCriteria(['a', 'b']);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'criterion1');
  assert.equal(r[1].name, 'criterion2');
});
test('normalizeCriteria: array of objects preserves name + weight', () => {
  const r = normalizeCriteria([
    { name: 'accuracy', description: 'facts match', weight: 3 },
    { name: 'brevity',  description: '2 sentences' },
  ]);
  assert.equal(r[0].name, 'accuracy');
  assert.equal(r[0].weight, 3);
  assert.equal(r[1].weight, 1);
});
test('normalizeCriteria: throws on empty array', () => {
  assert.throws(() => normalizeCriteria([]), /cannot be empty/);
});
test('normalizeCriteria: throws on non-array/non-string', () => {
  assert.throws(() => normalizeCriteria(42), /must be a string or an array/);
});
test('normalizeCriteria: throws on duplicate names', () => {
  assert.throws(
    () => normalizeCriteria([{ name: 'x', description: 'a' }, { name: 'x', description: 'b' }]),
    /duplicate criterion name/,
  );
});
test('normalizeCriteria: throws on missing description', () => {
  assert.throws(
    () => normalizeCriteria([{ name: 'x' }]),
    /description must be a non-empty string/,
  );
});
test('normalizeCriteria: throws on non-positive weight', () => {
  assert.throws(
    () => normalizeCriteria([{ name: 'x', description: 'd', weight: 0 }]),
    /weight must be a positive number/,
  );
});

// ---- buildUserPrompt --------------------------------------------------

test('buildUserPrompt: includes RESPONSE + CRITERIA blocks', () => {
  const cfg = [{ name: 'accuracy', description: 'facts match', weight: 1 }];
  const p = buildUserPrompt(cfg, 'the sky is blue', null);
  assert.match(p, /RESPONSE.*the sky is blue/s);
  assert.match(p, /CRITERIA/);
  assert.match(p, /1\. accuracy — facts match/);
});
test('buildUserPrompt: includes CONTEXT when provided', () => {
  const cfg = [{ name: 'accuracy', description: 'facts match', weight: 1 }];
  const p = buildUserPrompt(cfg, 'r', 'source of truth');
  assert.match(p, /CONTEXT.*source of truth/s);
});
test('buildUserPrompt: annotates non-default weight', () => {
  const cfg = [{ name: 'x', description: 'd', weight: 3 }];
  assert.match(buildUserPrompt(cfg, 'r'), /weight: 3/);
});

// ---- judgmentSchema ---------------------------------------------------

test('judgmentSchema: enum constrains criteria names', () => {
  const s = judgmentSchema(['a', 'b']);
  assert.deepEqual(s.properties.criteriaResults.items.properties.name.enum, ['a', 'b']);
  assert.deepEqual(s.required, ['criteriaResults', 'overallRationale']);
});

// ---- aggregateScore ---------------------------------------------------

test('aggregateScore: simple mean (equal weights)', () => {
  const cfg = [
    { name: 'a', description: '', weight: 1 },
    { name: 'b', description: '', weight: 1 },
  ];
  const results = [
    { name: 'a', score: 1.0, rationale: 'ok' },
    { name: 'b', score: 0.4, rationale: 'ok' },
  ];
  const { finalScore } = aggregateScore(results, cfg);
  assert.equal(finalScore, 0.7);
});
test('aggregateScore: weighted (3:1:1 = uneven)', () => {
  const cfg = [
    { name: 'a', description: '', weight: 3 },
    { name: 'b', description: '', weight: 1 },
    { name: 'c', description: '', weight: 1 },
  ];
  const results = [
    { name: 'a', score: 0.9, rationale: '' },
    { name: 'b', score: 0.0, rationale: '' },
    { name: 'c', score: 0.5, rationale: '' },
  ];
  const { finalScore } = aggregateScore(results, cfg);
  // (0.9*3 + 0.0*1 + 0.5*1) / 5 = 3.2/5 = 0.64
  assert.ok(Math.abs(finalScore - 0.64) < 0.001);
});
test('aggregateScore: clamps out-of-range scores', () => {
  const cfg = [{ name: 'a', description: '', weight: 1 }];
  const { finalScore } = aggregateScore([{ name: 'a', score: 1.5 }], cfg);
  assert.equal(finalScore, 1);
});
test('aggregateScore: missing criterion result → 0', () => {
  const cfg = [
    { name: 'a', description: '', weight: 1 },
    { name: 'b', description: '', weight: 1 },
  ];
  const { finalScore, merged } = aggregateScore([{ name: 'a', score: 1 }], cfg);
  assert.equal(finalScore, 0.5);
  assert.equal(merged[1].score, 0);
  assert.match(merged[1].rationale, /no rationale returned/);
});
test('aggregateScore: passed flag at 0.5 per-criterion', () => {
  const cfg = [
    { name: 'a', description: '', weight: 1 },
    { name: 'b', description: '', weight: 1 },
  ];
  const { merged } = aggregateScore([
    { name: 'a', score: 0.49 },
    { name: 'b', score: 0.50 },
  ], cfg);
  assert.equal(merged[0].passed, false);
  assert.equal(merged[1].passed, true);
});

// ---- End-to-end judge with mocked chat --------------------------------

function fakeChat(judgeReply) {
  return async (req) => ({
    text: JSON.stringify(judgeReply),
    data: judgeReply,
    model: 'judge-test-model',
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

test('llmJudge: single string criterion + pass verdict', async () => {
  const j = await llmJudge({
    chat: fakeChat({
      criteriaResults: [{ name: 'default', score: 0.9, rationale: 'looks good' }],
      overallRationale: 'meets bar',
    }),
    criteria: 'answer must cite a source',
    response: 'CTR-2026-101 says so.',
  });
  assert.equal(j.verdict, 'pass');
  assert.equal(j.score, 0.9);
  assert.equal(j.criteriaResults.length, 1);
  assert.equal(j.model, 'judge-test-model');
  assert.equal(j.usage.input_tokens, 100);
});

test('llmJudge: multi-criterion rubric with weights', async () => {
  const j = await llmJudge({
    chat: fakeChat({
      criteriaResults: [
        { name: 'accuracy',  score: 1.0, rationale: 'facts match' },
        { name: 'brevity',   score: 0.3, rationale: 'too long' },
        { name: 'grounding', score: 0.9, rationale: 'cites ID' },
      ],
      overallRationale: 'strong on facts, weak on brevity',
    }),
    criteria: [
      { name: 'accuracy',  description: 'facts match',  weight: 2 },
      { name: 'brevity',   description: 'be brief',     weight: 1 },
      { name: 'grounding', description: 'cite IDs',     weight: 3 },
    ],
    response: 'Contract CTR-2026-101 ends 2027-06-30.',
    context:  'Source: contract CTR-2026-101 dated 2024-04-01.',
  });
  // (1.0*2 + 0.3*1 + 0.9*3) / 6 = (2 + 0.3 + 2.7) / 6 = 5.0/6 ≈ 0.833
  assert.ok(Math.abs(j.score - 0.833) < 0.01);
  assert.equal(j.verdict, 'pass');
  assert.equal(j.criteriaResults[0].name, 'accuracy');
  assert.equal(j.criteriaResults[1].passed, false);   // 0.3 < 0.5
});

test('llmJudge: custom threshold flips verdict', async () => {
  const reply = {
    criteriaResults: [{ name: 'default', score: 0.6, rationale: 'meh' }],
    overallRationale: 'borderline',
  };
  const j1 = await llmJudge({ chat: fakeChat(reply), criteria: 'x', response: 'y' });
  assert.equal(j1.verdict, 'fail');       // 0.6 < 0.7 default
  const j2 = await llmJudge({ chat: fakeChat(reply), criteria: 'x', response: 'y', threshold: 0.5 });
  assert.equal(j2.verdict, 'pass');
});

test('llmJudge: judgeModel override propagates to req.model', async () => {
  let seenModel;
  const chat = async (req) => {
    seenModel = req.model;
    return {
      data: { criteriaResults: [{ name: 'default', score: 1, rationale: '' }], overallRationale: '' },
      usage: {},
    };
  };
  await llmJudge({ chat, criteria: 'x', response: 'y', judgeModel: 'claude-opus-4-7' });
  assert.equal(seenModel, 'claude-opus-4-7');
});

test('llmJudge: judgeSystem override used', async () => {
  let seenSystem;
  const chat = async (req) => {
    seenSystem = req.system;
    return {
      data: { criteriaResults: [{ name: 'default', score: 1, rationale: '' }], overallRationale: '' },
      usage: {},
    };
  };
  await llmJudge({ chat, criteria: 'x', response: 'y', judgeSystem: 'CUSTOM JUDGE PROMPT' });
  assert.equal(seenSystem, 'CUSTOM JUDGE PROMPT');
});

test('llmJudge: falls back to parsing text when result.data absent', async () => {
  const chat = async () => ({
    text: '```json\n' + JSON.stringify({
      criteriaResults: [{ name: 'default', score: 1, rationale: 'ok' }],
      overallRationale: 'ok',
    }) + '\n```',
    usage: {},
  });
  const j = await llmJudge({ chat, criteria: 'x', response: 'y' });
  assert.equal(j.score, 1);
});

test('llmJudge: throws on unparseable judge output', async () => {
  const chat = async () => ({ text: 'sorry I refuse to output JSON', usage: {} });
  await assert.rejects(
    llmJudge({ chat, criteria: 'x', response: 'y' }),
    /unparseable output/,
  );
});

test('llmJudge: accepts llm.chat handle instead of chat fn', async () => {
  const llm = {
    chat: async () => ({
      data: { criteriaResults: [{ name: 'default', score: 0.85, rationale: '' }], overallRationale: '' },
      usage: {},
    }),
  };
  const j = await llmJudge({ llm, criteria: 'x', response: 'y' });
  assert.equal(j.score, 0.85);
});

test('llmJudge: throws without llm or chat', async () => {
  await assert.rejects(
    llmJudge({ criteria: 'x', response: 'y' }),
    /pass either.*llm.*or.*chat/,
  );
});

test('llmJudge: throws on empty response', async () => {
  await assert.rejects(
    llmJudge({ chat: fakeChat({}), criteria: 'x', response: '' }),
    /response must be a non-empty string/,
  );
});

test('llmJudge: throws on missing criteria', async () => {
  await assert.rejects(
    llmJudge({ chat: fakeChat({}), response: 'y' }),
    /criteria is required/,
  );
});

test('llmJudge: throws on out-of-range threshold', async () => {
  await assert.rejects(
    llmJudge({ chat: fakeChat({}), criteria: 'x', response: 'y', threshold: 1.5 }),
    /threshold must be a number between 0 and 1/,
  );
});

test('llmJudge: context appears in the user prompt', async () => {
  let seenUserContent;
  const chat = async (req) => {
    seenUserContent = req.messages[0].content;
    return {
      data: { criteriaResults: [{ name: 'default', score: 1, rationale: '' }], overallRationale: '' },
      usage: {},
    };
  };
  await llmJudge({
    chat,
    criteria: 'x',
    response: 'RESPONSE_TEXT',
    context: 'CONTEXT_TEXT',
  });
  assert.match(seenUserContent, /CONTEXT_TEXT/);
  assert.match(seenUserContent, /RESPONSE_TEXT/);
});

test('llmJudge: format schema attached to chat request', async () => {
  let seenFormat;
  const chat = async (req) => {
    seenFormat = req.format;
    return {
      data: { criteriaResults: [{ name: 'a', score: 1, rationale: '' }, { name: 'b', score: 1, rationale: '' }], overallRationale: '' },
      usage: {},
    };
  };
  await llmJudge({
    chat,
    criteria: [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }],
    response: 'r',
  });
  assert.deepEqual(seenFormat.properties.criteriaResults.items.properties.name.enum, ['a', 'b']);
});

// ---- judgeMany --------------------------------------------------------

test('judgeMany: scores N responses in parallel', async () => {
  let calls = 0;
  const chat = async () => {
    calls++;
    return {
      data: { criteriaResults: [{ name: 'default', score: 0.8, rationale: 'ok' }], overallRationale: '' },
      usage: {},
    };
  };
  const results = await judgeMany({
    chat,
    criteria: 'x',
    responses: ['a', 'b', 'c'],
    concurrency: 2,
  });
  assert.equal(results.length, 3);
  assert.equal(calls, 3);
  for (const r of results) assert.equal(r.verdict, 'pass');
});

test('judgeMany: per-response context via object form', async () => {
  const seenContexts = [];
  const chat = async (req) => {
    seenContexts.push(req.messages[0].content.match(/CONTEXT.*?RESPONSE/s)?.[0] ?? '(none)');
    return {
      data: { criteriaResults: [{ name: 'default', score: 1, rationale: '' }], overallRationale: '' },
      usage: {},
    };
  };
  await judgeMany({
    chat,
    criteria: 'x',
    responses: [
      { response: 'r1', context: 'CTX_ONE' },
      { response: 'r2', context: 'CTX_TWO' },
    ],
  });
  assert.match(seenContexts[0], /CTX_ONE/);
  assert.match(seenContexts[1], /CTX_TWO/);
});

test('judgeMany: captures per-response errors instead of failing all', async () => {
  const chat = async (req) => {
    if (req.messages[0].content.includes('bad')) throw new Error('boom');
    return {
      data: { criteriaResults: [{ name: 'default', score: 1, rationale: '' }], overallRationale: '' },
      usage: {},
    };
  };
  const results = await judgeMany({
    chat,
    criteria: 'x',
    responses: ['good', 'bad', 'good'],
  });
  assert.equal(results[0].verdict, 'pass');
  assert.equal(results[1].verdict, 'error');
  assert.equal(results[1].error, 'boom');
  assert.equal(results[2].verdict, 'pass');
});

test('judgeMany: throws on empty responses', async () => {
  await assert.rejects(
    judgeMany({ chat: fakeChat({}), criteria: 'x', responses: [] }),
    /responses must be a non-empty array/,
  );
});

test('judgeMany: throws on bad concurrency', async () => {
  await assert.rejects(
    judgeMany({ chat: fakeChat({}), criteria: 'x', responses: ['a'], concurrency: 0 }),
    /concurrency must be a positive integer/,
  );
});

// ---- Judge system prompt --------------------------------------------

test('DEFAULT_JUDGE_SYSTEM is a non-empty string', () => {
  assert.ok(typeof DEFAULT_JUDGE_SYSTEM === 'string');
  assert.ok(DEFAULT_JUDGE_SYSTEM.length > 100);
  assert.match(DEFAULT_JUDGE_SYSTEM, /impartial/);
});
