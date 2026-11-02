# Commodity credit in Nigerian co-operatives — research notes

Date: 2026-11-02
Scope: why the commodity-credit scheme is shaped the way it is, and which local
rules and risks the implementation has to respect.

## 1. Legal basis for payroll deduction

The Co-operative Societies Act (as amended, 2004) is the federal baseline for
registered societies. It requires bye-laws covering loans to members — maximum
amount, maximum repayment period, interest, permitted purposes and default
consequences — before a society may lend ([Act text](https://faolex.fao.org/docs/pdf/nig120579.pdf),
s. 11(3)). It also deals with employer remittance: where an employer deducts a
member's contribution under the member's instruction, the employer must remit
within seven days of the deduction ([Co-operative Societies Act (Amended) 2004](https://www.oerafrica.org/system/files/2024-01/cooperative-societies-act-2004_0.pdf)).
Lagos State publishes its own consolidated Acts & Rules, which is the version
most Lagos-based societies operate under ([Lagos State Cooperative College](https://lascoco.lagosstate.gov.ng/package/co-operative-societies-acts-rules-pdf-2/)).

Practical consequence for this codebase: the scheme must be backed by an
explicit, per-member instruction and the co-op must treat unremitted payroll as
a receivable, not as cash. That is why the bank-cash gate blocks supplier
purchases until reconciled cash covers the order, and why shortfalls are
attributed and rolled forward rather than silently absorbed.

## 2. Payroll deduction is politically and legally fragile

Zamfara State suspended all non-statutory deductions — naming co-operative and
commodity-vendor deductions — from civil-service salaries in November 2024 after
complaints about unauthorised deductions ([The Guardian Nigeria](https://guardian.ng/news/zamfara-bans-cooperative-deductions-others-from-salaries/)).
The National Industrial Court has also enforced an unwritten tripartite
employer/co-op deduction agreement, awarding N112.4m in unremitted dues plus
interest ([NICN judgment](https://www.nicnadr.gov.ng/judgement/judgement.php?id=9622)).

Implications:

- Deductions need a recorded consent/instruction trail, not a verbal
  arrangement.
- The co-op should be able to pause a scheme when an employer stops remitting.
- Remittance status must be visible to members, because the member carries the
  credit risk if payroll fails.

## 3. Local market practice for consumer/commodity schemes

A large Nigerian staff co-operative (9mobile's ESMCS) publishes representative
terms for appliance and grocery schemes ([ESMCS consumer schemes](https://esmcs.com/consumer-schemes/)):

- six consecutive months of contributions before eligibility;
- purchases capped at 150% of cumulative contribution (devices capped at
  contribution);
- repayment strictly by payroll over at most six months;
- a 33.3% debt-service-ratio policy;
- a flat co-operative interest charge (5% on the device scheme);
- exclusions for land, buildings and automobiles;
- requests processed weekly, with a no-cancellation rule after approval.

These match the design choices already in the code: subscription is capped by an
uploaded payroll schedule, conversion produces a `Loan(kind=commodity)` repaid
by payroll instalments, and the scheme window opens and closes on a schedule.

## 4. Tax and regulatory treatment

Co-operatives are generally exempt from tax on member-facing activity, but pay
tax on profits from business outside co-operative activities; they also enjoy
stamp-duty and registration exemptions on instruments relating to the society's
business ([Coops4Dev Nigeria legal framework](https://coops4dev.coop/sites/default/files/2020-03/Nigeria%20Legal%20Framework%20Analysis%20Report.pdf)).
The 2025 tax reform keeps incentives for co-operatives whose earnings do not come
from commercial activity ([BBC News](https://www.bbc.com/news/articles/czdvnmz0j9go)).
The Nigeria Tax Administration Act 2025 is the operative procedural statute from
2026 ([TAT 2025](https://tat.gov.ng/Nigeria-Tax-Act-2025.pdf)).

Implication: the scheme should be recorded as a member benefit, not presented as
a trading business. Supplier purchases and any margin should be separately
reported so the co-op can show which activity is member-facing and which is
commercial.

## 5. Data protection

The Nigeria Data Protection Act 2023 requires a lawful basis, specific-purpose
consent, notice of recipients and retention, and a right to withdraw consent for
personal data ([NDPA 2023](https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf)).
Sensitive data needs explicit consent unless another narrow basis applies.

Implication: payroll schedules contain salary and bank data. Upload and
processing should be tied to the member's instruction, access should be
role-scoped, and the data should be purged or minimised once reconciliation is
complete. This aligns with the existing tenant scoping and audit logging in the
service.

## 6. Design checks that follow from the research

1. **Consent before deduction** — keep an auditable member instruction; do not
   treat app usage as consent.
2. **Cash before purchase** — never let reconciled cash be assumed; the bank-cash
   gate and audited override stay.
3. **Cap by contributions** — cap subscriptions by the uploaded payroll schedule
   and make the cap visible to the member.
4. **Explicit default path** — attribute shortfalls per member, apply priority
   (loan → commodity → savings) and roll forward, instead of blocking the whole
   batch.
5. **Employer risk** — surface remittance/payroll failure as a scheme-level
   pause, not just a member-level error.
6. **Data minimisation** — collect only what reconciliation needs and purge
   schedules after use.

## Sources

- [Co-operative Societies Act (Amended) 2004 (PDF)](https://www.oerafrica.org/system/files/2024-01/cooperative-societies-act-2004_0.pdf)
- [Nigerian Co-operative Societies Act (FAOLEX PDF)](https://faolex.fao.org/docs/pdf/nig120579.pdf)
- [Lagos State Co-operative Acts & Rules](https://lascoco.lagosstate.gov.ng/package/co-operative-societies-acts-rules-pdf-2/)
- [The Guardian Nigeria — Zamfara bans cooperative deductions](https://guardian.ng/news/zamfara-bans-cooperative-deductions-others-from-salaries/)
- [National Industrial Court — Oredo LGC staff v. Oredo LGC](https://www.nicnadr.gov.ng/judgement/judgement.php?id=9622)
- [ESMCS consumer schemes](https://esmcs.com/consumer-schemes/)
- [Coops4Dev — Nigeria legal framework analysis](https://coops4dev.coop/sites/default/files/2020-03/Nigeria%20Legal%20Framework%20Analysis%20Report.pdf)
- [Nigeria Data Protection Act 2023](https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf)
- [Nigeria Tax Administration Act 2025](https://tat.gov.ng/Nigeria-Tax-Act-2025.pdf)
- [BBC — Nigeria tax reform 2025](https://www.bbc.com/news/articles/czdvnmz0j9go)
