# Annual Registrar Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a filing-ready annual cooperative return (identity, membership movement, financials, statutory funds, dividends, governance) and file it from the developer console with a registrar acknowledgement.

**Architecture:** Extend the existing regulator-reporting pipeline with an `"annual"` period type, an `annualPack()` sheet composer, an acknowledgement column, three developer routes, and one console card. Reuses `buildReportFiles`, S3 upload, email, audit, and RLS-scoped transactions.

**Tech Stack:** TypeScript (ESM), Fastify 5, Prisma 6 (Postgres + SQLite test schema), Vitest, ExcelJS/PDFKit via `src/services/exports.ts`, vanilla JS console in `dashboard/dev/dev.js`.

**Spec:** `docs/superpowers/specs/2026-10-20-annual-registrar-pack-design.md`

## Global Constraints

- Both Prisma schemas must change: `prisma/schema.prisma` and `prisma/schema.local.prisma`.
- Annual period key is `YYYY`; data window is 1 Jan 00:00:00.000Z to 31 Dec 23:59:59.999Z.
- Default annual due date is 31 March of the following year; due day is clamped to the month's last day.
- Every coop read/write goes through `withCoopContext` or `withTx` + `setCoopContext`; no cross-coop queries.
- Developer routes inherit the existing preHandler: cookie/Bearer auth, revocation fail-closed, live-admin check, `X-Requested-With` on non-GET, support role read-only.
- Filing acknowledgement is optional, max 80 chars; filing note max 500 chars and stored in the existing `notes` column.
- No new runtime dependency. No scheduler changes. No registrar API integration.
- Branch: `feat/platform-console`. Do not stage unrelated untracked files.
- Gates before every commit: `npm run typecheck`; before final sign-off also `npm run lint`, `npm run format:check`, full `npm test`.
- Tests must use the SQLite local schema; `pretest` regenerates the client.

---

### Task 1: Schema, migration, annual period math, annual due profile

**Files:**
- Modify: `prisma/schema.prisma:1949-1982` (`RegulatorProfile`, `RegulatorReport`)
- Modify: `prisma/schema.local.prisma` (same two models)
- Create: `prisma/migrations/20261060000000_annual_registrar_pack/migration.sql`
- Modify: `src/services/regulator-reporting.ts:1-120` (`PeriodType`, `RegulatorDueProfile`, `DEFAULT_DUE`, `reportPeriod`, `periodDueAt`, `periodRange`, `dueProfile`)
- Modify: `src/services/regulator-reporting.ts:555-650` (`setRegulatorProfile`)
- Test: `tests/regulator-reporting.test.ts:216-250`, `:824-900`

**Interfaces:**
- Consumes: existing `RegulatorReport` upsert key `cooperativeId_period_periodType_packType`.
- Produces: `PeriodType = "monthly" | "quarterly" | "annual"`;
  `RegulatorDueProfile { monthlyDueDay; quarterlyDueDay; annualDueMonth; annualDueDay }`;
  `reportPeriod(now, "annual") -> "YYYY"`;
  `periodDueAt("YYYY", "annual", profile) -> Date`;
  profile fields `annualDueMonth`/`annualDueDay`.

- [ ] **Step 1: Add schema columns to both schemas**

In `prisma/schema.prisma` and `prisma/schema.local.prisma`:

```prisma
model RegulatorProfile {
  id              String   @id @default(cuid())
  cooperativeId   String
  cooperative     Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  label           String
  type            String
  contactEmail    String?
  monthlyDueDay   Int      @default(10)
  quarterlyDueDay Int      @default(15)
  annualDueMonth  Int      @default(3) // 1-12
  annualDueDay    Int      @default(31) // 1-31, clamped to the month's last day
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())

  @@index([cooperativeId, active])
}

model RegulatorReport {
  // ...existing fields unchanged...
  dueAt             DateTime?
  filedAt           DateTime?
  notes             String?
  acknowledgementId String?
  // ...existing @@unique and @@index unchanged...
}
```

- [ ] **Step 2: Add the migration**

Create `prisma/migrations/20261060000000_annual_registrar_pack/migration.sql`:

```sql
ALTER TABLE "RegulatorProfile" ADD COLUMN "annualDueMonth" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "RegulatorProfile" ADD COLUMN "annualDueDay" INTEGER NOT NULL DEFAULT 31;
ALTER TABLE "RegulatorReport" ADD COLUMN "acknowledgementId" TEXT;
```

- [ ] **Step 3: Regenerate the local client and push the test schema**

Run: `npm run prisma:push:local`
Expected: "Your database is now in sync with your Prisma schema."

Run: `npm run pretest`
Expected: Prisma client generated from `schema.local.prisma`.

- [ ] **Step 4: Write failing period tests**

In `tests/regulator-reporting.test.ts`, add to the `reportPeriod` describe:

```ts
  it("returns the calendar year for an annual period", () => {
    expect(reportPeriod(new Date("2026-01-01"), "annual")).toBe("2026");
    expect(reportPeriod(new Date("2026-12-31"), "annual")).toBe("2026");
  });
```

Replace the shared profile in the `periodDueAt` describe and add cases:

```ts
  const profile = {
    monthlyDueDay: 10,
    quarterlyDueDay: 15,
    annualDueMonth: 3,
    annualDueDay: 31,
  };

  it("is the configured annual due date in the following year", () => {
    expect(periodDueAt("2026", "annual", profile).toISOString().slice(0, 10)).toBe("2027-03-31");
  });

  it("clamps the annual due day to the last day of the month", () => {
    const february = { ...profile, annualDueMonth: 2, annualDueDay: 31 };
    expect(periodDueAt("2026", "annual", february).toISOString().slice(0, 10)).toBe(
      "2027-02-28",
    );
  });
```

Add to the `setRegulatorProfile` describe:

```ts
  it("stores and validates the annual due date", async () => {
    const coop = await createTestCoop("REG40");
    const admin = await createTestMember(coop.id, { phone: "2348000010050", role: "superadmin" });
    const actor = { id: admin.id, phone: admin.phone };

    const ok = await setRegulatorProfile(
      coop.id,
      { label: "Ministry", annualDueMonth: 4, annualDueDay: 30 },
      actor,
    );
    expect(ok.ok).toBe(true);
    const profile = await prisma.regulatorProfile.findFirst({ where: { cooperativeId: coop.id } });
    expect(profile!.annualDueMonth).toBe(4);
    expect(profile!.annualDueDay).toBe(30);

    const badMonth = await setRegulatorProfile(coop.id, { annualDueMonth: 13 }, actor);
    expect(badMonth.ok).toBe(false);
    const badDay = await setRegulatorProfile(coop.id, { annualDueDay: 0 }, actor);
    expect(badDay.ok).toBe(false);
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "annual"`
Expected: FAIL — `reportPeriod` returns `"2026-07"` for annual, `annualDueMonth` is not a known input, `periodDueAt` reads `profile.annualDueMonth` as undefined.

