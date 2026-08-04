// Ergonomic wrapper around `usageMetering` that auto-persists every record
// to a CAP entity via cds.run(INSERT.into(entity).entries(...)).
//
//   using { LlmUsage } from '@saptarishi/cds-plugin-llm/lib/usageEntity';
//   service FinanceService @(path: '/finance') {
//     entity LlmSpend as projection on LlmUsage;
//   }
//
//   // srv/handlers.js
//   const cds = require('@sap/cds');
//   const { usageMeteringToCap } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(usageMeteringToCap(cds, {
//     entity:     'saptarishi.llm.usage.LlmUsage',   // default
//     tenantOf:   (ctx) => ctx.raw?.tenant ?? 'default',
//     providerOf: (ctx) => ctx.raw?.providerAlias,
//   }));
//
// The wrapper delegates to `usageMetering` for aggregation + summary; the
// `onRecord` hook is set to a persister that INSERTs into `entity`. Users
// who want a custom insert path (batching, cross-tenancy, ...) should call
// `usageMetering()` directly and write their own onRecord.

const crypto = require('node:crypto');
const { usageMetering } = require('./usageMetering');

const DEFAULT_ENTITY = 'saptarishi.llm.usage.LlmUsage';

function usageMeteringToCap(cds, options = {}) {
  if (!cds || typeof cds.run !== 'function') {
    throw new Error(
      'usageMeteringToCap: first arg must be a @sap/cds instance (with cds.run). ' +
      "Pass require('@sap/cds').",
    );
  }
  const {
    entity = DEFAULT_ENTITY,
    onError = null,
    ...meteringOpts
  } = options;

  const log = (cds.log && cds.log('llm:usage')) || silentLog();

  const persist = async (record) => {
    try {
      // Resolve INSERT lazily so tests can attach a fake before the first call
      // (and so this file doesn't require @sap/cds at module load).
      const INSERT = cds.ql?.INSERT ?? cds.INSERT ?? (global && global.INSERT);
      if (!INSERT || typeof INSERT.into !== 'function') {
        throw new Error(
          'cds.ql.INSERT not available — is @sap/cds >= 7 loaded before the first metered call?',
        );
      }
      const id = (cds.utils && typeof cds.utils.uuid === 'function')
        ? cds.utils.uuid()
        : crypto.randomUUID();
      await cds.run(INSERT.into(entity).entries({ ID: id, ...record }));
    } catch (err) {
      if (onError) {
        try { onError(err, record); } catch { /* swallow */ }
      } else {
        log.warn(`llm usage persist failed for ${record.model}: ${err.message}`);
      }
    }
  };

  // Warn (once) if the caller supplied their own onRecord — persistence
  // would silently no-op, which is almost never what they want.
  if (options.onRecord) {
    log.warn(
      'usageMeteringToCap: options.onRecord is ignored — this wrapper installs its own ' +
      'persister. Call usageMetering() directly if you want a custom sink.',
    );
  }

  return usageMetering({ ...meteringOpts, onRecord: persist });
}

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

module.exports = { usageMeteringToCap, DEFAULT_ENTITY };
