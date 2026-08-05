# joule-project-api

CAP backend for the **Procurement Copilot** Joule agent. Hosts LLM-backed actions the agent calls via a BTP destination.

## Actions exposed

| OData action | Purpose |
|---|---|
| `POST /ai/summarizePurchaseOrder` | 2-sentence approver-ready PO summary |
| `POST /ai/explainInvoiceRisk` | AP triage risk rating (low/medium/high) + rationale |
| `POST /ai/extractInvoiceLineItems` | Structured extraction from an invoice image or PDF |
| `POST /procurement/SupplierContracts/ProcurementService.searchByMeaning` | **Semantic search over supplier contracts (auto-declared by `@rag`)** |
| `POST /procurement/SupplierContracts/ProcurementService.askAbout` | **Q&A with cited sources over supplier contracts (auto-declared by `@rag`)** |
| `GET  /finance/LlmSpend` | **Per-request LLM cost accounting — auto-persisted by `usageMeteringToCap` middleware. Queryable via OData: `$filter=tenant eq 'acme'`, `$orderby=totalCost desc`, etc.** |

The `/ai/*` actions delegate to whichever LLM provider is configured under `cds.requires.llm` (see [`../cds-plugin-llm`](../cds-plugin-llm/README.md)). The `/procurement/*` actions are auto-declared by [`@saptarishi/cds-plugin-vector-hana`](../cds-plugin-vector-hana/README.md) from the `@rag` annotation on `SupplierContracts` — **zero handler code lives in this project for them**. The `/finance/LlmSpend` entity is a projection of the shipped `saptarishi.llm.usage.LlmUsage` (from `@saptarishi/cds-plugin-llm@1.22+`); rows are auto-inserted by the `usageMeteringToCap` middleware wired inside `srv/ai-service.js`.

### Try the RAG endpoints

`SupplierContracts` uses `@rag.search: 'hybrid'` (new in cds-plugin-vector-hana 0.8.0) — vector similarity fused with keyword matching via Reciprocal Rank Fusion. Semantic queries still work; exact-token queries (contract IDs like `CTR-2026-101`, supplier codes like `sup-42`) now hit reliably where cosine-only would miss them.

```sh
# Semantic search — hybrid mode makes exact tokens like PO/contract IDs work too
curl -X POST http://localhost:4004/procurement/SupplierContracts/ProcurementService.searchByMeaning \
  -H 'content-type: application/json' \
  -d '{"query": "steel coils Europe short lead time", "topK": 3}' | jq

# Exact-token lookup — hybrid picks up the literal 'CTR-2026-101' in the row's text
curl -X POST http://localhost:4004/procurement/SupplierContracts/ProcurementService.searchByMeaning \
  -H 'content-type: application/json' \
  -d '{"query": "CTR-2026-101", "topK": 3}' | jq

# Q&A with cited sources — full pipeline: hybrid retrieval → LLM rerank → chat answer
curl -X POST http://localhost:4004/procurement/SupplierContracts/ProcurementService.askAbout \
  -H 'content-type: application/json' \
  -d '{"query": "Which suppliers can deliver aluminum in EMEA within 2 weeks and require green-electricity certificates?"}' | jq
```

The `askAbout` handler is customized in `srv/ai-service.js` to run the retrieved candidates through `llmRerank({ llm })` (new in cds-plugin-vector-hana 0.9.0) before generating the answer. The reranker scores each hit on a 0-10 relevance scale via a structured LLM call and re-sorts — so the answer prompt sees the most relevant contracts first. Latency-wise: hybrid pulls ~20 candidates, the reranker scores them in one LLM call (batch size 20), then the chat answer runs. On Groq's Llama 3.3 70B, that's typically ~1.5s end-to-end for the whole pipeline.

The first request seeds the vector index from the CSV automatically (via the plugin's `after CREATE` handler when CAP loads the seed data). Subsequent runs are cached in the SQLite vector table.

To go back to cosine-only for a single query, pass `mode: 'vector'`:

```sh
curl -X POST http://localhost:4004/procurement/SupplierContracts/ProcurementService.searchByMeaning \
  -H 'content-type: application/json' \
  -d '{"query": "CTR-2026-101", "mode": "vector", "topK": 3}'
# vector-only misses the literal token; hybrid recovers it.
```

### Query LLM spend

Every `/ai/*` and `/procurement/*` call that hits the LLM writes a row to `FinanceService.LlmSpend`:

```sh
# Full spend history (newest first)
curl -sS 'http://localhost:4004/finance/LlmSpend?$orderby=timestamp%20desc&$top=20' | jq

# Per-tenant totals (client-side aggregation for the demo — replace with a $apply group query in prod)
curl -sS "http://localhost:4004/finance/LlmSpend?\$filter=tenant%20eq%20'acme'&\$select=model,totalCost,timestamp" | jq

# Most expensive requests
curl -sS 'http://localhost:4004/finance/LlmSpend?$orderby=totalCost%20desc&$top=10' | jq
```

The middleware picks tenant from `cds.context.tenant` (populated by XSUAA on BTP) with a `'default'` fallback for local dev. Model prices come from the shipped `DEFAULT_PRICING` table — override in `srv/ai-service.js` if you have contract discounts.

## Provider by profile

Configured in `package.json`:

| Profile | Provider | Cost |
|---|---|---|
| `development` (default) | `llm-anthropic` (Claude) | Anthropic API pennies per request |
| `hybrid` | `llm-anthropic` | Same |
| `production` | `llm-genai-hub` (SAP AI Core) | BTP paid tier |

Swap provider without touching handler code — `srv/ai-service.js` only talks to `cds.connect.to('llm')`.

## Run locally

Prereqs for the RAG endpoints (skip if you only want the `/ai/*` actions):
- **Ollama** running on `localhost:11434` with two models pulled:
  - `ollama pull nomic-embed-text` (768-dim embeddings, used by `@rag`)
  - `ollama pull qwen2.5:14b` (chat model for `askAbout`)
- Alternative in production: point `cds.requires.llm-embed` and `cds.requires.llm` at `llm-genai-hub` (see the `[genai-hub]` profile in `package.json`).

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # for /ai/* actions
npm run watch
# or with Ollama-only (both chat + embed via Ollama):
CDS_ENV=ollama npm run watch
```

Then:

```sh
curl -X POST http://localhost:4004/ai/summarizePurchaseOrder \
  -H 'content-type: application/json' \
  -d '{
    "purchaseOrderId": "4500000123",
    "poJson": "{\"supplier\":\"Acme Steel GmbH\",\"material\":\"Cold-rolled steel coil, 1.2mm\",\"quantity\":24000,\"unit\":\"kg\",\"netAmount\":38400,\"currency\":\"EUR\",\"requestedDelivery\":\"2026-08-01\"}"
  }'
```

## Deploy to BTP

Add to your MTA descriptor as a Node.js module bound to:
- `xsuaa` (auth)
- `destination` (for the S/4HANA read the calling skill will do first)
- `aicore` service instance (extended plan) if using the `production` profile

The Joule side wiring lives in [`../joule-project/`](../joule-project/):
- `actions/cap-ai-summarize.openapi.yaml` — action spec Joule consumes
- `destinations/cap-ai-backend.json` — destination pointing at this app
- `skills/summarize-po/` — skill definition + prompt
