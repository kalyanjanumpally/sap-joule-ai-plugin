# Changelog

All notable changes to `@saptarishi/cds-plugin-llm`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.0] — 2026-07-29

### Added

- **MCP HTTP+SSE transport.** `saptarishi-llm mcp --http` runs the MCP server as a network service instead of a subprocess. Enables deployment as a CF app, behind an auth proxy, or as a shared internal service — one MCP endpoint that multiple engineers (and their MCP clients) can talk to.
  - Wire protocol matches MCP 2024-11-05 SSE transport spec: `GET /sse` opens the event stream and receives `event: endpoint\ndata: /messages?sessionId=<uuid>`; the client `POST /messages?sessionId=<uuid>` with each JSON-RPC message; server pushes replies back on the SSE stream.
  - Multi-session: N concurrent clients each get their own session and reply stream.
  - `GET /health` returns `{ server, version, transport, sessions }` — plug into your monitoring.
  - Flags: `--http`, `--port <N>` (default 3333), `--host <addr>` (default 127.0.0.1). Graceful shutdown on SIGINT / SIGTERM closes every session cleanly.
  - New export: `createHttpTransport({ server, port, host, logger })` for programmatic use.

- **`PromptRegistry.watchDir(dirPath)` — hot-reload prompt templates.** Requires a prior `loadFromDir(dirPath)`. Watches the directory; on any change to `.mjs` / `.js` files, unregisters everything previously loaded from that dir and re-loads with ESM cache-busting so import() picks up fresh code. Debounced (100ms default) because macOS FSEvents commonly fires multiple events per save. Optional `onReload({ loaded, registered, error? })` callback for observability.

- **`saptarishi-llm mcp --watch-prompts`** — enables `watchDir` on the `--prompts-dir` path. Iterate on templates without restarting the server.

- **`PromptRegistry.unregister(name)` + `.clear()`** — needed to support hot-reload but useful standalone.

- 14 new tests (231 total, adjusted for renamed helper): 
  - `mcpHttp.test.js` (8): health probe, endpoint event with sessionId, POST -> SSE reply round-trip, unknown session returns 404, bad JSON returns 400, session count grows/shrinks with disconnects, `tools/call` end-to-end over HTTP+SSE, 404 for unknown routes.
  - `promptRegistry.test.js` (+6): `unregister` return values, `clear` idempotence, `watchDir` requires prior `loadFromDir`, modification detection (unregister old + register new), broken syntax surfaces error via `onReload`, adding a new file triggers a full re-scan.
- TS defs: `watchDir(path, options?)`, `unregister(name)`, `clear()` on `PromptRegistry`.

### Notes

- Additive — no changes to existing behavior. `^1.9` consumers can bump to `^1.10` with zero code changes; HTTP transport and watch mode are opt-in.

## [1.9.0] — 2026-07-29

### Added

- **`PromptRegistry.loadFromDir(dirPath)` — filesystem prompt loader.** Drop `*.mjs` or `*.js` files into a folder, call `await registry.loadFromDir('./prompts')`, and every template gets registered. Supports three export conventions in a single scan: `export default <template>`, `export default [<t1>, <t2>, ...]`, and named exports (`export const foo = <template>`; non-templates silently skipped). Returns `{ loaded, registered }` counts. Rejects loudly if the directory is missing or is a file — a common misconfiguration worth surfacing.
- **`saptarishi-llm mcp --prompts-dir <path>`** (or `SAPTARISHI_LLM_PROMPTS_DIR` env var) auto-loads templates from a folder before the MCP server starts serving. Loaded prompts appear in `prompts/list` alongside the built-ins.
- **SSE streaming endpoint in the scaffold (`saptarishi-llm init`).** Generated apps now include a `POST /stream/chat` route registered inline in `srv/ai-service.js`. Streams `data: <chunk>\n\n` frames per token, ends with `data: [DONE]\n\n`. README example includes `curl -N` invocation.
- **MCP resource templates (parametrized URIs).**
  - New method: `resources/templates/list` returns registered `{ uriTemplate, name, description, mimeType }` entries.
  - `resources/read` now tries an exact match first, then falls back to matching against templates.
  - `registerResourceTemplate({ uriTemplate: 'user://{id}', read: ({ id }) => ... })`. RFC-6570-lite: `{name}` placeholders substituted via regex. Multi-param supported (`org://{orgId}/repo/{repoName}`).
  - Two built-in templates in `saptarishi-llm mcp`:
    - `provider://{kind}` — default model for a given provider kind
    - `prompt://{name}` — metadata for a registered prompt template (arguments, description)
