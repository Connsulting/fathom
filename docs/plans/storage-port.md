# PG0: SQLite and Postgres storage port

Status: proposed specification, documentation only. Inspected `origin/main` at
`9e9dfb423e562a0866193b57f8c3f104f5746ca7` on 2026-11-08.
This document settles the implementation design; it does not enable Postgres,
change a deployed store, file issues or dispatch implementation.

## Risks and dependencies

1. The main cost is propagating asynchronous reads and writes through the entire
   application, including auth, synchronous-looking engine admission, scenario
   assembly, scheduler callbacks, tools, demo seeding and test fixtures. An
   unawaited authorization check is a security bug. The cutover is one atomic
   caller migration, with full CI as its outside check.
2. Scheduler and model-budget work changes precisely these callers. MT-04 is
   still open as PR #111 at the inspected base; MT-05 is PR #125. IMP-1 and IMP-2
   merged, including migrations 029 and 030. Refresh before dispatch. Household
   migrations are numbered in merge order. The next free number follows the
   highest file in `src/store/migrations`; platform numbering is separate.
3. Postgres is an optional external service. Its availability, volume, secrets,
   TLS and operator backup custody are deployment prerequisites, not a reason to
   make local development depend on it. This spec authorizes no deployment.
4. Async transactions must keep one connection and one household throughout;
   sharing a SQLite connection across overlapping transactions would interleave
   unrelated requests. Postgres introduces real concurrent writers and deadlocks.
   Serialize household writes first, preserving today's single-writer semantics.
5. Row equality alone is insufficient: durable Confirm undo logs refer to hidden
   SQLite rowids, several screens use rowid ordering, and tenancy verification
   deliberately includes rowids. Convert these references before export. Never
   use VACUUM to produce the pre-conversion safety copy.
6. Delivery depends on prerequisite merges, sequential integration, CI and one
   implementation review per PR. Each package below is one agent run; no calendar
   promise depends on an unmerged package or a human approval during execution.

## Pinned decisions

1. SQLite stays the default, using the same files, WAL, foreign keys and 5000 ms
   busy timeout. Demo startup remains secret-free and needs no Postgres or new
   network access. Existing household data and financial behavior survive upgrade.
2. Both adapters implement one asynchronous port. Migrate every production caller,
   CLI, seed, evaluation runner and test helper. Remove old synchronous APIs in
   the cutover PR. No promise-or-value signatures, sync facade, thenable rows,
   worker-thread blocking bridge, raw driver escape hatch or backend branches in
   business code. Unused adapter scaffolding before cutover is not a second live
   application path.
3. Use one Postgres database per instance, a platform schema and one schema per
   household. A separate database per household is rejected: connection, role,
   migration and backup operations would multiply for no required process boundary.
   No household_id predicate is added to every financial table. The existing
   runtime registry and immutable store_identity remain authoritative.
4. The whole instance uses one selected backend, including platform and demo
   control stores. Mixed live SQLite/Postgres households, replication, online
   dual writes, distributed transactions and automatic failover are deferred.
5. PostgreSQL 17 is the initial supported major. Use the asynchronous `pg` driver,
   pinned exactly with the lockfile by its implementation ticket. Keep Node 24
   ESM, existing npm script names, monetary columns and deterministic calculators.
   This specification explicitly proposes replacing the SQLite-only storage
   clause in `docs/architecture.md`; it does not alter its other frozen contracts.

## Observed source inventory

The scan covers `src/**/*.mjs`, `src/**/*.sql`, household migrations 001 through
030 (there is no 024 file) and platform migrations 001 through 004. It found 965
`.prepare(` occurrences in 98 source files, including source-local tests. Counts
are a scope signal, not a dispatch-time inventory. Re-run on the final base.

| Evidence | Current dependency | Required treatment |
|---|---|---|
| `src/store/db.mjs` | DatabaseSync, open/migrate/tx/settings, sqlite_master, PRAGMAs, file publication | SQLite adapter plus async port; no application raw connection |
| `src/platform/db.mjs`, `ready.mjs`, `runtime.mjs` | platform.sqlite, root/identity checks, generation, atomic initial layout | Backend-selected scopes with the same identity/root invariants |
| `src/platform/migrate.mjs`, `migrate-tenancy.mjs`, `snapshot.mjs` | Legacy SQLite layouts, exclusive source locks, page backups, rowid-aware digest | Explicit SQLite source operations inside the adapter; remain tested offline tools |
| `src/auth/store.mjs`, `src/platform/outbound.mjs` | isTransaction, BEGIN IMMEDIATE and named nested savepoints | Explicit async transaction handle, serialized platform writes |
| `src/ingest/undo.mjs`, `confirm.mjs` | TEMP triggers/table, json_object/json_extract, main qualification, rowid undo, confirm_dependent savepoint | Port-owned capture, versioned primary-key undo and async savepoints |
| `src/public-demo/control.mjs`, `runtime.mjs` | Direct DatabaseSync, control DB, per-sandbox instance creation | Same port; dedicated control scope and isolated sandbox namespaces |
| `src/scenario/build.mjs`, `src/actions/receipts.mjs`, `src/tools/catalog/figures.mjs` | rowid ordering for sources, figures, conversations and action receipts | Durable portable ordering described below |
| `src/api/ingest-handlers.mjs`, `src/ingest/context.mjs`, `freshness.mjs` | files rowid as timestamp tie-breaker | Preserve the old relative order with explicit ordinal |
| `src/api/handlers.mjs`, `src/yearend/expected.mjs`, `src/ingest/pipeline.mjs`, `confirm.mjs`, `src/advisor/index.mjs` | lastInsertRowid | INSERT ... RETURNING id, including all test callers |
| `src/yearend/packet.mjs`, `src/api/account-detail.mjs` | group_concat, SQL rounding and permissive GROUP BY | Portable aggregates and complete grouping; deterministic code formats totals |

