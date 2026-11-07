# Public demo mode

`FATHOM_PUBLIC_DEMO=1` serves synthetic sample data without sign-in. This is separate from `FATHOM_DEMO`, which remains the private demo/development mode. Public demo mode starts no scheduler, email transport, auth enrollment service, MCP server or MCP key service. It never opens an owner household runtime.

## Startup and deployment inputs

Supply `FATHOM_PUBLIC_URL` as the demo host's HTTPS origin, `FATHOM_HOST` and `FATHOM_PORT` for the listener, and a dedicated writable data volume. HTTP is allowed only with an explicit localhost port for tests. The hostname belongs to the deployer.

`FATHOM_PUBLIC_DEMO_DATA` names the dedicated demo directory, default `demo-data`. Leave `FATHOM_DATA` unset or set it to exactly that same directory. Leave `FATHOM_DEMO` unset or set it to `1`. A new directory is seeded with the bundled synthetic household. An existing store must have both demo mode and the versioned `synthetic_demo` marker written by the demo seeder. A real store or an unmarked older demo store is refused before it is migrated or changed. Never point this mode at an owner volume. The marker is removed on private demo API writes, file ingestion or a SimpleFIN connection attempt; such a store must be reseeded before public use.

Startup rejects every nonempty `FATHOM_SIMPLEFIN_*`, `FATHOM_EMAIL_*`, `FATHOM_SMTP_*`, `FATHOM_MCP_*`, `FATHOM_BACKUP_*`, `FATHOM_PLATFORM_*` and `FATHOM_DATA_KEY_*` value. The sole exception is `FATHOM_EMAIL_TRANSPORT=dev`. This includes email addresses and their file forms, SMTP host/user/port/credentials, SimpleFIN access tokens and allowlists, backup and platform key files, data keys and MCP key/secret files. Separate model credentials are allowed: choose `FATHOM_ENGINE=fake` for an offline demo, `off` to pause answers, or `live` with a private `FATHOM_CLAUDE_CREDENTIAL_FILE` containing the deployment's separate API key. Public mode uses whatever explicitly configured model key is supplied. It does not load account credentials or ambient model credentials. Provider key limits should also be set by the deployer.

If a reverse proxy supplies client addresses, set `FATHOM_TRUSTED_PROXIES` to its explicit CIDRs and ensure it replaces untrusted forwarding headers. Without this, all requests from that proxy share one IP bucket. Forwarding headers from untrusted peers are ignored. `FATHOM_ALLOWED_HOSTS` can additionally restrict the HTTP Host header. POSTs must use the configured public origin. Cookies are HttpOnly, SameSite=Lax and Path=/, and Secure on HTTPS origins.

## Visitor state

Each visitor gets an independently seeded financial store, platform store, pack view and model engine in a sandbox directory selected through a random 256-bit cookie. The base seed store is never used for visitor writes or model spending. Cookie IDs must match the control database; they never become caller-supplied paths. Confirm answers, goals, decisions, what-ifs, Ask threads and demo reset touch only that visitor's sandbox. Thread titles use the existing deterministic title formatter without another model call.

Only an allowed household API request creates a sandbox. Health checks, static assets and refused features allocate none. A sandbox expires after its absolute TTL. Cleanup runs on allowed API requests and once per minute, closes handles of expired idle sandboxes and deletes their directories. Active handlers finish before their stores can be removed. At the configured sandbox count, new visitors receive HTTP 503 with a fixed busy message; existing visitors remain usable. Per-IP daily creation limits return HTTP 429. Reset clears only the current sandbox's household state and never resets its quotas. Dropping the cookie gets a new visitor only within the per-IP creation and Ask limits. The control database retains global quotas across cookie changes and process restarts. Old rate and daily usage rows are pruned after rollover.

## Spend and abuse limits

All limits come from environment variables and are enforced on the server. Ask and pack what-if share the visitor turn budget. Every model round, including a corrective retry, consumes one global call reservation. The demo has at most two rounds per engine call. Before a round, the control database transaction reserves conservative UTF-8 input bytes plus an envelope and the entire output allowance as tokens, and reserves their worst priced USD cost. Reservations are not refunded, including on failures. Concurrent requests cannot admit more than the remaining budgets. UTC calendar days use the actual server clock, independent of the sample household's scenario clock. An exhausted turn, token, global call or global USD budget returns: "The demo has hit today's limit. Please try again tomorrow." It makes no provider call for that answer.

