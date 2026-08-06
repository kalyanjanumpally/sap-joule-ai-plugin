// Pre-built JSON Schemas for common business-object extraction.
//
// Every schema here is a valid `format:` value for LLMService.chat() —
// pass it straight through and the plugin post-parses the response into
// the `data` field.
//
//   const { schemas } = require('@saptarishi/cds-plugin-llm');
//   const { data, model } = await llm.chat({
//     system: 'You extract structured invoices.',
//     messages: [{ role: 'user', content: [imageFromFile(path), { type: 'text', text: 'Extract.' }] }],
//     format: schemas.Invoice,
//   });
//   //  → data.vendor, data.total, data.lineItems[i], ...
//
// Schemas are `additionalProperties: false` so the LLM can't smuggle
// unspecified fields; `required` lists the fields the plugin's post-parse
// step will refuse a response that's missing. Modify via
// `schemas.extend(base, { properties, required })` when a variant needs
// extra fields.

// ---- Reusable sub-schemas --------------------------------------------

const IsoDate = {
  type: 'string',
  description: 'Date in ISO 8601 format (YYYY-MM-DD).',
  // Loose — the LLM must produce ISO but we don't want format validation to reject "2026-08".
};

const CurrencyCode = {
  type: 'string',
  description: 'ISO 4217 currency code (EUR, USD, GBP, ...).',
};

const LineItem = {
  type: 'object',
  description: 'One line on an invoice / PO / expense report.',
  properties: {
    description: { type: 'string' },
    quantity:    { type: 'number', description: 'Positive count. Fractional allowed for measured units (kg, hours).' },
    unitPrice:   { type: 'number', description: 'Per-unit cost in the enclosing document\'s currency.' },
    lineTotal:   { type: 'number', description: 'quantity × unitPrice. Include tax only if the source document does.' },
  },
  required: ['description', 'quantity', 'unitPrice', 'lineTotal'],
  additionalProperties: false,
};

// ---- Invoice ---------------------------------------------------------

const Invoice = {
  type: 'object',
  description: 'Structured extraction of a supplier invoice.',
  properties: {
    vendor:        { type: 'string', description: 'Legal name of the supplier as written on the invoice.' },
    invoiceNumber: { type: 'string' },
    invoiceDate:   IsoDate,
    dueDate:       IsoDate,
    currency:      CurrencyCode,
    subtotal:      { type: 'number', description: 'Pre-tax total.' },
    tax:           { type: 'number', description: 'Total tax amount. Include VAT / GST / sales tax.' },
    total:         { type: 'number', description: 'Amount due (subtotal + tax).' },
    lineItems:     { type: 'array', items: LineItem },
    notes:         { type: 'string', description: 'Any payment terms, PO reference, remittance instructions.' },
  },
  required: ['vendor', 'currency', 'total', 'lineItems'],
  additionalProperties: false,
};

// ---- PurchaseOrder ---------------------------------------------------

const PurchaseOrder = {
  type: 'object',
  description: 'Structured extraction of a purchase order for procurement approval.',
  properties: {
    poNumber:      { type: 'string' },
    supplier:      { type: 'string', description: 'Legal name of the supplier the PO is issued to.' },
    orderDate:     IsoDate,
    requestedDeliveryDate: IsoDate,
    currency:      CurrencyCode,
    lineItems:     { type: 'array', items: LineItem },
    totalAmount:   { type: 'number' },
    incoterm:      { type: 'string', description: 'INCOTERMS 2020 code (EXW, FOB, CIF, DAP, DDP, ...). Omit if not stated.' },
    approver:      { type: 'string', description: 'Named approver or approval role. Omit if unassigned.' },
    notes:         { type: 'string', description: 'Delivery instructions, tolerance, freight terms.' },
  },
  required: ['poNumber', 'supplier', 'currency', 'lineItems', 'totalAmount'],
  additionalProperties: false,
};

// ---- SupplierRisk ---------------------------------------------------

