/**
 * Reciprocal Rank Fusion — canonical algorithm from Cormack et al. 2009 for
 * combining multiple ranked result lists into one. Robust to score-scale
 * mismatches (cosine similarity vs BM25 vs anything else) because it only
 * uses each doc's rank, not its raw score.
 *
 *   fusedScore(doc) = sum over each list L of: w_L / (k + rank_L(doc))
 *
 * Docs missing from a list contribute 0 for that list. `k` is a smoothing
 * constant — 60 is the value the paper landed on and every reference
 * implementation uses; changing it moves the pivot between "top-ranked docs
 * dominate" (small k) and "spread out across the tail" (large k).
 *
 * Weights let callers bias one list over another (e.g. lean on vector recall
 * for conceptual queries, on keyword for SKU / order-number queries).
 * Weights don't need to sum to 1; they scale the per-list contribution.
 *
 * Both `lists` and the returned array carry through the original doc
 * shape (id, text, metadata, score) — the fused score is written into
 * `fusionScore` so callers can still see each source list's original
 * `score` on the surviving list-1 or list-2 copy.
 */
function reciprocalRankFusion({ lists, weights, k = 60 } = {}) {
  if (!Array.isArray(lists) || lists.length === 0) {
    throw new Error('reciprocalRankFusion: `lists` must be a non-empty array of hit arrays');
  }
  const ws = weights ?? new Array(lists.length).fill(1);
  if (ws.length !== lists.length) {
    throw new Error(`reciprocalRankFusion: weights.length (${ws.length}) !== lists.length (${lists.length})`);
  }

  // Doc canonicalization: index by id, keep the first-seen copy so callers
  // can still read whichever list's `text` / `metadata` / `score` won.
  // If any list contributes a doc with a metadata field the earlier lists
  // didn't, we merge it in — cheap way to enrich hits that appeared in the
  // vector list without metadata but were rescored by keyword with it.
  const merged = new Map();
  for (let i = 0; i < lists.length; i++) {
    const hits = lists[i] ?? [];
    for (let rank = 0; rank < hits.length; rank++) {
      const doc = hits[rank];
      if (!doc || doc.id == null) continue;
      const existing = merged.get(doc.id);
      if (existing) {
        // Enrich metadata if a later list has fields the earlier didn't
        if (doc.metadata && (!existing.metadata || Object.keys(existing.metadata).length === 0)) {
          existing.metadata = doc.metadata;
        }
        // Track per-list rank for observability
        existing._ranks[i] = rank;
      } else {
        const ranks = new Array(lists.length).fill(null);
        ranks[i] = rank;
        merged.set(doc.id, {
          id: doc.id,
          text: doc.text ?? '',
          metadata: doc.metadata ?? null,
          score: doc.score,
          _ranks: ranks,
        });
      }
    }
  }

  // Compute fused score
  const out = [];
  for (const doc of merged.values()) {
    let fusion = 0;
    for (let i = 0; i < lists.length; i++) {
      const rank = doc._ranks[i];
      if (rank == null) continue;
      fusion += ws[i] / (k + rank + 1); // rank+1 so #0 in list scores 1/(k+1) not 1/k
    }
    doc.fusionScore = fusion;
    delete doc._ranks;
    out.push(doc);
  }
  out.sort((a, b) => b.fusionScore - a.fusionScore);
  return out;
}

module.exports = { reciprocalRankFusion };
