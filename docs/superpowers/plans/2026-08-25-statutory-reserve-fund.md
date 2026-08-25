# Statutory Reserve Fund Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a 20% statutory reserve fund allocation on dividend declarations, compliant with Nigerian cooperative law, with tracking, reporting, and admin commands.

**Architecture:** Add a `ReserveAllocation` model to track each allocation event. Modify dividend distribution to deduct 20% before member payouts. Extend reconciliation services with reserve fund queries and reporting. Add admin command and AI routing.

**Tech Stack:** Prisma (schema + client), TypeScript, Vitest

**Spec:** Nigerian cooperative law requires 20% of net profit be allocated to statutory reserve before dividend distribution.

## Global Constraints

- All monetary values stored in kobo (₦1 = 100 kobo) as `Int`
- Keep `schema.prisma` and `schema.local.prisma` in sync
- Existing tests must pass: `npx vitest run tests/governance.test.ts tests/security.test.ts`
- Type check: `npx tsc --noEmit`

---

## Task 1: Schema Changes

**Files:**
- Modify: `prisma/schema.prisma` (lines 14-50 Cooperative model, add new model after ReconciliationLog)
- Modify: `prisma/schema.local.prisma` (lines 14-50 Cooperative model, add new model after ReconciliationLog)

**Interfaces:**
- Produces: `ReserveAllocation` model, `Cooperative.reserveFundBalance` field

- [ ] **Step 1: Add ReserveAllocation model to schema.prisma**

Add after the `ReconciliationLog` model (after line 71):

```prisma
// ---- Statutory reserve fund allocations ----
// Nigerian cooperative law requires 20% of net profit be allocated to a
// statutory reserve fund before dividends are distributed to members.
model ReserveAllocation {
  id            String      @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id])
  amount        Int         // amount allocated to reserve in kobo
  source        String      // dividend_declaration | profit_sharing | manual
  referenceId   String?     // e.g., dividend batch ID
  note          String?
  createdAt     DateTime    @default(now())

  @@index([cooperativeId, createdAt])
}
```

- [ ] **Step 2: Add reserveFundBalance to Cooperative model in schema.prisma**

In the `Cooperative` model, add after `reconciliationLogs ReconciliationLog[]` (line 46):

```prisma
  reserveAllocations   ReserveAllocation[]
```

And add the field after `dailyPayoutLimit` (line 25):

```prisma
  reserveFundBalance   Int                 @default(0) // statutory reserve fund balance in kobo
```

- [ ] **Step 3: Mirror changes to schema.local.prisma**

Apply the exact same changes to `prisma/schema.local.prisma`:
1. Add `ReserveAllocation` model after `ReconciliationLog`
2. Add `reserveFundBalance Int @default(0)` to `Cooperative` model
3. Add `reserveAllocations ReserveAllocation[]` relation to `Cooperative` model

- [ ] **Step 4: Run prisma db push**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx prisma db push
```

Expected: Schema pushed successfully, client generated.

- [ ] **Step 5: Verify types compile**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx tsc --noEmit
```

Expected: No errors.

---

## Task 2: Update Dividend Distribution with 20% Reserve

**Files:**
- Modify: `src/services/dividends.ts` (lines 56-145, `distributeDividend` function)

**Interfaces:**
- Consumes: `prisma.cooperative`, `prisma.reserveAllocation`, `prisma.ledgerEntry`
- Produces: Modified dividend pool (80% for members), `ReserveAllocation` record, ledger entry with `fundType: "reserve"`

- [ ] **Step 1: Update distributeDividend to allocate 20% statutory reserve**

Replace the `distributeDividend` function body. The key changes:

1. After computing `pool` (line 84), calculate `reserveAmount = Math.floor(pool * 0.20)`
2. Calculate `memberPool = pool - reserveAmount`
3. Create `ReserveAllocation` record
4. Update cooperative's `reserveFundBalance`
5. Post journal entry with `fundType: "reserve"`
6. Use `memberPool` instead of `pool` for member distribution
7. Update the return message to show both amounts

