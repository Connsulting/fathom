# Mock v2 build contract

This file is the single source of truth for everyone building `mock-v2/`. Core runtime, scenario
data and each design are built in parallel against it. If something here is ambiguous, pick the
simplest reading and note it at the top of your own file.

## Product in one paragraph

Fathom is a year-round financial co-pilot for a household of two independent professionals (one
S corp owner, one spouse moving from a partnership to a solo LLC, one toddler, a second child
expected early 2027). It mirrors their accounts read-only, knows their goals and life events, and
on a monthly cadence tells them either "it's covered" or the few things that need them before a
window closes. Each recommendation is a lightweight to-do with a why-now, a deadline, a value, a
checklist, and a conversation thread. They can war-game decisions on a tradeoff curve, chat with
the data, connect their own AI over MCP, and meet a human advisor quarterly who sees the same
state and confirms or vetoes what the AI proposed. At year end it hands a clean packet to the
accountant. It does not file taxes or move money.

## Hard rules

1. No real data in tracked files. Never read or copy anything from `mock-v2/private/` or
   `sample-data/` into code, CSS or docs. Real names, balances and dates live only in the scenario
   object loaded at runtime. Design code must render whatever the scenario says and hard-code no
   person, company, institution or dollar figure.
2. No em dashes, no emojis, anywhere (UI copy, comments, docs).
3. Dark mode only. Minimalist and clean. No colored left-border stripes on cards, no chip soup,
   no gradients-for-decoration, no drop shadows on dark. One accent color per design.
4. Vanilla ES modules, no build step, no npm installs. Fonts from Google Fonts only.
   Inline SVG for charts. Must work at 390px wide (no horizontal page scroll) and at 1440px.
5. No network calls except loading the scenario script and fonts. No real LLM calls: all
   conversation is canned from the scenario.

## File layout

```
mock-v2/
  index.html                 core: loads scenario, core, all designs
  core/core.js               core runtime (window.Fathom), harness bar, router, store
  core/harness.css           styles for the harness bar only (scoped under .fx-harness)
  scenario/example.js        synthetic scenario (tracked), same shape as private
  private/scenario.js        real scenario (gitignored); loaded first, falls back to example
  designs/<id>/design.js     one design: registers itself, renders every route
  designs/<id>/design.css    styles, every selector scoped under .d-<id>
  tools/synthesize.mjs       private/scenario.js -> scenario/example.js (names swapped, money scaled)
  README.md
```

Design ids: `ledger`, `console`, `horizon`, `thread`.

## Loading order (index.html)

1. `core/harness.css`, each `designs/<id>/design.css`.
2. Scenario: try `private/scenario.js`; on error load `scenario/example.js`. Each sets
   `window.FATHOM_SCENARIO` and `window.FATHOM_SCENARIO_SOURCE = 'private' | 'synthetic'`.
3. `core/core.js` (module). Then each `designs/<id>/design.js` (module). Each design calls
   `Fathom.registerDesign(...)`. Core boots after `DOMContentLoaded` plus a microtask so all
   designs are registered.

## Page structure

```
<body>
  <div class="fx-harness">  ...review harness, owned by core...  </div>
  <div id="app" class="d-<active id>">  ...owned by the active design...  </div>
</body>
```

The harness bar is a review tool, not product UI. It is a thin (40px) fixed strip at the top,
visually distinct (monospace, muted), containing:

1. Design dropdown (`<select>`): lists registered designs by name. Switching unmounts the old
   design, sets `#app` class, mounts the new one at the same route. Persist in `localStorage`
   (`fx.design`) inside try/catch, and in the URL as `?d=<id>`.
2. Demo state segmented control: `fresh`, `first`, `november`, `checkin`, `clear`
   (labels: "1 New member", "2 First brief", "3 November", "4 Check-in", "5 All clear").
3. AI engine toggle: "Engine: on/off". Off means proactive jobs paused and chat answers show a
   "engine off" notice. Purely canned.
