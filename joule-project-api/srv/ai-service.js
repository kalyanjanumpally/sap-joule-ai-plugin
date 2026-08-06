const cds = require('@sap/cds');
const {
  imageFromBase64, imageFromUrl,
  pdfFromBase64, pdfFromUrl,
  audioFromBase64,
  usageMeteringToCap,
  responseCache,
  Agent, runAgents,
  guardrails, filters,
  costBudget, BudgetExceededError,
  promptInjectionGuard, PromptInjectionError,
  schemas,
  prometheusHandler,
  streamAgents,
  retryOnRateLimit, RateLimitGiveUpError,
} = require('@saptarishi/cds-plugin-llm');
const {
  RAG,
  llmRerank,
  createQueryExpander,
} = require('@saptarishi/cds-plugin-vector-hana');

const PO_SYSTEM = `You summarize S/4HANA purchase orders for procurement approvers.
Rules:
- Exactly 2 sentences. No preamble.
- Sentence 1: supplier, material, quantity + unit, net amount + currency.
- Sentence 2: requested delivery date + one specific risk or note the approver should see (late-delivery risk, unusual quantity, off-catalog material, etc.). If nothing notable, say "No exceptions flagged."
- Never invent facts. If a field is missing from the JSON, omit it.`;

const INVOICE_EXTRACT_SYSTEM = `You extract structured data from scanned supplier invoices.
Rules:
- Return every line item you can see. Don't invent items.
- Numbers must be numbers (not strings). Currency codes must be ISO 4217 (EUR, USD, etc.).
- Dates in ISO 8601 (YYYY-MM-DD).
- If a field is not visible in the image, omit it from the output.
- Do not include descriptive prose — only the structured fields requested.`;

const INVOICE_SYSTEM = `You assess S/4HANA supplier invoice risk for AP triage.
Return risk = low | medium | high, and a one-sentence rationale.
High = overdue > 30d, or amount > 100k EUR without matched PO, or duplicate signals.
Medium = overdue 1-30d, or amount 25k-100k without matched PO.
Low = current, matched to PO, within tolerance.
Rationale must cite the specific field(s) driving the rating.`;

// ---- Multi-agent specialist prompts -----------------------------------

const CONTRACT_LOOKUP_SYSTEM = `You are a procurement research specialist.
Your only job is to answer questions about supplier contracts by looking them up in the contract database.
Rules:
- Always call the search_contracts tool. Do not answer from prior knowledge.
- Cite the contract ID (CTR-YYYY-NNN or the entity ID) in your answer.
- If the search returns nothing relevant, say so plainly.
- Keep answers to 2-3 sentences.`;

const PRICE_ANALYST_SYSTEM = `You are a procurement price analyst.
Your job is to reason about pricing terms in supplier contracts. You will typically be given contract text as part of your input; extract the numeric terms (rate cards, indexing, discounts, penalties) and answer the caller's question.
Rules:
- Only use numbers that are literally in the input. Do not fabricate rates.
- If a rate is expressed as an index (e.g. "LME +/- 4%"), name the index.
- Flag any ambiguity — the caller can go back to the coordinator with a clarification.
- Keep answers to 2-4 sentences.`;

const COMPLIANCE_CHECKER_SYSTEM = `You are a procurement compliance checker.
Given contract text or a described scenario, you flag potential compliance concerns.
Categories to check:
- REACH / RoHS / conflict minerals for raw materials
- Green-electricity / carbon-offset claims
- Data protection (GDPR / SOC2) for IT services
- Sanctions / export controls for cross-border shipments
Rules:
- If nothing looks concerning, say "No compliance flags." explicitly.
- Otherwise, cite the specific clause / claim you're flagging in one sentence per flag.
- Keep answers under 6 sentences total.`;

