# Commodity Credit - Payroll-Backed Purchase Schemes

**Date:** 2026-10-31
**Status:** Implemented on `feat/commodity-credit` (2026-10-31)
**Related:** `src/services/deductions.ts`, `src/services/deduction-ingest.ts`, `src/services/shop.ts`, `src/services/reconciliation.ts`, `src/services/scheduler.ts`, `src/services/buypoll.ts`, `docs/superpowers/specs/2026-10-29-coop-shop-design.md`

## Problem

Two public-sector pain points share one root cause: money that has been promised by an employer has not arrived yet.

1. **IPPIS / Accountant-General remittance lag.** Pay-slips show the payroll deduction on the 25th, but the lump-sum cheque reaches the co-op's bank account 30-90 days later. Members want their savings immediately; the co-op has no bank cash to lend or to pay withdrawals until the remittance lands.
2. **Commodity and asset financing.** Up to 40% of Nigerian co-op borrowing is non-cash: trailer-loads of 50kg rice, vegetable oil, rams and cows before Christmas and Eid-el-Kabir, plus laptops, phones and solar inverters for corporate co-ops, repaid over 3-6 monthly installments.

The bot already models the _money-in_ side (`DeductionBatch` + `DeductionItem` + `recordcheque` / `reconbatch`) and interest-free merchandise financing (`ShopItem` / `ShopOrder` / `Loan(kind="shop")`). What is missing is a way to let a member commit _expected_ payroll money to a commodity purchase before the cash arrives, without letting that expectation leak into spendable cash.

## Goal

A WhatsApp-native seasonal purchase scheme: a superadmin publishes a scheme with items and a subscription window, members subscribe using a capped commodity credit derived from their uploaded payroll schedule, and the co-op buys the goods only when reconciled bank cash (or an explicitly recorded supplier-credit decision) covers the purchase. Repayment is collected through payroll deduction installments, with per-member shortfall attribution and roll-forward.

## Non-goals

- No cash withdrawal, transfer or external payout against expected remittance. Commodity credit is spendable only inside a scheme.
- No supplier marketplace, delivery logistics or courier tracking.
- No multi-currency support in this iteration.
- No change to `PurchasePoll` voting UX; a scheme may optionally reference a poll that decided the item.
- No new interest or markup engine. Payroll-backed commodity financing is interest-free by design.
- No re-engineering of `ShopOrder`; the existing shop keeps its wallet auto-debit behavior.

## Decisions (agreed with product owner)

| Question                                    | Decision                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What may the member do with expected money? | **Commodity-credit only.** Provisional value can buy scheme items; never cash, transfers or withdrawals                                                          |
| Sourcing model                              | **Subscribe-then-buy batch.** Admin opens a scheme and a subscription window; the co-op purchases trailer-loads after the window closes                          |
| Repayment                                   | **Payroll deduction installments.** Installments are `DeductionItem(kind="commodity")` rows collected in `DeductionBatch`                                        |
| Credit cap                                  | **Multiple of the monthly deduction.** `cap = expectedMonthlyDeduction x COMMODITY_CREDIT_MULTIPLIER` (default 3)                                                |
| Expectation source                          | **Payslip / schedule upload.** The existing upload path writes the draft batch; its pending savings items are the credit basis                                   |
| Remittance shortfall                        | **Priority + roll forward.** Per member: loan arrears -> commodity installments -> savings; unpaid amounts roll to the next batch and block new commodity credit |

## Data model

Both `prisma/schema.prisma` and `prisma/schema.local.prisma`, plus a DDL migration and an `_rls` migration.

