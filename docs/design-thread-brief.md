# PolicyLoop design thread brief

## Outcome

Produce two reviewable artifacts in this repository:

1. `docs/product-and-architecture-design.md`, a detailed product and technical design.
2. A polished, locally runnable, fixture-backed clickable prototype for the owner to review in a browser.

This is a design and interaction prototype assignment, not a production build.

## Required experience

Place a clearly labeled demo-control bar at the top of every prototype screen. It must switch among:

1. Fresh sign-in and initial setup.
2. Imports completed and initial recommendations available.
3. Complex ongoing state with numerous recommendations and tasks in several lifecycle states.

Demonstrate these user journeys end to end:

1. Initial setup, prose-first goal capture, and monthly snapshot import.
2. Returning to ask financial and goal questions through conversation.
3. Reviewing recommendations and working through lightweight tasks, including accepting, implementing, snoozing, dismissing, and completing examples.

Use realistic synthetic owner-operator household and S-Corp data. Never copy identifiers or private values from the wiki.

## Product constraints

- Monthly snapshot exports, not live integrations.
- Two clocks: verified financial state through the last close and current planning state updated through conversation.
- Rigid accounting rows, prose-first goals, stateful recommendations, and lightweight child actions.
- Conversation is an operating surface over structured state, not authoritative memory.
- QuickBooks and other financial systems remain systems of record.
- No tax filing, money movement, investment selection, or general project-management product.
- The target personal alpha is single-workspace, has no application authentication, and is reachable only through Tailscale on the owner's homelab cluster.
- The prototype may simulate sign-in but must not implement authentication.

## Design expectations

Read every source named in `CLAUDE.md`. Reconcile contradictions and call them out. Do not simply restate the wiki architecture. Make concrete interaction, state-model, calculation-boundary, deployment, security, evaluation, and spike recommendations.

The spike plan must specify three or four independent architectural spikes. Each needs supplied inputs, artifact outputs, acceptance evidence, estimated autonomous size, and the decision unlocked. It must be suitable for the owner to choose later whether to add each spike to Bonus Drain. Do not queue or dispatch the spikes.

## Verification

- Run the prototype through its real local browser entry point.
- Exercise all three demo states and all three journeys.
- Run the repository's available checks.
- Leave the working tree with reviewable files and concise run instructions.
- Do not push, create a remote, open a pull request, deploy, or use real financial data.