| Variable prefix `FATHOM_PUBLIC_DEMO_` | Default | Meaning |
| --- | --- | --- |
| `TURNS_PER_DAY` | 20 | Ask and what-if turns per visitor per UTC day |
| `TOKENS_PER_DAY` | 500000 | Reserved input plus output tokens per visitor per UTC day |
| `TURNS_PER_IP_PER_DAY` | 40 | Turns across cookies from one resolved IP per UTC day |
| `CALLS_PER_DAY` | 200 | Global model rounds per UTC day, including retries |
| `USD_PER_DAY` | 5 | Global conservative model spend reservations in USD per UTC day |
| `MODEL` | `claude-haiku-5-5` | Demo model; must be one of the engine's verified priced models |
| `MAX_TOKENS` | 512 | Maximum generated tokens per round, at most 2048 |
| `MAX_INPUT_TOKENS` | 262144 | Maximum conservative input token reservation per round, at most 1048576 |
| `REQUESTS_PER_MINUTE` | 120 | API requests per resolved IP per minute |
| `CREATIONS_PER_IP_PER_DAY` | 5 | New sandbox cookies per resolved IP per UTC day |
| `SANDBOXES` | 50 | Maximum resident sandboxes, at most 200 |
| `TTL_SECONDS` | 86400 | Absolute sandbox lifetime, at most 604800 seconds |

Invalid or nonpositive values refuse startup. An IP request limit returns HTTP 429 with Retry-After. Model and token limits cannot be raised through the UI. Live demo calls go directly to the model Messages API, with no automatic retry, built-in tools, network tools, shell, filesystem or write tools. Offered tools are local read tools, with only that sandbox's DB in their context. The normal Ask grounding checks still apply. The globally capped engine covers Ask and Jev/what-if; scheduled/admin model work is off.

## Route behavior

`GET /api/auth/session` returns `{demo:true, publicDemo:true, identity:null}`. Every scenario payload includes the trusted boolean `live.publicDemo`; the shell displays "Demo with sample data". Allowed operations below are scoped to the cookie's sandbox. All other API operations fail closed with HTTP 403 and "This feature is disabled in public demo mode." There is no file import exception: every upload, import and retry is off. Export, backup, service settings, auth/enrollment/invites, operator/admin and job routes are off. Advisor reviews and check-ins are local sample state only; downloadable advisor/year-end packets are off. MCP at `/mcp`, including encoded spellings, is off. `/signin`, `/enroll`, `/account` and `/admin/users` are off. Ordinary web assets remain available. HEAD has the same policy as GET.

