# Classify household spending

Tax year: 2026

Reviewed: 2026-11-07

Every household-bucket category maps to one spending class. Other buckets map to their own class. Essential spending is housing, debt_service, healthcare, childcare and essential_other. Discretionary spending is the discretionary class. The remaining classes are unclassified, savings, taxes, business, income, transfer and excluded. Savings, taxes, business, income, transfer and excluded are not household spending.

Built-in definitions, with no arithmetic in this entry: household_spending is the spending measure and has no selectors. essential includes classes housing, debt_service, healthcare, childcare and essential_other. discretionary includes class discretionary. core_living excludes class debt_service and bucket tax, which is what an independence target should cover once the mortgage is paid off.

housing covers aggregator category Home & Garden. The demo seed has no housing-class category. Home & Garden is rent, upkeep, HOA, and escrowed property tax and insurance.

debt_service covers aggregator category Mortgage and demo-seed category housing. The demo's housing rows are mortgage payments. A mortgage payment is debt service. Its interest share is a housing cost and its principal share is saving. When only the payment is known, the whole payment is debt_service.

healthcare covers aggregator categories Medical, Healthcare Premiums and Health & Wellness, and demo-seed category health. Health & Wellness can hold gym memberships. A saved definition can move it.

childcare covers aggregator categories Childcare and Family Care, and demo-seed category childcare.

essential_other covers aggregator categories Groceries, Bills & Utilities, Auto & Transport, Pets, Fees and Legal, and demo-seed categories groceries and utilities.

discretionary covers aggregator categories Shopping, Dining & Drinks, Entertainment & Rec., Travel & Vacation, Software & Tech, Personal Care, Gifts and Charitable Donations, and demo-seed category dining. Giving is discretionary for spending even when it is deductible.

unclassified covers aggregator categories Uncategorized and Cash & Checks, and demo-seed category Uncategorized. Report it as a gap with its amount.

savings covers aggregator categories Investment, Mortgage Principal and HSA. Savings is not spending. The demo seed has no savings category.

taxes covers aggregator categories Income Tax and Taxes. Taxes are not spending. They are estimated payments and balances due. The demo seed has no taxes category.

business covers aggregator category Business and demo-seed categories payroll, software, contractors and fees. Follow the business bucket.

income covers aggregator category Income and demo-seed category income. Follow the income bucket.

transfer covers aggregator categories Credit Card Payment, Internal Transfers and Savings Transfer, and demo-seed category transfer. Follow the transfer bucket.

excluded covers aggregator category Ignore. Follow the excluded bucket.

Sources: [IRS Publication 936: home mortgage interest](https://www.irs.gov/publications/p936), [IRS Publication 503: child and dependent care](https://www.irs.gov/publications/p503).
