const cds = require('@sap/cds');
const { getBudget, getBudgetLimits } = require('./ai-service');

/**
 * FinanceService — live budget status + reload actions.
 *
 * The `LlmSpend` projection needs zero handler code (usageMeteringToCap
 * writes rows straight into the underlying LlmUsage entity). The
 * `LlmBudget` config entity is a plain CDS CRUD projection — CAP handles
 * SELECT/INSERT/UPDATE/DELETE for free.
 *
 * On boot: read every enabled LlmBudget row and mutate the shared limits
 * object that AIService passed to `costBudget()`. That way, admin edits
 * in the Fiori UI take effect after `POST /finance/reloadBudget()`
 * without a restart.
 */
module.exports = class FinanceService extends cds.ApplicationService {
  async init() {
    cds.once('served', async () => {
      try {
        const [, active] = await this._hydrateBudget();
        cds.log('llm:budget').info(`[budget] loaded ${active} active limits from LlmBudget`);
      } catch (e) {
        cds.log('llm:budget').warn(`[budget] hydrate failed: ${e.message}. Budget is UNLIMITED.`);
      }
    });

    // ---- getBudgetStatus — live snapshot -----------------------------
    this.on('getBudgetStatus', async () => {
      const budget = getBudget();
      const limits = getBudgetLimits() ?? {};
      if (!budget) {
        return { window: '', currency: 'USD', total: 0, perTenant: [], perModel: [], limits: {} };
      }
      const snap = await budget.snapshot();
      const perTenantLimits = limits.perTenant ?? {};
      const perModelLimits  = limits.perModel  ?? {};
      return {
        window:   snap.window,
        currency: snap.currency,
        total:    snap.total,
        perTenant: Object.entries(snap.perTenant).map(([entryKey, amount]) => ({
          entryKey,
          amount,
          limitAmt: budget.limitFor('perTenant', entryKey) ?? 0,
        })),
        perModel: Object.entries(snap.perModel).map(([entryKey, amount]) => ({
          entryKey,
          amount,
          limitAmt: budget.limitFor('perModel', entryKey) ?? 0,
        })),
        limits: {
          total: typeof limits.total === 'number' ? limits.total : 0,
          perTenant: Object.entries(perTenantLimits).map(([entryKey, amount]) => ({
            entryKey, amount, limitAmt: amount,
          })),
          perModel:  Object.entries(perModelLimits).map(([entryKey, amount]) => ({
            entryKey, amount, limitAmt: amount,
          })),
        },
      };
    });

    // ---- reloadBudget — re-read LlmBudget rows -----------------------
    this.on('reloadBudget', async () => {
      const [total, active] = await this._hydrateBudget();
      return { total, activeRows: active };
    });

    return super.init();
  }

  /**
   * Read the current LlmBudget config and mutate the shared limits object.
   * Returns [totalRowsRead, activeRowsApplied].
   *
   * We mutate the SAME object that was passed to `costBudget({ limits })`
   * at boot — since `limitFor()` reads `limits[scope]` on every call, the
   * update is immediately visible.
   */
  async _hydrateBudget() {
    const limits = getBudgetLimits();
    if (!limits) return [0, 0];
    const rows = await SELECT.from('FinanceService.LlmBudget');
    const active = rows.filter((r) => r.enabled);

    // Rebuild each scope map so removed rows disappear (not just added ones).
    const nextPerTenant = {};
    const nextPerModel  = {};
    let nextTotal;
    for (const r of active) {
      const amount = Number(r.limitAmount);
      if (!Number.isFinite(amount)) continue;
      if (r.scope === 'total')          nextTotal = amount;
      else if (r.scope === 'perTenant') nextPerTenant[r.keyName] = amount;
      else if (r.scope === 'perModel')  nextPerModel[r.keyName]  = amount;
    }
    limits.total     = nextTotal;
    limits.perTenant = nextPerTenant;
    limits.perModel  = nextPerModel;
    return [rows.length, active.length];
  }
};
