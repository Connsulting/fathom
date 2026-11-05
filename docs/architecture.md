# Fathom architecture

This is the architecture every build item works against. The first part is frozen: change it only
by agreement across items. The second part describes what the foundation item built (store,
tables, API, seams) and is updated by each item that extends it.

## Frozen architecture

### 1. Stack

Node 24 ESM (`.mjs`), no TypeScript, no frontend build step. SQLite through the built-in
`node:sqlite` (`DatabaseSync`). Minimal dependencies, all exact pins in `package.json`: the engine runtime uses the Anthropic and
MCP SDKs and Ajv, and `@playwright/test` is the dev dependency. Unit tests run with `node --test`
over every module's test directory (`npm test`), end-to-end tests with Playwright.

### 2. Layout

| Path | Owner and purpose |
|---|---|
| `package.json` | Scripts `start`, `test`, `seed:demo`, `e2e`, `e2e:smoke` (names are frozen). |
| `src/server.mjs` | HTTP entry: store mode rules, then serves the UI, `/shared/` and the API. |
| `src/config.mjs` | `loadConfig(env)`: every environment key, paths only. |
| `src/store/` | `db.mjs` plus `migrations/NNN-name.sql`. Owned by the foundation item. |
| `src/scenario/build.mjs` | Store to CONTRACT.md scenario object (`buildScenario`). |
| `src/api/` | Router, handlers, HTTP guards, static serving, the live answerer and its fake answer source. |
| `src/shared/` | Browser-safe logic used by the server and the UI (`rules.mjs`, `tokens.mjs`). |
| `src/tools/` | Tool registry shared by the chat engine and the MCP server. |
| `src/calc/` | Deterministic calculators (tax, payroll, retirement room, cash). |
| `src/ingest/`, `src/ingest/parsers/` | File ingest pipeline and one parser per source format. |
| `src/engine/` | Engine gateway (model calls, on/off, spend cap). |
| `src/packs/` | Knowledge pack loading and activation. |
| `src/mcp/` | MCP server over the tool registry. |
| `src/jobs/` | In-process scheduler and proactive jobs. |
| `src/email/` | Monthly email rendering and transports. |
| `web/` | The Horizon UI (`index.html`, `core/core.js`, `horizon/design.js`, `horizon/design.css`). |
| `demo/` | Synthetic demo scenario, seed and ledger. |
| `packs/<id>/` | Pack content. |
| `e2e/` | Playwright specs. |
| `Dockerfile` | The one image. |
| `docs/architecture.md` | This file. |

`mock-v2/` stays untouched as the design reference.

### 3. Money

Money is a JS number in dollars rounded to cents everywhere: `Math.round(x * 100) / 100` on every
write (`cents()` in `src/store/db.mjs`). Store columns are `REAL`. Display formatting lives in
`src/shared/tokens.mjs` (`money(n, {k, sign, cents})`). The model never states a number it did not
get from a calculator or from stored data, and every displayed figure carries its provenance.

### 4. UI

`web/` keeps the mock's `api` surface (CONTRACT.md "Core API") so the Horizon design changes
minimally. Data comes from `GET /api/scenario` (the CONTRACT.md scenario shape plus `live`) and
actions POST to the API; each action response carries the fresh scenario. There is no review
harness bar in the product. The demo build is a synthetic store seeded to the November state.

### 5. Facts

A store table of `{key, value JSON, src, asOf, confirmed}` (table `facts`, with provenance
columns). Frozen fact keys:

| Key | Type |
|---|---|
| `household.state` | string, for example "VA" |
| `household.filingStatus` | string: "mfj", "single", ... |
| `household.dependents` | int |
| `household.expectingChild` | bool |
| `household.dependentAges` | int[] |
| `income.w2` | bool |
| `income.sCorp` | bool |
| `income.selfEmployed` | bool |
| `income.partnership` | bool |
| `income.agiEstimate` | number |
| `benefits.hsa` | bool |
| `benefits.employer401k` | bool |
| `retirement.solo401k` | bool |
| `retirement.ira` | bool |
| `retirement.backdoorRothCandidate` | bool |
| `accounts.has529` | bool |
| `giving.charitable` | bool |
| `giving.annualEstimate` | number |

New keys may be added, never renamed.

### 6. Pack manifest

`packs/<id>/manifest.json`:

```
{ id, name, version, taxYear, reviewed: "YYYY-MM-DD", curator, covers: [...],
  appliesWhen: Rule, suggestWhen?: Rule, whatIf: { prompt },
  entries: [ { file, title, cites: [ { label, url } ] } ] }
```

Rule grammar:

```
Rule = { all: [Rule] } | { any: [Rule] } | { not: Rule }
     | { fact, op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'in'|'exists', value? }
```

`src/packs` exports `loadPacks(dirs[])`, `evaluate(rule, facts)`, `activePacks(packs, facts)`
returning `[{pack, status: 'active'|'suggested'|'available', why}]`, and `packContext(active)`
returning a stable string for prompt caching. A private "Your plans" pack lives in the data volume
at `$FATHOM_DATA/packs/your-plans/` in the same format.

### 7. Parser interface

`src/ingest/parsers/<id>.mjs` exports `{id, label, sourceKind, sniff(file) -> 0..1,
parse(file) -> {rows, warnings, period: {from, to}}}` where `file = {name, bytes: Uint8Array, mime}`.

`sourceKind` is one of `bank_csv`, `card_csv`, `aggregator_csv`, `brokerage_positions`,
`pnl_workbook`, `tax_payments`, `balances`, `paystub`, `tax_doc`, `statement`, `notes`, `other`.

Row kinds:

| Kind | Fields | Store table |
|---|---|---|
| transaction | `account: {inst, mask, name?, kind?}, date, amount, description, category?, externalId?` | `transactions` |
| balance | `account, date, amount` | `balances` |
| position | `account, asOf, symbol, name, quantity, price, value, costBasis?` | `positions` |
| pnl_line | `entity, period: 'YYYY-MM', category, amount` | `pnl_lines` |
| tax_payment | `jurisdiction, taxYear, date, amount, kind` | `tax_payments` |
| document | `docType, taxYear?, fields` | `documents` |
| fact | `key, value` | `facts` |

