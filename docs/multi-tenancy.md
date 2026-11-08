# Multi-household Fathom

Status: proposed specification, reviewed against `main` at
`4b800d2da3caa06f4653d2171b8c10482bac1a17` on 2026-11-06. This document ships no
implementation and does not enable multi-tenancy. The [vision](vision.md)
still lists it as deferred. The [architecture](architecture.md) describes the
current application, and [known limits](known-limits.md) remain applicable.

## Risks and external dependencies

1. The email and passkey account change is a prerequisite. At this review no
   account PR was open or merged on `Connsulting/fathom`; the owner supplied its
   contract: one `households` row, `users.household_id`, admin/member roles,
   emailed one-time enrollment links and server-side sessions. Financial tables
   remain unscoped. Re-read its merged PR and migrations before implementation;
   do not implement a second authentication system or retain a header fallback.
2. A wrong database, filesystem root, recipient, tool context or cache can expose
   an entire household. Separate files reduce accidental SQL leakage but share
   a process and operating-system identity. The operator, a compromised process
   and code execution can access all households. This is application isolation,
   not a sandbox against a malicious instance operator.
3. SQLite `DatabaseSync`, document parsing and packet assembly share an event
   loop and memory. Existing large-input limits do not provide tenant fairness.
   Start with at most 20 active households, one background handler per household
   and two background handlers instance-wide. Reject additional provisioning
   with 409 until the operator explicitly raises the configured limit following
   a load test. These are proposed initial bounds, not measured capacity claims.
4. Live Claude calls require an operator-funded API credential and provider terms
   permitting the intended service. Do not assume a personal subscription funds
   unrelated households. Real email needs a verified sender, delivery capacity
   and working enrollment delivery. SimpleFIN needs a separate valid connection
   for each household and vendor approval for the proposed operating model.
   None of those purchases, credentials or legal permissions is granted here.
5. Losing a household data key loses its encrypted files and connection secret.
   Losing the wrapping key affects all households. Recovery requires a tested
   backup of data and separately held secrets. A volume snapshot alone does not
   define a safe single-household restore.
6. The existing schema and account work can change concurrently. Refresh this
   inventory against the merged base; every added table, route, tool and script
   must be classified before multi-household access is enabled. Dependent ticket
   drafts below cannot honestly be certified startable on today's base.
7. Calendar delivery depends on the account PR, approval of this proposed design,
   sequential dependency merges, CI and cross-provider review. No implementation
   or production cutover is authorized by this docs PR.

## Pinned decisions

These come from the owner's task and existing product boundaries.

1. One instance serves many isolated households. A household, including its
   businesses, is the tenant. Membership is not a reason to combine financial
   state across households.
2. Use the parallel email/passkey account model as the starting point. Its first
   household owns all existing financial state; an authentication change alone
   does not scope that state.
3. Preserve read-only aggregation, deterministic figures with provenance,
   advisory-only behavior and synthetic demo/test data. Tax filing, money
   movement and securities selection remain outside the product.
4. Keep the standalone container, SQLite and in-process scheduler direction.
   Multi-tenancy does not itself authorize public ingress or a new hosting stack.
5. This change is a spec only. Tickets are contracts for later work, not a
   dispatch batch. Only this Markdown file belongs in this PR.

## Recommendation: a database and vault per household

| Approach | Isolation and failure mode | Cost for Fathom | Decision |
|---|---|---|---|
| `household_id` on every financial table in one SQLite file | Every read, join, update, unique constraint, foreign key, trigger and JSON reference must preserve the tenant. SQLite has no built-in row-level security to catch an omitted predicate. One broad query can read everyone. | Rebuild existing singleton rows and keys, Confirm undo triggers, planner queries and dedupe identities. Single-household restore needs a dependency-aware row export. | Reject for the first platform version. |
| A SQLite file per household, one app process | A query receives a database containing one household. Colliding file hashes, row ids and singleton ids remain local. A wrong runtime selection is still a disclosure. | Add a small platform database, runtime registry and isolated storage roots. Keep most financial SQL and existing constraints. Back up one household as a unit. | Recommend. |
| A process per household | Adds an address-space boundary; stronger containment requires separate OS identities, secret mounts and volumes too. Shared routing still needs correct authentication. | Process supervision, per-household ports, routing, deployment and resource allocation replace the current one-process design. Startup and upgrades multiply. | Defer until measured workload or trust requirements demand it. |

Use a shared platform SQLite database for identity and control, and a separate
financial SQLite database plus storage directory for each household. Never attach
another household database to a financial connection. The platform schema contains
no balances, documents, conversations, recommendations or private pack content.

Conceptual volume layout, relative to the configured data root:

```text
platform.sqlite
households/<opaque-household-id>/fathom.sqlite
households/<opaque-household-id>/files/
households/<opaque-household-id>/packs/your-plans/
households/<opaque-household-id>/outbox/
households/<opaque-household-id>/work/
```

The server generates opaque identifiers; display names and request paths never
become filesystem paths. The platform registry maps each id to one relative
storage root and generation. Verify root containment, real paths and absence of
symlink escapes before opening any database, file, pack or work directory. A
household database records its immutable household id in metadata; opening it
under another id fails closed. DB files, directories and mounted secrets remain
private to the service OS identity. SQLite rows and generated private packs are
not encrypted by the existing vault; filesystem and backup protection still
matter.

### Resolve once, carry context everywhere

An authenticated request resolves the user, active membership and household state
from the platform database before opening household state. Construct an immutable
household context containing the household id, membership role, database, storage
root, generation, clock, key handle, packs, engine, answerer, scheduler and email
delivery policy. A financial handler gets this context, never the platform DB.

Remove the singleton `db`/`dataDir` captures in `src/server.mjs` and
`src/api/router.mjs`. There is no process-global current household and no default
household when authentication, a key or a CLI selector is missing. Internal
functions that already take a database keep taking the resolved household DB;
their callers must supply matching root, packs and engine from the same context.

Keep one runtime per household generation; retain it until its requests, streams
and jobs finish. Start with the 20-household limit rather than adding eviction.
Suspension and restore reject new work, cancel streams and drain jobs before
closing handles. Late async completions check the generation before committing.
All requests and background tasks capture their context before the first await.

The normalized route representation used by dispatch must also drive auth and
Host/Origin checks. Retain the existing guards for every `/api` path, uploads,
unknown routes and wrong methods, and the separate bearer boundary for `/mcp`.
Encoded spelling must not bypass a boundary. Health exposes only readiness and
schema versions, without household ids, names, counts or storage paths.

## Accounts, membership and provisioning

### Identity and roles

Recommend that one user can belong to several households. A passkey authenticates
the global user; a membership authorizes one household. Migrate the account PR's
`users.household_id` and role into `household_memberships(user_id, household_id,
role, status, version)` with unique `(user_id, household_id)`. Remove the old
columns and migrate every caller in the same package. Do not keep two sources of
membership truth.

| Principal | Allowed actions |
|---|---|
| Household member | Read and edit that household's financial state, use Ask, upload, Confirm, goals, advisor records and packets; create personal MCP keys within the member's financial permissions. |
| Household admin | Member actions plus invite/remove members, change membership roles, household notification recipients, engine on/off and cap within the operator allocation, and request a household backup. Cannot change instance credentials or inspect another household. |
| Instance operator | Provision, suspend and resume households; grant operator roles; set instance limits and household allocations; run backup/restore and migration commands; view counts, health and sanitized codes. No financial API access or impersonation from this role alone. |

An operator who also belongs to a household has financial access only through
that membership. Admin does not imply operator. Persist operator grants in a
separate `instance_operators` table. Initial operator bootstrap requires an
explicit operator command bound to an existing enrolled user; never promote the
first public registrant. Prevent removal or demotion of the last active household
admin and last instance operator transactionally. Record administrative changes
in a platform audit log with ids, action and outcome, never financial payloads,
tokens or email bodies. OS-level operators remain trusted custodians of backups.

### Sign-up, household creation and invitations

