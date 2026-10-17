# Coop WhatsApp — World-Class Feature Roadmap

> **For agentic workers:** This is a **program roadmap**, not an executable plan. Each feature below gets its own detailed plan file (`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`) written with the `writing-plans` skill before implementation. Execute one feature plan at a time.

**Goal:** Evolve `coop-whatsapp` from a strong chat-first savings/loans platform into a full cooperative banking system benchmarked against the world's leading cooperatives (SACCOs, credit unions, Rabobank, Mondragon, Amul, Grameen, VSLA).

**Constraint (user decision, 2026-10-06):** **WhatsApp-only for now.** USSD was explicitly dropped — "WhatsApp is our selling point." Do not add USSD/SMS channels in this program.

**Agreed scope:** 15 features (2 were skipped: credit bureau/scoring, bill payments).

---

## Sequencing principles

1. **Financial core first.** Share capital changes what a "dividend" means, so it must land before share-based dividends, referral rewards, and federation liquidity.
2. **Governance compounds.** Committees define the roles that AGM elects and that the ombudsman escalates above.
3. **Discipline before reporting.** PEARLS/provisioning produce the numbers the regulator pack reports.
4. **Rails and reach are independent** and can be parallelised once the core is stable.
5. **Federation is last** — it depends on share capital and touches RLS tenant isolation, the riskiest area.

---

## Phase 1 — Ownership & protection (financial core)

| # | Feature | Depends on | Plan file |
|---|---------|-----------|-----------|
| 1 | **Share capital (member equity)** | — | `2026-10-06-share-capital.md` ✅ written |
| 2 | **Credit life insurance / loan protection** | 1 (protection fund accounting) | TBD |

**Why first:** Share capital is the line between a savings app and a cooperative (ICA Principle 3). It introduces `equity:share_capital`, the account that later features (referral rewards, federation liquidity) build on. Credit life insurance closes the death-claim loop and protects the loan book.

---

## Phase 2 — Governance

| # | Feature | Depends on | Plan file |
|---|---------|-----------|-----------|
| 3 | **Committee governance** (Credit / Supervisory-Audit / Board) | — | TBD |
| 4 | **AGM / general meeting** (motions, proxies, quorum, minutes) | 3 (committees are elected at AGM) | TBD |
| 5 | **Member ombudsman** (independent escalation) | 3 (escalates above committees) | TBD |

**Why here:** Committees define the role model; AGM is the ritual that elects them and ratifies dividends/bylaws; the ombudsman is the independent tier above them. All three reuse the existing `Vote`/`DividendVote` tally machinery.

---

## Phase 3 — Financial discipline

| # | Feature | Depends on | Plan file |
|---|---------|-----------|-----------|
| 6 | **Loan-loss provisioning + PEARLS ratios** | — (uses existing journal) | TBD |
| 7 | **Regulator reporting pack** | 6 (reports PEARLS/PAR) | TBD |

**Why here:** Provisioning and PEARLS turn the existing double-entry journal into solvency/asset-quality truth. The regulator pack then formats those numbers into statutory returns.

---

## Phase 4 — Products & growth

| # | Feature | Depends on | Plan file |
|---|---------|-----------|-----------|
| 8 | **Savings product variety** (fixed, goal, seasonal, junior) | — | TBD |
| 9 | **Group / VSLA / ROSCA** (ajo/esusu, joint-liability loans) | — | TBD |
| 10 | **Referral / member-get-member** | 1 (reward can be shares) | TBD |
| 11 | **Literacy → certification** | — (extends `MemberProgress`) | TBD |

**Why here:** These are additive product surfaces on the existing wallet/contribution/loan machinery. Referral is placed after share capital so rewards can be paid in shares.

---

## Phase 5 — Rails & reach

| # | Feature | Depends on | Plan file |
|---|---------|-----------|-----------|
| 12 | **NIBSS Direct Debit mandates** | — (provider integration) | TBD |
| 13 | **Multi-language + multi-currency** | — (extends `i18n.ts`, `Cooperative.currency`) | TBD |

**Why here:** Independent integrations. Language is low-risk/high-reach; multi-currency adds FX complexity at the provider boundary.

---

## Phase 6 — Scale & trust

| # | Feature | Depends on | Plan file |
|---|---------|-----------|-----------|
| 14 | **Device binding + transaction signing** | — (extends `auth2fa.ts`/`totp.ts`) | TBD |
| 15 | **Federation / inter-coop** (shared liquidity, inter-lending) | 1 (capital), RLS cross-tenant path | TBD |

**Why last:** Device binding is a contained security upgrade. Federation is the most architecturally significant — it needs an explicit, audited cross-tenant path through the RLS design, so it lands once everything else is stable.

---

## Cross-cutting requirements (apply to every feature plan)

- **Schema:** every new model goes in **both** `prisma/schema.prisma` and `prisma/schema.local.prisma` (enforced by `tests/schema-sync.test.ts`), plus a Postgres migration in `prisma/migrations/<timestamp>_<name>/migration.sql`.
- **RLS:** every new table with a `cooperativeId` column must be added to (a) a new Stage-1 RLS migration (`ENABLE` + policy) and (b) the FORCE list in `prisma/rls/recommended_policies.sql`. Child tables reached via a tenant parent go in the child list.
- **Money:** integer kobo everywhere; format with `formatBalance`; parse user input with `parseNaira`.
- **Tenancy:** chat writes go through `withCoopContext`; REST writes through `withTenant`; system jobs use `ownerPrisma`.
- **Audit:** every money/role action calls `audit()`.
- **Ledger:** every money movement posts a balanced `postJournal` pair (or `recordLedger`).
- **Tests:** TDD; run `npx vitest run tests/<file>.test.ts`; full suite `npm test` (SQLite, ~10 min).
- **Verification gate per feature:** `npm run typecheck` clean · `npm run lint` 0 errors · full suite green · schema-sync green.

---

## Status

- [x] Roadmap agreed (15 features, 2 skipped)
- [x] Phase 1 / Feature 1 plan written: `2026-10-06-share-capital.md`
- [ ] Phase 1 / Feature 1 implemented
- [ ] Remaining 14 feature plans written
