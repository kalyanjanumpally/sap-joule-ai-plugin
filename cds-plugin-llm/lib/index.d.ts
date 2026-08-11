// Type definitions for @saptarishi/cds-plugin-llm
// Public API surface only — internal utilities (withRetry, RetryableError,
// throwFromResponse) are not re-exported and intentionally not typed here.
//
// ═══════════════════════════════════════════════════════════════════════════
// 2.x STABILITY CONTRACT
// ═══════════════════════════════════════════════════════════════════════════
//
// Every export in this file with a `@since` marker of 1.99.0 or earlier is
// considered stable and covered by the 2.x compatibility contract:
//
//   * Argument order + option shapes are frozen
//   * Return shapes (stats, MCP resource payloads) are frozen
//   * Error codes in errorRegistry will not be renamed or repurposed
//   * HTTP status codes on LLMError subclasses will not change
//   * MCP resource URIs (config://*) will not be renamed
//   * Prometheus metric names (llm_*) will not be renamed
//
// Additive changes (new optional option fields, new methods, new middleware,
// new error codes, new provider kinds) can land in a minor (2.x) release.
//
// Any change that would break the above requires a 3.0 release.
//
// See MIGRATION.md for the full compatibility statement.
// ═══════════════════════════════════════════════════════════════════════════

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

/** @since 1.36.0 */
export interface AudioBase64Source {
  type: 'base64';
  /** IANA media type — audio/wav, audio/mpeg, audio/mp4, audio/ogg, audio/flac, audio/aac, audio/opus, audio/webm */
  media_type: string;
  /** Base64-encoded audio bytes (no data-URL prefix). */
  data: string;
}
/** @since 1.36.0 */
export interface AudioUrlSource {
  type: 'url';
  /** gs:// URI for Gemini. Other providers do not fetch audio by URL. */
  url: string;
  media_type?: string;
}
/** @since 1.36.0 */
export interface AudioBlock {
  type: 'audio';
  source: AudioBase64Source | AudioUrlSource;
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock | AudioBlock;

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
  /**
   * Submit a bulk-async batch to the provider's batch endpoint (~50% cheaper,
   * 24h SLA). Returns a `BatchHandle` — poll `getBatch(id)` until
   * `status === 'completed'`, then `getBatchResults(id)` returns the parsed
   * results. Only implemented on Anthropic (Message Batches) and OpenAI-
   * compatible providers whose endpoint speaks the OpenAI Batch API.
   * @since 1.25.0
   */
  batch(req: BatchRequest): Promise<BatchHandle>;
  getBatch(id: string): Promise<BatchHandle>;
  getBatchResults<D = unknown>(id: string): Promise<BatchResult<D>[]>;
  cancelBatch(id: string): Promise<BatchHandle>;
  /**
   * Pre-flight cost estimate. No middleware, no provider round-trip.
   * Pulls `model` default from `this.modelId`. @since 1.54.0
   */
  estimateCost(req: Omit<EstimateCostInput, 'model'> & { model?: string }): EstimateCostResult;
}

// ---- Batch API shapes (new in 1.25.0) ------------------------------------

export interface BatchItemRequest {
  /** Caller-assigned id — echoed back on every result. Unique within the batch. */
  customId: string;
  messages: Message[];
  system?: string;
  model?: string;
  maxTokens?: number;
  tools?: Tool[];
  format?: unknown;
  /** Anthropic thinking config; ignored on OpenAI. */
  thinking?: unknown;
}

export interface BatchRequest {
  requests: BatchItemRequest[];
  /** OpenAI only. Default '24h'. Anthropic ignores this. */
  completionWindow?: string;
}

export type BatchStatus = 'in_progress' | 'completed' | 'failed' | 'canceled';

export interface BatchHandle {
  id: string;
  provider: 'anthropic' | 'openai';
  status: BatchStatus;
  submittedAt: string | number;
  endedAt: string | number | null;
  counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  /** Raw provider response — inspect if you need something the unified shape doesn't cover. */
  raw: unknown;
}

