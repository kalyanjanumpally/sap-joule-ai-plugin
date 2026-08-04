// Type definitions for @saptarishi/cds-plugin-llm
// Public API surface only — internal utilities (withRetry, RetryableError,
// throwFromResponse) are not re-exported and intentionally not typed here.

// ---------------------------------------------------------------------------
// JSON schema — minimal shape the plugin actually forwards to providers
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Content blocks (Anthropic-shaped, unified across providers)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageUrlSource {
  type: 'url';
  url: string;
}

export interface ImageBase64Source {
  type: 'base64';
  /** e.g. 'image/png', 'image/jpeg' */
  media_type: string;
  data: string;
}

export interface ImageBlock {
  type: 'image';
  source: ImageUrlSource | ImageBase64Source;
}

export interface DocumentUrlSource {
  type: 'url';
  url: string;
}

export interface DocumentBase64Source {
  type: 'base64';
  /** 'application/pdf' */
  media_type: string;
  data: string;
}

/** Refers to a file previously uploaded via OpenAI's Files API (v1.14.0+). */
export interface DocumentFileIdSource {
  type: 'file_id';
  file_id: string;
  /** Informational — 'application/pdf' for uploadPdfFromUrl results. */
  mediaType?: string;
}

export interface DocumentBlock {
  type: 'document';
  source: DocumentUrlSource | DocumentBase64Source | DocumentFileIdSource;
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface Tool {
  name: string;
  description?: string;
  /** Preferred (Anthropic naming) */
  input_schema?: JsonSchema;
  /** Alias accepted for OpenAI-style tool declarations */
  parameters?: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: 'assistant';
  content?: string | ContentBlock[] | null;
  /** Set when replaying a prior turn that called tools */
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: 'tool' | 'tool_result';
  /** OpenAI naming */
  tool_call_id?: string;
  /** Anthropic naming */
  tool_use_id?: string;
  content: string | ContentBlock[];
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Chat request/response
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Default 3 */
  max?: number;
  /** Default 500 */
  baseMs?: number;
  /** Default 20000 */
  maxMs?: number;
}

export type ThinkingConfig =
  | { type: 'adaptive'; [k: string]: unknown }
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens?: number; [k: string]: unknown }
  | false;

