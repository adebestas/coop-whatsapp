# Federation / Inter-coop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let cooperatives form a federation to pool liquidity and lend to each other across currencies, governed by a dedicated federation admin.

**Architecture:** The federation is a ledger-holding entity with its own **platform-level** double-entry ledger (no `cooperativeId`, no RLS). Every money move is coop↔federation, so one transaction under the coop's RLS GUC writes both the coop's `JournalEntry`/`Posting` and the federation's `FederationLedgerEntry`/`FederationPosting` atomically. Bilateral inter-coop loans are brokered (the lender's funds are earmarked in the pool). FX rates are admin-maintained and captured into each loan/repayment.

**Tech Stack:** TypeScript, Fastify, Prisma (Postgres + SQLite mirror), Vitest, the existing double-entry journal (`src/services/journal.ts`) and audit chain (`src/services/audit.ts`).

**Spec:** `docs/superpowers/specs/2026-10-15-federation-design.md`

## Global Constraints

- **Both schemas identical:** every schema change goes in `prisma/schema.prisma` AND `prisma/schema.local.prisma` (enforced by `tests/schema-sync.test.ts`).
- **Money:** integer minor units (kobo) everywhere; display via `formatBalance`.
- **Tenancy:** coop-side writes go through `withCoopContext`; the federation ledger is platform-level (no RLS).
- **Audit:** every federation money move calls `audit()`.
- **FX:** fail closed — a cross-currency move with no rate throws.
- **Verification gate:** `npm run typecheck` clean · `npm run lint` 0 errors · full suite green · schema-sync green.
- **Test speed:** full `npx vitest run` takes ~19 min; run targeted files during iteration.
- **Commit policy:** do NOT commit unless the user explicitly asks. Commit steps below are intended checkpoints.
- **Local DB is SQLite** (`file:./dev.db`): migrations are hand-written Postgres SQL; local sync via `npx prisma db push --schema prisma/schema.local.prisma`.

---

### Task 1: Schema — federation models

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261049000000_federation/migration.sql`
- Test: `tests/schema-sync.test.ts` (existing)

**Interfaces:**
- Produces: Prisma models `Federation`, `FederationMembership`, `FederationLedgerEntry`, `FederationPosting`, `FederationLoan`, `FederationLoanRepayment`, `FxRate`.

- [ ] **Step 1: Add the models to BOTH schemas**

Append the seven models from spec §5 verbatim to `prisma/schema.prisma` and `prisma/schema.local.prisma` (identical text; only the datasource provider differs between files).

Also add a coop-level fund to `model Cooperative` (both schemas), next to `protectionFundBalance`:

```prisma
  federationFundBalance Int @default(0) // coop's own funds committed to a federation pool, in kobo
```

This is the coop's federation position (contribute decrements it, borrow increments it, repay decrements it) — the platform has no "coop wallet"; money lives in member wallets and coop-level funds.

- [ ] **Step 2: Hand-write the Postgres migration**

Create `prisma/migrations/20261049000000_federation/migration.sql` with `CREATE TABLE` statements for all seven tables (mirroring the Prisma models: `TEXT` for String, `INTEGER` for Int, `DOUBLE PRECISION` for Float, `TIMESTAMP(3)` for DateTime, `BOOLEAN` for Boolean), the unique indexes (`Federation.code`, `FederationLedgerEntry.txRef`, `FederationMembership(federationId, cooperativeId)`), the FK constraints, and the `@@index`es. Follow the style of `prisma/migrations/20261047000000_cubecover_insurance/migration.sql`.

- [ ] **Step 3: Sync the local SQLite DB + regenerate the client**

Run: `npx prisma db push --schema prisma/schema.local.prisma`
Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 4: Run the schema-sync test**

Run: `npx vitest run tests/schema-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations
git commit -m "feat(federation): add federation schema"
```

---

### Task 2: FX service

**Files:**
- Create: `src/services/federation/fx.ts`
- Test: `tests/federation-fx.test.ts`

**Interfaces:**
- Produces: `setRate(federationId, baseCurrency, quoteCurrency, rate, setBy): Promise<void>`; `getRate(federationId, from, to): Promise<number>` (throws `NO_FX_RATE` when none).

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-fx.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { setRate, getRate } from "../src/services/federation/fx.js";

async function makeFed() {
  return prisma.federation.create({
    data: { name: "West Africa Fed", code: `FED${Date.now()}`, baseCurrency: "NGN" },
  });
}

describe("federation FX", () => {
  it("returns 1 for the same currency", async () => {
    const fed = await makeFed();
    expect(await getRate(fed.id, "NGN", "NGN")).toBe(1);
  });

  it("returns the latest effective rate", async () => {
    const fed = await makeFed();
    await setRate(fed.id, "NGN", "GHS", 0.008, "admin");
    await setRate(fed.id, "NGN", "GHS", 0.009, "admin");
    expect(await getRate(fed.id, "NGN", "GHS")).toBeCloseTo(0.009);
  });

  it("inverts a stored rate when only the reverse exists", async () => {
    const fed = await makeFed();
    await setRate(fed.id, "NGN", "GHS", 0.008, "admin");
    expect(await getRate(fed.id, "GHS", "NGN")).toBeCloseTo(125);
  });

  it("fails closed when no rate exists", async () => {
    const fed = await makeFed();
    await expect(getRate(fed.id, "NGN", "KES")).rejects.toThrow("NO_FX_RATE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-fx.test.ts`
