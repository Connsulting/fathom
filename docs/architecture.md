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
| `package.json` | Scripts `start`, `test`, `seed:demo`, `e2e`, `e2e:smoke` (names are frozen), plus `plan` (`npm run plan`, one planning run over the real store). |
| `src/server.mjs` | HTTP entry: store mode rules, then serves the UI, `/shared/` and the API. |
| `src/config.mjs` | `loadConfig(env)`: every environment key, paths only. |
| `src/store/` | `db.mjs` plus `migrations/NNN-name.sql`. Owned by the foundation item. |
| `src/scenario/build.mjs` | Store to CONTRACT.md scenario object (`buildScenario`). |
| `src/api/` | Router, handlers, HTTP guards, static serving, the canned answerer. |
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
| `settings` | `key` PK, `value` JSON, `updated_at`. Keys: `mode`, `engine` `{on}`, `cap` `{usd}` (default 200), `clock`, `onboarding` `{done, step}`, `wargame.picks` `{salary, deferral}`, `seeded` `{at, scenario_sha}` |
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
| `messages` | `id` PK, `conversation_key`, `role` in me, fathom, advisor, claude, `text` (token-bearing HTML), `refs` JSON, `notice`, `ts` |
| `goals` | `id` PK, `def` JSON, `sort` |
| `deadlines` | `id` PK, `date`, `label`, `title`, `rec_id`, `hard` |
| `events` | `id` PK, `date` (label as in the scenario), `kind`, `title`, `body`, `sort` |
| `packs_state` | `id` PK, `def` JSON (the pack with its base status), `active` (NULL means no override), `exploring`, `what_if_asked`, `what_if_done`, `unhid` JSON, `sort`, `updated_at` |
| `decisions` | `id` PK, `title`, `status` in open, decided, upcoming, `wargame`, `rec_id`, `opens_on`, `when_label`, `note`, `decided_line`, `sort` |
| `jobs` | `id` PK, `name`, `cadence`, `does`, `cost`, `next_label`, `last_label`, `enabled`, `sort` |
| `job_runs` | `id` PK, `job_id`, `started_at`, `finished_at`, `status`, `cost_usd`, `note` |
| `api_keys` | `id` PK, `name`, `key_hash`, `scopes` JSON, `created_at`, `last_used_at`, `revoked_at` |
| `spend_ledger` | `id` PK, `ts`, `yyyymm` `'YYYY-MM'`, `purpose`, `cost_usd`, `model`, `tokens` JSON |
| `planner_recs` | `rec_id` PK (references `recs.id`), `trigger_id`, `grounding_hash`, `prose_src` in model, template, `first_run`, `last_run` (reference `job_runs.id`), `retired_at`, `retired_reason`, `retired_from`, `held_from`. Bookkeeping for planner-owned recs (migration 002). |

Migration 002 also adds a `src` column to `events`, `deadlines` and `decisions`; the planner writes its rows with `src = 'planner'` and replaces only those.

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
5. Engine: `budget.monthly` is `settings.cap.usd` (default 200); `budget.used` is the sum of
   `spend_ledger.cost_usd` for the clock's month; jobs come from `jobs`; `chat` from content.
