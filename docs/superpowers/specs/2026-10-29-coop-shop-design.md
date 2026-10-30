# Coop Shop — Commodity / Bulk-Purchase Financing

**Date:** 2026-10-29
**Status:** Approved design, pending implementation plan
**Related:** `src/services/loans.ts`, `src/services/deductions.ts`, `src/services/scheduler.ts`, `src/services/buypoll.ts`, `PurchasePoll`

## Problem

Up to 40% of cooperative borrowing is non-cash: members take bulk-purchased goods (rice, oil, generators, laptops) on 3–6 month installment plans. Today the bot has no catalog, no order flow, and no way to turn a dispatch into a collectable receivable. Co-ops track this in notebooks, which breaks statements, provisioning, insurance cover and regulator reporting.

## Goal

A WhatsApp-native shop where an admin publishes bulk items with installment terms, members order with a PIN, admins approve and dispatch, and the dispatch creates a real asset loan collected from savings and payroll.

## Non-goals

- No online payments, card checkout, delivery logistics or courier tracking.
- No supplier purchase orders — the co-op already owns the stock.
- No guarantors and no credit-committee queue for shop orders.
- No multi-unit carts (one order = one unit, or whatever one catalog row represents).
- No markup engine; shop financing is interest-free by design.

## Decisions (agreed with product owner)

| Question | Decision |
|----------|----------|
| Installment collection | **Both**: daily savings auto-debit first; payroll `DeductionBatch` settles arrears |
| Eligibility | Active/not frozen/suspended; no arrears; no other open order; `outstanding shop balance + price ≤ 50% of totalSaved`; no guarantors, no queue |
| Pricing | No markup. `monthly = floor(price / months)` for the first `months-1` payments; the last payment takes the remainder (exact to the kobo) |
| Order lifecycle | `pending → approved → dispatched`; admin **or** superadmin approves/rejects/dispatches |
| Shortfall on due date | Partial debit of available savings; remainder becomes arrears; weekly retry; payroll fallback; reminders at 3 and 15 days; new orders blocked while in arrears |
| Inventory | Optional `stockQty` per item; decremented atomically at dispatch; `null` = unlimited; catalog marks 0 as out of stock |
| Confirmation | Member enters the 4-digit PIN at `buyitem` (shared-phone protection), before the order is queued |
| Bookkeeping | Shop orders are `Loan` rows with `kind="shop"`: visible in `myloans`, statements, provisioning, insurance, regulator loan book and the payroll builder; excluded from the cash-loan queue and guarantor rules |

## Data model

Both `prisma/schema.prisma` and `prisma/schema.local.prisma`.

```prisma
model ShopItem {
  id            String   @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Restrict)
  name          String
  cashPrice     Int      // kobo
  maxMonths     Int      @default(3)
  stockQty      Int?     // null = unlimited
  active        Boolean  @default(true)
  createdById   String
  creator       Member   @relation("ShopItemCreator", fields: [createdById], references: [id], onDelete: Restrict)
  orders        ShopOrder[]
  createdAt     DateTime @default(now())

  @@index([cooperativeId, active])
}

model ShopOrder {
  id            String   @id @default(cuid())
  ref           String   @unique            // SHOP-XXXXXX
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Restrict)
  memberId      String
  member        Member   @relation("ShopOrderMember", fields: [memberId], references: [id], onDelete: Restrict)
  itemId        String
  item          ShopItem @relation(fields: [itemId], references: [id], onDelete: Restrict)
  cashPrice     Int      // price snapshot in kobo
  months        Int
  monthlyKobo   Int
  status        String   @default("pending") // pending | approved | dispatched | rejected | cancelled | completed
  approvedById  String?
  approvedBy    Member?  @relation("ShopOrderApprover", fields: [approvedById], references: [id], onDelete: SetNull)
  approvedAt    DateTime?
  dispatchedById String?
  dispatchedBy  Member?  @relation("ShopOrderDispatcher", fields: [dispatchedById], references: [id], onDelete: SetNull)
  dispatchedAt  DateTime?
  rejectReason  String?
  loanId        String?  @unique
  loan          Loan?    @relation(fields: [loanId], references: [id], onDelete: SetNull)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([cooperativeId, status])
  @@index([memberId, status])
}
```

`Loan` gains `kind String @default("cash")` (`cash | shop`) and `shopOrder ShopOrder?`.

## Commands

| Role | Command | Behaviour |
|------|---------|-----------|
| Admin/superadmin | `addshopitem "<name>" <price> [maxMonths] [stock]` | Creates an active item; validates name, price > 0, 1 ≤ months ≤ 12, stock ≥ 0 |
| Admin/superadmin | `shopitems` | Admin view including inactive items and stock |
| Admin/superadmin | `shoporders` | Open orders for this co-op (`pending`, `approved`) |
| Admin/superadmin | `approveorder <ref>` | `pending → approved`; notifies member |
| Admin/superadmin | `rejectorder <ref> [reason]` | `pending/approved → rejected`; notifies member |
| Admin/superadmin | `dispatch <ref>` | `approved → dispatched`; decrements stock, creates the loan, books the receivable, notifies member with the schedule |
| Admin/superadmin | `closeshopitem <id>` | `active = false`; existing orders unaffected |
| Member | `shop` | Catalog: id, name, cash price, monthly figure for the max plan (plus available plan lengths), out-of-stock marker |
| Member | `buyitem <id> [months]` | Defaults to `maxMonths`; validates stock/months/eligibility → summary → PIN → `pending` order; notifies member and admins |
| Member | `myshop` | Own orders with status, ref, plan, next due date and balance |

