# Commodity Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let members commit capped, payroll-backed credit to seasonal commodity schemes that the co-op only purchases once reconciled bank cash (or an audited supplier-credit decision) covers it, then collect repayment through payroll deduction installments with per-member shortfall attribution and roll-forward.

**Architecture:** Four new tables (`CommodityScheme`, `CommoditySchemeItem`, `CommoditySubscription`, `DeductionShortfall`) plus two small extensions (`DeductionItem.kind = "commodity"`, `rolloverOfItemId`). Credit is computed on read from the existing uploaded `DeductionBatch` (no second expectation ledger). Conversion creates `Loan(kind="commodity")` rows; collection reuses `DeductionItem` inside `DeductionBatch`, and `approveBatch` gains per-member priority allocation with roll-forward.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Prisma (PostgreSQL prod / SQLite test), Vitest, WhatsApp command router (`src/services/conversation.ts`, `src/services/admin.ts`).

**Spec:** `docs/superpowers/specs/2026-10-31-commodity-credit-design.md`

## Global Constraints

- Money is stored in kobo (`Int`); command input is naira and converted with `Math.round(naira * 100)`.
- Keep `prisma/schema.prisma` and `prisma/schema.local.prisma` in sync (guarded by `tests/schema-sync.test.ts`).
- Every schema change needs a DDL migration **and** an `_rls` migration; the PostgreSQL CI job applies `prisma/migrations` and never `db push`.
- New tables carrying `cooperativeId` use the direct RLS policy; `CommoditySchemeItem` uses the parent-resolver policy.
- All mutations call `audit({ cooperativeId, actorPhone, action, ... })` — `actorPhone` is required.
- Member-facing copy uses `formatBalance` from `src/services/cooperative.js`; never print raw kobo.
- Feature is env-gated: `COMMODITY_SCHEMES_ENABLED=1`, credit multiplier `COMMODITY_CREDIT_MULTIPLIER` (default 3).
- Tests run on SQLite via `npm test` (which regenerates the local client); never run `npx vitest` right after a PostgreSQL `prisma generate`.
- Formatting: `npx prettier --write` on touched files; `npm run format:check` must pass.

---

## File Structure

| File                                                                  | Responsibility                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`, `prisma/schema.local.prisma`                  | New models + relations (`Task 1`)                                                                             |
| `prisma/migrations/20261063000000_commodity_credit/migration.sql`     | DDL (`Task 1`)                                                                                                |
| `prisma/migrations/20261064000000_commodity_credit_rls/migration.sql` | RLS policies (`Task 1`)                                                                                       |
| `src/services/commodity-credit.ts`                                    | Credit position math, env gating (`Task 2`)                                                                   |
| `src/services/commodity-schemes.ts`                                   | Scheme lifecycle, subscriptions, purchase gate, conversion, collection (`Tasks 3-4`)                          |
| `src/services/deductions.ts`                                          | Commodity installments, cash-only loan selection, shortfall attribution, priority, roll-forward (`Tasks 5-6`) |
| `src/services/commodity-commands.ts`                                  | Pipe-delimited admin parsing + WhatsApp text formatting (`Task 7`)                                            |
| `src/services/conversation.ts`                                        | Member command cases (`Task 7`)                                                                               |
| `src/services/admin.ts`                                               | Admin/superadmin command cases (`Task 7`)                                                                     |
| `src/services/handlers/session.ts`                                    | Help menu lines (`Task 7`)                                                                                    |
| `src/services/scheduler.ts`                                           | Close expired schemes, month-end shortfall tick (`Task 7`)                                                    |
| `tests/commodity-credit.test.ts`                                      | Credit math (`Task 2`)                                                                                        |
| `tests/commodity-scheme.test.ts`                                      | Lifecycle, purchase gate, conversion, collection (`Tasks 3-4`)                                                |
| `tests/commodity-payroll.test.ts`                                     | Builder changes (`Task 5`)                                                                                    |
| `tests/deduction-shortfall.test.ts`                                   | Attribution, priority, roll-forward (`Task 6`)                                                                |
| `tests/commodity-commands.test.ts`                                    | WhatsApp wiring (`Task 7`)                                                                                    |
| `tests/deductions.test.ts`                                            | Rewrite two shortfall assertions (`Task 6`)                                                                   |

---

### Task 1: Schema, migrations, RLS

**Files:**

- Modify: `prisma/schema.prisma` (append new models, extend `DeductionItem`/`Loan` comments, add relation fields)
- Modify: `prisma/schema.local.prisma` (identical model changes; SQLite mirror)
- Create: `prisma/migrations/20261063000000_commodity_credit/migration.sql`
- Create: `prisma/migrations/20261064000000_commodity_credit_rls/migration.sql`
- Test: `tests/commodity-schema.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: Prisma models `commodityScheme`, `commoditySchemeItem`, `commoditySubscription`, `deductionShortfall`; `DeductionItem.kind` accepts `"commodity"`; `DeductionItem.rolloverOfItemId: string | null`.

- [x] **Step 1: Write the failing test**

```ts
// tests/commodity-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../tests/setup.js";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "commoditySubscription",
    "commoditySchemeItem",
    "commodityScheme",
    "loan",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
});

describe("commodity credit schema", () => {
  it("stores a scheme with items, a subscription and a shortfall", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Schema Coop", code: `SC${Date.now()}` },
    });
    const member = await prisma.member.create({
      data: {
        cooperativeId: coop.id,
        phone: "2348090000001",
        name: "Schema Member",
        code: "SCM001",
        role: "member",
        status: "active",
      },
    });
    const scheme = await prisma.commodityScheme.create({
      data: {
        cooperativeId: coop.id,
        reference: "SCH-TEST-1",
        name: "Christmas 2026",
        opensAt: new Date("2026-11-01"),
        closesAt: new Date("2026-11-20"),
        createdById: member.id,
      },
    });
    const item = await prisma.commoditySchemeItem.create({
      data: {
        schemeId: scheme.id,
        name: "Rice 50kg",
        unitLabel: "bag",
        unitCostKobo: 8_000_000,
        memberPriceKobo: 8_500_000,
        totalUnits: 100,
      },
    });
    const sub = await prisma.commoditySubscription.create({
      data: {
        reference: "CS-TEST-1",
        cooperativeId: coop.id,
        schemeId: scheme.id,
        itemId: item.id,
        memberId: member.id,
        qty: 2,
        unitPriceKobo: 8_500_000,
        totalKobo: 17_000_000,
        months: 3,
      },
    });
    expect(sub.status).toBe("reserved");
    expect(scheme.status).toBe("draft");

    const batch = await prisma.deductionBatch.create({
      data: {
        cooperativeId: coop.id,
        ref: "DED-SCHEMA-1",
        totalAmount: 1000,
        createdById: member.id,
      },
    });
    const shortfall = await prisma.deductionShortfall.create({
      data: {
        cooperativeId: coop.id,
        batchId: batch.id,
        memberId: member.id,
        amount: 500,
      },
    });
    expect(shortfall.status).toBe("open");

    await expect(
      prisma.commoditySubscription.create({
        data: {
          reference: "CS-DUP",
          cooperativeId: coop.id,
          schemeId: scheme.id,
          itemId: item.id,
          memberId: member.id,
          qty: 1,
          unitPriceKobo: 1,
          totalKobo: 1,
          months: 3,
        },
      }),
    ).rejects.toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commodity-schema.test.ts`
Expected: FAIL — `prisma.commodityScheme` is undefined.

- [x] **Step 3: Add the models to both schema files**

Append to `prisma/schema.prisma` and `prisma/schema.local.prisma` (identical text):

```prisma
model CommodityScheme {
  id             String                  @id @default(cuid())
  cooperativeId  String
  cooperative    Cooperative             @relation(fields: [cooperativeId], references: [id])
  reference      String                  @unique
  name           String
  season         String?
  opensAt        DateTime
  closesAt       DateTime
  status         String                  @default("draft") // draft | open | closed | purchased | converted | cancelled
  pollId         String?
  supplier       String?
  quotedCostKobo Int                     @default(0)
  actualCostKobo Int?
  fundingSource  String? // cash | supplier_credit
  purchaseNote   String?
  purchasedAt    DateTime?
  purchasedById  String?
  convertedAt    DateTime?
  createdById    String
  creator        Member                  @relation("SchemeCreator", fields: [createdById], references: [id])
  items          CommoditySchemeItem[]
  subscriptions  CommoditySubscription[]
  createdAt      DateTime                @default(now())
  updatedAt      DateTime                @updatedAt

  @@index([cooperativeId, status])
}

model CommoditySchemeItem {
  id              String                  @id @default(cuid())
  schemeId        String
  scheme          CommodityScheme         @relation(fields: [schemeId], references: [id], onDelete: Cascade)
  name            String
  unitLabel       String
  unitCostKobo    Int
  memberPriceKobo Int
  totalUnits      Int?
  maxQtyPerMember Int                     @default(1)
  subscriptions   CommoditySubscription[]

  @@index([schemeId])
}

model CommoditySubscription {
  id              String                 @id @default(cuid())
  reference       String                 @unique
  cooperativeId   String
  schemeId        String
  scheme          CommodityScheme        @relation(fields: [schemeId], references: [id])
  itemId          String
  item            CommoditySchemeItem    @relation(fields: [itemId], references: [id])
  memberId        String
  member          Member                 @relation(fields: [memberId], references: [id])
  qty             Int                    @default(1)
  unitPriceKobo   Int
  totalKobo       Int
  months          Int                    @default(3)
  status          String                 @default("reserved") // reserved | approved | rejected | cancelled | converted
  reservedAt      DateTime               @default(now())
  decidedAt       DateTime?
  decidedById     String?
  rejectReason    String?
  convertedLoanId String?                @unique
  dispatchedAt    DateTime?
  collectedAt     DateTime?
  collectedById   String?
  createdAt       DateTime               @default(now())
  updatedAt       DateTime               @updatedAt

  @@unique([schemeId, itemId, memberId])
  @@index([cooperativeId, status])
  @@index([memberId, status])
}

model DeductionShortfall {
  id             String         @id @default(cuid())
  cooperativeId  String
  batchId        String
  batch          DeductionBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  memberId       String
  member         Member         @relation(fields: [memberId], references: [id])
  amount         Int
  reason         String?
  attributedById String?
  status         String         @default("open") // open | rolled | waived
  rolledToItemId String?
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  @@unique([batchId, memberId])
  @@index([cooperativeId, status])
}
```

Then add the relation fields:

In `model Cooperative`, add:

```prisma
  commoditySchemes       CommodityScheme[]
  commoditySubscriptions CommoditySubscription[]
  deductionShortfalls    DeductionShortfall[]
```

In `model Member`, add:

```prisma
  schemesCreated          CommodityScheme[]       @relation("SchemeCreator")
  commoditySubscriptions  CommoditySubscription[]
  deductionShortfalls     DeductionShortfall[]
```

In `model DeductionBatch`, add:

```prisma
  shortfalls              DeductionShortfall[]
```

In `model DeductionItem`, replace `kind String @default("savings") // savings | loan` with:

```prisma
  kind            String        @default("savings") // savings | loan | commodity
```

and add (after `creditedAt`):

```prisma
  rolloverOfItemId String?       @unique
  rolledFrom       DeductionItem? @relation("DeductionRollover", fields: [rolloverOfItemId], references: [id])
  rolledTo         DeductionItem? @relation("DeductionRollover")
```

In `model Loan`, update the `kind` comment to:

```prisma
  kind            String   @default("cash") // cash | shop | commodity
```

- [x] **Step 4: Regenerate the SQLite client and push**

Run:

```powershell
node scripts/prisma-generate.mjs --local
npx prisma db push --schema prisma/schema.local.prisma --skip-generate
npx vitest run tests/commodity-schema.test.ts
```

Expected: PASS (1 test).

- [x] **Step 5: Generate the DDL migration**

Run (PowerShell; `cmd /c` avoids a BOM in the redirect):

```powershell
cmd /c "git show HEAD:prisma/schema.prisma > %TEMP%\commodity-old-schema.prisma"
New-Item -ItemType Directory -Force prisma/migrations/20261063000000_commodity_credit | Out-Null
cmd /c "npx prisma migrate diff --from-schema-datamodel %TEMP%\commodity-old-schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma\migrations\20261063000000_commodity_credit\migration.sql"
```

