# Fathom mock v2

A clickable, canned mock of the product defined in [`docs/vision.md`](../docs/vision.md).
Four dark, minimalist designs over one shared core and one scenario. No backend, no auth, no model
calls. The bar at the top is a review harness, not product UI.

## Run locally

```bash
cd mock-v2
python3 -m http.server 4600 --bind 127.0.0.1
# open http://127.0.0.1:4600/
```

The page loads `private/scenario.js` if it exists (gitignored, real data) and otherwise the
synthetic `scenario/example.js`. The harness shows which one is active.

Links are shareable: `?d=<ledger|console|horizon|thread>&demo=<fresh|first|november|checkin|clear>#/<route>`.
Routes: onboarding, brief, plan, rec/<id>, ask, wargame/<salary|deferral>, goals, accounts,
advisor, yearend, connect, engine, email, packs/<id>.

## Review path (ten minutes)

1. Demo state "1 New member": walk the six onboarding steps.
2. "3 November": read the brief, open each needs-you item, tick its checklist, complete it, and
   watch the verdict flip to covered.
3. Open the invoice-timing war game from its recommendation and pick an option; then the salary
   curve.
4. Packs: open "Charitable giving", run What if, turn the pack on, and find the new recommendation.
5. "4 Check-in": the advisor view. Then Connect and Engine. Toggle the engine off and ask a question.
6. Switch designs with the dropdown at any point; the state carries over.

## Files

| Path | What |
|---|---|
| `CONTRACT.md` | The build contract: schema, core API, routes, design briefs |
| `core/` | Runtime: store, router, tokens, harness bar |
| `designs/<id>/` | One design each: ledger, console, horizon, thread |
| `scenario/example.js` | Synthetic scenario, tracked |
| `private/scenario.js` | Real scenario, gitignored, never committed |
| `tools/synthesize.mjs` | Builds the synthetic scenario from a private one; fails on any leaked name or literal amount |
| `tools/deploy.sh` | Copies the site to a stable directory and serves it tailnet-only with `tailscale serve` |

## Container later

The layout is already the container's: a static site plus a data directory. A future image serves
the app and mounts the real scenario (later, the real store) as a volume at `private/`.