export interface BatchResult<D = unknown> {
  customId: string;
  text?: string;
  data?: D;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stopReason?: string;
  model?: string;
  /** Set when this specific item errored. `text` and other fields are absent. */
  error?: string;
  errorType?: 'errored' | 'canceled' | 'expired';
  raw: unknown;
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
 * Fireworks AI — hosted OSS models (Llama, Qwen, Mixtral, DeepSeek, ...) behind
 * an OpenAI-compatible endpoint. Configure via `credentials.{apiKey, baseUrl?}`
 * or `FIREWORKS_API_KEY` env.
 * @since 1.23.0
 */
export class FireworksLLMService extends OpenAICompatibleLLMService {}

/**
 * DeepSeek — direct API access to DeepSeek-V3 (chat) and DeepSeek-R1 (reasoning).
 * Configure via `credentials.{apiKey, baseUrl?}` or `DEEPSEEK_API_KEY` env.
 * @since 1.23.0
 */
export class DeepSeekLLMService extends OpenAICompatibleLLMService {}

/**
 * Mistral AI — direct API access to Mistral Large, Codestral, and the open-weights
 * family. Configure via `credentials.{apiKey, baseUrl?}` or `MISTRAL_API_KEY` env.
 * @since 1.23.0
 */
export class MistralLLMService extends OpenAICompatibleLLMService {}

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
 * Load an audio file from disk, base64-encode, auto-detect media type from
 * extension. Provider support: Gemini (native inline audio), OpenAI-compat
 * with GPT-4o Audio (input_audio content block). Anthropic / Ollama / most
 * Bedrock models throw a clear error. Supported extensions: .wav, .mp3,
 * .m4a, .ogg, .flac, .aac, .opus, .webm.
 * @since 1.36.0
 */
export function audioFromFile(filePath: string): Promise<AudioBlock>;

/**
 * Reference remote audio by URL. Google Cloud Storage URIs (gs://...) work
 * with Gemini natively. HTTP URLs are not fetched by any provider today —
 * download client-side and use audioFromBase64 or audioFromFile.
 * @since 1.36.0
 */
export function audioFromUrl(url: string, mediaType?: string): AudioBlock;

/**
 * Wrap raw base64 audio bytes into a plugin-shape audio block. mediaType is
 * required (audio formats don't self-describe from bytes alone).
 * @since 1.36.0
 */
export function audioFromBase64(base64Data: string, mediaType: string): AudioBlock;

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

// ---- streamTools() event types (new in 1.39.0) ------------------------

/** Emitted at the START of every chat turn. Handy for "Turn N of M" UIs. @since 1.39.0 */
export interface StreamToolsTurnStartEvent {
  type: 'turn_start';
  step: number;
}

/** Assistant text for the current turn. Atomic (not deltas). @since 1.39.0 */
export interface StreamToolsTextEvent {
  type: 'text';
  step: number;
  text: string;
}

/** Emitted right BEFORE a tool starts executing. @since 1.39.0 */
export interface StreamToolsToolCallStartEvent {
  type: 'tool_call_start';
  step: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Emitted AFTER a tool finishes (success or error). @since 1.39.0 */
export interface StreamToolsToolCallResultEvent {
  type: 'tool_call_result';
  step: number;
  id: string;
  name: string;
  result: string;
  isError: boolean;
}

/** Final event when the loop terminates. Shape matches RunToolsResult. @since 1.39.0 */
export interface StreamToolsDoneEvent extends RunToolsResult {
  type: 'done';
  step: number;
}

export type StreamToolsEvent =
  | StreamToolsTurnStartEvent
  | StreamToolsTextEvent
  | StreamToolsToolCallStartEvent
  | StreamToolsToolCallResultEvent
  | StreamToolsDoneEvent;

/**
 * Async-generator counterpart to `runTools`. Yields per-turn progress events
 * (turn_start, text, tool_call_start, tool_call_result) plus a final `done`
 * event carrying the same shape as `RunToolsResult`. Consumers use this to
 * render agent progress in chat UIs without blocking on the full trace.
 * @since 1.39.0
 */
export function streamTools(options: RunToolsOptions): AsyncGenerator<StreamToolsEvent, void, void>;

// ---------------------------------------------------------------------------
// Multi-agent orchestration (new in v1.27.0)
// ---------------------------------------------------------------------------

export interface AgentOptions {
  /** Short slug used by the coordinator to route (matches `/^[a-zA-Z0-9_-]+$/`). */
  name: string;
  /** One-line hint for the coordinator explaining when to invoke this agent. */
  description: string;
  /** LLM used by this specialist. May differ per-agent (cheap workers, smart supervisor). */
  llm: LLMService;
  /** System prompt for the agent's own tool-use loop. */
  system?: string;
  /** Tools this agent can call. Same shape as runTools' tools. Omit for a tool-less agent. */
  tools?: RunnableTool[];
  /** Safety cap on the agent's tool-loop turns. Default 10. */
  maxSteps?: number;
  /** Optional model override. */
  model?: string;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  toolCalls: Array<{ id: string; name: string; input: unknown; result: string; isError: boolean }>;
  usage: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

/**
 * Named specialist wrapping an LLM + optional tools + system prompt into a
 * unit the coordinator can invoke. See `runAgents` for the supervisor loop.
 * @since 1.27.0
 */
export class Agent {
  constructor(options: AgentOptions);
  readonly name: string;
  readonly description: string;
  readonly llm: LLMService;
  readonly system: string | null;
  readonly tools: RunnableTool[];
  readonly maxSteps: number;
  readonly model: string | null;
  run(params: { input: string }): Promise<AgentRunResult>;
}

/** Duck-typed agent — anything with `{ name, description, run(input) => Promise<string | { text }> }` is a valid worker. */
export interface AgentLike {
  name: string;
  description: string;
  run(params: { input: string }): Promise<string | { text: string }>;
}

export interface RunAgentsOptions {
  /** LLM used to coordinate the specialists. Usually a smarter/pricier model. */
  coordinator: LLMService;
  /** Array of Agent instances or duck-typed { name, description, run }. */
  agents: Array<Agent | AgentLike>;
  /** The top-level user task. */
  input: string;
  /** Override the default coordinator system prompt. */
  system?: string;
  /** Safety cap on coordinator turns. Default 20. */
  maxSteps?: number;
  /** Optional per-turn observer (mirrors runTools' `onStep`). */
  onStep?: (info: { step: number; response: ChatResponse }) => void | Promise<void>;
  /** Fired every time the coordinator invokes a specialist — good for observability. */
  onAgentInvocation?: (info: { agent: string; question: string }) => void | Promise<void>;
  /** Any other chat-request options (model, maxTokens, cache, ...) applied to coordinator calls. */
  [k: string]: unknown;
}

export interface RunAgentsResult {
  text: string;
  steps: number;
  /** One entry per specialist call, in invocation order. */
  trace: Array<{ agent: string; question: string | null; answer: string; isError: boolean }>;
  usage: { input_tokens?: number; output_tokens?: number };
  model?: string;
  stopReason?: string;
}

/**
 * Supervisor pattern — each agent is presented to the coordinator as a
 * tool (`invoke_<name>`), and `runTools` on the coordinator handles the
 * routing loop. Returns the coordinator's final text plus a compact trace
 * of every specialist invocation.
 * @since 1.27.0
 */
export function runAgents(options: RunAgentsOptions): Promise<RunAgentsResult>;

/** The default coordinator system prompt shipped with runAgents(). Override via options.system. */
export const DEFAULT_COORDINATOR_SYSTEM: string;

// ---- streamAgents() event types (new in 1.41.0) ----------------------

/** Emitted at the START of every coordinator turn. @since 1.41.0 */
export interface StreamAgentsTurnStartEvent {
  type: 'turn_start';
  step: number;
}

/** Coordinator text for the current turn (atomic per turn). @since 1.41.0 */
export interface StreamAgentsTextEvent {
  type: 'text';
  step: number;
  text: string;
}

/** Emitted right BEFORE a specialist agent runs. @since 1.41.0 */
export interface StreamAgentsAgentCallStartEvent {
  type: 'agent_call_start';
  step: number;
  /** Agent slug (`invoke_` prefix stripped from the underlying tool name). */
  agent: string;
  question: string | null;
}

/** Emitted AFTER a specialist finishes (success or error). @since 1.41.0 */
export interface StreamAgentsAgentCallResultEvent {
  type: 'agent_call_result';
  step: number;
  agent: string;
  answer: string;
  isError: boolean;
}

/** Final event when the coordinator terminates. Trace matches `runAgents()`. @since 1.41.0 */
export interface StreamAgentsDoneEvent extends RunAgentsResult {
  type: 'done';
  step: number;
}

export type StreamAgentsEvent =
  | StreamAgentsTurnStartEvent
  | StreamAgentsTextEvent
  | StreamAgentsAgentCallStartEvent
  | StreamAgentsAgentCallResultEvent
  | StreamAgentsDoneEvent;

/**
 * Async-generator counterpart to `runAgents`. Yields the same shape as
 * `streamTools` but with `invoke_<name>` tool events repackaged as agent-slug
 * events. Chat surfaces can render per-specialist badges without knowing
 * about the underlying `invoke_<name>` convention.
 * @since 1.41.0
 */
export function streamAgents(options: RunAgentsOptions): AsyncGenerator<StreamAgentsEvent, void, void>;

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
  /** How many requests were served from the response cache (new in 1.26.0). */
  totalCachedHits: number;
  /** Sum of what those cached hits would have cost if the LLM had actually been called (new in 1.26.0). */
  totalCostSaved: number;
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
  /** True when this request was served from the response cache; cost is 0 (new in 1.26.0). */
  cached: boolean;
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

/** @since 1.38.0 */
export interface RateLimitSnapshot {
  provider: string;
  requestsLimit?: number;
  requestsRemaining?: number;
  requestsResetAt?: string;    // ISO
  tokensLimit?: number;
  tokensRemaining?: number;
  tokensResetAt?: string;      // ISO
  retryAfterSeconds?: number;  // set on 429/503 responses
  updatedAt: string;           // when we last saw this state
}

export interface UsageMeteringMiddleware extends Middleware {
  summary(): UsageSummary;
  byModel(modelId: string): UsageBucket | null;
  byTenant(tenantId: string): UsageBucket | null;
  byProvider(providerId: string): UsageBucket | null;
  /**
   * Last-seen rate-limit snapshot(s). Call with no args for the full map;
   * pass a provider alias to get just that provider (or null if unknown).
   * @since 1.38.0
   */
  rateLimits(): Record<string, RateLimitSnapshot>;
  rateLimits(providerAlias: string): RateLimitSnapshot | null;
  reset(): void;
  /**
   * Ready-to-register MCP resource that returns the summary + rate-limit
   * snapshot as JSON. Drop into `new MCPServer({ resources: [meter.asMcpResource(), ...] })`.
   */
  asMcpResource(): {
    uri: 'config://usage';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => UsageSummary & { rateLimits: Record<string, RateLimitSnapshot> };
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

// ---- Response cache middleware (new in 1.26.0) --------------------------

export interface ResponseCacheStore {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
  clear?(): void | Promise<void>;
  size?(): number | null;
  has?(key: string): boolean | Promise<boolean>;
}

export interface SemanticCacheOptions {
  /** Async function turning text into an embedding vector. Called on cache misses. */
  embedder: (text: string) => Promise<number[]> | number[];
  /** Cosine similarity threshold in (0, 1]. Default 0.92. Higher = stricter. */
  threshold?: number;
  /** Max # of recent entries to compare against. Default 200. */
  maxScan?: number;
  /** Skip semantic lookup for text shorter than this. Default 20 chars. */
  minTextLength?: number;
}

export interface ResponseCacheOptions {
  /** Pluggable backend. Default: in-memory LRU with `maxEntries` cap. */
  store?: ResponseCacheStore;
  /** Cache entry TTL in milliseconds. Default: 3,600,000 (1 hour). */
  ttl?: number;
  /** Cap on in-memory LRU size (ignored if a custom store is provided). Default 10,000. */
  maxEntries?: number;
  /** Custom key derivation. Default: SHA-256 of (model, system, messages, tools, format, maxTokens). */
  keyFn?: (ctx: MiddlewareContext) => string | Promise<string>;
  /** Fired on cache hits — good place to log or increment a counter. */
  onHit?: (ctx: MiddlewareContext, cached: unknown) => void;
  /** Fired on cache misses (before the LLM call). */
  onMiss?: (ctx: MiddlewareContext) => void;
  /**
   * Enable semantic (embedding-based) cache lookup. On an exact miss, the
   * middleware embeds the user text and does a cosine scan over the recent
   * cache entries. Requests with `tools` are excluded automatically.
   * @since 1.32.0
   */
  semantic?: SemanticCacheOptions;
}

export interface ResponseCacheStats {
  hits: number;
  misses: number;
  skips: number;
  semanticHits: number;
  semanticMisses: number;
  embedderErrors: number;
}

export interface ResponseCacheMiddleware extends Middleware {
  stats: ResponseCacheStats;
  store: ResponseCacheStore;
  /**
   * In-process semantic index (cacheKey → { embedding, semanticText, ts }).
   * Only populated when the `semantic` option is enabled. @since 1.32.0
   */
  semanticIndex: Map<string, { embedding: number[]; semanticText: string; ts: number }>;
  clear(): Promise<void>;
  delete(key: string): Promise<void>;
  size(): number | null;
  /** Combined exact+semantic hit rate over total requests that reached the cache. */
  hitRate(): number;
  /** MCP resource dumping the cache stats — mirrors `usageMetering.asMcpResource()`. */
  asMcpResource(): {
    uri: 'config://cache';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => {
      hits: number;
      misses: number;
      skips: number;
      semanticHits: number;
      semanticMisses: number;
      embedderErrors: number;
      hitRate: number;
      size: number | null;
      semanticIndexSize: number;
    };
  };
}

/** Cosine similarity — exported for tests / custom scoring. @since 1.32.0 */
export function cosine(a: number[], b: number[]): number;

/**
 * Memoizes identical `chat()` calls by key = SHA-256(model, system, messages,
 * tools, format, maxTokens). Streams + embeddings + tool-turn responses
 * (result.toolCalls) are NOT cached. Skip per-call via `chat({ cache: false })`.
 *
 * Sets `result.cached = true` and `result.cacheKey` on hits — downstream
 * middleware (usageMetering) reads the flag to charge $0 and increment
 * `summary.totalCachedHits` + `summary.totalCostSaved`.
 * @since 1.26.0
 */
export function responseCache(options?: ResponseCacheOptions): ResponseCacheMiddleware;

/** Tiny LRU-with-TTL exported for consumers who want to pre-warm the cache. */
export class InMemoryLRU implements ResponseCacheStore {
  constructor(options: { maxEntries: number });
  get(key: string): unknown | null;
  set(key: string, value: unknown, ttlMs: number): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
  has(key: string): boolean;
}

// ---- Guardrails middleware (new in 1.28.0) ------------------------------

export type GuardrailVerdict =
  | { action: 'allow' }
  | { action: 'block'; reason?: string }
  | { action: 'redact'; payload: unknown };

/**
 * Guardrails filter. Called with `payload` (input side: `{ system, messages }`;
 * output side: the chat response) and the middleware `ctx`. Return one of
 * the three verdicts. Returning `undefined` / `null` is equivalent to
 * `{ action: 'allow' }`.
 */
export type GuardrailFilter = (
  payload: unknown,
  ctx: MiddlewareContext,
) => GuardrailVerdict | undefined | null | Promise<GuardrailVerdict | undefined | null>;

export interface GuardrailsOptions {
  inputFilters?: GuardrailFilter[];
  outputFilters?: GuardrailFilter[];
  /** Fired when any filter blocks. Good for logging + alerting. */
  onBlock?: (info: { stage: 'input' | 'output'; filterIndex: number; reason?: string; ctx: MiddlewareContext }) => void | Promise<void>;
  /** Fired when any filter redacts. */
  onRedact?: (info: { stage: 'input' | 'output'; filterIndex: number; ctx: MiddlewareContext }) => void | Promise<void>;
}

export interface GuardrailsStats {
  inputBlocks: number;
  outputBlocks: number;
  inputRedacts: number;
  outputRedacts: number;
}

export interface GuardrailsMiddleware extends Middleware {
  stats: GuardrailsStats;
  /** Zero all counters. @since 1.35.1 */
  reset(): void;
  /** MCP resource dumping the stats — matches the pattern on other observability middleware. @since 1.35.1 */
  asMcpResource(): {
    uri: 'config://guardrails';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => GuardrailsStats & { inputFilters: number; outputFilters: number };
  };
}

/**
 * Pluggable input/output filters. Input filters see `{ system, messages }`
 * before the request reaches the provider. Output filters see the chat
 * response before it's returned to the caller. Filters can allow, block
 * (throws `GuardrailBlockedError`), or redact (mutates the payload for
 * downstream middleware).
 * @since 1.28.0
 */
export function guardrails(options?: GuardrailsOptions): GuardrailsMiddleware;

export class GuardrailBlockedError extends LLMError {
  readonly code: 'GUARDRAIL_BLOCKED';
  readonly reason: string;
  readonly details: { stage: 'input' | 'output'; filterIndex: number };
}

// ---- Cost budget middleware (new in 1.29.0) -----------------------------

export type BudgetWindow = 'hour' | 'day' | 'month' | 'process' | number;
export type BudgetScope = 'total' | 'perTenant' | 'perModel';

export interface BudgetLimits {
  /** Aggregate ceiling across everything, in `currency`. */
  total?: number;
  /** Per-tenant limits. Use `default` for the catch-all; named keys for overrides. */
  perTenant?: Record<string, number>;
  /** Per-model limits, same shape as perTenant. */
  perModel?: Record<string, number>;
}

export interface CostBudgetOptions {
  limits?: BudgetLimits;
  /** How often the counters reset. Default 'day'. */
  window?: BudgetWindow;
  /** 'throw' (default) → BudgetExceededError. 'warn' → onExceeded fires; request proceeds. */
  action?: 'throw' | 'warn';
  currency?: string;
  /** Per-model prices — merged over `DEFAULT_PRICING`. Same shape as usageMetering. */
  pricing?: Record<string, ModelPricing>;
  pricingUnit?: number;
  tenantOf?: (ctx: MiddlewareContext) => string | null | undefined;
  providerOf?: (ctx: MiddlewareContext) => string | null | undefined;
  /**
   * Fires with `{ scope, key, current, limit, currency, action: 'block' | 'exceeded' }`.
   * `'block'` = pre-call refusal; `'exceeded'` = post-call crossing.
   */
  onExceeded?: (info: { scope: BudgetScope; key: string; current: number; limit: number; currency: string; action: 'block' | 'exceeded' }) => void | Promise<void>;
  /**
   * Pluggable counter store. Default is per-process in-memory. Pass a
   * `RedisCounterStore` (or any object matching the {@link CounterStore}
   * contract) to share counters across multiple app instances.
   * @since 1.30.0
   */
  store?: CounterStore;
}

export interface BudgetSnapshot {
  window: string;
  total: number;
  perTenant: Record<string, number>;
  perModel: Record<string, number>;
  currency: string;
}

/**
 * Pluggable counter storage for costBudget. Every method may return either
 * a plain value or a Promise — synchronous stores (InMemoryCounterStore)
 * return values directly; async stores (RedisCounterStore) return promises.
 * @since 1.30.0
 */
export interface CounterStore {
  /** Current spend for (scope, key) in the given bucket. */
  get(scope: BudgetScope, key: string, bucket: string): number | Promise<number>;
  /** Atomically add `amount` to (scope, key) in the given bucket. */
  add(scope: BudgetScope, key: string, bucket: string, amount: number): void | Promise<void>;
  /** All counters in the given bucket, grouped by scope. */
  snapshot(bucket: string): { total: number; perTenant: Record<string, number>; perModel: Record<string, number> }
                          | Promise<{ total: number; perTenant: Record<string, number>; perModel: Record<string, number> }>;
  /** Drop everything. Used by tests / manual admin. */
  clear(): void | Promise<void>;
}

export interface CostBudgetMiddleware extends Middleware {
  /** Sync return when using default store; Promise when using an async store. */
  spent(scope: BudgetScope, key: string): number | Promise<number>;
  spentTotal(): number | Promise<number>;
  snapshot(): BudgetSnapshot | Promise<BudgetSnapshot>;
  limitFor(scope: BudgetScope, key: string): number | null;
  reset(): void | Promise<void>;
  /** The underlying counter store (default in-memory, or user-supplied). */
  readonly store: CounterStore;
  asMcpResource(): {
    uri: 'config://budget';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => Promise<{ window: BudgetWindow; limits: BudgetLimits; currency: string; current: BudgetSnapshot }>;
  };
}

/**
 * Cost-budget enforcement middleware. Reads per-model pricing (same table as
 * `usageMetering`), maintains per-window spend counters, and throws /
 * warns / hooks when a limit is crossed.
 * @since 1.29.0
 */
export function costBudget(options?: CostBudgetOptions): CostBudgetMiddleware;

// ---- Rate-limit retry middleware (new in 1.47.0) ---------------------

export interface RetryOnRateLimitOptions {
  /** Max total attempts (including the initial call). Default 3. */
  maxAttempts?: number;
  /** Wait time in ms when no `retry-after` header/hint is present. Default 5000. */
  fallbackWaitMs?: number;
  /** Additional random jitter in [0, jitterMs) added to each wait. Default 250. */
  jitterMs?: number;
  /** Statuses treated as retryable. Default [429, 503]. */
  retryOnStatuses?: number[];
  onRetry?: (info: { ctx: MiddlewareContext; attempt: number; waitMs: number; status: number | null; error: Error; method: string }) => void | Promise<void>;
  onGiveUp?: (info: { ctx: MiddlewareContext; attempts: Array<{ attempt: number; waitMs: number; status: number | null; error: string }>; finalError: Error; method: string }) => void | Promise<void>;
}

export interface RetryOnRateLimitStats {
  requests:        number;
  retriedRequests: number;
  totalRetries:    number;
  givenUp:         number;
  totalWaitMs:     number;
}

export interface RetryOnRateLimitMiddleware extends Middleware {
  readonly stats: RetryOnRateLimitStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://rate-limit-retry';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => RetryOnRateLimitStats & { maxAttempts: number; fallbackWaitMs: number; jitterMs: number; retryOnStatuses: number[] };
  };
}

/**
 * Middleware that catches rate-limit errors (via `err.retryAfterSec` / matching
 * status codes / `RetryableError` from providers) and retries after the hinted
 * or fallback delay. Complements `usageMetering`'s `_rateLimit` state (surfacing)
 * with automated recovery. Composable with `costBudget`, `responseCache`, etc.
 * @since 1.47.0
 */
export function retryOnRateLimit(options?: RetryOnRateLimitOptions): RetryOnRateLimitMiddleware;

export class RateLimitGiveUpError extends LLMError {
  readonly code: 'RATE_LIMIT_GIVE_UP';
  readonly attempts: Array<{ attempt: number; waitMs: number; status: number | null; error: string }>;
  readonly cause: Error;
}

// ---- Circuit breaker middleware (new in 1.49.0) -----------------------

export type CircuitState = 'closed' | 'open' | 'halfOpen';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  threshold?: number;
  /** How long to stay open before a half-open probe (ms). Default 30_000. */
  cooldownMs?: number;
  /** Probes allowed while half-open. Default 1. */
  halfOpenAttempts?: number;
  /** Bucket state per provider (ctx.service.name). Default true. */
  perProvider?: boolean;
  /** Custom predicate — default counts 5xx + network errors, ignores 4xx. */
  isFailure?: (err: any) => boolean;
  onOpen?: (info: { provider: string; consecutiveFailures: number; lastError: Error; method: string }) => void | Promise<void>;
  onClose?: (info: { provider: string; method: string }) => void | Promise<void>;
  onHalfOpen?: (info: { provider: string; method: string }) => void | Promise<void>;
}

export interface CircuitBreakerStats {
  requests:       number;
  shortCircuited: number;
  opens:          number;
  closes:         number;
  halfOpens:      number;
  failures:       number;
  successes:      number;
}

export interface CircuitBreakerBucketState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
  cooldownRemainingMs: number;
}

export interface CircuitBreakerMiddleware extends Middleware {
  readonly stats: CircuitBreakerStats;
  state(provider?: string): CircuitBreakerBucketState;
  reset(provider?: string): void;
  forceOpen(provider?: string): void;
  /** External success signal — used by providerHealthProbe (1.62+). @since 1.62.0 */
  recordSuccess(provider?: string): void;
  /** External failure signal — used by providerHealthProbe (1.62+). @since 1.62.0 */
  recordFailure(provider?: string, err?: Error): void;
  forceClose(provider?: string): void;
  asMcpResource(): {
    uri: 'config://circuit-breaker';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => CircuitBreakerStats & {
      threshold: number;
      cooldownMs: number;
      halfOpenAttempts: number;
      perProvider: boolean;
      buckets: Record<string, CircuitBreakerBucketState>;
    };
  };
}

/**
 * Circuit-breaker middleware. Tracks consecutive failures per provider bucket;
 * after `threshold` failures, opens the circuit and short-circuits subsequent
 * calls for `cooldownMs`. Complements `retryOnRateLimit`: retries handle
 * transient throttling, breaker handles sustained outage.
 * @since 1.49.0
 */
export function circuitBreaker(options?: CircuitBreakerOptions): CircuitBreakerMiddleware;

export class CircuitOpenError extends LLMError {
  readonly code: 'CIRCUIT_OPEN';
  readonly provider: string;
  readonly cooldownRemainingMs: number;
  readonly cause?: Error;
}

// ---- Bulkhead middleware (new in 1.51.0) ------------------------------

export interface BulkheadOptions {
  /** Max concurrent in-flight calls per bucket. Default 10. */
  maxConcurrent?: number;
  /** Max additional waiters that can queue beyond in-flight. Default 0. */
  maxQueued?: number;
  /** How long a waiter can sit in the queue before rejection. Default 0 = no timeout. */
  queueTimeoutMs?: number;
  /** Bucket state per provider (ctx.service.name). Default true. */
  perProvider?: boolean;
  onQueue?: (info: { provider: string; inFlight: number; queued: number; method: string }) => void | Promise<void>;
  onReject?: (info: { provider: string; reason: 'queue-full' | 'queue-timeout'; inFlight: number; queued: number; method: string }) => void | Promise<void>;
  onExecute?: (info: { provider: string; inFlight: number; queued: number; method: string; waitedMs?: number }) => void | Promise<void>;
}

export interface BulkheadStats {
  requests: number;
  admitted: number;
  queued:   number;
  rejected: number;
  timedOut: number;
}

export interface BulkheadBucketState {
  inFlight: number;
  queued:   number;
}

export interface BulkheadObservation {
  provider:   string;
  durationMs: number;
  ok:         boolean;
  method:     string;
}

export interface BulkheadMiddleware extends Middleware {
  readonly stats: BulkheadStats;
  state(provider?: string): BulkheadBucketState;
  reset(provider?: string): void;
  /** Runtime concurrency tune — used by adaptiveBulkhead. @since 1.61.0 */
  setMaxConcurrent(n: number): void;
  /** @since 1.61.0 */
  getMaxConcurrent(): number;
  /** Subscribe to per-call observations. Returns unsubscribe fn. @since 1.61.0 */
  subscribe(fn: (obs: BulkheadObservation) => void): () => void;
  asMcpResource(): {
    uri: 'config://bulkhead';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => BulkheadStats & {
      maxConcurrent: number;
      maxQueued: number;
      queueTimeoutMs: number;
      perProvider: boolean;
      buckets: Record<string, BulkheadBucketState>;
    };
  };
}

/**
 * Bulkhead / concurrency-limit middleware. Caps in-flight calls per bucket,
 * queues excess up to maxQueued, times out overflow. Prevents one runaway
 * tenant / agent from starving others. Completes the resilience quartet:
 * retry → breaker → fallback → bulkhead.
 * @since 1.51.0
 */
export function bulkhead(options?: BulkheadOptions): BulkheadMiddleware;

export class BulkheadFullError extends LLMError {
  readonly code: 'BULKHEAD_FULL';
  readonly provider: string;
  readonly maxQueued: number;
}

export class BulkheadTimeoutError extends LLMError {
  readonly code: 'BULKHEAD_TIMEOUT';
  readonly provider: string;
  readonly queueTimeoutMs: number;
}

// ---- Deadline middleware (new in 1.52.0) ------------------------------

export interface DeadlineOptions {
  /** Total request-time budget in ms. Default 30_000. */
  timeoutMs?: number;
  /** Optional per-method overrides, e.g. { chat: 30_000, embed: 5_000, stream: 60_000 }. */
  perMethod?: Record<string, number>;
  onExpired?: (info: { method: string; timeoutMs: number; elapsedMs: number }) => void | Promise<void>;
}

export interface DeadlineStats {
  requests:    number;
  expired:     number;
  activeCount: number;
}

export interface DeadlineMiddleware extends Middleware {
  readonly stats: DeadlineStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://deadline';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => DeadlineStats & { timeoutMs: number; perMethod: Record<string, number> | null };
  };
}

/**
 * Deadline middleware — hard cap on total request time. Aborts the ctx.signal
 * on expiration. Compose as the OUTERMOST middleware so retries, queue-waits,
 * and provider calls all share ONE budget.
 * @since 1.52.0
 */
export function deadline(options?: DeadlineOptions): DeadlineMiddleware;

export class DeadlineExceededError extends LLMError {
  readonly code: 'DEADLINE_EXCEEDED';
  readonly timeoutMs: number;
  readonly method: string;
}

// ---- Aggregate health check (new in 1.53.0) --------------------------

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthSnapshot {
  status: HealthStatus;
  degraded: Array<{ layer: string; reason: string }>;
  primitives: {
    deadline?:       { requests: number; expired: number; activeCount: number };
    breaker?:        { openBuckets: string[]; opens: number; closes: number; shortCircuited: number };
    bulkhead?:       { saturated: Array<{ provider: string; inFlight: number; queued: number }>; rejected: number; timedOut: number };
    budget?:         { spent: number; limit: number | null; overLimit: boolean };
    retry?:          { requests: number; givenUp: number };
    guardrails?:     { inputBlocks: number; outputBlocks: number; inputRedacts: number; outputRedacts: number };
    injectionGuard?: { scanned: number; blocked: number; sanitized: number; warned: number };
    metering?:       { totalRequests: number; totalCost: number; totalCachedHits: number };
    cache?:          { hitRate: number | null; size: number | null; hits: number; misses: number };
  };
  custom: Record<string, { ok: boolean; reason: string | null }>;
}

export interface HealthCheckInput {
  deadline?:       DeadlineMiddleware;
  breaker?:        CircuitBreakerMiddleware;
  bh?:             BulkheadMiddleware;
  bulkhead?:       BulkheadMiddleware;
  budget?:         CostBudgetMiddleware;
  retry?:          RetryOnRateLimitMiddleware;
  guardrails?:     GuardrailsMiddleware;
  injectionGuard?: PromptInjectionGuardMiddleware;
  metering?:       UsageMeteringMiddleware;
  cache?:          ResponseCacheMiddleware;
  custom?: Array<{
    name: string;
    check: () => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  }>;
  /** Override per-layer degraded predicates. */
  isDegraded?: Partial<Record<string, (snap: any) => boolean>>;
}

/** Programmatic snapshot — call from your own route or logger. @since 1.53.0 */
export function healthCheck(mw: HealthCheckInput): Promise<HealthSnapshot>;

/**
 * Express/CAP-shaped route factory. Returns `(req, res) => Promise<void>`.
 * `treatDegradedAs` defaults to 200 (app still serving on degraded state);
 * `treatDownAs` defaults to 503.
 * @since 1.53.0
 */
export function healthHandler(
  mw: HealthCheckInput,
  options?: { treatDegradedAs?: number; treatDownAs?: number }
): (req: any, res: any) => Promise<void>;

// ---- Pre-flight cost estimator (new in 1.54.0) ------------------------

export interface EstimateCostInput {
  /** Required. Model ID as it would be passed to chat(). */
  model:      string;
  /** Chat messages — content may be a string or an array of content blocks. */
  messages:   Array<{ role: string; content: string | Array<{ type: string; text?: string; [k: string]: any }> }>;
  /** Optional system prompt — counted as input tokens. */
  system?:    string | null;
  /** Upper bound on OUTPUT tokens. Default 512. */
  maxTokens?: number;
  /** Optional per-model pricing override. Defaults to DEFAULT_PRICING. */
  pricing?:   Record<string, { input: number; output: number }>;
  /** Display-only currency label. Default 'USD'. */
  currency?:  string;
  /** Optional pre-loaded tokenizer. Skips the getTokenizer(model) auto-detect. */
  tokenizer?: { name?: string; countTokens: (text: string) => number };
}

export interface EstimateCostResult {
  model:           string;
  tokensIn:        number;
  estMaxTokensOut: number;
  inputUsd:        number;
  outputUsd:       number;
  estimatedUsd:    number;
  currency:        string;
  /** false when the model isn't in the pricing table — estimatedUsd is 0. */
  priced:          boolean;
  /** 'tiktoken' | 'js-tiktoken' | 'anthropic-tokenizer' | 'heuristic' | ... */
  tokenizerUsed:   string;
  /** Non-fatal advisories: unknown model, skipped multimodal blocks, etc. */
  notes:           string[];
}

/**
 * Pre-flight token-count + cost estimate. No provider round-trip.
 * Composes with costBudget as a pre-flight budget check:
 *   const est = estimateCost({ model, messages });
 *   if (est.estimatedUsd > remaining) refuse();
 * @since 1.54.0
 */
export function estimateCost(input: EstimateCostInput): EstimateCostResult;

// ---- Cost guard middleware (new in 1.56.0) ---------------------------

export interface CostGuardOptions {
  /** Required. Hard ceiling per call in USD (matches `estimatedUsd` field). */
  maxPerCallUsd: number;
  /** Optional soft threshold — fires `onWarn` if estimate exceeds. Default null. */
  warnAtUsd?: number | null;
  /** Optional per-model pricing override. Defaults to DEFAULT_PRICING. */
  pricing?: Record<string, { input: number; output: number }>;
  /** Optional pre-loaded tokenizer. Skips the getTokenizer(model) auto-detect. */
  tokenizer?: { name?: string; countTokens: (text: string) => number };
  /** Which methods to guard. Default ['chat', 'stream']. */
  applyTo?: string[];
  onExceeded?: (info: { estimatedUsd: number; limitUsd: number; model: string; tokensIn: number; method: string }) => void | Promise<void>;
  onWarn?:     (info: { estimatedUsd: number; warnAtUsd: number; limitUsd: number; model: string; tokensIn: number; method: string }) => void | Promise<void>;
}

export interface CostGuardStats {
  requests:          number;
  skipped:           number;
  checked:           number;
  warned:            number;
  blocked:           number;
  estimatedUsdTotal: number;
}

export interface CostGuardMiddleware extends Middleware {
  readonly stats: CostGuardStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://cost-guard';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => CostGuardStats & { maxPerCallUsd: number; warnAtUsd: number | null; applyTo: string[] };
  };
}