Expected: the file contains `CREATE TABLE "CommodityScheme"`, the three other tables, `ALTER TABLE "DeductionItem" ADD COLUMN "rolloverOfItemId"`, indexes and foreign keys. Verify with:

```powershell
Select-String -Path prisma/migrations/20261063000000_commodity_credit/migration.sql -Pattern 'CREATE TABLE|ADD COLUMN'
```

- [x] **Step 6: Write the RLS migration**

Create `prisma/migrations/20261064000000_commodity_credit_rls/migration.sql`:

```sql
-- Row-Level Security for commodity credit tables (Stage 1: ENABLE, not FORCE).
-- CommodityScheme, CommoditySubscription and DeductionShortfall carry a
-- cooperativeId column, so they use the direct policy. CommoditySchemeItem is
-- reached through its tenant parent CommodityScheme, so it uses the
-- parent-resolver policy.
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CommodityScheme','CommoditySubscription','DeductionShortfall']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("cooperativeId" = app.current_coop_id()) WITH CHECK ("cooperativeId" = app.current_coop_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('CommoditySchemeItem', 'schemeId', 'CommodityScheme')
    ) AS v(child, fk, parent)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id())) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p."cooperativeId" = app.current_coop_id()))',
      r.child || '_tenant_isolation', r.child,
      r.parent, r.child, r.fk,
      r.parent, r.child, r.fk
    );
  END LOOP;
END $$;

COMMIT;
```

- [x] **Step 7: Verify migrations on a fresh PostgreSQL**

Run:

```powershell
docker rm -f coop-commodity-test 2>$null
docker run -d --name coop-commodity-test -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=coop_test -p 55433:5432 postgres:16-alpine
Start-Sleep -Seconds 12
npm run prisma:generate
$env:DATABASE_URL="postgresql://test:test@localhost:55433/coop_test"
node scripts/db-migrate.mjs
$env:RLS_ENABLED="1"
npx vitest run tests/rls-isolation.test.ts
Remove-Item Env:DATABASE_URL; Remove-Item Env:RLS_ENABLED
docker rm -f coop-commodity-test
node scripts/prisma-generate.mjs --local
```

Expected: migrations apply, 14 RLS tests pass, no extra RLS failures for the new tables.

- [x] **Step 8: Run the schema suite and commit**

Run: `npx vitest run tests/schema-sync.test.ts tests/commodity-schema.test.ts`
Expected: PASS.

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261063000000_commodity_credit prisma/migrations/20261064000000_commodity_credit_rls tests/commodity-schema.test.ts
git commit -m "feat(db): add commodity scheme, subscription and deduction shortfall tables"
```

---

### Task 2: Credit position service

**Files:**

- Create: `src/services/commodity-credit.ts`
- Test: `tests/commodity-credit.test.ts`

**Interfaces:**

- Consumes: `prisma`, `getMemberByPhone`, `periodOf`.
- Produces:
  - `commoditySchemesEnabled(): boolean`
  - `creditMultiplier(): number`
  - `interface CommodityCreditPosition { expectedKobo: number; multiplier: number; capKobo: number; committedKobo: number; availableKobo: number; blockedReason: string | null }`
  - `getCommodityCreditPosition(phone: string): Promise<CommodityCreditPosition | null>`
  - `getCreditPositionForMember(memberId: string, cooperativeId: string): Promise<CommodityCreditPosition>`

- [x] **Step 1: Write the failing tests**

```ts
// tests/commodity-credit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import {
  commoditySchemesEnabled,
  getCreditPositionForMember,
} from "../src/services/commodity-credit.js";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "1");
  vi.stubEnv("COMMODITY_CREDIT_MULTIPLIER", "3");
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "commoditySubscription",
    "commoditySchemeItem",
    "commodityScheme",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
});

afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Credit Coop", code: `CR${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348090000010",
      name: "Credit Member",
      code: "CRM010",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  return { coop, member };
}

async function seedSchedule(coopId: string, memberId: string, amount: number) {
  return prisma.deductionBatch.create({
    data: {
      cooperativeId: coopId,
      ref: `DED-${new Date().toISOString().slice(0, 7)}-CRD1`,
      totalAmount: amount,
      sourceFileKey: "uploads/payslip.xlsx",
      sourceFileName: "payslip.xlsx",
      createdById: memberId,
      items: { create: [{ memberId, kind: "savings", amount }] },
    },
  });
}

describe("commodity credit position", () => {
  it("is disabled unless the env flag is set", () => {
    vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "0");
    expect(commoditySchemesEnabled()).toBe(false);
  });

  it("uses the uploaded schedule times the multiplier", async () => {
    const { coop, member } = await seed();
    await seedSchedule(coop.id, member.id, 10_000);
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.expectedKobo).toBe(10_000);
    expect(pos.capKobo).toBe(30_000);
    expect(pos.availableKobo).toBe(30_000);
    expect(pos.blockedReason).toBeNull();
  });

  it("subtracts commodity loans and open reservations", async () => {
    const { coop, member } = await seed();
    await seedSchedule(coop.id, member.id, 10_000);
    await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        principal: 5_000,
        balance: 5_000,
        months: 3,
        monthlyPayment: 1_667,
        status: "disbursed",
        kind: "commodity",
      },
    });
    const scheme = await prisma.commodityScheme.create({
      data: {
        cooperativeId: coop.id,
        reference: "SCH-C1",
        name: "Credit scheme",
        opensAt: new Date("2026-11-01"),
        closesAt: new Date("2026-11-20"),
        status: "open",
        createdById: member.id,
      },
    });
    const item = await prisma.commoditySchemeItem.create({
      data: {
        schemeId: scheme.id,
        name: "Oil",
        unitLabel: "jerrycan",
        unitCostKobo: 1_000,
        memberPriceKobo: 2_000,
      },
    });
    await prisma.commoditySubscription.create({
      data: {
        reference: "CS-C1",
        cooperativeId: coop.id,
        schemeId: scheme.id,
        itemId: item.id,
        memberId: member.id,
        qty: 1,
        unitPriceKobo: 2_000,
        totalKobo: 2_000,
        months: 3,
      },
    });
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.committedKobo).toBe(7_000);
    expect(pos.availableKobo).toBe(23_000);
  });

  it("blocks on an open shortfall and explains why", async () => {
    const { coop, member } = await seed();
    const batch = await seedSchedule(coop.id, member.id, 10_000);
    await prisma.deductionShortfall.create({
      data: { cooperativeId: coop.id, batchId: batch.id, memberId: member.id, amount: 500 },
    });
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.availableKobo).toBe(0);
    expect(pos.blockedReason).toContain("shortfall");
  });

  it("blocks when no schedule was uploaded this month", async () => {
    const { coop, member } = await seed();
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.availableKobo).toBe(0);
    expect(pos.blockedReason).toContain("no payroll schedule");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commodity-credit.test.ts`
Expected: FAIL — cannot resolve `../src/services/commodity-credit.js`.

- [x] **Step 3: Implement the service**

```ts
// src/services/commodity-credit.ts
import { prisma } from "../lib/prisma.js";
import { getMemberByPhone } from "./cooperative.js";
import { periodOf } from "./deductions.js";

export const DEFAULT_CREDIT_MULTIPLIER = 3;

export function commoditySchemesEnabled(): boolean {
  return process.env.COMMODITY_SCHEMES_ENABLED === "1";
}

export function creditMultiplier(): number {
  const raw = Number(process.env.COMMODITY_CREDIT_MULTIPLIER ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CREDIT_MULTIPLIER;
}

export interface CommodityCreditPosition {
  expectedKobo: number;
  multiplier: number;
  capKobo: number;
  committedKobo: number;
  availableKobo: number;
  blockedReason: string | null;
}

export async function getCommodityCreditPosition(
  phone: string,
): Promise<CommodityCreditPosition | null> {
  const member = await getMemberByPhone(phone);
  if (!member) return null;
  return getCreditPositionForMember(member.id, member.cooperativeId);
}

export async function getCreditPositionForMember(
  memberId: string,
  cooperativeId: string,
): Promise<CommodityCreditPosition> {
  const multiplier = creditMultiplier();
  const period = periodOf(new Date());
  const batches = await prisma.deductionBatch.findMany({
    where: {
      cooperativeId,
      sourceFileKey: { not: null },
      status: { in: ["draft", "submitted", "cheque_received"] },
    },
    include: {
      items: { where: { memberId, kind: "savings", status: "pending" } },
    },
    orderBy: { createdAt: "desc" },
  });
  const current = batches.find((b) => b.ref.startsWith(`DED-${period}-`)) ?? batches[0];
  const expectedKobo = current?.items.reduce((sum, i) => sum + i.amount, 0) ?? 0;
  const capKobo = Math.round(expectedKobo * multiplier);

  const commodityLoans = await prisma.loan.findMany({
    where: { cooperativeId, memberId, kind: "commodity", status: "disbursed", balance: { gt: 0 } },
    select: { balance: true },
  });
  const reservations = await prisma.commoditySubscription.findMany({
    where: { cooperativeId, memberId, status: { in: ["reserved", "approved"] } },
    select: { totalKobo: true },
  });
  const committedKobo =
    commodityLoans.reduce((sum, l) => sum + l.balance, 0) +
    reservations.reduce((sum, s) => sum + s.totalKobo, 0);

  const openShortfall = await prisma.deductionShortfall.findFirst({
    where: { cooperativeId, memberId, status: "open" },
    select: { id: true },
  });

  let blockedReason: string | null = null;
  if (!commoditySchemesEnabled()) {
    blockedReason = "Commodity schemes are not enabled.";
  } else if (openShortfall) {
    blockedReason =
      "Your payroll remittance was short and the unpaid balance is still open. Settle it before using commodity credit.";
  } else if (expectedKobo === 0) {
    blockedReason = "No payroll schedule has been uploaded for you this month.";
  }

  return {
    expectedKobo,
    multiplier,
    capKobo,
    committedKobo,
    availableKobo: blockedReason ? 0 : Math.max(0, capKobo - committedKobo),
    blockedReason,
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commodity-credit.test.ts`
Expected: PASS (5 tests).

- [x] **Step 5: Commit**

```bash
git add src/services/commodity-credit.ts tests/commodity-credit.test.ts
git commit -m "feat: compute commodity credit from uploaded payroll schedules"
```

---

### Task 3: Scheme lifecycle and subscriptions

**Files:**

- Create: `src/services/commodity-schemes.ts`
- Test: `tests/commodity-scheme.test.ts`

**Interfaces:**

- Consumes: `getCreditPositionForMember`, `installmentSchedule`, `formatBalance`, `notifyMember`, `audit`.
- Produces:
  - `createScheme(superPhone: string, input: { name: string; season?: string; opensAt: Date; closesAt: Date }): Promise<SchemeResult>`
  - `addSchemeItem(superPhone: string, schemeRef: string, input: { name: string; unitLabel: string; unitCostKobo: number; memberPriceKobo: number; totalUnits: number | null; maxQtyPerMember: number }): Promise<SchemeResult>`
  - `openScheme(adminPhone: string, schemeRef: string): Promise<SchemeResult>`
  - `closeScheme(adminPhone: string, schemeRef: string): Promise<SchemeResult>`
  - `subscribeCommodity(phone: string, schemeRef: string, itemKey: string, qty: number, months: number): Promise<SchemeResult>`
  - `cancelCommoditySubscription(phone: string, ref: string): Promise<SchemeResult>`
  - `rejectCommoditySubscription(adminPhone: string, ref: string, reason?: string): Promise<SchemeResult>`
  - `type SchemeResult = { ok: boolean; message: string; id?: string; ref?: string }`
  - `interface SchemeItemInput` (for the admin parser)

- [x] **Step 1: Write the failing tests**

```ts
// tests/commodity-scheme.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { notifyMember } from "../src/lib/messaging.js";
import {
  createScheme,
  addSchemeItem,
  openScheme,
  closeScheme,
  subscribeCommodity,
  cancelCommoditySubscription,
  rejectCommoditySubscription,
} from "../src/services/commodity-schemes.js";

const SUPER = "2348090000100";
const ADMIN = "2348090000101";
const MEMBER = "2348090000102";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "1");
  vi.stubEnv("COMMODITY_CREDIT_MULTIPLIER", "3");
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "commoditySubscription",
    "commoditySchemeItem",
    "commodityScheme",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
  vi.mocked(notifyMember).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Scheme Coop", code: `SM${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const superM = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: SUPER,
      name: "Super",
      code: "SS001",
      role: "superadmin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const admin = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: ADMIN,
      name: "Admin",
      code: "SA001",
      role: "admin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: MEMBER,
      name: "Member",
      code: "SM001",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  const batch = await prisma.deductionBatch.create({
    data: {
      cooperativeId: coop.id,
      ref: `DED-${new Date().toISOString().slice(0, 7)}-SCH1`,
      totalAmount: 10_000,
      sourceFileKey: "schedules/oct.xlsx",
      sourceFileName: "oct.xlsx",
      createdById: admin.id,
      items: { create: [{ memberId: member.id, kind: "savings", amount: 10_000 }] },
    },
  });
  return { coop, superM, admin, member, batch };
}

async function makeOpenScheme(superPhone: string) {
  const created = await createScheme(superPhone, {
    name: "Christmas 2026",
    season: "Christmas",
    opensAt: new Date("2026-11-01T00:00:00Z"),
    closesAt: new Date("2099-12-31T00:00:00Z"),
  });
  const added = await addSchemeItem(superPhone, created.ref!, {
    name: "Rice 50kg",
    unitLabel: "bag",
    unitCostKobo: 8_000_000,
    memberPriceKobo: 9_000_000,
    totalUnits: 10,
    maxQtyPerMember: 2,
  });
  return { scheme: created, item: added };
}

describe("commodity schemes", () => {
  it("creates a scheme with an item and opens it", async () => {
    const { superM, admin } = await seed();
    const { scheme, item } = await makeOpenScheme(SUPER);
    expect(scheme.ok).toBe(true);
    expect(item.ok).toBe(true);
    const opened = await openScheme(ADMIN, scheme.ref!);
    expect(opened.ok).toBe(true);
    const fresh = await prisma.commodityScheme.findUnique({
      where: { reference: scheme.ref! },
      include: { items: true },
    });
    expect(fresh!.status).toBe("open");
    expect(fresh!.items).toHaveLength(1);
    expect(await prisma.commodityScheme.count({ where: { createdById: superM.id } })).toBe(1);
    expect(admin.role).toBe("admin");
  });

  it("rejects a subscription over the credit cap", async () => {
    const { member } = await seed();
    const { scheme, item } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    // cap = 10,000 x 3 = 30,000; two bags cost 18,000,000
    const res = await subscribeCommodity(MEMBER, scheme.ref!, item.ref ?? "Rice 50kg", 2, 3);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("credit");
    expect(await prisma.commoditySubscription.count()).toBe(0);
    expect(member.role).toBe("member");
  });

  it("reserves credit and notifies the member", async () => {
    const { member } = await seed();
    const { scheme, item } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.update({
      where: { id: (await prisma.commoditySchemeItem.findFirst())!.id },
      data: { memberPriceKobo: 5_000 },
    });
    const res = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 2, 3);
    expect(res.ok).toBe(true);
    const sub = await prisma.commoditySubscription.findFirst();
    expect(sub!.status).toBe("reserved");
    expect(sub!.totalKobo).toBe(10_000);
    expect(vi.mocked(notifyMember)).toHaveBeenCalled();
    expect(member.id).toBeTruthy();
    expect(item.ok).toBe(true);
  });

  it("blocks the third bag when max per member is two", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    expect((await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 2, 3)).ok).toBe(true);
    const third = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    expect(third.ok).toBe(false);
    expect(third.message).toContain("maximum");
  });

  it("releases credit on member cancel and on admin reject", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    const first = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    const cancelled = await cancelCommoditySubscription(MEMBER, first.ref!);
    expect(cancelled.ok).toBe(true);
    const second = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    const rejected = await rejectCommoditySubscription(ADMIN, second.ref!, "duplicate");
    expect(rejected.ok).toBe(true);
    const rows = await prisma.commoditySubscription.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "rejected"]);
  });

  it("refuses subscriptions after the scheme closes", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    await closeScheme(ADMIN, scheme.ref!);
    const res = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain("closed");
  });
});
```

Note: `addSchemeItem` returns `SchemeResult` with `ref` set to the item id so tests can reference it; the concrete contract is `{ ok, message, id: scheme.id, ref: item.id }`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commodity-scheme.test.ts`
Expected: FAIL — cannot resolve `../src/services/commodity-schemes.js`.

