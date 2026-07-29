# cds-plugin-llm

[![CI](https://github.com/kalyanjanumpally/sap-joule-ai-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/kalyanjanumpally/sap-joule-ai-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@saptarishi/cds-plugin-llm.svg)](https://www.npmjs.com/package/@saptarishi/cds-plugin-llm)
[![license](https://img.shields.io/npm/l/@saptarishi/cds-plugin-llm.svg)](./LICENSE)

LLM-agnostic AI service for SAP CAP. One unified interface — swap between Anthropic (Claude), Ollama (local), Groq, any OpenAI-compatible endpoint, or SAP Generative AI Hub without changing your handler code.

**Status:** stable (v1.0.0). All five providers implemented; 64 unit tests + wire-protocol E2E verification against a mock AI Core; CI green on Node 20 + 22. API stability commitment in force — breaking changes require a major version bump. GenAI Hub is spec-compliant and mock-verified end-to-end; live verification against a real AI Core `extended` deployment is a labeled community-help gap (see FAQ).

## What it is

A CAP service kind that turns `cds.connect.to('llm')` into a working LLM client — with one unified interface (`chat`, `stream`, `embed`) that speaks to any of five backends. Swapping backends is a config change, not a code change.

Complementary to [`@cap-js/ai`](https://github.com/cap-js/ai), which focuses on value-help recommendations and SAP AI Core integration. This plugin fills the more general "I need a CAP-idiomatic way to call LLMs, with a local development story and multiple provider options" gap.

## Architecture

```
    Your CAP handler
          │
          │  cds.connect.to('llm')  →  { chat, stream, embed }
          ↓
    ┌─────────────────────────────────────────────┐
    │  LLMService  (base class)                   │
    │  - retries, structured-output parsing       │
    │  - unified chunk shape for streaming        │
    └────────────┬────────────────────────────────┘
                 │
                 ▼
    ┌────────────────────┬──────────────┬──────────────┐
    │ AnthropicLLM       │ OllamaLLM    │ GroqLLM      │
    │ OpenAICompatible   │ GenAIHubLLM  │              │
    └────────────────────┴──────────────┴──────────────┘
      ↓                    ↓              ↓
    Anthropic         Local Ollama    Groq / OpenAI /
    Messages API      HTTP            AI Core / any
                                      OpenAI-compat
```

- **No CDS entities or served OData surface** — this is a client library, not an OData service. `cds.connect.to('llm')` returns the provider instance directly.
- **Provider selection at connect time** via `cds.requires.llm.kind` — profile-aware, so `[development]`, `[production]`, `[genai-hub]`, etc. can each point at a different backend.
- **Provider inheritance:** `GroqLLMService` and `GenAIHubLLMService` both extend `OpenAICompatibleLLMService` (they speak the OpenAI `/chat/completions` shape); the latter adds OAuth + resource-group headers on top.

## Install

```bash
npm install @saptarishi/cds-plugin-llm
```

Optional peer dep for the Anthropic path: `@anthropic-ai/sdk` (installed automatically as a dependency).

**TypeScript:** full type definitions ship in the package (`lib/index.d.ts`). No `@types/*` package needed.

**CLI:** a `saptarishi-llm` executable ships with the package. Use it via `npx` without installing globally, or install once with `npm i -g @saptarishi/cds-plugin-llm`. See the [CLI section](#cli-new-in-v150).

## Configure

Add to your CAP app's `package.json` under `cds.requires`:

```json
{
  "cds": {
    "requires": {
      "llm": {
        "[development]": { "kind": "llm-groq",       "modelId": "llama-3.3-70b-versatile" },
        "[ollama]":      { "kind": "llm-ollama",     "modelId": "qwen2.5:14b"             },
        "[production]":  { "kind": "llm-genai-hub", "credentials": { "deploymentId": "..." } }
      }
    }
  }
}
```

Set the appropriate env var (see `.env.example`):
- `ANTHROPIC_API_KEY` for `llm-anthropic`
- `OLLAMA_BASE_URL` for `llm-ollama` (defaults to `http://localhost:11434`)
- `GROQ_API_KEY` for `llm-groq`
- `OPENAI_API_KEY` + `OPENAI_BASE_URL` for `llm-openai-compatible`

## Providers

| Kind | Backend | Cost to test | Status |
|---|---|---|---|
| `llm-anthropic` | Claude via Anthropic API | Pennies per call | Working |
| `llm-ollama` | Local Ollama daemon | Free | Working |
| `llm-groq` | Groq's hosted Llama/Mixtral/Qwen (sub-second inference) | Generous free tier | Working |
| `llm-openai-compatible` | Any endpoint speaking OpenAI's `/chat/completions` (OpenAI, Together, Fireworks, DeepSeek direct, LM Studio, LocalAI...) | Varies | Working |
| `llm-genai-hub` | SAP AI Core / Generative AI Hub | Paid (extended plan) | Spec-compliant · mock-verified end-to-end · live verify open (community help welcome) |

## Stability

- **Semantic Versioning.** `1.x` will preserve the public API contract documented in `lib/index.d.ts`. Breaking changes require a major version bump.
- **What's covered:** all exported symbols in `lib/index.js` — `LLMService` and 5 provider subclasses, `chat` / `stream` / `embed` shapes, `ContentBlock` union (text / image / document), message shapes, tool call shapes, stream chunk shapes, image / PDF helpers, and provider option fields (`kind`, `modelId`, `credentials`, `retries`, `responseCache`).
- **What's not covered:** provider-native `raw` response objects (shape follows the upstream API), CDS kind config field names (which follow CAP conventions), and behavior of individual model IDs (upstream provider concern).
- **Deprecation policy:** any deprecated field or method will be marked in the JSDoc + CHANGELOG for at least one minor release before removal, and only removed in a subsequent major version.
- **Full history** in [`CHANGELOG.md`](./CHANGELOG.md).

## Use

Standard CAP idiom — `cds.connect.to()`:

```js
const cds = require('@sap/cds');

module.exports = class ProcurementService extends cds.ApplicationService {
  async init() {
    const llm = await cds.connect.to('llm');

    this.on('summarizePO', async (req) => {
      const { poId } = req.data;
      const po = await SELECT.one.from('PurchaseOrders').where({ ID: poId });

      const { text } = await llm.chat({
        system: 'You summarize purchase orders for approvers in 2 sentences.',
        messages: [{ role: 'user', content: JSON.stringify(po) }],
        cache: true,  // Anthropic-only: caches the system prompt
      });

      return text;
    });

    return super.init();
  }
};
```

## Structured outputs (new in v0.3.0)

Pass a JSON schema via `format` and get a parsed `.data` field back:

```js
const { data, usage } = await llm.chat({
  system: 'Assess supplier invoice risk for AP triage.',
  messages: [{ role: 'user', content: invoiceJson }],
  format: {
    type: 'object',
    properties: {
      risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      rationale: { type: 'string' },
    },
    required: ['risk', 'rationale'],
    additionalProperties: false,
  },
});

console.log(data.risk);       // 'high'
console.log(data.rationale);  // 'Amount over 100k EUR without matched PO...'
```

Under the hood:
- **Anthropic**: uses `output_config.format` (native JSON schema)
- **OpenAI-compatible / Groq**: uses `response_format: { type: 'json_object' }` and prepends the schema to the system prompt for broadest model coverage
- **Ollama**: uses native `format` field (schema-strict on recent Ollama versions)
- **Base class** post-parses `.text` into `.data` uniformly; falls back to first-`{...}`-block extraction if the model wrapped the JSON in prose

## Tool use / function calling (new in v0.3.0)

Pass a unified tool schema; get normalized `toolCalls` back:

```js
const turn1 = await llm.chat({
  system: 'Help procurement approvers. Use tools to fetch data.',
  messages: [{ role: 'user', content: 'Fetch PO 4500000123' }],
  tools: [{
    name: 'get_purchase_order',
    description: 'Fetch a purchase order by its 10-digit ID',
    input_schema: {
      type: 'object',
      properties: { purchaseOrderId: { type: 'string' } },
      required: ['purchaseOrderId'],
    },
  }],
});

if (turn1.toolCalls?.length) {
  const call = turn1.toolCalls[0];  // { id, name, input }
  const result = await fetchPO(call.input.purchaseOrderId);  // your app logic

  // Feed the result back for turn 2
  const turn2 = await llm.chat({
    system: '...',
    messages: [
      { role: 'user',      content: 'Fetch PO 4500000123' },
      { role: 'assistant', toolCalls: turn1.toolCalls },
      { role: 'tool',      tool_call_id: call.id, content: JSON.stringify(result) },
    ],
    tools: [...],
  });
  console.log(turn2.text);  // model's final answer
}
```

Works across providers with matching `{ id, name, input }` shape. Individual model quality varies for multi-tool scenarios — llama-3.3-70b on Groq is solid for single-tool cases; Claude and qwen2.5 are more reliable for chained tool use.

### Tool runner — automatic multi-turn loop (new in v1.1.0)

For agent-style code that would otherwise write the "call → execute → feed back → repeat" loop by hand, `runTools()` wraps the pattern:

```js
const { runTools } = require('@saptarishi/cds-plugin-llm');

const result = await runTools({
  llm,
  system: 'You help procurement approvers.',
  messages: [{ role: 'user', content: 'Fetch PO 4500000123 and summarize it.' }],
  tools: [{
    name: 'get_purchase_order',
    description: 'Fetch a PO by 10-digit ID',
    input_schema: {
      type: 'object',
      properties: { purchaseOrderId: { type: 'string' } },
      required: ['purchaseOrderId'],
    },
    run: async ({ purchaseOrderId }) =>
      await SELECT.one.from('PurchaseOrders').where({ ID: purchaseOrderId }),
  }],
  maxSteps: 10,
});

result.text        // final assistant answer
result.steps       // number of chat() calls made
result.toolCalls   // [{ id, name, input, result, isError }, ...] — every call executed
result.usage       // aggregated tokens across all turns
```

What it handles for you:
- Executes every tool call in every turn (multiple in one turn all run)
- Appends assistant + `tool` messages correctly (matches the format both Anthropic and OpenAI-compat expect)
- Catches tool exceptions and surfaces them as `tool_result` with `is_error: true` so the model can recover
- Rejects with a clear message when an unknown tool name is called
- `maxSteps` safety cap (default 10) — throws if the model loops forever
- Optional `onStep({ step, response })` callback to observe each turn

## Streaming (new in v0.6.0)

Get tokens as they arrive from the model instead of waiting for the full response:

```js
for await (const chunk of llm.stream({
  system: 'You are a poet.',
  messages: [{ role: 'user', content: 'Write a haiku about SAP procurement.' }],
})) {
  if (chunk.type === 'text_delta') {
    process.stdout.write(chunk.text);
  }
  if (chunk.type === 'done') {
    console.log(`\n[${chunk.usage.output_tokens} tokens, stopReason: ${chunk.stopReason}]`);
  }
}
```

Chunk types:

| type | payload | when |
|---|---|---|
| `text_delta` | `{ text }` — incremental piece of text | fires per token/token-group as the model generates |
| `done` | `{ text, usage, stopReason, model }` — accumulated text + final metadata | once at the end |

Wire-shape parsing per provider:
- **Anthropic**: uses the SDK's `messages.stream()` — SSE under the hood, events adapted to unified chunks
- **OpenAI-compatible / Groq / GenAI Hub**: parses SSE (`data: {json}\n\n`) from the `/chat/completions` streaming endpoint, adds `stream_options: {include_usage: true}` so `usage` populates on the `done` chunk
- **Ollama**: parses NDJSON from `/api/chat`, emits `done` when the stream's final message carries `done:true`

Retries are **not** applied to streams (partial-response semantics are unclear). If a stream fails mid-way, the caller sees the error thrown from the generator.

Try the demo:

```sh
node scripts/stream-demo.js "Explain streaming LLM responses in 3 sentences."
```

## Embeddings (expanded in v0.7.0)

```js
const { embeddings } = await llm.embed({
  input: ['first document', 'second document', 'third'],
  model: 'text-embedding-3-small',  // optional; falls back to configured modelId
});
// embeddings is number[][] — one vector per input string
```

Supported providers:
- **Ollama** — `mxbai-embed-large`, `nomic-embed-text`, `all-minilm`, any embedding model you've pulled
- **OpenAI-compatible** (including Groq, Together AI, DeepSeek, LM Studio) — `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`, provider-specific models
- **Anthropic**: not supported (no first-party embeddings)
- **GenAI Hub**: needs a separate embedding-model deployment; not yet plumbed (planned for 0.9)

Single string or array of strings both work. Returns `{ embeddings: number[][], model: string }` — the outer array always matches the input length.

## Vision / multimodal input (new in v0.5.0)

Pass images inline as content blocks. Works across all providers with vision-capable models (Claude 3.5+, GPT-4o, Groq's `llama-3.2-*-vision`, Ollama's `llava` / `moondream` / `llama3.2-vision`).

```js
const { imageFromFile, imageFromUrl, imageFromBase64 } = require('@saptarishi/cds-plugin-llm');

// Load from disk
const image = await imageFromFile('/tmp/scanned-invoice.png');

// Or from a URL (Anthropic + OpenAI-compat; Ollama needs base64)
const image = imageFromUrl('https://example.com/invoice.png');

// Or from base64 data you already have
const image = imageFromBase64(base64Data, 'image/png');

const { data } = await llm.chat({
  model: 'gpt-4o',  // or claude-opus-4-7, llama-3.2-11b-vision-preview, llava, ...
  system: 'Extract structured data from scanned invoices.',
  messages: [{
    role: 'user',
    content: [
      image,
      { type: 'text', text: 'Return the vendor, invoice number, and line items.' },
    ],
  }],
  format: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      invoiceNumber: { type: 'string' },
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number' },
            unitPrice: { type: 'number' },
          },
        },
      },
    },
  },
});
```

Wire-shape translation is provider-aware:
- **Anthropic**: native content blocks (source can be `url` or `base64`)
- **OpenAI-compatible / Groq**: `image_url` blocks with data URLs for base64
- **Ollama**: text goes in `content`, images extracted to `images: [base64, ...]` (Ollama does not accept URLs — use `imageFromFile()` or `imageFromBase64()`)

## PDF documents (v0.8.0 · expanded in v0.9.0)

Pass PDF documents inline. Full native support on Anthropic (Claude 3.5+ parses text + visuals in one pass). Since **v0.9.0** OpenAI-compat providers accept base64 PDFs too via the `file` content-block shape — works on GPT-4o and newer OpenAI models. Groq and other OpenAI-compat providers that don't accept files will 400 upstream.

```js
const { pdfFromFile, pdfFromUrl, pdfFromBase64 } = require('@saptarishi/cds-plugin-llm');

const pdf = await pdfFromFile('/tmp/scanned-invoice.pdf');
// or: const pdf = pdfFromUrl('https://example.com/invoice.pdf');
// or: const pdf = pdfFromBase64(base64Data);

const { data } = await llm.chat({
  model: 'claude-opus-4-7',
  system: 'Extract structured data from scanned invoices.',
  messages: [{
    role: 'user',
    content: [
      pdf,
      { type: 'text', text: 'Return vendor, invoice number, line items.' },
    ],
  }],
  format: { /* JSON schema */ },
});
```

Provider notes:
- **Anthropic** — native, both base64 and URL sources
- **OpenAI-compat (GPT-4o+)** — base64 only. Plugin translates the document block to `{type:'file', file:{filename, file_data:'data:application/pdf;base64,...'}}`. URL PDFs throw with guidance to fetch client-side first.
- **Groq / other OpenAI-compat that don't accept files** — will 400 upstream; the error propagates cleanly
- **Ollama** — no PDF support; render pages to images via `pdftoppm` (poppler) and pass to a vision model like `llava` or `llama3.2-vision`

## SAP Generative AI Hub setup

The `llm-genai-hub` kind targets a **deployment** in your BTP AI Core instance. Prerequisites:

1. **Provision AI Core** — BTP Cockpit → Service Marketplace → *AI Core* → **extended** plan (free plan does not include Generative AI Hub).
2. **Create a resource group** (or use `default`).
3. **Deploy a model** via SAP AI Launchpad, `ai-api-cli`, or the SDK — e.g. `gpt-4o`, `mistral-large-instruct`, `claude-3-5-sonnet`. Note the deployment ID.
4. **Configure the plugin** — three ways depending on where your CAP app runs.

### On BTP Cloud Foundry (recommended)

Bind the AI Core service instance to your CAP app:

```sh
cf bind-service <your-app> <ai-core-instance>
cf restage <your-app>
```

Then set only the deployment ID (credentials auto-discovered from `VCAP_SERVICES`):

```sh
cf set-env <your-app> AICORE_DEPLOYMENT_ID <deployment-id>
cf set-env <your-app> AICORE_RESOURCE_GROUP default   # optional; defaults to 'default'
```

In `package.json`:

```json
{
  "cds": { "requires": { "llm": {
    "[production]": { "kind": "llm-genai-hub", "modelId": "gpt-4o" }
  }}}
}
```

### On Kyma

Attach the service binding manifest, then set the same env vars via a ConfigMap or Secret. The `VCAP_SERVICES` layout is preserved by the SBO (Service Binding Operator).

### Local dev pointing at a BTP-hosted AI Core

Extract the service key JSON from BTP Cockpit (Service Instance → Service Keys → View). Put values in `.env`:

```
AICORE_API_URL=https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com
AICORE_AUTH_URL=https://<subaccount>.authentication.<region>.hana.ondemand.com
AICORE_CLIENT_ID=sb-...
AICORE_CLIENT_SECRET=...
AICORE_DEPLOYMENT_ID=abc123                # chat model deployment
AICORE_EMBEDDING_DEPLOYMENT_ID=def456      # optional; enables llm.embed()
AICORE_MODEL=gpt-4o
```

Or pass explicitly in `package.json`:

```json
{
  "cds": { "requires": { "llm": {
    "[genai-hub]": {
      "kind": "llm-genai-hub",
      "modelId": "gpt-4o",
      "credentials": {
        "aiCoreUrl":     "https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com",
        "tokenUrl":      "https://<subaccount>.authentication.<region>.hana.ondemand.com",
        "clientId":      "sb-...",
        "clientSecret":  "...",
        "deploymentId":  "abc123",
        "resourceGroup": "default"
      }
    }
  }}}
}
```

### What it handles for you

- OAuth2 client-credentials flow against XSUAA
- Token caching + refresh (60s before expiry)
- `AI-Resource-Group` header
- Deployment-based inference endpoint construction
- `VCAP_SERVICES.aicore` auto-discovery when the service is bound

### Known limitations (v0.4.0)

- **OpenAI-shape only.** Deployments that expose the OpenAI `/chat/completions` shape (GPT, Mistral, Llama, Gemini, and Anthropic-via-shim) work. Native Anthropic-shape deployments (Claude via `/invoke`) are not yet supported — use the `llm-anthropic` kind directly for Claude.
- **Not yet live-verified.** Built to the SAP-documented API contract and unit-tested against mocks. Live verification against an AI Core `extended` deployment is the next contribution wanted.

## Automatic retries (new in v0.3.0)

Every `chat()` and `embed()` call is wrapped with exponential-backoff retry on 429 / 5xx responses. Honors `Retry-After` headers. Configurable per-call or globally:

```js
// Per-call override
await llm.chat({ messages: [...], retries: { max: 5, baseMs: 1000, maxMs: 30000 } });

// Or via cds.requires.llm config:
{ "cds": { "requires": { "llm": {
  "kind": "llm-groq",
  "retries": { "max": 5 }
}}}}
```

## Middleware / interceptors (new in v1.2.0)

Register hooks around every `chat` / `stream` / `embed` call. Koa-style compose — outermost first, `next()` returns the next middleware's result (or the provider's response). Middleware may inspect or transform the request AND the response, share state via `ctx.meta`, or short-circuit by returning without calling `next()`.

```js
const llm = await cds.connect.to('llm');

// 1. Logging + duration
llm.use(async (ctx, next) => {
  const start = Date.now();
  const res = await next();
  console.log(`[${ctx.method}] ${Date.now() - start}ms`);
  return res;
});

// 2. Cost tracking (aggregate tokens across every call)
const totals = { in: 0, out: 0 };
llm.use(async (ctx, next) => {
  const res = await next();
  totals.in  += res?.usage?.input_tokens  ?? 0;
  totals.out += res?.usage?.output_tokens ?? 0;
  return res;
});

// 3. Auto-injected system prompt suffix
llm.use(async (ctx, next) => {
  if (ctx.method === 'chat' && ctx.request.system) {
    ctx.request.system += '\n\nBe concise. If uncertain, say so.';
  }
  return next();
});

// 4. Streams: wrap the iterator to observe each chunk
llm.use(async (ctx, next) => {
  if (ctx.method !== 'stream') return next();
  const inner = await next();
  return (async function* () {
    for await (const chunk of inner) {
      if (chunk.type === 'text_delta') myLiveUI.append(chunk.text);
      yield chunk;
    }
  })();
});
```

Context object:
- `ctx.method` — `'chat'` | `'stream'` | `'embed'`
- `ctx.request` — mutable request options (modify before `next()` to affect the provider call)
- `ctx.meta` — scratchpad for cross-middleware state (e.g. timing marks, request IDs)

Notes:
- Middleware runs **around** the response cache, retries, and format-parsing — those are internal concerns your middleware can observe. Cache hits arrive at your middleware with `cached: true` set.
- Calling `next()` more than once from the same middleware throws.
- Errors propagate up the chain.
- For streams, `next()` returns an async iterable. To observe/transform chunks, wrap it into a new async generator.

### Built-in middleware (new in v1.3.0)

Two production-oriented middlewares ship in the box: rate limiting and OpenTelemetry tracing.

#### `rateLimit` — token-bucket limiter

```js
const { rateLimit } = require('@saptarishi/cds-plugin-llm');

const llm = await cds.connect.to('llm');

// Global: 60 requests burst, refill at 1/s
llm.use(rateLimit({ capacity: 60, refillPerSecond: 1 }));

// Per-user: keyed off ctx.meta.user (populate this from an earlier middleware
// that inspects your CAP request)
llm.use(rateLimit({
  capacity: 10,
  refillPerSecond: 0.2,
  keyFn: (ctx) => ctx.meta.user ?? 'anon',
  mode: 'wait',   // 'throw' (default) or 'wait' — pause instead of erroring
}));
```

When `mode: 'throw'` and the bucket is empty, the middleware throws an `Error` with `code: 'RATE_LIMITED'` and `retryAfterMs` so you can surface a proper 429 to your caller. Buckets are in-process — for multi-instance CF apps that need a shared counter, back with Redis via your own middleware.

#### `otel` — OpenTelemetry spans

```js
const { trace } = require('@opentelemetry/api');
const { otel } = require('@saptarishi/cds-plugin-llm');

llm.use(otel({
  tracer: trace.getTracer('cap-app'),
  systemAttribute: 'anthropic',   // sets gen_ai.system on every span
}));
```

Emits one span per `chat` / `stream` / `embed` call. Attributes follow the emerging GenAI semantic conventions where possible: `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.response.stop_reason`. Plus a few plugin-specific ones: `llm.cached`, `llm.tool_calls.count`, `llm.stream.chunks`, `llm.embed.count`. Duck-typed against `@opentelemetry/api` — no hard dependency, works with any object exposing `startSpan()`.

Stream spans stay open through the whole iterator (span ends on the `done` chunk, on early break, or on error — never leaks).

#### `redisRateLimit` — shared bucket across CF instances (new in v1.4.0)

The in-process `rateLimit` is fine for single-instance apps. For multi-instance CF deployments where a shared quota must be enforced globally, back the bucket with Redis.

```js
const Redis = require('ioredis');
const { redisRateLimit } = require('@saptarishi/cds-plugin-llm');

llm.use(redisRateLimit({
  redis: new Redis(process.env.REDIS_URL),
  capacity: 60,
  refillPerSecond: 1,
  keyFn: (ctx) => ctx.meta.user ?? 'anon',
  keyPrefix: 'ratelimit:llm:',   // default 'saptarishi:llm:rl:'
  mode: 'throw',                  // 'throw' | 'wait'
}));
```

Uses an atomic Lua `EVAL` so two instances checking the bucket at the same time cannot both succeed when only one token is left. Duck-typed client — any object with an `eval(script, numKeys, ...args)` promise API satisfies (works with `ioredis` and `node-redis` v4+ out of the box). On BTP, bind a Redis service to your CF app and pull the URL from `VCAP_SERVICES`.

## CLI (new in v1.5.0)

A `saptarishi-llm` executable ships with the package. Handy for provider health checks in CI, quick prompt experiments from the shell, pipelining embeddings into a downstream tool, or **scaffolding a fresh CAP project** pre-wired to the plugin (v1.6.0).

```bash
npx @saptarishi/cds-plugin-llm --help

# or install globally
npm install -g @saptarishi/cds-plugin-llm
saptarishi-llm --help
```

### Commands

```bash
saptarishi-llm chat -p "explain SAP CAP in one sentence"
saptarishi-llm stream -p "write a haiku about procurement"
saptarishi-llm embed -p "purchase order for steel coils" --json
saptarishi-llm verify --provider anthropic
saptarishi-llm providers
```

### Provider selection

`--provider <kind>` or `SAPTARISHI_LLM_PROVIDER` env var. Same five kinds as the CAP plugin: `anthropic`, `ollama`, `groq`, `openai-compatible`, `genai-hub`.

Credentials come from env vars (never CLI flags — avoids leaking secrets into shell history):

```bash
ANTHROPIC_API_KEY=sk-ant-... saptarishi-llm chat -p "hello"
OLLAMA_URL=http://192.168.5.13:11434 saptarishi-llm chat --provider ollama -p "hello"
GROQ_API_KEY=gsk-... saptarishi-llm verify --provider groq
```

### Input sources

Prompt can come from `--prompt` / `-p`, `--file` / `-f`, stdin, or a positional arg. Multiple sources concatenate with a blank line between them.

```bash
echo "summarize this" | saptarishi-llm chat -f contract.pdf.txt
saptarishi-llm embed -p "one\n---\ntwo\n---\nthree"      # 3 vectors from 1 call
```

### CI health checks

`verify` connects, runs a tiny probe, reports latency, and exits `0` on success / `1` on unexpected reply / `1` on error. Drop it in a nightly workflow to catch expired credentials or endpoint outages before your CAP app does.

```bash
saptarishi-llm verify --provider genai-hub --json
```

### Expose as an MCP server (new in v1.7.0)

`saptarishi-llm mcp` runs a Model Context Protocol server over stdio that exposes the configured provider as tools any MCP client can call. Register it in Claude Desktop, Cursor, Zed, or any other MCP-capable client and those clients gain a `chat` / `embed` / `verify` / `list_providers` tool backed by **your** provider config — with all its middleware, caching, rate limits, and OTel tracing.

The point: one MCP server = "the sanctioned way to call an LLM at MyCompany". Centralized credentials, centralized policy, developer productivity everywhere.

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```jsonc
{
  "mcpServers": {
    "saptarishi-llm": {
      "command": "npx",
      "args": ["-y", "@saptarishi/cds-plugin-llm", "mcp"],
      "env": {
        "SAPTARISHI_LLM_PROVIDER": "groq",
        "GROQ_API_KEY": "gsk-..."
      }
    }
  }
}
```

Tools exposed:

| Tool | Purpose |
|------|---------|
| `chat` | Send a prompt, return text. `{ prompt, system?, maxTokens? }` |
| `embed` | Embed input(s) into vectors. `{ input: string \| string[] }` |
| `verify` | Tiny probe against the provider. Returns `{ ok, latencyMs, model, text }`. |
| `list_providers` | Enumerate every supported provider kind with default models. |

Uses a hand-rolled MCP implementation (2024-11-05 spec) over stdio JSON-RPC 2.0 — **zero new dependencies**. Full protocol coverage: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `ping`, notifications. Tool errors surface as `result.isError: true` per spec so the model can recover, not as JSON-RPC errors.

**Resources exposed** (readable via `resources/read`):

| URI | Description |
|-----|-------------|
| `config://active-provider` | Current provider kind + model + middleware count. |
| `config://supported-providers` | Every provider kind + default model. |

**Prompts registered** (invokable via `prompts/get`) — see [Prompt-template registry](#prompt-template-registry-new-in-v180) below for the full built-in list.

**Resource templates** (new in v1.9.0; parametrized URIs discoverable via `resources/templates/list`):

| URI template | What clients can read |
|---|---|
| `provider://{kind}` | Default model for a specific provider kind (`provider://groq` → `{ kind: 'groq', defaultModel: 'llama-3.3-70b-versatile' }`). |
| `prompt://{name}` | Metadata (arguments, description) for a registered prompt template. To render, use `prompts/get`. |

### Scaffold a fresh CAP project (new in v1.6.0)

`init` creates a fully-wired CAP app in seconds — no manual `package.json` editing, no CDS boilerplate:

```bash
npx @saptarishi/cds-plugin-llm init joule-demo --provider groq
cd joule-demo
cp .env.example .env               # then fill in real credentials
npm install
cds watch
```

Then:

```bash
curl 'http://localhost:4004/ai/chat(prompt='"'"'hello'"'"')'
```

Generated:

```
joule-demo/
├── package.json          # cds.requires.llm pointing at chosen provider
├── srv/
│   ├── ai-service.cds    # service AIService { chat(prompt), summarize(text) }
│   └── ai-service.js     # handlers using cds.connect.to('llm')
│                         # + SSE streaming endpoint at POST /stream/chat
├── .env.example          # provider-specific env vars
├── .gitignore            # excludes .env, node_modules/, gen/
└── README.md             # how to run
```

**Streaming out of the box (v1.9.0+):** the generated `srv/ai-service.js` registers `POST /stream/chat` inline, streaming tokens as they arrive:

```bash
curl -N -X POST http://localhost:4004/stream/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"write a haiku about SAP CAP"}'
```

Flags:
- `--provider <kind>` — `anthropic` (default) | `ollama` | `groq` | `openai-compatible` | `genai-hub`
- `--model <id>` — override the default model for the chosen provider
- `--force` — overwrite a non-empty target directory
- `--dry-run` — print the file list without writing anything

## Prompt-template registry (new in v1.8.0)

Register named prompt templates once, invoke them by name from any CAP handler, and automatically expose them over MCP so external clients (Claude Desktop, Cursor, Zed) can invoke them too. Same registry, three surfaces.

```js
const { PromptRegistry, builtInPrompts } = require('@saptarishi/cds-plugin-llm');

const prompts = new PromptRegistry()
  .registerAll(builtInPrompts())                    // 5 built-ins
  .register({                                       // your own
    name: 'invoice_dispute_response',
    description: 'Draft a courteous response to an invoice dispute.',
    arguments: [
      { name: 'dispute', required: true, description: 'The dispute text' },
      { name: 'tone',    required: false, description: 'formal | friendly' },
    ],
    render: ({ dispute, tone = 'formal' }) => ({
      system: `You are AP support. Reply in a ${tone} tone. Never admit liability.`,
      messages: [{ role: 'user', content: dispute }],
    }),
  });

// From a CAP handler:
const req = prompts.render('invoice_dispute_response', { dispute });
const res = await llm.chat({ ...req, maxTokens: 512 });
```

Built-ins (`builtInPrompts()`):

| Name | Purpose |
|------|---------|
| `summarize` | Condense text to N sentences (`text`, `sentences?`). |
| `extract_json` | Extract structured JSON against a schema (`text`, `schema`). |
| `classify` | Assign one label from a set (`text`, `labels`). |
| `translate` | Translate to a target language (`text`, `targetLanguage`). |
| `procurement_risk_scorer` | SAP-flavored risk analyst prompt (`text`). |

Templates auto-appear as MCP prompts when you run `saptarishi-llm mcp`. Claude Desktop shows them as slash-commands the user can pick.

### Load templates from a folder (new in v1.9.0)

Instead of registering templates inline, drop `*.mjs` or `*.js` files into a directory and load them at boot:

```
prompts/
├── invoice_dispute.mjs        # export default { name, render, ... }
├── kpi_extractor.mjs          # export default { ... }
└── shared.mjs                 # export const foo = ...; export const bar = ...
```

```js
await registry.loadFromDir('./prompts');
```

Or expose the whole folder via MCP without writing any code:

```bash
saptarishi-llm mcp --prompts-dir ./prompts
# or: SAPTARISHI_LLM_PROMPTS_DIR=./prompts saptarishi-llm mcp
```

Three export conventions handled in one scan: `export default <template>`, `export default [<t1>, <t2>]`, or named exports.

Add `--watch-prompts` and the server hot-reloads templates when files change — iterate without restart (new in v1.10.0):

```bash
saptarishi-llm mcp --prompts-dir ./prompts --watch-prompts
```

### HTTP+SSE transport (new in v1.10.0)

By default `saptarishi-llm mcp` speaks stdio (for Claude Desktop / Cursor / Zed as a local subprocess). Add `--http` and it runs as a network service instead — the same MCP server, addressable over HTTP. Deploy to CF, put behind an auth proxy, share with a team.

```bash
saptarishi-llm mcp --http --port 3333 --host 0.0.0.0
# → MCP HTTP+SSE listening on http://0.0.0.0:3333/sse
# → GET /health for liveness/session count
```

Wire protocol (MCP 2024-11-05 SSE spec):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sse` | Client opens SSE stream. Server sends `event: endpoint\ndata: /messages?sessionId=<uuid>`. Server replies to that session flow back on this stream. |
| `POST` | `/messages?sessionId=<uuid>` | Client sends a single JSON-RPC message. Server acknowledges 202; reply arrives on the SSE stream. |
| `GET` | `/health` | `{ server, version, transport, sessions }` — plug into monitoring. |

Multi-session — N concurrent clients each get their own session and stream. Graceful shutdown on SIGINT/SIGTERM.

## Response caching (new in v0.9.0)

Opt-in per-instance LRU cache with TTL. Skips tool-use calls (side-effects) and streaming (partial responses). Hits return the same `ChatResponse` shape with `cached: true` set.

```jsonc
{
  "cds": { "requires": { "llm": {
    "kind": "llm-groq",
    "modelId": "llama-3.3-70b-versatile",
    "responseCache": true                              // defaults: 5min TTL, 100 entries
    // or: "responseCache": { "ttlMs": 600000, "maxEntries": 500 }
  }}}
}
```

Cache key is a SHA-1 of the request's stable JSON representation (`model + maxTokens + system + messages + tools + format + thinking`). Requests with any of those fields differing miss the cache.

```js
const r1 = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
r1.cached  // undefined  (miss + fresh call)

const r2 = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
r2.cached  // true        (hit — no upstream call)

llm.responseCache.hits    // 1
llm.responseCache.misses  // 1
llm.responseCache.size()  // 1
```

Common wins:
- **Same PO summarized twice** (approver reopens the review) — instant, zero tokens
- **Batch classification** with duplicate inputs — deduplicates automatically
- **Load-testing** — dev-env queries hit cache after the first pass

## Full API

```ts
llm.chat({
  messages: [{ role: 'user' | 'assistant' | 'tool', content: string | ContentBlock[], toolCalls?, tool_call_id? }],
  system?: string,
  model?: string,          // overrides configured default
  maxTokens?: number,      // default 16000 (lower for Groq free tier — TPM: 12k)
  format?: JSONSchema,     // unified structured output; returns parsed data
  tools?: Tool[],          // [{ name, description, input_schema }]
  thinking?: { type: 'adaptive' } | false,  // Anthropic-only; default adaptive
  cache?: boolean,         // Anthropic-only; caches the system prompt
  retries?: { max, baseMs, maxMs },
}) => Promise<{
  text: string,
  data?: unknown,          // populated when format was set
  toolCalls?: [{ id, name, input }],  // populated when model called tools
  raw: unknown,            // provider-native response
  usage: { input_tokens, output_tokens, ... },
  stopReason: string,      // 'end_turn' | 'tool_use' | 'max_tokens' | ...
  model: string,
}>

llm.embed({ input: string | string[], model? })
  => Promise<{ embeddings: number[][], model: string }>
```

## Provider capability matrix

|                       | `llm-anthropic` | `llm-ollama` | `llm-groq` | `llm-openai-compatible` | `llm-genai-hub` |
|---|---|---|---|---|---|
| chat                  | ✓ | ✓ | ✓ | ✓ | ✓ |
| stream                | ✓ (SDK)        | ✓ (NDJSON)   | ✓ (SSE)   | ✓ (SSE)                 | ✓ (SSE) |
| structured output (`format`) | ✓ (`output_config`) | ✓ (native `format`) | ✓ (json_object mode) | ✓ (json_object) | ✓ (json_object) |
| tool use (`tools`)    | ✓ (native)     | ✓ (qwen2.5, llama3.1+) | ✓ (function-calling models) | ✓ | ✓ |
| vision (images)       | ✓ (Claude 3.5+) | ✓ (llava, moondream, llama3.2-vision) | ✓ (llama-4-scout, etc.) | ✓ (gpt-4o, etc.) | ✓ (deployment-dependent) |
| PDF (documents)       | ✓ (Claude 3.5+ native)  | — (render pages to images first) | — (Groq doesn't accept files) | ✓ (base64, on models that support `file` blocks — GPT-4o+) | ✓ (deployment-dependent) |
| embeddings            | — (no first-party embeddings) | ✓ (`mxbai-embed-large`, etc.) | ✓ (when model available) | ✓ (`text-embedding-3-*`, `ada-002`, etc.) | ✓ (needs `embeddingDeploymentId`) |
| response cache (opt-in) | ✓ | ✓ | ✓ | ✓ | ✓ |
| prompt caching (`cache`) | ✓ (Anthropic system prompt ephemeral) | — | — | — | — |
| adaptive thinking (`thinking`) | ✓ (Opus 4.7 native) | — | — | — | — |

## FAQ

**How does this relate to `@cap-js/ai`?**
`@cap-js/ai` is scoped to value-help recommendations and SAP-RPT-1 with SAP AI Core integration. This plugin is a general-purpose LLM client with multi-provider support and a broader feature surface (streaming, tool use, vision, structured output). The two can coexist: one CAP app can `cds.connect.to('ai')` for value-help features and `cds.connect.to('llm')` for direct LLM calls.

**Can I use this without SAP BTP?**
Yes. Only the `llm-genai-hub` kind requires BTP (specifically AI Core). The other four kinds (Anthropic, Ollama, Groq, OpenAI-compatible) work in any Node.js environment. This is deliberate — the plugin is useful for CAP apps that don't run on BTP, and useful for prototyping before a BTP deployment.

**Is this production-ready?**
As of `1.0.0`: the public API surface is committed under semver (breaking changes require a major bump). The core is functional and unit-tested (64 tests + wire-protocol E2E). The plugin is deployed live on SAP BTP Cloud Foundry through this repo's `joule-project-api`. The one remaining honesty note: the GenAI Hub provider is spec-compliant and mock-verified end-to-end but not yet live-verified against a real AI Core `extended` deployment — happy to accept a PR from anyone with access. Everything else has been live-verified against its target service.

**How do I add a new provider?**
Extend `LLMService` (or `OpenAICompatibleLLMService` if the target speaks the OpenAI shape), implement `_chat` (required), plus `_stream` and `_embed` if applicable. Register a kind in your `package.json` under `cds.requires.kinds.<my-provider>` with `impl` pointing at the new class file and `external: true`.

**Which model do you recommend for common tasks?**
- Structured extraction / classification: any 7B+ instruction-tuned model. Groq's `llama-3.3-70b-versatile` is a good default (fast + free tier).
- Vision (invoice OCR, chart reading): Claude Opus 4.7 or GPT-4o for accuracy; Groq's `meta-llama/llama-4-scout-17b-16e-instruct` or Ollama's `llava` for local/cheap.
- Long-context summarization: Claude Opus 4.7 (1M context) or a GenAI Hub deployment of the same.
- Tool use / agentic loops: Claude 3.5+ or qwen2.5 on Ollama for multi-step reliability. Groq's llama models work for single-tool cases.
- Embeddings: Ollama with `mxbai-embed-large` or `nomic-embed-text`.

**Why not just use `@anthropic-ai/sdk` or `openai` directly?**
Three reasons: (1) CAP idiom — `cds.connect.to('llm')` is more natural in a CAP handler than importing an SDK class. (2) Provider swap without code change — flip a config value from `llm-groq` to `llm-anthropic` and the same handler works. (3) Unified interface for tools + structured output + streaming across all providers, so you don't rewrite the message-translation code five times.

**How do I do RAG (retrieval-augmented generation)?**
The plugin gives you `embed()` — combine with a vector store to complete the loop. Companion package [`@saptarishi/cds-plugin-vector-hana`](https://www.npmjs.com/package/@saptarishi/cds-plugin-vector-hana) provides a SAP HANA Cloud vector store (native `REAL_VECTOR` + `COSINE_SIMILARITY`) with a SQLite fallback for local dev, so you can build semantic-search features without HANA access and swap backends at deploy time.

**What happens if the underlying provider's API changes?**
Each provider adapter is a thin file (~150 lines). Provider API changes are localized to one file. The plugin's public surface (`chat`, `stream`, `embed`) is stable across provider changes.

## Contributing

PRs and issues welcome. The [repo](https://github.com/kalyanjanumpally/sap-joule-ai-plugin) has the plugin as `cds-plugin-llm/`. Standard workflow:

```sh
git clone https://github.com/kalyanjanumpally/sap-joule-ai-plugin
cd sap-joule-ai-plugin/cds-plugin-llm
npm install
npm test              # 39 unit tests, no external deps
npm run typecheck     # TypeScript definition check
node ../scripts/verify-genai-hub.js   # E2E mock verification
```

CI runs the same checks on every push (Node 20 + 22 matrix).

**Highest-value contributions right now:**
- Live-verification of the GenAI Hub provider against a real AI Core `extended` deployment
- Embeddings support for OpenAI-compatible providers
- Additional structured-output modes (JSON schema strict on models that support it)

## Roadmap

- ~~**0.7**: embeddings on OpenAI-compat / Groq~~ ✓ shipped in v0.7.0
- ~~**0.8**: PDF content blocks (Anthropic native; other providers explicit-reject)~~ ✓ shipped in v0.8.0
- ~~**0.9**: OpenAI-compat inline PDF (via `file` content-block) + GenAI Hub embeddings + response caching layer~~ ✓ shipped in v0.9.0
- ~~**1.0**: API stability commitment~~ ✓ shipped in v1.0.0 (live verification of GenAI Hub open — see FAQ)
- ~~**1.1**: `runTools()` — automatic multi-turn tool-use loop~~ ✓ shipped in v1.1.0
- ~~**1.2**: middleware / interceptor pattern~~ ✓ shipped in v1.2.0
- ~~**1.3**: built-in `rateLimit` + `otel` middlewares; vector store `upsertMany`~~ ✓ shipped in v1.3.0 (llm) / v0.2.0 (vector-hana)
- ~~**1.4**: `redisRateLimit` middleware; HANA HNSW index config~~ ✓ shipped in v1.4.0 (llm) / v0.3.0 (vector-hana)
- ~~**1.5**: `saptarishi-llm` CLI~~ ✓ shipped in v1.5.0
- ~~**1.6**: `saptarishi-llm init` CAP-app scaffolder~~ ✓ shipped in v1.6.0
- ~~**1.7**: `saptarishi-llm mcp` server (MCP over stdio)~~ ✓ shipped in v1.7.0
- ~~**1.8**: `PromptRegistry` + MCP resources + MCP prompts~~ ✓ shipped in v1.8.0
- ~~**1.9**: `loadFromDir` prompt loader + `--prompts-dir` on MCP + scaffold SSE endpoint + MCP resource templates~~ ✓ shipped in v1.9.0
- ~~**1.10**: MCP HTTP+SSE transport (`--http`) + hot-reload prompts (`--watch-prompts`)~~ ✓ shipped in v1.10.0
- **1.11+**: OpenAI Files API for URL PDFs, CAP model registry (providers in `.cds` files), MCP auth (bearer token / OAuth2), MCP progress notifications on tools/call, per-session provider overrides
- **Companion package**: [`@saptarishi/cds-plugin-vector-hana`](https://www.npmjs.com/package/@saptarishi/cds-plugin-vector-hana) — HANA Cloud vector store + SQLite fallback for RAG

## License

Apache-2.0