```prisma
model CommodityScheme {
  id             String   @id @default(cuid())
  cooperativeId  String
  cooperative    Cooperative @relation(fields: [cooperativeId], references: [id])
  reference      String   @unique // SCH-<season>-<short>
  name           String
  season         String?  // e.g. "Christmas 2026", "Ileya 2027"
  opensAt        DateTime
  closesAt       DateTime
  status         String   @default("draft") // draft | open | closed | purchased | converted | cancelled
  pollId         String?  // optional PurchasePoll that chose the item
  supplier       String?
  quotedCostKobo Int      @default(0)
  actualCostKobo Int?
  fundingSource  String?  // cash | supplier_credit
  purchaseNote   String?
  purchasedAt    DateTime?
  purchasedById  String?
  convertedAt    DateTime?
  createdById    String
  creator        Member   @relation("SchemeCreator", fields: [createdById], references: [id])
  items          CommoditySchemeItem[]
  subscriptions  CommoditySubscription[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([cooperativeId, status])
}

model CommoditySchemeItem {
  id              String   @id @default(cuid())
  schemeId        String
  scheme          CommodityScheme @relation(fields: [schemeId], references: [id], onDelete: Cascade)
  name            String   // "Rice 50kg", "Ram (medium)", "HP laptop"
  unitLabel       String   // "bag", "ram", "unit"
  unitCostKobo    Int      // what the co-op pays the supplier
  memberPriceKobo Int      // what the member is financed for
  totalUnits      Int?     // null = unlimited
  maxQtyPerMember Int      @default(1)
  subscriptions   CommoditySubscription[]
}

model CommoditySubscription {
  id              String   @id @default(cuid())
  reference       String   @unique // CS-<short>
  cooperativeId   String
  schemeId        String
  scheme          CommodityScheme @relation(fields: [schemeId], references: [id])
  itemId          String
  item            CommoditySchemeItem @relation(fields: [itemId], references: [id])
  memberId        String
  member          Member   @relation(fields: [memberId], references: [id])
  qty             Int      @default(1)
  unitPriceKobo   Int
  totalKobo       Int
  months          Int      @default(3)
  status          String   @default("reserved") // reserved | approved | rejected | cancelled | converted
  reservedAt      DateTime @default(now())
  decidedAt       DateTime?
  decidedById     String?
  rejectReason    String?
  convertedLoanId String?  @unique
  dispatchedAt    DateTime?
  collectedAt     DateTime?
  collectedById   String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([schemeId, itemId, memberId])
  @@index([cooperativeId, status])
  @@index([memberId, status])
}

model DeductionShortfall {
  id             String   @id @default(cuid())
  cooperativeId  String
  batchId        String
  batch          DeductionBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  memberId       String
  member         Member   @relation(fields: [memberId], references: [id])
  amount         Int      // kobo, still unpaid for this member
  reason         String?
  attributedById String?
  status         String   @default("open") // open | rolled | waived
  rolledToItemId String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([batchId, memberId])
  @@index([cooperativeId, status])
}
```

Extensions to existing models:

- `DeductionItem.kind` gains `"commodity"` (comment updated; no enum in use).
- `DeductionItem.rolloverOfItemId String? @unique` with a self-relation `rolledFrom` / `rolledTo`, so a rolled installment is traceable and cannot be rolled twice.
- `DeductionBatch.shortfalls DeductionShortfall[]`.
- `Member.commoditySubscriptions`, `Member.shortfalls`, `Member.schemesCreated`.
- `Cooperative.commoditySchemes`, `Cooperative.commoditySubscriptions`, `Cooperative.deductionShortfalls`.
- `Loan.kind` gains `"commodity"` (comment updated).

RLS: `CommodityScheme`, `CommoditySchemeItem` (via parent resolver or direct — it has no `cooperativeId`, so it uses the parent-resolver policy through `schemeId`), `CommoditySubscription`, `DeductionShortfall`. `CommodityScheme` and `CommoditySubscription` and `DeductionShortfall` carry `cooperativeId` and use the direct policy; `CommoditySchemeItem` uses the parent-resolver policy, matching the `SavingsDeposit` precedent.

## Credit position

Computed on read in `src/services/commodity-credit.ts`; nothing is stored as a spendable balance.

```
expected  = sum(pending savings items in the member's newest batch where
            sourceFileKey IS NOT NULL,
            status IN (draft, submitted, cheque_received),
            period = periodOf(today)
cap       = expected x COMMODITY_CREDIT_MULTIPLIER   (env, default 3)
committed = outstanding principal of disbursed Loan(kind="commodity")
          + totalKobo of subscriptions in (reserved, approved)
available = max(0, cap - committed)
```

