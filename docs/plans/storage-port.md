# PG0: SQLite and Postgres storage port

Status: proposed specification. This PR changes documentation only. Base inspected:
`9e9dfb42` on 2026-11-08. Implementation tickets belong in this document until
readiness checks pass; this PR dispatches none.

## Risks and dependencies

The synchronous database API reaches nearly every subsystem. Converting callers
to one asynchronous contract is the critical dependency. SQLite remains the
default and requires no database server. Postgres runs only when explicitly
configured. Scheduler, model-budget, MCP, delivery and ingest changes must merge
before their call sites are converted. Migration IDs 029 and 030 are occupied;
031 is the next free household number at this base, not a reserved number.

## Settled direction

1. One asynchronous storage port with SQLite and Postgres adapters. Every caller
   migrates; no synchronous facade, promise-or-value return or old signature.
2. One Postgres database per instance, one schema per household and a separate
   platform schema. The immutable household identity remains authoritative.
3. Backend-neutral query identifiers and explicit dialect implementations replace
   application-owned SQL. Adapter boundaries own transactions and savepoints.
4. Offline, verified conversion retains source SQLite files and opaque credential
   and vault bytes. Rollback after new writes requires a verified reverse export.
5. SQLite stays the default unit backend. CI additionally runs the shared unit
   contract and application suite against a Postgres service container.

The source inventory, complete port contract, conversion protocol and ticket
contracts are being completed in this review branch.