/**
 * Pre-flight cost enforcement middleware. Wraps `estimateCost` and runs BEFORE
 * the provider call — refuses over-budget requests with `CostGuardBlockedError`
 * WITHOUT spending a token. Stashes the estimate on `ctx.meta.costEstimate` for
 * downstream middleware.
 * @since 1.56.0
 */
export function costGuard(options: CostGuardOptions): CostGuardMiddleware;

export class CostGuardBlockedError extends LLMError {
  readonly code: 'COST_GUARD_BLOCKED';
  readonly estimatedUsd: number;
  readonly limitUsd: number;
  readonly model: string;
}

// ---- Resilience bundle (new in 1.55.0) --------------------------------

export type ResiliencePrimitiveKind =
  | 'deadline' | 'costBudget' | 'circuitBreaker' | 'bulkhead' | 'retryOnRateLimit';

export interface ResilienceBundleOptions {
  // Deadline
  deadlineMs?:         number;
  perMethodDeadline?:  Record<string, number> | null;
  // Cost budget (only wired when budgetLimits is non-null)
  budgetLimits?:       BudgetLimits | null;
  budgetWindow?:       BudgetWindow;
  budgetCurrency?:     string;
  budgetAction?:       'throw' | 'warn';
  // Circuit breaker
  breakerThreshold?:        number;
  breakerCooldownMs?:       number;
  breakerHalfOpenAttempts?: number;
  breakerPerProvider?:      boolean;
  // Bulkhead
  bulkheadMax?:         number;
  bulkheadQueue?:       number;
  bulkheadTimeoutMs?:   number;
  bulkheadPerProvider?: boolean;
  // Retry
  retryAttempts?:     number;
  retryFallbackMs?:   number;
  retryJitterMs?:     number;
  // Composition control
  include?:  ResiliencePrimitiveKind[] | null;
  exclude?:  ResiliencePrimitiveKind[] | null;
  // Callback hooks forwarded to the underlying primitives
  onDeadlineExpired?: DeadlineOptions['onExpired'];
  onRetry?:           RetryOnRateLimitOptions['onRetry'];
  onRetryGiveUp?:     RetryOnRateLimitOptions['onGiveUp'];
  onBreakerOpen?:     CircuitBreakerOptions['onOpen'];
  onBreakerClose?:    CircuitBreakerOptions['onClose'];
  onBudgetExceeded?:  CostBudgetOptions['onExceeded'];
  onBulkheadReject?:  BulkheadOptions['onReject'];
}

export interface ResilienceBundleStack {
  deadline?:  DeadlineMiddleware;
  budget?:    CostBudgetMiddleware;
  breaker?:   CircuitBreakerMiddleware;
  bh?:        BulkheadMiddleware;
  bulkhead?:  BulkheadMiddleware;
  retry?:     RetryOnRateLimitMiddleware;
  /** Description of the wired chain — feeds validateMiddlewareOrder. */
  chain:      Array<{ kind: ResiliencePrimitiveKind }>;
  /** Attach every included primitive to `llm` in canonical order. */
  apply(llm: LLMService | { use: (mw: Middleware) => any }): any;
  /** Shape ready to pass to `prometheusHandler({ ... })`. */
  prometheusBundle(): { deadline?: DeadlineMiddleware; budget?: CostBudgetMiddleware; breaker?: CircuitBreakerMiddleware; bh?: BulkheadMiddleware; retry?: RetryOnRateLimitMiddleware };
  /** Shape ready to pass to `healthHandler({ ... })`. */
  healthBundle():     { deadline?: DeadlineMiddleware; budget?: CostBudgetMiddleware; breaker?: CircuitBreakerMiddleware; bh?: BulkheadMiddleware; retry?: RetryOnRateLimitMiddleware };
}

export interface ResilienceBundlePreset {
  deadlineMs:              number;
  perMethodDeadline:       Record<string, number>;
  retryAttempts:           number;
  retryFallbackMs:         number;
  retryJitterMs:           number;
  breakerThreshold:        number;
  breakerCooldownMs:       number;
  breakerHalfOpenAttempts: number;
  bulkheadMax:             number;
  bulkheadQueue:           number;
  bulkheadTimeoutMs:       number;
}

// ---- Stream completion tracking (new in 1.72.0) ----------------------

export interface StreamCompletionInfo {
  /** true if the stream finished normally, false if it threw. */
  ok:         boolean;
  /** The error if ok=false. */
  error:      Error | null;
  /** Number of chunks yielded (including the final `done` chunk). */
  chunkCount: number;
  /** Wall-clock ms from wrapping until stream finished. */
  durationMs: number;
  /** The final chunk with type='done' (or null if stream errored before it). */
  doneChunk:  { type: 'done'; text?: string; usage?: any; model?: string } | null;
}

export interface StreamCompletionEnvelope<T> extends AsyncIterable<T> {
  /**
   * Register a callback fired exactly once when the stream is fully
   * consumed. If the stream has already completed by the time you
   * register, fires synchronously with the captured info.
   */
  onComplete(cb: (info: StreamCompletionInfo) => void): void;
  /** Immutable snapshot — null until the stream finishes. */
  readonly completedInfo: StreamCompletionInfo | null;
  readonly isCompleted: boolean;
}

/**
 * Wrap an async iterable so middleware can hook into 'stream fully
 * consumed' events. Auto-applied by `LLMService.stream()` — middleware
 * authors just need to check `hasStreamCompletion(result)` and call
 * `result.onComplete(cb)` to defer 'finally' logic.
 * @since 1.72.0
 */
export function wrapStreamCompletion<T>(iter: AsyncIterable<T>): StreamCompletionEnvelope<T>;

/** Type guard for a wrapped stream envelope. @since 1.72.0 */
export function hasStreamCompletion(x: unknown): x is StreamCompletionEnvelope<unknown>;

// ---- Chain snapshot diff (new in 1.73.0) -----------------------------

export interface ChainSnapshot {
  order: Array<{ position: number; kind: string; config?: Record<string, unknown> }>;
  summary?: Record<string, unknown>;
}

export interface ChainDiffConfigChange {
  field: string;
  from:  unknown;
  to:    unknown;
}

export interface ChainDiffResult {
  ok: boolean;
  added:         Array<{ kind: string; position: number }>;
  removed:       Array<{ kind: string; position: number }>;
  reordered:     Array<{ kind: string; fromPosition: number; toPosition: number }>;
  configChanged: Array<{ kind: string; changes: ChainDiffConfigChange[] }>;
  unchanged:     Array<{ kind: string; position: number }>;
  summary: {
    added:         number;
    removed:       number;
    reordered:     number;
    configChanged: number;
    unchanged:     number;
  };
}

/**
 * Compare two middleware chain snapshots (the `config://chain` payloads
 * from 1.48 validateMiddlewareOrder / buildChainSnapshot) and report
 * the delta. CI-friendly for detecting chain drift; pre-deploy diffs.
 * @since 1.73.0
 */
export function chainDiff(a: ChainSnapshot, b: ChainSnapshot): ChainDiffResult;

/**
 * Format a chainDiff result as a human-readable multi-line string with
 * +/-/~ markers. `colors: true` adds ANSI escape codes for terminals.
 * @since 1.73.0
 */
export function formatChainDiff(diff: ChainDiffResult, options?: { colors?: boolean }): string;

// ---- Replay buffer (new in 1.75.0) -----------------------------------

export interface ReplayBufferEntry {
  timestamp:     number;
  method:        string;
  model:         string | null;
  request:       Record<string, unknown>;
  response:      { textPreview?: string; textLength?: number; model?: string; usage?: any; cached?: boolean; stopReason?: string } | null;
  error:         { name: string; code: string | null; message: string; primitive: string | null; retriable: boolean } | null;
  durationMs:    number;
  correlationId: string | null;
  ok:            boolean;
}

export interface ReplayBufferOptions {
  /** Rolling buffer size. Default 100. */
  size?:                    number;
  /** Fields to strip from `request` before storing. Default ['messages', 'system', 'input']. */
  redactFields?:            string[];
  /** Capture stream calls too (defers to onComplete). Default true. */
  captureStreams?:          boolean;
  /** Include a truncated preview of the last user message even when 'messages' is redacted. */
  includeRedactedPreview?:  boolean;
  /** Truncation length for the redacted preview. Default 200. */
  previewChars?:            number;
}

export interface ReplayBufferStats {
  totalCaptured: number;
  successes:     number;
  failures:      number;
}

export interface ReplayBufferMiddleware extends Middleware {
  readonly stats: ReplayBufferStats;
  /** Everything currently in the buffer, oldest → newest. */
  dump():             ReplayBufferEntry[];
  /** Last N entries, oldest → newest. */
  dumpLastN(n: number): ReplayBufferEntry[];
  /** Entries matching a predicate. */
  dumpMatching(pred: (entry: ReplayBufferEntry) => boolean): ReplayBufferEntry[];
  /** Number of entries currently held (capped at capacity). */
  size():     number;
  /** Configured buffer size (max entries). */
  capacity(): number;
  /** Clear buffer + stats. */
  clear():    void;
  asMcpResource(): {
    uri: 'config://replay-buffer';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => ReplayBufferStats & {
      capacity: number;
      current: number;
      redactFields: string[];
      entries: ReplayBufferEntry[];
    };
  };
}

/**
 * Captures the last N request/response pairs in a rolling in-memory
 * buffer for live inspection. Zero persistence — different from the
 * 1.69 testing.recording (fixture files). Redacts sensitive fields
 * (messages, system, input) by default; can include a truncated
 * preview of the last user message via `includeRedactedPreview: true`.
 * @since 1.75.0
 */
export function replayBuffer(options?: ReplayBufferOptions): ReplayBufferMiddleware;

// ---- Structured output validator (new in 1.76.0) --------------------

export interface StructuredOutputValidatorStats {
  totalValidated:  number;
  valid:           number;
  invalid:         number;
  retries:         number;
  retriesGivenUp:  number;
  invalidStreams:  number;
  skipped:         number;
}

export interface StructuredOutputValidatorOptions {
  /** Static default schema. Used only when no per-request schema is found. */
  schema?:          Record<string, unknown> | null;
  /** Dynamic per-request schema resolver. Return null to fall back to `schema`. */
  schemaFrom?:      ((ctx: MiddlewareContext) => Record<string, unknown> | null | undefined) | null;
  /** Extract the parseable object from the response. Default: result.data → JSON.parse(result.text) → code fence → first-brace-match. */
  extractJson?:     (result: any) => unknown;
  /** Validator function. Default: built-in minimal validator. Return string[] errors OR { ok, errors } shape. */
  validate?:        (obj: unknown, schema: Record<string, unknown>) => string[] | { ok: boolean; errors?: string[] };
  /** What to do on invalid response. Default 'throw'. */
  onInvalid?:       'throw' | 'retry';
  /** Retry attempts when onInvalid='retry'. Default 1. */
  maxRetries?:      number;
  /** Build corrective prompt when retrying. */
  buildCorrection?: (info: { errors: string[]; schema: Record<string, unknown>; rawText: string | null }) => string;
  /** Inject correction into the retry request. Default appends a user message. */
  applyCorrection?: (request: any, correctionText: string) => any;
  /** Validate stream responses via onComplete. Default true. No retry for streams. */
  captureStreams?:  boolean;
  /** Field name to attach the parsed object to on the result. Default 'parsed'. */
  attachParsedAs?:  string;
}

export interface StructuredOutputValidatorMiddleware extends Middleware {
  readonly stats: StructuredOutputValidatorStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://structured-output-validator';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => StructuredOutputValidatorStats & {
      onInvalid:        'throw' | 'retry';
      maxRetries:       number;
      captureStreams:   boolean;
      hasStaticSchema:  boolean;
      hasSchemaFrom:    boolean;
    };
  };
}

export class StructuredOutputInvalidError extends LLMError {
  readonly errors:   string[];
  readonly rawText:  string | null;
  readonly schema:   Record<string, unknown>;
  readonly attempts: number;
}

/**
 * Post-response JSON Schema validator. Rejects (or auto-retries) LLM
 * responses that don't match the declared schema. Complements 1.34
 * `schemas` (pre-built shapes) by enforcing them at the chain level
 * instead of trusting the model to obey `format:`.
 * @since 1.76.0
 */
export function structuredOutputValidator(options?: StructuredOutputValidatorOptions): StructuredOutputValidatorMiddleware;

// ---- Idempotency (new in 1.77.0) -----------------------------------

export interface IdempotencyStats {
  totalRequests:     number;
  hits:              number;
  inFlightCoalesced: number;
  misses:            number;
  rejected:          number;
  evictions:         number;
  streamsBypassed:   number;
  errorsBypassed:    number;
}

export interface IdempotencyOptions {
  /** Completed-cache TTL in ms. Default 60_000 (1 minute). */
  ttlMs?:           number;
  /** LRU max entries. Default 1000. */
  maxSize?:         number;
  /** Hash function used when no explicit key. Default hashes model/messages/system/tools/format/etc. */
  hashOf?:          (ctx: MiddlewareContext) => string;
  /** Explicit key extractor (e.g. Stripe-style Idempotency-Key header). Falsy return → falls back to hashOf. */
  keyFrom?:         ((ctx: MiddlewareContext) => string | null | undefined) | null;
  /** Behavior when a duplicate arrives while the original is still in flight. Default 'coalesce'. */
  onInFlight?:      'coalesce' | 'reject';
  /** Behavior when a duplicate arrives within ttlMs after the original completes. Default 'return'. */
  onDuplicate?:     'return'   | 'reject';
  /** Cache streams too. Default false (streams bypass — each caller gets a fresh iterator). */
  captureStreams?:  boolean;
  /** Clock override for tests. */
  now?:             () => number;
}

export interface IdempotencyMiddleware extends Middleware {
  readonly stats: IdempotencyStats;
  reset(): void;
  size(): number;
  has(key: string): boolean;
  asMcpResource(): {
    uri: 'config://idempotency';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => IdempotencyStats & {
      ttlMs:       number;
      maxSize:     number;
      onInFlight:  'coalesce' | 'reject';
      onDuplicate: 'return' | 'reject';
      current:     number;
    };
  };
}

export class IdempotencyInFlightError extends LLMError {
  readonly key:       string;
  readonly completed: boolean;
}

/**
 * Deduplicates duplicate LLM requests over a short TTL window. Protects
 * against client retries on flaky networks that would otherwise cause
 * double-billing. Different semantics from responseCache (long warm
 * cache) and retryOnRateLimit (auto-retry on server errors).
 * @since 1.77.0
 */
export function idempotency(options?: IdempotencyOptions): IdempotencyMiddleware;

// ---- Batch orchestration helpers (new in 1.79.0) ---------------------

export interface WaitForBatchOptions {
  /** Poll interval between getBatch() calls. Default 30_000ms (30s). */
  pollIntervalMs?: number;
  /** Max wait before giving up. Default 6h. */
  timeoutMs?:      number;
  /** Fired on every poll (including the first). Errors are swallowed. */
  onProgress?:     (status: any) => void | Promise<void>;
  /** Clock override for tests. */
  now?:            () => number;
  /** Delay override for tests. */
  sleep?:          (ms: number) => Promise<void>;
}

export class BatchTimeoutError extends Error {
  readonly batchId:    string;
  readonly elapsedMs:  number;
  readonly lastStatus: string;
}

/**
 * Poll `svc.getBatch(id)` until the batch reaches a terminal state
 * (completed/failed/canceled) or the timeout elapses. Returns the
 * final status object. Reduces boilerplate around the poll-until-done
 * pattern for evals + offline pipelines.
 * @since 1.79.0
 */
export function waitForBatch(svc: any, id: string, opts?: WaitForBatchOptions): Promise<any>;

/**
 * One-shot: submit a batch, wait for completion, return results.
 * Throws if the terminal status is not 'completed'.
 * @since 1.79.0
 */
export function runBatch(svc: any, requests: any[], opts?: WaitForBatchOptions): Promise<any[]>;

// ---- PII redaction (new in 1.80.0) -----------------------------------

export type PiiDetectorName = 'email' | 'phone' | 'ssn' | 'creditCard' | 'iban';

export interface PiiCustomDetector {
  pattern: RegExp;                    // must have global flag
  validate?: (match: string) => boolean;
}

export interface PiiRedactOptions {
  /** Built-in detectors to enable. Default: all. */
  detectors?:       PiiDetectorName[];
  /** Additional custom detectors keyed by name. Patterns MUST have the 'g' flag. */
  customDetectors?: Record<string, PiiCustomDetector>;
  /** Token generator. Default: `<PII_${TYPE}_${index}>`. */
  tokenFor?:        (type: string, index: number) => string;
  /** Request fields to scan. Default ['messages', 'system', 'input']. */
  fields?:          string[];
  /** Un-mask tokens in the response text. Default true (round-trip). */
  unmaskResponse?:  boolean;
  /** Detect streams and skip response un-masking (stats.streamsSkipped++). Default true. */
  captureStreams?:  boolean;
}

export interface PiiRedactStats {
  totalRequests:     number;
  requestsWithPii:   number;
  tokensReplaced:    number;
  responsesUnmasked: number;
  streamsSkipped:    number;
  byType:            Record<string, number>;
}

export interface PiiRedactMiddleware extends Middleware {
  readonly stats: PiiRedactStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://pii-redact';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => PiiRedactStats & {
      detectors:      string[];
      unmaskResponse: boolean;
      captureStreams: boolean;
    };
  };
}

/**
 * Automatic PII masking. Detects emails / phones / SSNs / credit cards /
 * IBANs (and any custom regex) in outbound requests and replaces them
 * with reversible tokens BEFORE the request reaches the provider.
 * Optionally un-masks in the response text for round-trip use.
 * Companion to guardrails (which BLOCKS) — this SANITIZES so calls
 * proceed safely.
 * @since 1.80.0
 */
export function piiRedact(options?: PiiRedactOptions): PiiRedactMiddleware;

export const BUILT_IN_PII_DETECTORS: Record<PiiDetectorName, { pattern: RegExp; validate?: (m: string) => boolean }>;

export function luhnValid(digits: string): boolean;

// ---- Model router (new in 1.81.0) -----------------------------------

export interface ModelRouterMatch {
  method?:        string | string[];
  hasTools?:      boolean;
  hasFormat?:     boolean;
  hasImages?:     boolean;
  hasPdfs?:       boolean;
  hasAudio?:      boolean;
  model?:         string | string[];
  systemContains?: string | RegExp;
  systemMatches?:  RegExp;
  minInputTokens?: number;
  maxInputTokens?: number;
}

export interface ModelRouterRoute {
  model?:       string;
  maxTokens?:   number;
  temperature?: number;
  reason?:      string;
  tags?:        string[];
  [k: string]:  unknown;
}

export interface ModelRouterRule {
  match: ModelRouterMatch | ((ctx: MiddlewareContext) => boolean);
  route: ModelRouterRoute;
}

export interface ModelRouterOptions {
  rules?:     ModelRouterRule[];
  fallback?:  ModelRouterRoute | null;
  onRoute?:   ((info: {
    ruleIndex: number;
    fromModel: string | null;
    toModel:   string | null;
    reason:    string | null;
    tags:      string[] | null;
    method:    string;
  }) => void) | null;
  /** Where to stamp routing meta. 'meta' (default) or 'raw'. */
  exposeMetaOn?: 'meta' | 'raw';
}

export interface ModelRouterStats {
  totalRequests:   number;
  routed:          number;
  unrouted:        number;
  fallbackApplied: number;
  byRuleIndex:     Record<number, number>;
  byModel:         Record<string, number>;
}

