const {
  imageFromFile, imageFromUrl, imageFromBase64,
  pdfFromFile, pdfFromUrl, pdfFromBase64,
  audioFromFile, audioFromUrl, audioFromBase64,
} = require('./util');
const { runTools } = require('./toolRunner');

module.exports = {
  LLMService: require('./LLMService'),
  AnthropicLLMService: require('./providers/anthropic'),
  OllamaLLMService: require('./providers/ollama'),
  GenAIHubLLMService: require('./providers/genai-hub'),
  OpenAICompatibleLLMService: require('./providers/openai-compatible'),
  AzureOpenAILLMService: require('./providers/azure-openai'),
  GeminiLLMService: require('./providers/gemini'),
  BedrockLLMService: require('./providers/bedrock'),
  FireworksLLMService: require('./providers/fireworks'),
  DeepSeekLLMService: require('./providers/deepseek'),
  MistralLLMService: require('./providers/mistral'),
  GroqLLMService: require('./providers/groq'),
  // Vision helpers
  imageFromFile,
  imageFromUrl,
  imageFromBase64,
  // PDF helpers (Anthropic-only + OpenAI-compat since 0.9.0)
  pdfFromFile,
  pdfFromUrl,
  pdfFromBase64,
  // Audio helpers (Gemini native + OpenAI-compat GPT-4o Audio) — new in 1.36.0
  audioFromFile,
  audioFromUrl,
  audioFromBase64,
  // Tool runner — automatic multi-turn agent loop (new in 1.1.0)
  runTools,
  // Streaming counterpart — yields progress events between + inside each turn (new in 1.39.0)
  streamTools: require('./toolRunner').streamTools,
  // Multi-agent orchestration (new in 1.27.0)
  Agent: require('./agents').Agent,
  runAgents: require('./agents').runAgents,
  // Streaming counterpart — yields agent-slug events (new in 1.41.0)
  streamAgents: require('./agents').streamAgents,
  DEFAULT_COORDINATOR_SYSTEM: require('./agents').DEFAULT_COORDINATOR_SYSTEM,
  // Built-in middleware helpers (new in 1.3.0)
  rateLimit: require('./middleware/rateLimit').rateLimit,
  otel: require('./middleware/otel').otel,
  // Redis-backed rate limit (new in 1.4.0)
  redisRateLimit: require('./middleware/redisRateLimit').redisRateLimit,
  // Per-request cost + token metering (new in 1.21.0)
  usageMetering: require('./middleware/usageMetering').usageMetering,
  DEFAULT_PRICING: require('./pricing').DEFAULT_PRICING,
  // Auto-persist metering records to a CAP entity (new in 1.22.0)
  usageMeteringToCap: require('./middleware/usageMeteringToCap').usageMeteringToCap,
  DEFAULT_LLM_USAGE_ENTITY: require('./middleware/usageMeteringToCap').DEFAULT_ENTITY,
  // Response cache middleware — memoizes identical chat() calls (new in 1.26.0)
  // Semantic (embedding-based) lookup added in 1.32.0
  responseCache: require('./middleware/responseCache').responseCache,
  InMemoryLRU: require('./middleware/responseCache').InMemoryLRU,
  cosine: require('./middleware/responseCache').cosine,
  // Guardrails — input/output filters for PII, injection, blocklists (new in 1.28.0)
  guardrails: require('./middleware/guardrails').guardrails,
  GuardrailBlockedError: require('./middleware/guardrails').GuardrailBlockedError,
  filters: require('./filters'),
  // Prompt injection detection — dedicated middleware layer (new in 1.31.0)
  promptInjectionGuard: require('./middleware/promptInjectionGuard').promptInjectionGuard,
  PromptInjectionError: require('./middleware/promptInjectionGuard').PromptInjectionError,
  // Rate-limit-driven retry middleware (new in 1.47.0)
  retryOnRateLimit: require('./middleware/retryOnRateLimit').retryOnRateLimit,
  RateLimitGiveUpError: require('./middleware/retryOnRateLimit').RateLimitGiveUpError,
  // Circuit breaker middleware — sustained-outage guard (new in 1.49.0)
  circuitBreaker: require('./middleware/circuitBreaker').circuitBreaker,
  CircuitOpenError: require('./middleware/circuitBreaker').CircuitOpenError,
  // Provider fallback chain — orchestrates multiple providers (new in 1.50.0)
  chatWithFallback: require('./chatWithFallback').chatWithFallback,
  AllProvidersFailedError: require('./chatWithFallback').AllProvidersFailedError,
  // Bulkhead middleware — concurrency + queue isolation (new in 1.51.0)
  bulkhead: require('./middleware/bulkhead').bulkhead,
  BulkheadFullError: require('./middleware/bulkhead').BulkheadFullError,
  BulkheadTimeoutError: require('./middleware/bulkhead').BulkheadTimeoutError,
  // Deadline / timeout middleware — hard cap on total request time (new in 1.52.0)
  deadline: require('./middleware/deadline').deadline,
  DeadlineExceededError: require('./middleware/deadline').DeadlineExceededError,
  // Aggregate health check — Express-shaped route + programmatic snapshot (new in 1.53.0)
  healthHandler: require('./healthHandler').healthHandler,
  healthCheck: require('./healthHandler').healthCheck,
  // Pre-flight cost estimator — token-counts + prices without an API round-trip (new in 1.54.0)
  estimateCost: require('./estimateCost').estimateCost,
  // Cost guard middleware — pre-flight per-call cost ceiling (new in 1.56.0)
  costGuard: require('./middleware/costGuard').costGuard,
  CostGuardBlockedError: require('./middleware/costGuard').CostGuardBlockedError,
  // Resilience bundle — one-liner wiring for the full resilience stack (new in 1.55.0)
  resilience: require('./resilience'),
  // Structured error taxonomy — LLMError base + errorRegistry (new in 1.57.0)
  LLMError: require('./errors').LLMError,
  errorRegistry: require('./errors').errorRegistry,
  isLLMError: require('./errors').isLLMError,
  // HTTP error handler — Express-shaped middleware for LLMError → JSON (new in 1.58.0)
  llmErrorHandler: require('./llmErrorHandler').llmErrorHandler,
  // Structured JSON logging middleware — one canonical line per LLM call (new in 1.59.0)
  jsonLog: require('./middleware/jsonLog').jsonLog,
  // Auto-retry helper — wraps any async fn in a retry loop that respects LLMError.retriable (new in 1.60.0)
  autoRetry: require('./autoRetry').autoRetry,
  defaultRetryOn: require('./autoRetry').defaultRetryOn,
  // Adaptive concurrency tuner — AIMD on bulkhead.maxConcurrent by p95 latency (new in 1.61.0)
  adaptiveBulkhead: require('./middleware/adaptiveBulkhead').adaptiveBulkhead,
  // Provider health probe — proactive circuit isolation (new in 1.62.0)
  providerHealthProbe: require('./middleware/providerHealthProbe').providerHealthProbe,
  // Adaptive max-tokens — auto-shrink maxTokens to fit remaining budget (new in 1.63.0)
  adaptiveMaxTokens: require('./middleware/adaptiveMaxTokens').adaptiveMaxTokens,
  AdaptiveMaxTokensBlockedError: require('./middleware/adaptiveMaxTokens').AdaptiveMaxTokensBlockedError,
  // Trace correlation — extract/generate correlation ID per request (new in 1.64.0)
  traceCorrelation: require('./middleware/traceCorrelation').traceCorrelation,
  uuidv7: require('./middleware/traceCorrelation').uuidv7,
  parseTraceparent: require('./middleware/traceCorrelation').parseTraceparent,
  // CAP error bridge — LLMError → req.reject() for OData handlers (new in 1.65.0)
  toCapError: require('./capErrorBridge').toCapError,
  withCapHandler: require('./capErrorBridge').withCapHandler,
  // Boot-time preflight validator — fail-fast config check (new in 1.66.0)
  preflight: require('./preflight').preflight,
  PreflightError: require('./preflight').PreflightError,
  // Testing helpers — fakeLLM for network-free unit tests (new in 1.68.0)
  testing: require('./testing'),
  // Tenant isolation wrapper — per-tenant middleware chain instances (new in 1.71.0)
  tenantIsolate: require('./middleware/tenantIsolate').tenantIsolate,
  // Stream completion tracker — middleware can hook into stream 'fully consumed' (new in 1.72.0)
  wrapStreamCompletion: require('./streamCompletion').wrapStreamCompletion,
  hasStreamCompletion: require('./streamCompletion').hasStreamCompletion,
  // Chain snapshot diff — CI-friendly comparison of middleware chain snapshots (new in 1.73.0)
  chainDiff: require('./chainDiff').chainDiff,
  formatChainDiff: require('./chainDiff').formatChainDiff,
  // In-memory replay buffer — captures last N request/response pairs for live inspection (new in 1.75.0)
  replayBuffer: require('./middleware/replayBuffer').replayBuffer,
  // Structured output validator — JSON Schema check on LLM responses (new in 1.76.0)
  structuredOutputValidator: require('./middleware/structuredOutputValidator').structuredOutputValidator,
  StructuredOutputInvalidError: require('./middleware/structuredOutputValidator').StructuredOutputInvalidError,
  // Idempotency — dedupe duplicate requests over a short TTL (new in 1.77.0)
  idempotency: require('./middleware/idempotency').idempotency,
  IdempotencyInFlightError: require('./middleware/idempotency').IdempotencyInFlightError,
  // Batch orchestration helpers on top of the 1.25.0 batch API (new in 1.79.0)
  waitForBatch:      require('./batchHelpers').waitForBatch,
  runBatch:          require('./batchHelpers').runBatch,
  BatchTimeoutError: require('./batchHelpers').BatchTimeoutError,
  // PII redaction — mask emails/phones/SSNs/credit cards/IBANs on request; un-mask on response (new in 1.80.0)
  piiRedact:         require('./middleware/piiRedact').piiRedact,
  BUILT_IN_PII_DETECTORS: require('./middleware/piiRedact').BUILT_IN_DETECTORS,
  luhnValid:         require('./middleware/piiRedact').luhnValid,
  // Task-aware model routing — declare policy centrally instead of hand-picking per call (new in 1.81.0)
  modelRouter:       require('./middleware/modelRouter').modelRouter,
  // Embedding dedup cache — content-addressable per-text cache for embed() calls (new in 1.82.0)
  embeddingDedup:    require('./middleware/embeddingDedup').embeddingDedup,
  EmbeddingLRU:      require('./middleware/embeddingDedup').EmbeddingLRU,
  // Prompt caching stats — surfaces provider cache savings (Anthropic/OpenAI/DeepSeek/Gemini) as ops metrics (new in 1.83.0)
  promptCacheStats:  require('./middleware/promptCacheStats').promptCacheStats,
  DEFAULT_CACHE_MULTIPLIERS: require('./middleware/promptCacheStats').DEFAULT_CACHE_MULTIPLIERS,
  // LLM-as-judge helper — multi-criterion scoring for CI eval loops (new in 1.84.0)
  llmJudge:          require('./llmJudge').llmJudge,
  judgeMany:         require('./llmJudge').judgeMany,
  DEFAULT_JUDGE_SYSTEM: require('./llmJudge').DEFAULT_JUDGE_SYSTEM,
  // Auto-continuation — auto-resume max_tokens-truncated responses (new in 1.85.0)
  autoContinue:      require('./middleware/autoContinue').autoContinue,
  // Content safety classifier — model-based classification via OpenAI moderation + Anthropic refusal detection (new in 1.88.0)
  safetyClassifier:  require('./middleware/safetyClassifier').safetyClassifier,
  SafetyClassifierBlockedError: require('./middleware/safetyClassifier').SafetyClassifierBlockedError,
  // Prompt regression detector — CI eval loop on top of llmJudge (new in 1.89.0)
  promptRegression:  require('./promptRegression').promptRegression,
  loadFixtures:      require('./promptRegression').loadFixtures,
  formatRegressionReport: require('./promptRegression').formatReport,
  // RAG orchestration helper — retrieve → dedupe → rerank → truncate → answer (new in 1.90.0)
  ragChain:          require('./ragChain').ragChain,
  DEFAULT_RAG_SYSTEM: require('./ragChain').DEFAULT_RAG_SYSTEM,
  // Compact-history — summarize old messages when conversation exceeds maxMessages (new in 1.91.0)
  compactHistory:    require('./middleware/compactHistory').compactHistory,
  DEFAULT_COMPACT_SUMMARY_SYSTEM: require('./middleware/compactHistory').DEFAULT_SUMMARY_SYSTEM,
  // Distributed lock — per-key exclusive lock across multi-instance deployments (new in 1.92.0)
  distributedLock:   require('./middleware/distributedLock').distributedLock,
  InMemoryLockStore: require('./middleware/distributedLock').InMemoryLockStore,
  DistributedLockHeldError: require('./middleware/distributedLock').DistributedLockHeldError,
  DistributedLockTimeoutError: require('./middleware/distributedLock').DistributedLockTimeoutError,
  // OpenTelemetry spans (enhanced 2nd-gen of 1.3 otel) — cost + correlation + routing + error taxonomy + cache attribution (new in 1.93.0)
  otelSpans:         require('./middleware/otelSpans').otelSpans,
  // Retry-after propagation — enriches errors with retryAfterMs + resetAtMs from provider rate-limit headers (new in 1.94.0)
  retryAfterPropagation: require('./middleware/retryAfterPropagation').retryAfterPropagation,
  // Chain snapshot for GitOps — extract live chain config for diffing against baseline (new in 1.95.0)
  chainSnapshot:     require('./chainSnapshot').chainSnapshot,
  URI_TO_KIND:       require('./chainSnapshot').URI_TO_KIND,
  KNOWN_STATS_FIELDS: require('./chainSnapshot').KNOWN_STATS_FIELDS,
  // Sensitive-data audit trail — immutable hash-chained log of LLM calls containing PII (new in 1.96.0)
  sensitiveDataAudit: require('./middleware/sensitiveDataAudit').sensitiveDataAudit,
  InMemoryAuditStore: require('./middleware/sensitiveDataAudit').InMemoryAuditStore,
  verifyAuditChain:   require('./middleware/sensitiveDataAudit').verifyChain,
  hashAuditEntry:     require('./middleware/sensitiveDataAudit').hashEntry,
  // Streaming token throttler — rate-limit stream chunk emission for smooth UI cursor (new in 1.97.0)
  streamThrottle:     require('./middleware/streamThrottle').streamThrottle,
  // Prompt template linter — static-analysis for prompt templates (new in 1.98.0)
  lintPrompt:         require('./lintPrompt').lintPrompt,
  lintPrompts:        require('./lintPrompt').lintPrompts,
  formatLintReport:   require('./lintPrompt').formatLintReport,
  KNOWN_LINT_RULES:   require('./lintPrompt').KNOWN_RULES,
  DEFAULT_INJECTION_PATTERNS: require('./lintPrompt').DEFAULT_INJECTION_PATTERNS,
  // Multi-region failover — geographic-aware routing + health tracking (new in 1.99.0)
  regionFailover:     require('./regionFailover').regionFailover,
  AllRegionsFailedError: require('./regionFailover').AllRegionsFailedError,
  // Git-backed prompt registry — pull templates from a repo with polling (new in 2.1.0)
  gitPromptRegistry:  require('./gitPromptRegistry').gitPromptRegistry,
  // Cost forecast — rolling-window spend + projected end-of-window total (new in 2.2.0)
  costForecast:       require('./middleware/costForecast').costForecast,
  // Provider capability probe — introspect what features work against the configured provider+model (new in 2.3.0)
  capabilities:            require('./capabilities').capabilities,
  PROVIDER_CAPABILITY_MATRIX: require('./capabilities').PROVIDER_MATRIX,
  MODEL_CAPABILITY_OVERRIDES: require('./capabilities').MODEL_OVERRIDES,
  // Structured response scoring — deterministic rubric evaluator without an LLM call (new in 2.4.0)
  scoreResponse:      require('./scoreResponse').scoreResponse,
  formatScoreReport:  require('./scoreResponse').formatScoreReport,
  KNOWN_SCORE_CHECKS: require('./scoreResponse').KNOWN_CHECK_KINDS,
  // Multi-model consensus voting — parallel N-model vote with quorum + confidence (new in 2.5.0)
  consensusVoting:    require('./consensusVoting').consensusVoting,
  CONSENSUS_COMPARATORS: require('./consensusVoting').COMPARATORS,
  KNOWN_CONSENSUS_COMPARATORS: require('./consensusVoting').KNOWN_COMPARATORS,
  // Adaptive rate-limit tuner — quota-driven bulkhead concurrency adjustment (new in 2.6.0)
  adaptiveRateLimit:  require('./middleware/adaptiveRateLimit').adaptiveRateLimit,
  // Semantic response cache — reuse answers for similar prompts (new in 2.7.0)
  semanticCache:          require('./middleware/semanticCache').semanticCache,
  inMemorySemanticStore:  require('./middleware/semanticCache').inMemorySemanticStore,
  cosineSimilarity:       require('./middleware/semanticCache').cosineSimilarity,
  // Request coalescer — in-flight dedup of identical concurrent LLM calls (new in 2.8.0)
  requestCoalescer:       require('./middleware/requestCoalescer').requestCoalescer,
  // Structured output repair — multi-strategy auto-recovery for schema violations (new in 2.9.0)
  structuredOutputRepair: require('./middleware/structuredOutputRepair').structuredOutputRepair,
  jsonAutoFix:            require('./middleware/structuredOutputRepair').jsonAutoFix,
  // Cost-aware model router — cheap-first, escalate on low score (new in 2.10.0)
  costAwareRouter:        require('./middleware/costAwareRouter').costAwareRouter,
  // Chaos injector — deterministic fault injection for CI resilience testing (new in 2.11.0)
  chaosInjector:          require('./middleware/chaosInjector').chaosInjector,
  // Speculative hedge — staggered parallel hedges, first success wins (new in 2.12.0)
  speculativeHedge:       require('./middleware/speculativeHedge').speculativeHedge,
  AllHedgesFailedError:   require('./middleware/speculativeHedge').AllHedgesFailedError,
  // Reversible PII tokenization — model never sees raw PII (new in 2.13.0)
  reversibleTokenization: require('./middleware/reversibleTokenization').reversibleTokenization,
  tokenizePII:            require('./middleware/reversibleTokenization').tokenizePII,
  detokenizePII:          require('./middleware/reversibleTokenization').detokenizePII,
  PII_PATTERNS:           require('./middleware/reversibleTokenization').BUILT_IN_PATTERNS,
  // Fair-share scheduler — per-tenant WRR admission control (new in 2.14.0)
  fairShareScheduler:     require('./middleware/fairShareScheduler').fairShareScheduler,
  FairShareRejectedError: require('./middleware/fairShareScheduler').FairShareRejectedError,
  // Retry budget — SRE-style cap on retries-to-requests ratio (new in 2.15.0)
  retryBudget:            require('./middleware/retryBudget').retryBudget,
  RetryBudgetExhaustedError: require('./middleware/retryBudget').RetryBudgetExhaustedError,
  // Semantic router — embedding-based routing to model/system prompt buckets (new in 2.16.0)
  semanticRouter:         require('./middleware/semanticRouter').semanticRouter,
  // Provider load balancer — rotate across N credentials of same provider kind (new in 2.17.0)
  providerLoadBalancer:   require('./middleware/providerLoadBalancer').providerLoadBalancer,
  AllCredentialsUnhealthyError: require('./middleware/providerLoadBalancer').AllCredentialsUnhealthyError,
  PROVIDER_LOAD_BALANCER_STRATEGIES: require('./middleware/providerLoadBalancer').STRATEGIES,
  // Function-call arbitrator — policy + validation for LLM tool calls (new in 2.18.0)
  functionCallArbitrator: require('./middleware/functionCallArbitrator').functionCallArbitrator,
  InvalidToolCallError:   require('./middleware/functionCallArbitrator').InvalidToolCallError,
  normalizeToolShape:     require('./middleware/functionCallArbitrator').normalizeToolShape,
  normalizeToolList:      require('./middleware/functionCallArbitrator').normalizeToolList,
  // Session context store — multi-turn memory management (new in 2.19.0)
  sessionContextStore:    require('./middleware/sessionContextStore').sessionContextStore,
  inMemorySessionStore:   require('./middleware/sessionContextStore').inMemorySessionStore,
  // Prompt experiment framework — live A/B testing of prompt variants (new in 2.20.0)
  promptExperiment:       require('./middleware/promptExperiment').promptExperiment,
  // Request signing / HMAC receipts — cryptographic audit trail (new in 2.21.0)
  requestSigning:         require('./middleware/requestSigning').requestSigning,
  verifyReceiptChain:     require('./middleware/requestSigning').verifyReceiptChain,
  REQUEST_SIGNING_ALGORITHMS: require('./middleware/requestSigning').ALLOWED_ALGORITHMS,
  // Auto tool chain — cascading tool-call loop with cycle detection (new in 2.22.0)
  autoToolChain:          require('./middleware/autoToolChain').autoToolChain,
  UnknownToolError:       require('./middleware/autoToolChain').UnknownToolError,
  MaxDepthExceededError:  require('./middleware/autoToolChain').MaxDepthExceededError,
  ToolChainCycleError:    require('./middleware/autoToolChain').ToolChainCycleError,
  // Quota manager — per-user USD quota with sliding-window + warnings (new in 2.23.0)
  quotaManager:           require('./middleware/quotaManager').quotaManager,
  inMemoryQuotaStore:     require('./middleware/quotaManager').inMemoryQuotaStore,
  QuotaExhaustedError:    require('./middleware/quotaManager').QuotaExhaustedError,
  // Stream aggregator — buffer + emit aggregated chunks for smooth UI (new in 2.24.0)
  streamAggregator:       require('./middleware/streamAggregator').streamAggregator,
  // Multimodal attachment router — pick model by attachment type (new in 2.25.0)
  multimodalRouter:       require('./middleware/multimodalRouter').multimodalRouter,
  MULTIMODAL_ROUTE_TYPES: require('./middleware/multimodalRouter').KNOWN_TYPES,
  // Pre-built dashboards + Prometheus alert rules (new in 1.87.0)
  grafanaDashboard:      require('./dashboards').grafanaDashboard,
  prometheusAlertRules:  require('./dashboards').prometheusAlertRules,
  datadogDashboard:      require('./dashboards').datadogDashboard,
  newrelicDashboard:     require('./dashboards').newrelicDashboard,
  // Static middleware-ordering validator (new in 1.48.0)
  validateMiddlewareOrder: require('./validateMiddlewareOrder').validateMiddlewareOrder,
  filterWarnings: require('./validateMiddlewareOrder').filterWarnings,
  // Cost budgets + alerts — per-tenant/model/total ceilings (new in 1.29.0)
  costBudget: require('./middleware/costBudget').costBudget,
  BudgetExceededError: require('./middleware/costBudget').BudgetExceededError,
  // Pluggable budget counter stores — Redis for multi-instance (new in 1.30.0)
  InMemoryCounterStore: require('./middleware/costBudget').InMemoryCounterStore,
  RedisCounterStore: require('./middleware/costBudget').RedisCounterStore,
  // Prompt-template registry (new in 1.8.0)
  PromptRegistry: require('./promptRegistry').PromptRegistry,
  builtInPrompts: require('./promptRegistry').builtInPrompts,
  // Pre-built JSON Schemas for structured extraction (new in 1.34.0)
  schemas: require('./schemas'),
  // Prometheus text-format exporter for the middleware observability
  // surface (new in 1.35.0)
  promMetrics: require('./prometheus').promMetrics,
  prometheusHandler: require('./prometheus').prometheusHandler,
  // Rate-limit header parsers (new in 1.38.0)
  parseOpenAIRateLimit: require('./rateLimits').parseOpenAIRateLimit,
  parseAnthropicRateLimit: require('./rateLimits').parseAnthropicRateLimit,
  parseGeminiRateLimit: require('./rateLimits').parseGeminiRateLimit,
  parseBedrockRateLimit: require('./rateLimits').parseBedrockRateLimit,
  // OpenAI Files API helper (new in 1.14.0)
  uploadPdfFromUrl: require('./openaiFiles').uploadPdfFromUrl,
  // MCP HTTP transport helpers (new in 1.16.0)
  createJwtVerifier: require('./mcp/jwtVerifier').createJwtVerifier,
  // MCP transport factories (new in 1.20.0 — Streamable HTTP)
  createHttpTransport: require('./mcp/httpTransport').createHttpTransport,
  createStreamableHttpTransport: require('./mcp/streamableHttpTransport').createStreamableHttpTransport,
};
