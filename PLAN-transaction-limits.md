# Implementation Plan: Transaction Limits & Audit Trail

## Context

The cooperative banking platform has existing `LIMITS` constants in `lib/validation.ts` and `lib/money.ts` but they are NOT enforced at all call sites. Additionally, there are no per-member daily/monthly transaction limits required by CBN regulations.

---

## Fix #16: Enforce Existing Per-Transaction Limits

**Priority:** HIGH  
**Time:** 30 minutes  
**Risk:** LOW

### Problem
The following limits exist as constants but are NOT enforced:
- `MIN_SAVE` / `MAX_SAVE` in `createContribution()`
- `MIN_LOAN` / `MAX_LOAN` in `applyForLoan()`
- `MIN_WITHDRAW` / `MAX_WITHDRAW` in `requestWithdrawal()`
- `MAX_PAYANYONE` in `requestExternalPayment()`

### Solution
Add validation checks at each call site using the existing `LIMITS` constants from `lib/money.ts`.

### Files to Modify
- `src/services/cooperative.ts` — enforce MIN_SAVE/MAX_SAVE
- `src/services/loans.ts` — enforce MIN_LOAN/MAX_LOAN
- `src/services/withdrawals.ts` — enforce MIN_WITHDRAW/MAX_WITHDRAW
- `src/services/payanyone.ts` — enforce MAX_PAYANYONE

---

## Fix #17: Per-Member Daily Transaction Limits

**Priority:** HIGH  
**Time:** 1.5 hours  
**Risk:** MEDIUM

### Problem
No per-member daily/monthly caps exist. A compromised account could drain funds rapidly.

### Solution
Create a `TransactionLedger` model to track daily aggregates, with configurable limits per member tier.

### CBN Tier Limits (Naira)
| Tier | Daily In | Daily Out | Monthly Out |
|------|----------|-----------|-------------|
| Tier 1 | ₦300,000 | ₦300,000 | ₦3,000,000 |
| Tier 2 | ₦500,000 | ₦500,000 | ₦5,000,000 |
| Tier 3 | Unlimited | Unlimited | Unlimited |

### Database Changes
```prisma
model TransactionLedger {
  id        String   @id @default(cuid())
  memberId  String
  direction String   // "in" | "out"
  amount    Int      // in kobo
  type      String   // "contribution" | "withdrawal" | "loan" | "payout"
  date      DateTime @db.Date
  
  member Member @relation(fields: [memberId], references: [id])
  
  @@unique([memberId, direction, date, type])
  @@index([memberId, date])
}
```

### New File: `src/lib/limits.ts`
```typescript
import { prisma } from "./prisma.js";

const TIER_LIMITS = {
  tier1: { dailyIn: toKobo(300_000), dailyOut: toKobo(300_000), monthlyOut: toKobo(3_000_000) },
  tier2: { dailyIn: toKobo(500_000), dailyOut: toKobo(500_000), monthlyOut: toKobo(5_000_000) },
  tier3: { dailyIn: Infinity, dailyOut: Infinity, monthlyOut: Infinity },
};

export async function checkMemberLimit(
  memberId: string,
  direction: "in" | "out",
  amount: number,
  tier: "tier1" | "tier2" | "tier3" = "tier1",
): Promise<{ ok: boolean; message?: string }> {
  // Aggregate today's total for this member+direction
  // Compare against tier limit
  // Return ok or reject message
}

export async function recordTransaction(
  memberId: string,
  direction: "in" | "out",
  amount: number,
  type: string,
): Promise<void> {
  // Upsert daily aggregate in TransactionLedger
}
```

### Enforcement Points
| Operation | Direction | Where to Add |
|-----------|-----------|--------------|
| Contribution (save) | IN | `cooperative.ts:createContribution` |
| Top-up (bank transfer) | IN | `payments/topup.ts:handlePaymentNotification` |
| Dividend credit | IN | `dividends.ts:distributeDividend` |
| Withdrawal | OUT | `withdrawals.ts:requestWithdrawal` |
| Loan disbursement | OUT | `disbursements.ts:disburseLoan` |
| Payout | OUT | `admin.ts:handlePayout` |
| Pay-anyone | OUT | `payanyone.ts:payExternal` |
| Payroll | OUT | `payroll.ts:runPayroll` |

---

## Fix #18: Audit Trail for All Money Movements

**Priority:** HIGH  
**Time:** 1 hour  
**Risk:** LOW

### Problem
No immutable audit log exists for CBN inspection. Current logs are console/pino which can be modified.

### Solution
Create an `AuditLog` model that records EVERY money operation with before/after balances.