- [x] **Step 3: Implement lifecycle + subscriptions**

```ts
// src/services/commodity-schemes.ts
import { prisma } from "../lib/prisma.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { audit } from "./audit.js";
import { notifyMember } from "../lib/messaging.js";
import { getCreditPositionForMember } from "./commodity-credit.js";
import { installmentSchedule } from "./shop.js";

export interface SchemeResult {
  ok: boolean;
  message: string;
  id?: string;
  ref?: string;
}

export interface SchemeItemInput {
  name: string;
  unitLabel: string;
  unitCostKobo: number;
  memberPriceKobo: number;
  totalUnits: number | null;
  maxQtyPerMember: number;
}

function makeSchemeRef(): string {
  return `SCH-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function makeSubscriptionRef(): string {
  return `CS-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

async function staffMember(phone: string, roles: string[]) {
  return prisma.member.findFirst({ where: { phone, role: { in: roles } } });
}

async function findScheme(cooperativeId: string, key: string) {
  return prisma.commodityScheme.findFirst({
    where: { cooperativeId, OR: [{ id: key }, { reference: key.toUpperCase() }] },
    include: { items: true },
  });
}

export async function createScheme(
  superPhone: string,
  input: { name: string; season?: string; opensAt: Date; closesAt: Date },
): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can create a commodity scheme." };
  const name = input.name.trim();
  if (!name)
    return { ok: false, message: "Usage: *newscheme <name> | <season> | <opens> | <closes>*" };
  if (input.closesAt <= input.opensAt) {
    return { ok: false, message: "The closing date must be after the opening date." };
  }
  const scheme = await prisma.commodityScheme.create({
    data: {
      cooperativeId: superM.cooperativeId,
      reference: makeSchemeRef(),
      name,
      season: input.season?.trim() || null,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      createdById: superM.id,
    },
  });
  await audit({
    cooperativeId: superM.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "commodity.scheme.created",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: `${scheme.reference}: ${name}`,
  });
  return {
    ok: true,
    id: scheme.id,
    ref: scheme.reference,
    message:
      `Scheme *${scheme.reference}* created for *${name}*.\n` +
      `Add items with *addschemeitem ${scheme.reference} | <name> | <unit> | <cost> | <price> | <units> | <max>*, then *openscheme ${scheme.reference}*.`,
  };
}

export async function addSchemeItem(
  superPhone: string,
  schemeRef: string,
  input: SchemeItemInput,
): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can add scheme items." };
  const scheme = await findScheme(superM.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "draft") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status}; items can only be added while it is draft.`,
    };
  }
  if (!input.name.trim() || input.memberPriceKobo <= 0) {
    return { ok: false, message: "Item needs a name and a member price above zero." };
  }
  if (input.maxQtyPerMember < 1)
    return { ok: false, message: "Max per member must be at least 1." };
  const item = await prisma.commoditySchemeItem.create({
    data: {
      schemeId: scheme.id,
      name: input.name.trim(),
      unitLabel: input.unitLabel.trim() || "unit",
      unitCostKobo: Math.max(0, input.unitCostKobo),
      memberPriceKobo: input.memberPriceKobo,
      totalUnits: input.totalUnits,
      maxQtyPerMember: input.maxQtyPerMember,
    },
  });
  return {
    ok: true,
    id: scheme.id,
    ref: item.id,
    message: `Added *${item.name}* (${input.unitLabel}) at ${formatBalance(item.memberPriceKobo)} to *${scheme.reference}*.`,
  };
}

export async function openScheme(adminPhone: string, schemeRef: string): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can open a scheme." };
  const scheme = await findScheme(admin.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "draft")
    return { ok: false, message: `Scheme ${scheme.reference} is ${scheme.status}.` };
  if (scheme.items.length === 0)
    return { ok: false, message: "Add at least one item before opening the scheme." };
  await prisma.commodityScheme.update({ where: { id: scheme.id }, data: { status: "open" } });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.scheme.opened",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: scheme.reference,
  });
  const members = await prisma.member.findMany({
    where: { cooperativeId: scheme.cooperativeId, status: "active" },
    select: {
      id: true,
      phone: true,
      name: true,
      altChannelId: true,
      preferredChannel: true,
      optedOut: true,
    },
  });
  for (const m of members) {
    const position = await getCreditPositionForMember(m.id, scheme.cooperativeId);
    if (position.availableKobo <= 0) continue;
    await notifyMember(
      m,
      `?? *${scheme.name}* is open.\n` +
        `Your commodity credit: *${formatBalance(position.availableKobo)}*.\n` +
        `Reply *schemes* to see items, then *subscribe ${scheme.reference} <item> <qty> [months]*.`,
    ).catch(() => {});
  }
  return {
    ok: true,
    message: `Scheme *${scheme.reference}* is now open. Eligible members were notified.`,
  };
}

export async function closeScheme(adminPhone: string, schemeRef: string): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can close a scheme." };
  const scheme = await findScheme(admin.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "open")
    return { ok: false, message: `Scheme ${scheme.reference} is ${scheme.status}, not open.` };
  await prisma.commodityScheme.update({ where: { id: scheme.id }, data: { status: "closed" } });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.scheme.closed",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: scheme.reference,
  });
  return {
    ok: true,
    message: `Scheme *${scheme.reference}* is closed. Review subscriptions with *schemesubs ${scheme.reference}*.`,
  };
}