Expected: FAIL — cannot find module `../src/services/federation/fx.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/federation/fx.ts
import { prisma } from "../../lib/prisma.js";

export async function setRate(
  federationId: string,
  baseCurrency: string,
  quoteCurrency: string,
  rate: number,
  setBy: string,
): Promise<void> {
  if (!(rate > 0)) throw new Error("INVALID_FX_RATE");
  await prisma.fxRate.create({
    data: { federationId, baseCurrency, quoteCurrency, rate, setBy },
  });
}

export async function getRate(
  federationId: string,
  from: string,
  to: string,
): Promise<number> {
  if (from === to) return 1;
  const direct = await prisma.fxRate.findFirst({
    where: { federationId, baseCurrency: from, quoteCurrency: to },
    orderBy: { effectiveAt: "desc" },
  });
  if (direct) return direct.rate;
  const inverse = await prisma.fxRate.findFirst({
    where: { federationId, baseCurrency: to, quoteCurrency: from },
    orderBy: { effectiveAt: "desc" },
  });
  if (inverse && inverse.rate > 0) return 1 / inverse.rate;
  throw new Error("NO_FX_RATE");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-fx.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/federation/fx.ts tests/federation-fx.test.ts
git commit -m "feat(federation): add FX rate service"
```

---

### Task 3: Federation ledger

**Files:**
- Create: `src/services/federation/ledger.ts`
- Test: `tests/federation-ledger.test.ts`