- [ ] **Step 6: Implement period math and profile fields**

In `src/services/regulator-reporting.ts`, replace the type/profile block:

```ts
export type PeriodType = "monthly" | "quarterly" | "annual";
export type PackType = "statutory" | "nfiu" | "both";

export interface RegulatorDueProfile {
  monthlyDueDay: number;
  quarterlyDueDay: number;
  annualDueMonth: number;
  annualDueDay: number;
}

const DEFAULT_DUE: RegulatorDueProfile = {
  monthlyDueDay: 10,
  quarterlyDueDay: 15,
  annualDueMonth: 3,
  annualDueDay: 31,
};
```

Replace `reportPeriod`:

```ts
/** `YYYY-MM`, quarter-end `YYYY-MM`, or calendar `YYYY` for the period at `now`. */
export function reportPeriod(now: Date, periodType: PeriodType): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  if (periodType === "annual") return String(year);
  if (periodType === "monthly") {
    return `${year}-${String(month + 1).padStart(2, "0")}`;
  }
  // Quarterly returns are named for the quarter-end month (Jan-Mar -> 03).
  const quarterEndMonth = Math.ceil((month + 1) / 3) * 3;
  return `${year}-${String(quarterEndMonth).padStart(2, "0")}`;
}
```

Add a clamped-date helper and replace `periodDueAt`:

```ts
/** A UTC calendar date, clamped to the last day of the requested month. */
function dueDateUtc(year: number, month1: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month1 - 1, Math.min(day, lastDay)));
}

export function periodDueAt(
  period: string,
  periodType: PeriodType,
  profile: RegulatorDueProfile,
): Date {
  if (periodType === "annual") {
    return dueDateUtc(Number(period) + 1, profile.annualDueMonth, profile.annualDueDay);
  }
  const [year, month] = period.split("-").map(Number);
  const dueDay = periodType === "monthly" ? profile.monthlyDueDay : profile.quarterlyDueDay;
  // `month` is 1-based (03 = March); Date.UTC's 0-based month rolls forward.
  return new Date(Date.UTC(year, month, dueDay));
}
```

Replace `periodRange` to accept `YYYY`:

```ts
/** UTC [start, end] bounds of a `YYYY-MM` period or a calendar `YYYY` year. */
function periodRange(period: string): { start: Date; end: Date } {
  if (/^\d{4}$/.test(period)) {
    const year = Number(period);
    return {
      start: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
    };
  }
  const [year, month] = period.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}
```

Extend `dueProfile` select and return:

```ts
  const profile = await prisma.regulatorProfile.findFirst({
    where: { cooperativeId: coopId, active: true },
    orderBy: { createdAt: "desc" },
    select: {
      monthlyDueDay: true,
      quarterlyDueDay: true,
      annualDueMonth: true,
      annualDueDay: true,
      contactEmail: true,
    },
  });
  return {
    monthlyDueDay: profile?.monthlyDueDay ?? DEFAULT_DUE.monthlyDueDay,
    quarterlyDueDay: profile?.quarterlyDueDay ?? DEFAULT_DUE.quarterlyDueDay,
    annualDueMonth: profile?.annualDueMonth ?? DEFAULT_DUE.annualDueMonth,
    annualDueDay: profile?.annualDueDay ?? DEFAULT_DUE.annualDueDay,
    contactEmail: profile?.contactEmail ?? null,
  };
```

In `setRegulatorProfile`, extend the input type with `annualDueMonth?: number; annualDueDay?: number;` and add validation after the existing loop:

```ts
  if (
    input.annualDueMonth !== undefined &&
    (!Number.isInteger(input.annualDueMonth) ||
      input.annualDueMonth < 1 ||
      input.annualDueMonth > 12)
  ) {
    return { ok: false, message: "Annual due month must be between 1 and 12." };
  }
  if (
    input.annualDueDay !== undefined &&
    (!Number.isInteger(input.annualDueDay) || input.annualDueDay < 1 || input.annualDueDay > 31)
  ) {
    return { ok: false, message: "Annual due day must be between 1 and 31." };
  }
```

Add both fields to `create` and the conditional `update` spread, and include them in the audit detail/message:

```ts
        ...(input.annualDueMonth !== undefined ? { annualDueMonth: input.annualDueMonth } : {}),
        ...(input.annualDueDay !== undefined ? { annualDueDay: input.annualDueDay } : {}),
```

```ts
        annualDueMonth: input.annualDueMonth ?? DEFAULT_DUE.annualDueMonth,
        annualDueDay: input.annualDueDay ?? DEFAULT_DUE.annualDueDay,
```

```ts
    detail: `Regulator set to ${profile.label} (${profile.type}); monthly due ${profile.monthlyDueDay}, quarterly due ${profile.quarterlyDueDay}, annual due ${profile.annualDueMonth}/${profile.annualDueDay}`,
```

```ts
      `Monthly returns due day *${profile.monthlyDueDay}*, quarterly due day *${profile.quarterlyDueDay}*, annual due *${profile.annualDueMonth}/${profile.annualDueDay}*. ` +
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: PASS (existing period and profile tests included).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261060000000_annual_registrar_pack/migration.sql src/services/regulator-reporting.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): add annual period and due profile"
```

---

### Task 2: Annual pack - identity and membership movement

**Files:**
- Modify: `src/services/regulator-reporting.ts` (add `annualPack` after `statutoryPack`)
- Test: `tests/regulator-reporting.test.ts` (new `describe("annualPack")`)

**Interfaces:**
- Consumes: `periodRange` (Task 1), `ReportSheet` from `src/services/exports.ts`.
- Produces: `export async function annualPack(coopId: string, period: string): Promise<ReportSheet[]>`, whose first two sheets are named `"Annual Return"` and `"Membership Movement"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/regulator-reporting.test.ts`:

