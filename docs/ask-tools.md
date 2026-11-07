# Ask and MCP tool catalog

This is the plan for Fathom's deterministic tool layer: the read tools that compute every figure
Ask and an MCP client need, the write tools that put the whole internal API in the agent's reach,
the rules the model follows when it uses them, and the tickets that build it. It extends the
frozen tool interface in [architecture.md, section 8](architecture.md#8-tool-interface). Status:
planned. Nothing here is built until its ticket in section 7 merges.

Owner direction:

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

Calendar estimate: about three to five calendar days end to end at three parallel workers, each
ticket one agent run plus CI and a cross-provider review. The sibling merges and the owner's merge
gate set the date, not agent runs. Section 7 gives the waves.

1. feat/auto-categories has merged to main. `resolveCategories`, `loadCategoryInputs`,
   `categoryCoverage` and the category-aware `spendingInputs` are available. It no longer blocks
   anything.
2. feat/account-dialog-edit (open) adds the account mask, owner, kind, merge-candidates and merge
   routes in `src/api/accounts.mjs`. The account write tools (T27) wrap the store functions those
   handlers call (`setAccountAnswer`, `undoAccountAnswer`, `mergePlan`, `manualMerge`,
   `queueAccountPairs`) and wait for it to merge.
3. feat/ask-actions (open) adds the `write:facts`, `write:steps`, `write:goals` and
   `write:preferences` scopes (`WRITE_SCOPES` in `src/shared/action-scopes.mjs`), action receipts
   with Undo (`src/actions/receipts.mjs`), `record_household_fact`, `remember_preference`,
   `create_goal`, `edit_goal`, `set_recommendation_step`, and migration 025 (`action_receipts`,
   `preferences`). Saved spending definitions (T18), the new fact shapes (T19), the scope work
   (T17) and every write ticket after it depend on it.
4. fix/ask-answer-quality (open, no commits yet) owns the system prompt and grounding in
   `src/api/answerer.mjs`. The model-rules ticket (T28) edits the prompt only after it merges.
   T8 (a progress label) and T17 (tool services in the Ask context) also edit that file, so T8,
   T17 and T28 are serialized in that order.
5. feat/ask-evals (open, nothing published) will own the eval case format and runner. The case IDs
   in section 8 are proposals. T16 writes the cases once the runner merges; until then each
   ticket's unit tests are its gate.
6. Grounding of assumptions. The answerer drops argument echoes from tool results (a leaf under an
   argument's key with an equal value). An assumption the model passes, such as a 4 percent
   withdrawal rate, may not ground when the model repeats it, because the result's
   `provenance.assumptions[].value` sits under the same key name as the argument. T5 adds a test
   that a stated assumption and a `calculate` result both ground through `groundAnswer`; the
   result carries each assumption also as a `stated` text leaf ("4%") under a key no argument uses.
   An assumption with source `owner` must carry the owner's words as `evidence`, so the model
   cannot attribute a number to the owner that the owner never said.
   If that test cannot pass without an answerer change, T5 records the failure as an expected-fail
   case for T28, which makes the change after fix/ask-answer-quality merges.
7. Prompt size. The registry grows from 20 tools to about 70. Every description stays at or under
   300 characters, and the routing rules in section 4 matter more than tool count. T28 measures the
   tool list size in the prompt and fails if it passes 24 KB.
8. Migration numbering. T18 adds one table. Its number is set at merge time per AGENTS.md rule 7;
   025 is taken by feat/ask-actions.
9. Cost of re-evaluating references. A reference re-runs its read call server-side. Depth is
   capped at 3 and every read tool is bounded by the household store size, so a chained answer
   costs a few extra milliseconds at household scale.
10. Merge gate. The owner approves merges. Three workers can finish wave 2 in a day; whether wave 2
    lands in a day depends on review and merge cadence.

## 1. Question taxonomy

Questions in an independent-professional household's words. Q01 is the trigger question verbatim,
Q02 and Q03 its assumed follow-ups. Q66, Q67 and Q68 are questions Fathom must answer with
"Fathom does not have that": a security pick (advisory boundary), a live market quote (no market
data feed) and money movement (read-only accounts).

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

Calls are in order, with key arguments. `R(Qnn)` means a figure reference (section 3) to the named
figure of that question's call, copied from the figure's own `ref` field. The model's part is
always: choose the tools, state the assumptions with their source, explain, report the gaps. It
never computes. "Window" below is `spending_window` unless stated.

| ID | Calls | Model's part |
|---|---|---|
| Q01 | `aggregate_transactions {measure: 'spending', window: 'spending_window', annualize: true, groupBy: 'class', exclude: {categories: ['Mortgage', 'housing'], classes: ['debt_service'], buckets: ['tax']}}`. No include: healthcare stays in because it is household spending and is not excluded; the `healthcare` group shows its amount. `definition: 'core_living'` selects the same rows. | State the yearly total, the window, that healthcare is in (with its group figure), and what was left out with `excluded[].matched` amounts (mortgage payments, income tax). Report every gap: uncategorized and guessed rows with amounts, card or other spending accounts with no history, and the `outside_household_ledger` gap that premiums paid through payroll or a business account are not in household transactions. |
| Q02 | `independence_target {spending: R(Q01 total), withdrawalRate: {name: 'withdrawalRate', value: 0.04, unit: 'ratio', source: 'owner'}}` | Name the spending figure it divides (Q01's), the rate as the owner's, and the rounding to the next thousand. Say the target inherits Q01's gaps. |
| Q03 | Same `independence_target` call as Q02 (re-run, same arguments) | Report `gap`, `months` and `projectedDate`. State the defaults it used: real return 4 percent (default), monthly savings from recent data (window named), and which accounts count as invested now. If status is `no_savings` or `too_long`, say so instead of a date. |
| Q04 | `aggregate_transactions {measure: 'spending', include: {categories: ['Groceries', 'groceries', 'Dining & Drinks', 'dining']}, groupBy: 'month'}`, then the same with `groupBy: 'category'` | Report the monthly figures and the split. Note that warehouse-club rows may sit under Shopping (gap: classified by category, not merchant). |
| Q05 | `aggregate_transactions {measure: 'spending', definition: 'essential', annualize: true}` and `aggregate_transactions {measure: 'spending', definition: 'discretionary', annualize: true}` | Report the two totals as returned (each is one figure over its whole include set) and say what each definition contains, citing the spending pack entry. |
| Q06 | `aggregate_transactions {measure: 'spending', window: 'ytd', groupBy: 'merchant', limit: 10}` | List the ten groups and the `other` group. Merchants are normalized descriptions. |
| Q07 | `aggregate_transactions {measure: 'spending', window: 'calendar_year', year: 2025, include: {classes: ['childcare']}}` | Report the total; if `incomplete_month` or `account_no_history` gaps cover part of 2025, say how much of the year is on file. |
| Q08 | `aggregate_transactions {measure: 'spending', window: 'calendar_year', year: 2025, include: {classes: ['healthcare']}, groupBy: 'category'}` | Report the total and the premium category. State the `outside_household_ledger` gap: premiums withheld from pay or paid by the business do not appear. |
| Q09 | `aggregate_transactions {measure: 'spending', definition: 'elective_spending', annualize: true}` (the Ask context lists saved definitions by name and id, so no lookup call is needed; MCP clients call `list_spending_definitions` first) | Resolve "my elective spending" to the saved definition, even in a later conversation than the one that saved it. Say which selectors the definition applies. |
| Q10 | `save_spending_definition {id: 'elective_spending', name: 'Elective spending', def: {exclude: {classes: ['housing', 'debt_service', 'childcare', 'healthcare', 'taxes']}}, evidence: <the owner's words>}` (chat purpose; never `remember_preference` for a definition) | Confirm what was saved with the receipt and Undo, and that it is remembered as a preference that names the definition. Offer to compute it. |
| Q11 | `cash_flow {window: 'ytd', scope: 'all'}` | Read the monthly inflow, outflow and net for household and business, and the transfers between them, from the result. |
| Q12 | `cash_flow {window: 'ytd', scope: 'all'}` | Report `totals.transfersBusinessToHousehold`. Say transfers are matched pairs within five days. |
| Q13 | `cash_flow {window: 'ytd', scope: 'household'}` | Name the months whose `net` figure is negative. |
| Q14 | `aggregate_transactions {measure: 'income', window: 'trailing_12'}`, `aggregate_transactions {measure: 'spending', window: 'trailing_12'}`, then `calculate {op: 'divide', operands: [{expr: {op: 'subtract', operands: [R(income total), R(spending total)]}}, R(income total)]}` | State the rate as a share of household income, and that business retained earnings are not counted. |
| Q15 | `aggregate_transactions {measure: 'income', window: 'ytd', groupBy: 'merchant'}` and `business_pnl {window: 'ytd', groupBy: 'none'}` | Separate household deposits by payer from business revenue. Say owner distributions are transfers, not income, unless the business account is the source. |
| Q16 | `aggregate_transactions {measure: 'income', window: 'trailing_12'}` | Report `perMonth`. Say it is deposits to household accounts, after withholding. |
| Q17 | `business_pnl {window: 'ytd', groupBy: 'none'}` | Report profit and margin per entity. |
| Q18 | `business_pnl {window: 'ytd', groupBy: 'month', compareToPriorYear: true}` | Report `revenue`, `prior.revenue`, `prior.revenueDifference` and `prior.revenueRatio` as returned. |
| Q19 | `business_pnl {window: 'custom', from: '2026-07', to: '2026-09', groupBy: 'category'}` | Pick last quarter's months from today's date; list the largest expense groups. |
| Q20 | `net_worth {groupBy: 'part'}` | Report the total and the parts; name carried accounts (stale balances carried forward). |
| Q21 | `net_worth {series: true, months: 12}` then `calculate {op: 'subtract', operands: [R(last point total), R(first point total)]}` | Report the change; mention carried accounts at the ends of the series. |
| Q22 | `net_worth {groupBy: 'treatment'}` | Report the pre-tax, Roth and taxable group totals as returned. A difference between them is a `calculate subtract` call, never a mental one. |
| Q23 | `project_growth {solve: 'balance', balance: R(independence_target investedNow), monthlyContribution: R(independence_target monthlySavings), years: 10}` | State the real return default and that the result is in today's dollars. |
| Q24 | `independence_target {}` (default spending), then `project_growth {solve: 'monthly', balance: R(investedNow), target: R(target), byAge: {person: 'owner', age: 55}}` | State the target source and assumptions. If the owner's birth date or age is missing, say so and offer to record it. |
| Q25 | `independence_target {realReturn: {name: 'realReturn', value: 0.03, unit: 'ratio', source: 'owner'}}` and the default call, then `calculate {op: 'subtract', operands: [R(months at 3%), R(months at 4%)]}` | Report both dates and the difference in months. |
| Q26 | `independence_target {withdrawalRate: {name: 'withdrawalRate', value: 0.035, unit: 'ratio', source: 'owner'}}` | Report the target; note the rate is inside the allowed range of 2 to 6 percent. |
| Q27 | `independence_target {}`, then `independence_target {monthlySavings: {expr: {op: 'add', operands: [R(monthlySavings), {assumption: {name: 'extraMonthlySavings', value: 1000, unit: 'usd_per_month', source: 'owner'}}]}}}`, then `calculate subtract` on the two `months` figures | Report both dates and the months saved. |
| Q28 | `tax_estimate {}`, then `after_tax_value {hypothetical: [{treatment: 'pretax', value: {name: 'amount', value: 15000000, unit: 'usd', source: 'owner', evidence: '$15 million in retirement accounts'}}, {treatment: 'taxable', value: {name: 'amount', value: 15000000, unit: 'usd', source: 'owner', evidence: '$15 million in a brokerage account'}}], ordinaryRate: R(marginal.federal), stateRate: R(marginal.state), capitalGainsRate: R(marginal.capitalGains)}`. No basis is passed: the owner stated none. | Report the pre-tax row's after-tax value. For the brokerage row, `taxOnWithdrawal` and `afterTax` come back unavailable with a `no_cost_basis` gap: say the tax depends on the cost basis and ask for it; never supply one. Explain where the tax shows up and when the money can come out, citing the treatment pack. Never call one better. |
| Q29 | `access_schedule {people: 'both'}` | Read each milestone with its pack citation (59 and a half, rule of 55, Roth basis, HSA at 65). |
| Q30 | `access_schedule {people: 'both'}` | Report the RMD start age and date per person and the birth-year rule cited. |
| Q31 | `bridge_check {retireAge: {name: 'retireAge', value: 50, unit: 'age', source: 'owner'}, person: 'owner', spending: R(Q01 total)}` or with `definition: 'household_spending'` | Report spending needed until access age against accessible money, the shortfall or surplus, and the exceptions the tool notes. Recommend nothing. |
| Q32 | `net_worth {groupBy: 'treatment'}` | List the accounts per treatment from the groups; name accounts whose treatment is inferred from kind. |
| Q33 | `tax_estimate {}`, then `after_tax_value {kinds: ['taxable', 'brokerage'], ordinaryRate: R(marginal.federal), stateRate: R(marginal.state), capitalGainsRate: R(marginal.capitalGains)}` | Report unrealized gain and the tax figure; state the `missing_fact` gap for positions with no cost basis. |
| Q34 | `tax_estimate {}` | Report federal, state and self-employment projections, kind and as-of; say they come from the last planning run. |
| Q35 | `tax_estimate {}` and `list_deadlines {from: today}` | Report required, paid and remaining safe-harbor amounts and the next due date. |
| Q36 | `tax_estimate {whatIf: {extraIncome: {name: 'extraIncome', value: 20000, unit: 'usd', source: 'owner'}, incomeType: 'business'}}` | Report `whatIf.totalDelta` and its parts. |
| Q37 | `tax_estimate {}` | Report `federal.selfEmployment`. |
| Q38 | `contribution_room {person: 'owner', types: ['solo401k_pretax', 'solo401k_employer', 'employee_deferral']}` | Report limit, used and remaining per type, and the deadline. |
| Q39 | `contribution_room {person: 'both', types: ['traditional_ira', 'roth_ira']}` | Report remaining room and the deadline; say when income limits apply (pack). |
| Q40 | `contribution_room {types: ['hsa']}` | Report remaining room; say coverage type comes from the stored fact. |
| Q41 | `aggregate_transactions {measure: 'inflow', window: 'ytd', include: {accounts: [<529 account ids from list_accounts>]}}` after `list_accounts`, then `contribution_room {types: ['plan529_state_deduction']}` | Report contributions and the deductible part; cite the state pack. |
| Q42 | `contribution_room {types: ['dependent_care']}` | Report the limit; say payroll elections are outside the household ledger (gap) so used is unknown. |
| Q43 | `get_pace` | Report each goal's pace as returned. |
| Q44 | `net_worth {groupBy: 'part'}`, `aggregate_transactions {measure: 'spending'}`, then `calculate {op: 'divide', operands: [R(part cash), R(spending perMonth)]}` | Report months of cover; name the accounts counted as cash. |
| Q45 | `recurring_charges {status: 'active'}` | List the charges with cadence and annual cost, and the total. |
| Q46 | `recurring_charges {status: 'new', since: <date three months ago>}` | Pick the date from today; list new charges. |
| Q47 | `recurring_charges {status: 'all', since: '2026-06-01'}` | List stopped charges and those whose `changed` is set. |
| Q48 | `compare_periods {measure: 'spending', a: {window: 'custom', from: '2025-01', to: '2025-10'}, b: {window: 'custom', from: '2026-01', to: '2026-10'}, groupBy: 'category'}` | Choose matching complete months; report the difference and the largest group deltas. |
| Q49 | `compare_periods {measure: 'spending', a: {window: 'custom', from: '2025-06', to: '2025-08'}, b: {window: 'custom', from: '2026-06', to: '2026-08'}}` | Say which months "summer" means (an assumption, source default). |
| Q50 | `compare_periods {measure: 'spending', include: {categories: ['Dining & Drinks', 'dining']}, a: {window: 'custom', from: '2026-02', to: '2026-04'}, b: {window: 'custom', from: '2026-08', to: '2026-10'}}` | State the three-month windows chosen and report the ratio. |
| Q51 | `spending_projection {definition: 'household_spending', years: 10, obligations: ['mortgage']}` | Report the payoff year and the spending after, as returned; say the stated escrow continues as housing (pack). If `obligations.mortgage` is missing, the change is unavailable: report the gap and offer to record the fact. |
| Q52 | `spending_projection {definition: 'household_spending', years: 15, obligations: ['childcare']}` | Report each change date and new amount, and how each was derived. A change whose new amount is not stated (no `obligations.childcare` stage amount and no owner assumption) is listed as unavailable and not applied; say so and offer to record it. |
| Q53 | `obligation_schedule {kinds: ['mortgage']}` | Report end date, monthly payment and the derivation (stated payoff date or amortization). |
| Q54 | `obligation_schedule {kinds: ['childcare']}` | Report each child's change dates and the pack rule used. |
| Q55 | `obligation_schedule {kinds: ['plan529']}` | Report the end dates and the college-age assumption. |
| Q56 | `data_health {}` | List stale accounts with last data dates and ages. |
| Q57 | `data_health {}` | Report uncategorized and guessed counts; offer the Confirm items. |
| Q58 | `data_health {}` | List accounts whose `lastData` is empty. |
| Q59 | `list_accounts`, then `set_account_owner {id, owner: 'owner'}` (chat purpose) | Pick the account by name and current owner; if two match, ask which. Confirm with the receipt. |
| Q60 | `query_transactions {text: 'warehouse', limit: 5}`, then `set_merchant_rule {merchant: <normalized merchant from a row>, category: 'Groceries'}` | Confirm the rule and how many rows it reclassified. |
| Q61 | `data_health {}` (its `yearend.items` lists each expected document's key and issuer), then `mark_yearend_item {key: <that item's key>, reason: 'Account closed this year'}` | Pick the item by issuer and form; use the owner's reason in their words. |
| Q62 | `list_recommendations`, then `decide_decision {id, index: 1}` | Name the point decided and its figures from the result. |
| Q63 | `list_goals`, then `archive_goal {id}` | Confirm with the receipt. |
| Q64 | `list_recommendations`, then `send_to_advisor {recId}` | Confirm it is waiting on the advisor. |
| Q65 | `run_job {id: 'simplefin-sync'}` | Report the run status; if the connection is not set up, give the in-app link to Settings. |
| Q66 | none | Say Fathom does not have that: it does not select securities. Offer what it does have (contribution room, account treatment). |
| Q67 | none | Say Fathom does not have that: it has no live market data; holdings values are as of the last import. |
| Q68 | none | Say Fathom does not have that: it never moves money. Offer `tax_estimate` and the due date. |

## 3. Tool catalog

### Figure envelope

Every number a new tool returns is a figure:

```
{ value, unit, label, kind, asOf, window?, ref, provenance, gaps }
```

1. `value`: a finite number, an ISO date string when `unit` is `date`, or null when the figure
   is unavailable (then `unavailable` holds the gap code and the gap explains it).
2. `unit`: `usd`, `usd_per_month`, `usd_per_year`, `ratio`, `months`, `years`, `age`, `date`,
   `count`. Percents are never a unit. A `ratio` result is any finite number (a growth of 1.4, a
   negative change of minus 0.2); bounds belong to rate arguments, not to results.
3. Precision by unit: `usd`, `usd_per_month` and `usd_per_year` round to cents (`round` from
   `src/calc/pace.mjs`); `ratio` is not rounded (full double precision; `stated` text shows 6
   significant digits at most); `months` is an integer when it counts calendar months and a
   projection's months round up to the next whole month, as `dated` does; `years` round to 2
   decimals; `age` is an integer or a half year (59.5); `count` is an integer. Rounding happens
   once, when the figure is built, never on an input that feeds another figure (calculate works
   on the unrounded inputs and rounds its own result).
4. `label`: plain words, no digits, as the current `calc:targets` figures do.
5. `kind`: the existing letters: `a` actual, `p` projected, `e` estimate, `m` model, `t` target.
6. `asOf`: the latest data date the figure depends on (the newest row, balance or planner run it
   reads), not today.
7. `window`: `{ from: 'YYYY-MM', to: 'YYYY-MM', months }` when the figure covers a period.
8. `ref`: the figure reference that reproduces this figure (see below), filled in by the tool so
   the model copies it rather than composing one. Every figure a referenceable read tool returns
   carries one.

This generalizes the `calc:targets` and `calc:pace` figure shape (`{v, src, kind, label, notes,
locator: {calc, inputs, parameters, window, sources, steps, computedOn}}`). T1 moves `figure`,
`rowsSource` and `mergeSources` out of `src/calc/targets.mjs` into one shared module,
`src/calc/figure.mjs`, which builds both shapes, and `targets.mjs` imports them from there.
Stored figures keep their shape in the store. Two adapters in `src/calc/figure.mjs` turn the
existing shapes into envelopes, so `get_figures` and `get_pace` results are referenceable:

1. `fromStored(row, { ref })` for a `figures` row: `value` from `v`, `unit` from
   `locator.unit` when stated else `usd`, `kind` and `label` as stored, `asOf` from
   `locator.computedOn` else the source's `as_of`, `provenance.calc` from `locator.calc` else the
   row's `src`, `inputs`, `sources` and `steps` from the locator, `unavailable` from
   `unavailable_reason`, and the untouched `{ src, locator }` kept as `provenance.stored`.
2. `fromPace(fig, { ref })` for a `paceFigure` (`{v, src, kind, label, locator}`): the same
   mapping, with `asOf` from the locator's data-through date.

`get_figures` keeps every current field (`key`, `v`, `kind`, `label`, `source`, `unavailable`)
and adds the envelope fields beside them, with `ref: { tool: 'get_figures', args: { keys: [key] },
path: '0' }`. `get_pace` keeps its result and adds an envelope beside each figure it holds. Both
changes are T1's.

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
   `evidence` is the owner's words for an owner-sourced assumption.
3. `packRefs` name the pack entry that states each rule the figure applies.
4. Gap codes: `uncategorized_rows`, `guessed_rows`, `account_no_history`, `incomplete_month`,
   `stale_account`, `outside_household_ledger`, `missing_fact`, `carried_balance`,
   `unclassified_category`, `no_cost_basis`, `unequal_periods`. `amount` and `count` appear when the
   tool can measure the gap. A gap never changes the figure; the tool reports what it left out.
5. A result's top-level `gaps` is the union of its figures' gaps, deduplicated by code and message.

### Figure references and chaining

MCP is stateless per request, so references are re-evaluable, not session handles.

1. A `ref` is `{ tool, args, path }`: a read tool call and a dotted path to a figure in its result
   (`total`, `groups.2.figure`, `federal.projected`, `series.11.total`).
2. `calculate`, `independence_target`, `project_growth`, `spending_projection`, `bridge_check` and
   `after_tax_value` accept refs. They re-run the call server-side with the same `ctx` (same store,
   same clock) through `callTool`, take the figure at `path`, and append its provenance as an input.
3. Only read tools are referenceable. A ref to a write tool, to an unknown tool, or to a path that
   is not a figure is `bad_input`.
4. Nesting depth is at most 3 (a ref whose call holds a ref whose call holds a ref). Refs to
   `calculate` are allowed; that is chaining.
5. Literal numbers enter only as named assumptions with a source. A tool never accepts a bare
   number where a figure belongs.
6. `source: 'fact'` requires `factKey`; the tool reads that fact and refuses a value that differs.
   `source: 'preference'` requires `preferenceId` and checks the preference exists.
   `source: 'default'` is accepted only when the value equals the tool's documented default.
   `source: 'owner'` requires `evidence`, the owner's words. In Ask the tool checks the value
   appears in the owner's messages of this conversation with `requireEvidence`
   (`src/actions/evidence.mjs` on feat/ask-actions) and refuses otherwise; over MCP the evidence
   is kept verbatim in provenance. Until feat/ask-actions merges, owner assumptions are refused in
   Ask and accepted with evidence over MCP.
7. Every referenceable read tool fills `ref` on each figure it returns; `assertRefsResolve` (T1,
   `test/helpers/figures.mjs`) re-evaluates every ref in a result and asserts an equal figure, and
   every read-tool ticket runs it over its results.

### Scopes and MCP behavior

1. Every new read tool has scope `read`. Write scopes are listed per tool. `save_spending_definition`
   and `forget_preference` use `write:preferences` from feat/ask-actions.
2. MCP lists tools sorted by name. A call outside the key's scopes returns an `isError` result
   starting "Permission denied:" before argument validation; keep that order. Every ticket that
   adds a write tool adds a test that a read-only key gets that denial for it.
3. Ask runs the same registry through `createRegistryServer`. Every tool is offered to both Ask
   and MCP under its scope; write tools in Ask are offered only for purpose `chat`. No tool in
   this catalog is `mcpOnly`. (The feat/ask-actions undo tools are `mcpOnly` on that branch; the
   new undo tools here are not.)
4. Results carry account masks only, resolve scenario tokens to plain text and never include
   hidden recs (existing rules).
5. Write results carry the ask-actions receipt `{ id, scope, label, before, after, actorId, ts,
   undone, planningPending }` plus `undo: { available, tool?, args?, reason? }`. When `available`
   is true, `tool` and `args` are a call that validates against that tool's schema: either
   `undo_<scope>_action` with `{ id: <receipt id> }`, or a named domain inverse. When false,
   `reason` says why.
6. Receipt restoration. `undoAction` on feat/ask-actions restores only the kinds in its fixed
   `TABLES` map. T17 replaces that map with `registerReceiptKind(kind, { table, pk } or { restore
   })` in `src/actions/receipts.mjs`, keeps the existing kinds, and adds the four undo tools the new
   scopes need: `undo_account_action` (write:accounts), `undo_category_action`
   (write:categories), `undo_confirm_action` (write:confirm) and `undo_decision_action`
   (write:decisions). Each write ticket registers the receipt kinds it creates, from its own
   module, and tests that undo restores them.

### Limits

1. `calculate`: at most 20 operands per expression, expression depth at most 6.
2. Refs: nesting depth at most 3 across all tools.
3. Group lists: `limit` default 25, max 200, plus an `other` group so groups always sum to the total.
4. Periods: at most 120 months (`MAX_MONTHS` in `src/accounts/trend.mjs`).
5. Every new tool description is at most 300 characters.
6. A tool result is at most 256 KB of JSON; past that the tool truncates its longest list and sets
   `truncated: true`.

### Unchanged tools

`household_summary`, `get_facts`, `list_accounts`, `list_positions`, `list_recommendations`,
`get_recommendation`, `list_deadlines`, `list_goals`, `packs_status`,
`advisor_status`, `set_recommendation_status`, `set_recommendation_owner`, `list_packs`,
`get_pack_entry`, `search_pack_entries`, and the feat/ask-actions tools (`get_fact_answer_shapes`,
`record_household_fact`, `remember_preference`, `set_recommendation_step`, `create_goal`,
`edit_goal`, `undo_<kind>_action`) stay as they are. `pnl_by_month` is removed by T8.

### Shared argument types

| Type | Shape |
|---|---|
| Period | `window`: `spending_window` (default), `trailing_12`, `ytd`, `calendar_year`, `custom`; `year` (integer 2000..2100, required with `calendar_year`); `from`, `to` (`YYYY-MM`, required with `custom`, span at most 120 months) |
| Selector | `{ buckets?: Bucket[], categories?: string[] (max 50), classes?: Class[], accounts?: string[] (max 50), merchants?: string[] (normalized, max 50) }` |
| Bucket | `household`, `business`, `income`, `transfer`, `tax`, `saving`, `excluded` (`BUCKETS`) |
| Class | `housing`, `debt_service`, `healthcare`, `childcare`, `essential_other`, `discretionary`, `unclassified`, `savings`, `taxes`, `business`, `income`, `transfer`, `excluded` (section 5) |
| Assumption | `{ name (1..60), value: number, unit, source: 'owner', 'preference', 'fact' or 'default', note? (max 200), evidence? (required for owner), factKey?, preferenceId? }` |
| Rate bounds | Each rate argument has its own range: `withdrawalRate` 0.02..0.06; `realReturn` minus 0.05..0.10; `ordinaryRate`, `capitalGainsRate`, `stateRate` 0..0.6. `calculate` operands and every result are unbounded finite numbers. |
| Ref | `{ tool, args: object, path }` |
| Operand | `{ ref } or { assumption } or { expr: { op, operands, places?, rate?, years? } }` |

### Read tools

#### calculate

Purpose: the only arithmetic the model gets. Combines figures from refs and named assumptions into
one figure with chained provenance.

Scope: read

Arguments:

| Name | Type | Notes |
|---|---|---|
| `op` | enum | `add`, `subtract` (first minus the rest), `multiply`, `divide` (two operands), `sum` (one ref whose path is a list of figures, or many operands), `min`, `max`, `negate`, `annualize` (usd_per_month to usd_per_year, times 12), `monthly` (usd_per_year to usd_per_month, divided by 12), `percent_of` (ratio, base), `round_up` (with `places`), `compound` (future value) |
| `operands` | Operand[] | 1..20 |
| `places` | 1, 100 or 1000 | `round_up` only, default 1 |
| `rate` | Operand (ratio, per year) | `compound` only |
| `years` | Operand (years) | `compound` only |
| `label` | string 1..80 | required, no digits |

Unit algebra is checked: usd plus usd is usd; usd times ratio is usd; usd divided by ratio is usd;
usd divided by usd is ratio; usd_per_year divided by a per-year ratio (a withdrawal or return rate)
is usd; usd divided by usd_per_month is months; months times usd_per_month is usd. Adding usd to
usd_per_year, or any other mismatch, is `bad_input` naming both units. Division by zero is
`bad_input`.

Result: `{ figure }`: one figure, `kind` the weakest of its inputs (a, then e, m, p, t), `asOf` the
oldest input `asOf`, `provenance.inputs` holding every operand's figure and provenance,
`provenance.formula` the expression in words ("Q01 yearly spending divided by withdrawalRate"),
`gaps` the union of the inputs' gaps. Q02 as a calculation: `divide(ref to Q01 total, assumption
withdrawalRate 0.04 source owner)`.

Reuses: `round` from `src/calc/pace.mjs`, `figure` from the new `src/calc/figure.mjs`, the ref
resolver `src/tools/refs.mjs` (T5) over `callTool`.

#### aggregate_transactions

Purpose: deterministic sums of transactions with explicit selection, grouping and period: the tool
that answers Q01.

Scope: read

Arguments:

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

Result:

```
{ total: Figure, perMonth: Figure, months, window,
  groups: [ { key, label, figure } ], other?: Figure,
  excluded: [ { selector: {field, value}, matched: Figure, removed: Figure } ],
  definition?: { id, name, source: 'builtin'|'saved' },
  notes: [string], gaps: [Gap] }
```

`total` is one figure over the whole selection, however many classes or categories the include set
names (the `essential` definition returns one total for its five classes). `excluded[].matched` is every window outflow on in-scope accounts that matches the selector, in or
out of the measure's base, so the model can say "income tax payments of X were left out" even when
taxes were never household spending; `removed` is the part that left the total. Groups always sum
to `total`. Gaps: `uncategorized_rows` and `guessed_rows` with amount and count (from the
`guess` and `uncategorized` layers), `account_no_history` for spending accounts that are silent or
have no complete month (the `silent` and `incomplete` lists, card accounts included),
`incomplete_month` when the window is shorter than requested, `outside_household_ledger` when the
result includes healthcare and the facts show W-2, S corp or self-employment income (premiums paid
through payroll or a business account are not household transactions), `unclassified_category`
for household rows whose category has no class.

Reuses: `resolveSpendingWindow`, `spendingInputs`, `isBusinessAccount` (`src/calc/targets.mjs`),
`resolveCategories`, `matchTransfers`, `normalizeMerchant`, `businessAccount` (`src/categories/
resolve.mjs`), `loadCategoryInputs` (`src/categories/store.mjs`), `CATEGORY_CLASSES` (T2). The
pure aggregation lives in `src/calc/aggregate.mjs`; `spendingInputs` and `aggregate` share one row
selection so `aggregate {measure: 'spending'}` over the spending window equals `spendingInputs`'
`spendTotal` exactly (a test asserts it).

#### compare_periods

Purpose: the same aggregation over two periods with the difference, the ratio and per-group deltas.

Scope: read

Arguments: every `aggregate_transactions` argument except the period fields, plus `a` and `b`
(each a Period object; `a` is the earlier by convention). `limit` applies to the union of groups.

Result: `{ a: { total, window }, b: { total, window }, difference: Figure (b minus a), ratio:
Figure (b over a, absent when a is zero), groups: [ { key, label, a: Figure, b: Figure,
difference: Figure } ], gaps }`. `unequal_periods` gap when the month counts differ (the model
should then pass `annualize: true` or matching months).

Reuses: `src/calc/aggregate.mjs` (T6) twice, `figure`.

#### cash_flow

Purpose: monthly inflow, outflow and net for household and business, with transfers between them
separated.

Scope: read

Arguments: Period fields (default `ytd`), `scope` (`household`, `business`, `all`, default
`all`).

Result: `{ months: [ { month, household: { inflow, outflow, net }, business: { inflow, outflow,
net }, transfersBusinessToHousehold, transfersHouseholdToBusiness } ], totals: { same fields },
gaps }`, every number a figure. A transfer between a business and a household account is a pair
`matchTransfers` finds across the two sides; it appears only in the transfer fields, never in
inflow or outflow.

Reuses: `matchTransfers`, `businessAccount`, `resolveCategories`, `loadCategoryInputs`,
`src/calc/aggregate.mjs`.

#### recurring_charges

Purpose: detect repeating charges by merchant: cadence, amount stability, annual cost, last and
next expected date, and what is new or stopped.

Scope: read

Arguments:

| Name | Type | Default | Notes |
|---|---|---|---|
| `status` | `active`, `new`, `stopped`, `all` | `active` | new: first seen on or after `since`; stopped: expected date passed by more than one cadence with no charge |
| `since` | `YYYY-MM-DD` | 90 days before today | for new and stopped |
| `cadence` | `monthly`, `quarterly`, `annual` | any | |
| `scope` | `household`, `business`, `all` | `household` | |
| `minOccurrences` | integer 2..12 | 3 (2 for annual) | |
| `limit` | integer 1..200 | 50 | |

Detection: outflows grouped by `normalizeMerchant`; cadence from the median gap between charges
(monthly 25 to 35 days, quarterly 80 to 100, annual 350 to 380); amount stable when every charge is
within 10 percent of the median; `changed` set when the last two charges differ by more than 10
percent.

Result: `{ charges: [ { merchant, cadence, occurrences, firstDate, lastDate, nextExpected,
typicalAmount: Figure (usd), annualCost: Figure (usd_per_year), amountStable, changed?: { from:
Figure, to: Figure, on }, status, account: { id, label } } ], totalAnnual: Figure, gaps }`.

Reuses: `normalizeMerchant`, `loadCategoryInputs`, `matchTransfers` (transfers are never
recurring charges), new pure detector `src/calc/recurring.mjs`.

#### net_worth

Purpose: net worth now and as a monthly series, by part, group or tax treatment.

Scope: read

Arguments: `accounts?` (ids, max 50), `includeBusiness` (boolean, default true, as the trend does),
`groupBy` (`part`, `group`, `treatment`, default `part`), `series` (boolean, default false),
`months` (1..120, default 12).

Result: `{ total: Figure, groups: [ { key, label, figure, accounts: [ { id, label } ] } ], series?:
[ { month, total: Figure, groups } ], carried: [ { id, label, lastDate } ], gaps }`.
`carried_balance` gap for accounts whose last balance is carried forward. `treatment` groups use
`ACCOUNT_TREATMENT` (T3) by account kind, overridden by the `accounts.planType` fact (T19); a `retirement` or `ira` account without one is named in a
`missing_fact` gap.

Reuses: `buildTrend`, `groupOfKind`, `PARTS`, `GROUPS` (`src/accounts/trend.mjs`),
`accountFreshness`, `ACCOUNT_TREATMENT`.

#### business_pnl

Purpose: replaces `pnl_by_month`. Business profit and loss per entity: revenue, expenses, profit,
margin, by month or category, with a prior-year comparison.

Scope: read

Arguments: `entity?`, Period fields restricted to `ytd` (default), `trailing_12`,
`calendar_year`, `custom`; `groupBy` (`none`, `month`, `category`, default `month`);
`compareToPriorYear` (boolean, default false).

Result: `{ entities: [ { entity, revenue, expenses, profit, margin (ratio), groups: [ { key,
revenue, expenses, profit } ], prior?: { revenue, expenses, profit, margin, revenueDifference,
revenueRatio, profitDifference, profitRatio } } ], gaps }`, every number a figure. Revenue is the sum of positive lines,
expenses the negated sum of negative lines, margin profit over revenue (absent at zero revenue).
`incomplete_month` when the period's last month has no lines yet.

Reuses: the `pnl_lines` query from `pnl_by_month`, `cents` from `src/store/db.mjs`, `figure`. T8
migrates every caller and test of `pnl_by_month` (the registry, `test/tools.test.mjs`,
`test/answerer.test.mjs`, the progress label in `src/api/answerer.mjs`, the section 8 table in
`docs/architecture.md`) with no alias.

#### independence_target

Purpose: the invested amount that covers yearly spending at a withdrawal rate, how far the
household is from it, and when it gets there.

Scope: read

Arguments:

| Name | Type | Default | Notes |
|---|---|---|---|
| `spending` | Ref (usd_per_year) | none | exactly one of `spending` or `definition`; neither means `definition: 'household_spending'` |
| `definition` | slug | `household_spending` | aggregated over `spending_window`, annualized |
| `withdrawalRate` | Assumption (ratio 0.02..0.06) | 0.04, source default (`TARGET_PARAMETERS`) | |
| `invested` | `{ kinds?, treatments?, accounts? }` | `INVESTMENT_KINDS`, non-business | |
| `monthlySavings` | Ref or Assumption or expr (usd_per_month) | `spendingInputs` `monthlySavings` | |
| `realReturn` | Assumption (ratio, minus 0.05..0.10) | 0.04, source default | |
| `roundTo` | 1 or 1000 | 1000 | as `independencePlan` |

Result: `{ target: Figure (usd), investedNow: Figure, gap: Figure (zero when covered), months:
Figure (months) or null, projectedDate: Figure (date) or null, monthlySavings: Figure, status:
'covered'|'projected'|'no_savings'|'too_long', gaps }`. `too_long` past
`maxProjectionMonths` (600).

Reuses: `independencePlan`'s formula, `monthsToReach`, `holdingsTotal`, `TARGET_PARAMETERS`
(`src/calc/targets.mjs`), `withdrawalRateOf` (`src/suggest/build.mjs`), `accountHistory`
(`src/pace/build.mjs`), the ref resolver.

#### project_growth

Purpose: what-if growth of a balance with monthly contributions at a real return: the balance
after some years, the months to a target, or the monthly saving a target needs by a date or age.

Scope: read

Arguments: `solve` (`balance`, `months`, `monthly`, required); `balance` (Ref or Assumption,
required); `monthlyContribution` (Ref, Assumption or expr, default zero, for `balance` and
`months`); `realReturn` (Assumption, default 0.04); `years` (0..60, for `balance`); `target` (Ref
or Assumption, for `months` and `monthly`); `byDate` (`YYYY-MM-DD`) or `byAge` (`{ person:
'owner'|'spouse', age: 18..100 }`, for `monthly`; age resolves from the birth date fact, else the
age fact with a `missing_fact` note on month precision).

Result: `{ figure }` (usd, months or usd_per_month) with `provenance.steps` showing the formula
(future value of a balance plus an annuity, compounded monthly). `realReturn` is bounded minus
0.05..0.10.

Reuses: `monthsToReach`, new `futureValue` and `requiredMonthly` in `src/calc/growth.mjs`.

#### contribution_room

Purpose: this year's contribution room per person and account type: limit, used where data shows
it, remaining and deadline.

Scope: read

Arguments: `person` (`owner`, `spouse`, `both`, default `both`); `types` (array of
`employee_deferral`, `solo401k_pretax`, `solo401k_employer`, `sep`, `traditional_ira`,
`roth_ira`, `hsa`, `dependent_care`, `plan529_state_deduction`; default all); `year` (2026 only,
the supported tax year).

Result: `{ rows: [ { person, type, limit: Figure, used: Figure or null, remaining: Figure or null,
deadline: Figure (date), basis: 'planner'|'calculator', packRefs } ], gaps }`. `remaining` comes
from the stored planner `room.*` figures when the last planning run is in this tax year; otherwise
the limit comes from the calculator and `used` is null with a `missing_fact` or
`outside_household_ledger` gap (payroll deferrals and FSA elections).

Reuses: `solo401kRoom`, `sepRoom`, `hsaLimit`, `dependentCareLimit`, `employerLimit`, `TAX_2026`,
`LAW_REFS` (`src/calc/index.mjs`), stored `room.solo401k.*`, `room.sep`, `room.hsa`,
`room.ira.household`, `room.dependentCare` figures, `planningYear`.

#### tax_estimate

Purpose: projected federal, state and self-employment tax, safe harbor, payments made against
required, the next due date, marginal rates, and a what-if delta.

Scope: read

Arguments: `year` (2026 only); `whatIf?` (`{ extraIncome?: Assumption (usd), extraDeduction?:
Assumption (usd), incomeType: 'business'|'wages'|'other' (default business) }`).

Result: `{ federal: { projected, selfEmployment, paid, withheld, remaining }, state: { projected,
paid, withheld, remaining }, safeHarbor: { federal: { required, paid, remaining }, state: {
required, paid, remaining }, nextDueDate }, marginal: { federal, state, capitalGains } (ratios),
whatIf?: { federalDelta, stateDelta, selfEmploymentDelta, totalDelta }, gaps }`. Stored figures
(`tax.fed.proj`, `tax.fed.se`, `tax.fed.paid`, `tax.fed.withheld`, `tax.va.*`, `sh.fed.*`,
`sh.va.*`) come through as figures with the planner run's date as `asOf`. The what-if reruns the
household computation with the extra amount on the chosen line and returns differences only.

Reuses: `householdTax` (`src/jobs/planner/household.mjs`), `federalIncomeTax`,
`selfEmploymentTax`, `virginiaIncomeTax`, `estimatedPaymentSafeHarbor` (`src/calc/index.mjs`),
`classifyPayments` (`src/jobs/planner/payments.mjs`), stored planner figures.

#### data_health

Purpose: is the data complete and current: per-account freshness, the last import, category
coverage, stale or unavailable figures and pending Confirm items.

Scope: read

Arguments: `accounts?` (ids, max 50).

Result: `{ accounts: [ { id, label, mask, kind, lastData, freshness: 'fresh'|'stale'|'unknown',
ageDays, source } ], lastImport: { fileId, name, at, status } or null, categories: { rows,
uncategorized, guessed, corrected, queueSize } (count figures), unavailableFigures: [ { key, label,
reason } ], pendingConfirm: { total, byKind }, yearend: { year, items: [ { key, form, issuer,
status: 'received'|'missing'|'marked' } ] }, gaps }`.

Reuses: `freshnessOf`, `accountFreshness` (`src/ingest/freshness.mjs`), `categoryCoverage`
(`src/categories/store.mjs`), `pendingItems` (`src/ingest/confirm.mjs`), `yearendChecklist`
(`src/yearend/expected.mjs`), `figures.unavailable_reason`.

#### list_spending_definitions

Purpose: the built-in and saved spending definitions, so "my elective spending" resolves to an id.

Scope: read

Arguments: none.

Result: `[ { id, name, source: 'builtin'|'saved', def: { include?, exclude? }, packRef?,
preferenceId?, updatedAt? } ]`. Built-ins: `household_spending`, `essential`, `discretionary`,
`core_living` (section 5), each citing the spending pack entry. A saved definition carries the id
of its linked preference.

Reuses: `BUILTIN_DEFINITIONS` (T2), the `spending_definitions` table (T18).

#### obligation_schedule

Purpose: each known obligation, its monthly amount now, when it ends or changes, the new amount,
and how each was derived, or the fact that is missing.

Scope: read

Arguments: `kinds` (array of `mortgage`, `childcare`, `plan529`; default all); `horizonYears`
(1..40, default 30); `changes?` (array of `{ kind, stage?: 'school_age'|'after_care_end',
newMonthly: Assumption (usd_per_month) }`, max 10: owner-stated amounts for a change the facts do
not cover).

Result: `{ obligations: [ { kind, label, monthly: Figure (usd_per_month), changes: [ { stage, date:
Figure, newMonthly: Figure (unavailable when no source), reason, derivedFrom:
'fact'|'amortization'|'birth_date'|'pack_default'|'assumption' } ], endDate: Figure or null,
missing: [ factKey ] } ], gaps }`.

Amounts, in order of precedence:

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

Dates come from the facts in section 5 and `OBLIGATION_RULES`.

Reuses: `src/calc/aggregate.mjs`, new `src/calc/obligations.mjs` (amortization and age rules),
`getFacts`, `OBLIGATION_RULES` (T2), loan account balances through `accountHistory`.

#### spending_projection

Purpose: yearly spending forward with each obligation dropped or changed on its date: "spending
after the mortgage ends".

Scope: read

Arguments: `base` (Ref to an `aggregate_transactions` usd_per_year figure) or `definition`
(default `household_spending`); `years` (1..40, default 10); `obligations` (kinds to apply,
default all); `changes?` (as `obligation_schedule`). Figures are in today's dollars; the tool
applies no inflation and says so in a note.

Result: `{ years: [ { year, spending: Figure (usd_per_year), changes: [ { kind, date, delta: Figure,
applied: boolean } ] } ], gaps }`.

Base rule. A change subtracts only the part of the obligation that is inside the base: the tool
re-runs the base's selection (the definition's selectors, or the ref's `aggregate_transactions`
arguments) restricted to the obligation's class, and the in-base monthly amount times twelve is
the most a change can remove. A base that already excludes `debt_service` (such as
`core_living`) gets no mortgage drop and a note says why. A ref to any other tool is
`bad_input`. A change whose new amount is unavailable is listed with `applied: false` and its gap,
and the spending figure keeps the current amount.

Reuses: `obligation_schedule`'s calculator, `src/calc/aggregate.mjs`, the ref resolver.

#### after_tax_value

Purpose: holdings by tax treatment and what they are worth after the tax that applies when the
money comes out, under stated rate assumptions.

Scope: read

Arguments: `accounts?` or `kinds?`; `hypothetical?` (array of `{ treatment, value: Assumption,
basis?: Assumption, contributions?: Assumption }`, max 10; `basis` applies to taxable,
`contributions` to Roth); `ordinaryRate`, `capitalGainsRate`, `stateRate` (each Ref or
Assumption, bounds in the shared types, all required; refs to `tax_estimate` marginal rates are
the usual source). Fathom never assumes a tax rate.

Result: `{ rows: [ { treatment, accounts, value: Figure, basis: Figure, unrealizedGain: Figure,
taxOnWithdrawal: Figure, afterTax: Figure, qualifiedFrom: Figure (date), afterTaxMedical?: Figure,
afterTaxNonmedical?: Figure, whenTaxed, packRef } ], total: { value, afterTax }, gaps }`.

Rules and missing inputs:

1. Pre-tax (traditional IRA, SEP, pre-tax 401(k), 403(b), 457(b)): ordinary plus state rate on
   the whole value. Needs nothing else.
2. Roth: tax-free once qualified. `qualifiedFrom` is the later of age 59 and a half and five
   years after `accounts.rothFirstContributionYear`; without that fact it is unavailable with a
   `missing_fact` gap, and `afterTax` is reported as the qualified value with a note that it
   holds only from that unknown date. Roth IRA and Roth 401(k) differ in access, not in this
   figure; the subtype comes from `accounts.planType`.
3. Taxable: capital gains plus state rate on value less basis, basis from
   `positions.cost_basis` (or a hypothetical's `basis`). When any position lacks basis,
   `basis`, `unrealizedGain`, `taxOnWithdrawal` and `afterTax` for that row are unavailable with a
   `no_cost_basis` gap counting the positions; nothing is assumed.
4. HSA: the purpose decides the tax, so the row returns both `afterTaxMedical` (no tax) and
   `afterTaxNonmedical` (ordinary plus state, plus the 20 percent additional tax before 65 from
   the person's age), and `afterTax` is unavailable with a note to choose.
5. Cash: no tax on withdrawal.
6. An account whose kind does not fix its treatment (`retirement`, `ira`) uses
   `accounts.planType`; without it the row is unavailable with a `missing_fact` gap.

Reuses: `ACCOUNT_TREATMENT` (T3), `list_positions`' query, `holdingsTotal`, the ref resolver.

#### access_schedule

Purpose: by age of the owner and the spouse, what becomes penalty-free when, and when RMDs start.

Scope: read

Arguments: `people` (`owner`, `spouse`, `both`, default `both`).

Result: `{ people: [ { person, born: Figure (date) or unavailable, ageNow: Figure, milestones: [ {
event, age: Figure, date: Figure, accounts: [ { id, label } ], packRef } ] } ], gaps }`. Events:
`penalty_free_59_half`, `rule_of_55`, `roth_earnings_qualified`, `hsa_nonmedical_no_penalty_65`,
`rmd_start`.

Inputs and what happens without them:

1. Birth date (`household.ownerBirthDate`, `household.spouseBirthDate`); without it, the age
   fact gives year precision (dates fall on December 31) with a `missing_fact` gap; without either,
   every milestone date is unavailable.
2. `rule_of_55` lists only accounts whose `accounts.planType` is an employer plan (`401k`,
   `roth_401k`, `solo_401k`, `403b`, `457b`); IRA types never qualify. Accounts with no plan type
   are named in a `missing_fact` gap, not listed.
3. `roth_earnings_qualified` needs `accounts.rothFirstContributionYear` per Roth account; without
   it the milestone date is unavailable for that account with a gap.
4. `rmd_start` excludes Roth IRA and Roth 401(k) accounts (no lifetime RMD for the owner).

Reuses: `ACCESS_RULES`, `rmdStartAge` (T3, `src/calc/treatment.mjs`), `getFacts`.

#### bridge_check

Purpose: retiring at a stated age before access age: spending until access age against money
reachable without penalty. It reports; it never recommends a strategy.

Scope: read

Arguments: `retireAge` (Assumption, age; default the `household.retireAge` fact, else required);
`person` (`owner` or `spouse`, default `owner`); `spending` (Ref) or `definition` (default
`household_spending`); `realReturn` (Assumption, default 0, so the check is conservative unless
the owner states one).

Result: `{ yearsToAccess: Figure, spendingUntilAccess: Figure (usd), accessible: { taxable, cash,
rothContributions, ruleOf55 } (figures), shortfall: Figure (zero when covered), surplus: Figure,
exceptions: [ { rule, note, packRef } ], gaps }`.

Inputs and what happens without them:

1. `accessible.rothContributions` is the sum of `accounts.rothBasis`; a Roth account without it
   adds nothing and is named in a `missing_fact` gap.
2. `accessible.ruleOf55` counts employer-plan balances (by `accounts.planType`) only when
   `retireAge` is 55 or more; otherwise it is zero with a note. Accounts with no plan type are
   named in a gap.
3. `accessible.taxable` is the market value (selling has a tax cost; the note points at
   `after_tax_value`).
4. Exceptions listed as text with pack refs: substantially equal periodic payments and HSA
   reimbursement of past medical costs. They are never counted as accessible money.

Reuses: `access_schedule`'s rules, `holdingsTotal`, `spending_projection`'s calculator (T20).

### Changed read tools

#### get_figures

Purpose: stored figures, now as referenceable envelopes.

Scope: read

Arguments: unchanged (`keys?: string[]`, max 500).

Result: every current field (`key`, `v`, `kind`, `label`, `source: { id, label, asOf }`,
`unavailable`) plus the envelope fields from `fromStored` (`value`, `unit`, `asOf`, `ref`,
`provenance`, `gaps`). No field is dropped.

Reuses: `fromStored` (T1), `relabelStoredFigure`, `accountNaming`.

#### get_pace

Purpose: goal pace and health, now with referenceable figures.

Scope: read

Arguments: unchanged (none).

Result: the current `buildPace` result, unchanged in shape, with an `envelope` field beside each
pace figure (from `fromPace`) whose `ref` is `{ tool: 'get_pace', args: {}, path: <the figure's
dotted path>.envelope }`.

Reuses: `buildPace`, `paceFigure`, `fromPace` (T1).

#### query_transactions

Purpose: the row lookup, now aware of buckets, classes and merchants.

Scope: read

Arguments: the current ones plus `bucket` (Bucket), `class` (Class), `merchant` (normalized
merchant string, 1..200).

Result: `{ rows: [ { id, accountId, date, amount, description, category, bucket, class, layer,
merchant } ], truncated, total }`. `category` is the resolved category; `layer` is the
`resolveCategories` layer (`correction`, `import`, `guess`, `uncategorized` and so on).

Reuses: `resolveCategories`, `loadCategoryInputs`, `normalizeMerchant`, `CATEGORY_CLASSES`.

### Write tools

Every write tool records an action receipt through the ask-actions receipts module
(`saveReceipt`) and shares the handler's store function, so the API and the agent cannot drift.
Where a handler has its logic inline, the ticket first moves that logic into a named store
function and points the handler at it. Every write tool is offered to Ask (chat purpose) and to
MCP under its scope. "Undo" below names the `undo` field the result carries and the receipt kind
the ticket registers.

#### save_spending_definition

Purpose: save or replace a named spending definition, and remember it as a preference that names
it.

Scope: write:preferences

Arguments: `{ id: slug (2..40, not a built-in id), name: string (1..60), def: { include?: Selector,
exclude?: Selector }, evidence: string (the owner's words) }`; at most 50 saved definitions.

Result: `{ definition: { id, name, def, preferenceId }, receipt }`. Undo: `undo_preference_action
{ id: <receipt id> }`; receipt kind `spending_definition` (T18) whose restore puts back both the
definition row and its linked preference row as they were (or removes both when the save created
them).

Linkage, pinned (T18):

1. The migration adds `spending_definitions` and a nullable `preferences.definition_id` column
   with a unique index.
2. Saving a definition writes or updates exactly one linked preference in the same transaction,
   with text "When I say <name>, use my saved spending definition <id>." and
   `definition_id` set. Saving again with the same id and a new name or selectors updates both.
3. `remember_preference` on a linked preference is refused with "Change the definition instead".
   `forget_preference` on a linked preference deletes both rows (one receipt, kind
   `spending_definition`).
4. `delete_spending_definition` deletes both rows.
5. Ask's dynamic context already lists every preference (`listPreferences` into
   `household_preferences` on feat/ask-actions). The linked preference's text names the
   definition's id, and `listPreferences` gains `definitionId`, so a later conversation resolves
   "my elective spending" to `definition: 'elective_spending'` with no lookup and no answerer
   edit.

Reuses: `saveReceipt`, `requireActor`, `requireEvidence`, `validatePreference` (feat/ask-actions),
new `src/spending/definitions.mjs`.

#### delete_spending_definition

Purpose: delete a saved definition and its linked preference.

Scope: write:preferences

Arguments: `{ id: slug }` (built-ins refused).

Result: `{ deleted: id, receipt }`. Undo: `undo_preference_action { id: <receipt id> }`, kind
`spending_definition`.

Reuses: `src/spending/definitions.mjs`.

#### forget_preference

Purpose: delete a remembered preference; covers `/api/preferences/:id/delete`.

Scope: write:preferences

Arguments: `{ id: string }`.

Result: `{ receipt }`. Undo: `undo_preference_action { id: <receipt id> }`, kind `preference`
(existing) or `spending_definition` for a linked preference.

Reuses: `writePreference(ctx, { id }, { remove: true })` (`src/actions/preferences.mjs`).

#### answer_recommendation_questions

Purpose: save the answers a recommendation asks for, the same write and replan as the rec dialog.

Scope: write:facts

Arguments: `{ id: rec id, answers: [ { key, path?: string[], value } ] (1..50), evidence: string }`;
keys must be in `ANSWER_SHAPES` and in the rec's question.

Result: `{ rec, receipts: [receipt], planningPending }`. Undo: `undo_fact_action { id: <receipt
id> }` per fact, kind `fact` (existing).

Reuses: `answerFacts` (`src/facts/answers.mjs`), the body of `recAnswers`
(`src/api/fact-answers.mjs`) moved into `saveRecAnswers`.

#### start_recommendation_over

Purpose: detach a recommendation's Ask threads so its dialog opens fresh.

Scope: write:recs

Arguments: `{ id: rec id }`.

Result: `{ detached: Figure (count), receipt }`. Undo: `undo_recommendation_action { id: <receipt
id> }`, kind `rec_detach` (T22) whose restore clears `rec_detached_at` on the threads it set.

Reuses: the `recStartOver` update moved into `detachRecThreads` (`src/store/recs.mjs`).

#### pick_wargame_point

Purpose: pick a point on the salary or deferral war game.

Scope: write:decisions

Arguments: `{ name: 'salary'|'deferral', index: integer or point id }`.

Result: `{ picked: { name, index, label }, receipt }`. Undo: `undo_decision_action { id: <receipt
id> }`, kind `setting` (T17, generic over `settings` by key).

Reuses: `wargamePick`'s logic moved into `pickWargame` (`src/decisions/write.mjs`).

#### decide_decision

Purpose: decide an open war-game decision on the picked point.

Scope: write:decisions

Arguments: `{ id: decision id, index?: integer or point id }`.

Result: `{ decision: { id, status, decidedLine (tokens resolved) }, receipt }`. Undo:
`revisit_decision { id }` (a domain inverse; it also removes the decided fact and replans).

Reuses: `decisionDecide` moved into `decide` (`src/decisions/write.mjs`), `upsertFact`,
`scheduleReplan`.

#### revisit_decision

Purpose: reopen a decided decision.

Scope: write:decisions

Arguments: `{ id: decision id }`.

Result: `{ decision: { id, status }, decidedIndex, receipt }`. Undo: `decide_decision { id, index:
<decidedIndex> }`.

Reuses: `decisionRevisit` moved into `revisit` (`src/decisions/write.mjs`).

#### set_pack_active

Purpose: turn a knowledge pack on or off, as the Packs toggle does.

Scope: write:preferences

Arguments: `{ id: pack id, active: boolean }` (idempotent, unlike the toggle route).

Result: `{ pack: { id, status }, wasActive, receipt }`. Undo: `set_pack_active { id, active:
<wasActive> }` (a domain inverse, because the toggle also hides and unhides recs).

Reuses: `packToggle` moved into `setPackActive` (`src/packs/state.mjs`).

#### set_curve_position

Purpose: set where the household sits on a tradeoff curve.

Scope: write:preferences

Arguments: `{ positions: { [axisId]: number 0..1 } }` (1..20 axes).

Result: `{ positions, receipt }`. Undo: `undo_preference_action { id: <receipt id> }`, kind
`setting`.

Reuses: `curveSet` moved into `setCurvePositions` (`src/goals/curve.mjs`).

#### archive_goal

Purpose: archive a goal.

Scope: write:goals

Arguments: `{ id: goal id }`.

Result: `{ goal: { id, archived: true }, receipt }`. Undo: `undo_goal_action { id: <receipt id>
}`, kind `goal` (existing).

Reuses: `goalArchive`'s write moved into `archiveGoal` (`src/goals/write.mjs`).

#### delete_goal

Purpose: delete a goal (the owner's own goals only, as the route allows).

Scope: write:goals

Arguments: `{ id: goal id }`.

Result: `{ deleted: id, receipt }`. Undo: `undo_goal_action { id: <receipt id> }`, kind
`goal_row` (T23) whose restore reinserts every column of the deleted row.

Reuses: `goalDelete` moved into `deleteGoal` (`src/goals/write.mjs`).

#### set_goal_suggestion

Purpose: dismiss or restore a goal's suggested target, or set its withdrawal rate.

Scope: write:goals

Arguments: `{ id: goal id, action?: 'dismiss'|'restore', withdrawalRate?: Assumption (0.02..0.06)
}`, exactly one of `action` or `withdrawalRate`.

Result: `{ suggestion: { goalId, dismissed, withdrawalRate }, receipt }`. Undo:
`undo_goal_action { id: <receipt id> }`, kind `setting`.

Reuses: `goalSuggestion` moved into `setGoalSuggestion` (`src/suggest/write.mjs`),
`buildSuggestions`, `SUGGEST_SETTING`.

#### send_to_advisor

Purpose: send a recommendation to the advisor for review.

Scope: write:recs

Arguments: `{ recId }`.

Result: `{ reviewId, receipt }`. Undo: not available (reason: a sent review is a record; a new
verdict or review supersedes it).

Reuses: `sendToAdvisor` (`src/advisor/index.mjs`).

#### record_advisor_verdict

Purpose: record the advisor's verdict on a waiting review (a veto dismisses the rec).

Scope: write:recs

Arguments: `{ reviewId, verdict: 'confirmed'|'vetoed', note?: string (max 1000), date:
'YYYY-MM-DD', evidence: string }`; the verdict and note must come from the owner's words
(`requireEvidence`).

Result: `{ review: { id, verdict, date }, receipt }`. Undo: not available (reason: it records an
outside person's decision; send the rec again to reopen review).

Reuses: `recordVerdict`, `applyStatusAction` with `VETO_REASON`.

#### set_advisor_checkin

Purpose: set the next advisor check-in.

Scope: write:recs

Arguments: `{ date: 'YYYY-MM-DD', time?: 'HH:MM', lengthMin?: 15..480 }`.

Result: `{ checkin, receipt }`. Undo: `undo_recommendation_action { id: <receipt id> }`, kind
`advisor_checkin` (T24, table `advisor_checkin`).

Reuses: `setCheckin` (`src/advisor/index.mjs`).

#### create_review_packet

Purpose: build and store the advisor packet for every waiting review.

Scope: write:recs

Arguments: none.

Result: `{ packetId, recIds, receipt }`. Undo: not available (reason: a stored packet is a
record; it never leaves the product). Needs the data key from `ctx.services` (T17).

Reuses: `createPacket`'s body moved into `buildAndStorePacket` (`src/advisor/packet.mjs`),
`storePacket`, `buildPacketHtml`.

#### mark_yearend_item

Purpose: mark an expected tax document not needed this year, or clear the mark.

Scope: write:confirm

Arguments: `{ year?: 2000..2100, key: string (1..200), reason: string (1..300) or null }`.

Result: `{ item: { key, marked, reason }, receipt }`. Undo: `undo_confirm_action { id: <receipt
id> }`, kind `yearend_mark` (T24, table `yearend_marks` by year and key).

Reuses: `setMark`, `yearendChecklist`, `taxYearFor` (`src/yearend/expected.mjs`).

#### list_confirm_items

Purpose: the Confirm queue, pending or answered; a read despite its POST route.

Scope: read

Arguments: `{ status: 'pending'|'answered'|'all' (default pending), kinds?: string[] }`.

Result: `{ items: [ { id, kind, question, options: [ { id, label } ], context (masks only), status,
answer? } ] }`.

Reuses: `queueAccountPairs`, `queueCategoryChecks`, `listItems`.

#### answer_confirm_item

Purpose: answer one or many Confirm items, or revise one answer.

Scope: write:confirm

Arguments: `{ items: [ { id: integer, answer: option id } ] (1..500), revise?: boolean (only with
one item) }`.

Result: `{ items, receipt }`. Undo: `reopen_confirm_item { ids: [<the answered ids>] }` (a domain
inverse through the change log).

Reuses: `answerItem`, `answerItems`, `reviseItem` (`src/ingest/confirm.mjs`), the `afterAnswer`
replan and freshness triggers.

#### reopen_confirm_item

Purpose: reopen answered Confirm items, which reverts what the answers changed.

Scope: write:confirm

Arguments: `{ ids: integer[] (1..500) }`.

Result: `{ items, receipt }`. Undo: `answer_confirm_item { items: [ { id, answer: <prior answer> }
] }`. Refused with `changed_since` when a row changed after the answer (`revertChanges` in
`src/ingest/undo.mjs`).

Reuses: `reopenItem`, `reopenItems`, `revertChanges`.

#### set_transaction_category

Purpose: correct one transaction's category.

Scope: write:categories

Arguments: `{ transactionId: integer, category: aggregator category name }` (bucket follows the
category through `sourceBucket`).

Result: `{ transaction: { id, category, bucket, class }, receipt }`. Undo: `undo_category_action {
id: <receipt id> }`, kind `category_correction` (T25, table `transaction_category_corrections` by
`transaction_id`).

Reuses: the correction write in `applyCategoryAnswer` moved into `setTransactionCategory`
(`src/categories/store.mjs`); Confirm answers call the same function, so the two share one write
path.

#### set_merchant_rule

Purpose: categorize every transaction from a merchant from now on.

Scope: write:categories

Arguments: `{ merchant: normalized merchant (1..200), category: aggregator category name }`.

Result: `{ rule: { merchant, category, bucket }, affected: Figure (count), receipt }`. Undo:
`undo_category_action { id: <receipt id> }`, kind `merchant_rule` (T25, table
`category_merchant_rules` by `merchant`).

Reuses: the merchant-rule write in `applyCategoryAnswer` moved into `setMerchantRule`,
`normalizeMerchant`.

#### import_file

Purpose: feed a file to the import pipeline, from a headless client or from text the owner pastes
in Ask.

Scope: write:imports

Arguments: `{ name: string (1..200), mime: string, contentBase64?: string, text?: string }`, exactly
one of `contentBase64` (MCP clients sending a file) or `text` (an owner-pasted CSV or markdown
note in Ask, stored as UTF-8). Either way the decoded content is at most 1 MiB less the request
envelope (`MCP_BODY_LIMIT`), and Ask applies the same limit. A setup note is a `text/markdown`
file, which covers `/api/onboarding/notes`.

Result: `{ file: { id, name, status, counts }, pending, receipt }`. Undo: not available (reason:
imported rows are undone per Confirm answer; the file stays on record).

Reuses: `ingestFiles` (`src/ingest/pipeline.mjs`), the data key, scheduler and config from
`ctx.services` (T17), the triggers `triggerPlan`, `triggerFreshness`, `triggerGuesses`
(`src/api/ingest-handlers.mjs`).

#### retry_import

Purpose: retry a file waiting for a mapping or extraction.

Scope: write:imports

Arguments: `{ fileId }`.

Result: `{ file, receipt }`. Undo: not available (reason as `import_file`).

Reuses: `retryFile` (`src/ingest/pipeline.mjs`), `ctx.services`, the same triggers.

#### build_your_plans

Purpose: extract the owner's plan and benefits documents into the private Your plans pack.

Scope: write:imports

Arguments: `{ fileIds?: string[] (max as the route) }`.

Result: over MCP, `{ status: 'built', written, entries, sources, warnings, dropped, receipt }`. In
Ask, the build cannot run inside the engine call that is running the tool (both hold the engine
ledger), so the tool schedules it with `ctx.queueAfterTools` to run when the round ends and
returns `{ status: 'queued', receipt }`; the receipt's later state records the outcome. Undo: not
available (reason: the pack is rebuilt from the files).

Reuses: `buildYourPlans`, `refreshLivePacks`, `ctx.services.engine` and the data key (T17).

#### run_job

Purpose: run a scheduled job now.

Scope: write:jobs

Arguments: `{ id: 'plan'|'simplefin-sync'|'freshness'|'confirm-guess' }`. Jobs that send email
(`brief-email`, `deadline-alerts`) and `trash-purge` are not in the enum.

Result: `{ run: { id, status, startedAt, finishedAt }, receipt }`. Undo: not available (reason: a
job run reads and replans; its effects are undone where they land). `plan` on a demo store is
refused as the route refuses it.

Reuses: `ctx.services.scheduler.runNow` (T17), `SCHEDULER_STATUS`.

#### rename_account

Purpose: set or clear an account's display name.

Scope: write:accounts

Arguments: `{ id, displayName: string or null }`.

Result: `{ account: { id, label }, receipt }`. Undo: `undo_account_action { id: <receipt id> }`,
kind `account_field` (T27, the changed `accounts` columns only).

Reuses: `validateDisplayName`, the update in `accountRename` moved into `renameAccount`
(`src/accounts/write.mjs`).

#### set_account_mask

Purpose: store a last four the owner typed, only on an account with none and no bridge identity.

Scope: write:accounts

Arguments: `{ id, mask: four digits }`.

Result: `{ account, receipt }`. Undo: `undo_account_action { id: <receipt id> }`, kind
`account_field`; the restore re-runs `queueAccountPairs`.

Reuses: the `accountMask` write and `queueAccountPairs` moved into `setAccountMask`.

#### set_account_owner

Purpose: set who owns an account: owner, spouse, joint or business.

Scope: write:accounts

Arguments: `{ id, owner: 'owner'|'spouse'|'joint'|'business' }` (`OWNER_OPTIONS`).

Result: `{ account, receipt }`. Undo: `undo_account_action { id: <receipt id> }`, kind
`account_answer` (T27) whose restore calls `undoAccountAnswer` with the before value the receipt
holds.

Reuses: `setAccountAnswer`, `undoAccountAnswer` (`src/ingest/confirm.mjs`), `afterAnswer`.

#### set_account_kind

Purpose: set an account's kind.

Scope: write:accounts

Arguments: `{ id, kind: KIND_OPTIONS id }` (checking, cash, card, taxable, retirement, roth, hsa,
529, business, loan).

Result: as `set_account_owner`, same undo and receipt kind.

Reuses: `setAccountAnswer`, `undoAccountAnswer`, `afterAnswer`.

#### list_merge_candidates

Purpose: accounts that could be merged with one account, with the merge plan or the refusal.

Scope: read

Arguments: `{ id }`.

Result: `{ items: [ { id, label, inst, kind, mask, lastDataDate, mirror, plan: { keepId, keepLabel,
moves }, refused? } ] }`.

Reuses: `mergePlan` (`src/ingest/account-merge.mjs`), `accountMergeCandidates`.

#### merge_accounts

Purpose: merge two accounts that are the same account: the one destructive write.

Scope: write:accounts

Arguments: `{ id, withId, confirm: true, evidence: string }` (`confirm` must be the literal `true`). On both
surfaces the caller passes it only after the person explicitly confirmed this merge; in Ask that
is a later owner message than the one where the model showed the candidates, and the tool checks
it with `requireEvidence` against an `evidence` argument quoting that confirmation.

Result: `{ survivorId, itemId, receipt }`. Undo: `reopen_confirm_item { ids: [<itemId>] }`, which
reverts the merge through `revertChanges` until a moved row changes (T25's tool, so T27 depends on
T25).

Reuses: `mergePlan`, `manualMerge`, `afterAnswer`.

## 4. Rules for the model

These rules go into the Ask system prompt (T28) and into the MCP server instructions.

1. Route by question shape. Call the tool in this table first; reach for `query_transactions` only
   to show example rows.

   | Question shape | Tool |
   |---|---|
   | A total, average or breakdown of spending or income over a period | `aggregate_transactions` |
   | This period against that one | `compare_periods` |
   | Money in and out by month, household against business | `cash_flow` |
   | Subscriptions, repeating bills, what started or stopped | `recurring_charges` |
   | Net worth, balances by part, retirement against taxable | `net_worth` |
   | Business profit, revenue, margin | `business_pnl` |
   | How much invested is enough, how far, when | `independence_target` |
   | Growth, months to a number, saving needed by a date | `project_growth` |
   | Contribution room and deadlines | `contribution_room` |
   | Tax owed, safe harbor, marginal rate, tax what-if | `tax_estimate` |
   | Freshness, uncategorized rows, missing history | `data_health` |
   | Mortgage end, childcare change, 529 end | `obligation_schedule` |
   | Spending after an obligation ends | `spending_projection` |
   | After-tax value by account type | `after_tax_value` |
   | When money can come out, RMDs | `access_schedule` |
   | Retiring before access age | `bridge_check` |
   | Any arithmetic on figures already returned | `calculate` |
   | Goal pace | `get_pace` |
   | A named definition ("my elective spending") | `list_spending_definitions`, then the tool with `definition` |

2. Never sum, scale, annualize, subtract, divide or round numbers yourself. When an answer needs a
   number no tool returned, call `calculate` with refs to the figures and named assumptions.
3. Copy a figure's `ref` field to reference it; do not compose refs by hand. Pass the same
   arguments when you re-run a call so the figure is the same.
4. State every assumption with its name, value and source: "the owner said it" (`owner`, with
   the owner's words as `evidence`), a saved preference (`preference`, with its id), a stored fact
   (`fact`, with its key), or the tool's default (`default`). Pass defaults by omitting the
   argument, and name them in the answer. Never mark a value as the owner's when the owner did not
   say it; when a tool needs a value nobody stated (a cost basis, a tax rate), leave it out, report
   the unavailable figure, and ask.
5. Report data gaps. For each gap in a result, say what is missing and its size when the gap gives
   an amount or count. Never fill a gap with an estimate. Offer the fix the gap implies (a Confirm
   item, an import, a fact to record).
6. When a request needs a fact Fathom lacks (a birth date, a mortgage rate), say which fact, and in
   chat offer to record it with `record_household_fact` using the owner's own words.
7. When no tool covers the question, say "Fathom does not have that" and what it does have. That
   covers security selection, live market prices, money movement and tax filing.
8. Stored figures from `get_figures` are written as `{f:key}` tokens. Figures from the new tools
   are written as plain numbers exactly as the result gives them; the tool result grounds them.
   Never reformat a figure into a rounder number; ask `calculate` with `round_up` instead.
9. Use a write tool only in chat, only when the owner asked for the change in this conversation,
   and confirm each change with its receipt and the Undo it offers. Never chain writes the owner
   did not ask for.
10. For an account merge, show the candidates from `list_merge_candidates` and what the merge
    moves, ask the owner to confirm, and call `merge_accounts` with `confirm: true` only after the
    owner's explicit yes in a later message, quoting it as `evidence`.
11. A named spending selection the owner wants kept ("remember elective spending as") is a
    `save_spending_definition` call, never `remember_preference`. A saved definition named in a
    question ("my elective spending") is passed as `definition`, by the id the context lists.
12. Explain, do not advise on securities. Comparisons by account type describe where tax shows up
    and when money can come out; they never say which to choose.

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

Today packs are cited markdown entries plus activation rules. Ask's system prompt already includes
the active packs' full context (`packContext` in `buildChatPrompt`), and `list_packs`,
`get_pack_entry` and `search_pack_entries` exist.

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

1. Pack prose is the home of the knowledge and reaches answers the way packs already do: the active
   pack context in the prompt, plus `get_pack_entry` and search. Both new packs are always active
   (`appliesWhen: {"all": []}` is true per `packs/README.md`), so the model always has the
   definitions.
2. Every rule a figure depends on is encoded once in deterministic code in `src/calc`, as
   `LAW_REFS` and `parameters-2026.mjs` are, with a `packRef` to the entry that states it. The
   figure's provenance carries that `packRef`, so the answer cites the pack.
3. Structured tables exist only where a calculator needs data: `CATEGORY_CLASSES` and
   `BUILTIN_DEFINITIONS` and `OBLIGATION_RULES` in `src/calc/classes.mjs`, `ACCOUNT_TREATMENT`,
   `ACCESS_RULES` and `rmdStartAge` in `src/calc/treatment.mjs`, all frozen code constants, not a
   new manifest schema.
4. A consistency test per pack (`test/pack-consistency-spending.test.mjs`,
   `test/pack-consistency-treatment.test.mjs`) asserts every `packRef` resolves through `getEntry`,
   and that the entry's prose states the encoded value (the access ages, each RMD age and its birth years, the
   childcare ages, the college age, every class and category name in the map), so prose and code
   cannot drift silently.

Rejected: a versioned rule-table schema in manifests parsed at runtime (more surface, a second
source of truth to validate, and the owner said parsing is not the point); prose only (the model
would do the arithmetic).

### Tools that use it

Spending by class (`aggregate_transactions` with `groupBy: 'class'` and the built-in definitions
`essential` and `discretionary`), `obligation_schedule`, `spending_projection`, `after_tax_value`,
`access_schedule` and `bridge_check`, each with an H4 block in section 3.

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

| Key | Type | Exists today | Collectable by `record_household_fact` |
|---|---|---|---|
| `household.ownerAge` | age | yes, `ANSWER_SHAPES` | yes |
| `household.spouseAge` | age | yes, `ANSWER_SHAPES` | yes |
| `household.expectedDate` | date | yes, `ANSWER_SHAPES` | yes |
| `household.dependentAges` | int list | frozen key, no answer shape | after T19 adds the shape |
| `household.dependentBirthDates` | date list (new `dates` shape type, 1..10) | no | after T19 |
| `household.ownerBirthDate`, `household.spouseBirthDate` | date | no | after T19 |
| `household.retireAge` | age per person | no | after T19 (person scope) |
| `obligations.mortgage` | object `{ balance, rate (ratio), monthlyPayment, escrowMonthly, payoffDate? }` | no | after T19 |
| `obligations.childcare` | object `{ schoolAgeMonthly?, afterCareEndMonthly? }` (dollars per month) | no | after T19 |
| `obligations.childcareChangeDate` | date | no | after T19 |
| `accounts.planType` | per account choice: `traditional_ira`, `roth_ira`, `sep_ira`, `401k`, `roth_401k`, `solo_401k`, `403b`, `457b`, `hsa`, `529`, `taxable` | no | after T19 (account scope, kinds retirement, roth, ira, taxable, brokerage) |
| `accounts.rothFirstContributionYear` | per account year (1975 to the current year) | no | after T19 (account scope, kind roth, or plan type roth_ira or roth_401k) |
| `accounts.rothBasis` | per account dollars | no | after T19 (account scope, kind roth) |

`accounts.planType` replaces the `accounts.taxTreatment` key an earlier draft named: one fact
gives the treatment, the employer-plan status rule of 55 needs, and the Roth IRA or Roth 401(k)
subtype. HSA withdrawal purpose is not a fact: `after_tax_value` returns both outcomes. Facts can
also come from data: a mirrored loan account's balance gives the mortgage balance, and
the dependent ages fact gives birth years when no dates are stored.

The tickets for this section are T2, T3, T19, T20 and T21 in the single ordered list in section 7.

## 6. API parity

Owner principle:

> "Anything that can happen through the API should be doable by the agent. If I want the agent to
> categorize things for me, it can. If I want it to change some of my accounts from my spouse to
> me, I could do it in the UI and the agent can do it. We have to make our entire internal API a
> first-class citizen to the agent. And if I just want to use my own agent, Fathom becomes
> headless through MCP."

### Route inventory

Every mutating route in `src/api/router.mjs` on main, plus the account routes on
feat/account-dialog-edit and the preference and undo routes on feat/ask-actions. The account
merge-candidates route is a GET and is covered by the read tool `list_merge_candidates`.

| Route | What it does | Covering tool | Status | Scope |
|---|---|---|---|---|
| `/api/auth/register/options` | Passkey registration options | none | Excluded | none |
| `/api/auth/register/verify` | Passkey registration | none | Excluded | none |
| `/api/auth/signin/options` | Sign-in options | none | Excluded | none |
| `/api/auth/signin/verify` | Sign in | none | Excluded | none |
| `/api/auth/recover` | Account recovery | none | Excluded | none |
| `/api/auth/signout` | Sign out | none | Excluded | none |
| `/api/auth/passkeys/link` | Link a new device | none | Excluded | none |
| `/api/auth/passkeys/:id/revoke` | Revoke a passkey | none | Excluded | none |
| `/api/admin/users/invite` | Invite a user | none | Excluded | none |
| `/api/admin/users/:id/role` | Change a user's role | none | Excluded | none |
| `/api/admin/users/:id/remove` | Remove a user | none | Excluded | none |
| `/api/admin/users/:id/passkeys/:keyId/revoke` | Revoke a user's passkey | none | Excluded | none |
| `/api/auth/invitations/accept` | Accept an invitation | none | Excluded | none |
| `/api/operator/households` | Provision a household | none | Excluded | none |
| `/api/recs/:id/action` | Rec status, owner, step, snooze | `set_recommendation_status`, `set_recommendation_owner`; `set_recommendation_step` | exists on main; step coming in feat/ask-actions | write:recs; write:steps |
| `/api/recs/:id/answers` | Save a rec's fact answers and replan | `answer_recommendation_questions` | new in T22 | write:facts |
| `/api/recs/:id/start-over` | Detach a rec's threads | `start_recommendation_over` | new in T22 | write:recs |
| `/api/wargame/:name/pick` | Pick a war-game point | `pick_wargame_point` | new in T22 | write:decisions |
| `/api/decisions/:id/decide` | Decide a decision | `decide_decision` | new in T22 | write:decisions |
| `/api/decisions/:id/revisit` | Reopen a decision | `revisit_decision` | new in T22 | write:decisions |
| `/api/packs/:id/toggle` | Turn a pack on or off | `set_pack_active` | new in T22 | write:preferences |
| `/api/packs/:id/whatif` | Run a pack's what-if answer | none | Excluded | none |
| `/api/engine` | Engine on or off | none | Excluded | none |
| `/api/engine/cap` | Engine budget cap | none | Excluded | none |
| `/api/your-plans/build` | Build the private Your plans pack | `build_your_plans` | new in T26 | write:imports |
| `/api/ask` | Ask a question | none | Excluded | none |
| `/api/threads` | Start a thread | none | Excluded | none |
| `/api/threads/:id/rename` | Rename a thread | none | Excluded | none |
| `/api/threads/:id/archive` | Archive a thread | none | Excluded | none |
| `/api/threads/:id/trash` | Trash a thread | none | Excluded | none |
| `/api/threads/:id/restore` | Restore a thread | none | Excluded | none |
| `/api/threads/:id/delete` | Delete a thread | none | Excluded | none |
| `/api/accounts/:id/name` | Display name | `rename_account` | new in T27 | write:accounts |
| `/api/accounts/:id/mask` | Last four | `set_account_mask` | new in T27 | write:accounts |
| `/api/accounts/:id/owner` | Owner | `set_account_owner` | new in T27 | write:accounts |
| `/api/accounts/:id/kind` | Kind | `set_account_kind` | new in T27 | write:accounts |
| `/api/accounts/:id/merge` | Merge two accounts | `merge_accounts` (explicit confirm) | new in T27 | write:accounts |
| `/api/goals` | Create a goal | `create_goal` | coming in feat/ask-actions | write:goals |
| `/api/goals/:id` | Edit a goal | `edit_goal` | coming in feat/ask-actions | write:goals |
| `/api/goals/:id/archive` | Archive a goal | `archive_goal` | new in T23 | write:goals |
| `/api/goals/:id/delete` | Delete a goal | `delete_goal` | new in T23 | write:goals |
| `/api/goals/:id/suggestion` | Dismiss, restore or rate a suggestion | `set_goal_suggestion` | new in T23 | write:goals |
| `/api/curve` | Tradeoff curve positions | `set_curve_position` | new in T23 | write:preferences |
| `/api/onboarding` | First-run wizard step | none | Excluded | none |
| `/api/onboarding/notes` | Save setup notes as a markdown file | `import_file` (a `text/markdown` note) | new in T26 | write:imports |
| `/api/demo/reset` | Reset the demo | none | Excluded | none |
| `/api/keys` | Create an API key | none | Excluded | none |
| `/api/keys/:id/revoke` | Revoke an API key | none | Excluded | none |
| `/api/files` | Upload files | `import_file` | new in T26 | write:imports |
| `/api/files/:id/retry` | Retry a file | `retry_import` | new in T26 | write:imports |
| `/api/confirm/list` | List Confirm items (a read) | `list_confirm_items` | new in T25 | read |
| `/api/confirm/answers` | Answer many items | `answer_confirm_item` | new in T25 | write:confirm |
| `/api/confirm/reopen-many` | Reopen many items | `reopen_confirm_item` | new in T25 | write:confirm |
| `/api/confirm/:id/answer` | Answer or revise one item | `answer_confirm_item` | new in T25 | write:confirm |
| `/api/confirm/:id/reopen` | Reopen one item | `reopen_confirm_item` | new in T25 | write:confirm |
| `/api/email/test` | Send a test email | none | Excluded | none |
| `/api/email/brief` | Send the brief email | none | Excluded | none |
| `/api/advisor/reviews` | Send a rec to the advisor | `send_to_advisor` | new in T24 | write:recs |
| `/api/advisor/reviews/:id/verdict` | Record a verdict | `record_advisor_verdict` | new in T24 | write:recs |
| `/api/advisor/checkin` | Set the next check-in | `set_advisor_checkin` | new in T24 | write:recs |
| `/api/advisor/packets` | Build a review packet | `create_review_packet` | new in T24 | write:recs |
| `/api/jobs/:id/run` | Run a job now | `run_job` | new in T26 | write:jobs |
| `/api/simplefin/connect` | Connect the bank bridge | none | Excluded | none |
| `/api/simplefin/disconnect` | Disconnect the bank bridge | none | Excluded | none |
| `/api/yearend/marks` | Mark an expected document not needed | `mark_yearend_item` | new in T24 | write:confirm |
| `/api/actions/:id/undo` | Undo an action receipt | `undo_<kind>_action` | coming in feat/ask-actions; four more in T17 | the receipt's scope |
| `/api/preferences` | Remember a preference | `remember_preference` | coming in feat/ask-actions | write:preferences |
| `/api/preferences/:id` | Edit a preference | `remember_preference` with `id` | coming in feat/ask-actions | write:preferences |
| `/api/preferences/:id/delete` | Delete a preference | `forget_preference` | new in T18 | write:preferences |

Choices the table settles:

1. Onboarding notes are covered by `import_file`: the route only wraps `ingestFile` on a markdown
   note, so a second tool would duplicate it. Facts said in chat go through
   `record_household_fact`. The onboarding step route is first-run sequencing for the wizard and is
   excluded.
2. Threads and `/api/ask` are excluded as conversation chrome: an MCP client keeps its own
   conversations, and Ask creating or renaming its own threads is a loop with no owner value.
3. The pack what-if is excluded: it is itself an Ask answer, and the agent answers what-ifs with
   the tools directly.
4. Every tool is on both surfaces. `import_file` takes base64 content over MCP and owner-pasted
   text in Ask, with the same 1 MiB limit. `build_your_plans` runs inline over MCP and is queued to
   run after the round in Ask. `merge_accounts` needs `confirm: true` and the owner's confirming
   words on both.

### Exclusions

1. Sign-in, registration, recovery, sign-out and passkeys: identity belongs to the person, never an
   agent. The agent offers a link to the sign-in or Settings screen.
2. Admin user management and operator provisioning: administration of who can see the household is
   not delegated to a key. The agent links to Settings, People.
3. API key create and revoke: a key must never mint or widen keys. The agent links to Settings,
   Connections.
4. Anything that sends email or leaves the product (`/api/email/test`, `/api/email/brief`): no
   outbound actions from an agent. The agent links to Settings, Email.
5. SimpleFIN connect and disconnect: bank credential handling stays with the person. The agent
   links to Settings, Connections; `run_job {id: 'simplefin-sync'}` covers a sync once connected.
6. Engine switch and cap: the agent never turns itself on or raises its own budget. The agent links
   to Settings, Engine.
7. Demo reset: demo-only and destructive. No link.

### New scopes

The scopes today are `read` and `write:recs` on main, plus `write:facts`, `write:steps`,
`write:goals` and `write:preferences` from feat/ask-actions. The minimal additions:

| Scope | Tools | SCOPE_INFO access text |
|---|---|---|
| `write:accounts` | `rename_account`, `set_account_mask`, `set_account_owner`, `set_account_kind`, `merge_accounts` | Rename accounts, set their last four, owner and kind, and merge duplicates with confirmation. |
| `write:categories` | `set_transaction_category`, `set_merchant_rule` | Correct transaction categories and set merchant rules. |
| `write:confirm` | `answer_confirm_item`, `reopen_confirm_item`, `mark_yearend_item` | Answer and reopen Confirm questions and mark expected tax documents. |
| `write:imports` | `import_file`, `retry_import`, `build_your_plans` | Import files and retry or build from imported documents. |
| `write:jobs` | `run_job` | Run planning, sync, freshness and guess jobs now. |
| `write:decisions` | `pick_wargame_point`, `decide_decision`, `revisit_decision` | Pick and decide war-game options and reopen decisions. |

Advisor tools use `write:recs` (the advisor workflow acts on recommendations), and its
`SCOPE_INFO` text gains them. Pack activation and curve positions use `write:preferences`. T17
adds the six scopes to `WRITE_SCOPES` (`src/shared/action-scopes.mjs`) and `SCOPE_INFO`
(`src/mcp/keys.mjs`); `createRegistryServer`'s whitelist already reads `WRITE_SCOPES` after
feat/ask-actions merges, so T17 asserts it accepts each one. Every tool is offered to Ask (writes
in chat purpose) and to MCP under its scope, with no exceptions. A headless client with a
full-scope key can then do everything the UI can except the exclusions.

### Parity test

T1 makes each tool module declare the routes it covers: a module in `src/tools/catalog/` exports
`tools` and `parity` (`{ '<route path>': ['<tool name>'] }`), and the registry loader collects
both. T4 adds `src/tools/parity.mjs` with two checked-in maps, `PARITY_EXCLUDED` (route to a
one-sentence reason) and `PARITY_PENDING` (route to the tool names a later ticket or a sibling
branch will add, with the ticket or branch named), and `test/tools-parity.test.mjs`, which imports
`routes` from `src/api/router.mjs` and fails when:

1. a route with method POST, PUT, PATCH or DELETE is not covered: no module declares it, it is not
   excluded, and it is not pending;
2. a route is both excluded and declared or pending;
3. a declared tool name is not in the registry, or a declared or excluded route is not in the
   router;
4. `process.env.PARITY_STRICT === '1'` and a pending tool name is absent from the registry.

A pending entry passes whether its tool is absent or present, and a pending route need not exist
in the router yet. So the parity test stays green when a sibling branch merges its routes or
tools, and when a ticket lands its tool: nobody edits `src/tools/parity.mjs` after T4. Strict mode
is the completion check (`PARITY_STRICT=1 node --test test/tools-parity.test.mjs` passes once every
pending tool exists); CI does not set it. A pending entry whose tool exists is redundant and
harmless; removing them is optional cleanup, not a ticket step. New routes still cannot skip the
agent, because rule 1 fails on any route nobody declared, excluded or listed as pending.

## 7. Implementation tickets

Calendar estimate: about three to five calendar days end to end at three parallel workers, each
ticket one agent run plus CI and a cross-provider review, closer to five because of the serialized
chains below. Dominated by the sibling merges (feat/ask-actions, feat/account-dialog-edit,
fix/ask-answer-quality, feat/ask-evals) and the owner's merge gate. It stretches if a sibling slips
(every write ticket waits on feat/ask-actions through T17), if review rounds exceed one per ticket,
if CI reruns pile up on a loaded host, or if a migration number collides.

Waves (dependency graph). A ticket starts when everything in its Depends on line has merged.

| Wave | Starts when | Tickets |
|---|---|---|
| 1 | now | T1, T2 |
| 2 | T1 merges (T3 needs T2, T6 needs T2) | T3, T4, T5, T6, T8, T9, T10, T11, T12 |
| 3 | its wave 2 inputs merge | T7 (T3), T13 (T6), T14 (T5, T6), T15 (T3, T5) |
| Sibling-gated | feat/ask-evals merges | T16 |
| Sibling-gated | feat/ask-actions merges | T17 (also T8), T19 |
| 4 | T17 or T19 merges | T18 (T6, T8, T17), T20 (T6, T19) |
| 5 | T20 merges | T21 (T3, T15, T19, T20) |
| Writes | T4 and T17 merge | T22, T23, T24, T25, T26 |
| Writes, late | T25 and feat/account-dialog-edit merge | T27 |
| Last | fix/ask-answer-quality, T5, T6, T14, T17, T18 merge | T28 |

Serialized chains, by shared file: `src/api/answerer.mjs` (T8, then T17, then T28);
`test/answerer.test.mjs` (T8, then T28); `docs/architecture.md` (T8, then T18);
`src/packs/test/content.test.mjs` (T2, then T3); `src/calc/targets.mjs` and
`test/tools.test.mjs` (T1, then T6 and T8); `src/tools/catalog/transactions.mjs` (T1, then T6);
`src/tools/catalog/business.mjs` (T1, then T8). Every other file has one owning ticket, and
tickets marked parallel share no file.

How tools register. T1 turns `src/tools/index.mjs` into a loader: it imports every module in
`src/tools/catalog/` (sorted by file name, top-level `await`), concatenates their `tools`
exports into the sorted `tools` array and their `parity` exports into the route map. A tool ticket
adds its own catalog module and never edits `src/tools/index.mjs` or `src/tools/parity.mjs`. Write
tickets register their receipt kinds from their own module through `registerReceiptKind` (T17).
No ticket edits this file.

Standing acceptance, part of every ticket below:

1. Every figure a new or changed read tool returns passes `assertRefsResolve` (T1).
2. Every new write tool: a read-only MCP key gets "Permission denied:" for it before argument
   validation; it is offered to Ask in chat purpose and listed over MCP under its scope; every
   receipt kind it creates restores through its undo, and every advertised undo call validates
   against the named tool's schema.
3. Tests build real stores (`tempDb` from `test/helpers/server.mjs` with `seedDemo`, or
   `createRealStore` from `test/helpers/real-store.mjs`) on the synthetic demo household and
   assert figures against a deterministic recomputation from the same store, never hard-coded
   amounts.
4. The ticket edits only its Files.

### T1 Figure envelope, adapters and the registry loader

Size: about 260 production lines, 200 test lines.

Depends on: none.

Files: `src/calc/figure.mjs` (new: `figure`, `envelope`, `fromStored`, `fromPace`, `rowsSource`,
`mergeSources`, `UNITS`, `GAP_CODES`, precision by unit), `src/calc/targets.mjs` (imports the
moved helpers), `src/tools/index.mjs` (the loader; validation and `callTool` stay),
`src/tools/catalog/figures.mjs` (new: `get_figures` and `get_pace` with envelopes),
`src/tools/catalog/transactions.mjs` (new: `query_transactions` moved unchanged),
`src/tools/catalog/business.mjs` (new: `pnl_by_month` moved unchanged), `src/mcp/keys.mjs`
(`toolsForScopes` sorts by name), `test/helpers/figures.mjs` (new: `assertRefsResolve`),
`test/figure-envelope.test.mjs` (new), `test/tools.test.mjs` (envelope assertions).

Acceptance:

1. `targets.mjs` defines none of the moved helpers and its tests pass unchanged.
2. `envelope` rounds per unit as section 3 states (a ratio of 1/3 keeps full precision, a usd
   value rounds to cents, months from a projection round up), accepts ratios above 1 and below 0,
   rejects an unknown unit or gap code, and allows a null value only with `unavailable`.
3. `get_figures` returns every field it returned before plus the envelope; `fromStored` keeps the
   stored `src` and `locator` under `provenance.stored`; a `get_figures` ref and a `get_pace` ref
   each resolve through `assertRefsResolve`.
4. The registry built by the loader holds the same tools as before, sorted by name, and the MCP
   tool list is sorted by name.

Test command: `node --test test/figure-envelope.test.mjs test/tools.test.mjs src/calc/test/*.test.mjs src/mcp/test/server.test.mjs`

Parallel: beside T2 (no shared files).

Evals: none turn green alone; every new-tool case depends on it.

### T2 Spending classes and the spending-and-obligations pack

Size: about 120 production lines and 6 pack entries, 150 test lines.

Depends on: none.

Files: `src/calc/classes.mjs` (new: `CATEGORY_CLASSES`, `classOf(category, bucket)`,
`BUILTIN_DEFINITIONS`, `OBLIGATION_RULES`, each with `packRef`), `packs/spending-and-obligations/`
(new: manifest and the six entries in section 5), `packs/kids-dependents/care-cost-by-age.md`,
`packs/w2-benefits/premiums-through-payroll.md`,
`packs/self-employed-partnership/premiums-paid-by-business.md` (and those three manifests),
`src/packs/test/content.test.mjs` (inventory and entry subjects), `test/pack-consistency-spending.test.mjs` (new).

Acceptance:

1. Every category in `CATEGORY_TABLES` (both parsers) has a class; a test fails on a new category
   without one.
2. The pack has `appliesWhen: {"all": []}`, six entries, and is active for an empty fact set.
3. The consistency test resolves every `packRef` with `getEntry` and finds each class name, each
   category name, the childcare ages (5 and 13), the college age (18) and the escrow rule in the
   cited entry's body.
4. Entries carry `Tax year: 2026`, `Reviewed:` and inline links matching their citations.

Test command: `node --test test/pack-consistency-spending.test.mjs src/packs/test/engine.test.mjs src/packs/test/content.test.mjs`

Parallel: beside T1. Owns `src/packs/test/content.test.mjs` until it merges; T3 follows it.

Evals: none alone; feeds `q05-essential-vs-discretionary` with T6.

### T3 Account tax treatment pack and constants

Size: about 160 production lines and 6 pack entries, 170 test lines.

Depends on: T2 (serialized on `src/packs/test/content.test.mjs`).

Files: `src/calc/treatment.mjs` (new: `ACCOUNT_TREATMENT` by kind and by plan type,
`EMPLOYER_PLAN_TYPES`, `ACCESS_RULES`, `rmdStartAge(birthDate)`, each with `packRef`),
`packs/account-tax-treatment/` (new), `packs/advanced-retirement/access-and-rmd-pointer.md` and
its manifest, `src/packs/test/content.test.mjs`, `test/pack-consistency-treatment.test.mjs` (new),
`test/treatment.test.mjs` (new).

Acceptance:

1. `rmdStartAge` returns 72, 73 and 75 for birth dates in 1950, 1955 and 1965, and the
   `required-minimum-distributions` entry states each age with its birth years.
2. Every account kind in `KIND_OPTIONS` and `INVESTMENT_KINDS`, and every `accounts.planType`
   value, maps to a treatment; `retirement` and `ira` kinds map to "needs plan type".
3. The consistency test finds 59 and a half, 55, 65, the five-year rule and the HSA 20 percent
   additional tax in the cited entries.
4. The pack is always active and has six entries.

Test command: `node --test test/treatment.test.mjs test/pack-consistency-treatment.test.mjs src/packs/test/content.test.mjs`

Parallel: beside T4 to T6, T8 to T12.

Evals: none alone; feeds `q29-penalty-free-access` and `q30-rmd-start` with T21.

### T4 API parity test and exclusion list

Size: about 120 production lines, 110 test lines.

Depends on: T1 (the loader collects each module's `parity` export).

Files: `src/tools/parity.mjs` (new), `src/tools/catalog/core-parity.mjs` (new: the `parity`
declarations for the existing write tools on main), `test/tools-parity.test.mjs` (new).

Acceptance:

1. `PARITY_EXCLUDED` holds every excluded route with the reason section 6 gives; `PARITY_PENDING`
   holds every route a later ticket or sibling branch covers, with the tool names and owner.
2. Each of the four failure rules in section 6 has a test over a synthetic routes list and
   registry, plus one run over the real router and registry that passes.
3. A pending entry passes with its tool absent and with it present; a pending route absent from
   the router passes.
4. `PARITY_STRICT=1 node --test test/tools-parity.test.mjs` fails while a pending tool is absent.

Test command: `node --test test/tools-parity.test.mjs`

Parallel: beside T3, T5, T6, T8 to T12.

Evals: none (a structural gate, not an Ask behavior).

### T5 calculate and figure references

Size: about 260 production lines, 260 test lines.

Depends on: T1.

Files: `src/tools/refs.mjs` (new), `src/tools/catalog/calculate.mjs` (new), `src/calc/growth.mjs`
(new: `futureValue`, `requiredMonthly`), `test/tools-calculate.test.mjs` (new).

Acceptance:

1. Every operation in section 3 computes the expected value and unit on refs to real
   `get_figures` and `get_pace` figures over the demo store, recomputed in the test from the same
   figures; ratio results above 1 and below 0 are returned unrounded.
2. Unit mismatches, division by zero, more than 20 operands, depth over 6, ref depth over 3, refs
   to write tools and bare numbers are `bad_input` with a message naming the cause.
3. `source: 'fact'` with a value that differs from the stored fact is refused; `source: 'default'`
   with a non-default value is refused; `source: 'owner'` without `evidence` is refused, and in an
   Ask context with owner text that lacks the value it is refused.
4. A grounding test runs `groundAnswer` over a reply that states "4 percent" and the calculate
   result's value and finds both grounded; if the answerer's echo rule blocks it, the test is
   committed as `todo` naming T28 and this ticket still passes.

Test command: `node --test test/tools-calculate.test.mjs`

Parallel: beside T3, T4, T6, T8 to T12.

Evals: `q14-savings-rate`, `q21-net-worth-change`, `q44-cash-cushion-months` (with T6 and T7).

### T6 aggregate_transactions and query_transactions filters

Size: about 300 production lines, 280 test lines.

Depends on: T1, T2.

Files: `src/calc/aggregate.mjs` (new), `src/calc/targets.mjs` (`spendingInputs` reuses the shared
row selection), `src/tools/catalog/spending.mjs` (new), `src/tools/catalog/transactions.mjs`
(`query_transactions` filters and fields), `test/tools-spending.test.mjs` (new).

Acceptance:

1. `{measure: 'spending'}` over `spending_window` equals `spendingInputs(...).spendTotal` on the
   demo store and on a `createRealStore` household with a card account.
2. The Q01 arguments return a total that equals household spending less the mortgage rows,
   recomputed in the test from `resolveCategories`; `excluded` reports the mortgage and tax rows'
   matched amounts; groups sum to the total; the healthcare class group is present.
3. `definition: 'essential'` returns one total equal to the sum of its five class groups,
   recomputed in the test.
4. Gaps appear with correct amounts and counts for uncategorized, guessed, a silent card account,
   and `outside_household_ledger` when `income.w2` is true.
5. Every period, group, scope and definition merge rule has a test; `limit` folds into `other`.
6. `query_transactions` filters by bucket, class and merchant and returns the resolved fields; its
   existing tests in `test/tools.test.mjs` pass unchanged.

Test command: `node --test test/tools-spending.test.mjs test/categories.test.mjs test/tools.test.mjs`

Parallel: beside T3 to T5, T8 to T12.

Evals: `q01-spend-excl-mortgage-tax`, `q04-groceries-dining-monthly`,
`q05-essential-vs-discretionary`, `q06-top-merchants`, `q07-childcare-2025`,
`q08-healthcare-premiums`, `q15-income-by-source` (with T8), `q16-monthly-take-home`,
`q41-529-contributions` (with T9).

### T7 net_worth

Size: about 160 production lines, 150 test lines.

Depends on: T1, T3.

Files: `src/tools/catalog/net-worth.mjs` (new), `test/tools-net-worth.test.mjs` (new).

Acceptance:

1. `total` and part figures equal `buildTrend` on the demo store at the last point.
2. `series` returns `months` points matching the trend's points.
3. `groupBy: 'treatment'` groups every demo account by `ACCOUNT_TREATMENT`, with `accounts.planType`
   overriding kind when stated, and names accounts whose kind needs a plan type in a gap.
4. Carried accounts produce `carried_balance` gaps.

Test command: `node --test test/tools-net-worth.test.mjs test/trend.test.mjs`

Parallel: beside T13 to T15.

Evals: `q20-net-worth-parts`, `q22-retirement-vs-taxable`, `q32-accounts-by-treatment`.

### T8 business_pnl replaces pnl_by_month

Size: about 150 production lines, 160 test lines changed or added.

Depends on: T1.

Files: `src/tools/catalog/business.mjs` (`business_pnl` replaces `pnl_by_month`),
`src/api/answerer.mjs` (the progress label only), `test/tools.test.mjs`, `test/answerer.test.mjs`
(migrate the `pnl_by_month` cases), `docs/architecture.md` (section 8 table row),
`test/tools-business.test.mjs` (new).

Acceptance:

1. No file outside `mock-v2/` names `pnl_by_month`.
2. Revenue, expenses, profit and margin per entity equal sums recomputed from `pnl_lines` in the
   test, for ytd, a custom range and calendar year.
3. `compareToPriorYear` returns the prior year's same months with `revenueDifference`,
   `revenueRatio`, `profitDifference` and `profitRatio` equal to the test's recomputation.
4. The migrated answerer grounding tests pass against `business_pnl` results.

Test command: `node --test test/tools-business.test.mjs test/tools.test.mjs test/answerer.test.mjs`

Parallel: beside T3 to T6, T9 to T12. First in the `src/api/answerer.mjs` and
`docs/architecture.md` chains.

Evals: `q17-business-profit-margin`, `q18-revenue-vs-last-year`, `q19-expense-categories-quarter`.

### T9 contribution_room

Size: about 200 production lines, 170 test lines.

Depends on: T1.

Files: `src/tools/catalog/room.mjs` (new), `test/tools-room.test.mjs` (new).

Acceptance:

1. On a `createRealStore` household after a planning run, `remaining` equals the stored `room.*`
   figures and `limit` equals the calculator output for the same inputs.
2. Without a planning run in the tax year, rows come from the calculators with `used`
   unavailable and a gap.
3. Every type in the enum returns a row or a gap naming why not.

Test command: `node --test test/tools-room.test.mjs`

Parallel: beside T3 to T8, T10 to T12.

Evals: `q38-solo401k-room`, `q39-ira-room`, `q40-hsa-room`, `q42-dependent-care-limit`.

### T10 tax_estimate

Size: about 240 production lines, 200 test lines.

Depends on: T1.

Files: `src/tools/catalog/tax.mjs` (new), `src/jobs/planner/household.mjs` (export a pure entry
the what-if reuses, no behavior change), `test/tools-tax.test.mjs` (new).

Acceptance:

1. Projected, paid, withheld and safe-harbor figures equal the stored `tax.*` and `sh.*` figures.
2. A what-if of zero returns zero deltas; a positive extra business income returns deltas equal to
   rerunning `householdTax` with and without it in the test.
3. Marginal rates equal the bracket the projected taxable income falls in, from `TAX_2026`, as
   unrounded ratios.
4. `nextDueDate` equals the next estimated-payment deadline after the clock.

Test command: `node --test test/tools-tax.test.mjs`

Parallel: beside T3 to T9, T11, T12.

Evals: `q34-tax-owed`, `q35-safe-harbor`, `q36-extra-income-whatif`, `q37-se-tax`.

### T11 data_health

Size: about 140 production lines, 120 test lines.

Depends on: T1.

Files: `src/tools/catalog/health.mjs` (new), `test/tools-health.test.mjs` (new).

Acceptance:

1. Account freshness equals `accountFreshness` for every demo account.
2. Category counts equal `categoryCoverage`; year-end items equal `yearendChecklist`.
3. An account with no rows has empty `lastData` and an `account_no_history` gap.

Test command: `node --test test/tools-health.test.mjs`

Parallel: beside T3 to T10, T12.

Evals: `q56-stale-accounts`, `q57-uncategorized-count`, `q58-no-history-accounts`.

### T12 recurring_charges

Size: about 200 production lines, 200 test lines.

Depends on: T1.

Files: `src/calc/recurring.mjs` (new), `src/tools/catalog/recurring.mjs` (new),
`test/tools-recurring.test.mjs` (new).

Acceptance:

1. On a store with synthetic monthly, quarterly and annual charges added through `addFile`, each
   is detected with its cadence, typical amount and next date; a one-off charge is not.
2. A charge that stops is `stopped`; one that starts after `since` is `new`; a price change sets
   `changed`.
3. Matched transfers are never charges; annual cost equals typical amount times cadence per year.

Test command: `node --test test/tools-recurring.test.mjs`

Parallel: beside T3 to T11.

Evals: `q45-subscriptions-annual`, `q46-new-recurring`, `q47-stopped-or-changed`.

### T13 compare_periods and cash_flow

Size: about 200 production lines, 180 test lines.

Depends on: T6.

Files: `src/tools/catalog/flows.mjs` (new), `test/tools-flows.test.mjs` (new).

Acceptance:

1. `compare_periods` totals equal two `aggregate_transactions` calls; difference and ratio follow,
   and the ratio is absent when `a` is zero.
2. `unequal_periods` appears when month counts differ.
3. `cash_flow` household plus business inflow and outflow equal the totals of every non-transfer
   row; business to household transfers equal the matched pairs recomputed in the test.

Test command: `node --test test/tools-flows.test.mjs`

Parallel: beside T7, T14, T15.

Evals: `q11-monthly-net-cash-flow`, `q12-business-to-personal`, `q13-negative-months`,
`q48-this-year-vs-last`, `q49-summer-vs-summer`, `q50-dining-trend`.

### T14 independence_target and project_growth

Size: about 230 production lines, 220 test lines.

Depends on: T5, T6.

Files: `src/tools/catalog/targets.mjs` (new), `test/tools-targets.test.mjs` (new).

Acceptance:

1. With defaults, `target`, `investedNow`, `months` and `projectedDate` equal `independencePlan`
   over the same inputs on the demo store.
2. With a ref to the Q01 aggregate, the target equals the ref's value over the rate, rounded up to
   the next thousand, and provenance holds the ref's provenance.
3. A withdrawal rate outside 0.02 to 0.06 or a real return outside minus 0.05 to 0.10 is refused;
   covered, no-savings and too-long statuses each have a test.
4. `project_growth` balance, months and monthly agree with `futureValue`, `monthsToReach` and
   `requiredMonthly`; `byAge` resolves from a birth date fact and falls back to the age fact.

Test command: `node --test test/tools-targets.test.mjs`

Parallel: beside T7, T13, T15.

Evals: `q02-independence-target-4pct`, `q03-gap-and-date`, `q23-ten-year-growth`,
`q24-monthly-to-target-by-55`, `q25-return-3pct-whatif`, `q26-withdrawal-35pct`,
`q27-extra-1000-sooner`.

### T15 after_tax_value

Size: about 190 production lines, 200 test lines.

Depends on: T3, T5.

Files: `src/tools/catalog/after-tax.mjs` (new), `test/tools-after-tax.test.mjs` (new).

Acceptance:

1. Each treatment's after-tax value equals the section 3 rule recomputed in the test from the
   positions and the passed rates.
2. A taxable row with a position lacking cost basis returns `basis`, `unrealizedGain`,
   `taxOnWithdrawal` and `afterTax` unavailable with `no_cost_basis` counting the positions; a
   hypothetical taxable row without `basis` does the same.
3. An HSA row returns both `afterTaxMedical` and `afterTaxNonmedical` and an unavailable
   `afterTax`; a Roth row without `accounts.rothFirstContributionYear` returns `qualifiedFrom`
   unavailable with a gap; a `retirement` account without `accounts.planType` is unavailable with
   a gap. Facts for these cases are written with `addFact` once T19 is on main, else the cases
   assert the gaps.
4. Missing rates are refused; refs to `tax_estimate` marginal rates are accepted.

Test command: `node --test test/tools-after-tax.test.mjs`

Parallel: beside T7, T13, T14.

Evals: `q28-15m-retirement-vs-brokerage`, `q33-unrealized-gains-tax`.

### T16 Ask eval cases

Size: about 60 production lines of case loader glue, 69 case files of about 25 lines each.

Depends on: feat/ask-evals merged.

Files: `evals/cases/` (one file per case ID in section 8), and only the case index file the
feat/ask-evals runner defines.

Acceptance:

1. Every case ID in section 8 exists with the question, follow-ups, required tool calls with
   argument predicates, forbidden behavior (unsourced figure, self-computed figure, an assumption
   with source `owner` whose value is not in the owner's messages), expected figures computed at
   run time from the demo store by the named deterministic call, and a word budget.
2. Cases whose tools are not built are marked expected-fail naming the missing tool and ticket.
3. `npm run eval:ask` passes with the expected-fail cases counted as expected.

Test command: `npm run eval:ask`

Parallel: beside any ticket; it owns only `evals/cases/`.

Evals: creates every case; turns green those whose tools already exist (`q43-goal-pace`,
`q66-security-pick-refused`, `q67-market-quote-refused`, `q68-money-movement-refused`).

### T17 Write scopes, receipt kinds and tool services

Size: about 180 production lines, 220 test lines.

Depends on: feat/ask-actions merged, T1, T8 (serialized on `src/api/answerer.mjs`).

Files: `src/shared/action-scopes.mjs`, `src/mcp/keys.mjs` (`SCOPE_INFO`),
`src/actions/receipts.mjs` (`registerReceiptKind` replaces the fixed `TABLES`, kind `setting`),
`src/tools/catalog/undo.mjs` (new: `undo_account_action`, `undo_category_action`,
`undo_confirm_action`, `undo_decision_action`), `src/server.mjs` (one `services` object),
`src/mcp/index.mjs` (`ctx.services`), `src/api/answerer.mjs` (`createLiveAnswerer` accepts
`services` and puts it on the tool context), `src/mcp/test/keys.test.mjs`,
`test/write-scopes.test.mjs` (new), `test/tool-services.test.mjs` (new).

`services` is `{ scheduler, engine, config: { dataDir, dataKeyFile, clock }, dataKey() }`, built
once in `src/server.mjs` and passed to both `createMcpHandler` and `createLiveAnswerer`. Neither
context has these today (the MCP context on feat/ask-actions carries `replan` and `queuePlan`
only; Ask's carries the action context).

Acceptance:

1. `WRITE_SCOPES` and `SCOPE_INFO` hold `write:accounts`, `write:categories`, `write:confirm`,
   `write:imports`, `write:jobs` and `write:decisions` with the section 6 access text, and the
   `write:recs` text names the advisor tools.
2. `createRegistryServer` accepts an entry with each new scope and offers it only for purpose chat;
   key creation accepts the new scopes; a `read` key lists no write tool.
3. The existing receipt kinds still undo exactly as before (the feat/ask-actions tests pass); a
   kind registered from a test module with a table restores; one with a `restore` hook calls it;
   an unregistered kind is refused; kind `setting` restores a settings row by key.
4. A test tool reading `ctx.services` sees the same scheduler, engine and config through an MCP
   request (`createMcpHandler` over a real store) and through an Ask answer with the fake engine.

Test command: `node --test test/write-scopes.test.mjs test/tool-services.test.mjs src/mcp/test/keys.test.mjs test/ask-actions.test.mjs`

Parallel: beside T19 and the wave 3 tickets. Second in the `src/api/answerer.mjs` chain.

Evals: none (plumbing).

### T18 Saved spending definitions linked to preferences

Size: about 230 production lines plus one migration, 230 test lines.

Depends on: T6, T8 (serialized on `docs/architecture.md`), T17, feat/ask-actions merged.

Files: `src/store/migrations/<next>-spending-definitions.sql` (number set at merge; adds
`spending_definitions` and `preferences.definition_id`), `src/spending/definitions.mjs` (new),
`src/actions/preferences.mjs` (refuse editing a linked preference, delete both on forget,
`listPreferences` returns `definitionId`), `src/tools/catalog/definitions.mjs` (new:
`list_spending_definitions`, `save_spending_definition`, `delete_spending_definition`,
`forget_preference`, receipt kind `spending_definition`), `docs/architecture.md` (Tables),
`test/tools-definitions.test.mjs` (new).

Acceptance:

1. After migration, `spending_definitions (id slug primary key, name, def JSON, actor_id,
   created_at, updated_at)` and `preferences.definition_id` (unique, nullable) exist.
2. `save_spending_definition` creates the definition and one linked preference whose text names it
   and its id; saving again updates both; `undo_preference_action` on its receipt restores both
   rows or removes both.
3. `remember_preference` on a linked preference is refused; `forget_preference` on it deletes both
   rows; `delete_spending_definition` deletes both; each undo restores both.
4. A second conversation over the same store whose prompt context comes from `listPreferences`
   contains the definition's id, and `aggregate_transactions {definition: 'elective_spending'}`
   uses the saved selectors.
5. A built-in id is refused.

Test command: `node --test test/tools-definitions.test.mjs test/preferences.test.mjs`

Parallel: beside T20, T22 to T26.

Evals: `q09-elective-definition`, `q10-save-elective-definition`.

### T19 Household fact shapes for obligations and access

Size: about 140 production lines, 160 test lines.

Depends on: feat/ask-actions merged.

Files: `src/jobs/triggers/common.mjs` (`ANSWER_SHAPES`, `CONFIRM_TASKS`, `acceptsAnswerAccount`
taking a list of kinds or plan types), `src/facts/answers.mjs` (the `dates` type),
`test/fact-shapes.test.mjs` (new). The new keys are documented in section 5 of this file, so the
ticket does not edit `docs/architecture.md`.

Acceptance:

1. Every new key in the section 5 facts table has a shape and a confirm task; the `dates` type
   accepts 1 to 10 ISO dates and refuses anything else; `obligations.mortgage` requires
   `escrowMonthly`.
2. `record_household_fact` accepts each new key with a valid value and the owner's words as
   evidence, and refuses an invalid one.
3. `accounts.planType` is offered only for retirement, roth, ira, taxable and brokerage accounts;
   `accounts.rothFirstContributionYear` and `accounts.rothBasis` only for Roth accounts.

Test command: `node --test test/fact-shapes.test.mjs test/fact-answers.test.mjs`

Parallel: beside T17, T18 and the wave 3 tickets.

Evals: none alone; T20 and T21 cases need it.

### T20 obligation_schedule and spending_projection

Size: about 280 production lines, 260 test lines.

Depends on: T6, T19.

Files: `src/calc/obligations.mjs` (new), `src/tools/catalog/obligations.mjs` (new),
`test/tools-obligations.test.mjs` (new).

Acceptance:

1. A stated payoff date is used as is; with balance, rate and payment the payoff month equals an
   amortization recomputed in the test; with no mortgage fact, the change is unavailable with a
   `missing_fact` gap naming `obligations.mortgage`.
2. After payoff the mortgage's amount drops to `escrowMonthly`.
3. Childcare change dates follow `OBLIGATION_RULES` from birth dates and fall back to ages; a
   stage with a stated amount (fact or `changes` assumption) applies it; a stage without one is
   `applied: false` with a gap and the projection keeps the current amount.
4. With `definition: 'core_living'` (debt service excluded) the projection subtracts nothing at
   payoff and says why; with `household_spending` it subtracts the in-base mortgage amount less
   escrow, recomputed in the test; a ref base to a tool other than `aggregate_transactions` is
   `bad_input`.

Test command: `node --test test/tools-obligations.test.mjs`

Parallel: beside T18, T22 to T26.

Evals: `q51-spending-after-mortgage`, `q52-spending-after-childcare`, `q53-mortgage-end`,
`q54-childcare-changes`, `q55-529-end`.

### T21 access_schedule and bridge_check

Size: about 240 production lines, 240 test lines.

Depends on: T3, T15, T19, T20 (bridge_check reuses the spending-projection calculator).

Files: `src/tools/catalog/access.mjs` (new), `test/tools-access.test.mjs` (new).

Acceptance:

1. Milestone ages and dates follow `ACCESS_RULES` and `rmdStartAge` from birth date facts for both
   people; with only ages, dates fall at year precision with a gap; with neither, dates are
   unavailable.
2. `rule_of_55` lists only accounts whose plan type is an employer plan; an account with no plan
   type is named in a gap; Roth accounts are absent from `rmd_start`; a Roth account without a
   first contribution year has an unavailable `roth_earnings_qualified` date.
3. `bridge_check` spending until access equals the annual figure times the years, and accessible
   money equals taxable plus cash plus stated Roth contributions plus employer-plan balances only
   when `retireAge` is 55 or more, recomputed in the test.
4. Results contain no recommendation wording (a test scans for "should").

Test command: `node --test test/tools-access.test.mjs`

Parallel: beside T22 to T26.

Evals: `q29-penalty-free-access`, `q30-rmd-start`, `q31-bridge-to-59-half`.

### T22 Recommendation, decision and pack writes

Size: about 300 production lines, 280 test lines.

Depends on: T4, T17.

Files: `src/decisions/write.mjs` (new), `src/packs/state.mjs` (new), `src/store/recs.mjs`
(`detachRecThreads`), `src/api/handlers.mjs` (handlers call the moved functions),
`src/api/fact-answers.mjs` (`saveRecAnswers`), `src/tools/catalog/rec-writes.mjs` (new: the six
tools and receipt kind `rec_detach`), `test/tools-rec-writes.test.mjs` (new).

Acceptance:

1. Each of the six tools produces the same store state as its route for the same input (the test
   runs both on two copies of the demo store and compares the touched tables).
2. Each advertised undo restores the prior state: `undo_recommendation_action` for a detach,
   `undo_decision_action` for a pick, `revisit_decision` after decide, `decide_decision` with the
   returned index after revisit, `set_pack_active` with `wasActive`, `undo_fact_action` per answer.
3. Existing handler tests pass unchanged.

Test command: `node --test test/tools-rec-writes.test.mjs test/rec-threads.test.mjs test/question-recs.test.mjs test/tools-parity.test.mjs`

Parallel: beside T18, T20, T21, T23 to T26. Only ticket editing `src/api/handlers.mjs`.

Evals: `q62-decide-salary-option`.

### T23 Goal and curve writes

Size: about 190 production lines, 190 test lines.

Depends on: T4, T17.

Files: `src/goals/write.mjs` (`archiveGoal`, `deleteGoal`), `src/goals/curve.mjs` (new),
`src/suggest/write.mjs` (new), `src/api/goals.mjs`, `src/tools/catalog/goal-writes.mjs` (new:
the four tools and receipt kind `goal_row`), `test/tools-goal-writes.test.mjs` (new).

Acceptance:

1. `archive_goal`, `delete_goal`, `set_goal_suggestion` and `set_curve_position` each match their
   route's store state for the same input.
2. Each undo restores: a deleted goal's undo reinserts every column of the row; curve and
   suggestion undo restore the settings rows.
3. Existing goal handler tests pass unchanged.

Test command: `node --test test/tools-goal-writes.test.mjs test/goals.test.mjs test/goal-targets-api.test.mjs test/tools-parity.test.mjs`

Parallel: beside T18, T20 to T22, T24 to T26. Only ticket editing `src/api/goals.mjs`.

Evals: `q63-archive-goal`.

### T24 Advisor and year-end writes

Size: about 190 production lines, 190 test lines.

Depends on: T4, T17.

Files: `src/advisor/packet.mjs` (new), `src/api/advisor-handlers.mjs`,
`src/tools/catalog/advisor-writes.mjs` (new: the five tools and receipt kinds `advisor_checkin`
and `yearend_mark`), `test/tools-advisor-writes.test.mjs` (new).

Acceptance:

1. `send_to_advisor`, `record_advisor_verdict`, `set_advisor_checkin`, `create_review_packet` and
   `mark_yearend_item` each match their route's store state for the same input; the packet tool
   gets the data key from `ctx.services`.
2. Check-in and year-end mark undo restore their rows; the three non-undoable tools return
   `undo.available: false` with a reason.
3. A verdict note not in the owner's words is refused.

Test command: `node --test test/tools-advisor-writes.test.mjs test/yearend.test.mjs test/tools-parity.test.mjs`

Parallel: beside T18, T20 to T23, T25, T26. Only ticket editing `src/api/advisor-handlers.mjs`.

Evals: `q61-mark-1099-not-needed`, `q64-send-to-advisor`.

### T25 Confirm and category writes

Size: about 230 production lines, 230 test lines.

Depends on: T4, T17.

Files: `src/categories/store.mjs` (`setTransactionCategory`, `setMerchantRule`; `applyCategoryAnswer`
calls them), `src/api/ingest-handlers.mjs` (export `afterAnswer` when feat/account-dialog-edit has
not already), `src/tools/catalog/confirm-writes.mjs` (new: the five tools and receipt kinds
`category_correction` and `merchant_rule`), `test/tools-confirm-writes.test.mjs` (new).

Acceptance:

1. The five tools match their routes' store state for the same input; a Confirm category answer and
   `set_transaction_category` with the same input leave identical rows.
2. `undo_category_action` restores a correction and a merchant rule; `reopen_confirm_item` with
   the advertised ids reverts an answer, and `answer_confirm_item` with the advertised items
   re-applies it.
3. Existing category and Confirm tests pass unchanged.

Test command: `node --test test/tools-confirm-writes.test.mjs test/categories.test.mjs test/confirm-deck-web.test.mjs test/tools-parity.test.mjs`

Parallel: beside T18, T20 to T24, T26. Only ticket editing `src/api/ingest-handlers.mjs` and
`src/categories/store.mjs`.

Evals: `q60-merchant-rule-groceries`.

### T26 Imports and jobs

Size: about 190 production lines, 240 test lines.

Depends on: T4, T17.

Files: `src/tools/catalog/import-writes.mjs` (new: `import_file`, `retry_import`,
`build_your_plans`, `run_job`), `test/tools-import-writes.test.mjs` (new). The context wiring these
tools need (`ctx.services`) is T17's.

Acceptance:

1. Through an MCP request to `createMcpHandler` over a real store: `import_file` with a base64 CSV
   imports the same rows as the upload route; `run_job {id: 'freshness'}` runs through the
   scheduler; `build_your_plans` with the fake engine returns `status: 'built'` and writes the
   pack.
2. Through an Ask answer with the fake engine scripting the calls: `import_file` with pasted CSV
   text imports the same rows; `run_job` runs; `build_your_plans` returns `status: 'queued'` and
   the build has run once the answer returns.
3. Content over the limit is refused on both surfaces; a markdown note imports as the notes route
   does; `run_job` accepts only the four ids and refuses `plan` on a demo store.
4. The four tools return `undo.available: false` with a reason.

Test command: `node --test test/tools-import-writes.test.mjs test/tools-parity.test.mjs`

Parallel: beside T18, T20 to T25. Edits no shared file.

Evals: `q65-sync-now`.

### T27 Account writes

Size: about 210 production lines, 210 test lines.

Depends on: T4, T17, T25 (merge undo goes through `reopen_confirm_item`), feat/account-dialog-edit
merged.

Files: `src/accounts/write.mjs` (new), `src/api/accounts.mjs` (handlers call it),
`src/tools/catalog/account-writes.mjs` (new: the six tools and receipt kinds `account_field` and
`account_answer`), `test/tools-account-writes.test.mjs` (new).

Acceptance:

1. The five account writes and `list_merge_candidates` match their routes for the same input.
2. `undo_account_action` with `{ id: <receipt id> }` restores a rename, a mask, an owner and a
   kind (owner and kind through `undoAccountAnswer`).
3. `merge_accounts` without `confirm: true` or without evidence is refused on both surfaces; it is
   offered to Ask in chat and over MCP; `reopen_confirm_item {ids: [itemId]}` restores both
   accounts.

Test command: `node --test test/tools-account-writes.test.mjs test/account-rename.test.mjs test/merge-accounts-cli.test.mjs test/tools-parity.test.mjs`

Parallel: beside T18, T20 to T24, T26. Only ticket editing `src/api/accounts.mjs`.

Evals: `q59-change-account-owner`.

### T28 Model routing rules in the Ask prompt

Size: about 90 production lines of prompt text and code, 160 test lines.

Depends on: fix/ask-answer-quality merged, T5, T6, T14, T17 (serialized on
`src/api/answerer.mjs`), T18 (the definition rule replaces the prompt line that sends definitions
to `remember_preference`).

Files: `src/api/answerer.mjs` (static rules in `buildChatPrompt`, and the echo-rule fix if T5 left
a `todo`), `src/mcp/server.mjs` (server instructions), `test/answerer.test.mjs`,
`test/ask-rules.test.mjs` (new).

Acceptance:

1. The static prompt holds the section 4 rules and routing table, and no longer tells the model to
   store definitions with `remember_preference`; the tool list plus rules stay under 24 KB (a test
   measures it).
2. The T5 grounding test passes with no `todo`.
3. The MCP server instructions carry the same rules.

Test command: `node --test test/ask-rules.test.mjs test/answerer.test.mjs`

Parallel: beside any ticket that has merged its answerer edits; last in the `src/api/answerer.mjs`
chain.

Evals: flips the routing-sensitive cases in tier 2 (`npm run eval:ask:live`); tier 1 cases are
already green from their tool tickets.

## 8. Eval coverage

The Ask eval suite on feat/ask-evals runs cases with a question, follow-ups, required tool calls
with argument predicates, forbidden behavior (an unsourced figure, a self-computed figure),
expected figures computed at run time from the demo store, and a word budget. Tier 1 (`npm run
eval:ask`) runs in CI over scripted transcripts; tier 2 (`npm run eval:ask:live`) runs a live model
and never runs in CI. The branch has published no case names, so the IDs below are proposals, one
per question, `qNN-short-slug`, plus one cross-conversation case. T16 writes them. A case for a
tool not built yet is expected-fail naming the missing tool until its ticket lands, and that ticket
flips it. Every case forbids an unsourced figure, a self-computed figure, and an assumption with
source `owner` whose value does not appear in the owner's messages of that conversation.

| Case ID | Question | Required tools (key predicates) | Expected figures (deterministic call) | Ticket |
|---|---|---|---|---|
| q01-spend-excl-mortgage-tax | Q01 | `aggregate_transactions` measure spending, annualize true, exclude has debt_service or Mortgage, tax bucket excluded or absent, healthcare not excluded; exactly one call | the same call's `total` | T6 |
| q02-independence-target-4pct | Q02 | `independence_target` with spending ref to Q01 and withdrawalRate 0.04 source owner | that call's `target` | T14 |
| q03-gap-and-date | Q03 | `independence_target` same args | `gap`, `projectedDate` | T14 |
| q04-groceries-dining-monthly | Q04 | `aggregate_transactions` include categories groceries and dining, groupBy month | the call's groups | T6 |
| q05-essential-vs-discretionary | Q05 | two `aggregate_transactions` calls, definition essential and definition discretionary | each call's `total`; the answer states both totals and no number that is their sum or difference unless a `calculate` call returned it | T6 |
| q06-top-merchants | Q06 | `aggregate_transactions` groupBy merchant, limit 10 | the ten groups | T6 |
| q07-childcare-2025 | Q07 | `aggregate_transactions` calendar_year 2025, include class childcare | `total` | T6 |
| q08-healthcare-premiums | Q08 | `aggregate_transactions` include class healthcare | `total`; answer mentions the outside-ledger gap | T6 |
| q09-elective-definition | Q09 | `aggregate_transactions` with definition elective_spending | `total` | T18 |
| q09b-elective-definition-later-thread | Q09 asked in a new thread after Q10 was saved in an earlier one (the fixture saves the definition, then opens a fresh conversation) | `aggregate_transactions` with definition elective_spending; no `save_spending_definition` call | `total` | T18 |
| q10-save-elective-definition | Q10 | `save_spending_definition` exclude classes housing, debt_service, childcare, healthcare, taxes; no `remember_preference` call | receipt present; linked preference names the definition | T18 |
| q11-monthly-net-cash-flow | Q11 | `cash_flow` scope all | monthly nets | T13 |
| q12-business-to-personal | Q12 | `cash_flow` | `totals.transfersBusinessToHousehold` | T13 |
| q13-negative-months | Q13 | `cash_flow` scope household | months with negative net | T13 |
| q14-savings-rate | Q14 | two aggregates trailing_12, `calculate` divide | the calculate figure | T5 |
| q15-income-by-source | Q15 | `aggregate_transactions` measure income groupBy merchant; `business_pnl` | groups, revenue | T6 |
| q16-monthly-take-home | Q16 | `aggregate_transactions` measure income trailing_12 | `perMonth` | T6 |
| q17-business-profit-margin | Q17 | `business_pnl` ytd | profit, margin | T8 |
| q18-revenue-vs-last-year | Q18 | `business_pnl` compareToPriorYear true | `revenue`, `prior.revenue`, `prior.revenueDifference`, `prior.revenueRatio` | T8 |
| q19-expense-categories-quarter | Q19 | `business_pnl` custom quarter, groupBy category | groups | T8 |
| q20-net-worth-parts | Q20 | `net_worth` groupBy part | total, parts | T7 |
| q21-net-worth-change | Q21 | `net_worth` series, `calculate` subtract | the calculate figure | T5 |
| q22-retirement-vs-taxable | Q22 | `net_worth` groupBy treatment | groups | T7 |
| q23-ten-year-growth | Q23 | `project_growth` solve balance, years 10 | the figure | T14 |
| q24-monthly-to-target-by-55 | Q24 | `independence_target`, `project_growth` solve monthly byAge 55 | the figure | T14 |
| q25-return-3pct-whatif | Q25 | `independence_target` realReturn 0.03 source owner | months, date | T14 |
| q26-withdrawal-35pct | Q26 | `independence_target` withdrawalRate 0.035 | target | T14 |
| q27-extra-1000-sooner | Q27 | two `independence_target` calls, `calculate` subtract | the calculate figure | T14 |
| q28-15m-retirement-vs-brokerage | Q28 | `after_tax_value` hypothetical pretax and taxable with owner evidence, rate refs, no `basis` argument | pre-tax `afterTax`; taxable `afterTax` unavailable with `no_cost_basis`; the answer asks for the basis and states no taxable after-tax number | T15 |
| q29-penalty-free-access | Q29 | `access_schedule` both | milestones | T21 |
| q30-rmd-start | Q30 | `access_schedule` | rmd_start milestones | T21 |
| q31-bridge-to-59-half | Q31 | `bridge_check` retireAge 50 source owner | shortfall or surplus | T21 |
| q32-accounts-by-treatment | Q32 | `net_worth` groupBy treatment | groups | T7 |
| q33-unrealized-gains-tax | Q33 | `tax_estimate`, `after_tax_value` taxable kinds with rate refs | unrealizedGain, taxOnWithdrawal | T15 |
| q34-tax-owed | Q34 | `tax_estimate` | federal and state projected | T10 |
| q35-safe-harbor | Q35 | `tax_estimate` | safeHarbor fields | T10 |
| q36-extra-income-whatif | Q36 | `tax_estimate` whatIf extraIncome 20000 source owner | `whatIf.totalDelta` | T10 |
| q37-se-tax | Q37 | `tax_estimate` | `federal.selfEmployment` | T10 |
| q38-solo401k-room | Q38 | `contribution_room` owner, solo 401(k) types | remaining per type | T9 |
| q39-ira-room | Q39 | `contribution_room` IRA types | remaining | T9 |
| q40-hsa-room | Q40 | `contribution_room` hsa | remaining | T9 |
| q41-529-contributions | Q41 | `aggregate_transactions` inflow to 529 accounts; `contribution_room` plan529_state_deduction | total, deductible | T6 |
| q42-dependent-care-limit | Q42 | `contribution_room` dependent_care | limit; gap mentioned | T9 |
| q43-goal-pace | Q43 | `get_pace` | pace per goal | T16 |
| q44-cash-cushion-months | Q44 | `net_worth`, `aggregate_transactions`, `calculate` divide | months figure | T5 |
| q45-subscriptions-annual | Q45 | `recurring_charges` active | annual costs, total | T12 |
| q46-new-recurring | Q46 | `recurring_charges` status new | charges | T12 |
| q47-stopped-or-changed | Q47 | `recurring_charges` status all, since | stopped and changed | T12 |
| q48-this-year-vs-last | Q48 | `compare_periods` matching months, groupBy category | difference, group deltas | T13 |
| q49-summer-vs-summer | Q49 | `compare_periods` June to August both years | difference | T13 |
| q50-dining-trend | Q50 | `compare_periods` include dining | ratio | T13 |
| q51-spending-after-mortgage | Q51 | `spending_projection` obligations mortgage | year rows; with no mortgage fact in the demo store, the change is unavailable and the answer names the missing fact | T20 |
| q52-spending-after-childcare | Q52 | `spending_projection` obligations childcare | year rows; changes without a stated amount reported as not applied | T20 |
| q53-mortgage-end | Q53 | `obligation_schedule` mortgage | endDate, monthly | T20 |
| q54-childcare-changes | Q54 | `obligation_schedule` childcare | change dates | T20 |
| q55-529-end | Q55 | `obligation_schedule` plan529 | endDate | T20 |
| q56-stale-accounts | Q56 | `data_health` | stale accounts | T11 |
| q57-uncategorized-count | Q57 | `data_health` | category counts | T11 |
| q58-no-history-accounts | Q58 | `data_health` | accounts with empty lastData | T11 |
| q59-change-account-owner | Q59 | `list_accounts`, `set_account_owner` owner owner | receipt; `undo` is `undo_account_action` with the receipt id | T27 |
| q60-merchant-rule-groceries | Q60 | `query_transactions`, `set_merchant_rule` category Groceries | affected count | T25 |
| q61-mark-1099-not-needed | Q61 | `mark_yearend_item` reason from the owner's words | receipt | T24 |
| q62-decide-salary-option | Q62 | `list_recommendations`, `decide_decision` | receipt | T22 |
| q63-archive-goal | Q63 | `list_goals`, `archive_goal` | receipt | T23 |
| q64-send-to-advisor | Q64 | `send_to_advisor` | reviewId | T24 |
| q65-sync-now | Q65 | `run_job` id simplefin-sync | run status | T26 |
| q66-security-pick-refused | Q66 | none; forbids any security name | none; answer says Fathom does not have that | T16 |
| q67-market-quote-refused | Q67 | none; forbids any index level | none | T16 |
| q68-money-movement-refused | Q68 | no write tool | none | T16 |
