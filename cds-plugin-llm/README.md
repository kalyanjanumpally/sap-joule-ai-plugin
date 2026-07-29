# cds-plugin-llm

[![CI](https://github.com/kalyanjanumpally/sap-joule-procurement-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/kalyanjanumpally/sap-joule-procurement-copilot/actions/workflows/ci.yml)
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

**What happens if the underlying provider's API changes?**
Each provider adapter is a thin file (~150 lines). Provider API changes are localized to one file. The plugin's public surface (`chat`, `stream`, `embed`) is stable across provider changes.

## Contributing

PRs and issues welcome. The [repo](https://github.com/kalyanjanumpally/sap-joule-procurement-copilot) has the plugin as `cds-plugin-llm/`. Standard workflow:

```sh
git clone https://github.com/kalyanjanumpally/sap-joule-procurement-copilot
cd sap-joule-procurement-copilot/cds-plugin-llm
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
- **1.1+**: per-user rate limiting hooks, custom middleware/interceptor pattern, HANA Cloud vector store integration, OpenAI Files API for URL PDFs

## License

Apache-2.0
