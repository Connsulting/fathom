# Plan: goal model v2 (whose goal, priority, kinds, done)

Repo worktree: `<worktree>`, branch
`feat/goal-model-v2`, base `origin/main` (HEAD 7e82520). Build tier. Read `AGENTS.md` first.

## Risks and external dependencies (read first)

1. Migration number. `026-goal-kinds.sql` leaves a gap at 024 (held by another branch). Nothing in
   code enforces contiguity (`listMigrations` sorts, `migrate` skips applied ids), but
   docs/architecture.md says "no gaps". If the 024 branch merges after this one it keeps 024 and
   applies on existing stores in id order after 026 is already recorded, which `migrate` handles
   (it applies any unapplied id). If 024 is abandoned, a later migration should take 024 or the doc
   rule should be relaxed. AGENTS rule 7 governs renumbering.
2. T23 in docs/ask-tools.md moves archive and delete into `src/goals/write.mjs` and says it is the
   only ticket editing `src/api/goals.mjs`. This branch edits `src/goals/write.mjs`, and only the
   header comment of `src/api/goals.mjs`. Whoever merges second rebases. T23's `goal_row` undo
   ("reinserts every column") must include the new `done_at` column; S1 notes this in the spec.
3. `goal.kind` versus rec "goal kinds". `recs.goal_kinds` / `rec.goalKinds` already means goal
   topics (cash, retirement, ...). The brief names the new field `kind`, so `goal.kind` is the goal
   model kind (balance, range, floor, contribution). Every new comment that mentions either says
   which. A legacy def `kind` holding a topic (only test fixtures write one, for example
   `e2e/question-recs.spec.mjs`) moves to `goal.topic` at read time and keeps linking.
4. Demo freshness. The demo clock is 2026-11-05 and its balances end 2026-08-30, so every
   balance-tracked demo goal (including the new range and floor) is `unknown` / `stale_data`. The
   floor still reports its state from the last reading; the contribution example uses an entered
   amount dated 2026-10-31 so one new kind shows a live status (ahead).
5. Interpretation of "Plan". The Plan tab lists recommendations, not goals. Goals are listed on the
   Goals screen (`#/goals`, in the Home tab, "Where you are headed"). This plan reads "Plan
   ordering" as: the Goals screen orders each horizon column by priority (done goals last), and Plan
   rows order a rec's "Serves:" goals by priority. Recorded as an assumption for the PR.
6. Contributions dated after Dec 31 for the prior tax year (an IRA or HSA contribution made before
   Apr 15) are not counted from transactions, because the brief defines qualifying transactions as
   dated within the tax year. The person enters them. Listed as a known limit in the docs.

No external services, secrets or network are involved. Everything runs on demo data.

## Approach

1. Store: migration 026 adds `goals.done_at TEXT` only. Status is derived: `archived` when
   `archived_at`, else `done` when `done_at`, else `open`. All other new fields live in the def JSON
   and are validated by `validateGoal`; reads default `kind` to `balance`, `owner` and `priority` to
   null. No row is rewritten.
2. Model (`src/shared/goals.mjs`, shared with the browser): kinds, kind fields, owner ids,
   priorities, statuses, label helpers, kind-aware validation (including partial edits against the
   stored def), topics that ignore the model kinds.
3. Writes (`src/goals/write.mjs`): create and edit store only the kind's fields, capture a pace path
   only for balance and range, and map `status` to the `done_at` / `archived_at` columns. Seed goals
   stay non-editable (409), status included.
4. Reads (`loadGoals`): derived `kind`, `owner`, `priority`, `status` (owner goals), `doneAt`,
   legacy `topic`, and owner-goal figures for the new money fields (`goal.<id>.low` and so on).
5. Pace (`src/calc/pace.mjs` pure, `src/pace/build.mjs` store reads): `rangePace`, `floorPace`,
   `contributionPace` beside `goalPace`; `buildPace` dispatches by kind, skips done goals, and tags
   each entry with `kind`, `owner`, `priority`. `paceRollup` is unchanged (floor holding counts as
   on pace, breached as behind).
6. Tools: `create_goal` / `edit_goal` schemas and evidence checks cover the new fields;
   `list_goals` and `household_summary` (both `goalsForModel`) carry them; `get_pace` returns the
   new `buildPace` shape unchanged otherwise.
7. Demo: three seed-origin goals (range, floor, contribution) inserted by `demo/seed.mjs` after the
   ledger; existing seed goals with targets are the balance examples. `demo/scenario.mjs` and the
   mock are untouched (the mock's `example.js` is generated from a private file by
   `mock-v2/tools/synthesize.mjs`, so it must not be hand-edited, and `test/seed.test.mjs` requires
   scenario.mjs to equal it).
8. UI (Horizon): goal form gets a kind select with per-kind fields, a whose-goal select, a priority
   select and Mark done; Home cards and Goals cards show owner, priority, range position, floor
   state and contribution progress; Home and Goals order by priority.

Estimated production lines: S1 about 400, S2 about 190, S3 about 330; total about 920. Tests about
750 lines.

## Pinned decisions

Driver decisions kept unless noted.

1. Migration `src/store/migrations/026-goal-kinds.sql`, additive, `ALTER TABLE goals ADD COLUMN
   done_at TEXT`. Kept.
2. Owner value set. Changed from the driver's example (`you`) to the ids the spec and the store
   already use for people: `owner`, `spouse`, `joint`, and a dependent key matching `/^kid\d{0,2}$/`
   (`kid`, `kid2`, ...). Reasons: docs/ask-tools.md uses `person: 'owner'` (independence_target
   `byAge`) and `set_account_owner` takes `'owner'|'spouse'|'joint'|'business'` (`OWNER_OPTIONS` in
   `src/ingest/confirm.mjs`); `ownerOf(accounts.owner)` in `src/jobs/planner/data.mjs` returns the
   same ids, so contribution attribution by account holder is a direct comparison. Labels resolve
   from the scenario `names` (content written from the `household.names` fact by the planner,
   `namesOf` in `src/jobs/planner/brief.mjs`, keys `me`, `spouse`, `kid`, ...), with the neutral
   fallbacks You, Your spouse, Joint, Your child. No name is hard-coded. Code comments state that
   `goal.owner` (whose goal) is distinct from `origin: 'owner'` (typed by the owner).
3. Priority: `high`, `medium`, `low` or null. Home and Goals order high, medium, low, unset, stable
   on the existing order. Kept.
4. Kind fields, flat in the def, reusing existing names where the meaning matches:
   1. balance: `target`, `targetDate`, `track` (unchanged).
   2. range: `targetLow`, `targetHigh` (both required, low not above high), `targetDate`, `track`.
   3. floor: `floor` (required), `track` (required), no `targetDate`.
   4. contribution: `target` is the amount (required, above zero), `taxYear` (integer 2000 to 2100,
      required), `targetDate` is the deadline (required, on or after Jan 1 of the tax year),
      `accounts` (destination account ids, optional), `split` (optional `[{person, amount}]`,
      persons `owner`/`spouse`, unique, amounts add up to `target` to the cent), `entered`
      (optional `{asOf, total}` or `{asOf, people: [{person, amount}]}`, exactly one of total or
      people; with a split, entered persons must be split persons).
   Changed from the driver: `amount` and `deadline` are not new names. Reusing `target` and
   `targetDate` keeps the existing target figure, the evidence check, the Goals "By" date and
   suggestion exclusion working without a second path. The UI labels them "Amount to contribute"
   and "Deadline".
5. Status is set through the edit body (`status: 'open'|'done'|'archived'`), not a new route.
   `validateGoal` accepts it (AC1), `edit_goal` takes it (AC4), the editor's Mark done posts it.
   `POST /api/goals/:id/archive` stays. Done goals are excluded from pace, linking, suggestions and
   Home, and stay listed on Goals as done.
6. Seed goals: `status` stays their display text (`on track`, `done`, `watch`, `open`); a seed row
   with `done_at` reads `done`. Owner goals get the derived status. `openGoal` is unchanged and
   works for both because both use `'done'` for done and `archived` for archived.
7. Qualifying contribution transactions: `amount > 0`, `account_id` in the goal's `accounts`,
   `date` from `<taxYear>-01-01` to `<taxYear>-12-31` and on or before the clock. Transaction basis
   applies when at least one destination account has any transaction dated on or before the clock;
   otherwise the entered amount (provenance `you`); otherwise unknown with
   `missing_contributions`. Interest, dividends and transfers into the account count as
   contributions (known limit, documented).
8. Contribution pace: a linear plan from 0 on Jan 1 of the tax year to `target` at `targetDate`
   (the existing `goalPace` path and tolerance), plus: at or above target is `ahead` with time gap
   `Reached`; past the deadline and below target is `behind` with time gap `Deadline passed`.
9. Per-person contribution progress, without inventing attribution: transaction basis gives a
   person's sum only when every destination account's holder (`ownerOf(account.owner)`) is
   `owner` or `spouse`; entered basis gives a person's amount only from `entered.people`; otherwise
   per-person actuals are null and only the total shows.
10. Floor: holding at or above the floor, breached below. Status `on pace` (holding) or `behind`
    (breached) when the data is current; stale or missing data keeps `unknown` but still reports
    `floor.state` from the last reading. Home shows a breach as a warn chip "Below floor" even when
    stale, and a current breach also raises the health chip ("1 goal behind").
11. Range: `goalPace` against `targetLow`, plus `range: {low, high, position}` with position
    `below`, `in` or `above` from the tracked value. Above the high end is informational (chip
    "Above range", tone ok), not attention.
12. Series: balance unchanged; range uses `monthlyPace` with `target = targetLow`; floor and
    contribution get `{series: null, reason: 'kind_not_charted', dataEnd: null}`.
13. Demo examples are seed origin ("came with the demo, cannot be edited"), so
    `test/goals.test.mjs` "every goal is seed after reset" still holds and they get no
    suggestions. Their titles and prose carry no dollar amounts (provenance spec) and avoid the word
    "tax" (it would link tax-only recs and change housekeeping counts).

## Interface (all streams code against this)

### `src/shared/goals.mjs` new exports (S1)

