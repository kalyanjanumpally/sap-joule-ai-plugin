using { saptarishi.llm.usage.LlmUsage } from '@saptarishi/cds-plugin-llm/lib/usageEntity';

/**
 * FinanceService — LLM cost accounting, projected from the shipped
 * `LlmUsage` entity. Rows are auto-persisted by the `usageMeteringToCap`
 * middleware wired inside `ai-service.js` — this project writes zero
 * handler code for either the insert side or the read side.
 *
 * Example queries:
 *   GET /finance/LlmSpend?$orderby=timestamp desc&$top=100
 *   GET /finance/LlmSpend?$filter=tenant eq 'acme'&$select=timestamp,model,totalCost
 *   GET /finance/LlmSpend?$filter=totalCost gt 0.10&$orderby=totalCost desc
 *
 * Fits directly into a Fiori cost dashboard. Joule can call it via the
 * `check-ai-spend` skill.
 */
service FinanceService @(path: '/finance') {

  @readonly
  entity LlmSpend as projection on LlmUsage;

}
