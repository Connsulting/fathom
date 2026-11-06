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
| `package.json` | Scripts `start`, `test`, `seed:demo`, `e2e`, `e2e:smoke` (names are frozen), plus `plan` (`npm run plan`, one planning run over the real store) and `confirm:guess` (`npm run confirm:guess`, one run of the `confirm-guess` job: engine guesses for pending confirm questions). |
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
| `src/email/` | Email transports, send history and the monthly brief. |
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
| snapshot | `account, asOf` (a statement's holdings list, even empty: the account's complete holdings on that date) | none (drives position removal) |
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
| `advisor_status` | read | none | `{advisor, nextCheckin: {date, time, lengthMin, label} or null, waiting: [{recId, title, sentOn}], reviewed: [{recId, title, sentOn, verdict, note, reviewedOn, recordedOn}], history (closed reviews with closedOn, closedReason), packets: [{id, date, recIds}]}` (see "Advisor workflow") |
| `set_recommendation_status` | write:recs | `id, status: accepted, doing, done, dismissed, snoozed or proposed, wake?` | the rec; writes `rec_events` with actor `tool` |
| `list_packs` | read | none | `[{id, name, status, why, version, taxYear, reviewed, covers, entries: [{file, title}]}]` sorted by id |
| `get_pack_entry` | read | `packId, file` (the manifest file or the entry id) | `{packId, packName, file, id, title, markdown, citations: [{label, url}], version, taxYear, reviewed}`; any loaded pack, active or not |
| `search_pack_entries` | read | `query (2..200 chars), packId?, limit? (1..20, default 10)` | `{results: [{packId, file, id, title, score, snippet}], total, truncated}` over active packs only (the query is not echoed) |

The pack tools (`src/tools/packs.mjs`) load packs from `ctx.packDirs`, else the repo `packs/` plus
`<ctx.dataDir>/packs/your-plans` when it exists. Status is what the owner sees in the UI, not the
facts alone. A manifest pack links to a `packs_state` row by the row's `def.manifest` (a manifest
id), else by the row id (`manifestIdOf` in `src/packs/index.mjs`, shared with the live pack view).
A linked pack reads `packStatus(base, {active, exploring})` from
`src/shared/rules.mjs`, where `base` is the row's `def.status` when it is a string, else the status
from `activePacks(packs, facts)`, and `active` and `exploring` are the row's columns (a non-null
`active` wins; `exploring` shows when the pack is not active). `why` is `Turned on by the owner.` or
`Turned off by the owner.` when `active` is set, else the row's `def.why` with scenario tokens
resolved to plain text, else the activation reason. A pack with no linked row keeps the
facts-derived status and reason. Name, version, tax year, review date and entries always come from
the manifest files. `search_pack_entries` reads only packs whose status is `active`. Search terms are the lowercase alphanumeric runs of two or more characters in the
query; an entry matches when every term appears in its title or body; score is 5 per title
occurrence plus 1 per body occurrence; order is score descending, then pack id, then entry id.

Tool outputs resolve scenario tokens to plain text and expose masks only.

`src/engine/tools.mjs` `createRegistryServer` consumes this registry. Input schemas must compile
under strict Ajv, so no union types (`type` arrays); use `anyOf`. `ctx.now` may be a Date, an ISO
string or epoch ms, and the store clock decides "today" when set.

### 9. Engine gateway