Reproduce the high-risk scan with:

```sh
rg -n 'node:sqlite|lastInsertRowid|rowid|PRAGMA|AUTOINCREMENT|INSERT OR|json_|strftime|SAVEPOINT|BEGIN IMMEDIATE|GROUP BY|group_concat' src
rg -n '\?1|IS NOT \?|min\(attempts' src
```

### SQL dialect decisions

| Construct found | Handling |
|---|---|
| `?` and numbered `?1` bindings (`src/api/accounts.mjs`) | Callers normalize numbered/repeated placeholders to positional `?` with repeated argument values. A tested SQL lexer maps unquoted/uncommented `?` to `$n` in Postgres; never regex-replace literals or interpolate values. Named bindings are not part of the port. |
| ON CONFLICT upserts throughout; nine INSERT OR IGNORE files | Use explicit conflict targets and ON CONFLICT DO NOTHING/DO UPDATE. Qualify the target side of ambiguous arithmetic, including ingest_epoch's n. DO NOTHING must suppress only the intended uniqueness conflict, never CHECK/NOT NULL failures. No INSERT OR REPLACE or REPLACE INTO was found. |
| INTEGER PRIMARY KEY without AUTOINCREMENT | No AUTOINCREMENT keyword was found. SQLite ids alias rowid. Postgres uses BIGINT GENERATED BY DEFAULT AS IDENTITY for generated ids, BIGINT for singleton/reference ids. Preserve explicit ids, reset sequences above imported maxima and use RETURNING. No ctid or lastval substitution. |
| json_set, json_extract, json_valid, json_type, json_each | Runtime undo moves to typed row capture. Historical migrations 005, 006, 011 and 015 get explicit Postgres equivalents using guarded IS JSON, jsonb casts, jsonb_set and jsonb_array_elements. JSON stays TEXT at rest to preserve exact bytes; no automatic driver JSON parsing or JSONB storage rewrite. Match scalar/null/missing/invalid/array behavior with fixtures. |
| json_object and TEMP triggers in undo | Adapter-specific trigger implementation under one capture contract; row images use declared column order and common JS normalization. Include cascades and trigger-written business rows. No SQL-text interception pretending to capture all changes. |
| PRAGMA journal_mode, busy_timeout, foreign_keys, table_info, integrity_check, foreign_key_check, query_only, locking_mode, wal_checkpoint | SQLite only behind typed lifecycle operations. Postgres uses catalogs, READ ONLY transactions, validated constraints, lock/statement timeouts and logical verification. There is no PRAGMA string translated to a purported physical Postgres integrity check. |
| sqlite_master, main/temp qualification, dynamic table metadata | Port metadata lists only application tables/declared columns in the selected scope. Trusted migration/capture code quotes validated identifiers; ordinary queries cannot select schemas or attach databases. |
| strftime in 006/016 | Backend-specific migration statement with UTC millisecond ISO text; preserve migration timestamps on conversion. Runtime dates already mostly come from JS. No SQL julianday/datetime use was found; do not rewrite JS Date calls as SQL findings. |
| GLOB in spend_ledger's YYYY-MM CHECK | Postgres anchored regex for the same four-digit, hyphen, two-digit shape, without silently imposing a new valid-month policy. |
| scalar min(attempts + 1, ?) in auth rate limiting | Replace with portable CASE, qualifying attempts/expires_at in conflict updates. Preserve the exact bounded increment under platform write lock. |
| `name IS NOT ?` in scheduler and SQLite nullable equality | Use IS DISTINCT FROM for inequality and IS NOT DISTINCT FROM for equality; supported by SQLite in Node 24 and Postgres. Do not substitute <> with different NULL behavior. |
| group_concat(DISTINCT file_id), round(sum(amount), 2) | Select distinct provenance ids in a second ordered query and assemble in JS; use existing cents calculation after the aggregate. Test rounding boundaries and empty/null aggregates. |
| Non-grouped f.name, f.source_kind, f.source_id, f.uploaded_at in account-detail | Aggregate in a derived table first, then join files by its unique id. Do not use arbitrary-value aggregation. |
| LIKE and LIKE ... ESCAPE, lower/substr, text ordering | Preserve SQLite's ASCII-only case folding for existing search through an adapter-registered fathom_ascii_fold SQL function; compare folded expressions, with existing escaping. Postgres implementation uses translate, SQLite uses a deterministic JS function. Postgres text columns use deterministic C collation; add explicit ordering wherever results are user-visible. Test non-ASCII text and literal percent/underscore/backslash. |
| REAL, BLOB, integer flags, epoch timestamps | Postgres DOUBLE PRECISION, BYTEA, integer 0/1 flags with existing CHECKs and BIGINT epoch ms. No NUMERIC money rewrite, BOOLEAN coercion, TIMESTAMPTZ conversion or timezone-dependent driver Date values. Preserve IEEE-754 values and opaque byte arrays. |
| BEGIN IMMEDIATE, SAVEPOINT, SQLite table rebuild markers | Transaction and migration contracts below; Postgres explicit ALTER/constraint SQL, never disabling all FK triggers or accepting NOT VALID constraints at completion. |

## Storage port contract

New implementation location: `src/storage/`. Only `src/storage/sqlite/` imports
`node:sqlite`, including explicit legacy-layout readers and page-copy utilities.
Only `src/storage/postgres/` imports `pg`. These boundaries cover scripts, demo
and test helpers too; adapter conformance tests may inspect their own driver.
A static architecture check enforces the rule and rejects raw transaction SQL in
application modules. Common pure helpers such as cents and parseJson remain pure.