Each row carries a `locator` (row number or cell) from the parser; the pipeline adds
`{fileId, parser}`, stored as the `file_id`, `parser` and `locator` provenance columns.
`src/ingest/dedupe.mjs` exports `dedupeKey(row)` (stored in `transactions.dedupe_key`, unique).
Account masks are the last 4 digits only; full account numbers are never stored (a CHECK
constraint on `accounts.mask` enforces exactly four digits or NULL).

### 8. Tool interface

Shared by the chat engine and the MCP server. `src/tools/index.mjs` exports `tools`, a registry
of `{name, description, inputSchema (JSON Schema), scope: 'read'|'write:recs', handler(args, ctx)}`
with `ctx = {db, now}`, plus `getTool(name)`, `callTool(name, args, ctx)` (validates args against
`inputSchema`) and `ToolError` with `code` `'bad_input'` or `'not_found'`. The only write scope is
recommendation status.

| Tool | Scope | Input | Output |
|---|---|---|---|
| `household_summary` | read | none | `{facts, verdictLevel, needsYouCount, statusCounts, dataThrough, clock}` |
| `get_facts` | read | `keys?: string[]` | `[{key, value, src, asOf, confirmed}]` |
| `list_accounts` | read | none | `[{id, inst, mask, name, owner, kind, mirror, note, balance, asOf}]` |
| `query_transactions` | read | `accountId?, from?, to?, minAmount?, maxAmount?, category?, text?, limit? (1..200, default 50)` | `{rows: [{id, accountId, date, amount, description, category}], truncated, total}` |
| `list_positions` | read | `accountId?` | `[{accountId, symbol, name, quantity, price, value, costBasis, asOf}]` |
| `pnl_by_month` | read | `entity?, from?: 'YYYY-MM', to?` | `{rows: [{period, category, amount}], totals: {period: n}}` |
| `list_recommendations` | read | `status?: string or string[]` | live recs, never hidden |
| `get_recommendation` | read | `id` | the live rec |
| `list_deadlines` | read | `from?, to?` | `[{date, label, title, recId, hard}]` sorted by date |
| `list_goals` | read | none | goals |
| `get_figures` | read | `keys?: string[]` | `[{key, v, kind, label, source: {id, label, asOf}}]` |
| `packs_status` | read | none | `[{id, name, status, why}]` |
| `set_recommendation_status` | write:recs | `id, status: accepted, doing, done, dismissed, snoozed or proposed, wake?` | the rec; writes `rec_events` with actor `tool` |

Tool outputs resolve scenario tokens to plain text and expose masks only.

`src/engine/tools.mjs` `createRegistryServer` consumes this registry. Input schemas must compile
under strict Ajv, so no union types (`type` arrays); use `anyOf`. `ctx.now` may be a Date, an ISO
string or epoch ms, and the store clock decides "today" when set.

### 9. Engine gateway

`src/engine` exports `createEngine({mode: 'live'|'fake'|'off', ledger, capUsd, credential})` with
`call({purpose: 'chat'|'job'|'extract', system, messages, tools?, maxTokens})` and a chat runner on
the Claude Agent SDK. It checks on/off and month-to-date spend below the cap BEFORE every model
call (throws `EngineOffError` or `BudgetExceededError`) and records cost to the ledger after.
Ledger adapter: `{monthSpendUsd(yyyymm), record({ts, purpose, costUsd, model, tokens})}` over the
`spend_ledger` table (`yyyymm` stored as `'YYYY-MM'`). Default cap 200 USD (`settings.cap`).
`FATHOM_ENGINE=fake` in tests.

### 10. Config

Read from the environment by `src/config.mjs` (`loadConfig(env = process.env)`); paths only, no
secrets are read there.

| Key | Default | Meaning |
|---|---|---|
| `FATHOM_DATA` | `./data` (gitignored) | Data directory; holds `fathom.sqlite`. |
| `FATHOM_PORT` | `8080` | HTTP port. |
| `FATHOM_HOST` | `127.0.0.1` (the image sets `0.0.0.0`) | Bind address. |
| `FATHOM_DEMO` | unset (auto) | `1` demo store required, `0` real store required, unset follows the store (a new store is demo). |
| `FATHOM_ENGINE` | `fake`, or `off` when `FATHOM_DEMO=0` | `live`, `fake` or `off`. |
| `FATHOM_CLOCK` | unset | ISO date that overrides "today" (`settings.clock`) for demos and tests. Never written to the store. |
| `FATHOM_CLAUDE_CREDENTIAL_FILE` | unset | Path to the mounted Claude credential. |
| `FATHOM_DATA_KEY_FILE` | unset | Path to the raw file encryption key. |
| `FATHOM_EMAIL_TRANSPORT` | `dev` | `dev`, `gmail`, `resend` or `postmark`. |

## Store

`src/store/db.mjs` exports `openDb(path)` (WAL, foreign keys on, busy timeout 5000 ms),
`migrate(db)` returning `{applied: [ids]}`, `listTables(db)`, `getSetting(db, key, fallback)`,
`setSetting(db, key, value)` (JSON values), `MIGRATIONS_DIR`, `tx(db, fn)`, `cents(n)`,
`readStoreMode(file)` and `createStoreFile(file, init)`. The store is the source of truth for all
live state. All SQL uses prepared statements with bound parameters.

### Store mode rules

The store's mode is recorded once, at creation, in `settings.mode` (`'demo'` or `'real'`); it is
never inferred from what the store contains.

1. No `fathom.sqlite` in `FATHOM_DATA`: the server creates it (built in a temporary file and
   renamed into place). The mode is `demo` and the demo is seeded, unless `FATHOM_DEMO=0`, in
   which case the mode is `real` and the scenario is empty but valid.
2. The file exists: its mode is read without changing it. A file with no mode row (for example
   created by another tool) is `real`. `FATHOM_DEMO=1` against a real store and `FATHOM_DEMO=0`
   against a demo store both refuse to start with a clear error and leave the file unchanged.
