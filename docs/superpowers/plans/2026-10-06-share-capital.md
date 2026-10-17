# Share Capital (Member Equity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add member share capital to `coop-whatsapp` — members buy shares (permanent equity) with their savings, hold them, and receive dividends on shares, distinct from savings.

**Architecture:** Two new Prisma models (`ShareAccount`, `ShareTransaction`) plus four `CooperativeConfig` fields. A new `src/services/shares.ts` service owns all share logic (buy, view, share-dividend). Chat commands `shares` / `buyshares` are thin handlers over the service. Share purchases move money from the member's savings liability (`member_wallet:<walletId>`) into `equity:share_capital` via a balanced journal pair — no bank movement. Share dividends credit wallets directly, allocated by shareholding using the same largest-remainder method the savings dividend engine already uses.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Fastify 5, Prisma 6, vitest 3, SQLite (tests) / Postgres (prod).

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 1, Feature 1). This plan implements the "Share capital (member equity)" row.

## Global Constraints

- **WhatsApp-only.** No USSD/SMS. (User decision 2026-10-06.)
- **Money is integer kobo** everywhere (`₦1 = 100 kobo`). Format with `formatBalance`; parse user input with `parseNaira` (returns kobo).
- **Both schemas must stay identical** (datamodel): `prisma/schema.prisma` (Postgres) and `prisma/schema.local.prisma` (SQLite). `tests/schema-sync.test.ts` enforces it.
- **No Prisma `enum` declarations** — use `String` fields with an inline `// a | b | c` comment.
- **Every new `cooperativeId`-scoped table needs RLS**: a Stage-1 `ENABLE` + policy migration, and an entry in `prisma/rls/recommended_policies.sql` (FORCE list).
- **Tenancy:** chat writes run inside `withCoopContext`; inside a `withTx` block call `await setCoopContext(tx as never, cooperativeId)` first.
- **Audit** every money action with `audit()`; **journal** every money movement with a balanced `postJournal` pair.
- **Verification gate per task:** `npm run typecheck` clean, `npm run lint` 0 errors, targeted test green. Final task runs the full suite.

---

### Task 1: Schema, migration, and RLS for share capital

**Files:**
- Modify: `prisma/schema.prisma` (add 2 models, 4 config fields, 4 relation fields)
- Modify: `prisma/schema.local.prisma` (identical datamodel)
- Create: `prisma/migrations/20261014000000_share_capital/migration.sql`
- Create: `prisma/migrations/20261015000000_share_capital_rls/migration.sql`
- Modify: `prisma/rls/recommended_policies.sql`
- Test: `tests/schema-sync.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `ShareAccount` (`id`, `cooperativeId`, `memberId`, `shares: Int`, `totalPaid: Int`, `createdAt`, `updatedAt`) and `ShareTransaction` (`id`, `cooperativeId`, `memberId`, `shareAccountId`, `type: String`, `shares: Int`, `amount: Int`, `pricePerShare: Int`, `reference: String @unique`, `note: String?`, `createdAt`). `CooperativeConfig` gains `sharePrice: Int` (kobo, default `100000`), `minShares: Int` (default `1`), `maxShares: Int` (default `0` = unlimited), `allowShareRedemption: Boolean` (default `false`).

- [ ] **Step 1: Add the two models to `prisma/schema.prisma`**

Insert immediately after the `DividendEntry` model (which ends at the `@@unique([dividendId, memberId])` line, before `// ---- Broadcasts`):