```js
const storage = await openStorage(config);
const platform = await storage.platform();
const household = await storage.household({ householdId, generation });
const query = household.prepare('SELECT id FROM accounts WHERE kind = ?');
const row = await query.get('checking');
const rows = await query.all('checking');
await household.transaction(async tx => {
  const inserted = await tx.prepare('INSERT INTO messages (...) VALUES (...) RETURNING id').get(...values);
  await tx.savepoint(async nested => { await applyChange(nested, inserted.id); });
});
await storage.close();
```

The SQL example's ellipses denote existing column/value lists, not new SQL syntax.
`prepare(text)` creates an immutable logical query descriptor synchronously and
performs no I/O. `get`, `all` and `run` always return Promises. `get` resolves to a
plain row or undefined; `all` to plain rows; `run` to `{changes}`. Generated ids
come from RETURNING, never a result field named lastInsertRowid. No iterator or
multi-statement application exec is exposed. Statements bind null, string, finite
number, safe integer and Uint8Array only; booleans become explicit 0/1 in callers.
Unsafe integer conversion fails with a fixed code. BYTEA becomes Uint8Array;
BIGINT counts/ids/epochs become safe JS numbers. Null and undefined are distinct.
Binary64 finite numbers are losslessly encoded for dumps, including negative zero.
Reject NUL-bearing TEXT during preflight with a fixed code, since Postgres TEXT
cannot represent it; never silently truncate or recode such a source.

Common application SQL is the tested shared subset above, not arbitrary SQLite
SQL. Backend-specific DDL, metadata, trigger capture, backup and locking are
explicit adapter operations. A query that needs dialect syntax gets a named
catalog operation in `src/storage/queries/`, with both implementations and a
conformance test. Callers never inspect backend type. Postgres parameter types
and output normalization are tested, including count(*) and RETURNING values.
Prepared query caches belong to a physical connection, use a SQL hash for names,
are bounded to 256 entries per connection, and are cleared on close.

### Connections, concurrency and errors

SQLite retains a queue per physical connection. Every standalone operation takes
that queue; transaction callbacks retain it until commit/rollback. Concurrent
requests cannot enter the same connection's open transaction. A transaction gets
an explicit tx handle; use it in every callee, never the parent scope handle.
Nested work calls tx.savepoint and receives a new handle. Misuse of the parent
inside its callback fails immediately rather than deadlocking. Unique savepoint
names are generated by the port; rollback-to is followed by release. Nested
capture is refused, matching today's single active Confirm capture operation.

Postgres uses two bounded pools per process: platform max 4 clients and all
household scopes together max 8, independent of household count. A transaction
pins a client. Platform writes take one transaction advisory lock; household
writes take one advisory lock derived from the immutable household id, with a
fixed instance namespace. Hash collisions only serialize unrelated writers.
SQLite uses BEGIN IMMEDIATE for write transactions. Postgres write transactions
use READ COMMITTED plus that scope lock, taken before any reads; this serializes
read-check-write auth, leases, spend and financial mutations across processes.
Standalone mutations use an implicit write transaction and the same lock.
A transaction cannot write both platform and household scopes. Cross-scope
operations retain explicit journals/idempotency already used by the runtime;
MT-05 reservation and household mirror remain separate durable phases.

Set lock acquisition timeout to 5000 ms and statement timeout to 30000 ms. Do not
hold a transaction across model calls, email, filesystem work, streams or other
external I/O. Transaction callbacks contain database work and deterministic
calculation only. No automatic whole-callback retry can duplicate an external
side effect. Return fixed storage_busy, constraint_unique, constraint_foreign_key,
constraint_check, storage_unavailable and storage_invalid errors; preserve
existing domain/HTTP mappings in migrated callers. No SQL, DSN, params, private
path or driver error detail reaches a response or normal logs. Lost connections
roll back; abandoned clients are destroyed. Await startup and graceful shutdown.

### Scope, identity and filesystem

Postgres instance control uses `fathom_platform`. Household schema names are
`hh_` plus the first 60 lowercase hex characters of the SHA-256 of the immutable
household id, fitting the 63-byte identifier limit; the platform registry
stores the exact mapping with a UNIQUE constraint. A collision fails provisioning,
never shares storage. Add a storage descriptor per registry row (backend, schema,
generation) while retaining storage_root for files/packs/outbox/work on disk.
Do not place credentials in the registry. The configured backend must agree with
the platform marker and every served household descriptor, else startup refuses.

Each checked-out Postgres client begins a transaction and receives SET LOCAL ROLE
and a trusted SET LOCAL search_path for exactly its schema and pg_catalog. Use
separate NOLOGIN platform and household roles, no PUBLIC schema CREATE privileges,
no household cross-schema grants, no SECURITY DEFINER functions. The runtime
login can SET the provisioned roles without inheriting all their privileges.
Only a separate migration/provisioning connection can CREATE/DROP schemas/roles.
Registry-issued schema names are validated and quoted; never use a request id as
an identifier. App queries cannot explicitly qualify another schema or manipulate
roles/search_path. Rollback/reset before returning a client; failed reset destroys
it. Recheck store_identity before migration and after opening; generation changes
fence writes. This is protection against wrong scope selection, not against an
operator or arbitrary SQL execution by the shared trusted process.

The Postgres server also loads FATHOM_POSTGRES_PROVISION_URL_FILE, a separate
mounted credential used only by migration, createHouseholdStorage, sandbox
createInstance and sandbox cleanup. It is never handed to request/tool contexts
or a runtime pool. These entrypoints call the storage provisioning operation,
not arbitrary privileged SQL. PG startup requires both credential files; CI
creates synthetic runtime/provisioner roles without repository secrets. The
provisioner must be able to create/drop scopes and roles and grant runtime SET
ROLE privileges; preflight probes this on disposable synthetic objects.