export interface ModelRouterMiddleware extends Middleware {
  readonly stats: ModelRouterStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://model-router';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => ModelRouterStats & {
      ruleCount:     number;
      hasFallback:   boolean;
      fallbackModel: string | null;
    };
  };
}

/**
 * Task-aware model routing. Rewrites ctx.request.model (and
 * optionally maxTokens / temperature / any override) based on
 * declarative rules — first match wins. Route embeddings to
 * cheapest, complex reasoning to Opus, simple summarization to
 * Haiku, without call sites hand-picking models.
 * @since 1.81.0
 */
export function modelRouter(options?: ModelRouterOptions): ModelRouterMiddleware;

// ---- Embedding dedup cache (new in 1.82.0) ---------------------------

export interface EmbeddingDedupStore {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown): void | Promise<void>;
  has?(key: string): boolean;
  delete?(key: string): void;
  clear?(): void;
  size?: number | (() => number);
}

export interface EmbeddingDedupOptions {
  /** LRU max entries when using the built-in store. Default 10_000. */
  maxEntries?:     number;
  /** Skip caching texts longer than this. Default 100_000 chars. */
  maxTextLength?:  number;
  /** Normalize text before hashing. Default: trim + collapse whitespace. */
  normalize?:      (text: string) => string;
  /** Hash function producing the cache key. Default: sha256 hex. */
  hash?:           (text: string) => string;
  /** Custom store. Must expose { get, set }. Default: built-in LRU. */
  store?:          EmbeddingDedupStore | null;
}

export interface EmbeddingDedupStats {
  totalRequests:   number;
  totalTexts:      number;
  hits:            number;
  misses:          number;
  allHitRequests:  number;
  skippedTooLong:  number;
}

export interface EmbeddingDedupMiddleware extends Middleware {
  readonly stats: EmbeddingDedupStats;
  reset(): void;
  size(): number;
  clear(): void;
  has(text: string): boolean;
  asMcpResource(): {
    uri: 'config://embedding-dedup';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => EmbeddingDedupStats & {
      maxEntries:    number;
      maxTextLength: number;
      currentSize:   number;
      hitRate:       number;
    };
  };
}

export class EmbeddingLRU implements EmbeddingDedupStore {
  constructor(maxEntries: number);
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

/**
 * Content-addressable cache for `llm.embed({ input })` calls.
 * Normalizes each text, hashes it, looks up the vector. Same text →
 * same vector, no re-embedding. Big saver for RAG pipelines that
 * re-embed the same chunks on every re-index / re-rank / query
 * expansion.
 * @since 1.82.0
 */
export function embeddingDedup(options?: EmbeddingDedupOptions): EmbeddingDedupMiddleware;

// ---- Prompt cache stats (new in 1.83.0) ------------------------------

export type PromptCacheProvider = 'anthropic' | 'openai' | 'deepseek' | 'gemini' | string;

export interface PromptCacheMultipliers {
  creation: number;
  read:     number;
}

export interface PromptCacheStatsOptions {
  /** Per-model pricing (USD per 1M tokens). Defaults to DEFAULT_PRICING. */
  pricing?:          Record<string, { input?: number; output?: number }>;
  /** Per-provider cache multipliers vs normal input price. Default: sensible per provider. */
  cacheMultipliers?: Partial<Record<PromptCacheProvider, Partial<PromptCacheMultipliers>>>;
  /** Called for every cache-active call. Errors swallowed. */
  onCache?:          ((info: {
    provider:       PromptCacheProvider;
    model:          string | null;
    readTokens:     number;
    creationTokens: number;
    normalTokens:   number;
    actualCostUsd:  number;
    savingsUsd:     number;
    method:         string | null;
  }) => void) | null;
  /** Track stream completions via 1.72 onComplete. Default true. */
  captureStreams?:   boolean;
  /** Force a provider instead of auto-detecting from usage shape. */
  provider?:         PromptCacheProvider | null;
}

export interface PromptCacheStatsModelBucket {
  calls:          number;
  readTokens:     number;
  creationTokens: number;
  normalTokens:   number;
  savingsUsd:     number;
  costUsd:        number;
}

export interface PromptCacheStats {
  totalCalls:               number;
  callsWithCache:           number;
  totalCacheReadTokens:     number;
  totalCacheCreationTokens: number;
  totalNormalInputTokens:   number;
  totalSavingsUsd:          number;
  totalCostUsd:             number;
  unpricedCalls:            number;
  byProvider:               Record<string, number>;
  byModel:                  Record<string, PromptCacheStatsModelBucket>;
}

export interface PromptCacheStatsMiddleware extends Middleware {
  readonly stats: PromptCacheStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://prompt-cache-stats';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => PromptCacheStats & {
      hitRate:              number;
      callsWithCacheRatio:  number;
    };
  };
}

/**
 * Surface provider prompt-caching savings — hidden in usage.cache_read_input_tokens
 * (Anthropic), usage.prompt_tokens_details.cached_tokens (OpenAI),
 * usage.prompt_cache_hit_tokens (DeepSeek), usage.cachedContentTokenCount (Gemini)
 * — as ops metrics: hit rate, tokens saved, USD saved, per-model breakdown.
 * @since 1.83.0
 */
export function promptCacheStats(options?: PromptCacheStatsOptions): PromptCacheStatsMiddleware;

export const DEFAULT_CACHE_MULTIPLIERS: Record<PromptCacheProvider, PromptCacheMultipliers>;

// ---- LLM-as-judge helper (new in 1.84.0) -----------------------------

export interface JudgeCriterion {
  name?:        string;
  description:  string;
  weight?:      number;
}

export type JudgeCriteria = string | Array<string | JudgeCriterion>;

export interface JudgeCriterionResult {
  name:        string;
  description: string;
  score:       number;
  rationale:   string;
  passed:      boolean;
}

export interface JudgeResult {
  score:            number;
  verdict:          'pass' | 'fail';
  criteriaResults:  JudgeCriterionResult[];
  overallRationale: string;
  model:            string | null;
  usage:            unknown | null;
  threshold:        number;
  raw:              unknown;
}

export interface LlmJudgeOptions {
  llm?:              { chat: (req: any) => Promise<any> };
  chat?:             (req: any) => Promise<any>;
  criteria:          JudgeCriteria;
  response:          string;
  context?:          string;
  threshold?:        number;
  judgeModel?:       string;
  judgeSystem?:      string;
  judgeTemperature?: number;
  maxTokens?:        number;
}

/**
 * Wrap the standard eval-as-a-judge pattern: define pass/fail criteria
 * in natural language, submit an LLM output for scoring, get back a
 * structured judgment with per-criterion scores, weighted total,
 * verdict, and rationale.
 * @since 1.84.0
 */
export function llmJudge(options: LlmJudgeOptions): Promise<JudgeResult>;

export interface JudgeManyEntry {
  response: string;
  context?: string;
}

export interface JudgeManyOptions extends Omit<LlmJudgeOptions, 'response'> {
  responses:   Array<string | JudgeManyEntry>;
  concurrency?: number;
}

/**
 * Judge N responses against the same criteria in parallel with a
 * concurrency cap. Per-response errors are captured as
 * { verdict: 'error', error: string } — one bad response never
 * fails the whole batch.
 * @since 1.84.0
 */
export function judgeMany(options: JudgeManyOptions): Promise<Array<JudgeResult | { verdict: 'error'; error: string; score: 0 }>>;

export const DEFAULT_JUDGE_SYSTEM: string;

// ---- Auto-continuation (new in 1.85.0) -------------------------------

export interface AutoContinueOptions {
  /** Stop reasons that trigger a continuation. Default ['max_tokens','length','MAX_TOKENS']. */
  triggers?:         string[];
  /** Max continuation attempts per request. Default 3. */
  maxContinuations?: number;
  /** User message appended on continuation. Default: 'Continue from exactly where you left off...' */
  continuePrompt?:   string;
  /** Fired after every continuation. Errors swallowed. */
  onContinue?:       ((info: { attempt: number; triggeredBy: string; addedChars: number; totalChars: number; method: string }) => void) | null;
  /** Fired when the cap is exhausted and response is still truncated. */
  onGiveUp?:         ((info: { finalStopReason: string; attempts: number; method: string }) => void) | null;
  /** Methods to intercept. Default ['chat']. */
  methods?:          string[];
  /** Skip when `format:` is set on the request (structured extraction can't safely concatenate). Default true. */
  skipStructured?:   boolean;
  /** Skip streams. Default true — v1 doesn't auto-continue streams. */
  skipStreams?:      boolean;
}

export interface AutoContinueStats {
  totalRequests:      number;
  requestsContinued:  number;
  totalContinuations: number;
  giveUps:            number;
  byStopReason:       Record<string, number>;
}

export interface AutoContinueMiddleware extends Middleware {
  readonly stats: AutoContinueStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://auto-continue';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => AutoContinueStats & {
      maxContinuations: number;
      triggers:         string[];
      methods:          string[];
      skipStructured:   boolean;
      skipStreams:      boolean;
    };
  };
}

/**
 * Detects responses that were cut off by the provider's maxTokens
 * limit (`stopReason: 'max_tokens' | 'length' | 'MAX_TOKENS'`) and
 * automatically re-invokes the chain with a "continue where you
 * left off" user message, stitching text + summing usage.
 * @since 1.85.0
 */
export function autoContinue(options?: AutoContinueOptions): AutoContinueMiddleware;

// ---- Pre-built dashboards + alert rules (new in 1.87.0) --------------

export interface GrafanaDashboardOptions {
  /** Prometheus datasource UID. Default 'Prometheus'. */
  datasource?: string;
  /** Prometheus `job` label to filter on. Default 'llm'. */
  job?:        string;
}

export interface PrometheusAlertRulesOptions {
  job?: string;
}

export interface DatadogDashboardOptions {
  job?: string;
}

export interface NewRelicDashboardOptions {
  accountId: number | string;
  job?:      string;
}

/**
 * Grafana JSON dashboard model (schemaVersion 41+) matching the
 * shipped `promMetrics` output. Import via Dashboards → New → Import.
 * @since 1.87.0
 */
export function grafanaDashboard(options?: GrafanaDashboardOptions): Record<string, unknown>;

/**
 * Prometheus alert rules covering budget exhaustion, breaker open,
 * high error rate, bulkhead saturation, rate-limit give-ups, and
 * provider health probes.
 * @since 1.87.0
 */
export function prometheusAlertRules(options?: PrometheusAlertRulesOptions): { groups: Array<{ name: string; interval: string; rules: Array<Record<string, unknown>> }> };

/**
 * Datadog dashboard JSON matching the shipped promMetrics output
 * (metric names converted to Datadog dot-namespaced form).
 * @since 1.87.0
 */
export function datadogDashboard(options?: DatadogDashboardOptions): Record<string, unknown>;

/**
 * New Relic dashboard using NRQL queries. Requires an account id
 * because NRQL queries are account-scoped.
 * @since 1.87.0
 */
export function newrelicDashboard(options: NewRelicDashboardOptions): Record<string, unknown>;

// ---- Content safety classifier (new in 1.88.0) -----------------------

export interface SafetyClassifierOptions {
  /** OpenAI API key. Omit to skip moderation calls (Anthropic refusal detection still works). */
  apiKey?:              string | null;
  /** Moderation endpoint. Default OpenAI's `/v1/moderations`. */
  moderationEndpoint?:  string;
  /** Moderation model. Default 'omni-moderation-latest'. */
  moderationModel?:     string;
  /** Score >= threshold trips. Default 0.5. */
  threshold?:           number;
  /** 'block' throws SafetyClassifierBlockedError; 'flag' logs + passes through. Default 'block'. */
  action?:              'block' | 'flag';
  /** Restrict to specific categories. Default null = all. */
  categories?:          string[] | null;
  /** Also scan user input before the provider call. Default false. */
  checkInput?:          boolean;
  /** Scan the LLM output. Default true. */
  checkOutput?:         boolean;
  /** Methods to skip. Default ['embed']. */
  skipMethods?:         string[];
  /** Fired on every flag (both block and flag modes). Errors swallowed. */
  onFlag?:              ((info: { source: string; categories: string[]; scores: any; method: string; action: 'block' | 'flag'; streamMode: boolean }) => void) | null;
  /** fetch override for tests / custom transports. */
  fetch?:               typeof globalThis.fetch;
  /** Handle streams via 1.72 onComplete. Default true. Streams are always flag-only. */
  captureStreams?:      boolean;
}

export interface SafetyClassifierStats {
  totalChecks:      number;
  moderationCalls:  number;
  moderationErrors: number;
  flagged:          number;
  blocked:          number;
  refusals:         number;
  bySource:         Record<string, number>;
  byCategory:       Record<string, number>;
}

export interface SafetyClassifierMiddleware extends Middleware {
  readonly stats: SafetyClassifierStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://safety-classifier';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => SafetyClassifierStats & {
      threshold:       number;
      action:          'block' | 'flag';
      checkInput:      boolean;
      checkOutput:     boolean;
      hasApiKey:       boolean;
      moderationModel: string;
      categories:      string[] | '(all)';
    };
  };
}

export class SafetyClassifierBlockedError extends LLMError {
  readonly reason:     string;
  readonly categories: string[];
  readonly scores:     Record<string, number> | null;
  readonly source:     'anthropic-refusal' | 'openai-moderation';
}

/**
 * Content safety classifier. Detects unsafe LLM output via OpenAI's
 * Moderation API (free, per-category classification) + Anthropic's
 * built-in safety refusals (via stopReason='refusal', no extra call).
 * Complements guardrails (regex + PII) and promptInjectionGuard
 * (attack-pattern detection) with true model-based classification.
 * @since 1.88.0
 */
export function safetyClassifier(options?: SafetyClassifierOptions): SafetyClassifierMiddleware;

// ---- Prompt regression detector (new in 1.89.0) ----------------------

export interface RegressionFixture {
  name?:     string;
  path?:     string;
  request: {
    system?:   string;
    messages:  Array<any>;
    maxTokens?: number;
    format?:   Record<string, unknown>;
    [k: string]: unknown;
  };
  criteria:  JudgeCriteria;
  context?:  string;
  threshold?: number;
}

export interface RegressionResult {
  name:              string;
  verdict:           'pass' | 'fail' | 'error';
  score:             number;
  criteriaResults?:  JudgeCriterionResult[];
  overallRationale?: string;
  response?:         string;
  error?:            string;
  durationMs:        number;
}

export interface RegressionReport {
  total:    number;
  passed:   number;
  failed:   number;
  errors:   number;
  passRate: number;
  results:  RegressionResult[];
}

export interface PromptRegressionOptions {
  llm?:              { chat: (req: any) => Promise<any> };
  chat?:             (req: any) => Promise<any>;
  fixtures:          RegressionFixture[];
  judgeLlm?:         { chat: (req: any) => Promise<any> };
  judgeChat?:        (req: any) => Promise<any>;
  judgeModel?:       string;
  judgeSystem?:      string;
  judgeTemperature?: number;
  concurrency?:      number;
  onProgress?:       (info: RegressionResult & { index: number; total: number }) => void | Promise<void>;
  defaultThreshold?: number;
}

/**
 * Given a folder of fixture files (or an array of in-memory
 * fixtures), runs each prompt through the LLM, uses llmJudge (1.84)
 * to score against criteria, and aggregates a pass/fail report.
 * Perfect for CI eval loops that catch prompt regressions.
 * @since 1.89.0
 */
export function promptRegression(options: PromptRegressionOptions): Promise<RegressionReport>;

/**
 * Read every .json file in `dir`, parse, tag each with .name
 * (from filename if not present) + .path. Non-JSON files are
 * silently skipped. Deterministic order (alphabetical by name).
 * @since 1.89.0
 */
export function loadFixtures(dir: string): RegressionFixture[];

/**
 * Render a RegressionReport as a human-readable multi-line string.
 * Optional colors:true for ANSI escape codes.
 * @since 1.89.0
 */
export function formatRegressionReport(report: RegressionReport, options?: { colors?: boolean }): string;

// ---- RAG orchestration helper (new in 1.90.0) ------------------------

export interface RagChunk {
  id?:        string | number;
  text:       string;
  score?:     number;
  metadata?:  Record<string, unknown>;
  [k: string]: unknown;
}

export interface RagResult {
  answer:         string;
  chunks:         RagChunk[];
  retrievedCount: number;
  dedupedCount:   number;
  queriesUsed:    string[];
  usage:          unknown | null;
  model:          string | null;
}

export interface RagChainOptions {
  llm?:              { chat: (req: any) => Promise<any> };
  chat?:             (req: any) => Promise<any>;
  retriever:         (query: string, opts: { topK?: number; filter?: unknown }) => Promise<RagChunk[]> | RagChunk[];
  reranker?:         ((query: string, chunks: RagChunk[]) => Promise<RagChunk[]> | RagChunk[]) | null;
  queryExpander?:    ((query: string) => Promise<string[]> | string[]) | null;
  systemPrompt?:     string;
  template?:         (info: { question: string; context: string; chunks: RagChunk[] }) => string;
  defaultTopK?:      number;
  maxChunks?:        number;
  maxCharsPerChunk?: number;
  defaultMaxTokens?: number;
  onEmptyRetrieval?: 'error' | 'answer-anyway' | ((question: string) => RagResult | Promise<RagResult>);
}

export type RagChainAsk = (question: string, opts?: { topK?: number; filter?: unknown; maxTokens?: number }) => Promise<RagResult>;

/**
 * Build a retrieve → dedupe → optional-rerank → truncate → answer
 * pipeline. Returns an `ask(question, opts?)` function. Encapsulates
 * the boilerplate that RAG actions all reimplement.
 * @since 1.90.0
 */
export function ragChain(options: RagChainOptions): RagChainAsk;

export const DEFAULT_RAG_SYSTEM: string;

// ---- Compact-history middleware (new in 1.91.0) ----------------------

export interface CompactHistoryOptions {
  /** Compact when messages.length > this. Default 20. */
  maxMessages?:      number;
  /** How many recent messages to keep verbatim. Default 6. Must be < maxMessages. */
  keepRecent?:       number;
  /** Custom summarizer. Receives (oldMessages, ctx). Return non-empty string on success. */
  summarizer?:       ((oldMessages: any[], ctx: MiddlewareContext) => Promise<string> | string) | null;
  /** LLMService for the DEFAULT summarizer (used when no custom summarizer provided). */
  llm?:              { chat: (req: any) => Promise<any> };
  /** Raw chat function for the default summarizer. */
  chat?:             (req: any) => Promise<any>;
  /** Model override for the default summarizer's LLM call. Cheap+fast recommended. */
  summaryModel?:     string;
  /** System prompt for the default summarizer. */
  summarySystem?:    string;
  /** User prompt prefix (before dumped messages). */
  summaryPrompt?:    string;
  /** Prefix on the synthetic assistant summary message. Default '[EARLIER CONVERSATION SUMMARY]'. */
  summaryPrefix?:    string;
  /** maxTokens for the summary call. Default 500. */
  summaryMaxTokens?: number;
  /** Methods to skip. Default ['embed', 'stream']. */
  skipMethods?:      string[];
  /** Fired on every successful compaction. Errors swallowed. */
  onCompact?:        ((info: {
    method:         string;
    originalCount:  number;
    removedCount:   number;
    keptCount:      number;
    summaryChars:   number;
    finalCount:     number;
  }) => void) | null;
  /** Fired when the summarizer throws. */
  onError?:          ((info: { err: Error; method: string; oldMessagesCount: number }) => void) | null;
}

