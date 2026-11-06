# Fathom vision v2

Status: the app is in the build phase. This document is still the product definition. It pairs
with the clickable mock in `mock-v2/`. Supersedes the parts of
`docs/product-and-architecture-design.md` (on the `fathom-prototype` branch) that it contradicts.
What is built today is the short Status section below; the rest of this file is the vision and is
not a changelog.

Sources, in priority order:

1. The advisor call of Nov 4, 2026 (Granola meeting `44af90eb-e38e-4533-9f98-2f6ffc249487`),
   between the owner and a wealth advisor at an AI-first advisory firm. Citations below are
   `[call mm:ss]` timestamps into that transcript.
2. The original vision: this repo's design docs and the wiki pages listed in `AGENTS.md`.
3. Directions the owner gave while this mock was being built on Nov 5, 2026, cited `[build]`.
4. The household's real exports, used only at runtime on the private tailnet page. Nothing derived
   from them is in this document or any tracked file.

"The owner" means the person the product is for. No real names appear in tracked files.

## Status

Built, as of the docs refresh on `main`: the SQLite store and Horizon UI in one process; dump-everything ingest with an encrypted file vault and a Confirm deck (revisable answers, engine guesses from fixed basis codes); the planner (figures, provenance, war games); in-process jobs (nightly plan, monthly brief, deadline alerts, freshness, Ask trash purge, confirm guesses); the budgeted engine (`chat`, `job`, `extract`, `confirm`, `title`); Ask conversations with streamed, grounded answers; MCP with app-issued keys; knowledge packs and Your plans; email transports; the owner gate on the Tailscale login header; real onboarding (Tell us, sign-in display, Confirm); owner-editable goals and the tradeoff curve; the advisor review workflow; the year-end checklist and accountant packet; the keyboard layer and Ctrl+K switcher; the phone layout and home-screen install; and a real-store smoke mode.

Still deferred, or not on `main` when this section was written: live account aggregation (an open pull request adds read-only SimpleFIN connections; holdings stay unmapped there); an Accounts trend series, engine model display, plain event labels, war-game decide and revisit, and Files in the switcher (an open polish pull request); tax filing and money movement (out of scope); multi-household tenancy; a real advisor login (the owner records the verdict); a service worker for the installed phone app.

## 1. The product in one paragraph

A year-round financial co-pilot for a household of independent professionals. It mirrors every
account read-only, knows the household's goals and life events, and once a month answers one
question: am I missing something? Either "it's covered", or the few things that need you before a
window closes. Each recommendation is a light to-do with a why-now, a deadline, a value, a
checklist and a conversation. You war-game decisions yourself to get onto the tradeoff curve and
then choose where on it to sit. Your own AI can connect to it over MCP. A human advisor meets you
quarterly, has read the same state and conversations, and confirms or vetoes what the AI
proposed. At year end it hands the accountant a clean packet. It does not file returns or move
money.

## 2. What the call changed

### Pinned decisions

Each of these is now a requirement. Where it conflicts with older material, it wins.

1. **Four capabilities define the product.** Premium knowledge base access, secure read-only
   account aggregation, context-aware proactive recommendations, and direct platform access for
   war-gaming, with quarterly human check-ins on top `[call 33:18 to 37:20]`. The original vision
   centred on a monthly close and a triage surface; those are now implementation details under
   these four.
2. **The promise is "tell me it's covered, then let me forget about it", on a monthly cadence**
   `[call 9:37 to 9:48]`. This sharpens the original "I have you covered" into a concrete delivery
   rhythm: a monthly brief and email, and silence otherwise.
3. **The calendar year is the enemy.** Windows close at midnight on Dec 31, and the anxiety is
   being three months behind with no time left to fix cash flow `[call 19:13 to 19:49]`. Every
   recommendation carries its window, and the year clock is a primary visual in every design.
4. **Advisory, not filing.** Disclaimers are acceptable; the owner will take on the liability and
   use a cheap preparer, as long as the calendar year was handled `[call 23:44 to 24:44]`. The
   output that matters at year end is a checklist done during the year and a packet "shipped off to
   the accountant" `[call 25:01 to 25:56]`.
