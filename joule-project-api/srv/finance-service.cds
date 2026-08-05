using { saptarishi.llm.usage.LlmUsage } from '@saptarishi/cds-plugin-llm/lib/usageEntity';

/**
 * FinanceService — LLM cost accounting and spend enforcement.
 *
 * Two-sided model:
 *
 *   LlmSpend  — auto-written ledger of every LLM call (usageMeteringToCap).
 *               Populated by middleware, projected read-only.
 *   LlmBudget — admin-editable configuration for the `costBudget` middleware.
 *               Each row is one ceiling — scoped to the whole tenant (total),
 *               a specific tenant, or a specific model. The AIService reads
 *               these rows at boot and wires them into `costBudget()`.
 *
 * Plus two live-status actions that peek at the middleware's in-memory
 * counters (or Redis, when configured) without going through the DB:
 *
 *   GET  /finance/getBudgetStatus  — current-window spend broken down by
 *                                    total / perTenant / perModel.
 *   POST /finance/reloadBudget     — re-read LlmBudget rows into the
 *                                    middleware after an admin edit.
 *
 * Fits directly into a Fiori list report (see @UI annotations below) and
 * Joule can call `getBudgetStatus` via the `check-llm-budget` skill.
 */

type BudgetScopeT  : String(16) enum { total; perTenant; perModel; };
type BudgetWindowT : String(16) enum { hour; day; month; process; };
type BudgetActionT : String(8)  enum { throw; warn; };

entity LlmBudgetConfig {
  key ID     : String(64);                     // deterministic: `${scope}:${keyName}`
  scope      : BudgetScopeT  not null;
  keyName    : String(200)   not null;         // 'total' | tenant slug | model name
  windowKind : BudgetWindowT not null default 'day';
  limitAmount: Decimal(15, 4) not null;        // in `currency` — never NULL
  currency   : String(3)     not null default 'USD';
  action     : BudgetActionT not null default 'throw';
  enabled    : Boolean       not null default true;
  notes      : String(500);
}

service FinanceService @(path: '/finance') {

  @readonly
  entity LlmSpend as projection on LlmUsage;

  // ---- LlmBudget — editable configuration ------------------------------

  entity LlmBudget as projection on LlmBudgetConfig;

  // ---- Live status actions -------------------------------------------

  type BudgetSpendEntry {
    entryKey  : String;                    // 'total', tenant slug, or model name
    amount    : Decimal(15, 4);
    limitAmt  : Decimal(15, 4);            // configured limit for this key, if any
  }

  type BudgetStatus {
    window     : String;                 // ISO bucket prefix, e.g. '2026-08-05'
    currency   : String;
    total      : Decimal(15, 4);
    perTenant  : many BudgetSpendEntry;
    perModel   : many BudgetSpendEntry;
    limits     : {                       // echo of the configured limits
      total     : Decimal(15, 4);
      perTenant : many BudgetSpendEntry;
      perModel  : many BudgetSpendEntry;
    };
  }

  /** Current-window spend from the costBudget middleware. Read-only. */
  action getBudgetStatus() returns BudgetStatus;

  /** Reload budget config from `LlmBudget` rows. Call after admin edits. */
  action reloadBudget() returns {
    total      : Integer;    // # of rows read
    activeRows : Integer;    // # of enabled rows applied
  };
}

// ---- Fiori annotations — LlmBudget list report -----------------------

annotate FinanceService.LlmBudget with @(
  UI.HeaderInfo: {
    TypeName      : 'LLM budget',
    TypeNamePlural: 'LLM budgets',
    Title         : { Value: keyName },
    Description   : { Value: scope   },
  },
  UI.SelectionFields: [ scope, enabled, currency, windowKind ],
  UI.LineItem: [
    { Value: scope,       Label: 'Scope'      },
    { Value: keyName,     Label: 'Key'        },
    { Value: limitAmount, Label: 'Limit'      },
    { Value: currency,    Label: 'Currency'   },
    { Value: windowKind,  Label: 'Window'     },
    { Value: action,      Label: 'On exceed'  },
    { Value: enabled,     Label: 'Enabled'    },
  ],
  UI.FieldGroup #Details: {
    Data: [
      { Value: scope       },
      { Value: keyName     },
      { Value: limitAmount },
      { Value: currency    },
      { Value: windowKind  },
      { Value: action      },
      { Value: enabled     },
      { Value: notes       },
    ],
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Details', Label: 'Budget configuration' },
  ],
);

annotate FinanceService.LlmBudget with {
  ID          @title: 'ID'          @readonly;
  scope       @title: 'Scope'       @assert.range;   // enforce enum at runtime
  keyName     @title: 'Key';
  limitAmount @title: 'Limit';
  currency    @title: 'Currency';
  windowKind  @title: 'Window'      @assert.range;
  action      @title: 'On exceed'   @assert.range;
  enabled     @title: 'Enabled';
  notes       @title: 'Notes';
};

annotate FinanceService.LlmSpend with @(
  UI.HeaderInfo: {
    TypeName      : 'LLM spend',
    TypeNamePlural: 'LLM spend',
    Title         : { Value: model },
    Description   : { Value: tenant },
  },
  UI.SelectionFields: [ tenant, model, provider ],
  UI.LineItem: [
    { Value: timestamp,    Label: 'When'     },
    { Value: tenant,       Label: 'Tenant'   },
    { Value: model,        Label: 'Model'    },
    { Value: provider,     Label: 'Provider' },
    { Value: inputTokens,  Label: 'In'       },
    { Value: outputTokens, Label: 'Out'      },
    { Value: totalCost,    Label: 'Cost'     },
  ],
);