export interface CompactHistoryStats {
  totalRequests:             number;
  compacted:                 number;
  skipped:                   number;
  summarizerErrors:          number;
  totalMessagesRemoved:      number;
  totalMessagesReplacedWith: number;
}

export interface CompactHistoryMiddleware extends Middleware {
  readonly stats: CompactHistoryStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://compact-history';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => CompactHistoryStats & {
      maxMessages:         number;
      keepRecent:          number;
      summaryModel:        string | null;
      summaryMaxTokens:    number;
      hasCustomSummarizer: boolean;
    };
  };
}

/**
 * When messages.length > maxMessages, summarizes the oldest portion
 * via an LLM call and replaces it with a compact synthetic exchange —
 * keeping the recent keepRecent messages verbatim. Bounded context
 * spend for long-running agent conversations.
 * @since 1.91.0
 */
export function compactHistory(options?: CompactHistoryOptions): CompactHistoryMiddleware;

export const DEFAULT_COMPACT_SUMMARY_SYSTEM: string;

// ---- Distributed lock middleware (new in 1.92.0) ----------------------

export interface DistributedLockStore {
  acquire(key: string, ttlMs: number): Promise<string | null> | (string | null);
  release(key: string, token: string): Promise<boolean> | boolean;
  size?: number | (() => number);
  clear?: () => void;
}

export class InMemoryLockStore implements DistributedLockStore {
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<boolean>;
  size(): number;
  clear(): void;
}

export interface DistributedLockOptions {
  store:          DistributedLockStore;
  keyOf:          (ctx: MiddlewareContext) => string | null | undefined;
  ttlMs?:         number;
  action?:        'wait' | 'reject';
  waitTimeoutMs?: number;
  waitPollMs?:    number;
  skipMethods?:   string[];
  onAcquire?:     ((info: { key: string; method: string; ttlMs: number; token: string }) => void) | null;
  onWait?:        ((info: { key: string; method: string; waitTimeoutMs: number; waitPollMs: number }) => void) | null;
  onReject?:      ((info: { key: string; method: string }) => void) | null;
  onRelease?:     ((info: { key: string; method: string; released: boolean }) => void) | null;
  now?:           () => number;
  sleep?:         (ms: number) => Promise<void>;
}

export interface DistributedLockStats {
  totalRequests: number;
  acquired:      number;
  rejected:      number;
  timedOut:      number;
  waited:        number;
  totalWaitMs:   number;
  released:      number;
  releaseErrors: number;
  skipped:       number;
}

export interface DistributedLockMiddleware extends Middleware {
  readonly stats: DistributedLockStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://distributed-lock';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => DistributedLockStats & {
      ttlMs:         number;
      action:        'wait' | 'reject';
      waitTimeoutMs: number;
      waitPollMs:    number;
      storeType:     string;
      currentHeld:   number | null;
    };
  };
}

export class DistributedLockHeldError extends LLMError {
  readonly key: string;
}

export class DistributedLockTimeoutError extends LLMError {
  readonly key:      string;
  readonly waitedMs: number;
}

/**
 * Ensures only ONE instance of a multi-replica deployment executes a
 * specific key at a time. Redis/HANA-backed exclusive lock (bring your
 * own store implementing `{ acquire, release }`; a dev-only
 * InMemoryLockStore is bundled). Prevents duplicate execution across
 * pods for expensive operations (batch runs, cache warming,
 * tenant-scoped context builds). Companion to bulkhead (per-instance
 * concurrency) and idempotency (per-request dedup).
 * @since 1.92.0
 */
export function distributedLock(options: DistributedLockOptions): DistributedLockMiddleware;

// ---- Enhanced OTel spans middleware (new in 1.93.0) -------------------

export interface OtelSpansOptions {
  /** OTel tracer (duck-typed against @opentelemetry/api). Required. */
  tracer:            { startSpan: (name: string) => any };
  /** Span name prefix. Default 'llm.'. */
  spanNamePrefix?:   string;
  /** Static value for `gen_ai.system` attribute (e.g. 'anthropic', 'openai'). */
  systemAttribute?:  string | null;
  /** Compute + emit cost attributes via pricing table. Default true. */
  costs?:            boolean;
  /** Pricing override. Defaults to shipped DEFAULT_PRICING. */
  pricing?:          Record<string, { input?: number; output?: number }>;
  /** Emit `llm.correlation_id` from ctx.meta.correlationId (1.64). Default true. */
  correlation?:      boolean;
  /** Emit `llm.routing.*` attrs from ctx.meta.routed (1.81). Default true. */
  routing?:          boolean;
  /** Emit `llm.error.code / .primitive / .retriable` on LLMError. Default true. */
  errorTaxonomy?:    boolean;
  /** Emit `llm.cache.hit` + `llm.cache.source` (response-cache / prompt-cache-*). Default true. */
  cacheAttribution?: boolean;
  /** Custom span enricher fired after response attrs are set. Errors swallowed. */
  enrich?:           ((ctx: MiddlewareContext, result: any, span: any) => void) | null;
}

/**
 * Enhanced OTel spans middleware — 2nd-gen enrichment of the shipped
 * 1.3 `otel` middleware. Adds:
 *   - Cost attributes via pricing table
 *   - Correlation ID from ctx.meta (traceCorrelation 1.64)
 *   - Routing meta from ctx.meta.routed (modelRouter 1.81)
 *   - Error taxonomy on LLMError (1.57)
 *   - Cache source attribution (response-cache vs prompt-cache-*)
 *   - Stream completion tracking (1.72)
 *   - Custom enrich callback
 *
 * Duck-typed against `@opentelemetry/api` — no hard dep.
 * @since 1.93.0
 */
export function otelSpans(options: OtelSpansOptions): Middleware;

// ---- Retry-after propagation (new in 1.94.0) -------------------------

export interface RetryAfterPropagationOptions {
  /** Force a specific provider instead of auto-detecting from headers. */
  provider?:        'openai' | 'anthropic' | 'gemini' | 'bedrock' | string | null;
  /** Override parsers by provider key. Default: shipped 4-provider set. */
  parsers?:         Record<string, (headers: unknown, status?: number) => any>;
  /** Fires when a retry hint is captured. Errors swallowed. */
  onCapture?:       ((info: {
    provider:      string;
    retryAfterMs:  number | undefined;
    resetAtMs:     number | undefined;
    rateLimit:     any;
    errorCode:     string | null;
  }) => void) | null;
  /** If no provider detected and no hint parsed, apply this default (ms). */
  fallbackRetryMs?: number | null;
}

export interface RetryAfterPropagationStats {
  totalErrors:     number;
  hintsCaptured:   number;
  unknownProvider: number;
  fallbackApplied: number;
  byProvider:      Record<string, number>;
}

export interface RetryAfterPropagationMiddleware extends Middleware {
  readonly stats: RetryAfterPropagationStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://retry-after-propagation';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => RetryAfterPropagationStats & {
      provider:            string | null;
      fallbackRetryMs:     number | null;
      supportedProviders:  string[];
    };
  };
}

/**
 * Enriches outbound errors with `retryAfterMs` + `resetAtMs` fields
 * parsed from provider rate-limit headers (using shipped 1.38+
 * parsers). Complements `retryOnRateLimit` (1.47): that middleware
 * WAITS + retries internally; this one SURFACES the retry hint to
 * the caller when the internal retry gives up or is disabled.
 * @since 1.94.0
 */
export function retryAfterPropagation(options?: RetryAfterPropagationOptions): RetryAfterPropagationMiddleware;

// ---- Chain snapshot for GitOps (new in 1.95.0) -----------------------

export interface ChainSnapshotEntry {
  position: number;
  kind:     string;
  config?:  Record<string, unknown>;
}

export interface ChainSnapshotResult {
  generatedAt:   string;
  order:         ChainSnapshotEntry[];
  version?:      string;
  unknownCount?: number;
}

export interface ChainSnapshotOptions {
  /** Custom URI → kind overrides for non-shipped middleware. */
  kindMap?:        Record<string, string>;
  /** Custom config extractor. Return only the fields you want to persist. */
  extractConfig?:  (payload: any, mw: any) => Record<string, unknown> | null;
  /** Keep counter fields in the config. Default false (strip for stable diffing). */
  includeStats?:   boolean;
  /** Include plugin version in the snapshot. Default true. */
  includeVersion?: boolean;
  /** Override plugin version (test-only). */
  versionSource?:  string;
}

/**
 * Walks a live LLMService's middleware array and emits the
 * `{ order: [{ position, kind, config }] }` shape consumed by
 * chainDiff (1.73) + validateMiddlewareOrder (1.48). Enables
 * GitOps workflows: commit a baseline snapshot, diff against
 * live on every deploy, fail CI when the chain drifts.
 * @since 1.95.0
 */
export function chainSnapshot(llm: { middleware: any[] }, options?: ChainSnapshotOptions): ChainSnapshotResult;

/** URI → kind lookup for shipped middleware. */
export const URI_TO_KIND: Readonly<Record<string, string>>;

/** Stats field names stripped by chainSnapshot's default `extractConfig`. */
export const KNOWN_STATS_FIELDS: ReadonlySet<string>;

// ---- Sensitive-data audit trail (new in 1.96.0) ----------------------

export interface AuditEntry {
  sequence:      number;
  timestamp:     string;
  method:        string;
  model:         string | null;
  correlationId: string | null;
  piiCategories: string[];
  piiCount:      number;
  requestChars:  number;
  responseChars: number;
  usage:         unknown | null;
  prevHash:      string | null;
  hash:          string;
  requestPreview?:  string;
  responsePreview?: string;
  [customField: string]: unknown;
}

export interface AuditStore {
  append(entry: AuditEntry): void | Promise<void>;
  list?(opts?: { limit?: number; since?: string | number }): Promise<AuditEntry[]>;
  size?: number | (() => number);
  clear?(): void;
}

export class InMemoryAuditStore implements AuditStore {
  constructor(maxEntries?: number);
  append(entry: AuditEntry): Promise<void>;
  list(opts?: { limit?: number; since?: string | number }): Promise<AuditEntry[]>;
  size(): number;
  clear(): void;
  latest(): AuditEntry | null;
}

export interface AuditDetectionResult {
  categories: string[];
  count:      number;
}

export interface SensitiveDataAuditOptions {
  store:          AuditStore;
  trigger?:       'pii-detected' | 'always' | ((ctx: MiddlewareContext, result: any) => boolean);
  detector?:      ((ctx: MiddlewareContext, result: any) => AuditDetectionResult) | null;
  activeDetectors?: Record<string, { pattern: RegExp; validate?: (m: string) => boolean }>;
  includePayload?: boolean;
  previewChars?:   number;
  redactPayload?:  boolean;
  chained?:        boolean;
  enrich?:         ((ctx: MiddlewareContext, result: any) => Record<string, unknown> | null | undefined) | null;
  skipMethods?:    string[];
  onAudit?:        ((entry: AuditEntry) => void) | null;
  onError?:        ((info: { err: Error; phase: 'build' | 'append'; entry?: AuditEntry }) => void) | null;
}

export interface SensitiveDataAuditStats {
  totalRequests: number;
  audited:       number;
  skipped:       number;
  piiDetected:   number;
  storeErrors:   number;
  lastSequence:  number;
  lastHash:      string | null;
}

export interface SensitiveDataAuditMiddleware extends Middleware {
  readonly stats: SensitiveDataAuditStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://sensitive-data-audit';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => SensitiveDataAuditStats & {
      trigger:        string | Function;
      includePayload: boolean;
      chained:        boolean;
      redactPayload:  boolean;
      previewChars:   number;
    };
  };
}

/**
 * Persists an immutable, hash-chained audit log of every LLM call
 * containing PII (or matching a custom trigger). Compliance
 * requirement for GDPR / SOX / HIPAA workloads. Each entry is
 * chained to the previous — insertion / deletion / tampering are
 * detectable via `verifyAuditChain(entries)`.
 * @since 1.96.0
 */
export function sensitiveDataAudit(options: SensitiveDataAuditOptions): SensitiveDataAuditMiddleware;

/**
 * Verifies a chain of audit entries produced by sensitiveDataAudit.
 * Returns { ok, brokenAt: index|null, reason }.
 * @since 1.96.0
 */
export function verifyAuditChain(entries: AuditEntry[]): { ok: boolean; brokenAt: number | null; reason: string | null };

/**
 * Computes the canonical sha256 hash of an audit entry (excluding
 * the `hash` field itself). Used internally to build + verify chains;
 * exported so custom stores can recompute + validate.
 * @since 1.96.0
 */
export function hashAuditEntry(entry: Omit<AuditEntry, 'hash'>): string;

// ---- Streaming token throttler (new in 1.97.0) -----------------------

export interface StreamThrottleOptions {
  /** Target emission rate. Default 50. */
  maxTokensPerSecond?: number;
  /** Count tokens per chunk. Default: chunk.text.length / 4. */
  countTokens?:        (chunk: any) => number;
  /** Methods to skip (bypass throttling). Default ['chat', 'embed', 'batch']. */
  skipMethods?:        string[];
  /** Fired on every non-zero delay. Errors swallowed. */
  onDelay?:            ((info: { delayMs: number; tokensEmitted: number; tokensThisChunk: number }) => void) | null;
  /** Clock override for tests. */
  now?:                () => number;
  /** Delay override for tests. */
  sleep?:              (ms: number) => Promise<void>;
}

export interface StreamThrottleStats {
  totalStreams:   number;
  totalChunks:    number;
  totalTokens:    number;
  totalDelayMs:   number;
  skippedStreams: number;
}

export interface StreamThrottleMiddleware extends Middleware {
  readonly stats: StreamThrottleStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://stream-throttle';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => StreamThrottleStats & {
      maxTokensPerSecond: number;
      msPerToken:         number;
      skipMethods:        string[];
    };
  };
}

/**
 * Rate-limits stream chunk emission for smooth UI cursor. Some
 * providers (Groq, DeepSeek) emit tokens in tight bursts of 200+
 * tok/sec then pause — throttling to 30-50 tok/sec matches natural
 * reading speed. Only affects `stream` method; other methods pass
 * through. Preserves the 1.72 stream completion tracker.
 * @since 1.97.0
 */
export function streamThrottle(options?: StreamThrottleOptions): StreamThrottleMiddleware;

// ---- Prompt template linter (new in 1.98.0) ---------------------------

export interface LintIssue {
  code:    string;
  line:    number;
  col:     number;
  message: string;
  fixit:   string;
}

export interface LintReport {
  ok:       boolean;
  errors:   LintIssue[];
  warnings: LintIssue[];
  info:     LintIssue[];
  stats: {
    chars:              number;
    lines:              number;
    tokens:             number;
    variablesUsed:      string[];
    variablesDeclared:  string[];
  };
}

export interface LintOptions {
  variables?:         Record<string, unknown> | null;
  maxTokens?:         number | null;
  forbidden?:         string[];
  injectionPatterns?: Array<{ re: RegExp; name: string }>;
  ignore?:            string[];
  noDuplicateLines?:  boolean;
}

export interface LintBatchReport {
  ok:       boolean;
  byName:   Record<string, LintReport>;
  summary: {
    promptCount:   number;
    totalErrors:   number;
    totalWarnings: number;
  };
}

/**
 * Static analysis for prompt templates. Catches common issues:
 * missing / stale {{var}} substitutions, malformed variables, mixed
 * indentation, trailing whitespace, prompt-injection patterns in
 * the system prompt itself, role markers, forbidden phrases, overly
 * long prompts. Companion to promptRegression (1.89) — this catches
 * TEMPLATE issues (static), that catches BEHAVIORAL drift (dynamic).
 * @since 1.98.0
 */
export function lintPrompt(text: string, options?: LintOptions): LintReport;

/**
 * Batch variant. Lints an object of { name: text } prompts and
 * aggregates results.
 * @since 1.98.0
 */
export function lintPrompts(prompts: Record<string, string>, options?: LintOptions): LintBatchReport;

/**
 * Render a LintReport (or LintBatchReport) as a human-readable
 * multi-line string. Optional colors:true for ANSI escape codes.
 * @since 1.98.0
 */
export function formatLintReport(
  report: LintReport | LintBatchReport,
  options?: { colors?: boolean },
): string;

export const KNOWN_LINT_RULES: ReadonlySet<string>;
export const DEFAULT_INJECTION_PATTERNS: Array<{ re: RegExp; name: string }>;

// ---- Multi-region failover (new in 1.99.0) ---------------------------

export interface Region {
  name:    string;
  service: { chat: (req: any) => Promise<any> };
}

export interface RegionFailoverOptions {
  regions:              Region[];
  allowedRegions?:      string[] | null;
  isFallback?:          (err: any) => boolean;
  perRegionTimeoutMs?:  number | null;
  unhealthyCooldownMs?: number;
  onFailover?:          ((info: { from: string; to: string | null; error: Error; attempt: number; durationMs: number }) => void) | null;
  onSelected?:          ((info: { region: string; attempt: number; ofCandidates: number }) => void) | null;
  now?:                 () => number;
}

export interface RegionFailoverAttempt {
  region:      string;
  ok:          boolean;
  error?:      string;
  durationMs:  number;
}

export interface RegionFailoverStats {
  totalRequests:      number;
  successful:         number;
  failed:             number;
  failoversPerformed: number;
  byRegionSuccess:    Record<string, number>;
  byRegionFailure:    Record<string, number>;
  filteredResidency:  number;
}

export interface RegionFailoverInstance {
  chat(request: any): Promise<any & { region: string; attempts: RegionFailoverAttempt[] }>;
  readonly stats: RegionFailoverStats;
  reset(): void;
  unhealthySnapshot(): Record<string, { unhealthyUntilMs: number; msRemaining: number }>;
  markRegionUnhealthy(name: string, ttlMs?: number): void;
  clearRegionHealth(name: string): void;
  asMcpResource(): {
    uri: 'config://region-failover';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => RegionFailoverStats & {
      regionCount:         number;
      allowedRegions:      string[] | null;
      perRegionTimeoutMs:  number | null;
      unhealthyCooldownMs: number;
      currentUnhealthy:    string[];
    };
  };
}

export class AllRegionsFailedError extends LLMError {
  readonly attempts: RegionFailoverAttempt[];
  readonly cause:    Error;
}

/**
 * Multi-region failover. Routes LLM calls to the nearest healthy
 * region with automatic failover on breaker-open / 5xx / network
 * errors. Extends chatWithFallback (1.50) with geographic awareness
 * — per-provider fallback happens INSIDE each region's chain; this
 * handles per-region fallback across regions. Data-residency
 * configurable via allowedRegions (GDPR / SOC / etc.).
 * @since 1.99.0
 */
export function regionFailover(options: RegionFailoverOptions): RegionFailoverInstance;

// ---- Git-backed prompt registry (new in 2.1.0) ------------------------

export interface GitPromptRegistryOptions {
  /** Repository URL (https, ssh, or local path). Required. */
  url:        string;
  /** Branch to track. Default 'main'. Overridden by ref when both set. */
  branch?:    string;
  /** Explicit git ref (tag, branch, sha). Overrides branch when non-null. */
  ref?:       string | null;
  /** Local cache directory. Default: /tmp/saptarishi-git-prompts-<hash>. */
  dir?:       string | null;
  /** Subdirectory within the repo. Default '.'. */
  subdir?:    string;
  /** Poll interval ms (>=1000). null disables. */
  pollMs?:    number | null;
  /** Timeout per git command in ms. Default 30_000. */
  timeoutMs?: number;
  /** Git runner (dependency-injected for tests). Default: shell out to `git`. */
  runner?:    (args: string[], cwd?: string, timeoutMs?: number) => string;
  /** Fires when a pull surfaces a new SHA. Errors swallowed. */
  onChange?:  ((info: { from: string | null; to: string; refreshedAt: string }) => void) | null;
  /** Fires on pull failures. Errors swallowed. */
  onError?:   ((err: Error) => void) | null;
}