1. Launch with operator-provisioned, invite-only household creation. There is no
   open registration endpoint that allocates storage or model credit. An operator
   supplies the initial admin email and display name; the service creates a
   `provisioning` household, a random data key, migrated empty real DB and an
   enrollment invitation. Activate only after all resources exist and the first
   admin has enrolled. A crash leaves a resumable provisioning record, not an
   active half-created household. Automatic cleanup of failed provisioning must
   never delete an existing active root.
   Until MT-10, platform setting `multi_household_enabled` defaults to false and
   provisioning a second non-deleted household in real mode returns 409
   `multi_household_gated`, counting provisioning rows as well as active rows.
   MT-10 adds a release migration setting it true and makes true the new-instance
   default. Before that, tests seed this setting only in their disposable
   platform DB; demo mode is exempt. No HTTP or environment switch bypasses it.
2. A household admin invites an exact email to an exact household with an
   explicit member or admin role. Store a hash of a random 256-bit token, target
   household, normalized email, inviter, role, expiry and consumed/revoked state.
   Use the account PR's verified normalization rules, not provider-specific alias
   folding. Proposed expiry is 24 hours; resend revokes the old token. Token
   consumption and membership creation are one transaction and are single-use.
3. A new user completes the account PR's email proof and passkey enrollment. An
   existing user must authenticate as the invitation's verified email before
   accepting. Following a link is never sufficient to replace an existing
   account's passkeys or add another person's membership. Acceptance does not
   reveal the inviter's other households or copy any financial state.
4. Inviting a person already in another household adds a membership only in the
   target household. It neither moves the user nor grants the inviter visibility
   into existing memberships. Duplicate acceptance is idempotent for the same
   membership. Membership removal, suspension and invitation revocation take
   effect on the next boundary check; pending invitations from a removed admin
   are revoked.
5. Keep enrollment delivery separate from financial notification preferences.
   The enrollment transport may send to the invitee before they are a member;
   financial messages may go only to verified active members of their household.
   Enrollment pages and errors do not disclose other household names or whether
   an arbitrary email already has an account. Apply the account PR's request
   throttles plus at most 20 invitation emails per household per hour.

### Active household and switching

Each server-side session has one active household and a monotonically increasing
context version. The account PR's identity endpoint adds only that user's
membership list and current household. A protected switch endpoint accepts only
an active membership, rotates the context version and returns the new household
summary. Single-membership users enter their household directly; multi-membership
users choose after login. There is no cross-household aggregate dashboard.

Every financial request carries the household id and context version last issued
to that browser. They are assertions checked against the server session, never
selectors that grant authority. A stale tab gets 409 before reading or writing;
an unavailable membership gets a generic 403. Thus a delayed write from the old
tab cannot silently write into the newly selected household. Platform auth and
membership-management routes have separate explicit policies.

Fetch requests, including SSE, use headers `X-Fathom-Household` and
`X-Fathom-Context-Version`. Top-level GET/HEAD downloads use query parameters
`household` and `contextVersion`; the values are identifiers, not bearer secrets.
Reject duplicate values and conflicting header/query assertions. MT-09 delivers
both browser sending and server enforcement in one change, including advisor
anchors and year-end download links. Before MT-09, sessions still resolve only
their authorized household; the one-real-household gate prevents live switching.

Switching clears all client scenario, conversation, pack and search state, aborts
active requests/streams, then fetches the new scenario. Responses include their
captured household/version, and the client drops stale responses. Do not persist
financial payloads in shared local storage. Deep links include a household id;
they require membership and explicit selection before opening financial data.
Background work uses no browser session or browser-active household.

### Required operational controls

MT-03 adds `GET /api/household/outbound` and admin-only
`POST /api/household/outbound` with explicit boolean fields `jobs`, `email`,
`simplefin` and `engine`. Omitted fields retain their state. The server stores
pause flags per household and checks them before new work and external dispatch.
An enabled flag never overrides suspension, missing credentials, unverified
recipients or funding limits. These routes let an admin inspect and explicitly
resume the original migrated household and later a restored household. MT-04
through MT-07 connect their implementations to this same control, without
inventing another resume path.

MT-05 adds OS-operator command `node scripts/reconcile-spend.mjs --household
<id> --round <id> --cost-usd <amount> --receipt-ref <id>`. It accepts a finite nonnegative actual
cost only after the operator has obtained the provider receipt, records receipt
reference and audit outcome without its contents, settles idempotently and
releases unused reservation. A cost above the reserved bound keeps the
household's accounting hold with `reservation_bound_exceeded`; never silently
erase debt. Other households keep using unreserved credit. This exceptional
provider-bound violation requires an operator-reviewed accounting repair; the
ordinary reconcile command cannot disguise it as a within-bound settlement.
Tests supply synthetic receipts. This command reconciles accounting; it does
not automatically enable the household's engine pause flag.

MT-05 also adds OS-operator command `node scripts/model-budget.mjs
--instance-cap-usd <n>` and `node scripts/model-budget.mjs --household <id>
--allocation-usd <n>`. Values are finite dollars from 0 to 10000, rounded to cents;
the command records an idempotent audited setting change. Refuse an allocation
above the instance cap and refuse cap/allocation reductions below current-month
settled cost plus outstanding reservations. Changing a budget never changes
pause flags or reconciles a round. The existing admin cap endpoint remains
bounded by the operator allocation. Both commands are delivered and tested in
MT-05, so setting funding is an operator operation with a specified path.

MT-08 adds admin-only `POST /api/household/backups` returning a queued operation
id and `GET /api/household/backups/:id/status`. A fixed instance backup runner
uses the operator-configured backup destination/key; users cannot choose paths,
keys or another household. `node scripts/backup-household.mjs --household <id>`
invokes the same runner at the OS-operator boundary. Status exposes counts and
fixed codes only. Restore stays an operator command, never a household API.

## Complete storage inventory

The current schema has 46 application tables, including `schema_migrations`.
Every table below has exactly one ownership rule. New household stores replay
shipped migrations and then apply a new migration removing platform-only
`api_keys`; existing households remove it only after verified extraction. Each
database family has its own migration history and version, without editing
migrations that have shipped.

| Tables | Scope and required treatment |
|---|---|
| `schema_migrations` | Independent history in platform DB and every household DB; never infer one household's version from another. |
| `settings`, `content` | Household DB. Mode, onboarding, names, curve picks, time zone, engine switch/cap, planner snapshot, pack generation and narrative JSON are all private. Instance policy uses separate platform settings. |
| `files`, `sources`, `facts`, `accounts`, `transactions`, `balances`, `positions`, `pnl_lines`, `tax_payments`, `documents`, `figures` | Household DB. Every source, file, account, entity, date, locator and figure reference resolves inside this DB. Existing local ids and dedupe constraints remain local. |
| `recs`, `rec_events`, `conversations`, `messages`, `goals`, `deadlines`, `events`, `packs_state`, `decisions` | Household DB. Include archived/trash history, advisor prose, proposals, provenance JSON and token references. A public pack id does not make a household's activation or conversations public. |
| `jobs`, `job_runs`, `job_lock`, `spend_ledger`, `email_sends`, `deadline_alerts` | Household DB. Singletons, job/period uniqueness, run ids, histories and alert dedupe must not suppress another household's work. Instance spend authorization is separate below. |
| `superseded_rows`, `confirm_items`, `column_mappings`, `entity_aliases`, `held_facts`, `confirm_undo`, `confirm_guesses`, `ingest_epoch` | Household DB. Include archived row images, undo TEMP triggers, remembered answers, mapping signatures and singleton epoch. They can contain the same ids and headers in two households without sharing an answer. |
| `planner_recs`, `advisor_reviews`, `advisor_checkin`, `advisor_packets`, `yearend_marks`, `yearend_packets` | Household DB. Run references, review state, packet paths, marks and generated output stay local. |
| `simplefin_connection`, `simplefin_accounts` | Household DB. One connection singleton per household; account mapping and backfill/watermark state never cross roots. |
| `api_keys` | Move to platform DB with immutable `household_id`, creator membership/user id and membership version, scopes, token hash, timestamps and revocation state. No financial fields. |

