// testing.recording + testing.replay — record real LLM API responses to
// fixture files, then replay them in tests. Companion to 1.68 fakeLLM
// for cases where scripting responses by hand is tedious (multimodal,
// long structured outputs, etc).
//
// Typical workflow:
//
//   const { testing } = require('@saptarishi/cds-plugin-llm');
//
//   // 1. During test authoring: RECORD real calls
//   const rec = testing.recording({ store: 'test/fixtures/llm.json' });
//   llm.use(rec);
//   await llm.chat({ ... });   // hits real provider, records to fixture
//
//   // 2. In CI / normal test runs: REPLAY the fixtures (no network)
//   const rep = testing.replay({ store: 'test/fixtures/llm.json' });
//   llm.use(rep);
//   await llm.chat({ ... });   // returns the recorded response
//
// Store shape:
//   - path string: JSON file. Read on load, write on each recording.
//   - { get(hash), set(hash, entry), all() } — custom store (in-memory,
//     Redis, etc.).
//
// Hash strategy:
//   - default: SHA-256 over { method, model, messages, input, system,
//     maxTokens } — the fields that determine a call's semantics.
//   - custom: hashOn: (req, method) => string
//
// Fixture file shape:
//   {
//     "schema":  "cds-plugin-llm-testing/v1",
//     "entries": {
//       "<hash>": {
//         "request":    { method, model, messages, ... },
//         "response":   { text, usage, ... },
//         "recordedAt": "2026-08-07T..."
//       }
//     }
//   }

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LLMError } = require('./errors');

// ---- File-backed store ------------------------------------------------

function fileStore(storePath) {
  let loaded = null;
  function load() {
    if (loaded) return loaded;
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
        loaded = { schema: 'cds-plugin-llm-testing/v1', entries: {} };
      } else {
        loaded = parsed;
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        loaded = { schema: 'cds-plugin-llm-testing/v1', entries: {} };
      } else {
        throw new Error(`testing.recording/replay: failed to load ${storePath}: ${e.message}`);
      }
    }
    return loaded;
  }
  function save() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(load(), null, 2) + '\n', 'utf8');
  }
  return {
    get(hash) { return load().entries[hash] ?? null; },
    set(hash, entry) { load().entries[hash] = entry; save(); },
    all()     { return { ...load().entries }; },
    size()    { return Object.keys(load().entries).length; },
    _path:    storePath,
  };
}

// Normalize a store option — accept a path string or a custom shape.
function normalizeStore(store) {
  if (typeof store === 'string') return fileStore(store);
  if (store && typeof store === 'object'
      && typeof store.get === 'function'
      && typeof store.set === 'function') return store;
  throw new Error('testing: store must be a file-path string or { get, set } object.');
}

// ---- Default hash -----------------------------------------------------

const RELEVANT_REQUEST_FIELDS = ['model', 'messages', 'input', 'system', 'maxTokens', 'temperature', 'format', 'tools'];