```prisma
// ---- Share capital (member equity) ----
// Members buy shares in the cooperative. Unlike savings (a liability the member
// can withdraw), share capital is permanent member equity: it earns dividends
// and carries ownership. One member = one vote regardless of shares held.
model ShareAccount {
  id            String   @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId      String
  member        Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  shares        Int      @default(0) // number of shares currently held
  totalPaid     Int      @default(0) // kobo paid for shares currently held
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  transactions  ShareTransaction[]

  @@unique([cooperativeId, memberId])
  @@index([cooperativeId])
}

model ShareTransaction {
  id             String       @id @default(cuid())
  cooperativeId  String
  cooperative    Cooperative  @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId       String
  member         Member       @relation(fields: [memberId], references: [id], onDelete: Cascade)
  shareAccountId String
  shareAccount   ShareAccount @relation(fields: [shareAccountId], references: [id], onDelete: Cascade)
  type           String       // purchase | redemption | dividend
  shares         Int          // shares bought (+) / redeemed (-); 0 for a dividend
  amount         Int          // kobo moved
  pricePerShare  Int          // kobo per share at the time of the transaction
  reference      String       @unique
  note           String?
  createdAt      DateTime     @default(now())

  @@index([cooperativeId, memberId, createdAt])
}
```

- [ ] **Step 2: Add the relation fields to `Cooperative` and `Member` in `prisma/schema.prisma`**

In `model Cooperative`, after the line `phoneChangeRequests PhoneChangeRequest[]` (line ~65), add:

```prisma
  shareAccounts      ShareAccount[]
  shareTransactions  ShareTransaction[]
```

In `model Member`, after the line `sessionsRevokedAt       DateTime? // when the superadmin revoked this member's sessions` (line ~239), add:

```prisma
  shareAccount            ShareAccount?
  shareTransactions       ShareTransaction[]
```

- [ ] **Step 3: Add the four config fields to `CooperativeConfig` in `prisma/schema.prisma`**

After the line `commercialIncome         Int      @default(0) // kobo from non-member activities` (line ~1059), add:

```prisma
  sharePrice               Int      @default(100000) // kobo per share (₦1,000)
  minShares                Int      @default(1)
  maxShares                Int      @default(0) // 0 = unlimited
  allowShareRedemption     Boolean  @default(false)
```

- [ ] **Step 4: Mirror all of Steps 1–3 into `prisma/schema.local.prisma`**

Apply the exact same edits to `prisma/schema.local.prisma`. The datamodel must be byte-identical apart from the leading comments and the `datasource` provider line.

- [ ] **Step 5: Write the Postgres migration**

Create `prisma/migrations/20261014000000_share_capital/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "ShareAccount" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "totalPaid" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShareAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareTransaction" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "shareAccountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "pricePerShare" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShareTransaction_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CooperativeConfig" ADD COLUMN "sharePrice" INTEGER NOT NULL DEFAULT 100000,
ADD COLUMN "minShares" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "maxShares" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "allowShareRedemption" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "ShareAccount_cooperativeId_memberId_key" ON "ShareAccount"("cooperativeId", "memberId");
CREATE INDEX "ShareAccount_cooperativeId_idx" ON "ShareAccount"("cooperativeId");
CREATE UNIQUE INDEX "ShareTransaction_reference_key" ON "ShareTransaction"("reference");
CREATE INDEX "ShareTransaction_cooperativeId_memberId_createdAt_idx" ON "ShareTransaction"("cooperativeId", "memberId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShareAccount" ADD CONSTRAINT "ShareAccount_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareAccount" ADD CONSTRAINT "ShareAccount_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareTransaction" ADD CONSTRAINT "ShareTransaction_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareTransaction" ADD CONSTRAINT "ShareTransaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareTransaction" ADD CONSTRAINT "ShareTransaction_shareAccountId_fkey" FOREIGN KEY ("shareAccountId") REFERENCES "ShareAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 6: Write the RLS migration for the new tables**

Create `prisma/migrations/20261015000000_share_capital_rls/migration.sql`:

```sql
-- Row-Level Security for share-capital tables (Stage 1: ENABLE, not FORCE).
-- Both tables carry a cooperativeId column, so they use the direct policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ShareAccount','ShareTransaction']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMIT;
```

- [ ] **Step 7: Add the new tables to the Stage-2 FORCE list**

In `prisma/rls/recommended_policies.sql`, in the `FOREACH t IN ARRAY ARRAY[...]` list, add `'ShareAccount','ShareTransaction',` to the "Directly cooperativeId-scoped tables" group (e.g. after `'ReserveAllocation',`).

- [ ] **Step 8: Regenerate the local client and run the schema-sync test**

Run: `npm run prisma:generate:local`
Then: `npx vitest run tests/schema-sync.test.ts`
Expected: PASS (both schemas normalise equal; prod=postgresql, local=sqlite).

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261014000000_share_capital prisma/migrations/20261015000000_share_capital_rls prisma/rls/recommended_policies.sql
git commit -m "feat(shares): add ShareAccount/ShareTransaction schema, migration, RLS"
```