Platform additions are `households` (lifecycle, storage root/generation, mode,
allocation and wrapped key reference), `users`, `household_memberships`, the account
PR's passkey/challenge/session/enrollment tables, household invitations,
`instance_operators`, platform settings, audit events, provisioning/migration
operation records, notification subscriptions, backup manifests and model-spend
reservations/settlements. Use the merged account PR's actual table names for its
auth records. Passkeys and sessions belong to global users, not financial DBs;
invitations and notification subscriptions carry explicit household ids. Keep
foreign keys and unique constraints on the platform relationships. No SQL join
or cross-database foreign key reaches financial data.

Future migrations must classify every ordinary table and every JSON record
containing identifiers. A test compares SQLite's actual table inventory with the
scope registry; an unclassified table fails CI. SQLite internal tables are not
application data tables.

## Code paths and non-database state

### HTTP, tools, UI and packets

All registered financial routes under `src/api/` use the resolved context:
scenario/identity, rec actions, war games/decisions, packs/entries/What if, Ask JSON
and SSE, threads including Trash, goals/curve, onboarding/notes, demo reset,
keys/MCP info, uploads/retries, Confirm/list/answer/reopen, email, jobs, advisor,
SimpleFIN and year-end routes. Action responses rebuild the scenario with the
same context as the write. File ids, rec ids and thread keys are local identifiers,
not authorization. A foreign-only object id returns the same 404 as a nonexistent
id. An id present in both households selects only the caller's local object.

`src/scenario`, `src/tools`, `src/calc` callers, `src/advisor`, `src/yearend`,
`src/onboarding`, the answerer, grounded token/provenance resolution and private
pack retrieval all receive the same household context. Pure calculators and
immutable public pack definitions can be shared. Public content caches must
exclude private packs and activation state. Your plans paths, generation caches,
search indexes and model context are private even though their pack id is always
`your-plans`.

Advisor HTML and accountant ZIP generation read only the resolved DB and vault.
Build packets in that household's private work directory; delete intermediates
on success, failure and client disconnect, including disconnect during assembly.
Downloads remain authenticated. No static route serves household roots, private
packs, dev outbox, SQLite, backup manifests or work files.

### Ingest and file vault

The `inFlight` set at `src/ingest/pipeline.mjs` currently keys by content-derived
file id alone. Concurrent identical uploads in different households can return a
false duplicate. Move it into the household runtime, with retries using that
same lock. Audit every module cache and closure, including DB-handle-keyed
planner queues, ledger-object-keyed engine queues, scheduler timer maps and live
pack generation caches. Household-local SQL alone is insufficient.

Recommend one random 256-bit data encryption key per household, wrapped under an
operator-mounted key-encryption key. Store only wrapped keys and key versions in
the platform DB, with the household id authenticated during wrapping. The master
key and MCP HMAC secret are separate mounted secrets, never browser inputs or
tracked files. Sharing a master key is a recovery/operations choice; it does not
make all households share the same data key. Loss or compromise of that master
key has an instance-wide effect.

After MT-03, real mode requires `FATHOM_PLATFORM_KEY_FILE` for the wrapping key
and `FATHOM_MCP_SECRET_FILE` for the HMAC secret, both private regular mounted
files. `FATHOM_DATA_KEY_FILE` is an input to the offline legacy conversion only;
it is not a runtime fallback. `FATHOM_BACKUP_KEY_FILE` names the separate backup
encryption key when backup operations are configured. Existing Claude and email
credential variables keep their meanings. A missing real-mode secret refuses
the affected operation, never generates a replacement. The migration verifies
that `FATHOM_MCP_SECRET_FILE` contains exactly the existing HMAC bytes; an
operator can mount the original file without rewriting it. Demo creates its
own wrapping and HMAC keys under private `platform-secrets/` in its synthetic
volume and needs no external secret. MT-02 adds codecs/config validation only;
runtime selection of these secrets and the new envelope happens atomically with
the MT-03 storage migration.

Introduce one versioned vault envelope whose authenticated additional data binds
the household id, object purpose, object id and data-key version. Use fresh
AES-256-GCM nonces. Purposes distinguish uploads, advisor packets and SimpleFIN
credentials. Ciphertext copied into another household must fail authentication,
even when its file hash/id is identical. Resolve stored paths relative to the
household root, validate the expected basename and refuse traversal/symlinks.

The offline migration rewrites existing `FTHM1` blobs and fixed-AAD SimpleFIN
secrets into the new envelope. Only the migration utility reads the old envelope;
the normal server has one format after cutover. Keep immutable originals until
verification and rollback expiry. Rotation rewraps data keys for a master-key
change; changing a household data key requires re-encrypting all of that
household's blobs and secrets before changing its active key version. Rotation
is an explicit later operation, not an automatic retry on decryption failure.

Generated private packs remain private volume data as today; this spec does not
claim whole-database or whole-volume encryption. Backups encrypt their entire
bundle, including SQLite, private packs and metadata.

### In-process jobs and command-line callers

The dispatcher enumerates active households from the platform registry and
invokes their immutable scheduler contexts. Keep `plan`, `brief-email`,
`deadline-alerts`, `trash-purge`, `freshness`, `confirm-guess` and `simplefin-sync`
with their current cadences, household time zones and latest-period catch-up.
Use round-robin household admission with the concurrency bounds above. A failed
household handler records a sanitized error locally and does not stop the next
household. Maintain each DB's `job_lock` and `(job_id, period_key)` uniqueness.

Manual HTTP runs, the nightly tick, successful ingest/retry, Confirm debounce,
decide/revisit, SimpleFIN connect and account-match answers all trigger the
scheduler belonging to the initiating household. Pending reruns and timers remain
inside that scheduler. Planner `runId` must refer to a claimed local `job_runs`
row, not merely any integer. No job can enumerate household financial DBs.

`src/jobs/plan-cli.mjs`, `src/jobs/guess-cli.mjs`,
`scripts/build-your-plans.mjs`, `scripts/email-test.mjs`, demo seed/reset and
operational backup/restore tools require an explicit household selector resolved
by the same platform registry. `scripts/dump.mjs` uses an authenticated session
with its context assertions; it cannot bypass membership. Ingest-check and
test/seed helpers create their own explicitly synthetic household. No CLI falls
back to the original household or an arbitrary directory. Operational commands
use an OS-authorized operator boundary; user-facing financial tools use membership
or an appropriately scoped household key, never an operator impersonation token.

### MCP keys

`/mcp` authenticates against platform `api_keys` before resolving a household
runtime. A bearer key always selects its one immutable household. Browser cookies,
request-supplied household fields and model tool arguments cannot change it.
Keep existing `read` and `write:recs` scopes, with write permission bounded by
the creator's active membership. Recheck household availability, key revocation
and creator membership/version on every request; removal or role reduction
revokes affected keys. A member in two households creates separate keys.

Move the existing HMAC server secret to platform secret storage without changing
its bytes by explicitly mounting it through `FATHOM_MCP_SECRET_FILE`, so migrated
keys still verify. New keys are also household-bound at
creation. Preserve the current wire token shape; no token prefix encodes an
arbitrary filesystem path. Tool contexts include the key's resolved DB, root,
clock and private pack directories. Tool discovery exposes no other household.
MCP remains stateless per request and retains Host/Origin/body/method checks.

### SimpleFIN

Each household claims its own setup token and stores one encrypted access URL
under its data key. Never reuse the original household's connection for a new
household. Keep the URL allowlist, HTTPS and redirect refusal checks; auth is not
an SSRF defense. Token claims, connection status, account mapping candidates,
backfilled flags, sync windows, synthetic ingest files and plan triggers all use
one household context. Connection/account external ids and dedupe stay local.
Disconnect affects only that household and preserves its imported rows. A
restored connection is disabled pending admin reconfirmation to avoid unexpected
outbound work from a restored snapshot.