- Capability advertising now includes `resources: {}` when *either* static resources OR templates are registered.
- 17 new tests (217 total): loadFromDir (all export shapes, missing dir, sorted file order, non-JS ignored), MCP resource templates (register validation, list, read matching, multi-param, static > template precedence, capability advertising with only templates), buildResourceTemplates (provider + prompt), scaffold SSE (generated file references `cds.app.post`, `text/event-stream`, `llm.stream`), README references `/stream/chat`, end-to-end mcp subprocess test extended for `resources/templates/list`, `resources/read` against `provider://ollama`, and `--prompts-dir` loading a custom template.
- TS defs: `loadFromDir` on `PromptRegistry`.

### Notes

- Additive — no changes to existing MCP methods or CAP-plugin behavior. `^1.8` consumers can bump to `^1.9` with zero code changes.

## [1.8.0] — 2026-07-29

### Added

- **`PromptRegistry` — named prompt-template registry.** Register templates once; invoke by name from CAP handlers or expose over MCP. Templates declare their arguments (with `required` flag), then `render(vars)` returns a partial `ChatRequest` (system, messages, format) that callers merge into their per-call options.

  ```js
  const { PromptRegistry, builtInPrompts } = require('@saptarishi/cds-plugin-llm');
  const prompts = new PromptRegistry().registerAll(builtInPrompts());

  const req = prompts.render('extract_json', { text: '...', schema: {...} });
  const res = await llm.chat({ ...req, maxTokens: 512 });
  ```

  Ships 5 general-purpose built-ins: `summarize`, `extract_json`, `classify`, `translate`, `procurement_risk_scorer` (SAP-flavored for demos).

- **MCP: `prompts/list` + `prompts/get` support.** `saptarishi-llm mcp` now advertises the `prompts` capability and exposes every registered template (built-ins by default). Clients like Claude Desktop show them as "commands" the user can select.

- **MCP: `resources/list` + `resources/read` support.** Two config resources exposed by default:
  - `config://active-provider` — current provider + model + middleware count
  - `config://supported-providers` — every provider kind + default model
  Optional `usage://cache-stats` when a `cacheStats` fn is passed.

- Capability advertisement is now dynamic: `resources: {}` only appears in `initialize` when at least one resource is registered; `prompts: {}` only when a registry is attached.

- 26 new tests (200 total): PromptRegistry (16), MCP prompts + resources handlers (10 in-process + end-to-end subprocess coverage of `resources/list`, `prompts/list`, `prompts/get`).
- TS defs: `PromptRegistry`, `PromptTemplate`, `PromptArgument`, `RenderedPrompt`, `builtInPrompts`.

### Notes

- Additive — no changes to CAP-plugin runtime behavior or existing MCP methods. `^1.7` consumers can bump to `^1.8` with zero code changes.

## [1.7.0] — 2026-07-29

### Added

- **`saptarishi-llm mcp` — Model Context Protocol server.** Exposes the configured provider (including its middleware stack, response cache, rate limits, and OTel spans) as a stdio JSON-RPC MCP server. Register in Claude Desktop / Cursor / Zed / any MCP client and those clients gain a `chat` / `embed` / `verify` / `list_providers` tool backed by *your* provider config.
  - Hand-rolled MCP protocol implementation (2024-11-05 spec) over line-delimited stdio JSON-RPC 2.0 — zero new dependencies.
  - Handles: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Serialized message queue so replies stay in order and pending work drains before shutdown.
  - Tool errors surface as `result.isError: true` (per spec), not as JSON-RPC errors — the model sees the error and can recover.
  - Provider `init()` runs at startup before stdin is read, so credential errors surface immediately.
  - stdout reserved for protocol only; logs go to stderr (prefixed `[mcp:level]`).
