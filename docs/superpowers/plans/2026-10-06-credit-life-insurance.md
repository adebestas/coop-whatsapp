# Credit Life Insurance (Loan Protection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle loan-protection cover on every loan. A 1% premium (configurable) is deducted at disbursement into a self-insured protection fund. If the borrower dies (or is permanently disabled) and the death claim is approved, the outstanding loan is written off from the fund and the member's savings/shares pass to their next of kin.

**Architecture:** New `LoanProtection` register (one row per loan) + `Cooperative.protectionFundBalance` + `CooperativeConfig.loanProtectionPercent/Enabled`. Premium is withheld in `disburseLoan` alongside the admin charge and posted to `liabilities:loan_protection_fund`. The write-off runs inside the existing `approveClaim` saga, before the savings payout.

**Tech Stack:** TypeScript (ESM `.js` imports), Fastify 5, Prisma 6, vitest 3, SQLite (tests) / Postgres (prod).

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 1, Feature 2).

## Global Constraints
- Money is integer kobo; format with `formatBalance`.
- Both schemas identical (`prisma/schema.prisma` + `schema.local.prisma`); `tests/schema-sync.test.ts` enforces it.
- No Prisma `enum` — `String` with inline `// a | b` comment.
- New `cooperativeId`-scoped table needs a Stage-1 RLS migration + a FORCE-list entry.
- User decisions (2026-10-06): self-insured fund; 1% of principal (per-coop configurable); deducted at disbursement; covers death + permanent disability; on claim, write off the loan AND release savings/shares to next of kin.
- Verification per task: `npm run typecheck` clean, `npm run lint` 0 errors, targeted tests green.

---

### Task 1: Schema, config, migrations, RLS

**Files:** `prisma/schema.prisma`, `prisma/schema.local.prisma`, `prisma/migrations/20261017000000_loan_protection/migration.sql`, `prisma/migrations/20261018000000_loan_protection_rls/migration.sql`, `prisma/rls/recommended_policies.sql`.

**Interfaces produced:** model `LoanProtection` (id, cooperativeId, loanId `@unique`, memberId, premium `Int`, status, claimId `String? @unique`, writtenOff `Int @default(0)`, createdAt, claimedAt?); `Cooperative.protectionFundBalance Int @default(0)`; `CooperativeConfig.loanProtectionPercent Int @default(1)`, `loanProtectionEnabled Boolean @default(true)`; relations `Cooperative.loanProtections`, `Member.loanProtections`, `Loan.protection`, `DeathClaim.protection`.

- [ ] Add the model + fields to both schemas (place `LoanProtection` after `GuarantorDeduction`).
- [ ] Add relation back-refs on `Cooperative`, `Member`, `Loan`, `DeathClaim`.
- [ ] Postgres migration `20261017000000_loan_protection`: create `LoanProtection` table, indexes (`LoanProtection_loanId_key` unique, `LoanProtection_claimId_key` unique, `LoanProtection_cooperativeId_status_idx`, `LoanProtection_memberId_idx`), 4 FKs, and `ALTER TABLE "Cooperative" ADD COLUMN "protectionFundBalance" INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE "CooperativeConfig" ADD COLUMN "loanProtectionPercent" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "loanProtectionEnabled" BOOLEAN NOT NULL DEFAULT true`.
- [ ] RLS migration `20261018000000_loan_protection_rls`: `ENABLE ROW LEVEL SECURITY` + direct `cooperativeId` policy for `LoanProtection` (copy the pattern from `20261015000000_share_capital_rls`).
- [ ] Add `'LoanProtection'` to the directly-scoped group in `prisma/rls/recommended_policies.sql`.
- [ ] `npm run prisma:generate:local`; `npx prisma db push --schema prisma/schema.local.prisma`; `npx vitest run tests/schema-sync.test.ts` passes.
- [ ] Commit `feat(insurance): LoanProtection schema, migration, RLS`.

### Task 2: Premium withheld at disbursement

**Files:** `src/services/disbursements.ts` (modify `disburseLoan`), `tests/loan-protection.test.ts` (new).

**Interfaces consumed:** `LoanProtection`, `Cooperative.protectionFundBalance`, `CooperativeConfig`. **Produced:** the deduction + fund posting.

- [ ] **Test (red):** loan `amount = 100000` kobo (₦1,000), `adminCharge = 20000`, protection 1% → member receives `79000`; a `LoanProtection` row with `premium = 1000` exists; `protectionFundBalance = 1000`; trial balance balanced. Uses a member with a matching bank name and the payment mock.
- [ ] In `disburseLoan`, after `adminCharge`: load `CooperativeConfig`, compute `premium = enabled ? Math.floor((loan.amount * percent) / 100) : 0`, and `disbursable = Math.max(0, loan.amount - adminCharge - premium)`. Update the success message to mention the protection premium.
- [ ] After the loan is finalized `disbursed`, in one `withTx` with `setCoopContext`: create the `LoanProtection` row, increment `Cooperative.protectionFundBalance` by `premium`, write a `LedgerEntry` (`type: "balance_sheet"`, `category: "liabilities:loan_protection_fund"`), and `postJournal` DEBIT `assets:bank` / CREDIT `liabilities:loan_protection_fund` for `premium` (txRef `LOAN-PROT-${loan.id}`). Skip entirely when `premium <= 0`.
- [ ] **Verify:** `npx vitest run tests/loan-protection.test.ts tests/loan*.test.ts tests/money-invariants.test.ts`; typecheck; lint.
- [ ] Commit `feat(insurance): withhold protection premium at loan disbursement`.

### Task 3: Claim write-off + NOK release

**Files:** `src/services/deathclaims.ts` (modify `approveClaim`), `src/services/loan-protection.ts` (new: `writeOffProtection(claimId)`), admin/member messaging, `tests/loan-protection.test.ts`, `README.md`.

**Interfaces produced:** `writeOffProtection(cooperativeId, memberId, claimId)` — for every `Loan` of the member with `status` in `["disbursed","partial"]` and `balance > 0`: mark the loan `paid` with `balance: 0`, mark its `LoanProtection` `claimed` with `writtenOff = balance`, post journal DEBIT `liabilities:loan_protection_fund` / CREDIT `assets:loan_portfolio` for the balance, and decrement `Cooperative.protectionFundBalance`. Runs inside the `approveClaim` transaction/saga before the wallet payout, and never lets the fund go negative (clamp; excess is a coop expense).

- [ ] **Test (red):** create a member with an active loan (disbursed) and a protection fund, run the death-claim approval path, assert the loan is `paid`/`balance 0`, `LoanProtection.status = "claimed"`, the fund decremented, the journal balanced, and the savings still paid to the family.
- [ ] Implement `writeOffProtection` and call it in `approveClaim` right after the atomic `processing` claim and before the wallet debit. Include the written-off amount in the claim payout message.
- [ ] Update the `README.md` loan section with a `## Loan protection` subsection (1% default, configurable, self-insured, claims on death/disability).
- [ ] **Verify:** full gate + `npm test`.
- [ ] Commit `feat(insurance): write off protected loans on an approved death claim`.