### Engine budget and Claude credential

Recommend an instance-funded mounted Claude API credential for the first version.
Household admins cannot view, replace or export it. Per-household bring-your-own
credentials are deferred; there is no automatic fallback to an ambient account.
Keep a separate engine runtime, answerer, private prompt history and failure latch
for every household. Purposes `chat`, `job`, `extract`, `confirm` and `title` all
pass the same tenant budget boundary, including corrective retries and tool-loop
continuations. Static public prompts can share cache entries; private dynamic
context, tool results, SDK session ids and continuations cannot.

Household engine switches and `spend_ledger` remain local. A new household gets
zero model allocation until the operator sets it, with a hard configurable
instance monthly cap defaulting to zero on a fresh platform. An admin's cap is
at most its operator allocation, never the instance cap. Existing household spend
and cap migrate without resetting the current month; the operator must explicitly
set the instance funding cap before live calls resume. Use the server's actual
UTC month for funding authorization; `FATHOM_CLOCK` is test/demo-only and cannot
move real spending to a different month.

The shared platform reservation ledger authorizes both household and instance
spend in one SQLite transaction before each paid round. At admission, recheck
household lifecycle/generation and, for user-initiated calls, active membership
and session/key version; a captured context cannot authorize a new round after
revocation. Serialize by credential
across server and CLI processes through that ledger, not the current in-memory
ledger-object queue. Persist a round id, household, actual UTC month, upper bound,
state and final cost/usage counts. Set the provider's maximum spend/output bound
to the authorized remaining reservation. Refuse a call whose worst-case bounded
cost exceeds either remaining budget. Settle by round id idempotently; mirror the
settlement into the household ledger for display. Admission always uses the
platform authority, so a delayed household mirror cannot permit extra spending.

An interrupted or unpriceable round keeps its full reservation, disables further
calls for that household until reconciled by an explicit operator operation, and
survives restart. Never release an unknown cost on a timer. Other households may
use unreserved instance credit. A global credential failure pauses all live
calls; engine-off behavior and deterministic/template outputs remain available.
No prompts, results or credential bytes enter platform accounting.

### Email

Provider credential, sender identity and transport limits are instance settings;
notification recipients, subscriptions, time zone, previews, history and alert
dedupe are household-scoped. Replace global `FATHOM_EMAIL_TO` routing with
verified active member subscriptions. Migrate the original configured addresses
only when they match verified members; otherwise leave financial delivery paused
with an admin-visible code, never silently redirect it.

Resolve membership and subscription again immediately before transport dispatch,
using the same captured household as the composed message. Send separately per
recipient to avoid disclosing member addresses. Never copy financial content to
an operator by default. A notification link identifies its household, then
requires normal login and membership; it grants no access by itself.

Enrollment and financial messages use distinct send functions and policies. A
shared provider client can be reused only if it has no captured recipient or
message state. `dev` writes full bodies and addresses exclusively under that
household's private outbox; enrollment outbox is platform-private. Expose counts
and fixed codes in logs, not addresses, subjects, bodies or provider responses.
Keep financial `email_sends` and `deadline_alerts` local. Do not promise exactly
once delivery: the existing shutdown/send-history gap remains a documented
duplicate-delivery risk; include household identity in provider idempotency keys
when the selected provider supports them.

## Backups and restoring one household

Use an operator command to back up a named household. Pause its new writes,
triggers, email and model admission; drain active work; take a consistent SQLite
backup with SQLite's backup facility or `VACUUM INTO`, not a naked copy of a
WAL-mode database. Copy the frozen vault, private packs, private outbox and
required metadata; exclude transient work files and never replay an outbox,
verify hashes, then resume. Other households continue serving. Export a manifest
with household id, generation, schema/version, inventory hashes, wrapped key
versions and snapshot timestamp. Encrypt the whole bundle with an explicitly
provided backup encryption key held separately from the data volume.

The household bundle includes a restricted export of that household's membership
ids/roles and key-recovery metadata, but no other memberships, global passkey
records, sessions, provider credential or raw master key. Whole-instance disaster
recovery additionally needs a consistent platform backup, every household bundle,
the MCP HMAC secret, all master-key versions and service credentials, held
separately. A household bundle alone cannot reconstruct global user identity on
a replacement instance. Cross-instance identity transfer is deferred.

Single-household restore is replacement of the same registered household id on
the same instance; cloning into another id is refused. The operator supplies the
target id and a verified bundle. Require an explicit confirmation argument equal
to that id, then:

1. Validate bundle identity, hashes, schema compatibility, key availability and
   free space before changing the active root. Unpack into a fresh private root,
   refuse traversal and symlinks, run `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check`, and authenticate every encrypted object.
2. Suspend only the target household. Stop its jobs, drain requests/model rounds
   and close DB handles. Keep a rollback snapshot of its current generation.
   Global spend already authorized is never rolled back with financial data.
3. Atomically change the platform registry's root/generation to the validated
   root. A durable restore operation record allows restart to finish this exact
   switch; no request can observe a half-copied root. Flush the old runtime.
4. Keep current platform memberships and roles. Report drift from the bundle's
   membership metadata but never resurrect a removed user, old invitation,
   session or API key. Revoke all target-household keys and active session
   contexts; a user with other memberships can sign back into those normally.
5. Leave restored SimpleFIN, financial email, scheduled jobs and live model calls
   paused. Reconcile the local spend mirror from the current platform ledger,
   mark historical running jobs interrupted, and require the household admin to
   explicitly resume outbound functions after inspecting status. Restore itself
   completes when the household serves restored data with outbound work paused;
   no human click is part of the restore ticket's done condition.
6. Verify another household's DB, files, roles, sessions, keys and spend are
   unchanged. Retain the rollback generation for the operator's configured
   retention period, default 7 days; deletion of expired backups is explicit
   operator policy. A restored snapshot does not resurrect expired secrets.

Initial service target is a daily household backup with seven daily snapshots.
This proposes a 24-hour recovery point, not a guarantee before scheduling and a
restore drill exist. Migration and restore need free space for the source,
staged replacement and rollback generation, calculated before the operation.
Deletion/suspension is explicit: suspension keeps data and stops access/work;
destructive household deletion requires a separate operator command, revokes
access, stops work and removes its active roots, private packs, outbox and wrapped
data keys. Retained encrypted backups expire under the stated retention policy;
deletion does not claim immediate erasure from already retained backups.

## Migrating the current single household

The auth separation in MT-01 runs first and keeps the original financial
layout working; the steps here are the MT-03 financial cutover. Deploy only after
the account PR is merged and its actual auth schema has been reconciled. Before
then this document's auth table names are assumptions. The migration utility is
offline and resumable, with an exclusive instance lock and
an operation journal. There is no runtime legacy-storage fallback.

1. Run preflight on the source ref: exactly one existing household, all users
   assigned to it, no orphan auth rows, a readable existing data key and MCP
   HMAC secret, sufficient free space and a successful encrypted backup. Refuse
   ambiguous ownership, multiple unscoped stores or a missing key. A deployment
   without accounts first completes the account change, not an inferred owner
   migration from financial values.
2. Stop the server and outbound work. Snapshot platform/auth and financial tables
   together. Assign every existing financial row, file, private pack, job/run,
   cap/spend record, advisor artifact, outbox and SimpleFIN connection to the
   existing household id. No row is assigned by names, emails or account labels.
3. Validate the platform identity/control state already converted by MT-01 from
   `users.household_id`/role to memberships and preserved passkeys. Do not recopy
   identities from stale source tables. Revoke browser sessions/challenges and
   enrollment links for a clean login boundary.
   Move all `api_keys` with their existing hashes/scopes and explicit original
   household binding; preserve the HMAC secret. Existing keys have no recorded
   creator, so bind them to the single admin when exactly one exists; otherwise
   revoke them with a fixed migration code. Never guess among admins.