**Interfaces:**
- Consumes: `roundMoney` (`src/services/money.js`).
- Produces: `FederationPostingInput`; `postFederationJournal(opts, client?): Promise<{ posted: boolean; reason?: "unbalanced" | "duplicate" }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-ledger.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { postFederationJournal } from "../src/services/federation/ledger.js";

async function makeFed() {
  return prisma.federation.create({
    data: { name: "Fed", code: `FED${Date.now()}`, baseCurrency: "NGN" },
  });
}

describe("federation ledger", () => {
  it("posts a balanced entry", async () => {
    const fed = await makeFed();
    const r = await postFederationJournal({
      federationId: fed.id,
      txRef: `FJ-${Date.now()}`,
      description: "test",
      currency: "NGN",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 1000 },
        { account: "coop:x:payable", direction: "CREDIT", amount: 1000 },
      ],
    });
    expect(r.posted).toBe(true);
    expect(await prisma.federationLedgerEntry.count({ where: { federationId: fed.id } })).toBe(1);
  });

  it("rejects an unbalanced entry", async () => {
    const fed = await makeFed();
    const r = await postFederationJournal({
      federationId: fed.id,
      txRef: `FJ-${Date.now()}`,
      description: "bad",
      currency: "NGN",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 1000 },
        { account: "coop:x:payable", direction: "CREDIT", amount: 900 },
      ],
    });
    expect(r.posted).toBe(false);
    expect(r.reason).toBe("unbalanced");
  });

  it("is idempotent on txRef", async () => {
    const fed = await makeFed();
    const ref = `FJ-${Date.now()}`;
    const opts = {
      federationId: fed.id,
      txRef: ref,
      description: "dup",
      currency: "NGN",
      postings: [
        { account: "assets:bank", direction: "DEBIT" as const, amount: 500 },
        { account: "coop:x:payable", direction: "CREDIT" as const, amount: 500 },
      ],
    };
    expect((await postFederationJournal(opts)).posted).toBe(true);
    expect((await postFederationJournal(opts)).reason).toBe("duplicate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-ledger.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/federation/ledger.ts
import { prisma } from "../../lib/prisma.js";
import { roundMoney } from "../money.js";

export interface FederationPostingInput {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amount: number;
  cooperativeId?: string | null;
}

export async function postFederationJournal(
  opts: {
    federationId: string;
    txRef: string;
    description: string;
    currency: string;
    postings: FederationPostingInput[];
  },
  client: Pick<typeof prisma, "federationLedgerEntry"> = prisma,
): Promise<{ posted: boolean; reason?: "unbalanced" | "duplicate" }> {
  const postings = opts.postings.map((p) => ({ ...p, amount: roundMoney(p.amount) }));
  if (postings.length < 2) return { posted: false, reason: "unbalanced" };
  const totals = postings.reduce(
    (a, p) => (p.direction === "DEBIT" ? { ...a, d: roundMoney(a.d + p.amount) } : { ...a, c: roundMoney(a.c + p.amount) }),
    { d: 0, c: 0 },
  );
  if (totals.d !== totals.c || totals.d <= 0) return { posted: false, reason: "unbalanced" };
  try {
    await client.federationLedgerEntry.create({
      data: {
        federationId: opts.federationId,
        txRef: opts.txRef,
        description: opts.description,
        currency: opts.currency,
        postings: {
          create: postings.map((p) => ({
            account: p.account,
            direction: p.direction,
            amount: p.amount,
            cooperativeId: p.cooperativeId ?? null,
          })),
        },
      },
    });
    return { posted: true };
  } catch (err: any) {
    if (err?.code === "P2002") return { posted: false, reason: "duplicate" };
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-ledger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/federation/ledger.ts tests/federation-ledger.test.ts
git commit -m "feat(federation): add federation double-entry ledger"
```

---

### Task 4: Federation service — create + membership

**Files:**
- Create: `src/services/federation/index.ts`
- Test: `tests/federation-membership.test.ts`

**Interfaces:**
- Consumes: `prisma`, `audit` (`src/services/audit.js`).
- Produces: `createFederation(name, code, baseCurrency): Promise<Federation>`; `addMember(federationId, cooperativeId): Promise<FederationMembership>`; `removeMember(federationId, cooperativeId): Promise<void>`; `listFederationsForCoop(cooperativeId): Promise<Federation[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-membership.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  createFederation,
  addMember,
  removeMember,
  listFederationsForCoop,
} from "../src/services/federation/index.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Coop ${code}`, code, currency: "NGN" } });
}