Household provisioning first reserves an operation id, household/schema mapping
and provisioning phase in the platform operation journal. It then creates the
unserved schema, immutable identity, role and contained files, marking resources
ready before publishing the registry row/generation. The create transaction
records its operation id inside the schema. On restart, recognize the journal
before fresh-target checks: adopt the complete unpublished schema only when
operation id, household identity, artifact checks and root match; otherwise
remove only verified incomplete resources owned by that operation and rebuild.
An unknown/conflicting existing schema always refuses. A crash after publication
resumes the published operation rather than recreating its schema. No active
household schema is deleted by provisioning cleanup.

Public-demo control uses fathom_demo_control. Each sandbox platform schema is
`dp_` plus the first 60 hex characters of SHA-256 of its server-issued visitor id;
its own generated household receives the ordinary hh_ mapping. Thus fathom_platform
is the normal instance platform name, not the name of every sandbox platform.
The control registry journals sandbox creation/publication/deletion and stores
both exact schema mappings. Namespace collisions refuse. Cleanup blocks new
admission, drains active requests, records delete_pending, then uses the
provisioning connection to drop only that sandbox's verified schemas/roles and
remove its contained root; mark complete after both. A crash resumes deletion.
Synthetic template creation/reset uses this port on both backends. Files remain
private and contained in each existing sandbox/household root. No control handle
can be used as a financial handle. Reads never default to a served household.

### Migrations and integrity

Preserve all shipped SQLite migration files byte for byte. Add an explicit
Postgres SQL implementation for every shipped household/platform migration at
the same logical id/name, including data transformations, removed account tables,
partial unique indexes, FKs, triggers and singleton checks. No blind SQL rewriting.
SQLite files stay at their existing paths; Postgres counterparts live in
`src/storage/postgres/migrations/{household,platform}/`. Future migrations ship
both implementations in the same PR. A catalog records id, name, scope and both
artifact checksums; converted history records retain original applied_at values
and provenance without claiming Postgres executed the SQLite scripts.

One transaction per migration under a scope migration lock; the schema_migrations
row commits with its changes. Reject unknown/newer versions and mismatched known
id/name/checksum before serving. Populate a separate artifact ledger for shipped
SQLite migrations whose existing history has no checksum, after matching the
known release files. Never reinterpret missing checksum as proof of execution.
Do not read STORE_IDENTITY_DDL by regex from a SQLite file for Postgres startup.

The existing SQLite REBUILDS_TABLE procedure keeps FK checking before commit.
Postgres migrations use transactional DDL and explicit constraints, with deferred
FKs only where the existing schema requires them. New schema initialization and
full upgrade from a populated pre-port fixture must reach equivalent schemas.
Store and platform histories remain independent for every household.

`scope.inspect()` returns table/column/primary-key/constraint metadata without
other schemas. `scope.verify()` returns counts, schema version and fixed findings.
SQLite runs integrity_check and foreign_key_check. Postgres validates catalog
constraint state, runs explicit orphan/uniqueness/singleton checks and compares
expected schema artifacts. This is logical verification, not a claim of physical
page integrity. Database physical recovery and PITR remain operator concerns.

### Portable row identity, ordering and Confirm undo

Use declared primary keys, including composite keys, as portable row identity.
Every captured household table must have a declared non-null unique primary key;
fail schema validation otherwise. Before enabling Postgres, add NOT NULL checks
where SQLite TEXT PRIMARY KEY allowed NULL and reject invalid existing rows.
No ctid, Postgres OID or copied hidden rowid becomes a new runtime identity.

Add a storage ordinal to sources, figures, conversations, files and action_receipts.
Backfill it from each live SQLite rowid, preserving gaps and relative order. New
inserts allocate the next ordinal from per-table storage_sequences under the
household write transaction; reinserted Undo rows retain their captured ordinal.
The explicit column replaces every rowid ORDER BY, including alias-qualified
queries. Keep internal sequence state out of financial capture and expose no
new display fields. Historical rowid-aware SQLite migration digests remain valid
for their existing explicit legacy source operation, not for cross-backend checks.

A new numbered upgrade rewrites every existing confirm_undo.changes into a v2
record containing table, operation, primary-key before/after, typed before/after
images and ordinal where applicable. Derive keys from the recorded images,
including deleted rows absent from the live table. Preserve legacy movedFrom
refusal as an explicit key-move refusal marker. Historical schema mismatches
keep changed_since behavior; malformed or unmappable active records abort the
upgrade. No runtime old-log decoder remains. Test deleted rows, rowid gaps,
key changes, null values and composite keys; do not invalidate undo to avoid work.
Apply the same identity rule to receipt/import before_state and after_state data
introduced by IMP work; inspect those merged formats before dispatch.

`tx.capture(async captured => ...)` returns result plus ordered v2 changes, using
one pinned transaction. SQLite TEMP triggers and Postgres normal row triggers
produce the same typed images. Postgres capture installs its permanent ordinary
invoker-rights triggers during migrations; each trigger logs only when a
transaction-local capture marker is set and a pg_temp log exists. Set/clear the
marker within a savepoint, allocate log sequence per connection, clean temporary
state on success and failure, and reset before pool reuse. Trigger code qualifies
its own scope and pg_temp log; no data from a different transaction is captured.

Capture all business writes including cascades; preserve the existing UNTRACKED
and FIELD_LEVEL rules. Revert checks the recorded after image, walks changes in
reverse, restores deleted keys/ordinals and changes only recorded account fields.
A failed comparison rolls back the whole undo. Keep capture installation separate
from ingest_epoch's normal business triggers, whose effects must remain equal.

## Digests, backups and restore

Add a versioned cross-backend digest format. Use the same ordered declared column
list on both sides, tagged byte arrays, exact TEXT bytes, canonical safe integers
and lossless finite binary64 encodings. Sort serialized rows and table names;
include duplicate counts, composite keys and storage ordinals. Do not parse and
restringify JSON TEXT. Do not hash backend catalog OIDs or identity sequence names.
Compare sequence high-water marks separately. Exclude only backend artifact
metadata, with an explicit manifest list. Keep the existing digest version for
legacy tenancy snapshots; never compare unlike digest versions as equal.

