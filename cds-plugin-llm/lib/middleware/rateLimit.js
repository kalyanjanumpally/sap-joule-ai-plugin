// Token-bucket rate-limit middleware for llm.use().
//
//   const { rateLimit } = require('@saptarishi/cds-plugin-llm/lib/middleware/rateLimit');
//   llm.use(rateLimit({
//     capacity: 60,               // burst allowance
//     refillPerSecond: 1,         // steady-state rate
//     keyFn: (ctx) => ctx.request.system?.slice(0, 32) ?? 'global',
//     mode: 'throw' | 'wait',     // default 'throw'
//   }));
//
// Buckets are held in-process (fine for single-instance CAP apps). For
// multi-instance rate limiting, wire your own middleware against Redis.

function rateLimit(options = {}) {
  const {
    capacity,
    refillPerSecond,
    keyFn = () => 'global',
    mode = 'throw',
  } = options;

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error('rateLimit: capacity must be a positive number');
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new Error('rateLimit: refillPerSecond must be a positive number');
  }
  if (mode !== 'throw' && mode !== 'wait') {
    throw new Error(`rateLimit: mode must be 'throw' or 'wait' (got ${mode})`);
  }

  const buckets = new Map();

  function take(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, updatedAt: now };
      buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.updatedAt) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSecond);
      b.updatedAt = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const missing = 1 - b.tokens;
    const waitMs = Math.ceil((missing / refillPerSecond) * 1000);
    return { ok: false, waitMs };
  }

  const mw = async (ctx, next) => {
    const key = keyFn(ctx);
    const res = take(key);
    if (res.ok) return next();
    if (mode === 'throw') {
      const err = new Error(`Rate limit exceeded for key '${key}' — retry in ${res.waitMs}ms`);
      err.code = 'RATE_LIMITED';
      err.retryAfterMs = res.waitMs;
      err.key = key;
      throw err;
    }
    await new Promise(resolve => setTimeout(resolve, res.waitMs));
    const second = take(key);
    if (!second.ok) {
      const err = new Error(`Rate limit still exhausted for key '${key}' after wait`);
      err.code = 'RATE_LIMITED';
      err.key = key;
      throw err;
    }
    return next();
  };

  mw._buckets = buckets;
  return mw;
}

module.exports = { rateLimit };