export async function subscribeCommodity(
  phone: string,
  schemeRef: string,
  itemKey: string,
  qty: number,
  months: number,
): Promise<SchemeResult> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "Join a cooperative first." };
  const scheme = await findScheme(member.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "open") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status === "closed" ? "closed" : scheme.status}; subscriptions are not open.`,
    };
  }
  const now = new Date();
  if (now < scheme.opensAt || now > scheme.closesAt) {
    return { ok: false, message: "The subscription window is not open right now." };
  }
  const item =
    scheme.items.find((i) => i.id === itemKey) ??
    scheme.items.find((i) => i.name.toLowerCase() === itemKey.toLowerCase()) ??
    scheme.items.find((i) => i.name.toLowerCase().includes(itemKey.toLowerCase()));
  if (!item) return { ok: false, message: "That item is not on this scheme." };
  const safeQty = Math.floor(qty);
  const safeMonths = Math.floor(months);
  if (!Number.isFinite(safeQty) || safeQty < 1)
    return { ok: false, message: "Quantity must be at least 1." };
  if (safeQty > item.maxQtyPerMember) {
    return {
      ok: false,
      message: `The maximum per member for *${item.name}* is ${item.maxQtyPerMember}.`,
    };
  }
  if (!Number.isFinite(safeMonths) || safeMonths < 3 || safeMonths > 6) {
    return { ok: false, message: "Choose 3 to 6 monthly installments." };
  }
  if (item.totalUnits !== null) {
    const taken = await prisma.commoditySubscription.aggregate({
      where: { itemId: item.id, status: { in: ["reserved", "approved", "converted"] } },
      _sum: { qty: true },
    });
    const left = item.totalUnits - (taken._sum.qty ?? 0);
    if (safeQty > left)
      return { ok: false, message: `Only ${Math.max(0, left)} unit(s) of *${item.name}* left.` };
  }
  const totalKobo = item.memberPriceKobo * safeQty;
  const position = await getCreditPositionForMember(member.id, member.cooperativeId);
  if (position.availableKobo <= 0) {
    return {
      ok: false,
      message: `You have no commodity credit right now. ${position.blockedReason ?? ""}`.trim(),
    };
  }
  if (totalKobo > position.availableKobo) {
    return {
      ok: false,
      message:
        `That costs ${formatBalance(totalKobo)} but your available commodity credit is ` +
        `*${formatBalance(position.availableKobo)}*. Reduce the quantity or installments.`,
    };
  }
  const existing = await prisma.commoditySubscription.findFirst({
    where: { schemeId: scheme.id, itemId: item.id, memberId: member.id },
  });
  if (existing)
    return { ok: false, message: "You already have a subscription for that item on this scheme." };
  const { monthly } = installmentSchedule(totalKobo, safeMonths);
  const sub = await prisma.commoditySubscription.create({
    data: {
      reference: makeSubscriptionRef(),
      cooperativeId: member.cooperativeId,
      schemeId: scheme.id,
      itemId: item.id,
      memberId: member.id,
      qty: safeQty,
      unitPriceKobo: item.memberPriceKobo,
      totalKobo,
      months: safeMonths,
    },
  });
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorRole: member.role,
    action: "commodity.subscription.created",
    targetType: "commoditySubscription",
    targetId: sub.id,
    amount: totalKobo,
    detail: `${sub.reference}: ${safeQty} x ${item.name} on ${scheme.reference}`,
  });
  await notifyMember(
    member,
    `?? *Reserved:* ${safeQty} x ${item.name}\n` +
      `Total: *${formatBalance(totalKobo)}* over ${safeMonths} months (~${formatBalance(monthly)}/month).\n` +
      `Reference: ${sub.reference}. Repayment starts after the co-op buys the goods.`,
  ).catch(() => {});
  return {
    ok: true,
    id: sub.id,
    ref: sub.reference,
    message:
      `?? Reserved *${safeQty} x ${item.name}* on *${scheme.name}*.\n` +
      `Total ${formatBalance(totalKobo)} - about ${formatBalance(monthly)}/month for ${safeMonths} months.\n` +
      `Reference: *${sub.reference}*. Reply *mysubs* to review it.`,
  };
}

export async function cancelCommoditySubscription(
  phone: string,
  ref: string,
): Promise<SchemeResult> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "Join a cooperative first." };
  const sub = await prisma.commoditySubscription.findFirst({
    where: {
      cooperativeId: member.cooperativeId,
      memberId: member.id,
      reference: ref.toUpperCase(),
    },
    include: { scheme: true, item: true },
  });
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "reserved")
    return { ok: false, message: `Subscription ${sub.reference} is ${sub.status}.` };
  if (sub.scheme.status !== "open") {
    return {
      ok: false,
      message: "The scheme is no longer open; ask an admin to reject the subscription.",
    };
  }
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: { status: "cancelled", decidedAt: new Date(), decidedById: member.id },
  });
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorRole: member.role,
    action: "commodity.subscription.cancelled",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: sub.reference,
  });
  return {
    ok: true,
    message: `Subscription *${sub.reference}* cancelled; your credit is free again.`,
  };
}

export async function rejectCommoditySubscription(
  adminPhone: string,
  ref: string,
  reason?: string,
): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can reject a subscription." };
  const sub = await prisma.commoditySubscription.findFirst({
    where: { cooperativeId: admin.cooperativeId, reference: ref.toUpperCase() },
    include: { member: true },
  });
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "reserved" && sub.status !== "approved") {
    return { ok: false, message: `Subscription ${sub.reference} is ${sub.status}.` };
  }
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: {
      status: "rejected",
      decidedAt: new Date(),
      decidedById: admin.id,
      rejectReason: reason?.trim() || null,
    },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.subscription.rejected",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: `${sub.reference}${reason ? `: ${reason}` : ""}`,
  });
  await notifyMember(
    sub.member,
    `Your subscription *${sub.reference}* was not approved${reason ? `: ${reason}` : "."}`,
  ).catch(() => {});
  return { ok: true, message: `Subscription *${sub.reference}* rejected; credit released.` };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commodity-scheme.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add src/services/commodity-schemes.ts tests/commodity-scheme.test.ts
git commit -m "feat: add commodity scheme lifecycle and credit reservations"
```

---

### Task 4: Purchase gate, conversion, collection

**Files:**

- Modify: `src/services/commodity-schemes.ts` (append functions)
- Test: `tests/commodity-scheme.test.ts` (add a second `describe` block)

**Interfaces:**

- Consumes: `prisma.posting`, `prisma.loan`, `prisma.deductionBatch`, `installmentSchedule`, `audit`.
- Produces:
  - `purchaseScheme(superPhone: string, ref: string, supplier: string, actualCostKobo: number, opts?: { fundingSource?: "cash" | "supplier_credit"; note?: string }): Promise<SchemeResult>`
  - `convertScheme(superPhone: string, ref: string): Promise<SchemeResult>`
  - `dispatchCommodity(adminPhone: string, ref: string): Promise<SchemeResult>`
  - `collectCommodity(adminPhone: string, ref: string, memberCode: string): Promise<SchemeResult>`
  - `bankCashKobo(cooperativeId: string): Promise<number>`
  - `listSchemeSubscriptions(cooperativeId: string, ref: string): Promise<...>`

- [x] **Step 1: Write the failing tests**

Append to `tests/commodity-scheme.test.ts`:

```ts
import {
  bankCashKobo,
  purchaseScheme,
  convertScheme,
  dispatchCommodity,
  collectCommodity,
} from "../src/services/commodity-schemes.js";

describe("commodity purchase and conversion", () => {
  it("refuses to purchase without reconciled bank cash", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    await closeScheme(ADMIN, scheme.ref!);
    const res = await purchaseScheme(SUPER, scheme.reference, "Farm Ltd", 5_000_000);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("cash");
    const fresh = await prisma.commodityScheme.findUnique({
      where: { reference: scheme.reference },
    });
    expect(fresh!.status).toBe("closed");
  });

  it("allows an audited supplier-credit override", async () => {
    await seed();
    const { coop } = await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    await closeScheme(ADMIN, scheme.ref!);
    const res = await purchaseScheme(SUPER, scheme.reference, "Farm Ltd", 5_000_000, {
      fundingSource: "supplier_credit",
      note: "Supplier allows 60 days",
    });
    expect(res.ok).toBe(true);
    const fresh = await prisma.commodityScheme.findUnique({
      where: { reference: scheme.reference },
    });
    expect(fresh!.status).toBe("purchased");
    expect(fresh!.fundingSource).toBe("supplier_credit");
    const logged = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "commodity.scheme.purchased" },
    });
    expect(logged).not.toBeNull();
  });

  it("converts reservations into commodity loans and dispatch/collect tracking", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 3_000 } });
    const subscribed = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 2, 3);
    await closeScheme(ADMIN, scheme.ref!);
    await prisma.posting.create({
      data: {
        entry: {
          create: {
            cooperativeId: (await prisma.cooperative.findFirst())!.id,
            description: "reconciled remittance",
            postings: {
              create: [{ account: "assets:bank", direction: "DEBIT", amount: 10_000_000 }],
            },
          },
        },
      },
    });
    expect(await bankCashKobo((await prisma.cooperative.findFirst())!.id)).toBe(10_000_000);
    expect((await purchaseScheme(SUPER, scheme.reference, "Farm Ltd", 6_000_000)).ok).toBe(true);
    const converted = await convertScheme(SUPER, scheme.reference);
    expect(converted.ok).toBe(true);
    const loan = await prisma.loan.findFirst({ where: { kind: "commodity" } });
    expect(loan).not.toBeNull();
    expect(loan!.balance).toBe(6_000);
    expect(loan!.status).toBe("disbursed");
    const item = await prisma.deductionItem.findFirst({ where: { kind: "commodity" } });
    expect(item).not.toBeNull();
    expect(item!.amount).toBe(2_000);
    const sub = await prisma.commoditySubscription.findFirst();
    expect(sub!.status).toBe("converted");
    expect(sub!.convertedLoanId).toBe(loan!.id);

    const dispatched = await dispatchCommodity(ADMIN, subscribed.ref!);
    expect(dispatched.ok).toBe(true);
    const collected = await collectCommodity(ADMIN, subscribed.ref!, "SM001");
    expect(collected.ok).toBe(true);
    const after = await prisma.commoditySubscription.findFirst();
    expect(after!.collectedAt).not.toBeNull();
  });
});
```

Note: the `posting`/`entry` shape must match the schema; inspect an existing test that creates a posting (e.g. `tests/reconciliation.test.ts`) and copy its creation shape if the nested form differs.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commodity-scheme.test.ts`
Expected: FAIL — `purchaseScheme` is not exported.

- [x] **Step 3: Implement purchase, conversion, collection**

Append to `src/services/commodity-schemes.ts`:

```ts
export async function bankCashKobo(cooperativeId: string): Promise<number> {
  const rows = await prisma.posting.groupBy({
    by: ["direction"],
    where: { entry: { cooperativeId }, account: "assets:bank" },
    _sum: { amount: true },
  });
  const debit = rows.find((r) => r.direction === "DEBIT")?._sum.amount ?? 0;
  const credit = rows.find((r) => r.direction === "CREDIT")?._sum.amount ?? 0;
  return debit - credit;
}

