# Fathom

A year-round financial co-pilot for households of independent professionals: read-only account
mirroring from data dumps, goals in plain language, proactive recommendations with deadlines, war
games on tradeoff curves, curated knowledge packs, a monthly "it's covered" brief, and MCP access
for your own AI. Advisory only: it never files taxes or moves money.

Status: build phase. The product definition is [`docs/vision-v2.md`](docs/vision-v2.md).

## Try the design mock

The mock runs on synthetic demo data and needs nothing installed beyond Python 3:

```bash
cd mock-v2
python3 -m http.server 4600 --bind 127.0.0.1
# open http://127.0.0.1:4600/?d=horizon
```

See [`mock-v2/README.md`](mock-v2/README.md) for the review path. Horizon is the chosen design;
Ledger, Console and Thread remain as alternatives in the design switcher.

## Data

The repository only ever contains synthetic demo data. Real data lives in a deployment's data
volume and is never committed.