```ts
describe("annualPack", () => {
  it("includes identity particulars and membership movement for the year", async () => {
    const coop = await createTestCoop("REG30");
    await prisma.cooperative.update({
      where: { id: coop.id },
      data: {
        registrationNumber: "LS/CS/2020/001",
        tin: "12345678-0001",
        scumlStatus: "registered",
        dpoEmail: "dpo@example.com",
      },
    });
    await prisma.regulatorProfile.create({
      data: { cooperativeId: coop.id, label: "Lagos Ministry", type: "ministry" },
    });

    const before = await createTestMember(coop.id, { phone: "2348000010040" });
    await prisma.member.update({
      where: { id: before.id },
      data: { createdAt: new Date("2025-06-01T10:00:00Z") },
    });
    const joined = await createTestMember(coop.id, { phone: "2348000010041" });
    await prisma.member.update({
      where: { id: joined.id },
      data: { createdAt: new Date("2026-05-01T10:00:00Z") },
    });
    await prisma.member.update({ where: { id: joined.id }, data: { status: "suspended" } });
    await createTestMember(coop.id, { phone: "2348000010042" });
    await prisma.member.updateMany({
      where: { cooperativeId: coop.id, phone: "2348000010042" },
      data: { createdAt: new Date("2027-01-05T10:00:00Z") },
    });

    const sheets = await annualPack(coop.id, "2026");
    const identity = sheets.find((s) => s.name === "Annual Return")!;
    const movement = sheets.find((s) => s.name === "Membership Movement")!;

    expect(identity.rows).toContainEqual(["Registration number", "LS/CS/2020/001"]);
    expect(identity.rows).toContainEqual(["Regulator", "Lagos Ministry (ministry)"]);
    expect(identity.rows).toContainEqual(["Members (current)", "3"]);

    expect(movement.rows).toContainEqual(["Opening members (1 Jan)", "1"]);
    expect(movement.rows).toContainEqual(["Joined during year", "1"]);
    expect(movement.rows).toContainEqual(["Closing members (31 Dec)", "2"]);
    expect(movement.rows).toContainEqual(["Suspended (as of generation)", "1"]);
  });
});
```

Add `annualPack` to the import list from `../src/services/regulator-reporting.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "annualPack"`
Expected: FAIL — `annualPack` is not exported.

- [ ] **Step 3: Implement the two sheets**

Add after `statutoryPack` in `src/services/regulator-reporting.ts`:

```ts
/**
 * Build the annual registrar return for a calendar year. READ-ONLY: identity and
 * compliance particulars, membership movement, statutory financial statements,
 * fund appropriations/dividends, and governance/AGM evidence.
 */
export async function annualPack(coopId: string, period: string): Promise<ReportSheet[]> {
  const { start, end } = periodRange(period);
  const [coop, profile, opening, joined, closing, byStatus] = await Promise.all([
    prisma.cooperative.findUnique({
      where: { id: coopId },
      select: {
        name: true,
        code: true,
        state: true,
        country: true,
        registrationNumber: true,
        tin: true,
        cvn: true,
        scumlStatus: true,
        dpoName: true,
        dpoPhone: true,
        dpoEmail: true,
      },
    }),
    prisma.regulatorProfile.findFirst({
      where: { cooperativeId: coopId, active: true },
      orderBy: { createdAt: "desc" },
      select: { label: true, type: true },
    }),
    prisma.member.count({ where: { cooperativeId: coopId, createdAt: { lt: start } } }),
    prisma.member.count({
      where: { cooperativeId: coopId, createdAt: { gte: start, lte: end } },
    }),
    prisma.member.count({ where: { cooperativeId: coopId, createdAt: { lte: end } } }),
    prisma.member.groupBy({
      by: ["status"],
      where: { cooperativeId: coopId },
      _count: { _all: true },
    }),
  ]);

  const current = byStatus.reduce((sum, row) => sum + row._count._all, 0);
  const statusRows = new Map(byStatus.map((row) => [row.status, row._count._all]));
  const warnings: string[] = [];
  if (!coop?.registrationNumber) warnings.push("Registration number is missing");
  if (!coop?.tin) warnings.push("TIN is missing");
  if (!coop?.scumlStatus) warnings.push("SCUML status is missing");
  if (!coop?.dpoEmail) warnings.push("DPO email is missing");

  const identity: ReportSheet = {
    name: "Annual Return",
    rows: [
      ["Item", "Value"],
      ["Cooperative", coop?.name ?? ""],
      ["Code", coop?.code ?? ""],
      ["State", coop?.state ?? ""],
      ["Country", coop?.country ?? ""],
      ["Regulator", profile ? `${profile.label} (${profile.type})` : "Not configured"],
      ["Period (calendar year)", period],
      ["Registration number", coop?.registrationNumber ?? ""],
      ["TIN", coop?.tin ?? ""],
      ["CVN", coop?.cvn ?? ""],
      ["SCUML status", coop?.scumlStatus ?? ""],
      ["DPO name", coop?.dpoName ?? ""],
      ["DPO phone", coop?.dpoPhone ?? ""],
      ["DPO email", coop?.dpoEmail ?? ""],
      ["Members (current)", String(current)],
      ["Generated at (UTC)", new Date().toISOString()],
      ["Warnings", warnings.length ? warnings.join("; ") : "None"],
      [
        "Note",
        "Calendar-year return. Money in NGN. Member status is as of generation time.",
      ],
    ],
  };

  const movement: ReportSheet = {
    name: "Membership Movement",
    rows: [
      ["Metric", "Members"],
      ["Opening members (1 Jan)", String(opening)],
      ["Joined during year", String(joined)],
      ["Closing members (31 Dec)", String(closing)],
      ["Active (as of generation)", String(statusRows.get("active") ?? 0)],
      ["Pending (as of generation)", String(statusRows.get("pending") ?? 0)],
      ["Suspended (as of generation)", String(statusRows.get("suspended") ?? 0)],
      ["Deceased (as of generation)", String(statusRows.get("deceased") ?? 0)],
      [
        "Note",
        "Exit dates are not stored; status breakdowns reflect the current member record.",
      ],
    ],
  };

  return [identity, movement];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "annualPack"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/regulator-reporting.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): annual pack identity and membership movement"
```

---

### Task 3: Annual pack - financials, funds/dividends, governance

**Files:**
- Modify: `src/services/regulator-reporting.ts` (`annualPack`)
- Test: `tests/regulator-reporting.test.ts` (`annualPack` describe)

**Interfaces:**
- Consumes: `statutoryPack`, `formatBalance`, `prisma.dividend`, `prisma.reserveAllocation`, `prisma.meeting`.
- Produces: sheets named `"Balance Sheet"`, `"Profit & Loss"`, `"PAR Aging"`, `"PEARLS"`, `"Savings"`, `"Loans"`, `"Statutory Funds & Dividends"`, `"Governance"` appended to `annualPack` output.