5. **Optimise to the Pareto curve; the owner picks the point.** "Just get me on the curve" across
   business, goals and personal finance, while the owner decides between retirement, lifestyle and
   horizons `[call 18:27 to 19:03, 25:01]`. The S corp salary question is the canonical example: it
   moves deferral room, payroll tax and QBI at once `[call 12:58 to 13:43]`. War games show the
   curve, mark points that are off it, and never pick the point for you.
6. **Recommendations are triggered by calendar events, income changes and life events, and are
   conversable.** Why it is a thing now, the advantages, the time aspect, combined from the
   knowledge base and the household's own context `[call 34:58 to 36:15]`. Example triggers from
   the call: a mid-year S corp conversion and payroll true-up cash `[call 6:17]`, invoice deferral
   ahead of an unpaid maternity leave `[call 19:51 to 20:28]`, SEP versus Solo 401(k)
   `[call 5:41, 16:08]`, HSA and state-tax timing `[call 5:30]`.
7. **Task tracking to a degree.** "Keep me honest", not project management `[call 11:56]`.
   Each recommendation has a short checklist and nothing more.
8. **A thin human layer, not no human.** The owner wants direct platform access and fewer human
   touchpoints, but quarterly check-ins where the advisor has seen the conversations, confirms or
   kills what the AI said, and raises "things you're not asking" `[call 30:28 to 31:48]`.
   Specialists can be swapped in per topic `[call 36:30 to 37:14]`. The advisor's own caution, that
   tools give the textbook answer and miss traps like the backdoor Roth pro-rata rule
   `[call 27:51 to 28:37]`, is why advisor verdicts are first-class on every recommendation.
   This replaces the original stance of CPA review as an optional escalation tier.
9. **Bring your own intelligence.** MCP access to the knowledge base, to read-only account data
   ("can't delete anything"), and to the recommendations `[call 33:18 to 35:31]`.
10. **Read-only aggregation replaces manual exports as the default.** "Right now I'm doing exports"
    `[call 34:22]`. Exports stay as a fallback for accounts that cannot connect.
11. **Price anchor: 2,000 to 5,000 dollars a year**, against a 15,000 dollar full-service advisor
    and a transactional preparer who charges per question `[call 8:24, 11:56]`.
12. **Market: freelance, fractional and AI-native professionals** who manage business and personal
    money together and do not want frequent calls `[call 17:22 to 17:53, 39:58 to 41:07]`.

### Directions from the owner during this build

1. **No real names in tracked files** `[build]`. The mock is data-driven; real names and figures
   live only in a gitignored scenario loaded at runtime.
2. **Long-term deployment is a standalone container in the homelab** `[build]`, not a
   Kubernetes-first production stack. See section 5.
3. **Claude drives chat and the proactive jobs** `[build]`: chat over the data through the Claude
   Agent SDK, and scheduled jobs that do the proactive work, funded from the owner's monthly Claude
   credits, with an on/off switch for testing.
4. **Knowledge packs** `[build]`. The knowledge base is split into curated packs (S corp owner,
   self-employed and partnership income, W-2 benefits, Virginia resident, kids and dependents,
   advanced retirement, charitable giving, and more). A pack turns on when the household's facts
   make it apply and becomes retrieval context. Packs are visible in the UI. Each has a **What if**
   action: a conversation about doing the thing the pack covers, which is how the product can
   recommend something the current facts would never trigger (an S election for someone on 1099
   income today).
5. **Several dark, minimalist designs, switchable from a bar at the top** `[build]`.

### Dropped or demoted from the original vision

1. **The monthly close as the user's central surface.** With read-only aggregation, closing a month
   is a background job. Freshness stays first-class, but as a property of the mirror (connected,
   manual, missing), not a ritual the owner performs.
2. **The two-by-two triage board and time budget.** The call asks for "tell me the few things" and
   "let me forget", which a short needs-you list plus a year clock serves better.
3. **The concierge tracer as the first product step.** The call wants direct platform access, and
   the build is personal-first. A human advisor appears as a quarterly reviewer instead.
4. **Kubernetes as the production target.** Replaced by one container (section 5).
5. **Fathom's trademark clearance** remains open and is not addressed here. Fathom stays the
   working name.

### Kept from the original vision