PG-5 upgrades MT-08's single household bundle format to a new typed version,
reusing its backup runner, request/status APIs and restore command. It does not
introduce a parallel household backup subsystem. The backend-neutral logical
household bundle contains typed rows, schema history,
sequence/ordinal state, store_identity, relative-root file hashes and encrypted
vault/files/packs/outbox/work bytes, plus the platform slice required by the
multi-tenancy backup contract. Wrap it in authenticated encryption with the
existing separately supplied backup key, fsync a private partial file and publish
without overwrite only after verification. The versioned MT-08 bundle header
distinguishes these archives from existing FTHMSNAP1 SQLite safety snapshots;
those snapshots retain their explicit offline restore tool. The runner chooses
the declared bundle version, never guesses a format or uses silent fallback.

Quiesce the selected household: block admission, stop scheduling, drain in-flight
work and fence generation before taking database/filesystem state. SQLite uses
the online backup API for page-preserving safety copies. Postgres logical export
uses one repeatable-read snapshot while paused, with every query on its pinned
client. There is no filesystem copy of Postgres's live data directory. Export
platform slice under its scope lock after relevant jobs have drained. Instance
conversion/backup stops all admission to obtain a coordinated platform snapshot;
a household bundle never includes unrelated households' auth or financial rows.
Secrets needed for disaster recovery are backed up separately under the existing
custody policy; the root wrapping secret is never plaintext in a bundle.

Restore into an unserved staging scope/root. Authenticate the entire archive,
validate table/column allowlists and containment, check schema/rows/files/keys and
then publish the registry generation. Refuse a different household identity,
existing target, malformed paths or symlinks. Ordinary household restore preserves
global passkeys/users, checks current memberships, reconciles spend conservatively,
revokes affected sessions/challenges/MCP bindings and leaves outbound paused as
specified in `docs/multi-tenancy.md`. Other households' digests stay equal.
Crash recovery recognizes already-published operation states before applying
fresh-target preconditions. Full-instance recovery restores platform plus all
households as one stopped operation. Postgres PITR and pg_dump archives are
operator supplements, not this port's application-consistent household backup.

## Offline SQLite to Postgres conversion

The minimum supported unit is an instance: its platform and all registered
households, including a single-household installation. `--household` can select a
household for export/verification, but cannot publish a mixed-backend instance.
A live per-household backend switch is deferred. The converter and verifier are
explicit operator CLI boundaries, take endpoints/paths/key files from their
caller, and print only counts, fixed codes and aggregate digests.

1. Preflight a stopped instance under an exclusive operation lock and SQLite
   exclusive locks. Probe exact supported schema versions, all identities and
   roots, Postgres major/role permissions/TLS, backup key, existing source safety
   snapshot, target vacancy and free space. Reject unsupported NUL text, unsafe
   numeric values, invalid primary keys and unknown data shapes before copying.
   Keep configured public origin, WebAuthn RP id, HMAC secret and wrapping key
   unchanged; fail on a mismatch. Credentials never appear in the journal.
2. Create and verify encrypted page-preserving platform/household safety snapshots
   and the file-tree manifest. Work only on staging copies, upgrade them through
   the portable identity/undo migration, and compute typed source digests. The
   immutable originals remain the pre-write rollback source.
3. Create target schemas unserved. Import platform rows and each household in
   FK dependency order, preserving TEXT and BYTEA exactly and explicitly inserting
   generated ids. Do not use session_replication_role to disable triggers/FKs.
   A dedicated import mode omits capture and ingest_epoch business triggers until
   loading finishes; install/verify them before target admission. Reset identity
   sequences and ordinal allocators above maxima. Match logical migration history.
4. Verify per-table count and typed digest, constraints, schema catalog, immutable
   identity, sequence state and every filesystem ciphertext hash. Compare every
   credential/public-key byte and user_handle, counter, wrapped data key, version,
   vault path/reference and SimpleFIN access_blob byte for byte. No re-enrollment,
   decryption/re-encryption, base64 normalization, key rotation or pack rewriting.
   Verify source/target decryption yields equal synthetic plaintext in tests.
5. Journal durable states prepared, copied, verified, published and write_enabled.
   Journal operation identity and artifacts are private SQLite state for this
   helper. Resume by recognizing actual published state first; use atomic/fsynced
   marker publication and a generation fence. A crash after target commit but
   before journal advancement must resume without duplicate rows or keys. Refuse
   conflicting source/target active markers. Every server/CLI startup checks them.
6. Publish the backend marker/configuration only after verification. It contains
   backend, operation id and expected generation, never a DSN or secret. Restart
   the target in verification-only mode: no household financial writes, model,
   email, SimpleFIN or jobs. Allow isolated synthetic auth verification on a
   disposable restored copy, not mutation of the authoritative converted state.
7. Before any target write, rollback stops the target and repoints the marker to
   the immutable SQLite source at its original schema/configuration; verify its
   safety digest and credentials. Once write_enabled is durable, restoring that
   old source is refused to prevent silent data loss. A later return to SQLite
   requires a new stopped, verified Postgres-to-SQLite export using the same typed
   bundle importer, including current platform/auth state and files. That reverse
   path is tested before enabling the forward converter, not promised later.
8. Offline commands `verify`, `enable-writes` and `rollback` are separate explicit
   actions sharing the operation id. Outbound remains paused until resumed through
   the existing household control. A stale process using the old marker/generation
   cannot write. Retain verified safety snapshots until explicit operator cleanup;
   this spec performs no real cutover or cleanup.

The converter is backend movement, not MT-03's vault-envelope migration. It
requires the current household layout and does not reinterpret legacy vault data.