- [ ] **Step 1: Write the failing test**

Extend the `annualPack` describe:

```ts
  it("adds financial statements, statutory funds, dividends and governance", async () => {
    const coop = await createTestCoop("REG31");
    const admin = await createTestMember(coop.id, {
      phone: "2348000010043",
      role: "superadmin",
    });
    const member = await createTestMember(coop.id, { phone: "2348000010044" });

    await makeLedger(coop.id, "income", "interest", 50000, new Date("2026-03-15T12:00:00Z"));
    await makeLedger(coop.id, "expense", "salary", 10000, new Date("2026-03-20T12:00:00Z"));
    await makeContrib(coop.id, member.id, 400000);
    await makeLoan(coop.id, member.id, 200000, 45);

    await prisma.reserveAllocation.create({
      data: {
        cooperativeId: coop.id,
        amount: 250000,
        source: "dividend_declaration",
        createdAt: new Date("2026-04-01T10:00:00Z"),
      },
    });
    await prisma.educationFund.create({
      data: {
        cooperativeId: coop.id,
        amount: 100000,
        source: "dividend_declaration",
        createdAt: new Date("2026-04-01T10:00:00Z"),
      },
    });
    await prisma.developmentFund.create({
      data: {
        cooperativeId: coop.id,
        amount: 50000,
        source: "dividend_declaration",
        createdAt: new Date("2026-04-01T10:00:00Z"),
      },
    });
    const dividend = await prisma.dividend.create({
      data: {
        cooperativeId: coop.id,
        reference: "DIV-2026-1",
        rate: 5,
        basis: "savings",
        totalPool: 300000,
        status: "distributed",
        createdAt: new Date("2026-05-01T10:00:00Z"),
        distributedAt: new Date("2026-05-02T10:00:00Z"),
      },
    });
    await prisma.dividendEntry.create({
      data: {
        dividendId: dividend.id,
        memberId: member.id,
        amount: 120000,
        status: "settled",
        paidAt: new Date("2026-05-02T10:00:00Z"),
      },
    });
    const meeting = await prisma.meeting.create({
      data: {
        cooperativeId: coop.id,
        type: "agm",
        title: "2026 AGM",
        status: "closed",
        scheduledAt: new Date("2026-06-15T10:00:00Z"),
        closedAt: new Date("2026-06-15T12:00:00Z"),
        createdById: admin.id,
      },
    });
    await prisma.meetingAttendance.create({
      data: { meetingId: meeting.id, memberId: member.id, present: true },
    });

    const sheets = await annualPack(coop.id, "2026");
    expect(sheets.map((s) => s.name)).toEqual([
      "Annual Return",
      "Membership Movement",
      "Balance Sheet",
      "Profit & Loss",
      "PAR Aging",
      "PEARLS",
      "Savings",
      "Loans",
      "Statutory Funds & Dividends",
      "Governance",
    ]);

    const funds = sheets.find((s) => s.name === "Statutory Funds & Dividends")!;
    expect(funds.rows).toContainEqual(["Reserve allocated in year", formatBalance(250000)]);
    expect(funds.rows).toContainEqual(["Education allocated in year", formatBalance(100000)]);
    expect(funds.rows).toContainEqual(["Development allocated in year", formatBalance(50000)]);
    expect(funds.rows).toContainEqual(["Dividends declared in year", formatBalance(300000)]);
    expect(funds.rows).toContainEqual(["Dividends settled in year", formatBalance(120000)]);

    const governance = sheets.find((s) => s.name === "Governance")!;
    expect(governance.rows).toContainEqual(["AGM held in year", "Yes"]);
    expect(
      governance.rows.some((row) => row[0] === "AGM" && row[2].includes("attendance 1")),
    ).toBe(true);
  });
```