3. A demo store is never reseeded on restart: its state persists.
4. `npm run seed:demo` rebuilds a demo store or creates a missing one, and refuses a real store
   (exit 1, data untouched). `POST /api/demo/reset` does the same rebuild in place and is a 404
   unless the store's mode is `demo`.
5. Real household data lives only in the data volume, never in the repository.

### Tables

Money columns are dollars rounded to cents; JSON columns hold JSON text. The provenance columns
`file_id` (references `files.id`), `parser` and `locator` are on every data-derived table:
`accounts`, `transactions`, `balances`, `positions`, `pnl_lines`, `tax_payments`, `documents`,
`facts`, `figures` (and `recs`).

| Table | Columns |
|---|---|
| `schema_migrations` | `id` PK, `name`, `applied_at` |
| `settings` | `key` PK, `value` JSON, `updated_at`. Keys: `mode`, `engine` `{on}`, `cap` `{usd}` (default 200), `clock`, `onboarding` `{done, step}`, `wargame.picks` `{salary, deferral}`, `seeded` `{at, scenario_sha}`, `packs.generation` (integer, bumped by every Your plans build), `yourPlans` `{builtAt, entries, sources: [file names]}` (the last build) |
| `content` | `key` PK, `value` JSON, `src`, `updated_at`. Narrative sections with no data table yet: `meta` (product, household, dataThrough), `names`, `law`, `pct`, `series`, `verdict`, `domains`, `curve`, `wargame`, `ask`, `advisor`, `yearend`, `connect`, `engine.chat`, `onboarding`, `email` |
| `files` | `id` PK, `name`, `mime`, `size`, `sha256`, `source_kind`, `uploaded_at`, `stored_path`, `status`, `note` |
| `sources` | `id` PK, `label`, `as_of`, `kind`, `last_ingest_at`, `note` |
| `facts` | `key` PK, `value` JSON, `src`, `as_of`, `confirmed`, provenance, `updated_at` |
| `accounts` | `id` PK, `inst`, `mask` (4 digits or NULL), `name`, `owner`, `kind`, `mirror`, `note`, `fig_key`, provenance, `sort` |
| `transactions` | `id` PK, `account_id`, `date`, `amount`, `description`, `category`, `external_id`, `dedupe_key` unique, provenance |
| `balances` | `id` PK, `account_id`, `date`, `amount`, provenance; unique (`account_id`, `date`) |
| `positions` | `id` PK, `account_id`, `as_of`, `symbol`, `name`, `quantity`, `price`, `value`, `cost_basis`, provenance |
| `pnl_lines` | `id` PK, `entity`, `period` `'YYYY-MM'`, `category`, `amount`, provenance |
| `tax_payments` | `id` PK, `jurisdiction`, `tax_year`, `date`, `amount`, `kind`, provenance |
| `documents` | `id` PK, `doc_type`, `tax_year`, `fields` JSON, provenance |
| `figures` | `key` PK, `v`, `src` (references `sources.id`), `kind` in a, p, e, m, `label`, provenance, `updated_at` |
| `recs` | `id` PK, `def` JSON (the CONTRACT rec minus live fields), `status`, `waiting_on`, `wake`, `tasks_done` JSON, `window_close` ISO date, `window_label`, `pack_id`, `sort`, `updated_at`, provenance |
| `rec_events` | `id` PK, `rec_id`, `ts`, `action`, `arg`, `from_status`, `to_status`, `actor` (`ui`, `tool`, ...) |
| `conversations` | `key` PK (`ask`, a rec id, or `pack:<id>`), `created_at` |
| `messages` | `id` PK, `conversation_key`, `role` in me, fathom, advisor, claude, `text` (token-bearing HTML), `refs` JSON, `notice`, `ts`, `provenance` JSON or NULL (migration 002; see "Answer provenance") |
| `goals` | `id` PK, `def` JSON, `sort` |
| `deadlines` | `id` PK, `date`, `label`, `title`, `rec_id`, `hard` |
| `events` | `id` PK, `date` (label as in the scenario), `kind`, `title`, `body`, `sort` |
| `packs_state` | `id` PK, `def` JSON (the pack with its base status; manifest-backed rows carry `def.manifest`, and optionally `def.label`), `active` (NULL means no override), `exploring`, `what_if_asked`, `what_if_done`, `unhid` JSON, `sort`, `updated_at` |
| `decisions` | `id` PK, `title`, `status` in open, decided, upcoming, `wargame`, `rec_id`, `opens_on`, `when_label`, `note`, `decided_line`, `sort` |
| `jobs` | `id` PK, `name`, `cadence`, `does`, `cost`, `next_label`, `last_label`, `enabled`, `sort` |
| `job_runs` | `id` PK, `job_id`, `started_at`, `finished_at`, `status`, `cost_usd`, `note` |
| `api_keys` | `id` PK, `name`, `key_hash`, `scopes` JSON, `created_at`, `last_used_at`, `revoked_at` |
| `spend_ledger` | `id` PK, `ts`, `yyyymm` `'YYYY-MM'`, `purpose`, `cost_usd` (rounded up to whole cents on write), `model`, `tokens` JSON (usage counts only, never prompt text) |

### Adding a migration

1. Add `src/store/migrations/NNN-name.sql` with the next number (three digits, no gaps, lowercase
   name with dashes). Never edit a migration that has shipped.
2. Write plain SQL. `migrate()` runs each file once, in numeric order, inside its own transaction,
   and records it in `schema_migrations`; a failure rolls that file back and stops startup.
3. `GET /healthz` reports the latest applied id as `schema`.
4. Add the new tables and columns to the table list above (`test/docs.test.mjs` checks every table
   is named here) and, if the demo should populate them, extend `demo/seed.mjs` (its clear order
   lists children before parents).

## Scenario builder

`buildScenario(db, {clock})` in `src/scenario/build.mjs` returns the CONTRACT.md scenario with
live state merged in, plus `live`. It only reads.

1. Clock: `clock` (from `FATHOM_CLOCK`) overrides `settings.clock`; otherwise today is the current
   UTC date. `meta.clock` and `meta.clockLabel` (for example "Tue, Jan 5, 2027") come from it.