Deterministic calculation with the model never stating a number it did not get from a calculator
or the mirror (the mock enforces this with tokens: prose references figures, the renderer
resolves them, and every figure carries its provenance as actual, projected, estimate or model).
Value reported in classes that are never summed (tax saved, timing, retirement room, risk, cash,
goal). Coverage derived from open recommendations, never authored. The household plus its
businesses as one financial unit with the person as the customer.

## 3. Core loop

1. **Mirror.** Accounts sync read-only daily. Missing or manual accounts are visible as gaps.
2. **Detect.** Jobs watch for calendar windows, income changes and life events (some told in
   chat), and switch knowledge packs on or off as facts change.
3. **Recommend.** A trigger produces or updates a recommendation with window, value, grounded
   figures, pack citations, cross-effects and a checklist.
4. **Brief.** On the 1st, the monthly brief and email: a verdict, what needs you, what changed,
   what is covered. If nothing needs you, it says so and what it checked.
5. **Converse and war-game.** The owner asks, explores what-ifs, and picks points on curves. Picks
   update the plan.
6. **Review.** Before each quarterly check-in, an advisor packet summarises conversations and
   pending recommendations. The advisor confirms, vetoes, adds questions not asked.
7. **Hand off.** At year end, the packet for the accountant.

## 4. Recommendation model

Statuses: proposed, accepted, doing, waiting (on data, the advisor, or a date), snoozed (with a
wake condition), done, dismissed, and hidden (behind an inactive knowledge pack). "Needs you" is
any proposed item, plus accepted or in-progress items whose window is inside 30 days. Waiting and
snoozed items are carried and do not count. The verdict is computed from that set, so the brief can
only say "covered" when nothing needs the owner.

Each recommendation has a trigger type (calendar, income, life, goal, advisor), a window, an effort
estimate, value classes, a why-now, the owner's own figures, knowledge-pack excerpts with citations,
cross-effects on other decisions, a checklist, an advisor verdict, and a conversation thread.

## 5. Architecture direction

The target is a single self-hosted container that runs in the homelab, reachable only on the
tailnet.

| Component | Role |
|---|---|
| Web app and API | One process. Serves the UI and the JSON API. |
| Store | SQLite on a mounted volume. Household facts, mirrored accounts and transactions, recommendations, conversations, pack activation, job runs. |
| Scheduler | In-process cron for the jobs in section 6. Survives restarts by reading job state from the store. |
| Claude worker | Claude Agent SDK. Chat and job reasoning call the same read-only tools the MCP server exposes, plus the active knowledge packs as retrieval context. |
| Calculators | Deterministic modules (tax, payroll, retirement room, cash). The model calls them; it never does arithmetic in prose. |
| Knowledge packs | Versioned bundles of curated entries (markdown plus metadata plus an embedding index) with activation rules over household facts. Loaded from the image or a mounted directory. |
| Aggregation connector | Read-only tokens to a Plaid-style aggregator. Manual export import as a fallback. |
| MCP server | Same tools, scoped tokens, read-only by default; a write scope only for recommendation status. |
| Engine switch | Global on/off and a monthly spend cap enforced in code before every model call. Off means jobs pause and chat answers stay canned. |

Deployment: one image, one volume for data, one mounted secret for the Claude credential and the
aggregator token, served on the tailnet with `tailscale serve`. No public ingress. Backups are
volume snapshots.

The mock already has the shape this needs: a static UI that renders whatever scenario it is given,
with the real scenario loaded at runtime from a gitignored directory that becomes the container's
data volume.

## 6. Proactive jobs

| Job | Cadence | What it does |
|---|---|---|
| Account mirror sync | Daily | Pull balances and transactions. No model call unless something looks unusual. |
| Deadline sweep | Weekly | Check every window in the next 60 days against the plan and checklists. |
| Life event and income triggers | On new data | Re-plan affected recommendations; switch packs on or off. |
| Monthly brief and email | 1st of the month | Verdict, needs-you, what changed, covered. Nothing goes out if nothing changed. |
| Advisor packet | Before each check-in | Summarise conversations and pending recommendations for the human. |

## 7. Privacy and security

1. Data lives on the homelab volume. The tailnet is the only network path.
2. Model calls send the minimum context a question needs; no account numbers or tax identifiers
   are ever sent, and the mirror stores masked account identifiers only.