---

### Task 2: Share service core (buy, view, allocation)

**Files:**
- Create: `src/services/shares.ts`
- Test: `tests/shares.test.ts`

**Interfaces:**
- Consumes: `prisma`, `withTx` from `../lib/prisma.js`; `setCoopContext` from `../lib/tenant-context.js`; `postJournal` from `./journal.js`; `formatBalance` from `./cooperative.js`; `audit` from `./audit.js`; `computePnl` from `./ledger.js`.
- Produces:
  - `allocateByShares(holdings: { id: string; shares: number }[], pool: number): Map<string, number>` — pure, largest-remainder allocation; sums to `pool` when `pool > 0` and total shares `> 0`.
  - `getShareAccount(memberId: string): Promise<{ shares: number; totalPaid: number; pricePerShare: number; value: number } | null>`
  - `buyShares(memberId: string, count: number): Promise<{ ok: boolean; message: string }>`
  - `distributeShareDividend(phone: string, rate: number): Promise<{ ok: boolean; message: string; pool?: number; paid?: number }>` (used in Task 4)

- [ ] **Step 1: Write the failing tests**

Create `tests/shares.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { allocateByShares, buyShares, getShareAccount } from "../src/services/shares.js";

async function fundWallet(memberId: string, kobo: number) {
  await prisma.wallet.update({ where: { memberId }, data: { balance: kobo, totalSaved: kobo } });
}

describe("share capital", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.shareTransaction.deleteMany();
    await prisma.shareAccount.deleteMany();
    await prisma.posting.deleteMany();
    await prisma.journalEntry.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  it("allocates a pool by shareholding with no kobo lost", () => {
    const holdings = [
      { id: "a", shares: 1 },
      { id: "b", shares: 1 },
      { id: "c", shares: 1 },
    ];
    const out = allocateByShares(holdings, 100);
    const total = [...out.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
    expect(out.get("a")).toBeGreaterThanOrEqual(33);
  });

  it("buys shares from the wallet and posts a balanced journal", async () => {
    const coop = await createTestCoop("SHARE1");
    const member = await createTestMember(coop.id, { phone: "2348000000001" });
    await fundWallet(member.id, 500000); // ₦5,000

    const result = await buyShares(member.id, 3); // 3 × ₦1,000 = ₦3,000
    expect(result.ok).toBe(true);

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares).toBe(3);
    expect(account?.totalPaid).toBe(300000);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(200000); // ₦5,000 − ₦3,000

    const postings = await prisma.posting.findMany();
    const debit = postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount, 0);
    const credit = postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount, 0);
    expect(debit).toBe(credit);
    expect(postings.some((p) => p.account === "equity:share_capital")).toBe(true);
  });

  it("refuses a purchase the wallet cannot cover", async () => {
    const coop = await createTestCoop("SHARE2");
    const member = await createTestMember(coop.id, { phone: "2348000000002" });
    await fundWallet(member.id, 50000); // ₦500

    const result = await buyShares(member.id, 1); // costs ₦1,000
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/save/i);
    expect(await prisma.shareAccount.findFirst({ where: { memberId: member.id } })).toBeNull();
  });

  it("reports the share account value", async () => {
    const coop = await createTestCoop("SHARE3");
    const member = await createTestMember(coop.id, { phone: "2348000000003" });
    await fundWallet(member.id, 500000);
    await buyShares(member.id, 2);

    const account = await getShareAccount(member.id);
    expect(account?.shares).toBe(2);
    expect(account?.value).toBe(200000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/shares.test.ts`
