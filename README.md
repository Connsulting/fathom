# Fathom

A year-round financial co-pilot for households of independent professionals: read-only account
mirroring from data dumps, goals in plain language, proactive recommendations with deadlines, war
games on tradeoff curves, curated knowledge packs, a monthly "it's covered" brief, and MCP access
for your own AI. Advisory only: it never files taxes or moves money.

Status: build phase. Docs: product definition [`docs/vision-v2.md`](docs/vision-v2.md) (Status
section for built versus deferred), architecture [`docs/architecture.md`](docs/architecture.md),
known limits [`docs/known-limits.md`](docs/known-limits.md), releases [`docs/releasing.md`](docs/releasing.md).
The clickable mock is `mock-v2/`.

## Run it

Node 24 or later:

```bash
npm ci && npm start
# open http://127.0.0.1:8080/
```

One process serves the Horizon UI and the JSON API, backed by SQLite in `./data/fathom.sqlite`.
On a data directory with no store it creates a demo store seeded with synthetic data (the
November state) and keeps its state across restarts.

| Variable | Default | Meaning |
|---|---|---|
| `FATHOM_DATA` | `./data` | Data directory holding `fathom.sqlite`. |
| `FATHOM_PORT` | `8080` | HTTP port. |
| `FATHOM_HOST` | `127.0.0.1` | Bind address (the container uses `0.0.0.0`). |
| `FATHOM_DEMO` | unset | `1` requires a demo store, `0` requires a real store (a new one starts empty); unset follows the store, and a new store is a demo. A mismatch refuses to start and changes nothing. |
| `FATHOM_ENGINE` | `fake` (`off` with `FATHOM_DEMO=0`) | `live`, `fake` or `off`. |
| `FATHOM_CLOCK` | unset | ISO date that overrides "today", for demos and tests. |
| `FATHOM_FAKE_STREAM_MS` | `25` | Fake engine only: milliseconds between streamed answer chunks (0 to 1000). |
| `FATHOM_CLAUDE_CREDENTIAL_FILE` | unset | Path to the mounted Claude credential. |
| `FATHOM_DATA_KEY_FILE` | unset | Path to the file encryption key. |
| `FATHOM_EMAIL_TRANSPORT` | `dev` | `dev`, `smtp`, `resend`, `postmark` or `agentmail`. |
| `FATHOM_PUBLIC_URL` | unset | Required on a real store, which refuses to start without a valid one. The origin people and MCP clients use: `https://<dns name>` at the root (no path, credentials, query or fragment, and no IP address), or `http://localhost:<port>` for local tests only. Passkeys bind to its host name, every mutation must carry its exact origin, emailed links start with it and MCP clients use it plus `/mcp`. Optional on a demo. |
| `FATHOM_ALLOWED_HOSTS` | unset | Comma separated extra host names (`host` or `host:port`) allowed on `/mcp` and every `/api` route besides the `FATHOM_PUBLIC_URL` host. |
| `FATHOM_TRUSTED_PROXIES` | none (`[]`, no proxies trusted) | Comma separated CIDRs, explicit IPv4 or IPv6 ranges (`10.0.0.0/8`, `fd00::/8`), of the reverse proxies whose `X-Forwarded-For` the rate limits may read. An invalid entry refuses to start. |
| `FATHOM_SIMPLEFIN_ALLOWED_HOSTS` | `bridge.simplefin.org,beta-bridge.simplefin.org` | Hosts the SimpleFIN client may call (no scheme, port or path). Anything else refuses to start. |
| `FATHOM_EMAIL_FROM` | unset (`dev` uses `fathom@example.invalid`) | Sender address, or the AgentMail inbox id. Not with `FATHOM_EMAIL_FROM_FILE`. |
| `FATHOM_EMAIL_FROM_FILE` | unset | File holding the sender address. Not with `FATHOM_EMAIL_FROM`. |
| `FATHOM_EMAIL_TO` | unset (`dev` uses `owner@example.invalid`) | Recipient addresses, comma separated. Not with `FATHOM_EMAIL_TO_FILE`. |
| `FATHOM_EMAIL_TO_FILE` | unset | File of recipients, comma or newline separated. Not with `FATHOM_EMAIL_TO`. |
| `FATHOM_EMAIL_CREDENTIAL_FILE` | unset | API key or SMTP password file. Required except for `dev`. Mode 0400, 0440 with fsGroup, or 0600. |
| `FATHOM_EMAIL_SMTP_USER` | unset | SMTP user name when the transport is `smtp`. |
| `FATHOM_EMAIL_SMTP_HOST` | `smtp.gmail.com` | SMTP host. |
| `FATHOM_EMAIL_SMTP_PORT` | `465` | `465` (TLS) or `587` (STARTTLS). |
| `FATHOM_LIVE_EMAIL` | unset | `1` lets `npm run email:test` send one real message. Read only by that script. |
| `FATHOM_LIVE` | unset | `1` lets `npm run smoke:live` call the live model. Read only by that test. |
| `FATHOM_SMOKE_BASE_URL` | unset | Playwright smoke target. `BASE_URL` is the same switch. |
| `FATHOM_SMOKE_TARGET` | `demo` | `real` for a real store: signed-out `@auth-smoke` checks, or with a storage state the shells, empty states and provenance. GET and HEAD only. |
| `FATHOM_SMOKE_STORAGE_STATE` | unset | Path to a Playwright storage-state file holding a signed-in session for the supplied smoke server. Needs `FATHOM_SMOKE_BASE_URL` or `BASE_URL`. |

