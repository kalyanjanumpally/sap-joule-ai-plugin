// Static test doubles for LLMService. `fakeLLM()` returns a
// LLMService-compatible object that returns SCRIPTED responses instead
// of hitting a real provider — big dev-ex improvement for consumers
// writing unit tests against the plugin.
//
//   const { testing } = require('@saptarishi/cds-plugin-llm');
//
//   const fake = testing.fakeLLM({
//     scripts: [
//       // Match by method / model / regex on user text / custom fn
//       { when: { method: 'chat', matches: /purchase order/i },
//         respond: { text: 'PO summary', usage: { input_tokens: 10, output_tokens: 20 } } },
//       { when: { method: 'embed' },
//         respond: { embeddings: [[0.1, 0.2, 0.3]], usage: { input_tokens: 5 } } },
//       // Predicate function — full req + method access
//       { when: (req, method) => method === 'chat' && req.messages.length > 5,
//         respond: (req) => ({ text: `long conv (${req.messages.length} msgs)` }) },
//     ],
//     defaultResponse: { text: 'fallback', usage: { input_tokens: 1, output_tokens: 1 } },
//     delayMs: 10,             // simulated latency (per call)
//     failRate: 0.0,            // 0..1 — random failure rate for testing retry paths
//     failWith: () => Object.assign(new Error('simulated 429'), { status: 429 }),
//   });
//
//   // Use in tests — same API as a real LLMService
//   const res = await fake.chat({ messages: [{ role: 'user', content: 'summarize this purchase order' }] });
//   // res.text === 'PO summary'
//
//   // Full call history captured
//   fake.calls                    // → [{ method, request, response, error?, timestamp, durationMs }]
//   fake.callsMatching(c => c.method === 'chat')
//   fake.reset()                  // clears history
//
// Middleware compatibility:
//   fake.use(mw) works — the middleware chain runs before the fake
//   provider returns, so tests can exercise the FULL middleware stack
//   including breaker + retry + cache + guardrails around a scripted
//   provider. Enables reliable, network-free tests of the resilience
//   quartet.