```js
export const GOAL_KINDS = Object.freeze(['balance', 'range', 'floor', 'contribution']);
export const KIND_LABEL = Object.freeze({ balance: 'Reach a balance', range: 'Stay in a range', floor: 'Keep a floor', contribution: 'Make a contribution' });
// The def fields each kind keeps; a field listed for another kind is dropped on a kind change and refused in a body.
export const KIND_FIELDS = Object.freeze({
  balance: Object.freeze(['target', 'targetDate', 'track']),
  range: Object.freeze(['targetLow', 'targetHigh', 'targetDate', 'track']),
  floor: Object.freeze(['floor', 'track']),
  contribution: Object.freeze(['target', 'taxYear', 'targetDate', 'accounts', 'split', 'entered']),
});
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const PRIORITY_LABEL = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low' });
export const priorityRank = p => (PRIORITIES.includes(p) ? PRIORITIES.indexOf(p) : PRIORITIES.length);
export const GOAL_STATUSES = Object.freeze(['open', 'done', 'archived']);
// People who can contribute (split, entered): the ids accounts.owner and the spec use.
export const PERSONS = Object.freeze(['owner', 'spouse']);
export const isDependentKey = v => typeof v === 'string' && /^kid\d{0,2}$/.test(v);
export const isGoalOwner = v => v === 'owner' || v === 'spouse' || v === 'joint' || isDependentKey(v);
export const kindOf = def => (def && GOAL_KINDS.includes(def.kind) ? def.kind : 'balance');
export const goalStatusOf = row => (row?.archived_at ? 'archived' : row?.done_at ? 'done' : 'open');
// Label for a person or goal owner id from scenario names ({me, spouse, kid, ...}); neutral fallbacks.
export function personLabel(id, names = {}) { /* owner -> names.me || 'You'; spouse -> names.spouse || 'Your spouse'; joint -> 'Joint'; kid* -> names[id] || 'Your child'; else '' */ }
// Whose-goal options for the editor: owner, spouse, joint, then each kid key present in names (sorted), else 'kid'.
export function goalOwnerOptions(names = {}) { /* -> [{ id, label }] */ }
```

`LIMITS` gains `people: 2`, `taxYearMin: 2000`, `taxYearMax: 2100`. `validateGoal` gains an option
`previous` (the stored def, for partial edits).

### Stored def (owner goal, after this change)

`{id, title, note, horizon, kind, owner, priority, ...KIND_FIELDS[kind], pace}`. `pace` is the
captured path for balance and range, null for floor and contribution. Status is never in the def.

### `loadGoals` goal (S1)

Every goal: `{...def, id, origin, archived, kind, owner, priority, doneAt, topic?}`; owner goals
also `status` (`goalStatusOf(row)`); a seed row with `done_at` gets `status: 'done'`. Owner goal
figures added to `fig` (all `src: 'goal-target'`):

| key | when | kind | label |
| --- | --- | --- | --- |
| `goal.<id>.low` | range, finite `targetLow` | t | Range low end |
| `goal.<id>.high` | range, finite `targetHigh` | t | Range high end |
| `goal.<id>.floor` | floor, finite `floor` | t | Floor |
| `goal.<id>.split.<person>` | contribution split entry | t | Share of the contribution |
| `goal.<id>.entered` | contribution entered total (sum of people when people) | a | Contributed so far, as you entered |
| `goal.<id>.entered.<person>` | contribution entered people entry | a | Contributed so far, as you entered |

Range progress: `g.progress = {cur, target: 'goal.<id>.low'}` when tracked and low above zero.
Contribution: `g.accountsLabel` is the destination account labels joined by ", ".

### Pace entry (S2), added fields

Every entry: `kind`, `owner`, `priority` (null when unset). Per kind:
1. range: `goalPace` result on the low bound plus `range: {low: Figure, high: Figure, position:
   'below'|'in'|'above'|null}`.
2. floor: `{id, title, targetDate: null, status, reason, dataThrough, stale, target: Figure (the
   floor, label 'Floor', kind t), actual, expected: null, gap (actual minus floor), gapDays: null,
   tolerance: null, timeGap ('Holding'|'Below floor'|null), floor: {state: 'holding'|'breached'|null}}`.
3. contribution: `goalPace` result on the planned path plus `contribution: {basis:
   'transactions'|'entered'|null, taxYear, deadline, remaining: Figure|null, people: [{person,
   target: Figure|null, actual: Figure|null}]}`; `actual` is the progress figure. Reason
   `missing_contributions` replaces `missing_actual` when there is no progress source.
New reason codes: `missing_contributions`, `kind_not_charted`. Every figure is a `paceFigure`
(`src: 'calc:pace'`) whose `locator.sources` lists rows: transactions ids for transaction basis,
`{rows: {table: 'goals', ids: [id], count: 1}, field: 'entered', src: 'you'}` for entered, plus the
goal row and, for the transaction basis, `{rows: {table: 'accounts', ids, count}}`.

### `web/horizon/screens/home-model.js` new exports (S3)

`PRIORITY_RANK`, `priorityRankOf(p)`, `orderGoals(goals)`, `orderServes(serves, goals)`,
`kindLine(p, i)`; `homeModel` cards gain `kind`, `owner`, `priority`, `line`. home-model.js keeps
no imports (node imports it), so it holds its own `PRIORITY_RANK`, checked against `PRIORITIES` by a
test.

## Owned streams

