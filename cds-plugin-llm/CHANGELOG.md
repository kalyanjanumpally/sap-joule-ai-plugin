# Changelog

All notable changes to `@saptarishi/cds-plugin-llm`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.77.0] — 2026-08-09

### Added

- **`idempotency({ ttlMs?, keyFrom?, onInFlight?, onDuplicate?, ... })` — request deduplication over a short TTL window.** Protects against client retries on flaky networks that would otherwise cause double-billing for the same logical call. Different semantics from `responseCache` (long-lived intentional warm cache) and `retryOnRateLimit` (that middleware IS the retry; this handles the mirror case of dedup'ing CLIENT retries).

  ```js
  const { idempotency } = require('@saptarishi/cds-plugin-llm');

  llm.use(idempotency({
    ttlMs:   60_000,                                       // completed-window: 60s
    maxSize: 1000,
    keyFrom: (ctx) => ctx.raw?.headers?.['idempotency-key'],  // Stripe-style
  }));
  ```

- **Two duplicate windows, each with two failure modes:**

  | Window | Mode | Behavior |
  | --- | --- | --- |
  | in-flight (original still running) | `coalesce` (default) | subsequent callers await the SAME promise; one provider call happens |
  | in-flight | `reject` | throws `IdempotencyInFlightError` with `completed: false` |
  | completed (within `ttlMs`) | `return` (default) | subsequent callers get the cached result reference |
  | completed | `reject` | throws `IdempotencyInFlightError` with `completed: true` |

- **Key computation.** Explicit `keyFrom(ctx)` takes priority — supports Stripe-style `Idempotency-Key` headers or custom logic. Falls back to `hashOf(ctx)` (SHA-256 over model / messages / system / input / maxTokens / temperature / format / tools / seed). Falsy or throwing `keyFrom` transparently falls back. Empty/invalid keys bypass caching entirely.

- **LRU eviction with expiry.** Fixed-size Map (insertion-order preserves LRU). On access, expired entries at the head are swept. On write, if at capacity, oldest is evicted. Touching an entry (hit or coalesce) moves it to the end.

- **Errors are NOT cached.** A failed original call is removed from the store immediately — subsequent retry legitimately re-invokes the provider. Coalesced callers on an in-flight failure all receive the same rejection. `stats.errorsBypassed` tracks this.

- **Streams bypass by default** (`captureStreams: false`). Async iterators can't be shared safely — each caller must own its iteration. `captureStreams: true` is available for advanced use where callers coordinate consumption. `stats.streamsBypassed` counts.

- **New error code `IDEMPOTENCY_IN_FLIGHT`** in the 1.57 taxonomy: `httpStatus: 409` (Conflict — a request with this key is already being processed), `retriable: true` (safe to retry once the original completes), `severity: warning`. `IdempotencyInFlightError` carries `key` (full hash) and `completed` (boolean).

- **Introspection.** `stats: { totalRequests, hits, inFlightCoalesced, misses, rejected, evictions, streamsBypassed, errorsBypassed }` + `size()` + `has(key)` + `reset()` + `asMcpResource()` → `config://idempotency`.

- **TypeScript.** `IdempotencyOptions`, `IdempotencyStats`, `IdempotencyMiddleware`, `IdempotencyInFlightError`.

- **Recommended placement.** OUTER of `usageMetering` / `costBudget` (dedupes shouldn't re-bill), INNER of `promptInjectionGuard` / `guardrails` (still validate every caller's input, but dedupe the LLM call).

## [1.76.0] — 2026-08-07

### Added

- **`structuredOutputValidator({ schemaFrom?, onInvalid?, maxRetries?, ... })` — post-response JSON Schema validator.** Rejects (or auto-retries) LLM responses that don't match a declared schema. Complements 1.34 `schemas` (which ships pre-built JSON Schemas for common business objects) by enforcing them at the chain level rather than trusting the model to obey `format:` at the provider layer.

  ```js
  const { structuredOutputValidator, schemas } = require('@saptarishi/cds-plugin-llm');

  llm.use(structuredOutputValidator({
    onInvalid:  'retry',
    maxRetries: 1,
  }));

  const res = await llm.chat({
    messages: [{ role: 'user', content: 'Extract this invoice: ...' }],
    format:   schemas.Invoice,
  });
  //  → res.parsed = { vendor, currency, total, lineItems, ... }
  //  → throws StructuredOutputInvalidError if the model returned malformed JSON or missed a required field
  ```

- **Two failure modes.** `onInvalid: 'throw'` (default) surfaces `StructuredOutputInvalidError` immediately with the list of validation errors + the raw text — hand-off to your caller / retry policy. `onInvalid: 'retry'` appends a corrective user message ("your previous response failed schema validation: …") and re-invokes the chain up to `maxRetries` times. Retry mutates only `ctx.request` for the inner call and restores the original before returning, so outer middleware sees no side effects.

- **Built-in minimal validator (dep-free).** Handles the subset used by the shipped `schemas` module: `type`, `required`, `properties`, `items`, `enum`, `additionalProperties: false`. Recursive on nested objects + arrays. Sufficient to enforce every `schemas.*` shape without pulling in Ajv/Zod. Users who need full JSON Schema draft-7 can pass a `validate:` adapter — accepts either `string[]` errors or `{ ok, errors }` shape for Zod/Ajv integration.

- **Smart JSON extraction.** Default `extractJson` tries in order:
  1. `result.data` — provider already parsed via `format:` (LLMService fast path)
  2. `JSON.parse(result.text)` — clean text response
  3. Fenced code block `` ```json … ``` `` (or bare `` ``` `` fence) — very common Anthropic / OpenAI pattern
  4. First `{` → last `}` — model wrapped JSON in prose ("Here's your invoice: {…} Hope this helps!")
  5. First `[` → last `]` — top-level arrays

  Override via `extractJson:` for custom envelopes (function-call args, tool responses, etc.).

- **Correction prompt is customizable.** Default `buildCorrection({ errors, schema, rawText })` produces a compact "your previous response could not be parsed as valid JSON matching the required schema. Errors: … Return ONLY a JSON object matching this schema: …" message. `applyCorrection(request, text)` defaults to appending a user message but can be swapped to inject via `system` or a tool-response format.

- **Streaming support (1.72+).** `captureStreams: true` (default) defers validation to `onComplete` — validates the final done chunk's text after the stream is fully consumed. No retry is possible for streams (the caller has already consumed the output), but `stats.invalidStreams` increments so you can dashboard the failure rate. `captureStreams: false` skips streams entirely.

- **Non-destructive `result.parsed`.** On success, the validated object is attached to `result.parsed` (configurable via `attachParsedAs`). If the field already exists, it's left untouched — never clobbers a downstream middleware's earlier parse. Original `result.text` and `result.data` are always preserved.

- **New error code `STRUCTURED_OUTPUT_INVALID`** in the 1.57 taxonomy: `httpStatus: 502` (Bad Gateway — upstream returned malformed data), `retriable: false` (internal retry already exhausted or disabled), `severity: error`. `StructuredOutputInvalidError` extends `LLMError` and carries `errors[]`, `rawText`, `schema`, and `attempts`.

- **Introspection.** `stats: { totalValidated, valid, invalid, retries, retriesGivenUp, invalidStreams, skipped }` + `reset()` + `asMcpResource()` → `config://structured-output-validator`.

- **TypeScript.** `StructuredOutputValidatorOptions`, `StructuredOutputValidatorStats`, `StructuredOutputValidatorMiddleware`, `StructuredOutputInvalidError`.

## [1.75.0] — 2026-08-07

### Added

- **`replayBuffer({ size, redactFields?, ... })` — in-memory replay buffer.** Captures the last N request/response pairs in a rolling buffer for live inspection. Zero persistence — different use case from the 1.69 `testing.recording` (fixture files for tests).

  ```js
  const { replayBuffer } = require('@saptarishi/cds-plugin-llm');

  const rb = replayBuffer({
    size:                   100,
    redactFields:           ['messages', 'system'],
    includeRedactedPreview: true,
  });
  llm.use(rb);

  // Later — from a /debug endpoint, on-call incident, etc.:
  app.get('/debug/recent-llm', (req, res) => {
    res.json(rb.dumpLastN(20));
  });
  ```

- **Debugging use case:** "the LLM said something weird — pull the last 10 exchanges from memory and see what actually flowed." Complements `jsonLog` (1.59) which is fire-and-forget with `replayBuffer`'s lookback capability.

- **Every entry** carries the essentials without leaking sensitive data:

  ```json
  {
    "timestamp":     1691234567890,
    "method":        "chat",
    "model":         "gpt-4o-mini",
    "request":       { "model": "gpt-4o-mini", "maxTokens": 100, "messages_redacted": true },
    "response":      { "textPreview": "The answer is …", "textLength": 234, "model": "gpt-4o-mini", "usage": {...} },
    "error":         null,
    "durationMs":    1234,
    "correlationId": "req-abc-123",
    "ok":            true
  }
  ```

- **Smart redaction defaults** — `messages`, `system`, `input` stripped from the stored request (adds `_redacted: true` marker). Non-sensitive fields (model, maxTokens, temperature, etc.) preserved. Override via `redactFields: [...]` for tighter or looser policies.

- **`includeRedactedPreview: true`** — includes a truncated preview of the last user message even when `messages` is redacted. Set `previewChars` for the truncation length (default 200). Useful for debugging "which prompt triggered this weird response" without dumping the full conversation.

- **Response summarization** — text bodies over 200 chars truncated to `textPreview` with `textLength` for the original length. Full response objects (embeddings, tool results, etc.) never stored — just the summary essentials.

- **Structured error capture** — failed calls store `{ name, code, message, primitive, retriable }` matching the 1.57 LLMError taxonomy. Same shape whether the error came from an LLMError or a plain Error.

- **Stream capture (1.72+)** — `captureStreams: true` (default) defers capture until the stream is fully consumed, then records with the real duration + `done` chunk summary. `captureStreams: false` captures the envelope immediately (less useful — for consumers who want the raw envelope reference).

- **Correlation ID** — pulled from `ctx.meta.correlationId` (set by 1.64 `traceCorrelation`) so debug output can be cross-referenced with jsonLog / distributed trace / persisted rows.

- **Circular buffer semantics** — fixed-size Array with a write pointer. When capacity is reached, oldest entries are overwritten. `dump()` returns entries oldest → newest; `dumpLastN(n)` for a tail window; `dumpMatching(pred)` for filtered views.

- **Introspection + MCP:**
  - `rb.stats` → `{ totalCaptured, successes, failures }`
  - `rb.size()` / `rb.capacity()` — current entries / max
  - `rb.clear()` — wipe buffer + stats
  - `rb.asMcpResource()` → `config://replay-buffer` (full snapshot payload for MCP subscribers)

### Type definitions

- `ReplayBufferEntry`, `ReplayBufferOptions`, `ReplayBufferStats`, `ReplayBufferMiddleware`
- `replayBuffer(options?): ReplayBufferMiddleware`

### Backwards compatibility

Additive — no breaking changes.

## [1.74.0] — 2026-08-07

### Added

- **4 new CLI commands for chain observability** — bundled into the existing `saptarishi-llm` binary + a new `cds-llm` alias so consumers who prefer the shorter name get it.

  ```bash
  cds-llm chain-visualize chain.json     # ASCII box-drawing diagram
  cds-llm chain-diff a.json b.json       # diff two snapshots (CI drift check)
  cds-llm chain-validate chain.json      # check for ordering warnings/errors
  cds-llm preflight config.json          # env / models / chain / budget checks
  ```

- **`chain-visualize`** — Unicode box-drawing diagram of the middleware chain with per-step config summary. Reads a `config://chain` snapshot from a file (or stdin). Perfect for pitch decks + debugging.

  ```
  ┌──────────────────────────────────────────────────┐
  │            OUTER (request enters here)           │
  └──────────────────────────────────────────────────┘
    │                                                │
    ▼
  ┌──────────────────────────────────────────────────┐
  │ [ 0] deadline          timeoutMs=30000           │
  └──────────────────────────────────────────────────┘
    │                                                │
    ▼
  ┌──────────────────────────────────────────────────┐
  │ [ 1] bulkhead          maxConcurrent=10 …        │
  └──────────────────────────────────────────────────┘
    ...
  ```

- **`chain-diff`** — wraps 1.73 `chainDiff()`. Exit code 0 if identical, 1 on drift, 2 on file/usage error. `--json` for structured output, `--no-colors` to strip ANSI. Auto-detects TTY for color output.

- **`chain-validate`** — wraps 1.48 `validateMiddlewareOrder()`. Exit 0 clean, 1 on error findings. `--strict` treats warnings as errors too. Human output groups findings by severity with `✗ / ⚠ / ℹ` markers and per-finding `fixit:` hints.

- **`preflight`** — wraps 1.66 `preflight()`. Reads a config JSON with `requiredEnv / budgetLimits / models / chain`. Exit 0 on pass, 1 on error. Human output shows each check with `✓ / ⚠ / ✗` markers + duration.

- **`cds-llm` binary alias** — the same CLI is now installed under BOTH `saptarishi-llm` and `cds-llm` names. `cds-llm` is easier to type + matches the plugin's SAP CAP flavor.

- **CI workflow example:**
  ```bash
  # 1. Snapshot current chain into a baseline (do once, check into git)
  curl http://.../mcp/... > chain-baseline.json

  # 2. On every deploy, fetch the live chain and diff
  curl http://.../mcp/... > /tmp/chain-live.json
  cds-llm chain-diff chain-baseline.json /tmp/chain-live.json --no-colors \
    || { echo "chain drifted — review required"; exit 1; }
  ```

### Backwards compatibility

Additive — no breaking changes. Existing `saptarishi-llm` commands unchanged. New binary alias `cds-llm` points to the same script.

## [1.73.0] — 2026-08-07

### Added

- **`chainDiff(a, b)` — chain snapshot diff tool.** Compare two middleware chain snapshots (the `config://chain` payloads from 1.48 `validateMiddlewareOrder` / `buildChainSnapshot`) and report the delta: added / removed / reordered primitives + per-primitive config field changes.

  ```js
  const { chainDiff, formatChainDiff } = require('@saptarishi/cds-plugin-llm');

  const baseline = JSON.parse(fs.readFileSync('chain-baseline.json'));
  const live     = await mcpClient.readResource('config://chain');

  const diff = chainDiff(baseline, live);
  if (!diff.ok) {
    console.error(formatChainDiff(diff, { colors: true }));
    process.exit(1);   // CI fails if chain drifted
  }
  ```

- **Structured result** — `{ ok, added, removed, reordered, configChanged, unchanged, summary }`. Every drift lands in exactly one bucket:
  - `added` — new primitive not in baseline
  - `removed` — baseline primitive missing from live
  - `reordered` — same primitive, different position
  - `configChanged` — same primitive, config fields differ (recursively)
  - `unchanged` — same primitive, same position, same config

- **Config drift detection.** Field-by-field comparison of the `config` object on each snapshot entry. Handles scalar changes (`10 → 20`), added fields (`undefined → value`), removed fields (`value → undefined`), and nested object / array changes (via `JSON.stringify` structural comparison).

- **`formatChainDiff(diff, { colors? })`** — human-readable multi-line output with `+/-/~` markers. Optional ANSI colors for terminals (green `+`, red `-`, yellow `~`).

  ```
  + traceCorrelation  (position 2, added)
  - oldMw  (was at position 5)
  ~ bulkhead  reordered: 3 → 4
  ~ costBudget  config changed:
      maxConcurrent: 10 → 20
      queueTimeoutMs: 5000 → 10000

  summary: +1 added, -1 removed, ~1 reordered, ~1 config, =6 unchanged
  ```

- **Long-value truncation** — config values over 60 chars are truncated in the formatter output with `...` to keep the terminal diff scannable.

- **CI use case:** commit a baseline snapshot with your app; on each deployment, fetch the live `config://chain` from the MCP server and run `chainDiff(baseline, live)` — fail the pipeline if `!diff.ok`. Catches accidental middleware ordering changes, config tuning drift, or unauthorized primitive additions before they land in prod.

- **Pre-deploy diff** — teams tuning resilience config across environments can diff `dev.json` vs `prod.json` before rolling out changes.

### Type definitions

- `ChainSnapshot`, `ChainDiffResult`, `ChainDiffConfigChange`
- `chainDiff(a, b): ChainDiffResult` — pure function, no side effects
- `formatChainDiff(diff, options?): string`

### Backwards compatibility

Additive — no breaking changes.

## [1.72.0] — 2026-08-07

### Added

- **Streaming middleware compatibility — fixed a long-standing gap.** Middleware that used `try / finally` to release resources (bulkhead slot, breaker state) fired as soon as `next()` returned the iterable — NOT when the stream actually ended. This release ships a completion tracker that lets middleware defer `finally` logic to the moment the stream is fully consumed.

- **`wrapStreamCompletion(iter)`** — wraps any async iterable in an envelope that fires `onComplete(info)` callbacks when the stream ends (success or error). Auto-applied by `LLMService.stream()` so middleware authors just need to check `hasStreamCompletion(result)` and hook in.

  ```js
  const { hasStreamCompletion } = require('@saptarishi/cds-plugin-llm');

  const mw = async (ctx, next) => {
    acquireResource();
    const result = await next();
    if (hasStreamCompletion(result)) {
      result.onComplete((info) => {
        // Fires when stream fully consumed (success or error)
        releaseResource(info.ok, info.durationMs);
      });
      return result;
    }
    releaseResource(true);   // chat/embed path
    return result;
  };
  ```

- **Completion info** carries `{ ok, error, chunkCount, durationMs, doneChunk }` — the actual final `done` chunk (with real usage + model) so consumers get authoritative summary data. `durationMs` is wall-clock from wrapping until stream end.

- **3 shipped middleware updated** to defer completion for streams:
  - **`bulkhead`** — slot now released when the stream ends, not when the iterable is created. Fixes the case where fast-returning streams under-counted concurrency. A second call is now correctly rejected while an earlier stream is still consuming.
  - **`circuitBreaker`** — success / failure recorded when the stream ends. Stream errors that fail mid-flow now count against the threshold; N stream errors in a row correctly open the circuit.
  - **`jsonLog`** — log line emitted ONCE at stream completion, with `durationMs` reflecting real stream duration + `tokensIn/tokensOut/model` from the final `done` chunk. Adds `chunkCount` field. Error logs fire on stream failure with the captured error.

- **Idempotent wrapping** — `wrapStreamCompletion(wrapStreamCompletion(x)) === x` (same reference). Safe to double-wrap; middleware and `LLMService.stream()` can both apply without conflict.

- **Multiple subscribers supported** — multiple middleware can call `onComplete()` on the same envelope; all fire in registration order. Subscriber exceptions are swallowed so a broken subscriber can't affect the stream or other subscribers.

- **Late subscribers** — `onComplete()` called AFTER the stream has already completed fires synchronously with the captured info. Prevents lost events in complex composition scenarios.

### Type definitions

- `StreamCompletionInfo` — `{ ok, error, chunkCount, durationMs, doneChunk }`
- `StreamCompletionEnvelope<T>` — `AsyncIterable<T>` extended with `onComplete()` + `completedInfo` + `isCompleted`
- `wrapStreamCompletion<T>(iter)`, `hasStreamCompletion(x)` — top-level exports

### Backwards compatibility

Additive on the runtime side:
- Existing middleware that don't check `hasStreamCompletion()` continue to work exactly as before (fire `finally` on iterable creation).
- Stream consumers see identical chunks — the wrapper just passes them through.
- `LLMService.stream()` still yields `text_delta` + `done` chunks in the same shape.
- The three updated middleware are DRAMATICALLY more useful on streams; consumers running them against streams before this release should see zero regressions on chat/embed and correct behavior on stream.

## [1.71.0] — 2026-08-07

### Added

- **`tenantIsolate({ tenantOf?, factory, ... })` — multi-tenant isolation wrapper.** Hands out per-tenant instances of the middleware(s) returned by `factory(tenantId)`. Each tenant gets its OWN bulkhead / breaker / tuner state so one noisy tenant can't fill another tenant's queue or trip another tenant's circuit.

  ```js
  const { tenantIsolate, bulkhead, circuitBreaker } = require('@saptarishi/cds-plugin-llm');

  const iso = tenantIsolate({
    tenantOf: (ctx) => ctx.raw?.tenant ?? cds.context?.tenant ?? 'default',
    factory:  (tenantId) => {
      // Called ONCE the first time this tenant hits us.
      // Return a middleware fn OR array (composed in Koa style).
      return [
        circuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
        bulkhead({ maxConcurrent: 5, maxQueued: 20, queueTimeoutMs: 5_000 }),
      ];
    },
    onTenantCreate: (id) => cds.log('tenant-iso').info(`spun up chain for '${id}'`),
  });
  llm.use(iso);
  ```

- **Big SAP CAP pitch story:** *"a noisy tenant can't affect another tenant's provider quota, circuit state, or observed latency."* Complements the existing per-provider bucketing (bulkhead / breaker / bucket by `ctx.service.name`) with per-tenant bucketing (bucket by `tenantOf(ctx)`).

- **Default `tenantOf`** reads `ctx.raw.tenant` → `cds.context.tenant` → `'default'` — zero-config for SAP CAP apps.

- **Lazy instantiation.** `factory(tenantId)` is called ONCE per new tenant; subsequent calls reuse the same middleware instances. Predictable memory: N tenants × M middleware instances.

- **Koa-style composition.** If `factory` returns an array, the wrapper composes them left-to-right (outer→inner) around `next()`. Same semantics as `llm.use()` for the top-level chain.

- **Robust tenant-ID handling.** Numeric / non-string tenant IDs get stringified for consistent Map keys. `null` / `undefined` / throw → falls back to `'default'`.

- **Introspection:**
  - `iso.tenants()` → all seen tenant IDs
  - `iso.chainFor(tenantId)` → the tenant's middleware array (reach into per-primitive stats)
  - `iso.statsFor(tenantId)` → per-tenant request count
  - `iso.stats` → `{ requests, tenantsSeen }` aggregate
  - `iso.reset(tenantId?)` → clear one tenant or all
  - `iso.asMcpResource()` → `config://tenant-isolate` with per-tenant breakdown

- **Callback hooks:**
  - `onTenantCreate(tenantId)` — fires once per new tenant (log/pre-populate)
  - `onRequest({ tenantId, method })` — fires per request
  - Callback exceptions are swallowed — never break the request path

### Type definitions

- `TenantIsolateOptions`, `TenantIsolateStats`, `TenantIsolateMiddleware`
- Middleware handles are typed compatible with existing bulkhead / breaker / tuner types

### Backwards compatibility

Additive — no breaking changes. `tenantIsolate` is a new top-level export. Existing per-provider bucketing on bulkhead / breaker unchanged.

## [1.70.0] — 2026-08-07

### Added

- **`resilience.presets` — 4 named config profiles for `resilience.bundle`.** Long-overdue companion to the 1.55 bundle. Spread-friendly: use directly or override selectively.

  ```js
  const { resilience } = require('@saptarishi/cds-plugin-llm');

  // Use a preset directly:
  const stack = resilience.bundle(resilience.presets.balanced);

  // Or override selectively:
  const stack = resilience.bundle({
    ...resilience.presets.aggressive,
    budgetLimits: { total: 100 },      // presets don't include budget
    breakerThreshold: 5,                // override just this one field
  });
  ```

- **4 preset profiles shipped:**

  | Preset | Deadline (chat) | Retry attempts | Breaker threshold | Bulkhead max | Use case |
  |---|---|---|---|---|---|
  | **aggressive** | 15s | 2 | 3 | 5 | Latency-sensitive; fail fast, tight bounds |
  | **balanced** | 30s | 3 | 5 | 10 | Production defaults (matches bare `bundle()` output) |
  | **lenient** | 120s | 5 | 10 | 20 | Dev / testing; generous timeouts, higher retry patience |
  | **burst** | 60s | 3 | 10 | 50 | Bulk pipelines; high concurrency, forgiving of transient spikes |

- **AIMD design across presets** — `aggressive` shrinks faster (lower thresholds), `lenient` grows slower (higher thresholds). Every preset validates cleanly through 1.48 `validateMiddlewareOrder` — no non-info warnings.

- **`perMethodDeadline` per preset** — chat / embed / stream / batch each get profile-appropriate timeouts. e.g. `aggressive` caps embed at 3s (fast operations shouldn't hang); `burst` caps batch at 10 minutes (long bulk pipelines).

- **`budgetLimits` deliberately excluded** from all presets — it's a deployment-specific concern (per-tenant / per-window limits) and must be provided explicitly. Callers just spread it in:

  ```js
  resilience.bundle({ ...resilience.presets.balanced, budgetLimits: { total: 500 } });
  ```

- **`Object.freeze`d** so accidental mutation throws in strict mode. `perMethodDeadline` sub-object is intentionally shallow-frozen so callers can spread it into their own configs.

### Type definitions

- `ResilienceBundlePreset` — the shape of a preset object (all required fields)
- `resilience.presets` — typed as `{ readonly aggressive: Readonly<ResilienceBundlePreset>; ... }`

### Backwards compatibility

Additive — no breaking changes. `resilience.presets` is a new export under the existing `resilience` namespace.

## [1.69.0] — 2026-08-07

### Added

- **`testing.recording` + `testing.replay`** — record real LLM API responses to a JSON fixture file, then replay them in tests. Natural follow-up to 1.68 `fakeLLM` for cases where scripting responses by hand is tedious (multimodal outputs, long structured JSON, streamed replies).

  ```js
  const { testing } = require('@saptarishi/cds-plugin-llm');

  // 1. During test authoring — record real calls to a JSON file:
  const rec = testing.recording({ store: 'test/fixtures/llm.json' });
  llm.use(rec);
  await llm.chat({ ... });   // hits real provider, records to fixture

  // 2. In CI / normal test runs — replay from fixtures, no network:
  const rep = testing.replay({ store: 'test/fixtures/llm.json' });
  llm.use(rep);
  await llm.chat({ ... });   // returns the recorded response
  ```

- **Store abstraction.** Pass a **file path** (JSON file on disk — auto-loaded on first use, auto-saved on each write) OR a **custom store** `{ get(hash), set(hash, entry), all() }` for in-memory / Redis / etc.

- **Hash strategy.** Default hashes over `{ method, model, messages, input, system, maxTokens, temperature, format, tools }` — the fields that determine a call's semantics. Irrelevant fields (correlationId, tenant, etc.) don't affect the hash. Override with `hashOn: (req, method) => 'custom-key'` for tighter or looser matching.

- **`replay` strict mode (default true)** throws `MissingFixtureError` on cache miss so tests fail loudly when a request has drifted from what was recorded. Set `strict: false` to fall through to the real provider on miss (useful for incremental fixture building — record new + replay existing in the same pass).

- **`MissingFixtureError`** extends `LLMError` with code `MISSING_FIXTURE` (added to `errorRegistry`), so consumers can use the 1.57 taxonomy + 1.58 error handler + 1.65 CAP bridge for consistent error surfacing. `httpStatus: 500` — a test-config issue would be a server error if it leaked to prod.

- **`skipMethods`** on both — e.g. `skipMethods: ['stream']` if streaming responses are hard to serialize as fixtures. Skipped methods fall through to the real provider (recording) or next middleware (replay).

- **Non-throwing write** — if the store's `set()` throws (disk full, permission denied), `recording` records the error as a `skip` and passes the response through unchanged. Never breaks the request path.

- **Introspection** — `mw.stats` (`{ requests, recorded, skipped }` for recording; `{ requests, hits, misses, fallthroughs, skipped }` for replay) + `mw.store` for direct fixture access.

- **Fixture file format** — a JSON object with `{ schema: 'cds-plugin-llm-testing/v1', entries: { [hash]: { request, response, recordedAt, method } } }`. Safe to check into git; each entry is deterministic + auditable.

- **`fileStore(path)`** exported so consumers can build their own record/replay tools on top of the same file abstraction.

- **New error code in taxonomy.** `MISSING_FIXTURE` added to `errorRegistry` (primitive: `testing.replay`, retriable: false, httpStatus: 500, severity: error). `LLMErrorCode` union extended.

### Type definitions

- `FixtureEntry`, `FixtureStore` — fixture format + store interface
- `RecordingOptions`, `RecordingStats`, `RecordingMiddleware`
- `ReplayOptions`, `ReplayStats`, `ReplayMiddleware`
- `testing.recording(options)`, `testing.replay(options)`, `testing.fileStore(path)`, `testing.defaultHash(req, method)`, `testing.MissingFixtureError`
- `LLMErrorCode` extended with `'MISSING_FIXTURE'`

### Backwards compatibility

Additive — no breaking changes. `testing.recording` and `testing.replay` are new exports under the existing `testing` namespace from 1.68.

## [1.68.0] — 2026-08-07

### Added

- **`testing.fakeLLM({ scripts, ... })` — LLMService-compatible fake for unit tests.** Returns scripted responses instead of hitting a real provider. Big dev-ex improvement for consumers writing unit tests against the plugin — no network dependency, no flaky provider timeouts, no API keys needed.

  ```js
  const { testing } = require('@saptarishi/cds-plugin-llm');

  const fake = testing.fakeLLM({
    scripts: [
      { when: { method: 'chat', matches: /purchase order/i },
        respond: { text: 'PO summary', usage: { input_tokens: 10, output_tokens: 20 } } },
      { when: { method: 'embed' },
        respond: { embeddings: [[0.1, 0.2, 0.3]], usage: { input_tokens: 5 } } },
      // Predicate matcher — full req + method access
      { when: (req, method) => method === 'chat' && req.messages.length > 3,
        respond: (req) => ({ text: `long conv: ${req.messages.length} msgs` }) },
    ],
    defaultResponse: { text: 'fallback', usage: { input_tokens: 1, output_tokens: 1 } },
    delayMs:         10,     // simulated latency
    failRate:        0.0,     // 0..1 random failure rate for testing retry paths
    failWith:        () => Object.assign(new Error('sim 429'), { status: 429 }),
  });

  const res = await fake.chat({ messages: [{ role: 'user', content: 'summarize this purchase order' }] });
  // res.text === 'PO summary'
  ```

- **Full LLMService API surface:** `chat(req)`, `embed(req)`, `stream(req)`. `stream()` yields a single `text_delta` chunk followed by a `done` chunk — same shape as real providers.

- **Middleware compatibility.** `fake.use(mw)` works — the middleware chain runs BEFORE the scripted "provider" returns, so tests can exercise the FULL middleware stack (breaker + retry + cache + guardrails + costGuard + etc.) around a scripted response. Enables reliable, network-free tests of the entire resilience quartet.

- **Three matcher styles for `when`:**
  - Object shape: `{ method: 'chat', model: 'gpt-4o', matches: /regex/ }` — all fields optional, all must match
  - Predicate fn: `(req, method) => boolean` — full req + method access
  - `matches` regex is tested against user-visible text (chat: all user messages concatenated; embed: input string/array)

- **Two response styles for `respond`:**
  - Fixed object: `{ text: 'reply', usage: { ... } }`
  - Fn: `(req, method) => response` — dynamic responses based on the request

- **Call history capture** — every call recorded as `{ method, request, response, error?, timestamp, durationMs }`. `fake.calls` full history; `fake.callsMatching(pred)` filtered; `fake.lastCall()` most recent; `fake.reset()` clears.

- **Failure injection** — `failRate: 0.5` randomly fails 50% of calls with the configured error. Perfect for testing retry / breaker / autoRetry paths without needing a real flaky provider.

- **Runtime script mutation** — `fake.setScripts([...])` replaces; `fake.addScript({...})` appends. Between test cases without recreating the fake.

- **Strict mode** — `strict: true` throws on unmatched call + no default (catches missing scripts). Default `false` returns a stub (empty text / empty embeddings) to keep tests running when full scripting isn't required.

### Type definitions

- `testing.fakeLLM(options)` → `FakeLLM`
- `FakeLLMScript`, `FakeLLMScriptMatcher`, `FakeLLMCall`, `FakeLLMOptions`, `FakeLLM` — full LLMService-compatible interface

### Backwards compatibility

Additive — no breaking changes. `testing` is a new namespace under the plugin's default export.

## [1.67.0] — 2026-08-07

### Added

- **Prometheus emitters for 5 previously invisible primitives.** Every recent primitive from 1.59 through 1.64 now exposes counters + gauges through `promMetrics()`. Pass the new middleware handles alongside the existing ones — Grafana dashboards can now cover the full resilience + observability stack.

  ```js
  const text = await promMetrics({
    // Existing:
    cache, budget, guardrails, injectionGuard, metering, breaker, bh, deadline, costGuard, retry,
    // New in 1.67.0:
    tuner,                 // adaptiveBulkhead (1.61)
    probe,                 // providerHealthProbe (1.62)
    adaptiveMaxTokens,     // adaptiveMaxTokens (1.63)
    trace,                 // traceCorrelation (1.64)
    jsonLog,               // jsonLog (1.59) — now with per-error-code labels
  });
  ```

- **New metrics shipped:**

  | Family | Counters | Gauges |
  |---|---|---|
  | **adaptiveBulkhead** | `_ticks_total`, `_adjustments_total`, `_grows_total`, `_shrinks_total` | `_p95_ms`, `_current_max_concurrent` |
  | **providerHealthProbe** | `llm_probe_probes_total`, `_successes_total`, `_failures_total`, `_timeouts_total`, `_health_changes_total` | `llm_probe_provider_healthy{provider}` (1 healthy, 0 unhealthy, -1 never probed) |
  | **adaptiveMaxTokens** | `_requests_total`, `_skipped_total`, `_adjusted_total`, `_rejected_total`, `_unchanged_total`, `_saved_tokens_total` | — |
  | **traceCorrelation** | `llm_trace_requests_total`, `_extracted_total`, `_generated_total` | — |
  | **jsonLog** | `llm_json_log_requests_total`, `_ok_total`, `_failed_total`, `_by_error_code_total{code}` (labeled per LLMError code) | — |

- **`llm_probe_provider_healthy` gauge** is particularly useful for alerting: a per-provider indicator that flips from 1 → 0 the moment the probe first fails, without waiting for a real user request to trigger the breaker.

- **`llm_json_log_by_error_code_total{code}`** — labeled counter that surfaces the per-error-code breakdown from `jsonLog`'s stats. Alertable per code: `rate(llm_json_log_by_error_code_total{code="CIRCUIT_OPEN"}[5m])` fires when the breaker starts short-circuiting user requests.

- **`llm_adaptive_max_tokens_saved_tokens_total`** — cumulative output tokens saved by shrinking oversized requests. Multiply by output token price to estimate the money saved.

### Backwards compatibility

Additive — no breaking changes. All existing metric names + shapes unchanged; new emitters are gated on the corresponding middleware handle being passed to `promMetrics()`. Passing no new handles = old output byte-for-byte.

## [1.66.0] — 2026-08-07

### Added

- **`preflight({ ... })` — boot-time config validator.** Runs a structured set of checks at startup so pods fail-fast if config is wrong, instead of failing on the first user request. Composable — each check is a named entry in the returned report; consumers can wire the same checks into k8s liveness probes / CI smoke tests / MCP resources.

  ```js
  const { preflight } = require('@saptarishi/cds-plugin-llm');

  cds.once('served', async () => {
    await preflight({
      requiredEnv: ['GROQ_API_KEY'],
      providers: [
        { name: 'openai',    probe: async () => openaiSvc.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }) },
        { name: 'anthropic', probe: async () => anthropicSvc.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }) },
      ],
      chain:        stack.chain,                       // from 1.55 resilience.bundle
      budgetLimits: { total: 500, perTenant: { free: 10 } },
      models:       ['gpt-4o-mini', 'claude-sonnet-4-6'],
    });
    // Throws PreflightError on missing pieces (default failFast: true).
  });
  ```

- **5 check families:**
  - **`requiredEnv`** — each env var exists in `process.env` and is non-empty (error on miss)
  - **`providers`** — each `probe()` resolves within `timeoutMsPerCheck` (error on failure / timeout)
  - **`chain`** — passes `validateMiddlewareOrder` cleanly (error on ordering errors, warning on non-info findings)
  - **`budgetLimits`** — non-empty object with `total` / `perTenant` / `perModel` entries (warning if empty)
  - **`models`** — each model ID exists in the pricing table (warning on miss)

- **Structured report** returned regardless of pass/fail:

  ```json
  {
    "ok":         true,
    "timestamp":  "2026-08-07T12:34:56.789Z",
    "durationMs": 234,
    "checks": [
      { "name": "env:GROQ_API_KEY",   "status": "ok" },
      { "name": "chain:validate",     "status": "ok" },
      { "name": "provider:openai",    "status": "ok" },
      { "name": "provider:anthropic", "status": "error", "message": "timed out" }
    ],
    "counts": { "ok": 3, "warning": 0, "error": 1 },
    "errors":   [{ "name": "provider:anthropic", ... }],
    "warnings": []
  }
  ```

- **`PreflightError`** — plain Error subclass with `.report` (the full structured report) + `.code: 'PREFLIGHT_FAILED'`. Thrown when any check has `status: 'error'` and `failFast: true` (default). Set `failFast: false` to get the report without throwing.

- **Parallel probes.** All `providers[*].probe()` run in parallel (Promise.all with per-check timeout). Three providers with 100ms probes finish in ~100ms, not 300ms.

- **Per-check timeout** — each probe wrapped in `Promise.race` with `timeoutMsPerCheck` (default 10s, min 100ms). Timeout counts as error with `PROBE_TIMEOUT` hint in the message.

- **`onCheck` callback** fires per check with `{ name, status, message?, details? }` for real-time logging. Errors thrown by the callback are swallowed.

- **Non-throwing contract everywhere** — malformed provider entries, probe throws, callback throws all get captured as check entries without crashing the preflight run.

### Type definitions

- `PreflightCheckStatus`, `PreflightCheckEntry`, `PreflightReport`, `PreflightOptions`
- `preflight(options?)` returns `Promise<PreflightReport>`
- `PreflightError extends Error` with `.code: 'PREFLIGHT_FAILED'` + `.report`

### Backwards compatibility

Additive — no breaking changes. Preflight is a one-shot function; no middleware chain integration.

## [1.65.0] — 2026-08-07

### Added

- **`toCapError(err, req, options?)` — LLMError → CAP req.reject() bridge.** Converts any 1.57 `LLMError` into a CAP `req.reject(status, message, details)` call so OData action handlers surface structured errors to clients. Complements the 1.58 `llmErrorHandler` (Express-shaped, for raw routes) with a CAP-shaped alternative for inside OData handlers.

  ```js
  const { toCapError, withCapHandler } = require('@saptarishi/cds-plugin-llm');

  // Direct in a handler:
  this.on('summarizePurchaseOrder', async (req) => {
    try {
      const { text } = await llm.chat({ messages: [...] });
      return { summary: text };
    } catch (e) {
      return toCapError(e, req);
    }
  });

  // Or wrap a handler once:
  this.on('summarizePurchaseOrder', withCapHandler(async (req) => {
    const { text } = await llm.chat({ messages: [...] });
    return { summary: text };
  }));
  ```

- **Resulting OData error payload** carries the full LLMError taxonomy:

  ```json
  {
    "error": {
      "code":       "CIRCUIT_OPEN",
      "message":    "circuitBreaker: circuit is OPEN for provider='openai' — 25000ms cooldown remaining. …",
      "@Common.numericSeverity": 4,
      "primitive":  "circuitBreaker",
      "retriable":  true,
      "severity":   "error",
      "provider":   "openai",
      "cooldownRemainingMs": 25000
    }
  }
  ```

- **`withCapHandler(handler, options?)`** — wrapper decorator that catches any LLMError thrown by `handler` and converts it via `toCapError`. Non-LLMError exceptions propagate (CAP's default handler processes them). Preserves the handler's `this` binding + additional args.

- **Non-LLMError safety.** Both `toCapError` and `withCapHandler` RE-THROW non-`LLMError` exceptions — they don't silently swallow unrelated bugs. This is intentional: only known plugin errors get converted; anything else lands in CAP's default error path.

- **Fallback surfacing.** If `req.reject()` is missing (older CAP versions or edge cases), falls back to `req.error()`. If neither exists, throws an Error with `status`, `code`, and `llmError` fields so callers can still map to HTTP.

- **`mask` + `severity` options:**
  - `mask: ['cooldownRemainingMs']` strips specific fields from the details payload (e.g. hide backoff hints from external clients)
  - `severity: 2` sets `@Common.numericSeverity` to warning instead of the default 4 (fatal)

- **`Error`-shaped nested values are flattened** to `{ message, name, code }` to keep the OData payload bounded.

### Type definitions

- `ToCapErrorOptions`
- `toCapError(err, req?, options?): any`
- `withCapHandler<F>(handler, options?): F`

### Backwards compatibility

Additive — no breaking changes. Complements 1.58 `llmErrorHandler` without replacing it.

## [1.64.0] — 2026-08-07

### Added

- **`traceCorrelation` middleware — end-to-end distributed tracing.** Extracts (or generates) a correlation ID per request and stashes it on `ctx.meta.correlationId` so every downstream middleware — `jsonLog` (1.59), `usageMetering`, provider calls — surfaces the same ID. Optionally propagates into `cds.context` so CAP's own logging + persisted rows carry it too.

  ```js
  const { traceCorrelation } = require('@saptarishi/cds-plugin-llm');

  const trace = traceCorrelation({
    generator: traceCorrelation.uuidv7,   // time-ordered IDs
    onExtract: (info) => cds.log('llm:trace').debug(info),
  });
  llm.use(trace);   // OUTER of jsonLog so log lines carry the ID
  ```

- **Lookup precedence** (default `fromCtx`):
  1. `ctx.raw.correlationId` (caller-supplied)
  2. `ctx.raw.headers['x-correlation-id']`
  3. `ctx.raw.headers['x-request-id']`
  4. W3C `traceparent` trace-id (the 32-char hex ID from the middle of the header value — parsed via `parseTraceparent`)
  5. `cds.context?.id` (CAP's per-request UUID)
  6. `generator()` — fresh UUID

  Custom `fromCtx` overrides the default lookup entirely.

- **`uuidv7()` — time-ordered UUID generator.** RFC-9562 v7 layout (48-bit ms timestamp + 4-bit version + 74 bits random). K-sortable — better index locality in a log store than v4. Default generator remains `crypto.randomUUID` (v4) for zero-dep compatibility; opt in to v7 with `generator: traceCorrelation.uuidv7`.

- **`parseTraceparent(headerValue)`** — helper to extract the trace-id from a W3C traceparent header string. Returns null on malformed input. Exported for consumers who want to compose their own `fromCtx`.

- **CDS context propagation** — `injectIntoCdsContext: true` (default) writes the ID to `cds.context[metaField]` if the context exists and doesn't already carry that field. Never overwrites; safe with CAP's own request-scoped context.

- **Non-throwing contract.** If `fromCtx` throws, the middleware falls back to `generator()` — never breaks the request path. `onExtract` callback errors are swallowed. Missing `cds.context` (e.g. running in a bare Node script) skips propagation silently.

- **Introspection:**
  - `mw.stats` → `{ requests, extracted, generated }` — split showing how often IDs came from upstream vs. had to be generated fresh (useful to detect misconfigured upstream tracing).
  - `mw.reset()` — clears counters
  - `mw.asMcpResource()` → `config://trace-correlation`

- **Placement guidance.** Compose OUTER of `jsonLog` (1.59) so the log line carries the correct ID, and OUTER of `usageMetering` (1.21) so LlmSpend rows are tagged with it. Recommended chain:
  ```
  deadline → traceCorrelation → jsonLog → guardrails → costGuard → ... → provider
  ```

### Type definitions

- `TraceCorrelationOptions`, `TraceCorrelationStats`, `TraceCorrelationMiddleware`
- `uuidv7()`, `parseTraceparent(headerValue)` — top-level exports
- Helper functions also available as `traceCorrelation.uuidv7` / `traceCorrelation.parseTraceparent` / `traceCorrelation.defaultFromCtx`

### Backwards compatibility

Additive — no breaking changes.

## [1.63.0] — 2026-08-07

### Added

- **`adaptiveMaxTokens` — cost-aware token budgeting middleware.** Runs BEFORE the provider call and mutates `ctx.request.maxTokens` so estimated cost fits under the caller's remaining budget × safetyFactor. Prevents the "one giant call ate my whole daily budget" failure mode.

  ```js
  const shrinker = adaptiveMaxTokens({
    budget:       budgetMw,          // required — the 1.29 costBudget middleware
    scope:        'perTenant',        // 'total' | 'perTenant' | 'perModel'
    safetyFactor: 0.5,                 // use ≤ 50% of remaining $ per call
    minTokens:    50,                  // never shrink below
    tenantOf:     (ctx) => ctx.raw?.tenant ?? 'default',
    onAdjust:     (info) => cds.log('llm:adaptive-tokens').info(info),
  });
  llm.use(shrinker);
  ```

  Example flow:
  - Caller asks for `maxTokens: 8000`
  - Remaining budget: `$0.10`; safetyFactor `0.5` → safe budget `$0.05`
  - Model gpt-4o at $20/M output → safe output tokens `≈ 2500`
  - Middleware shrinks `req.maxTokens` from `8000` to `2500` before provider sees it
  - `ctx.meta.adaptiveMaxTokens` records `{ requested, adjusted, remainingUsd, safeUsd, model }` for downstream logging (jsonLog picks it up automatically)

- **Completes the cost story.** The plugin now has four layered cost primitives:
  - `costBudget` (1.29) — hard per-tenant / per-window accumulator ceiling
  - `costGuard` (1.56) — per-call ceiling (independent of budget window)
  - `estimateCost` (1.54) — pre-flight quote (no round-trip)
  - `adaptiveMaxTokens` (1.63) — auto-shrink maxTokens to fit remaining budget

- **`AdaptiveMaxTokensBlockedError`** — thrown when the safe budget cannot fit even `minTokens` of output. Inherits from `LLMError` with code `BUDGET_TOO_TIGHT`, HTTP status 402, non-retriable (budget won't refund until window resets).

- **Smart skip semantics** — the middleware bows out cleanly and passes through when:
  - Method is not in `applyTo` (default `['chat', 'stream']` — embed skipped)
  - No `model` in request
  - Model has no pricing entry (unknown / free / embed-only)
  - No budget limit configured for the target scope/key (unlimited → nothing to enforce)

- **Reads from every scope**. `scope: 'total'` uses the global limit; `'perTenant'` uses `tenantOf(ctx)` to look up; `'perModel'` uses `modelOf(ctx)`. Same shape as `costBudget` so pairs cleanly.

- **`ctx.meta.adaptiveMaxTokens` stashed for downstream.** Every adjustment writes `{ requested, adjusted, remainingUsd, safeUsd, model }` to `ctx.meta` — the 1.59 `jsonLog` middleware picks it up automatically when `includeMeta: true`.

- **Introspection + control:**
  - `mw.stats` → `{ requests, skipped, adjusted, rejected, unchanged, totalSavedTokens }` — `totalSavedTokens` shows cumulative shrinkage for cost forecasting
  - `mw.reset()` — clears counters
  - `mw.asMcpResource()` → `config://adaptive-max-tokens`

- **Callbacks:**
  - `onAdjust({ requested, adjusted, remainingUsd, safeUsd, inputUsd, model, method })` — every shrink
  - `onBlock({ remainingUsd, safeUsd, inputUsd, safeOutputTokens?, minTokens, model })` — every rejection

- **New error code in taxonomy:** `BUDGET_TOO_TIGHT` added to `errorRegistry` (primitive: `adaptiveMaxTokens`, retriable: false, httpStatus: 402, severity: error). `LLMErrorCode` union extended.

### Type definitions

- `AdaptiveMaxTokensOptions`, `AdaptiveMaxTokensStats`, `AdaptiveMaxTokensMiddleware`
- `AdaptiveMaxTokensBlockedError extends LLMError`
- `LLMErrorCode` extended with `'BUDGET_TOO_TIGHT'`

### Backwards compatibility

Additive — no breaking changes.

## [1.62.0] — 2026-08-07

### Added

- **`providerHealthProbe({ providers, breaker, ... })` — proactive circuit isolation.** Periodic background pings to each provider via a user-supplied probe fn. On failure, records into the 1.49 `circuitBreaker` so the circuit opens BEFORE the first real user request fails. Complements the reactive breaker (which waits for a real user request to fail).

  ```js
  const { providerHealthProbe, circuitBreaker } = require('@saptarishi/cds-plugin-llm');

  const breaker = circuitBreaker({ threshold: 3, cooldownMs: 30_000 });

  const health = providerHealthProbe({
    providers: [
      { name: 'openai',    probe: async () => openaiSvc.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }) },
      { name: 'anthropic', probe: async () => anthropicSvc.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }) },
    ],
    intervalMs: 60_000,
    timeoutMs:  10_000,
    breaker,
    onHealthChange: (info) => cds.log('llm:health-probe').warn(info),
  });

  llm.use(breaker);
  health.start();
  ```

- **Extends `circuitBreaker` with 2 new methods (1.62 requires 1.49-compatible breaker):**
  - `breaker.recordSuccess(provider)` — external success signal; resets consecutive failures. If halfOpen, closes the circuit.
  - `breaker.recordFailure(provider, err)` — external failure signal; increments consecutive failures. On threshold, opens the circuit — exactly like a real request failure would.

- **Health-change detection.** `onHealthChange({ provider, from, to, err })` fires when a provider transitions healthy ↔ unhealthy. Does NOT fire on same-state consecutive probes (no noise on healthy runs). First probe never fires the callback — that's the initial state, not a transition.

- **Timeout as failure.** Individual probes are wrapped in a `timeoutMs` race. Timeout counts as a failure (via `recordFailure`) with `err.code === 'PROBE_TIMEOUT'` and increments `stats.timeouts`.

- **Staggered probes.** When `start()` schedules the periodic intervals, probes are offset by `intervalMs / providers.length` so all providers aren't pinged in the same instant. Prevents a synchronized burst that hits every provider simultaneously.

- **`unref()`'d timers** — the periodic intervals don't hold the event loop open. Safe to leave running until process exit; graceful shutdown via `stop()`.

- **`probeNow(providerName?)`** — fire all probes immediately, or a single provider by name. Useful for tests + on-demand refresh after a deployment.

- **Per-provider `state()`** — `{ healthy: boolean | null, lastProbeAt, lastError }`. `healthy: null` means never probed.

- **`asMcpResource()` → `config://provider-health`** exposing per-provider snapshot for MCP subscribers.

- **Callback error handling.** `onHealthChange` / `onProbe` exceptions are swallowed — never affect probe scheduling or breaker feedback.

### Type definitions

- `HealthProbeEntry`, `HealthProbeState`, `ProviderHealthProbeOptions`, `ProviderHealthProbeStats`, `ProviderHealthProbeHandle`
- `CircuitBreakerMiddleware` extended with `recordSuccess(provider?)` and `recordFailure(provider?, err?)`

### Backwards compatibility

Fully additive:
- `providerHealthProbe` is a new top-level export
- Breaker's new `recordSuccess / recordFailure` methods don't change any existing behavior; the internal state transitions use the same logic (refactored to shared helpers).

## [1.61.0] — 2026-08-07

### Added

- **`adaptiveBulkhead({ bulkhead, p95TargetMs, ... })` — auto-tuning wrapper for the 1.51 bulkhead.** Observes each call's latency; on periodic tick, computes p95 over the sample window. If p95 > target → shrink `maxConcurrent` (backpressure); if p95 < target → grow (headroom). Classic AIMD (additive-increase, multiplicative-decrease) applied to concurrency.

  ```js
  const { bulkhead, adaptiveBulkhead } = require('@saptarishi/cds-plugin-llm');

  const bh = bulkhead({ maxConcurrent: 10, maxQueued: 50, queueTimeoutMs: 5_000 });
  const tuner = adaptiveBulkhead({
    bulkhead:      bh,
    p95TargetMs:   2000,
    minConcurrent: 2,
    maxConcurrent: 50,
    adjustEveryMs: 10_000,
    stepUp:        1,      // grow slowly (probe for headroom)
    stepDown:      2,      // shrink aggressively (backpressure fast)
    sampleWindow:  100,
    onAdjust: (info) => cds.log('llm:tuner').info(info),
  });

  llm.use(bh);
  tuner.start();           // begin ticking; setInterval is unref'd
  ```

- **Extends the 1.51 bulkhead with 3 new methods:**
  - `bh.setMaxConcurrent(n)` — runtime concurrency adjustment. In-flight calls above the new limit are NOT interrupted; they finish naturally. Increasing the limit immediately drains waiters.
  - `bh.getMaxConcurrent()` — current effective concurrency.
  - `bh.subscribe(fn)` — register a per-call observer that receives `{ provider, durationMs, ok, method }` after each completion. Returns an unsubscribe function.

- **AIMD philosophy:** `stepUp` defaults to 1, `stepDown` to 2. Grow one slot at a time — probe carefully for headroom. Shrink two slots at a time — react quickly when latency spikes. Tune stepDown higher for more aggressive backpressure.

- **Rolling p95** over the last N samples (default 100). Cheap allocation-free circular buffer. Samples INCLUDE queue wait time — the tuner optimizes for user-observed latency, not just provider RTT.

- **`filterProvider`** predicate — instantiate multiple tuners each pointed at the same bulkhead but tuning off a different provider's samples, or drop specific providers entirely.

- **`tickNow()`** — fire the tick logic immediately. Useful for tests + on-demand adjustment (e.g. after a deployment where you want to re-evaluate ASAP).

- **Lifecycle:**
  - `start()` — idempotent; subscribes to bulkhead observations + starts `setInterval`. The interval is `unref()`'d so it doesn't hold the event loop open.
  - `stop()` — clears the interval + unsubscribes. Future calls after stop won't collect samples.
  - `asMcpResource()` → `config://adaptive-bulkhead` with tuner state + current concurrency.

- **Stats surface:** `{ ticks, adjustments, grows, shrinks, lastP95Ms, lastAction, lastMaxConcurrent }`. `lastAction` is one of `'grow' | 'shrink' | 'noop' | 'noop-no-samples' | 'none'` — feed into your alerting for surprising behavior.

### Type definitions

- `BulkheadObservation` — the shape passed to `bh.subscribe()`
- `BulkheadMiddleware` extended with `setMaxConcurrent / getMaxConcurrent / subscribe`
- `AdaptiveBulkheadOptions`, `AdaptiveBulkheadStats`, `AdaptiveBulkheadHandle`
- `adaptiveBulkhead(options)`

### Backwards compatibility

Fully additive on the bulkhead side — every existing consumer continues to work; `setMaxConcurrent / getMaxConcurrent / subscribe` are new methods, and `bh.stats` / `bh.state()` / `bh.reset()` / `bh.asMcpResource()` are unchanged. `adaptiveBulkhead` is a new top-level export.

## [1.60.0] — 2026-08-07

### Added

- **`autoRetry(fn, options)` — retriable-aware wrapper.** Wraps any async function in a retry loop that respects the 1.57 `LLMError.retriable` field. Callers get automatic recovery from transient failures WITHOUT hand-writing per-error retry code.

  ```js
  const { autoRetry } = require('@saptarishi/cds-plugin-llm');

  const chat = autoRetry(llm.chat.bind(llm), {
    maxAttempts:  3,
    backoffMs:    500,
    jitterMs:     200,
    maxBackoffMs: 30_000,
    onRetry:  (info) => cds.log('llm:auto-retry').warn(info),
    onGiveUp: (info) => cds.log('llm:auto-retry').error(info),
  });
  const result = await chat({ messages: [...] });
  ```

- **Retriable errors retry automatically:**
  - `CircuitOpenError` → waits `err.cooldownRemainingMs` (breaker's own hint), NOT exponential backoff
  - `BulkheadFullError` → waits + retries (slot may free up)
  - `BulkheadTimeoutError` → same

- **Non-retriable errors throw immediately** — no wasted retries:
  - `DeadlineExceededError`, `CostGuardBlockedError`, `BudgetExceededError`
  - `PromptInjectionError`, `GuardrailBlockedError`
  - `RateLimitGiveUpError`, `AllProvidersFailedError`
  - Plain `Error` (no `retriable` field)

- **Smart backoff.** `CIRCUIT_OPEN` honours `err.cooldownRemainingMs` directly (why guess when the breaker already told us). Others use `backoffMs * 2^attemptIdx + random(0, jitterMs)`, capped at `maxBackoffMs`. Prevents thundering-herd + respects per-error semantics.

- **Original error preserved.** The re-thrown error is the actual last-attempt error — same class, same code, same subclass-specific fields. We attach `err.autoRetryAttempts = [{attempt, waitMs, code, error}, ...]` for inspection. No wrapping error class means callers keep their existing `instanceof BulkheadFullError` / `err.code === 'CIRCUIT_OPEN'` checks.

- **Custom `retryOn` predicate.** Override the default `err?.retriable === true` for provider-native errors (e.g. `retryOn: err => err?.httpCode === 429`) or to be MORE restrictive (retry only bulkhead-timeout, not bulkhead-full).

- **`this` + args forwarding.** `autoRetry(fn)` returns a function that forwards its `this` binding and arguments to the wrapped function — safe for method binding.

- **`defaultRetryOn` exported** for composition: `retryOn: (err) => defaultRetryOn(err) || err?.httpCode === 429`.

- **Stats surface:** `wrapped.stats` → `{ calls, retriedCalls, totalRetries, givenUp, totalWaitMs }`. `wrapped.reset()` clears counters.

- **Callback hooks:**
  - `onRetry({ ctx: { attempt, waitMs, code, error }, error })` — fires before each wait
  - `onGiveUp({ attempts, finalError })` — fires once after exhausting maxAttempts
  - Callback exceptions are swallowed — never break the request path

### Type definitions

- `AutoRetryOptions`, `AutoRetryStats`, `AutoRetryWrapped<F>`
- `autoRetry<F>(fn, options?)` returns `AutoRetryWrapped<F>` — a callable with `.stats` + `.reset()`
- `defaultRetryOn(err)`

### Backwards compatibility

Additive — no breaking changes. `autoRetry` is a wrapper over any async function; it doesn't touch the middleware chain or existing error classes.

## [1.59.0] — 2026-08-07

### Added

- **`jsonLog` — structured logging middleware.** Emits ONE canonical JSON line per LLM call — a stable schema that ops teams can index / alert on / feed straight into ELK / Datadog / CloudWatch without a per-project mapping. Composable with any logger (cds.log, pino, winston, console).

  ```js
  const { jsonLog } = require('@saptarishi/cds-plugin-llm');

  const log = jsonLog({
    logger:        cds.log('llm:call'),
    correlationId: (ctx) => ctx.raw?.correlationId ?? cds.context?.id ?? null,
  });
  llm.use(log);
  ```

  Success payload:

  ```json
  {
    "ts":            "2026-08-07T12:34:56.789Z",
    "method":        "chat",
    "ok":            true,
    "durationMs":    1234,
    "tenant":        "acme",
    "provider":      "llm",
    "model":         "gpt-4o-mini",
    "tokensIn":      42,
    "tokensOut":     87,
    "cost":          0.001234,
    "cachedHit":     false,
    "correlationId": "req-abc-123"
  }
  ```

  Failure payload (LLMError-aware — uses 1.57 taxonomy):

  ```json
  {
    "ts": "…", "method": "chat", "ok": false, "durationMs": 5230,
    "tenant": "acme", "provider": "llm", "model": "gpt-4o-mini",
    "correlationId": "req-xyz-456",
    "error": {
      "code":      "CIRCUIT_OPEN",
      "primitive": "circuitBreaker",
      "retriable": true,
      "severity":  "error",
      "message":   "circuitBreaker: circuit is OPEN for provider='openai' …"
    }
  }
  ```

- **Reads signals from every primitive shipped so far:**
  - `ctx.meta.costEstimate` (from 1.56 `costGuard`) → `cost` field
  - `result.usage` (every provider) → `tokensIn` / `tokensOut`
  - `result.cached` / `.cost` (from `usageMetering` / `responseCache`) → `cachedHit` / `cost`
  - `err.code` / `.primitive` / `.retriable` / `.severity` (1.57 `LLMError`) → structured `error` block

- **Privacy-first defaults.** Log line NEVER includes messages / system by default. Opt in with `includeRequestPreview: true` to include the first `previewChars` (default 200) of the last user message. Multimodal content arrays are joined text-only (images / audio / PDFs never in the log). `redactMetaFields` (default `['messages', 'system']`) strips those keys from `ctx.meta` before including.

- **Non-throwing logger contract.** If your logger explodes mid-call, the request path is unaffected — the caller sees the real result / error, not a logger crash. Same for the `correlationId` callback.

- **`logger.info()` → `logger.log()` fallback.** Works with structured loggers (pino, winston) that expose per-level methods AND with bare `{ log }` shapes (console, primitive wrappers).

- **Stats + MCP resource:**
  - `log.stats` → `{ requests, ok, failed, byErrorCode: { CIRCUIT_OPEN: 3, ... } }`
  - `log.reset()` — clears counters
  - `log.asMcpResource()` → `config://json-log`

- **Placement is flexible.** Two useful positions:
  1. OUTER (after deadline, before guardrails): full request duration including retries + queue waits, sees raw request.
  2. INNER of guardrails: logs the scrubbed content path only — useful when you want a request preview but never log PII.

### Type definitions

- `JsonLogPayload` — canonical schema for the emitted JSON
- `JsonLogOptions`, `JsonLogStats`, `JsonLogMiddleware`

### Backwards compatibility

Additive — no breaking changes.

## [1.58.0] — 2026-08-07

### Added

- **`llmErrorHandler` — HTTP error middleware for LLMError.** Express/CAP-shaped 4-arg error middleware. Catches any `LLMError` (1.57 taxonomy) from downstream, converts it to a structured JSON response with the correct HTTP status and (when applicable) a `Retry-After` header.

  ```js
  const { llmErrorHandler } = require('@saptarishi/cds-plugin-llm');

  app.use(llmErrorHandler({
    log: (err, meta) => cds.log('llm:http').warn(
      `[${meta.method} ${meta.url}] ${err.code} → HTTP ${meta.status}`,
    ),
  }));
  ```

  Response:

  ```json
  HTTP 503
  Content-Type: application/json
  Retry-After: 25

  {
    "error": {
      "code":      "CIRCUIT_OPEN",
      "primitive": "circuitBreaker",
      "retriable": true,
      "severity":  "error",
      "message":   "circuitBreaker: circuit is OPEN for provider='openai' — 25000ms cooldown remaining. …",
      "details":   { "provider": "openai", "cooldownRemainingMs": 25000 }
    }
  }
  ```

- **`Retry-After` header** set automatically when the plugin can suggest a specific wait:
  - `CircuitOpenError` → `ceil(cooldownRemainingMs / 1000)`
  - `BulkheadFullError` / `BulkheadTimeoutError` → `1` (retry immediately with backoff)
  - Other retriable errors — no header (caller decides backoff strategy)

- **Non-LLMError pass-through.** By default, non-`LLMError` exceptions are forwarded to `next(err)` so downstream / default error handlers see them unchanged. Set `passThroughNonLLMErrors: false` to catch everything as a generic `500 { code: 'INTERNAL_ERROR' }` — defense-in-depth for APIs that must never leak a stack trace or internal message.

- **`mask` + `includeStack`** — strip specific fields from the response body (e.g. `mask: ['cooldownRemainingMs']` to hide backoff hints from external clients). `includeStack: true` adds the stack trace to the response for internal debugging; `mask: ['stack']` overrides it back off.

- **`log` callback** fires with `(err, { method, url, status, code })` for each caught `LLMError`. Errors thrown by the callback are swallowed (never affect the outgoing response).

- **Handles bare `http.ServerResponse` shape** (writeHead / end) in addition to Express (status / json), so it drops into any Node HTTP server.

- **Details are subclass-specific.** Everything except the base `LLMError` fields (`code`, `primitive`, `retriable`, `httpStatus`, `severity`, `cause`, `stack`) is serialized into `details`. `Error`-shaped values get flattened to `{ message, name, code }` to keep the response bounded.

### Type definitions

- `LlmErrorHandlerOptions`, `LlmErrorResponseBody`
- `llmErrorHandler(options?)` returns Express-shaped `(err, req, res, next) => void`

### Backwards compatibility

Additive — no breaking changes.

## [1.57.0] — 2026-08-07

### Added

- **Structured error taxonomy.** New `LLMError` base class + `errorRegistry` maps every shipped error code to structured metadata: `{ primitive, retriable, httpStatus, severity }`. All 10 public error classes now inherit from `LLMError`, giving consumers one place to handle everything the plugin might throw.

  ```js
  const { LLMError, errorRegistry, isLLMError } = require('@saptarishi/cds-plugin-llm');

  try {
    await llm.chat(...);
  } catch (err) {
    if (isLLMError(err)) {
      res.status(err.httpStatus).json({
        code:       err.code,
        primitive:  err.primitive,
        retriable:  err.retriable,
        message:    err.message,
      });
      return;
    }
    throw err;   // unknown / provider-native — re-raise
  }
  ```

- **10 error classes now inherit from `LLMError`:**

  | Class | Code | Primitive | Retriable | HTTP | Severity |
  |---|---|---|---|---|---|
  | `CircuitOpenError` | `CIRCUIT_OPEN` | circuitBreaker | ✓ (after cooldown) | 503 | error |
  | `BulkheadFullError` | `BULKHEAD_FULL` | bulkhead | ✓ | 429 | warning |
  | `BulkheadTimeoutError` | `BULKHEAD_TIMEOUT` | bulkhead | ✓ | 429 | warning |
  | `DeadlineExceededError` | `DEADLINE_EXCEEDED` | deadline | ✗ | 504 | error |
  | `RateLimitGiveUpError` | `RATE_LIMIT_GIVE_UP` | retryOnRateLimit | ✗ | 429 | error |
  | `AllProvidersFailedError` | `ALL_PROVIDERS_FAILED` | chatWithFallback | ✗ | 502 | error |
  | `CostGuardBlockedError` | `COST_GUARD_BLOCKED` | costGuard | ✗ | 402 | error |
  | `BudgetExceededError` | `BUDGET_EXCEEDED` | costBudget | ✗ | 402 | error |
  | `PromptInjectionError` | `PROMPT_INJECTION` | promptInjectionGuard | ✗ | 400 | error |
  | `GuardrailBlockedError` | `GUARDRAIL_BLOCKED` | guardrails | ✗ | 400 | error |

- **HTTP status semantics** are matched to the failure mode:
  - `503 Service Unavailable` — circuit open (provider is down)
  - `504 Gateway Timeout` — deadline exceeded
  - `502 Bad Gateway` — all providers failed
  - `429 Too Many Requests` — bulkhead saturated / rate-limit gave up
  - `402 Payment Required` — cost ceiling / budget exhausted
  - `400 Bad Request` — user input triggered a security filter

- **`isLLMError(err)`** — convenience type-guard: `if (isLLMError(e)) handle(e); else throw e;`.

- **Retriability semantics** — separates "safe to retry the exact same request" (circuit-open after cooldown, bulkhead saturated) from "same request will always fail" (budget exhausted, security block, exceeded ceiling). Retry-loops upstream of the plugin can now automatically retry the right classes and give up on the rest.

- **Preserved subclass identity.** Each subclass still reports its specific `.name` (`CircuitOpenError`, `BulkheadFullError`, etc.) via `new.target.name`, so `instanceof` and `toString()` continue to work as expected.

### Type definitions

- `LLMErrorCode` — string-literal union of all 10 shipped codes
- `ErrorRegistryEntry` — `{ primitive, retriable, httpStatus, severity }`
- `errorRegistry` — `Record<LLMErrorCode | string, ErrorRegistryEntry>`
- `LLMError` — base class with typed `readonly code / primitive / retriable / httpStatus / severity`
- All 10 subclasses' TS declarations now `extends LLMError` (was `extends Error`)
- `isLLMError(err): err is LLMError`

### Backwards compatibility

Fully additive on the runtime side:
- Every error still has the same `.code` field with the same value.
- Every error still has the same subclass name (via `new.target.name`).
- Every subclass-specific field (`provider`, `attempts`, `estimatedUsd`, etc.) is preserved.
- Every error is still `instanceof Error` (`LLMError extends Error`).

New behavior:
- Every error is now also `instanceof LLMError` — this is new but can only be a strict superset of previous behavior; no existing consumer code that checked `instanceof <specific subclass>` will regress.

## [1.56.0] — 2026-08-07

### Added

- **`costGuard` middleware — pre-flight cost enforcement.** Wraps the 1.54.0 `estimateCost` helper and runs BEFORE the provider call — refuses over-budget requests with `CostGuardBlockedError` WITHOUT spending a single token. Complements the reactive `costBudget` (post-call accumulator) with a proactive per-call ceiling.

  ```js
  const { costGuard } = require('@saptarishi/cds-plugin-llm');

  const guard = costGuard({
    maxPerCallUsd: 1.00,            // hard ceiling
    warnAtUsd:     0.10,            // soft warning
    onExceeded: (info) => cds.log('llm:cost-guard').warn(info),
    onWarn:     (info) => cds.log('llm:cost-guard').info(info),
  });
  llm.use(guard);
  ```

- **Recommended ordering** (top = OUTERMOST):

  ```
  deadline → guardrails → costGuard → costBudget → circuitBreaker →
  bulkhead → retryOnRateLimit → provider
  ```

  Placement rationale:
  - **AFTER guardrails** — PII / injection scrubbing runs first, so the estimate counts the scrubbed content the provider actually sees.
  - **BEFORE costBudget** — costBudget is a per-tenant/window accumulator; costGuard is a per-call ceiling. Independent checks.

- **Opt-outs:**
  - Non-chat methods (`embed`, `batch`) skip by default. Set `applyTo: ['chat', 'stream']` (default) or add / remove.
  - Caller can bypass a single request with `req.costGuard: 'skip'` — useful for internal admin calls or one-off big-payload requests where you accept the cost.
  - Unknown models pass through (`priced: false` → `estimatedUsd: 0` → passes any positive ceiling).

- **Estimate stashed for downstream.** The full `estimateCost` result is written to `ctx.meta.costEstimate` before `next()` runs. Downstream middleware (metering, logging, custom headers) can read it for pre/post comparison.

- **Introspection + control:**
  - `guard.stats` → `{ requests, skipped, checked, warned, blocked, estimatedUsdTotal }`
  - `guard.reset()` — clears counters
  - `guard.asMcpResource()` → `config://cost-guard`

- **Prometheus:** `emitCostGuard` wired into `promMetrics` — new counters `llm_cost_guard_requests_total`, `_checked_total`, `_skipped_total`, `_warned_total`, `_blocked_total`, `_estimated_dollars_total` (cumulative $ estimate for cost planning).

- **`validateMiddlewareOrder` extensions:**
  - New rule `COST_GUARD_OUTER_OF_GUARDRAILS` (warning) — costGuard OUTER of guardrails means the estimate counts PII that will be redacted, inflating the ceiling check.
  - `costGuard` added to `KNOWN_KINDS`.

### Type definitions

- `CostGuardOptions`, `CostGuardStats`, `CostGuardMiddleware`
- `CostGuardBlockedError`
- `MiddlewareOrderingWarningCode` extended with `COST_GUARD_OUTER_OF_GUARDRAILS`

### Backwards compatibility

Additive — no breaking changes.

## [1.55.0] — 2026-08-07

### Added

- **`resilience.bundle({...})` — one-liner for the full resilience stack.** Wires `deadline → costBudget → circuitBreaker → bulkhead → retryOnRateLimit` in canonical order with sensible defaults. Completes the 1.47-1.54 arc: production-grade resilience in one line instead of five separate `llm.use()` calls with per-primitive option objects.

  ```js
  const { resilience } = require('@saptarishi/cds-plugin-llm');

  const stack = resilience.bundle({
    deadlineMs:        30_000,
    retryAttempts:     3,
    breakerThreshold:  5,
    breakerCooldownMs: 30_000,
    bulkheadMax:       10,
    bulkheadQueue:     50,
    budgetLimits:      { total: 500, perTenant: { free: 10 } },
  });

  stack.apply(llm);   // → registers all 5 middleware in canonical order
  ```

- **Named primitive access.** Each field on the returned stack is the middleware instance itself — inspect stats, force-open a circuit, snapshot a bucket, etc.

  ```js
  stack.deadline.stats;                     // { requests, expired, activeCount }
  stack.breaker.state('openai');            // { state, consecutiveFailures, cooldownRemainingMs }
  stack.bh.reset('openai');                 // drain the bulkhead
  stack.retry.stats.givenUp;                // permanent failures after retries
  stack.budget.snapshot();                  // per-tenant / per-model spend
  ```

- **One-line Prometheus + health wiring.** `prometheusBundle()` and `healthBundle()` return the exact shapes `prometheusHandler` and `healthHandler` expect. Two more one-liners:

  ```js
  const stack = resilience.bundle({ budgetLimits: { total: 500 } });
  stack.apply(llm);
  app.get('/metrics', prometheusHandler(stack.prometheusBundle()));
  app.get('/health',  healthHandler(stack.healthBundle()));
  ```

- **`stack.chain` — validateMiddlewareOrder-compatible description.** The chain array matches `[{ kind: 'deadline' }, { kind: 'costBudget' }, ...]` so consumers can pass it straight to `validateMiddlewareOrder(stack.chain)` and confirm the wiring is clean before deployment.

- **`include` / `exclude` options** for partial bundles. Test rigs can skip specific primitives; a "chat-only" service can drop `budget` if it's metered elsewhere; a "batch" service can drop `retry` if the batch API handles it natively.

- **`CANONICAL_ORDER`** constant exported (`['deadline', 'costBudget', 'circuitBreaker', 'bulkhead', 'retryOnRateLimit']`) for consumers who want to build their own ordering-aware tools on top of the bundle.

- **Callback hooks forwarded per-primitive:** `onDeadlineExpired`, `onRetry`, `onRetryGiveUp`, `onBreakerOpen`, `onBreakerClose`, `onBudgetExceeded`, `onBulkheadReject` — set them once at bundle time instead of threading them through five separate option objects.

### Type definitions

- `ResiliencePrimitiveKind` — string-literal union of the 5 canonical kinds
- `ResilienceBundleOptions`, `ResilienceBundleStack`
- `namespace resilience { function bundle(); const CANONICAL_ORDER; }`

### Backwards compatibility

Additive — no breaking changes. `resilience.bundle` is a new top-level export; consumers can continue using the individual middleware factories.

## [1.54.0] — 2026-08-07

### Added

- **`estimateCost` — pre-flight cost estimator.** Token-counts a request and applies pricing to give a max-cost estimate WITHOUT hitting the provider. Zero network round-trip. Backs a "this call will cost $0.032 before you make it" pitch UX, and composes cleanly with `costBudget` for pre-flight budget checks.

  ```js
  const { estimateCost } = require('@saptarishi/cds-plugin-llm');

  const est = estimateCost({
    model:     'gpt-4o-mini',
    messages:  [{ role: 'user', content: 'Draft a supplier onboarding email.' }],
    system:    'You are a procurement assistant.',
    maxTokens: 500,
  });
  // → {
  //     model:           'gpt-4o-mini',
  //     tokensIn:        24,
  //     estMaxTokensOut: 500,
  //     inputUsd:        0.0000036,
  //     outputUsd:       0.0003,
  //     estimatedUsd:    0.000304,
  //     currency:        'USD',
  //     priced:          true,
  //     tokenizerUsed:   'tiktoken',
  //     notes:           [],
  //   }
  ```

- **`svc.estimateCost({ messages, maxTokens, ... })`** — instance method on `LLMService`. Pulls `model` default from `this.modelId`. Explicit `model` override respected.

  ```js
  const llm = await cds.connect.to('llm');
  const est = llm.estimateCost({ messages, maxTokens: 200 });
  if (est.estimatedUsd > 1.0) refuseAndSuggestSmaller();
  ```

- **Uses the same tokenizer + pricing infra as `usageMetering`:**
  - `getTokenizer(model)` — real `tiktoken` / `js-tiktoken` / `@anthropic-ai/tokenizer` when installed; heuristic fallback otherwise. Reports which tokenizer was used via `tokenizerUsed`.
  - `DEFAULT_PRICING` — same USD-per-million-tokens table. Override with `pricing: {...}` for contract discounts / region variance.
  - Same model-family assumptions as the meter → the estimate matches the actual meter to within tokenizer variance.

- **Multimodal-aware.** Content arrays are walked; `type: 'text'` blocks contribute tokens; `image` / `document` / `audio` / `tool_result` blocks are skipped with a note (`skipped N non-text content block(s)`). Callers relying on accurate vision / PDF cost estimates should refine per-provider.

- **Unknown-model handling.** Models not in the pricing table return `priced: false` and `estimatedUsd: 0`, still with a valid `tokensIn` count and a note (`model 'X' not in pricing table`). Callers can spot-check `priced === false` to catch missing pricing before shipping.

- **Configurable defaults.** All fields except `model` and `messages` have sensible defaults: `maxTokens=512`, `pricing=DEFAULT_PRICING`, `currency='USD'`.

### Type definitions

- `EstimateCostInput`, `EstimateCostResult`
- `LLMService.estimateCost(req)` — instance method with `Omit<..., 'model'> & { model?: string }` shape

### Backwards compatibility

Additive — no breaking changes. `estimateCost` is a new top-level export; `LLMService.estimateCost` is a new instance method.

## [1.53.0] — 2026-08-06

### Added

- **`healthHandler` + `healthCheck` — aggregate health check.** Extracts the `/resilience` aggregate the demo app built inline into a shipping primitive. One route wires up a k8s-compatible health endpoint that reports the state of every resilience primitive.

  ```js
  const { healthHandler } = require('@saptarishi/cds-plugin-llm');

  app.get('/health', healthHandler({
    deadline, breaker, bh, budget, retry, cache, guardrails, injectionGuard, metering,
    custom: [
      { name: 'db',     check: async () => ({ ok: await db.ping() }) },
      { name: 'kafka',  check: async () => ({ ok: await kafka.ping() }) },
    ],
  }));
  ```

  Response:

  ```json
  {
    "status": "ok" | "degraded" | "down",
    "degraded": [
      { "layer": "breaker", "reason": "providers open: openai" }
    ],
    "primitives": {
      "deadline": { "requests": 100, "expired": 0, "activeCount": 3 },
      "breaker":  { "openBuckets": [], "opens": 2, "closes": 2, "shortCircuited": 5 },
      "bulkhead": { "saturated": [], "rejected": 0, "timedOut": 0 },
      "budget":   { "spent": 12.34, "limit": 500, "overLimit": false },
      "retry":    { "requests": 100, "givenUp": 0 },
      "guardrails":     { "inputBlocks": 0, "outputBlocks": 0, "inputRedacts": 3, "outputRedacts": 1 },
      "injectionGuard": { "scanned": 42, "blocked": 0, "sanitized": 2, "warned": 0 },
      "metering":       { "totalRequests": 100, "totalCost": 12.34, "totalCachedHits": 15 },
      "cache":          { "hitRate": 0.35, "size": 128, "hits": 15, "misses": 27 }
    },
    "custom": {
      "db":    { "ok": true,  "reason": null },
      "kafka": { "ok": true,  "reason": null }
    }
  }
  ```

- **Two entry points:**
  - `healthHandler(mw, options)` — Express-shaped route factory: `(req, res) => Promise<void>`.
  - `healthCheck(mw)` — programmatic snapshot for custom routes / loggers / MCP resources.

- **Configurable HTTP status:**
  - `treatDegradedAs` defaults to **200** (app is still serving on degraded state — typical for GKE / EKS deployments where degraded ≠ unavailable).
  - `treatDownAs` defaults to **503** (a custom probe returned `ok: false` — pod should be removed from load balancer).
  - Set `treatDegradedAs: 503` for strict mode (any degradation removes the pod).

- **Custom probes.** `custom: [{ name, check: async () => ({ ok, reason }) }]` for app-specific checks (DB ping, downstream service). Probes that throw are captured as `ok: false` with the exception message. A single failing custom probe elevates the status to `down`.

- **Override degraded predicates.** `isDegraded: { breaker: (snap) => bool, ... }` for consumers who want different degradation thresholds. Example: only mark bulkhead as degraded when `rejected > 100`, not on any rejection.

- **Handles bare `http.ServerResponse` shape** (writeHead / end) in addition to Express (status / json), so it drops into any node HTTP server.

- **`DEFAULT_IS_DEGRADED`** exported for consumers who want to compose their own predicates on top of the built-ins.

### Type definitions

- `HealthStatus = 'ok' | 'degraded' | 'down'`
- `HealthSnapshot` — full response shape with typed `primitives` fields
- `HealthCheckInput` — union of all supported middleware types

### Backwards compatibility

Additive — no breaking changes. `healthHandler` is a new top-level export; all existing exports unchanged.

## [1.52.0] — 2026-08-06

### Added

- **`deadline` middleware — hard cap on total request time.** Applies to the entire request pipeline: retries, bulkhead queue waits, provider call. Uses an `AbortController`; provider implementations that respect `ctx.signal` (or forward it into `fetch`) will cancel in-flight HTTP calls when the deadline expires.

  ```js
  const { deadline } = require('@saptarishi/cds-plugin-llm');

  const dl = deadline({
    timeoutMs: 30_000,
    perMethod: { chat: 30_000, embed: 5_000, stream: 60_000 },
    onExpired: (info) => cds.log('llm:deadline').warn('expired', info),
  });
  llm.use(dl);
  ```

- **Compose as OUTERMOST middleware.** Recommended chain:

  ```
  deadline → promptInjectionGuard → guardrails → costBudget →
  circuitBreaker → bulkhead → retryOnRateLimit → provider
  ```

  Rationale: retries, queue-waits, and provider calls all share ONE deadline budget. If deadline were INNER of retry, each retry would get a fresh deadline — defeating the "total time budget" contract.

- **`AbortSignal` composition.** If the caller already passed `ctx.signal`, deadline links it: the caller's abort propagates to inner middleware AND vice-versa. Already-aborted signals propagate immediately without waiting for `next()` to run.

- **Per-method budgets.** `perMethod: { chat, embed, stream, batch }` lets you set tight timeouts for embeddings (~5s) while allowing longer chat completions (~30s) and even longer streams (~60s).

- **Introspection:**
  - `dl.stats` → `{ requests, expired, activeCount }`
  - `dl.reset()` — clears requests + expired (activeCount unchanged, reflects real in-flight state)
  - `dl.asMcpResource()` → `config://deadline`

- **Prometheus:** `emitDeadline` wired into `promMetrics` — counters `llm_deadline_requests_total`, `llm_deadline_expired_total`; gauge `llm_deadline_active_count`.

- **`validateMiddlewareOrder` extensions:**
  - New rule `DEADLINE_INNER_OF_RETRY` (warning) — deadline INNER of retry means each retry gets a fresh deadline.
  - New rule `NO_DEADLINE` (info) — no deadline means a slow provider can burn indefinite time.
  - `deadline` added to `KNOWN_KINDS`.

### Type definitions

- `DeadlineOptions`, `DeadlineStats`, `DeadlineMiddleware`
- `DeadlineExceededError`
- `MiddlewareOrderingWarningCode` extended with `DEADLINE_INNER_OF_RETRY` and `NO_DEADLINE`

### Backwards compatibility

Additive — no breaking changes. Existing chains without deadline continue to work; the validator's new `NO_DEADLINE` finding is info-severity and can be suppressed via `filterWarnings(result, ['NO_DEADLINE'])`.

## [1.51.0] — 2026-08-06

### Added

- **`bulkhead` middleware — concurrency + queue isolation.** Caps in-flight calls per bucket (default: per-provider), queues excess up to `maxQueued`, times out overflow after `queueTimeoutMs`. Prevents one runaway tenant / agent loop from starving others.

  ```js
  const { bulkhead } = require('@saptarishi/cds-plugin-llm');

  const bh = bulkhead({
    maxConcurrent:  10,
    maxQueued:      50,
    queueTimeoutMs: 5000,
    perProvider:    true,
    onQueue:   (info) => cds.log('llm:bulkhead').debug('queued',   info),
    onReject:  (info) => cds.log('llm:bulkhead').warn ('rejected', info),
    onExecute: (info) => cds.log('llm:bulkhead').trace('running',  info),
  });
  llm.use(bh);
  ```

- **Completes the resilience quartet:** `retry (transient)` → `breaker (sustained)` → `fallback (multi-provider)` → `bulkhead (isolation)`.

- **Recommended ordering:** `costBudget → circuitBreaker → bulkhead → retryOnRateLimit → provider`. Rationale:
  - Bulkhead INNER of `circuitBreaker`: open-circuit rejections don't hold a bulkhead slot (reject-fast preserved).
  - Bulkhead INNER of `costBudget`: budget check completes without waiting for a slot.
  - Bulkhead OUTER of `retryOnRateLimit`: retries hold their slot across wait+retry, preventing thundering-herd on recovery.

- **Errors:**
  - `BulkheadFullError` — queue is at `maxQueued` capacity, request rejected immediately.
  - `BulkheadTimeoutError` — request waited longer than `queueTimeoutMs`.

- **Introspection + control:**
  - `bh.state(provider?)` → `{ inFlight, queued }`
  - `bh.stats` → `{ requests, admitted, queued, rejected, timedOut }`
  - `bh.reset(provider?)` — rejects queued waiters with `BulkheadFullError`, clears bucket
  - `bh.asMcpResource()` → `config://bulkhead`

- **Prometheus:** `emitBulkhead` wired into `promMetrics` — counters `llm_bulkhead_requests_total`, `_admitted_total`, `_queued_total`, `_rejected_total`, `_timed_out_total`; per-bucket gauges `llm_bulkhead_in_flight`, `llm_bulkhead_queued`.

- **`validateMiddlewareOrder` extensions:**
  - New rule `BULKHEAD_OUTER_OF_BREAKER` (warning) — bulkhead OUTER of circuitBreaker wastes slot capacity on short-circuited requests.
  - New rule `NO_BULKHEAD` (info) — no bulkhead in chain means one runaway tenant can starve provider concurrency for everyone.
  - `bulkhead` added to `KNOWN_KINDS`.

### Type definitions

- `BulkheadOptions`, `BulkheadStats`, `BulkheadBucketState`, `BulkheadMiddleware`
- `BulkheadFullError`, `BulkheadTimeoutError`
- `MiddlewareOrderingWarningCode` extended with `BULKHEAD_OUTER_OF_BREAKER` and `NO_BULKHEAD`

### Backwards compatibility

Additive — no breaking changes. Existing chains without bulkhead continue to work; the validator's new `NO_BULKHEAD` finding is info-severity and can be suppressed via `filterWarnings(result, ['NO_BULKHEAD'])`.

## [1.50.0] — 2026-08-06

### Added

- **`chatWithFallback` — provider-chain orchestrator.** Tries providers in order; fails over to the next on retryable errors. Composes with the 1.49.0 `circuitBreaker`: an open circuit throws `CircuitOpenError`, which the fallback treats as an immediate signal to try the next provider (no wait, no retry).

  ```js
  const { chatWithFallback } = require('@saptarishi/cds-plugin-llm');

  const { result, providerUsed, modelUsed, attempts } =
    await chatWithFallback({
      providers: [
        { service: openaiSvc,    model: 'gpt-4o-mini' },
        { service: anthropicSvc, model: 'claude-3-5-sonnet-latest' },
        { service: bedrockSvc,   model: 'anthropic.claude-3-haiku-20240307-v1:0' },
      ],
      request: {
        messages: [{ role: 'user', content: 'Draft a supplier onboarding email.' }],
        maxTokens: 200,
      },
      onFailover: ({ from, to, error, skipped }) =>
        cds.log('llm:fallback').warn(`${from} → ${to} (${skipped ? 'circuit-open' : error.message})`),
    });
  ```

- **Composes with the full 1.49.0 resilience stack:**
  - Each provider's own middleware chain (`guardrails / costBudget / retryOnRateLimit / circuitBreaker / usageMetering`) still runs per-attempt.
  - `chatWithFallback` sees the OUTCOME of that chain — retries have already been exhausted by the time it sees an error, so the fallback happens at the right layer.
  - Circuit-open short-circuit skips a provider WITHOUT delay.

- **Smart default `isFallback` predicate.** Fails over on:
  - `CircuitOpenError` (breaker says "provider is down")
  - `RateLimitGiveUpError` (retry gave up after `maxAttempts`)
  - HTTP `5xx` status codes
  - Errors with no status (network / transport failure)

  Does NOT fail over on `4xx` — a bad request will fail on all providers. Same for `429` (that's retry-in-place territory, not fail-over).

- **Per-provider request overrides.** Shared `request` fields (messages, temperature, etc.) are merged with per-provider `request` overrides. Per-provider `model` fields take precedence. Lets you tune per-provider max-tokens, thinking budget, or provider-specific params.

- **Introspection:** returns full `attempts: [{ service, model, ok, skipped, error?, errorName?, status? }]` — makes it trivial to log which providers were tried, which were circuit-skipped, and which returned real errors.

- **`onFailover` callback.** Fires before each transition with `{ from, to, error, skipped, willRetry }`. Errors thrown here are swallowed (doesn't affect the outcome).

- **`AllProvidersFailedError`** — thrown when every provider fails (or a non-retryable error is hit first). Carries the full `attempts` array + `cause` so callers can surface a precise "we tried openai, anthropic, and bedrock — all three failed" error message.

### Type definitions

- `FallbackProviderEntry`, `FallbackAttempt`, `FallbackResult<T>`, `ChatWithFallbackOptions`
- `chatWithFallback<T>(options): Promise<FallbackResult<T>>`
- `AllProvidersFailedError`

### Backwards compatibility

Additive — no breaking changes. Existing single-provider calls (`svc.chat({...})`) continue to work unchanged.

## [1.49.0] — 2026-08-06

### Added

- **`circuitBreaker` middleware — sustained-outage guard.** After `threshold` consecutive failures per provider bucket, opens the circuit and short-circuits subsequent calls with `CircuitOpenError` for `cooldownMs`. A half-open probe re-tests after cooldown; success closes the circuit, failure re-opens it.

  ```js
  const { circuitBreaker } = require('@saptarishi/cds-plugin-llm');

  const breaker = circuitBreaker({
    threshold:        5,          // 5 consecutive failures → open
    cooldownMs:       30_000,     // stay open 30s before half-open probe
    halfOpenAttempts: 1,          // one probe allowed while half-open
    perProvider:      true,       // per-provider buckets (default)
    isFailure: (err) => err?.status >= 500,   // default: 5xx + network, not 4xx
    onOpen:  (info) => cds.log('llm:breaker').warn('circuit opened', info),
    onClose: (info) => cds.log('llm:breaker').info('circuit closed', info),
  });
  llm.use(breaker);
  ```

- **Composes with `retryOnRateLimit`:** place `circuitBreaker` OUTER of retry. Retries handle transient throttling (429/503); breaker handles sustained outage. If the provider is truly down, the breaker short-circuits BEFORE retries burn budget.

  ```
  promptInjectionGuard → guardrails → costBudget → circuitBreaker →
  retryOnRateLimit → usageMetering → responseCache → provider
  ```

- **Per-provider bucketing.** By default, each provider (openai, anthropic, bedrock, gemini) gets its own circuit — one bad provider can't take down calls to a different provider. `perProvider: false` uses a single global bucket.

- **Failure predicate.** Default `isFailure` counts 5xx + network errors, ignores 4xx (client bugs shouldn't open the circuit). Override with `isFailure: (err) => err?.status === 429` to (e.g.) only trip on sustained rate-limiting.

- **Introspection + control:**
  - `breaker.state(provider?)` → `{ state, consecutiveFailures, openedAt, cooldownRemainingMs }`
  - `breaker.stats` → `{ requests, shortCircuited, opens, closes, halfOpens, failures, successes }`
  - `breaker.forceOpen(provider?)` / `breaker.forceClose(provider?)` — manual control for kill-switches / recovery
  - `breaker.reset(provider?)` — clear a bucket or all state
  - `breaker.asMcpResource()` → `config://circuit-breaker` for MCP resource subscriptions

- **Prometheus:** `emitCircuitBreaker` wired into `promMetrics` — new counters `llm_breaker_requests_total`, `llm_breaker_short_circuited_total`, `llm_breaker_opens_total`, `llm_breaker_closes_total`, `llm_breaker_half_opens_total`, plus per-bucket gauges `llm_breaker_state` (0=closed, 1=halfOpen, 2=open), `llm_breaker_consecutive_failures`, `llm_breaker_cooldown_remaining_seconds`.

- **`validateMiddlewareOrder` extensions:**
  - New rule `BREAKER_INNER_OF_RETRY` (warning) — circuitBreaker INNER of retryOnRateLimit means retries fire even when the provider is objectively down.
  - New rule `NO_CIRCUIT_BREAKER` (info) — no circuitBreaker in chain means sustained outage will burn through retry + budget on every request.
  - `circuitBreaker` added to `KNOWN_KINDS`.

### Type definitions

- `CircuitState = 'closed' | 'open' | 'halfOpen'`
- `CircuitBreakerOptions`, `CircuitBreakerStats`, `CircuitBreakerBucketState`, `CircuitBreakerMiddleware`
- `MiddlewareOrderingWarningCode` extended with `BREAKER_INNER_OF_RETRY` and `NO_CIRCUIT_BREAKER`

### Backwards compatibility

Additive — no breaking changes. Existing chains without circuit breaker continue to work; the validator's new `NO_CIRCUIT_BREAKER` finding is info-severity and can be suppressed via `filterWarnings(result, ['NO_CIRCUIT_BREAKER'])`.

## [1.48.0] — 2026-08-06

### Added

- **`validateMiddlewareOrder(chain)` — static ordering validator.** Accepts a canonical chain description (matches `config://chain` MCP payload) and flags mis-orderings that break composition invariants. Returns `{ ok, warnings: [{ code, severity, message, fixit, involved }] }` with `error / warning / info` severities.

  ```js
  const { validateMiddlewareOrder } = require('@saptarishi/cds-plugin-llm');

  const result = validateMiddlewareOrder([
    { kind: 'promptInjectionGuard' },
    { kind: 'guardrails' },
    { kind: 'costBudget' },
    { kind: 'retryOnRateLimit' },
    { kind: 'usageMeteringToCap' },
    { kind: 'responseCache' },
  ]);
  // → { ok: true, warnings: [] } for the canonical demo-app pattern
  ```

- **Rules shipped:**
  - **`BUDGET_INNER_OF_RETRY`** (warning) — `costBudget` INNER of `retryOnRateLimit` means retries hit the provider without a re-check against the budget → budget-exhausted flow can burn through retries.
  - **`INJECTION_INNER_OF_GUARDRAILS`** (warning) — `promptInjectionGuard` INNER of `guardrails` means PII / NFKC normalization can erase homoglyph + zero-width signals before the injection guard sees them.
  - **`CACHE_OUTER_OF_BUDGET`** (info) — `responseCache` OUTER of `costBudget` means cache hits skip the pre-flight budget check. Often desired.
  - **`CACHE_OUTER_OF_METERING`** (info) — `responseCache` OUTER of `usageMetering` means cache hits skip the metering counter entirely. Sometimes desired (zero metering overhead on hits), sometimes not (no $0 rows in LlmSpend, no `totalCostSaved`).
  - **`NO_RETRY`** (info) — no `retryOnRateLimit` → throttled requests fail without recovery.
  - **`NO_METERING`** (info) — no `usageMetering / usageMeteringToCap` → cost accounting missing.
  - **`NO_SECURITY_LAYER`** (info) — neither `guardrails` nor `promptInjectionGuard` wired.
  - **`DUPLICATE_KIND`** (warning) — same middleware appears twice with different position indices.
  - **`UNKNOWN_KIND`** (info) — third-party middleware; validator has no ordering rules for it.

- **`filterWarnings(result, ignoredCodes)`** — convenience for suppressing specific codes in tests or intentional exceptions.

- **`KNOWN_KINDS` set exported** — covers exactly the 7 middleware kinds the plugin ships (usageMeteringToCap counted as a variant of usageMetering for ordering purposes).

- **19 new tests** (883 total): input validation, canonical chain produces zero warnings, each of the 9 rules fires correctly (positive + negative), `filterWarnings` drops requested codes, all warning objects carry the required fields.

- **TS defs:** `MiddlewareOrderingWarningCode` string-literal union, `MiddlewareOrderingWarning`, `MiddlewareOrderingResult`, `validateMiddlewareOrder`, `filterWarnings`.

### Notes

- **`ok` is `false` only for `error`-severity warnings.** None of the shipped rules are errors — they're advisory. Consumers can promote a rule to error-severity by wrapping the validator + throwing when a specific code appears in `warnings`.
- **`CACHE_OUTER_OF_METERING` is deliberately info-severity.** The reversed ordering (metering OUTER of cache — the demo-app's pattern) is the DESIRED behavior for cache-hit observability: metering sees `cached: true` on hits and records $0 rows + increments `totalCostSaved`. The rule fires the other direction as a *design-choice* nudge, not a bug alarm.
- **Rules assume the OUTER→INNER order** shipped by `config://chain` (top of array runs first on the way DOWN). If you use a different ordering convention, reverse the array before validating.
- **Roadmap:** the demo app's `config://chain` MCP resource will surface `warnings` from this validator in a follow-up release. External MCP clients will see the health of the middleware stack at a glance.

## [1.47.1] — 2026-08-06

### Added

- **Retry counters in `promMetrics` / `prometheusHandler`.** Ties `retryOnRateLimit` (1.47.0) into the Grafana + Kubernetes ServiceMonitor stack. Register the retry middleware in the bundle to emit the new series:

  ```js
  const retry = retryOnRateLimit({ maxAttempts: 3 });
  llm.use(retry);
  app.get('/metrics', prometheusHandler({ cache, budget, retry, guardrails, injectionGuard, metering }));
  ```

- **5 new metric families:**
  - `llm_retry_requests_total` — total requests observed by the middleware (each retried request counts as ONE, not N)
  - `llm_retry_retried_requests_total` — requests that hit throttling and were retried at least once
  - `llm_retry_attempts_total` — total retry attempts across all requests (a request that retried twice contributes 2)
  - `llm_retry_given_up_total` — requests that exhausted `maxAttempts` and threw `RateLimitGiveUpError`
  - `llm_retry_wait_seconds_total` — cumulative time spent waiting between retries, in seconds (`totalWaitMs / 1000` for compatibility with Prometheus rate() math)

- **3 new tests** (864 total): no retry series emitted when no retry middleware is bound; all 5 counters + wait-seconds gauge emit correctly when bound with populated stats; full-bundle HELP/TYPE parity round-trip with retry mw included.

- **TS defs:** `PrometheusMiddlewareBundle.retry?: RetryOnRateLimitMiddleware`.

### Notes

- **`llm_retry_wait_seconds_total` uses seconds (not ms)** because Prometheus's `rate()` and `increase()` idioms expect seconds. Grafana panels showing "total time spent waiting on throttling" are one `sum(rate(llm_retry_wait_seconds_total[5m]))` away.
- **Alert recipe:** `rate(llm_retry_given_up_total[10m]) > 0.01` — any give-up above 1% over 10m indicates provider quota exhaustion → page ops.
- **Backward-compatible.** Bundles without a `retry` field yield the same output as before. No new required fields.

## [1.47.0] — 2026-08-06

### Added

- **`retryOnRateLimit({ maxAttempts, fallbackWaitMs, jitterMs, retryOnStatuses, onRetry, onGiveUp })` — rate-limit-driven retry middleware.** Completes the rate-limit loop shipped over 1.38.0–1.45.0: those releases surfaced provider throttling state via `_rateLimit` on responses; this release automatically WAITS + RETRIES when a call gets throttled. Reads `err.retryAfterSec` from `RetryableError` (or matching status codes), waits that duration, retries. Complements `costBudget` (blocks BEFORE the call) with reactive recovery AFTER.

  ```js
  const retry = retryOnRateLimit({
    maxAttempts:    3,       // total attempts including the initial call
    fallbackWaitMs: 5000,    // when no retry-after hint is present
    jitterMs:       250,     // 0..250ms random jitter per wait
    onRetry:  (info) => cds.log('llm:retry').warn(`retry ${info.attempt} after ${info.waitMs}ms: ${info.error.message}`),
    onGiveUp: (info) => cds.log('llm:retry').error(`gave up after ${info.attempts.length} retries`),
  });
  llm.use(retry);
  ```

- **Recommended chain (top = outermost):** `promptInjectionGuard → guardrails → costBudget → retryOnRateLimit → usageMetering → responseCache → provider`. Placing OUTER of `usageMetering` means retries don't inflate the counter (one logical request = one metering row); INNER of `costBudget` so a budget check still trips on the second attempt.

- **`RateLimitGiveUpError`** — thrown after exhausting `maxAttempts`. Carries `.code = 'RATE_LIMIT_GIVE_UP'`, `.attempts` (array of `{attempt, waitMs, status, error}`), and `.cause` (the underlying provider error) so consumers can log the full retry timeline for post-mortems.

- **Stats surface** — `mw.stats: { requests, retriedRequests, totalRetries, givenUp, totalWaitMs }`, `mw.reset()`, and `mw.asMcpResource()` returning `config://rate-limit-retry` with the counters + configuration.

- **15 new tests** covering validation, happy path, single/multi-retry via `RetryableError`, plain-Error-with-status detection, non-retryable status pass-through, custom `retryOnStatuses`, `RateLimitGiveUpError` with attempt history, `onRetry` + `onGiveUp` observer callbacks, error-swallowing in observer callbacks, total-wait-ms aggregation, `reset()`, `asMcpResource()` payload shape.

### Changed

- **`_runMiddleware` now allows sequential re-calls to `next()`** to support retry patterns. Previously any middleware that called `next()` more than once threw `middleware called next() more than once` — that was too strict. Concurrent overlapping calls (two `next()` promises in flight from the same middleware body) still throw with a clearer `next() concurrently` message. The existing test `calling next() twice from the same middleware throws` was renamed + updated: sequential retries are now legal, but concurrent calls remain a bug. Net +1 test.

### Notes

- **Interaction with `defaultRetries` on the provider.** The base `LLMService._chatCore` also wraps the provider call in `withRetry(fn, retries)` (see `lib/util.js`). By default that's `{ max: 3, baseMs: 500 }`. If you want `retryOnRateLimit` to see every rate-limit error, disable the built-in via `chat({ ..., retries: { max: 0 } })` per request, or set `defaultRetries: { max: 0 }` at provider instantiation. Otherwise the built-in retries first (with exponential backoff), and only surfaces to the middleware after those attempts also fail.
- **Streams:** the middleware wraps the initial `next()` call which returns the async iterable. If the provider throws BEFORE the stream opens (typical rate-limit case), retry works. If the stream opens then errors mid-iteration, retry is not attempted — retrying would re-play already-yielded chunks to the caller. Consumers who need mid-stream retry should build a stream-aware layer.
- **`RetryableError.retryAfterSec = 0`** is treated as "retry now" — useful for tests that need fast retries without artificial waits. Providers that don't set the field but throw with a matching status get `fallbackWaitMs + jitter`.
- **All 4 provider families now cooperate with `retryOnRateLimit`.** `throwFromResponse` in `lib/util.js` throws `RetryableError` on 429/503 for OpenAI-compat + Anthropic; `parseGeminiRateLimit` / `parseBedrockRateLimit` populate `retryAfterSeconds` for the 4th layer of visibility.

## [1.46.0] — 2026-08-06

### Added

- **`cost-predict` CLI uses real tokenizers when available.** The char/token heuristic shipped in 1.33.0 had ±15% variance; installing `tiktoken` (or `js-tiktoken` or `@anthropic-ai/tokenizer`) drops that to <±2%. Detection is automatic and per-model — no config needed to get better numbers, just install the peer-optional package.

- **New `lib/tokenizer.js` module** — `getTokenizer(model)` returns `{ name, countTokens(text) }`, resolving in this order:
  - **OpenAI / GPT-family (gpt-*, o1-*, o3-*, o4-*)**: `tiktoken` → `js-tiktoken` → heuristic
  - **Anthropic (claude-*)**: `@anthropic-ai/tokenizer` → `tiktoken` (via `cl100k_base` fallback) → heuristic
  - **Everything else (Gemini, Llama, Bedrock non-Anthropic)**: heuristic (no widely-available real tokenizer)
  Lazy-loaded so cold-start stays fast; results memoized per (encoder, model).

- **`--tokenizer` flag on `cost-predict`** — three modes:
  - **`auto`** (default) — use real tokenizer when installed for the model family; heuristic otherwise
  - **`tiktoken`** — force real tokenizer; exit 2 with a helpful message if none is installed for the requested model
  - **`heuristic`** — force char/token factor even if a real tokenizer is available (useful for reproducible cross-machine estimates)

- **Per-row + summary tokenizer reporting** — the JSON output now includes `tokenizerMode` at the top level and `tokenizer` on each per-model row (`'heuristic'` / `'tiktoken'` / `'js-tiktoken'` / `'anthropic-tokenizer'`). The human-readable table adds a new `TOKZ` column so you can see at a glance which method costed which family.

  ```sh
  # Optional: pick the best tokenizer for your workload
  npm install --save-dev tiktoken            # or js-tiktoken for pure-JS envs
  npm install --save-dev @anthropic-ai/tokenizer  # for Claude

  saptarishi-llm cost-predict batch.jsonl --model gpt-4o
  # → per-model rows now show TOKZ=tiktoken; numbers are provider-accurate
  ```

- **16 new tests** (845 total):
  - **`getTokenizer`** (11 tests): heuristic fallback, null/empty text, per-family chars/token factors, `tiktoken` resolves for GPT + falls back to `cl100k_base` when `encoding_for_model` throws, `js-tiktoken` fallback when `tiktoken` missing, `@anthropic-ai/tokenizer` for Claude, `tiktoken` cl100k_base fallback when Anthropic tokenizer missing, Gemini goes straight to heuristic (not OpenAI-family), unspecified model defaults.
  - **`cost-predict` `--tokenizer` flag** (5 tests): defaults to `auto` (yields heuristic without tokenizers installed), `heuristic` forces heuristic even when real one would be available, `tiktoken` errors with actionable message when unavailable, invalid mode → exit 2 with usage line, TOKZ column appears in human-readable output.

### Notes

- **All three tokenizer packages are peer-OPTIONAL.** Zero install-size impact when you don't need precise counts. When you do, pick the one that matches your workload — `tiktoken` (WASM, fastest for OpenAI) or `js-tiktoken` (pure JS, works in restricted environments).
- **`@anthropic-ai/tokenizer` is officially deprecated**, but still the most accurate available for Claude. Falls back to `cl100k_base` (Anthropic's older BPE) when missing — reasonable approximation.
- **`--tokenizer heuristic` is deterministic across machines** even when different tokenizer packages are installed. Useful for reproducible CI budget-gate checks.
- **Bedrock + Gemini stay heuristic-only** — no widely-available JS tokenizer for either family. If you need precision there, call the provider's `/count_tokens` endpoint from your own code.

## [1.45.0] — 2026-08-06

### Added

- **Bedrock rate-limit plumbing.** Closes the last gap in the rate-limit family (after OpenAI-compat in 1.38.0, Anthropic in 1.40.0, Gemini in 1.44.0). All 4 major provider families now emit `_rateLimit` on chat + stream responses; `usageMetering.rateLimits('bedrock')` returns a snapshot; Prometheus emits the same `llm_rate_limit_*` gauges.

- **`parseBedrockRateLimit(sdkResponse, statusCode)`** — extracts rate-limit info from an AWS SDK v3 Bedrock response. AWS doesn't publish per-response quota-remaining headers on the direct Bedrock surface, so most successful calls yield `null`. What we CAN extract:
  - **`$metadata.retryAfterHeader`** — set by the SDK's throttling handler on 429/503 responses.
  - **Fallback: `$metadata.httpHeaders['retry-after']`** — when the SDK exposes headers via a custom httpHandler.
  - **Proxy-injected `x-amzn-ratelimit-*` headers** — when `$metadata.httpHeaders` is populated (rare on direct AWS SDK, common behind API Gateway).
  - `statusCode` param overrides `$metadata.httpStatusCode` when the caller has more accurate information.

- **Provider wiring** — Bedrock `_chat` reads `$metadata` off the ConverseCommand response; `_stream` reads it off the initial ConverseStreamCommand response before draining the stream. Both attach `_rateLimit` when non-null.

- **12 new tests** (829 total): `parseBedrockRateLimit` — 200 with no signals → null, 429/503 with `retryAfterHeader`, statusCode override, 200 ignores retryAfterHeader, proxy `x-amzn-ratelimit-*` extraction, fallback to `httpHeaders['retry-after']`, null/undefined input handling; Bedrock provider — `_chat` attaches on 429, `_chat` omits on 200-no-signals, `_stream` attaches on done chunk; end-to-end with `usageMetering.rateLimits('bedrock')`.

### Notes

- **AWS Bedrock's rate-limit visibility is deliberately sparse.** Bedrock's quota system is per-account-per-region and reads via CloudWatch metrics (`AWS/Bedrock/ModelInvocations`, `Throttles`), not response headers. This release surfaces what the SDK response object exposes — mostly `retryAfterSeconds` on throttled responses. For production quota alerts, combine `llm_rate_limit_retry_after_seconds{provider="bedrock"}` with CloudWatch metric queries.
- **Custom httpHandler consumers** get more: when a custom httpHandler surfaces `$metadata.httpHeaders`, the parser extracts `x-amzn-ratelimit-*` headers (some enterprise Bedrock deployments behind proxies do emit these).
- **All 4 major providers now emit `_rateLimit`**:
  - OpenAI-compat (all 6 subclasses) — 1.38.0
  - Anthropic — 1.40.0
  - Gemini — 1.44.0
  - Bedrock — 1.45.0
- **Ollama does not report rate limits** (self-hosted, unbounded local inference). No plans to add.

## [1.44.0] — 2026-08-06

### Added

- **Gemini rate-limit plumbing.** Third and final piece of the rate-limit family (after OpenAI-compat in 1.38.0 + Anthropic in 1.40.0). Gemini provider now attaches `_rateLimit` on chat + stream responses; `usageMetering.rateLimits('gemini')` returns a snapshot; Prometheus emits the same `llm_rate_limit_*` gauges for Gemini traffic.

- **`parseGeminiRateLimit(headers, statusCode)`** — normalized header parser handling both surface variants Google exposes:
  - **Vertex-style** (Google's canonical Vertex AI surface): `x-goog-quota-limit`, `x-goog-quota-remaining`, `x-goog-quota-refresh` (Unix epoch seconds → converted to ISO).
  - **OpenAI-style** (when API-Gateway proxies re-emit standard headers): `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` (duration or ISO).
  - **Universal** `retry-after` on 429/503.
  - Returns `null` when no signals present (direct Generative Language API often omits these).
  - Vertex takes precedence when both header families are present.

- **Provider wiring** — Gemini `_chat` reads response headers via `parseGeminiRateLimit(res.headers, res.status)` and attaches `_rateLimit` on the returned response. `_stream` captures the same headers off the initial stream-open response and attaches on the done chunk.

- **10 new tests** (817 total): `parseGeminiRateLimit` — Vertex-style headers, OpenAI-style headers, 429 retry-after, no headers → null, Vertex-wins precedence, Headers-object shape; Gemini provider — `_chat` attaches `_rateLimit` when Vertex headers present, gracefully omits when no headers, `_stream` attaches on done chunk; end-to-end with `usageMetering.rateLimits('gemini')` via a mocked fetch.

### Notes

- **Direct Generative Language API often omits rate-limit headers.** Users on `generativelanguage.googleapis.com` (the default endpoint) may see `_rateLimit: undefined` on every response — that's expected. Users on Vertex or behind an API Gateway that adds standard headers get the data.
- **Gemini's quota model doesn't split requests vs tokens** on the header side — `tokensLimit / tokensRemaining / tokensResetAt` fields are `undefined`. Consumers wanting token-level budgets can hook `usageMetering.onRecord` and compute from `usageMetadata.candidatesTokenCount` / `promptTokenCount`.
- **All 3 major providers now emit `_rateLimit`.** OpenAI-compat (all 6 subclasses) + Anthropic + Gemini. Bedrock rate-limit plumbing is the last gap; AWS reports throttling via SDK response metadata — needs a separate approach.

## [1.43.0] — 2026-08-06

### Added

- **Gemini + Bedrock stream `toolCalls` plumbing.** Closes the follow-up noted in 1.42.0 CHANGELOG. `streamTools` + `streamAgents` now work with Gemini and Bedrock providers with full text_delta + tool-call event surfacing — no fallback to atomic-text needed.

- **Gemini `_stream`**: Gemini emits complete `functionCall` parts per SSE frame (not fragmented like OpenAI-compat), so we collect them as-received and surface on the done chunk. `stopReason: 'tool_use'` set when any tool calls fired, matching Anthropic + OpenAI-compat conventions.

- **Bedrock `_stream`**: Bedrock Converse emits `contentBlockStart.start.toolUse` with `{ toolUseId, name }`, followed by a series of `contentBlockDelta.delta.toolUse.input` fragments (JSON string built up incrementally). Accumulated per `contentBlockIndex` and parsed at stream close via the same `safeParseJson` tolerance as OpenAI-compat. `stopReason: 'tool_use'` normalized when tool calls fire (Bedrock's native `messageStop.stopReason` sometimes doesn't set it).

  ```js
  // Gemini/Bedrock behave identically to OpenAI-compat + Anthropic now:
  for await (const evt of streamTools({
    llm: geminiOrBedrockService,
    system, messages, tools, maxSteps: 8,
  })) {
    // text_delta events during each turn
    // tool_call_start / tool_call_result events
    // done event with usage aggregate
  }
  ```

- **6 new tests** (807 total):
  - Gemini `_stream`: functionCall part surfaces as toolCalls with `stopReason='tool_use'` + text_delta chunks alongside
  - Gemini `_stream`: text-only response omits toolCalls field, preserves `finishReason`
  - Gemini `_stream`: multiple `functionCall` parts in one turn (each becomes a toolCall)
  - Bedrock `_stream`: toolUse start + input deltas → toolCalls on done with correct `id/name/input`, `stopReason='tool_use'`, `usage` mapped
  - Bedrock `_stream`: text-only response omits toolCalls, preserves `end_turn` stopReason
  - Bedrock `_stream`: multiple parallel tool_use blocks at different `contentBlockIndex` values

### Notes

- **All 5 provider families now support streamed `toolCalls`** on the done chunk: OpenAI-compat (Azure OpenAI + GenAI Hub + Groq + DeepSeek + Mistral + Fireworks all inherit), Anthropic, Gemini, Bedrock. Ollama does not support tool-use natively in stream mode; consumers on Ollama fall back to atomic-text through `streamTools`.
- **Bedrock `_stream` requires a real SDK response object.** The test fakes it via `svc._sdk` + `svc.client` injection; live consumers work unchanged.
- **`safeParseJson` extracted to Bedrock provider file** — matches the identically-named helper in OpenAI-compat. Both tolerate malformed JSON by returning `null`, letting the agent loop surface the raw text through the tool result.

## [1.42.0] — 2026-08-06

### Added

- **Token-level `text_delta` streaming in `streamTools()` + `streamAgents()`.** Closes the follow-up noted in 1.39.0 CHANGELOG. Chat UIs now stream assistant text word-by-word during a turn instead of waiting for atomic per-turn text. Automatic when the LLM exposes `stream()`; falls back to the existing atomic-text path when only `chat()` is available.

  ```js
  for await (const evt of streamTools({ llm, system, messages, tools })) {
    switch (evt.type) {
      case 'text_delta':          appendToChatBubble(evt.text);   break;  // NEW in 1.42.0
      case 'text':                commitBubble(evt.text);          break;  // still emitted at end-of-turn
      case 'tool_call_start':     showBadge(evt.name);             break;
      case 'tool_call_result':    hideBadge(evt.name);             break;
      case 'done':                finalize(evt);                    break;
    }
  }
  ```

- **Provider streams surface `toolCalls` on the done chunk.** `openai-compatible.js` `_stream` now accumulates `tool_calls` deltas across chunks (they arrive as fragments — `id + function.name` in the first delta, `function.arguments` string built up incrementally across subsequent deltas). `anthropic.js` `_stream` surfaces `tool_use` content blocks the same way. Both use the same `{ id, name, input }` normalized shape as `chat()` — downstream code (streamTools, streamAgents, custom consumers) can treat streamed responses identically to non-streamed ones.

- **`stream: false` opt-out** — pass at the top level to force `streamTools`/`streamAgents` onto the atomic `chat()` path for a specific run. Useful when a caller wants deterministic per-turn timing or when a middleware breaks on streamed chunks.

- **11 new tests** (801 total): `streamTools` uses `stream()` when available (event sequence `turn_start → text_delta+ → text → done`), single-turn tool call with deltas interleaved (7 events in strict order across 2 turns), `stream: false` forces `chat()` (backward-compat), fallback to `chat()` when `llm.stream` is missing, aggregate usage across streamed turns, `streamAgents` inherits streaming behavior end-to-end. Plus OpenAI-compat `_stream` accumulation (single call fragmented across deltas, multiple parallel tool_calls at different indices, text_delta chunks yielded alongside tool-call accumulation) and Anthropic `_stream` (tool_use content blocks surface as toolCalls on done, text-only response omits toolCalls).

### Notes

- **`text` events still emitted at end of turn** with the fully-accumulated turn text. Consumers using the atomic-text path don't need to change — the delta events are additive. UIs that stream deltas can ignore the final `text` event or use it as a "commit bubble" signal.
- **Backward-compat maintained.** Every scripted-LLM stub in existing test suites uses `chat()` only, so the new streaming path only kicks in when the caller's LLM exposes both `chat()` and `stream()`. All 22 existing `streamTools + streamAgents` tests still pass unchanged.
- **`text_delta` events do not have a `text` fallback field.** Consumers ignoring the delta events (i.e. old code) see the same event sequence as before: `turn_start`, `text`, `tool_call_start`, `tool_call_result`, `done`. Only NEW consumers subscribing to `text_delta` change behavior.
- **Provider support:** OpenAI-compat (all subclasses — Azure OpenAI, GenAI Hub, Groq, DeepSeek, Mistral, Fireworks) + Anthropic. Gemini + Bedrock + Ollama streams don't yet surface `toolCalls` on the done chunk; streamTools falls back to atomic text there. Follow-up work.
- **`stopReason: 'tool_use'`** is set when the model finishes with tool calls (matching the non-streaming path). Consumers can gate agent-loop continuation on this.

## [1.41.0] — 2026-08-06

### Added

- **`streamAgents()` — async-generator counterpart to `runAgents()`.** Yields the same event surface as `streamTools()` but with `invoke_<name>` tool events repackaged as agent-slug events. Chat surfaces can render per-specialist progress badges without knowing about the underlying `invoke_<name>` convention.

  ```js
  const { streamAgents } = require('@saptarishi/cds-plugin-llm');

  for await (const evt of streamAgents({ coordinator, agents, input })) {
    switch (evt.type) {
      case 'turn_start':          showBadge(`Turn ${evt.step}`);        break;
      case 'text':                writeToChat(evt.text);                 break;
      case 'agent_call_start':    showBadge(`${evt.agent}…`);           break;  // e.g. "contract-lookup…"
      case 'agent_call_result':   hideBadge(evt.agent);                  break;
      case 'done':                finalize(evt);  // trace, usage, steps
    }
  }
  ```

- **5 event types** (all include `step: 1..maxSteps`):
  - **`turn_start`** — before each coordinator turn.
  - **`text`** — coordinator prose for the turn (atomic per turn).
  - **`agent_call_start`** — right before a specialist runs; carries `{ agent, question }` (invoke_ prefix stripped).
  - **`agent_call_result`** — after specialist finishes; carries `{ agent, answer, isError }`.
  - **`done`** — extends `RunAgentsResult` with `type: 'done'` + `step`. `trace` matches `runAgents()` exactly — one entry per specialist invocation with `{ agent, question, answer, isError }`.

- **Same validation as `runAgents()`** — requires `{ coordinator, agents, input }`; each agent needs a unique `name`, `description`, and `run()` function; duplicate names rejected. `onAgentInvocation` observer callback fires per specialist call.

- **10 new tests** (790 total): validation (missing coordinator/agents/input, duplicate agent name), single agent call sequence (`invoke_` prefix stripped in start + result events), done-event trace shape matches `runAgents()` (one entry per invocation, aggregated usage across turns), `onAgentInvocation` fires per call, text-only turn (empty trace), specialist throws → `isError=true` propagates to result + trace, integration with real `Agent` class instances (duck-type equivalence).

- **TS defs:** `StreamAgentsEvent` discriminated union (`StreamAgentsTurnStartEvent | StreamAgentsTextEvent | StreamAgentsAgentCallStartEvent | StreamAgentsAgentCallResultEvent | StreamAgentsDoneEvent`); `streamAgents()` signature returns `AsyncGenerator<StreamAgentsEvent, void, void>`.

### Notes

- **Shares the specialist-conversion logic with `runAgents()`.** Any change to `invoke_<name>` tool-shape or observer semantics needs to happen in both places (or gets extracted to a shared helper).
- **Coordinator still uses `chat()` per turn** — text is atomic per turn (same trade-off as `streamTools()`; delta-level streaming is a follow-up requiring provider changes).
- **Backpressure friendly.** Same async-iterator cleanup as `streamTools()`. Client disconnect breaks the loop; no orphan chat/specialist calls fire.
- **The demo app's `/stream/analyzeScenario` endpoint** currently uses `streamTools()` with hand-rolled `invoke_<name>` tools. A follow-up demo-app release will swap in `streamAgents()` and drop ~30 lines of inline conversion.

## [1.40.1] — 2026-08-06

### Added

- **`MCPServer.registerResource` and `.registerResourceTemplate` now accept `handler` as an alias for `read`.** Closes the plugin-wide `handler` vs `read` inconsistency noted in earlier CHANGELOGs. Consumers spreading `mw.asMcpResource()` output directly into `server.registerResource(...)` no longer need the `{ ...r, read: r.handler }` shim.

  ```js
  // Before (still works):
  const r = cache.asMcpResource();
  server.registerResource({ ...r, read: r.handler });

  // After (now the recommended shape):
  server.registerResource(cache.asMcpResource());
  ```

- **`read` takes precedence when both are provided** — deliberate: `read` is canonical per MCP spec, `handler` is the compatibility shim for the plugin's `asMcpResource()` pattern. Registering with both is atypical (why?) but well-defined.

- **4 new tests** (780 total): `registerResource` accepts a `handler` alias and the value round-trips through `resources/read`; `registerResourceTemplate` accepts a `handler` alias; template rejects when neither `read` nor `handler` is supplied; `read` takes precedence when both are present.

### Changed

- Error messages updated: `resource X: read must be a function` → `resource X: read (or handler) must be a function` (both `read` and `handler` now valid).

### Notes

- **The demo app's `fromMiddleware()` adapter shim is no longer necessary** — a follow-up demo-app release will drop it. Existing code using the shim continues to work; it's just extra ceremony.
- **Fully backward-compatible.** Existing consumers registering with `read` see no change; the shim only activates when `handler` is present and `read` is not.
- **Test file assertion updated** to match the new error message (`/read \(or handler\)/`). No other code changes required.

## [1.40.0] — 2026-08-06

### Added

- **Anthropic rate-limit plumbing.** The Anthropic provider now attaches `_rateLimit` on chat + stream responses, matching the OpenAI-compat behavior shipped in 1.38.0. `usageMetering.rateLimits('anthropic')` now returns a snapshot; Prometheus emits the same `llm_rate_limit_*` gauges for Anthropic traffic; MCP `config://usage` payload includes it.

  ```js
  await llm.chat({ ..., providerAlias: 'anthropic' });
  meter.rateLimits('anthropic');
  // → {
  //     requestsLimit: 1000, requestsRemaining: 999, requestsResetAt: '2026-08-06T12:00:00Z',
  //     tokensLimit: 400000, tokensRemaining: 399900, tokensResetAt: '2026-08-06T12:00:00Z',
  //     retryAfterSeconds: undefined, updatedAt: '2026-08-06T00:00:00Z',
  //   }
  ```

- **`extractAnthropicRateLimit(stream)`** — defensive helper wired into both `_chat` and `_stream` paths. Handles the three Anthropic SDK response-accessor shapes (function, Promise property, absent) plus a swallow-and-skip path for SDK errors. Rate-limit tracking is best-effort observability, never a reason to fail a chat call.

- **7 new tests** (776 total): `_chat` attaches `_rateLimit` when SDK exposes `response()` as a function, works with the Promise-property shape, gracefully skips when the accessor is missing (older SDK), swallows extraction errors, omits `_rateLimit` when headers carry no rate-limit info, `_stream` attaches `_rateLimit` on the done chunk, end-to-end with `usageMetering.rateLimits('anthropic')`.

### Notes

- **Anthropic snapshot uses ISO-format reset timestamps** — parsed via the existing `parseAnthropicRateLimit` shipped in 1.38.0; no plugin changes needed elsewhere. Prometheus `llm_rate_limit_reset_*_seconds` gauges convert the ISO to seconds-from-now the same way as OpenAI-compat.
- **Gemini + Bedrock + Ollama still don't attach `_rateLimit`** — Gemini + Bedrock use vendor SDKs whose transport layer abstracts headers; Ollama doesn't publish rate-limit headers. Follow-up work.
- **SDK compatibility.** Tested against `@anthropic-ai/sdk` v0.36 (currently the pinned version). Future SDK versions may relocate the response accessor — the defensive shape check falls through cleanly so upgrades don't break; consumers who need continued rate-limit tracking can pin the SDK version until the plugin catches up.

## [1.39.0] — 2026-08-06

### Added

- **`streamTools()` — async-generator counterpart to `runTools()`.** Yields per-turn progress events (turn_start, text, tool_call_start, tool_call_result) plus a final `done` event carrying the same shape as `RunToolsResult`. Chat surfaces can render "searching contracts…", "checking compliance…" progress instead of blocking on the full agent trace.

  ```js
  const { streamTools } = require('@saptarishi/cds-plugin-llm');

  for await (const evt of streamTools({
    llm,
    system: 'You help procurement approvers.',
    messages: [{ role: 'user', content: 'Fetch PO 4500000123 and summarize.' }],
    tools: [ searchContracts, priceLookup, complianceCheck ],
    maxSteps: 8,
  })) {
    switch (evt.type) {
      case 'turn_start':        showBadge(`Turn ${evt.step}`); break;
      case 'text':              writeToChat(evt.text);          break;
      case 'tool_call_start':   showBadge(`${evt.name}…`);       break;
      case 'tool_call_result':  hideBadge(evt.name);             break;
      case 'done':              finalize(evt);                    break;
    }
  }
  ```

- **5 event types** (all include `step: 1..maxSteps`):
  - **`turn_start`** — emitted BEFORE each `llm.chat()` call. Useful for "Turn N of M" UIs.
  - **`text`** — assistant text for the turn. Atomic per turn (not token-level deltas). Turns that produce only tool calls emit no `text` event.
  - **`tool_call_start`** — right before a tool runs. Carries `{ id, name, input }`.
  - **`tool_call_result`** — after the tool finishes (success OR error). Carries `{ id, name, result, isError }`. Result is stringified for wire compatibility with the message history the loop appends.
  - **`done`** — final event. Extends `RunToolsResult` with `type: 'done'` + `step`. Shape identical to `runTools()` return value, so consumers can share downstream code.

- **Same validation surface as `runTools()`** — requires `{ llm, messages, tools }`; each tool needs a `run()` function; `maxSteps` guard throws with the same diagnostic when the model loops.

- **12 new tests** (769 total): validation (missing llm / messages / tools / tool.run), text-only turn (turn_start + text + done), single tool call sequence (7 events in order), tool-throws → `isError=true` + error message, unknown-tool-name → clear error the agent can recover from, multiple tool calls in one turn (paired 1:1 start/result), empty-text turn omits text event, `maxSteps` guard throws, `done` event shape matches `RunToolsResult` (aggregate usage across turns, messages/toolCalls arrays, model + stopReason).

- **TS defs:** `StreamToolsEvent` discriminated union (`StreamToolsTurnStartEvent | StreamToolsTextEvent | StreamToolsToolCallStartEvent | StreamToolsToolCallResultEvent | StreamToolsDoneEvent`); `streamTools()` signature returns `AsyncGenerator<StreamToolsEvent, void, void>`.

### Notes

- **Text is emitted atomically per turn** (one `text` event per assistant response). Token-level `text_delta` streaming requires provider changes to preserve `tool_calls` state through the streaming path (OpenAI-compat's stream currently accumulates text but does not surface tool_calls until after the stream closes). Consumers wanting delta streaming for non-agent flows should call `llm.stream()` directly. Delta support for `streamTools` is a follow-up.
- **Consumes the same middleware chain as `runTools()`** — every turn goes through `llm.chat()`, so `guardrails`, `costBudget`, `usageMetering`, `responseCache`, `promptInjectionGuard` all apply per-turn. `costBudget` block errors propagate as thrown exceptions from the generator.
- **Backpressure friendly.** The generator awaits each `llm.chat()` + tool `run()` before yielding the next event. If the consumer stops iterating (early break), no orphan chat calls fire; JavaScript's async-iterator cleanup handles it.
- **Compatible with `runAgents`** — the multi-agent coordinator today wraps `runTools`. A follow-up will offer `streamAgents` with the same event shape so specialist calls can render progress too.

## [1.38.0] — 2026-08-06

### Added

- **Rate-limit-aware cost tracking.** `usageMetering` now records provider-reported rate-limit headers (remaining requests, remaining tokens, reset timestamps, retry-after) alongside token counts. New `mw.rateLimits()` accessor returns the last-seen state per provider alias. Ties into Prometheus + budget for early-warning alerts BEFORE rate-limit rejections start.

  ```js
  const meter = usageMetering({ providerOf: (ctx) => ctx.raw?.providerAlias });
  llm.use(meter);

  await llm.chat({ messages: [...], providerAlias: 'openai' });

  meter.rateLimits('openai');
  // → {
  //     provider: 'openai',
  //     requestsLimit: 5000, requestsRemaining: 4998, requestsResetAt: '2026-08-06T00:00:01Z',
  //     tokensLimit:   250000, tokensRemaining:   249900, tokensResetAt:   '2026-08-06T00:00:00Z',
  //     retryAfterSeconds: undefined,
  //     updatedAt: '2026-08-06T00:00:00Z',
  //   }
  ```

- **Provider wiring** — the OpenAI-compat provider parses response headers via the new `parseOpenAIRateLimit()` and attaches `_rateLimit` on the returned response object. All 6 OpenAI-compat subclasses (Azure OpenAI, GenAI Hub, Groq, DeepSeek, Mistral, Fireworks) inherit this automatically.
- **Header parsers** — `parseOpenAIRateLimit(headers, statusCode)` and `parseAnthropicRateLimit(headers, statusCode)` both exported for consumers doing their own metering. Handle OpenAI's compound-duration reset values (`1s`, `500ms`, `1m5s`, `1h32m`) as well as ISO passthrough; interpret `retry-after` only on 429/503 responses.
- **`mw.rateLimits(providerAlias?)`** — with no args, returns the full `{ [alias]: snapshot }` map; with an alias, returns just that provider's snapshot or `null` when unknown.
- **`mw.reset()`** now clears rate-limit state too.
- **`mw.asMcpResource()` payload extended** — `config://usage` now carries a `rateLimits` field with the current per-provider snapshot.
- **5 new Prometheus metrics** (via `prometheusHandler({ metering })`):
  - `llm_rate_limit_remaining_requests{provider}` — latest x-ratelimit-remaining-requests value
  - `llm_rate_limit_remaining_tokens{provider}` — latest x-ratelimit-remaining-tokens value
  - `llm_rate_limit_reset_requests_seconds{provider}` — seconds until requests bucket resets
  - `llm_rate_limit_reset_tokens_seconds{provider}` — seconds until tokens bucket resets
  - `llm_rate_limit_retry_after_seconds{provider}` — from the LAST 429/503 seen (0 otherwise)

- **19 new tests** (757 total): `parseResetToIso` (durations `1s/500ms/1m5s`, ISO passthrough, unparseable), `parseOpenAIRateLimit` (full header set, 429 retry-after, 200 ignores retry-after, no-headers → null, Headers-object shape), `parseAnthropicRateLimit` (ISO passthrough), `usageMetering.rateLimits()` (latest-wins semantics, alias scoping, stream done-chunk records, reset clears, MCP payload extension), `promMetrics` (all 5 metric families emitted; no series when no state), and OpenAI-compat provider wiring end-to-end (mocked fetch verifies `_rateLimit` reaches the response).

- **TS defs:** new `RateLimitSnapshot` interface; `UsageMeteringMiddleware.rateLimits()` overloads; `parseOpenAIRateLimit` + `parseAnthropicRateLimit` signatures.

### Notes

- **Anthropic + Gemini + Bedrock + Ollama providers do not yet attach `_rateLimit`** — Anthropic uses the SDK's abstracted transport (headers not directly exposed on the streaming path); Gemini + Bedrock use vendor SDKs; Ollama doesn't publish rate-limit headers. Follow-up work will plumb these through — for now, only OpenAI-compat family provides rate-limit state.
- **Snapshot semantics: latest wins.** The middleware overwrites the per-provider slot on every response. If you need history, hook `onRecord` and store the `_rateLimit` field per request.
- **Reset semantics: seconds-from-now.** Prometheus emits reset times as `_seconds` gauges (seconds until reset). Convert to absolute clock time in Grafana with `time() + llm_rate_limit_reset_requests_seconds{provider="openai"}` if you want an ETA.
- **Alert recipe:** `llm_rate_limit_remaining_requests{provider="openai"} / llm_rate_limit_limit_requests{provider="openai"} < 0.1` — 10% remaining, page ops. Combine with `retry_after_seconds > 0` for hard-block alerts.

## [1.37.0] — 2026-08-06

### Added

- **`schemas.asMcpResource()` + `schemas.asMcpResourceTemplate()`** — the shipped `schemas` module now speaks MCP directly. External MCP clients (Claude Desktop, Cline, Cursor) can list every registered schema name via `schema://list` and read any individual schema's JSON via `schema://{name}` (e.g. `schema://Invoice`, `schema://SupplierRisk`). Useful for LLM-driven tool discovery and self-documenting Joule agents that need to construct requests matching a specific shape.

  ```js
  const { schemas } = require('@saptarishi/cds-plugin-llm');
  const { MCPServer } = require('@saptarishi/cds-plugin-llm/lib/mcp/server');

  const listResource = schemas.asMcpResource();
  const perNameTemplate = schemas.asMcpResourceTemplate();
  server.registerResource({ ...listResource, read: listResource.handler });
  server.registerResourceTemplate({ ...perNameTemplate, read: perNameTemplate.handler });
  ```

- **Resource shape** (`schema://list`, JSON):
  ```json
  { "schemas": ["Invoice", "PurchaseOrder", "SupplierRisk", "ContractSummary", "ExpenseReport", "EmailDraft"] }
  ```

- **Resource template** (`schema://{name}`, JSON):
  - Known name → the raw JSON Schema (same object as `schemas.byName(name)`).
  - Unknown name → `{ error: "unknown schema: <name>", known: [...] }` so the client sees an actionable payload with the valid names.

- **TS defs updated:** `SchemasBundle` declares `asMcpResource(): { uri: 'schema://list', ... }` + `asMcpResourceTemplate(): { uriTemplate: 'schema://{name}', ... }` with the literal-string URI types the MCP server expects.

- **3 new tests** (738 total): `asMcpResource()` lists every business-object schema by name, `asMcpResourceTemplate()` resolves `schema://Invoice` to the same reference `schemas.Invoice` returns, unknown-name path returns the error+known payload.

### Notes

- **Consumers custom-registering asMcpResource() outputs** (matching the pattern used for cache / budget / guardrails / injection-guard / usage) still need the same `handler → read` adapter shim. That's a plugin-wide inconsistency I'll unify in a future minor by making MCPServer accept either shape. For now: `{ ...r, read: r.handler }` works.
- **Immutable payloads.** `asMcpResourceTemplate().handler({ name: 'Invoice' })` returns the same object reference as `schemas.Invoice` — mutating it would affect every future consumer. Wrap with `structuredClone(...)` if your MCP client mutates payloads.
- **Extensions aren't listed.** `schemas.extend()` produces one-off variants; those don't show up in `schema://list`. Consumers wanting to expose tenant-specific extensions should register their own resource with a namespaced URI.

## [1.36.0] — 2026-08-06

### Added

- **Multi-modal audio input support.** New helpers `audioFromFile()`, `audioFromUrl()`, `audioFromBase64()` extend the vision + PDF helper family. Providers that speak audio (Gemini native, OpenAI-compat GPT-4o Audio) accept the block directly; providers that don't (Anthropic, Ollama, most Bedrock) throw a clear diagnostic instead of a cryptic upstream 400.

  ```js
  const { audioFromFile } = require('@saptarishi/cds-plugin-llm');

  const voice = await audioFromFile('/tmp/voice-note.mp3');
  const { text } = await llm.chat({
    model: 'gemini-2.5-flash',
    messages: [{
      role: 'user',
      content: [voice, { type: 'text', text: 'Transcribe and extract action items.' }],
    }],
  });
  ```

- **Helper shapes** (mirroring the image + PDF helpers):
  - **`audioFromFile(path)`** — reads from disk, base64-encodes, auto-detects media type from extension. Supported: `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.aac`, `.opus`, `.webm`. Unknown extensions throw with the list of supported ones.
  - **`audioFromUrl(url, mediaType?)`** — reference remote audio. Google Cloud Storage URIs (`gs://bucket/key.mp3`) work on Gemini natively. HTTP URLs get a clear error at dispatch time — providers don't fetch audio by URL today.
  - **`audioFromBase64(data, mediaType)`** — `mediaType` is required (audio formats don't self-describe from bytes the way image magic numbers do; provider APIs need it in the payload).

- **Provider wiring:**
  - **Gemini** — `inlineData` with `audio/*` mimeType (same wire shape as inline images). `gs://` URIs get `fileData` blocks. HTTP URLs throw with a "download client-side" hint.
  - **OpenAI-compatible** — translates to the `input_audio` content block that GPT-4o Audio (and OpenAI-compat gateways mirroring the shape) accept. Format mapping: `audio/mpeg` → `mp3`, `audio/wav` → `wav`, `audio/mp4` → `mp4`, etc. Groq / DeepSeek / etc. will 400 upstream — that's the honest signal that the target model doesn't speak audio.
  - **Anthropic** — new `rejectUnsupportedBlocks()` message-level guard throws before the SDK dispatches. Points users at transcribing client-side (whisper.cpp, Deepgram) OR switching providers.
  - **Ollama** — throws with a whisper.cpp hint + provider switch suggestion.
  - **Bedrock** — throws with Nova Sonic / InvokeModelCommand path guidance (Converse API doesn't route audio yet).
  - **All OpenAI-compat subclasses (Azure OpenAI, GenAI Hub, Groq, DeepSeek, Mistral, Fireworks)** inherit the `input_audio` translation automatically. Ones without audio support 400 upstream.

- **TS defs:** new `AudioBlock`, `AudioBase64Source`, `AudioUrlSource` types; `ContentBlock` union extended; `audioFromFile / audioFromUrl / audioFromBase64` signatures.

- **12 new tests** (735 total): `audioFromBase64` mediaType requirement + shape, `audioFromUrl` shape (with + without mediaType), `audioFromFile` unsupported extension + `.mp3/.wav/.m4a/.flac` extensions map to correct MIME types, Anthropic audio-block rejection (`Claude Voice` diagnostic), OpenAI-compat translation to `input_audio` block (verified via mocked `fetch` capturing the request payload), OpenAI-compat URL-audio rejection.

### Notes

- **Real-time / streaming voice not in scope.** These helpers deliver PRE-RECORDED audio into a chat turn. For live voice, use provider-native realtime APIs (Gemini Live, OpenAI Realtime).
- **Provider support matrix will drift** — hosted OpenAI-compat gateways adopt/drop audio support model-by-model. The plugin translates the block correctly and lets the provider surface accept/reject. Consumers who need pre-flight compatibility can gate on `model` before wiring an audio block.
- **URL-based audio is only usable on Gemini today** — and only for `gs://` URIs. Every other provider rejects URL-source audio at dispatch. Download client-side and pass base64.
- **The Anthropic message-level guard also caches** for future block types — a new `rejectUnsupportedBlocks()` helper we'll extend as we learn about more block types the provider doesn't handle.

## [1.35.1] — 2026-08-06

### Added

- **`guardrails().reset()` + `guardrails().asMcpResource()`** — brings the guardrails middleware in line with the observability pattern used by `costBudget`, `responseCache`, `promptInjectionGuard`, and `usageMetering`. Consumers who register `mw.asMcpResource()` on an MCP server no longer need a hand-rolled adapter for `config://guardrails`.

  ```js
  const gr = guardrails({ inputFilters: [...], outputFilters: [...] });
  llm.use(gr);
  mcpServer.registerResource({ ...gr.asMcpResource(), read: gr.asMcpResource().handler });
  gr.reset();   // zero all counters (useful in tests + after admin review)
  ```

  Resource shape (`config://guardrails`, JSON):
  ```json
  { "inputBlocks": 0, "outputBlocks": 0, "inputRedacts": 0, "outputRedacts": 0,
    "inputFilters": 3, "outputFilters": 1 }
  ```

- **TS defs updated:** `GuardrailsMiddleware` now declares `reset(): void` + `asMcpResource(): { uri: 'config://guardrails', ... }`.

- **2 new tests** (723 total): `reset()` zeroes all four counters after a real block; `asMcpResource()` returns `config://guardrails` with live counters + filter counts.

### Notes

- **Fully backward-compatible.** `guardrails()` returns the same middleware function; the new methods are attached to it. Existing consumers of `gr.stats` are unchanged.

## [1.35.0] — 2026-08-06

### Added

- **`promMetrics` + `prometheusHandler` — Prometheus text-format exporter for the middleware observability surface.** Same counters that the `asMcpResource()` / `mw.stats` APIs expose, serialized to the exposition format Grafana / DataDog agent / Prometheus itself expects to scrape. Drops directly into any Express-shaped app or bare `http.ServerResponse`.

  ```js
  const { prometheusHandler } = require('@saptarishi/cds-plugin-llm');
  app.get('/metrics', prometheusHandler({
    cache, budget, guardrails, injectionGuard, metering,
  }));
  ```

- **Metrics emitted** (help text + type header + labeled series per Prom 0.0.4 exposition):
  - **Cache** — `llm_cache_hits_total`, `llm_cache_misses_total`, `llm_cache_skips_total`, `llm_cache_semantic_hits_total`, `llm_cache_semantic_misses_total`, `llm_cache_embedder_errors_total` (counters); `llm_cache_hit_rate`, `llm_cache_size`, `llm_cache_semantic_index_size` (gauges).
  - **Budget** — `llm_budget_spent_dollars{scope, key}`, `llm_budget_limit_dollars{scope, key}` (gauges). Scope is `total | perTenant | perModel`; absent limits are omitted so Grafana ratio queries don't divide by null.
  - **Guardrails** — `llm_guardrails_blocks_total{stage}`, `llm_guardrails_redacts_total{stage}`. Stage is `input | output`.
  - **Injection guard** — `llm_injection_scanned_total`, `llm_injection_blocked_total`, `llm_injection_sanitized_total`, `llm_injection_warned_total`, plus `llm_injection_detector_hits_total{detector}` for per-detector breakdown (regex / base64 / unicode / delimiters / roleAttempt / lengthAnomaly).
  - **Usage metering** — `llm_usage_requests_total`, `llm_usage_input_tokens_total`, `llm_usage_output_tokens_total`, `llm_usage_cost_dollars_total`, `llm_usage_cached_hits_total`, `llm_usage_cost_saved_dollars_total`, plus per-model / per-tenant / per-provider breakdowns (`llm_usage_requests_by_model_total{model}`, `llm_usage_cost_by_model_dollars_total{model}`, etc.).

- **`excludeBreakdowns: true`** option — drops the per-model / per-tenant / per-provider series. Trade granularity for scrape cardinality on fleets with hundreds of models or thousands of tenants.

- **Label sanitization + escaping** built in — dots, dashes, special chars in tenant / model / provider names get normalized to Prom-legal identifiers (`sanitizeLabelName`); values get escaped for backslash / quote / newline (`escapeLabel`). Both are exported for consumers building their own metric emitters.

- **`prometheusHandler` supports both Express (`res.status().send()`) and bare Node http (`res.writeHead(); res.end()`)** shapes — auto-detected. Sets `Content-Type: text/plain; version=0.0.4; charset=utf-8`. Errors get serialized to a `500` with a `# metrics generation failed: <reason>` comment so the scrape target stays parseable.

- **15 new tests** (721 total): helper unit tests (label escape + name sanitize), empty-bundle output, per-middleware emission (cache with + without semantic, budget with scope+key labels, guardrails stage labels, injection detector labels, metering with per-* breakdowns), `excludeBreakdowns` filter, wild-input label sanitization, prometheusHandler (200 + Content-Type, 500 on error, bare-http shape), and a full-bundle round-trip asserting every `# HELP` has a matching `# TYPE`.

- **TS defs:** `PrometheusMiddlewareBundle`, `PromMetricsOptions`, `promMetrics`, `prometheusHandler`.

### Notes

- **All middleware slots are optional** — pass whichever you have wired. Fields that aren't present in a bundle produce no metrics (no blank series to confuse Grafana).
- **Cardinality caution:** the per-tenant / per-model / per-provider counters produce one series per bucket. A 10K-tenant deployment ≈ 30K time series just from `llm_usage_requests_by_tenant_total` + `_cost_by_tenant_dollars_total`. Use `excludeBreakdowns: true` for those + rely on the `usageMeteringToCap` DB rows for slicing.
- **Auth is caller's responsibility.** `prometheusHandler` is a pure metrics writer — wrap it with Express middleware for bearer auth / IP allowlist. Standard Prom scrape agents already run in a trusted network segment; the handler doesn't second-guess that.
- **Complements `asMcpResource()` — doesn't replace it.** MCP resources are for LLM-driven inspection (Claude Desktop reading the current cache hit rate to answer "how many requests did we cache today?"); Prometheus metrics are for time-series graphs + alerting. Wire both if you have both consumers.
- **Recommended chain unchanged.** promMetrics reads from middleware state, doesn't participate in the request chain. Zero request-path overhead.

## [1.34.0] — 2026-08-06

### Added

- **`schemas` — pre-built JSON Schemas for common business-object extraction.** Every schema is a valid `format:` value for `chat({...})` — pass it straight through and the plugin post-parses the response into the `data` field. Removes the boilerplate of hand-rolling the same `Invoice` / `PurchaseOrder` shape in every consumer.

  ```js
  const { schemas, imageFromFile } = require('@saptarishi/cds-plugin-llm');

  const { data } = await llm.chat({
    system: 'You extract structured invoices from scanned PDFs.',
    messages: [{
      role: 'user',
      content: [imageFromFile('invoice.png'), { type: 'text', text: 'Extract.' }],
    }],
    format: schemas.Invoice,   // ← full JSON Schema, ready-to-use
  });

  data.vendor; data.total; data.lineItems[0].description;
  ```

- **6 shipped business-object schemas:**
  - **`schemas.Invoice`** — vendor, invoice number, dates, subtotal/tax/total, line items, currency, notes. Required: `vendor`, `currency`, `total`, `lineItems`.
  - **`schemas.PurchaseOrder`** — poNumber, supplier, order + requested-delivery dates, line items, totalAmount, incoterm (INCOTERMS 2020), approver, notes. Required: `poNumber`, `supplier`, `currency`, `lineItems`, `totalAmount`.
  - **`schemas.SupplierRisk`** — risk (low/medium/high enum), rationale, confidence (0-1), factors[] (each with impact enum: increases/decreases/neutral).
  - **`schemas.ContractSummary`** — parties, contractType, effective/expiry dates, scope, keyTerms[], obligations[] (with party + dueBy), terminationClause, renewal, governingLaw.
  - **`schemas.ExpenseReport`** — employee, report + period dates, line items (with category enum + receipt bool), total, businessJustification.
  - **`schemas.EmailDraft`** — to/cc/bcc, subject, body, tone enum (formal/neutral/friendly/urgent), attachments.

- **3 reusable sub-schemas** exposed for composition: `schemas.LineItem` (shared between Invoice + PurchaseOrder), `schemas.IsoDate`, `schemas.CurrencyCode`.

- **Helpers:**
  - **`schemas.list()`** — enumerate every registered schema name (useful for a `/schemas` MCP resource or docs generator).
  - **`schemas.byName(name)`** — safe lookup, returns undefined for unknown names.
  - **`schemas.extend(base, { properties, required })`** — non-mutating extend for tenant-specific variants (e.g. `schemas.extend(schemas.Invoice, { properties: { glAccount: { type: 'string' } }, required: ['glAccount'] })`). Base schema is never mutated; required entries are de-duplicated automatically.

- **Every schema is `additionalProperties: false`** — the LLM can't smuggle unspecified fields into the response, and the plugin's post-parse step refuses responses missing declared `required` fields.

- **14 new tests** (706 total): shape validation across every business-object schema (type=object, properties present, required is array, additionalProperties=false, every required field is defined), sub-schema exports, `list()` enumeration, `byName()` lookup + unknown handling, `extend()` merge behavior + non-mutation + required de-duplication + non-object base rejection, chat() integration proving format param reaches the provider unchanged, SupplierRisk enum + factors shape, ContractSummary obligations shape, ExpenseReport line-item required fields, EmailDraft tone enum, LineItem reuse across Invoice + PurchaseOrder.

- **TS defs:** `JsonSchema`, `SchemasBundle`, `schemas` const with typed properties + helpers.

### Notes

- **Not schema validation.** The plugin trusts the LLM to follow the schema; validation lives at the provider layer (some enforce, some don't). Combine with `filters.pii()` or your own post-parse check if you need runtime guarantees.
- **`additionalProperties: false` is deliberately strict.** Some providers strip unknown fields silently; others error. If you need "loose" mode for a specific tenant, use `schemas.extend(base, ...)` and manually set `additionalProperties: true` on the returned schema.
- **Composition:** every business-object schema references `schemas.LineItem` by reference (same object instance). If you monkey-patch `schemas.LineItem` at runtime, Invoice + PurchaseOrder both see the change. Prefer `schemas.extend` for variants.
- **No dependency on JSON Schema tooling.** These are plain literals — bring your own validator (ajv, valibot, zod-from-schema) if you want to validate the response client-side.

## [1.33.0] — 2026-08-06

### Added

- **`saptarishi-llm cost-predict <file.jsonl>` — batch cost predictor CLI.** Reads a JSONL of chat requests, heuristically estimates input tokens (chars ÷ per-model chars/token factor), predicts output tokens as `maxTokens × output-factor`, prices via `DEFAULT_PRICING`, prints a per-model breakdown + percentiles + grand total. Closes the loop with `costBudget` and `FinanceService.LlmSpend`: predict spend BEFORE firing an OpenAI Batch API or Anthropic Message Batches job, so you can size the ceiling and get sign-off in advance.

  ```sh
  saptarishi-llm cost-predict batch.jsonl --model claude-opus-4-7 --output-factor 0.5 --percentile 90

  cost-predict: 1200 request(s) in batch.jsonl
    output-factor=0.5  (predicted output tokens = maxTokens × 0.5)
    percentile   =p90

  MODEL                              #     IN tot    OUT tot   COST tot      COST p90
  ────────────────────────────────────────────────────────────────────────────────────
    claude-opus-4-7                  980   4.2M      500k      $100.5000     $0.1521
    gpt-4o                           200   180k      100k      $2.1500       $0.0180
  ? my-fine-tuned-llm                20    22k       10k       $0.0000       $0.0000
  ────────────────────────────────────────────────────────────────────────────────────
  TOTAL                              1200  4.4M      610k      $102.6500
  ```

- **Input row shapes** accepted, one JSON per line:
  - Full request: `{ model, system?, messages: [...], maxTokens? }`
  - Shorthand: `{ model?, prompt: "...", maxTokens? }`
  - Legacy: `{ model?, text: "...", maxTokens? }`
  Structured content blocks (`messages[i].content = [{type:'text',text:'...'}, ...]`) get flattened + summed. Malformed lines are reported to stderr but don't abort the run — the summary tells you how many were skipped.

- **Per-model char-per-token factors** — heuristic tokenization tuned per model family: Anthropic (3.5), GPT (4.0), Llama (4.2), Mistral (4.1), Gemini (4.0), Qwen (3.2, multilingual denser), DeepSeek (3.8), unknown defaults to 4.0. Not a substitute for provider tokenizers but close enough for pre-batch sizing.

- **Flags:**
  - `--model <id>` — default model for rows that don't set one
  - `--output-factor <n>` — predicted-output ÷ maxTokens ratio (default 0.6). Set 0 for input-only estimation.
  - `--percentile <n>` — cost/token percentile to report per model (default 95)
  - `--max-tokens <n>` — default maxTokens if a row omits it (default 1024)
  - `--json` — machine-readable JSON output for CI pipelines

- **Unpriced models flagged with `?`** in the human table and listed under an `unpriced` section (also in the JSON output). Add them to `DEFAULT_PRICING` or override via code to get accurate estimates.

- **16 new tests** (692 total): missing/nonexistent/empty file, invalid `--output-factor` / `--percentile`, malformed JSONL lines reported-but-ignored, per-model pricing via DEFAULT_PRICING, unknown-model priced=false path, `--model` default fallback, mixed-model bucketing, output-factor=0 (input-only), percentile arithmetic (p90 ≥ p50), full `{system, messages: [...]}` shape, structured content-block messages, human-readable output format (TOTAL row, per-model header, `?` flag for unpriced).

### Notes

- **Not a substitute for real tokenization.** Heuristics are ±15% on English, wider on code and multilingual content. Use for sizing / sign-off / rough budgeting, not billing forecasts. Call your provider's `count_tokens` endpoint if you need precision.
- **Fits the observability family.** `cost-predict` uses the same `DEFAULT_PRICING` table as `costBudget` and `usageMetering`. If you edit the table (or ship pricing overrides), all three tools stay in sync automatically.
- **CI-friendly:** `--json` output plus non-zero exit codes on file errors makes this drop-in for a GitHub Action or CAP pipeline check — fail the deploy if projected spend on a batch exceeds a ceiling.

## [1.32.0] — 2026-08-06

### Added

- **Semantic response cache — `responseCache({ semantic: { embedder, threshold, maxScan, minTextLength } })`.** Cache hits are no longer limited to bit-exact prompt matches. On an exact miss, the middleware embeds the user text and does a linear cosine scan over the most recent `maxScan` cache entries; anything crossing `threshold` returns the cached response. Reduces LLM spend on the common case of "customers asking the same question five different ways."

  ```js
  const llm = await cds.connect.to('llm');
  const cache = responseCache({
    ttl: 3_600_000,
    semantic: {
      embedder:      async (text) => (await llm.embed({ input: [text] })).embeddings[0],
      threshold:     0.92,                // cosine — higher = stricter (default 0.92)
      maxScan:       200,                 // how many recent entries to compare
      minTextLength: 20,                  // skip super-short queries
    },
  });
  llm.use(cache);
  ```

- **On a semantic hit, the returned response is marked with `{ cached: true, semantic: true, similarity: 0.94, cacheKey: <request-key>, semanticMatchKey: <matched-key> }`** — downstream middleware (`usageMetering`) can distinguish semantic hits from exact hits and record them appropriately (still $0 cost — the LLM was not called).

- **`.stats` extended:** `semanticHits`, `semanticMisses` (only counted when there were candidates to compare against — cold-index attempts are noise, not signal), and `embedderErrors`. `hitRate()` now includes semantic hits in the numerator. `asMcpResource().handler()` surfaces all of them plus `semanticIndexSize`.

- **`.semanticIndex`** — the in-process embedding index (`cacheKey → { embedding, semanticText, ts }`) is exposed for tests / manual eviction / debugging. Bounded by `maxScan` via LRU insertion order — evicts oldest when full.

- **`cosine(a, b)`** helper exported for tests and custom scoring.

- **20 new tests** (676 total, +20): cosine correctness (identical / orthogonal / opposite / zero-safe), validation (bad embedder / threshold / maxScan), semantic hit + miss on near-identical vs unrelated phrasing, strict-threshold miss, exact-fast-path when semantic enabled (embedder does NOT run on exact hits), tool-request skip, minTextLength skip, `cache: false` opt-out, embedder-failure non-fatal, hitRate arithmetic, `asMcpResource` snapshot, `maxScan` eviction, `clear()` drops both stores, and stale-index-pointer cleanup.

- **TS defs:** `SemanticCacheOptions`, extended `ResponseCacheStats`, `ResponseCacheMiddleware.semanticIndex`, `cosine`.

### Notes

- **Backward compatible** — `semantic` is opt-in; without it, `responseCache` behaves exactly as it did in 1.26.0+. Existing exact-match caching is unchanged.
- **Eligibility:** requests with `tools: [...]` skip semantic lookup automatically (tool-call routing must be deterministic against the exact input, not a fuzzy neighbor). Structured-output requests (`format: {...}`) DO participate — the caller usually wants shape stability, and the format is part of the cached response.
- **The semantic index is IN-PROCESS regardless of `store`** — Redis + HANA backends still work for exact matches, but each replica warms its own semantic index. That's a deliberate trade-off: cross-instance semantic hits are approximate anyway, and centralized vector search would add a network round-trip on every miss. Roadmap: adapter for HANA vector store as a shared `semantic.store`.
- **Cost model:** every semantic-eligible miss pays for one embedding call. On a 1024-dim provider embedding at ~$0.00013/1K tokens, that's ~$0.0000002 per short prompt — order-of-magnitude cheaper than the completion it might save. Set `minTextLength` higher if you have very high volume of tiny prompts.
- **Threshold tuning:** start at 0.92 (strict). Drop to 0.85 for chatty consumer surfaces; go higher (0.95+) for accuracy-critical flows (compliance, legal). `semanticMisses` counts only compare-and-fail attempts — the metric is directly useful for threshold tuning without cold-start noise.
- **Recommended chain unchanged:** `promptInjectionGuard → guardrails → costBudget → usageMetering → responseCache → provider`. Semantic hits still contribute $0 rows to `LlmSpend` and increment `summary.totalCostSaved`.

## [1.31.0] — 2026-08-05

### Added

- **`promptInjectionGuard({ action, threshold, detectors, maxUserMessageChars, extraPatterns, onDetect })` — dedicated prompt-injection detection middleware.** Where `filters.promptInjection()` is a single regex layer for the shipped `guardrails()` middleware, `promptInjectionGuard()` is a top-level middleware that layers **six** detectors, aggregates their confidences, and picks an action based on the combined score. Runs outer of everything else so the sanitized (or blocked) payload is what cache keys, metering, and the provider see.

  ```js
  const { promptInjectionGuard } = require('@saptarishi/cds-plugin-llm');

  const guard = promptInjectionGuard({
    action:    'sanitize',            // 'block' | 'sanitize' | 'warn'
    threshold: 0.6,                    // combined confidence (0, 1]
    detectors: ['regex', 'base64', 'unicode', 'delimiters', 'roleAttempt', 'lengthAnomaly'],
    maxUserMessageChars: 8000,
    onDetect: (info) => cds.log('llm:injection').warn(info),
  });
  llm.use(guard);
  ```

- **Six detectors, each returning a confidence weight:**
  - **`regex`** (0.7) — override phrases (`ignore previous instructions`, `disregard prior prompts`), role-play manipulation (`you are now DAN`, `pretend to be`, `act as`), prompt exfiltration (`reveal your system prompt`, `print your instructions`), delimiter smuggling (`[INST]`, `<|im_start|>`, `<system>`, `### System`), and data-exfil framing (`send the conversation to`). ~20 patterns; `extraPatterns` augments.
  - **`base64`** (0.85) — scans for base64 chunks ≥ 40 chars, decodes to UTF-8, re-runs the regex battery on the decoded text. Skips binary blobs (< 30% printable). Catches smuggled payloads that would otherwise slip past a regex-only layer.
  - **`unicode`** (0.4 / 0.35) — flags zero-width & bidi control chars (U+200B..U+200F, U+202A..U+202E, U+FEFF), plus Cyrillic/Latin homoglyph mixes (Cyrillic `а` in an otherwise-Latin word).
  - **`delimiters`** (0.6) — fake conversation turn markers (`--- ASSISTANT TURN ---`, `=== SYSTEM ===`, `~~~ USER ~~~`).
  - **`roleAttempt`** (0.5) — broader role-manipulation phrasing the regex layer misses (`from now on`, `starting now, you are`, `new role:`).
  - **`lengthAnomaly`** (0.25) — user messages > `maxUserMessageChars`. Weak signal alone; combines with others to push a mixed attack over threshold.

- **Three actions:**
  - **`block`** (default) → throws `PromptInjectionError` with `.code = 'PROMPT_INJECTION'`, `.score`, `.evidence`. Provider never called.
  - **`sanitize`** → mutates the request in place: strips zero-width / bidi controls, NFKC-normalizes homoglyphs, replaces fake-turn / `<|im_start|>` / `<system>` markers with `[...-removed]` placeholders, truncates to `maxUserMessageChars`. Detector output logged via `onDetect`. Then the request proceeds.
  - **`warn`** → `onDetect` fires; request proceeds unmodified. Zero-blocking observability mode.

- **`.stats`** surface — `{ scanned, blocked, sanitized, warned, byDetector: { regex, base64, unicode, delimiters, roleAttempt, lengthAnomaly } }` for /prompt-injection-stats dashboards. **`.reset()`** and **`.asMcpResource()`** (`config://prompt-injection-guard`) match the pattern used by the other observability primitives.

- **27 new tests** (656 total): validation, clean-input passthrough, regex family (classic override, DAN, reveal-prompt, extraPatterns), base64 (encoded injection, benign decode, binary skip), unicode (zero-width, homoglyphs), delimiter smuggling, length anomaly (alone-vs-combined threshold behavior), sanitize path (zero-width strip, fake-turn replace, truncation), warn path (`onDetect` fires + request proceeds + errors swallowed), detector opt-out, stream pre-check, multi-content structured messages, and stats+reset+asMcpResource.

- **TS defs:** `InjectionDetector`, `PromptInjectionHit`, `PromptInjectionGuardOptions`, `PromptInjectionGuardStats`, `PromptInjectionGuardMiddleware`, `PromptInjectionError`.

### Notes

- **Recommended chain:** `promptInjectionGuard → guardrails → costBudget → usageMetering → responseCache → provider`. Placing the guard OUTER of `guardrails` means it runs before PII scrubbing — that's intentional: injection detection wants to see the raw payload so it can spot zero-width chars and homoglyphs before NFKC normalization erases them.
- **`guardrails` + `promptInjectionGuard` compose cleanly** — they operate on different signals. `guardrails.filters.promptInjection()` stays useful as a fast first-line filter; `promptInjectionGuard()` adds depth. Deployments running both incur ~2 regex passes on user text; the incremental cost is negligible vs. a provider round-trip.
- Confidence weights are tunable at threshold time, not per-detector today. If you want a detector to only warn (not block), disable it in `detectors: [...]` and add an `onDetect` upstream — or file an issue.

## [1.30.0] — 2026-08-05

### Added

- **Pluggable counter storage for `costBudget` — `store` option + `RedisCounterStore` + `InMemoryCounterStore`.** Closes the single-process disclaimer from 1.29.0. Multiple app instances (Kubernetes replicas, blue/green deploys, etc.) can now share a single spend ledger via Redis so per-tenant / per-model / total ceilings hold across the fleet.

  ```js
  const Redis = require('ioredis');
  const { costBudget, RedisCounterStore } = require('@saptarishi/cds-plugin-llm');

  const redis = new Redis(process.env.REDIS_URL);
  const budget = costBudget({
    limits: { total: 1000, perTenant: { default: 100 } },
    window: 'day',
    store: new RedisCounterStore(redis, {
      namespace:     'llm:budget',
      keyTtlSeconds: 60 * 60 * 24 * 40,   // covers month windows with margin
    }),
  });
  llm.use(budget);
  ```

  - **`RedisCounterStore(client, { namespace, keyTtlSeconds, scanCount })`** — accepts any ioredis-shaped client. Uses `INCRBYFLOAT` for atomic increments (multi-instance safe), `SCAN + MGET` for snapshots, and `EXPIRE` on every write so old-window keys age out on their own (no cron / manual cleanup).
  - **`InMemoryCounterStore`** — the default per-process store, now exported so consumers can subclass it or use it as the reference impl for their own adapter.
  - **`CounterStore` contract** — four methods: `get(scope, key, bucket)`, `add(scope, key, bucket, amount)`, `snapshot(bucket)`, `clear()`. Each may return sync or `Promise` — the middleware `await`s uniformly. HANA / DynamoDB / Postgres adapters plug in the same way.

- **15 new tests** covering `InMemoryCounterStore` (add / get / snapshot / clear), the async-store contract path (proves `spent()`, `snapshot()`, `reset()` accept promises), `RedisCounterStore` against a mock ioredis client (INCRBYFLOAT, namespaced keys, TTL refresh, add(0) no-op, empty snapshot, SCAN-based clear, cross-bucket isolation), and end-to-end integration (two independent budget middlewares sharing a Redis store agree on total spend and refuse over-limit calls on either instance).

### Changed

- **BREAKING (minor):** `costBudget` introspection methods (`spent`, `spentTotal`, `snapshot`, `reset`) now delegate to the store. With the default `InMemoryCounterStore` they remain synchronous; with an async store (e.g. `RedisCounterStore`) they return `Promise`s. Callers using the default store don't need code changes; callers passing a custom store must `await` these methods.
- **BREAKING (minor):** `asMcpResource().handler` is now `async` (must `await` store I/O). Existing MCP integrations already await handlers so no code changes are needed there; direct sync callers must add `await`.
- Recommended chain ordering unchanged: `guardrails → costBudget → usageMetering → responseCache → provider`.

### Notes

- `RedisCounterStore.clear()` uses `SCAN + DEL` in batches (not `FLUSHDB`) — safe to share Redis with other apps, only touches keys under the configured `namespace`.
- The Redis store's per-key TTL is refreshed on every `add()`. Buckets that stop receiving writes will expire naturally after `keyTtlSeconds`; there's no background sweeper.
- Race window: pre-call check + record are still non-atomic across instances — a small number of concurrent requests may all pass the check-and-then-record boundary before any of them records their cost. Acceptable for soft cost-control ceilings; use a tighter limit if strict.

## [1.29.0] — 2026-08-05

### Added

- **`costBudget({ limits, window, action, currency, tenantOf, providerOf, onExceeded })` — cost-budget enforcement middleware.** Reads per-model pricing (same table as `usageMetering`), maintains per-window spend counters, and throws / warns / hooks when a limit is crossed. Ties directly into the existing `FinanceService.LlmSpend` accounting story from 1.22.0.

  ```js
  const { costBudget } = require('@saptarishi/cds-plugin-llm');

  const budget = costBudget({
    limits: {
      total:     1000,                            // $1000/day across everything
      perTenant: { default: 100, 'acme': 500 },   // $100/day/tenant; Acme gets $500
      perModel:  { 'claude-opus-4-7': 50 },       // Opus capped at $50/day
    },
    window: 'day',
    action: 'throw',                              // or 'warn'
    tenantOf:  (ctx) => ctx.raw?.tenant,
    onExceeded: (info) => cds.log('llm:budget').warn(info),
  });
  llm.use(budget);
  ```

- **`BudgetExceededError`** — thrown by pre-call refusal. Has `.code = 'BUDGET_EXCEEDED'`, `.scope`, `.key`, `.current`, `.limit`, `.currency`. Actionable: the CAP handler can `req.error(429, err.message)` to surface a clean 429 to the client.

- **Two enforcement points**:
  1. **Pre-call** — before the LLM request is dispatched, current window spend is compared against the limit. If already over, `BudgetExceededError` is thrown (or `onExceeded` fires with `action: 'block'`). The provider is never called.
  2. **Post-call** — response's `usage` is priced via `DEFAULT_PRICING` (merged with `pricing` overrides) and added to counters. If this call pushed us over, `onExceeded` fires with `action: 'exceeded'` so downstream systems (Alertmanager, Slack, PagerDuty) know a threshold was crossed.

- **Window rotations** — counters bucketed by ISO string prefix so they reset naturally:
  - `'hour'` → `YYYY-MM-DDTHH`
  - `'day'` (default) → `YYYY-MM-DD`
  - `'month'` → `YYYY-MM`
  - `'process'` → never resets (until process restart)
  - `<n: number>` → per-N-second sliding window
  No cron jobs needed; the next call in a new window sees a fresh bucket.

- **Actions**:
  - `'throw'` (default) — pre-call check throws `BudgetExceededError`; post-call `onExceeded` fires with `action: 'exceeded'`.
  - `'warn'` — never blocks. `onExceeded` fires for both pre-call (`action: 'block'`) and post-call (`action: 'exceeded'`) so consumers can decide policy externally (Prometheus counter, Alertmanager, degraded-mode routing).

- **Scopes**: `total`, `perTenant`, `perModel`. `perTenant.default` and `perModel.default` act as catch-alls when a specific key isn't listed. Named entries override the default.

- **`.snapshot()`, `.spent()`, `.spentTotal()`, `.limitFor()`, `.reset()`** on the middleware for observability + tests. `.asMcpResource()` returns a `config://budget` MCP resource dumping `{ window, limits, currency, current: snapshot }` — mirrors `usageMetering.asMcpResource()`.

- **Pricing** — same shape as `usageMetering`. Merges user overrides into `DEFAULT_PRICING`. Unknown models cost $0 but the request is still counted. `pricingUnit` defaults to 1M tokens; per-1K contract prices set `pricingUnit: 1000`.

- **Streams counted** — the `done` chunk on `stream()` carries usage; the middleware records it same as chat.

- **TS defs**: `BudgetLimits`, `BudgetWindow`, `BudgetScope`, `BudgetSnapshot`, `CostBudgetOptions`, `CostBudgetMiddleware`, `BudgetExceededError`.

- **21 new tests (614 total)**: validation (bad action + bad window), basic pricing sums via `DEFAULT_PRICING` + overrides + unknown-model $0 fallback, pre-call refusal (total limit, perTenant scoping, `perTenant.default` catch-all, perModel scoping, LLM not called on refusal), warn mode (never blocks + `onExceeded` fires + `onExceeded` errors swallowed), `action: 'block' | 'exceeded'` distinction in the hook, `window: 'process'` never resets, `reset()` zeroes counters, `.snapshot()` shape, `.spent()` per-key, `.limitFor()` resolves named → default → null, `.asMcpResource()` shape, stream done-chunk accounting, clean composition with `usageMetering` in the same chain.

### Notes

- Additive — `^1.28` consumers bump to `^1.29` with zero code changes. `costBudget` is opt-in via `llm.use(...)`; nothing changes for callers not attaching it.
- **Ordering**: recommended chain is `guardrails → costBudget → usageMetering → responseCache → provider`. costBudget should sit OUTER of the metering + cache so the refusal fires before either does bookkeeping. Cache hits still count against the budget (same cost as an uncached call) — swap that behavior by putting the cache OUTER of the budget if desired.
- Per-process by default — for multi-instance CF / K8s deployments, aggregate the per-replica counters upstream (Prometheus + PromQL sum, or wire a shared Redis backend). The middleware is designed to be adapter-friendly; a Redis backend can ship in a future release without changing the API.
- Budget checks are stateful and NOT strictly transactional — race conditions may allow one extra request through on the boundary of the check-and-record window. This is acceptable given the enforcement is a soft ceiling for cost control, not a per-transaction security guarantee.

## [1.28.0] — 2026-08-05

### Added

- **`guardrails({ inputFilters, outputFilters, onBlock, onRedact })` — pluggable input/output filter middleware for `llm.use()`.** Filters can allow, block (throws `GuardrailBlockedError`), or redact (mutates the payload). Input filters run BEFORE the request reaches the provider; output filters run BEFORE the response is returned to the caller. Fits SAP procurement pitches where data-handling compliance is a hard requirement.

  ```js
  const { guardrails, filters } = require('@saptarishi/cds-plugin-llm');

  llm.use(guardrails({
    inputFilters: [
      filters.blocklist(['password', /internal-only-\\d+/i]),
      filters.pii({ redact: true }),
      filters.promptInjection(),
    ],
    outputFilters: [
      filters.pii({ redact: true }),
    ],
    onBlock: (info) => cds.log('llm:guardrails').warn(info),
  }));
  ```

- **Filter signature**: `async (payload, ctx) => { action: 'allow' | 'block' | 'redact', reason?, payload? }`. Input side sees `{ system, messages }`; output side sees the full chat response. Returning `undefined` is treated as `allow`. Redactions mirror back into `ctx.request` (input) or become the return value (output).

- **`GuardrailBlockedError`** — thrown when any filter blocks. Has `.code = 'GUARDRAIL_BLOCKED'`, `.reason`, and `.details = { stage, filterIndex }` for observability.

- **Built-in filters** shipped in `filters`:
  - **`filters.blocklist(patterns, { mode?, replacement? })`** — string/regex blocklist. `mode: 'block'` (default) throws on match; `mode: 'redact'` replaces matches. Strings are literal substring; regexes are used verbatim.
  - **`filters.pii({ redact?, types?, replacement? })`** — PII regex detector for `ssn` (US), `creditCard`, `email`, `phone` (US). Redacts by default; `redact: false` blocks. `types` restricts scope.
  - **`filters.promptInjection({ extraPatterns? })`** — heuristic detector for common prompt-injection patterns ("ignore previous instructions", "you are now DAN", fake `<system>` role tags, etc.). Examines only `user` + `tool` messages — never the system prompt itself.

- **`onBlock` + `onRedact` hooks** for CAP logging, Prometheus counters, Alertmanager escalations. Hook errors are swallowed to protect the request path.

- **Stats surface** — `guardrails.stats` exposes `{ inputBlocks, outputBlocks, inputRedacts, outputRedacts }` counters.

- **TS defs**: `GuardrailFilter`, `GuardrailVerdict`, `GuardrailsOptions`, `GuardrailsStats`, `GuardrailsMiddleware`, `GuardrailBlockedError`, `BlocklistOptions`, `PiiOptions`, `PromptInjectionOptions`. `filters` namespace exported.

- **29 new tests (593 total)**: construction validation, allow-passthrough, input/output block, stats + hooks, input/output redact composition, blocklist (strings/regex/redact/errors), pii (all types + custom replacement + block mode + output-side + errors), promptInjection (four attack patterns, system-prompt trust boundary, extra patterns, benign queries), filter ordering + composition.

### Notes

- Additive — `^1.27` consumers bump to `^1.28` with zero code changes.
- Heuristic prompt-injection detection is deliberately shallow — it catches common patterns fast but is NOT defense-in-depth. Layer with least-privilege tool access, output constraints (structured JSON), and stakeholder review before letting an LLM interact with sensitive systems.
- Filters run in list order; the first block wins. Expensive filters (external moderation APIs, cross-encoder classifiers) should come last so cheap wins short-circuit.
- Streams: input filters run before the stream opens; per-chunk output filtering is NOT in scope for this release. Collect and filter at the end if you need it.

## [1.27.0] — 2026-08-05

### Added

- **`Agent` class + `runAgents({ coordinator, agents, input, ... })` — multi-agent orchestration on top of `runTools()`.** Wire multiple specialist agents (each with its own LLM + tools + system prompt) behind a supervisor coordinator that routes tasks to the right specialist. Fits SAP procurement workflows where a supervisor routes to contract-lookup, price-analyst, compliance-checker specialists — each backed by whichever LLM (cheap vs smart) suits its role.

  ```js
  const { Agent, runAgents } = require('@saptarishi/cds-plugin-llm');

  const contractLookup = new Agent({
    name: 'contract-lookup', llm: cheapLlm,
    description: "Answers questions about supplier contracts.",
    system: 'You are a procurement specialist. Use the tools to look up contracts.',
    tools: [/* hybridSearchTool, ... */],
  });
  const priceAnalyst = new Agent({ name: 'price-analyst', llm: smartLlm, description: '...', tools: [...] });
  const compliance   = new Agent({ name: 'compliance-checker', llm: smartLlm, description: '...' });

  const { text, trace } = await runAgents({
    coordinator: smartLlm,
    agents: [contractLookup, priceAnalyst, compliance],
    input: 'For PO 4500000123 draft a compliance memo including price analysis.',
  });
  // trace: [{ agent: 'contract-lookup', question, answer, isError }, ...]
  ```

- **How it works.** `runAgents` synthesizes one tool per agent (`invoke_<name>`) with a single `question: string` parameter, then runs `runTools()` on the coordinator with those tools. Each specialist call goes through the tool's `run()`, which forwards the coordinator's question to the agent's own `run({ input })` method — and that in turn calls `runTools()` internally if the agent has its own tools. So it's tool-loops all the way down; every existing runTools guarantee (usage aggregation, `maxSteps` cap, error surfacing) still holds.

- **`Agent` class** — named specialist wrapping an LLM + optional tools + system prompt:
  - `name` must match `/^[a-zA-Z0-9_-]+$/` (LLM tool-name rules).
  - `description` shown to the coordinator — used to decide when to invoke.
  - `tools` optional — a tool-less agent just does a single `chat()` with the input as the user message.
  - `maxSteps` bounds the agent's own tool loop (default 10).
  - `model` overrides the agent's LLM's default model per-agent.

- **Duck-typed agents welcome** — anything with `{ name, description, run({ input }) => Promise<string | { text }> }` counts as an agent. Plug in non-LLM workers (a SQL query engine, a rules engine, a webhook caller) alongside real `Agent` instances. `runAgents` unwraps `.text` if the run returns an object.

- **Coordinator system prompt** — the default `DEFAULT_COORDINATOR_SYSTEM` is exported so callers can compose. Override per call via `system`. Emphasizes: pick the right specialist, don't answer the specialist's question yourself, admit when no specialist fits.

- **`onAgentInvocation` hook** — fires with `{ agent, question }` every time the coordinator invokes a specialist. Perfect for observability (tracing, OTel spans, per-agent cost lines in `usageMetering`).

- **Compact trace** — the returned `result.trace` is one entry per specialist call in invocation order: `{ agent, question, answer, isError }`. Callers who want the raw `runTools`-style tool-call array can read `result.toolCalls` on individual `Agent.run` returns.

- **Errors surface cleanly** — a specialist throwing → `trace[i].isError: true` with the exception message; the coordinator sees the same message as tool-result content and can decide whether to try another specialist or produce a fallback answer.

- **TS defs**: `Agent`, `AgentOptions`, `AgentRunResult`, `AgentLike` (duck-typed), `RunAgentsOptions`, `RunAgentsResult`, `DEFAULT_COORDINATOR_SYSTEM` string constant.

- **22 new tests (564 total)**: `Agent` construction validation (name regex, required description, LLM, tools shape, maxSteps bounds), tool-less agent single-chat path, non-string input rejection, model override propagation, tool-loop happy path via delegation to `runTools()`. `runAgents` validation (coordinator, agents array, input, per-agent required fields, duplicate name detection), single-specialist happy path with trace assertion, multi-step routing across two specialists in sequence, duck-typed non-Agent workers, `onAgentInvocation` firing, custom + default coordinator system prompt, specialist throwing surfaces as `isError: true`, coordinator supplying bad tool-call args → clean error not crash.

### Notes

- Additive — `^1.26` consumers bump to `^1.27` with zero code changes. Nothing changes for callers who don't use `Agent` / `runAgents`.
- Coordinator choice matters: use a smart model (Claude Opus, GPT-4o, Gemini Pro) for the supervisor because the routing decision benefits from strong tool-selection reasoning. Specialists can use cheap models (Haiku, Gemini Flash, Groq's `llama-3.1-8b`) where their scope is narrow.
- Latency is additive — each specialist invocation adds one full tool-loop plus one coordinator turn. For latency-sensitive paths, use `runTools` directly with all specialist tools flattened onto a single LLM instead. `runAgents` shines when specialists' contexts, models, or tools legitimately differ.
- Every layer respects the existing `usageMetering` + `responseCache` middleware since both agent and coordinator LLMs are regular `LLMService` instances — coordinator + specialist requests all get metered and cached separately.

## [1.26.0] — 2026-08-05

### Added

- **`responseCache({ store, ttl, keyFn, maxEntries?, onHit?, onMiss? })` — response cache middleware for `llm.use()`.** Memoizes identical `chat()` calls keyed by a SHA-256 hash of `(model, system, messages, tools, format, maxTokens)`. Cache hits return the previous response tagged with `cached: true` + `cacheKey` for targeted invalidation. Streams, embeddings, and tool-turn responses (`result.toolCalls`) are NOT cached — those are either hard to replay safely or intermediate steps.

  ```js
  const { responseCache, usageMetering } = require('@saptarishi/cds-plugin-llm');

  // Order matters — usageMetering OUTER so it sees cache-hit responses on
  // the way back up the chain. If cache ran outer, hits would short-circuit
  // before meter's next() returned.
  llm.use(usageMetering({ ... }));
  llm.use(responseCache({ ttl: 60 * 60_000 }));   // 1 hour default

  const r1 = await llm.chat({ messages: [...] });  // MISS — real LLM call
  const r2 = await llm.chat({ messages: [...] });  // HIT — r2.cached === true
  ```

- **In-memory LRU with per-entry TTL (default backend).** New `InMemoryLRU` class exported for consumers who want to pre-warm the cache or share one across multiple provider instances. Evicts oldest on `maxEntries` overflow (default 10,000). `get()` touches recency so hot entries survive.

- **Pluggable backends.** Pass any `store` implementing `{ get(key), set(key, value, ttlMs), delete?, clear?, size?, has? }`. Redis, HANA cache tables, ioredis, `keyv` — all drop in cleanly. Persistence errors during `set` are swallowed so a hiccup in the backend never fails the underlying request that already succeeded.

- **Per-call opt-out**: pass `cache: false` on the `chat()` request. Increments `stats.skips` for observability.

- **Custom `keyFn` for domain-specific bucketing.** Default hashes `(model, system, messages, tools, format, maxTokens)`; write your own to collapse near-duplicate queries under one entry (e.g. normalizing whitespace, lowercasing, tenant-scoping the key). `keyFn` throws are caught → falls through to a live call so a broken key-gen never takes down `chat()`.

- **`usageMetering` integration** — when a cached response with `result.cached === true` bubbles up through metering, the request is still counted (`totalRequests`) BUT charged $0. New `summary.totalCachedHits` counts them; new `summary.totalCostSaved` sums what those hits WOULD have cost if the LLM had actually been called. `record.cached` bool now on every `onRecord` sink record.

  ```jsonc
  // Example summary after 100 requests with a 40% hit rate on Claude Opus:
  {
    "totalRequests":     100,
    "totalCost":         12.75,      // paid for 60 real calls
    "totalCachedHits":   40,
    "totalCostSaved":    8.50,       // 40 hits × ~$0.21 avg
    "byModel":           { ... }
  }
  ```

- **`asMcpResource()`** on the cache middleware — a ready-to-register MCP resource at `config://cache` returning `{ hits, misses, skips, hitRate, size }`. Mirrors the pattern in `usageMetering.asMcpResource()`.

- **Middleware helpers**: `mw.stats`, `mw.store`, `mw.size()`, `mw.hitRate()`, `mw.clear()`, `mw.delete(key)`. `mw.delete(cachedResponse.cacheKey)` invalidates a single entry.

- Exports: `responseCache`, `InMemoryLRU`. TS defs — `ResponseCacheOptions`, `ResponseCacheStore`, `ResponseCacheStats`, `ResponseCacheMiddleware` — with `@since 1.26.0`. `UsageSummary` extended with `totalCachedHits: number` and `totalCostSaved: number`. `UsageRecord` extended with `cached: boolean`.

- **25 new tests (542 total)**: basic caching (real LLM called once on identical repeat), key-scope discrimination (differing messages / system / tools / format each break cache), per-call opt-out via `chat({ cache: false })`, embeds not cached, tool-turn responses not cached, TTL expiry forces re-fetch, LRU eviction on `maxEntries`, `get()` touches recency so hot entries survive, expired entries deleted lazily, pluggable-store backend, custom `keyFn`, `keyFn` throwing falls through, usageMetering integration (0 cost + totalCachedHits + totalCostSaved), no cache attached → counters stay at 0, `reset()` zeroes the new counters, `onHit` + `onMiss` hooks fire, `clear()`, `delete(key)`, `asMcpResource()` shape, ttl / keyFn validation, `defaultKeyFn` determinism.

### Notes

- Additive — `^1.25` consumers bump to `^1.26` with zero code changes. `responseCache` is opt-in via `llm.use(...)`; `usageMetering` still works exactly as before if no cache is attached (both new counters stay at 0).
- Middleware ordering: **usageMetering OUTER, responseCache INNER** for savings tracking to work. Reverse the order and cache hits short-circuit before meter sees them — the requests count zero and no savings are tracked. Documented in the CHANGELOG and inline in the tests.
- The default in-memory LRU is per-process. For multi-instance deployments (CF, Kyma, K8s), each replica gets its own cache — cross-replica coherence needs a shared backend. Drop in Redis via a small `{ get, set }` adapter or point at a HANA cache table.
- Cache keys are SHA-256 hex (64 chars). Users needing shorter keys for a specific backend can transform them inside their `keyFn` — but keep in mind two colliding requests would return the wrong cached response.

## [1.25.0] — 2026-08-05

### Added

- **Batch API — bulk-async provider endpoints for cost-optimized offline workloads.** Anthropic's Message Batches and OpenAI's Batch API both ship at ~50% of sync-API prices with a 24h SLA. Ideal for nightly-scoring pipelines: bulk classification over invoices, offline enrichment of supplier records, overnight summarization jobs.

  ```js
  // Submit
  const handle = await llm.batch({
    requests: [
      { customId: 'inv-1', system: 'Extract invoice line items...', messages: [...], maxTokens: 400 },
      { customId: 'inv-2', system: 'Extract invoice line items...', messages: [...], maxTokens: 400 },
      // ...
    ],
    completionWindow: '24h', // OpenAI only; Anthropic ignores this
  });
  // → { id, provider: 'anthropic'|'openai', status: 'in_progress', submittedAt, counts, raw }

  // Poll
  let status = handle;
  while (status.status === 'in_progress') {
    await new Promise(r => setTimeout(r, 30_000));
    status = await llm.getBatch(handle.id);
  }

  // Retrieve
  const results = await llm.getBatchResults(handle.id);
  // → [{ customId, text, usage, model, ... } | { customId, error, errorType, ... }, ...]

  // Cancel (if you need to)
  await llm.cancelBatch(handle.id);
  ```

- **Unified `BatchRequest` / `BatchHandle` / `BatchResult` shapes** — same handles work regardless of provider. `handle.status` collapses each provider's finer states to `'in_progress' | 'completed' | 'failed' | 'canceled'`; `handle.counts` reports processing / succeeded / errored / canceled / expired.

  Anthropic status mapping: `processing_status: 'in_progress'` → `'in_progress'`; `'ended'` → `'completed'`.

  OpenAI status mapping: `validating` / `in_progress` / `finalizing` → `'in_progress'`; `completed` → `'completed'`; `failed` / `expired` → `'failed'`; `cancelling` / `cancelled` → `'canceled'`.

- **Implemented on `AnthropicLLMService` (Message Batches)** — uses the official `@anthropic-ai/sdk` `messages.batches.{create, retrieve, results, cancel}`. `results()` returns an async iterable; entries are translated into unified `BatchResult`s with text extracted from `content: [{ type: 'text', text }]` blocks, `tool_use` blocks becoming `toolCalls`, `errored`/`canceled`/`expired` entries becoming `{ error, errorType }`.

- **Implemented on `OpenAICompatibleLLMService` (OpenAI Batch API)** — the two-step flow: upload JSONL via `POST /v1/files` with `purpose: batch`, then `POST /v1/batches` with the `input_file_id`. `getBatchResults()` downloads `output_file_id`'s content, parses JSONL, and normalizes each line. Providers using this base but WITHOUT the batch endpoints (Groq, DeepSeek, Fireworks, Mistral) get the upstream 404/400 clearly. Users on those providers should stick to `chat()`.

- **Argument validation on the `LLMService` base** — `batch({})` rejects empty request lists; each `requests[i]` must have a non-empty `customId` and non-empty `messages`. `getBatch('')` / `cancelBatch(null)` reject with clear errors.

- **Clear "not supported" errors on providers without batch** — `Ollama`, `Gemini`, `Bedrock`, `GenAIHub`, and any subclass not overriding the internal `_batchSubmit` etc. throw a specific message pointing at the two supported providers and suggesting `chat()` instead.

- **Middleware does NOT wrap batch calls** — the request lifecycle is fundamentally async. Per-request cost accounting fires when `getBatchResults()` runs (the sync `usageMetering` middleware won't see individual batch items). Consumers who need per-item accounting should iterate results and record manually.

- **TS defs**: `BatchRequest`, `BatchHandle`, `BatchStatus`, `BatchItemRequest`, `BatchResult<D>`. Base class extended with `batch`, `getBatch`, `getBatchResults`, `cancelBatch`.

- **15 new tests (517 total)**: argument validation (missing/empty requests, missing customId, missing messages, non-string id), "not supported" error on the base class, Anthropic (unified → Message Batches shape translation with system + maxTokens + model overrides, status normalization ended → completed, results with succeeded + errored, retrieve-before-ended → clear error, cancel), OpenAI-compatible (two-step submit: files then batches, status mapping across all 8 upstream states, retrieve-before-completed → clear error, JSONL parse with success + error entries, cancel POSTs to `/batches/{id}/cancel`).

### Notes

- Additive — `^1.24` consumers bump to `^1.25` with zero code changes. `batch()` is opt-in; nothing changes for callers not using it.
- Anthropic Message Batches (2024-10) and OpenAI Batch API (2024-04) are provider-native features. The unified `BatchRequest` / `BatchHandle` / `BatchResult` shapes make provider-swap painless: your app writes to the unified API, and swapping `cds.requires.llm.kind` between `llm-anthropic` and `llm-openai-compatible` continues to work.
- Batch pricing (per provider docs as of 2026-08): Anthropic ~50% of the equivalent sync `chat()` prices; OpenAI ~50% off. The exact discount varies per model — check the provider's pricing page for the specific model you're batching.
- Batch results delivery is up to the provider's SLA: Anthropic's stated 24h has typically been minutes to hours in practice; OpenAI's varies from minutes to the full window depending on system load.

## [1.24.0] — 2026-08-05

### Added

- **MCP sampling + roots (server-initiated request infrastructure)** — the two remaining spec surfaces the plugin hadn't shipped. Both let a tool handler ask the connected client for something during a `tools/call`:

  - **`ctx.sample({ messages, systemPrompt?, maxTokens?, modelPreferences? })`** → sends `sampling/createMessage` to the client and awaits the client's LLM completion. The agent-loop pattern where a CAP tool (running server-side) reaches back through the transport to have the client (Claude Desktop, Cursor, VS Code Copilot) run its own LLM. The server never touches the client's API keys.
  - **`ctx.getRoots()`** → sends `roots/list` and returns `[{ uri, name? }, ...]`. Server tools discover which filesystem locations the client has granted access to. Cached per-session; `notifications/roots/list_changed` invalidates the cache so the next `ctx.getRoots()` call re-fetches.

  ```js
  const server = new MCPServer({
    name: 'my-cap-tools',
    version: '1.0.0',
    tools: [{
      name: 'summarize_file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      handler: async ({ path }, ctx) => {
        // Client-declared filesystem scope — the tool only reads what the user allowed
        const roots = await ctx.getRoots();
        if (!roots.some((r) => path.startsWith(new URL(r.uri).pathname))) {
          throw new Error(`path outside declared roots: ${path}`);
        }
        const text = await fs.readFile(path, 'utf8');

        // Delegate LLM work back to the client — no server-side API key required
        const reply = await ctx.sample({
          messages: [{ role: 'user', content: { type: 'text', text: `Summarize:\n${text}` } }],
          maxTokens: 200,
        });
        return { summary: reply.content.text };
      },
    }],
  });
  ```

- **`MCPServer.sendRequest(method, params, transportCtx, { timeoutMs? })`** — the underlying primitive. Assigns a unique `srv-<n>` id, writes a JSON-RPC request via `transportCtx.sendMessage`, and awaits the matching response. Correlated by id; `sessionState._pendingRequests` tracks in-flight requests. Times out cleanly (default 60s) with a `timed out after Nms` error. JSON-RPC error responses reject the promise with the error's `message`/`code`/`data`.

- **Response routing in `handleMessage`** — a JSON-RPC response (has `id` + `result`/`error`, no `method`) that arrives at the server is looked up in `_pendingRequests`, timer cleared, and the awaiting promise resolved or rejected. Responses for unknown ids are logged and dropped (no crash).

- **Client capability capture on `initialize`** — the client's declared `capabilities` (including `capabilities.sampling` and `capabilities.roots`) get stashed on `transportCtx.sessionState.clientCapabilities`. `ctx.sample()` and `ctx.getRoots()` gate on the matching capability and throw a specific, actionable error when the client didn't advertise it. Missing `capabilities` on the initialize params defaults to `{}` (still errors on `ctx.sample()`, but the handshake itself never fails).

- **`notifications/roots/list_changed` handler** — clears `sessionState.roots` and `rootsFetchedAt` so the next `ctx.getRoots()` re-fetches. Safe pre-init (no session state yet) — no-ops without crashing.

- **`transportCtx.sendMessage` on every transport**. The wire-level writer, symmetric with the existing `sendNotification`. Kept as separate names because both write to the same channel today but consumers may want to future-swap them independently.
  - **stdio**: writes JSON-RPC envelope + newline to `stdout`, same channel as tool call replies (line-delimited).
  - **HTTP+SSE (2024-11-05)**: `data: <json>\n\n` on the session's SSE stream — the same fan-out path as progress notifications.
  - **Streamable HTTP (2025-03-26)**: fans out across every open GET stream on the session (typically 1). No open GET stream → `ctx.sample()` / `ctx.getRoots()` will time out, which is the correct signal.

- **15 new tests (502 total)**: `sendRequest` (missing sendMessage → clear error, id-correlation + resolve, error response → reject, timeout → reject, response for unknown id → drop + warn, response routing frees the pending entry), `initialize` capability capture (stash + default), `ctx.sample()` (happy path via mock scripted client, capability missing → helpful error, transport missing → helpful error), `ctx.getRoots()` (fetch + cache once, `notifications/roots/list_changed` invalidates cache + re-fetch, capability missing → helpful error), pre-init `notifications/roots/list_changed` (safe no-op).

### Notes

- Additive — `^1.23` consumers bump to `^1.24` with zero code changes. Tool handlers that don't reach for `ctx.sample()` or `ctx.getRoots()` are unaffected; those that do get graceful capability-gated errors on clients that don't support them, so tools can fall back to a local LLM instead of failing outright.
- `sampling/createMessage` and `roots/list` are inherently bidirectional — they require the client to be listening for server-initiated requests. Every transport shipped in this plugin (stdio, HTTP+SSE, Streamable HTTP) meets that requirement, but any custom transport authors add MUST expose `transportCtx.sendMessage(msg)` or `ctx.sample()` / `ctx.getRoots()` will throw a clear error mentioning it.
- The client's `sampling/createMessage` response uses the client's own LLM — the server does not know or care which model that is. `reply.model` in the sampling response identifies it; `reply.content` is the completion; `reply.stopReason` matches the shape you'd get from `LLMService.chat()`.
- Timeouts default to 60s. Bidirectional MCP calls that expect a fast client-side model can pass `{ timeoutMs: 5000 }` to `sendRequest` explicitly.

## [1.23.0] — 2026-08-05

### Added

- **Three new OpenAI-compatible provider kinds** — light subclasses of `OpenAICompatibleLLMService` (same shape as `llm-groq`). Each inherits full chat + streaming + tools + vision + structured-outputs + embed support from the base class; the subclass only pins the base URL, env var name, and default model.

  ```jsonc
  // cds.requires.llm
  { "kind": "llm-fireworks",
    "modelId": "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "credentials": { "apiKey": "..." } }
  { "kind": "llm-deepseek", "modelId": "deepseek-chat",
    "credentials": { "apiKey": "..." } }
  { "kind": "llm-mistral",  "modelId": "mistral-large-latest",
    "credentials": { "apiKey": "..." } }
  ```

  | Kind | Default base URL | Env var | Default model |
  |---|---|---|---|
  | `llm-fireworks` | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
  | `llm-deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-chat` (V3; use `deepseek-reasoner` for R1) |
  | `llm-mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `mistral-large-latest` (or `codestral-latest`, `mistral-embed`) |

- **CLI support**: `--provider fireworks|deepseek|mistral` on `chat` / `stream` / `embed` / `verify`. `saptarishi-llm init <dir> --provider fireworks|deepseek|mistral` scaffolds a CAP app pre-wired to any of the three with the right env-var template. `providers` and the MCP `list_providers` tool + `config://supported-providers` resource now enumerate 11 kinds (was 8 in 1.19.0).

- **Pricing entries** in `DEFAULT_PRICING` covering all three default models plus their common alternates — Fireworks Llama-3.3/3.1/Qwen/Mixtral/DeepSeek-V3 + nomic embed, DeepSeek-chat + DeepSeek-reasoner, Mistral Large + Small + Codestral + mistral-embed. `usageMetering` picks these up automatically; contract discounts can override per model.

- **TS defs**: `FireworksLLMService`, `DeepSeekLLMService`, `MistralLLMService` classes exported from `lib/index.d.ts` with `@since 1.23.0`.

- **30 new tests (487 total)**: per-provider — extends `OpenAICompatibleLLMService`, default baseUrl, default modelId, caller override wins, env-var pickup, missing-key error, `POST /chat/completions` with `Bearer` auth. CLI factory integration for all three + `--base-url` override propagation. `DEFAULT_PRICING` coverage check. Adjusted 5 pre-existing tests that hard-coded `supported.length: 8` and the sorted provider-kind list (now 11).

### Notes

- Additive — every existing kind (`llm-anthropic`, `llm-ollama`, `llm-groq`, `llm-openai-compatible`, `llm-azure-openai`, `llm-gemini`, `llm-bedrock`, `llm-genai-hub`) is unchanged. `^1.22` consumers bump to `^1.23` with zero code changes.
- No new required dependencies. All three providers speak the OpenAI shape so no SDKs are pulled in — same fetch path as `llm-groq`.
- Pricing values in `DEFAULT_PRICING` are ballpark rates as of 2026-08-05 from each provider's public pricing page. Override in `usageMetering({ pricing: {...} })` if you have a contract rate.

## [1.22.0] — 2026-08-04

### Added

- **Canonical `LlmUsage` CDS entity + `usageMeteringToCap` auto-persist wrapper.** The 1.21.0 metering middleware exposed an in-memory summary and a `onRecord` sink hook; this release adds the "obvious next step" — a shipped CDS entity you can import into your model and a one-line wrapper that INSERTs every metering record into it. Result: LLM cost accounting persisted to HANA (or SQLite in dev), queryable via OData, with zero glue code.

  ```cds
  // srv/finance-service.cds
  using { saptarishi.llm.usage.LlmUsage } from '@saptarishi/cds-plugin-llm/lib/usageEntity';
  service FinanceService @(path: '/finance') {
    entity LlmSpend as projection on LlmUsage;
  }
  ```

  ```js
  // srv/handlers.js
  const cds = require('@sap/cds');
  const { usageMeteringToCap } = require('@saptarishi/cds-plugin-llm');
  const llm = await cds.connect.to('llm');
  llm.use(usageMeteringToCap(cds, {
    tenantOf:   (ctx) => ctx.raw?.tenant ?? cds.context?.tenant,
    providerOf: (ctx) => ctx.raw?.providerAlias,
  }));
  ```

  Now `GET /finance/LlmSpend?$filter=tenant eq 'acme'&$orderby=timestamp desc` returns every LLM call charged to Acme with model, tokens, and cost breakdown. Fits directly into a Fiori cost dashboard.

- **`lib/usageEntity.cds`** — the shipped entity. Columns: `ID` (UUID), `timestamp`, `provider`, `model`, `tenant`, `method`, `inputTokens`, `outputTokens`, `inputCost`, `outputCost`, `totalCost`, `currency`, `pricingKnown`. Bring your own entity name via `entity: 'MyApp.Finance.LlmSpend'` on the wrapper — the middleware only needs a superset of these columns, so consumers can extend the entity with cost centers, correlation ids, region flags, etc.

- **`usageMeteringToCap(cds, options)`** — wrapper around `usageMetering` that installs an `onRecord` handler doing `cds.run(INSERT.into(entity).entries(...))`. Delegates aggregation, `summary()`, and `byModel` / `byTenant` / `byProvider` / `reset()` / `asMcpResource()` to the base middleware unchanged. `onError` hook receives `(err, record)` on persist failures; defaults to `cds.log('llm:usage').warn(...)`. Persist errors NEVER propagate to the request path — same policy as 1.21.0.

- **Robust INSERT resolution.** The wrapper walks `cds.ql.INSERT` → `cds.INSERT` → `global.INSERT` at first call, so it works across CAP versions where the builder lives in different places. Missing entirely → a clear one-time warn (still doesn't block the request).

- **UUID sourcing**: prefers `cds.utils.uuid()` when present, falls back to `crypto.randomUUID()`. No behavioral difference in CAP apps; the fallback is for embedded/test scenarios.

- **Ignores `options.onRecord`** with a warning — since the wrapper installs its own persister, passing a custom sink would silently no-op the persistence. Consumers who want a custom sink call `usageMetering()` directly.

- Exports: `usageMeteringToCap`, `DEFAULT_LLM_USAGE_ENTITY` (the string `'saptarishi.llm.usage.LlmUsage'`).

- **14 new tests (457 total)**: constructor validation (bad cds arg), default entity persist path (record shape + cost math + INSERT payload), custom entity name, `cds.utils.uuid` preference + `crypto.randomUUID` fallback, INSERT-lookup fallbacks (`cds.ql.INSERT` → `cds.INSERT` → `global.INSERT` → clear warn if missing), persist-error swallowing + warn logging + `onError` hook (including onError-throws-too case), `onRecord` warning when caller supplies one, end-to-end aggregation surface still works (summary + byTenant + reset), user-supplied currency + pricing passed through to persisted rows.

### Notes

- Additive — `^1.21` consumers bump to `^1.22` with zero code changes. `usageMeteringToCap` is opt-in via `llm.use(...)`; nothing changes for callers still using `usageMetering()` directly.
- The wrapper is 100% composition — `require('./middleware/usageMetering').usageMetering` with an `onRecord` slotted in. If you want custom persistence (batching, cross-tenancy sinks, warehouse export), stay on `usageMetering()` and write your own `onRecord`.
- The shipped `LlmUsage` entity is versioned in `lib/usageEntity.cds`. Consumers who import it directly get whatever version they installed; those who copied it into their own model won't be affected by future column additions.

## [1.21.0] — 2026-08-04

### Added

- **`usageMetering` middleware — per-request token + dollar accounting for every provider.** Attach via `llm.use(meter)` and the plugin automatically records tokens, cost, and provenance for every `chat` / `stream` / `embed` request. Zero-config once attached; the built-in pricing table covers the major shipped models (Anthropic, OpenAI, Gemini, Groq, Bedrock, Cohere).

  ```js
  const { usageMetering } = require('@saptarishi/cds-plugin-llm');

  const meter = usageMetering({
    // sensible defaults ship in lib/pricing.js — only list overrides:
    pricing: { 'claude-opus-4-7': { input: 12, output: 60 } },  // contract discount
    currency: 'USD',
    tenantOf:   (ctx) => ctx.raw?.tenant,
    providerOf: (ctx) => ctx.raw?.providerAlias,
    onRecord:   async (r) => await INSERT.into(LlmUsage).entries(r),
  });
  llm.use(meter);

  // Later:
  meter.summary();                // { totalCost, byModel, byTenant, byProvider, ... }
  meter.byTenant('acme');         // { requests, inputTokens, outputTokens, cost }
  meter.reset();                  // zero everything
  ```

- **Default pricing table (`DEFAULT_PRICING`, `lib/pricing.js`).** Ships ballpark USD prices per 1M tokens for ~30 shipped models across Anthropic (direct + Bedrock), OpenAI (chat + embeddings + o-series), Gemini, Groq, Bedrock (Nova, Llama, Mistral, Titan embed, Cohere embed), and Ollama (local, $0). Merge your own overrides via `usageMetering({ pricing: {...} })` — only listed models are overridden; everything else falls through to defaults. Unknown models cost $0 but still appear in `byModel` so consumers can spot missing pricing entries.

- **`asMcpResource()` helper on the middleware.** Returns a ready-to-register MCP resource that exposes the live summary at `config://usage`:

  ```js
  new MCPServer({
    resources: [meter.asMcpResource(), ...otherResources],
    tools: [...],
  });
  ```

  Clients can `resources/read` at any time to see totals + per-model + per-tenant breakdown. `/mcp` streaming clients (Claude Desktop, Cursor) can bind this to a live cost dashboard.

- **Configurable `pricingUnit`** for contracts denominated per-1K tokens rather than per-1M (default 1_000_000). Set `pricingUnit: 1000` and quote your pricing table in per-1K rates.

- **Fire-and-forget `onRecord` sink** for external persistence — CAP entity inserts, warehouse pushes, Prometheus counters. Runs after in-memory aggregation completes; the request path is never blocked on it. Errors are silently swallowed to protect the request path — consumers who need durability should await their own writes inside.

- **Embed cost approximation.** Since most providers don't return token counts on the embeddings endpoint, the middleware approximates input tokens from the string length (~4 chars/token). Consumers who need precision should hook `onRecord` and swap in a real tokenizer (`tiktoken`) inside.

- **`ctx.raw` on the middleware context (additive).** Every `chat` / `stream` / `embed` call now exposes the original, untouched request object to middleware via `ctx.raw`. `ctx.request` remains the merged/normalized shape as before. Middleware needing arbitrary fields the caller supplied (`tenant`, `correlationId`, `providerAlias`, ...) reads them from `ctx.raw` rather than the stripped `ctx.request`. Fully backwards-compatible — existing middleware that ignores `ctx.raw` behaves exactly as in 1.20.

- **TS defs**: `UsageMeteringOptions`, `UsageMeteringMiddleware`, `UsageSummary`, `UsageBucket`, `UsageRecord`, `ModelPricing`, `DEFAULT_PRICING`. `MiddlewareContext.raw?: any` added.

- **21 new tests (443 total)**: DEFAULT_PRICING lookup + user overrides + fall-through, unknown-model handling, response-without-usage skip, tenant + provider partitioning, currency label preservation, `pricingUnit=1000` custom-scale contracts, stream done-chunk accounting + chunk pass-through, embed approximation with array inputs, `onRecord` sink (basic delivery + `pricingKnown` flag + error swallowing), `reset()` zeroes + preserves currency + accepts new writes, `summary()` returns immutable deep clone, `asMcpResource()` shape, and a sanity check that every shipped provider's default model has a pricing entry.

### Notes

- Additive — `^1.20` consumers bump to `^1.21` with zero code changes. `usageMetering` is opt-in via `llm.use(...)`; nothing changes for callers that don't attach it.
- Pricing entries in `DEFAULT_PRICING` are ballpark rates as of 2026-08-04. Provider prices change frequently; always override with your contract rates for any model where accuracy matters. Missing models silently cost $0 — not a fatal error, but visible in `byModel` for spotting.
- The middleware holds counters in-memory. For multi-process deployments (CF, Kyma, K8s), each replica has its own summary. Consumers who want cross-replica aggregation should use `onRecord` to push into a shared store (CAP entity backed by SQLite/HANA, Redis counter, Prometheus scrape, etc.).

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
