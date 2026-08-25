# Cooperative Governance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 4 cooperative governance features: dividend rate member vote, AGM scheduling, death claim deduplication, and byelaw registry.

**Architecture:** Schema-first approach — add fields to `CooperativeConfig` and new `Byelaw`/`DeathClaimApproval` models in Prisma, then wire up admin commands in `admin.ts`. Each fix is independent and can be implemented in parallel.

**Tech Stack:** TypeScript, Prisma ORM, PostgreSQL, WhatsApp bot (existing patterns)

**Spec:** `C:\Users\Hp\projects\coop-whatsapp\` (existing codebase — no external spec)

## Global Constraints
- Keep both `schema.prisma` and `schema.local.prisma` in sync
- Run `npx prisma generate` after every schema change
- Run `npx tsc --noEmit` after every code change
- Do NOT break existing functionality
- Follow existing code conventions (kobo integers, audit logging, sendText pattern)

---

## File Structure

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add fields to `CooperativeConfig`, add `Byelaw` model, add `DeathClaimApproval` model |
| `prisma/schema.local.prisma` | Mirror all schema changes |
| `src/services/admin.ts` | Add `agm schedule`, `agm info`, `byelaws add`, `byelaws list` commands; modify `paydividend` for threshold check |
| `src/services/deathclaims.ts` | Add dedup check in `approveClaim` using `DeathClaimApproval` table |
| `src/services/coop-config.ts` | Export `pendingDividendRate`/`lastDividendRate` in `CoopConfig` interface |

---

## Task 1: Schema Changes (All Fixes)

**Files:**
- Modify: `prisma/schema.prisma:884-905` (CooperativeConfig model)
- Modify: `prisma/schema.local.prisma` (mirror)

**Interfaces:**
- Produces: Updated Prisma client with new fields on `CooperativeConfig`, new `Byelaw` and `DeathClaimApproval` models

- [ ] **Step 1: Add fields to CooperativeConfig model**

Add these fields to the `CooperativeConfig` model in `schema.prisma`:

```prisma
model CooperativeConfig {
  // ... existing fields ...
  pendingDividendRate  Float?   // proposed rate awaiting member vote
  lastDividendRate     Float?   // last distributed dividend rate
  nextAGMDate          DateTime? // scheduled AGM date
}
```

- [ ] **Step 2: Add Byelaw model**

Add after the `CooperativeConfig` model:

```prisma
model Byelaw {
  id            String      @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  title         String
  content       String
  createdAt     DateTime    @default(now())

  @@index([cooperativeId])
}
```

Also add `byelaws Byelaw[]` to the `Cooperative` model relations.

- [ ] **Step 3: Add DeathClaimApproval model**

Add after the `DeathValidation` model:

```prisma
model DeathClaimApproval {
  id            String     @id @default(cuid())
  claimId       String
  claim         DeathClaim @relation(fields: [claimId], references: [id], onDelete: Cascade)
  approverId    String
  approver      Member     @relation(fields: [approverId], references: [id])
  createdAt     DateTime   @default(now())

  @@unique([claimId, approverId])
}
```

Also add `approvals DeathClaimApproval[]` to the `DeathClaim` model relations.

- [ ] **Step 4: Mirror changes to schema.local.prisma**

Copy all the same changes to `schema.local.prisma`.

- [ ] **Step 5: Run prisma generate**

```bash
npx prisma generate
```

Expected: Client generated successfully.

---

## Task 2: Dividend Rate Member Vote (Fix #1)

**Files:**
- Modify: `src/services/coop-config.ts:6-21` (CoopConfig interface)
- Modify: `src/services/admin.ts:1148-1170` (paydividend case)

**Interfaces:**
- Consumes: `getCoopConfig`, `updateCoopConfig` from coop-config.ts
- Produces: `pendingDividendRate` and `lastDividendRate` on CoopConfig

- [ ] **Step 1: Update CoopConfig interface**

In `coop-config.ts`, add to the `CoopConfig` interface:

```typescript
pendingDividendRate: number | null;
lastDividendRate: number | null;
```

Add defaults to `DEFAULT_CONFIG`:

```typescript
pendingDividendRate: null,
lastDividendRate: null,
```

Add to the config mapping in `getCoopConfig`:

```typescript
pendingDividendRate: (config as any).pendingDividendRate ?? null,
lastDividendRate: (config as any).lastDividendRate ?? null,
```

- [ ] **Step 2: Add threshold check to paydividend command**

In `admin.ts`, modify the `paydividend` case (lines 1148-1170). Replace the current body with:

```typescript
case "paydividend": {
  if (!isSuper) {
    await sendText({ to: phone, text: "Only the *super admin* can distribute dividends." });
    return true;
  }
  const rate = Number(args[0]);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    await sendText({ to: phone, text: "Usage: *paydividend <rate%>*, e.g. *paydividend 5* to pay a 5% dividend." });
    return true;
  }

  // Threshold check: if rate differs >5% from last rate, require member vote
  const config = await getCoopConfig(coopId);
  if (config.lastDividendRate !== null) {
    const diff = Math.abs(rate - config.lastDividendRate);
    if (diff > 5) {
      // Store the pending rate for member voting
      await updateCoopConfig(coopId, { pendingDividendRate: rate });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "dividend.vote_required",
        detail: `proposed ${rate}% differs ${diff}% from last ${config.lastDividendRate}% — member vote needed`,
      });
      await sendText({
        to: phone,
        text:
          `⚠️ The proposed rate *${rate}%* differs by *${diff}%* from the last dividend rate (${config.lastDividendRate}%).\n\n` +
          `Per cooperative governance rules, rate changes >5% require member approval.\n\n` +
          `Reply *startvote Dividend Rate ${rate}%* to open a member vote on this rate.`,
      });
      return true;
    }
  }

  const result = await distributeDividend(phone, rate);
  await sendText({ to: phone, text: result.message });
  // Update lastDividendRate after successful distribution
  await updateCoopConfig(coopId, { lastDividendRate: rate, pendingDividendRate: null });
  await audit({
    cooperativeId: coopId,
    actorPhone: phone,
    actorId: admin.id,
    actorRole: "superadmin",
    action: "dividend.distribute",
    detail: result.message,
  });
  return true;
}
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Task 3: AGM Scheduling (Fix #2)

**Files:**
- Modify: `src/services/admin.ts:155` (switch block — add before `default`)

**Interfaces:**
- Consumes: `getCoopConfig`, `updateCoopConfig` from coop-config.ts (already imported)
- Produces: `agm schedule <date>` and `agm info` commands

- [ ] **Step 1: Add AGM commands to admin switch**

In `admin.ts`, add two new cases before the `default` case in the switch block (before line 1563):

```typescript
case "agm": {
  if (!isSuper) {
    await sendText({ to: phone, text: "Only the *super admin* can manage AGM scheduling." });
    return true;
  }
  const subcmd = args[0]?.toLowerCase();
  if (subcmd === "schedule") {
    const dateStr = args[1];
    if (!dateStr) {
      await sendText({ to: phone, text: "Usage: *agm schedule <YYYY-MM-DD>*, e.g. *agm schedule 2026-12-15*" });
      return true;
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime()) || date <= new Date()) {
      await sendText({ to: phone, text: "Provide a valid future date in YYYY-MM-DD format." });
      return true;
    }
    await updateCoopConfig(coopId, { nextAGMDate: date } as any);
    await audit({
      cooperativeId: coopId,
      actorPhone: phone,
      actorId: admin.id,
      actorRole: "superadmin",
      action: "agm.schedule",
      detail: `AGM scheduled for ${date.toLocaleDateString("en-GB")}`,
    });
    await sendText({ to: phone, text: `✅ AGM scheduled for *${date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}*.` });
    return true;
  }
  if (subcmd === "info") {
    const config = await getCoopConfig(coopId);
    const nextDate = (config as any).nextAGMDate;
    if (!nextDate) {
      await sendText({ to: phone, text: "No AGM has been scheduled yet. Use *agm schedule <date>* to set one." });
      return true;
    }
    const d = new Date(nextDate);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    const body = [
      `*🏛️ AGM Information*`,
      ``,
      `Date: *${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}*`,
      daysLeft > 0 ? `Days remaining: *${daysLeft}*` : `*This AGM has passed.*`,
    ];
    await sendText({ to: phone, text: body.join("\n") });
    return true;
  }
  await sendText({ to: phone, text: "Usage:\n• *agm schedule <YYYY-MM-DD>* — set the next AGM date\n• *agm info* — view scheduled AGM" });
  return true;
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Task 4: Death Claim Deduplication (Fix #3)

**Files:**
- Modify: `src/services/deathclaims.ts:315-401` (approveClaim function)

**Interfaces:**
- Consumes: `DeathClaimApproval` model from Prisma
- Produces: Duplicate approval prevention in `approveClaim`

- [ ] **Step 1: Add dedup check in approveClaim**

In `deathclaims.ts`, modify the `approveClaim` function. After the governance checks block (after line 341 where `familyAccountNumber` is checked), replace the approval increment section (lines 343-368) with:

```typescript
  // --- Governance checks ---
  const approvalsRequired = claim.approvalsRequired ?? 2;
  let approvalCount = claim.approvalCount ?? 0;
  const familyConfirmed = claim.familyConfirmed ?? false;
  const waitingPeriodEnd = claim.waitingPeriodEnd;

  // DEDUP: Check if this super admin already approved
  const existingApproval = await prisma.deathClaimApproval.findUnique({
    where: { claimId_approverId: { claimId: claim.id, approverId: actor.id } },
  });
  if (existingApproval) {
    return { ok: false, message: `You already approved this claim. Waiting for other super admin(s).` };
  }

  // Record this approval in the junction table
  await prisma.deathClaimApproval.create({
    data: { claimId: claim.id, approverId: actor.id },
  });

  // Increment approval count
  approvalCount += 1;

  await prisma.deathClaim.update({
    where: { id: claim.id },
    data: { approvalCount },
  });

  await audit({
    cooperativeId: claim.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: "superadmin",
    action: "claim.approve",
    targetType: "deathclaim",
    targetId: claim.id,
    detail: `approval ${approvalCount}/${approvalsRequired}`,
  });
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Task 5: Byelaw Registry (Fix #4)

**Files:**
- Modify: `src/services/admin.ts:155` (switch block — add before `default`)

**Interfaces:**
- Consumes: `Byelaw` model from Prisma
- Produces: `byelaws add <title> <content>` and `byelaws list` commands

- [ ] **Step 1: Add byelaws commands to admin switch**

In `admin.ts`, add two new cases before the `default` case in the switch block (before line 1563). Place these right before the `agm` command:

```typescript
case "byelaws": {
  const subcmd = args[0]?.toLowerCase();
  if (subcmd === "add") {
    if (!isSuper) {
      await sendText({ to: phone, text: "Only the *super admin* can add byelaws." });
      return true;
    }
    const title = args[1];
    const content = args.slice(2).join(" ");
    if (!title || !content) {
      await sendText({ to: phone, text: "Usage: *byelaws add <title> <content>*, e.g. *byelaws add Savings Policy Members must save at least 2000 monthly.*" });
      return true;
    }
    await prisma.byelaw.create({
      data: { cooperativeId: coopId, title, content },
    });
    await audit({
      cooperativeId: coopId,
      actorPhone: phone,
      actorId: admin.id,
      actorRole: roleLabel(ctx),
      action: "byelaw.add",
      detail: `added byelaw: ${title}`,
    });
    await sendText({ to: phone, text: `✅ Byelaw "*${title}*" added. Members can view it with *byelaws*.` });
    return true;
  }
  if (subcmd === "list" || !subcmd) {
    const byelaws = await prisma.byelaw.findMany({
      where: { cooperativeId: coopId },
      orderBy: { createdAt: "desc" },
    });
    if (byelaws.length === 0) {
      await sendText({ to: phone, text: "No byelaws registered yet. Admins add with *byelaws add <title> <content>*." });
      return true;
    }
    const body = byelaws.map((b, i) =>
      `*${i + 1}. ${b.title}*\n${b.content}\n_Added: ${b.createdAt.toLocaleDateString("en-GB")}_`
    ).join("\n\n");
    await sendText({ to: phone, text: `*📜 Byelaws*\n\n${body}` });
    return true;
  }
  await sendText({ to: phone, text: "Usage:\n• *byelaws add <title> <content>* — add a byelaw (super admin)\n• *byelaws list* — view all byelaws" });
  return true;
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Task 6: Final Verification

- [ ] **Step 1: Run prisma generate**

```bash
npx prisma generate
```

Expected: Client generated successfully.

- [ ] **Step 2: Run full TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Verify no existing functionality broken**

Check that existing commands still work by reviewing the switch statement structure — all existing cases remain intact.
