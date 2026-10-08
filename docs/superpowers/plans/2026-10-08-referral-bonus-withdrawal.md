# Referral Bonus Balance + Withdrawal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each member a running referral-bonus balance and let them withdraw any amount of it to their wallet, their saved bank account, or airtime to any phone number, confirmed with their PIN, on WhatsApp and Telegram.

**Architecture:** A `Member.referralBonusBalance` (kobo) accumulates when a referral qualifies (no auto-payout). A new `ReferralWithdrawal` table records each withdrawal. A guided member flow (`withdrawbonus`) collects amount → destination → phone (airtime) → PIN, then atomically debits the balance and disburses via the existing wallet/bank/VTU paths (deferred past the chat transaction). This supersedes the confirm-at-qualification flow.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/specs/2026-10-08-referral-bonus-withdrawal-design.md`

## Global Constraints

- Money is integer kobo; format with `formatBalance`; parse user input with `parseNaira`.
- `.js` import extensions; no Prisma `enum` (use `String` + comments).
- `prisma/schema.prisma` and `prisma/schema.local.prisma` must stay identical (enforced by `tests/schema-sync.test.ts`).
- Every new table with `cooperativeId` needs a Stage-1 RLS migration + a FORCE-list entry in `prisma/rls/recommended_policies.sql`.
- Coop-scoped writes go through `withTx` + `setCoopContext`; the chat handler is ONE transaction, so provider payouts MUST be deferred via `enqueueAfterCommit` (never inline).
- Every credit/withdrawal/prompt action calls `audit()` with a human-readable description.
- Airtime is GATED behind the VTU adapter (`resolveVtuProvider()` null → not enabled).
- Verification per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted tests green · full suite green (`npm test`) · schema-sync green.

---

## File Structure

- `prisma/schema.prisma`, `prisma/schema.local.prisma` — `Member.referralBonusBalance`, `ReferralWithdrawal`.
- `prisma/migrations/20261045000000_referral_bonus/migration.sql` + `20261046000000_referral_bonus_rls/migration.sql`.
- `prisma/rls/recommended_policies.sql` — FORCE-list entry.
- `src/services/referrals.ts` — bonus credit at qualification; `getReferralBonus`, `withdrawReferralBonus`, `listReferralWithdrawals`; remove the confirm/pay-at-qualify path.
- `src/services/conversation.ts` — new states + routing; remove `confirmreward`/`cancelreward`.
- `src/services/handlers/session.ts` — guided withdrawal states.
- `src/services/admin.ts` — remove `referralpay`; extend `referralreport`.
- `src/services/scheduler.ts` — remove `runReferralPayouts`/`runReferralRewardPrompts` + wiring.
- `tests/referral.test.ts` — tests.

---

### Task 1: Schema, migration, RLS

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261045000000_referral_bonus/migration.sql`
- Create: `prisma/migrations/20261046000000_referral_bonus_rls/migration.sql`
- Modify: `prisma/rls/recommended_policies.sql`
- Test: `tests/schema-sync.test.ts` (existing)

**Interfaces produced:**
- `Member.referralBonusBalance Int @default(0)` (kobo).
- `ReferralWithdrawal` (id, cooperativeId, memberId, amount, destination, phone?, status, providerRef?, note?, createdAt, paidAt?).

- [ ] **Step 1: Add to both schemas**

Add to `Member`:
```prisma
  referralBonusBalance    Int                 @default(0) // kobo; withdrawable referral bonus
  referralWithdrawals     ReferralWithdrawal[]
```
Add to `Cooperative`:
```prisma
  referralWithdrawals ReferralWithdrawal[]
```
Add the model:
```prisma
// A member-initiated withdrawal from their accumulated referral bonus.
model ReferralWithdrawal {
  id            String    @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId      String
  member        Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  amount        Int // kobo
  destination   String // wallet | bank | airtime
  phone         String? // airtime destination number
  status        String    @default("pending") // pending | paid | failed
  providerRef   String?
  note          String?
  createdAt     DateTime  @default(now())
  paidAt        DateTime?

  @@index([cooperativeId, memberId])
  @@index([cooperativeId, status])
}
```

- [ ] **Step 2: Write the migrations**