3. Aggregator and MCP tokens are read-only. The product cannot move money or delete anything.
4. The advisor sees conversations only while the owner's sharing switch is on.
5. Tracked code and fixtures stay synthetic. Real scenario data is mounted, never committed.

## 8. How the mock maps to this

`mock-v2/` is a static, data-driven mock with four interchangeable designs over one shared core
and one scenario. The bar at the top is a review harness, not product UI.

| Requirement | Mock screens |
|---|---|
| Covered, monthly, then forget (pinned 2, 3) | Brief with verdict, needs-you, year clock; Email |
| Proactive, conversable recommendations (6, 7) | Plan; recommendation detail with thread, checklist, cross-effects |
| Pareto curve, owner picks (5) | War game: salary curve, invoice timing against December payroll cash |
| Premium knowledge base, packs, what-if (1, build 4) | Packs; pack citations in every recommendation |
| Read-only aggregation (10) | Accounts, with connected, manual and missing states |
| Direct access and bring your own AI (9) | Ask; Connect (MCP scopes, tools, sample session) |
| Thin human layer (8) | Advisor: agenda, verdicts, pending, questions not asked, specialists |
| Advisory, not filing (4) | Year-end packet |
| Claude engine with on/off (build 3) | Engine screen, harness switch |

Demo states in the harness: new member (onboarding), first brief, November in flight, quarterly
check-in, all clear. Completing the three needs-you items in the November state flips the verdict
to covered.

Designs (all dark, minimalist): **Ledger** (editorial monthly letter), **Console** (keyboard-first
split panes with a command palette), **Horizon** (the calendar year as the spine), **Thread**
(conversation-first, recommendations as cards in the thread).

## 9. Assumptions in the mock

1. The mock clock is Nov 5, 2026. Real exports run through late August; September to November
   figures are projected from the plan of record and marked projected.
2. The W-2 employer's open enrollment deadline is assumed, not known.
3. The amount of delivered, uninvoiced fixed-fee work is an assumption for illustration.
4. The usual monthly distribution and December business cash are projections.
5. The salary curve and invoice-timing figures come from a simplified model calibrated to the plan
   of record; they show shape and direction, not filing-grade numbers.
6. The spouse's S corp savings are rough estimates.
7. The advisor and the tax specialist are fictional personas. The MCP URL is a placeholder.
8. Knowledge pack contents are short illustrative excerpts with public citations, not a real
   curated corpus.

## 10. Open questions for the owner

1. **Who supplies the knowledge packs and the human layer?** The call suggests partnering with an
   advisory firm whose client-direct platform access is not on a near roadmap `[call 31:48 to
   32:32]`. Build the packs yourself, license them, or keep the human layer optional?
2. **Do Claude Max plan credits cover Agent SDK calls from a homelab container?** The plan assumes
   about 200 dollars a month of usage. This needs checking against current plan terms before the
   engine design depends on it; the fallback is an API key with the same monthly cap.
3. **Which aggregator?** Read-only aggregation is pinned; the vendor and its cost are not.
4. **Is the spouse a co-equal user?** The mock speaks to one person. The household has two operators.
5. **Pack activation rules: automatic or confirmed?** The mock turns packs on automatically and lets
   you turn suggested ones on after a what-if.
6. **How much should the advisor see by default?** The mock shares conversations with a switch.
7. **Which design direction to carry forward**, or which elements to combine.
8. **Price and packaging**: one tier with quarterly human check-ins, or software-only plus an
   optional human tier.

## 11. Deferred

This list is the original mock-era deferral. The Status section above is what shipped. Still
deferred from the product: multi-household tenancy; tax filing integrations; money movement (out
of scope permanently). Real model calls, the calculators, and owner identity (Tailscale, not a
password) are built. Live aggregation is the open SimpleFIN work, read-only only.

## 12. Run and review

Local:

```bash
cd mock-v2
python3 -m http.server 4600 --bind 127.0.0.1
# open http://127.0.0.1:4600/
```

Without `mock-v2/private/scenario.js` the mock runs on the synthetic scenario in
`mock-v2/scenario/example.js`. Regenerate the synthetic scenario from a private one with
`node mock-v2/tools/synthesize.mjs`.

Screens are linkable: `?d=<ledger|console|horizon|thread>&demo=<fresh|first|november|checkin|clear>#/<route>`.