Rules:

- No uploaded schedule line for the period -> `available = 0` with reason "no payroll schedule uploaded this month".
- Any `DeductionShortfall(status="open")` for the member -> `available = 0` until rolled or waived.
- Subscription must satisfy `qty <= maxQtyPerMember`, `qty <= units left` (when `totalUnits` is set), and `totalKobo <= available`.
- Credit is reserved immediately on subscribe; it is released on cancel, reject or scheme cancellation.

## Lifecycle

1. `draft` - superadmin creates the scheme and items (`newscheme`, `addschemeitem`). Not visible to members.
2. `open` - `openscheme` publishes and sends one batched broadcast to active members with credit headroom. Members subscribe; each subscription is `reserved`.
3. `closed` - at `closesAt` (scheduler tick) or by `closescheme`. No new subscriptions. Members may still cancel while open; after closing only an admin rejection releases a reservation.
4. `purchased` - superadmin records supplier and actual cost (`purchasescheme`). **Cash gate:** `assets:bank` journal balance (same derivation as `reconciliation.ts`) must cover `quotedCostKobo` minus already-committed scheme purchases. Otherwise the purchase requires `fundingSource="supplier_credit"` plus a note, is audited, and the scheme is reported as unfunded.
5. `converted` - `convertscheme` turns each `reserved`/`approved` subscription into a `Loan(kind="commodity")` (principal `totalKobo`, `months`, `monthlyPayment = floor(total/months)`, last installment takes the remainder, status `disbursed`) and appends the first `DeductionItem(kind="commodity")` to the next draft batch (creating a draft when none exists).
6. `cancelled` - releases every reservation; no money moves.

Collection is tracked on the subscription (`dispatchedAt`, `collectedAt`, `collectedById`); no second order object.

## Payroll collection and shortfalls

- `buildBatch` (and `buildBatchFromRows`) gain a commodity step: for each disbursed `Loan(kind="commodity")` with balance > 0, add one `DeductionItem(kind="commodity")` for `min(monthlyPayment, balance)`.
- Existing loan selection in `buildBatch` currently takes the first disbursed loan regardless of `kind`. It is narrowed to `kind="cash"` so commodity and shop loans are never collected twice (shop through `runShopInstallments`, commodity through this item).
- `reconcileBatch`: a short reconciliation now **settles** instead of refusing. It records the batch as reconciled and prompts attribution: `shortbatch <ref> <code> <amount|all>`. Unattributed shortfall is attributed proportionally per member. Every attribution is written to `DeductionShortfall`.
- `approveBatch`: allocates per member. For each member, `received = sum(items) - open shortfall`, then within that slice pay in priority order **loan -> commodity -> savings** (pending items are sorted by a fixed kind rank and grouping before the budget loop). Unpaid item amounts become `rolled`: the original item gets `status="rolled"`, and an equivalent item with `rolloverOfItemId` is appended to the next draft batch (created if absent). The batch can then finalize as `approved` while its shortfalls stay recorded.
- A member with an `open` shortfall has zero commodity credit; `waiveMonth`/`shortbatch waive` are the only exits.
- Scheduler: month-end tick notifies superadmins about batches not yet `approved` and lists members with open shortfalls.

Behavioral change: three existing tests assert "shortfall blocks approval". They are rewritten to assert settlement, per-member priority and roll-forward. The all-or-nothing block remains only when a superadmin explicitly rejects a short batch.

## Commands and permissions

Member:

- `schemes` - open schemes with items, member price, units left and own available credit.
- `subscribe <scheme> <item> <qty> [months]` - reserves credit and returns the schedule; `months` bounded 3-6 and by scheme policy.
- `mysubs` - reservations, installment schedule, dispatch/collection state.
- `cancelsub <ref>` - only while the scheme is `open`.
- `credit` - cap, committed, available, and the exact block reason when zero.