Add `formatBalance` is already imported in this test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "adds financial statements"`
Expected: FAIL — sheet list is only the two annual sheets.

- [ ] **Step 3: Implement the remaining sheets**

In `annualPack`, after the `movement` definition and before `return`, add reads:

```ts
  const financial = (await statutoryPack(coopId, period)).filter(
    (sheet) => sheet.name !== "Membership",
  );

  const [reserveYear, educationYear, developmentYear, dividends, balances, meetings] =
    await Promise.all([
      prisma.reserveAllocation.aggregate({
        where: { cooperativeId: coopId, createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
      }),
      prisma.educationFund.aggregate({
        where: { cooperativeId: coopId, createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
      }),
      prisma.developmentFund.aggregate({
        where: { cooperativeId: coopId, createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
      }),
      prisma.dividend.findMany({
        where: { cooperativeId: coopId, createdAt: { gte: start, lte: end } },
        select: {
          reference: true,
          rate: true,
          basis: true,
          totalPool: true,
          status: true,
          distributedAt: true,
          entries: { select: { amount: true, status: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.cooperative.findUnique({
        where: { id: coopId },
        select: {
          reserveFundBalance: true,
          protectionFundBalance: true,
          federationFundBalance: true,
          loanLossProvisionBalance: true,
        },
      }),
      prisma.meeting.findMany({
        where: { cooperativeId: coopId, scheduledAt: { gte: start, lte: end } },
        select: {
          type: true,
          title: true,
          status: true,
          scheduledAt: true,
          quorumPercent: true,
          attendance: { select: { present: true } },
          _count: { select: { motions: true } },
        },
        orderBy: { scheduledAt: "asc" },
      }),
    ]);

  const reserveTotal = reserveYear._sum.amount ?? 0;
  const educationTotal = educationYear._sum.amount ?? 0;
  const developmentTotal = developmentYear._sum.amount ?? 0;
  const declaredTotal = dividends.reduce((sum, row) => sum + row.totalPool, 0);
  const settledTotal = dividends.reduce(
    (sum, row) =>
      sum + row.entries.filter((e) => e.status === "settled").reduce((s, e) => s + e.amount, 0),
    0,
  );

  const funds: ReportSheet = {
    name: "Statutory Funds & Dividends",
    rows: [
      ["Item", "Amount"],
      ["Reserve allocated in year", formatBalance(reserveTotal)],
      ["Education allocated in year", formatBalance(educationTotal)],
      ["Development allocated in year", formatBalance(developmentTotal)],
      ["Dividends declared in year", formatBalance(declaredTotal)],
      ["Dividends settled in year", formatBalance(settledTotal)],
      ["Reserve fund balance", formatBalance(balances?.reserveFundBalance ?? 0)],
      ["Protection fund balance", formatBalance(balances?.protectionFundBalance ?? 0)],
      ["Federation fund balance", formatBalance(balances?.federationFundBalance ?? 0)],
      ["Loan-loss provision balance", formatBalance(balances?.loanLossProvisionBalance ?? 0)],
      ["", ""],
      ["Dividend run", "Rate | Basis | Pool | Status | Distributed"],
      ...dividends.map((d) => [
        d.reference,
        `${d.rate}% | ${d.basis} | ${formatBalance(d.totalPool)} | ${d.status} | ${
          d.distributedAt ? d.distributedAt.toISOString().slice(0, 10) : "-"
        }`,
      ]),
    ],
  };

  const agmHeld = meetings.some((m) => m.type === "agm" && m.status === "closed");
  const governance: ReportSheet = {
    name: "Governance",
    rows: [
      ["Item", "Value", "Detail"],
      ["AGM held in year", agmHeld ? "Yes" : "No", ""],
      ["Meetings in year", String(meetings.length), ""],
      ...meetings.map((m) => [
        m.type.toUpperCase(),
        m.scheduledAt.toISOString().slice(0, 10),
        `${m.title} | ${m.status} | attendance ${m.attendance.filter((a) => a.present).length} | quorum ${m.quorumPercent}% | motions ${m._count.motions}`,
      ]),
    ],
  };
```

Replace the final return:

```ts
  return [identity, movement, ...financial, funds, governance];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "annualPack"`
Expected: PASS for both annual tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/regulator-reporting.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): annual pack financials, funds, dividends, governance"
```

---

### Task 4: Annual generation and period validation

**Files:**
- Modify: `src/services/regulator-reporting.ts` (`generateReport`)
- Test: `tests/regulator-reporting.test.ts` (`generateReport` describe)

**Interfaces:**
- Consumes: `annualPack` (Tasks 2-3), `periodDueAt` annual branch (Task 1).
- Produces: `generateReport(coopId, "2026", "annual", "statutory", actorId)` persists `periodType: "annual"`, `period: "2026"`, due 31 March 2027 by default, and rejects malformed periods.

- [ ] **Step 1: Write the failing test**

Add inside `describe("generateReport")`:

```ts
  it("generates an idempotent annual pack with the following-year due date", async () => {
    const coop = await createTestCoop("REG32");
    const admin = await createTestMember(coop.id, {
      phone: "2348000010045",
      role: "superadmin",
    });
    const member = await createTestMember(coop.id, { phone: "2348000010046" });
    await makeLedger(coop.id, "income", "interest", 25000, new Date("2026-03-15T12:00:00Z"));
    await makeContrib(coop.id, member.id, 100000);

    const first = await generateReport(coop.id, "2026", "annual", "statutory", admin.id);
    expect(first.ok).toBe(true);
    const second = await generateReport(coop.id, "2026", "annual", "statutory", admin.id);
    expect(second.ok).toBe(true);
    expect(second.reportId).toBe(first.reportId);

    const rows = await prisma.regulatorReport.findMany({
      where: { cooperativeId: coop.id, period: "2026", periodType: "annual" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].dueAt?.toISOString().slice(0, 10)).toBe("2027-03-31");
  });

  it("rejects a malformed annual period", async () => {
    const coop = await createTestCoop("REG33");
    const res = await generateReport(coop.id, "2026-03", "annual", "statutory");
    expect(res.ok).toBe(false);
    expect(await prisma.regulatorReport.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "annual"`
Expected: FAIL — `generateReport` calls `annualPack` only after implementation; malformed `"2026-03"` currently succeeds because validation only checks pack type.

- [ ] **Step 3: Implement annual selection and validation**

In `generateReport`, after the pack-type guard:

```ts
  const periodPattern = periodType === "annual" ? /^\d{4}$/ : /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!periodPattern.test(period)) {
    return {
      ok: false,
      message: `Invalid *${periodType}* period *${period}*.`,
    };
  }
```

In the read transaction, replace the statutory branch:

```ts
    if (packType === "statutory" || packType === "both") {
      sheets.push(
        ...(periodType === "annual"
          ? await annualPack(coopId, period)
          : await statutoryPack(coopId, period)),
      );
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/regulator-reporting.test.ts -t "generateReport"`
Expected: PASS (including the existing monthly/quarterly cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/regulator-reporting.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): generate annual packs"
```

---

### Task 5: Filing acknowledgement and profile view

**Files:**
- Modify: `src/services/regulator-reporting.ts` (`ReportSummary`, `markFiled`, `listReports`, add `getRegulatorProfile`)
- Test: `tests/regulator-reporting.test.ts` (`markFiled`, `listReports` describes)

**Interfaces:**
- Produces:
  `markFiled(coopId: string, reportId: string, actor, filing?: { acknowledgementId?: string; note?: string })`;
  `ReportSummary` gains `acknowledgementId: string | null` and `notes: string | null`;
  `getRegulatorProfile(coopId): Promise<RegulatorProfileView | null>` with
  `{ id, label, type, contactEmail, monthlyDueDay, quarterlyDueDay, annualDueMonth, annualDueDay }`.

- [ ] **Step 1: Write the failing tests**

Extend `describe("markFiled")`:

```ts
  it("persists an acknowledgement and note, and audits the filing", async () => {
    const coop = await createTestCoop("REG41");
    const admin = await createTestMember(coop.id, { phone: "2348000010051", role: "superadmin" });
    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026",
        periodType: "annual",
        packType: "statutory",
        status: "generated",
      },
    });

    const res = await markFiled(coop.id, report.id, { id: admin.id, phone: admin.phone }, {
      acknowledgementId: " LSCS/AR/2026/0042 ",
      note: "Delivered by hand",
    });
    expect(res.ok).toBe(true);

    const saved = await prisma.regulatorReport.findUnique({ where: { id: report.id } });
    expect(saved!.status).toBe("filed");
    expect(saved!.acknowledgementId).toBe("LSCS/AR/2026/0042");
    expect(saved!.notes).toBe("Delivered by hand");
    expect(saved!.filedAt).toBeInstanceOf(Date);

    const audited = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "regulator.report_filed", targetId: report.id },
    });
    expect(audited!.detail).toContain("LSCS/AR/2026/0042");
  });

  it("rejects an over-length acknowledgement", async () => {
    const coop = await createTestCoop("REG42");
    const admin = await createTestMember(coop.id, { phone: "2348000010052", role: "superadmin" });
    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026",
        periodType: "annual",
        packType: "statutory",
      },
    });
    const res = await markFiled(coop.id, report.id, { id: admin.id, phone: admin.phone }, {
      acknowledgementId: "x".repeat(81),
    });
    expect(res.ok).toBe(false);
    expect(
      (await prisma.regulatorReport.findUnique({ where: { id: report.id } }))!.acknowledgementId,
    ).toBeNull();
  });