6. Derived provenance figures, registered at build time and never stored:
   `wg.salary.<pointId>.x|y` and `wg.deferral.<optionId>.amount|tax2026|tax2027|net|decCash|need|gap`
   (kind m, source `wargame-model`, "War-game model, from your plan");
   `series.<key>.<index>` (the point's kind, source the series `src` or `plan`);
   `engine.budget.used` (a, `spend-ledger`), `engine.budget.monthly` (p, `settings`),
   `engine.budget.left` (e, `spend-ledger`), and `engine.job.<jobId>.cost` (e, `job-estimates`,
   "Per-run cost estimate"). Built-in sources cover these ids when the store has no row for them.

### The `live` key

```
live = {
  mode: 'demo' | 'real',
  demo: 'november' | 'fresh',          // 'fresh' while onboarding is not done; the UI forces onboarding
  engine: boolean,                      // settings.engine.on, default true
  onboardStep: int,
  picks: { salary: int, deferral: int },  // war-game selections; default the current/recommended point
  conversations: { <key>: [ { id, role, text, refs, ts, notice } ] },
  packs: { <id>: { active: boolean | null, exploring: boolean, whatIfDone: boolean } },
  clock: 'YYYY-MM-DD'
}
```

Conversation keys are `ask`, a rec id, or `pack:<id>`; `ask` is always present. Message `id` is a
string (`m<rowid>`), `text` is token-bearing HTML source (paragraphs as `<p>...</p>`; resolve it
with `api.t` at read time), `refs` are rec ids, `ts` is a display label such as "Nov 5, 9:04 AM",
`notice` is true only for the engine-off notice. The demo seed opens each rec conversation with one
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
| `POST /api/packs/:id/toggle` | `{}` | `{scenario, status}`. Turning a pack on lifts its hidden recs to proposed; turning it off hides again only the recs it lifted that no other active pack powers. |
| `POST /api/packs/:id/whatif` | `{}` | `{scenario}`. Marks the pack exploring and appends the canned prompt and answer once to `pack:<id>`; with the engine off it appends a single notice and does not mark it done. |
| `POST /api/engine` | `{on: boolean}` | `{scenario}`; 400 when `on` is not boolean. |
| `POST /api/ask` | `{key?: 'ask', a rec id or 'pack:<id>', questionId? or text?}` | `{scenario, message}`. Exactly one of `questionId` or `text`; empty text, both or neither are 400; unknown question or conversation 404. Appends the owner's message and the answer (or the engine-off notice when the engine is off). |
| `POST /api/onboarding` | `{step}` | `{scenario}`. 0 to 5 set the step, 6 completes onboarding; anything else 400. |
| `POST /api/demo/reset` | `{}` | `{scenario}`. Rebuilds the demo store; 404 unless the store is a demo store. |
| `POST /api/jobs/plan/run` | `{}` | `{scenario, run}`. Runs the planner (`runPlanning`) with the server's runtime engine and `FATHOM_CLOCK`; 409 `{error: 'planning runs on real stores only'}` on a demo store, which it leaves unchanged. |

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

1. Answerer: `src/api/answerer.mjs` exports `createCannedAnswerer()` returning
   `{answer({db, key, questionId?, text?}) -> {paragraphs, refs, notice?} | null}`. `src/server.mjs`
   constructs it and the router passes it to handlers as `ctx.answerer`. The ask endpoint only calls
   it while the engine is on and words the owner's question itself from `src/api/questions.mjs`.
   Free text that exactly matches a canned question (the rec's own follow-ups first, then the
   suggested Ask questions; tokens resolved, trimmed, case-insensitive) gets that answer, else the
   fallback. The live engine replaces this object with the same interface.
2. Packs: `src/packs` replaces the seeded `packs_state.def` rows with loaded manifests and sets the
   base status from `activePacks(packs, facts)`; overrides in `packs_state` keep working.
3. Ingest: parsers write rows with provenance into the ledger tables, `facts` and `files`; figures
   and sources follow from them. Narrative `content` rows are replaced as data takes over.
4. Engine: `src/engine` records spend in `spend_ledger`, which already feeds `engine.budget.used`,
   and reads the cap from `settings.cap`.
5. MCP: `src/mcp` exposes `src/tools` with scopes checked against `api_keys`.
6. Jobs: `src/jobs` schedules from `jobs` and records `job_runs`.
7. Email: `src/email` renders the `email` content (later derived) through `FATHOM_EMAIL_TRANSPORT`.

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

The `Dockerfile` builds on `node:24-slim`, installs with `npm ci --omit=dev`, runs as the built-in
non-root `node` user (uid 1000) with `/data` owned by it, sets `FATHOM_DATA=/data`,
`FATHOM_PORT=8080` and `FATHOM_HOST=0.0.0.0`, exposes 8080, and health checks `GET /healthz` with
node's `fetch`. Mount a named volume at `/data`; a host bind mount directory must be writable by
uid 1000. `scripts/docker-smoke.sh` builds, runs and smoke tests the image with whatever docker CLI
configuration the caller has.

## Planner

`src/jobs/planner.mjs` exports `runPlanning(db, engine, {now, packDirs})`, `PlannerError` and
`PLAN_JOB_ID` (`'plan'`). It is the real-mode brain: a deterministic run that reads the ledger,
derives facts and figures, evaluates the trigger catalog and rewrites the planner-owned parts of
the plan and brief. `POST /api/jobs/plan/run` and `npm run plan` (`src/jobs/plan-cli.mjs`, exit 2
on a missing or demo store, prints counts and warning codes only) call it.

### Run steps

1. Refuse a demo store (`PlannerError` code `demo_store`). Insert the `jobs` row `plan` when
   missing and a `job_runs` row with status `running`.
2. Clock: `now` (a Date, ISO string or epoch ms), else `settings.clock`, else today. The tax year
   is the latest supported year (2026 today) whose return is not yet due (clock on or before
   Apr 15 of the next year); without one, tax, retirement and war-game figures are skipped with
   warning `unsupported_tax_year`.
3. Load planning data (`planner/data.mjs`): accounts with their latest balance or position value,
   P and L lines of the tax year, tax payments, documents, transactions of the last 400 days, files
   and per-source freshness (45 days, or for tax payments the latest federal installment date).
4. Derive facts (`planner/facts.mjs`), compute figures and the war-game models
   (`planner/figures.mjs`, `planner/household.mjs`, `planner/wargame.mjs`), then derive
   `income.agiEstimate` and `retirement.backdoorRothCandidate` from `agi.est`.
5. Evaluate the trigger catalog (`src/jobs/triggers/`) into hit, blocked or none per trigger.
6. Prose (`planner/prose.mjs`), outside the transaction: stored prose is kept while the grounding
   hash is unchanged; otherwise the engine is asked and its reply accepted only under the prose
   rules below; otherwise the template.
7. One write transaction: facts, sources, figures, recs (`planner/recs.mjs`), `refreshPackStateIn`,
   the brief (`planner/brief.mjs`), then pruning of planner figures nothing references.
8. Finish `job_runs` with `ok`, the engine cost and a note of counts only. On any throw the row is
   `error` with note `{error: <class name>, code: <PlannerError code or null>}` and the error is
   rethrown. Runs are serialized per db handle, and every write compares first, so a second run
   over the same data changes no row.

Result: `{runId, status: 'ok', counts: {factsDerived, factsWritten, figures, recs: {active, new,
updated, retired, unchanged}, byTrigger: {<id>: new|updated|unchanged|retired}, prose: {model,
template, kept}, warnings}, warnings: [codes], costUsd}`.

### Facts the planner owns

Planner facts carry `src: 'planner'`, `confirmed: 0`, `as_of` the clock and provenance
`{fileId, parser: 'planner', locator: {rule, rows: [{table, id}] (at most 20), count}}`. The planner
writes a key only when no row exists or the stored row is its own unconfirmed one, so owner answers
always win; a planner row whose evidence disappears is deleted (kept while the tax computation is
blocked). Booleans are only derived as true. Keys: `income.sCorp`, `income.selfEmployed`,
`income.partnership` (from entity documents, the `business.entities` fact, W-2, 1099-NEC and K-1
documents), `income.w2` (an outside employer, never the household's own S corp), `accounts.has529`,
`benefits.hsa`, `retirement.ira`, `retirement.solo401k` (from accounts), `giving.charitable`,
`giving.annualEstimate` (charitable outflows of the last 365 days), `income.agiEstimate` and
`retirement.backdoorRothCandidate` (AGI as the MAGI proxy above the Roth phase-out). Calculator
confirmations come only from owner-set facts: `retirement.planTermsConfirmed`,
`retirement.aggregationConfirmed`, `benefits.hsaEligible`, `benefits.hsaCoverage`,
`business.salaryRange`, `business.cashBasis`, `household.ownerAge`, `household.spouseAge` and
`accounts.va529`. A missing one produces no figure and turns the trigger that needs it into a
confirm form. Other owner inputs: `tax.itemizedEstimate`, `tax.vaItemizedEstimate`,
`tax.withholding.federal`, `tax.withholding.virginia`, `tax.prior.*`, `retirement.contributions`,
`income.partnershipEstimate`, `plan.nextYearBusinessIncome`, `business.lastPayrollDate`,
`household.expectedDate`, `household.names`.

### Figures

Rows are written with `parser = 'planner'`, a label with no digits (except inside 401(k), 529, W-2
and 1099), and a locator that always carries `computedOn`: data figures hold `rows: {table, ids
(first 50), count}`, model figures hold `calc`, `inputs` or `parts`, `steps` and `assumptions`.
Kinds: `a` actual, `p` projection, `e` estimate, `m` model output.

| Keys | Kind | Source |
|---|---|---|
| `bal.<accountId>` | a | `acct:<accountId>` |
| `cash.total`, `cash.business`, `cash.personal` | a | `calc:cash` |
| `cash.monthlyOut`, `cash.runwayMonths` | e | `calc:cash` |
| `pnl.<entity>.income`, `.expenses`, `.net`, `.salary`, `.payrollTax`; `inc.ytd.<entity>` | a | `pnl` |
| `pnl.<entity>.netProj`, `.salaryProj`; `scorp.profitProj` | p | `plan-projection` |
| `agi.est` | e | `calc:tax` |
| `tax.fed.qbi`, `.taxable`, `.income`, `.se`, `.proj`; `tax.va.proj` | m | `calc:tax` |
| `tax.fed.paid`, `tax.va.paid` | a | `tax-payments` |
| `tax.fed.withheld`, `tax.va.withheld` | a | `docs` |
| `sh.fed.required`, `.remaining`; `sh.va.required`, `.remaining` | m (e without a prior year) | `calc:tax` |
| `room.solo401k`, `.employee`, `.employer`; `room.sep`; `room.ira.owner`, `.spouse`, `.household`; `room.hsa` | m | `calc:retirement` |
| `hsa.contrib.ytd`, `va529.contrib.ytd` (zero when a college account had no deposit this year), `giving.trailing`, `giving.ytd` | a | `transactions` |
| `inc.ytd.w2` (outside-employer W-2 or latest paystub wages this year) | a | `docs` |
| `inc.ytd.total` (every `inc.ytd.*` figure) | a | `calc:income` |
| `ira.pretax.owner`, `ira.pretax.spouse` | a | `acct:<accountId>` |
| `va529.deductionLeft`, `va529.taxSaved`, `giving.twoYear` | m | `calc:tax` |
| `wg.salary.<point>.salary`, `.payroll`, `.dist`, `.tax`, `.x`, `.y`; `wg.deferral.<option>.amount`, `.tax2026`, `.tax2027`, `.net`, `.decCash`, `.need`, `.gap`; `wg.deferral.base.income` | m | `wargame-model` |

The household liability (`householdTax`) projects each P and L entity from its own months of data,
computes self-employment tax per person with filing-unit Additional Medicare, allocates the
deductible half to each business, caps QBI at 20 percent of taxable income before QBI, applies the
child tax credit for children under 17 (omitted above the phase-out threshold), and computes
Virginia tax with the Virginia 529 deduction (personal exemptions omitted). W-2 or paystub wages
from a classified household S corp count as that person's own-corp wages even without its P and L.
Every partnership entity needs its own complete K-1 (matched by the K-1's `partnership`, `entity`
or `payer` name) or, for a single partnership without one, `income.partnershipEstimate`. An
unclassified P and L entity, an incomplete partnership input, filing status mfs
(`mfs_unsupported`), a household tax calculator throw (`calc_failed`) or a missing Virginia
itemized estimate blocks the tax figures that need it. IRA room counts traditional and Roth IRA
contributions; SEP room for a sole proprietor passes that person's W-2 wages; a pre-tax IRA with
no balance on file leaves that person's pro-rata status unknown. A planner figure not produced by a run is deleted unless a rec def (text or
`mine`), message, decision note or content row references it, or a kept war-game entry names its
point or option. `src/scenario/build.mjs` serves a stored `wg.*` figure in place of the value it
would derive from `content.wargame`.

### Trigger catalog

Each module in `src/jobs/triggers/` exports `id`, `domain`, `trigger`, `packs`, `gate` (a pack
rule over facts that tolerates absent facts), `calcs`, `kb`, `window(ctx)`, `evaluate(ctx)` (null,
a hit, or `{blocked: reason}`), `build(ctx, hit)` and `template(ctx, hit)`. A trigger hits when its
gate holds, its window has not closed and `evaluate` returns a hit. A null evaluation after one of
the trigger's `calcs` threw is blocked as `calc_failed`, never retired.

| Id | Domain / class | Window |
|---|---|---|
| `fed-q4-estimate` | tax / calendar | Jan 15, hard |
| `va-q4-estimate` | tax / calendar | Jan 15, hard |
| `year-end-retirement` | retirement / calendar | Last payroll (Dec 15 or `business.lastPayrollDate`), hard |
| `solo401k-setup` | retirement / calendar | Before last payroll, hard |
| `scorp-salary` | business / income | Last payroll; scenario `salary` |
| `invoice-deferral` | business / calendar | Dec 1; scenario `deferral` |
| `hsa-room` | retirement / calendar | Apr 15, hard |
| `va529` | family / calendar | Dec 31, hard |
| `charitable-bunching` | giving / goal | Dec 31 |
| `backdoor-roth` | retirement / goal | Pro-rata snapshot Dec 31, then the Apr 15 IRA deadline |
| `dependent-care-fsa` | family / calendar | Open enrollment |
| `new-child` | family / life | the expected date, else none |
| `missing-data` | data / calendar | Jan 15 when tax data is blocked, else two weeks out |

Recs: a new hit inserts the rec (`proposed`, or `hidden` behind an owner-disabled pack), its
`planner_recs` row and a conversation with one Fathom message holding the summary. An existing
planner rec is updated only when its def, window or pack changes, keeping status, waiting, wake,
task flags (remapped by task text) and the conversation. A rec whose trigger no longer applies is
retired (status `dismissed` only from an active status, event `retire`, reason "Its window closed on
<date>." or "The condition behind it no longer holds in your data."), never deleted. A planner
retired rec revives to `proposed` only when the planner's retire event was the last status change.
A blocked trigger parks an active rec as `waiting` on `data` (event `block`, `held_from`) and
returns it when the data arrives (event `unblock`). A rec id the planner does not own is skipped
with warning `rec_id_taken`.

### Prose rules

Templates contain no digits outside tokens and no number words; amounts are `{f:}`/`{fk:}`
figure tokens, statutory amounts `{l:}`, percents `{p:}`, names `{n:}`; a figure token appears only
when that figure was produced. Data-derived text (entity and account names, `mine` labels) is
HTML-escaped, braces included, before it enters a title, task or prose. Model prose (one `job` call
per changed rec, `maxTokens` 1500, grounding allow list) is accepted only when the reply is JSON
`{summary, why[1..4], qa[0..4]{q, a[1..3]}}`, every token names an allowed key for its scope,
`checkGrounding` with token-only sources finds no literal number, and the engine's grounding check
passes; accepted text is HTML-escaped. Any failure, including `EngineOffError` and
`BudgetExceededError`, falls back to the template. The grounding hash covers the trigger, template
version, window close, the hit's figure values and its other hit variables.

### Brief content

Content rows (src `planner`), each written only when it changes: `names` (`household.names` over
neutral labels), `meta` (`dataThrough` is the latest source date), `law`, `pct`, `verdict` (the
earliest needs-you rec and its window), `domains` (tax, cash and data always, others when they have
a hit or a relevant fact; status needs, waiting, changed or covered), and `wargame` (each entry
replaced only when the run built a new model). Deadlines (src `planner`) are the hit windows plus
the statutory dates of the next 400 days that no hit covers. Decisions (src `planner`) are upserted
by id: `<scenario>-<year>` open per scenario hit and `salary-<year + 1>` upcoming for an S corp.
Events (src `planner`) are replaced only when something changed against `settings.planner.snapshot`
(new files, new, revived and retired recs, planner fact changes); the snapshot is rewritten each run.

### Job rows

`jobs` row `{id: 'plan', name: 'Planning run', cadence: 'On demand', cost: 0, enabled: 1}`, inserted
when missing (real stores only). Each run adds one `job_runs` row with ISO `started_at` and
`finished_at`, status `running` then `ok` or `error`, `cost_usd` and a counts-only `note`.

### Planner seams

1. `src/engine/runtime.mjs` `createRuntimeEngine({db, config, responses})` returns
   `{mode, call, extract}`: the gateway engine over `spend_ledger` (the gateway's `YYYYMM` month
   keys map to stored `YYYY-MM`). Before each call it throws `EngineOffError` when
   `settings.engine.on` is false and re-reads `settings.cap.usd` (200 when unusable). Live mode
   reads `config.claudeCredentialFile` once; a failed read makes calls throw
   `ModelCallError('Claude credential unavailable')` without naming the file. `src/server.mjs`
   builds one and passes it to the router, which hands it to handlers as `ctx.engine`.
2. `src/packs/state.mjs`: `defaultPackDirs(dataDir)` (repo `packs/` plus
   `<dataDir>/packs/your-plans` when present), `refreshPackStateIn(db, {packDirs})` (inside the
   caller's transaction) and `refreshPackState` (its own). Rows carry the CONTRACT pack def with
   base status from the stored facts and `recIds` from `recs.pack_id`; owner columns and previous
   what-if answers are kept, unknown packs removed, `updated_at` moves only with the def. The
   server refreshes pack state at startup for real stores only, logging a pack error by message.
3. `src/store/facts.mjs`: `upsertFact(db, {key, value, src, asOf, confirmed, provenance})` never
   replaces a confirmed row with an unconfirmed write and skips identical writes (returns
   `{written, reason?}`); `getFacts(db)` returns every fact parsed by key.