## Testing and CI

1. Default `npm test` stays SQLite. A shared fixture factory supplies async
   platform/household handles and injected clocks; domain tests must use it
   instead of creating DatabaseSync. All backend-neutral unit/application tests
   run unchanged under FATHOM_STORAGE=postgres, including auth, tools, ingest,
   planner, jobs, budgets, migration semantics and row/receipt undo. SQLite page,
   WAL, legacy-layout and historical physical-snapshot tests are explicitly
   SQLite-only; Postgres catalog/pool/role tests are Postgres-only. A manifest
   justifies backend-specific tests; no skip based on a missing database.
2. Add unit-postgres in `.github/workflows/ci.yml` with a Postgres 17 service
   container, ephemeral synthetic database and health check. Install exact
   dependencies and run the same npm test command with backend/DSN environment
   provided by CI. A missing/unhealthy service fails the job. Concurrent test
   files get isolated databases, each representing one synthetic instance with
   isolated platform/household schemas, deterministic cleanup and bounded clients.
3. Add a CI storage integration job on the same service: actual SQL, independent
   clients/processes, pool reuse, FK/unique/check failures, two-household canaries,
   serialized last-admin removal/rate limits/job leases/model reservations,
   nested savepoint rollback, trigger/cascade capture, byte-preserving roundtrip,
   abrupt converter kills at each durable boundary and a reverse conversion
   after new target writes. No mocked database or SQL driver inside these tests.
4. Existing SQLite Playwright remains required. Run focused Postgres demo HTTP
   and real WebAuthn journeys in CI, including migrated credentials through a
   CDP virtual authenticator and unchanged RP/origin. Synthetic auth-session
   injection cannot prove passkey preservation. Isolated restoration lets these
   ceremonies increment counters without changing the verified source bundle.
5. Local workers run only touched unit files directly as `node <test-file>` and
   relevant focused Playwright on an executor-chosen nondefault port. Full suites
   run only in CI. No Postgres install, Docker or cluster is required locally;
   PR CI is the Postgres verifier. An implementation cannot report Postgres
   acceptance from SQLite unit results or static inventory alone.

## Ticket split

These are dependency-ordered ticket drafts in this PR, not filed ready work.
Small is one narrow seam; Big is a coupled caller/lifecycle migration. Every
package is one agent run ending at a ready PR on main, with no human action in
its acceptance. Line ranges describe production scope, excluding test fixtures.
Executor: T3 worker, publication authorized when dispatched. Common run limits
are the current implement skill's 600-turn warning, 900-turn stop and refusal of
the 26th child spawn. Large line count alone is not a stop. Recheck before dispatch.

### Common readiness record

Inspected base: 9e9dfb423e562a0866193b57f8c3f104f5746ca7. Probes run:
`node --version` returned v24.22.1; `git rev-parse origin/main` resolved the named
base; `gh pr list --state open --json number,title,headRefName` found MT-04/MT-05
and overlapping tool/API PRs; `gh api repos/Connsulting/fathom/commits/9e9dfb42/check-runs`
showed unit/security checks passed and e2e still running. There is no current
healthy-base receipt. No nested AGENTS/CLAUDE files or ADR registry was found.
No credentials or external resources are needed for this documentation PR.

All drafts are startable **no now** pending this spec's merge, current base CI
and the blockers below; finishable **yes as a contract** with the named worker
and PR CI verifiers. This is not a yes/yes dispatch receipt. Before filing or
labelling ready, refresh main, inspect open PR file ownership and the coordinator
tracker, verify each prerequisite merged, run npm ci and a focused existing base
test, resolve exact driver/service pins, and record current required check runs
and commit statuses. At filing use native blocked-by relations; local PG labels
below are planning references only. Do not dispatch dependent drafts early.

Each readiness record must include base SHA, exact command/results, start/finish
verdicts, riskiest_step and contradiction_review. Common gates are unit, e2e,
gitleaks, npm-audit, actionlint and hadolint, plus Postgres jobs when delivered.
Future test paths below are ticket deliverables, not claims of current evidence.
CI owns the full suites; each worker runs only its focused files and git diff
--check. Cross-provider review and all required PR checks precede readiness.
A reviewer checks AGENTS, this contract, architecture and each touched lifecycle.
Protected behavior includes financial calculations, provenance, auth boundaries,
unchanged public tool/API payloads and real-data exclusion. Caller/test/doc
migration is authorized within each package; no production deployment is.

### PG-1 Small: asynchronous kernel and SQLite conformance

Problem: no async storage contract exists. Base: main. Blocked by: merged PG0.
Decisions: implement this contract as unused infrastructure, one SQLite adapter,
logical prepare descriptors, explicit tx handles and serialized connection queues.
Preconditions: Node 24 and npm ci; existing synthetic test helpers. Production
scope: 400 to 650 lines in src/storage and conformance support, one run.

1. Queries, typed normalization, nested rollback, parent-handle misuse, concurrency,
   close and fixed error codes pass with real SQLite. Verified by:
   `node test/storage/port.test.mjs`. Runs in: worker.
2. The application still runs its original default SQLite route, without importing
   the unused new kernel. Verified by: `node test/store.test.mjs` and PR CI unit/e2e.
   Runs in: worker and PR CI.

Out of scope: live caller conversion, Postgres driver, new store schema.
Readiness: no/contract yes. Risk probe: two simultaneous transactions on one
connection with one nested rollback. Contradiction review: no optional sync API.
Conflicts: none with MT/IMP business modules; recheck package/test-helper ownership.

### PG-2 Big: atomic asynchronous application cutover