Secret files, never committed: the Claude credential, the 32-byte data key and the email credential. The server also creates `api-key-secret` (64 hex characters, mode 0600) in the data directory on first start and uses it to hash API keys. A demo store creates `files/demo.key` for the vault. Sessions, passkeys and link tokens live in the store, hashed where they are secrets.

With `FATHOM_ENGINE=fake` (the demo default), Ask, recommendation chats and What if answer from a
deterministic scripted source through the same grounding and provenance path as the live engine.
`live` needs `FATHOM_CLAUDE_CREDENTIAL_FILE`.

Your plans: `npm run build:your-plans` (or the button on Packs) builds the private Your plans pack
from uploaded plan and benefits documents into `$FATHOM_DATA/packs/your-plans/`. It refuses to
write inside the repository, so set `FATHOM_DATA` to a directory outside the checkout to use it
(the default `./data` is inside the checkout).

Rebuild the demo store (refuses a real store):

```bash
npm run seed:demo
```

## Deciding and trends

On a real store the Decide screen's war games end in a choice: pick a point, press "Decide on this",
and the decision is saved with its figures. A decided salary becomes the payroll assumption on the
next planning run until you press "Revisit". Accounts shows monthly trend lines built from the
balances you uploaded. The Engine screen lists the model each purpose runs on, and Files is in the
quick switcher (Ctrl or Cmd K) and the Money tab's sub-nav.

## Bank and brokerage connections

Accounts connect read-only through SimpleFIN Bridge. Create a setup token on the SimpleFIN Bridge
site and paste it under Connect accounts on the Accounts screen (or in onboarding). Fathom claims it
once, keeps the access URL encrypted with the data key (a real store needs `FATHOM_DATA_KEY_FILE`),
and syncs daily with the `simplefin-sync` job or on Sync now. The deployment needs outbound HTTPS
to the hosts in `FATHOM_SIMPLEFIN_ALLOWED_HOSTS`. The demo uses a synthetic bridge and needs no
network.

## Email

Fathom sends a monthly brief and short deadline alerts. The default `dev` transport writes each
message to `outbox/` in the data directory and sends nothing. For real delivery set
`FATHOM_EMAIL_TRANSPORT` (AgentMail is the production target), the sender and recipients
(`FATHOM_EMAIL_FROM`, `FATHOM_EMAIL_TO` or their `_FILE` forms) and mount the API key as a file other
users cannot read (mode 0400, 0440 with fsGroup, or 0600) named by `FATHOM_EMAIL_CREDENTIAL_FILE`. The Email screen shows the
status, a preview, the send history and the scheduled jobs. `FATHOM_LIVE_EMAIL=1 npm run
email:test` sends one real test email; every key is listed in `docs/architecture.md`.

## Access

A real store has household accounts. Everything but `/healthz`, the sign-in pages and `/mcp`
needs a signed-in session; demo stores stay open with no accounts.

1. One household, shared. Every account sees and changes the same household data; this is access
   control for one household, not multi-tenancy. Roles are admin and member. Members use the whole
   app; admins also invite people, change roles, remove people and revoke anyone's passkeys on the
   Household page (`/admin/users`). The last enrolled admin cannot be demoted or removed. Inviting
   someone whose invitation is still pending sends a fresh link with the role just chosen; inviting
   someone who has already enrolled is refused, and their role changes with the role control.