```typescript
export async function distributeDividend(phone: string, rate: number): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
  if (!admin) {
    return { ok: false, message: "Only the super admin can pay dividends." };
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return { ok: false, message: "Rate must be between 0 and 100, e.g. *paydividend 50* pays 50% of profit." };
  }

  const pnl = await computePnl(admin.cooperativeId);
  if (pnl.netProfit <= 0) {
    return {
      ok: false,
      message:
        `There's no profit to share yet (net: ${formatBalance(pnl.netProfit)}).\n` +
        `Profit comes from loan interest, fines and admin charges, minus salaries and payments.`,
    };
  }

  const members = await prisma.member.findMany({
    where: { cooperativeId: admin.cooperativeId },
    include: { wallet: true },
  });
  const totalSaved = members.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  if (totalSaved <= 0 || members.length === 0) {
    return { ok: false, message: "No savings yet — nothing to distribute against." };
  }

  const pool = pnl.netProfit * (rate / 100);
  const reference = `DIV-${Date.now()}`;

  // 20% statutory reserve allocation (Nigerian cooperative law)
  const reserveAmount = Math.floor(pool * 0.20);
  const memberPool = pool - reserveAmount;

  // Create reserve allocation record
  await prisma.reserveAllocation.create({
    data: {
      cooperativeId: admin.cooperativeId,
      amount: reserveAmount,
      source: "dividend_declaration",
      referenceId: reference,
      note: `20% statutory reserve from dividend at ${rate}% of net profit`,
    },
  });

  // Update cooperative reserve fund balance
  await prisma.cooperative.update({
    where: { id: admin.cooperativeId },
    data: { reserveFundBalance: { increment: reserveAmount } },
  });

  // Post ledger entry for reserve allocation
  await recordLedger({
    cooperativeId: admin.cooperativeId,
    type: "appropriation",
    category: "dividend",
    amount: reserveAmount,
    note: `20% statutory reserve from dividend at ${rate}% of net profit`,
    reference: reference,
    fundType: "reserve",
  });

  const dividend = await prisma.dividend.create({
    data: {
      cooperativeId: admin.cooperativeId,
      rate,
      totalPool: memberPool,
      reference,
      status: "distributed",
      distributedAt: new Date(),
      entries: {
        create: members
          .filter((m) => (m.wallet?.totalSaved ?? 0) > 0)
          .map((m) => ({
            memberId: m.id,
            amount: ((m.wallet?.totalSaved ?? 0) / totalSaved) * memberPool,
            status: "paid",
            paidAt: new Date(),
          })),
      },
    },
  });

  // Credit wallets + record the appropriation in the ledger.
  let paidCount = 0;
  for (const m of members) {
    const share = totalSaved > 0 ? ((m.wallet?.totalSaved ?? 0) / totalSaved) * memberPool : 0;
    if (share <= 0) continue;
    paidCount += 1;
    await prisma.$transaction([
      prisma.wallet.update({ where: { id: m.wallet!.id }, data: { balance: { increment: share } } }),
      prisma.contribution.create({
        data: {
          amount: share,
          type: "dividend",
          note: `Dividend at ${rate}% of profit (${reference})`,
          reference: `DIV-${dividend.id.slice(-8)}-${m.id.slice(-6)}`,
          status: "confirmed",
          paidAt: new Date(),
          memberId: m.id,
          cooperativeId: admin.cooperativeId,
        },
      }),
    ]);
  }

  await recordLedger({
    cooperativeId: admin.cooperativeId,
    type: "appropriation",
    category: "dividend",
    amount: memberPool,
    note: `Dividend at ${rate}% of net profit (after 20% reserve)`,
    reference: dividend.id,
    fundType: "operational",
  });

  return {
    ok: true,
    message:
      `🎉 Dividend distributed!\n\n` +
      `Total profit pool: *${formatBalance(pool)}* (${rate}% of ${formatBalance(pnl.netProfit)})\n` +
      `20% statutory reserve: *${formatBalance(reserveAmount)}*\n` +
      `Member dividends: *${formatBalance(memberPool)}* shared among ${paidCount} member(s)\n\n` +
      `_Distributed proportional to savings._`,
  };
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx tsc --noEmit
```

Expected: No errors.

---

## Task 3: Reserve Fund Reporting Functions

**Files:**
- Modify: `src/services/reconciliation.ts` (extend after line 224)

**Interfaces:**
- Consumes: `prisma.reserveAllocation`, `prisma.cooperative`, `getReserveFundBalance`
- Produces: `getReserveHistory()`, `getReserveReport()`

- [ ] **Step 1: Add getReserveHistory function**

Add after `getSegregationReport` function (after line 224):

```typescript
/** List of all reserve fund allocations for a cooperative, newest first. */
export async function getReserveHistory(cooperativeId: string) {
  return prisma.reserveAllocation.findMany({
    where: { cooperativeId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}
```

- [ ] **Step 2: Add getReserveReport function**

Add after `getReserveHistory`:

```typescript
/**
 * Formatted statutory reserve fund report showing balance, allocation history,
 * and compliance status.
 */
export async function getReserveReport(cooperativeId: string): Promise<string> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  if (!coop) return "Cooperative not found.";

  const currentBalance = coop.reserveFundBalance;
  const allocations = await getReserveHistory(cooperativeId);
  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  // Compute net profit for compliance check
  const pnl = await computePnl(cooperativeId);
  const netProfit = pnl.netProfit;
  const requiredReserve = Math.floor(Math.max(0, netProfit) * 0.20);
  const isCompliant = netProfit <= 0 || currentBalance >= requiredReserve;

  const lastAlloc = allocations[0];

  const lines: string[] = [];
  lines.push(`📊 *Statutory Reserve Fund Report*`);
  lines.push(``);
  lines.push(`Current balance:    ${formatBalance(currentBalance)}`);
  lines.push(`Total allocated:    ${formatBalance(totalAllocated)}`);

  if (lastAlloc) {
    const date = lastAlloc.createdAt.toISOString().slice(0, 10);
    const ref = lastAlloc.referenceId ? ` (batch ${lastAlloc.referenceId})` : "";
    lines.push(`Last allocation:    ${date} (${formatBalance(lastAlloc.amount)} from ${lastAlloc.source}${ref})`);
  } else {
    lines.push(`Last allocation:    (none yet)`);
  }

  lines.push(``);
  if (netProfit > 0) {
    lines.push(`Net profit:         ${formatBalance(netProfit)}`);
    lines.push(`Required (20%):     ${formatBalance(requiredReserve)}`);
    lines.push(``);
    lines.push(`Status: ${isCompliant ? "✅ Compliant (reserve >= 20% of net profit)" : "⚠️ Below minimum — reserve < 20% of net profit"}`);
  } else {
    lines.push(`Status: ✅ No profit yet — reserve requirement not applicable`);
  }

  if (allocations.length > 1) {
    lines.push(``);
    lines.push(`*Recent allocations:*`);
    for (const a of allocations.slice(0, 5)) {
      const date = a.createdAt.toISOString().slice(0, 10);
      const ref = a.referenceId ? ` (${a.referenceId})` : "";
      lines.push(`• ${date} — ${formatBalance(a.amount)} from ${a.source}${ref}`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 3: Verify types compile**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx tsc --noEmit
```

Expected: No errors.

---

## Task 4: Admin Command for Reserve Fund

**Files:**
- Modify: `src/services/admin.ts` (add import on line 43, add case in switch around line 644)

**Interfaces:**
- Consumes: `getReserveReport` from reconciliation.ts
- Produces: `reservefund` command handler

- [ ] **Step 1: Add import for getReserveReport**

Update the import on line 43 from:
```typescript
import { getSegregationReport } from "./reconciliation.js";
```
to:
```typescript
import { getSegregationReport, getReserveReport } from "./reconciliation.js";
```

- [ ] **Step 2: Add reservefund case to the switch statement**

Add after the `fundstatus` case (after line 644), before `payanyone`:

```typescript
    case "reservefund": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can view the reserve fund." });
        return true;
      }
      const report = await getReserveReport(coopId);
      await sendText({ to: phone, text: report });
      return true;
    }
```

- [ ] **Step 3: Verify types compile**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx tsc --noEmit
```

Expected: No errors.

---

## Task 5: AI Command Routing

**Files:**
- Modify: `src/lib/ai.ts` (line 25, add to KNOWN_COMMANDS)

**Interfaces:**
- Consumes: `KNOWN_COMMANDS` array
- Produces: Updated array with `reservefund`

- [ ] **Step 1: Add reservefund to KNOWN_COMMANDS**

In `src/lib/ai.ts`, add `"reservefund"` to the admin section of `KNOWN_COMMANDS` (line 24-26). Add it after `"walletreconcile"`:

```typescript
  "pay", "approvewdraw", "approvewithdraw", "audit", "backup", "reconcile", "walletreconcile", "reservefund", "pnl",
```

- [ ] **Step 2: Verify types compile**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx tsc --noEmit
```

Expected: No errors.

---

## Task 6: Conversation Routing

**Files:**
- Modify: `src/services/conversation.ts` (no changes needed — admin commands are routed via `handleAdminCommand`)

**Note:** The `reservefund` command is handled by `handleAdminCommand` in `admin.ts`. The conversation.ts file routes all commands through `handleAdminCommand` first (line 196), so no additional routing is needed in conversation.ts.

- [ ] **Step 1: Verify that reservefund is handled by admin command pipeline**

The command flows: `handleMessage` → `handleAdminCommand` → `case "reservefund"` in admin.ts. No changes needed to conversation.ts.

---

## Task 7: Run Tests

**Files:**
- Test: `tests/governance.test.ts`
- Test: `tests/security.test.ts`

- [ ] **Step 1: Run governance tests**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx vitest run tests/governance.test.ts
```

Expected: All tests pass.

- [ ] **Step 2: Run security tests**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx vitest run tests/security.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Run full test suite**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx vitest run
```

Expected: All tests pass.

---

## Task 8: Update Test Cleanup

**Files:**
- Modify: `tests/governance.test.ts` (line 58-69, beforeEach cleanup)
- Modify: `tests/security.test.ts` (line 99-142, beforeEach cleanup)

**Interfaces:**
- Consumes: `ReserveAllocation` model name
- Produces: Updated cleanup arrays

- [ ] **Step 1: Add reserveAllocation to governance test cleanup**

In `tests/governance.test.ts`, add `"reserveAllocation"` to the cleanup array in the `beforeEach` block (around line 58-69). Add it before `"ledgerEntry"`:

```typescript
    "guarantorDeduction", "reserveAllocation", "ledgerEntry",
```

- [ ] **Step 2: Add reserveAllocation to security test cleanup**

In `tests/security.test.ts`, add `"reserveAllocation"` to the cleanup array in the `beforeEach` block (around line 99-142). Add it before `"ledgerEntry"`:

```typescript
    "guarantorDeduction", "reserveAllocation", "ledgerEntry",
```

- [ ] **Step 3: Run all tests again to verify cleanup works**

```bash
cd C:\Users\Hp\projects\coop-whatsapp && npx vitest run tests/governance.test.ts tests/security.test.ts
```

Expected: All tests pass.