function fakeLLM(options = {}) {
  const {
    name             = 'fake-llm',
    modelId          = 'fake-model',
    scripts          = [],
    defaultResponse  = null,
    delayMs          = 0,
    failRate         = 0,
    failWith         = () => new Error('fakeLLM: simulated failure'),
    strict           = false,   // when true + no script match + no default → throw
  } = options;

  if (!Array.isArray(scripts)) {
    throw new Error('fakeLLM: scripts must be an array of { when, respond } entries.');
  }
  for (const [i, s] of scripts.entries()) {
    if (!s || typeof s !== 'object') {
      throw new Error(`fakeLLM: scripts[${i}] must be an object with { when, respond }.`);
    }
    if (s.when == null) {
      throw new Error(`fakeLLM: scripts[${i}].when is required (object matcher OR predicate fn).`);
    }
    if (s.respond == null) {
      throw new Error(`fakeLLM: scripts[${i}].respond is required (object OR fn returning one).`);
    }
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`fakeLLM: delayMs must be a non-negative number (got ${delayMs}).`);
  }
  if (!Number.isFinite(failRate) || failRate < 0 || failRate > 1) {
    throw new Error(`fakeLLM: failRate must be in [0, 1] (got ${failRate}).`);
  }

  const svc = {
    name,
    modelId,
    middleware: [],
    calls: [],
    _scripts: scripts,

    use(mw) {
      if (typeof mw !== 'function') {
        throw new Error('fakeLLM.use() requires a function of shape: async (ctx, next) => ...');
      }
      this.middleware.push(mw);
      return this;
    },

    async chat(req) {
      if (!req || !Array.isArray(req.messages) || req.messages.length === 0) {
        throw new Error('fakeLLM.chat() requires { messages: [{ role, content }, ...] }');
      }
      return _runMiddleware(this, { method: 'chat', request: { model: modelId, ...req }, raw: req, meta: {} });
    },

    async embed(req) {
      if (!req || req.input == null) {
        throw new Error('fakeLLM.embed() requires { input: string | string[] }');
      }
      return _runMiddleware(this, { method: 'embed', request: { model: modelId, ...req }, raw: req, meta: {} });
    },

    async *stream(req) {
      if (!req || !Array.isArray(req.messages) || req.messages.length === 0) {
        throw new Error('fakeLLM.stream() requires { messages: [{ role, content }, ...] }');
      }
      const res = await _runMiddleware(this, { method: 'stream', request: { model: modelId, ...req }, raw: req, meta: {} });
      // Emit as a single text_delta + done to match provider stream shape
      yield { type: 'text_delta', text: res.text ?? '' };
      yield { type: 'done', text: res.text ?? '', usage: res.usage, model: res.model };
    },

    // ---- Test-side introspection ----

    callsMatching(pred) {
      return this.calls.filter(pred);
    },

    lastCall() {
      return this.calls.length > 0 ? this.calls[this.calls.length - 1] : null;
    },

    reset() {
      this.calls = [];
    },

    /** Replace / append scripts at runtime (e.g. between test cases). */
    setScripts(newScripts) {
      if (!Array.isArray(newScripts)) throw new Error('fakeLLM.setScripts: must be an array.');
      this._scripts = newScripts;
    },
    addScript(script) {
      this._scripts.push(script);
    },
  };

  // ---- Core dispatch (runs middleware chain, then the scripted "provider") ----

  async function _runMiddleware(self, ctx) {
    const chain = self.middleware;
    let i = -1;
    const dispatch = async (idx) => {
      if (idx <= i) throw new Error('fakeLLM._runMiddleware: next() called concurrently more than once');
      i = idx;
      if (idx >= chain.length) return _provider(self, ctx);
      return chain[idx](ctx, () => dispatch(idx + 1));
    };
    return dispatch(0);
  }

  async function _provider(self, ctx) {
    const startedAt = Date.now();
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    if (failRate > 0 && Math.random() < failRate) {
      const err = failWith(ctx.raw, ctx.method);
      self.calls.push({
        method:     ctx.method,
        request:    ctx.raw,
        response:   null,
        error:      err,
        timestamp:  Date.now(),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }

    const script = _matchScript(self, ctx);
    let response;
    if (script) {
      response = typeof script.respond === 'function' ? script.respond(ctx.raw, ctx.method) : script.respond;
    } else if (defaultResponse != null) {
      response = typeof defaultResponse === 'function' ? defaultResponse(ctx.raw, ctx.method) : defaultResponse;
    } else if (strict) {
      const err = new Error(`fakeLLM: no matching script for ${ctx.method} + no defaultResponse (strict mode)`);
      self.calls.push({ method: ctx.method, request: ctx.raw, response: null, error: err, timestamp: Date.now(), durationMs: Date.now() - startedAt });
      throw err;
    } else {
      // Non-strict default: reasonable stubs per method
      if (ctx.method === 'chat' || ctx.method === 'stream') {
        response = { text: '', usage: { input_tokens: 0, output_tokens: 0 } };
      } else if (ctx.method === 'embed') {
        response = { embeddings: [[]], usage: { input_tokens: 0 } };
      } else {
        response = {};
      }
    }

    // Clone shallow + fill in default model when not supplied
    const finalResponse = { model: ctx.request.model ?? modelId, ...response };
    self.calls.push({
      method:     ctx.method,
      request:    ctx.raw,
      response:   finalResponse,
      error:      null,
      timestamp:  Date.now(),
      durationMs: Date.now() - startedAt,
    });
    return finalResponse;
  }

  function _matchScript(self, ctx) {
    for (const s of self._scripts) {
      if (_scriptMatches(s.when, ctx)) return s;
    }
    return null;
  }

  function _scriptMatches(when, ctx) {
    if (typeof when === 'function') {
      try { return !!when(ctx.raw, ctx.method); }
      catch { return false; }
    }
    if (typeof when === 'object' && when !== null) {
      if (when.method && when.method !== ctx.method) return false;
      if (when.model  && ctx.request.model !== when.model) return false;
      if (when.matches) {
        const text = _extractText(ctx.raw, ctx.method);
        if (!when.matches.test(text)) return false;
      }
      return true;
    }
    return false;
  }

  return svc;
}

// Extract user-visible text from a request for regex matching.
function _extractText(req, method) {
  if (method === 'embed') {
    if (typeof req.input === 'string') return req.input;
    if (Array.isArray(req.input)) return req.input.join(' ');
    return '';
  }
  // chat / stream — concatenate all user messages
  if (!Array.isArray(req.messages)) return '';
  return req.messages
    .filter((m) => m && m.role === 'user')
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join(' ');
      }
      return '';
    })
    .join(' ');
}

const {
  recording,
  replay,
  MissingFixtureError,
  defaultHash,
  fileStore,
} = require('./testingRecordReplay');

module.exports = {
  fakeLLM,
  recording,
  replay,
  MissingFixtureError,
  defaultHash,
  fileStore,
};
