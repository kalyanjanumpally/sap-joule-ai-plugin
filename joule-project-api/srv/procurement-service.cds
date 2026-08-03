using { cuid, managed } from '@sap/cds/common';

/**
 * ProcurementService exposes a semantically-searchable catalog of supplier
 * contracts. The `@rag` annotation auto-wires:
 *   - a vector index on the SQLite backend (dimension = 768, matches
 *     Ollama's nomic-embed-text-v1.5)
 *   - CRUD sync — every CREATE / UPDATE / DELETE keeps the vector index
 *     in step with the underlying rows
 *   - two bound OData actions on the entity, callable from Joule:
 *       searchByMeaning(query, topK)                           → array of SupplierContracts
 *       askAbout(query, topK, systemInstructions)              → { answer, sources: array of SupplierContracts }
 *
 * No handler code lives in this project for those actions — everything is
 * done by @saptarishi/cds-plugin-vector-hana. The point of the demo is
 * exactly that: one annotation, Joule can call it.
 */
service ProcurementService @(path: '/procurement') {

  @rag: {
    fields:    ['supplierName', 'contractType', 'category', 'terms'],
    dimension: 768,
    store:     'sqlite',
    topK:      5,
    provider:  'llm-embed',                   // Ollama nomic-embed-text (768 dim) — see package.json cds.requires
    chatter:   'llm',                         // reuse the main chat model for askAbout
  }
  entity SupplierContracts : cuid, managed {
    supplierName : String(200);
    contractType : String(50);                // 'framework' | 'nda' | 'sla' | 'sow'
    category     : String(50);                // 'raw-materials' | 'logistics' | 'IT-services' | ...
    region       : String(50);                // 'EMEA' | 'APAC' | 'AMER'
    terms        : LargeString;               // the actual contract text — this is what gets embedded
    validFrom    : Date;
    validTo      : Date;
  }

}