Problem: sync assumptions span the complete caller graph. Base: main. Blocked by:
PG-1, MT-04 through MT-07 and IMP-3 through IMP-8 merged; IMP-1/IMP-2 are already
present. Decisions: switch every caller and helper in one PR, preserve SQLite
semantics, move all direct driver/lifecycle code under src/storage/sqlite, replace
raw transaction SQL with handles, await authorization and admission. The default
backend stays SQLite; Postgres is not selectable yet. Preconditions: settled
merged caller graph and synthetic fixtures. Production scope: 4000 to 8000 changed
lines across callers/adapters, mostly mechanical, one Big run with full CI.

1. Static driver-boundary and async-call checks reject DatabaseSync/raw transaction
   escape hatches outside adapters; every changed signature has one form and all
   callers migrate. Verified by: `node test/storage/architecture.test.mjs` plus
   review of the generated caller inventory. Runs in: worker and PR CI.
2. Auth removal/revocation, scheduler jobs, engine admission with
   `budget: {maxCostUsd, ...}`, ingest, tools, UI boundaries and CLIs preserve
   behavior. Verified by: `node test/auth-store.test.mjs`,
   `node test/tenancy-context.test.mjs`, `node test/engine-runtime.test.mjs`,
   `node test/storage/async-cutover.test.mjs`; full unit/e2e in CI. Runs in: worker
   and PR CI. The new cutover test drives real HTTP/CLI boundaries, including
   delayed rejected auth and admission results.

Out of scope: changed auth policy, model budget math, money formulas, deployed data.
Readiness: no/contract yes. Risk probe: delayed auth denial and rejected transaction
rollback through HTTP without leaking or committing a response. Contradiction
review: entire direct-import and callback graph, including demo, evals and legacy
migration CLIs. Conflicts: all MT-04..MT-07 callers and IMP-1..IMP-8 storage/helpers;
serialize behind these packages rather than continually rewriting their branches.

### PG-3 Big: portable SQL, primary-key undo and row ordering

Problem: rowid and SQLite SQL prevent lossless export. Base: main. Blocked by PG-2.
Decisions: apply the dialect table, explicit ordering, v2 undo and complete legacy
log conversion; retain shipped SQL unchanged. Preconditions: async caller graph
and populated synthetic undo/import fixtures. Scope: 800 to 1400 production lines
plus the next free household migration, one run.

1. Populated upgrade preserves existing visible order, deleted-row undo, account
   field-level protection, import receipts, rowid gaps and composite keys; a
   malformed active log aborts atomically. Verified by:
   `node test/storage/identity-upgrade.test.mjs` and
   `node test/ingest/confirm-revise.test.mjs`. Runs in: worker.
2. Search/null/upsert/aggregate semantics and result types match the documented
   SQLite behavior; runtime rowid/lastInsertRowid/raw PRAGMA use is absent outside
   SQLite internals. Verified by: `node test/storage/sql-semantics.test.mjs` and
   `node test/storage/architecture.test.mjs`. Runs in: worker.

Out of scope: altering old migration artifacts, invalidating usable Undo histories.
Readiness: no/contract yes. Risk probe: revert a pre-upgrade deleted natural-key
row after migration. Contradiction review: before/after image conversion against
IMP receipt formats and legacy tenancy digest tests. Conflicts: ingest/receipt
work from IMP-3/4/5/7 and MT migration fixtures; blockers have already serialized it.

### PG-4 Big: Postgres schemas, migrations and conformance CI

Problem: the port has no real second backend. Base: main. Blocked by PG-3.
Decisions: Postgres 17, pg exact lockfile pin, roles/scopes/pools/locks and explicit
migration counterparts; ship unit-postgres and storage integration CI in this
same PR so the backend is verifiable before merge. Postgres config remains
internal test-only until PG-6. Preconditions: existing PR Actions permission and
service-container support from ordinary GitHub-hosted jobs; verify a synthetic
service starts in this PR, no repository secret required. Scope: 1200 to 2200
production lines plus migration SQL and workflow, one run.

1. Every migration and populated upgrade, query normalization, nested rollback,
   role/search_path reset, failed pool client, createHouseholdStorage provisioning,
   sandbox create/cleanup crash recovery, two-household isolation and concurrent
   auth/lease/reservation write test passes on an actual Postgres service. Verified
   by: CI unit-postgres (`FATHOM_STORAGE=postgres npm test`) and storage-postgres
   (`node test/storage/postgres-integration.test.mjs`). Runs in: PR CI.
2. Default demo and entire SQLite suite stay green; missing Postgres does not
   affect local setup, while a missing service fails the Postgres job. Verified
   by: existing CI unit/e2e and the Postgres startup failure case in
   `node test/storage/config.test.mjs`. Runs in: worker and PR CI.

Out of scope: deployment, local containers, external DB credentials, new public
config selection before the converter exists. Readiness: no/contract yes. Risk
probe: one pooled client used successively for A, failed A transaction and B,
with colliding keys and no canary leakage. Contradiction review: all migration
constraints and capture triggers compared to SQLite. Conflicts: MT-05 platform
migration numbers and all future IMP migrations; choose numbers at merge time.

### PG-5 Big: typed bundles, digests and backend-neutral restore

Problem: physical SQLite archives cannot restore into Postgres. Base: main.
Blocked by PG-4 and MT-08 merged. Decisions: upgrade MT-08's one bundle format
to typed rows under a new version, reuse its runner/APIs/restore command, verified
quiesced export, staged same-id restore and reverse importer; preserve explicit
old snapshot operations. No second household backup command is introduced.
Preconditions: real CI database and synthetic keys/trees from helpers. Scope:
800 to 1300 production lines, one run.

1. Both backend roundtrips preserve typed digests, sequences, opaque credentials,
   ciphertext bytes, file references and active Undo; malformed archive, symlink,
   wrong id, disk failure and corrupted bytes refuse publication. Verified by:
   `node test/storage/bundle.test.mjs` on SQLite and CI storage-postgres running
   the same file on Postgres. Runs in: worker and PR CI.
