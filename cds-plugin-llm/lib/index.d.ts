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

export class GuardrailBlockedError extends Error {
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

export class RateLimitGiveUpError extends Error {
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

export class CircuitOpenError extends Error {
  readonly code: 'CIRCUIT_OPEN';
  readonly provider: string;
  readonly cooldownRemainingMs: number;
  readonly cause?: Error;
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

export class AllProvidersFailedError extends Error {
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
  | 'NO_RETRY'
  | 'NO_METERING'
  | 'NO_SECURITY_LAYER'
  | 'NO_CIRCUIT_BREAKER'
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

export class BudgetExceededError extends Error {
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

export class PromptInjectionError extends Error {
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
