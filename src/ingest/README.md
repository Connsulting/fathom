# File ingestion

The deterministic parser boundary contains only `aggregator.mjs`,
`chase-activity.mjs`, and `brokerage-positions.mjs`. SimpleFIN remains a
separate deterministic read-only connector. Every other supported file goes
through the indexed proposal service. Historical parser ids remain evidence
labels and never select executable code.

## Standard parsers

Each parser exports `id`, `label`, `sourceKind`, `sniff(file)` and `parse(file)`.
Files contain `name`, `bytes: Uint8Array`, and optional `mime`. Parsed output is
`{rows, warnings, period: {from, to}}`. Warnings contain codes and locators.
`registry.mjs` exports `parsers`, `listParsers()` and `pickParser()`.

1. Aggregator outflows become negative ledger amounts. Bank activity retains
   signed posted amounts and row provenance for running balances.
2. Account masks retain at most four digits. Unknown identity and ownership use
   the existing account matching and Confirm services.
3. Brokerage exports require an as-of date grounded in content or filename.
   Pending activity stays excluded; incomplete account snapshots cannot remove
   holdings. A complete snapshot retains period authority over omissions.

## Source-grounded proposals

`ingestFile(db, file, opts)` stores original bytes encrypted before routing.
`opts` captures the household context, actor, scopes and clock. Household
ownership and generation are checked before a late commit.

1. `model-source.mjs` indexes bounded CSV/TSV cells, every workbook sheet, text
   spans and PDF text. Raw scans wait as `needs_source_text`. No raw PDF image
   reaches the engine. Formula caches and excluded regions remain explicit.
2. `model-parse.mjs` uses the household engine and durable per-file ceilings.
   Every field cites local source references and an allowlisted transform.
   Numeric literals from the engine never establish financial values.
3. `model-validation.mjs` verifies coverage, identity, units, dates, totals and
   duplicate previews. Unresolved or contradictory proposals commit no rows.
   It groups P&L amounts in integer cents and retains every contributing ref.
4. `model-review.mjs` stages a deterministic summary. The authenticated actor
   approves the specific proposal version through `reviewImport`, also exposed
   at `POST /api/import-proposals/:proposalId/review`. Corrections require fresh
   approval. A stale source or changed effect refuses atomically.
5. `model-layout.mjs` applies approved declarative column mappings locally.
   Structural context and identity bindings are checked on every file. A new
   layout is never approved merely because the engine proposed it.

Supported waiting states are `waiting_for_engine`, `budget_exhausted`,
`needs_confirmation`, `needs_clarification`, and `needs_source_text`.
`unsupported`, `too_large`, and `failed` retain the encrypted source without
financial writes. Legacy waiting records remain eligible for explicit retry.
The file list, scenario, onboarding and refresh tool expose current statuses.

## Identity, supersession and Undo

Identical bytes remain a file duplicate. `retryFile(db, fileId, opts)` accepts
`mode: 'retry'` for waiting files and `mode: 'reinterpret'` for imported files.
Reinterpretation reads the retained vault bytes under the same file id and
stages another version. Old active rows stay until approval.

The common persistence adapter preserves transaction occurrence multiplicity,
account-scoped external ids, confirmed duplicate survivor links, near-duplicate
questions, withholding recipient conflicts and tax date precision. Existing
rows and historical source labels need no migration or backfill.

Complete validated groups hold omission authority for their represented target,
entity or payer, and period. An unrelated later group cannot grant authority to
an earlier one. Revisions and removals retain archived before-images, including
when reinterpretation uses the same file id.

`model-undo.mjs` registers `model_import` with `registerReceiptKind`. Receipts
retain changed row before/after images. Imported facts use child fact receipts
and the shared grouped all-scopes authorization. Undo checks every affected
after-state and refuses stale or dependent changes atomically. Restore hooks
run synchronously inside the shared Undo transaction and do not open a nested
transaction. Source files, audit batches and model spend remain. Undo of first
layout approval invalidates automatic reuse; a newer mapping is never undone.

Post-commit planning, freshness, Confirm guesses and pack refresh use the same
services as standard imports. Pending proposals never count as observed data.