// Module-scoped lazy singleton so the streaming Express route (registered in
// AIService.init below) and the OData handlers share one LLM instance.
//
// Middleware stack (top = OUTER, bottom = INNER):
//
//   guardrails         — input/output filters. Runs FIRST so the scrubbed
//                        request reaches every downstream layer (metering
//                        records scrubbed content, cache keys on scrubbed
//                        content, provider sees scrubbed content). Output
//                        filters run LAST so the caller never sees PII the
//                        model surfaced from its retrieval sources.
//   usageMeteringToCap  — persists every request into FinanceService.LlmSpend.
//                         Must observe cache-hit responses on the way back up
//                         the chain — those get recorded with cost=0 and
//                         increment totalCachedHits + totalCostSaved.
//   responseCache       — memoizes identical chat() calls. In-memory LRU with
//                         a 1-hour TTL for the demo; swap for Redis / HANA
//                         cache in a real BTP deployment via the `store` opt.
//
// The three together mean: every LLM call is scrubbed + tracked + potentially
// cached. Cache hits show up as $0 rows in LlmSpend; PII never leaves the
// tenant boundary; injection attempts throw a GuardrailBlockedError and are
// logged for the security team to review.
let _llmPromise;
let _cache;
let _guardrails;
let _budget;
let _injectionGuard;
let _metering;
let _retry;
// Shared limits object — passed by reference to costBudget() so
// FinanceService can mutate it live from LlmBudget rows without a
// restart. costBudget reads from this via limitFor() on every call.
const _budgetLimits = { total: undefined, perTenant: {}, perModel: {} };
function getLLM() {
  if (!_llmPromise) {
    _llmPromise = cds.connect.to('llm').then((llm) => {
      // Prompt injection guard — sits OUTER of everything else so the
      // sanitized (or refused) payload is what guardrails + cache + meter +
      // provider all see. Runs BEFORE guardrails so it can spot zero-width
      // chars and homoglyphs before NFKC normalization would erase them.
      // action='sanitize' means classic override attempts (base64-smuggled,
      // fake-turn markers, <|im_start|>) get stripped rather than blocked —
      // preserves user intent while removing the attack surface. Genuine
      // jailbreak attempts still cross threshold via the regex layer and
      // get scrubbed to `[role-marker-removed]` etc.
      _injectionGuard = promptInjectionGuard({
        action:    'sanitize',
        threshold: 0.6,
        maxUserMessageChars: 8000,
        onDetect: (info) => {
          cds.log('llm:injection').warn(
            `[injection] ${info.action} @ score=${info.score.toFixed(2)}: ${info.evidence.join('; ')}`,
          );
        },
      });
      llm.use(_injectionGuard);
      _guardrails = guardrails({
        inputFilters: [
          // Fast first-line filter — same regex family as the guard above,
          // kept here as a hard-block backstop for the highest-confidence
          // patterns. Redundant with the guard's regex detector; cost is
          // one extra regex pass on user text (negligible).
          filters.promptInjection(),
          // Internal-only string blocklist — e.g. codes, endpoints, secret
          // names that must never leave the SAP tenant boundary. Add real
          // patterns in your deployment.
          filters.blocklist(['<INTERNAL-SECRET>'], { mode: 'block' }),
          // PII scrubbing on the way in — accidental paste of SSNs / credit
          // cards / emails / phone numbers gets redacted before the provider
          // ever sees them.
          filters.pii({ redact: true }),
        ],
        outputFilters: [
          // Model may echo PII from retrieved contract text (contact emails,
          // phone numbers in the terms column). Scrub before returning.
          filters.pii({ redact: true }),
        ],
        onBlock: (info) => {
          cds.log('llm:guardrails').warn(
            `[guardrails] blocked at ${info.stage} (filter #${info.filterIndex}): ${info.reason}`,
          );
        },
        onRedact: (info) => {
          cds.log('llm:guardrails').info(
            `[guardrails] redacted at ${info.stage} (filter #${info.filterIndex})`,
          );
        },
      });
      llm.use(_guardrails);
      // costBudget — starts empty; FinanceService.init() populates it from
      // the LlmBudget entity once the DB is up. Sits OUTER of the meter so
      // a refusal (BudgetExceededError) short-circuits before a $0 row would
      // land in LlmSpend.
      _budget = costBudget({
        limits:   _budgetLimits,        // shared reference — FinanceService mutates this
        window:   'day',
        action:   'throw',
        currency: 'USD',
        tenantOf:   (ctx) => ctx.raw?.tenant ?? cds.context?.tenant ?? 'default',
        onExceeded: (info) => {
          cds.log('llm:budget')[info.action === 'block' ? 'warn' : 'info'](
            `[budget] ${info.action}: ${info.scope}='${info.key}' — spent ${info.current.toFixed(4)} ${info.currency}, limit ${info.limit} ${info.currency}`,
          );
        },
      });
      llm.use(_budget);
      // Rate-limit retry sits between costBudget (blocks BEFORE the call)
      // and usageMetering (records what happened). Placement rationale:
      //   - INNER of costBudget: if a retry pushes us over the budget on
      //     attempt N, the pre-check on attempt N+1 fires correctly.
      //   - OUTER of usageMetering: retries don't inflate LlmSpend rows
      //     (one logical request = one metering row).
      // Disable the base LLMService's built-in withRetry (max: 3, baseMs: 500)
      // via per-request retries: {max: 0} on our own chat() calls if we want
      // this middleware to see every throttle. For the demo we let both
      // layers work — the built-in provides quick backoff for transient
      // errors, this layer catches sustained rate-limit pressure with a
      // longer patience budget.
      _retry = retryOnRateLimit({
        maxAttempts:    3,
        fallbackWaitMs: 2000,
        jitterMs:       500,
        onRetry:  (info) => cds.log('llm:retry').warn(
          `[retry] attempt ${info.attempt} in ${info.waitMs}ms (status=${info.status}): ${info.error.message.slice(0, 80)}`,
        ),
        onGiveUp: (info) => cds.log('llm:retry').error(
          `[retry] gave up after ${info.attempts.length} retries: ${info.finalError.message.slice(0, 100)}`,
        ),
      });
      llm.use(_retry);
      _metering = usageMeteringToCap(cds, {
        tenantOf:   (ctx) => ctx.raw?.tenant ?? cds.context?.tenant ?? 'default',
        providerOf: (ctx) => ctx.raw?.providerAlias ?? cds.env.requires?.llm?.kind ?? null,
      });
      llm.use(_metering);
      // Semantic cache — reuses the `llm-embed` alias (Ollama nomic-embed-text
      // by default, or genai-hub embed deployment in prod). Cache hits now
      // fire not only on exact prompt matches but on semantically-similar
      // rephrasing. Threshold 0.88 is a middle-ground: strict enough to
      // avoid returning wrong answers to structurally-different questions,
      // loose enough to catch chatty rephrasings ("summarize PO-42", "give me
      // a summary of PO-42", "brief me on PO-42"). Lazy-init the embed
      // service on first miss — no boot-time hit if the app never gets called.
      let embedSvcPromise;
      const embedder = async (text) => {
        embedSvcPromise ??= cds.connect.to('llm-embed');
        const embedSvc = await embedSvcPromise;
        const { embeddings } = await embedSvc.embed({ input: [text] });
        return embeddings[0];
      };
      _cache = responseCache({
        ttl: 60 * 60 * 1000, // 1 hour
        semantic: {
          embedder,
          threshold:     0.88,
          maxScan:       200,
          minTextLength: 30, // don't embed tiny prompts — waste of an embed call
        },
      });
      llm.use(_cache);
      return llm;
    });
  }
  return _llmPromise;
}