describe("federation membership", () => {
  it("creates a federation and adds/removes members", async () => {
    const fed = await createFederation("West Africa Fed", `FED${Date.now()}`, "NGN");
    const coop = await makeCoop(`C${Date.now()}`);
    await addMember(fed.id, coop.id);
    expect((await listFederationsForCoop(coop.id)).map((f) => f.id)).toContain(fed.id);
    await removeMember(fed.id, coop.id);
    expect((await listFederationsForCoop(coop.id)).map((f) => f.id)).not.toContain(fed.id);
  });

  it("is idempotent on addMember", async () => {
    const fed = await createFederation("Fed", `FED${Date.now()}`, "NGN");
    const coop = await makeCoop(`C${Date.now()}`);
    await addMember(fed.id, coop.id);
    await addMember(fed.id, coop.id);
    expect(await prisma.federationMembership.count({ where: { federationId: fed.id } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-membership.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/federation/index.ts
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit.js";

export async function createFederation(name: string, code: string, baseCurrency: string) {
  return prisma.federation.create({ data: { name, code, baseCurrency } });
}

export async function addMember(federationId: string, cooperativeId: string) {
  const existing = await prisma.federationMembership.findUnique({
    where: { federationId_cooperativeId: { federationId, cooperativeId } },
  });
  if (existing) return existing;
  const m = await prisma.federationMembership.create({
    data: { federationId, cooperativeId, status: "active" },
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.member.add",
    targetType: "federation",
    targetId: federationId,
    detail: `coop ${cooperativeId} joined federation ${federationId}`,
  });
  return m;
}

export async function removeMember(federationId: string, cooperativeId: string): Promise<void> {
  await prisma.federationMembership.deleteMany({ where: { federationId, cooperativeId } });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.member.remove",
    targetType: "federation",
    targetId: federationId,
    detail: `coop ${cooperativeId} left federation ${federationId}`,
  });
}

export async function listFederationsForCoop(cooperativeId: string) {
  const memberships = await prisma.federationMembership.findMany({
    where: { cooperativeId, status: "active" },
    include: { federation: true },
  });
  return memberships.map((m) => m.federation);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-membership.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/federation/index.ts tests/federation-membership.test.ts
git commit -m "feat(federation): create federation + membership"
```

---

### Task 5: Pool contribute / borrow / repay

**Files:**
- Modify: `src/services/federation/index.ts`
- Test: `tests/federation-pool.test.ts`

**Interfaces:**
- Consumes: `withCoopContext` (`src/lib/tenant-context.js`), `postJournal` (`src/services/journal.js`), `postFederationJournal` (Task 3), `getRate` (Task 2), `getCoopMeta` (tenant-context).
- Produces: `contribute(federationId, cooperativeId, amountKobo): Promise<void>`; `borrow(federationId, cooperativeId, amountKobo, termMonths, lenderCooperativeId?): Promise<FederationLoan>`; `repay(loanId, amountKobo): Promise<void>`; `getPosition(federationId, cooperativeId): Promise<{ stakeKobo: number; owedKobo: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-pool.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createFederation, addMember, contribute, borrow, repay, getPosition } from "../src/services/federation/index.js";

async function setup(fund = 10_000_000) {
  const fed = await createFederation("Fed", `FED${Date.now()}`, "NGN");
  const coop = await prisma.cooperative.create({
    data: { name: "Coop", code: `C${Date.now()}`, currency: "NGN", federationFundBalance: fund },
  });
  await addMember(fed.id, coop.id);
  return { fed, coop };
}

describe("federation pool", () => {
  it("contributes from the coop fund into the pool", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const updated = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updated?.federationFundBalance).toBe(9_000_000);
    const pos = await getPosition(fed.id, coop.id);
    expect(pos.stakeKobo).toBe(1_000_000);
  });

  it("borrows from the pool and repays", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
    expect(loan.status).toBe("active");
    await repay(loan.id, 500_000);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("repaid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-pool.test.ts`
Expected: FAIL — `contribute` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/federation/index.ts`:

```ts
import { withCoopContext, getCoopMeta } from "../../lib/tenant-context.js";
import { postJournal } from "../journal.js";
import { postFederationJournal } from "./ledger.js";
import { getRate } from "./fx.js";

export async function contribute(federationId: string, cooperativeId: string, amountKobo: number): Promise<void> {
  const { currency } = await getCoopMeta(cooperativeId);
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: federationId } });
  const rate = await getRate(federationId, currency, fed.baseCurrency);
  const baseAmount = Math.round(amountKobo * rate);
  const ref = `FED-CONTRIB-${federationId}-${cooperativeId}-${Date.now()}`;

  await withCoopContext(cooperativeId, async () => {
    const claimed = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, federationFundBalance: { gte: amountKobo } },
      data: { federationFundBalance: { decrement: amountKobo } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    await postJournal({
      cooperativeId,
      txRef: ref,
      description: `Federation pool contribution`,
      postings: [
        { account: "federation:receivable", direction: "DEBIT", amount: amountKobo },
        { account: "coop:federation_fund", direction: "CREDIT", amount: amountKobo },
      ],
    });
    await postFederationJournal({
      federationId,
      txRef: ref,
      description: `Pool contribution from coop ${cooperativeId}`,
      currency: fed.baseCurrency,
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: baseAmount },
        { account: `coop:${cooperativeId}:payable`, direction: "CREDIT", amount: baseAmount, cooperativeId },
      ],
    });
  });
  await audit({ cooperativeId, actorPhone: "system", action: "federation.contribute", targetType: "federation", targetId: federationId, amount: amountKobo, detail: `contributed ${amountKobo} ${currency}` });
}

export async function borrow(federationId: string, cooperativeId: string, amountKobo: number, termMonths: number, lenderCooperativeId?: string) {
  const { currency } = await getCoopMeta(cooperativeId);
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: federationId } });
  const rate = await getRate(federationId, currency, fed.baseCurrency);
  const baseAmount = Math.round(amountKobo * rate);
  const dueAt = new Date(Date.now() + termMonths * 30 * 24 * 60 * 60 * 1000);
  const loan = await prisma.federationLoan.create({
    data: { federationId, lenderCooperativeId: lenderCooperativeId ?? null, borrowerCooperativeId: cooperativeId, principalKobo: amountKobo, currency, fxRateToBase: rate, interestRate: 0.12, termMonths, status: "active", disbursedAt: new Date(), dueAt },
  });
  const ref = `FED-LOAN-${loan.id}`;
  await withCoopContext(cooperativeId, async () => {
    await prisma.cooperative.update({
      where: { id: cooperativeId },
      data: { federationFundBalance: { increment: amountKobo } },
    });
    await postJournal({
      cooperativeId,
      txRef: ref,
      description: `Federation loan disbursement`,
      postings: [
        { account: "coop:federation_fund", direction: "DEBIT", amount: amountKobo },
        { account: "federation:payable", direction: "CREDIT", amount: amountKobo },
      ],
    });
    await postFederationJournal({
      federationId,
      txRef: ref,
      description: `Loan to coop ${cooperativeId}`,
      currency: fed.baseCurrency,
      postings: [
        { account: `coop:${cooperativeId}:receivable`, direction: "DEBIT", amount: baseAmount, cooperativeId },
        { account: "assets:bank", direction: "CREDIT", amount: baseAmount },
      ],
    });
  });
  await audit({ cooperativeId, actorPhone: "system", action: "federation.borrow", targetType: "federation_loan", targetId: loan.id, amount: amountKobo, detail: `borrowed ${amountKobo} ${currency} for ${termMonths}m` });
  return loan;
}

