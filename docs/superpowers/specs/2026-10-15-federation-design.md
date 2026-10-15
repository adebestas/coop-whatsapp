# Federation / Inter-coop — Shared Liquidity & Inter-lending

**Date:** 2026-10-15
**Status:** Draft
**Feature:** 15 — Federation / inter-coop (shared liquidity, inter-lending)
**Branch:** `feat/world-class`
**Depends on:** Feature 1 (share capital), Feature 13 (multi-currency + runtime context), the RLS design (`prisma/migrations/20261005000000_rls_policies`, `20261006000000_rls_resolvers`)

## 1. Goal

Let independent cooperatives on the platform form a **federation** so they can:

- **Pool liquidity** — member coops contribute idle funds into a shared pool and borrow from it.
- **Lend to each other** — a bilateral inter-coop loan, brokered through the pool (the lender's funds are earmarked for the borrower).
- Operate **across currencies** using admin-maintained FX rates.
- Be governed by a **dedicated federation admin**, with each coop's admin approving its own side.

## 2. Non-goals

- Automatic default handling (defaults are manual — the federation admin decides the remedy).
- Real-time FX feeds (rates are admin-maintained).
- Cross-federation transfers.
- Member-level federation membership (membership is at the cooperative level).

## 3. Key decisions (locked)

| Decision                    | Choice                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| v1 scope                    | **Both** — shared pool + bilateral inter-coop loans                                                                          |
| Currency                    | **Cross-currency with FX rates** (admin-maintained)                                                                          |
| Governance                  | **Dedicated federation admin** + each coop admin approves its own side                                                       |
| Cross-tenant model          | **Platform-level federation tables** + a federation-membership access dimension; all writes through one audited service      |
| Default handling            | **Manual** (federation admin)                                                                                                |
| Money-movement architecture | **Approach 1** — the federation is a ledger-holding entity with its own platform-level ledger; every move is coop↔federation |

## 4. Why Approach 1 (the RLS crux)

The RLS model sets a single GUC (`app.current_cooperative_id`) per transaction, and tenant tables are `USING ("cooperativeId" = app.current_coop_id())`. A cross-coop money move therefore **cannot** write two coops' RLS-scoped ledgers in one transaction.

Approach 1 resolves this by making the federation a **ledger-holding entity with a platform-level ledger** (no `cooperativeId`, no RLS). Every money move is **coop↔federation**, so a single transaction under the coop's GUC writes:

1. the coop's RLS-scoped `JournalEntry`/`Posting`, and
2. the federation's platform-level `FederationLedgerEntry`/`FederationPosting`

— atomically, with no second context and no owner-connection bypass. Bilateral inter-coop loans are **brokered**: the lender's funds are earmarked in the pool for the borrower, and the `FederationLoan` row records the lender so interest flows back.

## 5. Data model (platform-level — no `cooperativeId`, no RLS)

```prisma
model Federation {
  id           String   @id @default(cuid())
  name         String
  code         String   @unique
  baseCurrency String   @default("NGN")
  status       String   @default("active") // active | suspended
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  memberships  FederationMembership[]
  loans        FederationLoan[]
  ledger       FederationLedgerEntry[]
  rates        FxRate[]
}

model FederationMembership {
  id             String   @id @default(cuid())
  federationId   String
  federation     Federation @relation(fields: [federationId], references: [id], onDelete: Cascade)
  cooperativeId  String
  status         String   @default("active") // active | suspended
  joinedAt       DateTime @default(now())
  @@unique([federationId, cooperativeId])
  @@index([cooperativeId])
}

model FederationLedgerEntry {
  id           String   @id @default(cuid())
  federationId String
  federation   Federation @relation(fields: [federationId], references: [id], onDelete: Cascade)
  txRef        String   @unique
  description  String
  currency     String   // baseCurrency
  createdAt    DateTime @default(now())
  postings     FederationPosting[]
  @@index([federationId])
}

model FederationPosting {
  id         String   @id @default(cuid())
  entryId    String
  entry      FederationLedgerEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  account    String   // e.g. "coop:<coopId>:payable", "assets:bank", "pool:liquidity"
  direction  String   // DEBIT | CREDIT
  amount     Int      // minor units, in the entry's currency
  cooperativeId String? // the counterparty coop, when applicable
  @@index([entryId])
}

model FederationLoan {
  id                   String   @id @default(cuid())
  federationId         String
  federation           Federation @relation(fields: [federationId], references: [id], onDelete: Cascade)
  lenderCooperativeId  String?  // null = pool-funded
  borrowerCooperativeId String
  principalKobo        Int      // in `currency`
  currency             String
  fxRateToBase         Float    // captured at disbursement
  interestRate         Float    // annual, e.g. 0.12
  termMonths           Int
  status               String   @default("pending") // pending | active | repaid | defaulted
  disbursedAt          DateTime?
  dueAt                DateTime?
  repaidKobo           Int      @default(0)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  repayments           FederationLoanRepayment[]
  @@index([federationId, status])
  @@index([borrowerCooperativeId])
  @@index([lenderCooperativeId])
}

model FederationLoanRepayment {
  id           String   @id @default(cuid())
  loanId       String
  loan         FederationLoan @relation(fields: [loanId], references: [id], onDelete: Cascade)
  amountKobo   Int
  currency     String
  fxRateToBase Float
  paidAt       DateTime @default(now())
  @@index([loanId])
}

model FxRate {
  id            String   @id @default(cuid())
  federationId  String
  federation    Federation @relation(fields: [federationId], references: [id], onDelete: Cascade)
  baseCurrency  String
  quoteCurrency String
  rate          Float    // 1 base = rate quote
  effectiveAt   DateTime @default(now())
  setBy         String
  @@index([federationId, baseCurrency, quoteCurrency, effectiveAt])
}
```

Both `prisma/schema.prisma` and `prisma/schema.local.prisma` get these models (schema-sync test). A hand-written Postgres migration creates the tables. **No RLS** on these tables (platform-level).

## 6. Money flows (all coop↔federation, one transaction each)

Let `F` = the federation ledger, `C` = the coop's journal. **Every move is atomic** (fund write + both ledgers + the loan/repayment row in ONE `withCoopContext` transaction), uses a **collision-proof `txRef`** (`crypto.randomUUID()`), and **asserts `posted === true`** on both journals (throwing to roll back otherwise).

- **Fund the federation fund** (coop admin, `federation fund <amount>`): `C`: DEBIT `coop:federation_fund` / CREDIT `reserve:fund`; `Cooperative.reserveFundBalance` decremented (guarded `gte`), `federationFundBalance` incremented. This is the coop committing its own capital — the only way `federationFundBalance` grows.
- **Contribute to pool** (coop admin): `C`: DEBIT `federation:receivable` / CREDIT `coop:federation_fund`; `federationFundBalance` decremented (guarded); `F`: DEBIT `assets:bank` / CREDIT `coop:<id>:payable`. The coop's pool stake = its `federation:receivable` balance.
- **Borrow from pool** (coop admin; federation admin approves — see §8): **guarded by pool liquidity** — the federation's `assets:bank` balance must be ≥ the amount, else `INSUFFICIENT_POOL_LIQUIDITY`. `F`: DEBIT `coop:<id>:receivable` / CREDIT `assets:bank`; `C`: DEBIT `coop:federation_fund` / CREDIT `federation:payable`; `federationFundBalance` incremented.
- **Bilateral inter-coop loan (brokered + earmarked)**: the lender must have available stake ≥ the amount; the lender's `federation:receivable` is reclassified to `federation:loan_receivable` (earmarked for this loan). `FederationLoan.lenderCooperativeId` records the lender.
- **Repay**: `C`: DEBIT `federation:payable` / CREDIT `coop:federation_fund`; `federationFundBalance` decremented (guarded); `F`: DEBIT `assets:bank` / CREDIT `coop:<id>:receivable`; **plus interest** (below).
- **Interest** (simple): `interest = round(principal × interestRate × termMonths / 12)`. On repayment the borrower pays principal + interest; the interest credits the lender's `federation:interest_income` (bilateral) or `pool:liquidity` (pool-funded).
- **FX**: each `FederationLoan`/`FederationLoanRepayment` stores `fxRateToBase` at the time of the move. `F` is kept in `baseCurrency`; each `C` in its own currency. Settled entries are never revalued.

## 7. FX

- `getRate(federationId, from, to)`: same currency → 1.0; else the latest `FxRate` by `effectiveAt`; **fail closed** (throw) if none exists.
- Rates are set by the federation admin (`federation rate <from> <to> <rate>`).
- The rate is captured into the loan/repayment row at the moment of the move.

## 8. Governance & commands

- **Federation admin** — a super-admin flagged as federation admin (a new `isFederationAdmin` flag on the admin record, or a dedicated role). Manages federations, memberships, FX rates, loan approval, and defaults.
- **Coop admin** — approves its own side (contribute / borrow).
- **WhatsApp commands:**
  - Federation admin: `federation create <name> <baseCurrency>`, `federation addcoop <code>`, `federation removecoop <code>`, `federation rate <from> <to> <rate>`, `federation loans`, `federation approveloan <id>`, `federation default <id>`. Commands target a federation by code (`federation <code> ...`) or the sole federation when only one exists.
  - Coop admin: `federation fund <amount>` (reserve → federation fund), `federation contribute <amount>` (federation fund → pool), `federation borrow <amount> <months> [lenderCode]`, `federation repay <loanId> <amount>`, `federation position`.
- **Approval flow**: `borrow` creates a loan in `pending` (no money moves). The federation admin runs `federation approveloan <id>`, which disburses (the money move happens in `approveLoan`, super-admin gated). `federation default <id>` marks a loan `defaulted` (manual remedy).
- **Defaults are manual**: the federation admin marks a loan `defaulted` and decides the remedy (reschedule / write-off / draw on the borrower's pool stake). No automatic money movement.

## 9. RLS / security

- Federation tables are **platform-level** (no `cooperativeId`, no RLS).
- Access is gated by **federation membership**: a coop can only read rows for federations it belongs to — enforced in the service layer and asserted by tests.
- **One audited `federation` service** is the single cross-tenant path. Every money move writes the coop's RLS-scoped journal **and** the federation's platform-level ledger in **one transaction**, plus an `audit()` entry.
- The federation ledger is readable across coops by design (the pool is shared); it holds no member PII.

## 10. Files touched

- `prisma/schema.prisma` + `prisma/schema.local.prisma` (new models) + migration
- `src/services/federation/index.ts` (new: the audited service — create, membership, contribute, borrow, repay, approve, default)
- `src/services/federation/fx.ts` (new: `getRate`, `setRate`)
- `src/services/federation/ledger.ts` (new: federation double-entry posting)
- `src/services/admin.ts` (federation-admin commands)
- `src/services/conversation.ts` (coop-admin `federation` commands)
- `src/lib/tenant-context.ts` (a `resolveFederationMembership` helper if needed)

## 11. Tests

- `tests/federation-fx.test.ts` — rate resolution, same-currency, fail-closed.
- `tests/federation-pool.test.ts` — contribute/borrow/repay math, pool stake.
- `tests/federation-loan.test.ts` — bilateral loan lifecycle, interest split, default.
- `tests/federation-isolation.test.ts` — a coop cannot read another coop's federation rows.
- `tests/schema-sync.test.ts` — green (new models in both schemas).

## 12. Open questions

1. Federation-admin flag: a new boolean on the admin/super-admin record, or a dedicated role? **Default:** a boolean flag on the super-admin record.
2. Should members (not just admins) see their coop's federation position? **Default:** coop-admin only in v1.
3. Interest accrual: simple interest over the term, or amortized? **Default:** simple interest, repaid in one or more installments.
