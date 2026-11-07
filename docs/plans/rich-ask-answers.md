# Plan: rich Ask answers (charts, tables, comparisons) and war games in Ask

Status: planned. Branch `docs/rich-ask-answers`, base `main`. Nothing here is built until its
ticket in section 9 merges. Read `AGENTS.md` and `docs/ask-tools.md` (sections 3, 4 and 7) first;
this plan builds on the tool registry, figure envelope and figure references defined there.

Owner direction, 2026-11-07:

> "You know how [a coding chat app] has the ability in chat to show interactive charts and stuff?
> We should have that in Ask with charting and sortable tables and stuff... and side by side stuff
> like that. Just have it all in Ask!"

Separately the owner decided that the What-if page (the war games) goes away. Each war game
(salary, invoice deferral) becomes a suggested Ask question whose answer reads the same
deterministic war-game model through a tool, shows the comparison in the answer, and lets the
owner pick a point as an Ask write with Undo.

## Risks and external dependencies (read first)

Calendar estimate: about three to five calendar days after C2, C3 and C4 merge, at up to three
parallel workers. Each ticket is one agent run plus CI and one cross-provider review. The date is
set by the four-deep chain B1, B2, B4, B5, by C9 (which B4 needs and which itself waits on C2 and
C3), and by the owner's merge gate on each PR.

