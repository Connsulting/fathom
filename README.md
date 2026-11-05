# Fathom

A year-round financial co-pilot for households of independent professionals: read-only account
mirroring from data dumps, goals in plain language, proactive recommendations with deadlines, war
games on tradeoff curves, curated knowledge packs, a monthly "it's covered" brief, and MCP access
for your own AI. Advisory only: it never files taxes or moves money.

Status: build phase. The product definition is [`docs/vision-v2.md`](docs/vision-v2.md); the
architecture is [`docs/architecture.md`](docs/architecture.md).

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
| `FATHOM_CLAUDE_CREDENTIAL_FILE` | unset | Path to the mounted Claude credential. |
| `FATHOM_DATA_KEY_FILE` | unset | Path to the file encryption key. |
| `FATHOM_EMAIL_TRANSPORT` | `dev` | `dev`, `gmail`, `resend` or `postmark`. |
| `FATHOM_PUBLIC_URL` | unset | URL MCP clients use to reach this server (http or https, no credentials, query or fragment). Its host is allowed on `/mcp` and every `/api` route. |
| `FATHOM_ALLOWED_HOSTS` | unset | Comma separated extra host names (`host` or `host:port`) allowed on `/mcp` and every `/api` route. A deployment reached by a DNS name must set this or `FATHOM_PUBLIC_URL`. |

Rebuild the demo store (refuses a real store):

```bash
npm run seed:demo
```

## Test

```bash
npm test                     # unit tests (node --test): app, packs, engine and calc
npx playwright install chromium
npm run e2e                  # Playwright against two local demo servers it starts itself
BASE_URL=http://127.0.0.1:8080 npm run e2e:smoke   # read-only @smoke subset against a running server
```

`scripts/e2e-all.sh` runs the full suite and then the smoke subset against a separately started
server. `scripts/docker-smoke.sh` builds the image and smoke tests a container using your docker
CLI configuration as is.

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

## Design mock

`mock-v2/` is the clickable design reference on synthetic data and needs only Python 3:

```bash
cd mock-v2
python3 -m http.server 4600 --bind 127.0.0.1
# open http://127.0.0.1:4600/?d=horizon
```