### Database Changes
```prisma
model AuditLog {
  id          String   @id @default(cuid())
  memberId    String?
  action      String   // "contribution.create", "wallet.debit", "payout.send"
  amount      Int?     // in kobo
  balanceBefore Int?   // wallet balance before
  balanceAfter  Int?   // wallet balance after
  metadata    String?  // JSON with extra context (txRef, provider, etc.)
  createdAt   DateTime @default(now())
  
  @@index([memberId, createdAt])
  @@index([action, createdAt])
}
```

### New File: `src/lib/audit.ts`
```typescript
import { prisma } from "./prisma.js";

export interface AuditEntry {
  memberId?: string;
  action: string;
  amount?: number;
  balanceBefore?: number;
  balanceAfter?: number;
  metadata?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      ...entry,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : undefined,
    },
  });
}
```

### Integration Points
- `cooperative.ts:createContribution` — log contribution + balance change
- `withdrawals.ts:finalizeWithdrawal` — log debit + balance change
- `admin.ts:handlePayout` — log payout + balance change
- `disbursements.ts:disburseLoan` — log loan disbursement
- `payments/topup.ts` — log top-up credit

---

## Fix #19: Suspicious Activity Alerts

**Priority:** HIGH  
**Time:** 1 hour  
**Risk:** LOW

### Problem
No detection for unusual patterns (large transfers, rapid sequences, new payees).

### Solution
Add checks in `fraud.ts` that are called before every money-out operation.

### Rules
| Rule | Threshold | Action |
|------|-----------|--------|
| Large transfer | > ₦1,000,000 | Alert + 10-min delay |
| Rapid sequence | > 3 transfers in 5 min | Block + alert |
| New payee | First time to this bank account | 24h hold |
| Night transfer | 12am - 5am | Alert only |
| Amount anomaly | > 5x member's average | Alert |

### New File: `src/services/alerts.ts`
```typescript
export async function checkSuspiciousActivity(
  memberId: string,
  amount: number,
  payeeAccount?: string,
): Promise<{ ok: boolean; alert?: string; delay?: number }> {
  // Check large transfer threshold
  // Check rapid sequence
  // Check new payee
  // Check night transfer
  // Check amount anomaly
}
```

---

## Fix #20: Transaction Velocity Checks

**Priority:** MEDIUM  
**Time:** 45 minutes  
**Risk:** LOW

### Problem
A compromised account could perform rapid-fire transactions to drain funds.

### Solution
Rate limit per-member: max 5 money-out transactions per 10-minute window.

### Implementation
```typescript
// In-memory rate limiter (per member)
const velocityMap = new Map<string, number[]>();
const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const VELOCITY_MAX = 5;

export function checkVelocity(memberId: string): boolean {
  const now = Date.now();
  const timestamps = (velocityMap.get(memberId) ?? [])
    .filter(t => now - t < VELOCITY_WINDOW_MS);
  
  if (timestamps.length >= VELOCITY_MAX) return false;
  
  timestamps.push(now);
  velocityMap.set(memberId, timestamps);
  return true;
}
```

### Enforcement
- Call before every wallet debit in `withdrawals.ts`, `admin.ts`, `disbursements.ts`, `payanyone.ts`

---

## Fix #21: Guaranteed Limit Enforcement via Middleware

**Priority:** MEDIUM  
**Time:** 30 minutes  
**Risk:** LOW

### Problem
Even with limit functions, developers might forget to call them.

### Solution
Create a `withLimits()` wrapper that enforces all checks automatically.

```typescript
export async function withLimits<T>(
  memberId: string,
  direction: "in" | "out",
  amount: number,
  action: () => Promise<T>,
): Promise<T> {
  // 1. Check per-transaction limits
  // 2. Check daily/monthly limits
  // 3. Check velocity
  // 4. Check suspicious activity
  // 5. Execute action
  // 6. Record in audit log
  // 7. Record in transaction ledger
  return result;
}
```

---

## Verification Plan

1. Run `npm run typecheck` after each fix
2. Run `npm test` after all fixes
3. Add new test file `tests/limits.test.ts`:
   - Test per-transaction limit enforcement
   - Test daily limit blocking
   - Test velocity blocking
   - Test audit log creation
4. Test in dev environment with real WhatsApp numbers

---

## Deployment Order

1. Fix #16 (enforce existing limits) — no schema change, safe to deploy first
2. Fix #18 (audit trail) — new table, no breaking changes
3. Fix #17 (per-member limits) — new table + enforcement
4. Fix #20 (velocity checks) — in-memory, no schema change
5. Fix #19 (suspicious activity) — new table + checks
6. Fix #21 (middleware wrapper) — refactor, deploy last