/** Exported for FinanceService to install/refresh budget limits from the DB. */
function getBudget() { return _budget; }
function getBudgetLimits() { return _budgetLimits; }

/** Exported for `/ai/cache-stats` — a small ops-visible dashboard on the cache. */
function getCache() { return _cache; }
/** Exported for `/ai/guardrails-stats` — hits/blocks/redacts dashboard. */
function getGuardrails() { return _guardrails; }
/** Exported for `/injection-stats` — prompt-injection detection dashboard. */
function getInjectionGuard() { return _injectionGuard; }
/** Exported for the MCP service — usage metering middleware for summary(). */
function getMetering() { return _metering; }
/** Exported for the MCP service + /retry-stats dashboard. */
function getRetry() { return _retry; }

/**
 * SSE streaming handler — plain Express, not OData. Registered from within
 * AIService.init() so it fires after cds.app is available.
 *
 *   POST /stream/summarizePurchaseOrder
 *   body: { purchaseOrderId, poJson }
 *   response: text/event-stream
 *     data: {"type":"text_delta","text":"Acme "}\n\n
 *     data: {"type":"text_delta","text":"Steel "}\n\n
 *     data: {"type":"done","text":"...","usage":{...},"model":"..."}\n\n
 */
/**
 * SSE handler for the multi-agent analyzeScenario flow. Powered by
 * streamAgents() from cds-plugin-llm 1.41.0 — the invoke_<name> tool
 * conversion + trace repackaging happens plugin-side, so events emitted to
 * the SSE stream already carry clean agent slugs like
 * `agent_call_start { agent: 'contract-lookup', question: '...' }`.
 */