`src/engine` exports `createEngine({mode: 'live'|'fake'|'off', ledger, capUsd, credential})` with
`call({purpose: 'chat'|'job'|'extract'|'confirm'|'title', system, messages, tools?, maxTokens})` and a chat
runner on the Claude Agent SDK. `extract`, `confirm` and `title` are one structured Messages API round (a JSON
schema); `title` names Ask threads on `TITLE_MODEL` (`claude-haiku-5-5`), every other purpose runs
on `DEFAULT_MODEL` (`claude-opus-5-5`), and the conservative estimate for an unknown cost uses the
purpose's model. Prices live in `src/engine/pricing.mjs` with the date they were verified on the
pricing page; Haiku 5.5 has a base row for prompts up to 100,000 tokens (input plus cache read plus
cache write) and a long row above that. It checks on/off and month-to-date spend below the cap BEFORE every model
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
| `FATHOM_FAKE_STREAM_MS` | `25` | Fake engine only: milliseconds between streamed answer chunks (0 to 1000). |
| `FATHOM_CLAUDE_CREDENTIAL_FILE` | unset | Path to the mounted Claude credential. |
| `FATHOM_DATA_KEY_FILE` | unset | Path to the raw file encryption key. |
| `FATHOM_EMAIL_TRANSPORT` | `dev` | `dev`, `smtp`, `resend`, `postmark` or `agentmail` (see Email). |
| `FATHOM_EMAIL_FROM` | unset (`dev` uses `fathom@example.invalid`) | Sender address; for `agentmail` the inbox id. Not with `FATHOM_EMAIL_FROM_FILE`. |
| `FATHOM_EMAIL_FROM_FILE` | unset | Path to a file holding the sender address. Not with `FATHOM_EMAIL_FROM`. |
| `FATHOM_EMAIL_TO` | unset (`dev` uses `owner@example.invalid`) | Recipient addresses, comma separated. Not with `FATHOM_EMAIL_TO_FILE`. |
| `FATHOM_EMAIL_TO_FILE` | unset | Path to a file of recipient addresses (comma or newline separated). Not with `FATHOM_EMAIL_TO`. |
| `FATHOM_EMAIL_CREDENTIAL_FILE` | unset | Path to the mounted email credential (API key or SMTP password); must not be readable by other users; mount the secret with mode 0400 or 0440 (with fsGroup) or 0600. Required by every transport but `dev`. |
| `FATHOM_EMAIL_SMTP_USER` | unset | SMTP user name for `smtp`. |
| `FATHOM_EMAIL_SMTP_HOST` | `smtp.gmail.com` | SMTP host for `smtp`. |
| `FATHOM_EMAIL_SMTP_PORT` | `465` | `465` (TLS) or `587` (STARTTLS, TLS required); anything else is a config error. |
| `FATHOM_LIVE_EMAIL` | unset | `1` lets `npm run email:test` send a real email (see Email); read only by that script. |
| `FATHOM_PUBLIC_URL` | unset | The URL MCP clients reach this server at (an `http` or `https` URL with no credentials, query or fragment; anything else refuses to start). Emails link into the app from it. Its host is allowed on `/mcp` and every `/api` route, and `GET /api/mcp` advertises it with `/mcp` appended. |
| `FATHOM_ALLOWED_HOSTS` | unset | Comma separated extra `Host` names allowed on `/mcp` and every `/api` route: `host` (any port) or `host:port`. |
| `FATHOM_OWNER_LOGINS` | unset | Comma or newline separated Tailscale logins admitted on a real store (trimmed, case-insensitive). Unset or blank on a real store fails closed: every page and `/api` route answers 401. See "Owner identity". |
| `FATHOM_OWNER_LOGINS_FILE` | unset | Path to a file holding the same list (comma or newline separated). Use instead of `FATHOM_OWNER_LOGINS`; setting both, or an unreadable file, fails closed. |

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
| `settings` | `key` PK, `value` JSON, `updated_at`. Keys: `mode`, `engine` `{on}`, `cap` `{usd}` (default 200), `clock`, `timezone` (IANA zone for job schedules, default `America/New_York`), `onboarding` `{done, step}`, `wargame.picks` `{salary, deferral}`, `seeded` `{at, scenario_sha}`, `packs.generation` (integer, bumped by every Your plans build), `yourPlans` `{builtAt, entries, dropped, sources: [file names]}` (the last build) |
| `content` | `key` PK, `value` JSON, `src`, `updated_at`. Narrative sections with no data table yet: `meta` (product, household, dataThrough), `names`, `law`, `pct`, `series`, `verdict`, `domains`, `curve`, `wargame`, `ask`, `advisor`, `yearend`, `connect`, `engine.chat`, `onboarding`, `email` |
| `files` | `id` PK, `name`, `mime`, `size`, `sha256` (unique when set), `source_kind`, `uploaded_at`, `stored_path`, `status` (an ingest status, `pending` while routing), `note` (`limit_exceeded` for a `too_large` file), `parser`, `counts` JSON, `source_id`, `header_signature`, `period_from`, `period_to`, `coverage` JSON (the slots a workbook authoritatively covers) |
| `sources` | `id` PK, `label`, `as_of`, `kind`, `last_ingest_at`, `note` |
| `facts` | `key` PK, `value` JSON, `src`, `as_of`, `confirmed`, provenance, `updated_at` |
| `accounts` | `id` PK, `inst`, `mask` (4 digits or NULL), `name`, `owner`, `kind`, `mirror`, `note`, `fig_key`, provenance, `sort`, `source_id`, `identity` (unique when set: `inst|mask:<mask>`, `inst|name:<name>` or `source:<hash>`) |
| `transactions` | `id` PK, `account_id`, `date`, `amount`, `description`, `category`, `external_id`, `dedupe_key` unique, `occurrence`, provenance |
| `balances` | `id` PK, `account_id`, `date`, `amount`, `dedupe_key` (unique when set), provenance; unique (`account_id`, `date`) |
| `positions` | `id` PK, `account_id`, `as_of`, `symbol`, `name`, `quantity`, `price`, `value`, `cost_basis`, `dedupe_key` (unique when set), provenance |
| `pnl_lines` | `id` PK, `entity`, `period` `'YYYY-MM'`, `category`, `amount`, `dedupe_key` (unique when set), `source_slot`, provenance |
| `tax_payments` | `id` PK, `jurisdiction`, `tax_year`, `date`, `amount`, `kind` (the row's payment kind), `dedupe_key` (unique when set), `source_slot`, `payer`, `date_precision`, `tax_year_basis`, `recipient` (withholding: `owner`, `spouse` or `unknown`, the last segment of its `wh:` slot; NULL for workbook rows), provenance |
| `documents` | `id` PK, `doc_type`, `tax_year`, `fields` JSON (extracted values only; a `notes` document holds the reference `{ref, sha256, chars, lines}`, never the text), `dedupe_key` (unique when set), provenance |
| `figures` | `key` PK, `v`, `src` (references `sources.id`), `kind` in a, p, e, m, `label`, provenance, `updated_at` |
| `recs` | `id` PK, `def` JSON (the CONTRACT rec minus live fields), `status`, `waiting_on`, `wake`, `tasks_done` JSON, `window_close` ISO date, `window_label`, `pack_id`, `sort`, `updated_at`, provenance |
| `rec_events` | `id` PK, `rec_id`, `ts`, `action`, `arg`, `from_status`, `to_status`, `actor` (`ui`, `tool`, ...) |
| `conversations` | `key` PK (an Ask thread `ask:<12 lowercase hex>`, a rec id, or `pack:<id>`), `created_at`, `last_at` (newest message time, else `created_at`), and for Ask threads `title` (NULL until named), `title_source` (NULL, `auto` or `manual`), `archived_at`, `trashed_at` (migration 008; app clock ISO times) |
| `messages` | `id` PK, `conversation_key`, `role` in me, fathom, advisor, claude, `text` (token-bearing HTML), `refs` JSON, `notice`, `ts`, `provenance` JSON or NULL (migration 006; see "Answer provenance") |
| `goals` | `id` PK, `def` JSON, `sort` |
| `deadlines` | `id` PK, `date`, `label`, `title`, `rec_id`, `hard` |
| `events` | `id` PK, `date` (label as in the scenario), `kind`, `title`, `body`, `sort` |
| `packs_state` | `id` PK, `def` JSON (the pack with its base status, plus an optional `manifest` tag naming the repo pack manifest the row stands for, and on demo rows a `label` keeping the demo name; migration 005 tags the demo rows with `manifest`, migration 006 adds `label`, real rows link by their own id), `active` (NULL means no override), `exploring`, `what_if_asked`, `what_if_done`, `unhid` JSON, `sort`, `updated_at` |
| `decisions` | `id` PK, `title`, `status` in open, decided, upcoming, `wargame`, `rec_id`, `opens_on`, `when_label`, `note`, `decided_line`, `sort` |
| `jobs` | `id` PK, `name`, `cadence`, `does`, `cost`, `next_label`, `last_label`, `enabled`, `sort` |
| `job_runs` | `id` PK, `job_id`, `started_at`, `finished_at`, `status` (`running`, `ok`, `skipped` or `error`), `cost_usd`, `note` (counts JSON only), `period_key`, `trigger` (`scheduled`, `manual` or `ingest`), `duration_ms`, `error_class` (an error code or class name, never a message); unique (`job_id`, `period_key`) where `period_key` is set |
| `job_lock` | `id` PK (always 1), `holder`, `expires_at`: the scheduler lease |
| `email_sends` | `id` PK, `ts`, `kind` in brief, alert, test, `subject`, `status` in sent, failed, `error_code`, `transport`, `recipients` (a count), `message_id`, `job_run_id`. No bodies and no addresses. |
| `deadline_alerts` | `key`, `threshold` (14, 7 or 1), `deadline_date`, `sent_at`, `send_id`; PK (`key`, `threshold`) |
| `api_keys` | `id` PK, `name`, `key_hash`, `scopes` JSON, `created_at`, `last_used_at`, `revoked_at` |
| `spend_ledger` | `id` PK, `ts`, `yyyymm` `'YYYY-MM'`, `purpose`, `cost_usd` (full precision), `model`, `tokens` JSON (usage counts only, never prompt text) |
| `superseded_rows` | `id` PK, `table_name`, `dedupe_key`, `row` JSON (the archived row), `file_id`, `superseded_by` (references `files.id`), `reason` (`revised`, `removed`, `older_snapshot`, `alias_merged`, `duplicate_confirmed`, `duplicate_cross_format`, `duplicate`, `summarized`), `at`, `survivor_key` (for `duplicate_confirmed`, the dedupe key of the row it was confirmed against) |
| `confirm_items` | `id` PK, `kind`, `subject`, `question`, `options` JSON `[{id, label}]`, `context` JSON, `status` in pending, answered, `answer`, `file_id`, `created_at`, `answered_at`; unique (`kind`, `subject`) |
| `confirm_undo` | `item_id` PK (references `confirm_items.id`, cascade delete), `ingest_epoch` (the epoch when the answer was recorded), `changes` JSON `[{table, op, rowid, before, after}]` (the answer's change log, row images as JSON text), `created_at`, `used_at` (set when a later import or planning run re-applied the answer). One row per revisable answer (migration 009). |
| `confirm_guesses` | `item_id` PK (references `confirm_items.id`, cascade delete), `option_id` (NULL when the engine gave no valid guess), `reason`, `model`, `ts`. One row per question sent to the engine, so none is sent twice (migration 009). |
| `ingest_epoch` | `id` PK (always 1), `n`. Bumped by triggers on every `files` insert and update (migration 009); readers treat a missing row as 0. |
| `column_mappings` | `signature` PK (header signature), `mapping` JSON, `src`, `created_at`, `uses` |
| `entity_aliases` | `alias` PK (normalized alias name), `entity` (canonical display name), `created_at` |
| `held_facts` | `id` PK, `hold` (`employer:<employerKey>`), `key`, `value` JSON, `file_id`, `parser`, `locator`, `confidence`, `created_at` |
| `advisor_reviews` | `id` PK, `rec_id` (references `recs.id`; NULL only for a demo item outside the plan), `title` (the rec title when sent), `sent_at`, `verdict` NULL (waiting), confirmed or vetoed, `note` (escaped owner text, at most 1000 characters before escaping), `reviewed_on` (the advisor's date), `recorded_at`, `grounding_hash` (the planner's hash for the rec when the verdict was recorded), `closed_at`, `closed_reason` (`sent again`, `inputs changed`); at most one open row per rec (migration 011) |
| `advisor_checkin` | `id` PK (always 1), `date`, `time` (`HH:MM` or NULL), `length_min`, `updated_at`. The owner-set next check-in (migration 011). |
| `advisor_packets` | `id` PK (`advpkt-` and 16 hex), `created_at`, `clock` (the scenario date it was built for), `rec_ids` JSON, `stored_path` (encrypted under the data key, `files/<id>.bin`), `bytes`, `sha256` (migration 011) |
| `planner_recs` | `rec_id` PK (references `recs.id`), `trigger_id`, `grounding_hash`, `prose_src` in model, template, `first_run`, `last_run` (reference `job_runs.id`), `retired_at`, `retired_reason`, `retired_from`, `held_from`. Bookkeeping for planner-owned recs (migration 007). |

Migration 002 (`002-ingest.sql`) adds the ingest columns above (`files.parser` through
`files.coverage`, `accounts.source_id` and `identity`, `transactions.occurrence`, every
`dedupe_key` and `source_slot`, `tax_payments.payer`, `date_precision` and `tax_year_basis`) and
the tables `superseded_rows`, `confirm_items`, `column_mappings`, `entity_aliases` and
`held_facts`. `demo/seed.mjs` clears them with the rest of the store. Migration 003
(`003-ingest-recipients.sql`) adds `tax_payments.recipient`, and migration 004
(`004-ingest-survivor.sql`) adds `superseded_rows.survivor_key`. Migration 005 (`005-pack-manifest.sql`)
tags the seven manifest-backed demo pack rows with `def.manifest` in demo stores only (see
"Live pack state"). Migration 006 (`006-chat.sql`) adds `messages.provenance` and, in demo stores
only, sets `def.label` to the demo name on those tagged rows and adds the synthetic fact
`income.agiEstimate` when absent.

Migration 007 (`007-planner.sql`) creates `planner_recs` and adds a `src` column to `events`, `deadlines` and `decisions`; the planner writes its rows with `src = 'planner'` and replaces only those.

Migration 008 (`008-jobs-email.sql`) adds the scheduler columns `job_runs.period_key`, `trigger`,
`duration_ms` and `error_class` with the partial unique index on (`job_id`, `period_key`) (rows
with no period key, such as the planner's own runs, may repeat), and the tables `job_lock`,
`email_sends` and `deadline_alerts`. The new tables have no foreign keys, so the demo seed clears
them freely. In a demo store only (`settings.mode` is `demo`) it also deletes the five retired mock
jobs (`sync`, `sweep`, `triggers`, `brief`, `packet`) and their `job_runs` rows, because the demo now
seeds the scheduler's jobs and there is one jobs list.

Migration 009 (`009-confirm-deck.sql`) creates `confirm_undo`, `confirm_guesses` and
`ingest_epoch` with the two `files` triggers that bump the epoch (see "Confirm queue").

Migration 011 (`011-advisor.sql`) creates `advisor_reviews`, `advisor_checkin` and
`advisor_packets` (see "Advisor workflow"). The demo seed fills the first two from the scenario.
It backfills `advisor_reviews` from an existing store's rec defs (`def.advisor`) and the advisor
content row's `reviewed` items outside the plan, so an upgrade keeps every pending review and
verdict; the content row's `next` label shows until the owner sets a check-in.

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

`buildScenario(db, {clock, engineMode?, packs?})` in `src/scenario/build.mjs` returns the CONTRACT.md scenario with
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
   `series.<key>.<index>` (the point's kind, source the series `src` or `plan`; a real store's series carry `imported: true` and src `balances`, the "Account balances you uploaded" built-in source);
   `engine.budget.used` (a, `spend-ledger`), `engine.budget.monthly` (p, `settings`),
   `engine.budget.left` (e, `spend-ledger`), `engine.job.<jobId>.cost` (e, `job-estimates`,
   "Per-run cost estimate") and `engine.ledger.<id>.cost` (a, `spend-ledger`, label
   `<purpose>, <ts label>`) for each listed ledger row. Built-in sources cover these ids when the
   store has no row for them.
7. Ingest freshness: `live.ingest` is `ingestState(db, {clock})` from `src/ingest/freshness.mjs`.
   Each account gains `asOf` (its last data date, or ''), `fresh` (`fresh`, `stale` or `unknown`)
   and `sourceId` (its ingest source id, or null); demo accounts read '', `unknown` and null.
   `imported` is false only for demo seeded accounts; the UI renders every other account's name,
   institution, owner and note as plain escaped text, never through token resolution.
   `domains` pass through `applyFreshness`: a stale ingest source appends "<label> data is <n>
   days old. Export a fresh copy." to its domain's note, moves a `covered` domain to `waiting`, and
   adds the domain (status `waiting`) when the store has none with that id.

### Engine models

`engine.models` is `[{purpose, model}]` for chat, job, extract, title and confirm, read from
`modelFor(purpose)` in `src/engine/pricing.mjs` (the same function the engine calls), so the Engine
screen shows the configured model per purpose in demo and real mode. `engine.chat` stays a demo-only
content row (a note); an empty store serves it blank.

### The `live` key

```
live = {
  mode: 'demo' | 'real',
  demo: 'november' | 'fresh',          // see the live.demo rule below; the UI forces onboarding on 'fresh'
  engine: boolean,                      // settings.engine.on, default true
  onboardStep: int,
  picks: { salary: int, deferral: int },  // war-game selections; default the current/recommended point
  conversations: { <key>: [ { id, role, text, refs, ts, notice, provenance } ] },
  threads: [ thread ],                  // every Ask thread, archived and trashed included, newest lastAt first
  askStarters: [ { id, q } ],           // Ask starter questions whose condition holds, pinned order
  packs: { <id>: { active: boolean | null, exploring: boolean, whatIfDone: boolean } },
  yourPlans: { sources: [ { fileId, name, docType } ], files: [ { id, name } ], built: settings.yourPlans | null },
  clock: 'YYYY-MM-DD',
  heard: { sections: [ { id, title, items: [ heard item ] } ], deadlines: int, pending: int, empty: boolean },  // see Onboarding below
  ingest: {
    pending: int,                       // pending confirm items
    items: [ confirm item ],            // pending items, shape below, plus fileName (string or null) and
                                        // guess (null or {option, label, reason, model, ts})
    files: [ file ],                    // latest 50 files
    sources: [ { id, label, kind, asOf, lastIngestAt, cadence, state, ageDays, howTo } ],
    accounts: { <accountId>: { asOf, fresh, sourceId } },
    staleNotes: [ { domain, text } ],
    formats: [ how-to entry ]
  }
}
```

`yourPlans.sources` are the plan and benefits documents (a text-only document row is named
`document-<id>` with `fileId` null); `files` are the stored files a build can read (text or PDF).

Conversation keys are Ask threads (`ask:<id>`), rec ids, or `pack:<id>`; every stored
conversation is present. Message `id` is a
string (`m<rowid>`), `text` is token-bearing HTML source (paragraphs as `<p>...</p>`; resolve it
with `api.t` at read time), `refs` are rec ids, `ts` is a display label such as "Nov 5, 9:04 AM",
`notice` is true for every notice the answerer stores instead of an answer (engine off, off by
configuration, over the cap, model error). `provenance` is the stored answer provenance or null
(owner messages, notices and seeded messages). The demo seed opens each rec conversation with one
fathom message holding its summary.

### Ask threads

Ask is many conversations. A thread is a `conversations` row keyed `ask:<id>`, `<id>` 12 lowercase
hex characters; URLs and the thread routes use the bare `<id>` (anything else is 404). Thread JSON
is `{id, key, title, titleSource, createdAt, lastAt, archivedAt, trashedAt, turns}`: `title` is the
stored title or null (the UI shows "New conversation"), `titleSource` null, `auto` or `manual`,
`turns` the count of owner messages. A thread is active, archived (`archivedAt`), or in Trash
(`trashedAt`, which wins; trash keeps `archivedAt` so restore returns the thread where it was).
Asking in an archived thread unarchives it; asking in a trashed one is 409. Threads trashed 30 or
more days before the app clock are deleted with their messages (`purgeTrash`) by the daily `trash-purge` job (03:00); reads and server
starts purge nothing. Migration 010 moves the old single `ask`
conversation, when it has messages, into one thread with the same messages.

Naming (`src/api/threads.mjs`): after a reply is stored, a thread with no title source and at least
two owner messages each followed by a reply (a notice counts) is named once. The engine gets one
`title` call whose fixed system text holds no household data and whose one user message is this
thread's non-notice messages as plain text, newest last, at most 12 messages and 6000 characters.
The model title is trimmed, loses one pair of quotes and a trailing period, and is refused when
empty, over 60 characters or 8 words, with a line break, control character, `< > { }` or backtick,
or any digit, currency or percent sign, or spelled-out number or money word, or any word
(lowercased, with a plural `s`/`es` and a possessive `'s` folded) that is not a function word and
was not used in this thread's owner messages. Engine off, over the cap, any error or a
refused title uses the fallback: the first owner message as plain text (figure tokens removed,
other tokens resolved, tags stripped, entities decoded) cut to 48 characters at a word boundary.
The fake engine returns the fallback as its title. Writes only land while `title_source` is NULL,
so an owner rename (`manual`, 1 to 60 characters, digits allowed) always wins. Titles render
escaped.

`live.askStarters` lists, in this order and only when its condition holds: `attention` "What needs
my attention right now?" (a visible rec proposed, accepted or doing), `taxes` "How are our tax
payments tracking this year?" (any tax payment), `scorp` "How is the S corp doing this year?" (fact
`income.sCorp` true or any P&L line), `yearend` "What should we do before the year ends?" (always).

### The `live.demo` rule

`live.demo` is `november` when onboarding is done, or when the store is real and `hasData`
(`EXISTS (SELECT 1 FROM files) OR EXISTS (SELECT 1 FROM accounts)`); otherwise `fresh`. A real store
that already holds data is a returning owner and lands in the app, not first-run onboarding. Demo
stores follow onboarding alone.

### Onboarding

Onboarding is six steps (Sign in, Tell us, Accounts, Confirm, Priorities, First brief). Nothing in
it is fake or hand-written any more except the Accounts (connections) and Priorities steps, which
other items own.

Sign in. There is no passkey and no form. Identity is the owner gate (Owner identity above). The
demo build, which has no gate, shows step 0 as a line: "Signed in through your private network"
with the identity `GET /api/identity` reports, or "Reached through your private network" with a
note that the demo signs no one in. A real store skips step 0 (the first step is 1) and shows the
signed-in name in the page header; More shows it too.

Tell us. The text is saved by `POST /api/onboarding/notes` (`src/api/onboarding-handlers.mjs`) as a
file named `Setup notes <date>.md` (type `text/markdown`) through `ingestFile`, exactly the path of
an uploaded notes file: the bytes are stored encrypted in the vault, the notes parser writes the
`notes` document row (a reference, never the text), and with the engine on `extractDocument` reads
the redacted text, writes facts with provenance (`file_id`, parser `extract-notes`, locator) and
goal documents, and asks a `fact_check` Confirm card for a fact below the confidence floor. With
the engine off only the parser's deterministic path runs: the note is stored and the file waits
with status `needs_extraction` (retried from Confirm, Waiting files, once the engine is on);
nothing is extracted and nothing is invented. The same text saved twice is a `duplicate`. A
successful import triggers the plan and confirm-guess jobs, like an upload. The response carries
`understood` from `understoodOf` (`src/onboarding/heard.mjs`):
`{fileId, status, engineOn, waiting, facts: [{key, label, value, confirmed}], goals: [{title, when}], asked}`,
the stored rows that file wrote and the open questions it raised; the page shows it after the
save. A returning owner reaches the same step again as Setup in More (real stores only): the route
`#/onboarding` is allowed on a real store after first run, lands on step 1, shows Back to the app,
and finishing returns to the brief.

Confirm ("Here is what we heard"). `live.heard` is `deriveHeard(db, {clock})`: stored facts (filing
status, state, dependents and ages, expecting a child, income types, benefits, giving), entities
(the P&L entities) and accounts counted by kind, plus the count of deadlines in
the next twelve months and of open Confirm questions. A heard item is
`{id, key?, label, value, prov, confirmed, asked, edit: {route, step?, label}}`. `prov` names the
file the value came from (`From <file name>`), the planner, or the owner's own answer ("confirmed by
you"). `edit` is the Confirm deck when a question about that item is open, Accounts for accounts
and entities, and Tell us ("Correct in notes") otherwise, because a corrected note supersedes an
unconfirmed fact and raises a check against a confirmed one. A value of the wrong type is not
shown. `onboarding.heard` in the content table is no longer read. File-sourced text (file, entity
and account names) is rendered escaped, never as tokens or markup.

Seams. The Accounts step (item 22) and the Priorities step (item 20) are unchanged `else if (s === 2)`
and `(s === 4)` branches of `pOnboarding` in `web/horizon/design.js`; the Confirm step is
`heardHtml`, the Tell us panel `understoodHtml`.

## API

All JSON. On a real store every path except `/healthz` and `/mcp` first passes the owner identity
gate (see "Owner identity"), before the Host allowlist, route matching and static files. Every `/api` route (any path equal to `/api` or under `/api/`, including unknown paths,
wrong methods and the ingest upload and confirm routes) first passes the Host allowlist described
under "MCP server": a foreign `Host` gets 403 `{error: 'forbidden host'}` before route matching.
`/healthz` and static files are exempt. A deployment reached by a DNS name must set
`FATHOM_PUBLIC_URL` or `FATHOM_ALLOWED_HOSTS`. Every POST except `POST /api/files` requires
`content-type: application/json` (charset allowed), else 415; when an `Origin` header is present its
host must equal the `Host` header, else 403; bodies are capped at 64 KiB (413); malformed JSON or a
non-object body is 400. Errors are `{error: '<message>'}`. Unknown
paths under `/api` are a JSON 404 and a known path with the wrong method is 405. Every action
response is `{scenario, ...}` with the fresh scenario.

| Method and path | Body | Response |
|---|---|---|
| `GET /healthz` | | `{ok: true, schema: <latest migration id>}` |
| `GET /api/scenario` | | the scenario with `live` |
| `GET /api/identity` | | `{identity: {login, name} or null}`. The admitted owner: `login` is the trimmed `Tailscale-User-Login`, `name` the trimmed `Tailscale-User-Name` or else the login. Always `null` on a demo store. |
| `POST /api/recs/:id/action` | `{action: accept, start, snooze, dismiss, complete, reopen or task, arg?}` | `{scenario}`. `task` toggles task `arg`; `snooze` takes a wake label (default "Next month"). 400 bad action or task index, 404 unknown or hidden rec. Writes `rec_events` (actor `ui`). |
| `POST /api/wargame/:name/pick` | `{index}` (an index or an option id) | `{scenario}`. `name` is salary or deferral (404 otherwise); 400 out of range. |
| `POST /api/decisions/:id/decide` | `{index?}` (a point index or id; default the stored pick) | `{scenario}`. Decide on the picked point of an open salary or deferral decision: status becomes decided and `decided_line` is built from the point's own label plus `{f:...}` tokens for the `wg.*` figures the registry holds (provenance stays on the figures). Records the pick in `wargame.picks`, writes the owner-stated assumption fact (`business.salaryDecided` = `{entity, salary}`, the S corp the game was built for and the point's `wg.salary.<id>.salary` value, or `business.deferralDecided` = `{option, amount}`; src `decide:salary` or `decide:deferral`, confirmed, locator names the decision and the figure), logs a `decide` rec event on the linked rec and schedules the plan job (trigger `decide`) on a real store. 404 unknown id, 400 no war game or bad index, 409 already decided, not open, upcoming or unavailable. |
| `POST /api/decisions/:id/revisit` | `{}` | `{scenario}`. Reopens a decision decided that way: status open, `decided_line` cleared, the assumption fact deleted, a `revisit` rec event, plan job scheduled. 409 for a decision that is not decided with a stored choice. |
| `POST /api/packs/:id/toggle` | `{}` | `{scenario, status, note}`. Turning a pack on lifts its hidden recs to proposed; turning it off hides again only the recs it lifted that no other active pack powers. `note` is "Recommendations update on the next planning run." |
| `POST /api/packs/:id/whatif` | `{}` | `{scenario}`. Marks the pack exploring and appends the pack's what-if prompt and a live answer (with provenance) once to `pack:<id>`. A manifest-backed pack's prompt is literal text, stored escaped like free text (`whatIfOwnerText`); an illustrative demo prompt keeps its token form; a notice reply (engine off, over the cap, model error) is appended once and does not mark it done. |
| `GET /api/packs/:id/entries/:entryId` | | `{entry: {id, title, body, cites}}` for an entry of a manifest-backed pack row, from the loaded packs; 404 otherwise. |
| `POST /api/engine` | `{on: boolean}` | `{scenario}`; 400 when `on` is not boolean. |
| `POST /api/engine/cap` | `{usd}` | `{scenario}`. `usd` a finite number from 0 to 10000, rounded to cents and stored as `settings.cap`; anything else 400. |
| `POST /api/ask` | `{key: an Ask thread key 'ask:<id>', a rec id or 'pack:<id>', questionId? or text?}` | `{scenario, message}`. `key` is required (400 without it). Exactly one of `questionId` or `text`; empty text, both or neither are 400; unknown question or conversation 404; a thread in Trash 409. Appends the owner's message and the live answer with its provenance, or a notice; asking in an archived thread unarchives it, and a thread due a name is named before the response. New threads come only from `POST /api/threads`. With `Accept: text/event-stream` the answer streams as Server-Sent Events: `start` `{key}`, then `progress` `{label}` (a fixed plain label per tool), `text` `{text}` (raw model text, never grounded or stored) and `reset` `{}` (drop streamed text), then `final` with the JSON body above, or `error` `{status, error}`. Validation errors before the first event are ordinary JSON errors. |
| `GET /api/threads` | | `{active, archived, trash}`, each a list of thread JSON newest `lastAt` first. Purges old trash first. |
| `POST /api/threads` | `{}`, `{text}` or `{questionId}` (an Ask starter id) | `{scenario, thread, message?}`. Creates a thread; with a question it also asks it (validated like `POST /api/ask`; a starter's fixed text is the question) and returns the reply as `message`. Unknown starter 404. Streams like `POST /api/ask` on request. |
| `GET /api/threads/:id` | | `{thread, messages}` (messages as in `live.conversations`). A trashed thread opens too; 404 unknown or malformed id. |
| `POST /api/threads/:id/rename` | `{title}` | `{scenario, thread}`. Sets `title_source` `manual`; 400 invalid title; 404 unknown. |
| `POST /api/threads/:id/archive` | `{}` | `{scenario, thread}`. Sets `archivedAt`; 409 when trashed. |
| `POST /api/threads/:id/trash` | `{}` | `{scenario, thread}`. Sets `trashedAt`, keeps `archivedAt`. |
| `POST /api/threads/:id/restore` | `{}` | `{scenario, thread}`. Clears `trashedAt` when trashed, else `archivedAt`. |
| `POST /api/threads/:id/delete` | `{}` | `{scenario}`. Deletes the thread and its messages forever; 409 unless it is in Trash. |
| `POST /api/your-plans/build` | `{fileIds?: string[]}` (at most 50) | `{scenario, result: {written, entries, sources, warnings, dropped}}`. Builds the Your plans pack (`dropped` counts the extracted sections that did not match their document); 400 for a bad body; 409 while the engine is off, over the cap, or when the data directory is inside the repository. |
| `POST /api/onboarding` | `{step}` | `{scenario}`. 0 to 5 set the step, 6 completes onboarding; anything else 400. |
| `POST /api/onboarding/notes` | `{text}` | `{scenario, file, understood}`. Saves the Tell us note as a notes document through the ingest pipeline (see Onboarding below). 400 for a missing, empty or control-character text, 413 over 30000 bytes, 409 without a data key on a real store, 422 when the note could not be stored. The text never appears in an error, a log or the database. |
| `POST /api/demo/reset` | `{}` | `{scenario}`. Rebuilds the demo store and removes stored uploads (`$FATHOM_DATA/files/*.bin`); 404 unless the store is a demo store. Clears `api_keys`; the server secret file survives. |
| `GET /api/keys` | | `{keys: [{id, name, scopes, createdAt, lastUsedAt, revokedAt}]}` ordered by creation; never a key or hash. |
| `POST /api/keys` | `{name, scopes?: ('read' or 'write:recs')[]}` | `{key, record, keys}`. The only time the key is shown. Name trimmed, 1 to 80 characters, no control characters; scopes always include `read`; else 400. |
| `POST /api/keys/:id/revoke` | `{}` | `{record, keys}`. Sets `revokedAt` once (a second revoke keeps it); 404 unknown id. |
| `GET /api/mcp` | | `{url, publicUrlSet, tools: [{name, description, scope}], scopes: [{id, label, access}]}`. `url` is `FATHOM_PUBLIC_URL` with `/mcp` appended unless it already ends in it, else `<proto>://<Host>/mcp` with proto from `X-Forwarded-Proto` (http or https only), then the socket. |
| `POST /api/files` | multipart/form-data, field `files` (one or more) | `{scenario, files: [result], pending}`. A result is `{fileId, name, status, sourceKind, parser, counts, duplicateOf?}` with status `imported`, `duplicate`, `needs_mapping`, `needs_extraction`, `unsupported`, `too_large` (past a parse limit, see Ingest) or `failed`. 400 no files or malformed body, 409 a real store without `FATHOM_DATA_KEY_FILE` (nothing stored), 413 over a size cap, 415 not multipart with a boundary. |
| `GET /api/files` | | `{files: [{id, name, status, sourceKind, parser, counts, uploadedAt}]}`, newest first. |
| `POST /api/files/:id/retry` | `{}` | `{scenario, file: result}`. Routes a `needs_mapping` or `needs_extraction` file again under the same id; 404 unknown file, 409 a file that is not waiting. |
| `GET /api/confirm` | | `{items: [pending confirm items]}`. |
| `POST /api/confirm/list` | `{status?: pending (default), answered or all}` | `{items}`; 400 for another status. |
| `GET /api/confirm/:id` | | `{item}` with `item.final`, pending or answered; 404 unknown item. The Confirm deck reads it after a lost answer reply to retry only an item that is still pending. |
| `POST /api/confirm/:id/answer` | `{answer: optionId, revise?: true}` | `{scenario, item}` with `item.final` (null or the reason it is final). 404 unknown item, 400 an option not offered, 409 already answered or stale (the value changed since the question was asked). Confirm refusals carry `code` (`stale`, `answered`, `not_answered`, ...) next to `error`. A planner fact check records the notes value it was asked against (`context.stored`) and is stale only when that fact changed. On a real store an answer, a reopen or a stale refusal schedules the plan job (trigger `confirm`): 30 s after the last answer of a burst, or at once when no question is left pending. With `revise: true` it changes an answered item's answer instead: 409 "that question is not answered yet" for a pending item, and 409 with a fixed one-line message when the answer is final (see "Confirm queue"). |
| `POST /api/confirm/:id/reopen` | `{}` | `{scenario, item}`. Puts an answered item back to pending and restores every row its answer changed. 404 unknown item, 409 not answered, stale or final, as for a revise. |
| `GET /api/email` | | `{status: {transport, state, recipient, recipients, detail}, preview: {subject, text, html, summarySrc}, history}`. `recipient` is masked (`o***@e***.invalid`); `history` is `email_sends` rows newest first with no bodies. The preview is the brief composed now over the store with the runtime engine (template summary when the engine cannot answer). |
| `POST /api/email/test` | `{}` | `{send, history}`. Sends a fixed test email (kind `test`) through the configured transport; a failed send is a 200 with `send.status` `failed` and `send.errorCode`. |
| `POST /api/email/brief` | `{}` | `{send, history}`. Composes and sends the brief now (kind `brief`); failures as above. |
| `POST /api/advisor/reviews` | `{recId}` | `{scenario, reviewId}`. Sends the rec to the advisor (idempotent while it waits; a reviewed rec sent again closes the old verdict). 404 unknown or hidden rec. |
| `POST /api/advisor/reviews/:id/verdict` | `{verdict: 'confirmed' or 'vetoed', note, date: 'YYYY-MM-DD'}` | `{scenario}`. Records the advisor's verdict; a veto dismisses the rec through the rec action path (event `dismiss`, arg `advisor vetoed`). 400 bad verdict, note over 1000 characters or bad date, 404 no open review, 409 already has a verdict. |
| `POST /api/advisor/checkin` | `{date, time?: 'HH:MM', lengthMin: 5..480}` | `{scenario}`. Sets the next check-in. |
| `POST /api/advisor/packets` | `{}` | `{scenario, packetId}`. Builds the review packet for every waiting review and stores it encrypted. 409 when nothing waits or a real store has no data key. |
| `GET /api/advisor/packets/:id` | | The stored packet as `text/html` with `Content-Disposition: attachment`, the one non-JSON API response. 404 unknown id. |
| `GET /api/jobs` | | `{jobs: [{id, name, cadence, does, lastRun, next, nextAt}], runs, timezone}`. Only jobs with a handler are listed; `runs` are recent `job_runs`. |
| `POST /api/jobs/:id/run` | `{}` | `{scenario, run, jobs}`. Runs the job now through the scheduler under the lease (trigger `manual`); `run` is the scheduler's run (`{id, jobId, status, trigger, periodKey, startedAt, finishedAt, durationMs, errorClass, costUsd, note}`) and `scenario` the fresh scenario. `POST /api/jobs/plan/run` is this route: the manual planning run with the server's runtime engine and clock; on a demo store it answers 409 `{error: 'planning runs on real stores only'}` before the scheduler, leaving the store unchanged. 404 unknown job, 409 already running or the lease is held by another scheduler. |

Key responses carry no `scenario`, the one exception to the rule above.

Uploads: `POST /api/files` takes `multipart/form-data` with a boundary (else 415) under the same
Origin rule as JSON posts. A request is capped at 200 MB (`UPLOAD_REQUEST_LIMIT`) and each file at
50 MB (`UPLOAD_FILE_LIMIT`) in `src/api/upload.mjs`; a declared `Content-Length` over the request
cap is refused with 413 and `Connection: close` before the body is read, and both caps are
enforced again while the body streams. Error messages name the limit, never contents. File names
keep only their base name (directories of either slash style stripped), at most 255 characters.
The parser has no dependencies. Every other route keeps the 64 KiB JSON cap. Errors on ingest
routes log `fathom: ingest request failed` and an error code only, never the error object; errors
on the email and jobs routes log `fathom: request failed` and a code the same way. An upload with
any `imported` result, and a retry whose file ends `imported`, call
`ctx.scheduler.trigger('plan', 'ingest')` without waiting; a trigger failure logs a code and never
fails the request.

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
API responses also set `Cache-Control: no-store`.

### Owner identity

Trust model. The app is reached through `tailscale serve`, which proxies each request and adds
`Tailscale-User-Login` and `Tailscale-User-Name` for the signed-in tailnet user. On a real store
(`settings.mode` is not `demo`, so a store with no mode row is real) every page, static file and
`/api` route requires a `Tailscale-User-Login` listed in `FATHOM_OWNER_LOGINS` or
`FATHOM_OWNER_LOGINS_FILE`, compared trimmed and case-insensitively; a header Node joined from
duplicates never matches. `src/api/identity.mjs` holds the check and the router runs it once, first,
for every path except exactly `/healthz` (open for probes) and `/mcp` (bearer keys only; it never
reads the identity header). Demo stores are open. With no usable list (unset, blank, both keys set,
an unreadable file) the gate fails closed: startup logs one `fathom:` line naming the problem (never
the file contents, path or error) and every gated request is 401. A refused `/api` request gets
`{error: 'unauthorized'}`; any other path gets a static Not authorized page with
`Cache-Control: no-store` (no body for HEAD). Neither echoes the header. Handlers see the admitted
identity as `ctx.identity` (null on a demo store).

`tailscale serve` strips any client-supplied `Tailscale-User-*` headers, whatever their case, before
adding its own, so a tailnet client cannot forge them through it. Tagged nodes (every agent host)
get no login header, so only the owner's own devices pass the gate.

Limit. The header is trustworthy only when the sole path to the app is `tailscale serve`. Anything
that reaches the pod, its Service or a port-forward directly could forge it. The homelab deployment
keeps ingress default-deny and binds its port-forward to loopback only; a misconfigured Service or a
second ingress would break this. Known limit, with no code fix: any local process on the serving
host can reach that loopback port-forward directly and send a forged header. It is recommended for
acceptance; the owner has not decided yet. The Host allowlist still applies after the gate, so the tailnet
name must be allowed through `FATHOM_PUBLIC_URL` or `FATHOM_ALLOWED_HOSTS`. Scripts that post
without the header (such as `scripts/dump.mjs`) get 401 from a real-mode server unless they go
through `tailscale serve`.

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
   `ctx = {db, now, dataDir, clock}`.

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

## Advisor workflow

The owner runs the advisor review (`src/advisor`); there are no advisor accounts or logins.
Sending a rec opens an `advisor_reviews` row; recording the advisor's verdict fills it. The scenario
builder sets each rec's `advisor` (`null`, or `{verdict: 'pending'|'confirmed'|'vetoed', note,
date, reviewId}`) from the open rows, never from the rec def, and builds `advisor` from the
`content` row's narrative keys (`name`, `role`, `agenda`, `notAsking`, `shared`, `experts`) plus
the tables: `next` (`{when, length, date, time, lengthMin}`), `reviewed` (newest first, with
`date` and `reviewedOn`), `pending` (rec ids, CONTRACT shape), `waiting` (`[{reviewId, recId,
title, sent, sentOn}]`) and `packets` (`[{id, createdAt, date, recIds}]`). Demo and real stores
share this path: `demo/seed.mjs` writes the tables and strips `next`, `reviewed` and `pending` from
the content row and `advisor` from rec defs.

Planner persistence: a vetoed rec is dismissed by the owner's action, so `applyRecs` keeps it
dismissed on later runs, and a confirmed verdict lives outside the rec def, so reruns keep it.
`liftStaleVetoes` runs in the planner's write transaction after `applyRecs`: a veto on a planner
rec whose `planner_recs.grounding_hash` (figures, window and variables behind the rec) differs from
the hash recorded with the verdict is closed with `inputs changed`, and the rec returns to
`proposed` (event `advisor_veto_lifted`, actor `planner`) when the veto's dismiss is still its last
status change.

The review packet (`src/advisor/packet.mjs`) is one self-contained HTML document with no scripts or
external resources: a household summary, each waiting rec with its why-now, figures, steps,
knowledge sources and questions for the advisor, the figures' stated assumptions, and a numbered
note for every figure (value, label, kind, source, as of). Figures come only from the scenario's
stored or derived figures; statutory amounts and rates (`{l:}`, `{p:}`) cite the `law` and `pct`
content rows' source (`contentSources`: a sources row, an imported file, or the planner's tax
calculator parameters). Any token whose source is unknown renders as "figure unavailable".
All stored text is reduced to plain text and escaped. The owner downloads it and prints to PDF
from the browser. Packets are stored with the vault's AES-256-GCM under the data key and listed on
the Advisor screen for re-download. The packet is not emailed.

## Seams later items plug into

1. Answerer: `src/api/answerer.mjs` exports `createLiveAnswerer({engine, packs})` returning
   `{answer({db, key, questionId?, text?, clock?}), whatIf({db, packId, clock?})}`, each resolving to
   `{paragraphs, refs, notice?, provenance?}` (`answer` is null for an unknown `questionId`).
   `src/server.mjs` constructs it and the router passes it to handlers as `ctx.answerer`. Every Ask,
   rec conversation, pack follow-up and What if goes through it; the ask endpoint words the owner's
   question itself from `src/api/questions.mjs`. See "Chat over the data" below.
2. Packs: `src/packs/state.mjs` rewrites the base fields of `packs_state.def` from loaded
   manifests and `activePacks(packs, facts)` in real stores; overrides in `packs_state` keep
   working. `src/packs/live.mjs` adds the manifest view the UI and answerer read. See "Live pack
   state" below.
3. Ingest: parsers write rows with provenance into the ledger tables, `facts` and `files`; figures
   and sources follow from them. Narrative `content` rows are replaced as data takes over. See
   "Ingest" below.
4. Engine: `src/engine` records spend in `spend_ledger`, which already feeds `engine.budget.used`,
   and reads the cap from `settings.cap`. See "Runtime engine" below.
5. MCP: `src/mcp` exposes `src/tools` at `POST /mcp` with scopes checked against `api_keys` (see
   MCP server above). `src/server.mjs` loads the server secret, builds the key service
   (`createKeyService`) and `createMcpHandler`, and passes both to `createHandler`, which builds
   them from `config.dataDir` on first use when they are not passed. New tools added to the
   registry appear on `/mcp` under their scope with no further wiring.
6. Jobs: `src/jobs` schedules from `jobs` and records `job_runs`; see "Jobs" below. The router
   passes the scheduler to handlers as `ctx.scheduler` (null when it could not be built).
7. Email: `src/email` sends through `FATHOM_EMAIL_TRANSPORT` and the router passes the transport
   as `ctx.transport`; see "Email" below.

## Jobs

`src/jobs/scheduler.mjs` runs in process. `src/server.mjs` builds it after the engine is
initialized with `createScheduler({db, config, engine, handlers: defaultHandlers({publicUrl}),
transport})`, starts it once the server listens (a start failure logs a code and the server still
serves) and stops it before closing the store.

1. Periods are computed in the owner's zone (`settings.timezone`, default `America/New_York`; an
   invalid zone falls back to the default). `plan` daily at 02:00 (key `YYYY-MM-DD`),
   `brief-email` monthly on the 1st at 07:00 (`YYYY-MM`), `deadline-alerts` daily at 07:00
   (`YYYY-MM-DD`), `trash-purge` daily at 03:00 (`YYYY-MM-DD`), `freshness` weekly on Monday at 06:00 (that Monday's date), `confirm-guess`
   daily at 03:00 (`YYYY-MM-DD`). The due key is the
   latest period whose start is at or before now. With `FATHOM_CLOCK` set, the clock date at 12:00
   is now, so every period of that day is due.
2. Idempotence: one attempt per (`job_id`, `period_key`), enforced by the unique index. A failed
   run is not retried for the same period. Manual runs use `manual:<iso ts>` and ingest triggered
   runs `ingest:<iso ts>`.
3. Catch-up: each tick (every minute) runs a job only when its latest due key has no row, so a
   restart runs at most the latest missed period of each job, never a backfill.
4. Lease: `job_lock` holds one row (holder, expires_at), a 5 minute lease renewed each tick. A
   scheduler without the lease runs nothing, and a manual run without it is 409. While any handler
   runs, a timer renews the lease every third of its length, but only while this scheduler still
   holds it, so a long run never loses the lease to another scheduler.
5. Handlers: `(ctx) -> {costUsd?, note?, status?: 'skipped'}` with ctx `{db, config, engine,
   transport, now, clock, periodKey, trigger, jobRunId}`. Only jobs with a handler are scheduled
   and listed, but every `JOBS` entry has a row in the `jobs` table even before its handler is
   wired (with no next label). A run's row goes `running` then `ok`, `skipped` or `error` with `finished_at`,
   `duration_ms`, `error_class` (identifier only), `cost_usd` and a counts-only `note`: numbers and
   booleans with identifier keys, at the top level or in an object one level down (the planner's
   `recs` and `prose` counts); strings, arrays and deeper values are dropped.
6. Engine: every model call goes through the runtime engine. With the engine off, over its cap, in
   fake mode with no script, or when the summary fails grounding, the brief uses its template
   summary and still sends.
7. Plan job: `defaultHandlers` includes `plan`, the only code path that plans. Nightly, manual
   (Run now, `POST /api/jobs/plan/run`, `npm run plan`) and ingest (`trigger('plan', 'ingest')`
   after an import) runs share it, the lease and `job_runs`. On a real store it calls
   `runPlanning(db, engine, {now: ctx.clock, packDirs: defaultPackDirs(dataDir), runId:
   ctx.jobRunId})` and returns the planner's cost and its counts as the note. On a demo store it
   plans nothing: scheduled and ingest runs are recorded `skipped`, and a manual run over HTTP is
   refused with 409 before the scheduler, so nothing changes. `npm run plan` builds a scheduler
   with only the plan handler and runs it now; it exits 3, telling the owner to use Run now in the
   app or `POST /api/jobs/plan/run`, when another process (the running server) holds the lease.
8. Confirm-guess job: `defaultHandlers` includes `confirm-guess`, the only code path that asks the
   engine for confirm guesses. Nightly at 03:00, manual (Run now, `POST /api/jobs/confirm-guess/run`,
   `npm run confirm:guess`) and ingest (`trigger('confirm-guess', 'ingest')` beside the plan trigger
   after an upload or retry imports a file) runs share it. It calls `guessPending(db, engine, {now:
   ctx.now})` until nothing is left. When that skips (engine off, not a live engine, nothing
   pending) the run is `skipped` with note `{pending}`; otherwise it is `ok` with the batch cost
   sum and note `{batches, items, guessed, stopped}`, also when an engine error stopped it.
   `npm run confirm:guess` builds a scheduler with only this handler, runs it now and prints one
   JSON line `{status, note}`; it exits 1 when there is no store and 3 when another process holds
   the lease.
9. Triggers during a run: `trigger(jobId, reason)` for a job that is already running remembers the
   request, and when the current run finishes exactly one more run starts with that reason, so
   several triggers during one run coalesce into one rerun. `trigger` never rejects.
10. Stop: `stop()` is graceful and never rejects. It stops ticking, refuses new runs (409) and
   drops queued reruns, waits for active runs to finish (at most `drainMs`, default 30 seconds),
   then releases the lease; the server awaits it before closing the store.

## Email

`src/email/transport.mjs` reads addresses and the credential from their files at send and status
time (never from `src/config.mjs`) and exposes `createTransport(config)`, `emailStatus(config)`
and `maskAddress`. `src/email/send.mjs` sends and records every attempt in `email_sends`.

1. Transports: `dev` (default) writes each message as a JSON file in `$FATHOM_DATA/outbox`
   (directory 0700, file 0600) and sends nothing; `smtp` uses nodemailer (465 TLS or 587
   STARTTLS with TLS required); `resend`, `postmark` and `agentmail` use the providers' HTTPS
   APIs. AgentMail is the production target: `FATHOM_EMAIL_FROM` is the inbox id.
2. Credential: `FATHOM_EMAIL_CREDENTIAL_FILE` names the API key or SMTP password file. Like the
   engine credential it must not be readable by other users: a file that other can access is refused, so a
   mounted secret needs mode 0400 or 0440 (with fsGroup) or 0600. A missing, unreadable, empty or
   other-readable file is `missing_credential`. The credential never appears in a response, log or error.
3. Send codes: a failed send is recorded with status `failed` and one fixed code:
   `missing_config`, `missing_credential`, `auth`, `not_found`, `rate_limited`, `invalid`,
   `rejected`, `network` or `other`. No key, body, address or provider response is logged.
4. Brief: `src/email/brief.mjs` builds the monthly brief from the scenario: the verdict, the recs
   that need the owner, deadlines in the next 60 days, stale sources and engine spend. Every amount
   printed is a stored figure with a footnote marker, and a Figures section lists each one with
   its label, kind, source and as-of date. The summary paragraph may come from the engine, which
   may name amounts only as `{f:key}` tokens from the brief's figure set; any digit, `$`, `%`,
   "percent" or number word outside a token, or a grounding failure, falls back to the template
   summary. The HTML uses inline style attributes only (no `<style>`, no scripts).
5. Alerts: `src/jobs/alerts.mjs` alerts on deadlines and rec windows closing within 14 days at
   the thresholds 14, 7 and 1 days. A deadline linked to a rec and that rec's window share the
   key `rec:<id>:<date>`; an unlinked deadline is `deadline:<date>:<hash of the normalized
   title>`. Recs that are done, dismissed or hidden are skipped. Due alerts go out as one email,
   and `deadline_alerts` rows are written only after it is sent, so each (key, threshold) alerts
   once.
6. The Email screen (`web/horizon/screens/email.js`) shows the transport state and masked
   recipient, Send test email and Send brief now, the brief preview in an iframe with an empty
   `sandbox` attribute filled through `srcdoc`, the send history and the jobs with Run now.
7. Live check: `FATHOM_LIVE_EMAIL=1 npm run email:test` sends one test email through the
   configured transport and prints only the status and code; without `FATHOM_LIVE_EMAIL=1` it
   refuses (exit 2). Never run it in CI.

## Runtime engine

`src/engine/runtime.mjs` (frozen, from the ingest work) exports `createSpendLedger(db)`,
`DEFAULT_CAP_USD` and `createRuntimeEngine({db, config, now?})` returning `{mode, init(),
credentialState, isOn(), call(request), extract(request)}`. `src/server.mjs` builds ONE runtime per
process, so accounting poison lasts for the process, and awaits `init()` once at startup.

1. Ledger adapter: `monthSpendUsd` takes `'YYYYMM'` or `'YYYY-MM'`; `record({ts, purpose, costUsd,
   model, tokens})` stores `yyyymm` from `ts`, the cost at full precision and the usage counts as
   `tokens`. The Engine screen reads `spend_ledger` itself (`loadLedger` in `src/scenario/build.mjs`).
2. Runtime: before every call it throws `EngineOffError` when `settings.engine.on` is false and
   re-reads `settings.cap.usd` (default 200; a malformed cap reads 0), rebuilding the inner engine
   when the cap changes. `isOn()` is `config.engine !== 'off'`, no accounting poison and the switch
   on. The server passes `now` as the scenario clock date (`FATHOM_CLOCK`, else `settings.clock`,
   else today) at the current UTC time (`clockNow` in `src/scenario/build.mjs`), so spend lands in
   the month the Engine screen shows; `scripts/build-your-plans.mjs` does the same.
3. `createEngine` takes three optional per-call request fields: `fake`, a script list used in fake
   mode instead of the constructor queue (a fake call with neither throws `ModelCallError`);
   `toolContext` `{db, now}` for that call's tools (the answerer passes the store and the clock
   time); and `systemDynamic`: the SDK system prompt is `[system, engine rules,
   SYSTEM_PROMPT_DYNAMIC_BOUNDARY, systemDynamic]`, so `system` is prompt cached and the dynamic part
   is not; the Messages round sends it as a second, uncached system block; the unknown-cost
   estimate counts it.
4. Live mode reads `FATHOM_CLAUDE_CREDENTIAL_FILE` exactly once, in `init()`; `credentialState` is
   `loaded`, `failed` or `none`. After a failure the server logs "fathom: engine credential
   unavailable" and every live call throws `ModelCallError` before any spend. Credential contents
   and read errors are never logged.

## Chat over the data

`src/api/answerer.mjs`, with the deterministic fake answer source in `src/api/fake-answers.mjs`.

1. Before a model call: off by the switch answers with the engine-off notice, off by configuration
   with "The engine is off in this deployment's configuration, so answers are paused." The answerer
   then reads `household_summary` (tool time is the scenario clock), and for a rec conversation the
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
   for other surfaces; chat never writes). In Ask threads and rec conversations the answerer adds one
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
   `$8.7 million` and `$8,700,000`, never `$8.70` or `8.7`. A scaled quantity followed by a percent
   sign or the word `percent` (`1 thousand percent`) is one percent quantity of the full value on
   both sides, so it needs percent evidence, not number evidence. Number-word phrases (`two million`)
   are still read word by word, and one followed by a percent sign (with or without a space) or the
   word `percent` (`one thousand %`) is likewise a percent quantity that needs percent evidence.
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
   invented amount is marked unverified after the retry. In Ask threads and rec conversations, free text
   that is an explicit command (`^(please\s+)?(accept|start|complete|dismiss|snooze|reopen)\b`)
   naming a rec (the rec conversation's own rec, or in an Ask thread a visible rec's id or exact title)
   adds a `propose_recommendation_action` call to the tool round, and the text round says the owner
   can confirm it below. Negations and questions ("Do not mark anything done", "Should I dismiss
   this?") never match.

### Answer provenance

Stored in `messages.provenance` and returned on the message: `{engine: mode, model, tools: [{name,
args}], figures: [figure keys], packIds: [active manifest ids in the prompt], packEntries: [entry
titles named in the answer], literals: [{text, source}], grounding: {ok, retried, unverified:
[texts]}, costUsd, proposal?: {recId, action, wake?}}`. No prompt text is ever stored.

## Live pack state

`src/packs/state.mjs` (frozen, from the ingest work) owns the stored pack rows: see "Facts helper
and pack state" under Ingest. `src/packs/live.mjs` builds the live view on top of it:

1. `yourPlansDir(dataDir)` is `<dataDir>/packs/your-plans`. `loadLivePacks(dataDir)` returns
   `{packs, dirs, warnings}`: the repository packs (any error throws) plus the Your plans pack when
   it loads; a broken one is skipped with a warning that carries none of its contents.
2. `refreshLivePacks(db, {dataDir, now?})` runs `refreshPackState` over those dirs (real stores;
   rows are keyed by manifest id) and, in a demo store, inserts one row for each loaded pack that
   no row backs (in practice the Your plans pack; the seed holds the repository packs). Startup,
   demo reset, the Your plans build action and `npm run build:your-plans` call it. Ingest calls
   `refreshPackState` itself after facts change; nothing refreshes per request.
3. `createLivePacks(db, {dataDir})` returns `{loaded(), backing(rowId, def), view(rowId, def),
   entry(rowId, entryId), refresh()}`. `loaded()` reloads when `settings['packs.generation']` or the
   Your plans directory changes, so a build in this process or the CLI shows on the next request.
   `backing()` is the loaded pack whose id is `manifestIdOf(rowId, def)` (`src/packs/index.mjs`):
   `def.manifest` (the tag on demo rows) or else the row id, the same link the MCP pack tools use. `view()` is the row def plus the backing manifest's `covers`, `entries` (count), `entryList`
   `[{id, title, cites}]`, `curator`, `version`, `taxYear`, `reviewed` and `whatIf.prompt`, with
   `manifest` set to its id and `why` from `activePacks` over the stored facts (escaped, as
   `refreshPackState` stores it; the UI renders manifest-backed text literally, so a seeded demo
   `why` with tokens would show them raw); the row's name, base status, `recIds` and what-if
   answers stay.
   The server passes it to handlers as `ctx.packs`, and `buildScenario(db, {packs})` applies `view()`
   to every scenario pack. The answerer uses it for the active manifest packs and pack
   conversations, and `GET /api/packs/:id/entries/:entryId` uses `entry()`.
4. The demo seed tags its seven manifest-backed packs with `manifest` and `label` (the demo name);
   migrations 005 (`manifest`) and 006 (`label`) apply the same tags to existing demo stores only. Demo pack rows keep their
   seeded base status, since `refreshPackState` leaves demo stores alone.

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
   Stored files are read the way ingest reads its own uploads: through the vault
   (`readStoredFile`, `stored_path` must be `files/<id>.bin`, the file id is the associated data)
   under the data key, which the builder takes as `key` (the API handler and the CLI load it with
   `loadDataKey` from `FATHOM_DATA_KEY_FILE` or the demo store's generated key, as the ingest
   handlers do; a missing key is a 409 or a CLI failure with the vault's message). A file that
   fails authentication, or cannot be read, is skipped with a warning naming it, and nothing from it
   reaches the engine. Text (`text/*`, `.md`, `.txt`) is read as UTF-8. A PDF (`application/pdf`
   or `%PDF-` magic) is read through ingest's `pdfText`: with a text layer, its pages (separated by
   a form feed in `pdfText`'s text) go to the engine as one text document with a `Page N` line
   opening each page; an `image_only` PDF is skipped with one warning that it has no text layer,
   and an `incomplete` or `failed` one with one warning that its text layer could not be read,
   both before any model call. Anything else warns. Warnings never carry document text.
3. Each source goes through `engine.extract` with rows `{title, body, excerpt, page, taxYear?}`,
   `excerpt` the verbatim source text the row is drawn from. Extracted entries must match the
   document. Each source is checked as a list of page texts with no page markers in them: a text
   source split on its own `Page N` marker lines with the marker lines removed (text before the
   first marker is page 1), a PDF split at its text layer's page boundaries without the generated
   `Page N` labels the engine sees. A row is kept only when (a) its excerpt, whitespace-normalized
   (runs collapsed to one space, trimmed), is a nonempty substring of a single page's normalized
   text;
   (b) every number in its neutralized title and body is in the excerpt, without the prose
   exemptions of `checkGrounding` (bare years, dates): every digit run of the title and body must
   be a digit run of the excerpt, with thousands separators removed on both sides (1,500 and 1500
   are the same run) and a date or year taken as its digit runs (2026-12-15 is 2026, 12 and 15);
   `checkGrounding` with the excerpt as the only data must also pass, where a number word counts
   when the excerpt has the same words with the same unit kind (percent-marked or not). So "The benefit is 2099 dollars" from a numberless source
   is dropped; and (c) that page's number is `row.page`. A marker line or generated label is
   therefore never an excerpt or numeric evidence, an excerpt spanning a page boundary is dropped,
   and a `Page N` line printed inside a PDF page is ordinary page text that never moves the page
   check. Every dropped row is counted in `dropped`, a warning per source says
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

## Ingest

The "dump everything" flow: the owner drops any mix of exports and documents, each file is stored
encrypted, routed to a parser, a mapping or an extraction, deduplicated against what is stored,
and anything ambiguous becomes a short question in the confirm queue.

### Pipeline

`src/ingest/pipeline.mjs` exports `ingestFiles(db, files, {engine, config, now, key})` returning
`{results}`, `ingestFile(db, file, opts)` and `retryFile(db, fileId, opts)` (errors carry
`status` 404 for an unknown file and 409 for a file that is not waiting).

1. File id is `f-` plus the first 24 hex characters of the content SHA-256. Identical bytes are a
   `duplicate` of the stored file (`duplicateOf`), and nothing is imported again.
2. The encrypted bytes are stored first, then a `files` row, then the file is routed: a known
   parser (`pickParser`), else an unknown table (`readTable` then `mapTabular`), else a PDF or
   UTF-8 text (`extractDocument`), else `unsupported`. Markdown notes keep the notes parser's
   document as a reference to the encrypted file (`fields: {ref: fileId, sha256, chars, lines}`,
   never the text) and are then extracted as `notes` from the decrypted bytes (on retry, from the
   vault).
   Parsing is bounded by `src/ingest/format.mjs` `LIMITS` (200000 rows, 512 columns, 2000000
   cells, 32768 characters per cell; CSV sniffing reads only the header within 64 KiB).
   Workbooks use `XLSX_LIMITS` for cells (250000 worksheet cells, shared strings and rich-text
   runs together) and are checked on their raw XML bytes before any part is read; the metadata
   parts read into a tree (`xl/workbook.xml` and its rels) have their own budget of 20000
   elements each, and an unknown xlsx table is budgeted as filled rows times header width
   against `LIMITS.cells` before its rows are widened. A reader past a limit throws `LimitError` (`limit_exceeded`); the pipeline
   records the file as `too_large` with note `limit_exceeded` and counts `{warnings: 1,
   warningCodes: {limit_exceeded: 1}}`, keeps its encrypted bytes and stores nothing else.
3. Rows get `dedupe_key`s (`src/ingest/dedupe.mjs`) and provenance (`file_id`, `parser`,
   `locator` JSON); `transactions.occurrence` keeps the occurrence counter. A transaction with an
   `externalId` (check or slip number, or a mapped column) is keyed
   `[accountKey, 'ext', externalId, signed cents, occurrence]`, with no date (occurrence only for
   a repeat within one file). A key collision from another file compares descriptions. From the
   same parser, equal normalized descriptions are a duplicate. From another parser, equal
   normalized descriptions or a shared distinctive word are a cross-format duplicate (archived as
   `duplicate_cross_format`; `counts.crossFormat` when only a word is shared). Any other
   description stores a second transaction under `<key>:d:<16 hex of the description hash>` and
   asks `near_duplicate` whatever the distance between the dates, once per pair even when the
   three-day proximity question also applies. When the collided key holds no active row, the
   question pairs the new row with the active row reached by following the `survivor_key` links of
   `duplicate_confirmed` tombstones (bounded; a cycle, self link or missing survivor asks
   nothing). Accounts are upserted
   by `identity` (`acct-` plus 16 hex of its hash), with `mirror` `manual` and masks of 4 digits
   only.
4. Revisions: P and L and tax workbook rows carry a `source_slot`; a later workbook replaces the
   rows of every slot in its `files.coverage` (changed amounts archive as `revised`, missing rows
   as `removed`). Balances and positions compare `files.period_to`: a newer file wins
   (`revised`), an older one is archived as `older_snapshot`, equal values advance provenance.
   A positions file, or a statement extraction with a `holdings` key (a `snapshot` row), is a
   complete snapshot per (account, as-of): stored positions it omits are archived as `removed`
   and deleted when it holds period authority. A warning other than `pending_activity` or
   `invalid_cost_basis` makes the account it names incomplete, or the whole file when it names
   none; an incomplete snapshot never removes. A recipient answer that rekeys withholding onto
   a row of the same recipient archives the newer as `duplicate` when the amounts are equal; a
   different amount, at rekey or at import, keeps both and asks `withholding_conflict` (never `revised`). A W-2 or 1099 row of a
   known recipient that lands in the slot of an active row of the same form type from another file under another key (the
   payer identity includes the income amount) also asks `withholding_conflict`, equal amounts or not. Withholding slots are
   `wh:<employer or payer key>:<taxYear>:<jurisdiction>:<recipient>`; W-2 withholding summarizes paystub
   withholding in the same slot (`summarized`) only once the recipient is known, at import or
   when a recipient answer recomputes the slots. Every replaced row is kept in `superseded_rows`.
5. Each file records `parser`, `source_kind`, `source_id`, `period_from`, `period_to`, `status`
   and `counts` JSON `{rows: {kind: n}, duplicates, crossFormat, revised, superseded, incomplete,
   warnings, warningCodes: {code: n}, queued, extractPath?}`; `extractPath` (`text`,
   `pdf_text_layer`, `pdf_document` or `pdf_withheld`) is set when extraction ran. Ingest sources (`sources` ids starting `ing:`) keep the latest `as_of`
   and `last_ingest_at`; account balance figures follow the latest stored balance, else the
   holdings total at the latest as-of date, else 0 from a complete empty snapshot dated after
   every stored position.
6. When facts change, `refreshPackState` runs. The pipeline logs only an error code.

### Encryption at rest

`src/ingest/vault.mjs`: every uploaded file is stored as `$FATHOM_DATA/files/<id>.bin` (mode 0600,
directory 0700, written atomically) in AES-256-GCM: `FTHM1`, a 12 byte IV, the ciphertext and the
16 byte tag, with the file id bound as additional data. `loadDataKey({dataDir, keyFile, mode})`
reads `FATHOM_DATA_KEY_FILE` (32 raw bytes, 64 hex characters or base64 of 32 bytes; symlinks
refused). A real store without the key file refuses uploads with "uploads need
FATHOM_DATA_KEY_FILE: set it to a file holding a 32 byte key" (HTTP 409). A demo store generates
`$FATHOM_DATA/files/demo.key` on first use. `clearStoredFiles(dataDir)` removes `*.bin` only.

### Mapping unknown tables

`src/ingest/mapping.mjs`: a CSV or workbook sheet with no parser is identified by
`header_signature` (SHA-256 of its normalized headers). A stored `column_mappings` row is applied
by code with no model call; otherwise the engine proposes a mapping from the headers and at most 5
redacted rows, which is validated (`MAPPING_SCHEMA`, every column present, required columns per
target) before it is stored and applied. With the engine off or an invalid proposal the file is
`needs_mapping` and can be retried.

### Extraction with redaction

`src/ingest/extract.mjs` classifies a document (`DOC_TYPES`) and extracts it with a per-type JSON
Schema that never asks for SSNs, EINs, full account numbers, names of people or addresses. Text
is redacted first (`src/ingest/redact.mjs`): SSN and EIN patterns are masked, money-shaped
numbers become opaque references that code resolves back, and every other digit run longer than
4 keeps only its last 4 digits. A PDF's text layer is read first by `src/ingest/pdftext.mjs`
`pdfText(bytes) -> {status, text, pages}` (pdfjs-dist in a `worker_threads` Worker with bounded
heaps, a 20 s timeout, a 2 MB text cap and its output discarded; never rejects). `text` (any
text with a letter) is redacted and sent as text (`pdf_text_layer`); `image_only` (no text on
any page) is sent as a document (`pdf_document`); `incomplete` (over 50 pages, timeout, cap or
out of memory) and `failed` (a parse error) wait as `needs_extraction` with note
`pdf_unreadable`, and nothing is sent (`pdf_withheld`). Extracted values become rows by
deterministic code; facts below 0.8 confidence wait for a `fact_check`, and employer-dependent
facts wait in `held_facts` until the employer relation is known. With the engine off the file is
`needs_extraction`.

### Confirm queue

`src/ingest/confirm.mjs` keeps `confirm_items` (one per `kind` and `subject`) with
`ask`, `answer(db, id, optionId, {now})`, `pendingItems` and `listItems`. Item shape: `{id, kind,
subject, question, options: [{id, label}], context, status, answer, fileId, createdAt}`. Kinds:
`account_owner`, `account_kind`, `entity_alias`, `tax_year`, `fact_check`, `near_duplicate`,
`employer_relation`, `employer_recipient` (subject the employer key; options `owner` "You",
`spouse` "Your spouse", `both` "Both of you") and `document_recipient` (subject a paystub, W-2
or 1099 payer identity; options `owner`, `spouse`; asked per document after `both`, and directly
for each 1099 with withholding) and `withholding_conflict` (subject `<dedupe key>|<cents>|<cents>`;
options `first`, `second`, `both`; the later row holds `<payer>:doc:<file id>` until answered, the
rejected row is archived as `withholding_conflict` and the survivor takes the identity; the context names each row by id,
dedupe key, file id and cents, a question whose rows are summarized, archived or rekeyed closes as superseded, and an
answer to one whose rows no longer match is refused as `stale`). A recipient answer
sets `tax_payments.recipient` on the matching withholding rows, recomputes their `wh:` slots and
summarizes per slot; while a row's recipient is unknown nothing summarizes it. An answered
subject is remembered and applied to later imports without a new question. `ConfirmError` codes map to HTTP: `not_found` 404, `bad_option` 400, `answered` 409,
`stale` 409, `not_answered` 409 and `final` 409 (with `reason`).

Revise and reopen (`reviseItem(db, id, optionId, {now})`, `reopenItem(db, id, {now})`, both
returning `{item, factsChanged}`) use a generic per-answer change log, not per-kind inverse code.
`answerItem` runs the answer under `captureChanges` (`src/ingest/undo.mjs`): TEMP triggers on every
ordinary table except `confirm_undo`, `confirm_guesses`, `ingest_epoch`, `schema_migrations` and
`spend_ledger` record each row change, and the log is stored in `confirm_undo` with the current
ingest epoch. `revertChanges` walks the log backwards, requires every touched row to still equal
the image the answer left (or to be still absent after a delete), and restores it; a revise then
answers again, all in one transaction, so a refusal changes nothing. `finalReason(db, item)` is
null or why an answer can no longer change: `no_undo` (answered before the log existed),
`imported_since` (a file was imported since, so remembered answers reached rows outside the log),
`used_since` (a later import or planning run re-applied it), `changed_since` (found only on
revert: a later change touched a logged row) and `stale` for a superseded item. The 409 messages
are "This answer was recorded before answers could be changed, so it is final.", "A file was
imported after this answer, so it is final.", "A later change builds on this answer, so it is
final." and "A later import used this answer, so it is final.". Pack state refreshes when either
log touched `facts`.

Engine guesses (`src/ingest/guess.mjs`): `guessPending(db, engine, {now, batchSize = 20,
maxBatches, fake})` sends pending items with no `confirm_guesses` row in batches, one engine call
with purpose `confirm` each (a single structured Messages round with no tools), carrying each
item's kind, question, options, context without locators and file metadata (name, source kind,
parser, period). A guess is kept only when its item is in the batch, its option is one of that
item's options, and its basis is one of six fixed codes (`REASON_CODES`); the stored reason is
the fixed sentence for that code (`REASON_TEXT`), never model text, so no model-written figure
reaches the card; every item sent gets a row (`option_id` NULL otherwise). It runs only on a live
engine (or with a per-call fake script in tests) that is on; engine errors stop the run as
`stopped`. Guesses never answer. It runs only as the scheduler job `confirm-guess` (see "Jobs"):
daily at 03:00, after an upload or retry that imports a file, Run now, and `npm run confirm:guess`
(`src/jobs/guess-cli.mjs`).

### Freshness

`src/ingest/freshness.mjs` gives each ingest source a cadence by source kind: monthly (stale after
45 days) for `bank_csv`, `card_csv`, `aggregator_csv`, `balances`, `brokerage_positions`,
`statement` and `pnl_workbook`; per pay period (35 days) for `paystub`; quarterly (100 days) for
`tax_payments`; annual (400 days) for `tax_doc`; none for `notes` and `other`. Stale sources feed
the domain notes (see the scenario builder). `src/ingest/howto.mjs` holds generic export steps
per format with no institution names.

### Facts helper and pack state

`src/store/facts.mjs` exports `upsertFact(db, {key, value, src, asOf, confirmed, provenance})`
(never overwrites a confirmed fact with an unconfirmed one), `getFacts(db)` (flat dotted keys)
and `deleteFact(db, key, {fileId})` (only that file's unconfirmed fact). `src/packs/state.mjs`
exports `refreshPackState(db, {packDirs, dataDir})`: it loads the repository packs plus
`$FATHOM_DATA/packs/your-plans/`, evaluates them against the facts and rewrites the base fields
of `packs_state.def` while keeping `recIds`, the what-if answers and the override columns; demo
stores are left alone. `upsertFact` returns `{written, changed}` (`written` false when a confirmed
fact blocked it). The server calls it at startup through `refreshLivePacks` (see "Live pack
state"; a failure logs a code and startup continues); the pipeline and the confirm answer call it
after facts change.

### Scripts

`node scripts/dump.mjs <baseUrl> <files or dirs...>` uploads files to `POST /api/files` in batches
under 200 MB, skipping dotfiles and reporting files over 50 MB, and prints one line per file
(status, rows by kind, `dup=`, `warn=` and the base name, no values); it exits 1 when a request
fails. `node scripts/ingest-check.mjs <dir>` imports a directory twice into a throwaway real store
in the OS temp dir (engine off unless `FATHOM_ENGINE=fake`; `.key`, `.json` and dotfiles
skipped), prints totals only, and always deletes its temp dir.

## Demo data

`demo/scenario.mjs` is the synthetic scenario (a faithful copy of the mock's). `demo/seed.mjs`
(`seedDemo(db)`, `OPENS_ON`) loads it at the November state: live status is
`statusByDemo.november ?? status`, windows become close dates relative to the scenario clock,
`opens_on` comes from `OPENS_ON` (`salary27` opens 2027-01-01; the others are dependency driven),
and the spend ledger sums to the scenario's month-to-date spend. `demo/ledger.mjs` adds a
deterministic synthetic ledger (seeded PRNG): transactions for the checking and business accounts
from January through the data-through month, balances at data-through equal to each account's
figure, positions for investment accounts, monthly P and L per business and quarterly estimated
tax payments. Every seeded row carries `file_id` and `parser` `demo-seed` and a locator. The seed
also queues four synthetic pending confirm questions on demo rows (`account_owner`,
`account_kind`, a `fact_check` on a key the demo facts lack, a `tax_year` with no workbook rows)
and one stored guess (model `demo`) on the owner question, so the demo shows the confirm deck.

## Container

The `Dockerfile` builds on `node:24-slim`, installs with `npm ci --omit=dev`, copies `src`, `web`,
`demo`, `packs` and `scripts`, runs as the built-in
non-root `node` user (uid 1000) with `/data` owned by it, sets `FATHOM_DATA=/data`,
`FATHOM_PORT=8080` and `FATHOM_HOST=0.0.0.0`, exposes 8080, and health checks `GET /healthz` with
node's `fetch`. It copies `src`, `web`, `demo` and `packs` (the pack tools read the repo packs at
runtime). Mount a named volume at `/data`; a host bind mount directory must be writable by
uid 1000. `scripts/docker-smoke.sh` builds, runs and smoke tests the image with whatever docker CLI
configuration the caller has.

## Planner

`src/jobs/planner.mjs` exports `runPlanning(db, engine, {now, packDirs, runId})`, `PlannerError`
and `PLAN_JOB_ID` (`'plan'`). It is the real-mode brain: a deterministic run that reads the ledger,
derives facts and figures, evaluates the trigger catalog and rewrites the planner-owned parts of
the plan and brief. Its only caller is the scheduler's `plan` handler (see Jobs), so every run has
the `job_runs` row the scheduler claimed and `runId` (required, an integer; a `TypeError` without
it) is that row's id. `POST /api/jobs/plan/run` (the generic `POST /api/jobs/:id/run`) and `npm run
plan` (`src/jobs/plan-cli.mjs`: exit 2 on a missing or demo store, 3 when another process holds the
job lease, 1 when the run fails; prints counts and warning codes only) run the plan job.

### Run steps

1. Refuse a demo store (`PlannerError` code `demo_store`). The `jobs` row and the `job_runs` row
   are the scheduler's.
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
7. One write transaction: facts, sources, figures, recs (`planner/recs.mjs`), `refreshPackState`
   and pack `recIds`, the brief (`planner/brief.mjs`), then pruning of planner figures nothing references.
8. Return the result. The scheduler finishes the `job_runs` row: `ok` with the engine cost and the
   counts as a counts-only note, or on a throw `error` with an identifier-only `error_class`. Runs
   are serialized per db handle, and every write compares first, so a second run over the same
   data changes no row.

Result: `{runId, status: 'ok', counts: {factsDerived, factsWritten, figures, recs: {active, new,
updated, retired, unchanged}, byTrigger: {<id>: new|updated|unchanged|retired}, prose: {model,
template, kept}, warnings}, warnings: [codes], costUsd}`.

### Facts the planner owns

Planner facts carry `src: 'planner'`, `confirmed: 0`, `as_of` the clock and provenance
`{fileId, parser: 'planner', locator: {rule, rows: [{table, id}] (at most 20), count}}`. The planner
writes a key only when no row exists or the stored row is its own unconfirmed one, so owner answers
always win; a planner row whose evidence disappears is deleted (kept while the tax computation is
blocked). Booleans are only derived as true. Keys: `income.sCorp`, `income.selfEmployed`,
`income.partnership` (from the `business.entities` fact, P and L lines, W-2 `employerName`, 1099-NEC
and K-1 `entityKind` documents), `income.w2` (an outside employer, never the household's own S corp), `accounts.has529`,
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
| `tax.fed.paid`, `tax.va.paid` (tax_payments rows of kind `paid` only) | a | `tax-payments` |
| `tax.fed.withheld`, `tax.va.withheld` (rows of kind `withholding`, or the owner's `tax.withholding.*`) | a | `tax-withholding` (`docs` for the owner fact) |
| `sh.fed.required`, `.remaining`; `sh.va.required`, `.remaining` | m (e without a prior year) | `calc:tax` |
| `room.solo401k`, `.employee`, `.employer`; `room.sep`; `room.ira.owner`, `.spouse`, `.household`; `room.hsa` | m | `calc:retirement` |
| `hsa.contrib.ytd`, `va529.contrib.ytd` (zero when a college account had no deposit this year), `giving.trailing`, `giving.ytd` | a | `transactions` |
| `inc.ytd.w2` (outside-employer W-2 box 1, or the latest paystub's `ytdGross` this year) | a | `docs` |
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
Ingest's K-1 names no partnership: a partnership K-1 counts only when it is the only one and there
is exactly one classified partnership (its owner is the partner); any other count blocks
`k1_unmatched`. A single partnership without a K-1 uses `income.partnershipEstimate`. An S corp
K-1 adds nothing next to its S corp's P and L and blocks `k1_scorp_unmatched` without one. An
unclassified P and L entity, an incomplete partnership input, filing status mfs
(`mfs_unsupported`), a household tax calculator throw (`calc_failed`) or a missing Virginia
itemized estimate blocks the tax figures that need it. IRA room counts traditional and Roth IRA
contributions; SEP room for a sole proprietor passes that person's W-2 wages; payroll records are kept per
person and employer, and a household S corp W-2 for anyone but its owner counts as that person's
wages; owner-set non-Roth own-corp 401(k) deferral and catch-up records lower that person's
P&L officer salary wages only for types no payroll document carries (document wages are box 1
and never reduced); salary war-game points are clamped into
`business.salaryRange`, and an S corp with no officer salary yet still gets the war game (no
current point, measured against the range midpoint); `scorp-salary` and `invoice-deferral` are
blocked, not retired, while household or Virginia tax is blocked; a pre-tax IRA with
no balance on file leaves that person's pro-rata status unknown.

The planner reads ingest's stored shapes and answers, never a field ingest does not write
(`src/jobs/planner/payroll.mjs`, `payments.mjs`). A W-2 or paystub belongs to the recipient of its
active withholding rows (`tax_payments.recipient`), else to the `employer_recipient` or, after
"both", `document_recipient` answer; unknown, the planner asks ingest's own question
(`withholdingRecipient`) and blocks `w2_recipient_unknown`. An employer is household when it matches
a household entity by normalized name or `entity_aliases`, else the `employer_relation` answer
decides (`household_employer_unmatched`, `employer_relation_pending`). W-2s sum per recipient,
employer key and year with three separate bases: box 1 is taxable wages, box 5 is Medicare wages
(Additional Medicare Tax and FICA or SE inputs only; unread, it blocks `w2_medicare_wages_missing`)
and box 1 plus the box 12 pretax codes is plan compensation (IRC 415(c)(3), noted
`w2_plan_compensation`). An own S corp W-2 for the year replaces the officer salary projection for
all three. Box 12 unread leaves compensation unknown unless the owner states that sponsor's
deferrals: plan limits, solo and SEP room, the salary war game and, above the 199A threshold, the
corp's QBI W-2 wages (so QBI and federal tax) block with `w2_plan_compensation_unknown`. A wage part
exists whenever box 1 (or a P and L salary) is known. Each salary war game point takes payroll tax
on its cash salary, taxable wages as that salary plus this year's signed box 1 minus box 5, and
plan compensation as that salary plus this year's signed compensation minus box 5, never clamped;
owner-stated deferrals feed only compensation for a W-2; the current point is the cash salary. Box 12 D, E, F, G and S are pre-tax, D, E, F, S, AA and BB
count toward 402(g) (G and EE do not), W is HSA money, and a W-2 without box 12 leaves deferrals
unknown. Deferrals above the 402(g) limit are catch-ups; across a household plan and another plan
they block `deferral_split_unknown` until `retirement.otherPlanDeferrals` is answered. A paystub-only
employer projects `ytdGross` to the year (`section125_unknown`), blocking `paystub_ytd_missing`, or
`paystub_deferrals_unknown` when a stub shows deferrals and no outside-401k contribution is stated
for that employer (an unnamed one only when the person has a single outside employer).
A W-2 whose withholding a `withholding_conflict` answer dropped is dropped too; a pending conflict
blocks `w2_correction_pending`, answers keeping different forms block `w2_correction_conflicting`,
and two W-2s nothing reconciles block `w2_duplicate_unresolved`. Tax payments count once by kind
and jurisdiction (`VA` and `Virginia` are Virginia; `state` is Virginia only for a `paid` row of a
Virginia household): blocks are `tax_payment_kind_unknown`, `withholding_state_unknown`,
`withholding_recipient_unknown`, `withholding_conflict_pending`, `tax_year_unconfirmed` and
`estimated_payer_unknown`, each holding only its figure and the safe-harbor figures that use it.
Additional Medicare Tax withheld (box 6) is not extracted and counts as zero
(`addl_medicare_withholding_not_read`). Last year's federal tax is `tax.prior.federal`, else the
uploaded form1040 `totalTax` (`prior_tax_total_line`); AGI is `tax.prior.agi`, else its `agi`.
Account owners are ingest's option labels mapped to people, and a business account's entity is
`accounts.businessEntity`, else the only household business. A planner figure not produced by a run is deleted unless a rec def (text or
`mine`), message, decision note or content row references it, or a kept war-game entry names its
point or option. `src/scenario/build.mjs` serves a stored `wg.*` figure in place of the value it
would derive from `content.wargame`.

### Trigger catalog

Each module in `src/jobs/triggers/` exports `id`, `domain`, `trigger`, `packs`, `gate` (a pack
rule over facts that tolerates absent facts), `calcs`, `kb`, `window(ctx)`, `evaluate(ctx)` (null,
a hit, or `{blocked: reason}`), `build(ctx, hit)` and `template(ctx, hit)`, plus an optional `needsYear` flag: a trigger with it
is skipped (state none) when no planning tax year is known. A trigger hits when its gate holds, its window has not closed and `evaluate` returns a hit. A null evaluation after one of
the trigger's `calcs` threw is blocked as `calc_failed`, never retired.

| Id | Domain / class | Window |
|---|---|---|
| `fed-q4-estimate` | tax / calendar | Jan 15, hard |
| `va-q4-estimate` | tax / calendar | Jan 15, hard |
| `year-end-retirement` | retirement / calendar | Deferral deadline (see Deferral deadlines below), hard; regular, catch-up or Roth catch-up room (SEP room alone does not fire it); blocked when `solo401kRoom` throws |
| `solo401k-setup` | retirement / calendar | Deferral deadline (see Deferral deadlines below), hard |
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

### Decided salary

The decide action (`POST /api/decisions/:id/decide`) writes the owner fact `business.salaryDecided`
as `{entity, salary}`; the salary war game content carries `entity`, the slug of the S corp it was
built for. `computeFigures` treats the salary as that business's owner-stated payroll assumption only:
another S corp keeps its own projection. It replaces the straight-line P&L officer salary projection
(`pnl.<slug>.salaryProj`, source `owner-decision`), becomes the wage part of the household tax parts
and the war game's current point, and distributions follow the same model as the war game (profit
before salary less the salary and the employer payroll tax on it), so wages and distributions move
together. The deferral game's monthly payroll uses the decided salary and its employer payroll tax.
Profit before salary still comes from the P&L. The decision is dropped for the run (the projection
figure is restored) when a W-2 from the business exists for the year (actual data wins) or when the
salary would leave negative distributions. Revisit deletes the fact, so the next run goes back to
the data. A decided deferral is recorded (`business.deferralDecided`) and shown, but no projection
reads it yet.

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
Fact-change event titles come from the fixed label map in `src/shared/event-labels.mjs` (every
frozen fact key, detected and no longer seen, plus a fallback per event kind), for example "S corp
income detected"; no title holds a figure or a raw key, and the scenario rewrites an old stored
"<key> changed" title the same way. The `series` content row (src `planner`) is built by
`src/jobs/planner/series.mjs` from the balances table (positions values for months a brokerage
account has no balance): one `acct-<id>` series per account with at least two months in the last 12,
and `net` ("Net worth, accounts with a trend": only accounts with a series of their own, debts such as
card, credit and loan kinds subtracted, each counted from its first month with its last balance carried
forward; it ends at the newest month any upload covers).

### Deferral deadlines

`year-end-retirement` and `solo401k-setup` share one deadline from `info.solo` (the sized
participant's sponsor kind) and `firstYearStatus(ctx)` in `triggers/common.mjs`: an S corp owner
(or no sponsor known) defers through payroll, so the last payroll; a sole proprietor with no plan
on file whose `business.onlyEmployee` fact is true (owns the whole business, no employees, the
spouse included) gets Apr 15 of the next year for a first plan year (IRC 401(b)(2) as amended by
SECURE 2.0 s.317); a sole proprietor with a plan or who is not eligible, and a partnership, get
Dec 31 (Treas. Reg. 1.401(k)-1(a)(6)(iii)). Without the answer both recs are confirm forms with the
Apr 15 window, and year-end-retirement sizes nothing. Sole proprietor text never mentions payroll.
Roth catch-up room is never described as lowering this year's tax; the tax value line appears only
when `room.solo401k.pretax` is positive.

### Planner literal check

Besides `checkGrounding`, model prose passes `plannerLiteralFree` (`planner/prose.mjs`): after
tokens are removed, only a month and day (optionally with the year), `tax year YYYY`, `in YYYY` and
the plan identifiers 401(k), 403(b), 457(b), `529 plan` and Virginia529 may carry digits, and none
of those is allowed next to a money word, a percent sign or a dollar sign. Stored prose, model or
template, is reused only while it still passes both checks; otherwise the rec is rewritten.
Templates obey the same rule. `src/engine/grounding.mjs` treats Virginia529 as an identifier.

### Unavailable history

A war game the run could not rebuild because its inputs are invalid (`info.wargameInvalid[name]`,
whatever the season) stays in `content.wargame` with `unavailable: <reason>`; a game absent only
for the season is kept unchanged, and a rebuilt game drops the marker. Planner decisions on such a
game keep their row and status and get `decisions.unavailable_reason` (cleared on rebuild; an
upcoming next-year row is not marked). The scenario serves those decisions with status
`unavailable` and `unavailable`, and the game with status `unavailable`, unless a stored decision
on it is decided. `POST /api/wargame/:name/pick` answers 409 for an unavailable game. Decide lists
unavailable decisions in a collapsed "No longer current" block with a "See the history" link.

A planner figure not produced by a run but kept because something references it gets
`figures.unavailable_reason`: the readable text for `info.withheld[key]`, else the run's first
blocked code, else a generic "no longer computed" line (`reasonText(ctx, code)` in
`triggers/missing-data.mjs`). A produced figure clears it. The scenario serves it as
`fig[key].unavailable`, `get_figures` as `unavailable`, plain token text appends " (not current)",
HTML figure spans carry `data-unavailable="1"`, and the popover shows a "Not current" row.
Triggers never read stored figures, so a retained value never drives a current recommendation.

### Figure notes and stored text

A figure locator's `notes` (readable assumption sentences, no digits) reach the scenario as
`fig[key].notes` (at most five) and the popover as "Assumes" rows. Names and the product name are
stored as given and escaped once where they become HTML (`esc` in `web/horizon/design.js`; `{n:}`
tokens escape on resolve). Knowledge-base excerpts are escaped with braces neutralized after the
cut, so pack text never carries markup or a live token.

Retiring a planner rec that is already done, dismissed or hidden writes a `retire` event with the
same from and to status and keeps the owner's status.

Owner inputs added by this round: `business.onlyEmployee`, `retirement.iraBasis` ({owner?,
spouse?} after-tax IRA basis from Form 8606), `retirement.priorYearFicaWages`,
`retirement.planOffersRoth`, `retirement.otherPlanDeferrals`, `tax.prior.qbiLossCarryforward`,
and an optional `entity` on `retirement.contributions` entries.

### Job rows

The scheduler owns both: the `jobs` row `plan` comes from its `JOBS` table (`Nightly plan
refresh`, daily at 02:00), and each run adds one `job_runs` row (status `running` then `ok`,
`skipped` or `error`, with trigger, period key, duration, `cost_usd` and a counts-only `note`) whose
id the planner writes to `planner_recs.first_run` and `last_run`.

### Planner seams

The planner uses the shared seams described under "Seams later items plug into" (the runtime
engine, handed to it as `ctx.engine`) and "Facts helper and pack state".

1. Facts: `upsertFact` for every derived fact; a run counts a fact as written only when the call
   reports `{written: true, changed: true}`. Planner-owned facts that no longer derive are deleted
   by key where `src = 'planner'` and unconfirmed (`deleteFact` deletes by file, not by source).
2. Packs: `refreshPackState(db, {packDirs})` inside the planner's write transaction, then the
   planner sets each `packs_state.def.recIds` to the ids of the recs whose `pack_id` is the pack,
   sorted, since `refreshPackState` keeps `recIds` as stored.