Expected: FAIL — `Cannot find module '../src/services/shares.js'`.

- [ ] **Step 3: Implement `src/services/shares.ts`**

```ts
import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { postJournal } from "./journal.js";
import { formatBalance } from "./cooperative.js";
import { computePnl } from "./ledger.js";
import { audit } from "./audit.js";

const DEFAULT_SHARE_PRICE = 100000; // kobo (₦1,000)
const MAX_DIVIDEND_RATE = 25; // per Nigerian Cooperative Societies Act

/** Largest-remainder (Hamilton) allocation of `pool` kobo across shareholdings. */
export function allocateByShares(
  holdings: { id: string; shares: number }[],
  pool: number,
): Map<string, number> {
  const eligible = holdings.filter((h) => h.shares > 0);
  const totalShares = eligible.reduce((sum, h) => sum + h.shares, 0);
  const out = new Map<string, number>();
  if (totalShares <= 0 || pool <= 0) return out;

  const raw = eligible.map((h) => {
    const exact = (h.shares / totalShares) * pool;
    const kobo = Math.floor(exact);
    return { id: h.id, kobo, remainder: exact - kobo };
  });
  let leftover = pool - raw.reduce((sum, r) => sum + r.kobo, 0);
  raw.sort((a, b) => b.remainder - a.remainder);
  for (const r of raw) {
    if (leftover <= 0) break;
    r.kobo += 1;
    leftover -= 1;
  }
  for (const r of raw) out.set(r.id, r.kobo);
  return out;
}

export async function getShareAccount(memberId: string): Promise<{
  shares: number;
  totalPaid: number;
  pricePerShare: number;
  value: number;
} | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { cooperative: { include: { config: true } } },
  });
  if (!member) return null;
  const pricePerShare = member.cooperative.config?.sharePrice ?? DEFAULT_SHARE_PRICE;
  const account = await prisma.shareAccount.findFirst({ where: { memberId } });
  const shares = account?.shares ?? 0;
  return {
    shares,
    totalPaid: account?.totalPaid ?? 0,
    pricePerShare,
    value: shares * pricePerShare,
  };
}

export async function buyShares(
  memberId: string,
  count: number,
): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(count) || count <= 0) {
    return { ok: false, message: "Enter a whole number of shares, e.g. *buyshares 5*." };
  }

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { wallet: true, cooperative: { include: { config: true } } },
  });
  if (!member || !member.wallet) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  const price = member.cooperative.config?.sharePrice ?? DEFAULT_SHARE_PRICE;
  const minShares = member.cooperative.config?.minShares ?? 1;
  const maxShares = member.cooperative.config?.maxShares ?? 0;
  const cost = price * count;

  if (count < minShares) {
    return { ok: false, message: `The minimum purchase is *${minShares}* share(s).` };
  }

  const account = await prisma.shareAccount.upsert({
    where: { cooperativeId_memberId: { cooperativeId: member.cooperativeId, memberId } },
    create: { cooperativeId: member.cooperativeId, memberId },
    update: {},
  });

  if (maxShares > 0 && account.shares + count > maxShares) {
    return { ok: false, message: `You can hold at most *${maxShares}* shares.` };
  }
  if (member.wallet.balance < cost) {
    return {
      ok: false,
      message:
        `Buying *${count}* share(s) costs *${formatBalance(cost)}* but your savings balance is ` +
        `*${formatBalance(member.wallet.balance)}*.\n\nReply *save <amount>* to top up first.`,
    };
  }

  const reference = `SHARE-BUY-${member.cooperativeId}-${memberId}-${Date.now()}`;
  const walletId = member.wallet.id;

  await withTx(async (tx) => {
    await setCoopContext(tx as never, member.cooperativeId);
    await tx.wallet.update({ where: { id: walletId }, data: { balance: { decrement: cost } } });
    await tx.shareAccount.update({
      where: { id: account.id },
      data: { shares: { increment: count }, totalPaid: { increment: cost } },
    });
    await tx.shareTransaction.create({
      data: {
        cooperativeId: member.cooperativeId,
        memberId,
        shareAccountId: account.id,
        type: "purchase",
        shares: count,
        amount: cost,
        pricePerShare: price,
        reference,
      },
    });
    await postJournal(
      {
        cooperativeId: member.cooperativeId,
        txRef: reference,
        description: `Share purchase: ${count} share(s)`,
        postings: [
          { account: `member_wallet:${walletId}`, direction: "DEBIT", amount: cost, memberId },
          { account: "equity:share_capital", direction: "CREDIT", amount: cost },
        ],
      },
      tx as any,
    );
  });

  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: member.phone,
    actorId: memberId,
    actorRole: member.role,
    action: "shares.buy",
    targetType: "share_account",
    targetId: account.id,
    amount: cost,
    detail: `${count} share(s) @ ${price} kobo`,
  }).catch(() => {});

  const newShares = account.shares + count;
  return {
    ok: true,
    message:
      `✅ You bought *${count}* share(s) for *${formatBalance(cost)}*.\n\n` +
      `You now hold *${newShares}* share(s) worth *${formatBalance(newShares * price)}*.`,
  };
}

export async function distributeShareDividend(
  phone: string,
  rate: number,
): Promise<{ ok: boolean; message: string; pool?: number; paid?: number }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
  if (!admin) return { ok: false, message: "Only the super admin can pay dividends." };
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_DIVIDEND_RATE) {
    return { ok: false, message: `Rate must be between 0 and ${MAX_DIVIDEND_RATE}.` };
  }

  const pnl = await computePnl(admin.cooperativeId);
  if (pnl.netProfit <= 0) {
    return { ok: false, message: `There's no profit to share yet (net: ${formatBalance(pnl.netProfit)}).` };
  }

  const accounts = await prisma.shareAccount.findMany({
    where: { cooperativeId: admin.cooperativeId, shares: { gt: 0 } },
    select: {
      id: true,
      memberId: true,
      shares: true,
      member: { select: { name: true, wallet: { select: { id: true } } } },
    },
  });
  const totalShares = accounts.reduce((sum, a) => sum + a.shares, 0);
  if (totalShares <= 0) {
    return { ok: false, message: "No shares have been issued yet — nothing to distribute against." };
  }

  const reserve = Math.floor(pnl.netProfit * 0.2);
  const education = Math.floor(pnl.netProfit * 0.02);
  const development = Math.floor(pnl.netProfit * 0.05);
  const distributable = Math.max(0, pnl.netProfit - reserve - education - development);
  const pool = Math.max(0, Math.round(distributable * (rate / 100)));
  if (pool <= 0) {
    return { ok: false, message: "After statutory deductions there's no distributable profit left." };
  }

  const allocation = allocateByShares(
    accounts.map((a) => ({ id: a.memberId, shares: a.shares })),
    pool,
  );
  const reference = `SHARE-DIV-${Date.now()}`;
  let paid = 0;

  await withTx(async (tx) => {
    await setCoopContext(tx as never, admin.cooperativeId);
    for (const a of accounts) {
      const amount = allocation.get(a.memberId) ?? 0;
      if (amount <= 0 || !a.member.wallet) continue;
      await tx.wallet.update({
        where: { id: a.member.wallet.id },
        data: { balance: { increment: amount } },
      });
      await tx.shareTransaction.create({
        data: {
          cooperativeId: admin.cooperativeId,
          memberId: a.memberId,
          shareAccountId: a.id,
          type: "dividend",
          shares: 0,
          amount,
          pricePerShare: 0,
          reference: `${reference}-${a.memberId}`,
          note: `Share dividend at ${rate}%`,
        },
      });
      await postJournal(
        {
          cooperativeId: admin.cooperativeId,
          txRef: `${reference}-${a.memberId}`,
          description: `Share dividend to ${a.member.name}`,
          postings: [
            { account: "appropriation:dividend", direction: "DEBIT", amount },
            { account: `member_wallet:${a.member.wallet.id}`, direction: "CREDIT", amount, memberId: a.memberId },
          ],
        },
        tx as any,
      );
      paid++;
    }
  });

  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: admin.phone,
    actorId: admin.id,
    actorRole: admin.role,
    action: "shares.dividend",
    targetType: "share_dividend",
    targetId: reference,
    amount: pool,
    detail: `Share dividend at ${rate}% to ${paid} member(s)`,
  }).catch(() => {});

  return {
    ok: true,
    message:
      `🎉 *Share dividend paid*\n\n` +
      `Rate: *${rate}%* of net profit ${formatBalance(pnl.netProfit)}\n` +
      `Pool: *${formatBalance(pool)}*\n` +
      `Credited to *${paid}* shareholder(s).`,
    pool,
    paid,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/shares.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/shares.ts tests/shares.test.ts
git commit -m "feat(shares): share service — buy, view, allocation, share dividend"
```

---

### Task 3: Chat commands `shares` and `buyshares`

**Files:**
- Modify: `src/services/handlers/money.ts` (add two handlers)
- Modify: `src/services/conversation.ts` (import + switch cases)
- Modify: `src/services/handlers/session.ts` (`buildFullMenu`)
- Modify: `src/services/telegram-bot.ts` (`setTelegramCommands`)
- Test: `tests/shares.test.ts` (add a `handleMessage` case)

**Interfaces:**
- Consumes: `buyShares`, `getShareAccount` from `../shares.js` (Task 2); `getMemberByPhone`, `formatBalance` from `../cooperative.js`; `sendText` from `../../lib/messaging.js`; `parseNaira` from `./session.js`.
- Produces: `handleShares(phone: string): Promise<void>` and `handleBuyShares(phone: string, args: string[]): Promise<void>` exported from `src/services/handlers/money.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/shares.test.ts`:

```ts
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

describe("shares chat commands", () => {
  it("buys shares via the chat command", async () => {
    const coop = await createTestCoop("SHARECHAT");
    const member = await createTestMember(coop.id, { phone: "2348000000099" });
    await fundWallet(member.id, 500000);

    await handleMessage(member.phone, "buyshares 2");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares).toBe(2);
    const calls = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(calls).toMatch(/share/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shares.test.ts -t "buys shares via the chat command"`
Expected: FAIL — the command is unhandled, so no `ShareAccount` row is created.

- [ ] **Step 3: Add the handlers to `src/services/handlers/money.ts`**

Add to the imports at the top:

```ts
import { buyShares, getShareAccount } from "../shares.js";
```

Append at the end of the file:

```ts
export async function handleShares(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const account = await getShareAccount(member.id);
  if (!account) {
    await sendText({ to: phone, text: "We couldn't load your share account. Please try again." });
    return;
  }
  await sendText({
    to: phone,
    text:
      `📈 *Your shares*\n\n` +
      `Shares held: *${account.shares}*\n` +
      `Value: *${formatBalance(account.value)}* (at ${formatBalance(account.pricePerShare)}/share)\n` +
      `Total paid: *${formatBalance(account.totalPaid)}*\n\n` +
      `Reply *buyshares <count>* to buy more.`,
  });
}

export async function handleBuyShares(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const count = args[0] ? parseInt(args[0], 10) : NaN;
  if (!Number.isInteger(count) || count <= 0) {
    await sendText({ to: phone, text: "How many shares? Reply *buyshares <count>*, e.g. *buyshares 5*." });
    return;
  }
  const result = await buyShares(member.id, count);
  await sendText({ to: phone, text: result.message });
}
```

- [ ] **Step 4: Wire the commands into `src/services/conversation.ts`**

Add `handleShares, handleBuyShares` to the existing import from `./handlers/money.js` (the import block around lines 59–112).

In `handleMessageInner`'s `switch (cmd)`, add these cases next to the other money commands (near the `case "balance":` block, before `default:`):

```ts
    case "shares":
      await handleShares(phone);
      break;
    case "buyshares":
      await handleBuyShares(phone, args);
      break;
```

- [ ] **Step 5: Add the commands to the menu and Telegram list**

In `src/services/handlers/session.ts` `buildFullMenu`, in the `*💰 Money*` section, after the `• *fund* — your personal top-up account` line, add:

```
    `• *shares* / *buyshares <count>* — own shares in the coop\n` +
```

In `src/services/telegram-bot.ts` `setTelegramCommands`, add to the array:

```ts
    { command: "shares", description: "View your shares" },
    { command: "buyshares", description: "Buy shares in the cooperative" },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/shares.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck` → clean. `npm run lint` → 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/handlers/money.ts src/services/conversation.ts src/services/handlers/session.ts src/services/telegram-bot.ts tests/shares.test.ts
git commit -m "feat(shares): shares and buyshares chat commands"
```

---

### Task 4: Share dividend admin command `paysharedividend`

**Files:**
- Modify: `src/services/admin.ts` (add a `case` in `handleAdminCommand`)
- Modify: `src/services/handlers/session.ts` (`buildAdminMenu` super-admin line)
- Test: `tests/shares.test.ts` (add a share-dividend case)

**Interfaces:**
- Consumes: `distributeShareDividend` from `./shares.js` (Task 2).
- Produces: the `paysharedividend <rate%>` admin command.

- [ ] **Step 1: Write the failing test**

Append to `tests/shares.test.ts`:

```ts
import { distributeShareDividend } from "../src/services/shares.js";

describe("share dividend", () => {
  it("credits shareholders by shareholding", async () => {
    const coop = await createTestCoop("SHAREDIV");
    const admin = await createTestMember(coop.id, { phone: "2348000000100", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000000101" });
    const b = await createTestMember(coop.id, { phone: "2348000000102" });
    await fundWallet(admin.id, 1000000);
    await fundWallet(a.id, 1000000);
    await fundWallet(b.id, 1000000);
    await buyShares(a.id, 3);
    await buyShares(b.id, 1);

    // Seed profit so there is something to distribute.
    await prisma.ledgerEntry.create({
      data: { cooperativeId: coop.id, type: "income", category: "interest", amount: 1000000 },
    });

    const result = await distributeShareDividend(admin.phone, 20);
    expect(result.ok).toBe(true);

    const aAfter = await prisma.wallet.findUnique({ where: { memberId: a.id } });
    const bAfter = await prisma.wallet.findUnique({ where: { memberId: b.id } });
    // a holds 3 of 4 shares → gets ~3× b's dividend
    expect((aAfter?.balance ?? 0) - 700000).toBeGreaterThan((bAfter?.balance ?? 0) - 900000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shares.test.ts -t "credits shareholders by shareholding"`
Expected: FAIL — `distributeShareDividend` is not exported yet (Task 2 adds it; if Task 2 is done, this test should already pass — if so, proceed).

- [ ] **Step 3: Add the admin command to `src/services/admin.ts`**

Add to the imports:

```ts
import { distributeShareDividend } from "./shares.js";
```

In `handleAdminCommand`'s `switch (cmd)`, add a case (near `case "paydividend"`):

```ts
    case "paysharedividend": {
      const rate = Number(args[0]);
      const result = await distributeShareDividend(phone, rate);
      await sendText({ to: phone, text: result.message });
      return true;
    }
```

- [ ] **Step 4: Add the command to the admin menu**

In `src/services/handlers/session.ts` `buildAdminMenu`, in the `*Super admin:*` line, add `*paysharedividend <rate%>*` after `*paydividend <rate%>*`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/shares.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck` → clean. `npm run lint` → 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/admin.ts src/services/handlers/session.ts tests/shares.test.ts
git commit -m "feat(shares): paysharedividend admin command"
```

---

### Task 5: Admin REST endpoint, docs, and full verification

**Files:**
- Modify: `src/routes/admin.ts` (add `GET /api/admin/shares`)
- Modify: `README.md` (document share capital)
- Test: `tests/shares.test.ts` (add an endpoint test)

**Interfaces:**
- Consumes: `prisma` (already imported in `admin.ts`), `withTenant`, `requireSuper`.
- Produces: `GET /api/admin/shares` → `{ ok: true, accounts: { memberId, name, shares, totalPaid, value }[], totalShares, sharePrice }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/shares.test.ts`:

```ts
import { createTestApp } from "./setup.js";

describe("shares admin endpoint", () => {
  it("lists share accounts for the cooperative", async () => {
    const coop = await createTestCoop("SHAREAPI");
    const admin = await createTestMember(coop.id, { phone: "2348000000200", role: "superadmin", pin: "1234" });
    const m = await createTestMember(coop.id, { phone: "2348000000201" });
    await fundWallet(m.id, 500000);
    await buyShares(m.id, 2);

    const app = await createTestApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "x-requested-with": "xmlhttprequest" },
      payload: { phone: admin.phone, pin: "1234" },
    });
    const cookie = login.headers["set-cookie"] as string;

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/shares",
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.totalShares).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shares.test.ts -t "lists share accounts"`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the endpoint to `src/routes/admin.ts`**

Inside `adminApiRoutes`, after the preHandler hook (line ~182) and alongside the other `withTenant` routes, add:

```ts
  app.get("/api/admin/shares", withTenant(async (req) => {
    const coopId = req.adminCoopId!;
    const config = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
    const sharePrice = config?.sharePrice ?? 100000;
    const accounts = await prisma.shareAccount.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true } } },
      orderBy: { shares: "desc" },
    });
    const totalShares = accounts.reduce((sum, a) => sum + a.shares, 0);
    return {
      ok: true,
      sharePrice,
      totalShares,
      accounts: accounts.map((a) => ({
        memberId: a.memberId,
        name: a.member.name,
        shares: a.shares,
        totalPaid: a.totalPaid,
        value: a.shares * sharePrice,
      })),
    };
  }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shares.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Document share capital in `README.md`**

Add a `## Share capital` section (after the `## Dividends` section) describing: members buy shares with `buyshares <count>` (default ₦1,000/share, configurable per coop via `CooperativeConfig.sharePrice`); `shares` shows holdings; share capital is permanent equity (not withdrawable unless `allowShareRedemption`); super admins distribute profit on shares with `paysharedividend <rate%>` (distinct from `paydividend`, which pays on savings). Add `shares` / `buyshares` to the member command table and `paysharedividend` to the admin command table.

- [ ] **Step 6: Full verification gate**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → 0 errors.
Run: `npx vitest run tests/schema-sync.test.ts tests/shares.test.ts` → green.
Run: `npm test` → full suite green (baseline 256 passed / 12 skipped; expect +7 from this feature).

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.ts README.md tests/shares.test.ts
git commit -m "feat(shares): admin shares endpoint + docs"
```

---

## Self-review notes

- **Spec coverage:** share capital (buy/view/dividend), configurable price, RLS, admin visibility, docs — all covered. Redemption (`sellshares`) is intentionally deferred: `allowShareRedemption` is added to config but no command consumes it yet; a follow-up plan should add `sellshares` when the user wants it.
- **Type consistency:** `allocateByShares` takes `{ id, shares }[]` and returns `Map<string, number>` in both Task 2 and Task 4. `buyShares`/`getShareAccount`/`distributeShareDividend` signatures match their call sites in Tasks 3–5.
- **Journal accounts:** `member_wallet:<walletId>` matches the existing top-up convention (`src/services/payments/topup.ts:153`); `equity:share_capital` is new and balanced against it.