4. Data source label: "private data" or "synthetic data", plus the mock clock
   (`scenario.meta.clockLabel`) and "data through `scenario.meta.dataThrough`".
5. Reset button (resets store to the current demo state's defaults).

On narrow screens the harness collapses to the dropdown plus a "..." button that opens the rest.

## Core API: `window.Fathom`

```js
Fathom.registerDesign({ id, name, blurb, mount(root, api), unmount?(), render?(route) })
Fathom.api  // same object passed to mount
```

`api` (the only thing designs use):

```js
api.s                       // the scenario object (read-only)
api.state                   // current mutable store (see Store), read-only to designs
api.route                   // { name, params } current route
api.go(name, params?)       // navigate; updates location.hash
api.on(fn)                  // subscribe; fn(state, route) called after any change. returns unsubscribe
api.t(str)                  // resolve tokens in a string -> HTML string (see Tokens)
api.txt(str)                // resolve tokens -> plain text (no markup)
api.fig(key)                // { v, src, kind, label } raw figure
api.money(n, opts?)         // format number: $44,854 ; opts.k -> $45K ; opts.sign -> +$1,700
api.recs()                  // all recommendations with live status merged in
api.rec(id)
api.needsYou()              // recs needing the person now (rule below), sorted by window.days
api.verdict()               // { level: 'clear'|'attention', headline, sub } computed
api.act(recId, action, arg?)// action: 'start'|'snooze'|'dismiss'|'complete'|'reopen'|'task'
                            //   'task' arg = task index, toggles done
                            //   'snooze' arg = wake label string
api.ask(questionId)         // appends canned Q and A to the active conversation
api.askFree(text)           // appends free text + scenario.askFallback answer
api.conversation(recId?)    // array of {role:'me'|'fathom'|'advisor', html, refs?, ts}
api.scenarioPick(name, idx) // war-game selection: name 'salary'|'deferral'
api.onboard(step)           // onboarding step index 0..5; step 6 completes -> demo state 'first'
api.engineOn()              // boolean
api.setEngine(on)           // switch the engine from product UI (Engine screen)
                            //   or put data-fx-engine on any button: core toggles on click
api.demo()                  // current demo state id
api.packs()                 // scenario.packs with live status merged ('exploring' after a what-if)
api.pack(id)
api.whatIf(packId)          // marks pack 'exploring', appends pack.whatIf.prompt and answer to
                            //   conversation key 'pack:<id>' (read it with api.conversation('pack:'+id))
api.packToggle(packId)      // available/suggested <-> active (canned; a turned-on pack's recIds
                            //   appear as 'proposed' recs if they were hidden)
```

### Knowledge packs (added after the first brief went out; all designs must support)

The partner knowledge base is organised into curated packs (S corp owner, self-employed and
partnership income, W-2 benefits, Virginia resident, kids and dependents, advanced retirement,
charitable giving, and so on). A pack switches on automatically when the household's facts make
it apply, and then its content is retrieval context for chat and recommendations. Every rec's
`kb` entries carry `pack: '<packId>'`, so a design can show which pack an excerpt came from.
Packs that do not apply yet are still listed as `available` (or `suggested` when something in the
data hints at them), each with a "What if" button: "let me talk through what happens if I did
this". That is how the product can recommend something the person's current facts would never
trigger (for example an S corp election for someone who is only on 1099 income today). The
what-if is a canned conversation that ends in concrete `unlocks` (new recs it would create).
Recs with `pack` hidden behind an inactive pack carry `status: 'hidden'` until the pack is turned
on; designs must not list `hidden` recs.

Packs UI must show: active packs with why they are on (`why`), what they cover, how many curated
entries, curator and last update, the recs each one powers (links); suggested and available packs
with their trigger hint and a What if action; the what-if conversation with its `unlocks` list and
a "Turn this pack on" action (`api.packToggle`). Packs should also be visible from rec detail
(the kb excerpts' pack names link to the pack).

### Routes (hash based: `#/<name>/<param>`)

| name | params | purpose |
|---|---|---|
| `onboarding` | `step` 0..5 | only route available in demo state `fresh` |
| `brief` | | home. Verdict, needs-you, year clock, what changed, covered domains |
| `plan` | | all recommendations by status (the to-do list) |
| `rec` | `id` | recommendation detail with conversation |
| `ask` | | open conversation with the data |
| `wargame` | `name` optional | tradeoff scenarios (`salary`, `deferral`) |
| `goals` | | prose goals and where-on-the-curve preferences |
| `accounts` | | read-only mirror of accounts and detected events |
| `advisor` | | quarterly human check-in |
| `yearend` | | accountant packet |
| `connect` | | MCP / bring your own AI |
| `engine` | | proactive jobs, chat engine, monthly budget, on/off |
| `email` | | the monthly email digest preview |
| `packs` | `id` optional | knowledge packs: active, suggested, available; detail with "What if" |

Demo state `checkin` starts on `advisor`. Demo state `fresh` forces `onboarding`.

### Store and status rules

Each rec has a base `status` in the scenario plus optional `statusByDemo: { first: 'proposed', clear: 'done' }`.
Live status = action overrides ?? statusByDemo[demo] ?? status.

Statuses: `proposed` (new, needs a decision), `doing` (the owner has committed: "Doing it",
in motion with its steps tracked), `waiting` (blocked; `waitingOn: 'data'|'advisor'|'date'`), `snoozed`
(`wake` label), `done`, `dismissed`.

Actions (buttons): start ("Doing it") -> doing; complete ("Done") -> done; snooze ("Later") ->
snoozed; dismiss ("Not for us") -> dismissed; reopen -> proposed. Completing all tasks does not auto-complete.

`needsYou()` = recs where status is `proposed`, or status is `doing` and
`window.days <= 30`. Excludes `waiting`, `snoozed`, `done`, `dismissed`.

`verdict()`: if needsYou is empty -> level `clear`, headline from `scenario.verdict.clear`,
else `attention` with headline from `scenario.verdict.attention` where `{count}` is replaced.

### Tokens

Scenario prose never states a number directly. It uses tokens:

| token | resolves to |
|---|---|
| `{f:key}` | money figure `scenario.fig[key]` formatted `$44,854` |
| `{fk:key}` | same, compact: `$45K`, `$2.38M` |
| `{l:key}` | statutory money `scenario.law[key]` formatted `$24,500` |
| `{p:key}` | percent `scenario.pct[key]` formatted `35%` |
| `{n:key}` | name `scenario.names[key]` |

`api.t()` wraps `{f}`/`{fk}` results in `<span class="fx-fig" data-fig="key" data-kind="a|p|e|m">`
so a design can style provenance (`a` actual from a mirrored account, `p` projected from the plan,
`e` estimate, `m` model output) and show `api.fig(key).src` on hover or tap. `{l}` gets
`class="fx-law"`. Designs must give `.fx-fig` an affordance (dotted underline is fine) and show
its source on click (a small popover; core provides `api.figPopover(el)` that any design may call,
or roll your own).

## Scenario schema (`window.FATHOM_SCENARIO`)

```js
{
  meta: { product:'Fathom', clock:'2026-11-05', clockLabel:'Thu, Nov 5, 2026',
          dataThrough:'Aug 30, 2026', household:'string' },
  names: { me, spouse, kid, biz, spouseBiz, w2, bank, broker, payroll, hsa, advisor, specialist },
  law:  { key: number },                    // statutory amounts, never scaled
  pct:  { key: number },                    // percents, 0-100
  src:  { id: { label, asOf } },            // provenance sources
  fig:  { key: { v: number, src: 'srcId', kind: 'a'|'p'|'e'|'m', label: 'short label', notes?: ['assumption sentence'], unavailable?: 'reason' } },  // notes: at most five; unavailable: kept for reference, not current
  series: { key: { label, unit:'$', points:[{ x:'Apr', v:number, kind:'a'|'p' }] } },

  verdict: { clear:{ headline, sub }, attention:{ headline, sub } },   // tokens allowed

  domains: [ { id, name, watching:'what we watch (tokens)', status:'covered'|'changed'|'needs'|'waiting',
               note:'one line (tokens)' } ],

  events: [ { date:'Aug 14', kind:'income'|'life'|'calendar'|'account'|'milestone',
              title, body } ],              // "what changed"; tokens allowed

  deadlines: [ { date:'2026-12-31', label:'Dec 31', title, recId?, hard:boolean } ],

  recs: [ {
    id, title, summary,                     // summary: one sentence, tokens
    trigger: 'calendar'|'income'|'life'|'goal'|'advisor',
    triggerText,                            // e.g. "Hard deadline: Dec 31"
    domain,                                 // domain id
    window: { label:'Dec 31', days: 56 },
    effort: '10 min',
    status, statusByDemo?, waitingOn?, wake?,
    advisor: null | { verdict:'confirmed'|'pending'|'vetoed', note },
    value: [ { cls:'tax'|'timing'|'retire'|'risk'|'cash'|'goal', text } ],  // never summed
    why: [ 'paragraph', ... ],              // why this, why now
    mine: [ { label, fig:'figKey' } ],      // grounded figures from their data
    kb: [ { title, body, cite } ],          // partner knowledge base excerpts
    cross: [ 'how this touches another decision' ],
    tasks: [ { t, done:boolean } ],
    qa: [ { q, a:[ 'paragraph' ] } ],       // canned follow-ups in the rec conversation
    scenario?: 'salary'|'deferral'
  } ],

  goals: [ { id, title, prose, horizon:'now'|'1-3y'|'3-10y', status:'done'|'on track'|'watch'|'open',
             progress?: { cur:'figKey', target:'figKey' } } ],
  curve: [ { id, left, right, value: 0..1, note } ],   // where-on-the-curve preferences

  wargame: {
    salary: { title, question, xLabel, yLabel,
              points:[ { id, label, x:number, y:number, frontier:boolean, current?:boolean, warn?:string, note } ],
              takeaway },
    deferral: { title, question,
                options:[ { id, label, amount:number, tax2026:number, tax2027:number, net:number,
                            decCash:number, need:number, note } ],
                takeaway }
  },

  ask: { suggested:[ { id, q, a:[ 'paragraph' ], refs:[ 'recId' ] } ], fallback:[ 'paragraph' ] },

  accounts: [ { id, inst, name, owner, kind:'business'|'checking'|'taxable'|'retirement'|'roth'|'hsa'|'529'|'cash',
                fig:'figKey' | null, mirror:'connected'|'manual'|'missing', note } ],

  advisor: {
    name, role, next:{ when, length }, agenda:'prose',
    reviewed:[ { recId?, title, verdict:'confirmed'|'vetoed', note } ],
    pending:[ 'recId' ],
    notAsking:[ { q, why } ],
    shared:[ { title, when } ],
    experts:[ { name, role, when } ]
  },

  yearend: { docs:[ { t, status:'have'|'expected'|'missing', src, note } ],
             decisions:[ { t, done:boolean, recId? } ] },

  connect: { url, scopes:[ { id, label, access:'read'|'write', on:boolean } ],
             tools:[ { name, desc } ], transcript:[ { role:'me'|'claude'|'tool', text } ], config:'string' },

  engine: { budget:{ monthly:number, used:number },
            jobs:[ { id, name, cadence, last, next, does, cost } ],
            chat:{ model:'label', note } },

  onboarding: { welcome:{ headline, sub }, dump:'prose', files:[ { name, status } ],
                institutions:[ { inst, accounts, mode:'read-only' } ],
                heard:{ people:[...], entities:[...], income:[...], lifeEvents:[...], deadlines:number, questions:[...] },
                priorities:[ { id, label, value } ] },

  email: { subject, preheader, greeting, sections:[ { heading, items:[ 'tokens' ] } ], footer },

  // Decide is dynamic: open decisions first, decided ones collapsed, upcoming ones with when they open.
  decisions: [ { id, title, status:'open'|'decided'|'upcoming', wargame?:'salary'|'deferral', recId?, when, note } ],
  // wargame.salary and wargame.deferral also carry status ('open'|'decided') and, when decided, a `decided` line.

  packs: [ { id, name, status:'active'|'suggested'|'available',
             why:'why it is on, or the hint that it might apply (tokens)',
             covers:[ 'topic' ], entries:number, curator, updated,
             recIds:[ 'recId' ],
             whatIf: { prompt:'What if ...', a:[ 'paragraph (tokens)' ],
                       unlocks:[ { title, text, recId? } ] } } ]
}

// rec.kb entries: { title, body, cite, pack:'packId' }
// rec.status may be 'hidden' (behind an inactive pack); never listed until the pack is on.
// Every text field in the scenario may contain tokens; always render through api.t().
```

## What every design must cover

1. Onboarding (6 steps): welcome and simulated sign-in, "dump everything in" prose box with
   attached files, connect accounts read-only (a modal that says it cannot move or delete),
   "what we heard" confirmation, where-on-the-curve priorities, building first brief.
2. Brief: verdict; the needs-you items with window countdown; a year clock (Jan to Dec, today
   marker, deadlines); what changed this month; covered domains; link to the monthly email.
3. Plan: all recs grouped sensibly; each shows trigger, window, effort, value classes, advisor
   verdict. Actions available inline and in detail.
4. Rec detail: why now, from your data (grounded figures), from the knowledge base (with cite),
   cross-effects, checklist (toggleable), advisor verdict, actions, and a conversation thread with
   canned follow-up chips (`api.ask`-style via `rec.qa`; use `api.conversation(recId)`), plus a
   link to the war game when `scenario` is set.
5. Ask: suggested questions, free text box (fallback answer), answers with grounded figures and
   links to recs.
6. War game: salary as a tradeoff curve (scatter with frontier line; x = retirement room,
   y = tax change; current point marked; selecting a point shows its note); deferral as
   selectable options showing 2026 tax, 2027 tax, net, and December business cash against
   payroll need (a bar against a threshold).
7. Goals, Accounts, Advisor, Year-end, Connect, Engine, Email: render all fields listed above.
8. Every action visibly changes state (status, counts, verdict). Completing the needs-you items
   in demo state `november` must flip the brief to the clear verdict.

## Design briefs

All four are dark, minimalist, clean, and must feel like a real product, not a wireframe.

1. `ledger` "Ledger": editorial and calm. The brief reads like a short monthly letter. Serif
   display (for example Newsreader or Fraunces) with a quiet sans for UI. Single centered column,
   generous whitespace, hairline rules, numbers set as tabular figures. Navigation is a quiet top
   text menu. Accent: warm brass.
2. `console` "Console": keyboard-first and dense but uncluttered, in the spirit of Linear or
   Raycast. Left sidebar, list and detail split panes, a Cmd-K command palette that can jump to
   any route or rec and run actions. Mono for figures. Accent: cool blue or electric violet.
3. `horizon` "Horizon": time is the interface. The calendar year (and the next few years for goals)
   is the spine: a horizontal timeline where recs sit at their windows, and "now" is a line you
   can see. Everything else hangs off the timeline. Accent: a single teal or green.
4. `thread` "Thread": conversation-first. Home is a single thread where Fathom posts the monthly
   brief, recs arrive as compact interactive cards inside the thread, and you can reply or tap
   follow-ups. Data, plan and settings live in a slide-over drawer. Accent: soft amber or coral.
