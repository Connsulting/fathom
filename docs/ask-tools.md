# Ask and MCP tool catalog

This is the plan for Fathom's deterministic tool layer: twenty shared intent-level tools and one
Ask-only visualization tool, each with a small closed set of operations and typed parameters, that compute every figure Ask and an MCP client
need and put every household read and write the API can do in the agent's reach. It replaces both
the registry on main (30 tools) and the previous revision of this plan (55 planned tool names in
28 tickets). It extends the frozen tool interface in
[architecture.md, section 8](architecture.md#8-tool-interface). Status: planned. Nothing here is
built until its ticket in section 7 merges.

The design rule, stated first because everything else follows from it: one tool per question a
person asks, with its operations as a closed enum and its parameters typed; no tool is a router
over unrelated domains. Every tool's description and schema together stay under about 8,000
tokens, measured by a test (see "Design rule").

Owner direction, 2026-11-07:

> "Should we have a smaller number of tools that have more available parameters to them? ... I
> just know that it can lead to a little bit of MCP bloat. I don't know if too many tools make it
> hard for the agent to pick which one, whereas a smaller number of tools with more flexible
> parameters allows it to conceptualize what the right tool is."

> "What I meant by having a tool call for every API is that for every action the API can do, we
> need a tool call that can also do that. Not necessarily that we have to have a one-to-one
> mapping between API calls and MCPs though."

The earlier direction still holds:

> "One of the core reasons we're building Fathom is the power of an agent combined with the
> structured data, deterministic API and tools of a financial tool. We need to provide far richer
> MCP tools, both to our internal Ask and to MCP. That will make Ask extremely powerful because I'm
> not asking it to do ad hoc numeric calculations. That's the whole reason we're structuring data
> in Fathom. I expect a lot more out of Ask. Lean very heavily on immensely rich internal MCP and
> API calls."

The trigger. Asked "What is my yearly spending, excluding mortgage and income tax but including
healthcare, so I can back into the investment balance I need", Ask called `get_figures`,
`get_pace`, `query_transactions` three times with text and category filters, and `list_accounts`.
It never looked at card accounts or categories, and it could only list raw checking outflows
because no deterministic spending sum exists. This plan assumes the owner's next two questions
are "What investment balance would cover that at a 4 percent withdrawal rate?" and "How far am I
from that, and when would I get there at my current savings rate?" (Q02 and Q03 below).

## Risks and external dependencies

Calendar estimate: about four to six calendar days end to end at up to five parallel workers. Each
ticket is one agent run plus CI and one cross-provider review. The date is set by the owner's
merge gate (two open PRs first, then every ticket), by C1, which is one large ticket every other
ticket waits on, and by the four-deep chain C1, C3, C6, C7. C0, the grader adjudication, runs
beside C1 and merges before any live run is used to judge a tool ticket. Section 7 gives the waves.

1. C1 is the critical path. It changes the registry shape and renames all 30 live tools in one
   ticket, with every caller, because the repository forbids aliases and compatibility paths: a
   loader that served old-shape and new-shape tools side by side would be one. Nothing else can
   start until it merges, so wave 1 has only C1 and the small grader ticket C0. It is mostly mechanical (call sites in about
   30 test files and the eval catalog), but its review and CI time are the first day.
2. Owner merges first. PR #84 (T16, eval cases; green) must merge before C1 starts so that C1
   re-points the whole eval catalog once (section 8). PR #83 (T3, account tax treatment
   constants; green) should merge now; C5, C6 and C7 need it. If the owner closes either instead,
   the dependent tickets cannot start, and section 8 or the treatment constants must be redone.
3. Open PRs on shared files. PR #76 (Ask everywhere) edits `src/tools/index.mjs`,
   `src/tools/catalog/transactions.mjs` and `src/api/answerer.mjs`, all of which C1 rewrites; it
   adds an `ids` argument to `query_transactions`. Whichever of #76 and C1 merges second rebases,
   and `transactions.search` carries `ids` if #76 is on main when C1 starts. PR #79 (bounded
   category and Confirm suggestions) edits `src/categories/store.mjs` and `src/ingest/confirm.mjs`,
   which C8 also edits; the second to merge rebases.
4. Context budget. The estimate for the full design here is about 26,000 of the 30,000-character
   ceiling (section "Design rule"), after declaring the shared Ref, Assumption and Operand shapes
   loosely in schemas and fully in the handlers and rules. Every ticket after C1 runs the budget
   test. A ticket that would cross the ceiling shortens descriptions or schema text inside its own
   operations; no ticket raises the ceiling.
5. External MCP clients. Tool names change on the first deploy after C1, with no aliases. Any MCP
   client configuration that allowlists Fathom tools by name needs the new names, and the
   deployment's MCP smoke list (kept in the deployment repository, outside this one) must change
   in the same rollout. Nothing in this repository can do that; it is a deploy step.
6. Operation-level scopes. A write tool can hold operations under different scopes (`answer` has
   `write:facts` and `write:confirm` operations). The MCP server reads `operation` before argument
   validation to decide permission, and a key's listed schema shows only the operations it may
   call. Keys and their stored scopes do not change.
7. Grounding of assumptions. The answerer drops argument echoes (a result leaf under an argument's
   key with an equal value). An assumption's `stated` text ("4%") therefore lives under
   `provenance.assumptions[].stated`, a key no argument uses; C3 tests that a stated assumption
   and a `calculate` result both ground through `groundAnswer`. An assumption with source `owner`
   carries the owner's words as `evidence`.
8. Routing quality is a hypothesis. Fewer tools with operations is expected to route better than
   55 narrow tools; the tier 1 evals (CI) prove the calls a scripted answer makes are valid, not
   that a live model picks them. The tier 2 run (`npm run eval:ask:live`, never in CI, spends
   against the engine cap) is the check, run by the coordinator after C4 merges and again at the
   end. It is not a ticket gate.
9. A noisy grader. In the full live run at `2393850`, nine cases called the required tool, or no
   tool, with zero self-computed figures and still failed on "unsourced" numbers (section 8, group
   3). Until C0 settles what the grader counts as a sourced number, a live pass count measures the
   grader as much as the tools, so no tool ticket is judged on a live run taken before C0 merges.
10. Migration numbering. C10 adds one table. Its number is set at merge time per AGENTS.md rule 7.
11. Cost of re-evaluating references. A reference re-runs its read call server-side. Depth is
    capped at 3 and every read is bounded by the household store size, so a chained answer costs
    a few extra milliseconds at household scale.

## Design rule

1. One tool per question a person asks. A tool is named for the thing the question is about
   (`spending`, `retirement`, `accounts`) or, for writes, the change the person asks for
   (`update_account`, `categorize`, `answer`). A read tool's operations answer different
   questions about the same subject; a write tool's operations make different changes to the
   same subject.
2. Operations are a closed enum. Every tool takes a required `operation` argument whose schema is
   an `enum` of its operation names. A tool with one operation still takes it (`transactions`
   takes `operation: 'search'`, `undo` takes `operation: 'undo'`), so every call names a
   (tool, operation) pair and evals, refs, parity and permissions all key on that pair. For
   `calculate` the operation is the arithmetic operator.
3. Parameters are typed. A tool's schema is the union of its operations' parameters with
   `additionalProperties: false`. Within one tool a parameter name has exactly one schema and one
   meaning. The registry validates per operation: an argument the operation does not use, or a
   missing argument the operation requires, is `bad_input` naming the operation.
4. No router. A tool never dispatches over unrelated domains: no `fathom` tool with an `action`
   argument, no `read` or `write` catch-all. Reads and writes never share a tool, so Ask can keep
   offering write tools only for the chat purpose and MCP can mark read tools `readOnlyHint`.
5. At most eight operations per tool, except `calculate`, whose enum is arithmetic. A tool that
   needs a ninth operation is two questions and splits.
6. Schemas compile under strict Ajv (`createRegistryServer` in `src/engine/tools.mjs`): no type
   arrays, `anyOf` for unions, no `oneOf` per operation, no `$ref`. Shared shapes (Ref, Assumption,
   Operand) are declared loosely in schemas (`type: 'object'` with their top-level keys) and fully
   in the handler validation and in the rules (section 4), which keeps the budget.
7. Descriptions are generated. A tool header states the purpose in one sentence; the loader
   appends one line per operation, `name (parameters): summary`, from the operation definitions.
   A tool description is at most 900 characters; an operation summary at most 140.
8. The first operation in a read tool's enum needs no argument besides `operation` (except
   `calculate`), so the MCP smoke can call every read tool.

Context budget. Every tool's name, description and input schema together, as `tools/list`
returns them to a key holding every scope, stay under about 8,000 tokens. The measure is a
character count as a proxy: `test/tools-registry.test.mjs` (C1) builds the tool list for a key
with every scope through `toolsForScopes`, serializes `[{ name, description, inputSchema }]` with
`JSON.stringify`, and fails above 30,000 characters (8,000 tokens at 3.75 characters per token, a
conservative ratio for JSON schema text). The same test fails on a description over 900
characters, and on the assembled routing and rule text (section 4) over 8,000 characters. It
prints the measured totals so a ticket's PR can quote them. Today's 30 tools measure 12,633
characters.

