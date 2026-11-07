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
   not extract facts or financial figures. The pipeline never stores that text:
   it replaces the fields with a reference, `{ref, sha256, chars, lines}` (`ref`
   is the file id of the encrypted upload), before the dedupe key and insert.
8. Aggregator and brokerage-positions files may carry the holder or owner name the
   source itself writes for an account: the first present of the columns
   `account holder`, `account owner`, `owner`, `holder`, trimmed, becomes
   `account.holder` (absent when empty). A mapped file does the same through the
   optional mapping field `accountHolder`; the model sees only the header name and
   redacted samples, as for every column. The holder is never part of the account
   key, so dedupe keys are unchanged.

Parsing is bounded (`format.mjs` `LIMITS`): at most 200000 rows, 512 columns per
record, 2000000 cells in total and 32768 characters per cell. Workbooks keep
those limits except cells: `XLSX_LIMITS` allows 250000, counted over worksheet
cells, shared strings and rich-text runs together, with an XML element budget
sized from it; the metadata parts read into a tree (`xl/workbook.xml` and its
rels) also have their own budget of 20000 elements each. An unknown xlsx table
is budgeted as filled rows times header width against `LIMITS.cells` before its
rows are widened. Readers count while they scan and throw `LimitError` (code
`limit_exceeded`) before passing a limit; a workbook part is checked on its raw
XML bytes before it is read. `csvHeader(file)`
reads only the first record within a 64 KiB window, so `csvScore` and sniffing
never materialize rows. Parsers swallow ordinary failures but rethrow
`LimitError`, in `sniff` too.

`dedupeKey(row)` hashes semantic identity. Both transaction parsers call
`identifyAccountRows(result, file)` to assign `occurrence`, a one-based ordinal
in file order within each account, posted-day and signed-cents group. Distinct
repeated postings retain distinct keys. The Nth occurrence in one export matches
the Nth occurrence in an overlapping export. Invalid rows and running balances
do not consume transaction ordinals. Each parse starts a new count.
Future transaction producers must assign these ordinals before deduplication.
A transaction with an `externalId` (the bank format's `Check or Slip #`, or a
mapped `externalId` column) is keyed by account and that id instead:
`[accountKey, 'ext', externalId, signed cents, occurrence]` (the occurrence only
for a repeat of the same id and amount within one file), with no date, so a check
deduplicates even when its posting date differs between exports, and a check and
its return never collide.

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
`unsupported`, `too_large` or `failed`. `retryFile` throws `IngestError` with
`status` 404 (unknown file) or 409 (file not waiting). A file left `pending`
by an interrupted run is routed again by `retryFile` or by re-uploading its
bytes; a concurrent upload of bytes being ingested is a `duplicate`.

1. The file id is `f-` plus 24 hex of the content SHA256. Same bytes are a
   `duplicate` of the stored file. Bytes are stored encrypted (vault) before the
   `files` row is written; a file's rows are written in one transaction.
2. Routing: a frozen parser, else a tabular file through a learned or proposed
   column mapping (`mapping.mjs`, parser `mapped`), else a PDF or UTF-8 text
   through extraction (`extract.mjs`, parser `extract-<docType>`), else
   `unsupported`. Markdown notes keep the notes parser document (as a reference,
   never text) and then extract facts and goals from the decrypted bytes (on retry,
   from the vault); with the engine off they wait as `needs_extraction`. A
   `LimitError` anywhere in routing records the file as `too_large` with note
   `limit_exceeded` and counts `{warnings: 1, warningCodes: {limit_exceeded: 1}}`;
   its encrypted bytes stay and nothing else is stored.
3. Accounts upsert by identity (`inst|mask:`, `inst|name:` or `source:`), id
   `acct-` plus 16 hex of its SHA256, mirror `manual`. A new account asks for its
   owner, and for its kind when the export does not name a known one. A row's
   holder name is kept in `account_holders` for new and existing accounts; the
   first source to name one wins and a later file never replaces it.
4. Transactions skip a confirmed duplicate key. A stored key from another file
   is compared by normalized description (lowercase letters and digits): equal is
   a duplicate. From another parser, equal normalized descriptions or a shared
   distinctive word (a run of 3 or more letters outside card and payment
   boilerplate) make a cross-format overlap, a duplicate counted under
   `counts.crossFormat` when only a word is shared and archived as
   `duplicate_cross_format`. Any other description is another transaction: it is
   stored under `<key>:d:<first 16 hex of SHA256 of the normalized description>`
   and asks `near_duplicate` whatever the distance between the dates, against the
   collided key's active row or, when that key holds only a confirmed duplicate,
   the active row reached by following `survivor_key` links on the tombstones
   (bounded; a cycle, self link or missing survivor asks nothing). An alt key
   already stored or confirmed duplicate is a duplicate with no new question. The
   same amount within three days from another file asks `near_duplicate` too,
   once per pair (subject: the two keys sorted). Balances and
   positions keep one row per slot; the file whose period ends later (unknown is
   oldest) holds authority: equal values advance provenance, a different value
   is `revised`, an older file's value is archived as `older_snapshot`. A
   positions file is a complete snapshot of each (account, as-of) it lists, and a
   statement extraction with a `holdings` key (even an empty list) emits a
   `snapshot` row (`account, asOf`) for its account and period end; without the
   key it is no snapshot. Stored positions of that account and date the snapshot
   omits are archived as `removed` and deleted when the file holds period
   authority. A warning other than `pending_activity` or `invalid_cost_basis`
   makes the account it names incomplete (`invalid_position` and
   `truncated_position` carry `account`), or every snapshot of the file when it
   names none; an incomplete snapshot never removes.
