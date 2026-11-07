# Model-parsed imports

Status: proposed specification. Source snapshot: `main` at `8351e0b` (2026-11-07).
Remote `main` was `5a7fd22` at final revision; implementation readiness refreshes all probes.
This change ships documentation only. The ticket bodies below are planning contracts,
not filed issues or dispatched work. One cross-provider plan review precedes coordinator review.

## Risks and external dependencies

1. A valid schema does not prove a correct interpretation. Source citations, complete input
   coverage, reconciliation, and the owner's first approval gate every new layout.
2. C10 in [ask-tools.md](../ask-tools.md#c10-preferences-definitions-and-refresh) owns
   `refresh.import_file`, `refresh.retry_import`, and `household.imports`. They are not on this
   base. IMP-7 waits for C10 and uses those operations, rather than creating competing tools.
   The operation-registry consolidation PR #92 is open; workers must refresh its merge state.
   C2 owns `write:imports` and `registerReceiptKind`; IMP-3, IMP-4 and IMP-5 wait for C2.
   IMP-2 waits only for IMP-1. It uses the household engine's existing monthly `cap`
   setting and `spend_ledger`, platform `funded()` check, outbound engine pause, and its own
   per-file limit. MT-05 reservation integration is deferred to MT-05's own ticket.
3. The multi-household document is a specification, but household runtimes, vaults, and outbound
   controls already exist in `src/platform/runtime.mjs` and `src/platform/outbound.mjs`.
   All new state belongs to the captured household database and vault, never platform tables.
4. A paid live evaluation needs worker-shell credentials, funded engine access, and explicit
   spend authorization. This spec does not run a model or grant spend. Offline acceptance is
   sufficient for each implementation PR; a live score remains a separate acceptance receipt.
5. Public code and fixtures contain only generated data. No source workbook, copied layout,
   private amount, identity, hostname, username, or machine path enters the repository or PR.

## Pinned decisions

The engine interprets arbitrary household files. Code reads bounded bytes, validates proposals,
resolves accounts and entities, calculates figures, deduplicates, and writes. A household's
layout never becomes a parser, filename rule, sheet-name convention, or application regex.
The product answers from everything already known, identifies specific remaining gaps, and
accepts corrections in plain words. It does not require a data-entry form.

The product remains advisory. No money movement, filing, security selection, bank mutation,
or external instruction execution is introduced. The engine receives no write tools during
file interpretation. Every amount it proposes is a reference to a source cell or text span;
only deterministic code turns references into values and aggregates.

### Complete parser inventory on the base

| Current file under `src/ingest/parsers/` | Decision | Retained boundary |
| --- | --- | --- |
| `chase-activity.mjs` | Keep | Standard institution checking and credit-card activity CSVs, with existing occurrence and reference-number identity. |
| `brokerage-positions.mjs` | Keep | Standard brokerage positions exports, including grounded snapshot dates. |
| `aggregator.mjs` | Keep | The aggregator transaction export and its documented sign convention. |
| `pnl-workbook.mjs` | Replace | Engine mapping or cited rows for P&L and spending workbooks. |
| `balances.mjs` | Replace | Engine mapping or cited rows for month-end balance sheets. |
| `account-map.mjs` | Replace | Engine mapping or cited account metadata proposals. |
| `tax-payments.mjs` | Replace | Engine mapping or cited rows for payment logs. |
| `notes.mjs` | Replace | Common free-form proposal and action path. |

`src/ingest/simplefin.mjs` is outside this directory. Keep it as a deterministic, read-only
connector. These standard institution exports and SimpleFIN are the entire deterministic
parser boundary. New standard institution variants can add documented adapters with synthetic
fixtures; unknown variants use the engine path. Do not call an arbitrary CSV standard because
its columns happen to look familiar.

Keep `format.mjs`, the bounded OOXML reader in `workbook.mjs`, PDF text extraction, vault
storage, semantic dedupe, account matching, and generic mapping application. Reading a format
is distinct from interpreting its financial meaning. Remove `ledgerHeader`, `taxHeader`,
`entityOf`, and all business-specific workbook coverage inference when their callers migrate.
No code derives a business identity by stripping a suffix from a sheet name.

Existing model extraction of statements, tax documents, and plan documents joins this proposal
contract. Their document schemas remain semantic targets; they no longer write unchecked
numeric model literals. Text-layer PDFs get page and text-span references. Image-only PDFs
wait as `needs_source_text`: this subsystem does not send unredacted scans or guess OCR values.
That change replaces the current raw-image extraction route and migrates its callers in IMP-4.

## Current seams and intended flow

`pipeline.mjs` currently tries `registry.mjs`, then `mapping.mjs`, then `extract.mjs`.
`mapping.mjs` hashes normalized ordered headers, samples five rows, and immediately saves and
applies a new model mapping. It supports transactions, balances, and positions only, and reads
only the first workbook table. The new flow visits every populated sheet and region, stages
new proposals, and never treats an engine proposal as owner approval.

1. Capture actor, household id, generation, clock, database, engine, and vault from the request
   context before awaiting. Retain `householdOf` ownership checks and household in-flight ids.
2. Store original bytes encrypted and identify content by the existing SHA256/file id. Perform
   bounded decoding before model admission. A malformed or oversized file makes no ledger write.
3. Standard institution parser results continue through deterministic ingest. Every other file
   becomes a bounded source index. First try an approved mapping, then ask the household engine
   for a typed mapping or referenced rows. Never send a document to the categorizer service.
4. Validate the entire proposal, stage it in the household DB, and render its deterministic
   summary. Unresolved identity, sign, date, coverage, or total conflicts block affected groups.
   Independent validated groups remain visible as proposals, but the file commits atomically.
5. The authenticated owner accepts in plain words. Revalidate against current stored rows and
   the saved source hash, then commit through existing ingest persistence and Ask actions.
   Run existing post-ingest freshness, planning, guesses, and pack refresh after commit only.
6. Return a receipt and outcome counts. Reads distinguish pending proposals from active data;
   pending, expected, incomplete, and rejected figures never become observed actuals.

### Source index and provenance

Index every populated workbook cell with its sheet ordinal, coordinate, value type, formula
flag, cached-value flag, and raw value hash. Preserve merged-cell anchors and both Excel date
epochs. Index CSV/TSV columns by ordinal as well as header, so duplicate header labels cannot
silently bind to the wrong column. Text has UTF-8 byte offsets and line numbers; PDFs add page.
Empty, error, uncached-formula, hidden, and excluded regions have explicit dispositions.
Hidden sheets are inventoried; the model cannot silently discard them. Never execute formulas,
macros, archive paths, links, embedded instructions, model code, or SQL.

A source reference has this logical shape, persisted in existing locator JSON and proposal
records rather than a new public identifier format:

```json
{
  "fileId": "f-synthetic",
  "sha256": "content digest",
  "sheet": {"index": 0, "nameRef": "s0"},
  "cell": "D7",
  "row": 7,
  "column": 4,
  "rawHash": "cell digest",
  "valueType": "number",
  "precision": "cent"
}
```

For text, replace sheet/cell/column with `page`, `line`, `byteStart`, `byteEnd`.
Each output field has `{refs, transform}`. `transform` is an allowlisted declarative operation:
identity, trim, date decode with declared locale/epoch, month reporting anchor, currency decode,
as-is/negate sign, debit-credit difference, or sum of explicit references. It is never executable
text. Account/entity labels and dates need citations too. A model response names reference ids
and typed labels; it cannot supply an amount, quantity, percentage, or calculated total literal.

Persist `{version, fileId, proposalId, mappingId, mappingVersion, interpreterVersion,
fields, derivedFrom, completeness}` with each new locator. `derivedFrom` retains all operands
of a deterministic aggregate, not merely the last contributing file. Original bytes remain the
source of truth; model output is not evidence. Display counts and totals are calculator/store
results with these references. Human-facing filenames and sheet names are read locally only.

### Typed targets

All money follows the frozen dollars/cent rounding contract. Reconciliation and comparisons
use integer cents internally. Unknown means null or a held field, never zero.

| Target | Required fields and rules | Persistence |
| --- | --- | --- |
| Transaction | Resolved account, posted date, signed amount reference, description reference; optional category and external-id references. Outflow negative. Assign occurrence before dedupe. | Existing `transactions`, via pipeline. |
| Balance | Resolved account, as-of reference, amount reference, date precision, `running` or `closing` basis. Do not turn a running balance into a month-end balance. | Existing `balances` and deterministic figure refresh. |
| P&L line | Resolved entity, `YYYY-MM` period, category, signed amount references, `business` or `household_spending` purpose. Revenue positive, expense negative, refunds offset expenses. Basis is `cash`, `accrual`, or `unknown`, source-cited or explicitly confirmed. | Existing `pnl_lines`; group in code by entity/period/category. Never duplicate imported detail and its summary. |
| Fact | Registered typed key, cited value, as-of and precision, scope and subject. No arbitrary new fact key from a model. Unsupported statements remain source-linked notes. | Existing facts actions and their evidence/confirmation rules. |
| Tax payment | Jurisdiction, payer/recipient, amount reference, payment kind, tax year and its basis, payment date and precision. Paid versus required, estimated versus withholding, and tax year versus calendar year remain distinct. | Existing `tax_payments` via pipeline and current conflict/withholding safeguards. |
| Account metadata | Source alias, cited institution/mask/kind/holder fields, proposed resolved account id. Metadata does not create a balance or merge accounts. | Existing account document/matching/Confirm actions. |
| Position/document | Preserve current position and document target fields, including individual tax boxes and plan terms, using cited fields under this contract. | Existing positions/documents; no security selection. |
| Expected transaction | Subject/payer, direction, due date/precision, nullable amount, account id when known, status `expected`, `observed`, or `cancelled`, source statement and actor. | New household `expected_transactions`, written by a shared action, excluded from actual balances, P&L, and paid tax. |

A tax log naming only a month gets a month reporting anchor with `datePrecision: month` and
its stated/confirmed year convention. It cannot establish a payment day. Ambiguous January
payments ask a narrow tax-year question. No source or confirmation means no use in tax math.
A P&L ledger does not establish tax wages, payroll compensation, or accounting basis by itself.

### Validation and complete coverage

1. Verify every reference exists in the exact file hash and matches its raw hash and type.
   No uncached formula or error cell can support a value. Reject unknown fields, transforms,
   target types, and nonexistent references. A confidence score never bypasses a check.
2. Inventory each populated region as imported detail, cited control total, duplicate summary,
   forecast, explanatory text, or unresolved. Every excluded amount region needs a cited
   reason. Missing/unresolved regions block complete-coverage claims and omission deletion.
3. Recompute sums by account/entity/period from included detail. Compare every applicable
   cited subtotal and grand total to the same semantic group in integer cents, tolerance zero.
   A source total with its own explicit rounding precision is compared after that declared
   rounding. Never silently widen tolerance. Cached formulas are source values, not proof
   their formulas were evaluated recently. If no control total exists, say “No sheet total
   to check”; do not claim totals match. Owner acceptance can approve a fully inventoried
   no-total layout; contradictory totals require a corrected proposal or explicit exclusion
   of an identified control total before committing.
4. Validate calendar dates, locale, epoch, period, currency, and sign. Version one accepts USD
   only; other currencies wait with `unsupported_currency`. No FX conversion or fiscal-period
   inference. A changed unit/sign/date interpretation invalidates cached applicability.
5. Resolve accounts through current identity and match rules, including holder ambiguity.
   Alias maps are explicit local state. Never merge by a guessed name, mask, or sheet title.
   A plain-language clarification can settle multiple related fields; do not ask for known facts.
6. Run `identifyAccountRows`, `dedupeKey`, posting observations, cross-format comparisons,
   confirmed duplicate tombstones/survivor links, and near-duplicate questions exactly as the
   standard path does. External ids remain account-scoped; equal repeated postings survive.
7. Validate facts with registered shapes and actions; preserve W-2 box distinctions, employer
   relations, recipient conflicts, explicit zero versus absent withholding, source slots,
   snapshot authority, and incomplete-group guards. P&L totals are calculated from cited detail.
8. Revalidate at approval/commit against current rows. A stale proposal returns `proposal_stale`
   with its deterministic diff. The transaction rolls back every row, receipt, and mapping
   approval on refusal. Household suspension/generation changes refuse a late commit.

## Plain-language confirmation and layout memory

First use shows one deterministic summary, for example: “12 months of spending for 2 people,
380 rows, totals match the sheet.” Those synthetic example counts must come from validation
when rendered. It also says what will insert, revise, remain duplicate, or remain unresolved.
“Looks right”, “yes”, and an unambiguous instruction to import accept that specific version.
“Wait”, a correction, or a mixed reply does not. Use existing actor-bound conversation evidence;
never infer acceptance from silence or a high model score. Detail and source popovers are optional.

Save the approved declarative mapping in `column_mappings`, keyed by household-local ordered
normalized `headerSignature`, mapping schema version, and structural context. Context includes
sheet/region structure, header ordinals, target, explicit units, sign/date rules, account/entity
bindings, and row/summary roles. Header signature is the index, not permission to reuse one
ambiguous mapping for unrelated same-header tables. A compatible, uniquely bound mapping applies
all rows locally, validates totals and dedupe again, and commits with zero engine calls and zero
mapping confirmation, including with outbound engine paused. New account/conflict questions
remain ordinary Confirm questions, not a repeated layout approval.

Never store file-specific row amounts in the mapping. Deterministic guards check applicability
on every file. Added/removed/reordered columns, new populated regions, changed unit labels,
invalid dates/signs, or conflicting account bindings hold the file. Carry unchanged approved
bindings into a versioned proposal and ask only for the changed interpretation: “A new Credit
column appeared; should it offset Debit?” Optional unused-column changes are recorded and shown
as a delta too. No automatic shape migration or fallback parser.

For irregular files the engine proposes typed rows for each new content hash. Without a stable
headered mapping there is no executable layout cache to reuse. Identical bytes reuse their
staged/approved interpretation without another call; new irregular content needs interpretation
and a summary approval. This is explicit in status, rather than promising a zero-call reuse of
prior extracted values. A repeat rectangular region in an irregular workbook can acquire an
approved generic column mapping; no per-household extraction code is generated.

Existing `column_mappings` have no recorded owner approval. Add approval/version metadata,
mark existing entries unapproved, and stage one summary on their next use. Do not rewrite their
already imported rows or pretend an earlier model decision was owner consent.

### One proposal review interface

IMP-3 delivers the shared review service and authenticated HTTP route
`POST /api/import-proposals/:proposalId/review`, with body
`{version, decision, evidence}`. IMP-7 registers exactly that service as
`refresh.review_import {proposalId, version, decision, evidence}` in C10's existing tool;
no other approval, correction, or commit operation is introduced. `version` is the positive
integer proposal version; `decision` is `approve` or `correct`; `evidence` is the exact owner
statement, bounded to 1 through 4,000 characters. The required scope is `write:imports`, plus
every underlying action scope when the proposal contains facts, goals, or recommendation edits.
The HTTP route uses the existing session, Origin and household guards; MCP uses its scoped key.
Both resolve actor and household from context, never body fields.

For `approve`, match `evidence` to the authenticated actor's current owner statement using
`src/actions/evidence.mjs`, require unambiguous acceptance of the immediately presented
proposal/version, and atomically revalidate, commit, approve the mapping, and return
`{proposalId, version, status, counts, receipt}`. A stale version returns HTTP 409 with
`proposal_stale`; a foreign id returns 404; missing scope returns 403 with no effects.
For `correct`, the owner statement becomes cited correction evidence and a new versioned
proposal. Interpretation requiring the engine returns queued, never commits immediately,
and cannot reuse approval from an older version. Numeric corrections remain subject to
shared evidence validation. The revised version must be explicitly accepted.

IMP-3 keeps the new mapping/proposal path internal until IMP-4's atomic routing cutover;
existing upload behavior does not start staging new layouts on IMP-3's merge. Its HTTP route
can operate on synthetic seeded proposals in boundary tests. Since C10's refresh registration
arrives in IMP-7, IMP-3 records this single route/operation pair as planned in C2's explicit
`PARITY_PENDING` inventory and the tool catalog; IMP-7 removes that pending entry and proves
actual HTTP/MCP/Ask parity. This is a tracked unbuilt operation, not a second write path.
All engine work for corrections in Ask uses C10's `queueAfterTools`; MCP/HTTP can run it inline.

## Free-form updates and shared action writes

A pasted, typed, or uploaded note is encrypted as a source and interpreted into the same staged
proposal envelope. Bind source spans to the authenticated owner's statement, not assistant
prose or an older unrelated conversation. Present what was understood and accept a correction
or approval in plain words. Use `src/actions/index.mjs`, `src/actions/evidence.mjs`,
`src/actions/receipts.mjs`, and the shared `undo` dispatcher. There is no note-specific SQL
writer for facts, goals, rec steps, or expected transactions.

For “payroll true-up done, the payroll provider pays next Tuesday”, match a unique stored
payroll recommendation step and propose its completion through `changeRec`; if none exists, retain that clause as a
source-linked note rather than inventing a fact key. A recognized typed fact uses `recordFact`,
and a goal edit uses `changeGoal`. Add one expected-transaction action in `src/actions/` and
one registered `answer.expected_transaction` operation; no separate import-only action.
C10 still owns import, retry and proposal review. The expected action requires `write:imports`;
fact writes additionally require `write:facts`, goal writes `write:goals`, recommendation-step
completion `write:steps`, and recommendation status/owner edits `write:recs`. Import approval
never grants those scopes. Check all required scopes before applying the group; a missing
scope leaves that action and the whole note group pending with a permission reason and no
partial writes. Each child receipt retains its action's scope.

Reuse the existing `settings.timezone` through `ownerTimezone(db)` in
`src/jobs/scheduler.mjs`, including its existing `America/New_York` default and validity checks.
Do not create a second timezone setting or change the scheduler/email default. Show the
resolved timezone with relative-date summaries.
Relative dates are resolved in deterministic code from the source's captured date and household
timezone: “next Tuesday” means the first Tuesday strictly after that local date. Preserve the
phrase, anchor, timezone, rule, and resulting ISO date in evidence and show the resolved date
in the summary. Extend the shared evidence validator with this typed date derivation and
source-span validation; do not relax it to accept arbitrary model dates. An uploaded historical
note without an anchor asks for the date. No amount was stated in the example, so the expected
payment amount stays unknown; do not borrow gross/net from an unrelated payroll record.

Approval applies all note actions in one outer transaction, defers replanning until commit,
and groups their existing action receipts into one Undo affordance. Register expected
transaction and atomic receipt-group kinds through C2's
`registerReceiptKind(kind, {restore})`; do not add another fixed-table Undo dispatcher.
Group metadata retains the child receipt ids and union of their required scopes. Before any
restore, grouped Undo verifies the actor owns every child receipt and holds every child scope,
then checks all current after-states and dependent changes. A missing scope or stale child
refuses the whole group atomically; `write:imports` alone cannot undo fact or goal changes.
The original encrypted note and audit receipt remain. Do not delete an observed posting when
undoing an expectation. Linking an expectation to a later observed transaction is explicit and
never counts the expectation in actuals. No automatic amount-only match in version one.

Ask answers relevant stored facts while a note/import waits and names only the unresolved part.
It neither hides existing knowledge behind setup nor makes the owner repeat values already held.

## Privacy, engine admission, and cost

Reuse `scrubDescription`'s normalization, household-name and known-account masking, and identifier
redaction before dispatch. It currently also masks every digit and truncates at 600 characters,
so applying it to serialized workbooks would destroy amounts and dates. Apply it to semantic
text leaves, tokenize numeric/date cells and typed text quantities first, and keep the reversible
reference index local. Use opaque account/entity/sheet ids. Original filenames, names, account
numbers, credentials, raw cell hashes, vault paths, and the reverse token map never leave.
Known private names in headers and sheet labels are scrubbed too. Numeric text values, percentages,
and date/amount tokens resolve only against the local source index. Do not send truncation as
complete text: oversized leaves are split into referenced spans, or the proposal waits.

The model receives only scrubbed headers/labels, opaque ids, value types, cell/row coordinates,
five scrubbed sample rows per table for mapping, and bounded scrubbed indexed regions for
irregular extraction. Account ids are ephemeral tokens; a household-local resolver restores
identity. Identifiers remain masked rather than recoverable to the provider. Semantic financial
content and structure still leave through the configured engine, as in categorization; the UI
states that limitation. Never log prompts, output values, or decrypted note text.

Pinned defaults per file, including classification, correction, chunks, retries, and restart:
USD 0.50 total, 4 dispatched calls, 32,768 input tokens, 8,192 output tokens total, 4,096 output
tokens per call, 120 seconds wall clock per attempt, and 1 retry within those same limits.
These are admission ceilings, not a promise that every file fits. The 250,000-cell OOXML limit
still bounds decoding; a file larger than the model envelope waits with `budget_exhausted`.
Never silently sample away uncovered sheets. A user can supply a smaller file; the agent cannot
raise a cap. The default file cap also applies to a note treated as a file.

IMP-2 admits every file through the existing household engine in `src/engine/runtime.mjs`:
read its monthly `cap` setting and `spend_ledger`, require the platform `funded()` check and
`ctx.household.outbound.enabled('engine')`, and apply the remaining per-file limit before
calling it. Use purpose `extract` and an import/file correlation id. Persist the file's calls,
tokens, actual cost, and conservative failed/unknown cost in household `import_model_spend`;
retry/restart cannot reset these counters. The existing engine remains responsible for its
monthly cap admission and ledger. The per-file request allowance is the smaller of remaining
file budget and the engine's current remaining monthly cap. A false funding or outbound check
dispatches nothing. Do not add household/instance round reservations in IMP-2.

Validate file ceilings against the selected engine model's configured prices; if one legal
call cannot fit, dispatch none and record `budget_exhausted`. Test that boundary rather than
assuming a token-to-dollar price.

Deferred to MT-05: when its transactional round reservations land, MT-05 attaches these existing
per-file limits and `import_model_spend` correlations to its round-reservation/settlement API in
its own ticket. IMP-2 does not wait for MT-05 or promise the cross-process reservation guarantees
that MT-05 will supply.

Check `ctx.household.outbound.enabled('engine')`, runtime `isOn()`, funding, remaining budget,
and household generation before every provider dispatch, retry included. A pause after a call
starts forbids subsequent dispatches; keep its returned proposal local and require a valid
current context for commit. Nothing toggles the engine or raises its cap automatically.

| State | User-visible status | Consequence |
| --- | --- | --- |
| Engine off, no credentials, or outbound paused before interpretation | `waiting_for_engine`: “File saved. Waiting for the engine to interpret it.” | Encrypted bytes stay; no guessed rows, automatic outbound attempt, or confirmation of nonexistent output. |
| File or household budget exhausted | `budget_exhausted`: “File saved. Interpretation stopped at the budget limit.” | Retain validated staged chunks and spend, commit nothing; explicit retry obeys the same remaining cap. |
| New mapping or new irregular proposal validated | `needs_confirmation` | One grounded summary; no active ledger writes yet. |
| Ambiguous or invalid interpretation | `needs_clarification` | Narrow plain-language question with source evidence, no form. |
| No safe text source | `needs_source_text` | Keep original encrypted, request readable text; no raw scan dispatch. |
| Approved layout valid locally | `imported` | No model or new layout confirmation; ordinary identity/conflict questions still apply. |

Persist reason codes separately from display text. New statuses migrate every API, tool,
scenario, retry whitelist, UI, test, and documentation consumer in the same owning ticket.
Legacy waiting files are routed by new logic on explicit retry; no automatic paid backfill.

## Migration, duplicates, supersession, and Undo

Migrations are additive and numbered at merge. Keep all imported rows' existing file ids,
parser labels, locators, source slots, confirmed answers, tombstones, and archived versions.
Historical parser labels are evidence, not executable compatibility branches. Label rendering
uses persisted source metadata with a generic historical label when missing; it never needs
an import from a deleted parser. The existing domain source id `tax-payments` can remain a
planner aggregate source; it is not an executable parser registration.

A same-byte upload remains a file duplicate. Add explicit `reinterpret` mode to the existing
retry service for an already-imported file: it reads the retained vault bytes under the same
file id, creates a new proposal/version, and keeps old active rows until validated approval.
Normal retry semantics stay for waiting files. This is one current API contract with an explicit
mode, not a legacy signature. A corrected file with different bytes uses ordinary upload.

The commit adapter uses current semantic duplicate rules, not parser names or proposal ids as
identity. Equal observations retain all source evidence; distinct repeated transactions survive;
corrections archive before-images as revised. New interpretation of identical bytes compares
with the old interpretation rather than being short-circuited by file-id duplicate detection.
Each supersession records proposal/version plus before/after provenance even when file ids match.
Completeness comes from validated coverage declarations and source-index inventory, replacing
`pnlCoverage`, `taxCoverage`, `incompleteParts`, and snapshot parser-id allowlists with target
capabilities. Missing rows are removed only for fully validated, explicitly complete groups
that hold current period authority. Incomplete, older, unresolved, or partial files cannot
remove or overwrite held source slots. A re-import does not gain authority from upload time.

IMP-4 removes all five replaced parsers and migrates every production caller, registry entry,
label, coverage branch, helper, test expectation, and fixture route in its PR. Test historical
provenance with synthetic populated stores, not by retaining old parsing implementations.
Run reference searches to distinguish inert historical labels from executable dispatch.
No dual signature, filename fallback, old-layout special case, or parallel parser path.

IMP-4 registers model-import batch restoration through C2's
`registerReceiptKind(kind, {restore})`, reusing IMP-5's receipt-group support and preserving
before/after images. Model-import receipts require `write:imports` plus every child action
scope when a batch contains facts or other actions; authorization preflight and grouped Undo
use the same all-scopes rule as notes. Never use an import receipt to bypass a narrower action
scope. New model batches and note groups expose Undo through the one shared dispatcher.
A batch reverts revisions and omission removals only if all affected after-states still match. Refuse dependent/stale Undo atomically. Old imports remain subject to their
existing Confirm Undo rules. This intentionally amends C10's planned “import Undo unavailable”
for new model batches; standard legacy imports do not acquire fabricated historical receipts.
The file record and spent model cost survive Undo. Undo of first approval invalidates its
mapping's automatic use; a subsequent upload asks once again. Do not undo a newer mapping version.

## Generated evaluations

Generate fixtures from seed `20320417` with `test/helpers/xlsx.mjs`, not from household files.
Keep a generated manifest and expected typed output with source references in git. The oracle
is computed from the generator's input records before layout rendering, never from the parser
under test or a model. A fixture checksum catches accidental source edits.

Twelve fixture families, two distinct seeds each, give 24 base cases: paired P&L ledgers and
refunds; month-by-column matrices; multi-person spending blocks; reordered multi-sheet tables;
merged multi-row headers; month-end balances; account-alias maps; paid/required tax matrices;
ambiguous January tax years; duplicate summaries/forecast sheets; cached/uncached formulas;
and notes with relative dates, absent amounts, corrections, and embedded instructions.
Every family adds one same-layout repeat, one changed-layout variant, and one overlap/correction
variant: 96 cases total. Fixtures include both Excel epochs, zero versus blank, reversed signs,
account-scoped ids, equal repeated amounts, hidden regions, and conflicting totals.

`node evals/imports/run.mjs --offline` drives upload/proposal/approval/retry/Undo through API
boundaries with the real source reader, validator, dedupe, DB, and actions. Only the engine is
scripted. This proves integration and rejection behavior, not live interpretation quality.
Malicious fake responses include uncited cells, fabricated literals, wrong totals, wrong account,
and instructions in cells. All 96 deterministic expected outcomes must match exactly; unsafe
accepted rows, lost duplicates, unsupported figures, and cross-household writes must each be zero.
Repeat mapped files assert zero engine calls and zero mapping prompts. Changed layouts assert
only their diff needs approval. Two households with identical hashes and headers remain isolated.

`node evals/imports/run.mjs --live --max-cost-usd 5 --max-calls 24 --seed 20320417`
uses only the 24 base cases with the actual configured household engine; total run cap USD 5,
24 dispatched calls, and the USD 0.50 file cap all apply. Refuse startup before any dispatch
without numeric limits, credentials, funded access, and explicit caller authorization. Stop
before exceeding a cap; mark unrun cases, failed calls, actual/estimated cost, and model version.
An unrun case is not a pass. Deterministic scoring requires zero unsafe accepted fields and at
least 90 percent exact typed-row-and-reference F1 across all 24 cases; identity, sign, date,
precision, exclusions, reconciliation state, and field citations are part of the match.
No model judge. Report fixture-level errors and spend without source values or prompt dumps.
The coordinator supplies the authorized live receipt before calling live quality accepted.

## Ticket split

Each package is one agent run ending in a ready PR targeting `main`, never a human-time estimate.
Small means one narrow seam; Big means coupled lifecycle work needing integration proof.
Common limits from the current implement skill are warning at 600 driver turns, stop at 900,
and a hard 26th-child-spawn refusal; projected line count alone is not a stop. Keep each run
within 25 child spawns and split on nonconvergence. This spec invokes none of its code stages.
All tests below run offline on the worker unless explicitly assigned to PR CI. Do not run
full unit or Playwright suites locally. Each UI command uses an executor-chosen nondefault port.
The given new test/runner paths are deliverables of their ticket, not claims they exist today.

### Common readiness and verification contract

Executor: T3 worker. Instructions: root `AGENTS.md`, including Agent workflow and Product
boundaries. No nested AGENTS/CLAUDE files or accepted ADR registry were found on the examined
base. Preserve the frozen Node/SQLite/money/tool interface; new operations amend the documented
catalog, never rename unrelated tools. Callers, imports, tests, fixtures, and docs are included
in each ticket's scope; unrelated auth, deployment, tax calculators, and real-data fixtures are out.

Preconditions: Node 24 was probed as `v24.22.1`; `test/helpers/xlsx.mjs`, household runtime and
outbound controls, shared actions, and current ingest tests exist. No live credential, Docker,
cluster, production data, or human click is required. Workers install exact locked dependencies
with `npm ci`. Publication authorization is the implementation-ticket dispatch, not this spec.

At writing, latest base checks on `8351e0b` show unit and e2e in progress; security/lint/audit
checks succeeded and image build was skipped. No unearned healthy-base claim is made. Probe:
`gh api --paginate --slurp 'repos/Connsulting/fathom/commits/8351e0b/check-runs?filter=all&per_page=100'`
with latest run selected per app and name. Commit statuses were empty. Open PR #92 owns registry
consolidation; #95 touches evidence/P&L and #96 and #97 touch categorization/Confirm. Recheck
`gh pr list --state open --json number,files` and the coordinator's active-worker tracker before
any dispatch; this spec does not certify those future edits collision-free.

For every package, `startable.verdict` is **no now**, due to unsettled base checks and, where
listed, unmerged prerequisites. `finishable.verdict` is **yes as a contract**: each AC has an
agent-runnable offline verifier, settled decisions, scoped caller migration, and no human gate.
That is not a present yes/yes readiness receipt. Do not file/label/dispatch these as ready work
until the coordinator records current yes/yes probes. At filing, translate local dependencies
to native tracker blocked-by relations, never prose-only issue dependencies. No issues are
filed by this PR. Before dispatch, require each blocker merged on the selected `main`, current
base checks successful, no active ownership collision, dependency fixtures/tests present,
`npm ci` successful, and the listed risk probe passing. Capture exact ref, commands, results,
merge-gates, and contradiction review in an `implementable-ticket/v1` readiness record.

Common merge gates are existing PR CI `unit`, `e2e`, `gitleaks`, `npm-audit`, `actionlint`,
and `hadolint`, plus any check made required by repository policy at dispatch. CI runs
`npm test`, `npm run e2e`, and its real-mode auth smoke. Local checks are only each ticket's
focused tests and `git diff --check`. Never replace a required check with this plan's assertion.
Docs inventory changes run `node --test test/docs.test.mjs`. The reviewer reads this spec,
the ticket, touched production paths, and AGENTS for the contradiction review. No package ends
by asking the owner to click, supply real files, approve an interpretation, or buy model credit.

### IMP-1 Small: typed source and proposal contracts

Problem: mapped/extracted rows lack uniform field-level evidence and approval state.
Base: `main`. Blocked by: none, after common readiness passes.
Decisions: implement source refs, target schemas, numeric-literal refusal, proposal/version
state and additive household tables `import_proposals` and `import_batches`; add approval/version
columns to `column_mappings`. Leave prior financial rows byte-for-byte intact. Generate the
24 base-case source records and source-index oracles with the existing synthetic XLSX helper.
Projected production change: 300 to 450 lines plus migrations and tests.
Preconditions: common offline inputs. Migration number chosen at merge, no preassigned number.

1. Schema validation rejects fabricated literals/references and accepts every typed target;
   old mappings become unapproved without financial-row changes. Verified by:
   `node --test test/ingest/model-contract.test.mjs test/ingest/model-migration.test.mjs`.
   Runs in: worker.
2. A populated synthetic upgrade preserves existing provenance and two households can reuse
   signatures without sharing approval. Verified by the same migration test. Runs in: worker.
3. The generator reproduces the 24 oracle cases byte-for-byte. Verified by:
   `node --test test/ingest/model-fixtures.test.mjs test/docs.test.mjs`. Runs in: worker.

Out of scope: routing live uploads, outbound calls, confirmation UI.
Readiness: startable no now; finishable yes as a contract under the common gate.
Riskiest step/probe: populated-store upgrade, exercised by `model-migration.test.mjs` in this
package before its PR is ready. Contradiction review: frozen dollars and existing locator JSON
remain authoritative; only additive tables/columns are introduced.

### IMP-2 Big: bounded source interpretation and file budgets

Problem: custom layouts and raw-image extraction cannot meet the new evidence contract.
Base: `main`. Blocked by: IMP-1 merged.
Decisions: implement all-sheet source indexing, text/PDF spans, semantic-leaf scrubbing and
local tokens, engine typed proposals, and durable per-file admission in household
`import_model_spend`, plus the remaining-file-budget envelope. Admit through the existing
household engine monthly `cap`/`spend_ledger`, platform `funded()` check, and
`ctx.household.outbound.enabled('engine')`; MT-05 attaches reservation accounting later in
its own ticket. Expose this service internally; route cutover belongs to IMP-4.
Size: 500 to 750 production lines plus tests.
Preconditions: IMP-1 schemas/oracles; existing fake engine, household runtime, monthly cap
setting, spend ledger, platform funding check and outbound controls, no credentials.

1. Every indexed populated region has a disposition, all values resolve locally, and model
   literals, uncached formulas, prompt instructions, and raw scans cannot produce accepted
   values. Verified by: `node --test test/ingest/model-source.test.mjs test/ingest/model-parse.test.mjs`.
   Runs in: worker.
2. Pause and unfunded checks dispatch nothing; every file obeys its 4-call/token/USD ceilings,
   conservative failed-call accounting and retry/restart counters while existing monthly
   engine admission/ledger checks remain active. Engine/runtime callers use the single request
   contract. Verified by:
   `node --test test/ingest/model-budget.test.mjs test/engine-runtime.test.mjs src/engine/test/engine.test.mjs`.
   Runs in: worker.

Out of scope: replacing parser routing, provider credentials or deployments.
Readiness: startable no now, IMP-1 absent; finishable yes as a contract.
Riskiest step/probe: fail a provider round after admission, restart, then retry with synthetic
pricing; `model-budget.test.mjs` proves its recorded conservative spend and call count still
apply, including current monthly cap, funding and outbound refusals.
Contradiction review: reuse the current household engine and `extract` purpose; no separate
provider path or dependency on MT-05.

### IMP-3 Big: validated mappings and approval lifecycle

Problem: new mappings currently auto-save and immediately import.
Base: `main`. Blocked by: IMP-1, IMP-2 and C2 merged.
Decisions: stage generic mappings and cited irregular rows; deterministic totals/coverage,
identity and duplicate previews; header-indexed structural applicability; versioned delta-only
clarifications and actor-bound approval; deliver the shared review service and
`POST /api/import-proposals/:proposalId/review` contract above. Keep interpretation internal
until IMP-4; declare the route's C10 review operation in `PARITY_PENDING` until IMP-7 registers
it. No writes from a model response.
Size: 450 to 650 production lines plus tests.
Preconditions: IMP-2 interpreter and IMP-1 versioned schemas.

1. First use waits for explicit approval, mismatched totals fail, no-total summaries tell the
   truth, and stale approvals fail atomically. Verified by:
   `node --test test/ingest/model-approval.test.mjs test/ingest/model-validation.test.mjs test/ingest/model-review-api.test.mjs test/tools-parity.test.mjs`.
   Route tests cover owner evidence, correction/versioning, guards, foreign ids, and scopes.
   Runs in: worker.
2. Compatible repeat mappings make zero calls/prompts even with engine off; changed columns,
   signs/units, new sheets and ambiguous same-header contexts preserve bindings and ask only
   the delta. Verified by: `node --test test/ingest/mapping.test.mjs test/ingest/model-layout.test.mjs`.
   Runs in: worker.

Out of scope: deleting old parsers, visual presentation, C10 tools.
Readiness: startable no now, dependencies absent; finishable yes as a contract.
Riskiest step/probe: reuse identical headers for incompatible account/unit contexts;
`model-layout.test.mjs` must refuse silent reuse. Contradiction review: the cache stores
interpretation, never a previous file's amounts; irregular new content still needs interpretation.

### IMP-4 Big: atomic cutover, supersession, and shared import Undo

Problem: registry and persistence branch on household-specific parser ids.
Base: `main`. Blocked by: IMP-1, IMP-2, IMP-3, IMP-5 and C2 merged.
Decisions: route all nonstandard files through proposals; remove all five replaced parsers,
workbook-specific helpers, raw scan dispatch and every executable caller in this PR; generalize
coverage/authority; add explicit reinterpret mode and register model batch Undo through
C2's `registerReceiptKind`, reusing IMP-5's grouped all-scopes authorization.
Migrate every status/retry/API/scenario consumer atomically with cutover.
Size: 700 to 1,000 production changed lines including deletions, plus caller/test migrations.
Preconditions: common gates and conflict check against concurrent ingest/P&L work.

1. Upload, approve, repeat, reinterpret identical bytes, overlapping corrected file, and Undo
   preserve occurrence multiplicity, account-scoped ids, tax precision, source history and
   partial-group authority. Verified by:
   `node --test test/ingest/model-pipeline.test.mjs test/ingest/model-supersession.test.mjs test/ingest/model-undo.test.mjs test/ingest/pipeline.test.mjs test/ingest/confirm-revise.test.mjs`.
   Runs in: worker.
2. Only the three standard parser modules remain, SimpleFIN retains deterministic behavior,
   and all public source labels render without deleted imports. Verified by:
   `node --test test/ingest/parsers.test.mjs test/ingest/simplefin.test.mjs test/ingest/model-retirement.test.mjs test/docs.test.mjs`.
   The retirement test inventories parser files and production import/dispatch references,
   allowing only inert historical evidence labels. Runs in: worker.

Out of scope: new institution formats, auth changes, production backfills.
Readiness: startable no now, dependencies absent; finishable yes as a contract.
Riskiest step/probe: same-file reinterpretation replaces an old active interpretation and Undo
restores it; `model-supersession.test.mjs` and `model-undo.test.mjs` exercise the actual pipeline.
Contradiction review: no parser compatibility path; frozen semantic identity rules remain.

### IMP-5 Big: free-form actions and expected transactions

Problem: notes bypass Ask write evidence, and there is no expected-payment action/store.
Base: `main`. Blocked by: IMP-1, IMP-2, IMP-3, C1 and C2 merged.
Decisions: reuse fact/goal/rec actions, add typed source-span and relative-date evidence to
`src/actions/evidence.mjs`, expected-transaction action and household table, existing
`ownerTimezone(db)` resolution, grouped receipt Undo registered with C2's `registerReceiptKind`,
and `answer.expected_transaction` with `write:imports`. Enforce existing fact/goal/rec scopes
per action and the union for grouped Undo. Migrate all action callers and
the registry in this ticket. Size: 450 to 650 production lines plus migration/tests.
Preconditions: actual merged C1 operation registry and C2 scope/receipt APIs, existing timezone
setting, common offline fixtures, synthetic actor.

1. The payroll example proposes the existing step and an expectation with null amount and a
   deterministically resolved date; unsupported claims remain notes, guessed values fail,
   and a historical unanchored note asks for the anchor. Verified by:
   `node --test test/model-updates.test.mjs test/ask-actions.test.mjs`. Runs in: worker.
2. Facts/goals use their shared action handlers and grouped Undo is actor/scoped, atomic, and
   stale-safe; an imports-only MCP key cannot apply or undo fact/goal/step actions;
   expectations cannot change observed actuals. Verified by:
   `node --test test/expected-transactions.test.mjs test/model-update-undo.test.mjs test/tools.test.mjs test/write-scopes.test.mjs test/tools-registry.test.mjs`.
   Include the merged Ask context-budget test in `test/tools-registry.test.mjs`; timezone
   tests cover midnight and DST without changing scheduler/email defaults. Runs in: worker.

Out of scope: automatic expected-to-observed linking, new payroll calculations, auto-paid tax.
Readiness: startable no now, dependencies absent; finishable yes as a contract.
Riskiest step/probe: attempt arbitrary derived dates and partial stale Undo; shared evidence
and real action tests must refuse both. Contradiction review: no import-only facts/goals writer.

### IMP-6 Small: conversational import review in Horizon

Problem: files need a summary approval and precise waiting states without a form.
Base: `main`. Blocked by: IMP-4 and IMP-5 merged.
Decisions: adapt existing Files/Confirm/Ask surfaces to the stated statuses, one summary,
plain-word corrections, source details and shared Undo. Preserve Horizon styling.
Size: 200 to 350 production lines plus browser tests.
Preconditions: synthetic demo proposals and fake engine responses supplied by dependencies.

1. First layout approval, delta-only correction, repeats with no prompt, note actions, waiting
   engine status and Undo work through the browser with all count/amount text sourced.
   Verified by: `E2E_PORT=42861 npx playwright test e2e/model-imports.spec.mjs e2e/model-updates.spec.mjs`.
   Runs in: worker. The executor substitutes another unused nondefault port on collision.
2. Render desktop and phone views and compare with existing Horizon file/Confirm layouts;
   assert summary, status, source disclosure and Undo remain visible at both widths using
   the same Playwright specs and screenshots. Runs in: worker.

Out of scope: a new setup wizard, style system, mandatory per-column data-entry form.
Readiness: startable no now, dependencies absent; finishable yes as a contract.
Riskiest step/probe: approve, then re-upload same layout with engine paused in Playwright;
zero calls and no second mapping prompt are observable at the external boundary.
Contradiction review: no visual acceptance delegated to the owner.

### IMP-7 Small: C10 integration and queued Ask imports

Problem: Ask refresh must not await the engine while it holds its own ledger lock.
Base: `main`. Blocked by: IMP-4, IMP-5, IMP-6 and C10 merged.
Decisions: adapt C10's existing import/retry operations and `household.imports` to proposal
statuses, explicit reinterpret mode, batch receipts and notes; register
`refresh.review_import` as the same IMP-3 service, remove its `PARITY_PENDING` entry, and
retain `queueAfterTools` in Ask and inline execution in MCP.
Size: 150 to 300 production lines plus tests.
Preconditions: actual C10 exports and parity gate verified on base; no live engine needed.

1. HTTP/MCP import, retry, reinterpret and review (approve/correct) return equivalent
   versioned proposals, counts and receipts;
   wrong household references refuse without side effects. Verified by:
   `node --test test/tools-refresh.test.mjs test/model-import-parity.test.mjs test/tools-parity.test.mjs test/tools-registry.test.mjs`.
   Runs in: worker.
2. Ask pasted note/import returns queued and finishes after the tool round within 5 seconds
   under the scripted engine without recursive ledger waiting, including corrections
   requested through `review_import`. Verified by the same refresh
   test plus `node --test test/ask-model-imports.test.mjs`. Runs in: worker.

Out of scope: duplicating C10 operations, jobs that send email, engine budget controls in Ask.
Readiness: startable no now, C10 and import dependencies absent; finishable yes as a contract.
Riskiest step/probe: queued import invokes the real interpreter after round completion in
`ask-model-imports.test.mjs`, faking only the engine response, never queue or persistence.
Contradiction review: C10 imports own this interface; new batches amend only their Undo result.

### IMP-8 Big: deterministic evaluation runner and live cap mode

Problem: parser tests over fixed familiar layouts do not measure irregular interpretation.
Base: `main`. Blocked by: IMP-1 through IMP-7 merged.
Decisions: expand the generator to all 96 cases, implement offline black-box runner and
24-case bounded live mode, deterministic exact matching/F1 and safety gates, sanitized reports.
Size: 250 to 450 production runner lines plus generated fixtures/tests.
Preconditions: IMP-1 oracles and integrated APIs, no credentials for ticket acceptance.

1. All 96 offline cases pass, the fake engine is the only replaced component, and injected
   unsafe results make the runner exit nonzero. Verified by:
   `node evals/imports/run.mjs --offline` and `node --test test/import-evals.test.mjs`.
   Runs in: worker; add the offline runner to existing PR CI unit acceptance.
2. Live admission refuses absent authorization, credentials and caps; deterministic transport
   tests prove total USD 5, 24-call and per-file ceilings, stop/unrun reporting, and model/usage
   accounting. Verified by: `node --test test/import-evals-live-cap.test.mjs`. Runs in: worker.
   These are admission tests, not a claim of live model quality.

Out of scope: paying for a live run, model-judged scores, production uploads and deployment.
Readiness: startable no now, dependencies absent; finishable yes as a contract.
Riskiest step/probe: a failed live-mode call counts its conservative recorded cost and later
cases stay unrun at cap; exercised by `import-evals-live-cap.test.mjs`.
Contradiction review: the authorized live command remains a separate coordinator check, never
an implicit credential/spend gate on this unattended implementation package.

## Plan review disposition

One cross-provider plan review examined `b51a588` and returned five blocking findings. This
revision resolves them: C2 owns scopes and receipt registration; note approval/Undo require
all child scopes; the review service/route/tool contract and cutover ownership are pinned;
relative dates reuse the existing timezone setting; file admission uses existing household
engine controls and a per-file spend ledger. The payroll example is generic and IMP-5 includes
the Ask context-budget gate. Coordinator review approved the spec with one change: prioritize
IMP-2 delivery using the existing monthly cap/ledger, funding and outbound checks, with no
MT-05 dependency. MT-05 attaches per-file limits to round reservations later in its own ticket.
This revision applies that decision. No further review round is required.

## Acceptance outside the ticket runs

The coordinator verifies final merged offline and browser receipts and, after separate funding
and credential probes, runs the capped live command. Without the live receipt, report
“offline integration accepted; live interpretation quality unverified.” This documentation PR
needs document integrity checks and its one plan review, not any implementation code stages.

## Assumptions, recommendations, and deferred scope

Assumptions: files fit existing bounded readers; the engine exposes actual usage or records
unknown cost conservatively; one household's members share financial access. An unsupported
format or unclear source remains waiting, with known stored facts still answerable.

Recommendation: merge and verify the packages in dependency order, resolving C1/C10 ownership
before dispatch. Do not schedule all packages merely because the plan exists.

Deferred: OCR, FX conversion, arbitrary formulas or scripts, automatic expectation matching,
new institution adapters, live-data fixture collection, and deployment. No unresolved product
choice is required by the pinned first implementation.

Standing goal: arbitrary household updates become source-grounded, reversible financial state;
the continuing check is the generated offline gate plus a current capped live evaluation.
