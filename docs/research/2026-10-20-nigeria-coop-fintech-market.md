# Nigeria's co-operative fintech market: sizing, competitors, and the compliance surface

**Date:** 20 October 2026
**Scope:** Nigerian co-operative (thrift & credit / SACCO-style) digitisation — market structure, competitor set, and the obligations a co-op operating platform must satisfy (corporate, AML/CFT, data protection, tax, payments boundary). Internet-sourced; every load-bearing claim is linked.
**Method note:** Nigeria has no single authoritative national co-operative registry, so sector counts are estimates from state registrar records and surveys. Treat the absolute numbers as order-of-magnitude, not census.

---

## 1. Market snapshot

| Signal | Value | Source |
|---|---|---|
| Registered co-operatives | ~30,000+ (largest sector in West Africa) | [Cooperatives.com — Nigeria](https://cooperatives.com/countries/nigeria) |
| Estimated membership | ~5–7 million | [Cooperatives.com — Nigeria](https://cooperatives.com/countries/nigeria) |
| Dominant type | Thrift & credit societies | [Cooperatives.com — Nigeria](https://cooperatives.com/countries/nigeria) |
| Formal financial inclusion | 64% (2023), up from 56% (2020) | [EFInA A2F 2023](https://efina.org.ng/research) |
| Financially excluded adults | 26% (2023), down from 32% (2020) | [EFInA A2F 2023](https://efina.org.ng/research) |
| Where borrowers go when short of cash | 29% family/friends, **22% co-operative society**, 19% loan app, 16% bank | [PiggyVest Savings Report 2025](https://www.piggyvest.com/reports/2025) |

**Reading it.** The addressable base is not "people who want a neobank" — it is the ~22% of surveyed savers who already treat a co-operative as their fallback lender, plus the ~26% still outside formal finance. Co-operatives are the incumbent informal institution in that gap. The product competition is therefore not against commercial banks; it is against WhatsApp groups, paper ledgers, Excel, and the treasurer's memory.

**Structural constraint.** Registration is decentralised: the federal Co-operative Societies Act (Cap C35 LFN 2004, descended from Decree No. 90 of 1993) sets the framework, but each of the 36 states has its own Co-operative Societies Act and registrar ([Cooperatives.com](https://cooperatives.com/countries/nigeria); [Co-operative Societies Act text](https://faolex.fao.org/docs/pdf/nig120579.pdf)). There is no national API, no single onboarding portal, and no shared member identity. Any platform that wants multi-state coverage must model "which registrar, which registration number, which state regime" as first-class data — which is exactly what the platform console's compliance metadata (`registrationNumber`, `TIN`, `CVN`, SCUML status) is for.

**Why now.** Three things changed recently:
1. Nigeria exited the FATF grey list on **24 October 2025**, which raises the expected compliance bar for every entity in the money chain, including co-op platforms ([NFIU Annual Report 2025](https://www.nfiu.gov.ng/AnnualReport)).
2. The NDPC's **GAID 2025** made data-controller registration concrete and cheap to trigger (see §3.3).
3. WhatsApp-native finance proved it can scale in this market: Xara crossed **₦10 billion** in transaction volume and **50,000 users** within roughly 300 days, bootstrapped ([Technext, June 2026](https://technext24.com/news/whatsapp-xara-crosses-%e2%82%a610-b-transaction)).

---

## 2. Competitive landscape

| Player | Positioning | What they actually sell | Relevance to a co-op console |
|---|---|---|---|
| **Xara** | WhatsApp-native "chat is your bank" | Payments, invoicing, P&L, payroll inside WhatsApp; crypto (USDC/USDT) top-ups via Solana | Not co-op-specific, but sets the UX expectation: no app download, conversational onboarding. The co-op product must meet that bar. [Technext](https://technext24.com/news/whatsapp-xara-crosses-%e2%82%a610-b-transaction) · [African Tech Journal](https://www.africantechjournal.com/articles/forget-saas-xara-runs-your-sales-payments-and-operations-on-whatsapp) |
| **Esusu Africa** | Cloud banking suite for group savings / esusu | Loan lifecycle, open-banking APIs, member accounts | Direct competitor for thrift & credit digitisation. [Tracxn](https://platform.tracxn.com/a/d/company/5dd6d66ff0e6f67c3c74cd31/electronic%20esusu) · [esusu.africa](https://esusu.africa) |
| **WBAfrica** | Core banking for co-operatives | Cloud core banking, Abuja-based | Competes on "bank-grade ledger" positioning. [Tracxn](https://platform.tracxn.com/a/d/company/5fca6c29cb44461beb8ece03/wbafrica) |
| **Coopify** | Co-op management + loan servicing | Member management, loan servicing for co-ops and lenders, Lagos, 2019 | Closest feature-for-feature analogue to a co-op back office. [Tracxn](https://platform.tracxn.com/a/d/company/5eb966333c737a24a7b6ae70/coopify) |
| **Asusu** | Co-op management software | Accounts, multi-branch, SMS/email alerts, USSD (*347*14#), payments, mobile app | Strong on offline/USSD reach; weak on platform-level governance. [asusu.ng](https://asusu.ng/index.html) |
| **Coopivo** | Digital co-op management | Member/savings/loan digitisation | Long-tail of small co-ops. [coopivo.com](https://coopivo.com/) |
| **Thrifto** | Digital ajo/esusu/adashe | Group creation, contribution tracking, payout scheduling; launched March 2026 | Targets ROSCA, not registered co-ops — adjacent, not identical, buyer. [TechEconomy](https://techeconomy.ng/thrifto-digital-ajo-esusu-savings-platform-nigeria) |
| **PiggyVest** | Consumer savings | Savings, invest, loans | Competes for the same wallet, not the same institution. [PiggyVest 2025 report](https://www.piggyvest.com/reports/2025) |

**White space.** Nearly every local player sells either (a) a co-op back office, or (b) a consumer savings app. Almost nobody sells **the platform layer**: multi-tenant provisioning, statutory-fund accounting, dividend runs, regulator reporting, and tenant isolation for many co-ops at once. That is the console's actual moat — the feature set this repo already has (provisioning, statutory rates, dividend previews/distribution, compliance metadata, per-co-op suspension, tenant-scoped queries) is the differentiator, not chat banking.

**Threat.** Xara-style conversational UX plus a co-op ledger is a plausible fast-follow. The defensible assets are the compliance ledger, audit trail, and registrar-specific metadata — not the chat interface.

---

## 3. Compliance surface

### 3.1 Corporate form and registration

| Question | Answer | Implication |
|---|---|---|
| Who registers a co-operative? | State Director/ Ministry of Co-operatives under the state Co-operative Societies Act (federal framework: Cap C35 LFN 2004) | The console must store the **state of registration** and the **registrar-issued number**; there is no CAC number for a co-op. |
| Can the platform be a "Cooperative Ltd"? | CAC restricts use of the word "Cooperative" in a company name without the Commission's consent | The operating company should be a normal limited company; co-ops are customers, not subsidiaries. [CAC Operations Checklists 2022](https://news.cac.gov.ng/wp-content/uploads/2022/05/Corporate-Affairs-Commission-Operations-Checklists-2022.pdf) |
| Does CAMA govern the co-op? | No — CAMA's Part F covers incorporated trustees/associations, not co-operatives; co-ops sit under the Co-operative Societies Act | Don't market "CAMA-compliant co-op"; the correct claim is "registered under the applicable state Co-operative Societies Act". The existing CAMA warning in the chat onboarding path is therefore directionally right but should name the state law. [Companies Regulations 2021](https://www.cac.gov.ng/wp-content/uploads/2021/01/COMPANIES-REGULATIONS-2021-published.pdf) |
| Annual filing | Financial year 1 Jan–31 Dec for Part F associations; co-ops file with their state registrar | Console needs an annual-return reminder per registrar, not a CAC tick-box. |

### 3.2 AML/CFT (the part that bites a payments-adjacent platform)

- **Cash limits.** No person or body corporate may make or accept a cash payment above **₦5,000,000 (individual)** or **₦10,000,000 (body corporate)** except through a financial institution ([MLPPA 2022, s.2](https://www.nfiu.gov.ng/LawsAndRegulations?fileName=Money+Laundering+%28Prevention+and+Prohibition%29+Act%2C+2022&filePath=C%3A%5CNFIU%5Cwwwroot%5Cdocuments%5CMLp_9GKCQR&handler=PreviewFile)).
- **Cross-border.** Transfers to/from abroad above **US$10,000** (or equivalent) must be reported; same threshold for cash/negotiable instruments carried across the border ([MLPPA 2022](https://www.nfiu.gov.ng/LawsAndRegulations?fileName=Money+Laundering+%28Prevention+and+Prohibition%29+Act%2C+2022&filePath=C%3A%5CNFIU%5Cwwwroot%5Cdocuments%5CMLp_9GKCQR&handler=PreviewFile)).
- **Reporting.** Threshold-based CTRs plus STRs/SARs go to the NFIU. In 2025 the NFIU received **41.7 million CTRs, 42,082 STRs and 10,513 SARs** ([NFIU Annual Report 2025](https://www.nfiu.gov.ng/AnnualReport)). Volume is dominated by DMBs; DNFBPs report through SCUML/RapidAML.
- **SCUML.** DNFBPs must register with SCUML, run AML/CFT/CPF programmes, do CDD, keep records, train staff annually, and file CTRs/CBTRs; the 2024 regulation (S.I. No. 39 of 2024) sets the regime ([SCUML/EFCC regulation](https://scuml.efcc.gov.ng/wp-content/uploads/2024/11/EFCC-SCUML-Anti-Money-Regulation.pdf)). Registration is free and only via the official portal ([SCUML guideline](https://scumlportal.efcc.gov.ng/SCUML%20Registration%20Guideline.pdf)).
- **Is a co-op a reporting entity?** A registered co-op collecting member savings is not a CBN-licensed deposit taker, so it is not a bank — but the platform operator may still fall in scope as a financial institution or DNFBP depending on whether it touches funds. **Treat this as a counsel question, not a product guess.** The safe design: the platform never holds member funds; a licensed PSP/collection account does, and the platform only records reconciled entries.

**What the code already does:** `classifyReport()` distinguishes CTR vs STR and carries ₦5m/₦10m/$10k constants; `flagTransaction`/`autoFileReport` file only on the correct trigger. **Gap:** there is no filing export/acknowledgement loop, no SCUML registration status workflow beyond a stored field, and no beneficial-ownership capture for corporate members.

### 3.3 Data protection (NDPA 2023 + GAID 2025)

| Obligation | Threshold / rule | Console implication |
|---|---|---|
| Registration as DCPMI | Controller/processor of "major importance" if it processes **>200 data subjects in 6 months**, or is in a listed sector / provides ICT services ([GAID 2025, Sch. 7](https://ndpc.gov.ng/wp-content/uploads/2025/03/NDP-ACT-GAID-2025-MARCH-20TH.pdf)) | Any real co-op platform is a DCPMI. Registration with NDPC is mandatory; the 200-subject trigger is trivially met. |
| DPO | Required for DCPMI | Must be a named, reachable person — expose in the console, not buried in a policy page. |
| Breach notification | Within **72 hours** of awareness; keep a breach register ([NDPA 2023, s.40](https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf)) | Needs an incident workflow with timestamps and evidence, not just logs. |
| DPIA | Required for high-risk processing; template in GAID Sch. 4 | Run before adding new data fields (BVN, bank details, biometrics). |
| Cross-border transfer | Permitted on adequacy or appropriate safeguards; GAID Sch. 5 guidance | Hosting/analytics outside Nigeria needs a documented basis. |
| Penalties | Greater of **₦10m** and **2% of prior-year gross revenue** (DCPMI); greater of ₦2m and 2% otherwise ([NDPA ss.48(4)–(5)](https://venvera.com/learn/ndpa/fines-and-penalties)) | Compliance is cheaper than one enforcement action. |
| Lawful basis / minimisation | Consent, contract, legal obligation, etc.; collect only what is needed | Phone is the identity key today — that is defensible, but BVN and bank data need their own basis. |

**What the code already does:** phone normalisation to E.164 at every write path, no `sessionPhone` spoofing, tenant-scoped queries, admin token revocation, audit rows on privileged actions. **Gaps:** no data-subject request (access/erasure/portability) endpoints, no retention/erasure schedule per data class, no consent record model, no DPO/NDPC registration fields on the platform tenant, no cross-border transfer register.

### 3.4 Tax

- A **registered co-operative society is exempt from Companies Income Tax** under s.73(2) of the Co-operative Societies Act, which exempts it from tax under s.26 CITA ([Act text](https://faolex.fao.org/docs/pdf/nig120579.pdf)); FIRS treats registered co-ops similarly to NGOs for tax purposes ([FIRS circular](https://assets.kpmg.com/content/dam/kpmg/ng/pdf/tax/firs-circular-on-taxation-of-ngos.pdf)).
- The exemption is **not** a blanket on trading income: where a co-op carries on a trade or business beyond member services, profits can be taxable ([BusinessDay](https://businessday.ng/business-economy/article/eight-organisations-exempt-from-companies-income-tax-in-nigeria)).
- The **platform company** is taxable on its SaaS fees. The console should therefore separate "co-op statutory reports" from "platform invoices" and never commingle ledgers.

### 3.5 Payments and the deposit-taking boundary

- Only banks, microfinance banks and (latterly) payment service banks are licensed to take deposits from the public; unlicensed deposit canvassing is an offence under BOFIA ([CBN notice](https://www.cbn.gov.ng/OUT/PUBLICATIONS/GUIDELINES/OFID/2008/OFID-04-2008.PDF)).
- A co-op may pool **members'** savings on a common-bond basis, but must not advertise deposit-taking to the general public or promise returns. The platform's marketing copy and onboarding must make the membership gate explicit.
- CBN's revised cash policies from **1 January 2026** abolished the cumulative deposit cap and set weekly withdrawal ceilings of **₦500,000 (individual)** and **₦5m (corporate)**, with excess charges ([ICIR](https://www.icirnigeria.org/cbn-scraps-deposit-limits-increases-weekly-withdrawal-threshold)). Cash-heavy co-ops will feel this; the product should push electronic rails and flag cash patterns.
- Practical architecture: licensed PSP virtual accounts per member, webhook reconciliation, platform never custodies funds. That is also the cleanest AML story.

---

## 4. What this means for the console

**Already right (keep and market):**
1. **Statutory-fund accounting** — reserve 25%, education 10%, development 5% resolved from config per co-op, not hardcoded. This is the single hardest thing for a spreadsheet to get right and the first thing a regulator asks about.
2. **Dividend preview → approval → distribution** with a hard cap and bank payouts; auditable and reproducible.
3. **Compliance metadata per co-op** — registration number, TIN, CVN, SCUML status, DPO contact. This is the seed of a "registrar-ready" profile.
4. **Tenant isolation and admin-token revocation** — a suspended co-op's admins lose access immediately, and scheduled jobs skip suspended tenants.
5. **Phone as canonical identity**, normalised on every write path — the precondition for deduplication across co-ops.

**Next three compliance bets (in order of leverage):**
1. **Registrar pack.** Generate a per-co-op annual return PDF: member count, savings, loans, statutory funds, dividends, AGM date. No competitor does this well, and it converts the console from "software" to "compliance infrastructure".
2. **NDPA operations.** DSR endpoints (access/erasure/export), consent records per purpose, retention rules per data class, and a breach register with 72-hour timers. Cheapest way to de-risk the largest fine exposure.
3. **AML evidence.** Keep `classifyReport`, add a filing log (who filed what, when, acknowledgement ID), sanctions-list refresh with a timestamp, and a cash-threshold alert for contributions above ₦5m/₦10m. Do not become the filer unless counsel confirms the platform is the reporting entity.

**Do not build:** a wallet that custodies member funds, "interest" or "returns" marketing language, or a public deposit-taking flow. Those cross the BOFIA line and would turn a SaaS business into an unlicensed deposit taker.

---

## 5. Open questions to resolve with counsel

1. Is the platform operator a "financial institution" or DNFBP under MLPPA 2022 when it only records (never holds) funds? The answer determines NFIU vs SCUML filing.
2. Does a multi-state co-op need separate registration per state, and how should the console model dual membership?
3. For chat-provisioned co-ops without a registration number, is a "pending registration" state acceptable to registrars, or does it create liability for the platform?
4. Which entity signs the NDPC registration — the platform, each co-op, or both as joint controllers? The GAID's joint-controller guidance matters here.
5. Cross-border hosting: is an adequacy finding available for the chosen cloud region, or is a safeguard (SCC-like) instrument required?

---

## Sources

1. Cooperatives.com — [Cooperatives in Nigeria](https://cooperatives.com/countries/nigeria)
2. EFInA — [Access to Financial Services in Nigeria 2023](https://efina.org.ng/research) · [A2F 2023 highlights](https://efina.org.ng/wp-content/uploads/2024/03/A2F-2023-Event-Day-Presentation-Version4-1.pdf)
3. PiggyVest — [Savings Report 2025](https://www.piggyvest.com/reports/2025)
4. Nigerian Co-operative Societies Act (Cap C35 LFN 2004) — [FAO Lex text](https://faolex.fao.org/docs/pdf/nig120579.pdf)
5. CAMA 2020 / Companies Regulations 2021 — [CAC](https://www.cac.gov.ng/wp-content/uploads/2021/01/COMPANIES-REGULATIONS-2021-published.pdf) · [CAC Operations Checklists 2022](https://news.cac.gov.ng/wp-content/uploads/2022/05/Corporate-Affairs-Commission-Operations-Checklists-2022.pdf)
6. MLPPA 2022 — [NFIU](https://www.nfiu.gov.ng/LawsAndRegulations?fileName=Money+Laundering+%28Prevention+and+Prohibition%29+Act%2C+2022&filePath=C%3A%5CNFIU%5Cwwwroot%5Cdocuments%5CMLp_9GKCQR&handler=PreviewFile)
7. SCUML — [AML/CFT/CPF Regulations 2024 (S.I. 39 of 2024)](https://scuml.efcc.gov.ng/wp-content/uploads/2024/11/EFCC-SCUML-Anti-Money-Regulation.pdf) · [Registration guideline](https://scumlportal.efcc.gov.ng/SCUML%20Registration%20Guideline.pdf)
8. NFIU — [2025 Annual Report](https://www.nfiu.gov.ng/AnnualReport)
9. NDPA 2023 — [NDPC text](https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf) · [GAID 2025](https://ndpc.gov.ng/wp-content/uploads/2025/03/NDP-ACT-GAID-2025-MARCH-20TH.pdf) · [penalty analysis](https://venvera.com/learn/ndpa/fines-and-penalties)
10. FIRS — [tax treatment of NGOs and co-operatives](https://assets.kpmg.com/content/dam/kpmg/ng/pdf/tax/firs-circular-on-taxation-of-ngos.pdf) · [BusinessDay on CITA exemptions](https://businessday.ng/business-economy/article/eight-organisations-exempt-from-companies-income-tax-in-nigeria)
11. CBN — [notice on unlicensed deposit canvassing](https://www.cbn.gov.ng/OUT/PUBLICATIONS/GUIDELINES/OFID/2008/OFID-04-2008.PDF) · [ICIR on 2026 cash policy](https://www.icirnigeria.org/cbn-scraps-deposit-limits-increases-weekly-withdrawal-threshold)
12. Competitors — [Xara (Technext)](https://technext24.com/news/whatsapp-xara-crosses-%e2%82%a610-b-transaction) · [Esusu Africa](https://esusu.africa) · [WBAfrica (Tracxn)](https://platform.tracxn.com/a/d/company/5fca6c29cb44461beb8ece03/wbafrica) · [Coopify (Tracxn)](https://platform.tracxn.com/a/d/company/5eb966333c737a24a7b6ae70/coopify) · [Asusu](https://asusu.ng/index.html) · [Coopivo](https://coopivo.com/) · [Thrifto (TechEconomy)](https://techeconomy.ng/thrifto-digital-ajo-esusu-savings-platform-nigeria)
