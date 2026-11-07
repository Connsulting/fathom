// P&L and household spending: deterministic, read-only aggregations over the categorized store.
// Every number in a result is a figure key into the result's `figures`, each with its source,
// detail rows and provenance. See docs/architecture.md "P&L and household spending".

export { PnlError } from './shared.mjs';
export { pnlEntities, businessPnl, businessPnlRows } from './business.mjs';
export { householdSpending, householdSpendingRows } from './spending.mjs';