4. Copy the remaining financial DB and auxiliary directories into the registered
   household root. Remove platform-only auth/key tables from the staged financial
   DB using new migrations; keep all financial ids, provenance, undo history,
   dedupe identities, run references and mode. Do not replay imports or reseed.
5. Generate a new household data key, wrap it, and re-encrypt uploads, advisor
   packets and the SimpleFIN access blob with the new household-bound envelope.
   Validate every object before publication. Copy private packs without changing
   their contents; preserve pack generation and the prior outbox privately.
6. Compare per-table row counts and canonical row digests for unchanged data;
   compare scenario, figures, financial totals, decrypted-file hashes and packet
   content using synthetic migration fixtures. Use schema/count-only receipts
   for a real migration. Verify memberships and migrated-key binding; run SQLite
   integrity/foreign-key checks. Record only counts, hashes and fixed codes.
7. Publish the platform manifest/root mapping only after all checks pass; retain
   the immutable original snapshot. A failed staging operation leaves the old
   instance recoverable; rerun resumes by journal state and never duplicates
   memberships, spend, keys or financial rows. Fail closed if old and new active
   layouts disagree.
8. Start with one active production household and outbound work paused. Log in
   again; verify the migrated state and funding/recipient configuration before
   explicit resumption. MT-10's release migration later opens multi-household
   provisioning, after its isolation gate passes. Keep the rollback snapshot
   for 7 days.
   After new writes, rollback restores a coordinated full snapshot under a
   stopped service; never point the old binary at the newer live volume.

Demo is a separate synthetic instance using the same tenant-resolution code.
Seed/reset selects an explicit demo household and refuses real mode. An open
demo shortcut must never coexist with real household data in the same process.
The existing default demo startup remains secret-free and network-free beyond
its current demo needs.

## Test strategy and acceptance gate

The claim is narrow and testable: for any authenticated household A boundary,
data returned, modified, queued, sent or used as model/tool context belongs to A.
Public immutable packs and the caller's own membership metadata are explicit
exceptions. Root/process compromise is outside this application-level claim.

### Route inventory and adversarial fuzzing

Build an executable inventory from exported `routes` in `src/api/router.mjs`,
the actual auth/control registrations, the exact `/mcp` transport methods and the
tool registry. Every method/path/tool needs a policy classification, fixture
builder and success assertion; zero unclassified entries is the gate. Compare
the inventory to live dispatch, not just a parallel hand-maintained allowlist.
A new route/tool fails CI until its cross-household case exists.

For every `/api` route, including auth/control routes and unknown paths, and
every `/mcp` method and tool:

1. Create two synthetic households in one real application process, active admin
   and member sessions for each, an A+B member, and an operator without financial
   membership. The Node harness uses a client-side software WebAuthn authenticator
   to sign real registration/assertion challenges; the actual server verifies
   them. Read enrollment links from a local mail sink. Browser e2e separately uses
   Playwright virtual authenticators. Do not mint sessions directly, inject
   authenticated identities or bypass the session resolver.
2. Create overlapping local ids, file hashes, pack ids, job/period ids, entity
   names, numeric amounts, Confirm subjects and account external ids. Also give
   B unique synthetic canaries in files, notes, facts, messages, private packs,
   packet bodies and email recipients. This detects accidental local-id matches
   as well as broad reads. Assert A's expected complete result, not merely the
   absence of one string.
3. Replay every valid B request with A's session and A's required context
   assertions while retaining B's object references. A foreign-only object must
   behave like a nonexistent one. A colliding id must affect only A's record.
   For requests without object ids, assert complete A-only results, counts,
   balances, provenance and histories. Run the symmetric B-to-A direction.
4. Separately substitute B's household/version assertions, ids in path/query/body,
   nested arrays and JSON references, pack entry names, stored paths and upload
   metadata while authenticating as A. Require pre-handler refusal of mismatched
   context, including on GET and HEAD. Exercise anonymous, expired/revoked
   sessions, removed membership, suspended household, stale version, nonmember
   operator and each admin-only action with a member.
5. Fuzz raw and percent-encoded path separators/segments, double encoding, malformed
   ids, duplicate query/header fields, wrong verbs and content types, forged Host
   and Origin, browser cookie plus foreign bearer combinations, JSON-RPC batches,
   tools/list and each tools/call. A browser session alone never authenticates
   `/mcp`; use A and B bearer keys for its successful cases. MCP session-only,
   foreign-key, revoked-key and wrong-scope cases must all be covered.
6. Use 100 fixed, recorded seeds with five mutations per route/method/tool per
   direction in nightly CI; use two of those seeds per PR. Deterministic fixtures
   cover each authorization class on every PR regardless of the random seed.
   Print only synthetic seed, route template, mutation kind and assertion code.
   Save minimized synthetic repros on failure; never fuzz against real data.
7. Inspect HTTP bodies/headers, all SSE events before final grounding, downloads
   after decryption/decompression, emitted model requests,
   email sink/outbox and queued jobs. Compare B's DB logical digest and filesystem
   manifest before/after each unauthorized A mutation. A 404 with a B-side effect
   is a failure. Inspect sanitized logs for leaked payloads and credentials.

These probes run against the actual HTTP/session/router/runtime/store/vault/tool
path. Use local external-service emulators at the model, mail and SimpleFIN
network boundaries, while keeping the changed internal code real. Fake engine
mode tests deterministic grounding, but isolation integration also runs live-mode
transport pointed at the local model emulator and observes its received context.
MT-05 adds programmatic `testTransport` injection into the server/engine test
bootstrap for both Messages HTTP and SDK HTTP destinations. It requires explicit
loopback endpoints and a synthetic credential generated by the fixture; the
normal CLI bootstrap never accepts or passes it. There is no environment, HTTP
or real-credential base-URL override. The SDK test child gets its loopback base
URL through this harness only; production destinations remain fixed. This
replaces only the external network destination, not internal engine, tools,
authentication or accounting. No paid/provider credential is needed for the
isolation gate; external provider smokes are separate, explicitly funded
deployment checks.

### Lifecycle, recovery and browser proof

1. Race identical uploads in A and B; both must store/import independently. Race
   Confirm revisions, private-pack rebuilds, manual jobs, title generation and
   engine cap changes. Prove caches, locks, generations and ledgers remain local.
2. Drive scheduled, CLI, manual and ingest-triggered jobs across both households.
   Restart mid-run, simulate one handler failure and assert B progresses; verify
   catch-up, leases, alert dedupe, spending and recipients per household.
3. Replay membership removal, suspension and household switching during uploads,
   pending responses and SSE. A stale tab must not expose new-household content
   or write into it; a revoked operation cannot dispatch email or a new paid round.
4. Attempt to decrypt B's ciphertext using A's context, including identical ids,
   swapped wrapped keys and mismatched purposes. Attempt symlink and traversal
   access through packets, packs, upload retries, backup extraction and CLIs.
5. Submit concurrent paid rounds through the server and CLI against household
   and instance caps. Crash between reserve/send/settle/mirror, restart, and prove
   admission includes outstanding reservations and never duplicates a settlement.
6. Migrate a synthetic legacy store containing every table and each artifact type.
   Inject a failure at every journal phase and rerun. Compare unchanged semantic
   digests, figures, decrypted bytes, passkeys, MCP binding and spend, including a
   missing key, invalid ownership, preexisting target and insufficient space.
7. Back up A, mutate A and B, then restore only A. A's financial state must return
   while B's state and credentials remain current; removed A members and revoked
   tokens stay revoked, current spend is retained, and outbound work stays paused.
   Crash before and after the registry switch and recover deterministically.
8. Playwright verifies enrollment, two-household selection, role controls,
   household-labelled deep links, two tabs with stale context, logout and login,
   packet downloads, browser state and demo reset. Render desktop and phone
   surfaces and compare household names/context against the fixtures. No real
   data in screenshots.

