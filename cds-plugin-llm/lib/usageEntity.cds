// Canonical CDS entity for the usage-metering middleware.
//
//   using { LlmUsage } from '@saptarishi/cds-plugin-llm/lib/usageEntity';
//   service FinanceService @(path: '/finance') {
//     entity LlmSpend as projection on LlmUsage;
//   }
//
// Bring your own if you want a richer shape (extra tenancy columns, per-team
// cost centers, ...). The `usageMeteringToCap()` middleware only needs an
// entity whose `elements` are a superset of these fields — extra columns
// are ignored, missing columns will fail at insert time.

namespace saptarishi.llm.usage;

entity LlmUsage {
  key ID           : UUID;
  timestamp        : Timestamp;
  provider         : String(64);   // cds.services alias (or arbitrary label)
  model            : String(128);  // effective model id from the response
  tenant           : String(128);
  method           : String(16);   // 'chat' | 'stream' | 'embed'
  inputTokens      : Integer;
  outputTokens     : Integer;
  inputCost        : Decimal(19, 6);
  outputCost       : Decimal(19, 6);
  totalCost        : Decimal(19, 6);
  currency         : String(8);
  pricingKnown     : Boolean;      // false when the model isn't in the price table
}
