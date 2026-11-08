# Fathom agent instructions

Fathom is a year-round financial co-pilot for a household of independent professionals. The
product definition is [`docs/vision.md`](docs/vision.md). The clickable mock in
[`mock-v2/`](mock-v2/) is the design reference; the Horizon design is the chosen direction.

The project is in the build phase: a standalone, self-hosted app that runs as one container in the
owner's homelab, reachable only on the owner's private network.

## Repository rules

1. `main` is always deployable and runs end to end on demo data with no secrets and no network
   access beyond what the demo needs.
2. Real household data never enters the repository. It lives in the deployment's data volume and,
   for the mock, in the gitignored `mock-v2/private/`. Imports, exports, raw dumps and derived
   files stay out of git (see `.gitignore`).
3. Demo and test fixtures are synthetic. Generate the mock's synthetic scenario with
   `node mock-v2/tools/synthesize.mjs`, which fails on any leaked name or literal amount.
4. No real names, account numbers, tax identifiers, addresses, credentials, hostnames, usernames,
   network names or home paths in tracked files, commits or PR text. Refer to "the owner" and
   "the spouse". Code takes hosts, contexts, origins and secrets from its caller or environment.
5. Secrets come from the environment or mounted files at runtime, never from tracked files.
6. Every change ships with tests. End-to-end coverage uses Playwright against the demo build.

## Agent workflow

These override the general implement process where they differ. Several agents share one build
host, and full local suites on a loaded host time out at random, cost reruns and prove nothing CI
does not.

1. Locally, run only the tests for what you touched: the unit files and Playwright specs that
   cover the changed modules, plus any test you added. Do not run the full `npm test` or the full
   Playwright suite locally. CI runs both on every push and is the full-suite gate.
2. A test that times out locally while unrelated to your change is host load. Rerun that one file
   alone once. If it passes alone, leave it to CI; do not keep rerunning the suite.
3. Run Playwright on a port of your own (not the default 4173) so parallel agents do not collide.
4. Change tiers decide how much process a change gets.
   Small: UI or copy, or a fix or feature in a few files, under about 300 lines, with no auth,
   security, store migration, money math or new subsystem. A Small change gets one review round and
   no local Playwright.
   Big: anything else. A Big change gets one review round; auth, security and data-rewriting store
   migrations get two. Plan review happens only for security or authentication changes,
   data-rewriting store migrations and new subsystems, and is capped at two rounds. Every other
   change goes straight to tests and implementation.
   Every review round has a 30-minute deadline. Cleanup commits get no review round of their own,
   and the final commit is reviewed before merge.
5. Every PR still gets a code review from a provider other than the author's before merge.
6. Commit and push to the remote branch at every checkpoint, starting with the failing tests.
   Uncommitted worktrees have been lost to cleanup.
7. Store migrations are numbered in merge order. When two branches claim the same number, the one
   that merges second renumbers.

## Product boundaries

Advisory only. No tax filing, no money movement, no securities selection. Account access is
read-only. Calculations that produce figures are deterministic code; the model never states a
number it did not get from a calculator or from stored data, and every displayed figure carries
its provenance.

## Source context

Background on the owner's thinking lives in the owner's wiki (`~/wiki` on the owner's machines):
`pages/owner-household-financial-policy-engine.md`,
`pages/owner-household-financial-policy-engine-architecture.md`, `pages/s-corp-transition.md`,
and the `raw/thoughts/2026-08-30-*` notes on the operating model, the year-round operator and the
fractional-professional beachhead. Read them; never edit them from this repository and never copy
private values from them.

Earlier prototype, spike and MVP work is preserved in local `archive/*` tags (not pushed). Reuse
code from there deliberately; do not restore the branches.

## Writing

No emojis. No em dashes. Terse, decision-oriented prose. Separate pinned decisions,
recommendations, assumptions, open questions and deferred scope.
