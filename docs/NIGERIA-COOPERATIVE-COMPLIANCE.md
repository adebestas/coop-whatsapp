# Nigeria Cooperative Standards & Compliance Report

Status: research briefing (deliverable A). Date: 2026-10-17.
Purpose: ground the coop-whatsapp platform in the legal, regulatory and operational
standards for Nigerian thrift & loan / credit cooperatives, and map those standards to
concrete product requirements.

> Sourcing: web search + direct fetches of primary/agency sources (PLAC, FAOLEX, FMAFS,
> NFIU, SCUML/EFCC, NDPC, FCCPC, CBN, WOCCU, World Bank). Each key claim carries a source
> URL and date. Anything uncertain is listed in §7 and must be re-verified before
> publication or a compliance filing.

---

## 1. Legal & regulatory framework

- **Primary statute:** Nigerian **Co-operative Societies Act, Cap. N98, LFN 2004** (originally
  No. 90 of 1993) — registration and operation of co-operative societies federation-wide.
  It is a **framework law**; operative detail (reserve %, committee structure, surplus
  appropriation) lives in **registered bye-laws** + **state laws**, so rules vary by state.
  (PLAC: https://placng.org/lawsofnigeria/view2.php?sn=356 ; FAOLEX:
  https://faolex.fao.org/docs/pdf/nig120579.pdf)
- **Who supervises:** **State** Governors appoint each **Director of Co-operatives**;
  registration, bye-law approval, audit oversight, inquiry, liquidation and dispute
  handling are done at **state** level (Act ss.1(2), 5–6, 36–38, 49). At federal level the
  President appoints a **Federal Director of Co-operatives** (s.1(1)); the cooperative
  mandate now sits under the **Federal Ministry of Agriculture & Food Security (FMAFS)**.
  (FMAFS, 2026-08-13:
  https://agriculture.gov.ng/fg-signs-mou-to-deploy-national-cooperative-digital-identity-system-announces-6-month-revalidation-for-all-cooperatives)
- **There is no federal "Cooperative Societies Commission" in force** as of Oct 2026.

### 2024–2026 reform context (active, evolving)
- **RH-CRRP 2030**: On **2026-08-12** FMAFS signed an MoU with the Cooperative Federation of
  Nigeria and Seamfix to deploy the **National Cooperative Digital Architecture Platform
  (NCDAP)** — a **National Cooperative Smart Registry (NCSR)**, a **Cooperative Verification
  Number (CVN)** per society, and a **CoopID** per member. (FMAFS, 2026-08-13, above)
- A **6-month National Revalidation & Re-certification Exercise** for **all** cooperatives,
  run through **State Departments of Cooperatives**. (FMAFS, 2026-08-13)
- A **harmonised Cooperative Societies Bill** (full repeal & re-enactment) is being drafted
  to recognise **digital registration, electronic records, identity, data governance and
  fintech**. As of Oct 2026 it is a **directive/plan, not enacted law**.
- Policy direction: cooperatives as an **agricultural financing / value-chain engine**.
  (BusinessDay, 2026-04-09:
  https://businessday.ng/agriculture/article/fg-targets-cooperatives-as-financing-value-chain-engine-in-agriculture-reset)

### CBN boundary
- Cooperatives are **outside CBN's direct regulatory perimeter**. CBN's Microfinance Policy
  treats credit-only, membership-based institutions (incl. financial cooperatives) as
  **"supervised by the appropriate Ministry"**; a cooperative wanting to be a Microfinance
  Bank must incorporate/transform into an **MFB** and be CBN-licensed. The Act states the
  **Money Lender's Law of a State does not apply** to a registered society (s.55(1)).
  (CBN Microfinance Policy Framework, 2005;
  https://www.cbn.gov.ng/OUT/PUBLICATIONS/GUIDELINES/DFD/2006/MICROFINANCE%20POLICY.PDF)
- **Name restriction:** the word **"bank" is prohibited** in a cooperative's name except a
  central financing society (Act s.3(6)); names must contain "Co-operative" and end with
  "Limited" (ss.3(4)–(5)).
- **SEC boundary:** cooperatives **soliciting public investment** can be treated as
  **unregistered investment schemes** (SEC warned against two named cooperatives,
  2025-01-26: https://businessday.ng/news/article/sec-warns-nigerians-against-unregistered-investment-platforms).

### Data protection (NDPA 2023 / NDPR)
- **Nigeria Data Protection Act, 2023 (Act No. 37)**, commenced **2023-06-12**, created the
  **Nigeria Data Protection Commission (NDPC)**. (https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf)
- **Registration duty:** a controller/processor is "of major importance" if it keeps/accesses
  a filing system and **processes personal data of more than 200 data subjects in 6 months**
  (or meets other sector/threshold criteria incl. financial). Fees: **₦250,000 (Ultra-High),
  ₦100,000 (Extra-High), ₦10,000 (Ordinary High)**. (NDPC Updated Guidance Notice, dated
  2024-12-19: https://ndpc.gov.ng/wp-content/uploads/2025/07/Updated-Guidance-Notice-on-Registtration-2024.pdf)
- Duties: appoint a **DPO**, keep breach records, file **annual audit compliance returns**
  via a licensed **DPCO**. (NDPA 2023 ss.32–37; https://ndpc.gov.ng/dpco-registration-requirements/)

### Consumer protection (FCCPC)
- **Digital, Electronic, Online or Non-Traditional Consumer Lending Regulations, 2025
  ("DEON")**, issued **2025-09-03**; digital lenders must register with FCCPC, with rules on
  transparency, fair interest, data privacy, and a ban on unethical recovery; penalties up to
  **₦100 million or 1% of turnover**; director disqualification up to 5 years. FCCPC resumed
  DEON enforcement **2026-07-20**. (https://fccpc.gov.ng/digital-lending-fccpc-tackles-abuses-issues-landmark-regulations/)
- **Relevance:** member-only cooperative credit may be **outside** DEON (which targets
  consumer lending); app/USSD/online lending to **non-members** would be captured.

---

## 2. Statutory requirements for a registered cooperative (Act Cap. N98)

**Formation & bye-laws**
- Primary society: **≥10 qualified persons** (s.3(1)); industrial **≥6** (s.3(2)); secondary
  **≥5 registered societies** (s.3(3)). Name rules per §1 (s.3(4)–(6)); nominal registration
  fee ₦100 (s.3(8), outdated). Registration decided within **60 days** (s.5(3)).
- **Mandatory bye-law contents** (s.11(2)): name/address, objects, area of operation,
  membership qualifications, custody/investment of funds, liability, share capital, general
  meetings, committees (appointment/removal/powers), and **disposal of annual surplus**.
- **Lending bye-laws must fix** (s.11(3)): **interest rate, maximum loan per member, maximum
  repayment period, extension terms, loan purposes, and default consequences.**
- Bye-law amendments are **invalid until registered** (s.12). A registered society is a
  **body corporate**; affairs administered by a **committee** appointed by members (s.6).

**Membership & shares**
- Minimum age **16** (s.22(1)(a)). **One member, one vote** (chairman has casting vote, s.25).
- A member cannot belong to more than one society whose primary object is lending without
  consent (s.24). **No member (other than a registered society) may hold more than one-fifth
  of the share capital** (s.27). Rights exercisable only after required payments (s.23).

**Funds, reserve & surplus**
- Funds invested only in a Cooperative/approved bank, Federal Government securities, or as the
  committee approves (s.33). **Loans only to members** (consent needed to lend to another
  society) (s.30).
- **Reserve fund ≥ one-fourth (25%) of net profits** as per the audit report; Director may
  reduce for limited-liability societies (s.34(2)). **Education fund up to 10%** of the
  remainder with Director approval (s.34(3)).
- **No dividend/bonus/distribution except as provided and only after committee approval**
  (s.34(1)). Registered societies are **exempt from Companies Income Tax (s.26 CITA)** and
  from stamp/registration duties (s.20).
- **Liquidation priority:** costs → liabilities → **share capital** → dividend (if permitted)
  at **not more than 5% per annum** (s.44).
- **Member security:** the society has a **first charge** over a member's produce/interest and
  a **set-off** against shares/deposits/dividends for debts due (ss.15–16); shares are
  otherwise not liable to attachment for personal debts (s.17).

**Audit & returns**
- **Annual audit** by an approved auditor, covering **overdue debts + asset/liability
  valuation**, and reporting P&L, balance sheet, financial position, management, overdue
  debts, disposal of profit, benefits-in-kind to the CEO, and verification of cash/securities
  (s.36). The Director may prescribe returns (s.36(7)) and has access to all books/cash
  (s.36(6)); may **inquire/inspect** on request of the committee majority or ≥1/3 of members
  (s.37) and **surcharge** officers for misapplication (s.46).

**Member register & data**
- Keep the Act/bye-laws/**register of members open to free inspection** (ss.8, 13). Under
  NDPA 2023 the cooperative is a **data controller** (lawful basis/consent, security, breach
  handling, DPO; NDPC registration above thresholds).

**Typical appropriation split** (state/bye-law specific): the federal floor is reserve ≥25%;
common bye-laws add education ~2.5–7%, dividends ~50%, honoraria ~5%, general reserve. Example
(NFIU Staff Cooperative bye-law, 2020): 25% reserve, 7% education, 1% audit/supervision,
7.5% honorarium, 2% retained earnings, 4.5% meeting expenses.
(https://www.nfiu.gov.ng/NFIUCooperative/Files/NFIUCOOP%20BYE%20LAW.pdf)

---

## 3. AML/CFT obligations (NFIU / SCUML)

- **MLPPA 2022** (Money Laundering (Prevention & Prohibition) Act, in force 2022-05-12) and
  **TPPA 2022** drive reporting; STR duty is **MLPPA s.7**; DNFBP list is **MLPPA s.30**.
  (GIABA/FATF Nigeria Follow-Up Report, 2023-01-29)
- **STR — Suspicious Transaction Report: NO monetary threshold.** File for *any* suspicious
  transaction/activity, **within 24 hours**. (**Do not hard-code a ₦5M STR threshold.**)
- **CTR — Currency Transaction Report (threshold-based):** cash transactions **≥₦5,000,000
  (individuals)** and **≥₦10,000,000 (corporate bodies)**; plus **≥$10,000** (or equivalent)
  transfers to/from a foreign country. (NFIU FAQ: https://www.nfiu.gov.ng/Faqs ; CBN
  AML/CFT/CPF Regulations 2022 reg.40)
- **SAR** (non-transactional, e.g. refusal to provide KYC). Filing via **goAML/RapidAML**;
  max 500 transactions per STR. (NFIU FAQ)
- **SCUML** (under EFCC) registers/supervises DNFBPs; registration is **free**, before
  commencing business (MLPPA s.30; S.I. No. 39 of 2024, gazetted 2024-10-30:
  https://scuml.efcc.gov.ng/wp-content/uploads/2024/11/EFCC-SCUML-Anti-Money-Regulation.pdf).
  SCUML's category list (2025/2026) does **not** name cooperatives. DNFBP large-transaction
  filings to SCUML are weekly with **₦50,000 per unreported transaction per day** penalty.
- **NFIU context:** Nigeria exited the **FATF Grey List on 2025-10-24**. (NFIU 2025 Annual
  Report, published 2026-07-02: https://www.nfiu.gov.ng)

---

## 4. Operational best practices (thrift & loan cooperatives)

- **Savings → lending norms** (CPEC-style): minimum membership period (often **3 months**);
  **loan entitlement as a multiple of savings (commonly 2:1, up to 3:1)**; a **member
  guarantor/co-signor with sufficient savings** or tangible collateral. (World Bank,
  "Sustainable Banking with the Poor," 2000-09-13)
- **Guarantors:** member guarantors whose savings are pledged; limit **active loans per
  guarantor** (the reviewed project enforces max 2).
- **Default consequences** must be in bye-laws (Act s.11(3)); society has **first charge +
  set-off** (ss.15–16).
- **Provisioning / write-off (WOCCU PEARLS):** loan-loss allowance should cover **100% of
  loans delinquent >12 months** and **35% of loans 1–12 months**. Total delinquency / total
  loan portfolio target **<1%**. Effective-structure targets: loans/assets ≥50%,
  deposits/assets ~70–80%, institutional capital/assets ≥10%. (WOCCU PEARLS Monograph:
  https://www.woccu.org/documents/pearls_monograph)
- **Rates of return:** monthly % on loans; dividends on share equity; liquidation dividend
  capped at 5% p.a. (Act s.44(d)).
- **Delinquency management:** guarantor pledges + payroll/standing-order deduction + first
  charge + statutory arbitration (Act ss.15, 49).

---

## 5. Governance standards

- Affairs managed by a **committee appointed by members** (s.6(2)); bye-laws set appointment,
  suspension, removal, powers, duties (s.11(2)(k)).
- Typical structure: **Management (executive) Committee**, **Internal Audit Committee**
  (meets ≥4×/year), **Supervisory Committee**, and **Credit Committee** (loan approval) —
  with **separation of duties** between approval, audit/supervisory, and day-to-day
  management. (NFIU Staff Coop bye-law, 2020)
- **General meetings** (AGM) and committee meetings are bye-law prescribed (s.11(2)(j));
  member rights: one member one vote (s.25); free inspection (s.13).
- **Dispute resolution:** internal → Director/arbitrator → appeal to Minister/Commissioner
  within 30 days (s.49); statutory arbitration excluded from the Arbitration and Conciliation
  Act (s.55(2)).
- **Apex term limits:** no individual in more than two national/state apex bodies; terms ≤ two
  × four years (s.26(2)).

---

## 6. Product requirements derived from the above

Mapped to coop-whatsapp. Status legend: ✅ present, ⚠️ partial, ❌ missing.

| # | Requirement | Source | Status |
|---|---|---|---|
| R1 | Per-coop **state** + **registration number**; support **CVN** (society) and **CoopID** (member) fields for the 2026 NCSR revalidation | Act ss.3–5; FMAFS 2026-08-13 | ⚠️ (`registrationNumber` warning only) |
| R2 | Enforce **name** rules (contains "Co-operative", no "bank") | Act s.3(4)–(6) | ❌ |
| R3 | Lending bye-law terms must be configurable: **interest rate, max loan per member, max repayment period (duration), extension, purposes, default consequences** | Act s.11(3) | ⚠️ (rate yes; **duration/max-loan missing**) |
| R4 | **Reserve fund ≥25%** of net profit before dividends; **education fund ≤10%** of remainder | Act s.34 | ⚠️ (reserve exists as balance; no % rule/engine) |
| R5 | **Dividends** only after committee approval; liquidation dividend ≤5% p.a. | Act ss.34(1), 44(d) | ⚠️ |
| R6 | **Loans only to members**; **loans = 2–3× savings**; min membership period | Act s.30; World Bank 2000 | ✅/⚠️ (multiplier configurable; membership period missing) |
| R7 | **One member, one vote**; no member > 1/5 share capital | Act ss.25, 27 | ⚠️ (voting by member; share cap not enforced) |
| R8 | **STR: no threshold, file ≤24h**; **CTR ≥₦5M individual / ≥₦10M corporate**; **$10k cross-border** | MLPPA s.7; NFIU FAQ | ❌ (app labels ≥₦5M as "STR") |
| R9 | **SCUML registration status** tracking; weekly large-transaction filings | S.I. 39/2024 | ❌ |
| R10 | **PEARLS provisioning** (100% >12mo, 35% 1–12mo) + **delinquency ratio ≥ monitoring** | WOCCU PEARLS | ⚠️ (`provisionRates` exist; delinquency ratio not surfaced) |
| R11 | **Governance committees** (credit/supervisory/board + internal audit), separation of duties, sizes | Act s.11(2)(k); NFIU 2020 | ✅/⚠️ (3 committees; internal-audit committee missing) |
| R12 | **NDPA**: consent/lawful basis, DPO, breach log, NDPC registration when **>200 subjects/6mo**, annual return | NDPA 2023; NDPC 2024-12-19 | ⚠️ (consent types partial; DPO/NDPC fields missing) |
| R13 | **DEON**: if lending to non-members digitally, FCCPC registration + fair-interest/ethical-recovery rules | FCCPC 2025 | ❌ (out of member-only scope today) |
| R14 | **Annual audit pack** (overdue debts, asset/liability valuation) + regulator returns | Act s.36 | ⚠️ (regulator reporting exists; audit pack partial) |

**Two concrete bugs surfaced by this research (fixed in Phase 2):**
1. **AML mislabeling** — the app files **≥₦5M auto-reports as "STR"**. STR has **no
   threshold**; the ₦5M/₦10M figures are **CTR** thresholds. Wrong report type + wrong logic.
2. **Rule validation gap** — most `setconfig` numeric rules have **no bounds**, allowing
   misconfiguration (e.g. interest rate, ratios). Fixed by the typed rule registry.

---

## 7. Uncertain / needs verification

1. Whether a thrift & loan cooperative is a **"financial institution"** under MLPPA 2022
   (reporting directly to NFIU) vs. a **DNFBP** (SCUML), or outside both — verify MLPPA s.30
   text. Treat SCUML obligation as **risk-based** pending confirmation.
2. **SCUML registration trigger for cooperatives** specifically — no cooperative category
   listed; confirm.
3. **Harmonised Cooperative Societies Bill** — a directive/plan, **not law** as of Oct 2026.
4. **"Nigeria Cooperative Societies Commission"** — no evidence it exists.
5. **"Cooperative Bank of Nigeria (CoopBank)"** — proposed; no confirmed CBN licence.
6. **Reserve rate divergence** — federal floor 25%, many state bye-laws 20%; confirm per state.
7. **Act's nominal fees/fines** (₦100 registration, ₦1,000 fines) are decades out of date;
   current figures are state-set.
8. **FCCPC DEON applicability** to member-only cooperative credit — not explicit; confirm.
9. **NDPC threshold** (>200/6mo) from the 2024-12-19 guidance; check for 2025/2026 updates.
10. Some agency dates (NFIU 2025 report, FMAFS 2026-08-13) are recent; re-confirm live.
