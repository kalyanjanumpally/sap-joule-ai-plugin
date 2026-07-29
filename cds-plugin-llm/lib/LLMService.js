const cds = require('@sap/cds');
const { withRetry, ResponseCache, hashChatRequest } = require('./util');

/**
 * Abstract LLM service. Providers extend this and implement _chat / _embed
 * (and optionally _stream). See README for the full public API contract.
 *
 * Middleware (new in v1.2.0):
 *   llm.use(async (ctx, next) => {
 *     // ctx.method: 'chat' | 'stream' | 'embed'
 *     // ctx.request: the merged request options
 *     // ctx.meta:    arbitrary state you can share across middleware
 *     const res = await next();     // response from provider (or the next mw)
 *     return res;                    // return unchanged or return a modified copy
 *   });
 *
 * Middleware runs in registration order (outermost first). Also runs around
 * caching + retry + format-parse — those are middleware-visible internal
 * concerns. For streams, `next()` returns an async iterable that middleware
 * may wrap to observe/transform chunks.
 */
class LLMService extends cds.Service {
  async init() {
    this.modelId = this.options.modelId ?? this.options.model;
    this.defaultMaxTokens = this.options.maxTokens ?? 16000;
    this.defaultRetries = this.options.retries;
    this.middleware = [];
    if (this.options.responseCache) {
      const cfg = this.options.responseCache === true ? {} : this.options.responseCache;
      this.responseCache = new ResponseCache(cfg);
    }
    return super.init();
  }

  /**
   * Register a middleware. Returns `this` for chaining.
   *   llm.use(mw1).use(mw2);
   */
  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new Error('llm.use() requires a function of shape: async (ctx, next) => ...');
    }
    this.middleware.push(middleware);
    return this;
  }

  // ---- public API surface (dispatches through the middleware chain) --------

  async chat(req) {
    if (!req || !Array.isArray(req.messages) || req.messages.length === 0) {
      throw new Error('chat() requires { messages: [{ role, content }, ...] }');
    }
    const ctx = {
      method: 'chat',
      request: this._mergeRequest(req),
      meta: {},
    };
    return this._runMiddleware(ctx, () => this._chatCore(ctx.request, req));
  }

  async embed(req) {
    if (!req || req.input == null) {
      throw new Error('embed() requires { input: string | string[] }');
    }
    const ctx = {
      method: 'embed',
      request: { model: req.model ?? this.modelId, input: req.input, retries: req.retries },
      meta: {},
    };
    return this._runMiddleware(ctx, () => this._embedCore(ctx.request));
  }

  async *stream(req) {
    if (!req || !Array.isArray(req.messages) || req.messages.length === 0) {
      throw new Error('stream() requires { messages: [{ role, content }, ...] }');
    }
    const ctx = {
      method: 'stream',
      request: this._mergeRequest(req),
      meta: {},
    };
    // Middleware wraps around the async iterable. Middleware may inspect or
    // transform chunks by yielding a wrapped generator from next().
    const iter = await this._runMiddleware(ctx, () => this._streamCore(ctx.request));
    yield* iter;
  }

  // ---- middleware runner (Koa-style compose) -------------------------------

  _runMiddleware(ctx, coreFn) {
    const chain = this.middleware;
    const dispatch = (i) => {
      if (i >= chain.length) return Promise.resolve(coreFn());
      const mw = chain[i];
      const nextCalled = { done: false };
      const next = () => {
        if (nextCalled.done) {
          return Promise.reject(new Error('middleware called next() more than once'));
        }
        nextCalled.done = true;
        return dispatch(i + 1);
      };
      try {
        return Promise.resolve(mw(ctx, next));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return dispatch(0);
  }

  // ---- request normalization ----------------------------------------------

  _mergeRequest(req) {
    return {
      model: req.model ?? this.modelId,
      maxTokens: req.maxTokens ?? this.defaultMaxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      format: req.format,
      thinking: req.thinking,
      cache: req.cache,
      retries: req.retries,
    };
  }

  // ---- core implementations (middleware sees these via next()) -------------

  async _chatCore(merged, originalReq) {
    // Response-cache lookup (only for non-tool requests)
    const cacheKey = this.responseCache && !merged.tools ? hashChatRequest(merged) : null;
    if (cacheKey) {
      const cached = this.responseCache.get(cacheKey);
      if (cached) return { ...cached, cached: true };
    }

    const retryOpts = merged.retries ?? this.defaultRetries ?? {};
    const result = await withRetry(() => this._chat(merged), retryOpts);

    if (cacheKey && !result.toolCalls) {
      this.responseCache.set(cacheKey, result);
    }

    // Structured-output post-process
    if (merged.format && typeof result.text === 'string' && result.text.length > 0) {
      try {
        result.data = JSON.parse(result.text);
      } catch (_e) {
        const match = result.text.match(/\{[\s\S]*\}/);
        if (match) {
          try { result.data = JSON.parse(match[0]); } catch (_e2) { /* leave undefined */ }
        }
      }
    }
    return result;
  }

  async _embedCore(merged) {
    const retryOpts = merged.retries ?? this.defaultRetries ?? {};
    return withRetry(
      () => this._embed({ model: merged.model, input: merged.input }),
      retryOpts,
    );
  }

  _streamCore(merged) {
    // Return the async iterable directly — middleware can wrap it.
    return this._stream(merged);
  }

  // ---- provider hooks (subclasses implement) -------------------------------

  async _chat() {
    throw new Error(`${this.constructor.name} must implement _chat()`);
  }

  async *_stream() {
    throw new Error(`${this.constructor.name} does not support streaming`);
  }

  async _embed() {
    throw new Error(`${this.constructor.name} does not support embeddings`);
  }
}

module.exports = LLMService;