export async function purchaseScheme(
  superPhone: string,
  ref: string,
  supplier: string,
  actualCostKobo: number,
  opts: { fundingSource?: "cash" | "supplier_credit"; note?: string } = {},
): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can record a scheme purchase." };
  const scheme = await findScheme(superM.cooperativeId, ref);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "closed") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status}; close it before purchasing.`,
    };
  }
  if (!Number.isFinite(actualCostKobo) || actualCostKobo <= 0) {
    return { ok: false, message: "Usage: *purchasescheme <ref> | <supplier> | <cost>*" };
  }
  const fundingSource = opts.fundingSource ?? "cash";
  if (fundingSource === "supplier_credit" && !opts.note?.trim()) {
    return { ok: false, message: "A supplier-credit purchase needs a note (payment terms)." };
  }
  if (fundingSource === "cash") {
    const cash = await bankCashKobo(scheme.cooperativeId);
    const alreadyCommitted = await prisma.commodityScheme.aggregate({
      where: {
        cooperativeId: scheme.cooperativeId,
        status: { in: ["purchased", "converted"] },
        id: { not: scheme.id },
      },
      _sum: { actualCostKobo: true },
    });
    const available = cash - (alreadyCommitted._sum.actualCostKobo ?? 0);
    if (available < actualCostKobo) {
      return {
        ok: false,
        message:
          `Reconciled bank cash is ${formatBalance(available)}; this purchase needs ${formatBalance(actualCostKobo)}.\n` +
          `Wait for remittances, or record supplier credit with *purchasescheme ${scheme.reference} | ${supplier} | ${actualCostKobo / 100} | supplier_credit | <terms>* (super admin only, audited).`,
      };
    }
  }
  await prisma.commodityScheme.update({
    where: { id: scheme.id },
    data: {
      status: "purchased",
      supplier: supplier.trim(),
      actualCostKobo,
      fundingSource,
      purchaseNote: opts.note?.trim() || null,
      purchasedAt: new Date(),
      purchasedById: superM.id,
    },
  });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "commodity.scheme.purchased",
    targetType: "commodityScheme",
    targetId: scheme.id,
    amount: actualCostKobo,
    detail: `${scheme.reference}: ${supplier} via ${fundingSource}${opts.note ? ` (${opts.note})` : ""}`,
  });
  return {
    ok: true,
    message:
      `Purchase recorded for *${scheme.reference}*: ${formatBalance(actualCostKobo)} from ${supplier} (${fundingSource}).\n` +
      `Run *convertscheme ${scheme.reference}* to turn reservations into payroll installments.`,
  };
}

export async function convertScheme(superPhone: string, ref: string): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can convert a scheme." };
  const scheme = await findScheme(superM.cooperativeId, ref);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "purchased") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status}; purchase it first.`,
    };
  }
  const subs = await prisma.commoditySubscription.findMany({
    where: { schemeId: scheme.id, status: { in: ["reserved", "approved"] } },
    include: { item: true, member: true },
    orderBy: { createdAt: "asc" },
  });
  if (subs.length === 0) return { ok: false, message: "No subscriptions to convert." };

  const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  let batch = await prisma.deductionBatch.findFirst({
    where: { cooperativeId: scheme.cooperativeId, status: { in: ["draft", "submitted"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!batch) {
    batch = await prisma.deductionBatch.create({
      data: {
        cooperativeId: scheme.cooperativeId,
        ref: `DED-${period}-${Date.now().toString(36).toUpperCase()}`,
        note: `Commodity scheme ${scheme.reference}`,
        totalAmount: 0,
        createdById: superM.id,
      },
    });
  }

  let created = 0;
  for (const sub of subs) {
    const { monthly } = installmentSchedule(sub.totalKobo, sub.months);
    const loan = await prisma.loan.create({
      data: {
        cooperativeId: scheme.cooperativeId,
        memberId: sub.memberId,
        principal: sub.totalKobo,
        balance: sub.totalKobo,
        months: sub.months,
        monthlyPayment: monthly,
        status: "disbursed",
        kind: "commodity",
        purpose: `${scheme.name}: ${sub.qty} x ${sub.item.name}`,
      },
    });
    const firstInstallment = Math.min(monthly, loan.balance);
    await prisma.deductionItem.create({
      data: {
        batchId: batch.id,
        memberId: sub.memberId,
        kind: "commodity",
        loanId: loan.id,
        amount: firstInstallment,
      },
    });
    await prisma.commoditySubscription.update({
      where: { id: sub.id },
      data: {
        status: "converted",
        convertedLoanId: loan.id,
        decidedAt: new Date(),
        decidedById: superM.id,
      },
    });
    await notifyMember(
      sub.member,
      `?? *${sub.qty} x ${sub.item.name}* is now financed.\n` +
        `${sub.months} payroll installments of about ${formatBalance(monthly)}, starting with batch *${batch.ref}*.`,
    ).catch(() => {});
    created += 1;
  }
  await prisma.deductionBatch.update({
    where: { id: batch.id },
    data: {
      totalAmount: {
        increment: await prisma.deductionItem
          .aggregate({ where: { batchId: batch.id }, _sum: { amount: true } })
          .then((r) => r._sum.amount ?? 0),
      },
    },
  });
  await prisma.commodityScheme.update({
    where: { id: scheme.id },
    data: { status: "converted", convertedAt: new Date() },
  });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "commodity.scheme.converted",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: `${scheme.reference}: ${created} subscription(s)`,
  });
  return {
    ok: true,
    message:
      `Converted *${created}* subscription(s) on *${scheme.reference}*.\n` +
      `First installments were added to batch *${batch.ref}*.`,
  };
}

async function findSubscription(cooperativeId: string, ref: string) {
  return prisma.commoditySubscription.findFirst({
    where: { cooperativeId, OR: [{ id: ref }, { reference: ref.toUpperCase() }] },
    include: { member: { select: { id: true, name: true, code: true } }, item: true, scheme: true },
  });
}

export async function dispatchCommodity(adminPhone: string, ref: string): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can mark a subscription dispatched." };
  const sub = await findSubscription(admin.cooperativeId, ref);
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "converted")
    return { ok: false, message: `Subscription ${sub.reference} is ${sub.status}.` };
  if (sub.dispatchedAt)
    return { ok: false, message: `Subscription ${sub.reference} was already dispatched.` };
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: { dispatchedAt: new Date() },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.subscription.dispatched",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: sub.reference,
  });
  await notifyMember(
    sub.member,
    `?? Your *${sub.qty} x ${sub.item.name}* is ready for collection.\n` +
      `Admin will mark it collected with *collectsub ${sub.reference} <your code>*.`,
  ).catch(() => {});
  return { ok: true, message: `Subscription *${sub.reference}* marked dispatched.` };
}

export async function collectCommodity(
  adminPhone: string,
  ref: string,
  memberCode: string,
): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can mark a subscription collected." };
  const sub = await findSubscription(admin.cooperativeId, ref);
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "converted" || !sub.dispatchedAt) {
    return { ok: false, message: "Dispatch the item before marking it collected." };
  }
  if (sub.collectedAt)
    return { ok: false, message: `Subscription ${sub.reference} was already collected.` };
  if (sub.member.code.toUpperCase() !== memberCode.trim().toUpperCase()) {
    return { ok: false, message: "That member code does not match the subscription." };
  }
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: { collectedAt: new Date(), collectedById: admin.id },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.subscription.collected",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: `${sub.reference} collected by ${sub.member.name}`,
  });
  return {
    ok: true,
    message: `Collected: *${sub.qty} x ${sub.item.name}* handed to ${sub.member.name}.`,
  };
}

export async function listSchemeSubscriptions(cooperativeId: string, ref: string) {
  const scheme = await findScheme(cooperativeId, ref);
  if (!scheme) return null;
  const subs = await prisma.commoditySubscription.findMany({
    where: { schemeId: scheme.id },
    include: { member: { select: { name: true, code: true } }, item: true },
    orderBy: { createdAt: "asc" },
  });
  return { scheme, subs };
}

export async function listMemberSubscriptions(memberId: string, cooperativeId: string) {
  return prisma.commoditySubscription.findMany({
    where: { memberId, cooperativeId, status: { not: "cancelled" } },
    include: { item: true, scheme: true },
    orderBy: { createdAt: "desc" },
  });
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commodity-scheme.test.ts`
Expected: PASS (9 tests). If the `posting.create` shape fails, copy the exact nested shape from `tests/reconciliation.test.ts` and re-run.

- [x] **Step 5: Commit**

```bash
git add src/services/commodity-schemes.ts tests/commodity-scheme.test.ts
git commit -m "feat: gate scheme purchases on bank cash and convert reservations to payroll loans"
```

---

### Task 5: Payroll builder — commodity installments and cash-only loan selection

**Files:**

- Modify: `src/services/deductions.ts` (`buildBatch` ~28-118, `buildBatchFromRows` ~119-204)
- Test: `tests/commodity-payroll.test.ts`

**Interfaces:**

- Consumes: `DeductionItem.kind`, `Loan.kind`.
- Produces: `DraftItem.kind` widened to `"savings" | "loan" | "commodity"`; `buildBatch` emits commodity items; it no longer emits `"loan"` items for `kind != "cash"`.

- [x] **Step 1: Write the failing test**

```ts
// tests/commodity-payroll.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../tests/setup.js";
import { buildBatch } from "../src/services/deductions.js";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "loanRepayment",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
});

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Payroll Coop", code: `PC${Date.now()}` },
  });
  const admin = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348090000200",
      name: "Payroll Admin",
      code: "PA001",
      role: "admin",
      status: "active",
      monthlyDeduction: 10_000,
      wallet: { create: {} },
    },
  });
  return { coop, admin };
}

async function makeLoan(coopId: string, memberId: string, kind: string, balance: number) {
  return prisma.loan.create({
    data: {
      cooperativeId: coopId,
      memberId,
      principal: balance,
      balance,
      months: 3,
      monthlyPayment: 2_000,
      status: "disbursed",
      kind,
    },
  });
}

