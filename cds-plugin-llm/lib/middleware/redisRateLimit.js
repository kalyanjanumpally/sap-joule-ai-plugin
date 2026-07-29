// Redis-backed token-bucket rate-limit middleware. Shared bucket across CF
// instances — safe to use behind multi-instance CAP deployments.
//
//   const Redis = require('ioredis');
//   const { redisRateLimit } = require('@saptarishi/cds-plugin-llm/lib/middleware/redisRateLimit');
//   llm.use(redisRateLimit({
//     redis: new Redis(process.env.REDIS_URL),
//     capacity: 60,
//     refillPerSecond: 1,
//     keyFn: (ctx) => ctx.meta.user ?? 'anon',
//     keyPrefix: 'ratelimit:llm:',           // default 'saptarishi:llm:rl:'
//     mode: 'throw',                          // 'throw' | 'wait'
//   }));
//
// Uses a Lua script for atomicity — a single EVAL updates the bucket and
// reports whether a token was taken, so concurrent instances can't race.
// Client is duck-typed: any object with an eval(script, numKeys, ...args)
// method returning a Promise works (ioredis, node-redis v4 with modifier).

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = now_ms
else
  local elapsed_sec = (now_ms - ts) / 1000
  tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)
  ts = now_ms
end

local ok = 0
local wait_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  ok = 1
else
  local missing = 1 - tokens
  wait_ms = math.ceil((missing / refill_per_sec) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
redis.call('PEXPIRE', key, ttl_ms)

return { ok, wait_ms }
`;

function redisRateLimit(options = {}) {
  const {
    redis,
    capacity,
    refillPerSecond,
    keyFn = () => 'global',
    keyPrefix = 'saptarishi:llm:rl:',
    mode = 'throw',
  } = options;

  if (!redis || typeof redis.eval !== 'function') {
    throw new Error('redisRateLimit: options.redis is required and must expose an eval() method');
  }
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error('redisRateLimit: capacity must be a positive number');
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new Error('redisRateLimit: refillPerSecond must be a positive number');
  }
  if (mode !== 'throw' && mode !== 'wait') {
    throw new Error(`redisRateLimit: mode must be 'throw' or 'wait' (got ${mode})`);
  }

  // Keep buckets around long enough that a bucket that's been unused since
  // the last refill still exists to be refilled. `capacity / refillPerSecond`
  // seconds is the time to fully refill from empty; anything past 5x that is
  // safe to expire. Floored at 60s so short-lived buckets don't churn Redis.
  const ttlMs = Math.max(60_000, Math.ceil((capacity / refillPerSecond) * 5000));

  async function take(key) {
    const now = Date.now();
    const result = await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      keyPrefix + key,
      String(capacity),
      String(refillPerSecond),
      String(now),
      String(ttlMs),
    );
    const [ok, waitMs] = Array.isArray(result) ? result : [result?.[0], result?.[1]];
    return { ok: Number(ok) === 1, waitMs: Number(waitMs) || 0 };
  }

  return async (ctx, next) => {
    const key = keyFn(ctx);
    const res = await take(key);
    if (res.ok) return next();
    if (mode === 'throw') {
      const err = new Error(`Rate limit exceeded for key '${key}' — retry in ${res.waitMs}ms`);
      err.code = 'RATE_LIMITED';
      err.retryAfterMs = res.waitMs;
      err.key = key;
      throw err;
    }
    await new Promise(resolve => setTimeout(resolve, res.waitMs));
    const second = await take(key);
    if (!second.ok) {
      const err = new Error(`Rate limit still exhausted for key '${key}' after wait`);
      err.code = 'RATE_LIMITED';
      err.key = key;
      throw err;
    }
    return next();
  };
}

module.exports = { redisRateLimit };