export interface GitPromptRegistryStats {
  loads:            number;
  pullSuccesses:    number;
  pullErrors:       number;
  changesDetected:  number;
  lastError:        string | null;
  lastSha:          string | null;
  lastPullAt:       string | null;
}

export interface GitPromptRegistryInstance extends PromptRegistry {
  readonly sha:         string | null;
  readonly refreshedAt: string | null;
  readonly cacheDir:    string;
  readonly templateDir: string | null;
  readonly stats:       GitPromptRegistryStats;
  refresh(): Promise<void>;
  pull():    Promise<string>;
  stop():    void;
  asMcpResource(): {
    uri: 'config://git-prompt-registry';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => GitPromptRegistryStats & {
      url:        string;
      branch:     string;
      ref:        string;
      subdir:     string;
      pollMs:     number | null;
      cacheDir:   string;
      currentSha: string | null;
      refreshedAt: string | null;
    };
  };
}

/**
 * Build a PromptRegistry backed by a Git repository. Clones (if needed),
 * checks out the requested ref, loads every prompt file in `subdir`
 * (default: root), and optionally polls the remote for updates.
 * Enables prompt-as-code workflows where prompt changes go through PR
 * review, separately from code deploys. Composes with lintPrompt (1.98)
 * + promptRegression (1.89) for the full prompt CI loop.
 * @since 2.1.0
 */
export function gitPromptRegistry(options: GitPromptRegistryOptions): Promise<GitPromptRegistryInstance>;

// ---- Cost forecasting (new in 2.2.0) ---------------------------------

export interface CostForecastProjection {
  spentInWindowUsd:  number;
  windowSpanMs:      number;
  windowMs:          number;
  projectedUsd:      number;
  targetUsd:         number;
  utilizationRatio:  number;
  sampleCount:       number;
  currency:          string;
}

export interface CostForecastOptions {
  windowMs?:         number;
  targetUsd:         number;
  warnAtRatio?:      number;
  criticalAtRatio?:  number;
  minSampleSize?:    number;
  pricing?:          Record<string, { input?: number; output?: number }>;
  currency?:         string;
  onWarn?:           ((info: { projection: CostForecastProjection; model?: string; method?: string; tenant?: string | null }) => void) | null;
  onCritical?:       ((info: { projection: CostForecastProjection; model?: string; method?: string; tenant?: string | null }) => void) | null;
  onSpend?:          ((info: { costUsd: number; model?: string; method?: string; tenant?: string | null; projection: CostForecastProjection | null; level: 'ok' | 'warn' | 'critical' }) => void) | null;
  now?:              () => number;
  skipMethods?:      string[];
}

export interface CostForecastStats {
  totalCalls:      number;
  totalUsd:        number;
  sampleCount:     number;
  lastProjection:  CostForecastProjection | null;
  lastLevel:       'ok' | 'warn' | 'critical';
  warnFires:       number;
  criticalFires:   number;
  unpricedCalls:   number;
}

export interface CostForecastMiddleware extends Middleware {
  readonly stats: CostForecastStats;
  reset(): void;
  projection(): CostForecastProjection | null;
  asMcpResource(): {
    uri: 'config://cost-forecast';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => CostForecastStats & {
      windowMs:        number;
      targetUsd:       number;
      currency:        string;
      warnAtRatio:     number;
      criticalAtRatio: number;
      minSampleSize:   number;
      currentLevel:    'ok' | 'warn' | 'critical';
      projection:      CostForecastProjection | null;
    };
  };
}

/**
 * Rolling-window spend tracker with end-of-window projection. Emits
 * onWarn / onCritical events when projected spend crosses threshold
 * ratios — the "you'll hit the limit at 2:47pm" companion to
 * costBudget (hard ceiling) and costGuard (per-call limit).
 * @since 2.2.0
 */
export function costForecast(options: CostForecastOptions): CostForecastMiddleware;

// ---- Provider capability probe (new in 2.3.0) ------------------------

export type ProviderKind =
  | 'anthropic' | 'openai-compatible' | 'azure-openai'
  | 'groq' | 'deepseek' | 'fireworks' | 'mistral'
  | 'gemini' | 'bedrock' | 'ollama' | 'genai-hub'
  | string;

export interface ProviderCapabilities {
  chat:              boolean;
  stream:            boolean;
  embed:             boolean;
  batch:             boolean;
  vision:            boolean;
  pdf:               boolean;
  audio:             boolean;
  tools:             boolean;
  structuredOutput:  boolean;
  promptCache:       boolean;
  maxContextTokens:  number | null;
  maxOutputTokens:   number | null;
}

export interface CapabilityLiveProbeResult {
  name:  string;
  ok:    boolean;
  error: string | null;
}

export interface CapabilityReport extends ProviderCapabilities {
  provider: ProviderKind | null;
  model:    string | null;
  live: {
    ran:    boolean;
    probes: CapabilityLiveProbeResult[];
  };
}

export interface CapabilityOptions {
  /** When true, issue small verification calls to confirm static assumptions. Default false. */
  live?:           boolean;
  /** Per-probe timeout in ms. Default 8000. */
  timeoutMs?:      number;
  /** Which live checks to run. Default ['chat', 'embed', 'structuredOutput']. */
  probes?:         Array<'chat' | 'embed' | 'structuredOutput' | 'tools'>;
  /** Override the provider matrix (advanced). Default: shipped PROVIDER_CAPABILITY_MATRIX. */
  matrix?:         Record<string, ProviderCapabilities>;
  /** Additional model-specific overrides. Default: shipped MODEL_CAPABILITY_OVERRIDES. */
  modelOverrides?: Record<string, Partial<ProviderCapabilities>>;
}

/**
 * Probe a live LLMService for its capabilities. Static mode (default)
 * reads only class shape + configured kind + modelId. Live mode
 * (`live: true`) additionally issues small verification calls to
 * confirm each assumption. Fills the "which providers support what"
 * matrix without hand-maintained tables. Composes with modelRouter
 * (1.81) — route requests to the FIRST service whose capabilities
 * say it supports the feature.
 * @since 2.3.0
 */
export function capabilities(llm: unknown, opts?: CapabilityOptions): Promise<CapabilityReport>;

/** Provider-family capability matrix. Frozen. Deep-clone before mutating. */
export const PROVIDER_CAPABILITY_MATRIX: Readonly<Record<ProviderKind, ProviderCapabilities>>;

/** Model-specific overrides. Applied after the family matrix. */
export const MODEL_CAPABILITY_OVERRIDES: Readonly<Record<string, Partial<ProviderCapabilities>>>;

// ---- Structured response scoring (new in 2.4.0) ----------------------

export type ScoreCheckKind =
  | 'contains' | 'not-contains'
  | 'regex' | 'not-regex'
  | 'json' | 'json-schema'
  | 'word-count-range' | 'char-count-range' | 'sentence-count-range'
  | 'no-hallucinated-numbers'
  | 'starts-with' | 'ends-with'
  | 'one-of';

export interface ScoreRubricCriterion {
  /** Display name. Default: 'criterion-<i+1>'. */
  name?:             string;
  /** Weight for the weighted score aggregate. Default 1. */
  weight?:           number;
  /** Check to run. String kind (see ScoreCheckKind) or a function. */
  check:             ScoreCheckKind | ((text: string, ctx: Record<string, unknown>, response: unknown) => { ok: boolean; reason: string });
  /** For `contains` / `starts-with` / `ends-with` / `one-of`. */
  value?:            string;
  /** For `one-of`. */
  options?:          string[];
  /** For `contains` / `starts-with` / `ends-with` / `one-of`. */
  caseInsensitive?:  boolean;
  /** For `regex` / `not-regex`. */
  pattern?:          RegExp;
  /** For `json-schema`. Uses the shipped minimal validator. */
  schema?:           Record<string, unknown>;
  /** For `*-count-range`. */
  min?:              number;
  max?:              number;
  /** For `no-hallucinated-numbers`. Known-good numbers that are always OK. */
  allowed?:          Array<string | number>;
}

export interface ScoreCriterionResult {
  name:   string;
  ok:     boolean;
  reason: string;
  weight: number;
}

export interface ScoreReport {
  ok:       boolean;
  score:    number;
  passed:   number;
  failed:   number;
  total:    number;
  results:  ScoreCriterionResult[];
}

/**
 * Lightweight programmatic evaluator that scores an LLM output against
 * a rubric of deterministic checks. Companion to llmJudge (1.84) for
 * cheap sanity gates that don't need another LLM call. Composes with
 * promptRegression (1.89) — use scoreResponse for mechanical rubric
 * enforcement, llmJudge for qualitative assessment.
 * @since 2.4.0
 */
export function scoreResponse(
  response: string | { text?: string; [k: string]: unknown },
  rubric:   ScoreRubricCriterion[],
  ctx?:     Record<string, unknown>,
): ScoreReport;

/** Render a ScoreReport as a human-readable multi-line string. */
export function formatScoreReport(report: ScoreReport, options?: { colors?: boolean }): string;

export const KNOWN_SCORE_CHECKS: ReadonlyArray<ScoreCheckKind>;

// ---- Multi-model consensus voting (new in 2.5.0) ---------------------

export type ConsensusComparator =
  | 'exact' | 'normalized-text' | 'json-deep'
  | ((response: any) => string);

export interface ConsensusModelEntry {
  service: { chat: (req: any) => Promise<any> };
  model?:  string;
}

export interface ConsensusOptions {
  models:      ConsensusModelEntry[];
  request:     Record<string, unknown>;
  quorum?:     number;
  comparator?: ConsensusComparator;
  timeoutMs?:  number;
  onBallot?:   ((info: {
    model:      string;
    ok:         boolean;
    response:   any | null;
    key:        string | null;
    error:      string | null;
    durationMs: number;
  }) => void) | null;
}

export interface ConsensusBallot {
  model:      string;
  ok:         boolean;
  response:   any | null;
  key:        string | null;
  error:      string | null;
  durationMs: number;
  matched:    boolean;
}

export interface ConsensusTally {
  key:         string;
  count:       number;
  sampleModel: string;
}

export interface ConsensusResult {
  verdict:    'consensus' | 'plurality' | 'no-consensus' | 'all-failed';
  response:   any | null;
  confidence: number;
  quorum:     number;
  modelCount: number;
  ballots:    ConsensusBallot[];
  tallies:    ConsensusTally[];
}

/**
 * Multi-model consensus voting. Sends the same request to N models
 * in parallel, tallies responses under a caller-supplied comparator
 * (default: normalized-text equality), returns the majority response
 * with a confidence score + full ballot trail. Cost multiplier
 * (roughly Nx per call) — use for high-stakes calls where
 * hallucination cost > extra spend.
 * @since 2.5.0
 */
export function consensusVoting(options: ConsensusOptions): Promise<ConsensusResult>;

export const CONSENSUS_COMPARATORS: Readonly<Record<'exact' | 'normalized-text' | 'json-deep', (response: any) => string>>;

export const KNOWN_CONSENSUS_COMPARATORS: ReadonlyArray<'exact' | 'normalized-text' | 'json-deep'>;

// ---- Tenant isolation wrapper (new in 1.71.0) ------------------------

export interface TenantIsolateOptions {
  /** Extract tenant ID from ctx. Default reads ctx.raw.tenant, then cds.context.tenant, then 'default'. */
  tenantOf?: (ctx: MiddlewareContext) => string | number | null | undefined;
  /**
   * Called ONCE per new tenant. Returns a Middleware or Middleware[]
   * (composed in Koa style). Each tenant gets its own INSTANCE of
   * these middlewares (fresh bulkhead, breaker, tuner, etc.).
   */
  factory: (tenantId: string) => Middleware | Middleware[];
  onTenantCreate?: (tenantId: string) => void;
  onRequest?:      (info: { tenantId: string; method: string }) => void;
}

export interface TenantIsolateStats {
  requests:    number;
  tenantsSeen: number;
}

export interface TenantIsolateMiddleware extends Middleware {
  readonly stats: TenantIsolateStats;
  tenants():  string[];
  chainFor(tenantId: string):  Middleware[] | null;
  statsFor(tenantId: string):  { requests: number } | null;
  reset(tenantId?: string): void;
  asMcpResource(): {
    uri: 'config://tenant-isolate';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => TenantIsolateStats & {
      tenants: string[];
      perTenant: Record<string, { requests: number; middlewareCount: number }>;
    };
  };
}

/**
 * Multi-tenant isolation wrapper. Hands out per-tenant instances of the
 * middleware(s) returned by `factory(tenantId)`. Each tenant gets its own
 * bulkhead / breaker / tuner state so one noisy tenant can't fill another
 * tenant's queue or trip another tenant's circuit.
 * @since 1.71.0
 */
export function tenantIsolate(options: TenantIsolateOptions): TenantIsolateMiddleware;

export namespace resilience {
  /**
   * One-liner that wires the full resilience stack in canonical order:
   *   deadline → costBudget → circuitBreaker → bulkhead → retryOnRateLimit
   * Returns each primitive as a named field plus apply(llm),
   * prometheusBundle(), and healthBundle() helpers.
   * @since 1.55.0
   */
  function bundle(options?: ResilienceBundleOptions): ResilienceBundleStack;
  const CANONICAL_ORDER: readonly ResiliencePrimitiveKind[];

  /**
   * Named preset objects for common config profiles. Spread-friendly:
   *   resilience.bundle({ ...resilience.presets.balanced, budgetLimits: {...} })
   *
   * - aggressive: latency-sensitive; fail fast, tight bounds
   * - balanced:   production defaults (matches bare bundle() output)
   * - lenient:    dev / testing; generous timeouts, higher retry patience
   * - burst:      bulk pipelines; high concurrency, forgiving of spikes
   *
   * None include budgetLimits — that's a deployment-specific concern.
   * @since 1.70.0
   */
  const presets: {
    readonly aggressive: Readonly<ResilienceBundlePreset>;
    readonly balanced:   Readonly<ResilienceBundlePreset>;
    readonly lenient:    Readonly<ResilienceBundlePreset>;
    readonly burst:      Readonly<ResilienceBundlePreset>;
  };
}

// ---- Structured error taxonomy (new in 1.57.0) -----------------------

/** All error codes shipped by the plugin. */
export type LLMErrorCode =
  | 'RATE_LIMIT_GIVE_UP'
  | 'CIRCUIT_OPEN'
  | 'BULKHEAD_FULL'
  | 'BULKHEAD_TIMEOUT'
  | 'DEADLINE_EXCEEDED'
  | 'ALL_PROVIDERS_FAILED'
  | 'COST_GUARD_BLOCKED'
  | 'BUDGET_EXCEEDED'
  | 'BUDGET_TOO_TIGHT'
  | 'PROMPT_INJECTION'
  | 'GUARDRAIL_BLOCKED'
  | 'MISSING_FIXTURE';

export interface ErrorRegistryEntry {
  /** The middleware / helper that raises this error. */
  primitive:  string;
  /** Whether it's safe for the caller to try the exact same request again. */
  retriable:  boolean;
  /** Suggested HTTP status if the error surfaces as an API response. */
  httpStatus: number;
  /** Log-level hint: 'error' or 'warning'. */
  severity:   'error' | 'warning';
}

/** Read-only mapping: code → metadata. */
export const errorRegistry: Record<LLMErrorCode | string, ErrorRegistryEntry>;

/**
 * Base class for every public error thrown by the plugin. Subclasses
 * pass their code to super(); LLMError enriches with metadata from
 * `errorRegistry` (primitive, retriable, httpStatus, severity).
 * @since 1.57.0
 */
export class LLMError extends Error {
  readonly code:       LLMErrorCode | string;
  readonly primitive:  string;
  readonly retriable:  boolean;
  readonly httpStatus: number;
  readonly severity:   'error' | 'warning';
  constructor(message: string, code: LLMErrorCode | string);
}

/** Convenience: `if (isLLMError(e)) handle(e)`. @since 1.57.0 */
export function isLLMError(err: unknown): err is LLMError;

// ---- HTTP error handler middleware (new in 1.58.0) -------------------

export interface LlmErrorHandlerOptions {
  /**
   * Optional callback fired for each LLMError caught.
   * Errors thrown by this callback are swallowed.
   */
  log?: (err: LLMError, meta: { method?: string; url?: string; status: number; code: string }) => void;
  /** Field names to strip from the response body (subclass-specific fields + 'stack'). */
  mask?: string[];
  /** Include the stack trace in the response body. Default false. */
  includeStack?: boolean;
  /** Pass non-LLMError errors to next() instead of catching. Default true. */
  passThroughNonLLMErrors?: boolean;
}

export interface LlmErrorResponseBody {
  error: {
    code:       LLMErrorCode | string;
    primitive:  string;
    retriable:  boolean;
    severity:   'error' | 'warning';
    message:    string;
    details?:   Record<string, unknown>;
    stack?:     string;
  };
}

/**
 * Express/CAP-shaped 4-arg error middleware. Catches any LLMError from
 * downstream, converts it to a structured JSON response with the correct
 * HTTP status and (when applicable) a `Retry-After` header.
 * Non-LLMError errors pass through to next() by default.
 * @since 1.58.0
 */
export function llmErrorHandler(options?: LlmErrorHandlerOptions):
  (err: unknown, req: any, res: any, next: (err?: unknown) => void) => void;

// ---- JSON logging middleware (new in 1.59.0) --------------------------

export interface JsonLogPayload {
  ts:            string;
  method:        string;
  ok:            boolean;
  durationMs:    number;
  tenant:        string | null;
  provider:      string | null;
  model:         string | null;
  tokensIn?:     number | null;
  tokensOut?:    number | null;
  cost?:         number | null;
  cachedHit?:    boolean;
  correlationId: string | null;
  requestPreview?: string;
  meta?:         Record<string, unknown>;
  error?: {
    code:      LLMErrorCode | string;
    primitive: string | null;
    retriable: boolean;
    severity:  'error' | 'warning';
    message:   string;
  };
}

export interface JsonLogOptions {
  /** Any logger with .info() / .warn() / .error() (or a bare .log()). Required. */
  logger:                any;
  /** Level for successful calls. Default 'info'. */
  level?:                string;
  /** Level for failed calls. Default 'warn'. */
  errorLevel?:           string;
  /** Callback: extract a correlation id from ctx. Errors are swallowed. */
  correlationId?:        (ctx: MiddlewareContext) => string | null | undefined;
  /** Include the last user message (truncated) as `requestPreview`. Default false. */
  includeRequestPreview?: boolean;
  /** Truncation length for requestPreview. Default 200. */
  previewChars?:         number;
  /** Include ctx.meta (minus redactMetaFields) in the payload. Default false. */
  includeMeta?:          boolean;
  /** Field names to strip from ctx.meta before including. Default ['messages', 'system']. */
  redactMetaFields?:     string[];
}

export interface JsonLogStats {
  requests:    number;
  ok:          number;
  failed:      number;
  byErrorCode: Record<string, number>;
}

export interface JsonLogMiddleware extends Middleware {
  readonly stats: JsonLogStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://json-log';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => JsonLogStats & {
      level: string; errorLevel: string;
      includeRequestPreview: boolean; previewChars: number;
      includeMeta: boolean; redactMetaFields: string[];
    };
  };
}

/**
 * Structured JSON logging middleware. Emits ONE canonical JSON line per
 * LLM call — stable schema for ELK / Datadog / CloudWatch indexing.
 * @since 1.59.0
 */