function makeAnalyzeScenarioStreamHandler(llm) {
  return async (req, res) => {
    const { scenario } = req.body ?? {};
    if (!scenario) {
      res.status(400).json({ error: 'scenario is required in JSON body' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      for await (const evt of streamAgents({
        coordinator: llm,
        agents: buildScenarioSpecialists(llm),
        input: scenario,
        maxSteps: 8,
      })) {
        // Client disconnect: any write throws → catch aborts the loop
        write(evt);
      }
      res.end();
    } catch (e) {
      try { write({ type: 'error', message: e.message }); res.end(); }
      catch { /* socket gone */ }
    }
  };
}

/**
 * Build the same specialist trio used by the OData analyzeScenario action.
 * Shared so streaming + non-streaming paths route through identical prompts
 * and tool wiring (contract-lookup uses the @rag hybrid search).
 */
function buildScenarioSpecialists(llm) {
  const searchContracts = {
    name: 'search_contracts',
    description: 'Semantic + keyword search over supplier contracts. Returns the top matching contracts as JSON.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or exact ID like CTR-2026-101.' },
        topK:  { type: 'integer', description: '1-10; default 5' },
      },
      required: ['query'],
    },
    run: async ({ query, topK }) => {
      const hits = await cds.vectorHana.searchByMeaning({
        entity: 'ProcurementService.SupplierContracts',
        query,
        topK: topK ?? 5,
      });
      return JSON.stringify(hits.map((h) => ({
        ID:           h.id,
        supplierName: h.metadata?.supplierName,
        contractType: h.metadata?.contractType,
        region:       h.metadata?.region,
        text:         h.text,
      })), null, 2);
    },
  };

  return [
    new Agent({
      name: 'contract-lookup',
      description: 'Answers questions about supplier contracts. Give it the question in plain English (or a literal contract ID).',
      llm,
      system: CONTRACT_LOOKUP_SYSTEM,
      tools: [searchContracts],
      maxSteps: 3,
    }),
    new Agent({
      name: 'price-analyst',
      description: 'Extracts pricing terms from a piece of contract text. Give it the contract text or a summary, plus the question.',
      llm,
      system: PRICE_ANALYST_SYSTEM,
    }),
    new Agent({
      name: 'compliance-checker',
      description: 'Flags compliance concerns (REACH, RoHS, GDPR, sanctions, green claims) in a contract or scenario.',
      llm,
      system: COMPLIANCE_CHECKER_SYSTEM,
    }),
  ];
}

