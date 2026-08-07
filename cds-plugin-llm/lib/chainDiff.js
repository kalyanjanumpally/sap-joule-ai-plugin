// Chain snapshot diff. Compare two middleware chain snapshots (the
// `config://chain` payloads from 1.48 validateMiddlewareOrder /
// buildChainSnapshot) and report the delta: added / removed / reordered
// primitives + per-primitive config field changes.
//
// CI use case: check that a live deployment's chain matches a committed
// baseline. If it drifted, fail the pipeline with a structured diff.
//
// Signature:
//
//   const { chainDiff, formatChainDiff } = require('@saptarishi/cds-plugin-llm');
//
//   const diff = chainDiff(baselineChain, liveChain);
//   if (!diff.ok) {
//     console.error(formatChainDiff(diff));
//     process.exit(1);
//   }
//
// Snapshot shape (what both `a` and `b` must be):
//
//   {
//     order: [
//       { position: 0, kind: 'deadline', config: { timeoutMs: 30000, ... } },
//       { position: 1, kind: 'guardrails', config: {...} },
//       ...
//     ],
//   }
//
// Output shape:
//
//   {
//     ok:            false,                // true iff no changes
//     added:         [{ kind, position }],
//     removed:       [{ kind, position }],
//     reordered:     [{ kind, fromPosition, toPosition }],
//     configChanged: [{ kind, changes: [{ field, from, to }] }],
//     unchanged:     [{ kind, position }],
//     summary:       { added, removed, reordered, configChanged, unchanged },
//   }

function chainDiff(a, b) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.order)) {
    throw new Error('chainDiff: first arg must be a chain snapshot with an `order` array.');
  }
  if (!b || typeof b !== 'object' || !Array.isArray(b.order)) {
    throw new Error('chainDiff: second arg must be a chain snapshot with an `order` array.');
  }

  const aByKind = new Map(a.order.map((m) => [m.kind, m]));
  const bByKind = new Map(b.order.map((m) => [m.kind, m]));

  const added = [];
  const removed = [];
  const reordered = [];
  const configChanged = [];
  const unchanged = [];

  for (const [kind, aMw] of aByKind.entries()) {
    if (!bByKind.has(kind)) {
      removed.push({ kind, position: aMw.position });
    }
  }

  for (const [kind, bMw] of bByKind.entries()) {
    const aMw = aByKind.get(kind);
    if (!aMw) {
      added.push({ kind, position: bMw.position });
      continue;
    }
    // Present in both — check position + config
    const positionChanged = aMw.position !== bMw.position;
    const changes = diffConfig(aMw.config, bMw.config);

    if (positionChanged) {
      reordered.push({ kind, fromPosition: aMw.position, toPosition: bMw.position });
    }
    if (changes.length > 0) {
      configChanged.push({ kind, changes });
    }
    if (!positionChanged && changes.length === 0) {
      unchanged.push({ kind, position: bMw.position });
    }
  }

  const summary = {
    added:         added.length,
    removed:       removed.length,
    reordered:     reordered.length,
    configChanged: configChanged.length,
    unchanged:     unchanged.length,
  };
  const ok = added.length === 0 && removed.length === 0
    && reordered.length === 0 && configChanged.length === 0;

  return { ok, added, removed, reordered, configChanged, unchanged, summary };
}

// Compare two config objects field-by-field. Nested values are compared
// via JSON.stringify for stable equality (order-insensitive for arrays
// is intentionally NOT applied — arrays are treated as ordered).
function diffConfig(a, b) {
  const changes = [];
  const aObj = a && typeof a === 'object' ? a : {};
  const bObj = b && typeof b === 'object' ? b : {};
  const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const key of allKeys) {
    const aVal = aObj[key];
    const bVal = bObj[key];
    if (!deepEqual(aVal, bVal)) {
      changes.push({ field: key, from: aVal, to: bVal });
    }
  }
  return changes;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  // Use JSON.stringify for a simple structural comparison. Works for
  // scalars, arrays, plain objects. Falls back to string comparison
  // for BigInt / Symbol / function (throws on JSON.stringify).
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return String(a) === String(b);
  }
}

// ---- Formatter -------------------------------------------------------

/**
 * Format a chainDiff result as a human-readable multi-line string.
 * Terminal-friendly with +/-/~ markers.
 */
function formatChainDiff(diff, options = {}) {
  const { colors = false } = options;
  const c = colors
    ? { add: '\x1b[32m', rem: '\x1b[31m', mod: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' }
    : { add: '', rem: '', mod: '', dim: '', reset: '' };

  const lines = [];
  if (diff.ok) {
    lines.push(`${c.dim}chain unchanged (${diff.summary.unchanged} middleware, no drift)${c.reset}`);
    return lines.join('\n');
  }

  for (const a of diff.added) {
    lines.push(`${c.add}+ ${a.kind}${c.reset}  (position ${a.position}, added)`);
  }
  for (const r of diff.removed) {
    lines.push(`${c.rem}- ${r.kind}${c.reset}  (was at position ${r.position})`);
  }
  for (const r of diff.reordered) {
    lines.push(`${c.mod}~ ${r.kind}${c.reset}  reordered: ${r.fromPosition} → ${r.toPosition}`);
  }
  for (const cch of diff.configChanged) {
    lines.push(`${c.mod}~ ${cch.kind}${c.reset}  config changed:`);
    for (const change of cch.changes) {
      const fromStr = formatValue(change.from);
      const toStr   = formatValue(change.to);
      lines.push(`    ${change.field}: ${fromStr} → ${toStr}`);
    }
  }
  const s = diff.summary;
  lines.push('');
  lines.push(`${c.dim}summary: +${s.added} added, -${s.removed} removed, ~${s.reordered} reordered, ~${s.configChanged} config, =${s.unchanged} unchanged${c.reset}`);
  return lines.join('\n');
}

function formatValue(v) {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (typeof v === 'string') {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }
  return String(v);
}

module.exports = { chainDiff, formatChainDiff };
