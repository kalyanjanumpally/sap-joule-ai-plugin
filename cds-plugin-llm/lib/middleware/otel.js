// OpenTelemetry middleware for llm.use(). Duck-typed against @opentelemetry/api
// so this package does not require a hard dep on OTel.
//
//   const { trace } = require('@opentelemetry/api');
//   const { otel } = require('@saptarishi/cds-plugin-llm/lib/middleware/otel');
//   llm.use(otel({ tracer: trace.getTracer('cap-app') }));
//
// Span attributes follow the emerging GenAI semantic conventions where possible:
//   - gen_ai.system         provider kind ('anthropic', 'ollama', ...)
//   - gen_ai.request.model  effective model id
//   - gen_ai.operation.name 'chat' | 'stream' | 'embed'
//   - gen_ai.usage.input_tokens
//   - gen_ai.usage.output_tokens
//   - llm.cached            true when served from response cache
//
// Streams: the returned iterable is wrapped so the span ends on the `done` chunk
// (or when the iterator terminates for any reason). Chunk counts are recorded.

function otel(options = {}) {
  const {
    tracer,
    spanNamePrefix = 'llm.',
    systemAttribute,
  } = options;

  if (!tracer || typeof tracer.startSpan !== 'function') {
    throw new Error('otel: options.tracer is required and must implement startSpan()');
  }

  return async (ctx, next) => {
    const span = tracer.startSpan(spanNamePrefix + ctx.method);
    const set = (k, v) => { if (v !== undefined && v !== null && span.setAttribute) span.setAttribute(k, v); };

    set('gen_ai.operation.name', ctx.method);
    set('gen_ai.request.model', ctx.request.model);
    if (systemAttribute) set('gen_ai.system', systemAttribute);

    try {
      const result = await next();

      if (ctx.method === 'stream') {
        return (async function* wrapped() {
          let chunks = 0;
          let done;
          try {
            for await (const chunk of result) {
              chunks++;
              if (chunk?.type === 'done') done = chunk;
              yield chunk;
            }
            set('llm.stream.chunks', chunks);
            if (done) {
              set('gen_ai.response.model', done.model);
              set('gen_ai.usage.input_tokens', done.usage?.input_tokens);
              set('gen_ai.usage.output_tokens', done.usage?.output_tokens);
              set('gen_ai.response.stop_reason', done.stopReason);
            }
          } catch (err) {
            recordError(span, err);
            throw err;
          } finally {
            if (span.end) span.end();
          }
        })();
      }

      if (ctx.method === 'chat') {
        set('gen_ai.response.model', result?.model);
        set('gen_ai.usage.input_tokens', result?.usage?.input_tokens);
        set('gen_ai.usage.output_tokens', result?.usage?.output_tokens);
        set('gen_ai.response.stop_reason', result?.stopReason);
        set('llm.cached', result?.cached === true);
        if (Array.isArray(result?.toolCalls) && result.toolCalls.length > 0) {
          set('llm.tool_calls.count', result.toolCalls.length);
        }
      } else if (ctx.method === 'embed') {
        set('gen_ai.response.model', result?.model);
        set('llm.embed.count', Array.isArray(result?.embeddings) ? result.embeddings.length : 0);
      }

      if (span.end) span.end();
      return result;
    } catch (err) {
      recordError(span, err);
      if (span.end) span.end();
      throw err;
    }
  };
}

function recordError(span, err) {
  if (span.recordException) span.recordException(err);
  if (span.setStatus) span.setStatus({ code: 2, message: err?.message ?? String(err) });
}

module.exports = { otel };
