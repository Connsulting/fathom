# Deterministic parsers

Each parser exports `id`, `label`, `sourceKind`, synchronous `sniff(file)` and
`parse(file)`. Files contain `name`, `bytes: Uint8Array`, and optional `mime`.
`parse` returns `{rows, warnings, period: {from, to}}`. Empty periods use nulls.
Warnings contain codes and locators, never source values. The pipeline adds file
and parser identity. `registry.mjs` exports `parsers`, `listParsers()` and
`pickParser(file, {threshold = 0.75})`. A score must exceed the threshold. PDFs,
unknown CSVs and broken workbooks return null for model extraction.

1. Aggregator outflows are positive in the export and become negative ledger
   amounts. Bank exports already use ledger signs. Posted dates take precedence
   over original dates. Masks retain at most four digits, never full numbers.
2. Bank balances retain their source row. Several balances may exist on one day;
   these are running balances, not a claim about that day's closing balance.
3. Positions require a grounded as-of date from content or filename. Cash has
   unit price one when no price is exported. Pending activity warns and does not
   become a holding. Footers do not become positions.
4. P&L uses actual payment and expense detail sheets. It groups signed dollars by
   sheet-derived entity, month and category, retaining every amount-cell locator.
   Income and expense sheet names use the same entity rule: remove a trailing
   Income or Expenses label (including Actual) and surrounding punctuation.
   Different aliases remain distinct and require an explicit entity mapping.
   Summary and forecast matrices are excluded to prevent double counting.
   Expense refunds offset expenses. Income, transfer and card/loan payment rows
   in expense ledgers are excluded. The workbook does not establish accounting
   basis or a cash-to-P&L reconciliation.
5. Tax matrices have year-named sheets, Federal/State column groups and Paid
   columns for both payers. Required safe-harbor columns and totals are excluded.
   The export gives months, not payment days: `date` is a month-end reporting
   anchor, `datePrecision` is `month`, and each emitted payment warns
   `month_precision`. Consumers must not describe the anchor as the payment day.
   The row discriminator is `kind: 'tax_payment'`; `paymentKind: 'paid'` records
   the source's classification without assuming withholding or estimated status.
   `payer` retains the Paid column label so equal payments from two payers survive
   deduplication.
   `sheetYear` is grounded in the sheet label. The frozen `taxYear` field retains
   that label with `taxYearBasis: 'sheet_label'` and a `tax_year_assumed` warning.
   `dateBasis: 'sheet_label'` marks the reporting anchor's year as assumed too.
   The source does not establish whether sheets mean payment year or tax year.
   January can contain a prior-year Q4 payment. Neither tax year nor calendar
   year is confirmed; consumers must resolve the convention before tax math.
6. Account maps emit `document` rows with `docType: 'account_metadata'` and
   `fields: {account, source}`. Alias-only balances retain the alias as account
   name and leave institution and mask empty for later explicit mapping.
7. Notes emit one document with `docType: 'notes'` and `fields: {text}`. They do
   not extract facts or financial figures.

`dedupeKey(row)` hashes semantic identity. Both transaction parsers call
`identifyAccountRows(result, file)` to assign `occurrence`, a one-based ordinal
in file order within each account, posted-day and signed-cents group. Distinct
repeated postings retain distinct keys. The Nth occurrence in one export matches
the Nth occurrence in an overlapping export. Invalid rows and running balances
do not consume transaction ordinals. Each parse starts a new count.
Future transaction producers must assign these ordinals before deduplication.

Account identity is normalized institution plus mask, or name when unmasked.
When neither exists, `locator.source` scopes account rows to an opaque SHA256
of filename and bytes. It stores no raw filename or account number. Unidentified
accounts cannot deduplicate across different files until explicitly mapped.
An unnamed account without source identity is rejected by `dedupeKey`.
Description tolerance remains unbounded: provider-added prefixes, suffixes,
punctuation and renamed merchants do not affect a posting's key. Overlap matching
assumes both files include the same occurrences in each group; partial-day dumps
or reordered equal-amount postings cannot establish which occurrence is shared.
Account mapping is explicit; aliases and differently named institutions are not
inferred.
Balance identities include cents so different intraday balances survive. Position
identity is account, day and symbol. P&L identity is entity, month and category;
tax identity is jurisdiction, sheet year, month and payer. Amount corrections
retain the same slot key. A same-key, different-amount row is a revision, not an
additional amount. The pipeline must resolve import order and preserve both
versions as evidence; this module only computes keys. Document fields use canonical key ordering; facts use
key and value. Keys ignore parser and pipeline file IDs, and ignore locators
except the source scope required for an unnamed, unmasked account.