export async function repay(loanId: string, amountKobo: number): Promise<void> {
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  const cooperativeId = loan.borrowerCooperativeId;
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: loan.federationId } });
  const baseAmount = Math.round(amountKobo * loan.fxRateToBase);
  const ref = `FED-REPAY-${loanId}-${Date.now()}`;
  await withCoopContext(cooperativeId, async () => {
    const claimed = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, federationFundBalance: { gte: amountKobo } },
      data: { federationFundBalance: { decrement: amountKobo } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    await postJournal({
      cooperativeId,
      txRef: ref,
      description: `Federation loan repayment`,
      postings: [
        { account: "federation:payable", direction: "DEBIT", amount: amountKobo },
        { account: "coop:federation_fund", direction: "CREDIT", amount: amountKobo },
      ],
    });
    await postFederationJournal({
      federationId: loan.federationId,
      txRef: ref,
      description: `Repayment from coop ${cooperativeId}`,
      currency: fed.baseCurrency,
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: baseAmount },
        { account: `coop:${cooperativeId}:receivable`, direction: "CREDIT", amount: baseAmount, cooperativeId },
      ],
    });
  });
  const repaid = loan.repaidKobo + amountKobo;
  await prisma.federationLoan.update({
    where: { id: loanId },
    data: { repaidKobo: repaid, status: repaid >= loan.principalKobo ? "repaid" : "active" },
  });
  await prisma.federationLoanRepayment.create({
    data: { loanId, amountKobo, currency: loan.currency, fxRateToBase: loan.fxRateToBase },
  });
  await audit({ cooperativeId, actorPhone: "system", action: "federation.repay", targetType: "federation_loan", targetId: loanId, amount: amountKobo, detail: `repaid ${amountKobo} ${loan.currency}` });
}

export async function getPosition(federationId: string, cooperativeId: string) {
  const entries = await prisma.federationPosting.findMany({
    where: { cooperativeId, entry: { federationId } },
  });
  let stakeKobo = 0;
  let owedKobo = 0;
  for (const p of entries) {
    const signed = p.direction === "DEBIT" ? p.amount : -p.amount;
    if (p.account.endsWith(":payable")) stakeKobo += signed;
    if (p.account.endsWith(":receivable")) owedKobo += signed;
  }
  return { stakeKobo, owedKobo };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-pool.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/federation/index.ts tests/federation-pool.test.ts
git commit -m "feat(federation): pool contribute/borrow/repay"
```

---

### Task 6: Bilateral inter-coop loans + default

**Files:**
- Modify: `src/services/federation/index.ts`
- Test: `tests/federation-loan.test.ts`

**Interfaces:**
- Produces: `markDefaulted(loanId): Promise<void>`; `approveLoan(loanId): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-loan.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createFederation, addMember, contribute, borrow, markDefaulted } from "../src/services/federation/index.js";