- Claude Desktop config example in README:

  ```json
  {
    "mcpServers": {
      "saptarishi-llm": {
        "command": "npx",
        "args": ["-y", "@saptarishi/cds-plugin-llm", "mcp"],
        "env": { "SAPTARISHI_LLM_PROVIDER": "groq", "GROQ_API_KEY": "gsk-..." }
      }
    }
  }
  ```

- 23 new tests (171 total): protocol correctness (initialize, tools/list, tools/call, ping, notifications, unknown method, bad jsonrpc version, tool-throws-vs-JSON-RPC-error distinction), stdio pipe integration (multi-line + parse errors), tool implementations (all 4 tools, chat validation, anthropic-embed rejection), and end-to-end subprocess handshake.

### Notes

- Additive — no changes to CAP-plugin runtime behavior. `^1.6` consumers can bump to `^1.7` with zero code changes; MCP server is opt-in via CLI.

## [1.6.0] — 2026-07-29

### Added

- **`saptarishi-llm init <dir>` subcommand — scaffolds a working CAP app pre-wired to this plugin.** Turns "install & try" into a single command:

  ```bash
  npx @saptarishi/cds-plugin-llm init joule-demo --provider groq
  cd joule-demo && npm install && cds watch
  ```

  Generates:
  - `package.json` with `cds.requires.llm` config for the chosen provider (`${ENV_VAR}` substitution so credentials come from `.env`)
  - `srv/ai-service.cds` — service exposing `chat(prompt)` and `summarize(text)`
  - `srv/ai-service.js` — handlers using `cds.connect.to('llm')`
  - `.env.example` with provider-specific env vars
  - `.gitignore` (excludes `.env`, `node_modules/`, `gen/`)
  - `README.md` with run instructions

  Flags: `--provider <kind>` (default `anthropic`), `--model <id>`, `--force` (overwrite non-empty dir), `--dry-run` (print plan, write nothing). App name derived from directory basename.
- 14 new tests (148 total) covering template substitution, all 5 provider paths, non-empty dir rejection, `--force`, `--dry-run`, app-name derivation, and end-to-end subprocess invocation.

### Notes

- Additive — no changes to CAP-plugin runtime behavior. `^1.5` consumers can bump to `^1.6` with zero code changes; scaffolder is opt-in.

## [1.5.0] — 2026-07-29

### Added

- **`saptarishi-llm` CLI.** Executable ships in the package `bin/`, invokable via `npx @saptarishi/cds-plugin-llm` or globally after `npm i -g`. Uses Node's built-in `node:util` parseArgs — zero new runtime deps.
- **Subcommands:**
  - `chat` — send prompt, print response (plain text or `--json`)
  - `stream` — stream tokens live to stdout
  - `embed` — embed input(s), print vectors (or `--json` for full dump). Multiple inputs delimited by lines containing `---`.
  - `verify` — tiny probe against configured provider; reports latency + reply. Exits 0 on `/ok/i`, 1 otherwise. Handy for CI health checks.
  - `providers` — list supported provider kinds + their required env vars.