Implementation gate: `npm test`, `npm run e2e` and the existing CI real-mode smoke
remain required. The final ticket adds `node --test test-isolation/route-fuzz.mjs`
and `npx playwright test e2e/tenancy.spec.mjs` as focused gates. Mark the phone
cases `@mobile` so the existing mobile project selects them. Ordinary package
tests remain under the npm test globs; the exhaustive fuzz runner deliberately
lives outside them and needs no browser installation.

MT-10 adds `.github/workflows/tenancy.yml` with pull-request, main-push and
`17 3 * * *` UTC schedule triggers. Its browser-free PR job installs Node 24 and
runs `npm ci` then the fuzz command with two seeds, five mutations and a
600,000 ms execution budget; job timeout is 15 minutes. Its nightly job runs
`FATHOM_FUZZ_SEEDS=100 FATHOM_FUZZ_BUDGET_MS=3600000 node --test
test-isolation/route-fuzz.mjs`, with five mutations and a 75-minute job timeout.
The runner enforces the elapsed budget and reports synthetic seed/case counts.
Measure both suites before marking MT-10 finishable; keep every route/tool
covered, and split independent CI shards if a measured run exceeds its budget.
Playwright remains in the existing browser-equipped e2e job. A docs review or
green single-household suite is not evidence that isolation is implemented.

## Ordered implementation ticket contracts

### Mergeable intermediate states

| Package | Identity/control storage | Financial storage served after merge | Cutover rule |
|---|---|---|---|
| MT-01 | Creates `platform.sqlite`; offline `node scripts/migrate-platform.mjs` moves auth rows and memberships into it, preserving passkeys. | Original singleton `fathom.sqlite`, existing vault and HMAC format. | Real startup refuses with `platform_migration_required` until this migration completes. Demo creates its synthetic platform state automatically. |
| MT-02 | Adds wrapped-key records and the new codecs, without selecting them in the running server. | Unchanged singleton DB and existing vault envelope. | New codec tests and conversion utility land first; no dual-reader runtime or early format switch. |
| MT-03 | Uses the platform DB established by MT-01 and installs root/generation records. | Per-household DB/root and the sole new envelope, including basic platform-key lookup preserving existing MCP use. | `node scripts/migrate-tenancy.mjs` converts financial storage and vault together; unmigrated real startup refuses with `tenancy_migration_required` and names that command. Delivers outbound pause/resume controls at cutover. |
| MT-04 through MT-08 | Same platform registry; each package adds its own control tables. | Same per-household format; exactly one real household remains admitted. | Each package keeps existing demo and original-household paths working. New subsystems honor the shared pause flags. |
| MT-09 | Adds context assertion checking and switching atomically with all browser senders. | Same per-household format. | Real second-household provisioning stays gated; test fixtures explicitly enable disposable platform policy. |
| MT-10 | Release migration enables multi-household provisioning. | Same per-household format. | No second real household is created by tests, deployment or this docs PR. |

Each offline phase journals its own operation and leaves an immutable source
snapshot; new migrations remove moved tables only after verified extraction.
MT-01 delivers the offline encrypted source-snapshot helper used by both
migrations, loading `FATHOM_BACKUP_KEY_FILE`; it runs with the source server
stopped and is tested with synthetic keys. Thus migration backup does not depend
on the online single-household backup runner delivered later in MT-08.
The MT-03 migration validates MT-01 platform identity rather than copying it a
second time. There is one runtime storage format at each intermediate revision,
not a compatibility branch selected by whichever files happen to exist.

### Readiness, execution and calendar estimate

These are ordered draft contracts, not filed issues. They follow the
`implementable-ticket/v1` Problem, Base, Blocked by, Decisions, Preconditions,
Acceptance criteria and Out of scope shape. The list is designed for one T3
implementation run per package, ending at a ready PR with tests and an independent
review. No package is dispatched by this document. Every package targets `main`
after its dependencies merge. Every predecessor also requires its independent
review, green checks and coordinator-authorized merge; a ready PR is not a
merged dependency. Native tracker blocking relations must be created
when real issues exist; the identifiers below are document labels, not fake
tracker links.

Current readiness is deliberately not yes/yes: the account prerequisite and
proposed storage/context contract are absent from the inspected base. The skill
requires current probes, so none of the dependent drafts passes dispatch readiness
today. Do not file them as ready, claim future commands passed, or invent merged
dependencies. Before filing each actionable ticket, resolve its native blockers
and record `startable` and `finishable` verdicts, the resolved base SHA, owning
execution environment, actual command/results, `merge_gates`, `riskiest_step` and
an independent `contradiction_review`. A no stays out of the dispatch batch.

Evidence on 2026-11-06: `git ls-remote origin refs/heads/main` resolved the source
SHA at the top; `gh pr list --repo Connsulting/fathom --state open --json
number,title,files` returned no open PRs. The latest `unit` and `e2e` check runs
on that SHA were completed/success, and commit statuses contained no contexts.
The repository's `.github/workflows/ci.yml` runs `npm ci`, `npm test`,
`npx playwright install --with-deps chromium`, `npm run e2e` and a real-store smoke.
There is no docs-specific waiver or generated-file gate. This is base evidence,
not a readiness certificate for future implementation heads.

All package verifiers below are proposed tests to be delivered by their package,
run in the worker against synthetic storage and local boundary emulators. They
require no production access, live vendor account, paid call, container or
cluster. Existing demo e2e and real-mode smoke must migrate with the account
change; a stale Tailscale-header smoke cannot satisfy the later session contract.
Scope includes necessary callers, fixtures and docs, with the ordinary 150-line
outside-scope grant; broaden a contract before dispatch when more is needed.
Projected changed production lines below exclude tests and are estimates, not
scope fences. The current implement skill permits large changes, warns at 600
driver turns, stops at 900 and denies a 26th child spawn. Each package budgets one
run below those bounds; stop and split on nonconvergence rather than bypassing a
hook.

Calendar assumption: each first implementation run gets a 4-hour elapsed planning
window; reserve another 4 hours per package for CI, cross-provider review and one
repair cycle. These are provisional scheduling allowances, not measured run
durations or a promise. With no capacity wait, external delay or review rework,
the dependency graph below has nine sequential 8-hour windows, about 72 elapsed
hours from the last prerequisite merge; MT-04 and MT-05 can run together in
isolated worktrees. Let T0 be the actual account-PR merge and design approval
time. The earliest target is T0 + 72 hours. For illustration only, T0 at
2026-11-09 00:00 UTC yields 2026-11-12 00:00 UTC. No start date is committed;
every CI failure, review repair, merge-queue or external-access wait shifts it.
Coordinator merge authorization is an external gate after every package; the
72-hour illustration assumes zero wait at those gates and excludes their actual
elapsed waits, which must be added along the dependency chain.

1. **MT-01: Separate platform identity and household membership.**

   Problem: the account design binds each user to one household and has no
   distinct operator authority. Base: `main`. Blocked by: merged account change
   and accepted design. Decisions: create `platform.sqlite`, the offline auth
   migration and its encrypted source-snapshot helper in this package; refuse
   unmigrated real startup with `platform_migration_required`, and enforce
   `multi_household_enabled`/409 `multi_household_gated` until MT-10. Retain the
   singleton financial layout. Global users,
   multi-household membership, explicit operator bootstrap and invite-only
   provisioning as specified above;
   implement backend control records and enrollment policies with creation gated
   off until MT-10. Preconditions: inspect the merged account PR and verify its
   auth tests, fixture and migration command on the resolved base. Estimated
   production change: 500 to 900 lines; one run. Acceptance criteria:

   1. Existing user membership migrates once; duplicate invitations, email
      mismatch, replay, role escalation and last-admin/operator removal are
      refused; an operator without membership cannot read financial state.
      Verified by: `node --test test/tenancy-identity.test.mjs`. Runs in: worker.
   2. The account PR's passkey/session/enrollment tests and the complete existing
      suite remain green after every caller leaves `users.household_id`.
      Verified by: `npm test`. Runs in: worker.
   3. Unmigrated real startup refuses; a second non-deleted real household,
      including one still provisioning, gets 409 `multi_household_gated`.
      The source-snapshot helper encrypts and round-trips the stopped source
      using a synthetic `FATHOM_BACKUP_KEY_FILE`. Verified by:
      `node --test test/tenancy-identity.test.mjs`. Runs in: worker.

   Out of scope: financial calculations, public registration and provider setup.
   Readiness now: startable no, finishable no; missing merged account contract
   prevents a current migration/risk probe. Required riskiest-step probe at
   readiness: run the migration test on the actual account schema and authenticate
   an unchanged passkey. Contradiction review: reconcile account role/session
   rules with the membership and operator rules in this document.