export interface ChatRequest {
  messages: Message[];
  system?: string;
  /** Overrides the modelId configured on the provider instance */
  model?: string;
  /** Default 16000 */
  maxTokens?: number;
  /** Enables tool/function calling */
  tools?: Tool[];
  /** JSON schema for structured output; plugin parses response.text into response.data */
  format?: JsonSchema;
  /** Anthropic-only: pass through to the SDK. Default { type: 'adaptive' } on Anthropic. */
  thinking?: ThinkingConfig;
  /** Anthropic-only: sets cache_control on the system prompt */
  cache?: boolean;
  /** Per-call retry override */
  retries?: RetryOptions;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ChatResponse<D = unknown> {
  /** Concatenated text from all text content blocks */
  text: string;
  /** Populated when `format` was set on the request and the response was valid JSON */
  data?: D;
  /** Populated when the model called one or more tools */
  toolCalls?: ToolCall[];
  /** Provider-native response object — shape varies by provider */
  raw: unknown;
  usage: Usage;
  /** 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'refusal' | provider-specific */
  stopReason?: string;
  model?: string;
  /** True when the response was served from the responseCache */
  cached?: boolean;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface TextDeltaChunk {
  type: 'text_delta';
  text: string;
}

export interface DoneChunk {
  type: 'done';
  /** Accumulated text from the whole stream */
  text: string;
  usage: Usage;
  stopReason?: string;
  model?: string;
}

export type StreamChunk = TextDeltaChunk | DoneChunk;

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  input: string | string[];
  model?: string;
}

export interface EmbedResponse {
  embeddings: number[][];
  model?: string;
}

// ---------------------------------------------------------------------------
// Provider options (values you put under cds.requires.<name>)
// ---------------------------------------------------------------------------

export interface ProviderOptions {
  kind?: string;
  /** Default model to use when a request doesn't specify one */
  modelId?: string;
  /** Alias for modelId, kept for older configs */
  model?: string;
  maxTokens?: number;
  retries?: RetryOptions;
  /**
   * Enable an in-memory response cache for chat() calls.
   * true = default config (5min TTL, 100 entries). Object = custom.
   * Distinct from the per-request `cache: true` option (which controls
   * Anthropic's provider-side prompt caching).
   */
  responseCache?: boolean | { ttlMs?: number; maxEntries?: number };
  credentials?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Base + provider classes
// ---------------------------------------------------------------------------

/**
 * Middleware context object passed to every middleware function.
 * `method` tells you which public API triggered the chain.
 * `request` is mutable — modify it before calling next() to affect the provider call.
 * `meta` is a scratchpad for cross-middleware state (e.g. timing marks).
 */
export interface MiddlewareContext {
  method: 'chat' | 'stream' | 'embed';
  /** Merged, provider-ready request (defaults applied, unknown fields stripped). */
  request: any;
  /**
   * The original, untouched request the caller passed in. Middleware that
   * needs fields we don't merge into `request` (tenant id, correlation id,
   * request-scoped provider alias, ...) should read them from here. Present
   * on every call since 1.21.0.
   */
  raw?: any;
  meta: Record<string, any>;
}

/**
 * Middleware signature (Koa-style compose):
 *   async (ctx, next) => {
 *     // before: inspect / modify ctx.request
 *     const result = await next();       // -> chat: ChatResponse, embed: EmbedResponse,
 *                                        //    stream: AsyncIterable<StreamChunk>
 *     // after: inspect / modify result before returning
 *     return result;
 *   }
 * Middleware may short-circuit by returning without calling next().
 * For streams, wrap the returned iterable to observe/transform chunks.
 */
export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<any>,
) => Promise<any>;

/**
 * Abstract LLM service. All providers extend this.
 * Not intended to be instantiated directly; use one of the provider subclasses,
 * or connect via `cds.connect.to('llm')` in a CAP app.
 */
export class LLMService {
  constructor(name: string, model: unknown, options?: ProviderOptions);
  modelId?: string;
  defaultMaxTokens: number;
  middleware: Middleware[];
  init(): Promise<void>;
  /** Register a middleware. Returns `this` for chaining. */
  use(middleware: Middleware): this;
  chat<D = unknown>(req: ChatRequest): Promise<ChatResponse<D>>;
  stream(req: ChatRequest): AsyncGenerator<StreamChunk, void, void>;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

export class AnthropicLLMService extends LLMService {
  apiKey: string;
}

export class OllamaLLMService extends LLMService {
  baseUrl: string;
}

export class OpenAICompatibleLLMService extends LLMService {
  baseUrl: string;
  apiKey: string;
}

export class GroqLLMService extends OpenAICompatibleLLMService {}

/**
 * Azure OpenAI provider. Same request/response shapes as OpenAI, but URL
 * scheme is per-deployment and auth is `api-key` header (not Bearer).
 * Configure via `credentials.{endpoint, apiKey, deployment, embeddingDeployment?, apiVersion?}`.
 * @since 1.15.0
 */
export class AzureOpenAILLMService extends OpenAICompatibleLLMService {
  endpoint: string;
  deployment: string;
  embeddingDeployment: string;
  apiVersion: string;
}

export class GenAIHubLLMService extends OpenAICompatibleLLMService {
  aiCoreUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  deploymentId: string;
  resourceGroup: string;
}

/**
 * Google Gemini provider — calls the Google AI Studio API directly via fetch.
 * Configure via `credentials.{apiKey, baseUrl?, embeddingModel?}` or the
 * `GOOGLE_API_KEY` / `GEMINI_API_KEY` env vars.
 * @since 1.19.0
 */
export class GeminiLLMService extends LLMService {
  baseUrl: string;
  apiKey: string;
  embeddingModel: string;
}

/**
 * AWS Bedrock provider — uses the Converse API for chat + streaming and
 * InvokeModel for embeddings (Titan v2 / Cohere). Requires the optional peer
 * dependency `@aws-sdk/client-bedrock-runtime`. Configure via
 * `credentials.{region, accessKeyId?, secretAccessKey?, sessionToken?, embeddingModel?}`
 * or the standard AWS env vars.
 * @since 1.19.0
 */
export class BedrockLLMService extends LLMService {
  region: string;
  embeddingModel: string;
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/**
 * Load an image from disk, base64-encode, auto-detect media type from extension.
 * Supported: .png, .jpg, .jpeg, .gif, .webp
 */
export function imageFromFile(filePath: string): Promise<ImageBlock>;

/**
 * Wrap a URL as an image block. Works with Anthropic and OpenAI-compat providers.
 * Ollama does not accept URLs — use `imageFromFile` or `imageFromBase64` instead.
 */
export function imageFromUrl(url: string): ImageBlock;

/**
 * Wrap raw base64 image data as an image block.
 * @param base64Data - Base64-encoded image bytes (no data-URL prefix)
 * @param mediaType - e.g. 'image/png' (default), 'image/jpeg', 'image/gif', 'image/webp'
 */
export function imageFromBase64(base64Data: string, mediaType?: string): ImageBlock;

/**
 * Load a PDF from disk and return a plugin-shape document block.
 * PDF support requires an Anthropic provider (Claude 3.5+); other providers
 * will throw when they see a document block.
 */
export function pdfFromFile(filePath: string): Promise<DocumentBlock>;

/**
 * Reference a remote PDF by URL. Anthropic-only.
 */
export function pdfFromUrl(url: string): DocumentBlock;

/**
 * Wrap raw base64 PDF bytes into a plugin-shape document block. Anthropic-only.
 */
export function pdfFromBase64(base64Data: string): DocumentBlock;

/**
 * Fetch a PDF from `url`, upload to the OpenAI Files API at `<baseUrl>/files`,
 * and return a plugin-shape document block referencing the returned `file_id`.
 * Pass the block into any OpenAI-compatible chat request the same way you'd
 * pass a base64 PDF. Requires an endpoint that speaks OpenAI's Files API
 * (real OpenAI, Azure OpenAI — not Groq / DeepSeek / etc.).
 * @since 1.14.0
 */
export function uploadPdfFromUrl(url: string, options: {
  apiKey: string;
  baseUrl?: string;
  purpose?: 'user_data' | 'assistants' | 'batch' | 'fine-tune';
  filename?: string;
  fetchHeaders?: Record<string, string>;
}): Promise<DocumentBlock>;

/**
 * A verifier for `createHttpTransport({ authTokenVerifier })`. Given a
 * bearer token string, returns the token's claims (any truthy value) if
 * valid, or null/false if invalid. May throw — the transport will treat
 * a throw as a rejection.
 * @since 1.16.0
 */
export type AuthTokenVerifier = (token: string) => Promise<unknown | null>;

/**
 * Build an `authTokenVerifier` that validates JWTs against a remote JWKS
 * endpoint. Standard OAuth2 / OIDC path — works with SAP XSUAA, Auth0,
 * Okta, Azure AD, Google, Keycloak, AWS Cognito, etc.
 *
 * Requires `jose` as a peer dep — install with `npm install jose`.
 *
 *   const verifier = createJwtVerifier({
 *     jwksUrl:  'https://tenant.authentication.us10.hana.ondemand.com/token_keys',
 *     issuer:   'https://tenant.authentication.us10.hana.ondemand.com',
 *     audience: 'sb-my-cap-app!t12345',
 *   });
 *   createHttpTransport({ server, authTokenVerifier: verifier });
 * @since 1.16.0
 */
export function createJwtVerifier(options: {
  jwksUrl: string;
  issuer?: string;
  audience?: string;
}): AuthTokenVerifier;

// ---------------------------------------------------------------------------
// MCP HTTP transports (Streamable HTTP added in 1.20.0)
// ---------------------------------------------------------------------------

/** Loose type — see `lib/mcp/server.js` for the full MCPServer surface. */
export interface MCPServerLike {
  name: string;
  version: string;
  handleMessage(msg: unknown, ctx?: unknown): Promise<unknown>;
  addSubscriber(fn: (notif: unknown) => void): { subscriptions: Set<string> } & (() => void);
}

export interface TransportHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface CreateHttpTransportOptions {
  server: MCPServerLike;
  port?: number;
  host?: string;
  logger?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Static bearer token (constant-time comparison). Mutually exclusive with `authTokenVerifier`. */
  authToken?: string | null;
  /** Custom async token verifier (e.g. JWT + JWKS). Returns claims for accept, null/false for reject. */
  authTokenVerifier?: AuthTokenVerifier | null;
}

/**
 * MCP HTTP+SSE transport (spec 2024-11-05). Exposes an MCPServer on
 *   GET  /sse            — server-to-client event stream
 *   POST /messages       — client-to-server JSON-RPC
 * Kept for back-compat with older MCP clients.
 * @since 1.10.0
 */
export function createHttpTransport(options: CreateHttpTransportOptions): Promise<TransportHandle>;

export interface CreateStreamableHttpTransportOptions extends CreateHttpTransportOptions {
  /** Endpoint path. Default '/mcp'. */
  path?: string;
  /**
   * Whitelist of `Origin` headers to accept. Spec-recommended DNS-rebinding
   * protection. null / [] means accept any origin (dev-friendly default).
   */
  allowedOrigins?: string[] | null;
}

/**
 * MCP Streamable HTTP transport (spec 2025-03-26). One endpoint speaks the
 * whole protocol:
 *   POST   /mcp    — client-to-server JSON-RPC. Server assigns Mcp-Session-Id
 *                    on the first request and echoes it in subsequent
 *                    responses. Notifications (no id) return 202 + no body;
 *                    requests return 200 application/json.
 *   GET    /mcp    — optional long-lived SSE stream for server-initiated
 *                    notifications (list_changed, progress) on this session.
 *   DELETE /mcp    — explicit session termination.
 * Supported by Claude Desktop, Cursor, VS Code Copilot, and other modern
 * MCP clients.
 * @since 1.20.0
 */
export function createStreamableHttpTransport(
  options: CreateStreamableHttpTransportOptions,
): Promise<TransportHandle>;

// ---------------------------------------------------------------------------
// Tool runner — automatic multi-turn agent loop (new in v1.1.0)
// ---------------------------------------------------------------------------

/** Tool passed to runTools — same as Tool but with a `run` function attached. */
export interface RunnableTool extends Tool {
  /** Called with the model's tool_use `input`. Return anything JSON-serializable. */
  run(input: any): Promise<unknown> | unknown;
}

export interface RunToolsOptions {
  llm: LLMService;
  messages: Message[];
  tools: RunnableTool[];
  system?: string;
  /** Safety cap; throws if the model keeps calling tools past this many turns. Default 10. */
  maxSteps?: number;
  /** Optional callback fired after every chat() call. */
  onStep?: (info: { step: number; response: ChatResponse }) => void | Promise<void>;
  /** Any other chat-request options (model, maxTokens, format, thinking, cache, retries) */
  [key: string]: unknown;
}

export interface ExecutedToolCall {
  id: string;
  name: string;
  input: unknown;
  /** JSON-stringified tool result (or the string message for errors) */
  result: string;
  /** True when the tool threw or the name didn't match any registered tool */
  isError: boolean;
}

export interface RunToolsResult {
  /** Final assistant text after the loop terminates */
  text: string;
  /** Full message history: input + every assistant/tool turn */
  messages: Message[];
  /** Aggregated token totals across every chat() call the runner made */
  usage: Usage;
  /** Number of chat() calls the runner made */
  steps: number;
  /** Every tool call executed, with input + result + isError */
  toolCalls: ExecutedToolCall[];
  model?: string;
  stopReason?: string;
}

/**
 * Automatic multi-turn tool-use loop. Handles the chat -> execute-tools ->
 * append-results -> chat cycle until the model stops calling tools.
 *
 *   const result = await runTools({
 *     llm,
 *     messages: [{ role: 'user', content: 'Fetch PO 4500000123 and summarize' }],
 *     tools: [{
 *       name: 'get_purchase_order',
 *       description: 'Fetch a PO',
 *       input_schema: { type: 'object', properties: { purchaseOrderId: { type: 'string' } } },
 *       run: async ({ purchaseOrderId }) => await SELECT.one.from('POs').where({ ID: purchaseOrderId }),
 *     }],
 *     maxSteps: 10,
 *   });
 *   console.log(result.text);  // final assistant answer
 */
export function runTools(options: RunToolsOptions): Promise<RunToolsResult>;

// ---------------------------------------------------------------------------
// Built-in middleware helpers (new in v1.3.0)
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** Burst allowance — max tokens the bucket can hold. */
  capacity: number;
  /** Steady-state refill rate. */
  refillPerSecond: number;
  /**
   * Derives a bucket key from the request context. Buckets are per-key,
   * so different keys have independent limits. Default: always 'global'.
   */
  keyFn?: (ctx: MiddlewareContext) => string;
  /**
   * 'throw' (default) throws an error with `code: 'RATE_LIMITED'` and
   * `retryAfterMs` when the bucket is empty. 'wait' pauses the request
   * until a token is available.
   */
  mode?: 'throw' | 'wait';
}

/**
 * Token-bucket rate-limit middleware. In-process only — for multi-instance
 * apps, back with Redis via your own middleware.
 *
 *   llm.use(rateLimit({ capacity: 60, refillPerSecond: 1 }));
 */
export function rateLimit(options: RateLimitOptions): Middleware;

/** Minimal duck-typed OpenTelemetry span used by the otel middleware. */
export interface OtelSpanLike {
  setAttribute?(key: string, value: unknown): void;
  recordException?(err: unknown): void;
  setStatus?(status: { code: number; message?: string }): void;
  end?(): void;
}

/** Minimal duck-typed OpenTelemetry tracer used by the otel middleware. */
export interface OtelTracerLike {
  startSpan(name: string): OtelSpanLike;
}

export interface OtelOptions {
  /** OTel tracer (e.g. `trace.getTracer('cap-app')`). */
  tracer: OtelTracerLike;
  /** Span name prefix. Default: 'llm.'. Resulting spans: 'llm.chat', 'llm.stream', 'llm.embed'. */
  spanNamePrefix?: string;
  /** Value for the `gen_ai.system` attribute (e.g. 'anthropic', 'ollama'). */
  systemAttribute?: string;
}

/**
 * OpenTelemetry middleware. Duck-typed against @opentelemetry/api so no
 * hard dependency. Span attributes follow the GenAI semantic conventions
 * where possible (`gen_ai.system`, `gen_ai.usage.*`, etc.).
 */
export function otel(options: OtelOptions): Middleware;

/**
 * Minimal duck-typed Redis client. `ioredis` and `node-redis` (v4+ with
 * `.eval` promise API) both satisfy this shape.
 */
export interface RedisClientLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisRateLimitOptions {
  /** Redis client (ioredis or node-redis v4+). */
  redis: RedisClientLike;
  /** Burst allowance — max tokens the bucket can hold. */
  capacity: number;
  /** Steady-state refill rate. */
  refillPerSecond: number;
  /** Bucket key derivation. Default: always 'global'. */
  keyFn?: (ctx: MiddlewareContext) => string;
  /** Redis key prefix. Default: 'saptarishi:llm:rl:'. */
  keyPrefix?: string;
  /** 'throw' (default) or 'wait'. Same semantics as `rateLimit`. */
  mode?: 'throw' | 'wait';
}

/**
 * Redis-backed token-bucket rate-limit middleware. Uses an atomic Lua
 * EVAL so concurrent CF instances cannot race. Safe for multi-instance
 * deployments — the bucket is shared across every process pointed at
 * the same Redis. See `rateLimit` for the in-process variant.
 */
export function redisRateLimit(options: RedisRateLimitOptions): Middleware;

// ---------------------------------------------------------------------------
// Usage metering middleware (new in v1.21.0)
// ---------------------------------------------------------------------------

/**
 * Per-model pricing: cost in the configured currency per `pricingUnit`
 * tokens (default 1,000,000). `input` covers prompt tokens, `output`
 * covers completion tokens; embedding-only models set `output: 0`.
 */
export interface ModelPricing {
  input: number;
  output: number;
}

/** Default pricing table shipped in `lib/pricing.js`. Merge with your own overrides via `usageMetering({ pricing: ... })`. */
export const DEFAULT_PRICING: Record<string, ModelPricing>;

export interface UsageBucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  currency: string;
  byModel:    Record<string, UsageBucket>;
  byTenant:   Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
}

export interface UsageRecord {
  timestamp: string;                     // ISO-8601
  provider:  string | null;
  model:     string;
  tenant:    string | null;
  method:    'chat' | 'stream' | 'embed';
  inputTokens:  number;
  outputTokens: number;
  inputCost:    number;
  outputCost:   number;
  totalCost:    number;
  currency:     string;
  pricingKnown: boolean;                 // false when the model isn't in the price table
}

export interface UsageMeteringOptions {
  /** Per-model prices — merged over `DEFAULT_PRICING`. Only list overrides. */
  pricing?: Record<string, ModelPricing>;
  /** ISO-4217 (or free-form) currency label. Default 'USD'. */
  currency?: string;
  /** Extract a tenant/customer id from the request context. */
  tenantOf?: (ctx: MiddlewareContext) => string | null | undefined;
  /** Extract a provider label (e.g. cds.services alias) from the request context. */
  providerOf?: (ctx: MiddlewareContext) => string | null | undefined;
  /**
   * Optional async sink for persistence (CAP entity insert, warehouse push,
   * Prometheus counter, ...). Fired fire-and-forget after in-memory
   * aggregation; the request path is never blocked on it. Consumers who
   * need durability should await their own writes inside.
   */
  onRecord?: (record: UsageRecord) => void | Promise<void>;
  /** How many tokens the price table is denominated in. Default 1_000_000. */
  pricingUnit?: number;
}

export interface UsageMeteringMiddleware extends Middleware {
  summary(): UsageSummary;
  byModel(modelId: string): UsageBucket | null;
  byTenant(tenantId: string): UsageBucket | null;
  byProvider(providerId: string): UsageBucket | null;
  reset(): void;
  /**
   * Ready-to-register MCP resource that returns the summary as JSON.
   * Drop into `new MCPServer({ resources: [meter.asMcpResource(), ...] })`.
   */
  asMcpResource(): {
    uri: 'config://usage';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => UsageSummary;
  };
}

/**
 * Wrap `llm.chat` / `llm.stream` / `llm.embed` with token + cost accounting.
 * Zero cost when the model's usage numbers aren't reported by the provider,
 * but the request is still counted. Unknown models cost $0 but appear in
 * `byModel` so you can spot missing pricing entries.
 * @since 1.21.0
 */
export function usageMetering(options?: UsageMeteringOptions): UsageMeteringMiddleware;

export interface UsageMeteringToCapOptions extends Omit<UsageMeteringOptions, 'onRecord'> {
  /**
   * Fully qualified entity name to INSERT into. Default:
   * `'saptarishi.llm.usage.LlmUsage'` — matches the shipped
   * `lib/usageEntity.cds`. Bring your own entity with a superset of these
   * fields to add tenancy columns, per-team cost centers, etc.
   */
  entity?: string;
  /** Optional error hook called when a persist fails. Default: logs a warn. */
  onError?: (err: Error, record: UsageRecord) => void | Promise<void>;
}

/**
 * Wraps `usageMetering` with an `onRecord` handler that INSERTs each record
 * into a CAP entity via `cds.run(INSERT.into(entity).entries(...))`. The
 * canonical entity definition ships at `lib/usageEntity.cds` — import via
 * `using { LlmUsage } from '@saptarishi/cds-plugin-llm/lib/usageEntity';`
 * and project it into your OData service.
 *
 * The wrapper delegates aggregation + `summary()` to `usageMetering`; the
 * only added behavior is fire-and-forget persistence. Errors are swallowed
 * (logged via `cds.log('llm:usage').warn`) so the request path is never
 * blocked by a database hiccup.
 *
 *   const cds = require('@sap/cds');
 *   const { usageMeteringToCap } = require('@saptarishi/cds-plugin-llm');
 *   llm.use(usageMeteringToCap(cds, {
 *     tenantOf:   (ctx) => ctx.raw?.tenant,
 *     providerOf: (ctx) => ctx.raw?.providerAlias,
 *   }));
 *
 * @since 1.22.0
 */
export function usageMeteringToCap(cds: unknown, options?: UsageMeteringToCapOptions): UsageMeteringMiddleware;

/** Default entity name — matches `saptarishi.llm.usage.LlmUsage` in `lib/usageEntity.cds`. */
export const DEFAULT_LLM_USAGE_ENTITY: string;

// ---------------------------------------------------------------------------
// Prompt-template registry (new in v1.8.0)
// ---------------------------------------------------------------------------

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * Return value of a prompt template's `render(vars)`. This is a partial
 * ChatRequest — callers merge in per-call options (maxTokens, tools, etc)
 * before dispatching.
 */
export interface RenderedPrompt {
  messages: Message[];
  system?: string;
  format?: JsonSchema;
  [key: string]: unknown;
}

export interface PromptTemplate {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
  render: (vars: Record<string, any>) => RenderedPrompt;
}

/**
 * Named prompt-template registry. Register templates once, invoke by name
 * from CAP handlers or expose over MCP via `saptarishi-llm mcp`.
 */
export class PromptRegistry {
  constructor();
  register(prompt: PromptTemplate): this;
  registerAll(prompts: PromptTemplate[]): this;
  /**
   * Load every `*.mjs` and `*.js` file in `dirPath` (non-recursive) and
   * register the exported templates. Returns { loaded, registered } counts.
   */
  loadFromDir(dirPath: string): Promise<{ loaded: number; registered: number }>;
  /**
   * Watch a previously-loaded directory for changes and hot-reload templates.
   * Requires a prior `loadFromDir(dirPath)` call. Returns a watcher handle.
   */
  watchDir(dirPath: string, options?: {
    debounceMs?: number;
    onReload?: (r: { loaded?: number; registered?: number; error?: Error }) => void;
  }): { close(): void };
  list(): { name: string; description: string; arguments: PromptArgument[] }[];
  has(name: string): boolean;
  get(name: string): PromptTemplate | null;
  render(name: string, vars?: Record<string, any>): RenderedPrompt;
  /** Remove a template by name. Returns true if it existed. */
  unregister(name: string): boolean;
  /** Remove every registered template. */
  clear(): this;
}

/** Bundle of general-purpose prompt templates ready to `registerAll(...)`. */
export function builtInPrompts(): PromptTemplate[];