export function jsonLog(options: JsonLogOptions): JsonLogMiddleware;

// ---- Auto-retry helper (new in 1.60.0) --------------------------------

export interface AutoRetryOptions {
  /** Max total attempts including the initial call. Default 3. */
  maxAttempts?: number;
  /** Base exponential-backoff delay (backoffMs * 2^attemptIdx). Default 500. */
  backoffMs?: number;
  /** Random jitter added to each wait (0..jitterMs). Default 200. */
  jitterMs?: number;
  /** Cap on any single wait. Default 30_000. */
  maxBackoffMs?: number;
  /** Custom predicate. Default: `err?.retriable === true` (LLMError 1.57 taxonomy). */
  retryOn?: (err: any) => boolean;
  onRetry?:  (info: { ctx: { attempt: number; waitMs: number; code: string | null; error: string }; error: any }) => void | Promise<void>;
  onGiveUp?: (info: { attempts: Array<{ attempt: number; waitMs: number; code: string | null; error: string }>; finalError: any }) => void | Promise<void>;
}

export interface AutoRetryStats {
  calls:          number;
  retriedCalls:   number;
  totalRetries:   number;
  givenUp:        number;
  totalWaitMs:    number;
}

export interface AutoRetryWrapped<F extends (...args: any[]) => Promise<any>> {
  (...args: Parameters<F>): ReturnType<F>;
  readonly stats: AutoRetryStats;
  reset(): void;
}

/**
 * Wrap any async function in a retry loop that respects the LLMError 1.57
 * `retriable` field. Retries transient failures (CircuitOpen, BulkheadFull,
 * BulkheadTimeout); gives up immediately on non-retriable (Deadline, Budget,
 * CostGuard, Injection, Guardrail, etc.). CIRCUIT_OPEN uses
 * `err.cooldownRemainingMs` as the wait; other retries use exponential
 * backoff with jitter, capped at `maxBackoffMs`.
 *
 * The re-thrown error is the ORIGINAL from the last attempt, with
 * `.autoRetryAttempts` attached for inspection.
 * @since 1.60.0
 */
export function autoRetry<F extends (...args: any[]) => Promise<any>>(
  fn: F,
  options?: AutoRetryOptions,
): AutoRetryWrapped<F>;

/** Default retry predicate: `err?.retriable === true`. Exposed for composition. */
export function defaultRetryOn(err: any): boolean;

// ---- Adaptive concurrency tuner (new in 1.61.0) -----------------------

export interface AdaptiveBulkheadOptions {
  /** Required. The bulkhead middleware to tune (must be v1.61+ with .setMaxConcurrent + .subscribe). */
  bulkhead:        BulkheadMiddleware;
  /** Required. Target p95 latency in ms. Above → shrink; below → grow. */
  p95TargetMs:     number;
  /** Floor on maxConcurrent — the tuner never shrinks below this. Default 1. */
  minConcurrent?:  number;
  /** Ceiling on maxConcurrent — the tuner never grows above this. Default 100. */
  maxConcurrent?:  number;
  /** Adjustment tick interval in ms. Default 10_000. Min 100. */
  adjustEveryMs?:  number;
  /** AIMD grow step per tick when p95 is under target. Default 1. */
  stepUp?:         number;
  /** AIMD shrink step per tick when p95 is over target. Default 2. */
  stepDown?:       number;
  /** Rolling sample window size. Default 100. Min 5. */
  sampleWindow?:   number;
  /** Filter observations to a specific provider bucket. */
  filterProvider?: (provider: string) => boolean;
  onAdjust?: (info: {
    action:            'grow' | 'shrink' | 'noop' | 'noop-no-samples';
    p95Ms:             number;
    targetMs:          number;
    prevMaxConcurrent: number;
    newMaxConcurrent:  number;
    sampleCount:       number;
  }) => void | Promise<void>;
  onSample?: (info: BulkheadObservation) => void;
}

export interface AdaptiveBulkheadStats {
  ticks:             number;
  adjustments:       number;
  grows:             number;
  shrinks:           number;
  lastP95Ms:         number | null;
  lastAction:        'grow' | 'shrink' | 'noop' | 'noop-no-samples' | 'none';
  lastMaxConcurrent: number;
}

export interface AdaptiveBulkheadHandle {
  start(): void;
  stop(): void;
  /** Fire the tick logic immediately — useful for tests + manual adjustment. */
  tickNow(): void;
  readonly stats: AdaptiveBulkheadStats;
  asMcpResource(): {
    uri: 'config://adaptive-bulkhead';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => AdaptiveBulkheadStats & {
      p95TargetMs: number; minConcurrent: number; maxConcurrent: number;
      adjustEveryMs: number; stepUp: number; stepDown: number; sampleWindow: number;
      currentMaxConcurrent: number; sampleCount: number; running: boolean;
    };
  };
}

/**
 * Adaptive concurrency tuner for the 1.51 bulkhead. Observes each call's
 * latency; on periodic tick, computes p95 over the sample window. If p95 is
 * above target → shrink maxConcurrent (backpressure); if p95 is below target
 * → grow (headroom). Classic AIMD applied to concurrency: grow slowly, shrink
 * aggressively.
 * @since 1.61.0
 */
export function adaptiveBulkhead(options: AdaptiveBulkheadOptions): AdaptiveBulkheadHandle;

// ---- Adaptive rate-limit tuner (new in 2.6.0) --------------------------

export interface AdaptiveRateLimitOptions {
  /**
   * Bulkhead middleware instance (from `bulkhead()`) whose `setMaxConcurrent`
   * this tuner will call as quota drifts.
   */
  bulkhead: BulkheadMiddleware;
  /**
   * Fraction of remaining quota to keep as safety headroom. Default 0.20.
   * Range [0, 1). Higher = more conservative.
   */
  headroom?:      number;
  /**
   * EMA smoothing factor for remaining-ratio. Default 0.30. Range (0, 1].
   * Higher = more responsive; lower = smoother.
   */
  alpha?:         number;
  /** Concurrency floor. Default 1. */
  minConcurrent?: number;
  /**
   * Concurrency ceiling. Default: caller-decided; if omitted, tuner uses
   * `bulkhead.getMaxConcurrent() × 2` as the grow room upper bound.
   */
  maxConcurrent?: number | null;
  /** Force a specific provider parser (skips detection). */
  provider?:      'openai' | 'anthropic' | 'gemini' | 'bedrock' | null;
  /**
   * Custom parser overrides — same shape as the shipped rate-limit parsers.
   * Any keys omitted fall back to defaults.
   */
  parsers?:       Record<string, (headers: unknown, status?: number) => unknown>;
  /** Fired every time setMaxConcurrent is called. Errors are swallowed. */
  onAdjust?:      (info: {
    reason: 'sample' | 'low-remaining' | '429-halve';
    providerName: string | null;
    from: number;
    to: number;
    smoothedRatio: number;
    lastRatio?: number | null;
  }) => void;
  /** Fired on 429 (before/after halving). Errors are swallowed. */
  on429?:         (info: {
    providerName: string | null;
    before: number;
    after: number;
  }) => void;
  /** Test seam. Default `() => Date.now()`. */
  now?: () => number;
}

export interface AdaptiveRateLimitStats {
  totalCalls:       number;
  samples:          number;
  adjustments:      number;
  grows:            number;
  shrinks:          number;
  on429Adjustments: number;
  lastRatio:        number | null;
  lastTarget:       number | null;
  lastReason:       string | null;
  byProvider:       Record<string, number>;
}

export interface AdaptiveRateLimitMiddleware extends Middleware {
  readonly stats: AdaptiveRateLimitStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://adaptive-rate-limit';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => AdaptiveRateLimitStats & {
      headroom: number;
      alpha: number;
      minConcurrent: number;
      maxConcurrentCap: number | null;
      currentBulkheadMax: number;
      smoothedRatio: number;
      supportedProviders: string[];
    };
  };
}

/**
 * Adaptive rate-limit tuner. Watches provider rate-limit headers (1.38+
 * parsers), EMA-smooths remaining-ratio, and shrinks/grows the bulkhead's
 * maxConcurrent to keep `headroom` fraction as buffer. Halves on 429/503.
 * Composes with adaptiveBulkhead — this tuner is QUOTA-driven, adaptiveBulkhead
 * is LATENCY-driven; both can run against the same bulkhead.
 * @since 2.6.0
 */
export function adaptiveRateLimit(options: AdaptiveRateLimitOptions): AdaptiveRateLimitMiddleware;

// ---- Provider health probe (new in 1.62.0) ----------------------------

export interface HealthProbeEntry {
  name: string;
  probe: (info: { provider: string }) => Promise<unknown>;
}

export interface HealthProbeState {
  healthy:     boolean | null;   // null = never probed
  lastProbeAt: number | null;
  lastError:   Error | null;
}

export interface ProviderHealthProbeOptions {
  providers:  HealthProbeEntry[];
  /** Ping every provider every N ms. Default 60_000. Min 100. */
  intervalMs?: number;
  /** Individual probe timeout. Default 10_000. Min 100. */
  timeoutMs?:  number;
  /** Optional circuit breaker to feed success/failure signals into. Must be v1.62+. */
  breaker?:    CircuitBreakerMiddleware;
  onHealthChange?: (info: { provider: string; from: 'healthy' | 'unhealthy'; to: 'healthy' | 'unhealthy'; err: Error | null }) => void | Promise<void>;
  onProbe?:        (info: { provider: string; ok: boolean; durationMs: number; error: string | null }) => void;
}

export interface ProviderHealthProbeStats {
  probes:         number;
  successes:      number;
  failures:       number;
  timeouts:       number;
  healthChanges:  number;
}

export interface ProviderHealthProbeHandle {
  start(): void;
  stop(): void;
  /** Fire all probes right now, or a single provider by name. */
  probeNow(providerName?: string): Promise<void>;
  state(providerName?: string): HealthProbeState | Record<string, HealthProbeState> | null;
  readonly stats: ProviderHealthProbeStats;
  asMcpResource(): {
    uri: 'config://provider-health';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => ProviderHealthProbeStats & {
      intervalMs: number;
      timeoutMs: number;
      running: boolean;
      providers: Record<string, { healthy: boolean | null; lastProbeAt: number | null; lastError: string | null }>;
    };
  };
}

/**
 * Provider health probe — periodic background pings to each provider.
 * On failure, records into the 1.49 circuitBreaker so the circuit opens
 * BEFORE the first real request fails. Proactive circuit isolation (vs
 * the reactive 1.49 breaker that waits for a real user request).
 * @since 1.62.0
 */
export function providerHealthProbe(options: ProviderHealthProbeOptions): ProviderHealthProbeHandle;

// ---- Adaptive max-tokens (new in 1.63.0) ------------------------------

export interface AdaptiveMaxTokensOptions {
  /** Required. The costBudget middleware to read remaining $ from. */
  budget:        CostBudgetMiddleware;
  /** Which scope's remaining $ to check. Default 'total'. */
  scope?:        BudgetScope;
  /** Fraction of remaining $ the middleware may use (0..1]. Default 0.5. */
  safetyFactor?: number;
  /** Floor on the shrunk maxTokens. Below this → throw. Default 50. */
  minTokens?:    number;
  /** Ceiling when caller supplies no maxTokens. Default 4_000. */
  maxTokens?:    number;
  /** Optional per-model pricing override. Defaults to DEFAULT_PRICING. */
  pricing?:      Record<string, { input: number; output: number }>;
  /** Extract tenant from ctx (for perTenant scope). */
  tenantOf?:     (ctx: MiddlewareContext) => string | null | undefined;
  /** Extract model from ctx (for perModel scope). */
  modelOf?:      (ctx: MiddlewareContext) => string | null | undefined;
  /** Which methods to guard. Default ['chat', 'stream']. */
  applyTo?:      string[];
  onAdjust?:     (info: { requested: number; adjusted: number; remainingUsd: number; safeUsd: number; inputUsd: number; model: string; method: string }) => void | Promise<void>;
  onBlock?:      (info: { remainingUsd: number; safeUsd: number; inputUsd: number; safeOutputTokens?: number; minTokens: number; model: string }) => void | Promise<void>;
}

export interface AdaptiveMaxTokensStats {
  requests:         number;
  skipped:          number;
  adjusted:         number;
  rejected:         number;
  unchanged:        number;
  totalSavedTokens: number;
}

export interface AdaptiveMaxTokensMiddleware extends Middleware {
  readonly stats: AdaptiveMaxTokensStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://adaptive-max-tokens';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => AdaptiveMaxTokensStats & {
      scope: BudgetScope;
      safetyFactor: number;
      minTokens: number;
      maxTokens: number;
      applyTo: string[];
    };
  };
}

/**
 * Cost-aware token budgeting middleware. Runs BEFORE the provider call
 * and mutates `ctx.request.maxTokens` so estimated cost fits under the
 * caller's remaining budget * safetyFactor. Throws
 * AdaptiveMaxTokensBlockedError (LLMError code 'BUDGET_TOO_TIGHT') when
 * even minTokens can't fit. Completes the cost story: budget → estimate
 * → guard → adaptive tokens.
 * @since 1.63.0
 */
export function adaptiveMaxTokens(options: AdaptiveMaxTokensOptions): AdaptiveMaxTokensMiddleware;

export class AdaptiveMaxTokensBlockedError extends LLMError {
  readonly code: 'BUDGET_TOO_TIGHT';
  readonly remainingUsd: number;
  readonly minTokens: number;
  readonly model: string;
}

// ---- Trace correlation middleware (new in 1.64.0) ---------------------

export interface TraceCorrelationOptions {
  /**
   * Custom extractor. Default: reads ctx.raw.correlationId, then
   * headers['x-correlation-id'], then headers['x-request-id'], then
   * W3C traceparent trace-id, then cds.context?.id.
   */
  fromCtx?: (ctx: MiddlewareContext) => string | null | undefined;
  /** Fallback ID generator when nothing to extract. Default: crypto.randomUUID (v4). */
  generator?: () => string;
  /** Where to stash the id on ctx.meta. Default 'correlationId'. */
  metaField?: string;
  /**
   * If true and cds.context exists without the metaField, write the id there.
   * Default true.
   */
  injectIntoCdsContext?: boolean;
  onExtract?: (info: { id: string; source: 'extracted' | 'generated'; method: string }) => void;
}

export interface TraceCorrelationStats {
  requests:  number;
  extracted: number;
  generated: number;
}

export interface TraceCorrelationMiddleware extends Middleware {
  readonly stats: TraceCorrelationStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://trace-correlation';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => TraceCorrelationStats & { metaField: string; injectIntoCdsContext: boolean };
  };
}

/**
 * Trace correlation middleware. Extracts or generates a correlation ID per
 * request and stashes it on `ctx.meta.correlationId` so every downstream
 * middleware (jsonLog, usageMetering, provider calls) surfaces the same
 * ID. Optionally propagates into `cds.context` so CAP's own logging picks
 * it up. Enables end-to-end distributed tracing across an SAP CAP request
 * → LLM call chain.
 * @since 1.64.0
 */
export function traceCorrelation(options?: TraceCorrelationOptions): TraceCorrelationMiddleware & {
  uuidv7: () => string;
  parseTraceparent: (headerValue: string) => string | null;
  defaultFromCtx: (ctx: MiddlewareContext) => string | null;
};

/** UUIDv7 generator — 48-bit timestamp + 74 bits random. Time-ordered. @since 1.64.0 */
export function uuidv7(): string;
/** Parse a W3C traceparent header, returning the trace-id or null. @since 1.64.0 */
export function parseTraceparent(headerValue: string): string | null;

// ---- CAP error bridge (new in 1.65.0) ---------------------------------

export interface ToCapErrorOptions {
  /** Field names to strip from the details payload. */
  mask?: string[];
  /** OData Common.numericSeverity (2=warn, 3=err, 4=fatal). Default 4. */
  severity?: number;
}

/**
 * Convert an LLMError into a CAP `req.reject(status, message, details)` call.
 * Non-LLMError exceptions are RE-THROWN so CAP's default handler processes
 * them unchanged. Prefer `withCapHandler(fn)` for a decorator form.
 * @since 1.65.0
 */
export function toCapError(err: unknown, req?: any, options?: ToCapErrorOptions): any;

/**
 * Wrapper decorator — catches any LLMError thrown by `handler` and
 * converts it via toCapError. Non-LLMError exceptions propagate.
 * Preserves the handler's `this` binding + additional args.
 * @since 1.65.0
 */
export function withCapHandler<F extends (req: any, ...args: any[]) => Promise<any>>(
  handler: F,
  options?: ToCapErrorOptions,
): F;

// ---- Boot-time preflight validator (new in 1.66.0) --------------------

export type PreflightCheckStatus = 'ok' | 'warning' | 'error';

export interface PreflightCheckEntry {
  name:      string;
  status:    PreflightCheckStatus;
  message?:  string;
  details?:  unknown;
}

export interface PreflightReport {
  ok:         boolean;
  timestamp:  string;
  durationMs: number;
  checks:     PreflightCheckEntry[];
  counts: {
    ok:      number;
    warning: number;
    error:   number;
  };
  errors:   PreflightCheckEntry[];
  warnings: PreflightCheckEntry[];
}

export interface PreflightOptions {
  /** Env-var names that must exist + be non-empty. */
  requiredEnv?: string[];
  /** Providers to probe. Each `probe()` must resolve without throwing (within timeout). */
  providers?:   Array<{ name: string; probe: () => Promise<unknown> }>;
  /** Middleware chain description — passed to validateMiddlewareOrder. */
  chain?:       Array<{ kind?: string }>;
  /** Budget-limits object — non-empty check (warning only). */
  budgetLimits?: BudgetLimits | null;
  /** Model IDs to verify against the pricing table. Missing → warning. */
  models?:      string[];
  /** Callback per check. Errors are swallowed. */
  onCheck?:     (info: PreflightCheckEntry) => void;
  /** Throw PreflightError on any error-status check. Default true. */
  failFast?:    boolean;
  /** Per-probe / per-check timeout in ms. Default 10_000. Min 100. */
  timeoutMsPerCheck?: number;
  /** Pricing table for model checks. Defaults to DEFAULT_PRICING. */
  pricing?:     Record<string, { input: number; output: number }>;
}

/**
 * Boot-time preflight validator. Runs env / provider / chain / budget /
 * model checks and returns a structured report. Throws PreflightError
 * on any error-status check (unless failFast: false).
 *
 * Call this from your app's boot path (e.g. `cds.once('served')`) so
 * misconfigurations surface at pod startup rather than at first user
 * request.
 * @since 1.66.0
 */
export function preflight(options?: PreflightOptions): Promise<PreflightReport>;

export class PreflightError extends Error {
  readonly code: 'PREFLIGHT_FAILED';
  readonly report: PreflightReport;
}

// ---- Testing helpers (new in 1.68.0) ---------------------------------

export interface FakeLLMScriptMatcher {
  method?: 'chat' | 'embed' | 'stream';
  model?:  string;
  matches?: RegExp;
}

export interface FakeLLMScript {
  /** Matcher — either an object shape or a predicate fn `(req, method) => boolean`. */
  when:    FakeLLMScriptMatcher | ((req: any, method: string) => boolean);
  /** Response — either a fixed object or a fn `(req, method) => response`. */
  respond: unknown | ((req: any, method: string) => unknown);
}

export interface FakeLLMCall {
  method:     'chat' | 'embed' | 'stream';
  request:    unknown;
  response:   unknown;
  error:      Error | null;
  timestamp:  number;
  durationMs: number;
}