`20261045000000_referral_bonus/migration.sql`:
```sql
ALTER TABLE "Member" ADD COLUMN "referralBonusBalance" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ReferralWithdrawal" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "destination" TEXT NOT NULL,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "providerRef" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "ReferralWithdrawal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReferralWithdrawal_cooperativeId_memberId_idx" ON "ReferralWithdrawal"("cooperativeId", "memberId");
CREATE INDEX "ReferralWithdrawal_cooperativeId_status_idx" ON "ReferralWithdrawal"("cooperativeId", "status");
ALTER TABLE "ReferralWithdrawal" ADD CONSTRAINT "ReferralWithdrawal_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralWithdrawal" ADD CONSTRAINT "ReferralWithdrawal_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

`20261046000000_referral_bonus_rls/migration.sql` — mirror `20261044000000_referral_rls/migration.sql` with `ARRAY['ReferralWithdrawal']`.

- [ ] **Step 3: FORCE-list entry**

Append `'ReferralWithdrawal'` to the FORCE list in `prisma/rls/recommended_policies.sql` (next to `'Referral'`).

- [ ] **Step 4: Generate + push + verify**

```bash
npm run prisma:generate:local
npx prisma db push --schema prisma/schema.local.prisma --skip-generate
npx vitest run tests/schema-sync.test.ts
```
Expected: schema-sync PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261045000000_referral_bonus prisma/migrations/20261046000000_referral_bonus_rls prisma/rls/recommended_policies.sql
git commit -m "feat(referral): bonus balance + withdrawal schema, migration, RLS"
```

---

### Task 2: Qualification credits the bonus (remove auto-pay + confirm flow)

**Files:**
- Modify: `src/services/referrals.ts`, `src/services/scheduler.ts`, `src/services/conversation.ts`, `src/services/handlers/session.ts`, `src/services/admin.ts`
- Test: `tests/referral.test.ts`

**Interfaces produced:**
- `qualifyReferral(coopId, referredMemberId)` now credits the referrer's `referralBonusBalance` and marks the referral `rewarded`; returns `{ ok, message?, referralId? }` (unchanged shape).
- Removed: `notifyReferralReward`, `confirmreward`/`cancelreward` routing + states, `referralpay`, `runReferralPayouts`/`runReferralRewardPrompts` + its `runSchedulerTick` wiring.

- [ ] **Step 1: Write failing tests**

In `tests/referral.test.ts`:
- `qualifyReferral` credits the referrer's `referralBonusBalance` by `rewardAmount` and sets the referral `rewarded`; no `ReferralWithdrawal`/payout is created.
- A second `qualifyReferral` is a no-op (balance unchanged).
- `runReferralPayouts`/`runReferralRewardPrompts` no longer exists (import fails) — assert by removing its test.

Run: `npx vitest run tests/referral.test.ts` → FAIL.

- [ ] **Step 2: Implement**

