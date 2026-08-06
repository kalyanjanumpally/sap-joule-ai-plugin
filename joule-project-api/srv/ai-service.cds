service AIService @(path: '/ai') {

  type POSummary {
    purchaseOrderId : String;
    summary         : String;
    tokensUsed      : Integer;
    model           : String;
  }

  type RiskFactor {
    factor   : String;
    impact   : String enum { increases; decreases; neutral };
    evidence : String;
  }

  type InvoiceRisk {
    invoiceId  : String;
    risk       : String enum { low; medium; high };
    rationale  : String;
    // New in 0.7.0 — surfaced from the shipped schemas.SupplierRisk shape
    confidence : Decimal(3, 2);        // 0.00 - 1.00
    factors    : many RiskFactor;
    tokensUsed : Integer;
    model      : String;
  }

  type SupplierRiskAssessment {
    supplierId : String;
    risk       : String enum { low; medium; high };
    rationale  : String;
    confidence : Decimal(3, 2);
    factors    : many RiskFactor;
    tokensUsed : Integer;
    model      : String;
  }

  type InvoiceLineItem {
    description : String;
    quantity    : Decimal;
    unitPrice   : Decimal;
    lineTotal   : Decimal;
  }

  type InvoiceExtract {
    vendor         : String;
    invoiceNumber  : String;
    invoiceDate    : String;
    dueDate        : String;
    currency       : String;
    subtotal       : Decimal;
    tax            : Decimal;
    total          : Decimal;
    lineItems      : many InvoiceLineItem;
    tokensUsed     : Integer;
    model          : String;
  }

  action summarizePurchaseOrder(
    purchaseOrderId : String not null,
    poJson          : LargeString
  ) returns POSummary;

  action explainInvoiceRisk(
    invoiceId       : String not null,
    invoiceJson     : LargeString
  ) returns InvoiceRisk;

  /**
   * Structured extraction from an invoice — supports images (all providers
   * with a vision model) or PDFs (Anthropic-only; Claude 3.5+ has native
   * PDF understanding).
   *
   *   - Image: pass imageBase64 or imageUrl (+ optional mediaType).
   *   - PDF:   pass pdfBase64 or pdfUrl. Requires the LLM provider config to
   *            point at Anthropic; other providers will reject document blocks.
   *
   * `model` overrides the configured default. For PDFs, use e.g.
   * 'claude-opus-4-7'. For images, 'meta-llama/llama-4-scout-17b-16e-instruct'
   * (Groq) or 'gpt-4o' (OpenAI-compat).
   */
  action extractInvoiceLineItems(
    imageBase64 : LargeString,
    imageUrl    : String,
    pdfBase64   : LargeString,
    pdfUrl      : String,
    mediaType   : String,
    model       : String
  ) returns InvoiceExtract;

  // ---- Multi-agent orchestration (new in this project) -----------------
  // Supervisor coordinator + three specialist agents (contract-lookup,
  // price-analyst, compliance-checker). See srv/ai-service.js handler.

  type OrchestrationStep {
    agent    : String;   // slug of the specialist invoked
    question : String;   // what the coordinator asked
    answer   : String;   // the specialist's reply
    isError  : Boolean;  // true if the specialist threw
  }

  type OrchestrationResult {
    answer : String;                     // final coordinator-synthesized answer
    trace  : many OrchestrationStep;     // one entry per specialist call
    steps  : Integer;                    // # coordinator turns
  }

  action analyzeScenario(
    scenario : String not null
  ) returns OrchestrationResult;

  /**
   * Free-form supplier risk assessment. Pass a supplier ID plus any
   * context you have (recent orders, delivery incidents, geopolitical
   * situation, financial signals). Returns the shipped SupplierRisk
   * shape (risk enum + rationale + confidence + factors[]). Uses the
   * `schemas.SupplierRisk` JSON Schema from cds-plugin-llm@1.34+ —
   * same shape as explainInvoiceRisk so the UI can render both.
   */
  action assessSupplierRisk(
    supplierId : String not null,
    scenario   : String not null
  ) returns SupplierRiskAssessment;

  // ---- Voice-note to purchase-order draft (new in 0.9.0) ---------------
  // Takes a spoken voice memo (base64), asks an audio-capable model to
  // extract a structured purchase-order draft. Uses the schemas.PurchaseOrder
  // shape shipped in cds-plugin-llm 1.34.0 + the audioFromBase64() helper
  // shipped in 1.36.0. Requires an audio-capable provider — Gemini works
  // out of the box; llm-groq / llm-anthropic will 400.

  type PurchaseOrderDraft {
    poNumber              : String;      // may be empty if not spoken
    supplier              : String;
    orderDate             : String;      // ISO date, if spoken
    requestedDeliveryDate : String;
    currency              : String;
    totalAmount           : Decimal(15, 2);
    lineItems             : many {
      description : String;
      quantity    : Decimal(15, 3);
      unitPrice   : Decimal(15, 4);
      lineTotal   : Decimal(15, 4);
    };
    incoterm              : String;
    approver              : String;
    notes                 : String;
    tokensUsed            : Integer;
    model                 : String;
  }

  /**
   * Extract a structured PurchaseOrderDraft from a spoken voice memo.
   *
   *   `audioBase64` — the raw voice recording, base64-encoded (no data URI prefix).
   *   `format`     — 'wav' | 'mp3' | 'm4a' | 'ogg' | 'flac' | 'aac' | 'opus' | 'webm'.
   *                  Defaults to 'mp3'. Maps to the audio/* MIME type.
   *   `model`      — override the configured default. Recommended: 'gemini-2.5-flash'
   *                  (Google) or 'gpt-4o-audio-preview' (OpenAI-compat).
   *
   * Wraps the audio via audioFromBase64 + a schemas.PurchaseOrder format param.
   */
  action transcribeVoiceNoteToPO(
    audioBase64 : LargeString not null,
    format      : String,
    model       : String
  ) returns PurchaseOrderDraft;
}