Admin (`admin.ts`, raw pipe-delimited parsing like `addshopitem`):

- superadmin: `newscheme <name> | <season> | <opens> | <closes>`, `addschemeitem <scheme> | <name> | <unit> | <cost> | <price> | <units> | <max>`, `purchasescheme <ref> | <supplier> | <cost>`, `convertscheme <ref>`, `shortbatch <ref> <code> <amount|all|waive>`.
- admin: `openscheme`, `closescheme`, `schemesubs <ref>`, `rejectsub <ref>`, `dispatchsub <ref>`, `collectsub <ref> <code>`.

Dates are entered as `YYYY-MM-DD`; amounts use the same naira notation as every other command and are stored in kobo; `<units>` accepts `-` for unlimited stock.

`purchasescheme` joins the money-out command set so the pilot gate and audit treat it as real cash. All mutations audit with `actorPhone`; chain-of-custody actions record the supervising member.

## Notifications

- Scheme opened -> one batched broadcast to eligible members (not per-member spam).
- Subscription -> reservation confirmed, remaining credit, installment preview.
- Conversion -> schedule ("N x amount via payroll starting <period>").
- Deduction approval -> existing message extended with the commodity line.
- Shortfall / roll -> member-specific message naming what rolled and why credit is blocked.
- Dispatch -> collection instructions; collection -> receipt-style confirmation.

## Testing and verification

- `tests/commodity-credit.test.ts` - cap math, reservation release, shortfall block, tenant scoping.
- `tests/commodity-scheme.test.ts` - lifecycle transitions, cash-gate refusal and audited supplier-credit override, conversion to loan plus installments, collection.
- `tests/deduction-shortfall.test.ts` - attribution (explicit and proportional), per-member priority, roll-forward, batch finalization, idempotent re-approval.
- Updates: `tests/shop.test.ts` (kind isolation), `tests/conversation.test.ts` help menu, `tests/schema-sync.test.ts`, deduction suite for the new shortfall semantics.
- Migrations: one DDL migration generated with `prisma migrate diff`, one `_rls` migration; local Docker Postgres run of `scripts/db-migrate.mjs` plus `tests/rls-isolation.test.ts` before CI.
- Gates: `tsc --noEmit`, `npm run lint`, `npm run format:check`, focused suites, PR CI (type-check, unit, security, dependency audit, Postgres/RLS, build).

## Rollout

- `COMMODITY_SCHEMES_ENABLED=1` enables the feature; default off, and commands reply "commodity schemes are not enabled" while off.
- `COMMODITY_CREDIT_MULTIPLIER` default 3.
- Migration is additive with no backfill; `ShopOrder`, `Loan(kind="shop")` and cash-loan flows are unchanged.

## Risks and mitigations

| Risk                                                      | Mitigation                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Co-op buys stock against money that never arrives         | Cash gate at `purchased`; supplier-credit override is explicit, reasoned and audited                                                                                   |
| Double-collection of shop loans via the deduction builder | Narrow `buildBatch` loan selection to `kind="cash"`; commodity and shop each keep one collection path                                                                  |
| Credit math drift between batches                         | Expectation is read from the uploaded schedule batch, never stored a second time                                                                                       |
| Roll-forward loops or duplicate rollovers                 | `rolloverOfItemId` unique + item `status="rolled"`                                                                                                                     |
| Member disputes a shortfall                               | Attribution is per member, visible in `mysubs`/statement, and waivable with audit                                                                                      |
| RLS gaps on new tables                                    | Direct policy for `CommodityScheme`, `CommoditySubscription`, `DeductionShortfall`; parent-resolver policy for `CommoditySchemeItem`; verified by the Postgres RLS job |

## Open questions for the implementation plan

- Exact batching/throttling for the "scheme opened" broadcast to large co-ops.
- Whether scheme items should reuse `ShopItem` catalog rows for appliance sales in a later iteration.
- Whether `PurchasePoll` should auto-create a draft scheme once a poll closes (nice-to-have, not required for this scope).