function makeStreamHandler(llm) {
  return async (req, res) => {
    const { purchaseOrderId, poJson } = req.body ?? {};
    if (!poJson) {
      res.status(400).json({ error: 'poJson is required in JSON body' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // hint to nginx / CF gorouter to flush
    res.flushHeaders?.();

    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      for await (const chunk of llm.stream({
        system: PO_SYSTEM,
        messages: [{ role: 'user', content: poJson }],
        maxTokens: 300,
      })) {
        // If the client disconnected mid-stream, res.write throws and we exit via catch.
        write({ ...chunk, purchaseOrderId });
      }
      res.end();
    } catch (e) {
      // Client-close or upstream failure — try to notify (safe if socket is still open)
      try { write({ type: 'error', message: e.message }); res.end(); } catch { /* socket gone */ }
    }
  };
}

module.exports = class AIService extends cds.ApplicationService {
  async init() {
    const llm = await getLLM();

    // Observability MCP surface — spins up a Streamable HTTP MCP server on
    // port 3334 that exposes every middleware's asMcpResource() plus a small
    // tool surface (reload_budget, reset_cache, reset_injection_stats). Bound
    // to cds.once('served') so all middleware is wired before we build the
    // resource list. Set MCP_OBS_DISABLE to skip; MCP_OBS_TOKEN to require
    // bearer auth.
    cds.once('served', async () => {
      const { startObservabilityMcp } = require('./mcp-service');
      await startObservabilityMcp({
        getCache, getBudget, getBudgetLimits, getGuardrails, getInjectionGuard, getMetering, getRetry,
      });
    });

    // Wrap the vector-hana plugin's `cds.vectorHana.askAbout` with a
    // version that runs the FULL 5-stage RAG pipeline:
    //   1. expand      — createQueryExpander (HyDE) writes a hypothetical
    //                    answer; both the question AND the hypothetical
    //                    answer get embedded and retrieved on. Boosts
    //                    recall on abstract / under-specified queries.
    //   2. hybrid      — vector + keyword search per expanded query.
    //   3. RRF fuse    — Reciprocal Rank Fusion across all queries.
    //   4. LLM rerank  — the LLM scores each candidate 0-10, re-sorts.
    //   5. chat answer — augmented prompt with the top hits + citations.
    // All driven by the same LLM alias so the whole pipeline stays inside
    // whichever provider the app is configured for. Only touched once
    // per boot; safe if called by any concurrent request afterwards.
    if (cds.vectorHana && !cds.vectorHana._ragPipelineInstalled) {
      const expand = createQueryExpander({ llm, strategy: 'hyde' });
      const rerank = llmRerank({ llm });
      cds.vectorHana.askAbout = async (params = {}) => {
        const { entity, query, topK, filter, alpha, systemInstructions, ...chatOpts } = params;
        const store = cds.vectorHana.getStore(entity);
        if (!store) throw new Error(`no @rag store registered for '${entity}' — is the entity annotated?`);
        const rag = new RAG({ llm, store, mode: 'hybrid', expand, rerank });
        // filter + alpha (both new in vector-hana 0.11.0) are forwarded so
        // consumers can call the OData action with either or both:
        //   { query, filter: '{"region":"EMEA"}', alpha: 0.7 }
        // Undefined values pass through — RAG only exercises them when set.
        return rag.answer({
          query,
          topK: topK ?? 5,
          filter, alpha, systemInstructions, ...chatOpts,
        });
      };
      cds.vectorHana._ragPipelineInstalled = true;
    }

    // Register the SSE streaming endpoint on the Express app. Path is
    // /stream/... (not /ai/stream/...) because CAP mounts the OData handler
    // as middleware on /ai and catches everything under it.
    if (cds.app) {
      const express = require('express');
      cds.app.post(
        '/stream/summarizePurchaseOrder',
        express.json({ limit: '1mb' }),
        makeStreamHandler(llm),
      );

      // Multi-agent analyzeScenario with LIVE progress over SSE.
      // Runs the same 3-specialist supervisor flow as the OData
      // POST /ai/analyzeScenario action, but yields streamAgents() events
      // one at a time so a chat UI can render agent badges. Powered by
      // cds-plugin-llm 1.41.0 (invoke_<name> conversion happens plugin-side).
      //
      //   POST /stream/analyzeScenario
      //   body: { scenario }
      //   response: text/event-stream — one JSON event per line
      //     data: {"type":"turn_start","step":1}
      //     data: {"type":"text","step":1,"text":"I'll check the contracts first..."}
      //     data: {"type":"agent_call_start","step":1,"agent":"contract-lookup","question":"..."}
      //     data: {"type":"agent_call_result","step":1,"agent":"contract-lookup","answer":"...","isError":false}
      //     data: {"type":"done","step":3,"text":"...","trace":[...],"usage":{...}}
      cds.app.post(
        '/stream/analyzeScenario',
        express.json({ limit: '1mb' }),
        makeAnalyzeScenarioStreamHandler(llm),
      );

      // Ops dashboard for the response cache. Combined with the
      // FinanceService.LlmSpend entity, this makes savings observable:
      //   GET /finance/LlmSpend?$filter=totalCost eq 0  → cache-hit rows
      //   GET /cache-stats                              → hit rate + size
      cds.app.get('/cache-stats', (_req, res) => {
        const cache = getCache();
        if (!cache) return res.status(503).json({ error: 'cache not initialized yet' });
        res.json({
          hits:              cache.stats.hits,
          misses:            cache.stats.misses,
          skips:             cache.stats.skips,
          semanticHits:      cache.stats.semanticHits,
          semanticMisses:    cache.stats.semanticMisses,
          embedderErrors:    cache.stats.embedderErrors,
          hitRate:           cache.hitRate(),
          size:              cache.size(),
          semanticIndexSize: cache.semanticIndex.size,
        });
      });
      // Guardrails dashboard — block / redact counters (both stages).
      // Combined with /finance/LlmSpend (metered requests) this gives
      // Ops a complete picture: N requests came in, X were blocked, Y
      // scrubbed, Z hit the cache, W actually reached the provider.
      cds.app.get('/guardrails-stats', (_req, res) => {
        const gr = getGuardrails();
        if (!gr) return res.status(503).json({ error: 'guardrails not initialized yet' });
        res.json(gr.stats);
      });
      // Prompt-injection guard dashboard — scanned / blocked / sanitized /
      // warned counters + per-detector breakdown. Combines with
      // /guardrails-stats to give a complete picture of every rejection layer.
      cds.app.get('/injection-stats', (_req, res) => {
        const g = getInjectionGuard();
        if (!g) return res.status(503).json({ error: 'injection guard not initialized yet' });
        res.json(g.stats);
      });
      // Rate-limit retry dashboard — counters + total wait time absorbed.
      // Complements /finance/LlmSpend + /budget-status by showing throttling
      // pressure ops needs to see before it becomes user-visible latency.
      cds.app.get('/retry-stats', (_req, res) => {
        const r = getRetry();
        if (!r) return res.status(503).json({ error: 'retry middleware not initialized yet' });
        res.json(r.stats);
      });
      // Prometheus /metrics — same counters as the /*-stats endpoints but
      // serialized to Prom 0.0.4 text-exposition. Scrape-friendly for
      // Grafana + DataDog agent + Kubernetes ServiceMonitor. cardinality
      // for a demo is fine; a real deployment with 1000s of tenants should
      // pass { excludeBreakdowns: true } to drop the per-tenant series.
      cds.app.get('/metrics', prometheusHandler({
        cache:          getCache(),
        budget:         getBudget(),
        guardrails:     getGuardrails(),
        injectionGuard: getInjectionGuard(),
        metering:       getMetering(),
      }));
      // Budget dashboard — current-window spend + configured limits.
      // Complements the OData `FinanceService.getBudgetStatus()` action
      // with a simpler HTTP endpoint (no OData $inlinecount overhead) for
      // dashboards / kubelet probes.
      cds.app.get('/budget-status', async (_req, res) => {
        const budget = getBudget();
        if (!budget) return res.status(503).json({ error: 'budget not initialized yet' });
        const snap = await budget.snapshot();
        res.json({
          window:   snap.window,
          currency: snap.currency,
          total:    { spent: snap.total, limit: budget.limitFor('total', 'total') },
          perTenant: Object.entries(snap.perTenant).map(([key, spent]) => ({
            key, spent, limit: budget.limitFor('perTenant', key),
          })),
          perModel: Object.entries(snap.perModel).map(([key, spent]) => ({
            key, spent, limit: budget.limitFor('perModel', key),
          })),
        });
      });
    }

    this.on('summarizePurchaseOrder', async (req) => {
      const { purchaseOrderId, poJson } = req.data;
      const { text, usage, model } = await llm.chat({
        system: PO_SYSTEM,
        messages: [{ role: 'user', content: poJson }],
        cache: true,
        maxTokens: 300,
      });
      return {
        purchaseOrderId,
        summary: text,
        tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        model,
      };
    });

    this.on('explainInvoiceRisk', async (req) => {
      const { invoiceId, invoiceJson } = req.data;
      const { data, usage, model, text } = await llm.chat({
        system: INVOICE_SYSTEM,
        messages: [{ role: 'user', content: `Invoice ${invoiceId}:\n${invoiceJson}` }],
        cache: true,
        maxTokens: 400,
        // Structured output — use the shipped SupplierRisk schema. Same
        // {risk enum, rationale, confidence, factors[]} shape as the new
        // assessSupplierRisk action; UI can render them identically.
        format: schemas.SupplierRisk,
      });

      if (!data?.risk) {
        req.error(500, `LLM did not return a parseable risk object: ${text?.slice(0, 200)}`);
        return;
      }

      return {
        invoiceId,
        risk: data.risk,
        rationale: data.rationale,
        confidence: data.confidence,
        factors:    data.factors ?? [],
        tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        model,
      };
    });

    this.on('extractInvoiceLineItems', async (req) => {
      const { imageBase64, imageUrl, pdfBase64, pdfUrl, mediaType, model } = req.data;

      const isPdf = !!(pdfBase64 || pdfUrl);
      const isImage = !!(imageBase64 || imageUrl);

      if (!isPdf && !isImage) {
        req.error(400, 'Provide one of: imageBase64, imageUrl, pdfBase64, pdfUrl');
        return;
      }
      if (isPdf && isImage) {
        req.error(400, 'Provide either an image OR a PDF, not both');
        return;
      }

      let contentBlock;
      let defaultModel;
      if (isPdf) {
        // PDF path: Anthropic-only. Caller's LLM config must be llm-anthropic
        // OR they pass model: 'claude-...' AND the configured provider is Anthropic.
        contentBlock = pdfBase64 ? pdfFromBase64(pdfBase64) : pdfFromUrl(pdfUrl);
        defaultModel = 'claude-opus-4-7';
      } else {
        contentBlock = imageBase64
          ? imageFromBase64(imageBase64, mediaType || 'image/png')
          : imageFromUrl(imageUrl);
        // Groq's current vision model; overridable
        defaultModel = 'meta-llama/llama-4-scout-17b-16e-instruct';
      }

      const { data, usage, model: usedModel, text } = await llm.chat({
        model: model || defaultModel,
        system: INVOICE_EXTRACT_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            contentBlock,
            { type: 'text', text: 'Extract the invoice into the requested JSON shape.' },
          ],
        }],
        maxTokens: 1500,
        // Shipped Invoice schema. Field-for-field match with the previous
        // hand-rolled schema — dropped ~30 lines of duplicated shape.
        format: schemas.Invoice,
      });

      if (!data) {
        req.error(500, `Vision extract failed — LLM did not return parseable JSON: ${text?.slice(0, 300)}`);
        return;
      }

      return {
        vendor:        data.vendor,
        invoiceNumber: data.invoiceNumber,
        invoiceDate:   data.invoiceDate,
        dueDate:       data.dueDate,
        currency:      data.currency,
        subtotal:      data.subtotal,
        tax:           data.tax,
        total:         data.total,
        lineItems:     data.lineItems ?? [],
        tokensUsed:    (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        model:         usedModel,
      };
    });

    // ---- analyzeScenario: multi-agent supervisor ---------------------
    //
    // Three specialist agents (contract-lookup, price-analyst,
    // compliance-checker) behind a supervisor coordinator. All four LLM
    // instances share the same `llm` service alias (so usageMeteringToCap +
    // responseCache still track everything) but the contract-lookup
    // specialist is the only one wired with a tool — a search over the
    // @rag-annotated SupplierContracts.
    //
    // Because runAgents/Agent are pure JS glue over runTools, all the
    // familiar guarantees carry through: per-turn usage aggregation,
    // maxSteps safety cap, cache hits on any specialist's chat() call,
    // usageMeteringToCap rows in FinanceService.LlmSpend per LLM call.
    this.on('analyzeScenario', async (req) => {
      const { scenario } = req.data;
      // Shared with the /stream/analyzeScenario SSE endpoint — both flows
      // use identical prompts + tool wiring (contract-lookup uses the
      // @rag hybrid search). See buildScenarioSpecialists() above.
      const result = await runAgents({
        coordinator: llm,
        agents: buildScenarioSpecialists(llm),
        input: scenario,
        maxSteps: 8,
      });

      return {
        answer: result.text,
        trace: result.trace.map((t) => ({
          agent:    t.agent,
          question: t.question ?? '',
          answer:   typeof t.answer === 'string' ? t.answer : JSON.stringify(t.answer),
          isError:  t.isError,
        })),
        steps: result.steps,
      };
    });

    // ---- assessSupplierRisk — free-form supplier risk assessment ------
    //
    // Same {risk, rationale, confidence, factors[]} shape as
    // explainInvoiceRisk, but takes free-text scenario (recent incidents,
    // geopolitical context, financial signals) instead of a specific
    // invoice. Uses schemas.SupplierRisk directly — one line vs. ~15 for
    // a hand-rolled equivalent.
    this.on('assessSupplierRisk', async (req) => {
      const { supplierId, scenario } = req.data;
      const { data, usage, model, text } = await llm.chat({
        system: `You assess procurement supplier risk. Rate as low/medium/high based on the evidence. Cite the specific factors driving the rating; do not fabricate. If key data is missing, lower the confidence score.`,
        messages: [{
          role: 'user',
          content: `Supplier ${supplierId}\n\nContext:\n${scenario}\n\nAssess the risk and list the driving factors.`,
        }],
        cache: true,
        maxTokens: 800,
        format: schemas.SupplierRisk,
      });
      if (!data?.risk) {
        req.error(500, `LLM did not return a parseable risk assessment: ${text?.slice(0, 200)}`);
        return;
      }
      return {
        supplierId,
        risk:       data.risk,
        rationale:  data.rationale,
        confidence: data.confidence,
        factors:    data.factors ?? [],
        tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        model,
      };
    });

    // ---- transcribeVoiceNoteToPO — voice → PurchaseOrderDraft ---------
    //
    // Wraps the raw base64 recording in an audio content block via the
    // audioFromBase64 helper (new in cds-plugin-llm 1.36.0), then asks an
    // audio-capable model to extract the schemas.PurchaseOrder shape
    // (new in 1.34.0). One action, both primitives.
    //
    // Provider matrix:
    //   Gemini              works natively (inline audio)
    //   OpenAI-compat       works with gpt-4o-audio-preview (input_audio block)
    //   Anthropic / Ollama  throw the clear diagnostic shipped in 1.36.0
    //   (Groq / DeepSeek)   400 upstream — models don't speak audio
    this.on('transcribeVoiceNoteToPO', async (req) => {
      const { audioBase64, format, model } = req.data;
      const fmt = (format || 'mp3').toLowerCase();
      const MIME = {
        wav:  'audio/wav',  mp3: 'audio/mpeg', m4a: 'audio/mp4',
        ogg:  'audio/ogg',  flac: 'audio/flac', aac: 'audio/aac',
        opus: 'audio/opus', webm: 'audio/webm',
      };
      const mediaType = MIME[fmt];
      if (!mediaType) {
        req.error(400, `Unsupported audio format '${format}'. Use: ${Object.keys(MIME).join(', ')}`);
        return;
      }

      const audio = audioFromBase64(audioBase64, mediaType);

      try {
        const { data, usage, model: usedModel, text } = await llm.chat({
          model: model || undefined,   // fall through to configured default
          system: 'You extract structured purchase orders from spoken voice memos. Field values must come from what was actually said; do not invent SKUs, prices, or delivery dates. Currency codes must be ISO 4217. Dates in ISO 8601 (YYYY-MM-DD). If a field is missing from the recording, omit it.',
          messages: [{
            role: 'user',
            content: [
              audio,
              { type: 'text', text: 'Extract the purchase order into the requested JSON shape.' },
            ],
          }],
          cache: true,       // identical voice memos happen more than you'd think
          maxTokens: 1200,
          format: schemas.PurchaseOrder,
        });

        if (!data) {
          req.error(500, `Voice extract failed — LLM did not return parseable JSON: ${text?.slice(0, 300)}`);
          return;
        }

        return {
          poNumber:              data.poNumber ?? '',
          supplier:              data.supplier,
          orderDate:             data.orderDate ?? '',
          requestedDeliveryDate: data.requestedDeliveryDate ?? '',
          currency:              data.currency,
          totalAmount:           data.totalAmount,
          lineItems:             data.lineItems ?? [],
          incoterm:              data.incoterm ?? '',
          approver:              data.approver ?? '',
          notes:                 data.notes ?? '',
          tokensUsed:            (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
          model:                 usedModel,
        };
      } catch (e) {
        // Provider-clear diagnostics from cds-plugin-llm 1.36.0 for audio-
        // incapable providers — surface them 1:1 so the caller can act.
        if (/Audio.*not supported|Claude Voice|whisper|Nova Sonic/i.test(e.message)) {
          req.error(400, e.message);
          return;
        }
        throw e;
      }
    });

    return super.init();
  }
};

// Expose the budget middleware + shared limits object so FinanceService can
// install limits + read live counters. Attached AFTER the class assignment
// to avoid being clobbered by `module.exports = class AIService...`.
module.exports.getBudget = getBudget;
module.exports.getBudgetLimits = getBudgetLimits;
module.exports.getCache = getCache;
module.exports.getGuardrails = getGuardrails;
module.exports.getInjectionGuard = getInjectionGuard;
module.exports.getMetering = getMetering;
module.exports.getRetry = getRetry;
module.exports.getLLM = getLLM;
