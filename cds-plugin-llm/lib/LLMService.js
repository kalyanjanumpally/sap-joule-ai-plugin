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
      // Raw, untouched request the caller passed. Middleware that needs
      // fields we don't merge into `request` (tenant id, correlation id,
      // etc.) reads them from here.
      raw: req,
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
      raw: req,
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
      raw: req,
      meta: {},
    };
    // Middleware wraps around the async iterable. Middleware may inspect or
    // transform chunks by yielding a wrapped generator from next().
    const iter = await this._runMiddleware(ctx, () => this._streamCore(ctx.request));
    yield* iter;
  }

  // ---- Batch API (bulk-async offline workloads, new in 1.25.0) -------------
  //
  // Providers that support batch endpoints override the `_batch*` core methods
  // below. Message Batches on Anthropic (~50% cheaper, 24h SLA) and Batch API
  // on OpenAI (same trade-off) fit nightly-scoring pipelines: classification
  // over many rows, offline enrichment, bulk summarization.
  //
  //   const handle = await llm.batch({ requests: [
  //     { customId: 'inv-1', messages: [...], maxTokens: 200 },
  //     { customId: 'inv-2', messages: [...], maxTokens: 200 },
  //   ] });
  //   // Poll until complete:
  //   while ((await llm.getBatch(handle.id)).status === 'in_progress')
  //     await new Promise(r => setTimeout(r, 30000));
  //   const results = await llm.getBatchResults(handle.id);
  //
  // Middleware does NOT wrap batch calls — the request path is fundamentally
  // async and per-request cost accounting fires when getBatchResults() runs
  // (the sync usageMetering middleware won't see individual batch items).
  // Consumers who need per-item accounting should iterate results and record
  // manually.

  async batch(req) {
    if (!req || !Array.isArray(req.requests) || req.requests.length === 0) {
      throw new Error('batch() requires { requests: [{ customId, messages, ... }, ...] }');
    }
    for (const [i, r] of req.requests.entries()) {
      if (!r || typeof r.customId !== 'string' || r.customId.length === 0) {
        throw new Error(`batch(): requests[${i}].customId must be a non-empty string`);
      }
      if (!Array.isArray(r.messages) || r.messages.length === 0) {
        throw new Error(`batch(): requests[${i}].messages must be a non-empty array`);
      }
    }
    return this._batchSubmit(req);
  }

  async getBatch(id) {
    if (typeof id !== 'string' || !id) throw new Error('getBatch(id) requires a non-empty string id');
    return this._batchStatus(id);
  }

  async getBatchResults(id) {
    if (typeof id !== 'string' || !id) throw new Error('getBatchResults(id) requires a non-empty string id');
    return this._batchResults(id);
  }

  async cancelBatch(id) {
    if (typeof id !== 'string' || !id) throw new Error('cancelBatch(id) requires a non-empty string id');
    return this._batchCancel(id);
  }

  // Pre-flight cost estimate — same shape as the top-level estimateCost()
  // helper but pulls model default from this.modelId. No middleware, no
  // provider round-trip. New in 1.54.0.
  //
  // Falls back to this.options.{modelId,model} when the service hasn't
  // been init()'d yet — safe to call on a fresh instance, since the
  // estimator itself is stateless and doesn't need any middleware wiring.
  estimateCost(req = {}) {
    const { estimateCost: est } = require('./estimateCost');
    return est({
      ...req,
      model: req.model ?? this.modelId ?? this.options?.modelId ?? this.options?.model,
    });
  }

  async _batchSubmit()  { throw batchNotSupported(this, 'batch'); }
  async _batchStatus()  { throw batchNotSupported(this, 'getBatch'); }
  async _batchResults() { throw batchNotSupported(this, 'getBatchResults'); }
  async _batchCancel()  { throw batchNotSupported(this, 'cancelBatch'); }

  // ---- middleware runner (Koa-style compose) -------------------------------

  _runMiddleware(ctx, coreFn) {
    const chain = this.middleware;
    const dispatch = (i) => {
      if (i >= chain.length) return Promise.resolve(coreFn());
      const mw = chain[i];
      // `next()` may be called multiple times SEQUENTIALLY to support retry
      // patterns (retryOnRateLimit, backoff wrappers). Concurrent overlapping
      // calls still get flagged — that's a real bug. Relaxed in 1.47.0.
      let pending = false;
      const next = () => {
        if (pending) {
          return Promise.reject(new Error('middleware called next() concurrently (must await previous call before invoking again)'));
        }
        pending = true;
        const p = dispatch(i + 1);
        // Reset the flag whether the call resolves or rejects, so the same
        // middleware can `try { await next(); } catch { await next(); }` for retry.
        p.then(() => { pending = false; }, () => { pending = false; });
        return p;
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

function batchNotSupported(svc, method) {
  const kind = svc.options?.kind ?? svc.constructor?.name ?? 'this';
  return new Error(
    `${kind} does not support ${method}(). Batch endpoints are only implemented on ` +
    `AnthropicLLMService (Message Batches) and OpenAI-compatible providers whose endpoint ` +
    `speaks the OpenAI Batch API. Use chat() instead — or open an issue if your provider ` +
    `has a batch endpoint we could plug in.`,
  );
}

module.exports = LLMService;