2. Recs: `rec.status`, `rec.wake`, `rec.waitingOn` and `rec.tasks[].done` are live. Windows are
   stored as a close date plus label; `window.days` is the close date minus the clock in whole days.
   Hidden recs are included with status `hidden`; the UI and tools never list them. There is no
   `statusByDemo` in the output (the seed resolves it for November).
3. Packs: `packs[].status` is the base status from the pack definition and `live.packs[id]` carries
   the overrides. The client computes the CONTRACT `api.packs()` status from both, exactly as the
   mock does (`packStatus()` in `src/shared/rules.mjs`): active when `live.active` (or, when it is
   null, the base status is active), else exploring after a what-if, else available for a base
   active pack turned off, else the base status.
4. Decide: per decision the builder returns the derived `status` and an explanation `line` ('' for
   open and upcoming ones). A stored decided decision keeps `decided_line`, else its war game's
   stored `decided` text, else "when. note". An open or upcoming decision whose linked rec is done
   reads decided with "Marked done on your plan.", and one whose rec is dismissed reads "Set aside
   on your plan.". An upcoming decision with `opens_on` on or before the clock reads open; one with
   no `opens_on` is dependency driven and stays upcoming. War-game status: open if any decision
   naming it is open, else decided if any is decided, else upcoming. War-game `decided` is the
   stored text when a stored decided decision names it, else the line of the first derived decided
   decision.
5. Engine: `mode` is the configured `FATHOM_ENGINE` mode (`live`, `fake` or `off`; the API passes
   `config.engine` as `buildScenario(db, {clock, engineMode})`, null when not given), so the Engine
   screen shows "Off in configuration" and Paused when the mode is off even with the switch on;
   `budget.monthly` is `settings.cap.usd` (default 200); `budget.used` is the sum of
   `spend_ledger.cost_usd` for the clock's month; jobs come from `jobs`; `chat` from content;
   `ledger` is the latest 8 spend rows, newest first, as `[{id, ts, purpose, model, cost}]` (`ts`
   a display label, no token or prompt fields).