## Flows

### Order creation
1. Resolve member by phone; reject with a join prompt if absent.
2. Load the item scoped by the member's `cooperativeId`; reject inactive, unknown or out-of-stock items.
3. Validate months (1..`min(maxMonths, 12)`); compute the schedule with the exact-kobo split.
4. Eligibility: `status === "active"`, no `frozenAt`/`supervisoryFrozenAt`, no shop loan in arrears, no other `pending|approved` order, and `outstandingShopBalance + cashPrice ≤ 0.5 * totalSaved`.
5. Send the summary and require a 4-digit PIN using the same secret-challenge path as withdrawals (`issueSecretChallenge` / PIN verification). Wrong PIN follows the existing attempt-lockout policy.
6. Create the `ShopOrder` (`pending`) after PIN success; notify the member with the ref and notify every active admin/superadmin of the co-op; write an audit entry.

### Approval and dispatch
- `approveorder` and `rejectorder` require `role === "admin" || role === "superadmin"` and scope the order to the actor's co-op.
- `dispatch` runs in one transaction: re-check `approved` + stock, decrement stock, create the `Loan`, update the order. Ledger: increase `assets:loan_portfolio` (receivable) and decrease `assets:inventory` when the item was stock-tracked, mirroring how repayments book `assets:loan_portfolio`.
- Loan fields: `kind="shop"`, `amount = balance = cashPrice`, `interestRate = 0`, `adminCharge = 0`, `tenureMonths = months`, `monthlyPayment = monthlyKobo`, `status = "disbursed"`, `disbursedAt = now`, `dueDate = +1 month`.
- Dispatch notification contains item, ref, monthly amount, installment count and the first due date. `rejectorder` requires no stock changes because stock only moves at dispatch.

### Collection
- The daily installment job finds `Loan` rows with `kind="shop"`, `status in ("disbursed","partial")`, `balance > 0`, `dueDate <= now`:
  - debit `min(monthlyPayment, wallet.balance)`; write a `LoanRepayment`; book `assets:loan_portfolio` and (zero) interest.
  - if the wallet covers the installment: `balance -= installment`, `dueDate += 1 month`.
  - if short: `balance` still decreases by the amount debited, `status = "partial"`, `dueDate += 7 days` (weekly retry), and the shortfall is recorded as arrears (derived as the unpaid part of the current installment).
- The existing early-warning/reminder path sends 3-day and 15-day nudges. Shop loans have no guarantors, so guarantor alerts are skipped for `kind="shop"`.
- Payroll: the `DeductionBatch` builder already targets active loans, so shop loans are included; settlement uses the same repayment helper.
- Completion: `balance === 0` → loan `paid`, order `completed`, member notified.
- Arrears block new orders until cleared.

## Error handling

| Case | Response |
|------|----------|
| Unknown/inactive item | "That item is no longer available." |
| Out of stock | "Out of stock right now — ask your admin to restock." |
| Invalid months | List the allowed plan lengths |
| Ineligible | Specific reason (frozen, suspended, arrears, open order, cap exceeded with both numbers) |
| Wrong PIN | Existing PIN lockout messaging |
| Stock race at dispatch | Transaction recheck → "just sold out", order stays `approved` |
| Cross-co-op ref | Not found (never reveal another co-op's order) |
| Duplicate approval/dispatch | Idempotent no-op with a clear message |

## Testing (`tests/shop.test.ts`)

1. `addshopitem` validation (price, months, stock) and admin-only access.
2. `shop` catalog output including monthly figures and out-of-stock marker.
3. `buyitem` PIN confirmation creates a `pending` order; wrong PIN does not.
4. Eligibility: cap, one-open-order, arrears, frozen member.
5. `approveorder` / `rejectorder` role + co-op scoping.
6. `dispatch` decrements stock, creates a `kind="shop"` loan with the exact schedule, books the ledger, and is idempotent.
7. Installment job: full debit, partial debit → `partial` + weekly retry, payroll settlement, completion.
8. Co-op isolation for catalog, orders and dispatch.

## Rollout

- Schema: add the two models and the `Loan.kind` column to both Prisma schemas; SQLite dev via `prisma db push`; Postgres via the repository's existing migration path. Existing loans default to `kind="cash"`, so no backfill is needed.
- Feature is additive: no existing command changes behaviour; `myloans` gains shop rows, which is intended.
- No new environment variables.

## Risks

- **Exposure drift:** the 50% cap uses `totalSaved`, which excludes savings products and shares. Accepted for v1; revisit if co-ops ask.
- **Payroll inclusion:** shop loans must be filtered correctly by the batch builder, otherwise payroll double-pays savings installments. Covered by a dedicated test.
- **Ledger semantics:** shop dispatch books a receivable against inventory; co-ops that never tracked inventory will show a negative inventory bucket. Document it in the admin message/help text.
- **Weekend/holiday retries:** weekly retry may land on a bank holiday; the payroll fallback covers it.