export interface FakeLLMOptions {
  name?:            string;
  modelId?:         string;
  scripts?:         FakeLLMScript[];
  defaultResponse?: unknown | ((req: any, method: string) => unknown);
  /** Simulated per-call latency in ms. Default 0. */
  delayMs?:         number;
  /** 0..1 — random failure rate for testing retry paths. Default 0. */
  failRate?:        number;
  /** Called to build the failure error when failRate fires. */
  failWith?:        (req: any, method: string) => Error;
  /** Throw when no script matches + no defaultResponse. Default false. */
  strict?:          boolean;
}

export interface FakeLLM {
  readonly name: string;
  readonly modelId: string;
  readonly middleware: Middleware[];
  readonly calls: FakeLLMCall[];
  use(mw: Middleware): FakeLLM;
  chat(req: ChatRequest): Promise<any>;
  embed(req: EmbedRequest): Promise<any>;
  stream(req: ChatRequest): AsyncGenerator<StreamChunk, void, void>;
  callsMatching(pred: (call: FakeLLMCall) => boolean): FakeLLMCall[];
  lastCall(): FakeLLMCall | null;
  reset(): void;
  setScripts(scripts: FakeLLMScript[]): void;
  addScript(script: FakeLLMScript): void;
}

// ---- Record / replay (new in 1.69.0) --------------------------------

export interface FixtureEntry {
  request:    unknown;
  response:   unknown;
  recordedAt: string;
  method:     string;
}

export interface FixtureStore {
  get(hash: string):  FixtureEntry | null;
  set(hash: string, entry: FixtureEntry): void;
  all():              Record<string, FixtureEntry>;
  size?():            number;
}

export interface RecordingOptions {
  /** File path (JSON) or custom { get, set } store. */
  store:       string | FixtureStore;
  /** Hash a request into a fixture key. Default: SHA-256 of the relevant fields. */
  hashOn?:     (req: any, method: string) => string;
  /** Callback per successful record write. */
  onWrite?:    (info: { hash: string; method: string }) => void;
  /** Callback per skip (method-skipped, hash-error, write-error). */
  onSkip?:     (info: { method: string; reason: string; error?: string }) => void;
  /** Methods to bypass recording (e.g. ['stream']). */
  skipMethods?: string[];
}

export interface RecordingStats {
  requests: number;
  recorded: number;
  skipped:  number;
}

export interface RecordingMiddleware extends Middleware {
  readonly stats: RecordingStats;
  readonly store: FixtureStore;
  reset(): void;
}

export interface ReplayOptions {
  store:       string | FixtureStore;
  hashOn?:     (req: any, method: string) => string;
  /** Throw MissingFixtureError on cache miss. Default true. */
  strict?:     boolean;
  onHit?:      (info: { hash: string; method: string }) => void;
  onMiss?:     (info: { hash: string; method: string; model?: string }) => void;
  skipMethods?: string[];
}

export interface ReplayStats {
  requests:     number;
  hits:         number;
  misses:       number;
  fallthroughs: number;
  skipped:      number;
}

export interface ReplayMiddleware extends Middleware {
  readonly stats: ReplayStats;
  readonly store: FixtureStore;
  reset(): void;
}

export namespace testing {
  /**
   * LLMService-compatible fake for unit tests. Returns scripted responses
   * instead of hitting a real provider. Middleware (breaker, retry, cache,
   * guardrails, etc.) still runs before the scripted provider — enables
   * network-free tests of the full middleware stack.
   * @since 1.68.0
   */
  function fakeLLM(options?: FakeLLMOptions): FakeLLM;

  /**
   * Middleware that records real LLM API responses to a JSON fixture file
   * (request-hash → response). Use during test authoring to capture real
   * provider outputs, then swap to replay() for network-free CI runs.
   * @since 1.69.0
   */
  function recording(options: RecordingOptions): RecordingMiddleware;

  /**
   * Middleware that reads fixtures recorded by recording() and returns them
   * for matching requests. Throws MissingFixtureError on cache miss in
   * strict mode; falls through to next() in non-strict.
   * @since 1.69.0
   */
  function replay(options: ReplayOptions): ReplayMiddleware;

  /** File-backed FixtureStore. Auto-loads on first use, auto-saves on set. */
  function fileStore(path: string): FixtureStore;

  /** Default hash: SHA-256 over method + relevant request fields. */
  function defaultHash(req: any, method: string): string;

  class MissingFixtureError extends LLMError {
    readonly code:       'MISSING_FIXTURE';
    readonly hash:       string;
    readonly methodName: string;
    readonly model:      string;
  }
}

// ---- Provider fallback chain (new in 1.50.0) --------------------------

export interface FallbackProviderEntry {
  /** LLMService (or anything with a `.chat(req)` method + `.name`). */
  service: { name?: string; chat: (req: any) => Promise<any> };
  /** Per-provider model override. If omitted, inherits `request.model`. */
  model?: string;
  /** Per-provider request-field overrides — merged over shared request. */
  request?: Record<string, unknown>;
}

export interface FallbackAttempt {
  service: string;
  model:   string | undefined;
  ok:      boolean;
  /** true when short-circuited by an open breaker — this was NOT a live provider call. */
  skipped: boolean;
  error?:      string;
  errorName?:  string;
  status?:     number | null;
}

export interface FallbackResult<T = any> {
  result:        T;
  providerUsed:  string;
  modelUsed:     string | undefined;
  attempts:      FallbackAttempt[];
}

export interface ChatWithFallbackOptions {
  providers: FallbackProviderEntry[];
  request?:  Record<string, unknown>;
  /**
   * Predicate: given an error from a provider, should we try the next one?
   * Default: fails over on CircuitOpenError, RateLimitGiveUpError, 5xx status,
   * and network / unknown-status errors. Does NOT fail over on 4xx.
   */
  isFallback?: (err: any) => boolean;
  /** Called before each fail-over transition. Errors thrown here are swallowed. */
  onFailover?: (info: {
    from: string;
    to:   string | null;
    error: Error;
    skipped: boolean;
    willRetry: boolean;
  }) => void | Promise<void>;
}

/**
 * Try providers in order; fail over on retryable errors (5xx / network /
 * CircuitOpenError / RateLimitGiveUpError). Composes with the 1.49.0
 * `circuitBreaker` middleware: an open circuit throws CircuitOpenError,
 * which is treated as an immediate failover signal (no wait).
 * @since 1.50.0
 */
export function chatWithFallback<T = any>(options: ChatWithFallbackOptions): Promise<FallbackResult<T>>;

export class AllProvidersFailedError extends LLMError {
  readonly code: 'ALL_PROVIDERS_FAILED';
  readonly attempts: FallbackAttempt[];
  readonly cause?: Error;
}

// ---- Middleware ordering validator (new in 1.48.0) --------------------

export type MiddlewareOrderingWarningCode =
  | 'CACHE_OUTER_OF_METERING'
  | 'BUDGET_INNER_OF_RETRY'
  | 'INJECTION_INNER_OF_GUARDRAILS'
  | 'CACHE_OUTER_OF_BUDGET'
  | 'BREAKER_INNER_OF_RETRY'
  | 'BULKHEAD_OUTER_OF_BREAKER'
  | 'DEADLINE_INNER_OF_RETRY'
  | 'COST_GUARD_OUTER_OF_GUARDRAILS'
  | 'NO_RETRY'
  | 'NO_METERING'
  | 'NO_SECURITY_LAYER'
  | 'NO_CIRCUIT_BREAKER'
  | 'NO_BULKHEAD'
  | 'NO_DEADLINE'
  | 'DUPLICATE_KIND'
  | 'UNKNOWN_KIND';

export interface MiddlewareOrderingWarning {
  code: MiddlewareOrderingWarningCode | string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  fixit: string;
  involved: string[];
}

export interface MiddlewareOrderingResult {
  /** false iff any 'error'-severity warning present. */
  ok: boolean;
  warnings: MiddlewareOrderingWarning[];
}

/**
 * Static validator for llm.use() middleware ordering. Flags common
 * mis-orderings that break composition invariants — e.g. `usageMetering`
 * OUTER of `responseCache` inflates cache-hit counts, `costBudget` INNER of
 * `retryOnRateLimit` bypasses the ceiling on retries. Returns structured
 * warnings with severity + fixit hints.
 * @since 1.48.0
 */
export function validateMiddlewareOrder(chain: Array<{ kind?: string }>): MiddlewareOrderingResult;

/** Filter out warnings by code — useful in tests or intentional exceptions. @since 1.48.0 */
export function filterWarnings(result: MiddlewareOrderingResult, ignoredCodes?: string[]): MiddlewareOrderingResult;

export class BudgetExceededError extends LLMError {
  readonly code: 'BUDGET_EXCEEDED';
  readonly scope: BudgetScope;
  readonly key: string;
  readonly current: number;
  readonly limit: number;
  readonly currency: string;
}

/**
 * Default per-process in-memory counter store. Fast, zero-dep, but does
 * NOT survive restarts and does NOT share across processes.
 * @since 1.30.0
 */
export class InMemoryCounterStore implements CounterStore {
  get(scope: BudgetScope, key: string, bucket: string): number;
  add(scope: BudgetScope, key: string, bucket: string, amount: number): void;
  snapshot(bucket: string): { total: number; perTenant: Record<string, number>; perModel: Record<string, number> };
  clear(): void;
}

export interface RedisCounterStoreOptions {
  /** Redis key prefix. Default `'llm:budget'`. */
  namespace?: string;
  /**
   * TTL applied to each key on every write. Default 40 days — safely covers
   * the widest 'month' window. Old-window keys age out on their own.
   */
  keyTtlSeconds?: number;
  /** SCAN COUNT hint. Default 200. */
  scanCount?: number;
}

/**
 * Redis-backed counter store for costBudget. Multi-instance safe: uses
 * atomic INCRBYFLOAT so concurrent requests from different app instances
 * agree on totals.
 *
 * Accepts any ioredis-shaped client (also works with `node-redis` v4
 * once its API is wrapped to ioredis conventions).
 * @since 1.30.0
 */
export class RedisCounterStore implements CounterStore {
  constructor(client: unknown, options?: RedisCounterStoreOptions);
  get(scope: BudgetScope, key: string, bucket: string): Promise<number>;
  add(scope: BudgetScope, key: string, bucket: string, amount: number): Promise<void>;
  snapshot(bucket: string): Promise<{ total: number; perTenant: Record<string, number>; perModel: Record<string, number> }>;
  clear(): Promise<void>;
}

// ---- Prompt injection guard middleware (new in 1.31.0) ---------------

export type InjectionDetector =
  | 'regex'
  | 'base64'
  | 'unicode'
  | 'delimiters'
  | 'roleAttempt'
  | 'lengthAnomaly';

export interface PromptInjectionHit {
  detector: InjectionDetector;
  hit: true;
  confidence: number;
  evidence: string;
}

export interface PromptInjectionGuardOptions {
  /** 'block' (default) → PromptInjectionError. 'sanitize' → mutate & proceed. 'warn' → log only. */
  action?: 'block' | 'sanitize' | 'warn';
  /** Combined score in (0, 1] at which the action fires. Default 0.6. */
  threshold?: number;
  /** Which detectors to run. Default: all six. */
  detectors?: InjectionDetector[];
  /** Max user-message length before the lengthAnomaly detector fires. Default 8000. */
  maxUserMessageChars?: number;
  /** Extra regex patterns to check on top of the built-ins. */
  extraPatterns?: RegExp[];
  onDetect?: (info: {
    action: 'block' | 'sanitize' | 'warn';
    score: number;
    threshold: number;
    hits: PromptInjectionHit[];
    evidence: string[];
  }) => void | Promise<void>;
}

export interface PromptInjectionGuardStats {
  scanned:   number;
  blocked:   number;
  sanitized: number;
  warned:    number;
  byDetector: Record<InjectionDetector, number>;
}

export interface PromptInjectionGuardMiddleware extends Middleware {
  readonly stats: PromptInjectionGuardStats;
  reset(): void;
  asMcpResource(): {
    uri: 'config://prompt-injection-guard';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => {
      action: string;
      threshold: number;
      detectors: InjectionDetector[];
      maxUserMessageChars: number;
      stats: PromptInjectionGuardStats;
    };
  };
}

/**
 * Dedicated prompt-injection detection middleware. Layers regex,
 * base64-decode, unicode/homoglyph, delimiter smuggling, role-attempt,
 * and length-anomaly detectors; combines their confidences and blocks /
 * sanitizes / warns based on the aggregate score.
 * @since 1.31.0
 */
export function promptInjectionGuard(options?: PromptInjectionGuardOptions): PromptInjectionGuardMiddleware;

export class PromptInjectionError extends LLMError {
  readonly code: 'PROMPT_INJECTION';
  readonly score: number;
  readonly evidence: string[];
}

// ---- Built-in filters ---------------------------------------------------

export interface BlocklistOptions {
  /** 'block' (default) → GuardrailBlockedError on match. 'redact' → replace matches with `replacement`. */
  mode?: 'block' | 'redact';
  /** Substitute for 'redact' mode. Default '[REDACTED]'. */
  replacement?: string;
}

export interface PiiOptions {
  /** true (default) → replace PII with tags. false → block on detection. */
  redact?: boolean;
  /** Which PII types to detect. Default: all. */
  types?: Array<'ssn' | 'creditCard' | 'email' | 'phone'>;
  /** Custom substitute for redactions. Default `(type) => '[REDACTED-' + type + ']'`. */
  replacement?: (type: string) => string;
}

export interface PromptInjectionOptions {
  /** Extra regex patterns to check alongside the shipped defaults. */
  extraPatterns?: RegExp[];
}

/** Built-in filter factories. */
export const filters: {
  /**
   * String / regex blocklist. Default mode blocks; pass `mode: 'redact'`
   * to replace matches instead.
   */
  blocklist(patterns: Array<string | RegExp>, options?: BlocklistOptions): GuardrailFilter;
  /**
   * PII detector. Ships regexes for US SSN, common credit-card BINs,
   * standard email format, and US phone numbers. Redacts by default;
   * pass `redact: false` to block on detection.
   */
  pii(options?: PiiOptions): GuardrailFilter;
  /**
   * Heuristic prompt-injection detector. Matches well-known patterns
   * ("ignore previous instructions", "you are now DAN", fake role tags,
   * "reveal the system prompt", etc.). Only examines user + tool
   * messages — never the system prompt itself. Blocks on match.
   */
  promptInjection(options?: PromptInjectionOptions): GuardrailFilter;
  PII_REGEXES: Record<string, RegExp>;
  DEFAULT_INJECTION_PATTERNS: RegExp[];
};

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

// ---- Pre-built JSON Schemas for structured extraction (new in 1.34.0) --

/**
 * Structural JSON Schema. Every value here is a valid `format:` param
 * for `chat({...})`; the plugin post-parses the response into `data`.
 * Passed through unmodified — refer to JSON Schema Draft-07 for shape.
 */
export type JsonSchema = Record<string, unknown>;

export interface SchemasBundle {
  // Business-object schemas
  readonly Invoice: JsonSchema;
  readonly PurchaseOrder: JsonSchema;
  readonly SupplierRisk: JsonSchema;
  readonly ContractSummary: JsonSchema;
  readonly ExpenseReport: JsonSchema;
  readonly EmailDraft: JsonSchema;
  // Reusable sub-schemas
  readonly LineItem: JsonSchema;
  readonly IsoDate: JsonSchema;
  readonly CurrencyCode: JsonSchema;
  // Helpers
  list(): string[];
  byName(name: string): JsonSchema | undefined;
  /** Non-mutating extend — merge extra `properties` + `required` onto a base object schema. */
  extend(base: JsonSchema, patch: { properties?: Record<string, JsonSchema>; required?: string[] }): JsonSchema;
  /**
   * MCP static resource (`schema://list`) enumerating every registered schema name.
   * Register alongside `asMcpResourceTemplate()` to expose the whole surface.
   * @since 1.37.0
   */
  asMcpResource(): {
    uri: 'schema://list';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: () => { schemas: string[] };
  };
  /**
   * MCP resource template — `schema://{name}` resolves any individual schema's JSON.
   * Unknown names return `{ error: 'unknown schema: <name>', known: [...] }`.
   * @since 1.37.0
   */
  asMcpResourceTemplate(): {
    uriTemplate: 'schema://{name}';
    name: string;
    description: string;
    mimeType: 'application/json';
    handler: (params: { name: string }) => JsonSchema | { error: string; known: string[] };
  };
}

/**
 * Pre-built JSON Schemas for common business-object extraction. Pass any
 * schema straight to `chat({ format: schemas.Invoice })`.
 * @since 1.34.0
 */
export const schemas: SchemasBundle;

// ---- Prometheus metrics exporter (new in 1.35.0) ----------------------

export interface PrometheusMiddlewareBundle {
  cache?:          ResponseCacheMiddleware;
  budget?:         CostBudgetMiddleware;
  guardrails?:     GuardrailsMiddleware;
  injectionGuard?: PromptInjectionGuardMiddleware;
  metering?:       UsageMeteringMiddleware;
  /** @since 1.47.1 */
  retry?:          RetryOnRateLimitMiddleware;
}

export interface PromMetricsOptions {
  /** Skip per-tenant/model/provider breakdowns. Trades granularity for scrape cardinality. */
  excludeBreakdowns?: boolean;
}

/**
 * Serialize middleware state to Prometheus text-exposition format (0.0.4).
 * All fields on `mw` are optional — pass whichever middleware you have wired.
 * @since 1.35.0
 */
export function promMetrics(mw?: PrometheusMiddlewareBundle, options?: PromMetricsOptions): Promise<string>;

/**
 * Express-shaped `(req, res) => void` handler that responds with the
 * Prometheus text-format body. Sets Content-Type correctly. Register at /metrics.
 * @since 1.35.0
 */
export function prometheusHandler(mw?: PrometheusMiddlewareBundle, options?: PromMetricsOptions):
  (req: unknown, res: unknown) => Promise<void>;

/**
 * Normalize OpenAI-family rate-limit headers into a snapshot the usageMetering
 * middleware can track. Same shape used by Groq, DeepSeek, Mistral, Fireworks,
 * Azure OpenAI. Returns null when no rate-limit headers are present.
 * @since 1.38.0
 */
export function parseOpenAIRateLimit(headers: unknown, statusCode?: number): RateLimitSnapshot | null;

/**
 * Normalize Anthropic rate-limit headers into a snapshot the usageMetering
 * middleware can track. Anthropic uses ISO timestamps for reset headers
 * (unlike OpenAI's duration format).
 * @since 1.38.0
 */
export function parseAnthropicRateLimit(headers: unknown, statusCode?: number): RateLimitSnapshot | null;

/**
 * Normalize Gemini rate-limit headers into a snapshot. Handles both Vertex-style
 * (`x-goog-quota-limit`, `x-goog-quota-remaining`, `x-goog-quota-refresh` as
 * Unix epoch seconds) and OpenAI-style (`x-ratelimit-*`) headers when API
 * Gateway proxies re-emit them. Returns null when neither is present.
 * @since 1.44.0
 */
export function parseGeminiRateLimit(headers: unknown, statusCode?: number): RateLimitSnapshot | null;

/**
 * Extract rate-limit info from an AWS SDK v3 Bedrock response. AWS doesn't
 * publish per-response quota-remaining headers, so most successful calls
 * yield null. On 429/503 throttling responses, `retryAfterSeconds` is set
 * from `$metadata.retryAfterHeader`. Custom httpHandlers exposing
 * `$metadata.httpHeaders` also get `x-amzn-ratelimit-*` extraction.
 * @since 1.45.0
 */
export function parseBedrockRateLimit(sdkResponse: unknown, statusCode?: number): RateLimitSnapshot | null;
