# Model-parsed imports

Status: specification in progress. Base: `main` at `8351e0b`.

The engine interprets household layouts and free-form updates. Deterministic code validates cited source values, resolves identity, reconciles totals, and commits through existing ingest and Ask actions. Standard institution exports keep deterministic parsers. No household-specific layout becomes application parsing code.

## Parser boundary

| Current parser | Decision |
| --- | --- |
| `src/ingest/parsers/chase-activity.mjs` | Keep for standard checking and card activity exports. |
| `src/ingest/parsers/brokerage-positions.mjs` | Keep for standard brokerage positions exports. |
| `src/ingest/parsers/aggregator.mjs` | Keep for the aggregator transaction export. |
| `src/ingest/parsers/pnl-workbook.mjs` | Replace with engine proposals and deterministic validation. |
| `src/ingest/parsers/balances.mjs` | Replace with engine proposals and deterministic validation. |
| `src/ingest/parsers/account-map.mjs` | Replace with engine proposals and deterministic validation. |
| `src/ingest/parsers/tax-payments.mjs` | Replace with engine proposals and deterministic validation. |
| `src/ingest/parsers/notes.mjs` | Replace with the common free-form proposal path. |

`src/ingest/simplefin.mjs` is outside the parser directory and remains a deterministic, read-only connector.

## Delivery

The final specification will define typed proposals and provenance, conversational confirmation and cached mappings, free-form action reuse, privacy and budgets, supersession, generated evaluations, and dependent implementation tickets. This PR changes documentation only and receives one cross-provider plan review round before coordinator review.