- **Input sources:** `--prompt` / `-p`, `--file` / `-f`, piped stdin, positional arg. Concatenated with blank lines.
- **Provider selection:** `--provider <kind>` or `SAPTARISHI_LLM_PROVIDER` env var. Credentials read from env vars only (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OLLAMA_URL`, `AICORE_*`) — never CLI flags, to avoid leaking secrets into shell history.
- 25 new tests (134 total) covering `providerFactory` (all 5 kinds, env fallback, missing-credential errors), each subcommand (plain + `--json` output, error paths), and end-to-end subprocess invocation (`--version`, `--help`, unknown command exit code).

### Notes

- Additive — no changes to CAP-plugin behavior. `^1.4` consumers can bump to `^1.5` with zero code changes; CLI is a free bonus.

## [1.4.0] — 2026-07-29

### Added

- **`redisRateLimit` middleware — shared token bucket across CF instances.** In-process `rateLimit` (1.3.0) is fine for single-instance CAP apps, but multi-instance CF deployments need a shared bucket so instance-A's quota use is visible to instance-B. This middleware backs the bucket with Redis, using an atomic Lua EVAL so concurrent instances cannot race. Duck-typed against any client with an `eval(script, numKeys, ...args)` promise API (`ioredis`, `node-redis` v4+). Same `capacity` / `refillPerSecond` / `keyFn` / `mode` semantics as the in-process version, plus `keyPrefix` (default `'saptarishi:llm:rl:'`).
- TS defs: `redisRateLimit`, `RedisRateLimitOptions`, `RedisClientLike`. 6 new tests (109 total).

### Notes

- Additive — `^1.3` consumers can bump to `^1.4` with zero code changes; `redisRateLimit` is opt-in and the `redis` client is BYO.

## [1.3.0] — 2026-07-29

### Added

- **Built-in `rateLimit` middleware.** Token-bucket rate limiter, per-key via `keyFn(ctx)`. Two modes: `'throw'` (raises `Error` with `code: 'RATE_LIMITED'` + `retryAfterMs`) or `'wait'` (pauses until a token is available). In-process only — back with Redis via custom middleware for multi-instance apps. 9 tests.
- **Built-in `otel` middleware.** OpenTelemetry integration duck-typed against `@opentelemetry/api` so no hard dependency. Spans wrap `chat` / `stream` / `embed`; attributes follow GenAI semantic conventions where possible (`gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.response.stop_reason`, `llm.cached`, `llm.tool_calls.count`, `llm.stream.chunks`, `llm.embed.count`). Stream span ends after iterator termination (`done` chunk, error, or early break) — never leaks. 7 tests.
- TS defs: `rateLimit`, `RateLimitOptions`, `otel`, `OtelOptions`, `OtelTracerLike`, `OtelSpanLike`.

### Notes

- Purely additive on top of the 1.2 middleware runner. Consumers on `^1.2` can bump to `^1.3` with zero code changes; new helpers are opt-in.

## [1.2.0] — 2026-07-29

### Added

- **Middleware / interceptor pattern.** `llm.use(mw)` registers a Koa-style middleware around every `chat` / `stream` / `embed` call.
  - Signature: `async (ctx, next) => ...` where `ctx = { method, request, meta }`
  - Compose in registration order (outermost first); `next()` returns the next middleware's result (or provider response)
  - Middleware may modify request before `next()`, modify response after, or short-circuit by returning without calling `next()`
  - For streams, `next()` returns an async iterable — wrap it to observe / transform chunks
  - `ctx.meta` shared across the chain for cross-middleware state
- `chat` / `stream` / `embed` internally refactored so caching, retry, and format-parsing are visible to middleware as `next()`-returned response fields (e.g. `cached: true` on cache hits).
- 14 new middleware tests (87 total). TS defs: `Middleware`, `MiddlewareContext`.

### Notes

- Purely additive — no changes to `chat` / `stream` / `embed` public shape or provider hooks. Consumers on `^1.1` can bump to `^1.2` with zero code changes.

## [1.1.0] — 2026-07-29

### Added

- **`runTools()` — automatic multi-turn tool-use loop.** Wraps the chat → execute-tools → append-results → repeat cycle so consumers don't rewrite the boilerplate for every agent-style handler. Signature: `runTools({ llm, system, messages, tools: [{ name, description, input_schema, run }, ...], maxSteps, onStep })`. Returns `{ text, messages, usage, steps, toolCalls, model, stopReason }`. Handles:
  - Multiple tool calls per turn
  - Tool exceptions → surfaced as `tool_result` with `is_error: true` so the model can recover
  - Unknown tool names → same treatment (no crash)
  - `maxSteps` safety cap (default 10) with actionable error message on overrun
  - Optional `onStep({ step, response })` callback per turn
- TypeScript definitions: `RunnableTool`, `RunToolsOptions`, `RunToolsResult`, `ExecutedToolCall`.

### Notes

- Purely additive — no changes to `chat` / `stream` / `embed` behavior. Consumers on `^1.0` can bump to `^1.1` with zero code changes.

## [1.0.1] — 2026-07-29

### Changed

- Updated repository URL references from `sap-joule-procurement-copilot` to `sap-joule-ai-plugin` (repo was renamed on GitHub) in README badges, contributing section, and clone snippets. Old URL still redirects via GitHub but will not be relied on going forward.
- Added `repository`, `bugs`, and `homepage` fields to `package.json` — npm listing page now shows a proper Repository link. `directory: "cds-plugin-llm"` tells npm the package lives in a subdirectory of the linked repo.

### Fixed

- `CHANGELOG.md` now included in the npm tarball (was omitted from 1.0.0 due to missing entry in the `files:` array).

## [1.0.0] — 2026-07-29

**Stability commitment.** The public API surface is now considered stable. Breaking changes will require a major version bump (2.0.0+). Additive changes and non-breaking bug fixes ship as minor / patch releases.

### Added

- API stability commitment for the entire public surface: `LLMService` and all 5 provider subclasses, `chat` / `stream` / `embed` shapes, content blocks (text / image / document), tool call shapes, stream chunks (`text_delta` / `done`), image / PDF helpers, and provider option fields (`kind`, `modelId`, `credentials`, `retries`, `responseCache`).

### Notes

- **GenAI Hub live verification remains an open item.** The provider is built to SAP's documented AI Core API contract, unit-tested against a wire-protocol-accurate mock (12 tests), and passes end-to-end mock verification. Live verification against a real AI Core `extended` deployment is welcomed as a community PR. This is a labeled gap rather than a blocker on the 1.0 stability commitment — the wire-protocol implementation is what the mock covers, and the mock matches SAP's docs.

## [0.9.0] — 2026-07-27

### Added

- **OpenAI-compatible PDF support** — `document` content blocks translate to OpenAI's inline `file` content-block (`{type:'file', file:{filename, file_data:'data:application/pdf;base64,...'}}`). Base64 only; URL PDFs throw with actionable guidance. Works on GPT-4o+. Groq and other OpenAI-compat providers without file support 400 upstream (honest signal).
- **GenAI Hub embeddings** via separate `embeddingDeploymentId` — `GenAIHubLLMService.embed()` hits `/v2/inference/deployments/{embeddingDeploymentId}/embeddings`. Config via `credentials.embeddingDeploymentId` or `AICORE_EMBEDDING_DEPLOYMENT_ID` env var.
- **Response caching layer** — opt-in per-instance LRU with configurable TTL + `maxEntries`. Key = SHA-1 of stable JSON of (model, maxTokens, system, messages, tools, format, thinking). Skips tool-use and streaming. Cache hits return response with `cached: true` and expose `hits` / `misses` / `size()` stats.
- `DocumentBlock` type + `cached` field on `ChatResponse` in TypeScript defs.

### Fixed

- OpenAI-compat message translator now enters the multi-part path for **any** non-text block (previously image-only). Mixed content arrays with only text + document blocks no longer silently drop the document.

## [0.8.0] — 2026-07-25

### Added

- **PDF document content blocks** for Anthropic providers (Claude 3.5+ has native PDF understanding). New helpers: `pdfFromFile`, `pdfFromUrl`, `pdfFromBase64`.
- Explicit unsupported-document errors on Ollama and OpenAI-compat providers with actionable guidance (render pages to images / use Anthropic).
- `DocumentBlock` type in TS defs; `ContentBlock` union expanded.

## [0.7.0] — 2026-07-23

### Added

- **Embeddings on OpenAI-compat providers** (OpenAI, Groq, Together AI, DeepSeek, LM Studio). Reuses `_headers()` so auth (Bearer + resource-group where applicable) works uniformly. Single string or `string[]` input.

## [0.6.3] — 2026-07-22

### Changed

- README expanded with Architecture diagram, Capability matrix, FAQ, Contributing, Roadmap sections. Documentation-only release.

## [0.6.2] — 2026-07-22

### Added

- **TypeScript definitions** shipped in `lib/index.d.ts` (7.9KB). No `@types/*` package needed. Includes generic `ChatResponse<D>`, discriminated `StreamChunk` union, all provider classes with correct inheritance.
- `tsconfig.json` for local `npm run typecheck`.
- CI step: `tsc --noEmit` runs on every push (Node 20 + 22 matrix).

## [0.6.1] — 2026-07-21

### Fixed

- **`cds.connect.to('llm')` now works idiomatically.** Removed `lib/llm.cds` from the plugin — CAP was auto-serving it as an empty OData endpoint that `cds.connect.to('llm')` returned instead of the impl class. Kind registrations use `external: true` instead of a `model` reference. Consuming apps no longer need the `PROVIDERS` map + `connectLLM()` workaround. Side benefit: `NODE_PRESERVE_SYMLINKS=1` no longer needed for `file:` dev deps.

## [0.6.0] — 2026-07-20

### Added

- **Streaming responses** — async-generator `stream()` on the base class. Unified chunk shape: `{ type: 'text_delta', text }` per token, `{ type: 'done', text, usage, stopReason, model }` at the end.
- Provider-specific wire parsing: Anthropic SDK's `messages.stream()`, OpenAI-compat SSE, Ollama NDJSON.
- `stream_options: {include_usage: true}` on OpenAI-compat requests so `usage` populates on the done chunk.
- `scripts/stream-demo.js` — env-configurable live demo.

## [0.5.0] — 2026-07-18

### Added

- **Vision / multimodal input** — unified `image` content-block shape (URL or base64 source). Provider-specific translation:
  - Anthropic: native content blocks
  - OpenAI-compat: `image_url` with data-URL for base64
  - Ollama: extracts to `images: [base64, ...]` on the message; URLs rejected
- Helpers: `imageFromFile`, `imageFromUrl`, `imageFromBase64`.

## [0.4.0] — 2026-07-16

### Added

- **Complete GenAI Hub provider** (was a stub). OAuth2 client-credentials flow against XSUAA with 60s-before-expiry token caching + refresh. `AI-Resource-Group` header. Deployment-based inference endpoint. VCAP_SERVICES auto-discovery when the AI Core service is bound.
- `OpenAICompatibleLLMService` refactored with `_endpoint()` and `_headers()` hooks so GenAI Hub can override auth without duplicating `_chat`.
- 12 unit tests + wire-protocol E2E verification against a mock AI Core (`scripts/mock-ai-core.js`, `scripts/verify-genai-hub.js`).

## [0.3.0] — 2026-07-15

### Added

- **Tool use / function calling** — unified `tools: [{ name, description, input_schema }]` input; normalized `toolCalls: [{ id, name, input }]` in response; `stopReason: 'tool_use'` when the model called a tool. Full round-trip translation for OpenAI-compat (`role:'tool'` + `tool_call_id`), pass-through for Anthropic.
- **Structured outputs** — unified `format` JSON schema across providers. Anthropic uses `output_config.format`; OpenAI-compat uses `response_format: {type:'json_object'}` plus schema-in-prompt for broadest coverage; Ollama uses native `format` field. Base class post-parses `.text` into `.data` with a fallback for JSON wrapped in prose.
- **Automatic retries** — exponential backoff on 429 / 5xx / 529, honors `Retry-After` headers. Configurable per-call (`retries: { max, baseMs, maxMs }`) or globally in `cds.requires.<name>.retries`.

## [0.2.0] — 2026-07-14

### Added

- **Groq provider** (`llm-groq`) — inherits from a new generic `OpenAICompatibleLLMService`. Default model `llama-3.3-70b-versatile`.
- **Generic OpenAI-compatible provider** (`llm-openai-compatible`) — works with any endpoint speaking OpenAI's `/chat/completions` shape (OpenAI, Together AI, Fireworks, DeepSeek, LM Studio, LocalAI).

## [0.1.0] — 2026-07-14

Initial release. Anthropic + Ollama providers; GenAI Hub stub with wiring notes.
