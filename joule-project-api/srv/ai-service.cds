service AIService @(path: '/ai') {

  type POSummary {
    purchaseOrderId : String;
    summary         : String;
    tokensUsed      : Integer;
    model           : String;
  }

  type InvoiceRisk {
    invoiceId : String;
    risk      : String enum { low; medium; high };
    rationale : String;
    tokensUsed: Integer;
    model     : String;
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
}