const SupplierRisk = {
  type: 'object',
  description: 'Risk assessment for a supplier or specific supplier-transaction pair.',
  properties: {
    risk: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Overall risk rating. Cite the driving factor(s) in `factors`.',
    },
    rationale: { type: 'string', description: 'One or two sentences that ground the rating in specific evidence.' },
    confidence: {
      type: 'number',
      description: 'Model self-reported confidence in the rating, 0-1. Lower this if key data is missing.',
    },
    factors: {
      type: 'array',
      description: 'Individual signals that fed the rating. Each names the factor and its direction (+risk / -risk).',
      items: {
        type: 'object',
        properties: {
          factor:   { type: 'string' },
          impact:   { type: 'string', enum: ['increases', 'decreases', 'neutral'] },
          evidence: { type: 'string' },
        },
        required: ['factor', 'impact'],
        additionalProperties: false,
      },
    },
  },
  required: ['risk', 'rationale'],
  additionalProperties: false,
};

// ---- ContractSummary -------------------------------------------------

const ContractSummary = {
  type: 'object',
  description: 'Machine-readable summary of a supplier / partnership contract.',
  properties: {
    parties: {
      type: 'array',
      description: 'The signing parties, in order (usually the entity first, then the counterparty).',
      items: { type: 'string' },
    },
    contractType: {
      type: 'string',
      description: 'framework / nda / sla / sow / mou / other',
    },
    effectiveDate: IsoDate,
    expiryDate:    IsoDate,
    scope:         { type: 'string', description: 'What the contract covers, 1-3 sentences.' },
    keyTerms: {
      type: 'array',
      items: { type: 'string' },
      description: 'Pricing model, exclusivity, payment terms, SLAs, penalties. One phrase per entry.',
    },
    obligations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          party:       { type: 'string' },
          obligation:  { type: 'string' },
          dueBy:       IsoDate,
        },
        required: ['party', 'obligation'],
        additionalProperties: false,
      },
    },
    terminationClause: { type: 'string', description: 'How either party may terminate (notice period + causes). Omit if unstated.' },
    renewal:           { type: 'string', description: 'Automatic renewal terms, if any.' },
    governingLaw:      { type: 'string', description: 'Jurisdiction whose law governs the contract.' },
  },
  required: ['parties', 'contractType', 'scope'],
  additionalProperties: false,
};

// ---- ExpenseReport --------------------------------------------------

const ExpenseReport = {
  type: 'object',
  description: 'Structured expense report submitted by an employee for reimbursement.',
  properties: {
    employee:      { type: 'string' },
    reportDate:    IsoDate,
    periodStart:   IsoDate,
    periodEnd:     IsoDate,
    currency:      CurrencyCode,
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date:        IsoDate,
          category:    { type: 'string', description: 'travel / meals / lodging / supplies / software / other' },
          vendor:      { type: 'string' },
          description: { type: 'string' },
          amount:      { type: 'number' },
          receipt:     { type: 'boolean', description: 'true if a receipt is attached / referenced.' },
        },
        required: ['date', 'category', 'amount'],
        additionalProperties: false,
      },
    },
    total:               { type: 'number' },
    businessJustification: { type: 'string' },
  },
  required: ['employee', 'currency', 'lineItems', 'total'],
  additionalProperties: false,
};

// ---- EmailDraft -----------------------------------------------------

const EmailDraft = {
  type: 'object',
  description: 'A drafted email ready to review + send. Use for AI-drafted follow-ups, order acknowledgements, dunning notices, etc.',
  properties: {
    to:        { type: 'array', items: { type: 'string' }, description: 'Primary recipients (email addresses).' },
    cc:        { type: 'array', items: { type: 'string' } },
    bcc:       { type: 'array', items: { type: 'string' } },
    subject:   { type: 'string' },
    body:      { type: 'string', description: 'Plain-text or markdown body. Prefer plain text unless the caller opts in to markdown.' },
    tone: {
      type: 'string',
      enum: ['formal', 'neutral', 'friendly', 'urgent'],
      description: 'Self-reported tone. Useful for QA / approval workflows.',
    },
    attachments: {
      type: 'array',
      description: 'Filenames or blob refs to attach. Never inline base64.',
      items: { type: 'string' },
    },
  },
  required: ['to', 'subject', 'body'],
  additionalProperties: false,
};