The dependency-free OOXML reader supports ordinary stored or deflated XLSX ZIP
archives, shared and inline strings, cached formula values and both Excel date
epochs. It validates ZIP CRCs, XML structure and bounded decompression. It never
evaluates formulas, resolves external entities, follows external relationships,
or extracts archive paths. Formula cells without cached values warn and are
excluded. ZIP64, encrypted files and layouts without recognized headers fall
back to extraction rather than guessing.

# Pipeline

`pipeline.mjs` exports `ingestFiles(db, files, {engine, config, now, key})` ->
`{results}`, `ingestFile(db, file, opts)` and `retryFile(db, fileId, opts)`. A
result is `{fileId, name, status, sourceKind, parser, counts, duplicateOf?}` with
status `imported`, `duplicate`, `needs_mapping`, `needs_extraction`,
`unsupported` or `failed`. `retryFile` throws `IngestError` with `status` 404
(unknown file) or 409 (file not waiting).

1. The file id is `f-` plus 24 hex of the content SHA256. Same bytes are a
   `duplicate` of the stored file. Bytes are stored encrypted (vault) before the
   `files` row is written; a file's rows are written in one transaction.
2. Routing: a frozen parser, else a tabular file through a learned or proposed
   column mapping (`mapping.mjs`, parser `mapped`), else a PDF or UTF-8 text
   through extraction (`extract.mjs`, parser `extract-<docType>`), else
   `unsupported`. Markdown notes keep the notes parser document and then extract
   facts and goals; with the engine off they wait as `needs_extraction`.
3. Accounts upsert by identity (`inst|mask:`, `inst|name:` or `source:`), id
   `acct-` plus 16 hex of its SHA256, mirror `manual`. A new account asks for its
   owner, and for its kind when the export does not name a known one.
4. Transactions skip a stored key or a confirmed duplicate key; the same amount
   within three days from another file asks `near_duplicate`. Balances and
   positions keep one row per slot; the file whose period ends later (unknown is
   oldest) holds authority: equal values advance provenance, a different value
   is `revised`, an older file's value is archived as `older_snapshot`.
5. P&L entities map through `entity_aliases`; P&L and tax workbook rows carry
   `source_slot`. Same key with another amount is `revised`. A workbook's
   `coverage` (from the workbook itself) archives and removes rows of covered
   slots that the later file lacks (`removed`). A W-2 withholding total archives
   paystub withholding for its slot (`summarized`). An unreadable amount cell
   (`formula_without_cache`, `invalid_pnl_row`, `invalid_tax_payment`) marks
   what it may have fed as partly parsed: for P&L the warned row's entity,
   category and month (every month when its date is unreadable, every category
   when its category is empty); for tax the warned Paid column's slot (every
   Paid slot of the sheet when the column is unknown). A row whose Month cell is
   an uncached formula or an error but has a populated Paid cell warns
   `invalid_tax_month` and marks every Paid slot of its sheet. Stored rows there are
   neither removed nor revised; a differing amount counts as `incomplete` and the
   stored row stays. New keys still insert.
6. Questions (`confirm.mjs`): `account_owner`, `account_kind`, `entity_alias`,
   `tax_year` (subject `tax:<sheetYear>`), `fact_check` (subject
   `<sourceId>|<key>|<canonical JSON value>`, below 0.8 confidence),
   `near_duplicate` and `employer_relation` (employer facts are held in
   `held_facts` until answered). Answers are remembered by kind and subject.
7. Sources are `ing:<parser>:<account id or all>`; account figures
   `acct.<id>.balance` hold the latest balance or the latest holdings total.
   Pack state refreshes when facts change.

Extraction never sends an identifier: text goes through `redactForExtraction`
(amount tokens resolve in code) and mapping samples through `redact` (headers
and at most five rows). Schemas ask for no SSN, EIN, TIN, account number,
person's name or address. Nothing logs file contents or values.