2. A restores without changing B, current identity/membership/spend rules and
   outbound pause survive restore, and a second restart after publication resumes
   correctly. Verified by: `node test/storage/restore.test.mjs` on both backend
   CI jobs. Runs in: worker and PR CI.

Out of scope: PITR automation, destructive cleanup, deployment. Readiness:
no/contract yes. Risk probe: crash immediately after registry publication then
restart twice. Contradiction review: multi-tenancy backup/restore semantics.
Conflicts: MT-08 owns the backup runner and is an explicit merged blocker;
PG-5 adapts its shipped implementation. If MT-08 lands after PG-2, it must use
the async port already on main; if before, PG-2 includes its caller migration.

### PG-6 Big: offline conversion, reverse conversion and backend selection

Problem: an existing instance cannot safely select Postgres. Base: main.
Blocked by PG-5. Decisions: stopped whole-instance conversion, explicit journal
phases, verification-only admission, guarded enable-writes and safe rollback;
reverse export after target writes. Add FATHOM_STORAGE=sqlite|postgres (default
sqlite), FATHOM_POSTGRES_URL_FILE for the runtime DSN and
FATHOM_POSTGRES_PROVISION_URL_FILE for the restricted provisioning entrypoints;
the driver receives TLS configuration explicitly and never logs it. No environment-driven auto fallback.
Preconditions: CI Postgres, synthetic passkeys/keys and writable test roots;
new production secrets are outside acceptance. Scope: 700 to 1200 lines, one run.

1. CLI conversion and reverse conversion pass through all real storage components,
   preserve platform/auth/household bytes and figures, reject unsupported sources,
   fail closed on ambiguous active markers, and recover abrupt kills at every
   durable state without duplicate rows. Verified by:
   `node test/storage/convert.test.mjs` in CI storage-postgres. Runs in: PR CI.
2. Rollback works before enable-writes, is refused afterwards, and a verified
   reverse conversion includes post-cutover writes. Existing synthetic passkeys
   authenticate after forward and reverse conversion with unchanged RP/origin.
   Verified by: `node test/storage/rollback.test.mjs` and
   `npx playwright test e2e/storage-passkeys.spec.mjs` with an executor-chosen
   nondefault port in CI storage-postgres. Runs in: PR CI.
3. Startup defaults to SQLite, refuses backend-marker mismatches and serves an
   actual Postgres demo through HTTP when explicitly selected. Verified by:
   `node test/storage/config.test.mjs` and `node test/storage/http.test.mjs` in
   both backend CI jobs. Runs in: worker and PR CI.

Out of scope: running a real migration, changing public origin, rewrapping keys,
online mixed-backend households. Readiness: no/contract yes. Risk probe: kill
after target publication and before journal update, restart twice, then prove
old-source write fencing and post-write rollback refusal. Contradiction review:
startup/config/scheduler/CLI entrypoints all consult the active marker.
Conflicts: MT-04 operational CLIs and MT-05 admission API, already merged blockers;
MT-06/7 auth, MCP and delivery preserve their current contracts.

### PG-7 Small: operational contract and final acceptance gate

Problem: storage operators need runnable non-private instructions. Base: main.
Blocked by PG-6. Decisions: update architecture/config/multi-tenancy backend clauses
and document the shipped CLI verbs, secret mounts, outage recovery and retention;
no diagrams or UI redesign. Preconditions: exact merged commands and CI fixtures.
Scope: 100 to 200 production lines plus docs/tests, one run.

1. Every documented synthetic setup, verify, convert, rollback, reverse-export and
   restore command is exercised against both backend CI fixtures; the default
   no-Postgres path works. Verified by: `node test/storage/runbook.test.mjs` in
   storage-postgres and SQLite CI; `node test/docs.test.mjs`. Runs in: PR CI and
   worker. The runbook test invokes the actual shipped commands.
2. Readiness reports latest required unit/e2e/security/Postgres checks and one
   cross-provider code review for its head, with no local full-suite claims.
   Verified by: GitHub PR checks and review receipt. Runs in: PR CI and worker.

Out of scope: infrastructure changes, a production cutover or asking for human
click-through acceptance. Readiness: no/contract yes. Risk probe: execute the
published outage/recovery sequence with synthetic state. Contradiction review:
architecture's SQLite-only wording removed only where superseded by this design.
Conflicts: documentation touched by any later MT/IMP package; refresh after merges.

## Assumptions, deferred scope and review

All supported source instances already use current per-household storage and
FTHM2 vault layout. Files remain on the existing private application volume.
Operator provisioning rights and TLS trust are probed, never invented by the
application. There are no unresolved implementation design choices in this spec.
Service hosting, production conversion approval, online migration, replication,
separate database-per-household isolation, RLS and physical disaster-recovery
infrastructure remain outside these tickets.

One cross-provider plan review round completed against b8567d6e within the
20-minute deadline. The reviewer returned REQUEST CHANGES with two blockers.
Both are resolved in the follow-up revision; no second round was requested.

1. Schema creation during admin provisioning and public-demo creation lacked a
   serving-process credential, namespace and crash-recovery contract. Added the
   separate provisioning credential/entrypoints, journaled adoption/publication,
   explicit sandbox names and resumable deletion, with PG-4 acceptance coverage.
2. PG-5 could duplicate MT-08 backup/restore. MT-08 is now a merged blocker and
   PG-5 versions its existing bundle and reuses its runner/APIs/restore command.
3. Clarified the exact 60-character schema hash prefix and isolated synthetic
   database per test file so fixed platform names cannot collide in CI.

Validation: node test/docs.test.mjs passed all nine tests; git diff --check and
inline public-content/ticket-structure checks passed. Source inventory was
reviewed against the inspected base. These checks validate this documentation,
not an implementation of the port. The review findings were fixed by the author;
there is no claim of independent approval of the amended head.