1. Upstream tickets in flight. B1 needs C2 (PR #105: write plumbing, the last ticket allowed to
   edit `src/api/answerer.mjs` before B1), C3 (PR #106: `src/tools/refs.mjs`, `quote`) and C4
   (PR #104: `spending.total` groups and C4 transaction rows, the first list-of-figures reads). B4
   needs C9 (`act_on_recommendation.pick_point`, `decide`, `revisit`), which is not opened yet.
   If any of them changes the figure envelope or the Ref shape before merging, sections 3 and 4
   follow the merged shape and the ticket that hits the difference says so in its PR.
2. Serialized files. `src/api/answerer.mjs` and `test/answerer.test.mjs` are C1 then C2 in
   `docs/ask-tools.md`; B1 is the next and only B ticket to edit them. `src/tools/tools.mjs` and
   `src/tools/index.mjs` are "never edited by a ticket" in the C series; B1 edits both once (the
   `show` header and the Ask-only flag) and is the only B ticket that does. `evals/catalog.json`
   gets new case ids from B1 and B4 only, never an edit to an existing entry. `web/horizon/design.js`
   is edited by B4 (rec dialog link) and B5 (page removal); B5 merges second.
3. Context budget. `show` adds its description, schema and rules to the Ask tool list (not to
   MCP). The C1 budget test caps the MCP list at 30,000 characters and the rule text at 8,000;
   B1 adds the same 30,000 cap for the Ask-offered list and keeps the rule text under 8,000. The
   estimate is about 2,400 schema and description characters and about 700 rule characters.
4. Model behavior is a hypothesis. Tier 1 evals prove a scripted block validates and renders; only
   the tier 2 live run (`npm run eval:ask:live`, never in CI, spends against the engine cap) shows
   whether a live model calls `show` with valid references. The coordinator runs it after B1 and
   again after B4. It is not a ticket gate.
5. War-game freshness. The war-game model is computed by the planning run (`buildWargames` in
   `src/jobs/planner/wargame.mjs`) and stored as `wg.*` figures. Ask reads that stored model, so
   its figures are as of the last planning run, exactly as the page showed them. A live re-run
   with different inputs is deferred (section 7).
6. Scenario payload size. Blocks are stored in message provenance and reach the client with the
   thread. A block's stored form is capped at 64 KB and an answer at four blocks, so one answer
   adds at most 256 KB; a long thread of block-heavy answers grows the thread payload. Nothing here
   pages messages; if threads get slow, paging messages is a separate ticket.
7. Decide list relocation. The `#/wargame` route also hosts the Decide list (every open, upcoming,
   decided and not-built decision, including decisions with no war game). Removing the page needs
   a new home for that list; this plan pins it as a section on the Plan screen (section 7). This is
   an assumption the coordinator should confirm with the owner before B5 dispatches.

## Pinned decisions

1. A block is declared by the model through one Ask-only read tool, `show`, with one operation per
   block type (`chart`, `table`, `compare`, `timeline`). The model passes a block type, references
   to tool calls it already made in this answer, and field paths. It never passes a number, a label
   for a number, a color or HTML.
2. A deterministic builder turns a valid `show` call into a stored snapshot (every value as its
   figure envelope with provenance), and a deterministic client renderer draws the snapshot in
   Horizon style. Every drawn value is a figure with the existing provenance popover.
3. Validation is all or nothing at `show` time. An invalid block is never stored; the model gets a
   `dropped` result with a reason code, and the answer carries a plain note.
4. Blocks are stored with the message (`provenance.blocks`), placed by `{b:<id>}` markers in the
   answer text, and re-render from the stored snapshot. A later check marks a block stale when
   its data changed; it never silently recomputes.
5. `show` is never listed over MCP. MCP clients get the underlying structured tool results, which
   hold everything a block draws.
6. War games: a new read operation `recommendations.wargame` returns the stored war-game model as
   figures. Two suggested questions replace the What-if page. A compare block over that operation
   gets renderer-bound actions: Pick this (`act_on_recommendation.pick_point`) and Decide on this
   (`act_on_recommendation.decide`), each a registry write with a receipt and Undo in the
   conversation.
7. The What-if page, its route, the Ask sub-tab entry, the rec dialog's "War-game this" link and
   the Decide page are removed in B5, after B4 ships the replacement. The Decide list moves to the
   Plan screen.

Rejected:

1. Blocks as fenced JSON in the answer text. Parsing model text is fragile, the model learns about
   a bad block only after the answer is written, and grounding would have to skip the JSON.
2. Blocks that carry their own values ("data": [..] from the model). That is the model stating
   numbers, which the product boundary forbids.
3. Re-evaluating every reference when a conversation opens and drawing the new values. That
   silently recomputes old answers; the owner would see a chart that no longer matches its prose.
4. A model-authored action on a block. An action is a write; only the renderer may bind one, from
   a closed table, to data it already validated.
5. A live war-game re-run tool now. It needs the planner's whole input context per call
   (`buildWargames(data, out, ctx)` with household tax runs); the stored model is what the page
   showed and keeps Ask and the plan on one set of numbers.
6. Reviving the page's salary scatter as a separate widget. The `scatter` chart kind draws it from
   the same data through the general renderer.

## 1. Block types

Every block has an optional `title`: plain words, 1 to 80 characters, no digits, escaped on render.
Without one the renderer uses the source tool's plain source label ("Your spending"). Axis, series,
column and option labels always come from data (section 3), never from the model.

| Operation | What it draws | Model supplies | Limits |
|---|---|---|---|
| `chart` | `line`, `bar`, `area` over an ordered series (months, years, groups); `scatter` of one figure against another (the salary tradeoff) | `kind`, `source` (list Ref), `x` (Path), `series` (1 to 4 of `{ path, source? }`), `stacked?` (bar and area only), `title?` | 4 series; 120 points per series; one unit across all series; for `scatter` one unit per axis |
| `table` | Sortable, filterable rows with optional drill-down to the rows behind a figure | `source` (list Ref), `columns` (1 to 8 Paths), `sort?` (`{ column: Path, dir: 'asc' or 'desc' }`), `title?` | 8 columns; 200 rows; one unit per column |
| `compare` | Side-by-side options with their figures; renderer-bound actions for war games | either `source` (list Ref, each item an option) or `options` (2 to 8 of `{ source }`, each an object Ref), plus `fields` (1 to 8 Paths), `title?` | 2 to 8 options; 8 fields; one unit per field across options |
| `timeline` | Dated events in order (access ages, obligation changes, deadlines, goal dates) | `source` (list Ref), `date` (Path), `value?` (Path), `title?` | 60 events; `date` resolves to a date figure or an ISO date string |

Shapes:

1. Ref is the C3 shape `{ tool, args, path }`. For a list Ref, `path` points at an array (`groups`,
   `months`, `rows`, `points`, `''` for a top-level array); for an object Ref at an object. The
   `tool` and `args` must deep-equal a call made earlier in this answer that did not error
   (section 4, rule 2).
2. Path is a dotted path inside one item: segments match `^[A-Za-z_][A-Za-z0-9_]*$` or are a
   non-negative integer; at most 6 segments (`figure`, `household.net`, `figures.tax`).
3. Schema: `additionalProperties: false` everywhere; no property in the `show` schema outside
   `source.args` and `options[].source.args` has type `number` or `integer`. `kind`, `dir` and
   `operation` are enums. Ref `args` are opaque objects, checked by deep-equality against the turn.

What each value becomes:

1. A figure envelope at the path (`isFigure` from `src/tools/refs.mjs`): drawn from `value` and
   `quote`, with the provenance popover.
2. A row number from the row-number allowlist: `transactions.search` `rows[].amount` and
   `business.rows` item `amount`. Its provenance is the row itself (account label, date,
   description), as the answerer's row sources name it today.
3. A plain string (`month`, `key`, `label`, `date`, `description`, `category`, `merchant`,
   `cadence`, `status`, `account.label`): shown as escaped text. A string that is a whole number
   or contains one is allowed only for the keys `month`, `date`, `year`, `key` and `window.from`,
   `window.to`, because those are tool data, not claims.
4. Anything else (a bare number outside the allowlist, an object, a missing path in any item) makes
   the block invalid.

Labels the renderer derives:

1. Series and column labels: the figure `label` when every item's figure at that path shares it;
   otherwise the field name in words from a fixed `FIELD_LABEL` map in `src/blocks/labels.mjs`
   (`total`: Total, `net`: Net, `inflow`: Money in, `outflow`: Money out, `annualCost`: Per year,
   `typicalAmount`: Typical charge, `figure`: Amount, `amount`: Amount, `date`: Date,
   `description`: Description, `category`: Category, `merchant`: Merchant, `cadence`: How often);
   an unmapped field uses the tool's source label.
2. Category labels on the x axis and option labels: the item's `label`, else `key`, else `month`
   or `year` formatted (`2026-03` reads "Mar 2026"). For `options` given as separate Refs whose
   calls differ only in one assumption, the option label is the assumption's `name` in words plus
   its `stated` text from provenance ("Real return 3%"), both tool data.
3. Axis tick marks are scale marks computed by the renderer (`niceTicks`, moved from design.js into
   the block renderer), formatted with `api.money`; they are `aria-hidden` and carry no provenance.
   Every data value stays reachable as a figure through the popover and the table view.

## 2. Where blocks live

Blocks render wherever `web/horizon/screens/chat.js` renders a Fathom message: the full Ask page,
the Ask side panel (docked, sheet and full-height sheet), and the rec dialog's thread. One module,
`web/horizon/screens/ask-blocks.js`, renders all four types; chat.js calls it for each message with
`provenance.blocks` and places each block after paragraph `after`.

Layout:

1. Width follows the message column. In the docked panel the content box is as narrow as 288 px
   (320 px panel less padding); every block type must work at 288 px.
2. Charts: 16:9 up to 240 px tall on the page, 200 px at 288 to 480 px wide. Legend below the plot
   when there are 2 or more series. Line and area use 2 px strokes; bar charts use rounded 2 px
   corners and a zero baseline; scatter draws the frontier polyline when items carry `frontier`.
3. Tables: native `<table>`, first column sticky, the table inside a container with
   `overflow-x: auto`, `tabindex="0"` and an `aria-label`, so the page never scrolls sideways.
   Numbers right-aligned with tabular figures. A filter box appears above tables with more than 8
   rows. More than 20 rows show 20 with "Show all N rows".
4. Compare: options side by side as columns when the block is at least 560 px wide and has at most
   4 options; otherwise stacked cards, one per option, each listing its fields. The picked option
   (war games) has a check and the text "Picked".
5. Timeline: a vertical list with a date rail, each event's date, label and optional value.
6. Theme: colors only from Horizon tokens in `web/horizon/design.css` plus a 4-step series ramp
   declared as custom properties in `web/horizon/screens/ask.css` for light and dark. Every ramp
   color has at least 3:1 contrast against the panel background in both themes, checked by a unit
   test that reads the CSS.

Accessibility:

1. Each block is a `<figure>` with a `<figcaption>` (the title) and, for charts, an SVG with
   `role="img"` and an `aria-label` summary built from data ("Line chart of Total by month, Jan
   2026 to Oct 2026").
2. Every chart has a "Table" toggle that swaps in the same data as an accessible table; the toggle
   is a button with `aria-pressed`.
3. Keyboard on charts: the plot is one tab stop; Left and Right move the active point, Up and Down
   change series, the active value is announced through an `aria-live="polite"` region, Enter or
   Space opens the provenance popover for the active figure, Escape closes it and returns focus.
4. Tables: sort buttons inside `<th scope="col">` with `aria-sort`; the filter is a labelled
   `<input type="search">`; a drillable row has a "Show rows" button in its first cell that expands
   an inline region below the row (not a modal), moves focus to that region's heading, and Escape
   collapses it and returns focus to the button.
5. Compare: each option is a group with a heading; Pick this is a button whose accessible name
   includes the option label; the picked state is text, not color alone.
6. Figures inside blocks use the existing `.fx-fig` spans with `tabindex="0"` (none inside
   buttons), so the popover works by click, Enter and Space as everywhere else.

Provenance hover: when a message with blocks renders, chat.js registers each snapshot figure into
the client figure registry under `blk:<messageId>:<blockId>:<n>` with its value, kind, label, as-of
date, source label and provenance, the same way `api.pnlRows` registers row figures today. A new
`api.registerFigures(map)` in `web/core/core.js` exposes that registration. A stale block's figures
add "Changed since this answer" to the popover.

Streaming: while an answer streams, a `{b:<id>}` line renders as a neutral placeholder box ("Chart
being prepared") through `streamHtml`; the final stored message replaces it. The `show` call shows
the progress step "Drawing a chart" in the work block.

Over MCP: `show` is never listed and `instructions` omit its rules. An MCP client reads the same
`spending`, `accounts`, `recommendations` and other results a block would draw from, as JSON with
envelopes. No API or tool returns block HTML. If a later tool ever exposes Ask conversations, it
returns `provenance.blocks` as stored JSON (spec and snapshot), never rendered markup.

## 3. The `show` tool

Header in `src/tools/tools.mjs`: `['show', 'read', 'Show results from this answer as a chart,
table, comparison or timeline.', 'Drawing a chart', 'your answer']`, with `askOnly: true`.
Operations live in `src/tools/catalog/show.mjs`; the builder and validator in `src/blocks/`.

1. `askOnly` tools are offered to Ask in every purpose that offers read tools and are never listed
   or callable over MCP (`src/mcp/server.mjs`, `toolsForScopes`). The parity test ignores them.
2. `show` is not `referenceable`: a Ref to `show` is invalid in a block and in `calculate`.
3. The handler reads the answer's earlier calls through `ctx.turnResults()`, a new accessor that
   `createRegistryServer` (`src/engine/tools.mjs`) puts on the tool context: the `results` list it
   already keeps, in call order. The answerer shares one collector across the first engine call and
   a regeneration, so a block in the second call may use the first call's results.
4. Result to the model on success: `{ block: '<id>', status: 'shown', place: '{b:<id>}' }`, ids
   `b1` to `b4` in call order. On failure: `{ status: 'dropped', reason: <code>, note: <plain
   text> }` as a normal (not `isError`) result, so the model can carry on without it.
5. Rules for the model (in the assembled rule text, Ask only):
   1. When a trend, breakdown, ranking or side-by-side choice would be clearer drawn than written,
      call `show` after the reads it draws from, copying their exact tool and arguments as
      `source`. At most four blocks per answer.
   2. Never put a number, a label for a number, or markup in `show`. Pick paths to fields the
      result already has.
   3. Put `{b:<id>}` on its own line where the block belongs. Do not repeat every value of a block
      in prose; state the one or two figures the answer turns on, quoted as usual.
   4. If `show` returns `dropped`, do not mention the block.

## 4. Validation

`validateBlock(op, args, turnResults)` in `src/blocks/validate.mjs` is pure. A block passes only if
every rule holds; the first failing rule names the reason. Nothing partial is ever stored.

| # | Rule | Reason code |
|---|---|---|
| 1 | Schema valid (registry Ajv; no numeric property outside Ref args; title has no digit) | `bad_input` (registry) |
| 2 | Every Ref's `tool` and `args` deep-equal (canonical JSON, sorted keys) a non-error call in `turnResults()` | `not_in_answer` |
| 3 | Every Ref's tool is a read tool other than `show`; a write tool, `undo` or an unknown tool fails | `not_a_read` |
| 4 | Every Ref `path` resolves in that call's result to an array (list Ref) or object (object Ref) | `bad_path` |
| 5 | Every field path resolves in every item to a figure, an allowlisted row number or an allowed string (section 1) | `bad_field` |
| 6 | Units: one unit across a chart's series (per axis for scatter), per table column, per compare field; a chart's y values are not dates; a timeline's `date` is a date | `mixed_units` |
| 7 | Sizes: the limits in section 1; at most 4 blocks per answer; stored snapshot JSON at most 65,536 bytes | `too_large`, `too_many` |
| 8 | Chart `x` values are unique; series given with their own `source` align on the same `x` values | `misaligned` |

Unavailable figures (value null with a gap) are valid: they draw as a gap in a line, an empty bar,
or "Unavailable" text with the gap message in the popover.

The plain note stored for a dropped block is fixed per reason: "A chart was left out because its
data did not check out." (table: "A table ...", compare: "A comparison ...", timeline: "A timeline
..."). Notes are stored in `provenance.blockNotes` and rendered as muted lines under the answer.
A `{b:<id>}` marker naming an unknown or dropped id is removed from the text.

## 5. Persistence and staleness

Stored shape, in `messages.provenance` (no migration):

```
blocks: [ { id: 'b1', op: 'chart', after: <paragraph index>,
            spec: <the validated show args without operation>,
            calls: [ { tool, args } ],            // distinct source calls
            snapshot: <render model, below>,
            asOf: <newest figure asOf>, builtAt: <app clock ISO> } ]
blockNotes: [ { op, reason, text } ]
```

1. The snapshot is the render model the client draws, built by `buildSnapshot(op, spec, results)`
   in `src/blocks/snapshot.mjs`: for charts `{ kind, x: [ { text } ], series: [ { label, unit,
   points: [ Figure or null ] } ] }`; for tables `{ columns: [ { label, unit?, kind: 'figure' |
   'row_number' | 'text' } ], rows: [ { cells: [...], drill?: Drill } ] }`; for compare `{
   options: [ { label, id?, cells: [...] } ], fields: [ { label, unit } ], action?: Action }`; for
   timelines `{ events: [ { date, label, value? } ] }`. A Figure in a snapshot is the envelope
   with `provenance.steps` cut to 20 and `provenance.inputs` cut to 20 (with a count of the rest).
2. Placement: the answerer splits the final text on lines that are exactly `{b:<id>}`; a block's
   `after` is the number of rendered paragraphs before its marker. A marker inside a sentence is
   removed and the block goes after that paragraph. A shown block with no marker goes after the
   last paragraph, in call order. `TOKEN_LIKE` and the grounding mask learn the `b` token kind so a
   marker never counts as a number.
3. Reopening a conversation draws every block from its snapshot, with its as-of dates, and never
   calls a tool.
4. Staleness: `GET /api/threads/:id/blocks` re-runs each stored block's `calls` (deduplicated,
   read tools only, today's clock, the household's tool context) for the 20 most recent Fathom
   messages with blocks, rebuilds each snapshot from the same spec, and compares figure by figure
   (value to the cent for money, exactly otherwise, and `asOf`). It returns `{ blocks: [ {
   messageId, id, state: 'current' | 'stale' | 'unavailable', changed: <count> } ] }` and writes
   nothing. A call that now errors, or a spec that no longer validates, is `unavailable`.
5. The client calls it once when a thread opens. A stale block keeps its stored values and shows a
   badge "Stale" with "Your data changed after this answer. Values are as of <asOf>." and an "Ask
   again" button that sends the message's question as a new owner message in the same thread. An
   unavailable block shows "This data is no longer available" with the stored values dimmed.

## 6. Drill-down

A table row (or a chart point, through the Table view) is drillable when its figure came from an
operation in the drill table. Drilling never calls the model; it fetches the rows behind the figure
through the existing Money routes, which register their figures and sources for the popover.

| Source operation | Item | Drill fetch |
|---|---|---|
| `spending.total` with `groupBy` `category`, `month` | a group | `api.spendingRows` (`GET /api/spending/rows`) with the call's window as `from`/`to`, its `include`/`exclude`, and the group key as `category` or `month` |
| `spending.total` with `groupBy: 'none'` | the total | `api.spendingRows` with the window, `include`, `exclude` |
| `business.pnl` with `groupBy` `month`, `category` | an entity group | `api.pnlRows` (`GET /api/pnl/rows`) with entity, period, section and the group key |

`drillQuery(ref, item)` in `src/blocks/drill.mjs` builds the query; it returns null for any call it
cannot express exactly (a definition, a selector field the route does not take, another `groupBy`),
and a null query means no drill button. The snapshot stores the query as `drill`. The drilled list
shows the route's `sum` figure beside the block figure; B3's tests assert they are equal for every
mapping above on the demo store.

## 7. War games as Ask flows

### The read

New operation `recommendations.wargame` (read, referenceable), in
`src/tools/catalog/wargame.mjs`:

| Parameter | Type |
|---|---|
| `name` | `salary` or `deferral` (required) |

Result:

```
{ name, title, question, status: 'open' | 'upcoming' | 'decided' | 'unavailable' | 'not_built',
  decision: { id, status, decidedLine? } or null,
  notBuilt?: { code, text, unlock: 'files' | 'answers' },
  picked: <point id> or null, asOf: <planner run date>,
  salary:   { xLabel, yLabel, points: [ { id, label, current, frontier, note, warn?,
              figures: { salary, payroll, distributions, tax, room, rothRoom?, taxChange } } ] },
  deferral: { monthlyInvoices, options: [ { id, label, note,
              figures: { amount, taxThisYear, taxNextYear, net, decemberCash, payrollNeed, gap } } ] } }
```

1. Each figure is `fromStored` over the stored `wg.<name>.<id>.<field>` figure (planner keys:
   `salary`, `payroll`, `dist`, `tax`, `x`, `roth`, `y`; `amount`, `tax<year>`, `net`, `decCash`,
   `need`, `gap`), with the planner's label, kind `m`, the planner run date as `asOf`, and `ref`
   pointing at this operation and the figure's path. `taxThisYear` and `taxNextYear` map the two
   `tax<year>` keys in year order.
2. Status and decision come from the scenario's `wargame` and `decisions` exactly as Decide derived
   them (`deriveWargame`, `deriveDecisions` in `src/scenario/build.mjs`); `picked` from the
   `wargame.picks` setting merged over `defaultPicks`.
3. `not_built` returns `notBuilt` from `notBuiltReason` and no points; `unavailable` returns the
   points for reference and no actions.

### The suggested questions

Two starters join `ASK_STARTERS` in `src/scenario/build.mjs`, first in order, each shown only when
its game's status is `open` or `upcoming`:

| Starter id | Question | The answer calls |
|---|---|---|
| `wargame-salary` | Compare the salary options for my S corp side by side. | `recommendations.wargame {name: 'salary'}`, then `show.chart {kind: 'scatter', x: 'figures.room', series: [{path: 'figures.taxChange'}]}` over `salary.points`, then `show.compare` over `salary.points` with fields `salary`, `tax`, `room`, `distributions` |
| `wargame-deferral` | Should I move some December invoices into January? Compare the options. | `recommendations.wargame {name: 'deferral'}`, then `show.compare` over `deferral.options` with fields `amount`, `taxThisYear`, `taxNextYear`, `net`, `decemberCash`, `payrollNeed` |

The starter cap of four in chat.js stays; the war-game starters lead because open decisions are
time-bound. The fake engine (`src/api/fake-answers.mjs`) scripts both starters, including their
`show` calls and markers, so the demo build runs the flow end to end with no model.

The answer's prose follows the existing rules: it quotes the figures it discusses, names the
assumptions the model used (from figure provenance), reports gaps and never says which point to
choose beyond what a recommendation already says.

### Pick and decide as Ask writes

1. A `compare` block whose source is `recommendations.wargame` gets an `action` in its snapshot from
   the closed table `BLOCK_ACTIONS` in `src/blocks/actions.mjs`. Nothing else ever gets an action.
2. Each option shows "Pick this" while the game status is `open` or `upcoming`. When the status is
   `open` and a point is picked, the block footer shows "Decide on <picked label>" with the line
   "Picking marks your choice. Deciding saves it as your plan's assumption."
3. A click calls `POST /api/threads/:id/messages/:messageId/blocks/:blockId/act` with `{ action:
   'pick' | 'decide', option? }`. The server loads the stored block, rebuilds the tool arguments
   from the stored snapshot (never from the request beyond the option index), and calls the
   registry write with the signed-in actor and the conversation key:
   `act_on_recommendation {operation: 'pick_point', name, point: <option id>}` or
   `act_on_recommendation {operation: 'decide', decisionId, point: <picked id>}`. A game that is no
   longer pickable or a decision no longer open returns the tool's refusal as a 409 with its text.
4. On success the server appends a Fathom message with fixed text ("You picked <label>." or "You
   decided on <label>. Your plan uses it from the next planning run."), the label from the
   snapshot and escaped, and `provenance.actions: [receipt]`, so the existing receipt line and Undo
   button render. No model call is made.
5. The block's picked state is read live from the scenario's war-game picks, not the snapshot, so
   Undo of a pick (receipt kind `setting`, C9) and Undo of a decide (revisit, C9) show at once.
6. Typed requests ("pick the middle salary point", "revisit my salary decision") go through the
   model as ordinary chat writes under rule 9 of `docs/ask-tools.md`.
7. Parity: the new act route maps to `act_on_recommendation.pick_point` and `decide` in the
   section 6 route map.

### What is removed, and where the Decide list goes (B5)

1. Routes: `wargame` leaves `ROUTES`, `PARAM_KEY` and the parse in `web/core/core.js`, the
   allowlist in `web/auth/return-path.js`, and the label in `web/horizon/screens/ask-context.js`.
   An old `#/wargame` link falls to the default route as any unknown route does; no alias.
2. Ask sub-tab: `SUBNAV.ask` becomes Conversations and Packs.
3. Screens: `pWargame`, `pDecide`, `salaryChart`, `deferralView`, `pick`, the `data-wg` and
   `data-decide` handlers and the war-game CSS (`.h-sc*`, `.h-def*`, `.h-bars*`, `.h-wg*`,
   `.h-decide-bar`) leave `web/horizon/design.js` and `design.css`. `api.pickWargame` leaves core.js.
4. Plan card link: the rec dialog's "War-game this" link becomes "Ask about this tradeoff", which
   opens the Ask panel with the war-game starter question and the rec as a context chip (B4 adds
   the button beside the link; B5 removes the link).
5. Decide list: the Plan screen gets a "Decisions" section above the rec groups with the same rows
   and groups Decide had (Open, Not built yet, Coming up, Decided collapsed, No longer current
   collapsed). A war-game decision's button is "Ask", opening the panel with its starter; a rec
   decision's button opens the rec; a decided war-game decision keeps Revisit
   (`POST /api/decisions/:id/revisit`). The switcher's Decide entry and decision rows go to
   `#/plan`.
6. API: `POST /api/wargame/:name/pick` is removed (the page was its only caller; agents use
   `act_on_recommendation.pick_point`, the UI uses the block act route). The C9 test that compares
   `pick_point` with the route compares it with `pickWargame` in `src/decisions/write.mjs` instead,
   and the route map row in `docs/ask-tools.md` section 6 goes. `/api/decisions/:id/decide` and
   `/revisit` stay.
7. The packs "What if" (`POST /api/packs/:id/whatif`, the Packs page) is a different feature and
   stays.

## 8. Evals

Deterministic (tier 1, CI):

1. `test/blocks-validate.test.mjs`: one fixture per reason code in section 4 over real demo-store
   tool results, plus valid fixtures for each block type.
2. `evals/graders.mjs` `gradeBlocks` (B1): for every block in an answer, each `calls` entry
   deep-equals a call in the transcript; every snapshot figure equals (value and unit) the figure
   at the same path in that call's transcript result; the stored `spec` has no number-typed leaf
   outside Ref args and no digit in `title`; the answer's dropped count is zero for cases that list
   `blocks`. Violations are kinds `block_unreferenced`, `block_value_mismatch`, `block_literal`,
   `block_dropped`.
3. New cases in `evals/catalog.json`, each with a script in `evals/scripts/`:

| Case id | Question | Required calls | Ticket |
|---|---|---|---|
| `block-spending-by-month` | Show our monthly spending this year as a chart. | `spending.total {groupBy: 'month'}`, `show.chart` over its `groups` | B1 |
| `block-top-merchants` | Who are our ten biggest merchants this year? Put them in a table. | `spending.total {groupBy: 'merchant', limit: 10}`, `show.table` | B1 |
| `block-recurring` | List our subscriptions with what they cost a year. | `spending.recurring {}`, `show.table` | B1 |
| `block-dropped-not-in-answer` | Chart our net worth. (scripted `show` with a source the answer never called) | `show` returns `dropped` `not_in_answer`; the answer mentions no chart | B1 |
| `block-compare-returns` | Compare when we reach the target at 3 and 4 percent returns. | two `retirement.target`, `show.compare` with two `options` | B1 (expected-fail until C6) |
| `wargame-salary` | the `wargame-salary` starter | `recommendations.wargame {name: 'salary'}`, `show.chart {kind: 'scatter'}`, `show.compare` | B4 |
| `wargame-deferral` | the `wargame-deferral` starter | `recommendations.wargame {name: 'deferral'}`, `show.compare` | B4 |
| `wargame-pick-typed` | Pick the second deferral option. (follow-up) | `recommendations.wargame`, `act_on_recommendation.pick_point {name: 'deferral', point: <second option id>}` | B4 |

Live (tier 2, coordinator-run, not a gate): the same cases with a live model, graded by the same
graders, plus a report of how many answers used `show` where the case lists `blocks` and how many
blocks were dropped by reason.

End to end (Playwright, demo build, fake engine): B2 (`e2e/ask-blocks.spec.mjs`: blocks in the
panel and on the page, light and dark, 390 px phone, keyboard on chart and table), B3 (drill and
stale), B4 (`e2e/ask-wargame.spec.mjs`: starter to compare to pick to Undo to decide), B5 (updated
decide and nav specs).

## 9. Tickets

Every ticket targets `main`, is one agent run, follows `AGENTS.md` (focused local tests on a
private Playwright port, CI for the full suite, a cross-provider review) and the standing acceptance
of `docs/ask-tools.md` section 7 where it applies (real demo stores, figures recomputed in tests,
never hard-coded amounts). Small and Big are the repository's review tiers.

| Ticket | Tier | Blocked by | Size (production, test lines) |
|---|---|---|---|
| B1 Block contract: `show`, validation, snapshot, storage | Big (new subsystem) | C2 (PR #105), C3 (PR #106), C4 (PR #104) | about 650, 700 |
| B2 Block renderer: chart, table, compare in Ask | Big | B1 | about 900, 450 |
| B3 Drill-down and staleness | Small | B2 | about 300, 300 |
| B4 War games in Ask | Big | B2, C9 | about 550, 550 |
| B5 Retire the What-if page; Decide list to Plan | Small | B4 | about 150 added, 500 removed; 300 test |
| B6 Timeline block | Small | B2 | about 200, 200 |

Waves: B1 when C2, C3 and C4 merge; B2; then B3, B6 and (once C9 merges) B4 in parallel; then B5.

### B1 Block contract: `show`, validation, snapshot, storage

Problem: Ask answers are paragraphs only; a trend or a ranking has no way to be drawn, and nothing
lets the model ask for a drawing without stating numbers.

Base: `main`. Blocked by: C2, C3, C4 merged.

Decisions: sections 1, 3, 4 and 5 of this plan, as written. `show` is Ask-only. Blocks are built
from `ctx.turnResults()`, not re-run. Storage in `provenance.blocks`, no migration. B1 owns the
answerer change; no later B ticket edits `src/api/answerer.mjs`.

Files: `src/tools/tools.mjs` (header, `askOnly`), `src/tools/index.mjs` (`askOnly` listing and
Ask-only rule text), `src/tools/catalog/show.mjs` (new), `src/blocks/validate.mjs`,
`snapshot.mjs`, `labels.mjs` (new), `src/engine/tools.mjs` (`ctx.turnResults`), `src/mcp/server.mjs`
and `src/mcp/keys.mjs` (skip `askOnly`), `src/api/answerer.mjs` (shared collector, markers,
`provenance.blocks`, `blockNotes`, `b` token kind), `src/shared/answer-text.mjs` (marker
placeholder in `streamHtml`), `src/api/fake-answers.mjs` (a scripted `show` path), `evals/graders.mjs`
(`gradeBlocks`), `evals/catalog.json` (B1 cases only), `evals/scripts/` (B1 scripts),
`docs/ask-tools.md` (catalog row for `show`), `docs/architecture.md` (Ask answer shape),
`test/blocks-validate.test.mjs`, `test/blocks-snapshot.test.mjs`, `test/blocks-answer.test.mjs`
(new).

Done when:

1. Each reason code in section 4 is returned for its fixture and the block is not stored; each
   block type has a valid fixture whose snapshot figures equal the figures at the same paths in
   the source results. Verified by `test/blocks-validate.test.mjs` and
   `test/blocks-snapshot.test.mjs`. Runs in: worker.
2. An Ask answer with the fake engine that calls `spending.total {groupBy: 'month'}`, then
   `show.chart`, then writes text with `{b:b1}` on its own line stores one block with `after` equal
   to the paragraphs before the marker, renders no marker text, grounds without counting the
   marker, and stores `blockNotes` for a second, invalid `show` call. A block in a regenerated
   answer may reference a first-attempt call. Verified by `test/blocks-answer.test.mjs` and
   `test/answerer.test.mjs`. Runs in: worker.
3. `show` is absent from MCP `tools/list` for a key with every scope, a direct MCP call to it is
   refused as unknown, and the MCP `instructions` hold none of its rules. Verified by
   `src/mcp/test/server.test.mjs`. Runs in: worker.
4. The budget test measures the Ask-offered list (including `show`) under 30,000 characters and the
   Ask rule text under 8,000, printing both. Verified by `test/tools-registry.test.mjs`. Runs in:
   worker.
5. `gradeBlocks` reports each violation kind on a fixture, and `npm run eval:ask` passes with the
   four runnable B1 cases as required passes and `block-compare-returns` as an expected failure
   naming its missing pairs. Verified by `test/ask-evals-runner.test.mjs` and `npm run eval:ask`.
   Runs in: worker and PR CI.

Out of scope: rendering (B2); any change to existing eval case entries.

Test command: `node --test test/blocks-validate.test.mjs test/blocks-snapshot.test.mjs test/blocks-answer.test.mjs test/answerer.test.mjs test/tools-registry.test.mjs test/ask-evals-runner.test.mjs src/mcp/test/server.test.mjs && npm run eval:ask`

### B2 Block renderer: chart, table, compare in Ask

Problem: stored blocks (B1) have no client renderer.

Base: `main`. Blocked by: B1 merged.

Decisions: section 2 as written; one renderer module shared by the page, panel and rec dialog;
`niceTicks` moves from design.js into the renderer and design.js imports it until B5 removes its
last caller.

Files: `web/horizon/screens/ask-blocks.js` (new), `web/horizon/screens/chat.js` (call the renderer
after paragraph `after`, register figures, render `blockNotes`), `web/horizon/screens/ask.css`
(block styles, series ramp), `web/core/core.js` (`api.registerFigures`), `web/horizon/design.js`
(import `niceTicks`), `test/ask-blocks.test.mjs` (new, pure render functions over B1 snapshots),
`test/block-palette.test.mjs` (new), `e2e/ask-blocks.spec.mjs` (new).

Done when:

1. Each chart kind, a table and a compare render from B1 snapshot fixtures with every data value
   as a `.fx-fig` registered under `blk:` keys, labels from data only, and no model text other than
   the escaped title. Verified by `test/ask-blocks.test.mjs`. Runs in: worker.
2. Table sort by each column type and the filter work on the snapshot rows, with `aria-sort`
   updated. Verified by `test/ask-blocks.test.mjs`. Runs in: worker.
3. Every series ramp color meets 3:1 against the panel background in light and dark. Verified by
   `test/block-palette.test.mjs`. Runs in: worker.
4. On the demo build with the fake engine, a scripted answer shows a chart, a table and a compare
   in the docked panel and on the Ask page, at 1280 px and 390 px, in light and dark; the page has
   no horizontal scroll at 390 px; the chart's Table toggle, arrow keys, the live region and the
   popover on Enter work; the popover shows the figure's source and as-of date. Verified by
   `e2e/ask-blocks.spec.mjs`. Runs in: PR CI (local run on a private port for this spec only).

Out of scope: drill and stale states (B3); war-game actions (B4).

Test command: `node --test test/ask-blocks.test.mjs test/block-palette.test.mjs test/ask-convo.test.mjs`, then `npx playwright test e2e/ask-blocks.spec.mjs` on a private port.

### B3 Drill-down and staleness

Problem: a table figure cannot show the rows behind it, and a reopened answer cannot tell the owner
its data changed.

Base: `main`. Blocked by: B2 merged.

Decisions: sections 5 (items 4 and 5) and 6 as written.

Files: `src/blocks/drill.mjs` (new), `src/blocks/snapshot.mjs` (store `drill`),
`src/api/ask-blocks.mjs` (new: `GET /api/threads/:id/blocks`), `src/api/router.mjs`,
`docs/ask-tools.md` (route map: the status route is excluded as conversation chrome),
`web/horizon/screens/ask-blocks.js`, `web/core/core.js` (`api.blockStatus`),
`test/blocks-drill.test.mjs`, `test/blocks-stale.test.mjs` (new), `e2e/ask-blocks.spec.mjs`.

Done when:

1. For each drill mapping in section 6 on the demo store, the drill route's `sum` equals the
   block figure to the cent; `drillQuery` returns null for a definition, a merchant group and a
   class group. Verified by `test/blocks-drill.test.mjs`. Runs in: worker.
2. The status route returns `current` for an unchanged store, `stale` with the changed count after
   a test inserts a transaction in the window, and `unavailable` after the source call starts to
   error; it writes nothing (row counts and the stored message unchanged). Verified by
   `test/blocks-stale.test.mjs`. Runs in: worker.
3. In the browser, Show rows expands the rows with focus on the region heading and Escape returns
   focus; a stale block shows the badge and Ask again sends the question. Verified by
   `e2e/ask-blocks.spec.mjs`. Runs in: PR CI.

Test command: `node --test test/blocks-drill.test.mjs test/blocks-stale.test.mjs test/ask-blocks.test.mjs test/tools-parity.test.mjs`

### B4 War games in Ask

Problem: the war games live on a page the owner is retiring; Ask cannot read them or pick a point.

Base: `main`. Blocked by: B2 and C9 merged.

Decisions: section 7 "The read", "The suggested questions" and "Pick and decide as Ask writes", as
written. Point ids, not indexes, cross the tool boundary.

Files: `src/tools/catalog/wargame.mjs` (new), `src/blocks/actions.mjs` (new),
`src/blocks/snapshot.mjs` (attach the action), `src/api/ask-blocks.mjs` (act route),
`src/api/router.mjs`, `src/scenario/build.mjs` (starters), `src/api/fake-answers.mjs` (both
starters), `web/horizon/screens/ask-blocks.js` (Pick this, Decide footer, live picked state),
`web/core/core.js` (`api.blockAct`), `web/horizon/design.js` (rec dialog "Ask about this tradeoff"
button), `docs/ask-tools.md` (catalog and route map), `evals/catalog.json` and `evals/scripts/` (B4
cases), `test/tools-wargame.test.mjs`, `test/blocks-act.test.mjs` (new),
`e2e/ask-wargame.spec.mjs` (new).

Done when:

1. `recommendations.wargame` returns, for each game on the demo store, every point or option with
   figures equal to the stored `wg.*` figures, status and decision equal to the scenario's, and
   refs that pass `assertRefsResolve`; a store with no S corp returns `not_built` with the
   `notBuiltReason` text. Verified by `test/tools-wargame.test.mjs`. Runs in: worker.
2. The starters appear first only when their game is open or upcoming. Verified by
   `test/scenario.test.mjs`. Runs in: worker.
3. The act route with `pick` writes the same `wargame.picks` setting as `pickWargame`, stores a
   receipt whose Undo restores the prior picks, and appends one Fathom message with that receipt;
   with `decide` it matches `act_on_recommendation.decide`, and Undo revisits; a request option out
   of range is 400, an unavailable game 409, and the server never reads a point id from the request.
   Verified by `test/blocks-act.test.mjs`. Runs in: worker.
4. On the demo build with the fake engine, the salary starter shows a scatter and a compare; Pick
   this then Undo then Pick this then Decide on this leaves the decision decided with the picked
   point, and the rec dialog's Ask about this tradeoff opens the panel with the starter. Verified by
   `e2e/ask-wargame.spec.mjs`. Runs in: PR CI.
5. `npm run eval:ask` passes with the three B4 cases as required passes. Verified by `npm run
   eval:ask`. Runs in: worker and PR CI.

Out of scope: removing the What-if page (B5).

Test command: `node --test test/tools-wargame.test.mjs test/blocks-act.test.mjs test/scenario.test.mjs test/tools-registry.test.mjs test/tools-parity.test.mjs && npm run eval:ask`

### B5 Retire the What-if page; Decide list to Plan

Problem: once B4 ships, the What-if page duplicates Ask and the owner wants it gone; its Decide
list still needs a home.

Base: `main`. Blocked by: B4 merged.

Decisions: section 7 "What is removed" as written; no route alias.

Files: `web/horizon/design.js`, `web/horizon/design.css`, `web/horizon/screens/switcher.js`,
`web/horizon/screens/ask-context.js`, `web/core/core.js`, `web/auth/return-path.js`,
`src/api/router.mjs` and `src/api/handlers.mjs` (remove the pick route and `wargamePick`),
`test/tools-rec-writes.test.mjs` (created by C9; compare with `pickWargame`),
`test/wargame-retired.test.mjs` (new), `docs/ask-tools.md` (route map),
the e2e specs that name the page (`decide`, `decide-not-built`, `nav`, `routes`, `mobile`, `keys`,
`alignment`, `january`, `planner-mg`, `planner-real`, `real-polish`, `helpers`), and the unit tests
that name the route (`test/api.test.mjs`, `test/ask-context.test.mjs`, `test/tour.test.mjs`).

Done when:

1. No tracked file under `web/` or `src/api/` names the `wargame` route, `pWargame`, `pDecide`,
   `salaryChart`, `deferralView` or `/api/wargame/`. Verified by `test/wargame-retired.test.mjs`
   (new), which reads `git ls-files`. Runs in: worker.
2. The Plan screen shows the Decisions section with the same rows Decide showed on the demo store
   (open, not built, coming up, decided, no longer current), each button going where section 7
   says; Revisit still works. Verified by `e2e/decide.spec.mjs` and `e2e/decide-not-built.spec.mjs`
   (rewritten against Plan). Runs in: PR CI.
3. The Ask sub-nav lists Conversations and Packs only, and `#/wargame` lands on the default route.
   Verified by `e2e/nav.spec.mjs` and `e2e/routes.spec.mjs`. Runs in: PR CI.
4. `act_on_recommendation.pick_point` still matches `pickWargame` and undoes. Verified by
   `test/tools-rec-writes.test.mjs`. Runs in: worker.

Test command: `node --test test/api.test.mjs test/ask-context.test.mjs test/tour.test.mjs test/tools-rec-writes.test.mjs test/tools-parity.test.mjs test/wargame-retired.test.mjs`

### B6 Timeline block

Problem: dated results (access ages, obligation changes, deadlines) read better as a timeline.

Base: `main`. Blocked by: B2 merged.

Decisions: section 1 `timeline` row and section 2 item 5, as written.

Files: `src/tools/catalog/show.mjs` (`timeline`), `src/blocks/validate.mjs`, `snapshot.mjs`,
`web/horizon/screens/ask-blocks.js`, `test/blocks-validate.test.mjs`, `test/ask-blocks.test.mjs`.

Done when:

1. `show.timeline` over `household.deadlines` on the demo store validates and its events equal the
   deadlines in date order; a `date` path to a money figure is `mixed_units`. Verified by
   `test/blocks-validate.test.mjs`. Runs in: worker.
2. The timeline renders as a list with dates, labels and value figures, keyboard reachable.
   Verified by `test/ask-blocks.test.mjs`. Runs in: worker.

Test command: `node --test test/blocks-validate.test.mjs test/ask-blocks.test.mjs test/tools-registry.test.mjs`

### Readiness

Probed 2026-11-07 on `main` at `6306899`:

1. Can start: no for every ticket today, by design. B1 waits on PRs #104, #105 and #106 (open);
   B4 on C9 (not opened); the rest on earlier B tickets. Base health at `6306899`: actionlint,
   gitleaks, hadolint, npm-audit, publish and unit succeeded; e2e was in progress; build skipped.
   The coordinator reruns both probes before each dispatch.
2. Collisions found and resolved: PR #105 edits `src/api/answerer.mjs`, `src/tools/tools.mjs` and
   `test/answerer.test.mjs`, and PR #106 edits `test/answerer.test.mjs`; B1 is blocked by both, so
   it starts on their merged result. PR #106 exports `resolveRef`, `isFigure` and `MAX_REF_DEPTH`
   from `src/tools/refs.mjs`; B1 uses `isFigure` and walks list paths itself.
3. Can finish: yes for each ticket. Every Done when item names a unit test, `npm run eval:ask` or a
   Playwright spec that the worker or PR CI runs on the demo build with no secrets, no network and
   no live model. No item needs a person.
4. Riskiest step: B1 item 2, a regenerated answer's block referencing a first-attempt call. It
   depends on the answerer sharing one collector across two engine calls; `createRegistryServer`
   keeps a per-server `results` list today (`src/engine/tools.mjs`), so B1 passes a shared list in
   rather than relying on that one.
5. Open question carried to the coordinator: whether the owner accepts the Decide list on the Plan
   screen (risk 7). B5 is not dispatched until that is answered.

## Assumptions and deferred scope

Assumptions:

1. The salary scatter's axes stay pre-tax retirement room (x) and tax change (y), as the page drew
   them from the planner's `xLabel` and `yLabel`.
2. Picking stays a separate step from deciding, as on the page, because C9 owns both operations and
   the decide semantics (decided fact, replan) are unchanged.

Deferred:

1. A live war-game re-run tool with owner-changed inputs (needs the planner context per call).
2. Paging messages in long threads (risk 6).
3. Export of a block as CSV or image.
4. Blocks in the morning brief or email.