2. Passkeys only, no passwords. The email address is the username. Each person can hold several
   passkeys (Account, `/account`). Revoking any passkey signs that person out everywhere, including
   the current browser, but leaves the MCP keys they created live; revoking the last one is
   allowed, and getting back in then takes an email recovery link.
3. Sessions are a `__Host-fathom-session` cookie (HttpOnly, Secure, SameSite Lax) lasting seven
   days. The store keeps only a hash. Sign out ends the current session; removing a person ends all
   of theirs and deletes the MCP keys they created.
4. Adding a passkey on Account needs a sign-in from the last 10 minutes. Once the sign-in is
   older, Account shows a Sign in again link; sign in with an existing passkey, then come back to
   Account to add the new one. Enrollment and recovery links do not need a prior sign-in.
   To add a passkey on another device, use Account, Email me a link to add a passkey on another
   device, then open the emailed link on that device within 20 minutes. The link works once, goes
   only to your own address, and nothing is revoked: your other passkeys and sessions stay.
5. Enrollment, recovery and add-a-device links arrive by email, work once and expire after 20 minutes. The token
   is in the link's fragment, so it never reaches a server log. Recovery answers the same way for
   every address. Mail goes through the configured email transport, so a real deployment needs
   `FATHOM_EMAIL_TRANSPORT`, the sender and the credential set (`dev` writes links to `outbox/`).
6. Security notices. When a passkey is added through an invitation link, an add-a-device link or on Account, that person
   gets "Fathom passkey added". When a recovery link sets up a new passkey, the person and every
   enrolled admin get "Fathom account recovered". Each notice is sent separately, one recipient per
   message, carries no link or secret, and goes straight through the email transport, so it is not
   in the Email screen's history. A failed notice is logged and the passkey still works.
7. MCP keys stay separate bearer credentials for `/mcp`. Members manage their own keys; admins see
   and revoke every key, including keys created before accounts existed.

First admin, once per store, inside the container or with the same environment as the server:

```bash
npm run user:invite -- <email> --admin
```

The bootstrap command emails the enrollment link first and, only after the send succeeded, prints
the link to stdout for the operator. It refuses a demo store and stops working once anyone has enrolled; after that, admins
invite from the Household page. If the only admin loses every passkey and the mailbox too, recovery
needs offline work on the database outside these tools, so add a second admin or passkey early.

Deployment. Invitation, recovery and add-a-device links all need the configured email transport. Run the container behind a reverse proxy that terminates HTTPS for the DNS name in
`FATHOM_PUBLIC_URL`, serves the app at the root path and passes `Cookie` and `Origin` through
unchanged. The app trusts no forwarded headers except `X-Forwarded-For` from proxies listed in
`FATHOM_TRUSTED_PROXIES`, which only the rate limits read; by default no proxy is trusted and the
socket address counts as the client, so everyone behind the proxy shares one rate-limit bucket. Set
it to the ingress addresses verified on the live deployment, through the environment. Every mutation on a real store must carry
`Origin` equal to that origin, so scripts need a session cookie and that header;
`scripts/dump.mjs` has neither and does not work against a real store yet. Passkeys are bound to
the host name, so changing it means everyone re-enrolls through recovery links. A browser or
passkey provider must report the `credProps` extension with `rk` true when it creates a passkey,
or enrollment is refused; the tests prove this in Chromium, so check any other browser or provider
before relying on it. Passkey autofill in the Email field also depends on the browser and
provider; the Sign in with a passkey button always works.

Upgrading an existing deployment: set `FATHOM_PUBLIC_URL`, remove the former owner-login
configuration and Secret, and invite the first admin. Retire the old exposure only after the owner
has signed in with a passkey on their own devices.

Onboarding on a real store starts at Tell us, because signing in happened first. The Tell us note
is saved as an encrypted notes file and read the way an uploaded notes file is (with the engine off
it is stored and waits). "Here is what we heard" lists only what the store holds, with where each
value came from. On a real store, the Settings page (the gear) shows who is signed in, Account,
Household for admins, and Setup to add more context later.

## Test

