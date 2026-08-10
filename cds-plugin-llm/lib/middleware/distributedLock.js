// Distributed lock middleware. Ensures only ONE instance of a
// multi-replica deployment executes a specific key at a time.
// Prevents duplicate execution across pods for expensive operations —
// batch runs, cache warming, tenant-scoped context builds — where
// double-processing wastes spend or corrupts data.
//
// Companion to bulkhead (per-instance concurrency) and idempotency
// (per-request dedup within a TTL): distributedLock is per-key
// across instances.
//
//   const { distributedLock, InMemoryLockStore } = require('@saptarishi/cds-plugin-llm');
//
//   // Dev / single-instance:
//   llm.use(distributedLock({
//     store:  new InMemoryLockStore(),
//     keyOf: (ctx) => `llm:${ctx.raw?.tenant ?? 'default'}`,
//     ttlMs: 60_000,
//   }));
//
//   // Production (Redis) — bring your own store implementing { acquire, release }:
//   const redis = require('ioredis').createClient(...);
//   const store = {
//     async acquire(key, ttlMs) {
//       const token = crypto.randomUUID();
//       const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
//       return ok ? token : null;
//     },
//     async release(key, token) {
//       // Only release if we still own the lock (compare-and-delete via Lua).
//       const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
//       const n = await redis.eval(script, 1, key, token);
//       return n === 1;
//     },
//   };
//   llm.use(distributedLock({ store, keyOf: ..., ttlMs: 60_000 }));

const { LLMError } = require('../errors');

class DistributedLockHeldError extends LLMError {
  constructor(key) {
    super(`distributedLock: lock '${key}' is held by another instance (action=reject).`, 'DISTRIBUTED_LOCK_HELD');
    this.key = key;
  }
}

class DistributedLockTimeoutError extends LLMError {
  constructor(key, waitedMs) {
    super(`distributedLock: waited ${waitedMs}ms for lock '${key}' (action=wait); timed out.`, 'DISTRIBUTED_LOCK_TIMEOUT');
    this.key = key;
    this.waitedMs = waitedMs;
  }
}

// ---- InMemoryLockStore (dev-only, single-instance) --------------------

class InMemoryLockStore {
  constructor() {
    this.map = new Map();   // key → { token, expiresAt }
  }
  async acquire(key, ttlMs) {
    const now = Date.now();
    const held = this.map.get(key);
    if (held && held.expiresAt > now) return null;
    // Expired or unheld — acquire.
    const token = `tok-${Math.random().toString(36).slice(2)}-${now}`;
    this.map.set(key, { token, expiresAt: now + ttlMs });
    return token;
  }
  async release(key, token) {
    const held = this.map.get(key);
    if (!held || held.token !== token) return false;
    this.map.delete(key);
    return true;
  }
  size() { return this.map.size; }
  clear() { this.map.clear(); }
}

// ---- Main middleware --------------------------------------------------

function distributedLock(options = {}) {
  const {
    store,
    keyOf,
    ttlMs             = 60_000,
    action            = 'wait',
    waitTimeoutMs     = 30_000,
    waitPollMs        = 100,
    skipMethods       = ['embed'],
    onAcquire         = null,
    onWait            = null,
    onReject          = null,
    onRelease         = null,
    now               = () => Date.now(),
    sleep             = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (!store || typeof store.acquire !== 'function' || typeof store.release !== 'function') {
    throw new Error('distributedLock: store must expose { acquire(key, ttlMs), release(key, token) }.');
  }
  if (typeof keyOf !== 'function') {
    throw new Error('distributedLock: keyOf must be a function (ctx) => string.');
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 100) {
    throw new Error(`distributedLock: ttlMs must be >= 100 (got ${ttlMs}).`);
  }
  if (action !== 'wait' && action !== 'reject') {
    throw new Error(`distributedLock: action must be 'wait' or 'reject' (got ${JSON.stringify(action)}).`);
  }
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error(`distributedLock: waitTimeoutMs must be >= 0 (got ${waitTimeoutMs}).`);
  }
  if (!Number.isFinite(waitPollMs) || waitPollMs < 10) {
    throw new Error(`distributedLock: waitPollMs must be >= 10 (got ${waitPollMs}).`);
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('distributedLock: skipMethods must be an array.');
  }
  for (const cb of [onAcquire, onWait, onReject, onRelease]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('distributedLock: callbacks must be functions or null.');
    }
  }

  const skipSet = new Set(skipMethods);

  const stats = {
    totalRequests: 0,
    acquired:      0,
    rejected:      0,
    timedOut:      0,
    waited:        0,
    totalWaitMs:   0,
    released:      0,
    releaseErrors: 0,
    skipped:       0,
  };

  const mw = async (ctx, next) => {
    stats.totalRequests++;
    if (skipSet.has(ctx?.method)) {
      stats.skipped++;
      return next();
    }

    let key;
    try { key = keyOf(ctx); }
    catch (err) {
      // keyOf failure → surface as unlockable; fall through unlocked.
      stats.skipped++;
      return next();
    }
    if (typeof key !== 'string' || key.length === 0) {
      stats.skipped++;
      return next();
    }

    // Attempt to acquire.
    let token = await store.acquire(key, ttlMs);

    if (!token) {
      // Held elsewhere. Reject or wait.
      if (action === 'reject') {
        stats.rejected++;
        if (onReject) {
          try { onReject({ key, method: ctx.method }); } catch { /* swallow */ }
        }
        throw new DistributedLockHeldError(key);
      }

      // action === 'wait'
      const startedAt = now();
      stats.waited++;
      if (onWait) {
        try { onWait({ key, method: ctx.method, waitTimeoutMs, waitPollMs }); } catch { /* swallow */ }
      }
      while (true) {
        await sleep(waitPollMs);
        const elapsed = now() - startedAt;
        token = await store.acquire(key, ttlMs);
        if (token) {
          stats.totalWaitMs += elapsed;
          break;
        }
        if (elapsed >= waitTimeoutMs) {
          stats.timedOut++;
          throw new DistributedLockTimeoutError(key, elapsed);
        }
      }
    }

    stats.acquired++;
    if (onAcquire) {
      try { onAcquire({ key, method: ctx.method, ttlMs, token }); } catch { /* swallow */ }
    }

    try {
      return await next();
    } finally {
      try {
        const released = await store.release(key, token);
        if (released) stats.released++;
        if (onRelease) {
          try { onRelease({ key, method: ctx.method, released }); } catch { /* swallow */ }
        }
      } catch (err) {
        stats.releaseErrors++;
      }
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.acquired = stats.rejected = 0;
    stats.timedOut = stats.waited = stats.totalWaitMs = 0;
    stats.released = stats.releaseErrors = stats.skipped = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://distributed-lock',
    name: 'Distributed lock middleware',
    description: 'Per-key exclusive lock across instances. Counters + config.',
    mimeType: 'application/json',
    handler: () => ({
      ttlMs,
      action,
      waitTimeoutMs,
      waitPollMs,
      storeType: store.constructor?.name ?? 'anonymous',
      currentHeld: typeof store.size === 'function' ? store.size() : null,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  distributedLock,
  InMemoryLockStore,
  DistributedLockHeldError,
  DistributedLockTimeoutError,
};
