# Changelog

All notable changes to `@saptarishi/cds-plugin-llm`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.20.0] — 2026-08-04

### Added

- **MCP Streamable HTTP transport (spec 2025-03-26).** The spec-blessed replacement for the older HTTP+SSE transport (2024-11-05). One endpoint speaks the whole protocol; broadly compatible with Claude Desktop, Cursor, VS Code Copilot, and every modern MCP client.

  ```sh
  saptarishi-llm mcp --http --transport streamable-http \
    --port 3333 --host 0.0.0.0 \
    --allowed-origins https://app.example.com \
    --auth-token $SAPTARISHI_LLM_MCP_TOKEN
  ```

- **Wire protocol** (default path: `/mcp`):
  - `POST /mcp` — client sends a single JSON-RPC message.
    - Notification (no `id`) → `202 Accepted` with empty body.
    - Request (with `id`) → `200 application/json` with the reply.
    - Parse error → `400`.
    - First request (initialize) with no session id: server assigns a UUID and returns it via the `Mcp-Session-Id` **response header**; client echoes it on every subsequent request.
    - Non-initialize request with no session id → `400`.
    - Any request with an unknown session id → `404` (spec-conforming signal for the client to re-initialize).
  - `GET /mcp` — optional long-lived SSE stream for server-initiated notifications (list_changed, resources_updated, in-flight tool-call progress). Requires `Mcp-Session-Id`. Unknown session → `405`.
  - `DELETE /mcp` — explicit session termination. Returns `204`. Unknown session → `404`.

- **Origin validation (DNS-rebinding protection).** New `allowedOrigins: string[]` option — the server rejects requests with `Origin` headers not in the whitelist (`403 Forbidden`). Requests without an `Origin` header (native / server-to-server clients, curl) are allowed. Not set = accept any origin (dev-friendly default). CLI flag: `--allowed-origins a.com,b.com` (or env `SAPTARISHI_LLM_MCP_ALLOWED_ORIGINS`).

- **Session state carries the same shape as the HTTP+SSE transport.** Per-session subscriptions (from `resources/subscribe`), per-session provider alias (from `initialize._meta.provider`), and per-session GET-stream fan-out for broadcast + progress notifications. Tool handlers see `ctx.sessionState.provider` regardless of which transport the client used to connect.

- **Configurable endpoint path via `path` option** (default `/mcp`). Multiple transports can share one process by pointing them at different paths.

- **Pluggable bearer-token auth**: same `authToken` (constant-time compare) and `authTokenVerifier` (async, returns claims or null) as `createHttpTransport`, so a JWKS-based `createJwtVerifier` works on both transports unchanged. `/health` remains public.

- **CLI additions on `saptarishi-llm mcp --http`**:
  - `--transport streamable-http` — opt into the new transport (default remains `sse` for back-compat).
  - `--path /some/other/path` — custom endpoint path (Streamable HTTP only).
  - `--allowed-origins a.com,b.com` — origin whitelist.

- **Exports**: `createStreamableHttpTransport` and `createHttpTransport` are now both re-exported from `lib/index.js` for programmatic use. TS defs added — `CreateStreamableHttpTransportOptions`, `TransportHandle`, `MCPServerLike` — with `@since` tags.

- 27 new tests (422 total): health + basic routing, session assignment on initialize, session reuse via `Mcp-Session-Id` header, non-initialize with no session → 400, unknown session → 404 / 405, parse error → 400, notification → 202, GET stream with broadcast + progress fan-out, DELETE lifecycle, session-state isolation across N sessions, three auth surfaces (missing / matching / verifier), Origin whitelist (accept / reject / missing-is-OK), custom path, close() cleanup.

### Notes

- Additive — the existing `createHttpTransport` (HTTP+SSE) is unchanged. `^1.19` consumers can bump to `^1.20` with zero code changes. Migrate at your leisure; older MCP clients that only speak HTTP+SSE stay on `--http` alone.
- Same session-lifecycle model as HTTP+SSE: session state (subscriptions, provider alias, streams) cleaned up on DELETE, on `close()`, or when the last GET stream drops for a session that has no in-flight POST requests. Explicit DELETE from the client is the intended shutdown path.
- Progress notifications for a POST tool-call are delivered to the session's open GET stream (if any). If the client hasn't opened one, notifications are dropped — matches the HTTP+SSE trade-off. Clients that care about progress should keep a GET stream open for the session's lifetime.

