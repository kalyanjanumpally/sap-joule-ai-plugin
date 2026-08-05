const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reciprocalRankFusion } = require('../lib/rrf');

// ---- validation --------------------------------------------------------

test('reciprocalRankFusion: rejects missing / empty lists', () => {
  assert.throws(() => reciprocalRankFusion({}), /lists/);
  assert.throws(() => reciprocalRankFusion({ lists: [] }), /lists/);
});

test('reciprocalRankFusion: weights.length must match lists.length', () => {
  assert.throws(() => reciprocalRankFusion({ lists: [[], []], weights: [1] }), /weights\.length/);
});

// ---- basic fusion ------------------------------------------------------

test('reciprocalRankFusion: two lists with disjoint winners → both surface', () => {
  const vector = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const keyword = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const fused = reciprocalRankFusion({ lists: [vector, keyword] });
  const ids = fused.map(h => h.id);
  assert.deepEqual(ids, ['a', 'x', 'b', 'y', 'c', 'z']);
});

test('reciprocalRankFusion: docs appearing in both lists rank higher', () => {
  const vector  = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const keyword = [{ id: 'c' }, { id: 'a' }, { id: 'd' }];
  const fused = reciprocalRankFusion({ lists: [vector, keyword] });
  assert.equal(fused[0].id, 'a', 'a is #1 in vector, #2 in keyword — best combined');
  assert.equal(fused[1].id, 'c', 'c is #3 in vector, #1 in keyword — second best');
  // b and d appear in only one list each
  const rest = fused.slice(2).map(h => h.id).sort();
  assert.deepEqual(rest, ['b', 'd']);
});

test('reciprocalRankFusion: weight bias lets one list dominate', () => {
  const vector  = [{ id: 'a' }, { id: 'b' }];
  const keyword = [{ id: 'x' }, { id: 'y' }];
  const heavyKeyword = reciprocalRankFusion({ lists: [vector, keyword], weights: [0.1, 1.0] });
  assert.equal(heavyKeyword[0].id, 'x', 'keyword winner beats vector winner when weight is high');
  const heavyVector = reciprocalRankFusion({ lists: [vector, keyword], weights: [1.0, 0.1] });
  assert.equal(heavyVector[0].id, 'a');
});

test('reciprocalRankFusion: docs appearing in multiple lists always outrank single-list #1', () => {
  // Fundamental RRF property: the multi-list bonus is additive and never
  // dilutes to nothing. A doc that appears in every retrieval — even at
  // the tail — outscores a doc that only appears in one, regardless of k.
  const vector  = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const keyword = [{ id: 'c' }];
  for (const k of [1, 60, 1000]) {
    const fused = reciprocalRankFusion({ lists: [vector, keyword], k });
    assert.equal(fused[0].id, 'c', `multi-list winner should stay #1 at k=${k}`);
  }
});

// ---- doc merging + metadata ---------------------------------------------

test('reciprocalRankFusion: preserves text and metadata from the first-seen list', () => {
  const vector  = [{ id: 'a', text: 'from vector', metadata: { source: 'v' } }];
  const keyword = [{ id: 'a', text: 'from keyword', metadata: { source: 'k' } }];
  const fused = reciprocalRankFusion({ lists: [vector, keyword] });
  assert.equal(fused[0].text, 'from vector');
  assert.deepEqual(fused[0].metadata, { source: 'v' });
});

test('reciprocalRankFusion: enriches with metadata from a later list if the first was empty', () => {
  const vector  = [{ id: 'a', text: 't', metadata: null }];
  const keyword = [{ id: 'a', text: 't', metadata: { region: 'EMEA' } }];
  const fused = reciprocalRankFusion({ lists: [vector, keyword] });
  assert.deepEqual(fused[0].metadata, { region: 'EMEA' });
});

test('reciprocalRankFusion: docs with null id are ignored', () => {
  const list = [{ text: 'no id' }, { id: 'ok', text: 'has id' }];
  const fused = reciprocalRankFusion({ lists: [list] });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].id, 'ok');
});

test('reciprocalRankFusion: fusionScore is written; internal _ranks is stripped', () => {
  const list = [{ id: 'a' }];
  const fused = reciprocalRankFusion({ lists: [list] });
  assert.ok(typeof fused[0].fusionScore === 'number');
  assert.equal(fused[0]._ranks, undefined);
});
