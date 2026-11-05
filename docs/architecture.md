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
| `list_packs` | read | none | `[{id, name, status, why, version, taxYear, reviewed, covers, entries: [{file, title}]}]` sorted by id |
| `get_pack_entry` | read | `packId, file` (the manifest file or the entry id) | `{packId, packName, file, id, title, markdown, citations: [{label, url}], version, taxYear, reviewed}`; any loaded pack, active or not |
| `search_pack_entries` | read | `query (2..200 chars), packId?, limit? (1..20, default 10)` | `{query, results: [{packId, file, id, title, score, snippet}], total, truncated}` over active packs only |

The pack tools (`src/tools/packs.mjs`) load packs from `ctx.packDirs`, else the repo `packs/` plus
`<ctx.dataDir>/packs/your-plans` when it exists. Status comes from `activePacks(packs, facts)` over
the `facts` table; a `packs_state` row with a non-null `active` overrides it (1 active, 0
available). Search terms are the lowercase alphanumeric runs of two or more characters in the
query; an entry matches when every term appears in its title or body; score is 5 per title
occurrence plus 1 per body occurrence; order is score descending, then pack id, then entry id.

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
| `FATHOM_PUBLIC_URL` | unset | The URL MCP clients reach this server at (an `http` or `https` URL with no credentials, query or fragment; anything else refuses to start). Its host is allowed on `/mcp` and every `/api` route, and `GET /api/mcp` advertises it with `/mcp` appended. |
| `FATHOM_ALLOWED_HOSTS` | unset | Comma separated extra `Host` names allowed on `/mcp` and every `/api` route: `host` (any port) or `host:port`. |

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

All JSON. Every `/api` route (any path equal to `/api` or under `/api/`, including unknown paths and
wrong methods) first passes the Host allowlist described under "MCP server": a foreign `Host` gets
403 `{error: 'forbidden host'}` before route matching. `/healthz` and static files are exempt. A
deployment reached by a DNS name must set `FATHOM_PUBLIC_URL` or `FATHOM_ALLOWED_HOSTS`. Every POST requires `content-type: application/json` (charset allowed), else 415; when an
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
| `POST /api/demo/reset` | `{}` | `{scenario}`. Rebuilds the demo store; 404 unless the store is a demo store. Clears `api_keys`; the server secret file survives. |
| `GET /api/keys` | | `{keys: [{id, name, scopes, createdAt, lastUsedAt, revokedAt}]}` ordered by creation; never a key or hash. |
| `POST /api/keys` | `{name, scopes?: ('read' or 'write:recs')[]}` | `{key, record, keys}`. The only time the key is shown. Name trimmed, 1 to 80 characters, no control characters; scopes always include `read`; else 400. |
| `POST /api/keys/:id/revoke` | `{}` | `{record, keys}`. Sets `revokedAt` once (a second revoke keeps it); 404 unknown id. |
| `GET /api/mcp` | | `{url, publicUrlSet, tools: [{name, description, scope}], scopes: [{id, label, access}]}`. `url` is `FATHOM_PUBLIC_URL` with `/mcp` appended unless it already ends in it, else `<proto>://<Host>/mcp` with proto from `X-Forwarded-Proto` (http or https only), then the socket. |

Key responses carry no `scenario`, the one exception to the rule above.

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

### MCP server

`POST /mcp` (exactly that path) is a stateless Streamable HTTP MCP endpoint (`src/mcp`). Each
request gets a fresh low-level SDK `Server` and a `StreamableHTTPServerTransport` with no session id
and JSON responses, closed when the response closes. Checks run in this order:

1. Host: 403 `{error: 'forbidden host'}` unless the `Host` header is an IP literal, `localhost` or
   `*.localhost`, the host of `FATHOM_PUBLIC_URL`, or an entry of `FATHOM_ALLOWED_HOSTS`. This
   blocks DNS rebinding; it runs before authentication. The same Host allowlist guards every
   `/api` route (not only `/api/keys`), decided on the raw path before route matching; `/healthz`
   and static files are exempt. A deployment reached by a DNS name must set `FATHOM_PUBLIC_URL` or
   `FATHOM_ALLOWED_HOSTS`.
2. Origin: when present it must be `http` or `https` with the same host as `Host`, else 403
   `{error: 'forbidden origin'}`.
3. Auth: `Authorization: Bearer <key>` (scheme case-insensitive, one token). Missing, malformed,
   unknown and revoked keys all get 401 with `WWW-Authenticate: Bearer` and exactly
   `{"error":"unauthorized"}`.
4. Method: `GET` and `DELETE` are 405 with `Allow: POST`. Bodies are capped at 1 MiB (413);
   malformed JSON is 400.
5. The key's `last_used_at` is stamped, then the request runs with
   `ctx = {db, now, packDirs, clock}`.

Scopes: `read` (every read tool) and `write:recs` (adds `set_recommendation_status`); every key
has `read`. `tools/list` returns only the key's tools, annotated `readOnlyHint` for read tools and
`destructiveHint: false`, `openWorldHint: false`. Calling a registry tool outside the key's scopes
returns an `isError` result `Permission denied: <name> needs the <scope> scope, which this key
does not have.`; an unknown name is `no tool <name>`; a `ToolError` returns its message; any other
failure returns `Tool execution failed` and logs only the tool name and error class. Keys, tool
arguments and tool results are never logged.

Keys (`src/mcp/keys.mjs`) are `fathom_` plus 43 base64url characters (32 random bytes), shown once
by `POST /api/keys`. `api_keys` stores only HMAC-SHA256 of the key under a server secret: the file
`api-key-secret` in `FATHOM_DATA`, 64 hex characters, created 0600 on first start and never
rewritten (a malformed file stops startup; removing it invalidates every key). Verification
compares against every stored hash with `crypto.timingSafeEqual`.

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
5. MCP: `src/mcp` exposes `src/tools` at `POST /mcp` with scopes checked against `api_keys` (see
   MCP server above). `src/server.mjs` loads the server secret, builds the key service
   (`createKeyService`) and `createMcpHandler`, and passes both to `createHandler`, which builds
   them from `config.dataDir` on first use when they are not passed. New tools added to the
   registry appear on `/mcp` under their scope with no further wiring.
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
node's `fetch`. It copies `src`, `web`, `demo` and `packs` (the pack tools read the repo packs at
runtime). Mount a named volume at `/data`; a host bind mount directory must be writable by
uid 1000. `scripts/docker-smoke.sh` builds, runs and smoke tests the image with whatever docker CLI
configuration the caller has.
