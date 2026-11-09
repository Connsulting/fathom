// Synthetic scenario for the Fathom design mock. Invented demo data, copied from the demo
// scenario by tools/sync-scenario.mjs. Do not edit by hand; edit demo/scenario.mjs and re-run it.
window.FATHOM_SCENARIO = {
  "meta": {
    "product": "Fathom",
    "clock": "2026-11-05",
    "clockLabel": "Thu, Nov 5, 2026",
    "dataThrough": "Aug 30, 2026",
    "household": "Morgan and Riley"
  },
  "names": {
    "me": "Morgan",
    "spouse": "Riley",
    "kid": "Nora",
    "kid2": "Eli",
    "biz": "Copperleaf Studio",
    "spouseBiz": "Bluestem Veterinary Relief",
    "w2": "Lakeview School of Design",
    "bank": "Lakeshore Credit Union",
    "broker": "Ridgeline Investments",
    "payroll": "Tally Payroll",
    "hsa": "Pinecrest HSA",
    "advisor": "Jordan Ellis, CFP",
    "specialist": "Marcus Webb, EA"
  },
  "law": {
    "deferral": 24500,
    "dc415": 72000,
    "hsa_family": 8750,
    "qbi_threshold": 403500,
    "qbi_range": 150000,
    "ira_limit": 7500,
    "va529_deduction": 20000,
    "dcfsa": 7500,
    "std_ded": 32200,
    "salt_cap": 40000,
    "ss_base": 184500
  },
  "pct": {
    "phase_in": 22,
    "marginal": 37,
    "va_rate": 4.95,
    "fed_bracket": 32,
    "deduction_rate": 37,
    "comp_ratio": 33,
    "employer_share": 25
  },
  "src": {
    "biz": {
      "label": "Lakeshore Credit Union business checking, mirrored read-only",
      "asOf": "Aug 30, 2026"
    },
    "personal": {
      "label": "Lakeshore Credit Union joint checking, mirrored read-only",
      "asOf": "Aug 30, 2026"
    },
    "broker": {
      "label": "Ridgeline Investments positions, mirrored read-only",
      "asOf": "Aug 7, 2026"
    },
    "payroll": {
      "label": "Tally Payroll runs, mirrored read-only",
      "asOf": "Aug 27, 2026"
    },
    "txns": {
      "label": "Household transactions, mirrored read-only",
      "asOf": "Aug 30, 2026"
    },
    "plan": {
      "label": "Plan of record, revision 6",
      "asOf": "Aug 20, 2026"
    },
    "ret2025": {
      "label": "2025 filed return",
      "asOf": "May 2026"
    },
    "model": {
      "label": "Fathom model run on your plan",
      "asOf": "Nov 5, 2026"
    },
    "you": {
      "label": "You told us",
      "asOf": "Nov 4, 2026"
    }
  },
  "fig": {
    "biz_cash": {
      "v": 21500,
      "src": "biz",
      "kind": "a",
      "label": "Business checking balance"
    },
    "personal_cash": {
      "v": 14800,
      "src": "personal",
      "kind": "a",
      "label": "Joint checking balance"
    },
    "sp_cash": {
      "v": 9400,
      "src": "you",
      "kind": "e",
      "label": "Riley checking, unverified"
    },
    "reserve.actual": {
      "v": 96000,
      "src": "personal",
      "kind": "a",
      "label": "Synthetic cash reserve snapshot",
      "asOf": "2026-08-30",
      "cadenceKind": "balances"
    },
    "portfolio": {
      "asOf": "2026-08-07",
      "cadenceKind": "brokerage_positions",
      "v": 1240000,
      "src": "broker",
      "kind": "a",
      "label": "Brokerage and retirement total"
    },
    "my_port": {
      "v": 705000,
      "src": "broker",
      "kind": "a",
      "label": "Morgan accounts"
    },
    "sp_port": {
      "v": 535000,
      "src": "broker",
      "kind": "a",
      "label": "Riley accounts"
    },
    "taxable": {
      "v": 332000,
      "src": "broker",
      "kind": "a",
      "label": "Taxable accounts"
    },
    "my_pretax": {
      "v": 310000,
      "src": "broker",
      "kind": "a",
      "label": "Morgan pre-tax IRA balance (pro-rata)"
    },
    "sp_pretax": {
      "v": 395000,
      "src": "broker",
      "kind": "a",
      "label": "Riley pre-tax IRA balance (pro-rata)"
    },
    "my_tod": {
      "v": 260000,
      "src": "broker",
      "kind": "a",
      "label": "Morgan individual account"
    },
    "my_rollover": {
      "v": 310000,
      "src": "broker",
      "kind": "a",
      "label": "Morgan rollover IRA"
    },
    "my_roth": {
      "v": 135000,
      "src": "broker",
      "kind": "a",
      "label": "Morgan Roth IRA"
    },
    "sp_sep_ira": {
      "v": 395000,
      "src": "broker",
      "kind": "a",
      "label": "Riley SEP-IRA"
    },
    "sp_roth": {
      "v": 68000,
      "src": "broker",
      "kind": "a",
      "label": "Riley Roth IRA"
    },
    "sp_tod": {
      "v": 72000,
      "src": "broker",
      "kind": "a",
      "label": "Riley direct-index account"
    },
    "plan529": {
      "v": 38000,
      "src": "broker",
      "kind": "a",
      "label": "529 balance"
    },
    "home_equity": {
      "v": 420000,
      "src": "plan",
      "kind": "e",
      "label": "Home equity"
    },
    "net_worth": {
      "v": 1780000,
      "src": "plan",
      "kind": "e",
      "label": "Net worth, approximate"
    },
    "baseline": {
      "v": 32000,
      "src": "plan",
      "kind": "a",
      "label": "Monthly billing baseline after the retainer"
    },
    "prior_baseline": {
      "v": 24000,
      "src": "plan",
      "kind": "a",
      "label": "Monthly baseline before the retainer"
    },
    "my_gross": {
      "v": 336000,
      "src": "plan",
      "kind": "p",
      "label": "Business gross, full year"
    },
    "household_eac": {
      "v": 598000,
      "src": "plan",
      "kind": "p",
      "label": "Household revenue, full year"
    },
    "revenue_ytd": {
      "v": 341000,
      "src": "txns",
      "kind": "a",
      "label": "Household revenue Jan to Jul"
    },
    "run_rate": {
      "v": 612000,
      "src": "plan",
      "kind": "e",
      "label": "Household run rate"
    },
    "floor_income": {
      "v": 290000,
      "src": "plan",
      "kind": "e",
      "label": "Household income floor"
    },
    "ti_pre_qbi": {
      "v": 436500,
      "src": "model",
      "kind": "m",
      "label": "Taxable income before QBI, 2026"
    },
    "qbi_total": {
      "v": 66000,
      "src": "model",
      "kind": "m",
      "label": "Household QBI deduction, 2026"
    },
    "sp_qbi_lost": {
      "v": 8600,
      "src": "model",
      "kind": "m",
      "label": "Riley QBI deduction lost to the phase-in"
    },
    "sp_qbi_tax": {
      "v": 2750,
      "src": "model",
      "kind": "m",
      "label": "Tax cost of the phase-in"
    },
    "liability": {
      "v": 128500,
      "src": "plan",
      "kind": "e",
      "label": "2026 federal and Illinois liability"
    },
    "safe_harbor": {
      "v": 110600,
      "src": "plan",
      "kind": "m",
      "label": "Safe harbor total"
    },
    "fed_safe": {
      "v": 88000,
      "src": "plan",
      "kind": "m",
      "label": "Federal safe harbor (110% of 2025)"
    },
    "va_safe": {
      "v": 22600,
      "src": "plan",
      "kind": "m",
      "label": "Illinois safe harbor (100% of 2025)"
    },
    "fed_paid": {
      "v": 66000,
      "src": "personal",
      "kind": "a",
      "label": "Federal credited so far"
    },
    "va_paid": {
      "v": 16950,
      "src": "personal",
      "kind": "a",
      "label": "Illinois credited so far"
    },
    "q3_fed": {
      "v": 22000,
      "src": "personal",
      "kind": "a",
      "label": "Federal Q3 payment, Aug 21"
    },
    "q3_va": {
      "v": 5650,
      "src": "personal",
      "kind": "a",
      "label": "Illinois Q3 payment, Aug 25"
    },
    "jan_est": {
      "v": 22000,
      "src": "plan",
      "kind": "e",
      "label": "Jan 15 estimate"
    },
    "april_due": {
      "v": 17900,
      "src": "plan",
      "kind": "e",
      "label": "Balance due Apr 2027"
    },
    "salt_2025": {
      "v": 35500,
      "src": "ret2025",
      "kind": "a",
      "label": "SALT deducted on 2025 return"
    },
    "salary": {
      "v": 110000,
      "src": "plan",
      "kind": "a",
      "label": "2026 salary target"
    },
    "ytd_wages": {
      "v": 65000,
      "src": "payroll",
      "kind": "p",
      "label": "W-2 wages paid so far (ten runs)"
    },
    "offcycle_gross": {
      "v": 32000,
      "src": "plan",
      "kind": "p",
      "label": "Off-cycle run gross"
    },
    "offcycle_cash": {
      "v": 34400,
      "src": "model",
      "kind": "m",
      "label": "Business cash the off-cycle run needs"
    },
    "regular_run": {
      "v": 7000,
      "src": "model",
      "kind": "m",
      "label": "Business cash per regular run"
    },
    "dec_need": {
      "v": 41400,
      "src": "model",
      "kind": "m",
      "label": "December payroll cash needed"
    },
    "extra_payroll_tax": {
      "v": 4900,
      "src": "plan",
      "kind": "e",
      "label": "Payroll tax on the catch-up wages"
    },
    "offcycle_tax_deferred": {
      "v": 9050,
      "src": "model",
      "kind": "m",
      "label": "Tax deferred by the deferral"
    },
    "biz_cash_now": {
      "v": 29000,
      "src": "model",
      "kind": "p",
      "label": "Business checking, projected today"
    },
    "biz_cash_dec": {
      "v": 58000,
      "src": "model",
      "kind": "p",
      "label": "Business cash Dec 10, invoices sent"
    },
    "biz_cash_dec_defer": {
      "v": 32000,
      "src": "model",
      "kind": "p",
      "label": "Business cash Dec 10, invoices deferred"
    },
    "dec_short": {
      "v": 9400,
      "src": "model",
      "kind": "m",
      "label": "December shortfall if deferred and distributed"
    },
    "nov_distribution": {
      "v": 11000,
      "src": "model",
      "kind": "p",
      "label": "Usual monthly distribution"
    },
    "distributions_ytd": {
      "v": 84000,
      "src": "biz",
      "kind": "a",
      "label": "Business to personal transfers, Jan to Aug"
    },
    "fixed_fee": {
      "v": 26000,
      "src": "you",
      "kind": "e",
      "label": "Delivered fixed-fee work, not invoiced"
    },
    "defer_2026": {
      "v": 9600,
      "src": "model",
      "kind": "m",
      "label": "2026 tax saved by deferring"
    },
    "defer_2027": {
      "v": 7500,
      "src": "model",
      "kind": "m",
      "label": "2027 tax added by deferring"
    },
    "defer_net": {
      "v": 2100,
      "src": "model",
      "kind": "m",
      "label": "Net saved across both years"
    },
    "hsa_paid": {
      "v": 4500,
      "src": "txns",
      "kind": "a",
      "label": "HSA contributed this year"
    },
    "hsa_left": {
      "v": 4250,
      "src": "model",
      "kind": "m",
      "label": "HSA room left"
    },
    "sp_sep": {
      "v": 44000,
      "src": "plan",
      "kind": "e",
      "label": "Riley SEP, estimated maximum"
    },
    "sp_k1": {
      "v": 238000,
      "src": "plan",
      "kind": "e",
      "label": "Riley Schedule C net, estimate"
    },
    "ret_room_now": {
      "v": 52000,
      "src": "model",
      "kind": "m",
      "label": "Your Solo 401(k) room at current salary"
    },
    "childcare_yr": {
      "v": 11400,
      "src": "txns",
      "kind": "a",
      "label": "Childcare paid, last 12 months"
    },
    "w2_wages": {
      "v": 11000,
      "src": "ret2025",
      "kind": "a",
      "label": "Your W-2 wages there, 2025"
    },
    "childcare_mo": {
      "v": 950,
      "src": "txns",
      "kind": "a",
      "label": "Childcare per month"
    },
    "dcfsa_save": {
      "v": 3350,
      "src": "model",
      "kind": "m",
      "label": "Tax saved by a full DCFSA"
    },
    "va529_save": {
      "v": 990,
      "src": "model",
      "kind": "m",
      "label": "Illinois tax saved at the full deduction"
    },
    "vaq4_amt": {
      "v": 5650,
      "src": "plan",
      "kind": "e",
      "label": "Illinois Q4 estimate"
    },
    "vaq4_save": {
      "v": 450,
      "src": "model",
      "kind": "m",
      "label": "Federal tax saved by paying in December"
    },
    "reserve_target": {
      "v": 135000,
      "src": "plan",
      "kind": "e",
      "label": "Nine months of cash"
    },
    "yearend_cash": {
      "v": 136000,
      "src": "plan",
      "kind": "p",
      "label": "Year-end cash, projected"
    },
    "true_reserve": {
      "v": 96000,
      "src": "plan",
      "kind": "p",
      "label": "Reserve after tax earmarks"
    },
    "travel_yr": {
      "v": 14000,
      "src": "plan",
      "kind": "e",
      "label": "Two family trips per year"
    },
    "umbrella_lo": {
      "v": 380,
      "src": "plan",
      "kind": "e",
      "label": "Umbrella premium, low"
    },
    "umbrella_hi": {
      "v": 640,
      "src": "plan",
      "kind": "e",
      "label": "Umbrella premium, high"
    },
    "conc_gain": {
      "v": 88000,
      "src": "broker",
      "kind": "a",
      "label": "Embedded gain in the largest position"
    },
    "conc_trim_tax": {
      "v": 10400,
      "src": "model",
      "kind": "m",
      "label": "Tax on a partial trim this year"
    },
    "scorp_save_full": {
      "v": 11500,
      "src": "model",
      "kind": "e",
      "label": "S corp savings, full working year"
    },
    "scorp_save_leave": {
      "v": 5200,
      "src": "model",
      "kind": "e",
      "label": "S corp savings, sabbatical year"
    },
    "review_lo": {
      "v": 1500,
      "src": "plan",
      "kind": "e",
      "label": "Review-only CPA hours, low"
    },
    "review_hi": {
      "v": 3000,
      "src": "plan",
      "kind": "e",
      "label": "Review-only CPA hours, high"
    },
    "cpa_full": {
      "v": 9000,
      "src": "plan",
      "kind": "e",
      "label": "Full advisory relationship"
    },
    "port_3m": {
      "v": 2000000,
      "src": "plan",
      "kind": "e",
      "label": "Work-optional milestone"
    },
    "port_4m": {
      "v": 3000000,
      "src": "plan",
      "kind": "e",
      "label": "Zero-income-required milestone"
    },
    "mortgage_paid": {
      "v": 46000,
      "src": "plan",
      "kind": "a",
      "label": "HELOC payments in 2026"
    },
    "salary_alt_cost": {
      "v": 1900,
      "src": "model",
      "kind": "m",
      "label": "Extra tax at a higher salary"
    },
    "sep_cost": {
      "v": 6800,
      "src": "model",
      "kind": "m",
      "label": "Extra tax on the SEP path"
    },
    "life_ins_gap": {
      "v": 1500000,
      "src": "model",
      "kind": "e",
      "label": "Rough coverage gap for two kids through college"
    }
  },
  "series": {
    "biz_receipts": {
      "label": "Business receipts by month",
      "unit": "$",
      "points": [
        {
          "x": "Mar",
          "v": 24000,
          "kind": "a"
        },
        {
          "x": "Apr",
          "v": 26500,
          "kind": "a"
        },
        {
          "x": "May",
          "v": 22000,
          "kind": "a"
        },
        {
          "x": "Jun",
          "v": 28500,
          "kind": "a"
        },
        {
          "x": "Jul",
          "v": 25000,
          "kind": "a"
        },
        {
          "x": "Aug",
          "v": 33500,
          "kind": "a"
        },
        {
          "x": "Sep",
          "v": 32000,
          "kind": "p"
        },
        {
          "x": "Oct",
          "v": 32000,
          "kind": "p"
        },
        {
          "x": "Nov",
          "v": 32000,
          "kind": "p"
        },
        {
          "x": "Dec",
          "v": 32000,
          "kind": "p"
        }
      ]
    },
    "personal_cash": {
      "label": "Joint checking, month end",
      "unit": "$",
      "points": [
        {
          "x": "Jan",
          "v": 31000,
          "kind": "a"
        },
        {
          "x": "Feb",
          "v": 24500,
          "kind": "a"
        },
        {
          "x": "Mar",
          "v": 19000,
          "kind": "a"
        },
        {
          "x": "Apr",
          "v": 12500,
          "kind": "a"
        },
        {
          "x": "May",
          "v": 21000,
          "kind": "a"
        },
        {
          "x": "Jun",
          "v": 17500,
          "kind": "a"
        },
        {
          "x": "Jul",
          "v": 23000,
          "kind": "a"
        },
        {
          "x": "Aug",
          "v": 14800,
          "kind": "a"
        }
      ]
    },
    "biz_cash": {
      "label": "Business checking, month end",
      "unit": "$",
      "points": [
        {
          "x": "Mar",
          "v": 9000,
          "kind": "a"
        },
        {
          "x": "Apr",
          "v": 12000,
          "kind": "a"
        },
        {
          "x": "May",
          "v": 8500,
          "kind": "a"
        },
        {
          "x": "Jun",
          "v": 15500,
          "kind": "a"
        },
        {
          "x": "Jul",
          "v": 11000,
          "kind": "a"
        },
        {
          "x": "Aug",
          "v": 21500,
          "kind": "a"
        },
        {
          "x": "Sep",
          "v": 24000,
          "kind": "p"
        },
        {
          "x": "Oct",
          "v": 29000,
          "kind": "p"
        }
      ]
    }
  },
  "verdict": {
    "attention": {
      "headline": "Before the year closes: {count} for you to decide.",
      "sub": "Everything else is watched and on schedule. Nothing is late."
    },
    "clear": {
      "headline": "You are covered through December.",
      "sub": "Next thing that needs you is the Jan 15 estimate. We will tell you in January. Go do something else."
    }
  },
  "domains": [
    {
      "id": "tax",
      "name": "Estimated tax",
      "status": "covered",
      "watching": "Safe harbor: {f:fed_paid} of {f:fed_safe} federal and {f:va_paid} of {f:va_safe} Illinois credited.",
      "note": "Jan 15 payment of {f:jan_est} is reserved. April balance of {f:april_due} is reserved."
    },
    {
      "id": "payroll",
      "name": "Payroll and owner pay",
      "status": "needs",
      "watching": "Salary target {f:salary}, wages paid {f:ytd_wages}, reasonable-comp position.",
      "note": "The off-cycle run carrying your {l:deferral} deferral is not scheduled yet."
    },
    {
      "id": "cash",
      "name": "Cash and reserves",
      "status": "needs",
      "watching": "Business cash against payroll, personal reserve against the {f:reserve_target} target.",
      "note": "December business cash is tight if the fixed-fee invoices slip and the distribution goes out."
    },
    {
      "id": "retire",
      "name": "Retirement room",
      "status": "changed",
      "watching": "Solo 401(k), SEP, HSA, IRA pro-rata balances.",
      "note": "{f:ret_room_now} of room for you this year. {n:spouse}’s SEP waits on her year-end books."
    },
    {
      "id": "family",
      "name": "Family and household",
      "status": "needs",
      "watching": "Two kids, after-school care, insurance, 529s, life events you tell us about.",
      "note": "{n:spouse}’s sabbatical starts in January. Open enrollment is the first window that matters."
    },
    {
      "id": "entities",
      "name": "Entities and filings",
      "status": "waiting",
      "watching": "{n:biz} S corp filings, {n:spouseBiz} Schedule C, who files what.",
      "note": "Your CPA retired in August. Filing plan is with your advisor for the Dec 10 check-in."
    },
    {
      "id": "invest",
      "name": "Investments, tax view",
      "status": "covered",
      "watching": "Realized gains, wash sales, concentrated lots. No trading advice.",
      "note": "No gains realized this year. {f:conc_gain} embedded gain held to 2027."
    }
  ],
  "events": [
    {
      "date": "Nov 4",
      "kind": "life",
      "title": "You told us: {n:spouse}’s sabbatical runs January to March",
      "body": "Her relief income pauses for three months. We re-ran cash for Q1 2027 and opened three items."
    },
    {
      "date": "Nov 4",
      "kind": "income",
      "title": "Fixed-fee design work delivered, not invoiced",
      "body": "About {f:fixed_fee} for a finished design phase you can bill now or in January. Cash basis, so the timing is your call."
    },
    {
      "date": "Oct 30",
      "kind": "income",
      "title": "Retainer held a third month",
      "body": "Billing is tracking {f:baseline} a month. Full year now projects to {f:my_gross}."
    },
    {
      "date": "Aug 25",
      "kind": "calendar",
      "title": "Q3 estimates paid early",
      "body": "{f:q3_fed} federal on Aug 21 and {f:q3_va} Illinois on Aug 25. Matched in the mirror."
    },
    {
      "date": "Aug 12",
      "kind": "income",
      "title": "Developer retainer raised your baseline",
      "body": "From {f:prior_baseline} to {f:baseline} a month. Taxable income now crosses the QBI threshold of {l:qbi_threshold}, {p:phase_in} into the phase-in."
    },
    {
      "date": "Jun 19",
      "kind": "milestone",
      "title": "Studio HELOC paid off",
      "body": "Five months ahead of plan. Business cash now only has to cover payroll, taxes and distributions."
    }
  ],
  "deadlines": [
    {
      "date": "2026-11-20",
      "label": "Nov 20",
      "title": "Open enrollment closes (assumed)",
      "recId": "dcfsa",
      "hard": true
    },
    {
      "date": "2026-12-01",
      "label": "Dec 1",
      "title": "Decide on fixed-fee invoicing",
      "recId": "deferral",
      "hard": false
    },
    {
      "date": "2026-12-01",
      "label": "Dec 1",
      "title": "Schedule the off-cycle payroll run",
      "recId": "offcycle",
      "hard": false
    },
    {
      "date": "2026-12-10",
      "label": "Dec 10",
      "title": "Quarterly check-in with your advisor",
      "hard": false
    },
    {
      "date": "2026-12-15",
      "label": "Dec 15",
      "title": "Illinois Q4 payment, paid early for 2026",
      "recId": "vaq4",
      "hard": false
    },
    {
      "date": "2026-12-31",
      "label": "Dec 31",
      "title": "401(k) deferral, 529 deduction, umbrella policy",
      "recId": "offcycle",
      "hard": true
    },
    {
      "date": "2027-01-15",
      "label": "Jan 15",
      "title": "Q4 estimated tax",
      "recId": "reserve",
      "hard": true
    },
    {
      "date": "2027-01-31",
      "label": "Jan 31",
      "title": "Filing plan decided; W-2s out",
      "recId": "filingplan",
      "hard": false
    },
    {
      "date": "2027-03-15",
      "label": "Mar 15",
      "title": "1120-S due; S election window for 2027",
      "recId": "spouseentity",
      "hard": true
    },
    {
      "date": "2027-04-15",
      "label": "Apr 15",
      "title": "Returns, HSA and IRA contributions, balance due",
      "recId": "hsa",
      "hard": true
    }
  ],
  "recs": [
    {
      "id": "offcycle",
      "goalKinds": [
        "retirement",
        "tax"
      ],
      "owner": "you",
      "title": "Run the off-cycle payroll that carries your 401(k) deferral",
      "summary": "Your {l:deferral} Solo 401(k) deferral can only come out of W-2 wages paid by Dec 31, and none of it has been withheld yet.",
      "trigger": "calendar",
      "triggerText": "Hard deadline: Dec 31",
      "domain": "payroll",
      "window": {
        "label": "Schedule by Dec 1",
        "days": 26
      },
      "effort": "15 min",
      "status": "doing",
      "statusByDemo": {
        "first": "proposed"
      },
      "advisor": {
        "verdict": "confirmed",
        "note": "Agree. Regular method, not supplemental. Confirm the plan custodian deposit lands in December."
      },
      "value": [
        {
          "cls": "retire",
          "text": "{l:deferral} of pre-tax retirement room"
        },
        {
          "cls": "timing",
          "text": "About {f:offcycle_tax_deferred} of tax deferred"
        },
        {
          "cls": "risk",
          "text": "Cures earlier-quarter underpayment through withholding"
        }
      ],
      "why": [
        "This is the only item in your plan with a hard Dec 31 deadline. Employer contributions can wait until the extended filing date; your employee deferral cannot.",
        "One off-cycle run of {f:offcycle_gross} gets you to the {f:salary} salary target and carries the whole deferral, so December has nothing to scramble for."
      ],
      "mine": [
        {
          "label": "Wages paid so far",
          "fig": "ytd_wages"
        },
        {
          "label": "Off-cycle gross",
          "fig": "offcycle_gross"
        },
        {
          "label": "Business cash the run needs",
          "fig": "offcycle_cash"
        },
        {
          "label": "Business checking, projected today",
          "fig": "biz_cash_now"
        }
      ],
      "kb": [
        {
          "pack": "scorp",
          "title": "Owner deferrals ride on W-2 wages",
          "cite": "IRS Pub 560; partner pack note, Oct 2026",
          "body": "For an S corp owner, elective deferrals must be withheld from wages actually paid in the plan year. Run it as a regular payroll so withholding annualizes; withholding is treated as paid evenly across the year."
        }
      ],
      "cross": [
        "Needs {f:offcycle_cash} in business checking on run day. Deferring the fixed-fee invoices and taking the usual distribution would leave you short.",
        "Withholding from this run reduces the Jan 15 estimate dollar for dollar."
      ],
      "tasks": [
        {
          "t": "Set deferral to zero on the regular monthly runs",
          "done": true
        },
        {
          "t": "Confirm business cash covers the run on Dec 10",
          "done": false
        },
        {
          "t": "Create the off-cycle run in {n:payroll} using the regular method",
          "done": false
        },
        {
          "t": "Enter the deferral as a fixed {l:deferral}",
          "done": false
        },
        {
          "t": "Confirm the deposit reaches the Solo 401(k)",
          "done": false
        }
      ],
      "qa": [
        {
          "q": "Why one run instead of spreading it?",
          "a": [
            "The deferral is the only piece with a hard Dec 31 deadline. Putting it in one run while the cash is there removes the risk entirely and lands the salary target without a December scramble."
          ]
        },
        {
          "q": "Supplemental or regular method?",
          "a": [
            "Regular. Supplemental withholds a flat rate; regular annualizes the period and withholds more, which you want because withholding counts as paid evenly across all four quarters."
          ]
        },
        {
          "q": "What if business cash is short?",
          "a": [
            "Skip or shrink the November distribution first. Payroll is a poor way to move cash to the personal side anyway; distributions are the right pipe once the run clears."
          ]
        }
      ]
    },
    {
      "id": "deferral",
      "goalKinds": [
        "tax",
        "cash"
      ],
      "owner": "you",
      "title": "Decide how much fixed-fee work to invoice before January",
      "summary": "Billing {f:fixed_fee} in January instead of December saves about {f:defer_net} across two years and moves cash into the sabbatical months, but it squeezes December payroll cash.",
      "trigger": "life",
      "triggerText": "Life event: sabbatical in early 2027",
      "domain": "cash",
      "window": {
        "label": "Decide by Dec 1",
        "days": 26
      },
      "effort": "10 min",
      "scenario": "deferral",
      "status": "proposed",
      "advisor": {
        "verdict": "pending",
        "note": "On the Dec 10 agenda. Watch constructive receipt."
      },
      "value": [
        {
          "cls": "tax",
          "text": "About {f:defer_net} net across 2026 and 2027"
        },
        {
          "cls": "cash",
          "text": "{f:fixed_fee} arrives during the sabbatical"
        }
      ],
      "why": [
        "You are {p:phase_in} into the QBI phase-in this year, so the last dollars of 2026 income cost more than the first dollars of 2027 will, especially with {n:spouse}’s relief income paused for three months.",
        "The bigger reason is cash: income lands when household income dips, not when it peaks."
      ],
      "mine": [
        {
          "label": "Delivered, not invoiced",
          "fig": "fixed_fee"
        },
        {
          "label": "2026 tax saved",
          "fig": "defer_2026"
        },
        {
          "label": "2027 tax added",
          "fig": "defer_2027"
        },
        {
          "label": "Business cash Dec 10 if deferred",
          "fig": "biz_cash_dec_defer"
        },
        {
          "label": "December payroll need",
          "fig": "dec_need"
        }
      ],
      "kb": [
        {
          "pack": "selfemp",
          "title": "Cash basis and constructive receipt",
          "cite": "IRS Pub 538; partner pack note",
          "body": "On the cash method, income counts when received or made available to you. Delaying an invoice is fine. Holding a check you already have, or telling a client not to pay a payable invoice, is not."
        },
        {
          "pack": "scorp",
          "title": "Distributions are not payroll",
          "cite": "Partner pack note",
          "body": "Distributions move cash without payroll tax, but they compete with payroll for the same business dollars. Sequence payroll first in a tight month."
        }
      ],
      "cross": [
        "If deferred and the usual {f:nov_distribution} distribution goes out, December payroll is short by about {f:dec_short}.",
        "Lower 2026 income also shrinks the QBI phase-in on {n:spouse}’s side."
      ],
      "tasks": [
        {
          "t": "Pick an amount in the war game",
          "done": false
        },
        {
          "t": "Tell the client your invoice date",
          "done": false
        },
        {
          "t": "Hold or shrink the November distribution if deferring",
          "done": false
        }
      ],
      "qa": [
        {
          "q": "Is this legal?",
          "a": [
            "Yes, on the cash method, as long as you are delaying the invoice and not refusing money that is already available to you."
          ]
        },
        {
          "q": "What is the catch?",
          "a": [
            "December payroll cash. Run the off-cycle payroll before any distribution, or skip the November distribution."
          ]
        }
      ]
    },
    {
      "id": "dcfsa",
      "goalKinds": [
        "tax"
      ],
      "owner": "both",
      "title": "Elect a Dependent Care FSA at open enrollment",
      "summary": "You paid {f:childcare_yr} for after-school care and day camp in the last year and we do not see a Dependent Care FSA. A full {l:dcfsa} election saves about {f:dcfsa_save}.",
      "trigger": "life",
      "triggerText": "Window: open enrollment",
      "domain": "family",
      "window": {
        "label": "Nov 20 (assumed)",
        "days": 15
      },
      "effort": "5 min",
      "status": "proposed",
      "advisor": {
        "verdict": "pending",
        "note": "Likely yes. Check the teaching wages can carry the election."
      },
      "value": [
        {
          "cls": "tax",
          "text": "About {f:dcfsa_save} a year"
        }
      ],
      "why": [
        "Not confirmed yet: it depends on what {n:w2} offers part-time faculty and how much your paychecks there can carry. Ask in the chat below for the eligibility rules.",
        "Open enrollment is the only time you can elect it without a qualifying event. Summer day camp is the biggest childcare bill, so waiting a year gives up most of the value.",
        "The new limit is {l:dcfsa} per household, and after-school care plus camp clears it."
      ],
      "mine": [
        {
          "label": "Childcare, last 12 months",
          "fig": "childcare_yr"
        },
        {
          "label": "Per month",
          "fig": "childcare_mo"
        }
      ],
      "kb": [
        {
          "pack": "w2",
          "title": "Dependent care FSA",
          "cite": "IRC 129; partner pack note",
          "body": "Elected through an employer plan, pre-tax for income and payroll tax. The election must be supported by enough W-2 wages from that employer."
        },
        {
          "pack": "kids",
          "title": "Childcare for kids under 13",
          "cite": "Partner pack note",
          "body": "After-school programs and day camps qualify. Overnight camp does not. Keep the provider tax ID for the claim."
        }
      ],
      "cross": [
        "Uses your {n:w2} W-2 wages, not the S corp payroll."
      ],
      "tasks": [
        {
          "t": "Confirm {n:w2} offers a dependent care FSA, and its deadline",
          "done": false
        },
        {
          "t": "Ask HR how much per paycheck is left after other deductions",
          "done": false
        },
        {
          "t": "Elect what fits, up to {l:dcfsa}",
          "done": false
        },
        {
          "t": "Save the after-school program and camp tax IDs",
          "done": false
        }
      ],
      "qa": [
        {
          "q": "Am I even allowed to do this?",
          "a": [
            "Probably, but three things have to be true and we can only see one of them. First, {n:w2} has to offer a dependent care FSA to part-time faculty; we have not seen its benefits guide. Second, you cannot be more than a 2 percent owner of the employer offering it, which is why this goes through {n:w2} and not {n:biz}. Third, you both need earned income in the year, which you will have even with the sabbatical.",
            "The part we can see is the catch: the election comes out of your {n:w2} paychecks, and those wages were about {f:w2_wages} last year. A full {l:dcfsa} may not fit. One question to HR settles it."
          ]
        },
        {
          "q": "What if the paychecks are too small?",
          "a": [
            "Elect what fits. Any amount saves at your marginal rate plus payroll tax. Childcare spend the FSA does not cover can still count toward the dependent care credit, though at your income that is worth little."
          ]
        },
        {
          "q": "Is this better than the childcare credit?",
          "a": [
            "At your income, yes. The credit rate bottoms out; the FSA saves at your marginal rate plus payroll tax."
          ]
        }
      ]
    },
    {
      "id": "va529",
      "goalKinds": [
        "education",
        "tax"
      ],
      "owner": "both",
      "title": "Use the full Illinois 529 deduction before Dec 31",
      "summary": "Illinois deducts up to {l:va529_deduction} of 529 contributions a year on a joint return. The accounts hold {f:plan529} today.",
      "trigger": "calendar",
      "triggerText": "Year-end deduction",
      "domain": "family",
      "window": {
        "label": "Dec 31",
        "days": 56
      },
      "effort": "5 min",
      "status": "doing",
      "statusByDemo": {
        "first": "proposed"
      },
      "advisor": {
        "verdict": "confirmed",
        "note": "Easy win. Open {n:kid2}’s account so both kids are funded."
      },
      "value": [
        {
          "cls": "tax",
          "text": "About {f:va529_save} Illinois tax a year"
        },
        {
          "cls": "goal",
          "text": "Education goal progress"
        }
      ],
      "why": [
        "The deduction is per tax year and there is no carryforward, so room you do not use by Dec 31 is gone. Small dollars, zero effort."
      ],
      "mine": [
        {
          "label": "529 balance",
          "fig": "plan529"
        }
      ],
      "kb": [
        {
          "pack": "illinois",
          "title": "Illinois 529 deduction",
          "cite": "Illinois Income Tax Act; partner pack note",
          "body": "Contributions to an Illinois 529 plan are deductible up to the annual limit per taxpayer, double on a joint return. Contributions above the limit do not carry forward."
        },
        {
          "pack": "kids",
          "title": "One account per child",
          "cite": "Partner pack note",
          "body": "The limit is per taxpayer, not per account, so a second account adds flexibility, not deduction room."
        }
      ],
      "cross": [],
      "tasks": [
        {
          "t": "Contribute up to {l:va529_deduction} across both kids",
          "done": false
        },
        {
          "t": "Open {n:kid2}’s account",
          "done": false
        }
      ],
      "qa": [
        {
          "q": "Should I put in more?",
          "a": [
            "Not for the tax. Dollars above the limit get no Illinois deduction this year or later, so spread large contributions across years."
          ]
        }
      ]
    },
    {
      "id": "vaq4",
      "goalKinds": [
        "tax"
      ],
      "owner": "you",
      "title": "Pay the Illinois Q4 estimate in December, not January",
      "summary": "Paying the {f:vaq4_amt} Illinois estimate by Dec 31 deducts it on the 2026 return, while your rate is higher. With the sabbatical, 2027 income drops and the same deduction is worth less.",
      "trigger": "calendar",
      "triggerText": "Year-end timing",
      "domain": "tax",
      "window": {
        "label": "Dec 31",
        "days": 56
      },
      "effort": "5 min",
      "status": "doing",
      "statusByDemo": {
        "first": "proposed"
      },
      "advisor": {
        "verdict": "confirmed",
        "note": "Fine. Small, but free."
      },
      "value": [
        {
          "cls": "tax",
          "text": "About {f:vaq4_save} federal"
        }
      ],
      "why": [
        "You used {f:salt_2025} of the {l:salt_cap} SALT cap last year, so there is room. Moving the payment into December costs nothing; the estimate is due Jan 15 either way."
      ],
      "mine": [
        {
          "label": "Illinois Q4 estimate",
          "fig": "vaq4_amt"
        },
        {
          "label": "SALT used in 2025",
          "fig": "salt_2025"
        }
      ],
      "kb": [
        {
          "pack": "illinois",
          "title": "Timing state estimates",
          "cite": "Partner pack note",
          "body": "A state estimate paid in December is deductible in that year if it reflects a reasonable estimate of the liability."
        }
      ],
      "cross": [
        "Comes from joint checking, which also holds the Jan 15 federal earmark."
      ],
      "tasks": [
        {
          "t": "Schedule the Illinois payment for mid-December",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "reserve",
      "goalKinds": [
        "cash",
        "tax"
      ],
      "owner": "automatic",
      "title": "Keep the January and April tax money in personal checking",
      "summary": "Earmark {f:jan_est} for Jan 15 and {f:april_due} for the April balance. Safe harbor is met, so holding the cash costs nothing.",
      "trigger": "income",
      "triggerText": "Income change",
      "domain": "tax",
      "window": {
        "label": "Jan 15",
        "days": 71
      },
      "effort": "Watching",
      "status": "doing",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "Surfaces in January",
      "advisor": {
        "verdict": "confirmed",
        "note": "Agree. Money market for the reserve, not checking."
      },
      "value": [
        {
          "cls": "risk",
          "text": "No penalty, no surprise in April"
        }
      ],
      "why": [
        "Safe harbor is fixed at last year tax, so the retainer income shows up as a bigger April balance, not bigger estimates. Setting it aside now makes April a transfer instead of a scramble."
      ],
      "mine": [
        {
          "label": "2026 liability, estimated",
          "fig": "liability"
        },
        {
          "label": "Safe harbor payments",
          "fig": "safe_harbor"
        },
        {
          "label": "April balance due",
          "fig": "april_due"
        }
      ],
      "kb": [
        {
          "pack": "selfemp",
          "title": "Safe harbor at higher incomes",
          "cite": "IRS Pub 505",
          "body": "Above the income threshold, paying 110 percent of last year tax avoids the underpayment penalty regardless of this year."
        }
      ],
      "cross": [
        "The off-cycle run withholding reduces the Jan 15 amount."
      ],
      "tasks": [
        {
          "t": "Move the earmarks to a money market",
          "done": true
        },
        {
          "t": "Pay Jan 15 federal estimate",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "spsep",
      "goalKinds": [
        "retirement",
        "tax"
      ],
      "owner": "spouse",
      "title": "{n:spouse}’s SEP: fund the maximum in January",
      "summary": "Her SEP is about {f:sp_sep} once her Schedule C net is final. Every dollar comes off income in the phase-in zone.",
      "trigger": "calendar",
      "triggerText": "Waiting on her year-end books",
      "domain": "retire",
      "window": {
        "label": "Jan",
        "days": 75
      },
      "effort": "10 min",
      "status": "waiting",
      "waitingOn": "data",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "When her books close",
      "advisor": {
        "verdict": "confirmed",
        "note": "Fund at max. A Solo 401(k) would allow more; see the entity decision."
      },
      "value": [
        {
          "cls": "retire",
          "text": "About {f:sp_sep} of retirement room"
        },
        {
          "cls": "tax",
          "text": "Deducted at about {p:deduction_rate}"
        }
      ],
      "why": [
        "Fundable until the extended filing date, but sizing needs her final net. We will ping you the day the books close."
      ],
      "mine": [
        {
          "label": "Schedule C net, estimate",
          "fig": "sp_k1"
        },
        {
          "label": "SEP maximum, estimate",
          "fig": "sp_sep"
        }
      ],
      "kb": [
        {
          "pack": "selfemp",
          "title": "SEP for the self-employed",
          "cite": "IRS Pub 560",
          "body": "A sole proprietor figures the SEP contribution on net earnings after half of self-employment tax, so the effective rate is lower than the plan rate."
        }
      ],
      "cross": [
        "Grows her pre-tax IRA balance, which blocks a clean backdoor Roth until she rolls it into a Solo 401(k)."
      ],
      "tasks": [
        {
          "t": "Close the 2026 books for {n:spouseBiz}",
          "done": false
        },
        {
          "t": "Contribute the maximum",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "hsa",
      "goalKinds": [
        "health",
        "retirement",
        "tax"
      ],
      "owner": "you",
      "title": "Top up the HSA by April 15",
      "summary": "{f:hsa_left} of family HSA room left for 2026.",
      "trigger": "calendar",
      "triggerText": "Deadline: Apr 15",
      "domain": "retire",
      "window": {
        "label": "Apr 15",
        "days": 161
      },
      "effort": "5 min",
      "status": "doing",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "Surfaces in March",
      "advisor": null,
      "value": [
        {
          "cls": "tax",
          "text": "Triple tax advantage on {f:hsa_left}"
        }
      ],
      "why": [
        "Room left at filing time is easy to forget. This year it is on the calendar."
      ],
      "mine": [
        {
          "label": "Contributed this year",
          "fig": "hsa_paid"
        },
        {
          "label": "Room left",
          "fig": "hsa_left"
        }
      ],
      "kb": [
        {
          "pack": "w2",
          "title": "HSA via payroll vs direct",
          "cite": "Partner pack note",
          "body": "Payroll contributions also skip FICA. Direct contributions are deductible but do not."
        }
      ],
      "cross": [],
      "tasks": [
        {
          "t": "Contribute {f:hsa_left}",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "backdoor",
      "goalKinds": [
        "retirement"
      ],
      "owner": "you",
      "title": "Clear your pre-tax IRAs, then do a backdoor Roth",
      "summary": "Rolling {f:my_pretax} of pre-tax IRA money into the Solo 401(k) clears the pro-rata trap and opens {l:ira_limit} a year of Roth.",
      "trigger": "advisor",
      "triggerText": "Raised in chat",
      "domain": "retire",
      "window": {
        "label": "2027",
        "days": 120
      },
      "effort": "1 hour",
      "status": "snoozed",
      "wake": "Dec 10 check-in",
      "statusByDemo": {
        "first": "snoozed"
      },
      "advisor": {
        "verdict": "pending",
        "note": "Check the plan accepts roll-ins before anything moves. The pro-rata trap is the whole risk."
      },
      "value": [
        {
          "cls": "retire",
          "text": "{l:ira_limit} a year of Roth room"
        }
      ],
      "why": [
        "You asked about this in October. It works for you, but only after the rollover, and the pro-rata test is measured on Dec 31 of the conversion year, so there is no reason to rush it into 2026."
      ],
      "mine": [
        {
          "label": "Your pre-tax IRA balance",
          "fig": "my_pretax"
        },
        {
          "label": "Your Roth today",
          "fig": "my_roth"
        }
      ],
      "kb": [
        {
          "pack": "retire",
          "title": "The pro-rata rule",
          "cite": "IRS Form 8606 instructions",
          "body": "Conversions are taxed in proportion to all pre-tax IRA money you hold on Dec 31. Roll it into an employer plan first, or most of the conversion is taxable."
        }
      ],
      "cross": [
        "{n:spouse} cannot do this until her SEP-IRA is rolled into a Solo 401(k) of her own."
      ],
      "tasks": [
        {
          "t": "Confirm the Solo 401(k) accepts incoming rollovers",
          "done": false
        },
        {
          "t": "Direct-roll the rollover IRA",
          "done": false
        },
        {
          "t": "Contribute and convert",
          "done": false
        },
        {
          "t": "File Form 8606",
          "done": false
        }
      ],
      "qa": [
        {
          "q": "What about the mega backdoor?",
          "a": [
            "Your advisor vetoed it: your Solo 401(k) does not take after-tax money and your room is mostly used. See the check-in notes."
          ]
        }
      ]
    },
    {
      "id": "spouseentity",
      "goalKinds": [
        "tax"
      ],
      "owner": "spouse",
      "title": "Decide whether {n:spouse}’s relief practice should become an S corp",
      "summary": "At full-year income an S election saves about {f:scorp_save_full}. In a sabbatical year it is closer to {f:scorp_save_leave}, and it adds payroll.",
      "trigger": "life",
      "triggerText": "Life event: sabbatical",
      "domain": "entities",
      "window": {
        "label": "Mar 15",
        "days": 130
      },
      "effort": "30 min",
      "status": "snoozed",
      "wake": "After the sabbatical",
      "statusByDemo": {
        "first": "snoozed"
      },
      "advisor": {
        "verdict": "pending",
        "note": "Probably wait for 2028. Revisit when her schedule after the sabbatical is known."
      },
      "value": [
        {
          "cls": "tax",
          "text": "About {f:scorp_save_full} a year at full income"
        },
        {
          "cls": "retire",
          "text": "Pairs with a Solo 401(k) for her"
        }
      ],
      "why": [
        "Her practice is a sole proprietorship, so every dollar of net pays self-employment tax. An LLC with an S election would split that into wages and distributions.",
        "It does not fix the QBI phase-in loss of {f:sp_qbi_lost}: veterinary work is a specified service, so the loss follows income, not the entity."
      ],
      "mine": [
        {
          "label": "QBI deduction she loses now",
          "fig": "sp_qbi_lost"
        },
        {
          "label": "Her pre-tax IRA balance",
          "fig": "sp_pretax"
        }
      ],
      "kb": [
        {
          "pack": "scorp",
          "title": "Electing S status for a new LLC",
          "cite": "Form 2553 instructions",
          "body": "Due within 2 months and 15 days of the start of the tax year the election is to take effect. Late-election relief exists but is not a plan."
        }
      ],
      "cross": [
        "Ties to her Solo 401(k), the backdoor Roth, and 2027 cash during the sabbatical."
      ],
      "tasks": [
        {
          "t": "War-game her 2027 income with the sabbatical",
          "done": false
        },
        {
          "t": "Decide by Mar 15",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "babyprep",
      "goalKinds": [
        "cash",
        "health"
      ],
      "owner": "both",
      "title": "Get the family paperwork current",
      "summary": "Wills and guardians for {n:kid} and {n:kid2}, beneficiaries on every account, and term life sized for two kids through college.",
      "trigger": "life",
      "triggerText": "Kids and net worth",
      "domain": "family",
      "window": {
        "label": "Before the sabbatical",
        "days": 56
      },
      "effort": "2 hours",
      "status": "doing",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "Surfaces in December",
      "advisor": {
        "verdict": "confirmed",
        "note": "Wills and guardianship go to an estate attorney. We will refer."
      },
      "value": [
        {
          "cls": "risk",
          "text": "Coverage gap of roughly {f:life_ins_gap} closed"
        }
      ],
      "why": [
        "None of it is urgent this week, which is exactly why it has not happened. Doing it before the sabbatical means both incomes are running when the new premiums start."
      ],
      "mine": [
        {
          "label": "Net worth",
          "fig": "net_worth"
        }
      ],
      "kb": [
        {
          "pack": "kids",
          "title": "Family paperwork checklist",
          "cite": "Partner pack",
          "body": "Name guardians, update beneficiaries, re-size term life as the kids grow, and keep a letter of instruction with the will."
        }
      ],
      "cross": [
        "New premiums come out of joint checking during the sabbatical months."
      ],
      "tasks": [
        {
          "t": "Re-quote term life for both of you",
          "done": false
        },
        {
          "t": "Book the estate attorney",
          "done": false
        },
        {
          "t": "Update beneficiaries on every account",
          "done": false
        },
        {
          "t": "Write down the guardian choice",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "umbrella",
      "goalKinds": [],
      "owner": "both",
      "title": "Add a 2 million umbrella policy",
      "summary": "About {f:umbrella_lo} to {f:umbrella_hi} a year against a net worth near {f:net_worth}.",
      "trigger": "life",
      "triggerText": "Net worth and family",
      "domain": "family",
      "window": {
        "label": "Dec 31",
        "days": 56
      },
      "effort": "30 min",
      "status": "doing",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "Surfaces in December",
      "advisor": {
        "verdict": "confirmed",
        "note": "Yes. Quote through your auto and home carrier first."
      },
      "value": [
        {
          "cls": "risk",
          "text": "Liability protection"
        }
      ],
      "why": [
        "It was on your own list in June. It is cheap and nothing else covers this."
      ],
      "mine": [
        {
          "label": "Net worth",
          "fig": "net_worth"
        }
      ],
      "kb": [],
      "cross": [],
      "tasks": [
        {
          "t": "Get two quotes",
          "done": false
        },
        {
          "t": "Bind the policy",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "compmemo",
      "goalKinds": [
        "tax"
      ],
      "owner": "advisor",
      "title": "Write the reasonable compensation memo",
      "summary": "Your {f:salary} salary is about {p:comp_ratio} of billings now. A one-page memo with comparable rates, hours and duties is your defense.",
      "trigger": "income",
      "triggerText": "Income change",
      "domain": "payroll",
      "window": {
        "label": "Before filing",
        "days": 87
      },
      "effort": "20 min",
      "status": "doing",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "Surfaces in January",
      "advisor": {
        "verdict": "confirmed",
        "note": "Good. Revisit the salary for 2027 if the retainer renews."
      },
      "value": [
        {
          "cls": "risk",
          "text": "Audit defense for the S corp"
        }
      ],
      "why": [
        "The retainer raised billings, so the ratio slipped. Nothing to change this year, but write it down while the facts are fresh."
      ],
      "mine": [
        {
          "label": "Salary",
          "fig": "salary"
        },
        {
          "label": "Business gross",
          "fig": "my_gross"
        }
      ],
      "kb": [
        {
          "pack": "scorp",
          "title": "Reasonable compensation",
          "cite": "IRS S corp compensation guidance",
          "body": "Pay what you would pay someone else to do the work. Document comparable rates, hours and duties."
        }
      ],
      "cross": [
        "Salary sets your 401(k) room and your QBI wage limit. See the salary war game."
      ],
      "tasks": [
        {
          "t": "Fathom drafts the memo from your projects",
          "done": true
        },
        {
          "t": "Review and sign",
          "done": false
        }
      ],
      "qa": [],
      "scenario": "salary"
    },
    {
      "id": "filingplan",
      "goalKinds": [],
      "owner": "both",
      "title": "Decide who files the 2026 returns",
      "summary": "Your CPA retired in August. Review-only hours cost {f:review_lo} to {f:review_hi}, not the {f:cpa_full} of a full relationship.",
      "trigger": "calendar",
      "triggerText": "Decide by Jan 31",
      "domain": "entities",
      "window": {
        "label": "Jan 31",
        "days": 87
      },
      "effort": "15 min",
      "status": "waiting",
      "waitingOn": "advisor",
      "statusByDemo": {
        "first": "snoozed"
      },
      "wake": "Dec 10 check-in",
      "advisor": {
        "verdict": "pending",
        "note": "Bringing in our tax specialist for the 1120-S and her Schedule C."
      },
      "value": [
        {
          "cls": "risk",
          "text": "The 1120-S done right after the handoff"
        }
      ],
      "why": [
        "New preparer, first year in the QBI phase-in, and the Illinois replacement tax on the S corp. The year-end packet makes review-only hours realistic."
      ],
      "mine": [],
      "kb": [],
      "cross": [
        "The year-end packet is the input either way."
      ],
      "tasks": [
        {
          "t": "Specialist intro at the check-in",
          "done": false
        },
        {
          "t": "Decide solo, review-only, or full",
          "done": false
        }
      ],
      "qa": []
    },
    {
      "id": "mortgage",
      "goalKinds": [
        "home"
      ],
      "owner": "both",
      "title": "Pay off the studio HELOC",
      "summary": "Done Jun 19, five months early.",
      "trigger": "goal",
      "triggerText": "Goal",
      "domain": "family",
      "window": {
        "label": "Done",
        "days": 0
      },
      "effort": "Done",
      "status": "done",
      "advisor": null,
      "value": [
        {
          "cls": "goal",
          "text": "Milestone 1 of the ten-year plan"
        }
      ],
      "why": [
        "{f:mortgage_paid} of HELOC payments this year."
      ],
      "mine": [
        {
          "label": "HELOC payments 2026",
          "fig": "mortgage_paid"
        }
      ],
      "kb": [],
      "cross": [],
      "tasks": [],
      "qa": []
    },
    {
      "id": "q3",
      "goalKinds": [
        "tax"
      ],
      "owner": "automatic",
      "title": "Pay Q3 estimates",
      "summary": "Paid Aug 21 and Aug 25, matched in the mirror.",
      "trigger": "calendar",
      "triggerText": "Sep 15",
      "domain": "tax",
      "window": {
        "label": "Done",
        "days": 0
      },
      "effort": "Done",
      "status": "done",
      "advisor": null,
      "value": [
        {
          "cls": "risk",
          "text": "Safe harbor on track"
        }
      ],
      "why": [
        "{f:q3_fed} federal and {f:q3_va} Illinois."
      ],
      "mine": [
        {
          "label": "Federal",
          "fig": "q3_fed"
        },
        {
          "label": "Illinois",
          "fig": "q3_va"
        }
      ],
      "kb": [],
      "cross": [],
      "tasks": [],
      "qa": []
    },
    {
      "id": "megabackdoor",
      "goalKinds": [
        "retirement"
      ],
      "owner": "advisor",
      "title": "Mega backdoor Roth",
      "summary": "Vetoed by your advisor.",
      "trigger": "advisor",
      "triggerText": "Raised in chat",
      "domain": "retire",
      "window": {
        "label": "n/a",
        "days": 0
      },
      "effort": "n/a",
      "status": "dismissed",
      "advisor": {
        "verdict": "vetoed",
        "note": "Your plan takes no after-tax money and your room is mostly used. Not for you."
      },
      "value": [],
      "why": [
        "The textbook says yes. Your plan document says no."
      ],
      "mine": [],
      "kb": [],
      "cross": [],
      "tasks": [],
      "qa": []
    },
    {
      "id": "daf",
      "goalKinds": [
        "giving",
        "tax"
      ],
      "owner": "both",
      "title": "Bunch giving into a donor-advised fund with appreciated stock",
      "summary": "Giving appreciated shares instead of cash avoids the gain and gets the deduction, in a year your itemized deductions are already high.",
      "trigger": "goal",
      "triggerText": "From a what-if",
      "domain": "invest",
      "window": {
        "label": "Dec 31",
        "days": 56
      },
      "effort": "30 min",
      "status": "hidden",
      "advisor": null,
      "value": [
        {
          "cls": "tax",
          "text": "Avoids tax on the gain given, plus the deduction"
        }
      ],
      "why": [
        "Only worth it if you have real charitable intent. Your 2025 giving was small, so we never raised it."
      ],
      "mine": [
        {
          "label": "Embedded gain",
          "fig": "conc_gain"
        }
      ],
      "kb": [
        {
          "pack": "giving",
          "title": "Gifting appreciated stock",
          "cite": "IRS Pub 526",
          "body": "Long-term appreciated stock given to a public charity or DAF is deductible at fair value, up to the AGI limits."
        }
      ],
      "cross": [
        "Reduces 2026 taxable income, which also trims the QBI phase-in."
      ],
      "tasks": [
        {
          "t": "Decide an amount you would give anyway",
          "done": false
        },
        {
          "t": "Open a DAF and transfer shares",
          "done": false
        }
      ],
      "qa": []
    }
  ],
  "goals": [
    {
      "id": "arena",
      "title": "Keep the studio small",
      "horizon": "now",
      "status": "on track",
      "prose": "No employees, pick the projects, and school pickup three days a week. Income flexes around the schedule, not the other way around."
    },
    {
      "id": "mortgage",
      "title": "Studio HELOC paid off",
      "horizon": "now",
      "status": "done",
      "prose": "Done Jun 19. The build-out loan is gone and the studio runs on its own cash."
    },
    {
      "id": "reserve",
      "target": 135000,
      "targetDate": "2026-12-31",
      "track": {
        "figure": "reserve.actual"
      },
      "pace": {
        "startDate": "2026-01-01",
        "startValue": 70000
      },
      "title": "Nine months of cash",
      "horizon": "now",
      "status": "on track",
      "prose": "A real reserve, parked in a money market, separate from tax earmarks.",
      "progress": {
        "cur": "true_reserve",
        "target": "reserve_target"
      }
    },
    {
      "id": "port3",
      "target": 2000000,
      "targetDate": "2031-12-31",
      "track": {
        "figure": "portfolio"
      },
      "pace": {
        "startDate": "2026-01-01",
        "startValue": 1050000
      },
      "title": "Work optional",
      "horizon": "3-10y",
      "status": "on track",
      "prose": "Portfolio at the point where a quiet year for the studio is fine. The decision about growing or winding down happens here.",
      "progress": {
        "cur": "portfolio",
        "target": "port_3m"
      }
    },
    {
      "id": "port4",
      "target": 3000000,
      "targetDate": "2038-12-31",
      "track": {
        "figure": "portfolio"
      },
      "pace": {
        "startDate": "2026-01-01",
        "startValue": 1050000
      },
      "title": "Zero income required",
      "horizon": "3-10y",
      "status": "on track",
      "prose": "The backstop, not the trigger. Work does not stop; it just stops being necessary.",
      "progress": {
        "cur": "portfolio",
        "target": "port_4m"
      }
    },
    {
      "id": "trips",
      "title": "Two family trips a year",
      "horizon": "now",
      "status": "open",
      "prose": "One week in summer, one in winter, about {f:travel_yr} a year. Blocked by school calendars, not money."
    },
    {
      "id": "kids",
      "title": "College for both kids",
      "horizon": "3-10y",
      "status": "watch",
      "prose": "Steady 529 contributions for {n:kid} and {n:kid2}, using the Illinois deduction every year."
    }
  ],
  "curve": [
    {
      "id": "tax_cash",
      "left": "Pay less tax this year",
      "right": "Keep cash flexible",
      "value": 0.55,
      "note": "Even split, with extra weight on cash during the sabbatical."
    },
    {
      "id": "ret_life",
      "left": "Max retirement room",
      "right": "Lifestyle now",
      "value": 0.45,
      "note": "Fill pre-tax room, but not at the cost of the trips."
    },
    {
      "id": "effort",
      "left": "Optimize everything",
      "right": "Do not make me think",
      "value": 0.6,
      "note": "Only surface items with a deadline or real money behind them."
    },
    {
      "id": "human",
      "left": "Lean on the AI",
      "right": "Lean on the human",
      "value": 0.35,
      "note": "Quarterly human check-ins, plus help at filing time."
    }
  ],
  "wargame": {
    "salary": {
      "status": "decided",
      "decided": "Decided Aug 20 for 2026: {f:salary}. The payroll already run locks it in. Reopens for 2027 in January.",
      "title": "What should you pay yourself?",
      "question": "Each point is a salary. Up and right is more retirement room for more tax. Off the curve means you pay more for less.",
      "xLabel": "Pre-tax retirement room",
      "yLabel": "Tax change vs your current plan",
      "points": [
        {
          "id": "s70",
          "label": "Salary 70K",
          "x": 42000,
          "y": -2100,
          "frontier": true,
          "warn": "Weak reasonable-comp position",
          "note": "Cheapest on paper, hardest to defend on audit."
        },
        {
          "id": "s90",
          "label": "Salary 90K",
          "x": 47000,
          "y": -1200,
          "frontier": true,
          "warn": "Below a defensible range",
          "note": "Saves a little tax, gives up 401(k) room and comp defense."
        },
        {
          "id": "s110",
          "label": "Salary 110K",
          "x": 52000,
          "y": 0,
          "frontier": true,
          "current": true,
          "note": "Your plan. Keeps the QBI wage limit comfortably clear."
        },
        {
          "id": "s130",
          "label": "Salary 130K",
          "x": 57000,
          "y": 1900,
          "frontier": true,
          "note": "More room, more payroll tax. Reasonable if the retainer renews."
        },
        {
          "id": "s150",
          "label": "Salary 150K",
          "x": 62000,
          "y": 3800,
          "frontier": true,
          "note": "Each extra dollar of room costs about 38 cents of tax now."
        },
        {
          "id": "s175",
          "label": "Salary 175K",
          "x": 68000,
          "y": 6200,
          "frontier": true,
          "note": "Diminishing return."
        },
        {
          "id": "s200",
          "label": "Salary 200K",
          "x": 72000,
          "y": 8500,
          "frontier": true,
          "note": "At the full defined-contribution limit."
        },
        {
          "id": "sep",
          "label": "SEP instead of Solo 401(k)",
          "x": 27500,
          "y": 6800,
          "frontier": false,
          "note": "The path without the Solo 401(k). Off the curve: more tax and less room."
        }
      ],
      "takeaway": "You are on the curve. Where you sit on it is your call: the next notch up buys retirement room at roughly 38 cents on the dollar."
    },
    "deferral": {
      "status": "open",
      "title": "Invoice now or in January?",
      "question": "Delivered fixed-fee design work, cash basis. Pick how much to bill in January.",
      "options": [
        {
          "id": "d0",
          "label": "Bill it all now",
          "amount": 0,
          "tax2026": 0,
          "tax2027": 0,
          "net": 0,
          "decCash": 58000,
          "need": 41400,
          "note": "Simplest. December cash is comfortable. No help for the sabbatical months."
        },
        {
          "id": "d15",
          "label": "Defer half",
          "amount": 13000,
          "tax2026": -4800,
          "tax2027": 3750,
          "net": -1050,
          "decCash": 45000,
          "need": 41400,
          "note": "Some cash into the sabbatical, payroll still covered even with the distribution."
        },
        {
          "id": "d30",
          "label": "Defer all",
          "amount": 26000,
          "tax2026": -9600,
          "tax2027": 7500,
          "net": -2100,
          "decCash": 32000,
          "need": 41400,
          "note": "Best tax and cash timing, but December payroll is short unless you skip the November distribution."
        },
        {
          "id": "d30s",
          "label": "Defer all, skip the distribution",
          "amount": 26000,
          "tax2026": -9600,
          "tax2027": 7500,
          "net": -2100,
          "decCash": 43000,
          "need": 41400,
          "note": "Same tax result with payroll covered. Personal cash takes the hit for one month."
        }
      ],
      "takeaway": "Defer it, and skip one distribution. The tax win is modest; the real win is income arriving during the sabbatical."
    }
  },
  "decisions": [
    {
      "id": "deferral",
      "title": "Invoice now or in January?",
      "status": "open",
      "wargame": "deferral",
      "recId": "deferral",
      "when": "Decide by Dec 1",
      "note": "Tax timing against December payroll cash."
    },
    {
      "id": "dcfsa",
      "title": "How much dependent care FSA can your paychecks carry?",
      "status": "open",
      "recId": "dcfsa",
      "when": "Nov 20 (assumed)",
      "note": "One answer from HR settles it."
    },
    {
      "id": "salary26",
      "title": "What should you pay yourself in 2026?",
      "status": "decided",
      "wargame": "salary",
      "recId": "compmemo",
      "when": "Decided Aug 20",
      "note": "{f:salary}, locked in by the payroll already run."
    },
    {
      "id": "salary27",
      "title": "What should you pay yourself in 2027?",
      "status": "upcoming",
      "wargame": "salary",
      "when": "Opens in January",
      "note": "Reopens if the {f:baseline} baseline holds into 2027."
    },
    {
      "id": "spouseentity",
      "title": "{n:spouse}’s relief practice: S corp or not?",
      "status": "upcoming",
      "recId": "spouseentity",
      "when": "Before Mar 15",
      "note": "Opens once her schedule after the sabbatical is known."
    },
    {
      "id": "backdoor",
      "title": "When to roll the pre-tax IRA",
      "status": "upcoming",
      "recId": "backdoor",
      "when": "2027",
      "note": "After the advisor confirms the plan takes roll-ins."
    }
  ],
  "ask": {
    "suggested": [
      {
        "id": "screwing",
        "q": "What am I screwing up this month?",
        "refs": [
          "offcycle",
          "deferral",
          "dcfsa"
        ],
        "a": [
          "Nothing yet, but these decisions could slip. The off-cycle payroll with your {l:deferral} deferral is not scheduled and the deadline is hard. The fixed-fee invoices need a decision because they collide with December payroll cash. And open enrollment is the only cheap window for a Dependent Care FSA, worth about {f:dcfsa_save}.",
          "Taxes are covered: {f:fed_paid} federal is credited and the January and April money is earmarked."
        ]
      },
      {
        "id": "defer",
        "q": "Can we push the fixed-fee invoices into January?",
        "refs": [
          "deferral"
        ],
        "a": [
          "Yes. On the cash basis it saves about {f:defer_net} across two years and puts {f:fixed_fee} into the sabbatical months. The catch is December: business cash would be {f:biz_cash_dec_defer} against a {f:dec_need} payroll need. Skip the November distribution and it works."
        ]
      },
      {
        "id": "backdoor",
        "q": "Should I be doing a backdoor Roth?",
        "refs": [
          "backdoor"
        ],
        "a": [
          "Eventually, yes, but not this month. You hold {f:my_pretax} of pre-tax IRA money, which would make most of a conversion taxable. Roll it into the Solo 401(k) first. Your advisor wants to confirm the plan takes roll-ins at the Dec 10 check-in."
        ]
      },
      {
        "id": "salary",
        "q": "What should I pay myself next year?",
        "refs": [
          "compmemo"
        ],
        "a": [
          "If the {f:baseline} baseline holds, use your current {f:salary} as the starting point. Going higher changes your 401(k) room and tax costs. Open the salary war game to compare the stored options and pick your spot."
        ]
      },
      {
        "id": "leave",
        "q": "What happens to our cash during the sabbatical?",
        "refs": [
          "reserve",
          "deferral"
        ],
        "a": [
          "Year-end cash projects to {f:yearend_cash}. After the January and April tax earmarks you keep about {f:true_reserve}, on the way to the {f:reserve_target} target. Deferring the fixed-fee invoices moves another {f:fixed_fee} into the sabbatical months."
        ]
      },
      {
        "id": "track",
        "q": "Are we on track for work optional?",
        "refs": [],
        "a": [
          "Yes. The portfolio is at {f:portfolio} against the {f:port_3m} milestone, and household income of {f:run_rate} is about twice the {f:floor_income} floor. Nothing in this year plan works against it."
        ]
      }
    ],
    "fallback": [
      "In the real product this is answered live from your mirrored data, your plan and the active knowledge packs. This mock only has canned answers for the suggested questions."
    ]
  },
  "accounts": [
    {
      "id": "a_biz",
      "inst": "{n:bank}",
      "name": "Business checking",
      "owner": "{n:biz}",
      "kind": "business",
      "fig": "biz_cash",
      "mirror": "connected",
      "note": "Receipts, payroll debits, distributions"
    },
    {
      "id": "a_personal",
      "inst": "{n:bank}",
      "name": "Joint checking",
      "owner": "Household",
      "kind": "checking",
      "fig": "personal_cash",
      "mirror": "connected",
      "note": "Tax payments matched from here"
    },
    {
      "id": "a_jcash",
      "inst": "Other bank",
      "name": "{n:spouse}’s checking",
      "owner": "{n:spouse}",
      "kind": "cash",
      "fig": "sp_cash",
      "mirror": "manual",
      "note": "Entered by hand. Connect to stop guessing."
    },
    {
      "id": "a_tod",
      "inst": "{n:broker}",
      "name": "Individual",
      "owner": "{n:me}",
      "kind": "taxable",
      "fig": "my_tod",
      "mirror": "connected",
      "note": "Concentrated lot held to 2027"
    },
    {
      "id": "a_roll",
      "inst": "{n:broker}",
      "name": "Rollover IRA",
      "owner": "{n:me}",
      "kind": "retirement",
      "fig": "my_rollover",
      "mirror": "connected",
      "note": "Counts toward pro-rata"
    },
    {
      "id": "a_broth",
      "inst": "{n:broker}",
      "name": "Roth IRA",
      "owner": "{n:me}",
      "kind": "roth",
      "fig": "my_roth",
      "mirror": "connected",
      "note": ""
    },
    {
      "id": "a_jsep",
      "inst": "{n:broker}",
      "name": "SEP-IRA",
      "owner": "{n:spouse}",
      "kind": "retirement",
      "fig": "sp_sep_ira",
      "mirror": "connected",
      "note": "Balance far above contribution history. Likely a rollover; confirm."
    },
    {
      "id": "a_jtod",
      "inst": "{n:broker}",
      "name": "Direct-index account",
      "owner": "{n:spouse}",
      "kind": "taxable",
      "fig": "sp_tod",
      "mirror": "connected",
      "note": ""
    },
    {
      "id": "a_jroth",
      "inst": "{n:broker}",
      "name": "Roth IRA",
      "owner": "{n:spouse}",
      "kind": "roth",
      "fig": "sp_roth",
      "mirror": "connected",
      "note": ""
    },
    {
      "id": "a_529",
      "inst": "{n:broker}",
      "name": "529",
      "owner": "{n:kid}",
      "kind": "529",
      "fig": "plan529",
      "mirror": "connected",
      "note": ""
    },
    {
      "id": "a_payroll",
      "inst": "{n:payroll}",
      "name": "Payroll",
      "owner": "{n:biz}",
      "kind": "business",
      "fig": null,
      "mirror": "connected",
      "note": "Runs and year-to-date wages"
    },
    {
      "id": "a_hsa",
      "inst": "{n:hsa}",
      "name": "Family HSA",
      "owner": "Household",
      "kind": "hsa",
      "fig": null,
      "mirror": "missing",
      "note": "Not connected. {f:hsa_paid} contributed, seen from checking."
    },
    {
      "id": "a_solo",
      "inst": "Plan custodian",
      "name": "Solo 401(k)",
      "owner": "{n:me}",
      "kind": "retirement",
      "fig": null,
      "mirror": "missing",
      "note": "Open, unfunded. Connect after the off-cycle run."
    }
  ],
  "advisor": {
    "name": "{n:advisor}",
    "role": "Your advisor",
    "next": {
      "when": "Thu, Dec 10, 2:00 PM",
      "length": "30 min"
    },
    "agenda": "Next quarter I want to get through {n:spouse}’s sabbatical without a cash crunch, decide whether her practice should be an S corp, and walk into filing season with a plan now that our CPA has retired.",
    "reviewed": [
      {
        "recId": "offcycle",
        "title": "Off-cycle payroll with the deferral",
        "verdict": "confirmed",
        "note": "Regular method. Confirm the custodian deposit in December."
      },
      {
        "recId": "spsep",
        "title": "{n:spouse}’s SEP at maximum",
        "verdict": "confirmed",
        "note": "Fund at max once her books close."
      },
      {
        "recId": "megabackdoor",
        "title": "Mega backdoor Roth",
        "verdict": "vetoed",
        "note": "Plan takes no after-tax money and your room is mostly used."
      },
      {
        "title": "Hold the concentrated position through 2026",
        "verdict": "confirmed",
        "note": "A trim now costs about {f:conc_trim_tax} and deepens the phase-in."
      },
      {
        "recId": "compmemo",
        "title": "Reasonable comp memo",
        "verdict": "confirmed",
        "note": "Good draft. Add the project hours log."
      }
    ],
    "pending": [
      "deferral",
      "dcfsa",
      "backdoor",
      "spouseentity",
      "filingplan"
    ],
    "notAsking": [
      {
        "q": "Is your life insurance sized for two kids through college?",
        "why": "Coverage was set when {n:kid} was born. The gap is roughly {f:life_ins_gap}."
      },
      {
        "q": "Who are the guardians?",
        "why": "No will on file. This matters more than any tax item this quarter."
      },
      {
        "q": "Is {n:spouse}’s SEP-IRA balance a rollover?",
        "why": "It is far above her contribution history, and it changes her pro-rata plan."
      },
      {
        "q": "Who files the 1120-S now?",
        "why": "Your CPA retired. Mistakes here repeat every year."
      }
    ],
    "shared": [
      {
        "title": "Can we afford the sabbatical?",
        "when": "Sep 22"
      },
      {
        "title": "Backdoor Roth for both of us",
        "when": "Oct 6"
      },
      {
        "title": "Invoice timing before the sabbatical",
        "when": "Nov 4"
      },
      {
        "title": "Salary for next year",
        "when": "Nov 4"
      }
    ],
    "experts": [
      {
        "name": "{n:specialist}",
        "role": "Tax specialist",
        "when": "Joins the Dec 10 check-in for the filing plan"
      },
      {
        "name": "Estate attorney",
        "role": "Referral, outside our scope",
        "when": "Intro after the check-in"
      }
    ]
  },
  "yearend": {
    "docs": [
      {
        "t": "W-2 from {n:biz} payroll",
        "status": "expected",
        "src": "{n:payroll}",
        "note": "Late January"
      },
      {
        "t": "W-2 from {n:w2}",
        "status": "expected",
        "src": "{n:w2}",
        "note": "Late January"
      },
      {
        "t": "1099-NECs and books for {n:spouseBiz}",
        "status": "expected",
        "src": "Clinics she covers",
        "note": "January; drives her SEP size"
      },
      {
        "t": "Brokerage 1099s",
        "status": "expected",
        "src": "{n:broker}",
        "note": "Mid February"
      },
      {
        "t": "Estimated payment ledger",
        "status": "have",
        "src": "Mirror",
        "note": "Every federal and Illinois payment matched"
      },
      {
        "t": "Distribution ledger",
        "status": "have",
        "src": "Mirror",
        "note": "{f:distributions_ytd} through August"
      },
      {
        "t": "Mortgage 1098 and HELOC payoff letter",
        "status": "missing",
        "src": "{n:bank}",
        "note": "Pull the payoff letter"
      },
      {
        "t": "HSA contribution record",
        "status": "missing",
        "src": "{n:hsa}",
        "note": "Account not connected"
      },
      {
        "t": "Solo 401(k) contribution record",
        "status": "expected",
        "src": "Plan custodian",
        "note": "After the off-cycle run"
      },
      {
        "t": "Reasonable comp memo",
        "status": "expected",
        "src": "Fathom draft",
        "note": "Waiting on your signature"
      },
      {
        "t": "Business books, two corrections",
        "status": "have",
        "src": "P&L",
        "note": "HELOC line and one miscategorized May entry fixed"
      }
    ],
    "decisions": [
      {
        "t": "Off-cycle payroll run done",
        "done": false,
        "recId": "offcycle"
      },
      {
        "t": "Invoice timing decided",
        "done": false,
        "recId": "deferral"
      },
      {
        "t": "Illinois Q4 paid in December",
        "done": false,
        "recId": "vaq4"
      },
      {
        "t": "529 contributions made",
        "done": false,
        "recId": "va529"
      },
      {
        "t": "Q3 estimates paid",
        "done": true,
        "recId": "q3"
      },
      {
        "t": "Filing plan chosen",
        "done": false,
        "recId": "filingplan"
      }
    ]
  },
  "connect": {
    "url": "https://fathom.home.example/mcp",
    "scopes": [
      {
        "id": "kb",
        "label": "Knowledge packs (active ones)",
        "access": "read",
        "on": true
      },
      {
        "id": "accounts",
        "label": "Accounts and balances",
        "access": "read",
        "on": true
      },
      {
        "id": "txns",
        "label": "Transactions",
        "access": "read",
        "on": true
      },
      {
        "id": "plan",
        "label": "Recommendations and goals",
        "access": "read",
        "on": true
      },
      {
        "id": "status",
        "label": "Update recommendation status",
        "access": "write",
        "on": false
      }
    ],
    "tools": [
      {
        "name": "kb.search",
        "desc": "Search the active knowledge packs, with citations"
      },
      {
        "name": "accounts.list",
        "desc": "Balances and sync freshness, read-only"
      },
      {
        "name": "transactions.query",
        "desc": "Filter mirrored transactions, read-only"
      },
      {
        "name": "plan.recommendations",
        "desc": "Open recommendations with status, window and value"
      },
      {
        "name": "plan.update_status",
        "desc": "Mark a recommendation doing it, done, later or not for us (write scope)"
      },
      {
        "name": "scenarios.run",
        "desc": "Run a saved war game with new inputs"
      }
    ],
    "transcript": [
      {
        "role": "me",
        "text": "What am I screwing up this month?"
      },
      {
        "role": "tool",
        "text": "plan.recommendations(needs_you=true)  -> 3 results"
      },
      {
        "role": "tool",
        "text": "accounts.list(kind=business)  -> business checking, projected {f:biz_cash_now}"
      },
      {
        "role": "claude",
        "text": "Three things: schedule the off-cycle payroll for the {l:deferral} deferral, decide the fixed-fee invoice timing, and elect the dependent care FSA before open enrollment closes. Everything else Fathom marks as covered."
      }
    ],
    "config": "{\n  \"mcpServers\": {\n    \"fathom\": {\n      \"type\": \"http\",\n      \"url\": \"https://fathom.home.example/mcp\",\n      \"headers\": { \"Authorization\": \"Bearer <read-only token>\" }\n    }\n  }\n}"
  },
  "engine": {
    "budget": {
      "monthly": 200,
      "used": 27.6
    },
    "chat": {
      "model": "Claude via the Agent SDK",
      "note": "Chat reads the same read-only tools your own AI gets over MCP, plus the active knowledge packs. Turn the engine off during testing and every answer stays canned."
    },
    "jobs": [
      {
        "id": "sync",
        "name": "Account mirror sync",
        "cadence": "Daily, 6:00 AM",
        "last": "Today 6:00 AM",
        "next": "Tomorrow 6:00 AM",
        "does": "Pull balances and transactions read-only. No model call unless something looks unusual.",
        "cost": 0.02
      },
      {
        "id": "sweep",
        "name": "Deadline sweep",
        "cadence": "Weekly, Monday",
        "last": "Mon, Nov 2",
        "next": "Mon, Nov 9",
        "does": "Check every window in the next 60 days against the plan and the checklists.",
        "cost": 0.15
      },
      {
        "id": "triggers",
        "name": "Life event and income triggers",
        "cadence": "On new data",
        "last": "Wed, Nov 4",
        "next": "On next change",
        "does": "Re-plan the recommendations a new fact touches. Turns knowledge packs on or off.",
        "cost": 0.4
      },
      {
        "id": "brief",
        "name": "Monthly brief and email",
        "cadence": "Monthly, 1st",
        "last": "Sun, Nov 1",
        "next": "Tue, Dec 1",
        "does": "Write the brief, the verdict and the email. Nothing goes out if nothing changed.",
        "cost": 1.8
      },
      {
        "id": "packet",
        "name": "Advisor packet",
        "cadence": "Before each check-in",
        "last": "Sep 8",
        "next": "Dec 8",
        "does": "Summarise conversations and pending recommendations for the human review.",
        "cost": 2.5
      }
    ]
  },
  "onboarding": {
    "welcome": {
      "headline": "Dump everything in. We will tell you when it is covered.",
      "sub": "Read-only access to your accounts, your goals in your own words, and a monthly answer to one question: am I missing something?"
    },
    "dump": "I am an architect with a one-person studio. It has been an S corp since 2024 and pays me through payroll, and I also teach one evening course, which is a small W-2. {n:spouse} is a veterinarian doing relief shifts as a sole proprietor. We have two kids, nine and six, and live in Illinois. {n:spouse} is taking January to March off, unpaid, to finish a specialty certification, so I am thinking about pushing some invoices into January.\n\nOur CPA retired this summer, last April's balance due was bigger than we planned, and I am not sure we are using the retirement accounts well. I do not want to be perfect. I want to not miss deadlines, optimize where it is worth it, keep cash calm through the sabbatical, and then not think about it.",
    "files": [
      {
        "name": "2025 federal and Illinois returns.pdf",
        "status": "Read"
      },
      {
        "name": "2026 household P and L.xlsx",
        "status": "Read"
      },
      {
        "name": "Payroll report, Jan to Sep.pdf",
        "status": "Read"
      },
      {
        "name": "Ten-year plan.md",
        "status": "Read"
      }
    ],
    "institutions": [
      {
        "inst": "{n:bank}",
        "accounts": 2,
        "mode": "read-only"
      },
      {
        "inst": "{n:broker}",
        "accounts": 7,
        "mode": "read-only"
      },
      {
        "inst": "{n:payroll}",
        "accounts": 1,
        "mode": "read-only"
      },
      {
        "inst": "{n:hsa}",
        "accounts": 1,
        "mode": "read-only"
      }
    ],
    "heard": {
      "people": [
        "{n:me}, architect, S corp owner, Illinois",
        "{n:spouse}, veterinarian, sole proprietor",
        "{n:kid}, nine",
        "{n:kid2}, six"
      ],
      "entities": [
        "{n:biz}, S corp since 2024",
        "{n:spouseBiz}, sole proprietorship",
        "{n:w2}, part-time W-2 teaching job"
      ],
      "income": [
        "Your billings near {f:baseline} a month",
        "{n:spouse}’s practice near {f:sp_k1} a year",
        "Dividends from taxable accounts"
      ],
      "lifeEvents": [
        "Sabbatical, January to March 2027, unpaid",
        "Studio HELOC paid off in June",
        "CPA retired"
      ],
      "deadlines": 12,
      "questions": [
        "When does open enrollment close at {n:w2}?",
        "Is {n:spouse}’s SEP-IRA balance a rollover?",
        "How much delivered work is not invoiced yet?"
      ]
    },
    "priorities": [
      {
        "id": "tax_cash",
        "label": "Tax now vs flexible cash",
        "value": 0.55
      },
      {
        "id": "ret_life",
        "label": "Retirement vs lifestyle",
        "value": 0.45
      },
      {
        "id": "effort",
        "label": "Optimize vs leave me alone",
        "value": 0.6
      },
      {
        "id": "human",
        "label": "AI vs human",
        "value": 0.35
      }
    ]
  },
  "email": {
    "subject": "November: covered, with three decisions before Dec 31",
    "preheader": "Off-cycle payroll, invoice timing, and open enrollment.",
    "greeting": "Hi {n:me},",
    "sections": [
      {
        "heading": "Needs you",
        "items": [
          "Schedule the off-cycle payroll. Your {l:deferral} deferral has a hard Dec 31 deadline and needs {f:offcycle_cash} in business checking.",
          "Decide the fixed-fee invoice timing. Deferring saves about {f:defer_net} and helps the sabbatical months, but skip the November distribution if you do.",
          "Elect a Dependent Care FSA at open enrollment. About {f:dcfsa_save} a year."
        ]
      },
      {
        "heading": "Covered",
        "items": [
          "Estimated tax: {f:fed_paid} federal credited, January and April money earmarked.",
          "Investments: no gains realized this year, nothing to harvest.",
          "{n:spouse}’s SEP waits on her year-end books. We will ping you when they close."
        ]
      },
      {
        "heading": "What changed",
        "items": [
          "You told us about the sabbatical. We added three items and re-ran Q1 cash."
        ]
      }
    ],
    "footer": "Your next check-in with {n:advisor} is Thu, Dec 10. Reply to this email to ask anything; it goes to the same thread."
  },
  "packs": [
    {
      "id": "scorp",
      "name": "S corp owner",
      "status": "active",
      "why": "{n:biz} is an S corp and pays you W-2 wages.",
      "covers": [
        "Reasonable compensation",
        "Owner payroll and deferrals",
        "Distributions",
        "QBI wage limit",
        "Form 1120-S",
        "S elections"
      ],
      "entries": 41,
      "curator": "Partner tax team",
      "updated": "Oct 2026",
      "recIds": [
        "offcycle",
        "compmemo",
        "deferral",
        "spouseentity"
      ],
      "whatIf": {
        "prompt": "What if I raised my salary next year?",
        "a": [
          "Each step up buys 401(k) room at about 38 cents of tax per dollar, and keeps your comp defense strong if billings hold at {f:baseline} a month. Open the salary war game to see the whole curve."
        ],
        "unlocks": [
          {
            "title": "Salary war game",
            "text": "Pick a 2027 salary on the curve.",
            "recId": "compmemo"
          }
        ]
      }
    },
    {
      "id": "selfemp",
      "name": "Self-employed and partnership income",
      "status": "active",
      "why": "{n:spouse} has Schedule C income from {n:spouseBiz}, and both of you bill on a cash basis.",
      "covers": [
        "Self-employment tax",
        "SEP vs Solo 401(k)",
        "Quarterly estimates and safe harbor",
        "Cash-basis timing"
      ],
      "entries": 35,
      "curator": "Partner tax team",
      "updated": "Sep 2026",
      "recIds": [
        "spsep",
        "deferral",
        "reserve"
      ],
      "whatIf": {
        "prompt": "What if I invoiced everything in January?",
        "a": [
          "The 2026 tax drops by about {f:defer_2026} and 2027 rises by about {f:defer_2027}. The constraint is December payroll cash, not the tax code."
        ],
        "unlocks": [
          {
            "title": "Invoice timing war game",
            "text": "Pick an amount to defer.",
            "recId": "deferral"
          }
        ]
      }
    },
    {
      "id": "w2",
      "name": "W-2 benefits",
      "status": "active",
      "why": "Your {n:w2} teaching job offers benefits elections, including a dependent care FSA.",
      "covers": [
        "Open enrollment",
        "Dependent care FSA",
        "HSA",
        "Withholding"
      ],
      "entries": 18,
      "curator": "Partner planning team",
      "updated": "Oct 2026",
      "recIds": [
        "dcfsa",
        "hsa"
      ],
      "whatIf": {
        "prompt": "What if I stopped teaching?",
        "a": [
          "You would lose the only payroll that can carry a dependent care FSA. The S corp payroll cannot, because you own more than 2 percent of it."
        ],
        "unlocks": [
          {
            "title": "Childcare without the FSA",
            "text": "Would be added as a recommendation if you planned the change."
          }
        ]
      }
    },
    {
      "id": "illinois",
      "name": "Illinois resident",
      "status": "active",
      "why": "Your household files in Illinois.",
      "covers": [
        "Illinois estimates",
        "529 deduction",
        "SALT timing",
        "Replacement tax on S corps"
      ],
      "entries": 16,
      "curator": "Partner tax team",
      "updated": "Aug 2026",
      "recIds": [
        "vaq4",
        "va529"
      ],
      "whatIf": {
        "prompt": "What if we moved to another state?",
        "a": [
          "This pack would switch off and the new state pack would switch on. Part-year returns, a new 529 rule set, and a different estimate schedule."
        ],
        "unlocks": []
      }
    },
    {
      "id": "kids",
      "name": "Kids and dependents",
      "status": "active",
      "why": "Two kids at home, nine and six.",
      "covers": [
        "529 plans",
        "Childcare and the dependent care FSA",
        "Child tax credit",
        "Guardianship and life insurance"
      ],
      "entries": 24,
      "curator": "Partner planning team",
      "updated": "Oct 2026",
      "recIds": [
        "va529",
        "dcfsa",
        "babyprep"
      ],
      "whatIf": {
        "prompt": "What if we paid for private school later?",
        "a": [
          "529 money can pay K-12 tuition up to an annual cap. It would change how much you fund now versus later."
        ],
        "unlocks": []
      }
    },
    {
      "id": "retire",
      "name": "Advanced retirement",
      "status": "active",
      "why": "You both hold large pre-tax IRA balances and are above Roth income limits.",
      "covers": [
        "Backdoor Roth and pro-rata",
        "Rollovers into a Solo 401(k)",
        "Mega backdoor",
        "Required plan features"
      ],
      "entries": 29,
      "curator": "Partner planning team",
      "updated": "Oct 2026",
      "recIds": [
        "backdoor",
        "megabackdoor"
      ],
      "whatIf": {
        "prompt": "What if I did the backdoor Roth this December?",
        "a": [
          "With {f:my_pretax} still in pre-tax IRAs on Dec 31, most of the conversion would be taxable. Roll first, convert next year."
        ],
        "unlocks": []
      }
    },
    {
      "id": "giving",
      "name": "Charitable giving",
      "status": "suggested",
      "why": "You hold stock with a {f:conc_gain} embedded gain, and your itemized deductions are high this year.",
      "covers": [
        "Donor-advised funds",
        "Gifting appreciated stock",
        "Bunching deductions"
      ],
      "entries": 13,
      "curator": "Partner planning team",
      "updated": "Sep 2026",
      "recIds": [
        "daf"
      ],
      "whatIf": {
        "prompt": "What if we gave appreciated stock to a donor-advised fund this year?",
        "a": [
          "If you would give anyway, giving shares instead of cash skips the gain on what you give and gets the full deduction in a year you itemize. It also trims your taxable income inside the QBI phase-in.",
          "If you would not give anyway, it is not a tax strategy. Keep the pack off."
        ],
        "unlocks": [
          {
            "title": "Bunch giving into a donor-advised fund",
            "text": "Adds one recommendation with a Dec 31 window.",
            "recId": "daf"
          }
        ]
      }
    },
    {
      "id": "contractor",
      "name": "Building a staffed company",
      "status": "available",
      "why": "Your ten-year plan mentions hiring a junior designer at {n:biz} in 2028.",
      "covers": [
        "Hiring employees",
        "Plan coverage rules",
        "Payroll compliance",
        "Entity structure for growth"
      ],
      "entries": 26,
      "curator": "Partner tax team",
      "updated": "Jul 2026",
      "recIds": [],
      "whatIf": {
        "prompt": "What if {n:biz} hired employees?",
        "a": [
          "Retirement plans would have to cover employees, so the Solo 401(k) would stop working for you. Payroll, benefits and state registrations become real work, and the salary question changes shape."
        ],
        "unlocks": [
          {
            "title": "Entity plan for a staffed studio",
            "text": "Would be added when the hiring decision gets close."
          }
        ]
      }
    },
    {
      "id": "abroad",
      "name": "Extended time abroad",
      "status": "available",
      "why": "A semester abroad with the kids is in your plan for 2028.",
      "covers": [
        "International health insurance",
        "Foreign income rules",
        "Residency and state ties"
      ],
      "entries": 14,
      "curator": "Partner planning team",
      "updated": "Jun 2026",
      "recIds": [],
      "whatIf": {
        "prompt": "What if we spent a semester abroad?",
        "a": [
          "A few months away does not change residency, but client work done abroad can raise foreign tax questions, and your health plan may not travel."
        ],
        "unlocks": [
          {
            "title": "International health coverage",
            "text": "Research before the trip."
          }
        ]
      }
    },
    {
      "id": "rental",
      "name": "Rental real estate",
      "status": "available",
      "why": "Nothing in your data points here yet.",
      "covers": [
        "Depreciation",
        "Passive loss rules",
        "Short-term rental rules"
      ],
      "entries": 31,
      "curator": "Partner tax team",
      "updated": "Aug 2026",
      "recIds": [],
      "whatIf": {
        "prompt": "What if we bought a rental property?",
        "a": [
          "At your income, rental losses are mostly passive and suspended. It is an investment decision first and a tax decision a distant second."
        ],
        "unlocks": []
      }
    }
  ]
};
window.FATHOM_SCENARIO_SOURCE = 'synthetic';