| Method | Route | Public demo behavior |
| --- | --- | --- |
| GET | `/healthz` | Synthetic health only |
| GET | `/api/auth/session` | No-login demo bootstrap |
| POST | `/api/auth/register/options` | Off, HTTP 403 |
| POST | `/api/auth/register/verify` | Off, HTTP 403 |
| POST | `/api/auth/signin/options` | Off, HTTP 403 |
| POST | `/api/auth/signin/verify` | Off, HTTP 403 |
| POST | `/api/auth/recover` | Off, HTTP 403 |
| POST | `/api/auth/signout` | Off, HTTP 403 |
| GET | `/api/auth/passkeys` | Off, HTTP 403 |
| POST | `/api/auth/passkeys/link` | Off, HTTP 403 |
| POST | `/api/auth/passkeys/:id/revoke` | Off, HTTP 403 |
| GET | `/api/admin/users` | Off, HTTP 403 |
| POST | `/api/admin/users/invite` | Off, HTTP 403 |
| POST | `/api/admin/users/:id/role` | Off, HTTP 403 |
| POST | `/api/admin/users/:id/remove` | Off, HTTP 403 |
| POST | `/api/admin/users/:id/passkeys/:keyId/revoke` | Off, HTTP 403 |
| POST | `/api/auth/invitations/accept` | Off, HTTP 403 |
| POST | `/api/operator/households` | Off, HTTP 403 |
| GET | `/api/household/outbound` | Off, HTTP 403 |
| POST | `/api/household/outbound` | Off, HTTP 403 |
| GET | `/api/scenario` | Visitor sandbox |
| GET | `/api/pace` | Visitor sandbox |
| GET | `/api/identity` | Visitor sandbox |
| POST | `/api/recs/:id/action` | Visitor sandbox |
| POST | `/api/recs/:id/answers` | Off, HTTP 403 |
| POST | `/api/recs/:id/start-over` | Visitor sandbox |
| POST | `/api/wargame/:name/pick` | Visitor sandbox |
| POST | `/api/decisions/:id/decide` | Visitor sandbox |
| POST | `/api/decisions/:id/revisit` | Visitor sandbox |
| POST | `/api/packs/:id/toggle` | Visitor sandbox |
| POST | `/api/packs/:id/whatif` | Visitor sandbox |
| GET | `/api/packs/:id/entries/:entryId` | Visitor sandbox |
| POST | `/api/engine` | Off, HTTP 403 |
| POST | `/api/engine/cap` | Off, HTTP 403 |
| POST | `/api/your-plans/build` | Off, HTTP 403 |
| POST | `/api/ask` | Visitor sandbox |
| GET | `/api/threads` | Visitor sandbox |
| POST | `/api/threads` | Visitor sandbox |
| GET | `/api/threads/:id` | Visitor sandbox |
| POST | `/api/threads/:id/rename` | Visitor sandbox |
| POST | `/api/threads/:id/archive` | Visitor sandbox |
| POST | `/api/threads/:id/trash` | Visitor sandbox |
| POST | `/api/threads/:id/restore` | Visitor sandbox |
| POST | `/api/threads/:id/delete` | Visitor sandbox |
| POST | `/api/threads/:id/proposals/:messageId` | Off, HTTP 403 |
| GET | `/api/accounts/:id` | Visitor sandbox |
| GET | `/api/accounts/:id/transactions` | Visitor sandbox |
| GET | `/api/pnl` | Visitor sandbox |
| GET | `/api/pnl/rows` | Visitor sandbox |
| GET | `/api/spending` | Visitor sandbox |
| GET | `/api/spending/rows` | Visitor sandbox |
| POST | `/api/accounts/:id/name` | Visitor sandbox |
| POST | `/api/accounts/:id/mask` | Visitor sandbox |
| POST | `/api/accounts/:id/owner` | Visitor sandbox |
| POST | `/api/accounts/:id/kind` | Visitor sandbox |
| GET | `/api/accounts/:id/merge-candidates` | Visitor sandbox |
| POST | `/api/accounts/:id/merge` | Visitor sandbox |
| GET | `/api/goals/suggestions` | Visitor sandbox |
| POST | `/api/goals` | Visitor sandbox |
| POST | `/api/goals/:id` | Visitor sandbox |
| POST | `/api/goals/:id/archive` | Visitor sandbox |
| POST | `/api/goals/:id/delete` | Visitor sandbox |
| POST | `/api/goals/:id/suggestion` | Visitor sandbox |
| POST | `/api/curve` | Visitor sandbox |
| POST | `/api/onboarding` | Visitor sandbox |
| POST | `/api/onboarding/notes` | Off, HTTP 403 |
| POST | `/api/demo/reset` | Visitor sandbox |
| GET | `/api/keys` | Off, HTTP 403 |
| POST | `/api/keys` | Off, HTTP 403 |
| POST | `/api/keys/:id/revoke` | Off, HTTP 403 |
| GET | `/api/mcp` | Off, HTTP 403 |
| POST | `/api/files` | Off, HTTP 403 |
| GET | `/api/files` | Off, HTTP 403 |
| POST | `/api/files/:id/retry` | Off, HTTP 403 |
| GET | `/api/confirm` | Visitor sandbox |
| POST | `/api/confirm/list` | Visitor sandbox |
| POST | `/api/confirm/answers` | Visitor sandbox |
| POST | `/api/confirm/reopen-many` | Visitor sandbox |
| GET | `/api/confirm/:id` | Visitor sandbox |
| POST | `/api/confirm/:id/answer` | Visitor sandbox |
| POST | `/api/confirm/:id/reopen` | Visitor sandbox |
| GET | `/api/email` | Off, HTTP 403 |
| POST | `/api/email/test` | Off, HTTP 403 |
| POST | `/api/email/brief` | Off, HTTP 403 |
| GET | `/api/jobs` | Off, HTTP 403 |
| POST | `/api/advisor/reviews` | Visitor sandbox |
| POST | `/api/advisor/reviews/:id/verdict` | Visitor sandbox |
| POST | `/api/advisor/checkin` | Visitor sandbox |
| POST | `/api/advisor/packets` | Off, HTTP 403 |
| GET | `/api/advisor/packets/:id` | Off, HTTP 403 |
| POST | `/api/jobs/:id/run` | Off, HTTP 403 |
| POST | `/api/simplefin/connect` | Off, HTTP 403 |
| POST | `/api/simplefin/disconnect` | Off, HTTP 403 |
| POST | `/api/yearend/marks` | Visitor sandbox |
| GET | `/api/yearend/packet` | Off, HTTP 403 |
| POST | `/api/actions/:id/undo` | Off, HTTP 403 |
| POST | `/api/preferences` | Off, HTTP 403 |
| POST | `/api/preferences/:id` | Off, HTTP 403 |
| POST | `/api/preferences/:id/delete` | Off, HTTP 403 |

## Verification

Unit coverage in `test/public-demo.test.mjs` exercises startup refusals, policy gates, isolation, quota persistence and limits. `e2e/public-demo.spec.mjs` drives no-login landing, the marker, Confirm, fake Ask and two-context isolation at desktop and phone widths. For the focused local run, use `E2E_PORT=5031 E2E_PUBLIC_DEMO_PORT=5031 E2E_DATA=.e2e-data-pubdemo npx playwright test --config playwright.public-demo.config.mjs`. This config disables the ordinary demo servers; the spec starts and closes one public-demo server. The regular CI config includes this spec alongside the other tests, using its separate `E2E_PUBLIC_DEMO_PORT` (default 5031).

Deployment work is deferred to later: hosting, the demo hostname, DNS, TLS, reverse-proxy configuration, manifests, provider key provisioning and external spend limits.