5. P&L entities map through `entity_aliases`; P&L and tax workbook rows carry
   `source_slot`. Same key with another amount is `revised`. A workbook's
   `coverage` (from the workbook itself) archives and removes rows of covered
   slots that the later file lacks (`removed`). Withholding slots are
   `wh:<employer or payer key>:<taxYear>:<jurisdiction>:<recipient>` with recipient `owner`,
   `spouse` or `unknown` (also `tax_payments.recipient`). A W-2 withholding total
   archives paystub withholding of its slot (`summarized`) only when the recipient
   is known; an `unknown` slot never summarizes. An unreadable amount cell
   (`formula_without_cache`, `invalid_pnl_row`, `invalid_tax_payment`) marks
   what it may have fed as partly parsed: for P&L the warned row's entity,
   category and month (every month when its date is unreadable, every category
   when its category is empty); for tax the warned Paid column's slot (every
   Paid slot of the sheet when the column is unknown). A row whose Month cell is
   an uncached formula, an error, blank or not a month name (summary labels such as
   totals and required amounts excepted) but has a populated Paid cell warns
   `invalid_tax_month` and marks every Paid slot of its sheet. Stored rows there are
   neither removed nor revised; a differing amount counts as `incomplete` and the
   stored row stays. New keys still insert.
6. Questions (`confirm.mjs`): `account_owner`, `account_kind`, `entity_alias`,
   `tax_year` (subject `tax:<sheetYear>`), `fact_check` (subject
   `<sourceId>|<key>|<canonical JSON value>`, below 0.8 confidence),
   `near_duplicate`, `employer_relation` (employer facts are held in
   `held_facts` until answered), `employer_recipient` (subject the employer key;
   options `owner` You, `spouse` Your spouse, `both` Both of you) and
   `document_recipient` (subject the document's payer identity; options `owner`,
   `spouse`, asked per paystub or W-2 after `both`, and directly per 1099 with
   withholding, naming its form label). While the recipient is unknown a
   withholding row's payer identity is `<payer>:doc:<file id>`, so two members'
   identical documents stay apart. A recipient answer sets the
   recipient of the matching withholding rows, recomputes their slots and
   summarizes per slot; a rekeyed row that collides with one of the same
   recipient and amount is archived as `duplicate`. A different amount, at
   rekey or at import of a document, keeps both rows and asks
   `withholding_conflict` (options `first`, `second`, `both`; the rejected row
   is archived as `withholding_conflict`, the survivor takes the identity). The question names each row by id, dedupe key,
   file id and amount; once a named row is summarized, archived or rekeyed it closes as superseded, and answering
   a question whose rows no longer match is refused as `stale`. A W-2 or 1099 row of a known recipient in the slot of an
   active row of the same form type from another file under another key asks it too, equal amounts or not (paystubs never
   do; `both` keeps both). An explicit zero federal withholding field is a row
   (a correction to zero meets this rule); an absent one is not. Answers are remembered by kind and subject
   and apply at import; a remembered `first` or `second` keeps the row whose dedupe key and amount it kept, not a position.

   Cards show their evidence, not only the question (`context.mjs` `cardDetail`,
   read from stored rows, every figure with its file and date; no account number
   beyond the 4-digit mask and no SimpleFIN id). Account questions show the
   account (institution, mask, holder, source files, date range, row counts,
   latest balance with date and every file it sums, three latest transactions) beside every
   account with the same name, and list the fields that differ, because the owner
   and spouse can hold same-named accounts. `near_duplicate`,
   `withholding_conflict` and `account_match` show the entries side by side with
   the differing fields marked; `account_match` compares the candidate with the
   snapshot the last SimpleFIN sync stored (`simplefin_snapshots`), balance date
   included, and below it shows the candidate's full account view, its same-named
   accounts and the snapshot's three newest postings. Other kinds
   show their file and the values asked about.

   Best guess (`bestguess.mjs`): a deterministic rule guess (kind from the account
   name, `same` for equal date and amount, `joint` when a multi-holder name matches
   both household members) or the stored engine guess. The rule wins. Evidence is
   always rendered from stored values and quotes the field or document it came
   from (account name, institution and mask, source file, document type); engine
   prose never reaches the card. Guesses never answer.

   Auto-resolution (`auto.mjs` `autoResolve`) answers a pending question before
   it is asked, only when stored rows settle it, through the normal answer path
   (own transaction, undo log, `confirm_auto` row with rule and evidence inside the
   log). Rules:
   a. `cross_format_duplicate` (`near_duplicate`, option `same`): same account,
      date and cents, different parsers and files, not two different reference
      numbers, and either a key collision pair or the only row of its kind in each
      file, so the match is one to one and multiplicity is kept. A pair asked only
      by the three-day window is never resolved.
   b. `holder_match` (`account_owner`): the account's holder is a single name (no
      `&`, `+`, `/`, `,`, `and`, `or`) and matches exactly one household member,
      either by the `household.names` fact (every word of the stored name appears
      in the holder) or by an account with the same holder that you answered
      `owner` or `spouse`. A holder matching both members, or sources that
      disagree, asks.
   c. `shared_mask` (`account_owner`, `account_kind`): every answered account with
      the same 4-digit mask at a compatible institution (equal, or either empty)
      agrees. For `account_kind` a sibling whose kind came from its export counts.
      Bridge accounts, pairs answered `different` in an `account_match`, and pairs
      with two known, different holders are ignored. An `account_owner` whose
      holder names several people, or whose holder sources disagree, is never
      answered this way; an account with no holder can be.
   Safeguards: evidence lists the answers it rests on (`basis`) and their whole
   ancestry (`ancestors`), and no answer is ever used to support one it rests on.
   An item the owner reopened is declined and never auto-answered again. An auto
   owner or kind answer stays undoable after a later import (it is exempt from
   `imported_since`; `used_since` and `changed_since` still make it final), because
   undo restores only the account columns that answer changed. `autoResolve` runs
   once at the end of `ingestFiles`, `retryFile` and a SimpleFIN sync, and after an
   answer, a batch answer, a reopen or a revise, so rules b and c pick up answers
   as they land. A failure logs a code and never changes a file result or fails
   the request.

   Undo and dependents: reopening or revising an item first reverts, newest first,
   each auto answer whose ancestors include it (each in a savepoint; a final one
   stays, a failed revert rolls back alone). Reopening any answer, the owner's
   or Fathom's, marks the item declined, so Fathom always asks it again. A batch
   answer (`answerItems`) and a batch reopen (`reopenItems`) run in one transaction
   with an undo log per item, and any refusal changes nothing.

   Decided for you lists the answered items that have a `confirm_auto` row, newest
   first, each with its rule, evidence and Undo (a final one shows why it is final).
   In the Confirm deck an account question shows a Best guess tag on the guessed
   option with a Use best guess button, and when two or more account_owner or
   account_kind questions are pending they fold into one grouped card with a row
   per account, the guess preselected, and Use best guesses for all.

   Rank and group: `ingestState` sorts pending items by impact and the deck walks
   them in that order. Rank 0 tax_year, employer_relation, employer_recipient,
   document_recipient, withholding_conflict; 1 fact_check; 2 account_kind and
   account_owner (larger absolute latest balance first within); 3 account_match,
   entity_alias; 4 near_duplicate. `group` is the kind for account_owner and
   account_kind, else null.