function defaultHash(req, method) {
  const shape = { method };
  for (const f of RELEVANT_REQUEST_FIELDS) {
    if (req?.[f] !== undefined) shape[f] = req[f];
  }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

// ---- MissingFixtureError -----------------------------------------------

class MissingFixtureError extends LLMError {
  // Extend LLMError so the 1.57 taxonomy + 1.58 handler work with it.
  constructor(hash, method, model) {
    super(
      `testing.replay: no fixture for ${method} model='${model}' (hash=${hash.slice(0, 12)}...). Run in recording mode first.`,
      'MISSING_FIXTURE',
    );
    this.hash = hash;
    this.methodName = method;
    this.model = model;
  }
}

// ---- recording ---------------------------------------------------------

function recording(options = {}) {
  const {
    store,
    hashOn      = defaultHash,
    onWrite     = null,
    onSkip      = null,
    skipMethods = [],   // methods to bypass (e.g. don't record streams)
  } = options;
  if (store == null) {
    throw new Error('testing.recording: store is required (file path or { get, set } object).');
  }
  if (typeof hashOn !== 'function') {
    throw new Error('testing.recording: hashOn must be a function.');
  }

  const storeImpl = normalizeStore(store);
  const skipSet = new Set(skipMethods);

  const stats = { requests: 0, recorded: 0, skipped: 0 };

  const mw = async (ctx, next) => {
    stats.requests++;
    if (skipSet.has(ctx?.method)) {
      stats.skipped++;
      if (onSkip) { try { onSkip({ method: ctx?.method, reason: 'method-skipped' }); } catch {} }
      return next();
    }
    const response = await next();
    let hash;
    try {
      hash = hashOn(ctx.request ?? ctx.raw ?? {}, ctx.method);
    } catch (e) {
      // Don't break the request if hashing fails — just skip recording.
      stats.skipped++;
      if (onSkip) { try { onSkip({ method: ctx?.method, reason: 'hash-error', error: e.message }); } catch {} }
      return response;
    }
    const entry = {
      request:    ctx.request ?? ctx.raw ?? {},
      response,
      recordedAt: new Date().toISOString(),
      method:     ctx.method,
    };
    try {
      storeImpl.set(hash, entry);
      stats.recorded++;
      if (onWrite) { try { onWrite({ hash, method: ctx.method }); } catch {} }
    } catch (e) {
      // Don't break the request if write fails — just skip.
      stats.skipped++;
      if (onSkip) { try { onSkip({ method: ctx?.method, reason: 'write-error', error: e.message }); } catch {} }
    }
    return response;
  };
  mw.stats = stats;
  mw.reset = () => { stats.requests = stats.recorded = stats.skipped = 0; };
  mw.store = storeImpl;
  return mw;
}

// ---- replay -----------------------------------------------------------

function replay(options = {}) {
  const {
    store,
    hashOn      = defaultHash,
    strict      = true,
    onHit       = null,
    onMiss      = null,
    skipMethods = [],
  } = options;
  if (store == null) {
    throw new Error('testing.replay: store is required (file path or { get, set } object).');
  }
  if (typeof hashOn !== 'function') {
    throw new Error('testing.replay: hashOn must be a function.');
  }

  const storeImpl = normalizeStore(store);
  const skipSet = new Set(skipMethods);

  const stats = { requests: 0, hits: 0, misses: 0, fallthroughs: 0, skipped: 0 };

  const mw = async (ctx, next) => {
    stats.requests++;
    if (skipSet.has(ctx?.method)) {
      stats.skipped++;
      return next();
    }
    let hash;
    try {
      hash = hashOn(ctx.request ?? ctx.raw ?? {}, ctx.method);
    } catch (e) {
      // Hash failure → fall through to real provider (non-strict) or throw
      if (strict) {
        throw new MissingFixtureError('unhashable', ctx.method, ctx?.request?.model ?? 'unknown');
      }
      stats.fallthroughs++;
      return next();
    }
    const entry = storeImpl.get(hash);
    if (entry) {
      stats.hits++;
      if (onHit) { try { onHit({ hash, method: ctx.method }); } catch {} }
      return entry.response;
    }
    // Cache miss
    stats.misses++;
    if (onMiss) { try { onMiss({ hash, method: ctx.method, model: ctx?.request?.model }); } catch {} }
    if (strict) {
      throw new MissingFixtureError(hash, ctx.method, ctx?.request?.model ?? 'unknown');
    }
    stats.fallthroughs++;
    return next();
  };
  mw.stats = stats;
  mw.reset = () => { stats.requests = stats.hits = stats.misses = stats.fallthroughs = stats.skipped = 0; };
  mw.store = storeImpl;
  return mw;
}

module.exports = {
  recording,
  replay,
  MissingFixtureError,
  defaultHash,
  fileStore,
};