Merge order S1, S2, S3. S2 and S3 code against the Interface above and may start in parallel;
assertions that cross streams (get_pace fields in `test/goal-kinds-api.test.mjs`, demo cards in
`test/goal-kinds-home.test.mjs`) pass once the earlier stream is merged into the branch. Demo data
(the driver's S4) is merged into S1 because its test lives in S1's `test/goal-kinds.test.mjs` and its
defs must pass S1's validation.

### S1 model, migration, writes, API, tools, demo, docs

Files: `src/store/migrations/026-goal-kinds.sql` (new), `src/shared/goals.mjs`,
`src/goals/write.mjs`, `src/api/goals.mjs` (header comment), `src/scenario/build.mjs` (loadGoals
only), `src/actions/index.mjs`, `src/tools/actions.mjs`, `src/tools/index.mjs`,
`src/suggest/build.mjs`, `demo/seed.mjs`, `docs/architecture.md`, `docs/ask-tools.md`,
`test/tools.test.mjs` (behavior site), tests `test/goal-kinds.test.mjs`,
`test/store-goal-kinds-migration.test.mjs`, `test/goal-kinds-api.test.mjs`.

Edit blocks (each quoted excerpt verified with `grep -cF`, count 1 unless stated):

1. New `src/store/migrations/026-goal-kinds.sql`:
   ```sql
   -- Goal model v2: whose goal, priority, kinds and a done state. Additive: no row is rewritten.
   -- done_at (app clock ISO time) marks a goal done. Status is derived at read time: archived when
   -- archived_at, else done when done_at, else open. Kind (balance, range, floor, contribution),
   -- owner (whose goal: owner, spouse, joint or a dependent key), priority and the kind fields live in
   -- the def JSON, validated by src/shared/goals.mjs, with read-time defaults (kind balance, owner
   -- and priority unset). See docs/architecture.md, Goals.
   ALTER TABLE goals ADD COLUMN done_at TEXT;
   ```
2. `src/shared/goals.mjs`
   1. Header (count 1): `// A goal def: {id, title, note, horizon, target, targetDate, track, kind?}. Owner goals (origin`
      Rewrite the header paragraph: def is `{id, title, note, horizon, kind, owner, priority,
      ...kind fields}`; `kind` is the goal model kind (not a topic); `owner` is whose goal, distinct
      from `origin 'owner'`; topics come from words, tracked accounts and figures, contribution
      accounts, and a legacy `topic`.
   2. After (count 1): `export const LIMITS = Object.freeze({ title: 120, note: 500, accounts: 20, target: 1e10 });`
      Extend LIMITS with `people: 2, taxYearMin: 2000, taxYearMax: 2100` and add the Interface
      exports.
   3. Signature (count 1): `export function validateGoal(fields, { accounts = [], figures = {}, partial = false } = {}) {`
      becomes `{ accounts = [], figures = {}, partial = false, previous = null } = {}`.
      Inside, factor the existing target number check into `const money = (k, { positive = false } = {}) => ...`
      (same rules and messages with `${k}` in place of `target`) and use it for `target`,
      `targetLow`, `targetHigh`, `floor`. Add, before the final return:
      1. `kind`: present must be in GOAL_KINDS (`kind must be one of balance, range, floor, contribution`); absent and not partial: `'balance'`.
      2. `owner`: null or '' gives null; else `isGoalOwner` (`owner must be owner, spouse, joint or a dependent key such as kid`); absent and not partial: null.
      3. `priority`: null or '' gives null; else in PRIORITIES; absent and not partial: null.
      4. `status`: in GOAL_STATUSES; absent and not partial: `'open'`.
      5. `taxYear`: null gives null; else integer from taxYearMin to taxYearMax.
      6. `accounts`: null or [] gives null; else unique known ids (any account in `accounts`), at most LIMITS.accounts.
      7. `split`: null or [] gives null; else array of 1 to 2 objects with exactly keys `person` (in PERSONS) and `amount` (money above zero), persons unique.
      8. `entered`: null gives null; else object with `asOf` (isIsoDate, required) and exactly one of `total` (money) or `people` (1 to 2 `{person, amount}` with amount zero or more, persons unique).
      9. Kind rules on `merged = partial ? { ...(previous || {}), ...out } : out`, with `kind = kindOf(merged)` (a legacy topic in `previous.kind` reads as balance):
         1. Any body key (in `f`) listed in some KIND_FIELDS list but not in `KIND_FIELDS[kind]`: `${k} does not apply to a ${kind} goal`.
         2. When the kind changes in a partial edit, ignore the previous def's other-kind fields (build `merged` from previous fields of the new kind only).
         3. range: `targetLow` and `targetHigh` finite (`a range needs a low end and a high end`), low not above high (`the low end must not be above the high end`).
         4. floor: `floor` finite (`a floor needs an amount`), `track` not null (`a floor needs something to track`).
         5. contribution: `target` finite and above zero (`a contribution needs an amount`), `taxYear` set (`a contribution needs a tax year`), `targetDate` set (`a contribution needs a deadline`) and not before `${taxYear}-01-01`; split amounts sum (to cents) equals target (`the split must add up to the amount`); entered persons are split persons when a split is set.
      10. Not partial: default every field of `KIND_FIELDS[kind]` absent from the body to null (balance keeps today's `target`, `targetDate`, `track` null defaults).
   4. In `goalTopics`, replace (count 1): `  if (typeof goal.kind === 'string' && TOPIC_LABEL[goal.kind]) out.add(goal.kind);`
      with two lines that add `goal.topic` and `goal.kind` when each is a TOPIC_LABEL key (the model
      kinds are not keys, so they add nothing). After (count 1) `  const tr = goal.track;` and the
      tracked-accounts loop, add the same account-kind loop over `goal.accounts` (contribution
      destinations).
   5. Comment above openGoal (count 1): `// Goals that count for linking and ranking: not archived, not a finished seed goal.`
      becomes "not archived and not done (a done owner goal or a finished seed goal)". The function
      (count 1) `export const openGoal = g => !!g && !g.archived && g.status !== 'done';` is unchanged.
3. `src/goals/write.mjs`
   1. (count 1) `function valid(db, fields, partial) {` becomes `function valid(db, fields, partial, previous = null) {`
      and (count 1) `  const result = validateGoal(fields, { partial, accounts: db.prepare('SELECT id, kind FROM accounts').all(), figures: loadFigures(db) });`
      passes `previous`.
   2. Add `const PATH_KINDS = ['balance', 'range'];` and a helper `defFor(base, kind)` that copies
      `base`, deletes `status`, and deletes every key listed in another kind's KIND_FIELDS but not
      in `KIND_FIELDS[kind]`.
   3. Replace (count 1 each) `    const def = { id, title: value.title, note: value.note || '', horizon: value.horizon, target: value.target,`
      and `      targetDate: value.targetDate, track: value.track };` with
      `const { status, ...rest } = value; const def = defFor({ id, ...rest, note: rest.note || '' }, rest.kind);`
      and replace (count 1) `    def.pace = captureGoalPath(db, def, now.slice(0, 10));` with
      `def.pace = PATH_KINDS.includes(def.kind) ? captureGoalPath(db, def, now.slice(0, 10)) : null;`
   4. Insert (count 1) `    db.prepare("INSERT INTO goals (id, def, sort, origin, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)")`
      and (count 1) `      .run(id, JSON.stringify(def), sort, now, now);` gain `archived_at, done_at`
      columns: `status === 'archived' ? now : null`, `status === 'done' ? now : null`.
   5. Keep (count 1) the seed refusal `    if (row.origin !== 'owner') throw new ToolError('conflict', 'this goal came with the demo and cannot be edited; archive it or add your own');`
      Move `const previous = parse(row.def, {});` above (count 1) `    const value = valid(db, fields, true);`
      and pass it: `valid(db, fields, true, previous)`.
   6. Replace (count 1) `    const def = { ...previous, ...value, id };` with
      `const { status, ...rest } = value; const kind = kindOf({ ...previous, ...rest }); const def = defFor({ ...previous, ...rest, id }, kind);`
      Replace (count 1) `    if (!previous.pace || goalPathChanged(previous, def)) def.pace = captureGoalPath(db, def, now.slice(0, 10));`
      with: path kinds recapture as today; other kinds set `def.pace = null`.
   7. Replace (count 1) `    db.prepare('UPDATE goals SET def = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(def), now, id);`
      with an update that also sets `archived_at` and `done_at` when `status` is present:
      open: both null; done: `done_at = row.done_at || now`, `archived_at = null`; archived:
      `archived_at = row.archived_at || now`, `done_at` kept. Absent status: columns unchanged.
4. `src/api/goals.mjs` header only (count 1 each):
   `// POST /api/goals              {title, note?, horizon?, target?, targetDate?, track?} -> {scenario, goal}`
   and `// POST /api/goals/:id          the same fields, any subset                          -> {scenario, goal}`
   Rewrite to name `kind, owner, priority, status` and "the kind fields (src/shared/goals.mjs
   KIND_FIELDS)", and that `status` done or open marks a goal done or reopens it. No code change:
   both handlers already pass the body through and map ToolError to 400/404/409.
5. `src/scenario/build.mjs` (`loadGoals` only)
   1. Comment (count 1) `// Every goal row (archived included) as {...def, id, origin, archived, progress?}. Owner goals get`
      add the derived fields and the new figures.
   2. After (count 1) `    const g = { ...def, id: r.id, origin, archived: !!r.archived_at };` add: legacy topic move
      (`if (typeof def.kind === 'string' && !GOAL_KINDS.includes(def.kind)) g.topic = def.kind;`),
      `g.kind = kindOf(def)`, `g.owner = isGoalOwner(def.owner) ? def.owner : null`,
      `g.priority = PRIORITIES.includes(def.priority) ? def.priority : null`,
      `g.doneAt = r.done_at ?? null`, then `if (origin === 'owner') g.status = goalStatusOf(r); else if (r.done_at) g.status = 'done';`
      This sits before (count 1) `    if (origin !== 'owner') return g;`
   3. Before (count 1) `    if (cur && fig[tKey] && fig[tKey].v > 0) g.progress = { cur, target: tKey };`
      add the figure table from the Interface, `g.accountsLabel`, and the range progress rule (for a
      range, progress targets `goal.<id>.low` instead of `tKey`).
   Import `GOAL_KINDS, PRIORITIES, kindOf, isGoalOwner, goalStatusOf` from `../shared/goals.mjs`.
6. `src/actions/index.mjs`
   1. (count 1) `const GOAL_FIELDS = ['id', 'def', 'sort', 'origin', 'created_at', 'archived_at'];` add `'done_at'` (undo restores it).
   2. (count 1 each) `  const { title, note, horizon, target, targetDate, track } = parse(row.def, {});` and
      `  return { title, note, horizon, target, targetDate, track };`: return the whole def minus
      `id` and `pace`, plus `status: goalStatusOf(row)`.
   3. Evidence. Replace the loop at (count 1) `  for (const k of ['target', 'targetDate']) if (Object.hasOwn(fields, k)) {`
      with a list of evidence checks built from `fields`: scalars `target`, `targetDate`,
      `targetLow`, `targetHigh`, `floor`, `taxYear`; each `split[i].amount`; `entered.total`;
      each `entered.people[i].amount`; `entered.asOf`. Stored fallbacks: the previous def's value
      at the same path, plus for money values the available figure values (today's query at
      (count 1) `    if (k === 'target') stored.push(...ctx.db.prepare('SELECT v FROM figures WHERE unavailable_reason IS NULL').all().map(r => r.v));`).
      `null` values keep today's rule (clear words). `owner`, `priority`, `kind`, `status` need no
      evidence.
   4. `changeGoal` result: `{ goal: { ...parse(row.def, {}), status: goalStatusOf(row) }, receipt }`.
7. `src/tools/actions.mjs`
   1. Replace (count 1) `const goalFields = { title: { type: 'string' }, note: { type: 'string' }, horizon: { type: 'string' },`
      through (count 1) `  track: { anyOf: [{ type: 'null' }, obj({ accounts: { type: 'array', items: { type: 'string' } } }, ['accounts']), obj({ figure: id }, ['figure'])] } };`
      keeping those fields and adding: `kind` (string enum GOAL_KINDS), `owner` (string or null),
      `priority` (enum PRIORITIES or null), `status` (enum GOAL_STATUSES), `targetLow`,
      `targetHigh`, `floor` (number or null), `taxYear` (integer or null), `accounts` (array of
      strings or null), `split` (array of `obj({person: string, amount: number}, ['person','amount'])` or null),
      `entered` (`obj({asOf: string, total: number, people: array of the split item}, ['asOf'])` or null).
      The validator in `src/tools/index.mjs` supports `enum`, `integer` and `anyOf`.
   2. Descriptions (count 1 each, the `create_goal` and `edit_goal` lines): create: "Create a goal
      in the person's words. kind is balance (default), range (targetLow, targetHigh), floor (floor
      and track) or contribution (target is the amount, taxYear, targetDate is the deadline,
      optional accounts, split and entered). owner is whose goal (owner, spouse, joint or a
      dependent key such as kid); priority is high, medium or low. Use amounts and dates only when
      stated in this conversation or already stored. Returns the saved goal and a receipt."
      edit: "Edit a goal: any field above, or status done to mark it done and open to reopen it.
      Supply only changed fields, with amounts and dates from the person's words or stored data.
      Returns a receipt." No em dashes.
8. `src/tools/index.mjs` `goalsForModel`
   1. (count 1) `  return loadGoals(db, { fig, accounts }).filter(g => !g.archived).map(g => {` unchanged filter.
   2. Replace (count 1) `    if (!owner && g.status) out.status = g.status;` with `if (g.status) out.status = g.status;`
      and add `out.kind = g.kind`; `if (g.owner) { out.owner = g.owner; out.ownerLabel = personLabel(g.owner, scope.names); }`;
      `if (g.priority) out.priority = g.priority`.
   3. After (count 1) `    if (owner && g.targetDate) out.targetDate = g.targetDate;` add for owner goals:
      range `range: {low: {amount, source: 'you'}, high: {...}}`; floor `floor: {amount, source:
      'you'}`; contribution `contribution: {taxYear, deadline: targetDate, accounts: g.accountsLabel
      || null, split: [{person, label, amount, source: 'you'}], entered: {asOf, total?, people?,
      source: 'you'} | null}` (target stays `target: {amount, source: 'you'}`). Seed goals: `kind`,
      `owner`, `priority` and, for range and floor, the same objects with `source: 'plan'`.
   4. Description (count 1) `    description: 'The open household goals in plain language: title, horizon, note, the target the owner typed and the tracked current value from stored data.',`
      add "kind, whose goal, priority, status (open or done) and the kind's amounts as typed; use
      get_pace for progress."
9. `src/suggest/build.mjs` (count 1) `export const wantsSuggestion = g => g && g.origin === 'owner' && !g.archived && g.status !== 'done' && !finite(g.target);`
   append `&& (g.kind ?? 'balance') === 'balance'`.
