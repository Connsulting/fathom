# Known limits

One line each, taken from merged pull request bodies and deduplicated. The number is the pull request.

## Parsers and packs

1. Workbook income and expense tabs can stay distinct after suffix normalization until an alias maps them (#1).
2. Consumers must keep occurrence and locator source before dedupe, and a workbook reimport must supersede coverage so removed slots do not survive (#1).
3. Tax year versus payment year is still an assumption taken from sheet labels (#1).
4. On a real store, `list_packs` `why` can show HTML-escaped characters from a pack def (#5).
5. Pack tools read pack files on every call; there is no cache (#5).
6. Packs that are no longer loaded stay in `packs_state` (#8).

## Ingest

1. Two tax documents for the same recipient, payer, date and amounts collapse once the recipient is answered (#6).
2. A corrected form stores both income amounts; only withholding is reconciled by the question (#6).
3. A workbook with no P&L rows supersedes nothing and warns `empty_workbook` (#6).
4. A quote-heavy CSV of maximum-length cells, or several near-cap CSVs in one upload, can still exhaust a small heap (#6).
5. A PDF stream of zeros is bounded by the worker timeout and the text cap, not by a byte budget in the JS heap (#6).
6. A withholding conflict card does not show the competing amounts or file names (#6).
7. An explicit zero for state withholding emits no row, so a correction to zero is not asked; federal zeros are (#6).
8. Three or more forms in one slot compare a new form only with the earliest, and some deferred answer orders can leave two amounts counted (#6).
9. xlsx has its own cell budget (250,000 cells plus shared strings and rich text); CSV keeps 2,000,000 (#6).
10. Amounts are tokenized for the model only when they contain a run of 5 or more digits (#6).
11. A PDF text layer with characters but no letters is withheld as unreadable (#6).
12. Ingest does not extract W-2 box 6, so Additional Medicare Tax withholding counts as zero, with a note (#8).
13. Ingest does not classify 1098, 5498, 1099-K or a payroll report, so they land as `other` and show under received-but-not-on-the-list at year end (#23).

## Engine and planner

1. Unknown live accounting reserves an estimated spend and needs a new engine instance (#3).
2. Plan compensation assumes W-2 compensation and that the plan allows the full 25 percent employer rate; both are notes (#8).
3. AGI stands in for MAGI, Virginia personal exemptions are omitted, 2026 parameters stand in for next year, and married filing separately is unsupported; each is a note or a block (#8).
4. Prior-year safe harbor uses total tax as filed, which may include taxes outside the estimated-tax base; this is noted (#8).
5. Two unnamed K-1s for two partnerships stay blocked because ingest does not extract the partnership name (#8).
6. The QBI unknown-wage guard runs before loss netting and can withhold figures it does not need (#8).
7. A prior-year QBI loss carryforward applies only when the owner enters it (#8).
8. A guess that fails validation is stored as no guess and is not retried (#14).

## Confirm and onboarding

1. An answer becomes final after any file import, even one unrelated to it, because imports re-apply remembered answers (#14).
2. A planning run that re-applies an answered question also makes that answer final (#14).
3. An edit link for a fact with no open question goes back to Tell us; there is no inline fact editor (#25).
4. A confirmed fact that disagrees with a new note keeps its value; the note's value is not shown as understood (#25).
5. With the engine off, a Tell us note is stored and not read until the file is retried from Confirm (#25).
6. The First brief build animation is cosmetic; its areas line still counts scenario content domains (#25).
7. Saving notes during first run on a real store can flip the store to november, so Back to the app appears mid-onboarding (#25).
8. One open entity or account question sends every item of that kind to Confirm (#25).
9. Every unconfirmed fact is labeled to confirm in the understood panel, even when no card was raised (#25).
10. Text typed while a notes save is in flight is cleared when the save succeeds (#25).

## Jobs and email

1. On SIGTERM or SIGINT the server forces exit after 3 seconds, which can cut a send before its history row is written (#12).
2. A credential path that names a FIFO would block the open; the path comes only from the deployment (#12).
3. A failed brief or alert is not retried inside its period; Send brief now resends by hand (#12).
4. `runPlanning` accepts any integer run id; only the scheduler supplies one (#12).

## Ask

1. A model title made only of the owner's words can still carry a vague quantity word the denylist misses, such as "more" (#18).
2. A sparse store can show fewer than three starter chips (#18).
3. Naming a thread adds one Haiku call inside the request that completes turn 2 (#18).
4. A migrated `ask` thread shows "New conversation" until its next turn (#18).
5. Ctrl+Shift+L and Meta+L also focus the Ask input (#18).
6. Streaming is used by the Ask page only; recommendation and pack chats still use the JSON request (#21).
7. The prompt no longer asks the model to cite pack entries by title, so provenance may list fewer entries; tools, figures and literals in Sources are unchanged (#21).
8. Streamed figure tokens show the plain value in the checking style, or an ellipsis when unknown, never as a figure chip (#21).

## Owner gate

1. `Tailscale-User-Login` is trustworthy only when `tailscale serve` is the only path in; a direct pod or port-forward can forge it (#11).
2. Any local process on the host that runs the loopback port-forward can send a forged header; there is no code fix (#11).
3. `scripts/dump.mjs` sends no identity header, so a real-mode server answers 401 unless the script goes through `tailscale serve` (#11).

## Goals, year end, advisor

1. Partnerships have no stored names, so year end shows one generic K-1 item (#23).
2. Demo documents have no stored bytes; the demo packet uses a short synthetic text file per document (#23).
3. The year-end zip is buffered to a temp file before streaming, bounded by document size (#23).
4. A template version bump changes the grounding hash and lifts an advisor veto the same way an input change does (#26).
5. A confirmed advisor verdict stays confirmed when the recommendation's inputs later change; there is no staleness marker (#26).
6. Owner notes on a review are stored HTML-escaped, so `advisor_status` returns entity-escaped note text (#26).
7. A store upgraded from before migration 011 shows the old check-in label without a date until the owner sets one (#26).
8. Packet percentage and statutory notes cite the content row's source as a whole, not a per-value derivation (#26).

## Phone

1. War-game charts have no pointer readout, so touch drag on the curve is not implemented (#17).
2. There is no service worker; an installed home-screen icon still needs the network (#17).

## Not on main

Open pull request 27 (SimpleFIN, read-only): holdings are not mapped; a later bridge description keeps the first text; overlapping file rows can raise near-duplicate Confirm cards; the `simplefin` source has no freshness cadence; the fake bridge ignores `start-date`.

Open pull request 24 (Accounts, Engine, What changed, Decide, Files): a decided deferral is recorded but no projection reads it; a W-2 on file wins over a decided salary; a decided salary is dropped for a run when a W-2 exists or distributions would go negative, while the decided line still shows; net worth counts only accounts with two months of data and subtracts card, credit and loan kinds.