In `qualifyReferral`, replace the `enqueueAfterCommit(pay)` block with, inside the same `withTx` claim:
```ts
await tx.member.update({
  where: { id: referral.referrerId },
  data: { referralBonusBalance: { increment: rewardAmount } },
});
```
(keep the `pending → qualified` claim; set `status: "rewarded"` in the claim's `data` instead of `qualified`, and keep `qualifiedAt`). Audit `referral.bonus.credited`. Delete `notifyReferralReward` and the confirm-flow helpers. Remove `runReferralPayouts`/`runReferralRewardPrompts` from `scheduler.ts` and its `runSchedulerTick` call. Remove `confirmreward`/`cancelreward` cases from `conversation.ts` and the `awaiting_referral_reward_pin` case from `session.ts`. Remove `referralpay` from `admin.ts`.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
npx vitest run tests/referral.test.ts && npm run typecheck && npm run lint
git add src/services/referrals.ts src/services/scheduler.ts src/services/conversation.ts src/services/handlers/session.ts src/services/admin.ts tests/referral.test.ts
git commit -m "feat(referral): credit bonus balance at qualification; drop confirm/pay flow"
```

---

### Task 3: Withdrawal service (wallet / bank / airtime)

**Files:**
- Modify: `src/services/referrals.ts`
- Test: `tests/referral.test.ts`

**Interfaces produced:**
```ts
export async function getReferralBonus(coopId: string, memberId: string): Promise<{ ok: boolean; balance: number; message: string }>;
export async function withdrawReferralBonus(
  coopId: string,
  memberId: string,
  input: { amount: number; destination: "wallet" | "bank" | "airtime"; phone?: string },
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string; withdrawalId?: string }>;
export async function listReferralWithdrawals(coopId: string, memberId?: string): Promise<{ ok: boolean; message: string }>;
```

- [ ] **Step 1: Write failing tests**

- `withdrawReferralBonus` wallet: debits `referralBonusBalance`, credits the wallet (journal `expense:referral_reward` / `member_wallet:<id>`), creates a `paid` `ReferralWithdrawal`, audits.
- bank: uses the member's saved account; refuses when none; creates the withdrawal.
- airtime: calls the VTU adapter with the entered phone; gated (no provider) → refuses, balance unchanged.
- amount > balance → refused, balance unchanged; amount ≤ 0 → refused.
- overdraw impossible: two concurrent withdrawals cannot both succeed (conditional debit).
- definite payout failure → balance refunded, withdrawal `failed`.

Run: `npx vitest run tests/referral.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`withdrawReferralBonus`:
1. In `withTx` + `setCoopContext`: validate `amount > 0`; conditional debit
   `tx.member.updateMany({ where: { id: memberId, referralBonusBalance: { gte: amount } }, data: { referralBonusBalance: { decrement: amount } } })`; if `count === 0` → `{ ok:false, message: "Insufficient referral bonus." }`. Create the `ReferralWithdrawal` row (`pending`). Return the prep (member bank details, wallet id).
2. Outside the tx, disburse by destination:
   - `wallet` → `payWalletReward`-style journal + wallet increment (reuse the existing helper).
   - `bank` → `sendToBank` to the member's saved account (`REFBONUS-<withdrawalId>`).
   - `airtime` → `resolveVtuProvider()`; null → refund + `failed`; else `recharge({ phone, amountKobo: amount, reference: "REFBONUS-<id>" })`.
3. On success → mark `paid` + `paidAt` + `providerRef`; audit `referral.bonus.withdrawn`.
4. On definite failure → refund the balance (`increment`) + mark `failed` + audit.
5. On `unsure` → leave `pending` (no refund, no retry); audit `referral.bonus.unconfirmed`.
6. The provider call must run OUTSIDE any tx — callers defer via `enqueueAfterCommit` (Task 4).

`getReferralBonus` reads the balance (RLS-scoped). `listReferralWithdrawals` lists rows.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
npx vitest run tests/referral.test.ts && npm run typecheck && npm run lint
git add src/services/referrals.ts tests/referral.test.ts
git commit -m "feat(referral): referral bonus withdrawal service (wallet/bank/airtime)"
```

---

### Task 4: Commands + guided flow + docs

**Files:**
- Modify: `src/services/referrals.ts`, `src/services/conversation.ts`, `src/services/handlers/session.ts`, `src/services/admin.ts`, `README.md`
- Test: `tests/referral.test.ts`

**Interfaces produced:**
- Member commands `referralbonus`, `withdrawbonus` (guided).
- `referralreport` extended with bonus-outstanding + withdrawal stats.

- [ ] **Step 1: Write failing tests**

- `referralbonus` shows the balance.
- `withdrawbonus` guided: amount → destination (default from `referralRewardType`) → phone (airtime) → PIN → disburses (deferred).
- Wrong PIN → re-challenge, no debit.
- `referralreport` includes bonus/withdrawal figures.

Run: `npx vitest run tests/referral.test.ts` → FAIL.

- [ ] **Step 2: Implement + wire**

- `conversation.ts`: add states `awaiting_bonus_amount`, `awaiting_bonus_destination`, `awaiting_bonus_phone`, `awaiting_bonus_pin`; add `bonusAmount`, `bonusDestination`, `bonusPhone` to `FlowDataSchema`; route `referralbonus` + `withdrawbonus`.
- `handlers/session.ts`: implement the four states. The PIN state verifies via `verifyMemberPin`, then
  `enqueueAfterCommit(() => withdrawReferralBonus(coopId, memberId, { amount, destination, phone }, actor))` (fallback to immediate await), and replies with the outcome/queued message. Reuse the `awaiting_withdraw_pin` pattern.
- `admin.ts`: extend `referralreport` with total bonus outstanding + withdrawal counts.
- `README.md`: document the bonus balance + `withdrawbonus` (amount/destination/phone/PIN), bank = saved account, airtime = any number, both channels.

- [ ] **Step 3: Full gate + commit**

```bash
npm run typecheck && npm run lint && npm test && npx vitest run tests/schema-sync.test.ts
git add src/services/referrals.ts src/services/conversation.ts src/services/handlers/session.ts src/services/admin.ts README.md tests/referral.test.ts
git commit -m "feat(referral): bonus withdrawal commands and docs"
```

---

## Self-Review

- **Spec coverage:** bonus balance (Task 1/2), withdrawal to wallet/bank/airtime (Task 3), guided flow + PIN + both channels (Task 4), `ReferralWithdrawal` table (Task 1), default destination from config (Task 4), removal of the confirm/pay flow (Task 2). ✅
- **Placeholder scan:** no TBD/TODO; each code step names the exact function/pattern.
- **Type consistency:** `getReferralBonus`/`withdrawReferralBonus`/`listReferralWithdrawals` signatures consistent across tasks; `ReferralWithdrawal` fields consistent.
- **Open items:** the `unsure` reconciliation path (spec) is surfaced in `referralreport`; a dedicated reconcile job is deferred unless the existing payout reconciliation covers it.