6. Derived provenance figures, registered at build time and never stored:
   `wg.salary.<pointId>.x|y` and `wg.deferral.<optionId>.amount|tax2026|tax2027|net|decCash|need|gap`
   (kind m, source `wargame-model`, "War-game model, from your plan");
   `series.<key>.<index>` (the point's kind, source the series `src` or `plan`);
   `engine.budget.used` (a, `spend-ledger`), `engine.budget.monthly` (p, `settings`),
   `engine.budget.left` (e, `spend-ledger`), `engine.job.<jobId>.cost` (e, `job-estimates`,
   "Per-run cost estimate") and `engine.ledger.<id>.cost` (a, `spend-ledger`, label
   `<purpose>, <ts label>`) for each listed ledger row. Built-in sources cover these ids when the
   store has no row for them.

### The `live` key

```
live = {
  mode: 'demo' | 'real',
  demo: 'november' | 'fresh',          // 'fresh' while onboarding is not done; the UI forces onboarding
  engine: boolean,                      // settings.engine.on, default true
  onboardStep: int,
  picks: { salary: int, deferral: int },  // war-game selections; default the current/recommended point
  conversations: { <key>: [ { id, role, text, refs, ts, notice, provenance } ] },
  packs: { <id>: { active: boolean | null, exploring: boolean, whatIfDone: boolean } },
  yourPlans: { sources: [ { fileId, name, docType } ], files: [ { id, name } ], built: settings.yourPlans | null },
  clock: 'YYYY-MM-DD'
}
```

`yourPlans.sources` are the plan and benefits documents (a text-only document row is named
`document-<id>` with `fileId` null); `files` are the stored files a build can read (text or PDF).

Conversation keys are `ask`, a rec id, or `pack:<id>`; `ask` is always present. Message `id` is a
string (`m<rowid>`), `text` is token-bearing HTML source (paragraphs as `<p>...</p>`; resolve it
with `api.t` at read time), `refs` are rec ids, `ts` is a display label such as "Nov 5, 9:04 AM",
`notice` is true for every notice the answerer stores instead of an answer (engine off, off by
configuration, over the cap, model error). `provenance` is the stored answer provenance or null
(owner messages, notices and seeded messages). The demo seed opens each rec conversation with one
fathom message holding its summary.

## API

All JSON. Every POST requires `content-type: application/json` (charset allowed), else 415; when an
`Origin` header is present its host must equal the `Host` header, else 403; bodies are capped at
64 KiB (413); malformed JSON or a non-object body is 400. Errors are `{error: '<message>'}`. Unknown
paths under `/api` are a JSON 404 and a known path with the wrong method is 405. Every action
response is `{scenario, ...}` with the fresh scenario.

| Method and path | Body | Response |
|---|---|---|
| `GET /healthz` | | `{ok: true, schema: <latest migration id>}` |
| `GET /api/scenario` | | the scenario with `live` |
| `POST /api/recs/:id/action` | `{action: accept, start, snooze, dismiss, complete, reopen or task, arg?}` | `{scenario}`. `task` toggles task `arg`; `snooze` takes a wake label (default "Next month"). 400 bad action or task index, 404 unknown or hidden rec. Writes `rec_events` (actor `ui`). |
| `POST /api/wargame/:name/pick` | `{index}` (an index or an option id) | `{scenario}`. `name` is salary or deferral (404 otherwise); 400 out of range. |
| `POST /api/packs/:id/toggle` | `{}` | `{scenario, status, note}`. Turning a pack on lifts its hidden recs to proposed; turning it off hides again only the recs it lifted that no other active pack powers. `note` is "Recommendations update on the next planning run." |
| `POST /api/packs/:id/whatif` | `{}` | `{scenario}`. Marks the pack exploring and appends the pack's what-if prompt and a live answer (with provenance) once to `pack:<id>`. A manifest-backed pack's prompt is literal text, stored escaped like free text (`whatIfOwnerText`); an illustrative demo prompt keeps its token form; a notice reply (engine off, over the cap, model error) is appended once and does not mark it done. |
| `GET /api/packs/:id/entries/:entryId` | | `{entry: {id, title, body, cites}}` for an entry of a manifest-backed pack row, from the loaded packs; 404 otherwise. |
| `POST /api/engine` | `{on: boolean}` | `{scenario}`; 400 when `on` is not boolean. |
| `POST /api/engine/cap` | `{usd}` | `{scenario}`. `usd` a finite number from 0 to 10000, rounded to cents and stored as `settings.cap`; anything else 400. |
| `POST /api/ask` | `{key?: 'ask', a rec id or 'pack:<id>', questionId? or text?}` | `{scenario, message}`. Exactly one of `questionId` or `text`; empty text, both or neither are 400; unknown question or conversation 404. Appends the owner's message and the live answer with its provenance, or a notice. |
| `POST /api/your-plans/build` | `{fileIds?: string[]}` (at most 50) | `{scenario, result: {written, entries, sources, warnings, dropped}}`. Builds the Your plans pack (`dropped` counts the extracted sections that did not match their document); 400 for a bad body; 409 while the engine is off, over the cap, or when the data directory is inside the repository. |
| `POST /api/onboarding` | `{step}` | `{scenario}`. 0 to 5 set the step, 6 completes onboarding; anything else 400. |
| `POST /api/demo/reset` | `{}` | `{scenario}`. Rebuilds the demo store; 404 unless the store is a demo store. |

Free text is stored HTML-escaped with `{` and `}` escaped as `&#123;` and `&#125;`, so a user can
never inject a scenario token or markup.

### Static files and headers

`web/` is served at `/` and `src/shared/` at `/shared/`. Paths resolve inside those directories
only: any `.` or `..` segment (raw or percent-encoded), dotfile, backslash or symlink escape is a
404. Unknown extensionless paths fall back to `web/index.html`. Every response sets
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and this
CSP: `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com;
style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
API responses also set `Cache-Control: no-store`. There is no authentication in this item: the app
is reachable only on the owner's private network.

## Seams later items plug into

1. Answerer: `src/api/answerer.mjs` exports `createLiveAnswerer({engine, packs})` returning
   `{answer({db, key, questionId?, text?, clock?}), whatIf({db, packId, clock?})}`, each resolving to
   `{paragraphs, refs, notice?, provenance?}` (`answer` is null for an unknown `questionId`).
   `src/server.mjs` constructs it and the router passes it to handlers as `ctx.answerer`. Every Ask,
   rec conversation, pack follow-up and What if goes through it; the ask endpoint words the owner's
   question itself from `src/api/questions.mjs`. See "Chat over the data" below.
2. Packs: `src/packs/state.mjs` replaces the manifest-backed `packs_state.def` rows with loaded
   manifests and sets the base status from `activePacks(packs, facts)`; overrides in `packs_state`
   keep working. See "Live pack state" below.
3. Ingest: parsers write rows with provenance into the ledger tables, `facts` and `files`; figures
   and sources follow from them. Narrative `content` rows are replaced as data takes over.
4. Engine: `src/engine` records spend in `spend_ledger`, which already feeds `engine.budget.used`,
   and reads the cap from `settings.cap`. See "Runtime engine" below.
5. MCP: `src/mcp` exposes `src/tools` with scopes checked against `api_keys`.
6. Jobs: `src/jobs` schedules from `jobs` and records `job_runs`.
7. Email: `src/email` renders the `email` content (later derived) through `FATHOM_EMAIL_TRANSPORT`.

## Runtime engine

`src/engine/runtime.mjs` exports `createSpendLedger(db)` and `createRuntimeEngine({db, config, clock?})`.
`src/server.mjs` builds ONE runtime per process, so accounting poison lasts for the process.

1. Ledger adapter: `monthSpendUsd('YYYYMM')` reads `yyyymm = 'YYYY-MM'` (any other key is a
   TypeError); `record({ts, purpose, costUsd, model, tokens})` stores `yyyymm = ts` month, the cost
   rounded up to whole cents (sub-cent calls are never undercounted against the cap) and the usage
   counts as `tokens`; `recent(limit = 10)` lists `{id, ts, purpose, model, costUsd}` newest first.
2. Runtime: `{mode, ledger, isOn(), capUsd(), now(), call(request), extract(request)}`. `mode` is
   `config.engine`. The effective engine state is `isOn()` = `settings.engine.on !== false &&
   config.engine !== 'off'`. `capUsd()` is `settings.cap.usd` when it is a finite number of at least
   0, else 200. `now()` is the clock date (`clock`, `FATHOM_CLOCK`, else `settings.clock`) at the
   current UTC time, so spend lands in the month the Engine screen shows.
3. `createEngine` gains two optional hooks used by the runtime: `controls: () => ({on, capUsd})`,
   read inside the serialized check before every model round (on false throws `EngineOffError`; a
   finite `capUsd` replaces the constructed cap), and a per-call `request.fake` script list used in
   fake mode instead of the constructor queue. The runtime's fake default is one text round ("The
   fake engine has no scripted answer for this request.") for `call` and `{"rows":[]}` for `extract`.
4. `call` takes an optional `systemDynamic`: the SDK system prompt is `[system, engine rules,
   SYSTEM_PROMPT_DYNAMIC_BOUNDARY, systemDynamic]`, so `system` is prompt cached and the dynamic part
   is not; the Messages round sends it as a second, uncached system block; the unknown-cost
   estimate counts it.
5. Live mode reads `FATHOM_CLAUDE_CREDENTIAL_FILE` once at construction; a missing or unreadable
   credential makes every call throw `ModelCallError('Live engine has no credential')` before any
   spend. Credential contents and read errors are never logged.

## Chat over the data

`src/api/answerer.mjs`, with the deterministic fake answer source in `src/api/fake-answers.mjs`.

1. Before a model call: off by the switch answers with the engine-off notice, off by configuration
   with "The engine is off in this deployment's configuration, so answers are paused." The answerer
   then re-checks the pack fingerprint, reads `household_summary`, and for a rec conversation the
   rec (`get_recommendation`) or for `pack:<id>` the pack metadata and entries, as conversation
   context.
2. Prompt (`buildChatPrompt`): `system` = `PRODUCT_RULES` plus `<knowledge_packs>` holding
   `packContext` of the effectively active manifest packs (base status plus overrides), with no
   household data; `systemDynamic` = `<household_summary>`, optional `<conversation_context>` and
   today; `messages` = the last 20 non-notice messages as plain text turns plus the question.
   `PRODUCT_RULES` states: advisory only, no tax filing, no money movement or account changes, no
   securities selection, no number not taken from a tool result or the provided data, stored
   figures as `{f:key}` tokens from `get_figures`, cite pack entries by title, plain text paragraphs,
   and never changing a recommendation itself: on the owner's explicit request it calls
   `propose_recommendation_action` so the owner can confirm.
   A What if question is the pack prompt: a manifest-backed prompt is sent as the raw literal text
   (no token resolution), an illustrative demo prompt with its tokens resolved to plain text. The
   history filter drops an earlier copy of the prompt in its stored form.
3. Tools: every read tool of the registry, never `set_recommendation_status` (the registry keeps it
   for other surfaces; chat never writes). In `ask` and rec conversations the answerer adds one
   local, non-writing tool, `propose_recommendation_action` (scope `read`, input `{id, action:
   accept|start|complete|dismiss|snooze|reopen, wake?: string up to 200}`, no other keys). Its
   handler checks that the rec exists and is not hidden and that the action is in `ACTION_STATUS`,
   returns only `{proposed: true}` and never touches the store. It is never offered in `pack:<id>`
   conversations or a What if. The last successful call becomes `provenance.proposal` `{recId,
   action, wake?}` (one per answer); in a rec conversation a proposal for any other rec is ignored.
   The UI shows a confirm card in that Fathom message ("Proposed: <action label> <rec title>", the
   label from a fixed map, the wake label escaped) with a Confirm button
   (`button.h-propose[data-propose-rec][data-propose-action]`) that calls the ordinary rec action
   (`api.act`, `POST /api/recs/:id/action`). The card reads Done, with no button, once the rec's
   status equals `ACTION_STATUS[action]`.
4. Grounding (`groundAnswer`): every `{f|fk|l|p|n:key}` token is validated against `fig`, `law`,
   `pct` and `names` (key characters `[A-Za-z0-9_.-]`), recorded once as a violation when invalid,
   and masked; then `checkGrounding` checks the remaining numbers and number words against tool
   results and context data only (household summary, conversation context, active pack entry
   bodies), never stored figure values, so a stored figure typed as a literal is a violation
   ("stored figure written as a literal"). Each grounded literal is bound to the first single source
   that grounds it (a tool by name, else the context datum).
   No number laundering: before `checkGrounding` and literal attribution, each tool result is
   sanitized. A result leaf (string or number) under the same key name as an argument leaf of the
   same call with an equal value (compared after trim, case-insensitive; array elements take their
   parent key) is dropped, as is a string leaf containing an argument string of 3 or more characters
   with a digit, and every key that identifies or cites (`id`, `ids`,
   `key`, `keys`, keys ending in `Id`, `Ids` or `_id`, `url`, `href`, `cites`, `citation`,
   `citations`, `source`, `sources`, `file`, `fileName`, `page`, `pages`). Error results stay
   ignored; tool provenance (name and args) is unchanged. Pack entry bodies, and `context.entries`
   in a pack conversation, ground without their citation and metadata lines (lines starting with
   `Source:`, `Sources:`, `Tax year:` or `Reviewed:`, any case), so a file name or citation never
   grounds a number; the model still sees the full entry text.
   The key filter is one evidence sanitizer applied inside `groundAnswer` to every grounding
   source, not only tool results: the household summary, the conversation context (pack metadata,
   `context.entries`, the rec context) and each tool result. Besides the keys above it drops
   labels and account identifiers: `ref`, `refs`, `manifest`, `slug`, `name`, `names`, `title`,
   `titles`, `label`, `labels`, `covers`, `version`, `versions`, `curator`, `curators`, `mask`,
   `masks`, `inst`, `institution`, `owner`, `owners`, `symbol`, `symbols`, `urls`, `cite`, `src`,
   `files`, `path`, and any key ending in `_ids`, `Mask`, `Masks`, `_mask`, `Number`, `Numbers` or
   `_number` (a plain `number` key stays a value). Every `body` string loses its metadata lines in
   the same pass. Value fields (amounts, balances, rec `value` text, `why`) still ground. So a pack
   id such as `plan4821`, a pack name, curator or version, a rec id, or a `list_accounts` mask
   never grounds a number, though the model still sees all of them. The argument-echo rule stays
   specific to tool results. Any value under a key other than the equal argument's is evidence
   even when it equals an argument, so an exact amount query (`query_transactions` with
   `minAmount` equal to `maxAmount`) grounds its matching `rows[].amount`, and a computed total
   (`query_transactions` `total` equal to `limit`) grounds. The sanitizer also drops `fig`
   (a rec's figure reference, such as `mine[].fig`) and any string leaf, under any key, that is a
   single token (no whitespace) that is not one whole numeric expression, for example `plan529`,
   `rec8263`, `acct-4821k`, a month period `2026-11`, a date `2026-11-05`, an ISO timestamp or a
   URL. A token that is exactly one numeric expression (`4821`, `$4,821`, `12%`, `20k`) stays.
   Prose evidence is an allowlist, applied as one transform in the same pass. In every prose
   string (pack entry bodies, and any string value containing whitespace in a tool result, the
   household summary or the conversation context) a number grounds only when it is marked as a
   quantity: a currency sign before it, or a percent sign, the word `percent` or a magnitude
   (`k`, `thousand`, `million`, `billion`) after it, with no letter glued in front. Every other
   digit run is blanked to spaces before `checkGrounding` sees the string, so bare numbers in
   prose (`Publication 560`, `Section 125`, `age 50`, years, date parts, the digits of
   `Invest529`) never ground, while `$7,000`, `6%`, `3.9 percent`, `20k` and `2 million` do. JSON
   number fields stay evidence, and a single-token string such as `4821` or `$1,500` is not prose.
   Before any number is judged, URLs, markdown link destinations and autolinks are removed from the
   prose (link text stays), so `[policy](https://example.invalid/4821k)` grounds nothing while
   `[the $500 limit](...)` still grounds `$500`. A link destination ends at its balanced closing
   parenthesis, so nested and repeated parenthesized segments
   (`[policy](https://example.invalid/a(b(c))/d(e)/$4821)`) are removed whole, and a bare URL is
   removed through the next whitespace, parentheses included. Each number is judged as one whole numeric
   expression using the engine's `numberPattern`, so scientific notation, decimals and percents
   are kept or blanked as a unit: `$1e3` grounds `$1,000` and never `$1` or `3`, and `12.5%` never
   grounds `12%` or `5%`. A marked expression counts only when it stands as its own word: a letter,
   digit, underscore or period glued in front, a letter or underscore followed by a hyphen in front
   (`acct-4821k`, `plan-4821%`), or a letter, digit or underscore glued after (`plan_4821k`,
   `4821%25`) blanks it.
   A stored figure that a tool returns as plain text grounds when the model read it through that
   tool: the tool result is the evidence, though the model is told to write figures as tokens.
   In `checkGrounding` itself (answer and evidence alike) a hyphen glued to a preceding letter or
   digit is not a minus sign (`2026-01` reads as 2026 and 1), a minus after whitespace or before
   a currency sign (`-$500`) still is, and an explicit list of letter codes joined to digits by a
   hyphen (`K-12`, `K-1`, `I-9`) is vocabulary like `W-2`, `W-4` and the 1099 forms, not a number.
   Any other code (`X-873`, `AB-500`) is not masked: its digits are checked as a number.
   A number followed by a magnitude word (`thousand`, `million`, `billion`), with or without a
   currency sign before it, is one quantity on both sides: in evidence `8.7 million` is collected
   as 8,700,000 and never as 8.7, and in the answer `$8.7 million` is checked as 8,700,000 with
   the magnitude word not judged again on its own. So evidence saying `8.7 million` grounds
   `$8.7 million` and `$8,700,000`, never `$8.70` or `8.7`. Number-word phrases (`two million`)
   are still read word by word.
5. One corrective retry (same `system`, the first answer plus a corrective user turn). An answer
   still ungrounded is stored with each violation in `<span class="fx-unverified" title="Not found
   in your data or tool results">`. If the retry call itself fails, the answer is the matching
   notice (engine off, over the cap, model error), never the first ungrounded text; the spend the
   engine recorded for each completed round stays in the ledger.
6. Rendering (`renderAnswer`): model text is untrusted. Everything is HTML-escaped (quotes and
   apostrophes included) with `{` and `}` as `&#123;` and `&#125;`, except valid tokens; bound
   literals are wrapped in `<span class="fx-src" data-src="<literal index>" title="From <source>">`;
   paragraphs split on blank lines.
7. Notices (stored with `notice = 1`, no provenance): engine off, off by configuration, over the cap
   ("This month's engine budget of {f:engine.budget.monthly} is used up, so answers are paused. Raise
   the cap on the Engine screen or wait for next month."), and any other model error, including a
   missing live credential ("The model could not answer just now, so nothing was made up. Try again
   in a moment."). Model calls are awaited before the write transaction opens.
8. Refs: the canned question's refs when the question matches one, the rec of a rec conversation,
   a what-if's unlock recs, recs the answer read through tools, and the rec of its proposal.
9. Fake answer source (`fakeAnswerScript`, `FATHOM_ENGINE=fake`): one tool round
   (`household_summary`, `get_figures` with the answer's figure keys, `get_recommendation` in a rec
   conversation) and one text round: the canned demo answer for a suggested or rec question (by id
   or exact free text), the pack's canned what-if answer (else a numberless sentence naming the pack
   and its covers), or "From your household summary, N items need you right now." with N from the
   summary. Numbers in the owner's free text are echoed first ("You asked about ..."), so an
   invented amount is marked unverified after the retry. In `ask` and rec conversations, free text
   that is an explicit command (`^(please\s+)?(accept|start|complete|dismiss|snooze|reopen)\b`)
   naming a rec (the rec conversation's own rec, or in `ask` a visible rec's id or exact title)
   adds a `propose_recommendation_action` call to the tool round, and the text round says the owner
   can confirm it below. Negations and questions ("Do not mark anything done", "Should I dismiss
   this?") never match.

### Answer provenance

Stored in `messages.provenance` and returned on the message: `{engine: mode, model, tools: [{name,
args}], figures: [figure keys], packIds: [active manifest ids in the prompt], packEntries: [entry
titles named in the answer], literals: [{text, source}], grounding: {ok, retried, unverified:
[texts]}, costUsd, proposal?: {recId, action, wake?}}`. No prompt text is ever stored.

## Live pack state

`src/packs/state.mjs` exports `REPO_PACKS_DIR`, `yourPlansDir(dataDir)` (`<dataDir>/packs/your-plans`),
`defaultPackDirs(dataDir)` (the repository `packs/` plus the Your plans dir when it exists),
`refreshPackState(db, {packDirs})` returning `{packs, activation, warnings}`, and
`createPackRefresher(db, {dataDir})` returning `{refresh(), refreshIfFactsChanged(), loaded(),
entry(rowId, entryId)}`. `src/store/facts.mjs` exports `upsertFact(db, {key, value, src, asOf,
confirmed, provenance: {fileId, parser, locator}}) -> {changed}` (an unconfirmed value never
overwrites a confirmed one) and `getFacts(db)` (flat `{key: value}`).

1. Each loaded manifest maps to the `packs_state` row whose `def.manifest` names it, else a new row
   whose id is the manifest id. The def is rewritten from the manifest: `id`, `manifest`, `name`
   (`def.label` when set, else the manifest name), base `status` and `why` from
   `activePacks(packs, getFacts(db))`, `covers`, `entries` (count), `entryList` `[{id, title,
   cites}]`, `curator`, `version`, `taxYear`, `reviewed`, `updated` ("Nov 2026"), `recIds` (kept,
   else the recs whose `pack_id` is the row), and `whatIf` `{prompt, a, unlocks}` (prompt from the
   manifest, `a` and `unlocks` kept). Override columns are kept. Rows never manifest-backed (the
   demo's illustrative packs) are untouched; manifest-backed rows whose manifest is gone are deleted.
2. The demo seed tags its seven manifest-backed packs with `manifest` and `label`; migration 002
   applies the same tags to existing demo stores only (real stores are never tagged, so their
   manifests get their own rows).
3. Repository pack errors throw (startup fails loudly). A broken Your plans pack is skipped with a
   warning that carries none of its contents.
4. The refresher recomputes `defaultPackDirs(dataDir)` on every refresh and fingerprints the facts
   (`key, value, confirmed`) plus `settings['packs.generation']`. The router calls
   `refreshIfFactsChanged()` before every API handler and the answerer again before prompt assembly,
   so a fact written by any process or a Your plans build from the CLI shows on the next request.
   Startup, demo reset and the build action call `refresh()`.

## Your plans

`src/packs/your-plans.mjs` exports `buildYourPlans({db, engine, dataDir, fileIds, clock})` returning
`{written, dir, entries, sources: [{fileId, name}], warnings, dropped}`, and `fakeExtractRows(text)`
(sections split on `# Heading` lines and `Page N` markers, each row's `excerpt` the section text it
read, and "Untitled section" for a section with no heading, so no title carries a number or the
file name). `npm run build:your-plans [-- --file <id>]...` (`scripts/build-your-plans.mjs`) runs it
against the existing store (refusing when there is none) and prints counts only, the dropped count
included.

1. The target `<dataDir>/packs/your-plans/` must resolve (realpath of its nearest existing ancestor,
   so symlinks count) outside the repository entirely; otherwise the build refuses with "FATHOM_DATA
   is inside the repository; set it to a directory outside the checkout" before anything is read or
   written. `packs/your-plans/` is gitignored.
2. Sources: `documents` with `doc_type` plan or benefits (their file, or `fields.text` named
   `document-<id>` when the row has no file) plus the files named in `fileIds` (an unknown id warns).
   `stored_path` resolves against `dataDir` and must stay inside it after symlinks. Text (`text/*`,
   `.md`, `.txt`) and PDF (`application/pdf` or `%PDF-` magic) are read; anything else warns.
   Warnings never carry document text.
3. Each source goes through `engine.extract` with rows `{title, body, excerpt, page, taxYear?}`,
   `excerpt` the verbatim source text the row is drawn from. Extracted entries must match the
   document. For a text source a row is kept only when (a) its excerpt, whitespace-normalized
   (runs collapsed to one space, trimmed), is a nonempty substring of the normalized source text;
   (b) every number in its neutralized title and body is in the excerpt, without the prose
   exemptions of `checkGrounding` (bare years, dates): every digit run of the title and body must
   be a digit run of the excerpt, with thousands separators removed on both sides (1,500 and 1500
   are the same run) and a date or year taken as its digit runs (2026-12-15 is 2026, 12 and 15);
   `checkGrounding` with the excerpt as the only data must also pass, where a number word counts
   when the excerpt has the same words. So "The benefit is 2099 dollars" from a numberless source
   is dropped; and (c) an
   occurrence of the excerpt is on `row.page`, counting `Page N` marker lines before it (1 when there
   are none). A PDF source cannot be checked (the code holds no PDF text), so all its rows are
   dropped with one warning that PDF sections cannot be checked against the document yet and a text
   copy can be uploaded instead. Every dropped row is counted in `dropped`, a warning per source says
   how many sections did not match the document (no document text), `settings.yourPlans` records
   `dropped`, and the Packs Your plans result line shows "N sections were dropped because they did
   not match the document." when N > 0. Each kept row becomes `NN-<slug>.md` holding `# <title>`, the body, `Source: <file name>, page <n>`, `Tax year`
   and `Reviewed`. Private entries cite `https://your-plans.invalid/<encodeURIComponent(fileId)>?page=<n>`
   with label `<file name>, page <n>`: the frozen manifest requires absolute http(s) cites, and the
   reserved `.invalid` host never resolves; the UI shows these cites as plain text, never links.
4. The manifest is `your-plans` "Your plans", version 1.0.0, the clock year and date, curator "Built
   from your documents", `appliesWhen: {all: []}` (always active). It is written to a temporary
   sibling, validated with `loadPacks`, then swapped in. Zero kept rows write nothing. A successful
   build sets `settings.yourPlans` `{builtAt, entries, dropped, sources}` and increments
   `settings['packs.generation']`.

## Demo data

`demo/scenario.mjs` is the synthetic scenario (a faithful copy of the mock's). `demo/seed.mjs`
(`seedDemo(db)`, `OPENS_ON`) loads it at the November state: live status is
`statusByDemo.november ?? status`, windows become close dates relative to the scenario clock,
`opens_on` comes from `OPENS_ON` (`salary27` opens 2027-01-01; the others are dependency driven),
and the spend ledger sums to the scenario's month-to-date spend. `demo/ledger.mjs` adds a
deterministic synthetic ledger (seeded PRNG): transactions for the checking and business accounts
from January through the data-through month, balances at data-through equal to each account's
figure, positions for investment accounts, monthly P and L per business and quarterly estimated
tax payments. Every seeded row carries `file_id` and `parser` `demo-seed` and a locator.

## Container

The `Dockerfile` builds on `node:24-slim`, installs with `npm ci --omit=dev`, copies `src`, `web`,
`demo`, `packs` and `scripts`, runs as the built-in
non-root `node` user (uid 1000) with `/data` owned by it, sets `FATHOM_DATA=/data`,
`FATHOM_PORT=8080` and `FATHOM_HOST=0.0.0.0`, exposes 8080, and health checks `GET /healthz` with
node's `fetch`. Mount a named volume at `/data`; a host bind mount directory must be writable by
uid 1000. `scripts/docker-smoke.sh` builds, runs and smoke tests the image with whatever docker CLI
configuration the caller has.