describe("buildBatch commodity installments", () => {
  it("adds a commodity item and ignores shop loans", async () => {
    const { coop, admin } = await seed();
    await makeLoan(coop.id, admin.id, "shop", 5_000);
    const commodity = await makeLoan(coop.id, admin.id, "commodity", 6_000);
    const res = await buildBatch("2348090000200");
    expect(res.ok).toBe(true);
    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    const kinds = batch!.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["commodity", "savings"]);
    const commodityItem = batch!.items.find((i) => i.kind === "commodity")!;
    expect(commodityItem.loanId).toBe(commodity.id);
    expect(commodityItem.amount).toBe(2_000);
  });

  it("still creates a cash-loan item for kind cash", async () => {
    const { coop, admin } = await seed();
    await makeLoan(coop.id, admin.id, "cash", 6_000);
    await buildBatch("2348090000200");
    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    expect(batch!.items.map((i) => i.kind).sort()).toEqual(["loan", "savings"]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commodity-payroll.test.ts`
Expected: FAIL — commodities are emitted as `"loan"` or the shop loan is included.

- [x] **Step 3: Implement the builder changes**

In `buildBatch`, change the member include to cash-only:

```ts
    include: {
      loans: {
        where: { status: "disbursed", kind: "cash" },
        orderBy: { createdAt: "asc" },
      },
    },
```

Widen the draft type and extend the loop:

```ts
type DraftItem = {
  memberId: string;
  kind: "savings" | "loan" | "commodity";
  loanId?: string;
  amount: number;
};
```

After the per-member `for` loop (before `if (items.length === 0)`), add:

```ts
const commodityLoans = await prisma.loan.findMany({
  where: { cooperativeId: coopId, kind: "commodity", status: "disbursed", balance: { gt: 0 } },
  orderBy: { createdAt: "asc" },
});
for (const loan of commodityLoans) {
  const installment =
    loan.monthlyPayment && loan.monthlyPayment > 0
      ? Math.min(loan.monthlyPayment, loan.balance)
      : loan.balance;
  items.push({
    memberId: loan.memberId,
    kind: "commodity",
    loanId: loan.id,
    amount: Math.round(installment * 100) / 100,
  });
}
```

Apply the same include change and commodity loop in `buildBatchFromRows` (it builds loan items separately around lines 150-200; keep its row-derived savings items and add the same cash-only filter plus the commodity block before it creates the batch).

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commodity-payroll.test.ts tests/deductions.test.ts`
Expected: new file PASS; existing deductions tests still PASS (the shortfall tests are rewritten in Task 6).

- [x] **Step 5: Commit**

```bash
git add src/services/deductions.ts tests/commodity-payroll.test.ts
git commit -m "feat: collect commodity installments through payroll without double-collecting shop loans"
```

---

### Task 6: Shortfall attribution, priority allocation, roll-forward

**Files:**

- Modify: `src/services/deductions.ts` (`reconcileBatch` ~290-354, `approveBatch` ~446-663, add `attributeShortfall` + `rollForwardItem`)
- Modify: `tests/deductions.test.ts` (rewrite DEDB08 and DEDB10)
- Test: `tests/deduction-shortfall.test.ts`

**Interfaces:**

- Consumes: `DeductionShortfall`, `DeductionItem.rolloverOfItemId`, `periodOf`.
- Produces:
  - `attributeShortfall(superPhone: string, ref: string, memberCode: string, amountKobo: number | "all" | "waive", reason?: string): Promise<{ ok: boolean; message: string }>`
  - `rollForwardItem(batchId: string, itemId: string, approverId: string): Promise<DeductionItem>`
  - `priorityRank(kind: string): number` (loan 0, commodity 1, savings 2)

- [x] **Step 1: Rewrite the two existing shortfall tests**

In `tests/deductions.test.ts`, replace the test named `"a short reconciliation blocks approval until the full amount is received"` with:

```ts
it("a short reconciliation settles and rolls the unpaid amount forward", async () => {
  const coop = await makeCoop("DEDB08", "Short Coop", SUPER_PHONE);
  await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
  const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
  const m = await makeMember(M1, coop.id);
  await handleMessage(ADMIN_PHONE, `setcommit ${m.code} 10000`);
  await handleMessage(ADMIN_PHONE, "newbatch");
  const batch = await prisma.deductionBatch.findFirst();
  await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
  await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
  await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 100`);
  await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 60`);
  await handleMessage(SUPER_PHONE, `shortbatch ${batch!.ref} ${m.code} 40`);

  vi.clearAllMocks();
  await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
  expect((await prisma.wallet.findUnique({ where: { memberId: m.id } }))!.balance).toBe(6_000);
  const shortfall = await prisma.deductionShortfall.findFirst();
  expect(shortfall!.status).toBe("rolled");
  const rolled = await prisma.deductionItem.findFirst({ where: { status: "rolled" } });
  expect(rolled).not.toBeNull();
  const replacement = await prisma.deductionItem.findFirst({
    where: { rolloverOfItemId: rolled!.id },
  });
  expect(replacement!.amount).toBe(4_000);
  expect(replacement!.batchId).not.toBe(batch!.id);
});
```

Replace the test named `"partial approval credits only what the reconciled amount covers"` with:

```ts
it("partial approval applies priority per member and rolls the remainder", async () => {
  const coop = await makeCoop("DEDB10", "Partial Coop", SUPER_PHONE);
  await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
  const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
  const m1 = await makeMember(M1, coop.id);
  await handleMessage(ADMIN_PHONE, `setcommit ${m1.code} 100`);
  await handleMessage(ADMIN_PHONE, "newbatch");
  const batch = await prisma.deductionBatch.findFirst();
  await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
  await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
  await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 100`);
  await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 60`);
  await handleMessage(SUPER_PHONE, `shortbatch ${batch!.ref} ${m1.code} 40`);

  vi.clearAllMocks();
  await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
  expect((await prisma.wallet.findUnique({ where: { memberId: m1.id } }))!.balance).toBe(6_000);
  const fresh = await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } });
  expect(fresh!.status).toBe("approved");
});
```

- [x] **Step 2: Write the new failing test**

```ts
// tests/deduction-shortfall.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../tests/setup.js";
import { attributeShortfall, rollForwardItem, priorityRank } from "../src/services/deductions.js";

const SUPER = "2348090000300";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "loanRepayment",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
});

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Short Coop", code: `SH${Date.now()}` },
  });
  const superM = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: SUPER,
      name: "Super",
      code: "SS900",
      role: "superadmin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348090000301",
      name: "Short Member",
      code: "SM900",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  const batch = await prisma.deductionBatch.create({
    data: {
      cooperativeId: coop.id,
      ref: "DED-SHORT-1",
      status: "reconciled",
      totalAmount: 1_000,
      reconciledAmount: 600,
      createdById: superM.id,
    },
  });
  return { coop, superM, member, batch };
}

describe("deduction shortfalls", () => {
  it("ranks loan before commodity before savings", () => {
    expect(priorityRank("loan")).toBeLessThan(priorityRank("commodity"));
    expect(priorityRank("commodity")).toBeLessThan(priorityRank("savings"));
  });

  it("attributes an explicit shortfall", async () => {
    const { batch, member } = await seed();
    const res = await attributeShortfall(SUPER, batch.ref, member.code, 400, "employer skipped");
    expect(res.ok).toBe(true);
    const row = await prisma.deductionShortfall.findFirst();
    expect(row!.amount).toBe(400);
    expect(row!.status).toBe("open");
    expect(row!.reason).toBe("employer skipped");
  });

  it("attributes proportionally when no member is named", async () => {
    const { batch, member } = await seed();
    await prisma.deductionItem.create({
      data: { batchId: batch.id, memberId: member.id, kind: "savings", amount: 1_000 },
    });
    const res = await attributeShortfall(SUPER, batch.ref, "all", "all");
    expect(res.ok).toBe(true);
    const row = await prisma.deductionShortfall.findFirst();
    expect(row!.amount).toBe(400);
  });

  it("waives a shortfall and releases the block", async () => {
    const { batch, member } = await seed();
    await attributeShortfall(SUPER, batch.ref, member.code, 400);
    const res = await attributeShortfall(SUPER, batch.ref, member.code, "waive");
    expect(res.ok).toBe(true);
    const row = await prisma.deductionShortfall.findFirst();
    expect(row!.status).toBe("waived");
  });

  it("rolls an unpaid item into a draft batch for the next period once", async () => {
    const { batch, member } = await seed();
    const item = await prisma.deductionItem.create({
      data: { batchId: batch.id, memberId: member.id, kind: "savings", amount: 1_000 },
    });
    const first = await rollForwardItem(batch.id, item.id, member.id);
    expect(first.batchId).not.toBe(batch.id);
    expect(first.amount).toBe(1_000);
    const original = await prisma.deductionItem.findUnique({ where: { id: item.id } });
    expect(original!.status).toBe("rolled");
    await expect(rollForwardItem(batch.id, item.id, member.id)).rejects.toThrow();
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/deduction-shortfall.test.ts`
Expected: FAIL — `attributeShortfall` / `rollForwardItem` / `priorityRank` are not exported.

- [x] **Step 4: Implement attribution and roll-forward**

Add to `src/services/deductions.ts`:

```ts
export function priorityRank(kind: string): number {
  if (kind === "loan") return 0;
  if (kind === "commodity") return 1;
  return 2;
}

export async function attributeShortfall(
  superPhone: string,
  rawRef: string,
  memberCode: string,
  amountKobo: number | "all" | "waive",
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({
    where: { ref },
    include: { items: { include: { member: true } } },
  });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can attribute a shortfall." };
  }
  const received = batch.reconciledAmount ?? 0;
  const totalShort = Math.max(0, batch.totalAmount - received);
  if (totalShort === 0) return { ok: false, message: `Batch ${ref} was not short.` };
  const superM = await prisma.member.findFirst({
    where: { phone: superPhone, cooperativeId: batch.cooperativeId },
  });

  const targets =
    memberCode.trim().toLowerCase() === "all"
      ? Array.from(new Set(batch.items.map((i) => i.memberId))).map((id) => {
          const item = batch.items.find((i) => i.memberId === id)!;
          const owed = batch.items
            .filter((i) => i.memberId === id)
            .reduce((s, i) => s + i.amount, 0);
          return { memberId: id, name: item.member.name, owed };
        })
      : (() => {
          const item = batch.items.find(
            (i) => i.member.code.toUpperCase() === memberCode.trim().toUpperCase(),
          );
          if (!item) return null;
          const owed = batch.items
            .filter((i) => i.memberId === item.memberId)
            .reduce((s, i) => s + i.amount, 0);
          return [{ memberId: item.memberId, name: item.member.name, owed }];
        })();
  if (!targets) return { ok: false, message: "That member is not in this batch." };

  let added = 0;
  for (const target of targets) {
    const existing = await prisma.deductionShortfall.findUnique({
      where: { batchId_memberId: { batchId: batch.id, memberId: target.memberId } },
    });
    if (amountKobo === "waive") {
      if (existing) {
        await prisma.deductionShortfall.update({
          where: { id: existing.id },
          data: { status: "waived", attributedById: superM?.id ?? null },
        });
      }
      await audit({
        cooperativeId: batch.cooperativeId,
        actorPhone: superPhone,
        actorRole: "superadmin",
        action: "deduction.shortfall.waived",
        targetType: "deductionBatch",
        targetId: batch.id,
        detail: `${ref}: ${target.name}`,
      });
      continue;
    }
    const proportional = Math.round((totalShort * target.owed) / batch.totalAmount);
    const amount = amountKobo === "all" ? proportional : amountKobo;
    if (amount <= 0) continue;
    await prisma.deductionShortfall.upsert({
      where: { batchId_memberId: { batchId: batch.id, memberId: target.memberId } },
      update: {
        amount,
        status: "open",
        reason: reason ?? existing?.reason ?? null,
        attributedById: superM?.id ?? null,
      },
      create: {
        cooperativeId: batch.cooperativeId,
        batchId: batch.id,
        memberId: target.memberId,
        amount,
        reason: reason ?? null,
        attributedById: superM?.id ?? null,
      },
    });
    added += amount;
  }
  await audit({
    cooperativeId: batch.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "deduction.shortfall.attributed",
    targetType: "deductionBatch",
    targetId: batch.id,
    detail: `${ref}: ${formatBalance(added)} across ${targets.length} member(s)`,
  });
  return {
    ok: true,
    message:
      amountKobo === "waive"
        ? `Shortfall waived for ${targets.length} member(s) on *${ref}*.`
        : `Attributed ${formatBalance(added)} of shortfall on *${ref}* to ${targets.length} member(s).`,
  };
}

export async function rollForwardItem(
  batchId: string,
  itemId: string,
  approverId: string,
): Promise<{ id: string; batchId: string; amount: number; [key: string]: unknown }> {
  return withTx(async () => {
    const item = await prisma.deductionItem.findUnique({ where: { id: itemId } });
    if (!item) throw new Error("Deduction item not found.");
    if (item.batchId !== batchId) throw new Error("Item does not belong to that batch.");
    if (item.status !== "pending") throw new Error("Only a pending item can be rolled forward.");
    if (item.rolloverOfItemId) throw new Error("This item is already a rollover.");
    const parent = await prisma.deductionBatch.findUnique({ where: { id: batchId } });
    if (!parent) throw new Error("Batch not found.");
    const [year, month] = parent.ref.split("-").slice(1, 3);
    const next = new Date(Date.UTC(Number(year), Number(month), 1));
    const period = periodOf(next);
    let target = await prisma.deductionBatch.findFirst({
      where: { cooperativeId: parent.cooperativeId, status: "draft" },
      orderBy: { createdAt: "desc" },
    });
    if (!target) {
      target = await prisma.deductionBatch.create({
        data: {
          cooperativeId: parent.cooperativeId,
          ref: `DED-${period}-${Date.now().toString(36).toUpperCase()}`,
          note: `Rolled forward from ${parent.ref}`,
          totalAmount: 0,
          createdById: parent.createdById,
        },
      });
    }
    const created = await prisma.deductionItem.create({
      data: {
        batchId: target.id,
        memberId: item.memberId,
        kind: item.kind,
        loanId: item.loanId,
        amount: item.amount,
        rolloverOfItemId: item.id,
      },
    });
    await prisma.deductionItem.update({ where: { id: item.id }, data: { status: "rolled" } });
    await prisma.deductionBatch.update({
      where: { id: target.id },
      data: { totalAmount: { increment: created.amount } },
    });
    await prisma.deductionShortfall.updateMany({
      where: { batchId, memberId: item.memberId, status: "open" },
      data: { status: "rolled", rolledToItemId: created.id },
    });
    void approverId;
    return created;
  });
}
```

- [x] **Step 5: Change `reconcileBatch` to settle short batches**

Replace the shortfall early-return block in `reconcileBatch`:

```ts
if (shortfall > 0) {
  await notifySuperAdmins(
    batch.cooperativeId,
    `?? Batch *${ref}* reconciled short: expected ${formatBalance(batch.totalAmount)}, received ${formatBalance(amount)} (short ${formatBalance(shortfall)}). Approval is blocked until the full amount is received.`,
  );
  return {
    ok: true,
    message: `?? Batch *${ref}* reconciled with a shortfall of ${formatBalance(shortfall)}. Approval is blocked until the full amount is received.`,
  };
}
```

with:

```ts
if (shortfall > 0) {
  await notifySuperAdmins(
    batch.cooperativeId,
    `?? Batch *${ref}* reconciled short: expected ${formatBalance(batch.totalAmount)}, received ${formatBalance(amount)} (short ${formatBalance(shortfall)}).\n` +
      `Attribute it with *shortbatch ${ref} <member code|all> <amount|all|waive>*, then *approvebatch ${ref}*.`,
  );
  return {
    ok: true,
    message:
      `Batch *${ref}* reconciled with a shortfall of ${formatBalance(shortfall)}.\n` +
      `Attribute it with *shortbatch ${ref} <code|all> <amount|all|waive>*; unattributed amounts are split proportionally on approval.`,
  };
}
```

- [x] **Step 6: Rewrite the `approveBatch` allocation loop**

Replace the `let spent = 0; for (const item of batch.items) { ... }` block with a per-member version. Insert before the loop:

```ts
const pendingByMember = new Map<string, typeof batch.items>();
for (const item of batch.items) {
  if (item.status !== "pending") continue;
  const list = pendingByMember.get(item.memberId) ?? [];
  list.push(item);
  pendingByMember.set(item.memberId, list);
}
const shortfalls = await prisma.deductionShortfall.findMany({
  where: { batchId: batch.id, status: "open" },
});
const shortfallByMember = new Map(shortfalls.map((s) => [s.memberId, s.amount]));
let spent = 0;
const orderedMembers = Array.from(pendingByMember.entries());
for (const [memberId, memberItems] of orderedMembers) {
  const memberTotal = memberItems.reduce((s, i) => s + i.amount, 0);
  const short = shortfallByMember.get(memberId) ?? 0;
  let memberBudget = Math.max(0, memberTotal - short);
  const ordered = [...memberItems].sort((a, b) => priorityRank(a.kind) - priorityRank(b.kind));
  for (const item of ordered) {
    if (memberBudget <= 0) break;
    const applied = Math.min(item.amount, memberBudget);
    if (applied < item.amount) {
      // Partial credit is not modelled on DeductionItem; roll the whole item.
      await rollForwardItem(batch.id, item.id, approver.id);
      continue;
    }
    spent += applied;
    memberBudget -= applied;
    const member = item.member;
    // ... existing savings / loan credit body unchanged, using `applied` as the amount ...
  }
}
```

Inside that body, replace every `item.amount` used for crediting with `applied` (savings `Contribution.amount`, wallet increment, `Math.min(applied, loan.balance)`, notification figures), keep the `deductionItem.update` to `status: "credited"`, and after a member's items are processed, roll any item that was skipped because `memberBudget` hit zero:

```ts
for (const item of ordered) {
  const still = await prisma.deductionItem.findUnique({ where: { id: item.id } });
  if (still?.status === "pending") {
    await rollForwardItem(batch.id, item.id, approver.id);
  }
}
```

Finally, change the closing recalculation to count rolled items as settled:

```ts
const remainingPending = await prisma.deductionItem.count({
  where: { batchId: batch.id, status: "pending" },
});
```

stays as-is; because rolled items leave `pending`, a fully-allocated batch reaches `approved` with shortfalls recorded. Update the audit detail to include `rollovers` count when > 0.

- [x] **Step 7: Run the tests**

Run: `npx vitest run tests/deduction-shortfall.test.ts tests/deductions.test.ts`
Expected: PASS (5 new tests + rewritten DEDB08/DEDB10 + the rest of the deductions suite).

- [x] **Step 8: Commit**

```bash
git add src/services/deductions.ts tests/deduction-shortfall.test.ts tests/deductions.test.ts
git commit -m "feat: attribute payroll shortfalls per member and roll unpaid items forward"
```

---

### Task 7: WhatsApp wiring, help menus, scheduler, env gating

**Files:**

- Create: `src/services/commodity-commands.ts`
- Modify: `src/services/conversation.ts` (member cases)
- Modify: `src/services/admin.ts` (admin cases + money-out set)
- Modify: `src/services/handlers/session.ts` (help menus)
- Modify: `src/services/scheduler.ts` (close expired schemes + month-end shortfall notice)
- Test: `tests/commodity-commands.test.ts`

**Interfaces:**

- Consumes: all services from Tasks 2-6.
- Produces: `runSchemeWindows(now?: Date): Promise<number>`; `formatSchemesText(phone)`, `formatMySubsText(phone)`, `formatSchemeSubsText(coopId, ref)`; `parseSchemeItem(raw)`.

- [x] **Step 1: Write the failing tests**

```ts
// tests/commodity-commands.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { sendText } from "../src/lib/messaging.js";
import { handleMessage } from "../src/services/conversation.js";

const SUPER = "2348090000400";
const ADMIN = "2348090000401";
const MEMBER = "2348090000402";

function lastText(): string {
  const calls = vi.mocked(sendText).mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as { text: string }).text : "";
}

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "1");
  for (const t of [
    "session",
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "commoditySubscription",
    "commoditySchemeItem",
    "commodityScheme",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
  vi.mocked(sendText).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Cmd Coop", code: `CM${Date.now()}` },
  });
  const superM = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: SUPER,
      name: "Super",
      code: "CSU1",
      role: "superadmin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const admin = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: ADMIN,
      name: "Admin",
      code: "CAD1",
      role: "admin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: MEMBER,
      name: "Member",
      code: "CME1",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  await prisma.deductionBatch.create({
    data: {
      cooperativeId: coop.id,
      ref: `DED-${new Date().toISOString().slice(0, 7)}-CMD1`,
      totalAmount: 10_000,
      sourceFileKey: "schedules/cmd.xlsx",
      createdById: admin.id,
      items: { create: [{ memberId: member.id, kind: "savings", amount: 10_000 }] },
    },
  });
  return { coop, superM, admin, member };
}

describe("commodity WhatsApp commands", () => {
  it("creates and opens a scheme from admin chat", async () => {
    await seed();
    await handleMessage(SUPER, "newscheme Christmas 2026 | Christmas | 2026-11-01 | 2099-12-31");
    expect(lastText()).toContain("SCH-");
    const scheme = await prisma.commodityScheme.findFirst();
    await handleMessage(
      SUPER,
      `addschemeitem ${scheme!.reference} | Rice 50kg | bag | 800 | 900 | 10 | 2`,
    );
    expect(lastText()).toContain("Added");
    await handleMessage(ADMIN, `openscheme ${scheme!.reference}`);
    const fresh = await prisma.commodityScheme.findUnique({ where: { id: scheme!.id } });
    expect(fresh!.status).toBe("open");
  });

  it("shows credit and subscribes from member chat", async () => {
    const { member } = await seed();
    await handleMessage(SUPER, "newscheme Ileya 2027 | Ileya | 2026-11-01 | 2099-12-31");
    const scheme = await prisma.commodityScheme.findFirst();
    await handleMessage(
      SUPER,
      `addschemeitem ${scheme!.reference} | Ram | ram | 100 | 200 | 5 | 1`,
    );
    await handleMessage(ADMIN, `openscheme ${scheme!.reference}`);

    await handleMessage(MEMBER, "credit");
    expect(lastText()).toContain("30");
    await handleMessage(MEMBER, `subscribe ${scheme!.reference} Ram 1 3`);
    expect(lastText()).toContain("Reserved");
    const sub = await prisma.commoditySubscription.findFirst();
    expect(sub!.memberId).toBe(member.id);

    await handleMessage(MEMBER, "mysubs");
    expect(lastText()).toContain(sub!.reference);
    await handleMessage(MEMBER, "schemes");
    expect(lastText()).toContain("Ram");
  });

  it("replies with the disabled message when the feature flag is off", async () => {
    vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "0");
    await seed();
    await handleMessage(MEMBER, "schemes");
    expect(lastText()).toContain("not enabled");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commodity-commands.test.ts`
Expected: FAIL — `newscheme` is treated as an unknown command.

- [x] **Step 3: Implement the command helper module**

```ts
// src/services/commodity-commands.ts
import { prisma } from "../lib/prisma.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { commoditySchemesEnabled, getCommodityCreditPosition } from "./commodity-credit.js";
import { listMemberSubscriptions, listSchemeSubscriptions } from "./commodity-schemes.js";
import type { SchemeItemInput } from "./commodity-schemes.js";

export const COMMODITY_DISABLED = "Commodity schemes are not enabled on this deployment yet.";

export function parseSchemeItem(raw: string): SchemeItemInput | null {
  const body = raw.replace(/^\/?\s*addschemeitem\s+\S+\s*/i, "");
  const parts = body.split("|").map((p) => p.trim());
  if (parts.length < 6) return null;
  const [name, unitLabel, cost, price, units, max] = parts;
  const costNaira = Number(cost.replace(/,/g, ""));
  const priceNaira = Number(price.replace(/,/g, ""));
  const maxQty = Number(max.replace(/,/g, ""));
  if (!name || !Number.isFinite(costNaira) || !Number.isFinite(priceNaira)) return null;
  if (!Number.isFinite(maxQty) || maxQty < 1) return null;
  return {
    name,
    unitLabel: unitLabel || "unit",
    unitCostKobo: Math.round(costNaira * 100),
    memberPriceKobo: Math.round(priceNaira * 100),
    totalUnits: units === "-" || units === "" ? null : Number(units.replace(/,/g, "")),
    maxQtyPerMember: Math.floor(maxQty),
  };
}

export function parseNaira(raw: string): number | null {
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

export async function formatSchemesText(phone: string): Promise<string> {
  if (!commoditySchemesEnabled()) return COMMODITY_DISABLED;
  const member = await getMemberByPhone(phone);
  if (!member) return "Join a cooperative first.";
  const schemes = await prisma.commodityScheme.findMany({
    where: { cooperativeId: member.cooperativeId, status: "open" },
    include: { items: true },
    orderBy: { closesAt: "asc" },
  });
  if (schemes.length === 0) return "No commodity schemes are open right now.";
  const position = await getCommodityCreditPosition(phone);
  const lines = [
    `?? *Open commodity schemes*`,
    `Your credit: *${formatBalance(position?.availableKobo ?? 0)}*${position?.blockedReason ? ` - ${position.blockedReason}` : ""}`,
    ``,
  ];
  for (const scheme of schemes) {
    lines.push(
      `*${scheme.name}* (${scheme.reference}) - closes ${scheme.closesAt.toISOString().slice(0, 10)}`,
    );
    for (const item of scheme.items) {
      lines.push(
        ` ${item.name} (${item.unitLabel}): ${formatBalance(item.memberPriceKobo)} - max ${item.maxQtyPerMember}`,
      );
    }
    lines.push(` Reply: *subscribe ${scheme.reference} <item> <qty> 3*`);
    lines.push(``);
  }
  return lines.join("\n").trim();
}

export async function formatMySubsText(phone: string): Promise<string> {
  if (!commoditySchemesEnabled()) return COMMODITY_DISABLED;
  const member = await getMemberByPhone(phone);
  if (!member) return "Join a cooperative first.";
  const subs = await listMemberSubscriptions(member.id, member.cooperativeId);
  if (subs.length === 0)
    return "You have no commodity subscriptions. Reply *schemes* to see what is open.";
  const lines = ["?? *My commodity subscriptions*"];
  for (const sub of subs) {
    const state = sub.collectedAt
      ? "collected"
      : sub.dispatchedAt
        ? "ready for collection"
        : sub.status;
    lines.push(
      `*${sub.reference}* - ${sub.qty} x ${sub.item.name} (${sub.scheme.name})\n` +
        ` ${formatBalance(sub.totalKobo)} over ${sub.months} months - ${state}`,
    );
  }
  return lines.join("\n");
}

export async function formatSchemeSubsText(cooperativeId: string, ref: string): Promise<string> {
  if (!commoditySchemesEnabled()) return COMMODITY_DISABLED;
  const result = await listSchemeSubscriptions(cooperativeId, ref);
  if (!result) return "Scheme not found.";
  const { scheme, subs } = result;
  if (subs.length === 0) return `No subscriptions on *${scheme.reference}* yet.`;
  const total = subs.reduce((sum, s) => sum + s.totalKobo, 0);
  const lines = [
    `?? *${scheme.name}* (${scheme.reference}) - ${scheme.status}`,
    `${subs.length} subscription(s), ${formatBalance(total)}`,
    ``,
  ];
  for (const sub of subs) {
    lines.push(
      ` ${sub.member.name} (${sub.member.code}): ${sub.qty} x ${sub.item.name} - ${sub.status} - ${sub.reference}`,
    );
  }
  return lines.join("\n");
}
```

- [x] **Step 4: Wire member cases in `conversation.ts`**

Add imports near the other service imports:

```ts
import { formatMySubsText, formatSchemesText, COMMODITY_DISABLED } from "./commodity-commands.js";
import { cancelCommoditySubscription, subscribeCommodity } from "./commodity-schemes.js";
import { getCommodityCreditPosition } from "./commodity-credit.js";
```

Add cases before `default:` (next to the shop/guarantee cases):

```ts
    case "schemes": {
      await sendText({ to: phone, text: await formatSchemesText(phone) });
      break;
    }
    case "mysubs": {
      await sendText({ to: phone, text: await formatMySubsText(phone) });
      break;
    }
    case "credit": {
      const position = await getCommodityCreditPosition(phone);
      if (!position) {
        await sendText({ to: phone, text: "Join a cooperative first." });
        break;
      }
      await sendText({
        to: phone,
        text:
          `?? *Commodity credit*\n` +
          `Expected payroll deduction: ${formatBalance(position.expectedKobo)}\n` +
          `Cap (x${position.multiplier}): ${formatBalance(position.capKobo)}\n` +
          `Committed: ${formatBalance(position.committedKobo)}\n` +
          `Available: *${formatBalance(position.availableKobo)}*` +
          (position.blockedReason ? `\n?? ${position.blockedReason}` : ""),
      });
      break;
    }
    case "subscribe": {
      const [schemeRef, itemKey, qtyRaw, monthsRaw] = args;
      if (!schemeRef || !itemKey) {
        await sendText({ to: phone, text: "Usage: *subscribe <scheme> <item> <qty> [months 3-6]*" });
        break;
      }
      const result = await subscribeCommodity(
        phone,
        schemeRef,
        itemKey,
        Number(qtyRaw ?? 1),
        Number(monthsRaw ?? 3),
      );
      await sendText({ to: phone, text: result.message });
      break;
    }
    case "cancelsub": {
      if (!args[0]) {
        await sendText({ to: phone, text: "Usage: *cancelsub <reference>*" });
        break;
      }
      const result = await cancelCommoditySubscription(phone, args[0]);
      await sendText({ to: phone, text: result.message });
      break;
    }
```

Add `formatBalance` to the existing imports from `./cooperative.js` if it is not already in scope.

- [x] **Step 5: Wire admin cases in `admin.ts`**

Add imports:

```ts
import {
  addSchemeItem,
  closeScheme,
  collectCommodity,
  convertScheme,
  createScheme,
  dispatchCommodity,
  openScheme,
  purchaseScheme,
  rejectCommoditySubscription,
} from "./commodity-schemes.js";
import { formatSchemeSubsText, parseNaira, parseSchemeItem } from "./commodity-commands.js";
import { attributeShortfall } from "./deductions.js";
```

Add `"purchasescheme"` to `MONEY_OUT_COMMANDS`.

Add cases inside the admin switch:

```ts
      case "newscheme": {
        const body = raw.replace(/^\/?\s*newscheme\s+/i, "");
        const [name, season, opens, closes] = body.split("|").map((p) => p.trim());
        if (!name || !opens || !closes) {
          await sendText({ to: phone, text: "Usage: *newscheme <name> | <season> | <YYYY-MM-DD> | <YYYY-MM-DD>*" });
          break;
        }
        const result = await createScheme(phone, {
          name,
          season,
          opensAt: new Date(`${opens}T00:00:00Z`),
          closesAt: new Date(`${closes}T23:59:59Z`),
        });
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "addschemeitem": {
        const parsed = parseSchemeItem(raw);
        if (!parsed) {
          await sendText({ to: phone, text: "Usage: *addschemeitem <ref> | <name> | <unit> | <cost> | <price> | <units|-> | <max>*" });
          break;
        }
        const ref = raw.replace(/^\/?\s*addschemeitem\s+/i, "").split("|")[0].trim();
        const result = await addSchemeItem(phone, ref, parsed);
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "openscheme": {
        const result = await openScheme(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "closescheme": {
        const result = await closeScheme(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "schemesubs": {
        await sendText({ to: phone, text: await formatSchemeSubsText(coopId, args[0] ?? "") });
        break;
      }
      case "rejectsub": {
        const result = await rejectCommoditySubscription(phone, args[0] ?? "", args.slice(1).join(" "));
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "purchasescheme": {
        const body = raw.replace(/^\/?\s*purchasescheme\s+/i, "");
        const parts = body.split("|").map((p) => p.trim());
        const [ref, supplier, cost, funding, ...noteParts] = parts;
        const costKobo = parseNaira(cost ?? "");
        if (!ref || !supplier || !costKobo) {
          await sendText({ to: phone, text: "Usage: *purchasescheme <ref> | <supplier> | <cost> [| supplier_credit | <terms>]*" });
          break;
        }
        const result = await purchaseScheme(phone, ref, supplier, costKobo, {
          fundingSource: funding === "supplier_credit" ? "supplier_credit" : "cash",
          note: noteParts.join(" | ") || undefined,
        });
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "convertscheme": {
        const result = await convertScheme(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "dispatchsub": {
        const result = await dispatchCommodity(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "collectsub": {
        const result = await collectCommodity(phone, args[0] ?? "", args[1] ?? "");
        await sendText({ to: phone, text: result.message });
        break;
      }
      case "shortbatch": {
        const [ref, code, amountRaw] = args;
        const amount =
          amountRaw === "all" || amountRaw === "waive"
            ? amountRaw
            : parseNaira(amountRaw ?? "");
        if (!ref || !code || amount === null) {
          await sendText({ to: phone, text: "Usage: *shortbatch <ref> <member code|all> <amount|all|waive>*" });
          break;
        }
        const result = await attributeShortfall(phone, ref, code, amount);
        await sendText({ to: phone, text: result.message });
        break;
      }
```

If `raw` is not in scope in the admin switch, use the original text variable already available there (the shop cases use it as `raw`).

- [x] **Step 6: Add help-menu lines**

In `src/services/handlers/session.ts`, add to the member Money section:

```
` *credit* - check your commodity credit\n` +
` *schemes* / *subscribe* / *mysubs* / *cancelsub* - seasonal commodity schemes\n` +
```

and to the admin section:

```
` *newscheme* / *addschemeitem* / *openscheme* / *closescheme* - commodity schemes\n` +
` *schemesubs* / *rejectsub* / *purchasescheme* / *convertscheme* / *dispatchsub* / *collectsub*\n` +
` *shortbatch <ref> <code|all> <amount|all|waive>* - attribute payroll shortfall\n` +
```

- [x] **Step 7: Add the scheduler tick**

In `src/services/commodity-schemes.ts`, append:

```ts
export async function runSchemeWindows(now: Date = new Date()): Promise<number> {
  const expired = await prisma.commodityScheme.findMany({
    where: { status: "open", closesAt: { lt: now } },
    select: { id: true, reference: true, cooperativeId: true },
  });
  for (const scheme of expired) {
    await prisma.commodityScheme.update({ where: { id: scheme.id }, data: { status: "closed" } });
    await audit({
      cooperativeId: scheme.cooperativeId,
      actorPhone: "system",
      actorRole: "system",
      action: "commodity.scheme.closed",
      targetType: "commodityScheme",
      targetId: scheme.id,
      detail: `${scheme.reference}: window elapsed`,
    });
  }
  const openShortfalls = await prisma.deductionShortfall.findMany({
    where: { status: "open" },
    select: { cooperativeId: true, memberId: true, amount: true },
  });
  const byCoop = new Map<string, number>();
  for (const row of openShortfalls) {
    byCoop.set(row.cooperativeId, (byCoop.get(row.cooperativeId) ?? 0) + 1);
  }
  for (const [cooperativeId, count] of byCoop) {
    await notifySuperAdmins(
      cooperativeId,
      `?? ${count} member(s) have an open payroll shortfall. Review with *schemesubs* and *shortbatch*.`,
    ).catch(() => {});
  }
  return expired.length;
}
```

Add `import { notifySuperAdmins } from "./withdrawals.js";` to that file.

In `src/services/scheduler.ts`, add `runSchemeWindows` to the shop import group and call it after `runShopInstallments`:

```ts
await runSchemeWindows().catch((err) =>
  log.error("[scheduler] commodity scheme windows failed", { err: String(err) }),
);
```

- [x] **Step 8: Run tests and commit**

Run:

```powershell
npx vitest run tests/commodity-commands.test.ts tests/commodity-scheme.test.ts tests/shop.test.ts tests/conversation.test.ts
npm run lint
npx tsc --noEmit
```

Expected: all PASS, 0 lint errors, tsc clean.

```bash
git add src/services/commodity-commands.ts src/services/commodity-schemes.ts src/services/conversation.ts src/services/admin.ts src/services/handlers/session.ts src/services/scheduler.ts tests/commodity-commands.test.ts
git commit -m "feat: add WhatsApp commands for seasonal commodity schemes"
```

---

### Task 8: Full verification, docs, PR

**Files:**

- Modify: `README.md` (feature paragraph under the existing shop section)
- Modify: `docs/superpowers/specs/2026-10-31-commodity-credit-design.md` (status line only, if implementation deviates)
- No new source files.

- [x] **Step 1: Update the README feature list**

Add below the coop shop bullet:

```markdown
- **Commodity credit schemes** - seasonal bulk-purchase schemes (rice, oil, rams,
  appliances) funded from payroll-deduction credit. Members subscribe within a
  capped credit line; the co-op only purchases once reconciled bank cash covers
  the order, and installments are collected from payroll with per-member
  shortfall attribution and roll-forward.
```

- [x] **Step 2: Run the formatting and type gates**

```powershell
npx prettier --write "src/services/commodity-*.ts" "src/services/deductions.ts" "src/services/admin.ts" "src/services/conversation.ts" "src/services/handlers/session.ts" "src/services/scheduler.ts" "tests/commodity-*.ts" "tests/deduction-shortfall.test.ts"
npm run format:check
npm run lint
npx tsc --noEmit
```

Expected: formatting clean, 0 lint errors, tsc clean.

- [x] **Step 3: Run the focused suites**

```powershell
npx vitest run tests/commodity-credit.test.ts tests/commodity-schema.test.ts tests/commodity-scheme.test.ts tests/commodity-payroll.test.ts tests/commodity-commands.test.ts tests/deduction-shortfall.test.ts tests/deductions.test.ts tests/shop.test.ts tests/guarantor-phone.test.ts tests/dividend-payouts.test.ts tests/schema-sync.test.ts
```

Expected: all PASS.

- [x] **Step 4: Run the PostgreSQL RLS job locally**

```powershell
docker rm -f coop-commodity-final 2>$null
docker run -d --name coop-commodity-final -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=coop_test -p 55434:5432 postgres:16-alpine
Start-Sleep -Seconds 12
npm run prisma:generate
$env:DATABASE_URL="postgresql://test:test@localhost:55434/coop_test"
node scripts/db-migrate.mjs
$env:RLS_ENABLED="1"
npx vitest run tests/rls-isolation.test.ts
Remove-Item Env:DATABASE_URL; Remove-Item Env:RLS_ENABLED
docker rm -f coop-commodity-final
node scripts/prisma-generate.mjs --local
```

Expected: migrations apply from a clean database and 14 RLS tests pass.

- [x] **Step 5: Commit, push, open the PR**

```bash
git add README.md docs/superpowers/specs/2026-10-31-commodity-credit-design.md
git commit -m "docs: describe commodity credit schemes"
git push -u origin feat/commodity-credit
gh pr create --base main --title "feat: payroll-backed commodity credit schemes" --body "Implements docs/superpowers/specs/2026-10-31-commodity-credit-design.md.

## What
- Seasonal commodity schemes with member subscriptions capped by uploaded payroll schedules
- Bank-cash gate before any supplier purchase; audited supplier-credit override
- Conversion to Loan(kind=commodity) with payroll installment collection
- Per-member shortfall attribution, priority allocation (loan -> commodity -> savings) and roll-forward
- Fixes buildBatch so shop loans are no longer collected twice

## Verification
- tsc, lint, prettier
- commodity + deductions + shop + schema suites
- PostgreSQL migrations + RLS job replicated locally"
```

Expected: PR created; CI (type-check, unit, security, dependency audit, Postgres/RLS, build) green.

- [x] **Step 6: Report**

Summarize: tasks completed, test counts, CI status, and the one behavioral change (short batches now settle instead of blocking).

---

## Self-Review

**1. Spec coverage**

| Spec section                 | Task       |
| ---------------------------- | ---------- |
| Data model + RLS             | 1          |
| Credit position              | 2          |
| Lifecycle + cash gate        | 3, 4       |
| Payroll collection           | 5          |
| Reconciliation/priority/roll | 6          |
| Commands + permissions       | 7          |
| Notifications                | 3, 4, 6, 7 |
| Rollout env gating           | 2, 7       |
| Testing/verification         | 1-8        |

Gaps fixed during review: scheme cancellation (`schemes cancel` is covered by `cancelsub` + `closescheme`; a whole-scheme `cancelscheme` is intentionally out of scope and handled by `closescheme` + `rejectsub`); collection receipt is a plain notification, not a PDF (consistent with the spec's non-goals).

**2. Placeholder scan**

No "TBD"/"TODO"/"similar to Task N" remain. Two spots deliberately instruct the implementer to copy an exact shape from an existing test (`posting.create` nesting) rather than guessing it — that is a real instruction, not a placeholder.

**3. Type consistency**

- `SchemeResult` used identically in Tasks 3-4.
- `attributeShortfall` returns `{ ok, message }`, matching how admin cases consume it.
- `rollForwardItem` returns the created `DeductionItem`; Task 6's test reads `batchId` and `amount`.
- `priorityRank` order matches the spec (loan 0, commodity 1, savings 2).
- `getCreditPositionForMember` signature matches Tasks 2, 3, 7.