2. **MT-02: Bind vault keys and artifacts to households.**

   Problem: the current one-key vault and fixed SimpleFIN AAD cannot identify a
   tenant. Base: `main`. Blocked by: MT-01. Decisions: per-household wrapped keys,
   one new envelope codec, migration-only conversion reader, contained private
   roots; leave the server on its original envelope until MT-03.
   Preconditions: synthetic mounted master/data keys and local ciphertext
   fixtures created by tests; no live key. Estimated production change: 300 to
   600 lines; one run. Acceptance criteria:

   1. Upload, advisor packet and connection ciphertext decrypt only with the
      correct household, purpose, object and key version; wrong roots and
      symlinks are refused. Verified by: `node --test test/tenancy-vault.test.mjs`.
      Runs in: worker.
   2. Old-format synthetic objects convert and validate without changing their
      plaintext; failed conversion publishes nothing. Verified by:
      `node --test test/tenancy-vault-migration.test.mjs`. Runs in: worker.

   Out of scope: whole-database encryption and an operational key-rotation UI.
   Readiness now: startable no, finishable no; MT-01 absent. Required risk probe:
   swap equal-id ciphertext between two roots and observe authentication failure.
   Contradiction review: account for every vault reader, including SimpleFIN
   and packets, in conversion tests; verify the server keeps its original
   envelope until the MT-03 cutover.

3. **MT-03: Resolve household runtimes and migrate the original store.**

   Problem: the server captures one DB/root/runtime and ingest has a global
   file-id lock. Base: `main`. Blocked by: MT-01 and MT-02. Decisions: platform
   registry, immutable contexts/generations, per-household runtime/locks and the
   offline journaled financial migration above, including platform-key lookup
   preserving current MCP use; deliver the outbound status/pause/resume routes and
   guards in this package. Keep extra production-household creation
   gated off. Preconditions: synthetic legacy fixture with every table and
   artifact, staged roots and local keys. Estimated production change: 800 to
   1400 lines; one run. Acceptance criteria:

   1. Every financial API/scenario/answerer/tool/pack/packet caller receives one
      matching DB/root/runtime; concurrent equal-byte uploads in two synthetic
      households both import. Verified by:
      `node --test test/tenancy-context.test.mjs`. Runs in: worker.
   2. Migration preserves semantic row digests, figures, plaintext artifacts,
      valid key hashes and ownership; each phase failure resumes safely and
      source ambiguity refuses. Verified by:
      `node --test test/tenancy-migration.test.mjs`. Runs in: worker.

   3. An admin can inspect and resume the migrated household through
      `/api/household/outbound`; a member cannot change flags, and unavailable
      credentials or funding never become an implicit bypass. Verified by:
      `node --test test/tenancy-outbound.test.mjs`. Runs in: worker.

   Out of scope: changing financial math, production cutover and legacy runtime
   fallbacks. Readiness now: startable no, finishable no; MT-01/02 absent. Required
   risk probe: interrupt migration immediately before manifest publication and
   restart twice. Contradiction review: trace all server and script singleton
   captures against the context contract and migration preservation rules.

4. **MT-04: Scope scheduler dispatch and operational callers.**

   Problem: schedules, trigger closures and CLIs assume one household. Base:
   `main`. Blocked by: MT-03. Decisions: current per-household cadences/leases,
   round-robin dispatch, one active handler per household and two instance-wide,
   explicit CLI selectors, no default root. Preconditions: synthetic two-household
   runtime and controllable test clock. Estimated production change: 350 to 650
   lines; one run. Acceptance criteria:

   1. Nightly, manual, ingest, Confirm and SimpleFIN-triggered work remain local;
      restart and one handler failure preserve other-household progress and
      job-period independence. Verified by:
      `node --test test/tenancy-jobs.test.mjs`. Runs in: worker.
   2. Plan, guess, private-pack build, email-test, dump and seed/reset callers
      reject missing/foreign selectors and use their authorized household.
      Verified by: `node --test test/tenancy-cli.test.mjs`. Runs in: worker.

   Out of scope: an external queue and changed financial triggers. Readiness now:
   startable no, finishable no; MT-03 absent. Required risk probe: run two identical
   job ids/periods in separate household DBs and fail the first handler.
   Contradiction review: preserve the existing one scheduler path and lease rules.

5. **MT-05: Enforce household and instance model budgets.**

   Problem: a shared credential with ledger-object queues cannot cap concurrent
   server/CLI spend. Base: `main`. Blocked by: MT-03. Decisions: operator-funded
   credential, zero new allocations, UTC funding months, transactional round
   reservations, operator funding/allocation commands and reconciliation,
   programmatic loopback-only
   `testTransport` injection and idempotent household mirrors. Preconditions: local model
   HTTP emulator exercising live-mode serialization and synthetic usage, no paid
   calls. Estimated production change: 500 to 900 lines; one run. Acceptance
   criteria:

   1. All five purposes, tool continuations and retries reserve against both
      caps; server/CLI concurrency and crashes cannot overspend, double settle
      or release an unknown reservation. Verified by:
      `node --test test/tenancy-budget.test.mjs`. Runs in: worker.
   2. The model boundary sees only the requesting household's context; one
      household's poisoned accounting does not poison another runtime with
      unreserved credit. Verified by:
      `node --test test/tenancy-engine.test.mjs`. Runs in: worker.

   3. The operator reconcile command validates receipt references, refuses a
      foreign round and over-bound settlement, and clears a known-cost hold
      idempotently without enabling outbound work. The normal bootstrap cannot
      redirect a real credential through the test harness. Verified by:
      `node --test test/tenancy-reconcile.test.mjs`. Runs in: worker.
   4. The operator budget command sets instance funding and household allocation
      idempotently with an audit record, refuses an allocation above the cap and
      reductions below committed spend/reservations, and never changes pause
      flags. Verified by: `node --test test/tenancy-budget.test.mjs`.
      Runs in: worker.

   Out of scope: live billing integration and personal subscription credentials.
   Readiness now: startable no, finishable no; MT-03 absent. Required risk probe:
   crash after provider response and before mirror, then issue a CLI round.
   Contradiction review: trace all paid rounds through the reservation boundary
   and verify the SDK's configured maximum cost can honor the proposed bound.

6. **MT-06: Bind MCP credentials and every tool to one household.**

   Problem: the MCP/key services capture the original DB and expose no tenant
   binding. Base: `main`. Blocked by: MT-03 and MT-05. Decisions: platform key
   lookup, immutable household/creator binding, existing scope set and stateless
   MCP requests. Preconditions: synthetic keys and normal tenant runtimes.
   Estimated production change: 250 to 500 lines; one run. Acceptance criteria:

   1. Every tool reads/writes only its bearer household, including private packs
      and colliding rec ids; a cookie or household argument cannot widen it.
      Verified by: `node --test test/tenancy-mcp.test.mjs`. Runs in: worker.
   2. Removal, scope reduction, revocation, suspension and restore generation
      invalidate affected keys without affecting another household's keys.
      Verified by: `node --test test/tenancy-mcp-revocation.test.mjs`.
      Runs in: worker.

   Out of scope: new write scopes and cross-household tools. Readiness now:
   startable no, finishable no; prerequisites absent. Required risk probe:
   tools/call using A's bearer plus B's cookie, id and private-pack reference.
   Contradiction review: retain Host/Origin and exact `/mcp` transport policies.