// ---- Helpers --------------------------------------------------------

const REGISTRY = { Invoice, PurchaseOrder, SupplierRisk, ContractSummary, ExpenseReport, EmailDraft };

/**
 * List every registered schema name. Useful for a `/schemas` MCP resource
 * or a docs generator that needs to iterate.
 */
function list() { return Object.keys(REGISTRY); }

/**
 * Look up a schema by name. Returns undefined for unknown names — no throw
 * so callers can chain safely.
 */
function byName(name) { return REGISTRY[name]; }

/**
 * Non-mutating extend — produce a variant of a base schema with extra
 * properties and/or required fields. Useful when a tenant needs one
 * additional column beyond the shipped shape.
 *
 *   const InvoiceWithGL = schemas.extend(schemas.Invoice, {
 *     properties: { glAccount: { type: 'string' } },
 *     required:   ['glAccount'],
 *   });
 */
function extend(base, { properties = {}, required = [] } = {}) {
  if (!base || base.type !== 'object') {
    throw new Error('schemas.extend: base must be an object schema.');
  }
  return {
    ...base,
    properties: { ...base.properties, ...properties },
    required:   Array.from(new Set([...(base.required ?? []), ...required])),
  };
}

/**
 * MCP resource dumping the list of schema names. Register on an MCPServer
 * alongside asMcpResourceTemplate() to expose the whole surface:
 *
 *   const { schemas } = require('@saptarishi/cds-plugin-llm');
 *   server.registerResource({ ...schemas.asMcpResource(), read: schemas.asMcpResource().handler });
 *   server.registerResourceTemplate({ ...schemas.asMcpResourceTemplate(), read: schemas.asMcpResourceTemplate().handler });
 *
 * The MCP client sees a static resource `schema://list` (all names) plus a
 * template `schema://{name}` that resolves any individual schema's JSON.
 * Useful for LLM-driven tool discovery — the agent can enumerate names,
 * then read the JSON Schema of a specific type to construct a matching
 * request.
 * @since 1.37.0
 */
function asMcpResource() {
  return {
    uri: 'schema://list',
    name: 'Registered structured-output schemas',
    description: 'Every JSON Schema shipped in the plugin\'s `schemas` module. Read the individual schema at `schema://{name}`.',
    mimeType: 'application/json',
    handler: () => ({ schemas: list() }),
  };
}

/**
 * MCP resource template — the per-name lookup. `schema://Invoice`, `schema://PurchaseOrder`, etc.
 * Returns the raw JSON Schema. Unknown names return `{ error: 'unknown schema: <name>' }`
 * with a 200 status (the MCP client sees the payload; caller decides what to do).
 * @since 1.37.0
 */
function asMcpResourceTemplate() {
  return {
    uriTemplate: 'schema://{name}',
    name: 'Structured-output schema by name',
    description: 'Read any schema shipped in the `schemas` module by its exported name. e.g. schema://Invoice, schema://SupplierRisk. See schema://list for the full inventory.',
    mimeType: 'application/json',
    handler: ({ name }) => {
      const s = byName(name);
      if (!s) return { error: `unknown schema: ${name}`, known: list() };
      return s;
    },
  };
}

module.exports = {
  Invoice,
  PurchaseOrder,
  SupplierRisk,
  ContractSummary,
  ExpenseReport,
  EmailDraft,
  // Reusable sub-schemas exposed for composition
  LineItem,
  IsoDate,
  CurrencyCode,
  // Helpers
  list,
  byName,
  extend,
  // MCP wiring (new in 1.37.0)
  asMcpResource,
  asMcpResourceTemplate,
};