```bash
npm test                     # unit tests (node --test): app, packs, engine and calc
npx playwright install chromium
npm run e2e                  # Playwright against three local demo servers it starts itself (one keeps its data outside the checkout)
FATHOM_LIVE=1 FATHOM_CLAUDE_CREDENTIAL_FILE=<path> npm run smoke:live   # opt-in live engine smoke; makes real model calls and spends against the cap
BASE_URL=http://127.0.0.1:8080 npm run e2e:smoke   # read-only @smoke subset against a running server
```

Run focused tests locally; CI runs the full unit and Playwright suites and is the gate.
`scripts/e2e-all.sh` runs the full suite and then the smoke subset against a separately started
server. `scripts/docker-smoke.sh` builds the image and smoke tests a container using your docker
CLI configuration as is. It needs the published port reachable on 127.0.0.1 from the caller.
When that is not true, build the app image yourself and run:

```bash
scripts/remote-smoke.sh <app-image>
```

That command starts the image with a named volume, waits for `/healthz` inside the container,
checks the process is uid 1000, archives the tracked tree, then builds that archive's
`e2e/smoke.Dockerfile` (Playwright tag from that archive's `package-lock.json`), and runs the `@smoke` subset in the app
container's network namespace against `http://127.0.0.1:8080`. It removes everything it created.

Deployed smoke is that same `@smoke` subset against a server you already started: set `FATHOM_SMOKE_BASE_URL` (or `BASE_URL`). The default target is `demo`, which keeps the scenario assertions. For a real store set `FATHOM_SMOKE_TARGET=real`, which aborts any request to the app that is not GET or HEAD:

1. Signed out, run `npm run e2e -- --grep @auth-smoke`: health is public, the sign-in page renders without loading the household, and pages and APIs answer 401 with or without a forged identity header.
2. Signed in, also set `FATHOM_SMOKE_STORAGE_STATE` to a Playwright storage-state file for that server, saved after signing in with a passkey; the `@smoke` subset then checks shells, empty states and provenance. Nothing injects headers or sessions into a supplied server.

`e2e/identity.spec.mjs` covers accounts end to end on its own `http://localhost` server with synthetic data in the OS temp directory: the bootstrap CLI, emailed links, enrollment, discoverable sign-in, a second passkey, revocation, member denial, removal, sign-out and recovery, all through Chromium's virtual WebAuthn authenticator. It proves the button path and that conditional mediation is set up in Chromium, not that a particular password manager offers passkeys in the Email field.

## Docker

```bash
docker build -t fathom .
docker volume create fathom-data
docker run -d --name fathom -p 8080:8080 -v fathom-data:/data fathom
```

The container runs as the non-root `node` user (uid 1000) and reports health from `/healthz`. If
you bind mount a host directory at `/data` instead of a named volume, it must be writable by
uid 1000. A real store also needs `-e FATHOM_DEMO=0 -e FATHOM_PUBLIC_URL=https://<dns name>`, the
email settings, and the first admin invited with `docker exec fathom npm run user:invite -- <email> --admin`.

## Data

The repository only ever contains synthetic demo data. Real household data lives only in a
deployment's data volume (`FATHOM_DATA`) and is never committed.

## Year end

The Year end screen (`#/yearend`) lists the tax documents the household should expect for the tax
year, derived from stored facts, accounts and ledger activity, and shows each as received (with
the stored file) or missing (with where it comes from and when it usually arrives). Any item can
be marked not needed this year with a reason. "Assemble packet" downloads a zip for the tax
preparer: every received document decrypted from the vault plus a printable `index.html` with
expected against received, the year's tax payments, key figures and open items, each with its
source. The zip is built in a temporary directory that is removed after the download, and every
generation is recorded. See docs/architecture.md, Year end.

## Advisor reviews

The Advisor screen is a review workflow the owner runs; advisors have no accounts. Send a
recommendation to the advisor from its page or the Plan, set the next check-in, and record the
advisor's verdict (confirmed or vetoed, with a note and date). A veto dismisses the recommendation,
and later planning runs keep it dismissed unless its inputs change. Prepare packet builds a
printable HTML review packet of everything waiting, with every figure's source; it is stored
encrypted in the data volume and can be downloaded again. Print it to PDF from the browser.

## Design mock

`mock-v2/` is the clickable design reference on synthetic data and needs only Python 3:

```bash
cd mock-v2
python3 -m http.server 4600 --bind 127.0.0.1
# open http://127.0.0.1:4600/?d=horizon
```
