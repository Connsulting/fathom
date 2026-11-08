# Separate a mortgage payment from housing that continues

Tax year: 2026

Reviewed: 2026-11-08

A mortgage payment is debt service. Interest may be a housing cost under the home mortgage interest rules. Principal is saving, not spending. When the ledger has only the payment, classify the whole payment as debt service.

The obligation ends at a stated payoff date. If that date is absent, amortization of balance, rate and payment can derive it. With exactly one active mortgage loan account, Fathom can infer the balance from its newest snapshot, the payment from transactions matched to that loan or its payee, and a fixed rate from at least three months of consecutive balance changes and payments. Every inferred term is a named assumption with its stored-row sources and an invitation to correct it. All debt payments combined are not a mortgage payment.

Escrow continues as housing after the mortgage payoff. The household fact obligations.mortgage.escrowMonthly is required and may be zero. That amount continues as housing. Escrowed property tax and insurance do not end when the loan does.

Escrow cannot be inferred. If it is unknown, ask for escrow alone when the other terms are available. A provisional payoff assumes loan payment credits exclude escrow, or that matched payee payments are principal and interest; disclose that assumption. The spending projection waits for stated escrow before applying the mortgage change and removes only matched mortgage payments included in its spending base.

Sources: [IRS Publication 936: home mortgage interest](https://www.irs.gov/publications/p936).
