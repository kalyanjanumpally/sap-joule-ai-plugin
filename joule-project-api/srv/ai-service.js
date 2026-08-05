const cds = require('@sap/cds');
const {
  imageFromBase64, imageFromUrl,
  pdfFromBase64, pdfFromUrl,
  usageMeteringToCap,
  responseCache,
  Agent, runAgents,
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
//   usageMeteringToCap  — persists every request into FinanceService.LlmSpend.
//                         Must be OUTER so it observes cache-hit responses on
//                         the way back up the chain — those get recorded with
//                         cost=0 and increment totalCachedHits + totalCostSaved.
//   responseCache       — memoizes identical chat() calls. In-memory LRU with
//                         a 1-hour TTL for the demo; swap for Redis / HANA
//                         cache in a real BTP deployment via the `store` opt.
//                         Streams + embeds + tool-turn responses skip the
//                         cache automatically.
//
// The two together mean: every LLM call gets tracked, cache hits get billed
// $0 in LlmSpend, and the demo can hit the same query twice and watch the
// second one come back instantly + cost-free.
let _llmPromise;
let _cache;
function getLLM() {
  if (!_llmPromise) {
    _llmPromise = cds.connect.to('llm').then((llm) => {
      llm.use(usageMeteringToCap(cds, {
        tenantOf:   (ctx) => ctx.raw?.tenant ?? cds.context?.tenant ?? 'default',
        providerOf: (ctx) => ctx.raw?.providerAlias ?? cds.env.requires?.llm?.kind ?? null,
      }));
      _cache = responseCache({ ttl: 60 * 60 * 1000 }); // 1 hour
      llm.use(_cache);
      return llm;
    });
  }
  return _llmPromise;
}

/** Exported for `/ai/cache-stats` — a small ops-visible dashboard on the cache. */
function getCache() { return _cache; }

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
        const { entity, query, topK, filter, systemInstructions, ...chatOpts } = params;
        const store = cds.vectorHana.getStore(entity);
        if (!store) throw new Error(`no @rag store registered for '${entity}' — is the entity annotated?`);
        const rag = new RAG({ llm, store, mode: 'hybrid', expand, rerank });
        return rag.answer({
          query,
          topK: topK ?? 5,
          filter, systemInstructions, ...chatOpts,
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

      // Ops dashboard for the response cache. Combined with the
      // FinanceService.LlmSpend entity, this makes savings observable:
      //   GET /finance/LlmSpend?$filter=totalCost eq 0  → cache-hit rows
      //   GET /cache-stats                              → hit rate + size
      cds.app.get('/cache-stats', (_req, res) => {
        const cache = getCache();
        if (!cache) return res.status(503).json({ error: 'cache not initialized yet' });
        res.json({
          hits:    cache.stats.hits,
          misses:  cache.stats.misses,
          skips:   cache.stats.skips,
          hitRate: cache.hitRate(),
          size:    cache.size(),
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
        // Structured output: plugin post-parses the response into `data`
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

      if (!data?.risk) {
        req.error(500, `LLM did not return a parseable risk object: ${text?.slice(0, 200)}`);
        return;
      }

      return {
        invoiceId,
        risk: data.risk,
        rationale: data.rationale,
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
        format: {
          type: 'object',
          properties: {
            vendor:        { type: 'string' },
            invoiceNumber: { type: 'string' },
            invoiceDate:   { type: 'string' },
            dueDate:       { type: 'string' },
            currency:      { type: 'string' },
            subtotal:      { type: 'number' },
            tax:           { type: 'number' },
            total:         { type: 'number' },
            lineItems: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  quantity:    { type: 'number' },
                  unitPrice:   { type: 'number' },
                  lineTotal:   { type: 'number' },
                },
                required: ['description', 'quantity', 'unitPrice', 'lineTotal'],
                additionalProperties: false,
              },
            },
          },
          required: ['vendor', 'total', 'currency', 'lineItems'],
          additionalProperties: false,
        },
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

      // Tool wired to the vector-hana plugin's hybrid search. The agent
      // will call this whenever the scenario mentions a supplier / contract.
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

      const contractLookup = new Agent({
        name: 'contract-lookup',
        description: 'Answers questions about supplier contracts. Give it the question in plain English (or a literal contract ID).',
        llm,
        system: CONTRACT_LOOKUP_SYSTEM,
        tools: [searchContracts],
        maxSteps: 3,
      });
      const priceAnalyst = new Agent({
        name: 'price-analyst',
        description: 'Extracts pricing terms from a piece of contract text. Give it the contract text or a summary, plus the question.',
        llm,
        system: PRICE_ANALYST_SYSTEM,
      });
      const complianceChecker = new Agent({
        name: 'compliance-checker',
        description: 'Flags compliance concerns (REACH, RoHS, GDPR, sanctions, green claims) in a contract or scenario.',
        llm,
        system: COMPLIANCE_CHECKER_SYSTEM,
      });

      const result = await runAgents({
        coordinator: llm,
        agents: [contractLookup, priceAnalyst, complianceChecker],
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

    return super.init();
  }
};
