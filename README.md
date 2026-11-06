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
| `FATHOM_PUBLIC_URL` | unset | URL MCP clients use to reach this server (http or https, no credentials, query or fragment). Its host is allowed on `/mcp` and every `/api` route. |
| `FATHOM_ALLOWED_HOSTS` | unset | Comma separated extra host names (`host` or `host:port`) allowed on `/mcp` and every `/api` route. A deployment reached by a DNS name must set this or `FATHOM_PUBLIC_URL`. |
| `FATHOM_OWNER_LOGINS` | unset | Comma or newline separated Tailscale logins allowed into a real store. Unset on a real store, every page and `/api` route answers 401. |
| `FATHOM_SIMPLEFIN_ALLOWED_HOSTS` | `bridge.simplefin.org,beta-bridge.simplefin.org` | Hosts the SimpleFIN client may call (no scheme, port or path). Anything else refuses to start. |
| `FATHOM_OWNER_LOGINS_FILE` | unset | Path to a file with the same list, instead of `FATHOM_OWNER_LOGINS` (not both). |
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
| `FATHOM_SMOKE_TARGET` | `demo` | `real` for a finished real store: shells, empty states, provenance, GET and HEAD only. |
| `FATHOM_SMOKE_HEADERS` | unset | JSON object of extra headers (the owner login) for real-store smoke. |

Secret files, never committed: the Claude credential, the 32-byte data key, the email credential, and the owner-login list when you use the `_FILE` forms. The server also creates `api-key-secret` (64 hex characters, mode 0600) in the data directory on first start and uses it to hash API keys. A demo store creates `files/demo.key` for the vault.

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
quick switcher (Ctrl or Cmd K) and the More menu.

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

Reach the app through `tailscale serve`, which adds `Tailscale-User-Login` to every request. On a
real store, every page and `/api` route needs a login listed in `FATHOM_OWNER_LOGINS` (or
`FATHOM_OWNER_LOGINS_FILE`); without a usable list everything but `/healthz` answers 401. `/mcp`
uses its own bearer keys, and demo stores are open. Also allow the tailnet name through
`FATHOM_PUBLIC_URL` or `FATHOM_ALLOWED_HOSTS`.

`tailscale serve` strips client-supplied `Tailscale-User-*` headers before adding its own, and
tagged nodes get no login, so only the owner's own devices pass.

The limit: the header is only trustworthy when `tailscale serve` is the sole path to the app.
Anything that reaches the pod or a port-forward directly could forge it, so keep ingress
default-deny and bind any port-forward to loopback. Any local process on the serving host can still
reach the loopback port-forward with a forged header. This is a known limit with no code fix,
recommended for acceptance pending the owner's decision.

Onboarding has no sign-in of its own: identity is this gate, and the first step shows who the
server says you are. The Tell us note is saved as an encrypted notes file and read the way an
uploaded notes file is (with the engine off it is stored and waits). "Here is what we heard" lists
only what the store holds, with where each value came from. On a real store, More has Setup to add
more context later.

## Test

```bash
npm test                     # unit tests (node --test): app, packs, engine and calc
npx playwright install chromium
npm run e2e                  # Playwright against three local demo servers it starts itself (one keeps its data outside the checkout)
FATHOM_LIVE=1 FATHOM_CLAUDE_CREDENTIAL_FILE=<path> npm run smoke:live   # opt-in live engine smoke; makes real model calls and spends against the cap
BASE_URL=http://127.0.0.1:8080 npm run e2e:smoke   # read-only @smoke subset against a running server
```

`scripts/e2e-all.sh` runs the full suite and then the smoke subset against a separately started
server. `scripts/docker-smoke.sh` builds the image and smoke tests a container using your docker
CLI configuration as is.

Deployed smoke is that same `@smoke` subset against a server you already started: set `FATHOM_SMOKE_BASE_URL` (or `BASE_URL`), and for a real store that has finished first-run also set `FATHOM_SMOKE_TARGET=real` plus `FATHOM_SMOKE_HEADERS` as a JSON object when the deployment checks a login header. Real mode checks shells, empty states and provenance, and aborts any request to the app that is not GET or HEAD. The default target is `demo`, which keeps the scenario assertions.

## Docker

```bash
docker build -t fathom .
docker volume create fathom-data
docker run -d --name fathom -p 8080:8080 -v fathom-data:/data fathom
```

The container runs as the non-root `node` user (uid 1000) and reports health from `/healthz`. If
you bind mount a host directory at `/data` instead of a named volume, it must be writable by
uid 1000.

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