7. `counts` is `{rows: {kind: n}, duplicates, crossFormat, revised, superseded,
   incomplete, warnings, warningCodes: {code: n}, queued}`, plus `extractPath`
   when extraction ran: `text`, `pdf_text_layer`, `pdf_document` or `pdf_withheld`.
8. Sources are `ing:<parser>:<account id or all>`; account figures
   `acct.<id>.balance` hold the latest balance or the latest holdings total; with
   no balance, a complete empty snapshot dated after every stored position makes
   it 0, located at that file's holdings list.
   Pack state refreshes when facts change.

Extraction never sends an identifier: text goes through `redactForExtraction`
(amount tokens resolve in code) and mapping samples through `redact` (headers
and at most five rows). A PDF is read first by `pdftext.mjs` `pdfText(bytes)` ->
`{status, text, pages}` (pdfjs-dist in a resource-limited worker thread with a
20 s timeout, a 2 MB text cap and its output discarded; never rejects). Status
`text` (any text with a letter) is redacted and sent as text like a text file
(`pdf_text_layer`); `image_only` (no text on any page) goes as a document
(`pdf_document`), which is why no schema asks for an identifier; `incomplete`
(more than 50 pages, timeout, cap or out of memory) and `failed` (a parse error)
wait as `needs_extraction` with note `pdf_unreadable` and nothing is sent
(`pdf_withheld`). No store row holds file text: notes are a
reference, document fields hold extracted values, confirm contexts hold keys,
values and labels, and mapping samples are never stored. Schemas ask for no SSN, EIN, TIN, account number,
person's name or address. Nothing logs file contents or values.