async function setup() {
  const fed = await createFederation("Fed", `FED${Date.now()}`, "NGN");
  const lender = await prisma.cooperative.create({ data: { name: "Lender", code: `L${Date.now()}`, currency: "NGN", federationFundBalance: 10_000_000 } });
  const borrower = await prisma.cooperative.create({ data: { name: "Borrower", code: `B${Date.now()}`, currency: "NGN" } });
  await addMember(fed.id, lender.id);
  await addMember(fed.id, borrower.id);
  return { fed, lender, borrower };
}

describe("bilateral federation loan", () => {
  it("records the lender and can be marked defaulted", async () => {
    const { fed, lender, borrower } = await setup();
    await contribute(fed.id, lender.id, 1_000_000);
    const loan = await borrow(fed.id, borrower.id, 500_000, 3, lender.id);
    expect(loan.lenderCooperativeId).toBe(lender.id);
    await markDefaulted(loan.id);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("defaulted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-loan.test.ts`
Expected: FAIL — `markDefaulted` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/federation/index.ts`:

```ts
export async function approveLoan(loanId: string): Promise<void> {
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  if (loan.status !== "pending") return;
  await prisma.federationLoan.update({ where: { id: loanId }, data: { status: "active", disbursedAt: new Date() } });
  await audit({ cooperativeId: loan.borrowerCooperativeId, actorPhone: "system", action: "federation.loan.approve", targetType: "federation_loan", targetId: loanId, detail: "loan approved" });
}

export async function markDefaulted(loanId: string): Promise<void> {
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  await prisma.federationLoan.update({ where: { id: loanId }, data: { status: "defaulted" } });
  await audit({ cooperativeId: loan.borrowerCooperativeId, actorPhone: "system", action: "federation.loan.default", targetType: "federation_loan", targetId: loanId, detail: "loan marked defaulted (manual remedy)" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-loan.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/federation/index.ts tests/federation-loan.test.ts
git commit -m "feat(federation): bilateral loans + manual default"
```

---

### Task 7: Federation-admin commands

**Files:**
- Modify: `src/services/admin.ts` (add a `federation` command branch)
- Test: `tests/federation-admin.test.ts`

**Interfaces:**
- Consumes: the federation service (Tasks 4-6), `handleAdminCommand` (existing).

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-admin.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleAdminCommand } from "../src/services/admin.js";
// Mirror the admin-command harness in tests/savings-products.test.ts.

describe("federation admin commands", () => {
  it("creates a federation and adds a coop", async () => {
    // create a super admin + coop, send "federation create WestAfrica NGN",
    // then "federation addcoop <code>", assert the membership exists.
  });
  it("sets an FX rate", async () => {
    // send "federation rate NGN GHS 0.008", assert an FxRate row exists.
  });
});
```

(Fill the bodies using the existing admin test harness — mirror `tests/savings-products.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-admin.test.ts`
Expected: FAIL — `federation` is an unknown command.

- [ ] **Step 3: Write minimal implementation**

In `src/services/admin.ts`, add a `case "federation":` to the admin command switch (near the other admin commands). Parse `args[0]` as the subcommand:

```ts
case "federation": {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "create") {
    const [name, baseCurrency] = [args[1], (args[2] ?? "NGN").toUpperCase()];
    if (!name) { await sendText({ to: phone, text: "Usage: *federation create <name> <baseCurrency>*" }); return true; }
    const fed = await createFederation(name, `FED${Date.now()}`, baseCurrency);
    await sendText({ to: phone, text: `✅ Federation *${fed.name}* created (${fed.baseCurrency}).` });
    return true;
  }
  if (sub === "addcoop") {
    const code = args[1];
    const coop = code ? await prisma.cooperative.findUnique({ where: { code } }) : null;
    if (!coop) { await sendText({ to: phone, text: "Usage: *federation addcoop <coop code>*" }); return true; }
    const fed = await prisma.federation.findFirst({ orderBy: { createdAt: "desc" } });
    if (!fed) { await sendText({ to: phone, text: "No federation exists yet." }); return true; }
    await addMember(fed.id, coop.id);
    await sendText({ to: phone, text: `✅ *${coop.name}* added to *${fed.name}*.` });
    return true;
  }
  if (sub === "rate") {
    const [from, to, rateStr] = [args[1]?.toUpperCase(), args[2]?.toUpperCase(), args[3]];
    const rate = Number(rateStr);
    if (!from || !to || !Number.isFinite(rate) || rate <= 0) { await sendText({ to: phone, text: "Usage: *federation rate <from> <to> <rate>*" }); return true; }
    const fed = await prisma.federation.findFirst({ orderBy: { createdAt: "desc" } });
    if (!fed) { await sendText({ to: phone, text: "No federation exists yet." }); return true; }
    await setRate(fed.id, from, to, rate, phone);
    await sendText({ to: phone, text: `✅ Rate set: 1 ${from} = ${rate} ${to}.` });
    return true;
  }
  if (sub === "loans") {
    const fed = await prisma.federation.findFirst({ orderBy: { createdAt: "desc" } });
    const loans = fed ? await prisma.federationLoan.findMany({ where: { federationId: fed.id }, orderBy: { createdAt: "desc" }, take: 20 }) : [];
    const lines = loans.map((l) => `• *${l.id.slice(0, 8)}* — ${formatBalance(l.principalKobo, l.currency)} ${l.status}`);
    await sendText({ to: phone, text: lines.length ? `*Federation loans*\n\n${lines.join("\n")}` : "No federation loans." });
    return true;
  }
  if (sub === "approveloan") {
    const id = args[1];
    if (!id) { await sendText({ to: phone, text: "Usage: *federation approveloan <id>*" }); return true; }
    await approveLoan(id);
    await sendText({ to: phone, text: `✅ Loan *${id}* approved.` });
    return true;
  }
  if (sub === "default") {
    const id = args[1];
    if (!id) { await sendText({ to: phone, text: "Usage: *federation default <id>*" }); return true; }
    await markDefaulted(id);
    await sendText({ to: phone, text: `Loan *${id}* marked defaulted.` });
    return true;
  }
  await sendText({ to: phone, text: "Usage: *federation create|addcoop|rate|loans|approveloan|default*" });
  return true;
}
```

Add imports to `admin.ts`: `createFederation`, `addMember`, `approveLoan`, `markDefaulted` from `./federation/index.js`; `setRate` from `./federation/fx.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/admin.ts tests/federation-admin.test.ts
git commit -m "feat(federation): federation-admin commands"
```

---

### Task 8: Coop-admin commands

**Files:**
- Modify: `src/services/conversation.ts` (add a `federation` command branch)
- Test: `tests/federation-coop.test.ts`

**Interfaces:**
- Consumes: the federation service (Tasks 4-6).

- [ ] **Step 1: Write the failing test**

```ts
// tests/federation-coop.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
// Mirror the conversation harness in tests/conversation.test.ts.

describe("coop federation commands", () => {
  it("lets a coop admin contribute to the pool", async () => {
    // create a federation + member coop with a funded wallet, send
    // "federation contribute 1000", assert the wallet decreased.
  });
  it("shows the coop's federation position", async () => {
    // send "federation position", assert the reply mentions the stake.
  });
});
```

(Fill the bodies using the existing conversation test harness — mirror `tests/conversation.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/federation-coop.test.ts`
Expected: FAIL — `federation` is an unknown command.

- [ ] **Step 3: Write minimal implementation**

In `src/services/conversation.ts`, add a `federation` command check (near the other member/admin commands, after `member` is resolved). Only a coop admin may run it:

```ts
if (member && /^federation\b/i.test(text.trim())) {
  const parts = text.trim().split(/\s+/);
  const sub = (parts[1] ?? "").toLowerCase();
  const feds = await listFederationsForCoop(member.cooperativeId);
  if (!feds.length) { await sendText({ to: phone, text: "Your cooperative is not in a federation." }); return; }
  const fed = feds[0];
  if (sub === "position") {
    const pos = await getPosition(fed.id, member.cooperativeId);
    await sendText({ to: phone, text: `*${fed.name}* position\n\nPool stake: *${formatBalance(pos.stakeKobo)}*\nOwed to federation: *${formatBalance(pos.owedKobo)}*` });
    return;
  }
  if (member.role !== "admin" && member.role !== "superadmin") {
    await sendText({ to: phone, text: "Only a coop admin can manage federation funds." });
    return;
  }
  if (sub === "contribute") {
    const amount = toKobo(Number(parts[2]));
    if (!(amount > 0)) { await sendText({ to: phone, text: "Usage: *federation contribute <amount>*" }); return; }
    try {
      await contribute(fed.id, member.cooperativeId, amount);
      await sendText({ to: phone, text: `✅ Contributed *${formatBalance(amount)}* to *${fed.name}*.` });
    } catch (err: any) {
      await sendText({ to: phone, text: err?.message === "INSUFFICIENT_BALANCE" ? "Insufficient wallet balance." : "Could not contribute right now." });
    }
    return;
  }
  if (sub === "borrow") {
    const amount = toKobo(Number(parts[2]));
    const months = Number(parts[3]);
    if (!(amount > 0) || !(months > 0)) { await sendText({ to: phone, text: "Usage: *federation borrow <amount> <months>*" }); return; }
    const loan = await borrow(fed.id, member.cooperativeId, amount, months);
    await sendText({ to: phone, text: `✅ Borrowed *${formatBalance(amount)}* for ${months} months. Loan *${loan.id.slice(0, 8)}*.` });
    return;
  }
  await sendText({ to: phone, text: "Usage: *federation position|contribute <amount>|borrow <amount> <months>*" });
  return;
}
```

Add imports to `conversation.ts`: `listFederationsForCoop`, `getPosition`, `contribute`, `borrow` from `./federation/index.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/federation-coop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/conversation.ts tests/federation-coop.test.ts
git commit -m "feat(federation): coop-admin commands"
```

---

### Task 9: Isolation test + integration

**Files:**
- Test: `tests/federation-isolation.test.ts` (new)

- [ ] **Step 1: Write the isolation test**

```ts
// tests/federation-isolation.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createFederation, addMember, listFederationsForCoop } from "../src/services/federation/index.js";

describe("federation isolation", () => {
  it("a coop only sees federations it belongs to", async () => {
    const fedA = await createFederation("Fed A", `FA${Date.now()}`, "NGN");
    const fedB = await createFederation("Fed B", `FB${Date.now()}`, "NGN");
    const coop = await prisma.cooperative.create({ data: { name: "Coop", code: `C${Date.now()}`, currency: "NGN" } });
    await addMember(fedA.id, coop.id);
    const feds = await listFederationsForCoop(coop.id);
    expect(feds.map((f) => f.id)).toContain(fedA.id);
    expect(feds.map((f) => f.id)).not.toContain(fedB.id);
  });
});
```

- [ ] **Step 2: Run the isolation test**

Run: `npx vitest run tests/federation-isolation.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the verification gate**

Run: `npx tsc --noEmit` → 0 errors.
Run: `npx eslint src/` → 0 errors.
Run: `npx vitest run tests/federation-fx.test.ts tests/federation-ledger.test.ts tests/federation-membership.test.ts tests/federation-pool.test.ts tests/federation-loan.test.ts tests/federation-admin.test.ts tests/federation-coop.test.ts tests/federation-isolation.test.ts tests/schema-sync.test.ts` → all PASS.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run --reporter=dot`
Expected: green. Takes ~19 min.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add tests/federation-isolation.test.ts
git commit -m "test(federation): isolation + integration"
```

---

## Self-Review

**Spec coverage:** §5 data model → Task 1. §6 money flows → Tasks 3, 5, 6. §7 FX → Task 2. §8 governance/commands → Tasks 7, 8. §9 RLS/security → Tasks 4, 9. §11 tests → each task + Task 9.

**Placeholder scan:** Tasks 7 and 8 Step 1 test bodies are described (not fully coded) because they depend on the existing admin/conversation test harnesses; the implementer must mirror `tests/savings-products.test.ts` and `tests/conversation.test.ts`. All other steps carry real code.

**Type consistency:** `postFederationJournal(opts, client?)`, `getRate(federationId, from, to)`, `setRate(federationId, base, quote, rate, setBy)`, `createFederation(name, code, baseCurrency)`, `addMember(federationId, cooperativeId)`, `contribute(federationId, cooperativeId, amountKobo)`, `borrow(federationId, cooperativeId, amountKobo, termMonths, lenderCooperativeId?)`, `repay(loanId, amountKobo)`, `getPosition(federationId, cooperativeId)`, `approveLoan(loanId)`, `markDefaulted(loanId)` are used consistently across tasks.