```

Extend `describe("listReports")`:

```ts
  it("returns the acknowledgement and filing note", async () => {
    const coop = await createTestCoop("REG43");
    const admin = await createTestMember(coop.id, { phone: "2348000010053", role: "superadmin" });
    await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026",
        periodType: "annual",
        packType: "statutory",
        status: "filed",
        filedAt: new Date(),
        acknowledgementId: "ACK-1",
        notes: "Received",
      },
    });
    const res = await listReports(coop.id);
    expect(res.reports![0].acknowledgementId).toBe("ACK-1");
    expect(res.reports![0].notes).toBe("Received");
  });
```

Add a `getRegulatorProfile` test:

```ts
describe("getRegulatorProfile", () => {
  it("returns the active profile with annual due fields, or null", async () => {
    const coop = await createTestCoop("REG44");
    expect(await getRegulatorProfile(coop.id)).toBeNull();
    await prisma.regulatorProfile.create({
      data: {
        cooperativeId: coop.id,
        label: "Lagos Ministry",
        type: "ministry",
        annualDueMonth: 4,
        annualDueDay: 30,
      },
    });
    const view = await getRegulatorProfile(coop.id);
    expect(view).toMatchObject({
      label: "Lagos Ministry",
      annualDueMonth: 4,
      annualDueDay: 30,
    });
  });
});
```

Add `getRegulatorProfile` to the test imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: FAIL — `markFiled` ignores the fourth argument and `getRegulatorProfile` is not exported.

- [ ] **Step 3: Implement**

Extend `ReportSummary`:

```ts
export interface ReportSummary {
  id: string;
  period: string;
  periodType: string;
  packType: string;
  status: string;
  dueAt: Date | null;
  filedAt: Date | null;
  acknowledgementId: string | null;
  notes: string | null;
  files: { xlsx: string; pdf: string; csv: string } | null;
}
```

Replace `markFiled`:

```ts
export async function markFiled(
  coopId: string,
  reportId: string,
  actor: { id: string; phone: string },
  filing: { acknowledgementId?: string; note?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  const ref = reportId?.trim();
  if (!ref) return { ok: false, message: "Usage: *regreport filed <report id>*." };

  const acknowledgementId = filing.acknowledgementId?.trim() || null;
  const note = filing.note?.trim() || null;
  if (acknowledgementId && acknowledgementId.length > 80) {
    return { ok: false, message: "Acknowledgement must be 80 characters or fewer." };
  }
  if (note && note.length > 500) {
    return { ok: false, message: "Filing note must be 500 characters or fewer." };
  }

  const report = await prisma.regulatorReport.findFirst({
    where: { cooperativeId: coopId, id: { endsWith: ref } },
    orderBy: { generatedAt: "desc" },
  });
  if (!report) {
    return { ok: false, message: `No regulator report matching *${ref}* in your cooperative.` };
  }

  if (report.status === "filed" && !acknowledgementId && !note) {
    return {
      ok: true,
      message: `The *${report.period}* ${report.periodType} pack is already marked filed.`,
    };
  }

  const filedAt = new Date();
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.regulatorReport.update({
      where: { id: report.id },
      data: {
        status: "filed",
        filedAt: report.filedAt ?? filedAt,
        ...(acknowledgementId ? { acknowledgementId } : {}),
        ...(note ? { notes: note } : {}),
      },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "admin",
    action: report.status === "filed" ? "regulator.report_acknowledged" : "regulator.report_filed",
    targetType: "regulatorReport",
    targetId: report.id,
    detail:
      `${report.periodType} ${report.packType} pack for ${report.period} marked filed` +
      (acknowledgementId ? ` (ack ${acknowledgementId})` : ""),
  });

  return {
    ok: true,
    message:
      `*${report.period}* ${report.periodType} regulator pack marked *filed*` +
      (acknowledgementId ? ` with acknowledgement *${acknowledgementId}*` : "") +
      ".",
  };
}
```

Add fields to the `listReports` mapping:

```ts
      acknowledgementId: r.acknowledgementId,
      notes: r.notes,
```

Add `getRegulatorProfile` after `dueProfile`:

```ts
export interface RegulatorProfileView {
  id: string;
  label: string;
  type: string;
  contactEmail: string | null;
  monthlyDueDay: number;
  quarterlyDueDay: number;
  annualDueMonth: number;
  annualDueDay: number;
}

/** The active regulator profile for the console, or null when unconfigured. */
export async function getRegulatorProfile(coopId: string): Promise<RegulatorProfileView | null> {
  return prisma.regulatorProfile.findFirst({
    where: { cooperativeId: coopId, active: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      type: true,
      contactEmail: true,
      monthlyDueDay: true,
      quarterlyDueDay: true,
      annualDueMonth: true,
      annualDueDay: true,
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/regulator-reporting.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): filing acknowledgement and profile view"
```

---

### Task 6: Developer API routes

**Files:**
- Modify: `src/routes/developer.ts` (imports; add routes after the compliance PATCH at `:330`)
- Test: `tests/developer-regulator-reports.test.ts` (new)

**Interfaces:**
- Consumes: `generateReport`, `listReports`, `markFiled`, `getRegulatorProfile` (Tasks 4-5).
- Produces:
  `GET /api/developer/coops/:id/regulator-reports` -> `{ profile, reports }`;
  `POST /api/developer/coops/:id/regulator-reports` `{ year, packType }` -> `{ ok, reportId, dueAt, files, links, message }`;
  `POST /api/developer/coops/:id/regulator-reports/:reportId/file` `{ acknowledgementId?, note? }` -> `{ ok, message }`.

- [ ] **Step 1: Write the failing route test**

Create `tests/developer-regulator-reports.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, createTestCoop } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { resetRateLimit } from "../src/lib/cache.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

async function login(phone: string, role: "owner" | "support"): Promise<string> {
  await prisma.platformAdmin.create({
    data: { name: role, phone, role, pin: hashPin("123456"), mustChangePin: false },
  });
  await resetRateLimit("devlogin:127.0.0.1");
  const res = await app.inject({
    method: "POST",
    url: "/api/developer/login",
    payload: { phone, pin: "123456" },
  });
  expect(res.statusCode).toBe(200);
  return (res.headers["set-cookie"] as string).split(";")[0];
}

const write = (cookie: string) => ({ cookie, "x-requested-with": "XMLHttpRequest" });

beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  await prisma.regulatorReport.deleteMany();
  await prisma.regulatorProfile.deleteMany();
});

describe("developer regulator reports", () => {
  it("lists profile and reports for a coop", async () => {
    const coop = await createTestCoop("DEVREG1");
    await prisma.regulatorProfile.create({
      data: { cooperativeId: coop.id, label: "Lagos Ministry", type: "ministry" },
    });
    const cookie = await login("2348000000101", "owner");

    const res = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.profile.label).toBe("Lagos Ministry");
    expect(body.reports).toEqual([]);
  });

  it("generates an annual pack and rejects invalid input", async () => {
    const coop = await createTestCoop("DEVREG2");
    const cookie = await login("2348000000102", "owner");

    const ok = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 2026, packType: "statutory" },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).reportId).toBeTruthy();

    const badYear = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 26 },
    });
    expect(badYear.statusCode).toBe(400);

    const badPack = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 2026, packType: "bogus" },
    });
    expect(badPack.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/api/developer/coops/nope/regulator-reports",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("files a pack with an acknowledgement", async () => {
    const coop = await createTestCoop("DEVREG3");
    const cookie = await login("2348000000103", "owner");
    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026",
        periodType: "annual",
        packType: "statutory",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports/${report.id}/file`,
      headers: write(cookie),
      payload: { acknowledgementId: "ACK-42", note: "Hand delivered" },
    });
    expect(res.statusCode).toBe(200);
    const saved = await prisma.regulatorReport.findUnique({ where: { id: report.id } });
    expect(saved!.acknowledgementId).toBe("ACK-42");
    expect(saved!.notes).toBe("Hand delivered");

    const unknown = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports/nope/file`,
      headers: write(cookie),
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("keeps support role read-only", async () => {
    const coop = await createTestCoop("DEVREG4");
    const cookie = await login("2348000000104", "support");

    const read = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);

    const writeRes = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 2026 },
    });
    expect(writeRes.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/developer-regulator-reports.test.ts`
Expected: FAIL — routes return 404 ("Route not found").

- [ ] **Step 3: Implement the routes**

Add to the imports from `../services/regulator-reporting.js` (after `platform-audit` imports):

```ts
import {
  generateReport,
  listReports,
  markFiled,
  getRegulatorProfile,
} from "../services/regulator-reporting.js";
```

Add after the compliance PATCH route:

```ts
  // ---- Regulator returns (developer/owner) ----

  app.get("/api/developer/coops/:id/regulator-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    const [profile, listed] = await Promise.all([getRegulatorProfile(id), listReports(id)]);
    return { profile, reports: listed.reports ?? [] };
  });

  app.post("/api/developer/coops/:id/regulator-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });

    const body = (req.body ?? {}) as { year?: number | string; packType?: string };
    const year = Number(body.year);
    const currentYear = new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > currentYear) {
      return reply.code(400).send({ error: "year must be a four-digit year up to the current year" });
    }
    const packType = body.packType ?? "statutory";
    if (packType !== "statutory" && packType !== "nfiu" && packType !== "both") {
      return reply.code(400).send({ error: "packType must be statutory, nfiu or both" });
    }

    const result = await generateReport(id, String(year), "annual", packType, actorOf(req).id);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return result;
  });

  app.post("/api/developer/coops/:id/regulator-reports/:reportId/file", async (req, reply) => {
    const { id, reportId } = req.params as { id: string; reportId: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });

    const body = (req.body ?? {}) as { acknowledgementId?: string; note?: string };
    if (body.acknowledgementId !== undefined && typeof body.acknowledgementId !== "string") {
      return reply.code(400).send({ error: "acknowledgementId must be a string" });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return reply.code(400).send({ error: "note must be a string" });
    }

    const actor = actorOf(req);
    const result = await markFiled(
      id,
      reportId,
      { id: actor.id, phone: actor.phone },
      { acknowledgementId: body.acknowledgementId, note: body.note },
    );
    if (!result.ok) {
      const notFound = result.message.startsWith("No regulator report matching");
      return reply.code(notFound ? 404 : 400).send({ error: result.message });
    }
    return { ok: true, message: result.message };
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/developer-regulator-reports.test.ts`
Expected: PASS (4 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/developer.ts tests/developer-regulator-reports.test.ts
git commit -m "feat(developer): regulator report routes"
```

---

### Task 7: Console "Regulator returns" card

**Files:**
- Modify: `dashboard/dev/dev.js` (state near `coopDetail`; `renderCoopDetail`; `renderHealthPanel`; add render + handlers)
- Modify: `dashboard/dev/dev.css` only if a spacing rule is needed (prefer existing `.card`, `.form-inline`, `.table` classes)

**Interfaces:**
- Consumes: the three routes from Task 6.
- Produces: `window.generateAnnualReport(coopId)`, `window.fileRegulatorReport(coopId, reportId)`; card visible on the coop Health tab.

- [ ] **Step 1: Load report data with the coop detail**

Find the state block containing `let coopDetail = null;` and add:

```js
  let coopRegulator = { profile: null, reports: [] };
```

In `renderCoopDetail`, after the activity `try/catch` and before `renderCoopShell()`:

```js
      try {
        coopRegulator = await api(`/coops/${id}/regulator-reports`);
      } catch {
        coopRegulator = { profile: null, reports: [] };
      }
```

- [ ] **Step 2: Render the card**

In `renderHealthPanel`, insert before the "Controls" card:

```js
      <div class="card mb-6" id="regulatorCard">
        ${renderRegulatorCard(coop)}
      </div>
```

Add these functions near `renderMembersByStatus`:

```js
  function renderRegulatorCard(coop) {
    const profile = coopRegulator.profile;
    const reports = coopRegulator.reports || [];
    const thisYear = new Date().getUTCFullYear();
    const years = [thisYear, thisYear - 1, thisYear - 2]
      .map((y) => `<option value="${y}">${y}</option>`)
      .join('');
    const due = profile
      ? `Monthly day ${profile.monthlyDueDay} | Quarterly day ${profile.quarterlyDueDay} | Annual ${profile.annualDueMonth}/${profile.annualDueDay}`
      : 'No regulator configured (set it with the chat command *regulatorconfig*)';
    const rows = reports.length
      ? reports
          .map(
            (r) => `
        <tr>
          <td>${esc(r.period)}</td>
          <td>${esc(r.periodType)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.dueAt ? date(r.dueAt) : '-'}</td>
          <td>${r.filedAt ? date(r.filedAt) : '-'}</td>
          <td>${esc(r.acknowledgementId || '-')}</td>
          <td>
            ${r.files ? `<a href="${esc(r.files.xlsx)}" target="_blank" rel="noopener">XLSX</a> | <a href="${esc(r.files.pdf)}" target="_blank" rel="noopener">PDF</a>` : '-'}
          </td>
          <td>
            ${
              readOnly || r.status === 'filed'
                ? ''
                : `<button class="btn btn-secondary btn-sm" data-action="fileRegulatorReport" data-arg="${esc(coop.id)}|${esc(r.id)}">Mark filed</button>`
            }
          </td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="8" class="text-muted">No annual returns generated yet.</td></tr>';

    return `
      <div class="card-header">
        <span class="card-title">Regulator returns</span>
        <span class="text-muted text-xs">${esc(profile ? profile.label : 'Not configured')}</span>
      </div>
      <div class="card-body">
        <p class="text-muted text-sm mb-3">${esc(due)}</p>
        ${
          readOnly
            ? ''
            : `<div class="form-inline mb-4">
                 <div class="form-field"><label>Year</label><select id="regYear">${years}</select></div>
                 <div class="form-field"><label>Pack</label>
                   <select id="regPack">
                     <option value="statutory">Statutory</option>
                     <option value="both">Statutory + NFIU</option>
                     <option value="nfiu">NFIU</option>
                   </select>
                 </div>
                 <button class="btn btn-primary btn-sm" data-action="generateAnnualReport" data-arg="${esc(coop.id)}">Generate annual pack</button>
               </div>`
        }
        <table>
          <thead><tr><th>Period</th><th>Type</th><th>Status</th><th>Due</th><th>Filed</th><th>Ack</th><th>Files</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function statusBadge(status) {
    const cls = status === 'filed' ? 'badge-green' : 'badge-gray';
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }
```

If `statusBadge` already exists under another name, reuse `coopStatusBadge` instead and drop this helper.

- [ ] **Step 3: Add handlers**

Near `window.saveCoopCompliance`:

```js
  window.generateAnnualReport = async function (id) {
    const year = Number(document.getElementById('regYear')?.value);
    const packType = document.getElementById('regPack')?.value || 'statutory';
    try {
      const res = await api(`/coops/${id}/regulator-reports`, {
        method: 'POST',
        body: { year, packType },
      });
      toast('Annual pack generated');
      coopRegulator = await api(`/coops/${id}/regulator-reports`);
      renderCoopShell();
      return res;
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.fileRegulatorReport = async function (arg) {
    const [id, reportId] = String(arg || '').split('|');
    const acknowledgementId = window.prompt('Registrar acknowledgement number (optional):') || '';
    const note = window.prompt('Filing note (optional):') || '';
    try {
      await api(`/coops/${id}/regulator-reports/${reportId}/file`, {
        method: 'POST',
        body: { acknowledgementId, note },
      });
      toast('Marked filed');
      coopRegulator = await api(`/coops/${id}/regulator-reports`);
      renderCoopShell();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
```

Match the file's existing toast helper name/signature (`toast(...)` or `showToast(...)`); do not invent one.

- [ ] **Step 4: Verify the bundle parses**

Run: `node --check dashboard/dev/dev.js`
Expected: exit 0.

Manual check (documented for the PR): start the dev server, log into `dashboard/dev/`, open a coop, Health tab, generate a 2026 pack, confirm the row appears with XLSX/PDF links, mark it filed with an acknowledgement, confirm the status and ack render.

- [ ] **Step 5: Commit**

```bash
git add dashboard/dev/dev.js
git commit -m "feat(console): regulator returns card"
```

---

### Task 8: Full verification and sign-off

**Files:**
- Modify: `.superpowers/sdd/2026-10-17-platform-console/progress.md` (record the annual pack work)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green gates and an audit trail entry.

- [ ] **Step 1: Run the targeted suites**

Run: `npx vitest run tests/regulator-reporting.test.ts tests/developer-regulator-reports.test.ts`
Expected: PASS.

- [ ] **Step 2: Run static gates**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: 0 errors (warnings allowed; the branch baseline is 107).

Run: `npm run format:check`
Expected: clean. If it fails: run `npx prettier --write` on the changed files only.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all files pass; `tests/rls-isolation.test.ts` remains skipped without Postgres. Budget ~30 minutes.

- [ ] **Step 4: Record the work**

Append to `.superpowers/sdd/2026-10-17-platform-console/progress.md`:

```markdown
## ANNUAL REGISTRAR PACK (2026-10-20)

- Spec: `docs/superpowers/specs/2026-10-20-annual-registrar-pack-design.md`.
- Added `"annual"` period type (calendar year, 1 Jan-31 Dec UTC), annual due date
  (`RegulatorProfile.annualDueMonth/annualDueDay`, default 31 March, clamped), `annualPack()`
  (identity, membership movement, financial statements, funds/dividends, governance).
- Added `RegulatorReport.acknowledgementId`; filing note stored in `notes`; audit
  `regulator.report_filed` / `regulator.report_acknowledged`.
- Developer routes: list, generate, file. Console card on the coop Health tab.
- Tests: `tests/regulator-reporting.test.ts` (annual math/pack/filing), new
  `tests/developer-regulator-reports.test.ts`.
- Deferred: annual scheduler generation/reminders, receipt uploads.
```

- [ ] **Step 5: Commit**

```bash
git add .superpowers/sdd/2026-10-17-platform-console/progress.md
git commit -m "docs: record annual registrar pack work"
```

---

## Self-Review

- Spec sections mapped: §6.1 -> Task 1; §6.2 -> Tasks 2-3; §6.3 -> Tasks 4-5; §7 -> Task 6; §8 -> Task 7; §10 -> tests in Tasks 1-6; §12 -> Task 8. §5 -> Task 1. §9 -> enforced by existing preHandler plus Task 6 tests.
- Placeholder scan: all steps carry concrete code or commands. One deliberate instruction asks the implementer to reuse the file's existing toast helper name rather than invent one.
- Type consistency: `annualDueMonth`/`annualDueDay` used identically in schema, `RegulatorDueProfile`, `DEFAULT_DUE`, `dueProfile`, `getRegulatorProfile`, routes, and UI. `markFiled`'s fourth argument is `filing` in service and route. `ReportSummary.notes` matches the Prisma column.
- Known execution risk: the `-t` filters in Task 1/4 use test titles that exist after the test edits; if Vitest reports "No test files found", run the whole file instead.