7. **MT-07: Isolate financial email and SimpleFIN delivery.**

   Problem: global recipients and connection/key captures can disclose data
   outside the initiating household. Base: `main`. Blocked by: MT-04, MT-05 and
   MT-06. Decisions: verified member subscriptions, separate enrollment policy,
   household outboxes, one encrypted SimpleFIN connection per household and
   existing SSRF guards. Preconditions: local mail sink and local SimpleFIN
   emulator, synthetic setup tokens. Estimated production change: 400 to 700
   lines; one run. Acceptance criteria:

   1. Manual/periodic messages and previews contain only local data and reach
      only current verified subscribed members; removal before dispatch blocks
      delivery; outbox/deep links remain local. Verified by:
      `node --test test/tenancy-email.test.mjs`. Runs in: worker.
   2. Connect, sync, matching, watermark, dedupe and disconnect remain independent
      with colliding external account ids; unsafe claim URLs still refuse.
      Verified by: `node --test test/tenancy-simplefin.test.mjs`. Runs in: worker.

   Out of scope: provider purchases, holdings mapping and exactly-once mail.
   Readiness now: startable no, finishable no; prerequisites absent. Required risk
   probe: remove a recipient between composition and the real transport boundary.
   Contradiction review: compare recipient policy and every connection trigger to
   household membership and scheduler context.

8. **MT-08: Back up and restore one household.**

   Problem: volume snapshots have no single-household recovery contract. Base:
   `main`. Blocked by: MT-07. Decisions: encrypted consistent bundles, same-id
   generation replacement, current membership/spend preservation, paused outbound
   work, admin backup-request/status APIs, the fixed backup runner and seven-day
   default retention. Preconditions: synthetic two-household
   fixtures, local backup key, writable test storage and disk-failure injection.
   Estimated production change: 500 to 900 lines; one run. Acceptance criteria:

   1. Backup includes the named DB, vault, private pack and restricted metadata;
      missing keys, wrong identity/schema and tampered bundles refuse before
      active state changes. Verified by:
      `node --test test/tenancy-backup.test.mjs`. Runs in: worker.
   2. Interrupted restore recovers at each phase, restores A alone, preserves B
      and current authorization/spend, revokes A contexts/keys and leaves
      outbound work paused. Verified by:
      `node --test test/tenancy-restore.test.mjs`. Runs in: worker.

   3. An admin can queue and inspect only its own household backup; the fixed
      runner uses the configured key/destination, while members and foreign ids
      are refused before queuing. Verified by:
      `node --test test/tenancy-backup-api.test.mjs`. Runs in: worker.

   Out of scope: cross-instance user transfer and restoring production. Readiness
   now: startable no, finishable no; prerequisites absent. Required risk probe:
   crash after the root/generation switch before restart completion.
   Contradiction review: compare rollback and restore behavior with current
   platform identity, credentials, reservations and WAL handling.

9. **MT-09: Add household selection and role-aware management.**

   Problem: UI state and deep links assume one household. Base: `main`.
   Blocked by: MT-08. Decisions: session context versions on every financial
   request, stale-tab refusal, cleared browser state and role controls specified
   above; provision only synthetic additional households until MT-10.
   Preconditions: virtual passkey authenticator, local enrollment sink and
   two-household fixture. Estimated production change: 450 to 800 lines; one
   run. Acceptance criteria:

   1. Enrollment, invitations, operator provisioning, member/admin controls and
      switching work through real session APIs with no data copied between
      households. Verified by:
      `node --test test/tenancy-management.test.mjs`. Runs in: worker.
   2. Desktop/phone rendering, two-tab stale writes, delayed responses/SSE,
      deep links and logout preserve visible household identity and isolation.
      Verified by: `npx playwright test e2e/tenancy.spec.mjs`.
      Runs in: worker.

   Out of scope: open sign-up, public ingress and a cross-household dashboard.
   Readiness now: startable no, finishable no; prerequisites absent. Required risk
   probe: switch in one tab while another submits a delayed write and stream.
   Contradiction review: inspect every browser API helper and cache against the
   server-side active-context contract.

10. **MT-10: Gate multi-household activation on adversarial isolation tests.**

    Problem: scoped happy paths cannot prove complete boundary coverage. Base:
    `main`. Blocked by: MT-09 and all prior packages. Decisions: route/tool/schema
    classification, deterministic mutation counts and black-box lifecycle gate
    specified above; add the separate scheduled fuzz workflow and release
    migration enabling `multi_household_enabled` only after this gate passes.
    Preconditions: all predecessor tests green on the resolved base, synthetic
    fixtures and local external-service emulators. Estimated production change:
    100 to 250 lines plus test harness/fixtures; one run. Acceptance criteria:

    1. Every `/api` and `/mcp` route/method/tool has a successful authorized case
       and symmetric foreign-household attacks, with zero unclassified entries;
       DB/files/email/model/SSE effects satisfy the stated isolation invariant.
       Verified by: `node --test test-isolation/route-fuzz.mjs` and
       `FATHOM_FUZZ_SEEDS=100 FATHOM_FUZZ_BUDGET_MS=3600000 node --test test-isolation/route-fuzz.mjs`.
       Runs in: worker and the new browser-free tenancy CI jobs. PR execution
       fits 600,000 ms and nightly execution fits 3,600,000 ms; the package adds
       the schedule trigger, per-job timeouts and measured timing receipts.
    2. Lifecycle/recovery, secret-free demo and real-session smoke pass; only
       then does operator provisioning admit a second real household.
       Verified by: `npm test`, `npm run e2e` and CI's real-mode smoke adapted
       to server-side sessions. Runs in: worker and PR CI.

    Out of scope: deploying a second real household and starting any follow-on
    feature. Readiness now: startable no, finishable no; predecessor code and
    current runnable gate do not exist. Required risk probe: add a deliberately
    unclassified route and inject a foreign runtime in a test-only fixture; both
    must make the gate fail. Contradiction review: independent reviewer traces
    the live route/tool inventory and verifies that all tests cross the changed
    internal components without replacing their authorization or persistence.

## Assumptions

1. Households trust their active members with all household financial data.
   Admin/member is administration versus financial access, not field-level
   secrecy. Separation within a household requires another spec.
2. Initial use fits one service process and the proposed 20-household bound.
   The deployment continues using a private network and a stable HTTPS origin
   suitable for the account PR's WebAuthn relying-party configuration.
3. The account PR supplies secure passkey enrollment/recovery, session cookies,
   CSRF defenses and email proof. Its exact schema and test names are not yet
   known; implementation readiness requires reading its merged code and PR.
4. The operator supplies writable private storage and mounted wrapping, backup,
   HMAC, model and mail secrets. Tests supply synthetic equivalents only.

## Open questions

These do not require choices inside the proposed first implementation: the
defaults above fix that scope. Changing a default needs a revised contract before
dispatch.

1. Should a later commercial service admit public sign-up? Recommendation: retain
   operator-provisioned invitations until abuse controls, funding and vendor
   terms have been approved for that deployment.
2. Does actual load require stronger containment than one process? Recommendation:
   measure event-loop delay, memory and per-household job latency at 20 synthetic
   households before raising the limit; use process isolation if the shared
   runtime cannot meet the deployment's subsequently agreed service target.
3. What backup retention and recovery time does a commercial deployment need?
   Recommendation: begin with seven daily snapshots and a measured restore drill;
   set a recovery-time commitment only after that outside check exists.

## Deferred scope

1. Public SaaS ingress, open registration, billing/subscriptions and payment
   collection; provider contracts and production deployment are separate gates.
2. Process/container isolation per household, distributed scheduling, sharding
   and a database service replacing SQLite.
3. Cross-household reporting, moving or merging households, cloning/restoring a
   household under another id, and cross-instance identity portability.
4. Advisor identities, delegated professional access and per-document sharing.
5. Household-supplied Claude credentials, custom mail transports/senders per
   household, hardware-backed key management and a key-rotation interface.
6. Whole-database encryption and immediate deletion from retained backups.