10. `demo/seed.mjs`
    1. Add `export const KIND_GOALS` (frozen, synthetic, seed origin) near `CONFIRM_FACT`:
       ```js
       // Synthetic goals of the newer kinds (balance is the seed goals with targets). Seed origin:
       // they came with the demo and cannot be edited. Plain text, no dollar amounts, no tax words.
       export const KIND_GOALS = Object.freeze([
         { id: 'checking-range', kind: 'range', title: 'Keep household checking in a working range', horizon: 'now', status: 'on track',
           prose: 'Enough for the month ahead, with the rest swept to the reserve.', owner: 'joint', priority: 'medium',
           targetLow: 5000, targetHigh: 8000, targetDate: '2026-12-31', track: { accounts: ['a_personal'] } },
         { id: 'biz-floor', kind: 'floor', title: 'Business cash never drops below its floor', horizon: 'now', status: 'on track',
           prose: '{n:biz} keeps a standing minimum for payroll.', owner: 'owner', priority: 'high',
           floor: 15000, track: { accounts: ['a_biz'] } },
         { id: 'ira-fill', kind: 'contribution', title: 'Fill both IRAs for 2026', horizon: 'now', status: 'open',
           prose: 'Each of us puts in the full amount before the April deadline.', owner: 'joint', priority: 'medium',
           target: 15000, taxYear: 2026, targetDate: '2027-04-15', accounts: ['a_broth', 'a_jroth'],
           split: [{ person: 'owner', amount: 7500 }, { person: 'spouse', amount: 7500 }],
           entered: { asOf: '2026-10-31', people: [{ person: 'owner', amount: 7500 }, { person: 'spouse', amount: 4000 }] } },
       ]);
       ```
       Demo facts these rely on: `a_personal` ends at 6,220 and `a_biz` at 18,300 on 2026-08-30;
       `a_broth` and `a_jroth` have positions but no transactions, so the IRA goal uses the entered
       basis (11,500 of 15,000, ahead of the linear plan at the demo clock).
    2. After (count 1) `    S.goals.forEach((g, i) => goal.run(g.id, JSON.stringify(g), i));` add
       `KIND_GOALS.forEach((g, i) => goal.run(g.id, JSON.stringify({ ...g, pace: g.kind === 'range' ? captureGoalPath(db, g, clock) : null }), S.goals.length + i));`
       The statement at (count 1) `    const goal = db.prepare('INSERT INTO goals (id, def, sort) VALUES (?, ?, ?)');`
       is reused; balances are already inserted above it, so the capture reads them. Import
       `captureGoalPath` from `../src/pace/build.mjs`.
11. `test/tools.test.mjs` behavior site (count 1)
    `    assert.deepEqual(goals.map(g => g.id), demo.goals.map(g => g.id));` becomes
    `[...demo.goals, ...KIND_GOALS].map(g => g.id)` with `KIND_GOALS` imported from `../demo/seed.mjs`.
12. `docs/architecture.md`
    1. Table row (count 1) ``| `goals` | `id` PK, `def` JSON, `sort` |`` add `origin`, `archived_at`,
       `created_at`, `updated_at` (migration 012) and `done_at` (migration 026).
    2. Goals section line (count 1) ``owner goal def is `{id, title, note, horizon, target, targetDate, track}`; `src/shared/goals.mjs` ``
       rewrite the def paragraph: kinds and their fields (the KIND_FIELDS table), whose goal ids and
       label fallbacks, priority, derived status and `done_at`, seed status text, legacy `topic`,
       the new figure keys.
    3. Goal pace (count 1) ``Existing `list_goals` and `get_figures` keep their contracts. No migration is needed.``
       replace with: `list_goals` adds the model fields; pace per kind (decisions 7 to 12), the
       qualifying transaction rule, attribution rule, new reason codes, done goals excluded.
       Known limits: post-year-end prior-year contributions, interest and transfers counted.
    4. API rows: (count 1) the `POST /api/goals` row (``| `POST /api/goals` | `{title, note?, horizon?, target?, targetDate?, track?}` |``)
       and (count 1) ``| `POST /api/goals/:id` | any subset of the create fields | `{scenario, goal}`. Edits an owner goal; 409 for a seed (demo) goal, 404 unknown. |``
       name the new fields, the per-kind 400s and `status`.
    5. Home layout first line (count 1, verify) `Home is one `article.h-gcard` per live goal, in pace order, then goals without pace. Each card holds the`
       becomes "in priority order (high, medium, low, unset), then pace order", plus one sentence on
       the owner and priority chips and the kind lines.
13. `docs/ask-tools.md` (count 1) ```edit_goal`) stay as they are. The feat/ask-actions `undo_<kind>_action` tools change only by``:
    add a sentence after the paragraph: "feat/goal-model-v2 adds the goal model fields to
    `create_goal` and `edit_goal` (kind, owner, priority, status and the kind fields) and to
    `list_goals`; owner and person ids follow `OWNER_OPTIONS` (`owner`, `spouse`, `joint`) plus
    dependent keys. T23's `goal_row` restore includes `done_at`."

S1 local test command:
`node --test test/goal-kinds.test.mjs test/store-goal-kinds-migration.test.mjs test/goal-kinds-api.test.mjs test/goals.test.mjs test/ask-actions.test.mjs test/tools.test.mjs test/onboard-model.test.mjs test/goal-targets-api.test.mjs test/rec-links.test.mjs test/docs.test.mjs test/seed.test.mjs src/mcp/test/actions.test.mjs`

### S2 pace calc and pace build

Files: `src/calc/pace.mjs`, `src/pace/build.mjs`, test `src/calc/test/pace-kinds.test.mjs`.

Edit blocks:

1. `src/calc/pace.mjs`, insert before (count 1) `export function paceRollup(goals, clock) {`:
   1. `rangePace({ goal, actual = null, clock })`: `const base = goalPace({ goal: { ...goal, target: goal.targetLow }, actual, clock });`
      figures `low` ('Range low end', t) and `high` ('Range high end', t) via `paceFigure` with
      `calc: 'rangePace'`, inputs `{goal: {id, targetLow, targetHigh}, clock, actual: actual?.v ?? null}`
      and the same sources `goalPace` uses (goal row, pace sources, actual sources); position from
      `actual.v` when finite. Return `{ ...base, range: { low, high, position } }`. Non-finite low
      or high: `base` is already `no target`; range figures null.
   2. `floorPace({ goal, actual = null, clock })` per the Interface; holding is `actual.v >= floor`;
      status set only when `dataState(actual, clock)` is null. `paceFigure` with `calc: 'floorPace'`.
   3. `contributionPace({ goal, actual = null, basis = null, people = [], clock })`:
      no finite target, no integer taxYear or no valid targetDate: return the `goalPace` no-target
      shape plus `contribution` with `basis` and empty people. Else build
      `planned = { ...goal, pace: { startDate: `${goal.taxYear}-01-01`, startValue: 0, sources: [] } }`,
      `base = goalPace({ goal: planned, actual, clock })`; apply decision 8 overrides only when
      `!base.reason`; when `actual` is null set `base.reason = 'missing_contributions'`. Figures
      with `calc: 'contributionPace'`: `remaining` ('Left to contribute', e) and per person
      `target` ('Share of the contribution', t) and `actual` ('Contributed so far', the person
      actual's kind) with that person's sources. Persons: split persons, then entered persons not
      in the split, in PERSONS order (`['owner', 'spouse']`, local constant; no shared import in the
      pure calc).
   `paceRollup` stays unchanged.
2. `src/pace/build.mjs`
   1. Import (count 1) `import { goalPace, paceRollup, monthlyPace, paceMeter, finite, isoDate } from '../calc/pace.mjs';`
      add `rangePace, floorPace, contributionPace`; import `kindOf, isGoalOwner, PRIORITIES` from
      `../shared/goals.mjs`; import `ownerOf` from `../jobs/planner/data.mjs` (already imported by
      `src/suggest/build.mjs`, no cycle).
   2. In `makeReader`, before (count 1) `  return { tracked, observations, figure };` add
      `contributions(goal)` returning `{ actual, basis, people }`:
      1. ids: unique `goal.accounts` that exist in `accounts`.
      2. Transaction basis when some id has `SELECT 1 FROM transactions WHERE account_id = ? AND date <= ? LIMIT 1`.
         Rows: `SELECT id, account_id, date, amount FROM transactions WHERE account_id IN (...) AND amount > 0 AND date >= ? AND date <= ? AND date <= ? ORDER BY date, id`
         with `${taxYear}-01-01`, `${taxYear}-12-31`, clock. Per account data-through: the later of
         its newest transaction date and newest balance date on or before the clock; dependency
         `{kind: 'bank_csv', asOf}` per account. `actual = actualValue(sum, deps, [sourceRows('transactions', ids), sourceRows('accounts', accountIds)], 'Contributions recorded in the tax year')`
         (sum 0 with an empty transactions source when nothing qualifies). People: when every
         destination account's `ownerOf(owner)` is `owner` or `spouse`, one `actualValue` per such
         person from that person's rows, else none.
      3. Entered basis when `goal.entered` has a valid `asOf`: total `entered.total` or the people
         sum; dependency `{kind: 'balances', asOf: entered.asOf}`; source
         `{ rows: { table: 'goals', ids: [goal.id], count: 1 }, field: 'entered', src: 'you' }`;
         label 'Contributed so far, as entered'; people from `entered.people`.
      4. Else `{ actual: null, basis: null, people: [] }`.
   3. Replace (count 1) `  const defs = db.prepare('SELECT id, def FROM goals WHERE archived_at IS NULL ORDER BY sort, created_at, id').all()`
      with `... WHERE archived_at IS NULL AND done_at IS NULL ...`; keep (count 1)
      `    .map(r => ({ ...parse(r.def, {}), id: r.id })).filter(g => g.status !== 'done');` (seed done).
   4. Replace (count 1) `  const goals = defs.map(goal => goalPace({ goal, actual: reader.tracked(goal), clock }));`
      with a dispatch on `kindOf(goal)` (range, floor, contribution, else goalPace) that returns
      `{ ...result, kind, owner: isGoalOwner(goal.owner) ? goal.owner : null, priority: PRIORITIES.includes(goal.priority) ? goal.priority : null }`.
   5. Replace (count 1) `    series: { goals: Object.fromEntries(defs.map(goal => [goal.id, monthlyPace({ goal, observations: reader.observations(goal), clock })])),`
      with a per-kind series (decision 12).
   6. `goalPathChanged`, (count 1) `  return previous.target !== next.target || previous.targetDate !== next.targetDate`:
      also compare `kindOf(previous) !== kindOf(next)` and `previous.targetLow !== next.targetLow`.
      `captureGoalPath` (count 1 `  const a = makeReader(db, clock).tracked(goal);`) is unchanged.

S2 local test command:
`node --test src/calc/test/pace-kinds.test.mjs src/calc/test/pace.test.mjs test/pace.test.mjs`

### S3 web UI

Files: `web/horizon/screens/home-model.js`, `web/horizon/design.js`, `web/horizon/screens/home.css`,
`web/horizon/design.css`, `e2e/home.spec.mjs` (behavior site), tests
`test/goal-kinds-home.test.mjs`, `e2e/goal-kinds.spec.mjs`. `web/core/core.js` needs no change
(`goalUpdate(id, {status})` already posts to `/api/goals/:id`).

Edit blocks:

1. `web/horizon/screens/home-model.js`
   1. Add after the `servedGoalIds` block: `PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 })`
      (comment: matches PRIORITIES in src/shared/goals.mjs, checked by a test), `priorityRankOf`,
      `orderGoals(goals)` (stable: not done before done, then priority rank), `orderServes(serves,
      goals)` (stable by the matching goal's priority rank).
   2. `goalChip` (count 1) `export function goalChip(p) {`: at its top, before the no-target line,
      add: floor with `p.floor?.state === 'breached'`: `{tone: 'warn', label: 'Below floor'}`;
      floor with status `on pace`: `{tone: 'ok', label: 'Holding'}`; range with status `ahead` or
      `on pace` and position `in` or `above`: `{tone: 'ok', label: 'In range' | 'Above range'}`.
      Contribution needs nothing: its time gaps `Reached` and `Deadline passed` already become the
      ahead and behind labels.
   3. `paceReason`, at (count 1) `    const title = worst?.title || 'One goal';`: for one behind
      goal, a floor reads `${title} is below its floor.` and a passed deadline reads
      `${title} missed its deadline.`; the multi-goal sentence keeps its form.
   4. REASON_TEXT, after (count 1) `  missing_month_actual: 'No reading for this month.'` add
      `missing_contributions: 'No contributions are recorded or entered yet.'` and
      `kind_not_charted: 'This kind of goal has no monthly chart.'` (no underscores, dashes or amounts).
   5. `kindLine(p, i)` per the Interface: figure keys under `pace.goals.${i}.` (`range.low`,
      `range.high`, `target` for the floor, `actual`, `target`, `contribution.remaining`,
      `contribution.people.${j}.actual|target`), labels `positionLabel` (Below range, In range,
      Above range), `stateLabel` (Holding, Below floor), `asOf` (data-through when stale),
      `basisLabel` (From recorded contributions, As you entered), `taxYear`, `deadline`. Null for
      balance or no pace.
   6. `homeModel`: after (count 1) `  live.forEach((g) => { if (!ordered.includes(g)) ordered.push(g); });`
      stable-sort `ordered` by `priorityRankOf(g.priority)`; the card literal (count 1)
      `    return { id: g.id, goal: g, pace: p, paceIndex, chip: goalChip(p), bar: paceBar(p), next: actions[0] || null, actions, suggestion };`
      gains `kind: g.kind || 'balance', owner: g.owner ?? null, priority: g.priority ?? null, line: p ? kindLine(p, paceIndex) : null`.
      The live filter (count 1) `  const live = arr(goals).filter((g) => g && !g.archived && g.status !== 'done');` already drops done owner goals.
2. `web/horizon/design.js`
   1. Import (count 1) `import { KNOWN_FIGURES } from '/shared/goals.mjs';` add `GOAL_KINDS, KIND_LABEL,
      PRIORITIES, PRIORITY_LABEL, personLabel, goalOwnerOptions`; import `orderGoals, orderServes`
      from home-model.
   2. Draft: (count 1) `const emptyDraft = (horizon = 'now') => ({ title: '', note: '', horizon, target: '', targetDate: '', trackKind: 'none', accounts: [], figure: '' });`
      add `kind: 'balance', owner: '', priority: '', targetLow: '', targetHigh: '', floor: '',
      taxYear: String(clock year), dest: [], shareOwner: '', shareSpouse: '', enteredTotal: '',
      enteredOwner: '', enteredSpouse: '', enteredAsOf: ''`. `draftOf` (anchor count 1
      `    accounts: t && Array.isArray(t.accounts) ? t.accounts.slice() : [], figure: t && t.figure ? t.figure : ''`)
      fills them from the goal (`dest` from `g.accounts`, shares from `g.split`, entered fields from
      `g.entered`).
   3. `goalFormHtml`: after (count 1) the When row
      `    <div class="h-gf">${gl('When')}<div class="h-chips" role="group" aria-label="Horizon">${GOAL_BANDS.map(chip).join('')}</div></div>`
      add one `h-gf2` row with two selects: `Whose goal` (`data-gf="owner"`, first option "Not
      set", then `goalOwnerOptions(api.s.names)`, labels escaped) and `Priority`
      (`data-gf="priority"`, Not set, High, Medium, Low), then `Kind of goal` (`data-gf="kind"`,
      KIND_LABEL). Then the kind block replaces the current target/date/track rows for non-balance
      kinds; balance keeps the existing rows unchanged (labels Target amount, Target date, Track
      with must stay unique for `e2e/goals.spec.mjs`):
      1. range: `Low end` (`targetLow`), `High end` (`targetHigh`), `Target date`, Track with.
      2. floor: `Floor amount` (`floor`), Track with (required, no "Nothing yet" option).
      3. contribution: `Amount to contribute` (`target`), `Tax year` (`taxYear`, number),
         `Deadline` (`targetDate`, date), `Into these accounts` (checkboxes `data-gf="dest"` over
         every account, optional), `${personLabel('owner', names)}'s share` / spouse share
         (`shareOwner`, `shareSpouse`, optional), `Contributed so far` (`enteredTotal`, shown when
         no shares are given) or one per person (`enteredOwner`, `enteredSpouse`), and `As of`
         (`enteredAsOf`, date, prefilled with the scenario clock when empty).
      For an existing owner goal that is not done, the form nav gains `btn('Mark done', 'data-goal="done" data-id="…"', 'ghost')`.
   4. `goalFields(d)`: replace (count 1)
      `  const out = { title, note: d.note.trim(), horizon: d.horizon, target: null, targetDate: d.targetDate || null, track: null };`
      with common fields `{title, note, horizon, kind, owner: d.owner || null, priority: d.priority || null}`
      plus only `KIND_FIELDS[kind]` (never another kind's field), with client errors: Give both
      ends of the range. / The low end must not be above the high end. / Give the floor amount. /
      Pick what this floor tracks. / Give the amount to contribute. / Give the tax year. / Give
      the deadline. / The shares must add up to the amount. Balance output stays as today plus the
      common fields.
   5. Handlers: `goalInput` at (count 1) `  } else if (k === 'track') {` gains `dest` (checkbox set
      like `acct`) and `kind`/`owner`/`priority` (set the draft; `kind` redraws). `onChange` (count
      1) `  if (t?.dataset?.gf === 'track' || t?.dataset?.gf === 'acct') { goalInput(t); return; }`
      and `onInput` (count 1) `  if (t.dataset.gf && t.dataset.gf !== 'track' && t.dataset.gf !== 'acct') { goalInput(t); return; }`
      route `kind`, `owner`, `priority`, `dest` with the selects and checkboxes. `goalClick` after
      (count 1) `  if (act === 'delete') { ui.goalDel = d.id; draw(); return; }` adds `done`
      (`api.goalUpdate(d.id, { status: 'done' })`, closes the form if it is that goal) and
      `reopen` (`{ status: 'open' }`).
   6. Home card `goalCardHome`: the branch at (count 1)
      `  } else if (c.goal.origin === 'owner' && Number.isFinite(c.goal.target) && !c.goal.track) {`
      applies to balance only (`c.kind === 'balance' &&`). Add `kindHtml(c.line)` after the bar:
      range `<p class="h-gkind">Range {low} to {high}, {positionLabel}</p>`; floor `<p
      class="h-gkind">Floor {floor}, {stateLabel lowercased}{, as of Aug 30}</p>`; contribution
      `<p class="h-gkind">For {taxYear}, by {longDate(deadline)}. {basisLabel}.</p>` plus
      `<div class="h-gpeople">` rows `{label} {actual} of {target}` (or `{label} {target}` when the
      actual is null). Every amount through `figHtml(key, { k: true })`; labels through `esc`.
      Missing contribution progress shows `reasonText('missing_contributions')`. The header (count
      1) `  return `<article class="h-gcard" data-goal-card="${esc(c.id)}"><div class="h-gcard-h"><a class="h-gcard-t" href="${href('goals')}" data-go="goals">${goalTitle(c.goal)}</a>${chipHtml(c.chip, 'h-pchip')}</div>${bar}${next}${more}</article>`;`
      gains a `<div class="h-gtags">` after the header with `<span class="h-gtag" data-goal-owner>`
      (personLabel) and `<span class="h-gtag" data-goal-priority>` (PRIORITY_LABEL), each only
      when set.
   7. Goals screen `goalCard`: after (count 1) `  const meta = [];` push the owner label and
      `${PRIORITY_LABEL[p]} priority`; for a non-balance kind with a pace entry, use `kindHtml`
      (shared with Home) in place of the progress block; the header span shows `Done` for a done
      owner goal (class `done`, existing CSS). The action buttons at (count 1, the line starting
      ``    : `${owner && !g.archived ? btn('Edit', ``) gain `Mark done` (open owner goals) or
      `Reopen` (done owner goals). `pGoals` (count 1) `  const goals = all.filter((g) => !g.archived);`
      becomes `orderGoals(all.filter((g) => !g.archived))`.
   8. Plan rows: `servesHtml` (count 1) `  const list = arr(r.serves);` becomes
      `orderServes(arr(r.serves), arr(api.s.goals))`.
3. CSS: `web/horizon/screens/home.css` adds `.h-gtags` (flex, wrap, gap 6px), `.h-gtag` (muted
   pill like `.h-pchip` without the dot), `.h-gkind` (13px, `--fa`), `.h-gpeople` (grid, wraps);
   `web/horizon/design.css` adds nothing beyond reusing `.h-gf2`, which already collapses to one
   column at phone width (rule at the existing `.d-horizon .h-gf2 { grid-template-columns: 1fr; }`).
   Nothing may overflow at 390px.
4. `e2e/home.spec.mjs` behavior site: in `model`, after (count 1)
   `  const order = [...inPace, ...goals.filter((g) => !inPace.includes(g))];` stable-sort `order`
   by priority rank (high, medium, low, unset). In the card loop, before (count 1)
   `      const want = goalChip(p);` skip the chip and bar checks when `c.goal.kind && c.goal.kind !== 'balance'`
   (the title and next-action checks still run); `e2e/goal-kinds.spec.mjs` covers the other kinds.

S3 local test commands:
`node --test test/goal-kinds-home.test.mjs test/home-model.test.mjs`
`E2E_PORT=<a free port of your own, not 4173> npx playwright test e2e/goal-kinds.spec.mjs e2e/home.spec.mjs e2e/goals.spec.mjs`
Then open the attached screenshots (editor and Home, desktop and phone) and compare them with the
Horizon cards and form yourself.

## Behavior sites

Readers of goal def fields, status, `openGoal`, `goalTopics`, pace output, tool output, the board,
and tests or docs that pin goal counts or text. Each is either edited above or confirmed unaffected.

1. `src/shared/goals.mjs`: `validateGoal`, `goalTopics` (legacy `goal.kind` topic), `openGoal`,
   `servesGoals` (uses `openGoal`; done goals drop out of links). Edited (S1).
2. `src/goals/write.mjs` `createGoal`, `updateGoal`. Edited (S1).
3. `src/api/goals.mjs` `goalCreate`, `goalUpdate`, `goalArchive` (raw `archived_at`; unchanged),
   `goalDelete`, `goalSuggestion` (seed refusal unchanged). Header edited (S1).
4. `src/scenario/build.mjs` `loadGoals` (all goal readers: scenario, planner via
   `src/jobs/planner.mjs:91`, `linkWithStoredGoals`, tools, suggestions); `linkRecs`. Edited (S1).
5. `src/suggest/build.mjs` `wantsSuggestion` (status done, target). Edited (S1).
6. `src/actions/index.mjs` `GOAL_FIELDS`, `goalValue`, `changeGoal` evidence; `src/actions/receipts.mjs`
   undo reads `Object.keys(after)` so old receipts without `done_at` still undo. Edited (S1);
   receipts.mjs unaffected.
7. `src/tools/actions.mjs` schemas; `src/tools/index.mjs` `goalsForModel` (`list_goals`,
   `household_summary`), `get_pace` (returns `buildPace`). Edited (S1); get_pace via S2.
8. `src/pace/build.mjs` `buildPace` (def `status !== 'done'` filter for seed, archived filter),
   `captureGoalPath`, `goalPathChanged`; `src/calc/pace.mjs` `goalPace`, `paceRollup`,
   `monthlyPace`, `indexPaceFigures` (recurses into nested figures, so new figure keys index
   automatically). Edited (S2).
9. `web/horizon/screens/home-model.js` `homeModel` live filter (`status !== 'done'`), `goalChip`,
   `paceReason`, `paceBar` (floor has no expected, so no bar), `REASON_TEXT`, `boardCharts`
   (floor and contribution have no series array, so no chart). Edited (S3).
10. `web/horizon/design.js` `goalCardHome`, `goalCard` (`g.status` as CSS class and seed text),
    `pGoals`, `goalFormHtml`, `goalFields`, `draftOf`, `goalInput`, `goalClick`, `servesHtml`,
    `pPace` (board headline and reason). Edited (S3).
11. `web/horizon/screens/chat.js` `goalProposalHtml` (balance proposals only; unaffected).
    `web/horizon/screens/onboard-model.js` (starter goals are balance; unaffected;
    `test/onboard-model.test.mjs` asserts `value.target === null`, still true).
12. `src/advisor/packet.mjs` lists goal titles (unaffected).
13. `demo/seed.mjs` goal insert. Edited (S1).
14. Tests and specs that pin goal counts or text on the demo:
    1. `test/tools.test.mjs` list_goals ids. Edited (S1).
    2. `test/goals.test.mjs` demo reset keeps ids and every goal seed origin (kind goals are seed:
       passes); `rec('va529').serves` is `['kids']` (new goals carry no education topic: passes);
       household summary deepEqual list (same function: passes).
    3. `test/home-model.test.mjs` demo test: every live goal is a card, seed goals get no
       suggestion, pending 0, pace headline (passes; kind goals are seed and non-balance).
    4. `test/pace.test.mjs` demo reserve and port3 figures and `arena` no target (unchanged);
       `buildScenario(db).pace` equals `get_pace` (same builder).
    5. `test/rec-links.test.mjs` demo recs goal kinds and owners (rec rows unchanged); real-store
       count 7 (no demo). Passes.
    6. `test/seed.test.mjs` faithful port (scenario.mjs untouched). Passes.
    7. `e2e/home.spec.mjs` model order and chip replication. Edited (S3).
    8. `e2e/pace-board.spec.mjs` derives headline, reason and charts from the API pace (more
       unknown goals, one more chart for the range). Passes unedited.
    9. `e2e/pace.spec.mjs` reserve fields and `scenario.pace` equals `/api/pace`. Passes.
    10. `e2e/goals.spec.mjs` form labels and buttons: kept unique (balance rows unchanged; new
        controls are selects). Passes unedited.
    11. `e2e/goal-targets.spec.mjs` archives every goal first (archive route works on kind goals).
        Passes.
    12. `e2e/provenance.spec.mjs` bare dollar amounts on every route: new amounts go through
        `figHtml`; demo kind goal text has no amounts.
    13. `e2e/question-recs.spec.mjs` legacy topic kind `education` keeps linking via `topic`.
    14. `e2e/mobile.spec.mjs`, `e2e/nav.spec.mjs` width checks: new tags wrap.
15. Docs: `docs/architecture.md` (Goals and the tradeoff curve, Goal pace, Home layout, Tables,
    API routes) and `docs/ask-tools.md` (Unchanged tools note, T23). Edited (S1).
16. Migrations listing: docs/architecture.md "Adding a migration" has no per-migration list; the
    Tables row names migrations. `src/store/db.mjs` applies files in id order; no edit.

## Prior intent

`git -C <worktree> log -3 --format='%h %s' --since='6 months ago' -- <file>`:

1. `src/shared/goals.mjs`: f7b7697 Link every recommendation to a goal or housekeeping and give it
   an action owner (#42); e21b2d4 Goals and priorities become owner-editable data (#22).
2. `src/goals/write.mjs`: 0553f39 Enable scoped Ask actions with receipts, Undo and preferences.
3. `src/api/goals.mjs`: 4b102c2 Share action validation and finish scoped permission controls;
   0553f39 Enable scoped Ask actions...; c9c3a6d Suggest goal targets from stored data and give every
   goal its own Home card.
4. `src/scenario/build.mjs`: 128d96c Defer action replanning until the engine lock releases;
   be6109d Show goal labels through the naming rows so an unsure mask is not shown; 0553f39.
5. `src/actions/index.mjs`: 128d96c; 0553f39.
6. `src/tools/actions.mjs`: 0553f39.
7. `src/tools/index.mjs`: 4b102c2; 0553f39; 649e7f3 Preserve action steps alongside supplemental
   questions.
8. `src/suggest/build.mjs`: efd9b5d Classify transactions with source categories and undoable
   merchant rules; b62e77b Keep a gap on the latest run and name accounts from stored labels;
   5c23aea Reuse shared helpers in suggested targets and index transfer matching by amount.
9. `src/calc/pace.mjs`: 5c23aea; c9c3a6d; 84e0296 Add deterministic goal pace and household health
   API (#41).
10. `src/pace/build.mjs`: c9c3a6d; 84e0296.
11. `demo/seed.mjs`: 0553f39; efd9b5d; 4d9626d Move accounts to platform.sqlite with household
    memberships and operators.
12. `docs/architecture.md`: 128d96c; 931d708 List the owner and kind routes separately and follow
    the ending suffix in two label expectations; ff5404a Specify the deterministic tool layer shared
    by Ask and MCP.
13. `docs/ask-tools.md`: 7e82520 Close round three review gaps in the tool catalog spec; 1e13012;
    f6936a7.
14. `web/horizon/design.js`: 0553f39; be92a29 Address review: revert dependents on restate, honor
    mask certainty, refuse imported pairs, raw name on rename; fef07f9 Edit owner, kind and last 4 in
    the account dialog, and merge accounts from it.
15. `web/horizon/screens/home-model.js`: 5c23aea; c9c3a6d; 495644f Collapse navigation to four tabs
    and a settings gear (#46).
16. `web/horizon/screens/home.css`: c9c3a6d; 90965b5 Goals-first onboarding and empty Home (#48);
    df3157f Make Home goals-first with a pace board and one data-health line (#43).
17. `web/horizon/design.css`: 6b5e0c0; 9a274cd; 3dc6a32.
18. `test/tools.test.mjs`: 0553f39; e083072; f7b7697.
19. `e2e/home.spec.mjs`: 87eafe0 Add failing tests for suggested goal targets and a per-goal Home;
    df3157f.

Intent to preserve: owner text stays literal and escaped (e21b2d4); goal links resolve at read time
by topic (f7b7697); every Home figure has provenance and one card per live goal (c9c3a6d, df3157f);
pace is deterministic with explicit stale health (84e0296); Ask writes need owner evidence and give
undoable receipts (0553f39, 4b102c2).

## Tests

All fixtures synthetic. No real names or private amounts.

### test/goal-kinds.test.mjs (S1)

1. `validateGoal defaults a new goal to kind balance, status open, owner and priority unset`:
   `{title}` gives kind balance, status open, owner null, priority null, target, targetDate, track null.
2. `validateGoal accepts owner, spouse, joint and dependent keys as whose goal`: kid and kid2 pass;
   you, both, a name, 7 and kidx fail with the owner message; '' and null give null.
3. `validateGoal accepts high, medium or low priority, or unset`: urgent fails.
4. `validateGoal accepts status open, done and archived only`: closed fails; partial without status
   has no status key.
5. `a range needs both ends with the low end not above the high end`: missing high fails; 60 over 50
   fails; negative fails; 5000.004 rounds to 5000.
6. `a floor needs an amount and something tracked, and refuses a target date`: no track fails;
   targetDate fails with "does not apply to a floor goal".
7. `a contribution needs an amount, a tax year and a deadline in or after the tax year`: each missing
   field fails; taxYear 1999, 2101 and 2026.5 fail; deadline 2025-12-31 with taxYear 2026 fails;
   2027-04-15 passes.
8. `contribution accounts, split and entered are validated`: unknown account fails; split persons
   must be owner or spouse and unique; split 7000 plus 7000 against 15000 fails; entered without
   asOf fails; entered with both total and people fails; entered person outside the split fails.
9. `fields of another kind are refused`: balance with targetLow fails "does not apply to a balance goal".
10. `a partial edit validates against the stored def`: previous range 10 to 20; `{targetHigh: 5}`
    fails; `{kind: 'floor', floor: 5, track: {accounts: [known]}}` passes; `{title}` alone passes.
11. `personLabel and goalOwnerOptions read household names and fall back to neutral labels`: names
    {me: 'Ava', spouse: 'Ben', kid: 'Cy', kid2: 'Di'} give Ava, Ben, Joint, Cy, Di and options in
    that order; empty names give You, Your spouse, Joint, Your child and one kid option.
12. `goalTopics ignores model kinds, keeps a legacy topic and reads contribution accounts`: kind floor
    adds nothing; topic education adds education; raw kind education adds education; contribution
    with a retirement-kind account adds retirement.
13. `openGoal treats done and archived goals as closed`: status done false; archived true false;
    seed status 'on track' true; owner status open true.
14. `demo seed has one goal of each kind (balance, range, floor, contribution)`: seed a temp store,
    `loadGoals`: at least one balance, exactly one range, floor and contribution; the three are seed
    origin; each def (kind fields plus title, horizon, owner, priority) passes `validateGoal` against
    the seeded accounts and figures; titles and prose match no `/\$\s?\d/`; `buildPace` has an entry
    for each with its kind.

### test/store-goal-kinds-migration.test.mjs (S1)

1. `migration 026 adds done_at and rewrites no goal row`: `new DatabaseSync(':memory:')`,
   `migrate(db, { through: 25 })`; insert an owner goal with target, targetDate, track and pace; an
   archived owner goal; a seed goal with def status 'done'; a seed goal with a legacy `kind:
   'education'`; a seed goal with progress tokens. Snapshot `SELECT id, def, sort, origin,
   archived_at, created_at, updated_at FROM goals`. `migrate(db).applied` equals `[26]`. The
   snapshot is identical (def text byte for byte); `done_at` is null on every row; `PRAGMA
   table_info(goals)` shows `done_at` TEXT, nullable, no default.
2. `loadGoals reads existing goals back identically, plus kind balance, status open, owner and priority unset`:
   `loadGoals` before migrating equals `loadGoals` after (deepEqual), and every goal has kind
   balance, owner null, priority null, doneAt null; the open owner goal has status open, the
   archived one archived; seed statuses are unchanged ('done', display text); the legacy goal has
   `topic: 'education'` and `servesGoals({goalKinds: ['education']}, goals)` still returns it.
3. `migration 026 changes no other table`: `sqlite_master` sql for every object except the goals
   table is identical before and after; the goals sql differs only by the added column.

### src/calc/test/pace-kinds.test.mjs (S2)

1. `a range runs the balance path on its low end and reports below, in or above`: status and
   expected equal `goalPace` with `target = targetLow`; `range.low.v` and `range.high.v`; positions
   for 10000, 25000, 35000 against 20000 to 30000.
2. `a range without both ends is no target`.
3. `a floor holds at or above its amount and is breached below it`: 20000 holding, on pace, Holding,
   gap 0; 19999.99 breached, behind, Below floor, gap -0.01; no floor amount is no target.
4. `a stale floor reading keeps its state but not a known status`: actual dated 100 days back:
   unknown, stale_data, `floor.state` breached.
5. `floors count in the rollup as on pace when holding and behind when breached`: `paceRollup`
   counts and headline "1 goal behind".
6. `contribution progress sums positive transactions into the destination accounts within the tax year up to the clock`:
   temp store (`tempDb` from `../../../test/helpers/server.mjs`); accounts r1 (retirement, owner
   'You'), r2 (retirement, owner 'Your spouse'), c1 (checking); transactions r1 2025-12-20 +500, r1
   2026-02-01 +1000, r1 2026-03-01 -200, r2 2026-04-01 +1500, r1 2026-12-15 +700, c1 2026-05-01
   +9999, r2 2027-01-10 +300; balances r1 and r2 2026-10-31; clock 2026-11-05; goal target 5000,
   taxYear 2026, targetDate 2026-12-31, accounts r1 and r2, split 2500 each. `buildPace`: basis
   transactions; actual 2500; its sources list exactly the two qualifying transaction ids and the
   two accounts; people owner 1000 and spouse 1500; remaining 2500.
7. `per-person progress is total only when an account holder is unknown`: r3 with owner null in the
   accounts list: people actuals null, total still summed.
8. `contribution falls back to the entered amount with provenance you`: destination accounts without
   transactions, entered `{asOf: '2026-11-01', people: [owner 1200, spouse 800]}`: basis entered,
   actual 2000, a source `{rows: {table: 'goals', ids: [id], count: 1}, field: 'entered', src: 'you'}`.
9. `a contribution with no recorded or entered amount is unknown with missing_contributions`.
10. `a contribution at its amount is Reached and past its deadline below it is Deadline passed`
    (pure `contributionPace` with synthetic actuals).
11. `every figure in each kind result is a calc:pace figure with sources`: walk the results; every
    object with a finite `v` has `src: 'calc:pace'`, non-empty `locator.sources` and
    `locator.computedOn` equal to the clock.
12. `buildPace skips done goals, tags kind, owner and priority, and charts only balance and range`:
    a goal with `done_at` is absent; entries carry the fields; floor and contribution series are
    `{series: null, reason: 'kind_not_charted', dataEnd: null}`.
13. `goalPathChanged recaptures when the range low end or the kind changes`.

### test/goal-kinds-api.test.mjs (S1; item 7 needs S2)

Store pattern from `test/goals.test.mjs` (`tempDb`, handler ctx with `config.clock`), synthetic
accounts, balances and transactions; tool calls with the `test/ask-actions.test.mjs` context
(actorId, ownerText with the stated amounts and dates).
1. `POST /api/goals creates a range, a floor and a contribution and the scenario carries their fields`:
   kind, owner, priority, status open, kind fields; figures `goal.<id>.low`, `.high`, `.floor`,
   `.split.owner`, `.entered` with `src: 'goal-target'`; contribution `pace` null in the def.
2. `POST /api/goals/:id switches kind and drops the old kind's fields`: balance to floor leaves no
   target or targetDate in the def and pace null; floor back to balance captures a pace path.
3. `status done and open mark a goal done and reopen it`: done sets `done_at`, scenario status done,
   absent from `scenario.pace.goals` and from every rec's serves, still in `scenario.goals`; open
   clears it; archived sets `archived_at`; a seed goal edit with status answers 409.
4. `bad kind fields answer 400 with the validation message` (range low above high, floor without
   track, contribution without tax year, a field of another kind).
5. `create_goal and edit_goal take the new fields and need owner evidence for every amount and date`:
   a floor amount not in the owner text is refused (`/stated|evidence/`); a stated one saves;
   `edit_goal {status: 'done'}` saves without evidence; `undo_goal_action` restores `done_at` null.
6. `list_goals carries kind, whose goal with its label, priority, status and kind amounts`: content
   `names` row `{me: 'Ava', spouse: 'Ben'}` (synthetic) gives ownerLabel Ava; floor `{amount,
   source: 'you'}`; a done goal is listed with status done; an archived one is not.
7. `get_pace carries kind, owner, priority and each kind's result`: range `range.position`, floor
   `floor.state`, contribution `contribution.basis` transactions and actual equal to the fixture
   sum.
8. `the goal tool schemas list every new field`: `getTool('create_goal').inputSchema.properties` and
   edit_goal's include kind, owner, priority, status, targetLow, targetHigh, floor, taxYear,
   accounts, split, entered.

### test/goal-kinds-home.test.mjs (S3)

Pattern from `test/home-model.test.mjs` (pure imports from `web/horizon/screens/home-model.js`,
inline pace fixtures shaped like the Interface).
1. `homeModel orders cards high, medium, low, unset, keeping pace order within a priority`.
2. `cards carry kind, owner and priority, and a done goal has no card`.
3. `goalChip says In range, Above range, Holding, Below floor even when stale, Reached and Deadline passed`.
4. `kindLine gives range ends, floor state and contribution progress as pace figure keys`.
5. `paceReason names a breached floor and a missed deadline in plain words`.
6. `REASON_TEXT has plain text for missing_contributions and kind_not_charted` (no underscore, en or
   em dash, or dollar amount).
7. `orderGoals puts done goals last and orders by priority; orderServes orders served goals by priority`.
8. `PRIORITY_RANK matches PRIORITIES in src/shared/goals.mjs`.
9. `over the seeded demo store each kind goal card has a kind line whose figure keys exist in scenario.fig`:
   seedDemo, buildScenario, homeModel; the biz-floor card is first (high); the IRA card line has
   basis entered and two people.

### e2e/goal-kinds.spec.mjs (S3)

Tagged `@mobile` so the desktop (1440) and mobile (390) projects both run it; `resetDemo` before
each.
1. `create a contribution goal and a floor in the editor and see them on Home`: on `#/goals` open
   the form; kind Make a contribution; title "Synthetic HSA top up"; amount 6000, tax year 2026,
   deadline 2027-04-15, Whose goal joint, Priority high, Contributed so far 2500 as of 2026-11-01;
   attach a screenshot of the form (`testInfo.attach`); save (wait for POST /api/goals 200). Then a
   floor: title "Personal checking floor", kind Keep a floor, floor 3000, Track with accounts and
   the `a_personal` checkbox, Whose goal owner, Priority medium; save. Read `/api/scenario`; on Home
   both cards exist; the tags show `personLabel` values from `s.names` and High and Medium; the
   floor chip equals the mapping from its pace entry (Below floor, Holding or Data stale); the floor
   line shows the `pace.goals.<i>.target` figure as `money(3000, {k: true})`; the contribution bar
   labels show `money(2500, {k: true})` of `money(6000, {k: true})`; card order puts every high card
   before every medium and unset card; `bareDollarNodes(page)` is empty; no horizontal scroll
   (`scrollWidth <= innerWidth`); attach a Home screenshot.
2. `mark done takes a goal off Home and shows it as done on Goals; reopen brings it back`: create a
   balance goal via the API, Mark done on its Goals card, the card reads Done and Home has no card
   for it, Reopen restores the Home card.

## Edge cases

1. Partial edit that changes kind: previous other-kind fields are dropped, not validated.
2. Legacy def `kind` topic on a seed goal: reads kind balance, topic kept; an owner goal never has
   one.
3. Floor exactly at the amount is holding.
4. Range with low equal to high is valid.
5. Contribution reached before the deadline stays `ahead` / Reached after the deadline too.
6. Contribution deadline before the clock with no progress source: unknown with
   `missing_contributions` (not behind: nothing is known).
7. Destination account deleted or merged later: unknown ids are skipped at read; validation rejects
   them on the next edit.
8. Entered amount dated after the clock: `dataState` gives `undated_actual`, status unknown.
9. Entered amount older than 45 days: stale, unknown, Home chip Data stale (prompts an update).
10. A done goal that is archived reads archived; restoring through `/archive` returns it to done.
11. 200-goal cap unchanged; `done` counts toward it.
12. Names missing on a real store before the first planner run: neutral labels.
13. `goalOwnerOptions` offers "Your child" when the planner's neutral names include `kid`, even for
    a household with no children (minor; noted for the PR).
14. Split person labels on phone width wrap; amounts never leave `figHtml`.

## Done when (AC map)

1. AC1 (fields, migration, unchanged read-back): `test/goal-kinds.test.mjs` 1 to 10 and 13;
   `test/store-goal-kinds-migration.test.mjs` 1 to 3. Note: seed goals keep their display status
   text; "status open" applies to owner goals, and a seed goal reads done only when its display
   status is done or `done_at` is set.
2. AC2 (pace per kind, provenance): `src/calc/test/pace-kinds.test.mjs` 1 to 13;
   `test/goal-kinds-api.test.mjs` 7; `test/goal-kinds-home.test.mjs` 3 and 5 (board chips and
   reason). Floor and contribution have no monthly chart (`kind_not_charted`).
3. AC3 (editor and display, desktop and phone): `e2e/goal-kinds.spec.mjs` 1 and 2 on both
   projects; `test/goal-kinds-home.test.mjs` 1, 2, 4, 7, 9; screenshots attached.
4. AC4 (API and tools): `test/goal-kinds-api.test.mjs` 1 to 8; `src/mcp/test/actions.test.mjs`
   still passes; docs/ask-tools.md note.
5. AC5 (demo, one of each kind): `test/goal-kinds.test.mjs` 14; `test/goal-kinds-home.test.mjs` 9.
6. AC6 (tests): the six receipt files above, plus `src/mcp/test/actions.test.mjs`,
   `test/goals.test.mjs`, `src/calc/test/pace.test.mjs`, `test/pace.test.mjs` passing unchanged, and
   `test/tools.test.mjs`, `e2e/home.spec.mjs` passing with the listed behavior-site edits.
7. Full `npm test` and the full Playwright suite pass in CI on the pushed branch.

## Open questions for Brian (recorded in the PR, not blocking)

1. "Plan" read as the Goals screen plus Plan rows' Serves order (Risk 5).
2. Person ids `owner`/`spouse`/`joint` instead of `you` (decision 2).
3. Contribution pace uses a straight line from Jan 1 to the deadline; a lump-sum saver reads behind
   until the deposit. Alternative: report progress only, with no pace status, until the deadline.
4. Prior-year contributions made after Dec 31 are entered by hand (Risk 6).

## Deferred

Multiple named dependents beyond `household.names` keys; category-based exclusion of interest and
transfers from contributions; a monthly chart for floors and contributions; Ask goal proposals for
the new kinds (the chat proposal card stays balance only).

## Rebase onto origin/main 5e7dae7 (after the worker restart)

1. Migrations on main still end at 025; 026 stays.
2. `goalsForModel` and `list_goals` moved from `src/tools/index.mjs` to
   `src/tools/catalog/figures.mjs` (lines about 75 to 100 and 223). S1 item 8 applies there.
   `create_goal` and `edit_goal` stay in `src/tools/actions.mjs`. Workers re-locate every anchor in
   current source; an anchor that no longer resolves is re-found by its surrounding code, never
   dropped.
3. Coordinator constraint: a tool-catalog consolidation is being specced. Change only the existing
   goal tools' input fields (create_goal, edit_goal) and list_goals output; add no new goal tools.
   The docs/ask-tools.md note (S1 item 13) says so.
4. Host limits: streams run one after another (S1, S2, S3), one local test command at a time,
   Playwright once at the end on new or changed specs only.

## Plan review r1 resolutions (supersede the items they name)

1. Undo receipts versus lifecycle (finding 1). S1 item 6.1 stands (`done_at` in GOAL_FIELDS). Also,
   in `src/actions/receipts.mjs` `undoAction`, for `row.kind === 'goal'` the compared field list is
   the receipt's fields plus `archived_at` and `done_at`, each compared as `after?.[k] ?? null` (a
   receipt written before migration 026 has no `done_at`, read as null). A goal marked done or
   archived after a receipt therefore refuses undo with the existing conflict message. Test in
   test/goal-kinds-api.test.mjs: create a goal through `create_goal` (receipt), mark it done through
   `edit_goal {status:'done'}`, undo the create receipt: refused with conflict, goal row still
   present. Second test: an old-shape receipt whose after-state lacks `done_at` (insert it directly)
   also refuses after done.
2. Contribution coverage (finding 2). Replaces S2 item 2.2's basis rule. Transaction basis only
   when every destination account has at least one transaction dated from `<taxYear>-01-01` to the
   earlier of `<taxYear>-12-31` and the clock. Data-through is the earliest, across destination
   accounts, of each account's latest such transaction date. Freshness dependencies are those
   transactions (`{kind: 'bank_csv', asOf}` per account, the transaction import kind), never
   balances. Coverage rows (the latest transaction per account) are listed in provenance besides
   the qualifying rows. When some but not all destination accounts are covered: entered basis when
   `entered` exists, else unknown with reason `partial_contribution_coverage`. When none are
   covered (including prior-year-only transactions): entered basis, else `missing_contributions`.
   Tests in src/calc/test/pace-kinds.test.mjs (pure part) and test/pace.test.mjs or
   test/goal-kinds-api.test.mjs (store part): partial coverage, prior-year-only transactions, full
   coverage.
3. Qualifying contributions (finding 3). Replaces decision 7 and S2 item 2.2's row query. A
   qualifying row is a transaction with `amount > 0` into a destination account, dated in the tax
   year and on or before the clock, excluding (a) an internal move: an equal and opposite debit
   (same absolute amount to the cent) in another destination account within 5 days (the
   `transferDays` default of `resolveCategories`), matched one to one in date then id order; and
   (b) investment income: the imported category (`transaction_category_imports.category`) or the
   description matches `/\b(interest|dividends?|div(idend)? reinv\w*|capital gains?|cap gain)\b/i`.
   Transfers in from outside the destination set count (that is how contributions arrive; the
   resolver classes them `transfer`, so the resolved bucket is not used). The rule is a pure
   function `qualifyingContributions(rows, accountIds)` in `src/calc/pace.mjs` so it is unit
   tested. Docs (docs/architecture.md, Goal pace) state the rule and its limit: anything else
   credited to a destination account counts. Tests: interest row excluded, dividend reinvest
   excluded, a move between two destination accounts excluded on both sides, a plain deposit and an
   outside transfer counted.
4. Plan display and ordering (finding 4). Replaces S3 item 2.8. `servesHtml` (design.js about 1209)
   orders `serves` by the matching goal's priority (`orderServes`) and renders each served goal as
   its title link followed by `<span class="h-gtag" data-serve-owner>` (whose goal, when set),
   `<span class="h-gtag" data-serve-priority>` (priority, when set) and a short kind state from
   `kindLine` (`In range`, `Below floor`, `Holding`, `x of y contributed`) as plain text, amounts
   through `figHtml`. The scenario `pace.goals` entry for the goal is found by id. The Plan list
   sort (design.js about 862, `visibleRecs().slice().sort((a, b) => days(a) - days(b))`) becomes
   deadline days first, then the best priority rank among the rec's served open goals, then the
   existing order. Tests: test/goal-kinds-home.test.mjs (pure helpers `orderServes`,
   `planOrder(recs, goals)` exported from home-model.js and used by design.js); the e2e spec checks
   a Plan row's Serves chip at desktop and phone width when a demo rec serves a prioritized goal
   (the demo floor goal tracks business cash; a cash rec such as `reserve` serves it), else it
   checks Home and Goals only and the PR says so.
5. Canonical lifecycle status (finding 5). Replaces decision 6 and S1 item 5.2's status line.
   `loadGoals` sets `status` to `open`, `done` or `archived` for every goal: archived when
   `archived_at`; done when `done_at` or, for a seed goal, `def.status === 'done'`; else open. A seed
   goal's display text stays in its def and is exposed at read time as `statusLabel` (no JSON
   rewrite). Readers switched: `web/horizon/design.js` `goalCard` class (about 1327) uses
   `g.statusLabel || g.status`; `src/tools/catalog/figures.mjs` `goalsForModel` sends `status`
   (canonical) for every goal and `statusLabel` for seed goals; `openGoal`, `wantsSuggestion`,
   home-model's live filter and `buildPace`'s seed filter keep comparing to `'done'` and stay
   correct. `src/pace/build.mjs` filters `g.status !== 'done'` on the raw def, unchanged. The
   migration test asserts seed goals read back with status open (or done for the done seed goal),
   `statusLabel` equal to the old text, and every other field identical. validateGoal's `status`
   values are the same three.
6. Contribution deadline (finding 6). Validation rejects a contribution `targetDate` on or before
   `${taxYear}-01-01` (`the deadline must be after January 1 of the tax year`). Test in
   test/goal-kinds.test.mjs.
7. Editor redraw (finding 7). `goalInput` redraws the form on the `change` event of
   `shareOwner`, `shareSpouse` and the entered-mode inputs (change fires on leaving the field, so
   typing keeps focus), keeping the draft values; the per-person entered inputs appear once a share
   is set. The e2e spec enters shares, then per-person progress, without reopening the editor.
8. Seed goal tool detail (finding 8). Replaces S1 item 8.3's origin split. `goalsForModel`
   serializes every kind's fields for both origins: range `{low, high}`, floor `{amount}`,
   contribution `{taxYear, deadline, accounts, split, entered}` and `target`, with `source: 'plan'`
   for seed values and `'you'` for owner values; `entered` always carries `source: 'you'`
   (an entered amount is a person's statement; for the seed demo goal it is synthetic demo text).
   test/goal-kinds-api.test.mjs asserts the demo contribution goal's complete `list_goals` entry.