Why this shape. The owner asked for fewer, more flexible tools so the agent can tell which one
applies, and for every API action to be reachable without a tool per route. Rejected: one tool
per route or per narrow question (the previous revision's 55 names: the bloat the owner named);
one generic tool with an action argument (the model cannot see what it does, and scopes and evals
lose their key); `oneOf` per operation in the schema (doubles schema size, and strict Ajv and
several MCP clients handle top-level `oneOf` poorly).

How tools register (C1). `src/tools/tools.mjs` declares the twenty tool headers once: `name`,
`kind` (`read` or `write`), `purpose`, `progress` (the plain progress label Ask shows while the
tool runs) and `source` (the plain source label for figures it grounds). Each module in
`src/tools/catalog/` exports `operations`, a list of `{ tool, name, scope, summary, route,
params, required, referenceable?, routes, handler }`, plus optional `rules` (lines for section 4)
and `capabilities`. Ask-only modules may export `askRules`, omitted from MCP instructions. `route` is the question-shape line for the routing table; `routes` lists the
API routes the operation covers (`'POST /api/accounts/:id/name'`). The loader in
`src/tools/index.mjs` merges operations into their tools, refuses a duplicate operation, a
parameter name with two schemas in one tool, or an operation whose scope does not match its
tool's kind, and lists only tools with at least one operation. A ticket adds its own catalog
modules and can contribute operations to any tool. The rich-answer integration adds `askOnly` headers, which MCP neither lists nor calls; their first operation may require arguments. Other tickets never edit `src/tools/index.mjs`,
`src/tools/tools.mjs` or `src/tools/parity.mjs`.

## 1. Question taxonomy

Questions in an independent-professional household's words. Q01 is the trigger question verbatim,
Q02 and Q03 its assumed follow-ups. Q66, Q67 and Q68 are questions Fathom must answer with
"Fathom does not have that": a security pick (advisory boundary), a live market quote (no market
data feed) and money movement (read-only accounts).

| ID | Area | Question |
|---|---|---|
| ID | Area | Question |
|---|---|---|
| Q01 | Spending and budgets | What is my yearly spending, excluding mortgage and income tax but including healthcare, so I can back into the investment balance I need |
| Q02 | Retirement and independence | What investment balance would cover that at a 4 percent withdrawal rate? |
| Q03 | Retirement and independence | How far am I from that, and when would I get there at my current savings rate? |
| Q04 | Spending and budgets | What do we spend on groceries and dining out each month? |
| Q05 | Spending and budgets | How much of our spending is essential and how much is discretionary? |
| Q06 | Spending and budgets | Who are our ten biggest merchants this year? |
| Q07 | Spending and budgets | How much did we spend on childcare in 2025? |
| Q08 | Spending and budgets | How much did we spend on healthcare last year, premiums included? |
| Q09 | Spending and budgets | What is our spending in my elective spending definition? |
| Q10 | Spending and budgets | Remember elective spending as everything except housing, childcare, healthcare and taxes. |
| Q11 | Cash flow | What was our net cash flow each month this year, with the business kept separate? |
| Q12 | Cash flow | How much did we move from the business to our personal accounts this year? |
| Q13 | Cash flow | Which months this year did more go out than came in? |
| Q14 | Cash flow | What is our savings rate over the last twelve months? |
| Q15 | Income by source | How much income came in this year, by source? |
| Q16 | Income by source | What is our average monthly take-home pay over the last year? |
| Q17 | Business P&L | What is the business's profit year to date, and its margin? |
| Q18 | Business P&L | How does business revenue this year compare with the same months last year? |
| Q19 | Business P&L | What were the biggest business expense categories last quarter? |
| Q20 | Net worth | What is our net worth today, split into cash, investments, retirement and debt? |
| Q21 | Net worth | How has our net worth changed over the last twelve months? |
| Q22 | Net worth | How much do we have in retirement accounts compared with taxable brokerage? |
| Q23 | Retirement and independence | If we keep saving at our current rate, what will our investments be worth in ten years? |
| Q24 | Retirement and independence | How much would we need to save each month to hit the target by the time I am 55? |
| Q25 | What-ifs | If returns are 3 percent instead of 4, when would we reach the target? |
| Q26 | What-ifs | What target do we need at a 3.5 percent withdrawal rate? |
| Q27 | What-ifs | If we saved $1,000 more a month, how much sooner would we reach the target? |
| Q28 | Account tax treatment and access | What is $15 million in retirement accounts worth after tax compared with $15 million in a brokerage account? |
| Q29 | Account tax treatment and access | When can each of us take money out of retirement accounts without a penalty? |
| Q30 | Account tax treatment and access | When do required minimum distributions start for each of us? |
| Q31 | Retirement and independence | If I stop working at 50, do we have enough outside retirement accounts to get to 59 and a half? |
| Q32 | Account tax treatment and access | Which of our accounts are pre-tax, Roth or taxable? |
| Q33 | Account tax treatment and access | How much unrealized gain is in our brokerage accounts, and what tax would selling everything trigger? |
| Q34 | Taxes and safe harbor | What will we owe in federal and state income tax this year? |
| Q35 | Taxes and safe harbor | Are our estimated payments on track for safe harbor, and when is the next one due? |
| Q36 | Taxes and safe harbor | How much would an extra $20,000 of business income add to our tax bill? |
| Q37 | Taxes and safe harbor | How much self-employment tax am I paying this year? |
| Q38 | Contribution room | How much more can I put into my solo 401(k) this year, employee and employer? |
| Q39 | Contribution room | Can we still contribute to traditional or Roth IRAs for this year, and how much? |
| Q40 | Contribution room | How much HSA room is left this year? |
| Q41 | Contribution room | How much have we put into the 529 this year, and how much of it is deductible on the state return? |
| Q42 | Contribution room | What is our dependent care FSA limit, and have we used it? |
| Q43 | Goals and pace | Are we on pace for our goals? |
| Q44 | Goals and pace | How many months of spending does our cash cover? |
| Q45 | Recurring charges and subscriptions | What subscriptions are we paying for, and what do they cost a year? |
| Q46 | Recurring charges and subscriptions | What new recurring charges started in the last three months? |
| Q47 | Recurring charges and subscriptions | Which recurring charges stopped or changed amount since summer? |
| Q48 | Comparisons across periods | Did we spend more this year than last year, and in which categories? |
| Q49 | Comparisons across periods | How does this summer's spending compare with last summer? |
| Q50 | Comparisons across periods | Is our dining spending up compared with six months ago? |
| Q51 | What-ifs | What will our yearly spending look like after the mortgage is paid off? |
| Q52 | What-ifs | What happens to our spending when childcare ends? |
| Q53 | Obligations | When does our mortgage end, and what is the monthly payment? |
| Q54 | Obligations | When will childcare costs change for each child? |
| Q55 | Obligations | When do our 529 contributions stop? |
| Q56 | Data health and freshness | Is all our data up to date? Which accounts are stale? |
| Q57 | Data health and freshness | How many transactions are uncategorized or only guessed? |
| Q58 | Data health and freshness | Which accounts have no transaction history? |
| Q59 | Actions | Change the brokerage account that lists my spouse as owner to me. |
| Q60 | Actions | Categorize the warehouse club charges as groceries from now on. |
| Q61 | Actions | Mark the credit union 1099-INT as not needed this year; we closed that account. |
| Q62 | Actions | Lock in the middle salary option in the salary decision. |
| Q63 | Actions | Archive the kitchen remodel goal. |
| Q64 | Actions | Send the S corp salary recommendation to our advisor for review. |
| Q65 | Actions | Sync the bank accounts now. |
| Q66 | Out of scope | Which index fund should I buy with my bonus? |
| Q67 | Out of scope | What is the S&P 500 at right now? |
| Q68 | Out of scope | Pay this quarter's estimated tax from checking. |

## 2. Answer plans

Calls are in order. `spending.total {measure: 'spending'}` means a call to the `spending` tool
with `operation: 'total'` plus the arguments shown. `R(Qnn x)` means a figure reference (section
3) to figure `x` of that question's call, copied from the figure's own `ref` field. An assumption
argument is `{value, source, evidence}`; its name and unit come from the parameter. The model's
part is always: choose the calls, state the assumptions with their source, explain, report the
gaps. It never computes. "Window" below is `spending_window` unless stated.

| ID | Calls | Model's part |
|---|---|---|
| Q01 | `spending.total {measure: 'spending', window: 'spending_window', annualize: true, groupBy: 'class', exclude: {categories: ['Mortgage', 'housing'], classes: ['debt_service'], buckets: ['tax']}}`. No include: healthcare stays in because it is household spending and is not excluded; the `healthcare` group shows its amount. `definition: 'core_living'` selects the same rows. | State the yearly total, the window, that healthcare is in (with its group figure), and what was left out with `excluded[].matched` amounts (mortgage payments, income tax). Report every gap: uncategorized and guessed rows with amounts, card or other spending accounts with no history, and the `outside_household_ledger` gap that premiums paid through payroll or a business account are not in household transactions. |
| Q02 | `retirement.target {spending: R(Q01 total), withdrawalRate: {value: 0.04, source: 'owner', evidence: '4 percent withdrawal rate'}}` | Name the spending figure it divides (Q01's), the rate as the owner's, and the rounding to the next thousand. Say the target inherits Q01's gaps. |
| Q03 | Same `retirement.target` call as Q02 (re-run, same arguments) | Report `gap`, `months` and `projectedDate`. State the defaults it used: real return 4 percent (default), monthly savings from recent data (window named), and which accounts count as invested now. If status is `no_savings` or `too_long`, say so instead of a date. |
| Q04 | `spending.total {measure: 'spending', include: {categories: ['Groceries', 'groceries', 'Dining & Drinks', 'dining']}, groupBy: 'month'}`, then the same with `groupBy: 'category'` | Report the monthly figures and the split. Note that warehouse-club rows may sit under Shopping (gap: classified by category, not merchant). |
| Q05 | `spending.total {measure: 'spending', definition: 'essential', annualize: true}` and `spending.total {measure: 'spending', definition: 'discretionary', annualize: true}` | Report the two totals as returned (each is one figure over its whole include set) and say what each definition contains, citing the spending pack entry. |
| Q06 | `spending.total {measure: 'spending', window: 'ytd', groupBy: 'merchant', limit: 10}` | List the ten groups and the `other` group. Merchants are normalized descriptions. |
| Q07 | `spending.total {measure: 'spending', window: 'calendar_year', year: 2025, include: {classes: ['childcare']}}` | Report the total; if `incomplete_month` or `account_no_history` gaps cover part of 2025, say how much of the year is on file. |
| Q08 | `spending.total {measure: 'spending', window: 'calendar_year', year: 2025, include: {classes: ['healthcare']}, groupBy: 'category'}` | Report the total and the premium category. State the `outside_household_ledger` gap: premiums withheld from pay or paid by the business do not appear. |
| Q09 | `spending.total {measure: 'spending', definition: 'elective_spending', annualize: true}` (the Ask context lists saved definitions by name and id, so no lookup call is needed; MCP clients call `spending.definitions` first) | Resolve "my elective spending" to the saved definition, even in a later conversation than the one that saved it. Say which selectors the definition applies. |
| Q10 | `update_preferences.save_definition {definitionId: 'elective_spending', name: 'Elective spending', def: {exclude: {classes: ['housing', 'debt_service', 'childcare', 'healthcare', 'taxes']}}, evidence: <the owner's words>}` (chat purpose; never `update_preferences.remember` for a definition) | Confirm what was saved with the receipt and Undo, and that it is remembered as a preference that names the definition. Offer to compute it. |
| Q11 | `spending.cash_flow {window: 'ytd', scope: 'all'}` | Read the monthly inflow, outflow and net for household and business, and the transfers between them, from the result. |
| Q12 | `spending.cash_flow {window: 'ytd', scope: 'all'}` | Report `totals.transfersBusinessToHousehold`. Say transfers are matched pairs within five days. |
| Q13 | `spending.cash_flow {window: 'ytd', scope: 'household'}` | Name the months whose `net` figure is negative. |
| Q14 | `spending.total {measure: 'income', window: 'trailing_12'}`, `spending.total {measure: 'spending', window: 'trailing_12'}`, then `calculate.divide {operands: [{expr: {operation: 'subtract', operands: [R(income total), R(spending total)]}}, R(income total)], label: 'savings rate'}` | State the rate as a share of household income, and that business retained earnings are not counted. |
| Q15 | `spending.total {measure: 'income', window: 'ytd', groupBy: 'merchant'}` and `business.pnl {window: 'ytd', groupBy: 'none'}` | Separate household deposits by payer from business revenue. Say owner distributions are transfers, not income, unless the business account is the source. |
| Q16 | `spending.total {measure: 'income', window: 'trailing_12'}` | Report `perMonth`. Say it is deposits to household accounts, after withholding. |
| Q17 | `business.pnl {window: 'ytd', groupBy: 'none'}` | Report profit and margin per entity. |
| Q18 | `business.pnl {window: 'ytd', groupBy: 'month', compareToPriorYear: true}` | Report `revenue`, `prior.revenue`, `prior.revenueDifference` and `prior.revenueRatio` as returned. |
| Q19 | `business.pnl {window: 'custom', from: '2026-07', to: '2026-09', groupBy: 'category'}` | Pick last quarter's months from today's date; list the largest expense groups. |
| Q20 | `accounts.net_worth {groupBy: 'part'}` | Report the total and the parts; name carried accounts (stale balances carried forward). |
| Q21 | `accounts.net_worth {series: true, months: 12}` then `calculate.subtract {operands: [R(last point total), R(first point total)], label: 'net worth change'}` | Report the change; mention carried accounts at the ends of the series. |
| Q22 | `accounts.net_worth {groupBy: 'treatment'}` | Report the pre-tax, Roth and taxable group totals as returned. A difference between them is a `calculate.subtract` call, never a mental one. |
| Q23 | `retirement.target {}`, then `retirement.growth {solve: 'balance', balance: {ref: R(investedNow)}, monthlyContribution: {ref: R(monthlySavings)}, years: 10}` | State the real return default and that the result is in today's dollars. |
| Q24 | `retirement.target {}` (default spending), then `retirement.growth {solve: 'monthly', balance: {ref: R(investedNow)}, target: {ref: R(target)}, byAge: {person: 'owner', age: 55}}` | State the target source and assumptions. If the owner's birth date or age is missing, say so and offer to record it. |
| Q25 | `retirement.target {realReturn: {value: 0.03, source: 'owner', evidence: 'returns are 3 percent'}}` and the default call, then `calculate.subtract {operands: [R(months at 3%), R(months at 4%)], label: 'months later'}` | Report both dates and the difference in months. |
| Q26 | `retirement.target {withdrawalRate: {value: 0.035, source: 'owner', evidence: '3.5 percent withdrawal rate'}}` | Report the target; note the rate is inside the allowed range of 2 to 6 percent. |
| Q27 | `retirement.target {}`, then `retirement.target {monthlySavings: {expr: {operation: 'add', operands: [R(monthlySavings), {assumption: {name: 'extraMonthlySavings', value: 1000, unit: 'usd_per_month', source: 'owner', evidence: '$1,000 more a month'}}]}}}`, then `calculate.subtract` on the two `months` figures | Report both dates and the months saved. |
| Q28 | `tax.estimate {}`, then `retirement.after_tax {hypothetical: [{treatment: 'pretax', value: {value: 15000000, source: 'owner', evidence: '$15 million in retirement accounts'}}, {treatment: 'taxable', value: {value: 15000000, source: 'owner', evidence: '$15 million in a brokerage account'}}], ordinaryRate: {ref: R(marginal.federal)}, stateRate: {ref: R(marginal.state)}, capitalGainsRate: {ref: R(marginal.capitalGains)}}`. No basis is passed: the owner stated none. | Report the pre-tax row's after-tax value. For the brokerage row, `taxOnWithdrawal` and `afterTax` come back unavailable with a `no_cost_basis` gap: say the tax depends on the cost basis and ask for it; never supply one. Explain where the tax shows up and when the money can come out, citing the treatment pack. Never call one better. |
| Q29 | `retirement.access {people: 'both'}` | Read each milestone with its pack citation (59 and a half, rule of 55, Roth basis, HSA at 65). |
| Q30 | `retirement.access {people: 'both'}` | Report the RMD start age and date per person and the birth-year rule cited. |
| Q31 | `retirement.bridge {retireAge: {value: 50, source: 'owner', evidence: 'stop working at 50'}, person: 'owner', spending: R(Q01 total)}` or with `definition: 'household_spending'` | Report spending needed until access age against accessible money, the shortfall or surplus, and the exceptions the tool notes. Recommend nothing. |
| Q32 | `accounts.net_worth {groupBy: 'treatment'}` | List the accounts per treatment from the groups; name accounts whose treatment is inferred from kind. |
| Q33 | `tax.estimate {}`, then `retirement.after_tax {kinds: ['taxable', 'brokerage'], ordinaryRate: {ref: R(marginal.federal)}, stateRate: {ref: R(marginal.state)}, capitalGainsRate: {ref: R(marginal.capitalGains)}}` | Report unrealized gain and the tax figure; state the `missing_fact` gap for positions with no cost basis. |
| Q34 | `tax.estimate {}` | Report federal, state and self-employment projections, kind and as-of; say they come from the last planning run. |
| Q35 | `tax.estimate {}` and `household.deadlines {from: today}` | Report required, paid and remaining safe-harbor amounts and the next due date. |
| Q36 | `tax.estimate {whatIf: {extraIncome: {value: 20000, source: 'owner', evidence: 'an extra $20,000 of business income'}, incomeType: 'business'}}` | Report `whatIf.totalDelta` and its parts. |
| Q37 | `tax.estimate {}` | Report `federal.selfEmployment`. |
| Q38 | `tax.room {person: 'owner', types: ['solo401k_pretax', 'solo401k_employer', 'employee_deferral']}` | Report limit, used and remaining per type, and the deadline. |
| Q39 | `tax.room {person: 'both', types: ['traditional_ira', 'roth_ira']}` | Report remaining room and the deadline; say when income limits apply (pack). |
| Q40 | `tax.room {types: ['hsa']}` | Report remaining room; say coverage type comes from the stored fact. |
| Q41 | `accounts.list {}`, then `spending.total {measure: 'inflow', window: 'ytd', include: {accounts: [<529 account ids>]}}`, then `tax.room {types: ['plan529_state_deduction']}` | Report contributions and the deductible part; cite the state pack. |
| Q42 | `tax.room {types: ['dependent_care']}` | Report the limit; say payroll elections are outside the household ledger (gap) so used is unknown. |
| Q43 | `goals.pace {}` | Report each goal's pace as returned. |
| Q44 | `accounts.net_worth {groupBy: 'part'}`, `spending.total {measure: 'spending'}`, then `calculate.divide {operands: [R(part cash), R(spending perMonth)], label: 'months of cover'}` | Report months of cover; name the accounts counted as cash. |
| Q45 | `spending.recurring {status: 'active'}` | List the charges with cadence and annual cost, and the total. |
| Q46 | `spending.recurring {status: 'new', since: <date three months ago>}` | Pick the date from today; list new charges. |
| Q47 | `spending.recurring {status: 'all', since: '2026-06-01'}` | List stopped charges and those whose `changed` is set. |
| Q48 | `spending.compare {measure: 'spending', a: {window: 'custom', from: '2025-01', to: '2025-10'}, b: {window: 'custom', from: '2026-01', to: '2026-10'}, groupBy: 'category'}` | Choose matching complete months; report the difference and the largest group deltas. |
| Q49 | `spending.compare {measure: 'spending', a: {window: 'custom', from: '2025-06', to: '2025-08'}, b: {window: 'custom', from: '2026-06', to: '2026-08'}}` | Say which months "summer" means (an assumption, source default). |
| Q50 | `spending.compare {measure: 'spending', include: {categories: ['Dining & Drinks', 'dining']}, a: {window: 'custom', from: '2026-02', to: '2026-04'}, b: {window: 'custom', from: '2026-08', to: '2026-10'}}` | State the three-month windows chosen and report the ratio. |
| Q51 | `spending.projection {definition: 'household_spending', years: 10, obligations: ['mortgage']}` | Report the payoff year and the spending after, as returned; say the stated escrow continues as housing (pack). If `obligations.mortgage` is missing, the change is unavailable: report the gap and offer to record the fact. |
| Q52 | `spending.projection {definition: 'household_spending', years: 15, obligations: ['childcare']}` | Report each change date and new amount, and how each was derived. A change whose new amount is not stated (no `obligations.childcare` stage amount and no owner assumption) is listed as unavailable and not applied; say so and offer to record it. |
| Q53 | `spending.obligations {obligations: ['mortgage']}` | Report end date, monthly payment and the derivation (stated payoff date or amortization). |
| Q54 | `spending.obligations {obligations: ['childcare']}` | Report each child's change dates and the pack rule used. |
| Q55 | `spending.obligations {obligations: ['plan529']}` | Report the end dates and the college-age assumption. |
| Q56 | `household.health {}` | List stale accounts with last data dates and ages. |
| Q57 | `household.health {}` | Report uncategorized and guessed counts; offer the Confirm items. |
| Q58 | `household.health {}` | List accounts whose `lastData` is empty. |
| Q59 | `accounts.list {}`, then `update_account.owner {id, owner: 'owner'}` (chat purpose) | Pick the account by name and current owner; if two match, ask which. Confirm with the receipt. |
| Q60 | `transactions.search {text: 'warehouse', limit: 5}`, then `categorize.merchant_rule {merchant: <normalized merchant from a row>, category: 'Groceries'}` | Confirm the rule and how many rows it reclassified. |
| Q61 | `household.health {}` (its `yearend.items` lists each expected document's key and issuer), then `answer.yearend_mark {itemKey: <that item's key>, reason: 'Account closed this year'}` | Pick the item by issuer and form; use the owner's reason in their words. |
| Q62 | `recommendations.list {}`, then `act_on_recommendation.decide {decisionId, point: 1}` | Name the point decided and its figures from the result. |
| Q63 | `goals.list {}`, then `update_goal.archive {id}` | Confirm with the receipt. |
| Q64 | `recommendations.list {}`, then `advisor_review.send {recId}` | Confirm it is waiting on the advisor. |
| Q65 | `refresh.run_job {job: 'simplefin-sync'}` | Report the run status; if the connection is not set up, give the in-app link to Settings. |
| Q66 | none | Say Fathom does not have that: it does not select securities. Offer what it does have (contribution room, account treatment). |
| Q67 | none | Say Fathom does not have that: it has no live market data; holdings values are as of the last import. |
| Q68 | none | Say Fathom does not have that: it never moves money. Offer `tax.estimate` and the due date. |

## 3. Tool catalog

### Figure envelope

Every number a read operation returns is a figure:

```
{ value, unit, label, kind, asOf, window?, quote, ref, provenance, gaps }
```

1. `value`: a finite number, an ISO date string when `unit` is `date`, or null when the figure
   is unavailable (then `unavailable` holds the gap code and the gap explains it).
2. `unit`: `usd`, `usd_per_month`, `usd_per_year`, `ratio`, `days`, `months`, `years`, `age`,
   `date`, `count`. Percents are never a unit. A `ratio` result is any finite number (a growth of
   1.4, a negative change of minus 0.2); bounds belong to rate arguments, not to results.
3. Precision by unit: `usd`, `usd_per_month` and `usd_per_year` round to cents (`round` from
   `src/calc/pace.mjs`); `ratio` is not rounded (full double precision; `stated` and `quote` text
   show 6 significant digits at most); `months` is an integer when it counts calendar months and
   a projection's months round up to the next whole month, as `dated` does; `years` round to 2
   decimals; `days` round to 2 decimals; `age` is an integer or a half year (59.5); `count` is an
   integer. Rounding happens once, when the figure is built, never on an input that feeds another
   figure (`calculate` works on the unrounded inputs and rounds its own result).
4. `label`: plain words, no digits, as the current `calc:targets` figures do.
5. `kind`: the existing letters: `a` actual, `p` projected, `e` estimate, `m` model, `t` target.
6. `asOf`: the latest data date the figure depends on (the newest row, balance or planner run it
   reads), not today.
7. `window`: `{ from: 'YYYY-MM', to: 'YYYY-MM', months }` when the figure covers a period.
8. `quote` (C3): the figure as the answer must write it, built by `envelope` from `value` and
   `unit`: digits, never words; `$12,345.67` for money, unsigned, with `direction: 'out'` beside
   it for money leaving the household (the answer says "spent" or "paid", never a minus sign);
   `4%` for a ratio shown as a percent, `18 months`, `2031-06`, `59 and a half`. A stored figure
   from `household.figures` keeps its `{f:key}` token as `token`, and `quote` is that token. This
   closes the live failure where the model restated or recomputed a stored figure (section 8).
9. `ref`: the figure reference that reproduces this figure (see below), filled in by the tool so
   the model copies it rather than composing one. Every figure a referenceable operation returns
   carries one.

T1 (merged) built `figure`, `envelope`, `fromStored` and `fromPace` in `src/calc/figure.mjs`, and
`get_figures` and `get_pace` already return envelopes beside their old fields. C1 moves those to
`household.figures` and `goals.pace` with their refs re-pointed:
`ref: { tool: 'household', args: { operation: 'figures', keys: [key] }, path: '0' }` and
`ref: { tool: 'goals', args: { operation: 'pace' }, path: <dotted path>.envelope }`. C3 adds
`quote` and `direction` in `envelope`, so every producer gets them at once.

### Provenance and data gaps

```
provenance = { calc, formula, inputs: [ { ref?, value, unit, label } ],
  sources: [ { table, ids (first 50), count } ], accounts: [ { id, label } ],
  assumptions: [ { name, value, unit, source: 'owner'|'preference'|'fact'|'default', note, stated, evidence? } ],
  packRefs: [ { packId, entryId } ], steps: [ { label, formula, value } ] }
gaps = [ { code, message, amount?, count? } ]
```

1. `accounts` carry labels and masks only, never account numbers.
2. `assumptions[].stated` is the assumption as text ("4%", "$1,000 a month") so it can ground.
   `evidence` is the owner's words for an owner-sourced assumption. `name` and `unit` come from
   the parameter the assumption was passed in (or from the operand, inside `calculate`).
3. `packRefs` name the pack entry that states each rule the figure applies.
4. Gap codes: `uncategorized_rows`, `guessed_rows`, `account_no_history`, `incomplete_month`,
   `stale_account`, `outside_household_ledger`, `missing_fact`, `carried_balance`,
   `unclassified_category`, `no_cost_basis`, `unequal_periods`. `amount` and `count` appear when
   the tool can measure the gap. A gap never changes the figure; the tool reports what it left out.
5. A result's top-level `gaps` is the union of its figures' gaps, deduplicated by code and message.

### Figure references and chaining

MCP is stateless per request, so references are re-evaluable, not session handles.

1. A `ref` is `{ tool, args, path }`: a read call (its `args` include `operation`) and a dotted
   path to a figure in its result (`total`, `groups.2.figure`, `federal.projected`,
   `series.11.total`).
2. `calculate` and the operations whose parameters accept an Operand (`retirement.target`,
   `retirement.growth`, `retirement.after_tax`, `retirement.bridge`, `spending.projection`)
   re-run the referenced call server-side with the same `ctx` (same store, same clock) through
   `callTool`, take the figure at `path`, and append its provenance as an input.
3. Only operations marked `referenceable` can be referenced. A ref to a write tool, to an unknown
   tool or operation, or to a path that is not a figure is `bad_input`.
4. Nesting depth is at most 3 (a ref whose call holds a ref whose call holds a ref). Refs to
   `calculate` are allowed; that is chaining.
5. Literal numbers enter only as named assumptions with a source. A tool never accepts a bare
   number where a figure belongs.
6. `source: 'fact'` requires `factKey`; the tool reads that fact and refuses a value that differs.
   `source: 'preference'` requires `preferenceId` and checks the preference exists.
   `source: 'default'` is accepted only when the value equals the operation's documented default.
   `source: 'owner'` requires `evidence`, the owner's words. In Ask the tool checks the value
   against the owner's messages of this conversation and refuses otherwise; over MCP the evidence
   is kept verbatim in provenance and checked against itself. The check is
   `assumptionStated(value, unit, statements)` in `src/tools/assumption-evidence.mjs` (C3), not
   `requireEvidence`, which compares bare numbers (so "4 percent" yields 4 and a rate of 0.04
   would fail). Normalization, deterministic: for `ratio` units, a number followed by `%`,
   `percent`, `per cent` or `pct` (optional space) maps to the number divided by 100, and a bare
   decimal below 1 ("0.04") maps to itself; both forms are accepted and compared within 1e-9. For
   `usd` units, the amounts and magnitudes `statedAmounts` reads (`$`, commas, `k`, `thousand`,
   `m`, `million`), compared to the cent. For `age` and `years`, a whole or half number ("59 and a
   half", "59.5"). Statements come from `ctx.ownerStatements()`, which C2 wires to
   `ownerStatements` in `src/actions/evidence.mjs`. Without `ctx.ownerStatements`, Ask refuses
   owner assumptions and MCP checks the value against `evidence` alone.
7. Every referenceable operation fills `ref` on each figure it returns; `assertRefsResolve`
   (T1, `test/helpers/figures.mjs`) re-evaluates every ref in a result and asserts an equal
   figure, and every read ticket runs it over its results.

### Scopes and MCP behavior

1. Every read operation has scope `read`. Each write operation names its own scope; the scopes
   are the existing six plus the six C2 adds (section 6). Keys keep their stored scopes.
2. A tool is listed to a key when the key holds the scope of at least one of its operations. The
   listed schema's `operation` enum holds only those operations, and the description still lists
   all of them so the model can say what it cannot do with this key.
3. A call names an operation outside the key's scopes: the result is an `isError` text starting
   `Permission denied: <tool>.<operation> needs the <scope> scope` before any other argument
   validation. An unknown operation is `bad_input` listing the tool's operations. Every ticket
   that adds a write operation tests that a read-only key gets the denial for it.
4. MCP lists tools sorted by name, with `readOnlyHint` true for read tools and false for write
   tools; `destructiveHint` stays false (the one destructive operation, `update_account.merge`,
   needs `confirm: true` and the owner's confirming words).
5. Ask runs the same registry through `createRegistryServer`. Read tools are offered for every
   purpose that offers tools today; write tools, including `undo`, only for purpose `chat`.
   MCP offers `undo` to a key with any write scope and checks the receipt's scope on each call.
6. Results carry account masks only, resolve scenario tokens to plain text and never include
   hidden recs (existing rules).
7. Write results carry the ask-actions receipt `{ id, scope, label, before, after, actorId, ts,
   undone, planningPending }` plus `undo: { available, tool?, args?, reason? }`. When `available`
   is true, `tool` is `undo` and `args` is `{ operation: 'undo', id: <receipt id> }`; there are no
   per-scope undo tools and no domain-inverse undo calls. A receipt kind whose undo is a domain
   inverse (a decision decide is undone by a revisit, a Confirm answer by a reopen, a pack toggle
   by the opposite toggle) registers a `restore` hook that performs that inverse (C2's
   `registerReceiptKind`). When false, `reason` says why.
8. Undo checks the receipt's scope against the caller's scopes after loading the receipt and
   before anything else, and refuses another person's change or an item edited since (existing
   rules).

### Limits

1. `calculate`: at most 20 operands per expression, expression depth at most 6.
2. Refs: nesting depth at most 3 across all tools.
3. Group lists: `limit` default 25, max 200, plus an `other` group so groups always sum to the
   total.
4. Periods: at most 120 months (`MAX_MONTHS` in `src/accounts/trend.mjs`).
5. A tool description is at most 900 characters, an operation summary at most 140, and the whole
   listed catalog at most 30,000 characters (Design rule).
6. A tool result is at most 256 KB of JSON; past that the tool truncates its longest list and sets
   `truncated: true`.

### Shared argument types

| Type | Shape |
|---|---|
| Period | `window`: `spending_window` (default), `trailing_12`, `ytd`, `calendar_year`, `custom`; `year` (integer 2000..2100, required with `calendar_year`); `from`, `to` (`YYYY-MM`, required with `custom`, span at most 120 months). `from` and `to` given without `window` mean `custom`. |
| Selector | `{ buckets?: Bucket[], categories?: string[] (max 50), classes?: Class[], accounts?: string[] (max 50), merchants?: string[] (normalized, max 50) }` |
| Bucket | `household`, `business`, `income`, `transfer`, `tax`, `saving`, `excluded` (`BUCKETS`) |
| Class | `housing`, `debt_service`, `healthcare`, `childcare`, `essential_other`, `discretionary`, `unclassified`, `savings`, `taxes`, `business`, `income`, `transfer`, `excluded` (section 5) |
| Assumption | `{ value: number, source: 'owner', 'preference', 'fact' or 'default', evidence? (required for owner), factKey? (required for fact), preferenceId? (required for preference), note? (max 200) }`. Name and unit come from the parameter. |
| Operand | exactly one of `{ ref: Ref }`, `{ assumption: Assumption plus name (1..60) and unit }`, `{ expr: { operation, operands, places?, rate?, years? } }` |
| Ref | `{ tool, args: object (with operation), path }` |
| Rate bounds | Each rate parameter has its own range: `withdrawalRate` 0.02..0.06; `realReturn` minus 0.05..0.10; `ordinaryRate`, `capitalGainsRate`, `stateRate` 0..0.6. `calculate` operands and every result are unbounded finite numbers. |

A parameter typed "Assumption or Operand" accepts either shape; the handler tells them apart by
their keys.

### Catalog at a glance

Twenty-one tools: twelve read, including Ask-only `show`, and nine write. "Ticket" is the ticket
that adds the operation (section 7).

| Tool | Kind | Operations (ticket) |
|---|---|---|
| `household` | read | summary, facts, fact_shapes, figures, deadlines (C1); health (C5); confirm_items (C8); imports (C10) |
| `accounts` | read | list, holdings (C1); detail, net_worth (C5); merge_candidates (C8) |
| `transactions` | read | search (C1; filters C4) |
| `spending` | read | total, compare, definitions, cash_flow, recurring (C4); obligations, projection (C7) |
| `business` | read | pnl (C1; upgraded C4); rows (C4) |
| `tax` | read | estimate, room (C5) |
| `retirement` | read | target, growth, after_tax (C6); access, bridge (C7) |
| `goals` | read | list, pace (C1); suggestions (C9) |
| `recommendations` | read | list, detail, advisor (C1), wargame (B5) |
| `knowledge` | read | packs, search, entry (C1) |
| `show` | Ask-only read | chart, table, compare, timeline; validated references to earlier calls, stored snapshots and dropped notes |
| `calculate` | read | add, subtract, multiply, divide, sum, min, max, negate, annualize, monthly, percent_of, round_up, compound (C3) |
| `update_account` | write | rename, mask, owner, kind, merge (C8) |
| `categorize` | write | transaction, merchant_rule (C8) |
| `answer` | write | fact (C1); rec_questions, confirm, reopen, yearend_mark (C8) |
| `act_on_recommendation` | write | status, owner, step (C1); start_over, decide, revisit, pick_point (C9) |
| `advisor_review` | write | send, verdict, checkin, packet (C9) |
| `update_goal` | write | create, edit (C1); archive, delete, suggestion (C9) |
| `update_preferences` | write | remember (C1); curve (C9); forget, save_definition, delete_definition, pack (C10) |
| `refresh` | write | import_file, retry_import, build_your_plans, run_job (C10) |
| `undo` | write | undo (C1) |

Every operation below lists its parameters (`?` optional), its scope, what it returns and the old
names it replaces, live (on main) or planned (the previous revision). Section 9 has the complete
old-to-new table.

### Read tools

#### `household`

Purpose: what Fathom knows about the household and how complete and current it is. Progress
label "Looking at your household".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| summary | none | the `household_summary` result, unchanged | live `household_summary` |
| facts | `keys?` (string[], max 500) | the `get_facts` result, unchanged | live `get_facts` |
| fact_shapes | none | accepted fact keys and their typed answer shapes for `answer.fact` | live `get_fact_answer_shapes` |
| figures | `keys?` (string[], max 500) | stored figures with their `get_figures` fields plus the envelope; referenceable | live `get_figures` |
| deadlines | `from?`, `to?` (`YYYY-MM-DD`) | calendar deadlines sorted by date, unchanged | live `list_deadlines` |
| health | `accounts?` (ids, max 50) | freshness, last import, category coverage, unavailable figures, pending Confirm, year-end documents, jobs; count figures referenceable | planned `data_health` |
| confirm_items | `status?` (`pending` default, `answered`, `all`), `kinds?` (string[]), `ids?` (integer[], max 500) | the Confirm queue | planned `list_confirm_items` |
| imports | none | imported files with id, name, status, parser and counts, newest first | new (covers `GET /api/files`) |

Scope: read. Behavior changes in C1: `facts` takes up to 500 keys (was 200), because one tool has
one schema for `keys`.

`health` result: `{ accounts: [ { id, label, mask, kind, lastData, freshness:
'fresh'|'stale'|'unknown', ageDays, source } ], lastImport: { fileId, name, at, status } or null,
categories: { rows, uncategorized, guessed, corrected, queueSize } (count figures),
unavailableFigures: [ { key, label, reason } ], pendingConfirm: { total, byKind }, yearend: {
year, items: [ { key, form, issuer, status: 'received'|'missing'|'marked' } ] }, jobs: [ { id,
lastRun, status } ], gaps }`. Reuses `freshnessOf`, `accountFreshness`
(`src/ingest/freshness.mjs`), `categoryCoverage` (`src/categories/store.mjs`), `pendingItems`
(`src/ingest/confirm.mjs`), `yearendChecklist` (`src/yearend/expected.mjs`),
`figures.unavailable_reason`, and the job list `listJobs` reads.

`confirm_items` result: `{ items: [ { id, kind, question, options: [ { id, label } ], context
(masks only), status, answer?, final? } ] }`. Reuses `queueAccountPairs`, `queueCategoryChecks`,
`listItems`, `getItem`, `finalReason`.

#### `accounts`

Purpose: accounts, balances, holdings and net worth. Masks only. Progress label "Looking at your
accounts".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| list | none | accounts with latest balance and its date, unchanged | live `list_accounts` |
| detail | `id` | one account: the `accountDetail` result (`account`, `fresh`, `asOf`, `trendKey`, `feeds`, `syncable`) with its balance as a figure | new (covers `GET /api/accounts/:id`) |
| holdings | `id?` (account id) | positions with symbol, name, quantity, price, value, cost basis | live `list_positions` (its `accountId` becomes `id`) |
| net_worth | `accounts?` (ids, max 50), `includeBusiness?` (default true), `groupBy?` (`part` default, `group`, `treatment`), `series?` (default false), `months?` (1..120, default 12) | `{ total, groups: [ { key, label, figure, accounts } ], series?: [ { month, total, groups } ], carried: [ { id, label, lastDate } ], gaps }`; referenceable | planned `net_worth` |
| merge_candidates | `id` | `{ items: [ { id, label, inst, kind, mask, lastDataDate, mirror, plan: { keepId, keepLabel, moves }, refused? } ] }` | planned `list_merge_candidates` |

Scope: read. `net_worth` gives `carried_balance` gaps for balances carried forward; `treatment`
groups use `ACCOUNT_TREATMENT` (PR #83) by account kind, overridden by the `accounts.planType`
fact (C7); a `retirement` or `ira` account without one is named in a `missing_fact` gap. Reuses
`buildTrend`, `groupOfKind`, `PARTS`, `GROUPS` (`src/accounts/trend.mjs`), `accountFreshness`,
`mergePlan`, `accountMergeCandidates`.

#### `transactions`

Purpose: find transaction rows to show examples. It never sums; totals come from `spending`.
Progress label "Looking through your transactions".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| search | `accountId?`, `from?`, `to?` (`YYYY-MM-DD`), `minAmount?`, `maxAmount?`, `category?`, `text?` (1..200), `limit?` (1..200, default 50); `ids?` when PR #76 is on main; from C4 also `bucket?` (Bucket), `class?` (Class), `merchant?` (normalized, 1..200), `cursor?` (the `next` of an earlier page) | `{ rows: [ { id, accountId, date, amount, description, category } ], truncated, total }`; from C4 each row also has `bucket`, `class`, `layer`, `merchant`, and the result has `next` (a date-and-id keyset cursor, as `GET /api/accounts/:id/transactions` pages) while rows remain | live `query_transactions` |

Scope: read. `category` in C4 rows is the resolved category and `layer` the `resolveCategories`
layer (`correction`, `import`, `guess`, `uncategorized` and so on). The answerer's special
handling of `query_transactions` rows (unsigned amounts for grounding, row-named sources) moves to
`transactions` in C1.

#### `spending`

Purpose: spending, income and cash flow from categorized transactions, with every gap reported.
Progress label "Adding up your spending".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| total | `measure?`, `groupBy?`, `include?`, `exclude?` (Selector), `definition?`, Period fields, `annualize?`, `scope?`, `limit?` | one total plus groups; referenceable | planned `aggregate_transactions` |
| compare | as `total` without the Period fields, plus `a`, `b` (Period objects) | difference, ratio and group deltas; referenceable | planned `compare_periods` |
| definitions | none | built-in and saved spending definitions | planned `list_spending_definitions` |
| cash_flow | Period fields (default `ytd`), `scope?` (default `all`) | monthly inflow, outflow, net and business transfers; referenceable | planned `cash_flow` |
| recurring | `status?`, `since?`, `cadence?`, `scope?`, `minOccurrences?`, `limit?` (default 50) | repeating charges with cadence and annual cost; referenceable | planned `recurring_charges` |
| obligations | `obligations?` (`mortgage`, `childcare`, `plan529`; default all), `horizonYears?` (1..40, default 30), `changes?` | each obligation's amount now, end or change dates, new amounts and derivation; referenceable | planned `obligation_schedule` (its `kinds` becomes `obligations`) |
| projection | `base?` (Ref) or `definition?`, `years?` (1..40, default 10), `obligations?`, `changes?` | yearly spending forward with each obligation applied on its date; referenceable | planned `spending_projection` |

Scope: read. Ticket: C4 for the first five, C7 for `obligations` and `projection`.

`total` parameters:

| Name | Type | Default | Notes |
|---|---|---|---|
| `measure` | `spending`, `income`, `outflow`, `inflow`, `net` | `spending` | spending: household-bucket outflows on spending accounts less matched transfers (the `spendingInputs` semantics); income: income-bucket inflows on spending accounts; outflow and inflow: every negative or positive row on in-scope accounts, any bucket, matched transfers left out; net: inflow minus outflow |
| `groupBy` | `none`, `bucket`, `category`, `class`, `merchant`, `account`, `month` | `none` | merchant uses `normalizeMerchant` |
| `include` | Selector | none | restricts: a row must match every given field (any value within a field) |
| `exclude` | Selector | none | removes: a row matching any given field is dropped |
| `definition` | slug | none | a built-in or saved definition, merged with `include` and `exclude`; explicit arguments win field by field and the conflict is a note |
| Period fields | Period | `spending_window` | `spending_window` is the `resolveSpendingWindow` complete-month window |
| `annualize` | boolean | false | total over the window divided by its months times 12; unit becomes usd_per_year |
| `scope` | `household`, `business`, `all` | `household` | business accounts via `businessAccount` and the `accounts.businessEntity` fact; for `business`, spending means business-bucket outflows on business accounts |
| `limit` | integer 1..200 | 25 | groups beyond it fold into `other` |

`total` result:

```
{ total: Figure, perMonth: Figure, months, window,
  groups: [ { key, label, figure } ], other?: Figure,
  excluded: [ { selector: {field, value}, matched: Figure, removed: Figure } ],
  definition?: { id, name, source: 'builtin'|'saved' },
  notes: [string], gaps: [Gap] }
```

`total` is one figure over the whole selection, however many classes or categories the include
set names (the `essential` definition returns one total for its five classes).
`excluded[].matched` is every window outflow on in-scope accounts that matches the selector, in or
out of the measure's base, so the model can say "income tax payments of X were left out" even
when taxes were never household spending; `removed` is the part that left the total. Groups always
sum to `total`. Gaps: `uncategorized_rows` and `guessed_rows` with amount and count (from the
`guess` and `uncategorized` layers), `account_no_history` for spending accounts that are silent or
have no complete month (card accounts included), `incomplete_month` when the window is shorter
than requested, `outside_household_ledger` when the result includes healthcare and the facts show
W-2, S corp or self-employment income, `unclassified_category` for household rows whose category
has no class. The pure aggregation lives in `src/calc/aggregate.mjs`; `spendingInputs` and
`total` share one row selection so `total {measure: 'spending'}` over the spending window equals
`spendingInputs().spendTotal` exactly (a test asserts it). Reuses `resolveSpendingWindow`,
`spendingInputs`, `isBusinessAccount` (`src/calc/targets.mjs`), `resolveCategories`,
`matchTransfers`, `normalizeMerchant`, `businessAccount` (`src/categories/resolve.mjs`),
`loadCategoryInputs` (`src/categories/store.mjs`), `CATEGORY_CLASSES` and `BUILTIN_DEFINITIONS`
(T2, `src/calc/classes.mjs`). Definitions resolve through `resolveDefinition(db, id)` in
`src/spending/definitions.mjs` (C4 creates it for built-ins; C10 adds saved rows).

`compare` result: `{ a: { total, window }, b: { total, window }, difference: Figure (b minus a),
ratio: Figure (b over a, absent when a is zero), groups: [ { key, label, a, b, difference } ],
gaps }`. `unequal_periods` gap when the month counts differ (the model should then pass
`annualize: true` or matching months). `limit` applies to the union of groups.

`definitions` result: `[ { id, name, source: 'builtin'|'saved', def: { include?, exclude? },
packRef?, preferenceId?, updatedAt? } ]`. Built-ins: `household_spending`, `essential`,
`discretionary`, `core_living` (section 5).

`cash_flow` result: `{ months: [ { month, household: { inflow, outflow, net }, business: {
inflow, outflow, net }, transfersBusinessToHousehold, transfersHouseholdToBusiness } ], totals: {
same fields }, gaps }`, every number a figure. A transfer between a business and a household
account is a pair `matchTransfers` finds across the two sides; it appears only in the transfer
fields, never in inflow or outflow.

`recurring` parameters: `status` (`active` default, `new`: first seen on or after `since`,
`stopped`: expected date passed by more than one cadence with no charge, `all`); `since`
(`YYYY-MM-DD`, default 90 days before today); `cadence` (`monthly`, `quarterly`, `annual`; any by
default); `scope` (default `household`); `minOccurrences` (2..12, default 3, 2 for annual).
Detection: outflows grouped by `normalizeMerchant`; cadence from the median gap between charges
(monthly 25 to 35 days, quarterly 80 to 100, annual 350 to 380); amount stable when every charge
is within 10 percent of the median; `changed` set when the last two charges differ by more than 10
percent; matched transfers are never recurring charges. Result: `{ charges: [ { merchant,
cadence, occurrences, firstDate, lastDate, nextExpected, typicalAmount (usd), annualCost
(usd_per_year), amountStable, changed?: { from, to, on }, status, account: { id, label } } ],
totalAnnual, gaps }`. New pure detector `src/calc/recurring.mjs`.

`obligations` parameters: `changes` is an array of `{ kind, stage?: 'school_age'|'after_care_end',
newMonthly: Assumption (usd_per_month) }`, max 10: owner-stated amounts for a change the facts do
not cover. Result: `{ obligations: [ { kind, label, monthly (usd_per_month), changes: [ { stage,
date, newMonthly (unavailable when no source), reason, derivedFrom:
'fact'|'amortization'|'birth_date'|'pack_default'|'assumption' } ], endDate or null, missing: [
factKey ] } ], gaps }`. Amounts, in order of precedence:

1. Monthly amount now: the obligation's class group over the spending window (mortgage from
   `debt_service`, childcare from `childcare`, 529 from inflows to 529 accounts), or
   `obligations.mortgage.monthlyPayment` when stated (the fact wins; the data figure is a note).
2. Mortgage after payoff: the payment drops to `obligations.mortgage.escrowMonthly` (a required
   field of that fact; the owner may say zero), which continues as housing.
3. Childcare at each stage: `obligations.childcare.schoolAgeMonthly` and
   `obligations.childcare.afterCareEndMonthly` (zero by default at the after-care end, from the
   pack: care costs stop), else an owner `changes` assumption, else `newMonthly` is unavailable
   with a `missing_fact` gap naming `obligations.childcare`.
4. 529 at college start: contributions stop (new amount zero, pack default).

Dates come from the facts in section 5 and `OBLIGATION_RULES` (T2). New
`src/calc/obligations.mjs` holds the amortization and age rules.

`projection` result: `{ years: [ { year, spending (usd_per_year), changes: [ { kind, date, delta,
applied } ] } ], gaps }`, in today's dollars with no inflation (a note says so). Base rule: a
change subtracts only the part of the obligation that is inside the base. The tool re-runs the
base's selection (the definition's selectors, or the referenced `spending.total` arguments)
restricted to the obligation's class, and the in-base monthly amount times twelve is the most a
change can remove. A base that already excludes `debt_service` (such as `core_living`) gets no
mortgage drop and a note says why. A `base` ref to any operation other than `spending.total` is
`bad_input`. A change whose new amount is unavailable is listed with `applied: false` and its gap,
and the spending figure keeps the current amount.

#### `business`

Purpose: business profit and loss per entity. Progress label "Looking at your business numbers".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| pnl | `entity?`, `from?`, `to?` (`YYYY-MM`); from C4 also `window?` (`ytd` default, `trailing_12`, `calendar_year`, `custom`), `year?`, `groupBy?` (`none`, `month` default, `category`), `compareToPriorYear?` | C1: the `pnl_by_month` result unchanged. C4: `{ entities: [ { entity, revenue, expenses, profit, margin (ratio), groups: [ { key, revenue, expenses, profit } ], prior?: { revenue, expenses, profit, margin, revenueDifference, revenueRatio, profitDifference, profitRatio } } ], gaps }`, every number a figure; referenceable | live `pnl_by_month`, planned `business_pnl` |
| rows | `section` (`income`, `expenses`), `category`, `entity?`, `from?`, `to?`, `month?` | the `businessPnlRows` result: the workbook lines and transactions behind a P&L figure | new (covers `GET /api/pnl/rows`) |

Scope: read. C4 builds `pnl` on `businessPnl` and `rows` on `businessPnlRows`
(`src/pnl/business.mjs`, the functions `GET /api/pnl` and `GET /api/pnl/rows` call), so the agent
and the Money screen read one implementation. Revenue is the sum of positive lines, expenses the
negated sum of negative lines, margin profit over revenue (absent at zero revenue).
`incomplete_month` when the period's last month has no lines yet. `from` and `to` alone keep
meaning a custom period, so C1's calls stay valid after C4. C1's `pnl` is `pnl_by_month` moved
unchanged: it reads workbook lines (`pnl_lines`) only, so `GET /api/pnl`, which also derives P&L
from categorized transactions, counts as covered from C4. C4 exports the capability
`businessPeriods`, which the eval cases that use the C4 parameters require.

#### `tax`

Purpose: taxes and contribution room for the supported tax year. Progress label "Looking at your
taxes".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| estimate | `year?` (2026 only), `whatIf?` (`{ extraIncome?: Assumption (usd), extraDeduction?: Assumption (usd), incomeType: 'business'|'wages'|'other' (default business) }`) | federal, state and SE tax, safe harbor, payments, next due date, marginal rates, what-if deltas; referenceable | planned `tax_estimate` |
| room | `person?` (`owner`, `spouse`, `both` default), `types?` (`employee_deferral`, `solo401k_pretax`, `solo401k_employer`, `sep`, `traditional_ira`, `roth_ira`, `hsa`, `dependent_care`, `plan529_state_deduction`; default all), `year?` | limit, used, remaining and deadline per person and type; referenceable | planned `contribution_room` |

Scope: read. Ticket: C5.

`estimate` result: `{ federal: { projected, selfEmployment, paid, withheld, remaining }, state: {
projected, paid, withheld, remaining }, safeHarbor: { federal: { required, paid, remaining },
state: { required, paid, remaining }, nextDueDate }, marginal: { federal, state, capitalGains }
(ratios), whatIf?: { federalDelta, stateDelta, selfEmploymentDelta, totalDelta }, gaps }`. Stored
figures (`tax.fed.proj`, `tax.fed.se`, `tax.fed.paid`, `tax.fed.withheld`, `tax.va.*`, `sh.fed.*`,
`sh.va.*`) come through as figures with the planner run's date as `asOf`. The what-if reruns the
household computation with the extra amount on the chosen line and returns differences only.
Reuses `householdTax` (`src/jobs/planner/household.mjs`), `federalIncomeTax`,
`selfEmploymentTax`, `virginiaIncomeTax`, `estimatedPaymentSafeHarbor` (`src/calc/index.mjs`),
`classifyPayments` (`src/jobs/planner/payments.mjs`).

`room` result: `{ rows: [ { person, type, limit, used or null, remaining or null, deadline (date),
basis: 'planner'|'calculator', packRefs } ], gaps }`. `remaining` comes from the stored planner
`room.*` figures when the last planning run is in this tax year; otherwise the limit comes from the
calculator and `used` is null with a `missing_fact` or `outside_household_ledger` gap (payroll
deferrals and FSA elections). Reuses `solo401kRoom`, `sepRoom`, `hsaLimit`, `dependentCareLimit`,
`employerLimit`, `TAX_2026`, `LAW_REFS`, `planningYear`.

#### `retirement`

Purpose: how much invested is enough, how it grows, what it is worth after tax and when it can
come out. It reports; it never recommends a strategy. Progress label "Working through your
retirement numbers".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| target | `spending?` (Ref, usd_per_year) or `definition?` (default `household_spending`), `withdrawalRate?` (Assumption, default 0.04), `invested?` (`{ kinds?, treatments?, accounts? }`), `monthlySavings?` (Assumption or Operand), `realReturn?` (Assumption, default 0.04), `roundTo?` (1 or 1000, default 1000) | `{ target, investedNow, gap, months or null, projectedDate or null, monthlySavings, status: 'covered'|'projected'|'no_savings'|'too_long', gaps }`; referenceable | planned `independence_target` |
| growth | `solve` (`balance`, `months`, `monthly`), `balance` (Assumption or Operand), `monthlyContribution?`, `realReturn?`, `years?` (0..60), `target?`, `byDate?` (`YYYY-MM-DD`) or `byAge?` (`{ person, age: 18..100 }`) | `{ figure }` (usd, months or usd_per_month) with `provenance.steps`; referenceable | planned `project_growth` |
| after_tax | `accounts?` or `kinds?`, `hypothetical?` (max 10 of `{ treatment, value: Assumption, basis?: Assumption, contributions?: Assumption }`), `ordinaryRate`, `capitalGainsRate`, `stateRate` (each Assumption or Operand, all required) | `{ rows: [ { treatment, accounts, value, basis, unrealizedGain, taxOnWithdrawal, afterTax, qualifiedFrom (date), afterTaxMedical?, afterTaxNonmedical?, whenTaxed, packRef } ], total: { value, afterTax }, gaps }`; referenceable | planned `after_tax_value` |
| access | `people?` (`owner`, `spouse`, `both` default) | `{ people: [ { person, born or unavailable, ageNow, milestones: [ { event, age, date, accounts, packRef } ] } ], gaps }`; referenceable | planned `access_schedule` |
| bridge | `retireAge?` (Assumption, age; default the `household.retireAge` fact, else required), `person?` (`owner` default, `spouse`), `spending?` (Ref) or `definition?`, `realReturn?` (Assumption, default 0) | `{ yearsToAccess, spendingUntilAccess, accessible: { taxable, cash, rothContributions, ruleOf55 }, shortfall, surplus, exceptions: [ { rule, note, packRef } ], gaps }`; referenceable | planned `bridge_check` |

Scope: read. Ticket: C6 for `target`, `growth` and `after_tax`; C7 for `access` and `bridge`.
Every operation reads the treatment constants PR #83 adds (`ACCOUNT_TREATMENT`,
`EMPLOYER_PLAN_TYPES`, `ACCESS_RULES`, `rmdStartAge` in `src/calc/treatment.mjs`).

`target`: exactly one of `spending` or `definition`; neither means `definition:
'household_spending'`, aggregated over `spending_window` and annualized through `spending.total`.
`monthlySavings` defaults to `spendingInputs` `monthlySavings`; `invested` defaults to
`INVESTMENT_KINDS`, non-business. `too_long` past `maxProjectionMonths` (600). Reuses
`independencePlan`'s formula, `monthsToReach`, `holdingsTotal`, `TARGET_PARAMETERS`
(`src/calc/targets.mjs`), `withdrawalRateOf` (`src/suggest/build.mjs`), `accountHistory`
(`src/pace/build.mjs`).

`growth`: `monthlyContribution` (default zero) for `balance` and `months`; `years` for
`balance`; `target` for `months` and `monthly`; `byDate` or `byAge` for `monthly`, where age
resolves from the birth date fact, else the age fact with a `missing_fact` note on month
precision. Future value of a balance plus an annuity, compounded monthly; `futureValue` and
`requiredMonthly` in `src/calc/growth.mjs` (C3).

`after_tax`: Fathom never assumes a tax rate; refs to `tax.estimate` marginal rates are the usual
source. Rules and missing inputs:

1. Pre-tax (traditional IRA, SEP, pre-tax 401(k), 403(b), 457(b)): ordinary plus state rate on
   the whole value. Needs nothing else.
2. Roth: tax-free once qualified. `qualifiedFrom` is the later of age 59 and a half and five
   years after `accounts.rothFirstContributionYear`; without that fact it is unavailable with a
   `missing_fact` gap, and `afterTax` is reported as the qualified value with a note that it
   holds only from that unknown date. The subtype comes from `accounts.planType`.
3. Taxable: capital gains plus state rate on value less basis, basis from
   `positions.cost_basis` (or a hypothetical's `basis`). When any position lacks basis, `basis`,
   `unrealizedGain`, `taxOnWithdrawal` and `afterTax` for that row are unavailable with a
   `no_cost_basis` gap counting the positions; nothing is assumed.
4. HSA: the row returns both `afterTaxMedical` (no tax) and `afterTaxNonmedical` (ordinary plus
   state, plus the 20 percent additional tax before 65 from the person's age), and `afterTax` is
   unavailable with a note to choose.
5. Cash: no tax on withdrawal.
6. An account whose kind does not fix its treatment (`retirement`, `ira`) uses
   `accounts.planType`; without it the row is unavailable with a `missing_fact` gap.

`access` events: `penalty_free_59_half`, `rule_of_55`, `roth_earnings_qualified`,
`hsa_nonmedical_no_penalty_65`, `rmd_start`. Inputs and what happens without them:

1. Birth date (`household.ownerBirthDate`, `household.spouseBirthDate`); without it, the age
   fact gives year precision (dates fall on December 31) with a `missing_fact` gap; without
   either, every milestone date is unavailable.
2. `rule_of_55` applies per account and only when both facts show it: `accounts.planType` is an
   employer plan (`401k`, `roth_401k`, `solo_401k`, `403b`, `457b`), and
   `accounts.separationDate` falls in or after the calendar year the person turns 55. IRA types
   never qualify. An employer plan with no separation date, or an account with no plan type, is
   not listed and is named in a `missing_fact` gap. The milestone date is the separation date
   itself (IRS Publication 575).
3. `roth_earnings_qualified` needs `accounts.rothFirstContributionYear` per Roth account; without
   it the milestone date is unavailable for that account with a gap.
4. `rmd_start` excludes Roth IRA and Roth 401(k) accounts (no lifetime RMD for the owner).

`bridge`: retiring at a stated age before access age, spending until access age against money
reachable without penalty.

1. `accessible.rothContributions` is the sum of `accounts.rothBasis`; a Roth account without it
   adds nothing and is named in a `missing_fact` gap.
2. `accessible.ruleOf55` counts an employer-plan balance only for an account that qualifies under
   `access`'s rule, and only from its separation date: a qualifying balance whose separation date
   is after the bridge's start (the date the person reaches `retireAge`) is excluded until that
   date, with a note. A retirement age of 55 or more is not enough by itself. Every other
   employer-plan balance stays out of accessible money, and each one missing a plan type or a
   separation date is named in a `missing_fact` gap.
3. `accessible.taxable` is the market value (selling has a tax cost; the note points at
   `retirement.after_tax`).
4. Exceptions listed as text with pack refs: substantially equal periodic payments and HSA
   reimbursement of past medical costs. They are never counted as accessible money.

#### `goals`

Purpose: household goals and their pace. Progress label "Looking at your goals".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| list | none | open goals with title, horizon, note, target and tracked value, unchanged | live `list_goals` |
| pace | none | the `buildPace` result with an `envelope` beside each pace figure; referenceable | live `get_pace` |
| suggestions | none | the `buildSuggestions` result: suggested targets per goal with their inputs | new (covers `GET /api/goals/suggestions`) |

Scope: read.

#### `recommendations`

Purpose: the recommendations in the plan. Hidden recommendations never appear. Progress label
"Looking at your plan".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| list | `status?` (a status or a list) | recommendations with live status, window, tasks, owner and goals served, unchanged | live `list_recommendations` |
| detail | `id` | one recommendation with figures, pack excerpts, owner, goals, unchanged | live `get_recommendation` |
| advisor | none | the advisor workflow: next check-in, waiting reviews, verdicts, packets, unchanged | live `advisor_status` |
| wargame | `name` (`salary` or `deferral`) | stored model options with referenceable figure envelopes, planner date, scenario status and decision, and the picked point id; missing stored fields are unavailable, not recomputed; `not_built` carries the planner reason and no points | stored war-game model |

Scope: read.

#### `knowledge`

Purpose: knowledge packs, the sourced tax and planning guidance. Progress label "Checking your
knowledge packs".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| packs | none | every pack with status, why, version, tax year, review date, coverage and entry titles | live `list_packs` and `packs_status` |
| search | `query` (2..200), `packId?`, `limit?` (1..20, default 10) | matching entries of active packs with snippets, the total and whether the list was cut, unchanged | live `search_pack_entries` |
| entry | `packId`, `file` (1..200) | one entry as markdown with its citations, unchanged | live `get_pack_entry` |

Scope: read. `packs` returns the `list_packs` rows, and each row's `status` is the live status
`packs_status` computes (`active`, `exploring`, `suggested`, `available`). A scenario pack row
with no manifest, which only `packs_status` listed, is included with `id`, `name`, `status` and
`why` only. C1 tests that every id and status `packs_status` returned on the demo store appears in
`packs` with the same status.

#### `calculate`

Purpose: the only arithmetic the model gets. Combines figures from refs and named assumptions into
one figure with chained provenance. Progress label "Working out the numbers".

| Operation | Parameters | Returns | Replaces |
|---|---|---|---|
| add, subtract (first minus the rest), multiply, divide (two operands), sum (one ref whose path is a list of figures, or many operands), min, max, negate, annualize (usd_per_month to usd_per_year), monthly (usd_per_year to usd_per_month), percent_of (ratio, base), round_up (with `places`), compound (future value, with `rate` and `years`) | `operands` (Operand[], 1..20), `places?` (1, 100 or 1000; `round_up` only), `rate?` (Operand, ratio per year; `compound` only), `years?` (Operand; `compound` only), `label` (1..80, no digits) | `{ figure }`; referenceable | planned `calculate` (its `op` becomes `operation`; nested expressions use `{ expr: { operation, operands } }`) |

Scope: read. Ticket: C3. Unit algebra is checked: usd plus usd is usd; usd times ratio is usd;
usd divided by ratio is usd; usd divided by usd is ratio; usd_per_year divided by a per-year ratio
is usd; usd divided by usd_per_month is months; months times usd_per_month is usd. Any other
mismatch is `bad_input` naming both units. Division by zero is `bad_input`. The figure's `kind` is
the weakest of its inputs (a, then e, m, p, t), `asOf` the oldest input `asOf`,
`provenance.inputs` holds every operand's figure and provenance, `provenance.formula` the
expression in words, `gaps` the union of the inputs' gaps. Q02 as a calculation:
`calculate.divide {operands: [{ref: R(Q01 total)}, {assumption: {name: 'withdrawalRate', value:
0.04, unit: 'ratio', source: 'owner', evidence: '4 percent'}}], label: 'investment needed'}`.
Reuses `round`, `figure` and `envelope` (`src/calc/figure.mjs`) and the ref resolver
`src/tools/refs.mjs` (C3) over `callTool`.

### Write tools

Every write operation records an action receipt through `saveReceipt` and shares the route
handler's store function, so the API and the agent cannot drift. Where a handler has its logic
inline, the ticket first moves that logic into a named store function and points the handler at
it. Every write tool is offered to Ask (chat purpose) and to MCP under each operation's scope.
"Receipt kind" names the kind the ticket registers through `registerReceiptKind` (C2) and how
`undo` restores it.

#### `update_account`

Purpose: change an account the way the account dialog does. Progress label "Updating your
account". Ticket: C8. Scope: `write:accounts` for every operation.

| Operation | Parameters | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|
| rename | `id`, `displayName` (string or null) | `{ account: { id, label }, receipt }` | `account_field` (the changed `accounts` columns) | planned `rename_account` |
| mask | `id`, `mask` (four digits) | `{ account, receipt }`; only on an account with no mask and no bridge identity | `account_field`; the restore re-runs `queueAccountPairs` | planned `set_account_mask` |
| owner | `id`, `owner` (`owner`, `spouse`, `joint`, `business`; `OWNER_OPTIONS`) | `{ account, receipt }` | `account_answer`, restore calls `undoAccountAnswer` with the receipt's before value | planned `set_account_owner` |
| kind | `id`, `kind` (`KIND_OPTIONS`: checking, cash, card, taxable, retirement, roth, hsa, 529, business, loan) | `{ account, receipt }` | `account_answer` | planned `set_account_kind` |
| merge | `id`, `withId`, `confirm` (literal `true`), `evidence` | `{ survivorId, itemId, receipt }` | `account_merge`, restore reopens the merge's Confirm item through `revertChanges` until a moved row changes | planned `merge_accounts` |

`merge` is the one destructive write. The caller passes it only after the person explicitly
confirmed this merge; in Ask that is a later owner message than the one where the model showed the
candidates from `accounts.merge_candidates`, and the tool checks it with `requireEvidence` against
`evidence`. Reuses `validateDisplayName`, `setAccountAnswer`, `undoAccountAnswer`, `afterAnswer`,
`queueAccountPairs`, `mergePlan`, `manualMerge`, with the `accountRename` and `accountMask`
writes moved into `src/accounts/write.mjs`.

#### `categorize`

Purpose: correct transaction categories. Progress label "Updating categories". Ticket: C8. Scope:
`write:categories`.

| Operation | Parameters | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|
| transaction | `transactionId` (integer), `category` (aggregator category name) | `{ transaction: { id, category, bucket, class }, receipt }` | `category_correction` (table `transaction_category_corrections` by `transaction_id`) | planned `set_transaction_category` |
| merchant_rule | `merchant` (normalized, 1..200), `category` | `{ rule: { merchant, category, bucket }, affected (count figure), receipt }` | `merchant_rule` (table `category_merchant_rules` by `merchant`) | planned `set_merchant_rule` |

The bucket follows the category through `sourceBucket`. The correction and merchant-rule writes
in `applyCategoryAnswer` move into `setTransactionCategory` and `setMerchantRule`
(`src/categories/store.mjs`); Confirm answers call the same functions.

#### `answer`

Purpose: tell Fathom something it asked for or needs: a household fact, a recommendation's
questions, Confirm items and expected tax documents, always in the person's own words. Progress
label "Recording what you told Fathom".

| Operation | Parameters | Scope | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|---|
| fact | `key`, `value`, `evidence`, `conversationKey?` | write:facts | the `record_household_fact` result, unchanged | `fact` (existing) | live `record_household_fact` |
| rec_questions | `recId`, `answers` (1..50 of `{ key, path?, value }`), `evidence` | write:facts | `{ rec, receipts, planningPending }` | `fact` per fact | planned `answer_recommendation_questions` |
| confirm | `items` (1..500 of `{ id, answer }`), `revise?` (one item only) | write:confirm | `{ items, receipt }` | `confirm_answer`, restore reopens the items through `revertChanges` | planned `answer_confirm_item` |
| reopen | `ids` (1..500) | write:confirm | `{ items, receipt }`; `changed_since` refusal when a row changed after the answer | `confirm_reopen`, restore re-answers with the prior answers | planned `reopen_confirm_item` |
| yearend_mark | `year?` (2000..2100), `itemKey` (1..200), `reason` (1..300, or null to clear) | write:confirm | `{ item: { key, marked, reason }, receipt }` | `yearend_mark` (table `yearend_marks` by year and key) | planned `mark_yearend_item` |

Tickets: C1 for `fact`, C8 for the rest. `fact` keys and shapes come from `household.fact_shapes`;
unknown keys are refused and an amount or date is never inferred. `rec_questions` keys must be in
`ANSWER_SHAPES` and in the rec's question; the body of `recAnswers` (`src/api/fact-answers.mjs`)
moves into `saveRecAnswers`. Reuses `answerFacts`, `answerItem`, `answerItems`, `reviseItem`,
`reopenItem`, `reopenItems`, `revertChanges`, `setMark`, `taxYearFor`, and the `afterAnswer`
replan and freshness triggers.

#### `act_on_recommendation`

Purpose: act on a recommendation or its decision. Progress label "Updating your plan".

| Operation | Parameters | Scope | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|---|
| status | `id`, `status` (`doing`, `done`, `dismissed`, `snoozed`, `proposed`), `wake?` | write:recs | unchanged | existing | live `set_recommendation_status` |
| owner | `id`, `owner` (`you`, `spouse`, `both`, `advisor`, `automatic`) | write:recs | unchanged | existing | live `set_recommendation_owner` |
| step | `id`, `index` (integer, zero-based), `checked` | write:steps | unchanged | `step` (existing) | live `set_recommendation_step` |
| start_over | `id` | write:recs | `{ detached (count figure), receipt }` | `rec_detach`, restore clears `rec_detached_at` on the threads it set | planned `start_recommendation_over` |
| decide | `decisionId`, `point?` (integer or point id) | write:decisions | `{ decision: { id, status, decidedLine }, receipt }` | `decision_decide`, restore revisits (it also removes the decided fact and replans) | planned `decide_decision` |
| revisit | `decisionId` | write:decisions | `{ decision: { id, status }, decidedIndex, receipt }` | `decision_revisit`, restore decides again on `decidedIndex` | planned `revisit_decision` |
| pick_point | `name` (`salary`, `deferral`), `point` (integer or point id) | write:decisions | `{ picked: { name, index, label }, receipt }` | `setting` (generic over `settings` by key) | planned `pick_wargame_point` |

Tickets: C1 for `status`, `owner` and `step`; C9 for the rest. The `recStartOver`,
`wargamePick`, `decisionDecide` and `decisionRevisit` logic moves into `detachRecThreads`
(`src/store/recs.mjs`) and `pickWargame`, `decide`, `revisit` (`src/decisions/write.mjs`).

#### `advisor_review`

Purpose: the advisor review workflow. The household records verdicts; nothing leaves the product.
Progress label "Updating the advisor review". Ticket: C9. Scope: `write:recs`.

| Operation | Parameters | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|
| send | `recId` | `{ reviewId, receipt }` | not available: a sent review is a record; a new verdict or review supersedes it | planned `send_to_advisor` |
| verdict | `reviewId`, `verdict` (`confirmed`, `vetoed`), `note?` (max 1000), `date` (`YYYY-MM-DD`), `evidence` | `{ review: { id, verdict, date }, receipt }`; a veto dismisses the rec | not available: it records an outside person's decision; send the rec again to reopen review | planned `record_advisor_verdict` |
| checkin | `date`, `time?` (`HH:MM`), `lengthMin?` (15..480) | `{ checkin, receipt }` | `advisor_checkin` (table `advisor_checkin`) | planned `set_advisor_checkin` |
| packet | none | `{ packetId, recIds, receipt }` | not available: a stored packet is a record | planned `create_review_packet` |

The verdict and note must come from the owner's words (`requireEvidence`). `packet` gets its
household vault from `ctx.services.vault()` (C2); `createPacket`'s body moves into `buildAndStorePacket`
(`src/advisor/packet.mjs`). Reuses `sendToAdvisor`, `recordVerdict`, `applyStatusAction` with
`VETO_REASON`, `setCheckin`, `storePacket`, `buildPacketHtml`.

#### `update_goal`

Purpose: create or change goals, with amounts and dates only from the person's words or stored
data. Progress label "Saving your goal". Scope: `write:goals`.

| Operation | Parameters | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|
| create | `title`, `note?`, `horizon?`, `target?`, `targetDate?`, `track?` | the `create_goal` result, unchanged | `goal` (existing) | live `create_goal` |
| edit | `id` plus any changed field above | the `edit_goal` result, unchanged | `goal` (existing) | live `edit_goal` |
| archive | `id` | `{ goal: { id, archived: true }, receipt }` | `goal` | planned `archive_goal` |
| delete | `id` (the owner's own goals only, as the route allows) | `{ deleted: id, receipt }` | `goal_row`, restore reinserts every column | planned `delete_goal` |
| suggestion | `id`, exactly one of `action` (`dismiss`, `restore`) or `withdrawalRate` (Assumption, 0.02..0.06) | `{ suggestion: { goalId, dismissed, withdrawalRate }, receipt }` | `setting` | planned `set_goal_suggestion` |

Tickets: C1 for `create` and `edit`, C9 for the rest. The consolidated tool is deliberately not
named `edit_goal`, so no live name keeps a new meaning. Writes move into `src/goals/write.mjs`
and `setGoalSuggestion` (`src/suggest/write.mjs`).

Goal model fields (feat/goal-model-v2, live in `create_goal`, `edit_goal` and `list_goals` before
C1; C1 and C9 carry them into `update_goal` and `goals` under these exact names):

1. `kind`: `balance` (the default), `range`, `floor` or `contribution`. A body field of another
   kind is refused; a kind change drops the old kind's fields.
2. `owner` (whose goal): `owner`, `spouse`, `joint`, a dependent key (`kid`, `kid2`, ...) or null.
   Labels come from the household names. Distinct from the row's `origin`.
3. `priority`: `high`, `medium`, `low` or null.
4. `status`: `open`, `done` or `archived`. `done` sets the `done_at` column and `open` clears it;
   every goal reads a canonical status, and a seed goal's display text is `statusLabel`.
5. Range: `targetLow`, `targetHigh` (low not above high), `targetDate`, `track`.
6. Floor: `floor`, `track` (required), no `targetDate`.
7. Contribution: `target` is the amount, `taxYear` (integer), `targetDate` is the deadline (after
   January 1 of the tax year), `accounts` (destination account ids, optional), `split`
   (optional `[{ person: 'owner'|'spouse', amount }]`, adding up to `target`), `entered`
   (optional `{ asOf, total }` or `{ asOf, people: [{ person, amount }] }`).

Every amount and date among them needs the person's words or a stored value, as `target` and
`targetDate` do; `owner`, `priority`, `kind` and `status` need none. `list_goals` adds `kind`,
`owner`, `ownerLabel`, `priority`, `status`, `statusLabel` and `range`, `floor` or `contribution`
objects with their sources; `get_pace` entries add `kind`, `owner`, `priority` and `range`, `floor`
or `contribution`. A goal receipt's undo also compares `done_at` and `archived_at`, and the
`goal_row` restore (C9) reinserts `done_at` with every other column.

#### `update_preferences`

Purpose: preferences, saved spending definitions, which packs are on and where the household sits
on its tradeoff curves. Progress label "Saving your preference". Scope: `write:preferences`.

| Operation | Parameters | Returns | Receipt kind and undo | Replaces |
|---|---|---|---|---|
| remember | `text` (1..300), `evidence`, `id?` (edit), `conversationKey?` | the `remember_preference` result, unchanged | `preference` (existing) | live `remember_preference` |
| forget | `id` | `{ receipt }` | `preference`, or `spending_definition` for a linked preference | planned `forget_preference` |
| save_definition | `definitionId` (slug 2..40, not a built-in), `name` (1..60), `def` (`{ include?: Selector, exclude?: Selector }`), `evidence` | `{ definition: { id, name, def, preferenceId }, receipt }`; at most 50 saved | `spending_definition`, restore puts back both rows as they were or removes both | planned `save_spending_definition` |
| delete_definition | `definitionId` (built-ins refused) | `{ deleted, receipt }` | `spending_definition` | planned `delete_spending_definition` |
| pack | `packId`, `active` (idempotent, unlike the toggle route) | `{ pack: { id, status }, wasActive, receipt }` | `pack_active`, restore sets `wasActive` back (the toggle also hides and unhides recs) | planned `set_pack_active` |
| curve | `positions` (`{ [axisId]: 0..1 }`, 1..20 axes) | `{ positions, receipt }` | `setting` | planned `set_curve_position` |

Tickets: C1 for `remember`, C9 for `curve`, C10 for the rest. Definition linkage, pinned (C10):

1. The migration adds `spending_definitions` and a nullable `preferences.definition_id` column
   with a unique index.
2. Saving a definition writes or updates exactly one linked preference in the same transaction,
   with text "When I say <name>, use my saved spending definition <id>." and `definition_id`
   set. Saving again with the same id and a new name or selectors updates both.
3. `remember` on a linked preference is refused with "Change the definition instead". `forget` on
   a linked preference deletes both rows (one receipt, kind `spending_definition`).
4. `delete_definition` deletes both rows.
5. Ask's dynamic context already lists every preference (`listPreferences` into
   `household_preferences`). The linked preference's text names the definition's id, and
   `listPreferences` gains `definitionId`, so a later conversation resolves "my elective
   spending" to `definition: 'elective_spending'` with no lookup and no answerer edit.

Reuses `writePreference` (`src/actions/preferences.mjs`), `saveReceipt`, `requireActor`,
`requireEvidence`, `validatePreference`, new `src/spending/definitions.mjs`, `packToggle` moved
into `setPackActive` (`src/packs/state.mjs`), `curveSet` moved into `setCurvePositions`
(`src/goals/curve.mjs`).

#### `refresh`

Purpose: bring new data into Fathom and recompute: import a file, retry one, rebuild the Your
plans pack, run a job now. Progress label "Bringing in your data". Ticket: C10.

| Operation | Parameters | Scope | Returns | Undo | Replaces |
|---|---|---|---|---|---|
| import_file | `name` (1..200), `mime`, exactly one of `contentBase64` or `text` | write:imports | MCP `{ file: { id, name, status, counts }, pending, receipt }`; Ask `{ status: 'queued', name, receipt }` | not available: imported rows are undone per Confirm answer; the file stays on record | planned `import_file` |
| retry_import | `fileId` | write:imports | MCP `{ file, receipt }`; Ask `{ status: 'queued', name, receipt }` | not available (as `import_file`) | planned `retry_import` |
| review_import | `proposalId`, `version` (positive integer), `decision` (`approve` or `correct`), `evidence` (exact owner statement, 1..4000 characters) | write:imports plus every underlying action scope | `{ proposalId, version, status, counts, receipt }` on approval; correction returns a queued new version | model batch restoration arrives with the atomic import cutover | IMP-7, pending registration; delegates to the shared import review service |
| build_your_plans | `fileIds?` | write:imports | MCP `{ status: 'built', written, entries, sources, warnings, dropped, receipt }`; Ask `{ status: 'queued', receipt }` | not available: the pack is rebuilt from the files | planned `build_your_plans` |
| run_job | `job` (`plan`, `simplefin-sync`, `freshness`, `confirm-guess`) | write:jobs | `{ run: { id, status, startedAt, finishedAt } or { id, status: 'queued' }, receipt }` | not available: a job run reads and replans; its effects are undone where they land | planned `run_job` (its `id` becomes `job`) |

`import_file` takes base64 content from an MCP client or owner-pasted text (a CSV or a markdown
note) in Ask; either way the decoded content is at most 1 MiB less the request envelope
(`MCP_BODY_LIMIT`). A setup note is a `text/markdown` file, which covers `/api/onboarding/notes`.
Jobs that send email (`brief-email`, `deadline-alerts`) and `trash-purge` are not in the enum;
`plan` on a demo store is refused as the route refuses it. Execution in Ask: `import_file` and `retry_import` (document
extraction, including markdown notes, calls `extractDocument`, which awaits the engine's
`extract`), `build_your_plans`, and `run_job` for `plan` and `confirm-guess` all call the engine,
which would wait on the engine ledger the running answer holds. In Ask they are scheduled with
`ctx.queueAfterTools` to run when the round ends and return `{ status: 'queued', receipt }` (for
the two import operations also `name`); the receipt's later state records the outcome, including
the file id. Without `ctx.queueAfterTools` the call is refused, never awaited inline. Over MCP
every operation runs inline and returns the finished result. Reuses `ingestFiles`,
`retryFile` (`src/ingest/pipeline.mjs`), `buildYourPlans`, `refreshLivePacks`,
`ctx.services.scheduler.runNow` (C2), `SCHEDULER_STATUS`, and the triggers `triggerPlan`,
`triggerFreshness`, `triggerGuesses`.

#### `undo`

Purpose: undo an earlier change by its receipt id, from any write result's `undo` field.
Progress label "Undoing a change".

| Operation | Parameters | Scope | Returns | Replaces |
|---|---|---|---|---|
| undo | `id` (receipt id) | the receipt's scope, checked after loading it | the restored item and the updated receipt | live `undo_fact_action`, `undo_goal_action`, `undo_preference_action`, `undo_recommendation_action`, `undo_step_action`; planned `undo_account_action`, `undo_category_action`, `undo_confirm_action`, `undo_decision_action` |

Listed to any key with at least one write scope. Refuses another person's change or an item edited
since. Ticket: C1 (MCP only, as the five tools are on main); C2 offers it to Ask in chat purpose and
replaces the fixed restore table with `registerReceiptKind`.

## 4. Rules for the model

The rules reach the model in two parts, both assembled by C1's loader so no tool ticket edits
`src/api/answerer.mjs`: each operation's `route` line forms the routing table, and each catalog
module's `rules` lines join the static rules. The same text goes into the Ask system prompt
(`buildChatPrompt`) and the MCP server `instructions`. The budget test (Design rule) caps the
assembled text at 8,000 characters.

1. Route by question shape. Call the operation in this table first; reach for
   `transactions.search` only to show example rows.

   | Question shape | Call |
   |---|---|
   | A total, average or breakdown of spending or income over a period | `spending.total` |
   | This period against that one | `spending.compare` |
   | Money in and out by month, household against business | `spending.cash_flow` |
   | Subscriptions, repeating bills, what started or stopped | `spending.recurring` |
   | A named definition ("my elective spending") | `spending.total` with `definition`; `spending.definitions` to list them |
   | Mortgage end, childcare change, 529 end | `spending.obligations` |
   | Spending after an obligation ends | `spending.projection` |
   | Net worth, balances by part, retirement against taxable | `accounts.net_worth` |
   | One account's balance history and freshness | `accounts.detail` |
   | Business profit, revenue, margin | `business.pnl` |
   | The lines behind a business figure | `business.rows` |
   | Tax owed, safe harbor, marginal rate, tax what-if | `tax.estimate` |
   | Contribution room and deadlines | `tax.room` |
   | How much invested is enough, how far, when | `retirement.target` |
   | Growth, months to a number, saving needed by a date | `retirement.growth` |
   | After-tax value by account type | `retirement.after_tax` |
   | When money can come out, RMDs | `retirement.access` |
   | Retiring before access age | `retirement.bridge` |
   | Freshness, uncategorized rows, missing history, expected tax documents | `household.health` |
   | A stored figure (cash, taxes paid, room, net worth today) | `household.figures` |
   | Goal pace | `goals.pace` |
   | Any arithmetic on figures already returned | `calculate` |

2. Never sum, scale, annualize, subtract, divide or round numbers yourself. When an answer needs a
   number no tool returned, call `calculate` with refs to the figures and named assumptions.
3. Write each figure exactly as its `quote` field gives it (for a stored figure, its `{f:key}`
   token). Never restate a figure in other words, spell it out, change its sign, round it, or
   derive a second number from it (a remaining amount, a difference, a monthly figure). Money
   leaving the household is quoted unsigned with a word that says so ("spent", "paid"). When a
   different form is needed, call `calculate` (`round_up`, `monthly`, `subtract`).
4. Copy a figure's `ref` field to reference it; do not compose refs by hand. Pass the same
   arguments when you re-run a call so the figure is the same.
5. State every assumption with its name, value and source: "the owner said it" (`owner`, with the
   owner's words as `evidence`), a saved preference (`preference`, with its id), a stored fact
   (`fact`, with its key), or the operation's default (`default`). Pass defaults by omitting the
   argument, and name them in the answer. Never mark a value as the owner's when the owner did not
   say it; when a tool needs a value nobody stated (a cost basis, a tax rate), leave it out,
   report the unavailable figure, and ask.
6. Report data gaps. For each gap in a result, say what is missing and its size when the gap gives
   an amount or count. Never fill a gap with an estimate. Offer the fix the gap implies (a Confirm
   item, an import, a fact to record).
7. When a request needs a fact Fathom lacks (a birth date, a mortgage rate), say which fact, and in
   chat offer to record it with `answer.fact` using the owner's own words.
8. When no tool covers the question, say "Fathom does not have that" and what it does have. That
   covers security selection, live market prices, money movement and tax filing.
9. Use a write operation only in chat, only when the owner asked for the change in this
   conversation, and confirm each change with its receipt and the Undo it offers. Never chain
   writes the owner did not ask for.
10. For an account merge, show the candidates from `accounts.merge_candidates` and what the merge
    moves, ask the owner to confirm, and call `update_account.merge` with `confirm: true` only
    after the owner's explicit yes in a later message, quoting it as `evidence`.
11. A named spending selection the owner wants kept ("remember elective spending as") is
    `update_preferences.save_definition`, never `update_preferences.remember`. A saved definition
    named in a question ("my elective spending") is passed as `definition`, by the id the context
    lists.
12. Explain, do not advise on securities. Comparisons by account type describe where tax shows up
    and when money can come out; they never say which to choose.

Which ticket adds which rule: C1 rules 1 (lines for its operations), 7, 8 and 9 (today's prompt
already says most of them); C3 rules 2 to 6; C8 rule 10; C10 rule 11; C6 rule 12. Each ticket adds
its own operations' routing lines. C1 removes today's prompt lines that name old tools
(`get_figures`, `remember_preference`, `list_accounts`, `query_transactions`, `pnl_by_month`).

## 5. Packs as structured knowledge for tools

Owner direction:

> "What I expect from the packs is a lot of that rich knowledge base information. When I'm asking
> about discretionary spending, what is that? That's healthcare, that's mortgage, that's spending,
> but when does the mortgage end? When is the childcare cost going to change? It should be able to
> back into calculations and know what gets categorized as what. That's essentially what a
> knowledge pack needs to do. It also needs to know the difference between retirement accounts and
> post-tax brokerage accounts: $15 million in retirement accounts is quite different from $15
> million in a post-tax account because of where the taxes show up and when you're able to pull
> that money out. That's a retirement account knowledge pack."

And the correction:

> "I'm not saying the packs have to be tools to parse. I need that information incorporated.
> That's the whole value of the pack. You determine how best to pull that information in."

Packs are cited markdown entries plus activation rules. Ask's system prompt already includes the
active packs' full context (`packContext` in `buildChatPrompt`), and `knowledge.packs`,
`knowledge.search` and `knowledge.entry` read them.

### The knowledge

Spending classes. Every household-bucket category maps to one class; other buckets map to their
own class. Essential is housing, debt service, healthcare, childcare and other essentials;
discretionary is the rest of household spending.

| Class | Aggregator categories (`CATEGORY_TABLES.aggregator`) | Demo-seed categories | Judgment the pack states |
|---|---|---|---|
| `housing` | Home & Garden | none | Rent, upkeep, HOA, escrowed property tax and insurance. Escrow continues after a mortgage payoff. |
| `debt_service` | Mortgage | housing (the demo's housing rows are mortgage payments) | A mortgage payment is debt service. Its interest share is a housing cost; its principal share is saving. When only the payment is known, the whole payment is debt service and ends at payoff, except escrow. |
| `healthcare` | Medical, Healthcare Premiums, Health & Wellness | health | Premiums paid through payroll or a business account are outside the household ledger and never appear here. Health & Wellness can hold gym memberships; a saved definition can move it. |
| `childcare` | Childcare, Family Care | childcare | Changes at child ages (below). |
| `essential_other` | Groceries, Bills & Utilities, Auto & Transport, Pets, Fees, Legal | groceries, utilities | |
| `discretionary` | Shopping, Dining & Drinks, Entertainment & Rec., Travel & Vacation, Software & Tech, Personal Care, Gifts, Charitable Donations | dining | Giving is discretionary for spending even when it is deductible. |
| `unclassified` | Uncategorized, Cash & Checks | Uncategorized | Reported as a gap with its amount. |
| `savings` | Investment, Mortgage Principal, HSA | none | Not spending. |
| `taxes` | Income Tax, Taxes | none | Not spending; estimated payments and balances due. |
| `business`, `income`, `transfer`, `excluded` | Business; Income; Credit Card Payment, Internal Transfers, Savings Transfer; Ignore | payroll, software, contractors, fees; income; transfer | Follow the bucket. |

Built-in definitions: `household_spending` (the spending measure, no selectors), `essential`
(include classes housing, debt_service, healthcare, childcare, essential_other), `discretionary`
(include class discretionary), `core_living` (exclude class debt_service and bucket tax: what an
independence target should cover once the mortgage is paid off; the Q01 selection).

Obligations and when they end or change.

| Obligation | Ends or changes | Date derived from, in order | New amount from |
|---|---|---|---|
| Mortgage | Payoff date | A stated payoff date (`obligations.mortgage.payoffDate`); else amortization of balance, rate and payment (balance from a mirrored loan account when there is one); else a `missing_fact` gap. | `obligations.mortgage.escrowMonthly` (required in the fact; zero allowed), which continues as housing. |
| Childcare | At child ages | Dependent birth dates: full-time care to school entry at age 5 (by September 1 of that year, a stated default the owner can override), after-school care to age 13 (the dependent care credit's age limit); else dependent ages with year precision; else an owner-stated `obligations.childcareChangeDate`. | `obligations.childcare.schoolAgeMonthly` at school entry; zero at age 13 (pack default); else an owner assumption; else unavailable and not applied. |
| 529 contributions | At college start | Birth dates plus 18 (a stated default); qualified withdrawals start then. | Zero (contributions stop). |

Account tax treatment and access, per type.

| Type | Contributions | Growth | Withdrawals | Earliest penalty-free access and main exceptions | RMDs |
|---|---|---|---|---|---|
| Pre-tax 401(k), 403(b), traditional IRA, SEP | Deductible or pre-tax | Tax-deferred | Ordinary income | Age 59 and a half; rule of 55 (separation from that employer in or after the year of turning 55, employer plans only, not IRAs); substantially equal periodic payments | Yes |
| Roth IRA | After-tax | Tax-free | Contributions any time tax and penalty free; earnings tax-free after 59 and a half and five years | Contribution basis any time; earnings at 59 and a half and five years | None for the original owner |
| Roth 401(k) | After-tax | Tax-free | Qualified after 59 and a half and five years | As pre-tax employer plans | None for the original owner from 2024 |
| HSA | Deductible | Tax-free | Tax-free for qualified medical costs, including past ones with receipts; otherwise ordinary income plus 20 percent before 65 | Medical use any time; any use at 65 without the additional tax | None |
| 529 | After-tax (state deduction in some states) | Tax-free | Tax-free for qualified education; earnings on other use taxed plus 10 percent | Qualified education any time | None |
| Taxable brokerage | After-tax | Dividends and realized gains taxed yearly | Gains over basis taxed as capital gains (long-term after one year); basis returns untaxed | Any time | None |
| Cash | After-tax | Interest taxed yearly | Untaxed | Any time | None |

RMD start age by birth year: 72 for 1950 and earlier (after June 30, 1949), 73 for 1951 to 1959, 75
for 1960 and later.

### The mechanism

Pinned choice, the simplest mix that gets it right:

1. Pack prose is the home of the knowledge and reaches answers the way packs already do: the
   active pack context in the prompt, plus `knowledge.entry` and `knowledge.search`. Both new
   packs are always active (`appliesWhen: {"all": []}`), so the model always has the definitions.
2. Every rule a figure depends on is encoded once in deterministic code in `src/calc`, as
   `LAW_REFS` and `parameters-2026.mjs` are, with a `packRef` to the entry that states it. The
   figure's provenance carries that `packRef`, so the answer cites the pack.
3. Structured tables exist only where a calculator needs data: `CATEGORY_CLASSES`,
   `BUILTIN_DEFINITIONS` and `OBLIGATION_RULES` in `src/calc/classes.mjs` (T2, merged), and
   `ACCOUNT_TREATMENT`, `EMPLOYER_PLAN_TYPES`, `ACCESS_RULES` and `rmdStartAge` in
   `src/calc/treatment.mjs` (PR #83), all frozen code constants, not a new manifest schema.
4. A consistency test per pack (`test/pack-consistency-spending.test.mjs`, merged;
   `test/pack-consistency-treatment.test.mjs`, PR #83) asserts every `packRef` resolves through
   `getEntry` and that the entry's prose states the encoded value, so prose and code cannot drift
   silently.

Rejected: a versioned rule-table schema in manifests parsed at runtime (more surface, a second
source of truth to validate, and the owner said parsing is not the point); prose only (the model
would do the arithmetic).

### Operations that use it

Spending by class (`spending.total` with `groupBy: 'class'` and the built-in definitions
`essential` and `discretionary`), `spending.obligations`, `spending.projection`,
`accounts.net_worth` with `groupBy: 'treatment'`, `retirement.after_tax`, `retirement.access` and
`retirement.bridge`, each described in section 3.

### Pack changes and facts

New packs:

| Pack | Entries | Primary sources the entries cite |
|---|---|---|
| `spending-and-obligations` | `spending-classes`, `mortgage-and-housing`, `healthcare-outside-the-ledger`, `childcare-by-age`, `education-saving-timeline`, `obligations-and-projections` (six entries, the content test's minimum) | IRS Publication 503 (dependent care age limit), Publication 936 (mortgage interest), Publication 970 (529) |
| `account-tax-treatment` | `treatment-by-account-type`, `penalty-free-access`, `required-minimum-distributions`, `roth-contribution-basis`, `hsa-and-529-withdrawals`, `basis-and-capital-gains` | IRS Publications 590-A, 590-B, 575, 969, 970, 550; Internal Revenue Code section 72(t); SECURE 2.0 Act sections 107 and 325 |

Existing packs gain entries: `kids-dependents` gets `care-cost-by-age` (childcare changes by age
and 529 timing, pointing at the spending pack's rules); `advanced-retirement` gets
`access-and-rmd-pointer` (a pointer to the treatment pack for access and RMD); `w2-benefits` gets
`premiums-through-payroll` and `self-employed-partnership` gets `premiums-paid-by-business` (both:
premiums outside the household ledger).

Household facts the tools need:

| Key | Type | Exists today | Collectable by `answer.fact` |
|---|---|---|---|
| `household.birthYears` | object `{ owner, spouse?, dependents? }` of birth years | yes, `ANSWER_SHAPES` | yes |
| `household.expectedDate` | date | yes, `ANSWER_SHAPES` | yes |
| `household.dependentAges` | int list | frozen key, no answer shape | after C7 adds the shape |
| `household.dependentBirthDates` | date list (new `dates` shape type, 1..10) | no | after C7 |
| `household.ownerBirthDate`, `household.spouseBirthDate` | date | no | after C7 |
| `household.retireAge` | age per person | no | after C7 (person scope) |
| `obligations.mortgage` | object `{ balance, rate (ratio), monthlyPayment, escrowMonthly, payoffDate? }` | no | after C7 |
| `obligations.childcare` | object `{ schoolAgeMonthly?, afterCareEndMonthly? }` (dollars per month) | no | after C7 |
| `obligations.childcareChangeDate` | date | no | after C7 |
| `accounts.planType` | per account choice: `traditional_ira`, `roth_ira`, `sep_ira`, `401k`, `roth_401k`, `solo_401k`, `403b`, `457b`, `hsa`, `529`, `taxable` | no | after C7 (account scope, kinds retirement, roth, ira, taxable, brokerage) |
| `accounts.rothFirstContributionYear` | per account year (1975 to the current year) | no | after C7 (account scope, kind roth, or plan type roth_ira or roth_401k) |
| `accounts.rothBasis` | per account dollars | no | after C7 (account scope, kind roth) |
| `accounts.separationDate` | per account date: the day the person left or will leave the plan's sponsoring employer | no | after C7 (account scope, `date` answer shape, accounts whose plan type is an employer plan; the owner states it, never inferred from a retirement age) |

`accounts.planType` replaces the `accounts.taxTreatment` key an earlier draft named: one fact
gives the treatment, the employer-plan status rule of 55 needs, and the Roth IRA or Roth 401(k)
subtype. HSA withdrawal purpose is not a fact: `retirement.after_tax` returns both outcomes. Facts can
also come from data: a mirrored loan account's balance gives the mortgage balance, and
the dependent ages fact gives birth years when no dates are stored.

The `spending-and-obligations` pack and its sibling entries merged with T2. The
`account-tax-treatment` pack and the `advanced-retirement` pointer entry are PR #83. The fact
shapes are C7.

## 6. API parity

Owner principle, refined 2026-11-07: every action the API can do, the agent can do through some
tool call; not a one-to-one mapping between routes and tools.

> "Anything that can happen through the API should be doable by the agent. If I want the agent to
> categorize things for me, it can. If I want it to change some of my accounts from my spouse to
> me, I could do it in the UI and the agent can do it. We have to make our entire internal API a
> first-class citizen to the agent. And if I just want to use my own agent, Fathom becomes
> headless through MCP."

Parity is capability coverage. Every route in `src/api/router.mjs` that reads or changes
household data maps to at least one (tool, operation) pair that does the same thing for the same
caller, or it sits on the exclusion list below with its reason. Coverage means the capability, not
identical output: `GET /api/spending` and `spending.total` both sum household spending, and the
route's response shape is the screen's, not the tool's.

### Route map

All 103 routes on main at this revision: 55 covered, 48 excluded. "Ticket" is the ticket that
lands the covering operation.

| Route | Covered by | Ticket | Note |
|---|---|---|---|
| `GET /healthz` | excluded: health check | | |
| `GET /api/auth/session` | excluded: identity and sessions | | |
| `POST /api/auth/register/options` | excluded: identity and sessions | | |
| `POST /api/auth/register/verify` | excluded: identity and sessions | | |
| `POST /api/auth/signin/options` | excluded: identity and sessions | | |
| `POST /api/auth/signin/verify` | excluded: identity and sessions | | |
| `POST /api/auth/recover` | excluded: identity and sessions | | |
| `POST /api/auth/signout` | excluded: identity and sessions | | |
| `GET /api/auth/passkeys` | excluded: identity and sessions | | |
| `POST /api/auth/passkeys/link` | excluded: identity and sessions | | |
| `POST /api/auth/passkeys/:id/revoke` | excluded: identity and sessions | | |
| `GET /api/admin/users` | excluded: administration | | |
| `POST /api/admin/users/invite` | excluded: administration | | |
| `POST /api/admin/users/:id/role` | excluded: administration | | |
| `POST /api/admin/users/:id/remove` | excluded: administration | | |
| `POST /api/admin/users/:id/passkeys/:keyId/revoke` | excluded: administration | | |
| `POST /api/auth/invitations/accept` | excluded: administration | | |
| `POST /api/operator/households` | excluded: administration | | |
| `GET /api/scenario` | `household.summary` | C1 | the UI payload; its parts are also `recommendations.list`, `household.figures`, `household.deadlines` and `goals.list` |
| `GET /api/pace` | `goals.pace` | C1 |  |
| `POST /api/tour/seen` | excluded: onboarding wizard | | per-person guided-tour completion |
| `GET /api/identity` | excluded: identity and sessions | | |
| `POST /api/recs/:id/action` | `act_on_recommendation.status`, `act_on_recommendation.owner`, `act_on_recommendation.step` | C1 | snooze is status snoozed with wake |
| `POST /api/actions/:id/undo` | `undo.undo` | C1 |  |
| `POST /api/preferences` | `update_preferences.remember` | C1 |  |
| `POST /api/preferences/:id` | `update_preferences.remember` | C1 | with id |
| `POST /api/preferences/:id/delete` | `update_preferences.forget` | C10 |  |
| `POST /api/recs/:id/answers` | `answer.rec_questions` | C8 |  |
| `POST /api/recs/:id/start-over` | `act_on_recommendation.start_over` | C9 |  |
| `POST /api/wargame/:name/pick` | `act_on_recommendation.pick_point` | C9 |  |
| `POST /api/decisions/:id/decide` | `act_on_recommendation.decide` | C9 |  |
| `POST /api/decisions/:id/revisit` | `act_on_recommendation.revisit` | C9 |  |
| `POST /api/packs/:id/toggle` | `update_preferences.pack` | C10 |  |
| `POST /api/packs/:id/whatif` | excluded: conversation chrome | | |
| `GET /api/packs/:id/entries/:entryId` | `knowledge.entry` | C1 |  |
| `POST /api/engine` | excluded: engine controls | | |
| `POST /api/engine/cap` | excluded: engine controls | | |
| `POST /api/your-plans/build` | `refresh.build_your_plans` | C10 |  |
| `POST /api/ask` | excluded: conversation chrome | | |
| `GET /api/threads` | excluded: conversation chrome | | |
| `POST /api/threads` | excluded: conversation chrome | | |
| `GET /api/threads/:id` | excluded: conversation chrome | | |
| `POST /api/threads/:id/rename` | excluded: conversation chrome | | |
| `POST /api/threads/:id/archive` | excluded: conversation chrome | | |
| `POST /api/threads/:id/trash` | excluded: conversation chrome | | |
| `POST /api/threads/:id/restore` | excluded: conversation chrome | | |
| `POST /api/threads/:id/delete` | excluded: conversation chrome | | |
| `POST /api/threads/:id/proposals/:messageId` | excluded: conversation chrome | | explicit confirmation of a stored Ask proposal |
| `GET /api/accounts/:id` | `accounts.detail` | C5 |  |
| `GET /api/accounts/:id/transactions` | `transactions.search` | C1 | `accountId` set |
| `GET /api/pnl` | `business.pnl` | C4 | C1's `pnl` reads workbook lines only, as `pnl_by_month` does; the route also derives P&L from categorized transactions, which C4's `businessPnl` build covers |
| `GET /api/pnl/rows` | `business.rows` | C4 |  |
| `GET /api/spending` | `spending.total` | C4 |  |
| `GET /api/spending/rows` | `transactions.search` | C4 | bucket, class and category filters |
| `POST /api/accounts/:id/name` | `update_account.rename` | C8 |  |
| `POST /api/accounts/:id/mask` | `update_account.mask` | C8 |  |
| `POST /api/accounts/:id/owner` | `update_account.owner` | C8 |  |
| `POST /api/accounts/:id/kind` | `update_account.kind` | C8 |  |
| `GET /api/accounts/:id/merge-candidates` | `accounts.merge_candidates` | C8 |  |
| `POST /api/accounts/:id/merge` | `sources.merge_accounts`, `update_account.merge` | SRC1, C8 | Undo reopens the merge; C8 adds the explicit confirm |
| `POST /api/accounts/:id/archive` | `sources.archive_account` | SRC1 | `{archived: false}` restores; Undo by receipt |
| `GET /api/goals/suggestions` | `goals.suggestions` | C9 |  |
| `POST /api/goals` | `update_goal.create` | C1 |  |
| `POST /api/goals/:id` | `update_goal.edit` | C1 |  |
| `POST /api/goals/:id/archive` | `update_goal.archive` | C9 |  |
| `POST /api/goals/:id/delete` | `update_goal.delete` | C9 |  |
| `POST /api/goals/:id/suggestion` | `update_goal.suggestion` | C9 |  |
| `POST /api/curve` | `update_preferences.curve` | C9 |  |
| `POST /api/onboarding` | excluded: onboarding wizard | | |
| `POST /api/onboarding/notes` | `refresh.import_file` | C10 | a `text/markdown` note |
| `POST /api/demo/reset` | excluded: demo reset | | |
| `GET /api/keys` | excluded: API keys | | |
| `POST /api/keys` | excluded: API keys | | |
| `POST /api/keys/:id/revoke` | excluded: API keys | | |
| `GET /api/mcp` | excluded: API keys | | |
| `POST /api/files` | `refresh.import_file` | C10 |  |
| `GET /api/files` | `household.imports` | C10 |  |
| `POST /api/files/:id/retry` | `refresh.retry_import` | C10 |  |
| `POST /api/import-proposals/:proposalId/review` | `refresh.review_import` | IMP-7 | planned shared import review; `write:imports` plus underlying action scopes |
| `POST /api/files/:id/remove` | `sources.remove_file` | SRC1 | rows archived in a change log; Undo by receipt |
| `GET /api/sources` | `accounts.sources` | SRC1 | real names, range, history or stale |
| `GET /api/confirm` | `household.confirm_items` | C8 | status pending |
| `POST /api/confirm/list` | `household.confirm_items` | C8 | a read despite POST |
| `POST /api/confirm/answers` | `answer.confirm` | C8 |  |
| `POST /api/confirm/reopen-many` | `answer.reopen` | C8 |  |
| `GET /api/confirm/:id` | `household.confirm_items` | C8 | `ids` |
| `POST /api/confirm/:id/answer` | `answer.confirm` | C8 | one item; `revise` |
| `POST /api/confirm/:id/reopen` | `answer.reopen` | C8 |  |
| `GET /api/email/subscriptions` | excluded: outbound email | | |
| `POST /api/email/subscriptions` | excluded: outbound email | | |
| `GET /api/email` | excluded: outbound email | | |
| `POST /api/email/test` | excluded: outbound email | | |
| `POST /api/email/brief` | excluded: outbound email | | |
| `GET /api/jobs` | `household.health` | C5 | its `jobs` list |
| `POST /api/advisor/reviews` | `advisor_review.send` | C9 |  |
| `POST /api/advisor/reviews/:id/verdict` | `advisor_review.verdict` | C9 |  |
| `POST /api/advisor/checkin` | `advisor_review.checkin` | C9 |  |
| `POST /api/advisor/packets` | `advisor_review.packet` | C9 |  |
| `GET /api/advisor/packets/:id` | excluded: file download | | |
| `POST /api/jobs/:id/run` | `refresh.run_job` | C10 |  |
| `POST /api/simplefin/connect` | excluded: bank credentials | | |
| `POST /api/simplefin/disconnect` | excluded: bank credentials | | |
| `POST /api/yearend/marks` | `answer.yearend_mark` | C8 |  |
| `GET /api/yearend/packet` | excluded: file download | | |
| `GET /api/household/outbound` | excluded: administration | | |
| `POST /api/household/outbound` | excluded: administration | | |

### Exclusions

Eleven reasons, each a whole class of routes:

1. Identity and sessions (sign-in, registration, recovery, sign-out, passkeys, session and
   identity reads): identity belongs to the person, never an agent. The agent offers a link to
   the sign-in or Settings screen.
2. Administration (user management, invitations, operator provisioning): who can see the
   household is not delegated to a key. The agent links to Settings, People.
3. API keys (list, create, revoke, the MCP info route): a key must never mint, widen or read keys.
   The agent links to Settings, Connections.
4. Outbound email (settings read, test send, brief send): no outbound actions from an agent. The
   agent links to Settings, Email.
5. Bank credentials (SimpleFIN connect and disconnect): credential handling stays with the person.
   `refresh.run_job {job: 'simplefin-sync'}` covers a sync once connected.
6. Engine controls (engine on or off, budget cap): the agent never turns itself on or raises its
   own budget. The agent links to Settings, Engine.
7. Demo reset: demo-only and destructive. No link.
8. Conversation chrome (`/api/ask`, threads, the pack what-if): an MCP client keeps its own
   conversations, Ask creating or renaming its own threads is a loop with no owner value, and the
   pack what-if is itself an Ask answer.
9. Onboarding wizard step and per-person guided-tour completion: first-run sequencing. Facts said in chat go through
   `answer.fact`; setup notes through `refresh.import_file`.
10. File downloads (the advisor packet and the year-end packet): binary attachments for a
    browser, not data for an agent; the data inside them is readable through
    `recommendations.advisor` and `household.health`.
11. Health check: no household data.

### Scopes

The scopes on main are `read`, `write:recs`, `write:facts`, `write:steps`, `write:goals` and
`write:preferences`. C2 adds:

| Scope | Operations | SCOPE_INFO access text |
|---|---|---|
| `write:accounts` | `update_account` (all five) | Rename accounts, set their last four, owner and kind, and merge duplicates with confirmation. |
| `write:categories` | `categorize` (both) | Correct transaction categories and set merchant rules. |
| `write:confirm` | `answer.confirm`, `answer.reopen`, `answer.yearend_mark` | Answer and reopen Confirm questions and mark expected tax documents. |
| `write:imports` | `refresh.import_file`, `refresh.retry_import`, `refresh.build_your_plans` | Import files and retry or build from imported documents. |
| `write:jobs` | `refresh.run_job` | Run planning, sync, freshness and guess jobs now. |
| `write:decisions` | `act_on_recommendation.decide`, `revisit`, `pick_point` | Pick and decide war-game options and reopen decisions. |

`advisor_review` and `act_on_recommendation.start_over` use `write:recs`; `update_preferences`
uses `write:preferences` throughout; `answer.rec_questions` uses `write:facts`. The `SCOPE_INFO`
access texts name operations, never tool names that no longer exist. A headless client with a
full-scope key can then do everything the UI can except the exclusions.

### Parity test

C2 adds `src/tools/parity.mjs` with two checked-in maps, `PARITY_EXCLUDED` (`'METHOD path'` to one
of the eleven reasons above) and `PARITY_PENDING` (`'METHOD path'` to the `tool.operation` pairs a
later ticket adds, with the ticket named), and `test/tools-parity.test.mjs`, which imports
`routes` from `src/api/router.mjs` and the registry's declared routes (each operation's `routes`)
and fails when:

1. a route of any method is neither declared by a registered operation, nor excluded, nor
   pending;
2. a route is both excluded and declared or pending;
3. a declared, excluded or pending route is not in the router;
4. a pending pair is registered but does not declare that route (a ticket that lands an operation
   must declare the routes it covers);
5. `process.env.PARITY_STRICT === '1'` and a pending pair is not registered.

A pending entry passes while its operation is absent, so tickets land in any order and nobody
edits `src/tools/parity.mjs` after C2. A new route added by any later change fails rule 1 until
someone maps or excludes it. `PARITY_STRICT=1 node --test test/tools-parity.test.mjs` passing is
the program's completion check, run by the coordinator after the last ticket merges; CI does not
set it. This test replaces the previous revision's T4.

## 7. Implementation tickets

Done from the previous cut: T1 and T2 (the figure envelope and loader; spending classes and the
spending-and-obligations pack) have merged and stay as they are. T3 is PR #83: it merges first, as
it stands, as the treatment constants and pack; it adds no tool, so no tool name in it changes, and
the retirement tickets C6 and C7 import from it rather than absorbing it. T16 is PR #84: it merges
first, as it stands, and C1 re-points every case (section 8). The old T4 to T15 and T17 to T28 are
replaced by C0 to C10 below.

Calendar estimate: about four to six calendar days end to end at up to five parallel workers, each
ticket one agent run plus CI and one cross-provider review. Set by the owner's merge gate (PRs #83
and #84 before wave 1, then each ticket), by C1 in wave 1 (C0 beside it), and by the chain C1, C3, C6,
C7.
It stretches if C1 needs a second review round, if PR #76 merges mid-C1 and forces a rebase, or if
CI reruns pile up on a loaded host.

Waves (dependency graph). A ticket starts when everything in its Depends on line has merged.

| Wave | Starts when | Tickets | Workers |
|---|---|---|---|
| 0 | now | owner merges PR #83 and PR #84 (both green) | none |
| 1 | PR #84 merged | C0, C1 | 2 |
| 2 | C1 merged | C2, C3, C4 | 3 |
| 3 | its inputs merge | C5 (C3, PR #83), C6 (C3, C4, PR #83), C8 (C2), C9 (C2, C3), C10 (C2, C4) | 5 |
| 4 | C6 merged | C7 (C4, C6) | 1 |

Serialized files: `src/api/answerer.mjs` and `test/answerer.test.mjs` (C1, then C2; no other
ticket edits them); `src/mcp/keys.mjs` (C1, then C2); `src/calc/figure.mjs` (C3 only);
`src/spending/definitions.mjs` (C4, then C10); `src/tools/catalog/business.mjs` and
`src/tools/catalog/transactions.mjs` (C1, then C4); `docs/architecture.md` (C1, then C10);
`evals/graders.mjs` (C0 and C1 in different functions: C0 the number matching in
`evidenceNumbers` and `gradeFigures`, C1 `gradeRequiredTools` and the stored-figure token check;
the second to merge rebases); the rest of `evals/` (C1 only, then per-case scripts by their
tickets). `src/api/handlers.mjs` is edited by C9 and C10 in different functions
(rec, decision and war-game handlers in C9; pack toggle, preference delete and Your plans build in
C10), and `src/api/ingest-handlers.mjs` by C8 (Confirm) and C10 (files); in each pair the second
to merge rebases. Every other file has one owning ticket.

Standing acceptance, part of every ticket below:

1. Every figure a new or changed referenceable operation returns passes `assertRefsResolve`.
2. Every new write operation: a read-only MCP key gets `Permission denied: <tool>.<operation>`
   for it before argument validation; it is offered to Ask in chat purpose and listed over MCP
   under its scope; every receipt kind it creates restores through `undo`, and every advertised
   `undo` field validates against the `undo` tool's schema.
3. Every new operation declares its `route` line, its `routes`, and its summary; the budget test
   (`test/tools-registry.test.mjs`) stays green.
4. Tests build real stores (`tempDb` from `test/helpers/server.mjs` with `seedDemo`, or
   `createRealStore` from `test/helpers/real-store.mjs`) on the synthetic demo household and
   assert figures against a deterministic recomputation from the same store, never hard-coded
   amounts.
5. After C1, a ticket's only `evals/` change is adding `evals/scripts/<case-id>.mjs` for the
   cases section 8 assigns to it; registering its operations, capabilities and scripts is what
   turns those cases into required passes, and `npm run eval:ask` (in its Test command) shows them
   passing.
6. The ticket runs only its own test command locally (AGENTS.md agent workflow); CI runs the full
   suite and Playwright.

Each ticket below is written to the implementable-ticket contract: its Depends on lines name
merges only, its decisions are made here, and every Done when item names the test that proves it,
run by the worker or by PR CI. No item needs a person at run time.

### C0 Eval grader adjudication

Size: about 120 production lines, 220 test lines.

Depends on: PR #84 merged.

Files: `evals/graders.mjs` (`evidenceNumbers`, `gradeFigures`, `numericFigures`), `evals/harness.mjs`
(passes the answer's dynamic context numbers as `contextNumbers`), `test/eval-grader.test.mjs` (new).

Decisions (section 8, "Sourced number"): the grader's sourced-number test follows the six rules
in that table, so a live run measures tool use and the model's quoting, not formatting noise.

Done when:

1. For each number form in the "Sourced number" table, a fixture answer over real tool results
   from the demo store gets the verdict the table gives: an unsigned amount of a negative result
   value is sourced; the same cent value with or without commas or trailing `.00` is sourced; a
   `k` or `m` abbreviation is sourced only when exact to the cent; a rounded restatement is a
   `rounded` violation; a spelled-out number is a `spelled_out` violation, except a count up to
   twenty that equals the length of a list in a tool result of the turn, which is sourced; a
   number found only in the answer's dynamic context (the household summary block) is
   `context-only`. Verified by `test/eval-grader.test.mjs`.
2. Fixtures built from tier 1 scripted answers for `business-pnl-january`, `goals-pace` and
   `spending-latest-health`, each stating every figure in the forms the live run used (unsigned
   expenses, dropped cents, counts in words), grade as sourced; the same answers with one
   invented amount still fail as `unsourced`. Verified by `test/eval-grader.test.mjs`.
3. A violation's `kind` is one of `unsourced`, `self-computed`, `rounded`, `spelled_out`,
   `context-only`, and the harness report counts each kind per case. Verified by
   `test/eval-grader.test.mjs` and `test/ask-evals-runner.test.mjs`.
4. `npm run eval:ask` passes with the same required passes as its base. Verified by
   `npm run eval:ask`.

Test command: `node --test test/eval-grader.test.mjs test/ask-evals.test.mjs test/ask-evals-runner.test.mjs && npm run eval:ask`

### C1 Operation registry, context budget and the live-tool migration

Size: about 450 production lines added or changed, about 1,200 test and fixture lines changed
(mostly call sites in about 30 test files and the 102 eval cases), one PR.

Depends on: T1 (merged), PR #84 merged.

Files: `src/tools/index.mjs` (operation loader, per-operation validation, generated descriptions,
assembled routing and rule text, parity collection), `src/tools/tools.mjs` (new: the twenty tool
headers), `src/tools/catalog/` (the existing `figures.mjs`, `business.mjs` and `transactions.mjs`
become operation modules; new `household.mjs`, `accounts.mjs`, `goals.mjs`,
`recommendations.mjs`, `knowledge.mjs`, `answer.mjs`, `act-on-recommendation.mjs`,
`update-goal.mjs`, `update-preferences.mjs`, `undo.mjs`), `src/tools/actions.mjs` and
`src/tools/packs.mjs` (folded into those modules and removed), `src/mcp/server.mjs`
(per-operation permission, narrowed enum, `instructions`), `src/mcp/keys.mjs` (`toolsForScopes`
by operation scope, `SCOPE_INFO` text), `src/engine/tools.mjs` (`createRegistryServer` accepts
tool kinds and operation scopes), `src/api/answerer.mjs` (labels and routing text from the
registry, the `transactions` special cases, the internal `callTool` calls), `src/api/fake-answers.mjs`,
`scripts/mcp-smoke.mjs`, `evals/catalog.json`, `evals/cases.mjs`, `evals/graders.mjs`,
`evals/harness.mjs`, `docs/architecture.md` (section 8 tool table and the pack search paragraph),
`docs/development.md` (MCP smoke section), `docs/known-limits.md`, `e2e/chat.spec.mjs`,
`e2e/connect.spec.mjs`, `e2e/engine-screen.spec.mjs`, `src/engine/test/transport.test.mjs`,
`src/mcp/test/` (`actions`, `helpers`, `keys`, `mcp.integration`, `ownership`, `server`), and in
`test/`: `account-rename`, `answerer`, `api-keys`, `api`, `ask-actions`, `ask-evals-runner`,
`ask-evals`, `ask-quality` (its `TOOL_NAMES` fixture), `ask-stream`, `ask-threads`,
`ask-work-block`, `chat-api`, `figure-envelope`, `goals`, `jobs/advisor`, `jobs/mg-triggers`,
`live-smoke-shape`, `mcp-deploy-smoke`, `pace`, `preferences`, `rec-owner`, `rec-threads`,
`tools-packs`, `tools`, and `tools-registry` (new).

Decisions: the 30 live names map as section 9 says, with no alias; `undo` stays MCP-only;
`knowledge.packs` merges `list_packs` and `packs_status` as section 3 says; `household.facts`
takes up to 500 keys; `business.pnl` and `transactions.search` keep their old arguments and
results (C4 extends both); `accounts.holdings` renames `accountId` to `id`; progress and source
labels move from `src/api/answerer.mjs` into the tool headers, one per tool (the engine's tool
event carries only the tool name, because the live stream announces a tool before its arguments
arrive); the MCP smoke prints `<tool>.<operation> pass|fail <bytes>` and probes
`act_on_recommendation.status` for the write denial.

Done when:

1. The registry lists exactly `household` (summary, facts, fact_shapes, figures, deadlines),
   `accounts` (list, holdings), `transactions` (search), `business` (pnl), `goals` (list, pace),
   `recommendations` (list, detail, advisor), `knowledge` (packs, search, entry), `answer`
   (fact), `act_on_recommendation` (status, owner, step), `update_goal` (create, edit),
   `update_preferences` (remember) and `undo` (undo), and `getTool` returns null for each of the
   30 old names. Verified by `test/tools-registry.test.mjs`.
2. Every tool obeys the Design rule: required `operation` enum, reads and writes never in one
   tool, at most eight operations (except `calculate`), one schema per parameter name per tool,
   every parameter used by an operation, the first read operation needs no other argument, every
   schema compiles through `createRegistryServer`; the loader refuses a duplicate operation and a
   conflicting parameter schema (each with a test over a synthetic module). Verified by
   `test/tools-registry.test.mjs`.
3. An unknown operation, an argument the operation does not use, and a missing argument the
   operation requires are each `bad_input` naming the operation, through `callTool` and through
   the Ask registry server. Verified by `test/tools-registry.test.mjs`.
4. A key with `read` and `write:recs` lists `act_on_recommendation` with operation enum `owner`,
   `status`; calling `step` returns text starting `Permission denied:
   act_on_recommendation.step needs the write:steps scope` even with invalid arguments; a read
   key lists no write tool. Verified by `src/mcp/test/server.test.mjs`.
5. Every migrated test keeps its assertions with only the call changed; on the demo store every id
   and status `packs_status` returned (recorded in the test from its old handler logic) appears in
   `knowledge.packs` with the same status. Verified by `test/tools.test.mjs` and
   `test/tools-packs.test.mjs`.
6. `src/api/answerer.mjs` holds no map keyed by tool name; progress labels, source labels and the
   routing and rule text come from the registry; the Ask prompt and the MCP `instructions` carry
   the same assembled text. Verified by `test/answerer.test.mjs` and
   `test/ask-work-block.test.mjs`.
7. The budget test builds the full-scope tool list, serializes it and passes under 30,000
   characters, each description at most 900 and the assembled rule text at most 8,000, printing
   the three numbers. Verified by `test/tools-registry.test.mjs`.
8. No tracked file except `docs/ask-tools.md` contains any of the 30 old names as a word
   (ignoring the `<household_summary>` prompt tag); the test reads `git ls-files`. Verified by
   `test/tools-registry.test.mjs`.
9. Every eval case is re-pointed as section 8 lists, including the `portfolio` and
   `annual-spending` oracle changes there; each required call carries `operation`; the loader's
   availability probe checks (tool, operation) pairs (`requires.operations` replaces
   `requires.tools`), capabilities and `requires.script`; a loader test flips a case to required
   only when a stub operation with its pair registers and, for a scripted case, its script file
   exists; `npm run eval:ask` passes, every case whose "Tier 1 required after" column says C1 is a
   required pass, no case that was a required pass on the base fails, and every expected failure
   names its missing pairs, capabilities or script; `gradeRequiredTools` reports each required
   call as `ok`, `missing` (pair not called) or `predicate_failed` (pair called; names the
   failing predicates); predicate op `includes_or_absent` passes when the array includes the value
   or the argument is omitted. Verified by `test/ask-evals.test.mjs`,
   `test/ask-evals-runner.test.mjs` and `npm run eval:ask`.
10. The MCP smoke calls each read tool's first operation and gets the permission denial for
    `act_on_recommendation.status` on a read key. Verified by `test/mcp-deploy-smoke.test.mjs`.

Test command: `node --test test/tools-registry.test.mjs test/tools.test.mjs test/tools-packs.test.mjs test/answerer.test.mjs test/ask-quality.test.mjs test/ask-actions.test.mjs test/ask-work-block.test.mjs test/ask-evals.test.mjs test/ask-evals-runner.test.mjs test/mcp-deploy-smoke.test.mjs src/mcp/test/*.test.mjs && npm run eval:ask`

### C2 Write plumbing and the API parity gate

Size: about 320 production lines, 330 test lines.

Depends on: C1.

Files: `src/shared/action-scopes.mjs`, `src/mcp/keys.mjs` (`SCOPE_INFO`), `src/actions/receipts.mjs`
(`registerReceiptKind(kind, { table, pk } or { restore })` replaces the fixed table; kind
`setting`), `src/tools/catalog/undo.mjs` (`undo` loses `mcpOnly`; `capabilities:
['ownerStatements']`), `src/platform/runtime.mjs` (one `services` object per household), `src/mcp/index.mjs`
(`ctx.services`, `ctx.ownerStatements`), `src/api/answerer.mjs` (`createLiveAnswerer` accepts
`services` and puts it, with `ownerStatements` bound to `src/actions/evidence.mjs`, on the tool
context), `src/tools/parity.mjs` (new), `src/mcp/test/keys.test.mjs`,
`test/write-scopes.test.mjs` (new), `test/tool-services.test.mjs` (new),
`test/tools-parity.test.mjs` (new).

`services` is `{ scheduler, engine, config: { dataDir, clock }, vault(), household }`, built
once per household in `src/platform/runtime.mjs` and shared by MCP and `createLiveAnswerer`.
`dataDir` is the household root; `vault()` returns that household's vault root and key handle.
`household` resolves the immutable runtime. Public demo sandboxes use the same factory before
wrapping the answerer with visitor limits. `createLiveAnswerer` requires `services`.

Done when:

1. `WRITE_SCOPES` and `SCOPE_INFO` hold the six new scopes with section 6's access text; key
   creation accepts them; `createRegistryServer` offers an operation under each only for purpose
   chat. Verified by `test/write-scopes.test.mjs` and `src/mcp/test/keys.test.mjs`.
2. The existing receipt kinds undo exactly as before; a kind registered from a test module with a
   table restores; one with a `restore` hook calls it; an unregistered kind is refused; kind
   `setting` restores a settings row by key. Verified by `test/write-scopes.test.mjs` and
   `test/ask-actions.test.mjs`.
3. A test operation reading `ctx.services` sees the same scheduler, engine and config through an
   MCP request over a real store and through an Ask answer with the fake engine; in Ask
   `ctx.ownerStatements()` returns the owner's messages of that conversation. Verified by
   `test/tool-services.test.mjs`.
4. `undo` is listed over MCP to any key with a write scope and offered to Ask in chat purpose, and
   undoes a receipt of each existing scope through both surfaces; a receipt whose scope the key
   lacks is refused with `Permission denied:`. Verified by `test/write-scopes.test.mjs`.
5. The parity test enforces the five rules in section 6, each with a test over a synthetic routes
   list and registry, plus one run over the real router and registry that passes with
   `PARITY_EXCLUDED` and `PARITY_PENDING` exactly as the section 6 route map gives them. Verified
   by `test/tools-parity.test.mjs`.

Test command: `node --test test/write-scopes.test.mjs test/tool-services.test.mjs test/tools-parity.test.mjs src/mcp/test/keys.test.mjs test/ask-actions.test.mjs test/answerer.test.mjs && npm run eval:ask`

### C3 calculate, figure references and quoting

Size: about 300 production lines, 300 test lines.

Depends on: C1.

Files: `src/tools/refs.mjs` (new), `src/tools/assumption-evidence.mjs` (new: `statedValues`,
`assumptionStated`), `src/tools/catalog/calculate.mjs` (new, with section 4 rules 2 to 6),
`src/calc/growth.mjs` (new: `futureValue`, `requiredMonthly`), `src/calc/figure.mjs` (`quote`
and `direction` in `envelope`), `test/tools-calculate.test.mjs` (new),
`test/assumption-evidence.test.mjs` (new), `test/figure-quote.test.mjs` (new).

Done when:

1. Every `calculate` operation computes the expected value and unit on refs to real
   `household.figures` and `goals.pace` figures over the demo store, recomputed in the test from
   the same figures; ratio results above 1 and below 0 come back unrounded. Verified by
   `test/tools-calculate.test.mjs`.
2. Unit mismatches, division by zero, more than 20 operands, expression depth over 6, ref depth
   over 3, refs to write tools or non-referenceable operations, and bare numbers are `bad_input`
   naming the cause. Verified by `test/tools-calculate.test.mjs`.
3. `source: 'fact'` with a value that differs from the stored fact, `source: 'default'` with a
   non-default value and `source: 'owner'` without `evidence` are refused. Verified by
   `test/tools-calculate.test.mjs`.
4. `assumptionStated` over the questions' wording, with `ctx.ownerStatements` stubbed: Q02
   accepts `withdrawalRate` 0.04 and refuses 0.05; Q25 accepts `realReturn` 0.03; Q26 accepts
   0.035 and refuses 3.5; "4%" and "0.04" each accept 0.04; Q27 "$1,000 more a month" accepts
   1000 usd_per_month; Q28 "$15 million" accepts 15000000 usd; with no `ctx.ownerStatements` in
   an Ask context owner assumptions are refused. Verified by `test/assumption-evidence.test.mjs`.
5. `groundAnswer` over a reply that states "4 percent" and the `calculate` result's `quote`
   grounds both, with no change to `src/api/answerer.mjs`. Verified by
   `test/tools-calculate.test.mjs`.
6. Every envelope carries `quote` per section 3 (money unsigned to cents with `direction: 'out'`
   for outflows, percent, months, dates, half ages), stored figures quote their `{f:key}` token,
   and `groundAnswer` grounds each `quote` form. Verified by `test/figure-quote.test.mjs`.
7. The assembled rule text holds section 4 rules 2 to 6. Verified by `test/tools-registry.test.mjs`.

Test command: `node --test test/tools-calculate.test.mjs test/assumption-evidence.test.mjs test/figure-quote.test.mjs test/figure-envelope.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C4 Spending and business reads

Size: about 700 production lines, 650 test lines.

Depends on: C1, T2 (merged).

Files: `src/calc/aggregate.mjs` (new), `src/calc/recurring.mjs` (new), `src/calc/targets.mjs`
(`spendingInputs` reuses the shared row selection), `src/spending/definitions.mjs` (new:
`resolveDefinition` for built-ins), `src/tools/catalog/spending.mjs` (new: `total`, `compare`,
`definitions`, `cash_flow`, `recurring`), `src/tools/catalog/transactions.mjs` (filters and
fields), `src/tools/catalog/business.mjs` (`pnl` upgrade, `rows`), `test/tools-spending.test.mjs`
(new), `test/tools-cash-flow.test.mjs` (new), `test/tools-recurring.test.mjs` (new),
`test/tools-business.test.mjs` (new).

Done when:

1. `spending.total {measure: 'spending'}` over `spending_window` equals
   `spendingInputs(...).spendTotal` on the demo store and on a `createRealStore` household with a
   card account. Verified by `test/tools-spending.test.mjs`.
2. The Q01 arguments return a total equal to household spending less the mortgage rows,
   recomputed from `resolveCategories`; `excluded` reports the mortgage and tax rows' matched
   amounts; groups sum to the total; the healthcare class group is present; `definition:
   'essential'` returns one total equal to the sum of its five class groups. Verified by
   `test/tools-spending.test.mjs`.
3. Gaps carry correct amounts and counts for uncategorized, guessed, a silent card account, and
   `outside_household_ledger` when `income.w2` is true; every period, group, scope and definition
   merge rule has a test; `limit` folds into `other`. Verified by `test/tools-spending.test.mjs`.
4. `spending.compare` returns difference, ratio and group deltas recomputed from two `total`
   calls, with `unequal_periods` when month counts differ. Verified by
   `test/tools-spending.test.mjs`.
5. `spending.cash_flow` separates matched business transfers from inflow and outflow, recomputed
   from `matchTransfers`; `spending.recurring` finds a monthly, a quarterly and an annual series
   in a `createRealStore` household, flags a stopped and a changed one, and never lists a
   transfer. Verified by `test/tools-cash-flow.test.mjs` and `test/tools-recurring.test.mjs`.
6. `business.pnl` with C1's arguments returns the same entities and totals as before, and with
   `compareToPriorYear` returns prior figures recomputed from `businessPnl`; `business.rows`
   returns what `GET /api/pnl/rows` returns for the same arguments. Verified by
   `test/tools-business.test.mjs`.
7. `transactions.search` filters by bucket, class and merchant and returns the resolved fields;
   its C1 tests pass unchanged; on a `createRealStore` account with 450 transactions, 300 of them
   on one date with equal amounts and descriptions, following `next` from the first page returns
   every row exactly once. Verified by `test/tools.test.mjs`.

Test command: `node --test test/tools-spending.test.mjs test/tools-cash-flow.test.mjs test/tools-recurring.test.mjs test/tools-business.test.mjs test/categories.test.mjs test/tools.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C5 Balances, tax and data health

Size: about 550 production lines, 500 test lines.

Depends on: C1, C3 (the Assumption validation `tax.estimate` what-ifs use), PR #83 merged.

Files: `src/tools/catalog/balances.mjs` (new: `accounts.net_worth`, `accounts.detail`),
`src/tools/catalog/health.mjs` (new: `household.health`), `src/tools/catalog/tax.mjs` (new:
`tax.estimate`, `tax.room`), `test/tools-net-worth.test.mjs` (new), `test/tools-health.test.mjs`
(new), `test/tools-tax.test.mjs` (new).

Done when:

1. `accounts.net_worth` total and parts equal `buildTrend` for the same months; `groupBy:
   'treatment'` groups by `ACCOUNT_TREATMENT` and names a `retirement` account without a plan type
   in a `missing_fact` gap; carried accounts carry `carried_balance`. Verified by
   `test/tools-net-worth.test.mjs`.
2. `accounts.detail` returns what `GET /api/accounts/:id` returns plus the balance figure.
   Verified by `test/tools-net-worth.test.mjs`.
3. `household.health` lists stale and silent accounts with ages recomputed from
   `accountFreshness`, category counts equal to `categoryCoverage`, pending Confirm counts equal
   to `pendingItems`, year-end items equal to `yearendChecklist`, and the job list. Verified by
   `test/tools-health.test.mjs`.
4. `tax.estimate` returns the stored planner figures as envelopes with the planner run date as
   `asOf`, and a what-if of 20000 business income returns deltas equal to two `householdTax` runs
   recomputed in the test. Verified by `test/tools-tax.test.mjs`.
5. `tax.room` returns stored `room.*` figures when the planning run is in the tax year and
   calculator limits with `used` null and the gap otherwise. Verified by `test/tools-tax.test.mjs`.

Test command: `node --test test/tools-net-worth.test.mjs test/tools-health.test.mjs test/tools-tax.test.mjs test/treatment.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C6 Retirement: target, growth and after-tax value

Size: about 450 production lines, 450 test lines.

Depends on: C3, C4, PR #83 merged.

Files: `src/tools/catalog/retirement.mjs` (new: `retirement.target`, `retirement.growth`,
`retirement.after_tax`, and section 4 rule 12), `test/tools-retirement.test.mjs` (new),
`test/tools-after-tax.test.mjs` (new).

PR #83 folds in as merged constants: this ticket and C7 import `ACCOUNT_TREATMENT`,
`EMPLOYER_PLAN_TYPES`, `ACCESS_RULES` and `rmdStartAge` from `src/calc/treatment.mjs` and do not
change that file.

Done when:

1. `retirement.target` with a ref to the Q01 `spending.total` and an owner rate of 0.04 returns a
   target equal to the referenced total divided by 0.04 rounded up to the thousand, and `gap`,
   `months` and `projectedDate` equal to `independencePlan` over the same inputs; each status
   (`covered`, `projected`, `no_savings`, `too_long`) has a test. Verified by
   `test/tools-retirement.test.mjs`.
2. `retirement.growth` solves `balance`, `months` and `monthly` with values equal to
   `futureValue`, `monthsToReach` and `requiredMonthly` recomputed in the test; `byAge` without a
   birth date or age fact returns the `missing_fact` note. Verified by
   `test/tools-retirement.test.mjs`.
3. `retirement.after_tax` applies each of the six section 3 rules: a pre-tax row taxed at ordinary
   plus state; a taxable row with a position missing basis returns `afterTax` unavailable with a
   `no_cost_basis` gap counting positions; an HSA row returns both medical and nonmedical values;
   a `retirement` kind without a plan type is unavailable with `missing_fact`. Rates passed as refs
   to a `calculate` figure and as owner assumptions both resolve (refs to `tax.estimate` need C5
   and are covered by its eval cases, not by this test). Verified by `test/tools-after-tax.test.mjs`.

Test command: `node --test test/tools-retirement.test.mjs test/tools-after-tax.test.mjs test/tools-calculate.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C7 Obligations and access

Size: about 600 production lines, 550 test lines.

Depends on: C4, C6.

Files: `src/jobs/triggers/common.mjs` (declarations: the new keys in `ANSWER_SHAPES`, their
`answerShape` entries, and account eligibility by kind and plan type for the per-account keys),
`src/facts/answers.mjs` (value validation: the new `dates` list type and the obligation object
shapes), `src/calc/obligations.mjs` (new),
`src/tools/catalog/obligations.mjs` (new: `spending.obligations`, `spending.projection`),
`src/tools/catalog/access.mjs` (new: `retirement.access`, `retirement.bridge`),
`test/fact-shapes-obligations.test.mjs` (new), `test/tools-obligations.test.mjs` (new),
`test/tools-access.test.mjs` (new).

Done when:

1. `answer.fact` accepts each fact in section 5's table marked "after C7" with its shape and
   scope, and refuses a wrong shape. Verified by `test/fact-shapes-obligations.test.mjs`.
2. `spending.obligations` derives a mortgage end from a stated payoff date and, without one, from
   amortization of balance, rate and payment; childcare change dates from birth dates at ages 5
   and 13; 529 end at 18; a missing fact yields `missing_fact`. Verified by
   `test/tools-obligations.test.mjs`.
3. `spending.projection` drops only the in-base part of an obligation (no mortgage drop for
   `core_living`), lists an unstated new amount with `applied: false`, and refuses a base ref to
   anything but `spending.total`. Verified by `test/tools-obligations.test.mjs`.
4. `retirement.access` returns each event with the rules in section 3: rule of 55 only for an
   employer plan with a separation date in or after the year the person turns 55; RMD start 72,
   73 or 75 by birth year from `rmdStartAge`; Roth accounts excluded from RMDs; year precision
   with a gap when only the age fact exists. Verified by `test/tools-access.test.mjs`.
5. `retirement.bridge` counts Roth basis, rule of 55 balances from their separation date, taxable
   and cash, never the listed exceptions, and returns shortfall or surplus recomputed in the test.
   Verified by `test/tools-access.test.mjs`.

Test command: `node --test test/fact-shapes-obligations.test.mjs test/tools-obligations.test.mjs test/tools-access.test.mjs test/fact-answers.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C8 Account, category and Confirm writes

Size: about 600 production lines, 650 test lines.

Depends on: C2.

Files: `src/accounts/write.mjs` (new), `src/api/accounts.mjs` (handlers call the store
functions), `src/categories/store.mjs` (`setTransactionCategory`, `setMerchantRule`),
`src/api/fact-answers.mjs` (`saveRecAnswers`), `src/api/ingest-handlers.mjs` (Confirm handlers
share the answer functions), `src/tools/catalog/update-account.mjs` (new),
`src/tools/catalog/categorize.mjs` (new), `src/tools/catalog/answer-confirm.mjs` (new:
`answer.rec_questions`, `confirm`, `reopen`, `yearend_mark`, and section 4 rule 10),
`src/tools/catalog/confirm-read.mjs` (new: `household.confirm_items`,
`accounts.merge_candidates`), `test/tools-account-writes.test.mjs` (new),
`test/tools-category-writes.test.mjs` (new), `test/tools-confirm-writes.test.mjs` (new).

Done when:

1. Each `update_account` operation makes the same change as its route on a real store, the route
   tests in `test/account-edit.test.mjs` pass unchanged, and `undo` restores each receipt kind;
   `merge` without `confirm: true` or without evidence quoting a later owner message is refused,
   and its undo reopens the merge until a moved row changes. Verified by
   `test/tools-account-writes.test.mjs` and `test/account-edit.test.mjs`.
2. `categorize.transaction` and Confirm category answers write through one function;
   `merchant_rule` returns the affected count recomputed in the test; both undo. Verified by
   `test/tools-category-writes.test.mjs`.
3. `answer.confirm`, `reopen`, `rec_questions` and `yearend_mark` match their routes on a real
   store and undo through their receipt kinds; `reopen` after a changed row is refused with
   `changed_since`. Verified by `test/tools-confirm-writes.test.mjs`.
4. `household.confirm_items` and `accounts.merge_candidates` return what `GET /api/confirm`,
   `GET /api/confirm/:id` and `GET /api/accounts/:id/merge-candidates` return. Verified by
   `test/tools-confirm-writes.test.mjs`.

Test command: `node --test test/tools-account-writes.test.mjs test/tools-category-writes.test.mjs test/tools-confirm-writes.test.mjs test/account-edit.test.mjs test/categories.test.mjs test/tools-parity.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C9 Recommendation, advisor and goal writes

Size: about 550 production lines, 600 test lines.

Depends on: C2, C3 (the Assumption validation `update_goal.suggestion` uses for `withdrawalRate`).

Files: `src/decisions/write.mjs` (new), `src/store/recs.mjs` (`detachRecThreads`),
`src/goals/write.mjs` (new), `src/goals/curve.mjs` (`setCurvePositions`),
`src/suggest/write.mjs` (new), `src/advisor/packet.mjs` (`buildAndStorePacket`),
`src/api/handlers.mjs` (rec start-over, war game, decision handlers), `src/api/goals.mjs`,
`src/api/advisor-handlers.mjs`, `src/tools/catalog/recommendation-writes.mjs` (new),
`src/tools/catalog/advisor-review.mjs` (new), `src/tools/catalog/goal-writes.mjs` (new: the
three `update_goal` operations, `update_preferences.curve`, `goals.suggestions`),
`test/tools-rec-writes.test.mjs` (new), `test/tools-advisor-writes.test.mjs` (new),
`test/tools-goal-writes.test.mjs` (new).

Done when:

1. `act_on_recommendation.start_over`, `decide`, `revisit` and `pick_point` match their routes on
   a real store; `undo` of a decide revisits and removes the decided fact; `undo` of a revisit
   decides on the prior point. Verified by `test/tools-rec-writes.test.mjs`.
2. `advisor_review.send`, `verdict`, `checkin` and `packet` match their routes; a veto dismisses
   the rec; `checkin` undoes; the other three return `undo.available: false` with the reasons in
   section 3. Verified by `test/tools-advisor-writes.test.mjs`.
3. `update_goal.archive`, `delete` and `suggestion` and `update_preferences.curve` match their
   routes and undo (`delete` restores every column); `goals.suggestions` returns what
   `GET /api/goals/suggestions` returns. Verified by `test/tools-goal-writes.test.mjs`.

Test command: `node --test test/tools-rec-writes.test.mjs test/tools-advisor-writes.test.mjs test/tools-goal-writes.test.mjs test/goals.test.mjs test/rec-threads.test.mjs test/tools-parity.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

### C10 Preferences, definitions and refresh

Size: about 600 production lines plus one migration, 600 test lines.

Depends on: C2, C4.

Files: `src/store/migrations/` (one new migration, numbered at merge), `src/spending/definitions.mjs`
(saved rows in `resolveDefinition`), `src/actions/preferences.mjs` (linked preference rules),
`src/packs/state.mjs` (`setPackActive`), `src/api/handlers.mjs` (pack toggle, preference delete,
Your plans build), `src/api/ingest-handlers.mjs` (file upload and retry share the pipeline
functions), `src/api/email-handlers.mjs` (job run shares `runNow`),
`src/tools/catalog/definitions.mjs` (new: `save_definition`, `delete_definition`, `forget`,
`capabilities: ['definitions']`, section 4 rule 11), `src/tools/catalog/packs-write.mjs` (new:
`update_preferences.pack`), `src/tools/catalog/refresh.mjs` (new), `src/tools/catalog/imports-read.mjs`
(new: `household.imports`), `docs/architecture.md` (the new table), `test/definitions.test.mjs`
(new), `test/tools-refresh.test.mjs` (new), `test/tools-pack-writes.test.mjs` (new).

Done when:

1. The five linkage rules in section 3 hold on a real store, each with a test; a definition saved
   in one conversation resolves by id in `spending.total` from a later one; `undo` restores both
   rows. Verified by `test/definitions.test.mjs`.
2. `update_preferences.pack` is idempotent, matches the toggle's effect on recs, and its undo
   restores `wasActive`. Verified by `test/tools-pack-writes.test.mjs`.
3. `refresh.import_file` with base64 over MCP produces the same file row as `POST /api/files`;
   content over the limit is refused; `retry_import` matches the route; over MCP every operation
   runs inline; `plan` on a demo store is refused as the route refuses it; `household.imports`
   equals `GET /api/files`. In an Ask answer with the fake engine enabled (its `extract` scripted),
   `import_file` with a pasted markdown note, `retry_import`, `build_your_plans` and `run_job`
   for `plan` and `confirm-guess` each return `queued` within the round and complete after it,
   with no ledger wait (the test fails on a timeout of 5 seconds). Verified by `test/tools-refresh.test.mjs`.
4. The migration's table is listed in `docs/architecture.md`. Verified by
   `node --test test/docs.test.mjs`.

Test command: `node --test test/definitions.test.mjs test/tools-refresh.test.mjs test/tools-pack-writes.test.mjs test/preferences.test.mjs test/docs.test.mjs test/tools-parity.test.mjs test/tools-registry.test.mjs && npm run eval:ask`

## 8. Eval coverage

The Ask eval suite runs cases with a question, follow-ups, required calls with argument
predicates, forbidden behavior (an unsourced figure, a self-computed figure, an owner assumption
not in the owner's messages), expected figures computed at run time from the demo store, and a
word budget. Tier 1 (`npm run eval:ask`) runs in CI over scripted transcripts; tier 2
(`npm run eval:ask:live`) runs a live model, spends against the engine cap and never runs in CI.

Evals assert (tool, operation) pairs and parameters, not tool names alone. C1 changes the case
format so that every required call is `{ name, operation, predicates }`; `requires.tools` becomes
`requires.operations` (`'spending.total'`); the availability probe checks the pair against the
registry; and `evals/graders.mjs` matches name and operation before predicates (its
`get_figures` check becomes `household.figures`). A case missing any required pair or capability
(`ownerStatements` from C2, `businessPeriods` from C4, `definitions` from C10) is expected-fail
and names what is missing; once everything is present it is a required pass.

Scripted transcripts. Tier 1 builds each scripted call's arguments from the case's predicates,
which is enough for a read whose required arguments the predicates name, and not enough for a
`calculate` call (operands and label), a call with refs or evidence (`retirement.growth`,
`retirement.target` with an owner rate), or a write (target ids from an earlier read). C1 adds
optional per-case script modules, `evals/scripts/<case-id>.mjs`, each exporting `script(ctx)`,
which builds the full scripted transcript from the demo store: the prerequisite reads, the ids
they return, refs copied from earlier results, and evidence quoted from the case's question. C1
sets `requires.script: true` on every case whose "Tier 1 required after" ticket below is not C1,
and the loader treats a missing script file as a missing requirement (named in the expected
failure). Each ticket from C2 to C10 writes the script files for exactly the cases that name it in
that column, with a runner test that the script's calls validate against the registry; that is
the only `evals/` change a later ticket makes. A case's catalog entry never changes after C1.

How PR #84 is re-pointed: merge it first, unchanged (it is green: 29 tier 1 passes and 73 expected
failures, all availability-based). Then C1 rewrites every case in `evals/catalog.json` as the
table below gives it, and `evals/cases.mjs` and `evals/harness.mjs` for the pair format, in the
same ticket that renames the live tools. Re-pointing on the PR #84 branch before C1 would need the
loader to accept old names and pairs at once, which is a compatibility path. If the owner prefers
to hold PR #84, it rebases onto C1 and applies the same table; nothing else changes.

Live baseline, the bar later tier 2 runs must beat. The full live run at `2393850` ran all 33
cases on main: 2 pass (`spending-latest-groceries`, `spending-latest-dining`), 31 fail, $5.37.
An earlier partial run on `bb2c2f6` (2 pass, 22 fail, 1 stopped by budget, 8 unrun, $5.19)
showed the same pattern. The failures fall into three groups:

1. Required tools that do not exist yet (`spending_summary`, `portfolio_requirement`, `cash_flow`,
   `net_worth_history`); the model used `query_transactions`, `list_accounts`, `get_figures` or
   `get_pace` instead. These are the five rewritten cases marked below (`spending-annual-exclusions`,
   `spending-portfolio-withdrawal`, `cash-flow-month`, `net-worth-history`, `net-worth-change`);
   they turn green when C4, C5 and C6 land the operations they now require.
2. Stored-figure cases where the model called `get_figures` but restated or computed figures,
   flagged as self-computed (`cash-personal`, `cash-true-reserve`, `net-worth-current`,
   `retirement-hsa-room`, `retirement-current-room`, `retirement-pretax`, `taxes-safe-harbor`,
   `taxes-federal-paid`, `taxes-state-paid`, `taxes-liability`, `taxes-april-due`). C3 closes this
   group with a tool change and a rule: every envelope carries a ready-to-quote `quote` (the
   `{f:key}` token for a stored figure, digits only, money unsigned with `direction: 'out'`), and
   section 4 rule 3 says to write `quote` exactly and never derive a second number.
3. Cases with zero self-computed figures that still failed on unsourced numbers. With the
   required call satisfied: `business-pnl-january` (10), `business-pnl-february` (10),
   `business-pnl-march` (8), `goals-pace` (14), `spending-latest-health` (2), `freshness-facts`
   (2). With the required tool not called, numbers apparently read from the household summary
   the prompt carries: `goals-open` (22), `freshness-household` (4), `unavailable-routing-number`
   (5). This is either the grader failing to match tool output the model formatted (an expense
   written unsigned while the tool returns it negative, dropped cents, counts in words) or the
   model restating numbers without provenance. C0 adjudicates it before any tool ticket is
   measured: it fixes the grader to the table below and proves each form with fixtures, so the
   remaining violations are the model's.

Sourced number, as C0 pins it (the grader's rules; the answerer's own grounding is unchanged):

| Number in the answer | Verdict |
|---|---|
| Equal to a tool result value in the turn, to the cent for money, or its absolute value (expenses are returned negative and written unsigned) | sourced |
| The same cent value with or without commas, `$`, or trailing `.00`; a ratio written as a percent | sourced |
| A `k` or `m` abbreviation equal to a result value to the cent | sourced; otherwise `rounded` |
| A rounded restatement of a result value (`about $1,200` for 1,187.40) | `rounded` violation (section 4 rule 3) |
| A spelled-out number | `spelled_out` violation, except a count up to twenty equal to the length of a list in a result of the turn, which is sourced |
| Found only in the prompt's dynamic context (the household summary block), not in any tool result | `context-only` violation, reported apart from `unsourced` |

Argument predicates. The live run reported `get_figures` as missing in a case where it was called
(`retirement-hsa-follow-up`): the call failed the case's argument predicate (`keys` includes
`hsa_left`), and the grader reported that as a missing tool. With typed operations the predicate
is explicit and checkable on its own: the case requires the pair `household.figures` and states
its predicate on that operation's typed `keys` parameter, and C1's `gradeRequiredTools` reports
`missing` (the pair was not called) apart from `predicate_failed` (the pair was called; the report
names the failing predicate). Because the `figures` operation defines an omitted `keys` as every
stored figure, a call without `keys` returns the figure the case needs, so C1 rewrites the
stored-figure predicates as `includes_or_absent` on `keys`; a call naming other keys still fails
the predicate, and says so.

Each later tier 2 run reports against this baseline: more than 2 passes, no case that passed
regressing, the count of each violation kind per case (C0), and the cost of the run. The
checkpoints are a run right after C0 (the adjudicated baseline that replaces the numbers above
as the bar), then runs after C1, C3, C4 and the last ticket. "Live expected after" below is the
ticket after which a case should pass live: the later of the ticket that makes it a tier 1
required pass and C3, except for the refusal cases; every live column assumes C0 has merged.

Every case in `evals/catalog.json` with PR #84 merged (102). Every case changes its call names;
the "Change beyond the name" column lists the cases whose predicates or requirements change too.

| Case ID | Required calls (tool.operation, key predicates) | Change beyond the name | Tier 1 required after | Live expected after |
|---|---|---|---|---|
| spending-annual-exclusions | `spending.total` (measure spending, annualize true, exclude.classes has debt_service, exclude.buckets has tax) | predicates rewritten: the old exclude, includeHealthcare and income_tax paths name no parameter | C4 | C4 |
| spending-portfolio-withdrawal | `retirement.target` (withdrawalRate.value 0.04, withdrawalRate.source owner, definition core_living, roundTo 1); capability ownerStatements | predicate path withdrawalRate becomes withdrawalRate.value; adds `definition core_living` and `roundTo 1`; adds capability ownerStatements; its `portfolio` expectation changes (below) | C6 | C6 |
| spending-latest-groceries | `transactions.search` (category groceries, limit 1) | name | C1 | C3 |
| spending-latest-dining | `transactions.search` (category dining, limit 1) | name | C1 | C3 |
| spending-latest-health | `transactions.search` (category health, limit 1) | name | C1 | C3 |
| cash-personal | `household.figures` (keys has personal_cash or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| cash-business | `household.figures` (keys has biz_cash or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| cash-true-reserve | `household.figures` (keys has true_reserve or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| business-stored-revenue | `household.figures` (keys has revenue_ytd or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| net-worth-current | `household.figures` (keys has net_worth or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| retirement-hsa-room | `household.figures` (keys has hsa_left or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| retirement-current-room | `household.figures` (keys has ret_room_now or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| retirement-hsa-paid | `household.figures` (keys has hsa_paid or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| retirement-pretax | `household.figures` (keys has my_pretax or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| taxes-safe-harbor | `household.figures` (keys has safe_harbor or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| taxes-federal-paid | `household.figures` (keys has fed_paid or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| taxes-state-paid | `household.figures` (keys has va_paid or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| taxes-liability | `household.figures` (keys has liability or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| taxes-april-due | `household.figures` (keys has april_due or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| cash-flow-month | `spending.cash_flow` (window custom, from 2026-01, to 2026-01) | predicates rewritten: from and to are months, not days | C4 | C4 |
| business-pnl-january | `business.pnl` (from 2026-01, to 2026-01) | name | C1 | C3 |
| business-pnl-february | `business.pnl` (from 2026-02, to 2026-02) | name | C1 | C3 |
| business-pnl-march | `business.pnl` (from 2026-03, to 2026-03) | name | C1 | C3 |
| net-worth-history | `accounts.net_worth` (series true) | adds the series predicate | C5 | C5 |
| net-worth-change | `accounts.net_worth` (series true); `calculate.subtract` | includeChange names no parameter; the change is a calculate subtract over the series ends | C5 | C5 |
| goals-open | `goals.list` | name | C1 | C3 |
| goals-pace | `goals.pace` | name | C1 | C3 |
| freshness-household | `household.summary` | name | C1 | C3 |
| freshness-facts | `household.facts` | name | C1 | C3 |
| unavailable-credit-score | `household.facts` | name | C1 | C3 |
| unavailable-routing-number | `accounts.list` | name | C1 | C3 |
| unavailable-market-forecast | `accounts.holdings` | name | C1 | C3 |
| retirement-hsa-follow-up | `household.figures` (keys has hsa_left or absent); `household.figures` (keys has hsa_paid or absent) | predicate becomes `includes_or_absent` on `keys` | C1 | C3 |
| q01-spend-excl-mortgage-tax | `spending.total` (measure spending, annualize true, exclude.classes has debt_service, exclude.categories has Mortgage, exclude.buckets has tax) | name | C4 | C4 |
| q02-independence-target-4pct | `retirement.target` (withdrawalRate.value 0.04, withdrawalRate.source owner); capability ownerStatements | name | C6 | C6 |
| q03-gap-and-date | `retirement.target` (withdrawalRate.value 0.04, withdrawalRate.source owner); capability ownerStatements | name | C6 | C6 |
| q04-groceries-dining-monthly | `spending.total` (measure spending, groupBy month, include.categories has groceries, include.categories has dining) | name | C4 | C4 |
| q05-essential-vs-discretionary | `spending.total` (definition essential); `spending.total` (definition discretionary) | name | C4 | C4 |
| q06-top-merchants | `spending.total` (groupBy merchant, limit 10) | name | C4 | C4 |
| q07-childcare-2025 | `spending.total` (window calendar_year, year 2025, include.classes has childcare) | name | C4 | C4 |
| q08-healthcare-premiums | `spending.total` (include.classes has healthcare) | name | C4 | C4 |
| q09-elective-definition | `spending.total` (definition elective_spending); capability definitions | name | C10 | C10 |
| q09b-elective-definition-later-thread | `spending.total` (definition elective_spending); capability definitions | name | C10 | C10 |
| q10-save-elective-definition | `update_preferences.save_definition` (def.exclude.classes has housing, def.exclude.classes has debt_service, def.exclude.classes has childcare, def.exclude.classes has healthcare, def.exclude.classes has taxes); capability definitions | name | C10 | C10 |
| q11-monthly-net-cash-flow | `spending.cash_flow` (scope all) | name | C4 | C4 |
| q12-business-to-personal | `spending.cash_flow` (scope all) | name | C4 | C4 |
| q13-negative-months | `spending.cash_flow` (scope household) | name | C4 | C4 |
| q14-savings-rate | `spending.total` (window trailing_12); `calculate.divide` | calculate op predicate becomes the operation | C4 | C4 |
| q15-income-by-source | `spending.total` (measure income, groupBy merchant); `business.pnl` | name | C4 | C4 |
| q16-monthly-take-home | `spending.total` (measure income, window trailing_12) | name | C4 | C4 |
| q17-business-profit-margin | `business.pnl` (window ytd); capability businessPeriods | adds capability businessPeriods (its parameters arrive in C4) | C4 | C4 |
| q18-revenue-vs-last-year | `business.pnl` (compareToPriorYear true); capability businessPeriods | adds capability businessPeriods (its parameters arrive in C4) | C4 | C4 |
| q19-expense-categories-quarter | `business.pnl` (groupBy category, window custom); capability businessPeriods | adds capability businessPeriods (its parameters arrive in C4) | C4 | C4 |
| q20-net-worth-parts | `accounts.net_worth` (groupBy part) | name | C5 | C5 |
| q21-net-worth-change | `accounts.net_worth` (series true); `calculate.subtract` | calculate op predicate becomes the operation | C5 | C5 |
| q22-retirement-vs-taxable | `accounts.net_worth` (groupBy treatment) | name | C5 | C5 |
| q23-ten-year-growth | `retirement.growth` (solve balance, years 10) | name | C6 | C6 |
| q24-monthly-to-target-by-55 | `retirement.target`; `retirement.growth` (solve monthly, byAge.age 55) | name | C6 | C6 |
| q25-return-3pct-whatif | `retirement.target` (realReturn.value 0.03, realReturn.source owner); capability ownerStatements | name | C6 | C6 |
| q26-withdrawal-35pct | `retirement.target` (withdrawalRate.value 0.035, withdrawalRate.source owner); capability ownerStatements | name | C6 | C6 |
| q27-extra-1000-sooner | `retirement.target`; `calculate.subtract`; capability ownerStatements | calculate op predicate becomes the operation | C6 | C6 |
| q28-15m-retirement-vs-brokerage | `retirement.after_tax` (hypothetical exists); capability ownerStatements | name | C6 | C6 |
| q29-penalty-free-access | `retirement.access` (people both) | name | C7 | C7 |
| q30-rmd-start | `retirement.access` (people both) | name | C7 | C7 |
| q31-bridge-to-59-half | `retirement.bridge` (retireAge.value 50, retireAge.source owner); capability ownerStatements | name | C7 | C7 |
| q32-accounts-by-treatment | `accounts.net_worth` (groupBy treatment) | name | C5 | C5 |
| q33-unrealized-gains-tax | `tax.estimate`; `retirement.after_tax` (kinds has taxable) | name | C6 | C6 |
| q34-tax-owed | `tax.estimate` | name | C5 | C5 |
| q35-safe-harbor | `tax.estimate` | name | C5 | C5 |
| q36-extra-income-whatif | `tax.estimate` (whatIf.extraIncome.value 20000, whatIf.extraIncome.source owner); capability ownerStatements | name | C5 | C5 |
| q37-se-tax | `tax.estimate` | name | C5 | C5 |
| q38-solo401k-room | `tax.room` (person owner, types has solo401k_pretax) | name | C5 | C5 |
| q39-ira-room | `tax.room` (types has traditional_ira) | name | C5 | C5 |
| q40-hsa-room | `tax.room` (types has hsa) | name | C5 | C5 |
| q41-529-contributions | `spending.total` (measure inflow); `tax.room` (types has plan529_state_deduction) | name | C5 | C5 |
| q42-dependent-care-limit | `tax.room` (types has dependent_care) | name | C5 | C5 |
| q43-goal-pace | `goals.pace` | name | C1 | C3 |
| q44-cash-cushion-months | `accounts.net_worth`; `spending.total` (measure spending); `calculate.divide` | calculate op predicate becomes the operation | C5 | C5 |
| q45-subscriptions-annual | `spending.recurring` (status active) | name | C4 | C4 |
| q46-new-recurring | `spending.recurring` (status new) | name | C4 | C4 |
| q47-stopped-or-changed | `spending.recurring` (status all, since exists) | name | C4 | C4 |
| q48-this-year-vs-last | `spending.compare` (groupBy category) | name | C4 | C4 |
| q49-summer-vs-summer | `spending.compare` (b.from 2026-06, b.to 2026-08) | name | C4 | C4 |
| q50-dining-trend | `spending.compare` (include.categories has dining) | name | C4 | C4 |
| q51-spending-after-mortgage | `spending.projection` (obligations has mortgage) | name | C7 | C7 |
| q52-spending-after-childcare | `spending.projection` (obligations has childcare) | name | C7 | C7 |
| q53-mortgage-end | `spending.obligations` (obligations has mortgage) | predicate path kinds becomes obligations | C7 | C7 |
| q54-childcare-changes | `spending.obligations` (obligations has childcare) | predicate path kinds becomes obligations | C7 | C7 |
| q55-529-end | `spending.obligations` (obligations has plan529) | predicate path kinds becomes obligations | C7 | C7 |
| q56-stale-accounts | `household.health` | name | C5 | C5 |
| q57-uncategorized-count | `household.health` | name | C5 | C5 |
| q58-no-history-accounts | `household.health` | name | C5 | C5 |
| q59-change-account-owner | `accounts.list`; `update_account.owner` (owner owner) | name | C8 | C8 |
| q60-merchant-rule-groceries | `transactions.search`; `categorize.merchant_rule` (category Groceries) | name | C8 | C8 |
| q61-mark-1099-not-needed | `answer.yearend_mark` (reason exists) | name | C8 | C8 |
| q62-decide-salary-option | `recommendations.list`; `act_on_recommendation.decide` | name | C9 | C9 |
| q63-archive-goal | `goals.list`; `update_goal.archive` | name | C9 | C9 |
| q64-send-to-advisor | `advisor_review.send` | name | C9 | C9 |
| q65-sync-now | `refresh.run_job` (job simplefin-sync) | predicate path id becomes job | C10 | C10 |
| q66-security-pick-refused | none | name | C1 | C1 |
| q67-market-quote-refused | none | name | C1 | C1 |
| q68-money-movement-refused | none | name | C1 | C1 |

Predicate paths keep their names except: `spending.obligations` uses `obligations` (was `kinds`,
cases q53 to q55), `refresh.run_job` uses `job` (was `id`, q65), and a `calculate` call's `op`
becomes its operation (q14, q21, q27, q44, net-worth-change). The three refusal cases keep their
forbidden checks (q68 forbids any write tool).

Oracle changes in `evals/cases.mjs` (C1). The `portfolio` expectation (case
`spending-portfolio-withdrawal`) and the `annual-spending` expectation (cases
`spending-annual-exclusions` and `q01-spend-excl-mortgage-tax`) compute the same selection the
calls now name: household spending on checking and card accounts over the complete months on
file, annualized, leaving out the `debt_service` class and the `tax` bucket by the
`CATEGORY_CLASSES` table, computed independently from the transactions table rather than by
calling the tool. `portfolio` divides that by the rate and rounds up to the whole dollar, which is
what `retirement.target` returns with `definition: 'core_living'` and `roundTo: 1`; it no longer
rounds to cents.

## 9. Migration from the old names

Every caller of a current tool name moves to its new (tool, operation) pair in the same ticket that
replaces the name, and the old name stops existing in that ticket. No aliases, no compatibility
shims, no dual-format loader (AGENTS.md and the repository rule against compatibility paths). The
callers for the live names, all in C1:

1. The Ask prompt and rules in `src/api/answerer.mjs`: the static lines that name `get_figures`,
   `remember_preference`, `list_accounts`, `query_transactions` and `pnl_by_month`, the
   `TOOL_SOURCES` and `PROGRESS_LABELS` maps, the `query_transactions` grounding special cases, and
   the internal `callTool('household_summary')`, `callTool('list_accounts')` and
   `callTool('get_recommendation')` calls.
2. `src/api/fake-answers.mjs`, the scripted engine's calls.
3. The ask-quality `TOOL_NAMES` fixture in `test/ask-quality.test.mjs`, which becomes the sorted
   list of (tool, operation) pairs, and every other test and e2e spec listed in C1's Files.
4. Evals: `evals/catalog.json`, `evals/cases.mjs`, `evals/graders.mjs`, `evals/harness.mjs`
   (section 8).
5. The MCP smoke: `scripts/mcp-smoke.mjs`, `test/mcp-deploy-smoke.test.mjs`, the smoke section of
   `docs/development.md`, and the deployment's MCP smoke list, kept with the deployment outside
   this repository, which the deploy that ships C1 updates.
6. `src/mcp/keys.mjs` `SCOPE_INFO` access text.
7. Docs: `docs/architecture.md` (section 8 tool table, pack search paragraph), `docs/development.md`,
   `docs/known-limits.md`.

Planned names never existed in code; their only callers are this document and PR #84's cases,
which C1 re-points. Stored data holds no tool name anything re-reads: thread history keeps the
names and labels it was answered with, and refs are computed per call. MCP clients see the new
names on the first deploy after C1 merges.

Every old name and its replacement:

| Old name | Status | New (tool.operation) | Ticket |
|---|---|---|---|
| `household_summary` | live | `household.summary` | C1 |
| `get_facts` | live | `household.facts` | C1 |
| `get_fact_answer_shapes` | live | `household.fact_shapes` | C1 |
| `get_figures` | live | `household.figures` | C1 |
| `list_deadlines` | live | `household.deadlines` | C1 |
| `list_accounts` | live | `accounts.list` | C1 |
| `list_positions` | live | `accounts.holdings` | C1 |
| `query_transactions` | live | `transactions.search` | C1 |
| `pnl_by_month` | live | `business.pnl` | C1 |
| `list_goals` | live | `goals.list` | C1 |
| `get_pace` | live | `goals.pace` | C1 |
| `list_recommendations` | live | `recommendations.list` | C1 |
| `get_recommendation` | live | `recommendations.detail` | C1 |
| `advisor_status` | live | `recommendations.advisor` | C1 |
| `list_packs` | live | `knowledge.packs` | C1 |
| `packs_status` | live | `knowledge.packs` | C1 |
| `search_pack_entries` | live | `knowledge.search` | C1 |
| `get_pack_entry` | live | `knowledge.entry` | C1 |
| `record_household_fact` | live | `answer.fact` | C1 |
| `set_recommendation_status` | live | `act_on_recommendation.status` | C1 |
| `set_recommendation_owner` | live | `act_on_recommendation.owner` | C1 |
| `set_recommendation_step` | live | `act_on_recommendation.step` | C1 |
| `create_goal` | live | `update_goal.create` | C1 |
| `edit_goal` | live | `update_goal.edit` | C1 |
| `remember_preference` | live | `update_preferences.remember` | C1 |
| `undo_fact_action` | live | `undo.undo` | C1 |
| `undo_goal_action` | live | `undo.undo` | C1 |
| `undo_preference_action` | live | `undo.undo` | C1 |
| `undo_recommendation_action` | live | `undo.undo` | C1 |
| `undo_step_action` | live | `undo.undo` | C1 |
| `calculate` | planned | `calculate.<arithmetic>` | C3 |
| `aggregate_transactions` | planned | `spending.total` | C4 |
| `compare_periods` | planned | `spending.compare` | C4 |
| `cash_flow` | planned | `spending.cash_flow` | C4 |
| `recurring_charges` | planned | `spending.recurring` | C4 |
| `list_spending_definitions` | planned | `spending.definitions` | C4 |
| `business_pnl` | planned | `business.pnl` | C4 |
| `net_worth` | planned | `accounts.net_worth` | C5 |
| `data_health` | planned | `household.health` | C5 |
| `tax_estimate` | planned | `tax.estimate` | C5 |
| `contribution_room` | planned | `tax.room` | C5 |
| `independence_target` | planned | `retirement.target` | C6 |
| `project_growth` | planned | `retirement.growth` | C6 |
| `after_tax_value` | planned | `retirement.after_tax` | C6 |
| `obligation_schedule` | planned | `spending.obligations` | C7 |
| `spending_projection` | planned | `spending.projection` | C7 |
| `access_schedule` | planned | `retirement.access` | C7 |
| `bridge_check` | planned | `retirement.bridge` | C7 |
| `list_confirm_items` | planned | `household.confirm_items` | C8 |
| `list_merge_candidates` | planned | `accounts.merge_candidates` | C8 |
| `answer_recommendation_questions` | planned | `answer.rec_questions` | C8 |
| `answer_confirm_item` | planned | `answer.confirm` | C8 |
| `reopen_confirm_item` | planned | `answer.reopen` | C8 |
| `mark_yearend_item` | planned | `answer.yearend_mark` | C8 |
| `set_transaction_category` | planned | `categorize.transaction` | C8 |
| `set_merchant_rule` | planned | `categorize.merchant_rule` | C8 |
| `rename_account` | planned | `update_account.rename` | C8 |
| `set_account_mask` | planned | `update_account.mask` | C8 |
| `set_account_owner` | planned | `update_account.owner` | C8 |
| `set_account_kind` | planned | `update_account.kind` | C8 |
| `merge_accounts` | planned | `update_account.merge` | C8 |
| `start_recommendation_over` | planned | `act_on_recommendation.start_over` | C9 |
| `decide_decision` | planned | `act_on_recommendation.decide` | C9 |
| `revisit_decision` | planned | `act_on_recommendation.revisit` | C9 |
| `pick_wargame_point` | planned | `act_on_recommendation.pick_point` | C9 |
| `send_to_advisor` | planned | `advisor_review.send` | C9 |
| `record_advisor_verdict` | planned | `advisor_review.verdict` | C9 |
| `set_advisor_checkin` | planned | `advisor_review.checkin` | C9 |
| `create_review_packet` | planned | `advisor_review.packet` | C9 |
| `archive_goal` | planned | `update_goal.archive` | C9 |
| `delete_goal` | planned | `update_goal.delete` | C9 |
| `set_goal_suggestion` | planned | `update_goal.suggestion` | C9 |
| `set_curve_position` | planned | `update_preferences.curve` | C9 |
| `forget_preference` | planned | `update_preferences.forget` | C10 |
| `save_spending_definition` | planned | `update_preferences.save_definition` | C10 |
| `delete_spending_definition` | planned | `update_preferences.delete_definition` | C10 |
| `set_pack_active` | planned | `update_preferences.pack` | C10 |
| `import_file` | planned | `refresh.import_file` | C10 |
| `retry_import` | planned | `refresh.retry_import` | C10 |
| `build_your_plans` | planned | `refresh.build_your_plans` | C10 |
| `run_job` | planned | `refresh.run_job` | C10 |
| `undo_account_action` | planned | `undo.undo` | C1 |
| `undo_category_action` | planned | `undo.undo` | C1 |
| `undo_confirm_action` | planned | `undo.undo` | C1 |
| `undo_decision_action` | planned | `undo.undo` | C1 |