## [1.19.0] — 2026-08-03

### Added

- **`llm-gemini` provider — Google Gemini via Google AI Studio.** Direct-fetch implementation (no SDK), full feature parity with the existing providers:
  - Chat via `POST /v1beta/models/{model}:generateContent`
  - Streaming via `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` — SSE frame parsing with split-chunk tolerance
  - Embeddings via `:embedContent` (single) or `:batchEmbedContents` (arrays — one round-trip for N inputs)
  - Tool use — unified `{ name, description, input_schema }` translated to `tools[0].functionDeclarations`; `functionCall` parts parsed back into unified `toolCalls`
  - Vision — base64 `image` blocks → `inlineData: { mimeType, data }`. URL blocks throw (Google AI Studio does not fetch)
  - Structured outputs — `format` schema is sanitized (Gemini rejects `$schema` / `additionalProperties` / `title` / `default`) and passed as `generationConfig.responseSchema` with `responseMimeType: 'application/json'`
  - Role translation — unified `assistant` → Gemini `model`; system-role in `messages` throws with a specific error pointing at the `system` field
  - Auth via `x-goog-api-key` header (or `credentials.apiKey` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` env)

  ```jsonc
  // cds.requires.llm
  { "kind": "llm-gemini", "modelId": "gemini-1.5-pro",
    "credentials": { "apiKey": "..." } }
  ```

- **`llm-bedrock` provider — AWS Bedrock via the Converse API.** Uses `@aws-sdk/client-bedrock-runtime` as an **optional peer dependency** (users only install it when they configure this provider):
  - Chat via `ConverseCommand` — Bedrock's provider-agnostic surface (works with Claude-on-Bedrock, Llama, Mistral, Nova, ...)
  - Streaming via `ConverseStreamCommand` — yields `text_delta` chunks; captures `messageStop.stopReason` + `metadata.usage`
  - Embeddings via `InvokeModelCommand` — model-specific body shapes (Titan v1/v2: `{ inputText }`; Cohere embed v3: `{ texts, input_type }`); default embedding model `amazon.titan-embed-text-v2:0`
  - Tool use — unified tools → `toolConfig.tools[].toolSpec`; `toolUse` blocks parsed back into unified `toolCalls`. `tool_result` blocks with `is_error` set → `status: 'error'`
  - Vision — base64 `image` blocks → `image: { format, source: { bytes } }`; MIME → Bedrock format map (png/jpeg/gif/webp only). URL blocks throw. Media type validation fails fast for unsupported types
  - SigV4 signing, retry backoff, and endpoint resolution are all delegated to the SDK. `maxAttempts: 1` on the SDK client so the base `LLMService.withRetry` isn't double-retried
  - Auth via SDK credentials chain — `credentials.{accessKeyId, secretAccessKey, sessionToken?}` or the standard AWS env vars / profile / IAM role. Region is mandatory

  ```sh
  npm install @aws-sdk/client-bedrock-runtime
  ```

  ```jsonc
  // cds.requires.llm
  { "kind": "llm-bedrock", "modelId": "anthropic.claude-opus-4-20250514-v1:0",
    "credentials": { "region": "us-east-1" } }   // creds picked up from env
  ```

- **CLI support**: `--provider gemini` and `--provider bedrock` on `chat` / `stream` / `embed` / `verify`. `saptarishi-llm init <dir> --provider gemini|bedrock` scaffolds a CAP app pre-wired to either. `providers` lists them; MCP `list_providers` tool and `config://supported-providers` resource now return 8 entries.

- **TS defs**: `GeminiLLMService` and `BedrockLLMService` classes exported from `lib/index.d.ts` with `@since 1.19.0`.

- **50 new tests (395 total)**: Gemini (26 — init/env fallbacks, endpoint construction, chat request shape, system-instruction mapping, role translation, tool declaration + parse, sanitized schema, base64 image + URL rejection, PDF-not-supported error, single + batch embed, SSE stream with split-chunk tolerance, CLI factory integration). Bedrock (24 — init region validation, SDK-missing error, credentials optional/session-token, `maxAttempts: 1`, chat/tools/vision/tool-result shape, Converse + ConverseStream + InvokeModel commands, Titan vs Cohere embed body shape, MIME→format map, batch embed via multiple InvokeModel calls, stream events → unified chunks, CLI factory integration). Adjusted 5 pre-existing tests hard-coded on the `supported` count (was 6, now 8) and the sorted provider-kind list.

### Notes

- Additive — every existing kind (`llm-anthropic`, `llm-ollama`, `llm-groq`, `llm-openai-compatible`, `llm-azure-openai`, `llm-genai-hub`) is unchanged. Consumers on `^1.18` bump to `^1.19` with zero code changes.
- No new required dependencies. `@aws-sdk/client-bedrock-runtime` is an **optional** peer dep — you only install it if you use `llm-bedrock`. Users on the other 7 kinds pay nothing.
- Bedrock retry policy: the SDK's own `maxAttempts` is set to 1 so the base `LLMService.withRetry` (exponential backoff with jitter) stays the single source of truth. Change `retries` in `chat({ retries })` to tune.
- Gemini's schema sanitizer strips 4 fields (`$schema`, `additionalProperties`, `title`, `default`) that the Gemini structured-output validator rejects; the rest of the schema is passed through untouched. If you find a field that Gemini also rejects, open an issue.

## [1.18.1] — 2026-07-31

### Fixed

- **Test-suite flakiness on CI (test-only, no shipped behavior change).** Two race conditions in the internal MCP test harness intermittently failed on `ubuntu-latest` — reproduced on Node 20 in one run and Node 22 in another. Fixes:
  - Persistent line-buffered reader for MCP subprocess stdio tests (attach `data` listener once; queue lines). The old per-call attach/detach dropped a JSON reply on the floor whenever the OS delivered two lines in a single chunk.
  - `openSSE().nextEvent()` now removes its waiter on timeout, so a late event isn't silently consumed by an already-rejected promise (which would cascade into unrelated assertion failures on subsequent calls). Timeout bumped 3s → 10s for slower CI runners.
  - Three sleep-then-assert-count-dropped patterns replaced with a poll-until-condition helper. The fixed 100ms budget was tight on ubuntu-latest.

- No changes under `lib/` or `bin/` — 1.18.0 users get identical runtime behavior; this release exists to make the CI signal reliable for downstream contributors.

## [1.18.0] — 2026-07-30

### Added

- **Per-session MCP provider overrides.** One `saptarishi-llm mcp` process can now serve multiple named provider configurations behind a single endpoint. Clients pick which one to use per session (via `initialize._meta.provider`) or per tool-call (via a `provider` arg on `chat`/`embed`/`verify`). Real enterprise use: one authenticated MCP endpoint, different agents hit different backends — the DevOps agent on `cheap`, the compliance reviewer on `smart`, the local dev on `local`. Credentials centralized server-side; agents never touch API keys.

  ```bash
  saptarishi-llm mcp --http --host 0.0.0.0 \
    --providers-config ./providers.json
  ```

  ```jsonc
  // providers.json
  {
    "cheap": {
      "kind": "groq",
      "model": "llama-3.1-8b-instant",
      "credentials": { "apiKey": "gsk_..." }
    },
    "smart": {
      "kind": "anthropic",
      "model": "claude-opus-4-7",
      "credentials": { "apiKey": "sk-ant-..." }
    },
    "local": {
      "kind": "ollama",
      "model": "qwen2.5:14b",
      "credentials": { "baseUrl": "http://localhost:11434" }
    }
  }
  ```

  **Resolution order** for each tool call: `arguments.provider` > `sessionState.provider` (from `initialize._meta.provider`) > top-level default.

- **`--providers-config <path>` CLI flag** (also `SAPTARISHI_LLM_PROVIDERS_CONFIG` env var). JSON file mapping alias → `{ kind, model, credentials }`. Every alias is validated + instantiated + `init()`'d at boot, so bad configs die at startup, not on the first client call. Reserved names (`default`) and invalid alias syntax rejected at load.

- **Session-scoped defaults via `initialize._meta.provider`.** MCP's spec-blessed `_meta` slot on the initialize handshake carries the session's preferred alias; every subsequent tool call on that session uses it unless overridden per-call. Isolated per connection — session A picking `cheap` never leaks to session B. Validation deferred to tools/call so a typo doesn't wedge the handshake (users can still see the `list_providers` tool that would show them the right names).

- **Per-call override via `chat` / `embed` / `verify` tool args.** Every call-site can bypass the session default by passing `provider: '<alias>'` in the tool arguments. Unknown alias → tool-result error listing the configured aliases so the model can self-correct on the next turn.

- **`config://providers` resource.** Machine-readable dump of the current alias set (kind + model per alias, plus the default) — **credentials never returned**. Clients can `resources/read` this at any time to discover what's available.

- **`list_providers` tool result grows `aliases: [...]`.** Each entry is `{alias, kind, model}` — same shape as `config://providers`, exposed as a tool for models that prefer tool calls over resource reads.

- **`MCPServer.handleMessage(msg, transportCtx)` accepts `transportCtx.sessionState`.** Plain object scoped to a single connection. Populated by `initialize._meta.*`; forwarded to tool handlers via `handlerCtx.sessionState`. Reset naturally when the transport closes and re-opens. Third-party transports get this for free by allocating a fresh `{}` per session (matching the stdio + HTTP+SSE patterns).

- Wire example (session default + per-call override):

  ```jsonc
  // client -> server: session default
  { "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": { "protocolVersion": "2024-11-05",
                "_meta": { "provider": "smart" } } }

  // client -> server: uses session default (smart)
  { "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": { "name": "chat", "arguments": { "prompt": "summarize this PO" } } }

  // client -> server: per-call override, ignores session default
  { "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": { "name": "chat",
                "arguments": { "prompt": "dispatch this", "provider": "cheap" } } }
  ```

- 35 new tests (345 total):
  - `providerAliases.test.js` (30): registry (default fallback, known/unknown alias resolution, non-string rejection, list without credentials, hasAliases); config loader (JSON parse, parsed-object input, unknown kind, missing credentials, reserved 'default' alias, invalid alias syntax, malformed JSON error surfaces path, non-object root); `resolveConfigPath` (null, flag > env, relative → absolute); tools/call routing (default when no arg + no session, per-call arg wins, session default via `_meta.provider`, per-call wins over session, unknown alias error message, embed alias routing, embed anthropic rejection, verify uses session default, `list_providers` exposes aliases); `initialize._meta.provider` (stored in sessionState, missing = untouched, non-string ignored); tools/call handlerCtx exposes sessionState
  - `mcpHttp.test.js` (+2): initialize._meta.provider persists across POSTs on same session; sessionState isolated between sessions

### Notes

- Additive — `^1.17` consumers bump to `^1.18` with zero code changes. Aliases are opt-in; without `--providers-config` the tools behave exactly as before.
- **Credentials NEVER cross the MCP wire.** They live in `providers.json` (server-side, `chmod 600`); the wire only carries alias names. Rejecting client-supplied credentials is deliberate — it keeps the trust boundary at the server.
- Config file changes need a server restart. `--watch` for the config file is out of scope for 1.18; add-on for a future release.
- Ergonomic tip: `chmod 600 providers.json` + keep it out of git. Or point `--providers-config` at a path served by your secrets manager (`vault kv get -format=json …`).

## [1.17.0] — 2026-07-30

### Added

- **MCP resource subscriptions.** Clients can now `resources/subscribe` to a specific URI and get pushed a `notifications/resources/updated` whenever that resource mutates — no polling. Complements the list-changed notifications from 1.13.0: use `list_changed` when the *set* of resources shifts, `resources/updated` when a *specific* resource's content changes. Standard MCP 2024-11-05 subscriptions feature.

  Wire format:

  ```jsonc
  // client -> server
  { "jsonrpc": "2.0", "id": 1, "method": "resources/subscribe",
    "params": { "uri": "prompt://summarize" } }
  // server -> client (later, on change)
  { "jsonrpc": "2.0", "method": "notifications/resources/updated",
    "params": { "uri": "prompt://summarize" } }
  ```

  - **Per-connection state** — subscriptions live on the connection, not the server. Session A subscribing to `config://a` never affects session B. Cleaned up automatically when the SSE stream / stdio pipe closes.
  - **Delivered on both transports** — stdio writes updates to stdout on the same stream as replies; HTTP+SSE pushes to the subscribing session's SSE stream only.
  - **`resources/unsubscribe`** is idempotent — safe to call for a URI you never subscribed to.
  - **Unknown URIs rejected** at subscribe time (`invalid params`) so client typos surface immediately instead of subscribing to a URI that will never fire. Matches both static resources and template URIs (`prompt://{name}`, `provider://{kind}`).

- **`--watch-prompts` now fires per-URI updates.** When a template hot-reloads and a client had previously pinned to that prompt via `resources/subscribe('prompt://summarize')`, they get an immediate `resources/updated` for that exact URI (in addition to the existing `prompts/list_changed` broadcast). Iterate on a prompt file and every subscribed client refreshes their cached copy without a `resources/read`.

- **`MCPServer.notifyResourceUpdated(uri)`** — public broadcast helper. Silent no-op when nobody's subscribed to `uri` — safe to fire optimistically from hot-reload / cache-invalidation hooks. Subscriber errors are logged but don't break the broadcast to others (same semantics as `notifyListChanged`).
- **`MCPServer.subscribedUris(prefix?)`** — enumerate the distinct URIs any connected client has subscribed to, optionally filtered by prefix (e.g. `'prompt://'`). Useful when a broad invalidation event needs to fan out per-URI updates only to URIs someone actually cares about.
- **`addSubscriber` return value grew a `subscriptions` Set property.** Transports use it to pass per-session subscription state into `handleMessage` via `transportCtx.subscriptions`. Backwards compatible — existing callers that only invoke the unsubscribe function keep working.

- **Capability advertising updated.** `initialize` now returns `resources: { listChanged: true, subscribe: true }` (per MCP spec) when any resource or resource template is registered — signals to the client that both list_changed AND subscribe are available.

- 18 new tests (310 total):
  - `MCPServer` (+15): `addSubscriber` returns Set-carrying unsubscribe; `resources/subscribe` adds URI, accepts templated URI, rejects unknown URI, rejects missing uri; `resources/unsubscribe` removes URI, idempotent for never-subscribed URI; `notifyResourceUpdated` validates uri, routes only to subscribers of that URI, silent no-op with none, fans out to multiple, survives throwing subscriber; unsubscribe drops sink + its subscriptions; `subscribedUris` distinct + prefix-filtered; end-to-end subscribe → notify → unsubscribe over transportCtx
  - `httpTransport` (+3): per-session routing (A subscribed to `config://a`, B to `config://b`; each only receives their URI); `resources/unsubscribe` stops delivery; subscriptions cleared when session closes

### Notes

- Additive — `^1.16` consumers bump to `^1.17` with zero code changes. Subscriptions are opt-in from the client side; servers that don't `notifyResourceUpdated` behave identically to 1.16.
- The hot-reload path calls both `notifyListChanged('prompts')` (unchanged from 1.13) AND `notifyResourceUpdated('prompt://<name>')` (new) — clients that subscribed to specific prompt URIs get a targeted refresh; clients that only listen to list_changed keep working.

## [1.16.0] — 2026-07-30

### Added

- **MCP OAuth2 / JWKS-based JWT authentication** for the HTTP transport. Standard OAuth2/OIDC path — server validates `Authorization: Bearer <jwt>` against a remote JWKS endpoint, with optional issuer + audience claim checks. Works with any spec-compliant IdP: SAP XSUAA, Auth0, Okta, Azure AD, Google, Keycloak, AWS Cognito, Zitadel.

  ```bash
  saptarishi-llm mcp --http --host 0.0.0.0 \
    --jwks-url https://tenant.authentication.us10.hana.ondemand.com/token_keys \
    --jwt-issuer https://tenant.authentication.us10.hana.ondemand.com \
    --jwt-audience sb-my-cap-app!t12345
  ```

  - CLI flags: `--jwks-url`, `--jwt-issuer`, `--jwt-audience` (+ env fallbacks `SAPTARISHI_LLM_MCP_JWKS_URL`, `_JWT_ISSUER`, `_JWT_AUDIENCE`)
  - JWKS caching + auto-refresh handled by `jose` (peer dep — `npm install jose`)
  - Silent uniform 401 on any failure (bad sig, expired, wrong iss/aud, unknown kid) — never leaks *why* to avoid oracle attacks. Same rationale as the bearer-token constant-time compare.

- **Pluggable `authTokenVerifier`** on `createHttpTransport`. New shape: `async (token) => claims | null`. Custom flows (introspection endpoint, mTLS metadata mapping, JWT + local role check, etc.) drop straight in. Static-string `authToken: 'xxx'` (v1.11.0 API) is auto-wrapped into a verifier internally, so existing configs keep working unchanged.
- **`createJwtVerifier({jwksUrl, issuer?, audience?})`** — public factory returning an `AuthTokenVerifier` backed by `jose`. Reusable outside the CLI, e.g. for programmatic MCP HTTP setup or your own auth middleware.

- 14 new tests (292 total):
  - `jwtVerifier.test.js` (7): `jwksUrl` required, `createRemoteJWKSet` initialized from URL, valid token returns claims, invalid/thrown collapses to null, `issuer` + `audience` forwarded to `jose.jwtVerify`, unspecified issuer/audience omitted from opts
  - `mcpHttp.test.js` (+7): verifier accepts token when returning truthy, rejects when null, throws treated as rejection (logged), `/health` public even with verifier configured, missing Authorization header rejected, verifier wins when both `authToken` + `authTokenVerifier` supplied (warning logged), static `authToken` still works (v1.11.0 back-compat)

- TS defs: `AuthTokenVerifier` type, `createJwtVerifier` function. Exercised in `types.test-d.ts`.

### Notes

- Additive — `^1.15` consumers bump to `^1.16` with zero code changes. Existing `--auth-token` usage keeps working identically; JWT auth is opt-in per deployment.
- `jose` is an OPTIONAL peer dep — only needed when you use `--jwks-url` or `createJwtVerifier`. Static bearer tokens don't need it.
- On BTP with an XSUAA service binding, extract `credentials.uaadomain` + `credentials.xsappname` to build the flags:
  - `--jwks-url https://<subaccount>.authentication.<region>.hana.ondemand.com/token_keys`
  - `--jwt-issuer https://<subaccount>.authentication.<region>.hana.ondemand.com`
  - `--jwt-audience <xsappname>`

## [1.15.0] — 2026-07-29

### Added

- **Azure OpenAI provider** (`llm-azure-openai`). Same chat/embed shapes as OpenAI, but per-deployment URL scheme and `api-key` header (not Bearer). Real enterprise value for SAP shops that already run Azure OpenAI under their existing Microsoft procurement + governance stack.

  ```json
  { "cds": { "requires": { "llm": {
      "kind": "llm-azure-openai",
      "credentials": {
        "endpoint": "https://my-aoai.openai.azure.com",
        "apiKey":   "${AZURE_OPENAI_API_KEY}",
        "deployment": "my-gpt4o",
        "embeddingDeployment": "my-text-embedding-3-small",
        "apiVersion": "2024-10-21"
      }
  } } } }
  ```

  - **URL scheme**: `<endpoint>/openai/deployments/<deployment>/chat/completions?api-version=<v>` for chat, `<endpoint>/openai/deployments/<embeddingDeployment>/embeddings?api-version=<v>` for embeddings.
  - **Separate embedding deployment** — Azure typically pins each model to its own deployment; supply `embeddingDeployment` to route `/embeddings` calls to a different deployment than chat. Defaults to `deployment` when not set.
  - **Default `apiVersion`**: `2024-10-21`. Override for `-preview` API versions.
  - Endpoint URLs auto-normalize (trailing slash stripped).
  - Reuses the existing OpenAI-compatible request/response translation — vision, PDF (base64 + file_id), tool use, structured output, streaming, retries, and response caching all work unchanged.
- **`_embedEndpoint()` hook** added to `OpenAICompatibleLLMService` — subclasses (Azure, GenAI Hub, future ones) can now override embeddings URL construction alongside the existing `_endpoint()` hook.
- **CLI + scaffolder support**: `saptarishi-llm --provider azure-openai` and `saptarishi-llm init foo --provider azure-openai`. Env vars: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, plus optional `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` and `AZURE_OPENAI_API_VERSION`.
- MCP `list_providers` tool + `config://supported-providers` resource now include Azure.
- 12 new tests (279 total):
  - `azure-openai.test.js` (12): missing-credentials error message, embeddingDeployment defaults to deployment, default apiVersion, trailing-slash normalization, `_endpoint` + `_embedEndpoint` URL construction, `api-key` header (not Bearer), chat POSTs to per-deployment URL, embed POSTs to per-embedding-deployment URL, custom apiVersion applied to both endpoints, CLI `providerFactory` builds AzureOpenAILLMService, missing env vars listed
- TS defs: `AzureOpenAILLMService` extends `OpenAICompatibleLLMService`.

### Notes

- Additive — `^1.14` consumers bump to `^1.15` with zero code changes; the new provider is opt-in via configuration.
- Zero new dependencies.

## [1.14.0] — 2026-07-29

### Added

- **`uploadPdfFromUrl(url, options)` — OpenAI Files API helper.** Fetches a PDF from `url`, uploads via `POST <baseUrl>/files` (multipart/form-data), returns a plugin-shape document block referencing the returned `file_id`. Closes a real capability gap: URL PDFs on GPT-4o used to throw with "use pdfFromBase64"; now users can point at a URL and have it Just Work with one helper call.

  ```js
  const { uploadPdfFromUrl } = require('@saptarishi/cds-plugin-llm');
  const doc = await uploadPdfFromUrl('https://example.com/spec.pdf', {
    apiKey: process.env.OPENAI_API_KEY,
    // baseUrl:  'https://api.openai.com/v1'  (default)
    // purpose:  'user_data'                  (default)
    // filename: <inferred from URL basename>
  });
  await openai.chat({ messages: [{ role: 'user', content: [doc, textBlock] }] });
  ```

- **`DocumentBlock` gains a third source type: `file_id`.** OpenAI-compat provider translates `{type:'document', source:{type:'file_id', file_id:'file-xxx'}}` into `{type:'file', file:{file_id:'file-xxx'}}` on the chat.completions request. Base64 and URL sources still work exactly as before.

- URL PDF error message on OpenAI-compat providers now points users to the new helper (previously only suggested `pdfFromBase64` — technically correct but forced a manual download+encode step).

- Zero new runtime deps — uses global `fetch` / `FormData` / `Blob` (Node 18+, already required by the plugin).

- 13 new tests (267 total):
  - `openaiFiles.test.js` (11): validation (missing url/apiKey), download failure surfacing, upload failure with response body, happy path (verifies FormData shape + Authorization header + returned block), trailing slash on baseUrl stripped, filename inference from URL path (with + without extension), explicit `filename` override wins, missing `id` in upload response, `fetchHeaders` forwarded on download request
  - `pdf.test.js` (+2): document block with `source.type=file_id` passes through as `file.file_id` in chat.completions body; URL PDF error message now mentions `uploadPdfFromUrl`

- TS defs: `DocumentFileIdSource`, `uploadPdfFromUrl(url, options): Promise<DocumentBlock>`. Exercised in `types.test-d.ts`.

### Notes

- Additive — no changes to existing behavior for base64 or URL sources. `^1.13` consumers can bump to `^1.14` with zero code changes; the helper and the new source type are opt-in.
- Non-OpenAI compat endpoints (Groq, DeepSeek, Together, etc.) don't expose `/v1/files` — attempting `uploadPdfFromUrl` there will 404 with an actionable error message.

## [1.13.0] — 2026-07-29

### Added

- **MCP list-changed notifications.** When the server's tool / resource / prompt list mutates at runtime, connected clients get a `notifications/{prompts,resources,tools}/list_changed` push and can refresh their view — no polling. Standard MCP 2024-11-05 feature.
- **`--watch-prompts` now broadcasts on reload.** When hot-reload picks up template changes, the CLI calls `server.notifyListChanged('prompts')`; every connected MCP client sees the update immediately. Iterate on prompts in a folder and Claude Desktop / Cursor / Zed refreshes without a restart.
- **`MCPServer.addSubscriber(sendNotification)`** — transport-facing API for registering per-connection notification sinks. Returns an unsubscribe function that the transport MUST call on disconnect to prevent sink leaks. Wired for both stdio (one sink for `run()` duration) and HTTP+SSE (one sink per session, tied to `/sse` connection lifecycle).
- **`MCPServer.notifyListChanged(kind)`** — broadcast helper. `kind` is `'prompts' | 'resources' | 'tools'`. Silently no-ops when no subscribers. Subscriber errors are logged but don't break the broadcast to others.
- **Capability advertising updated.** `initialize` now returns `{ tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }` (per MCP spec) — signals to the client that it can rely on push notifications instead of polling.

- 10 new tests (254 total):
  - `MCPServer` (+7): `addSubscriber` validates fn, `notifyListChanged` validates kind, silent no-op with no subscribers, unsubscribe removes subscriber, broadcast reaches every subscriber, correct method per kind, throwing subscriber doesn't break others, `initialize` advertises `listChanged: true` on all present capabilities
  - `httpTransport` (+2): broadcast reaches every SSE session; subscriber leak — closed session unregisters its sink

### Notes

- Additive — no changes to existing behavior. `^1.12` consumers can bump to `^1.13` with zero code changes; hot-reload broadcasts happen automatically when both `--prompts-dir` and `--watch-prompts` are set.

## [1.12.0] — 2026-07-29

### Added

- **MCP progress notifications on `tools/call`.** Tool handlers grow an optional second argument — a `ctx` object with `reportProgress(current, total?)`. When a client sends a `tools/call` with `_meta.progressToken`, calls to `reportProgress` become server-sent `notifications/progress` messages carrying that token. Perfect for long-running tools (batch embeds, multi-step agents, streaming chains) that would otherwise leave the client hanging silently.
  - Wire format (MCP 2024-11-05):

    ```json
    { "jsonrpc": "2.0", "method": "notifications/progress",
      "params": { "progressToken": "<from client>", "progress": 3, "total": 10 } }
    ```

  - Delivered on **both transports**: stdio writes the notification to stdout on the same stream as replies; HTTP+SSE pushes it on the requesting session's SSE stream.
  - `total` is optional — omit for indeterminate progress.
  - Existing tools that ignore the second `ctx` argument keep working — the API is 100% backwards-compatible.
- `handleMessage(msg, transportCtx?)` — new optional second arg exposing `sendNotification(msg)`. Transports wire it to the appropriate connection. Public for third-party transport authors.

- 6 new tests (244 total):
  - `ctx.reportProgress` no-ops safely when the client didn't send a `progressToken`
  - Multiple progress calls emit multiple notifications with correct token
  - `progressToken` without a transport sink is silently ignored (no throw)
  - `reportProgress(n)` (no `total`) omits the `total` field
  - Existing single-arg tool handlers keep working
  - End-to-end over HTTP+SSE: client posts `tools/call` with `_meta.progressToken`, receives 3 notifications interleaved with the final reply on the session's SSE stream

### Notes

- Additive — `^1.11` consumers can bump to `^1.12` with zero code changes. Tool handlers keep their existing signature; the second `ctx` argument is opt-in.

## [1.11.0] — 2026-07-29

### Added

- **MCP HTTP transport: bearer token auth.** `saptarishi-llm mcp --http --auth-token <token>` (or `SAPTARISHI_LLM_MCP_TOKEN` env var) requires `Authorization: Bearer <token>` on every `/sse` and `/messages` request. Rejected requests get `401 Unauthorized` + `WWW-Authenticate: Bearer realm="mcp"` header. `/health` stays public so load balancers and monitoring can probe without credentials.
- **Constant-time token comparison** — `safeEqual` avoids trivial timing side-channels on the byte-by-byte character compare. Length-mismatched tokens short-circuit to false immediately.
- **Bind-warning safety net** — starting `--http` on any non-loopback host without an `--auth-token` prints a stderr warning: "anyone on the network can call your provider". No hard failure — some deployments legitimately terminate auth at an upstream proxy — but the message is deliberately loud.
- `authRequired: <bool>` field added to `/health` response so clients know whether credentials are needed before hitting `/sse`.

- 7 new tests (238 total): `/health` public even with token, `/sse` and `/messages` reject missing / wrong token, correct token round-trips end-to-end, length-mismatched tokens rejected before byte compare, `WWW-Authenticate` header shape.

### Notes

- Additive — no changes to existing behavior. `^1.10` consumers can bump to `^1.11` with zero code changes; auth is opt-in per deployment.
- Backwards compatible: running `--http` without `--auth-token` still works exactly as before (bound to 127.0.0.1 by default, no auth).

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
