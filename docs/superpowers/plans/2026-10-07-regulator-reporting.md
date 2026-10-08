# Regulator Reporting Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cooperatives a regulator reporting pack — statutory financial returns + NFIU AML summaries — generated on demand and on schedule, in Excel + PDF + CSV, with filing due-date tracking.

**Architecture:** A per-coop `RegulatorProfile` (label/type/due dates) + a `RegulatorReport` (per period/type, with file keys + filing status). A `regulator-reporting.ts` service formats existing ledger/PAR/PEARLS data (statutory) and AML/STR data (NFIU) into xlsx/pdf/csv via the existing export helpers. A scheduler auto-generates monthly/quarterly packs + due-date reminders. Admin commands generate/view/mark-filed.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, ExcelJS, PDFKit, SQLite/Postgres.

**Spec:** `docs/superpowers/specs/2026-10-07-regulator-reporting-design.md`

## Global Constraints

- Money is integer kobo; format with `formatBalance`; parse user input with `parseNaira`.
- `.js` import extensions; no Prisma `enum` (use `String` + comments).
- `prisma/schema.prisma` and `prisma/schema.local.prisma` must stay identical (enforced by `tests/schema-sync.test.ts`).
- Every new table with `cooperativeId` needs a Stage-1 RLS migration + a FORCE-list entry in `prisma/rls/recommended_policies.sql`.
- Coop-scoped writes go through `withTx` + `setCoopContext`; system jobs use `forEachCoop`.
- Every generation/filing action calls `audit()` with a human-readable description.
- Pack generation is READ-ONLY (no new accounting). Filing is manual (status tracked only).
- Verification per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted tests green · full suite green (`npm test`) · schema-sync green.

---

## File Structure

- `prisma/schema.prisma`, `prisma/schema.local.prisma` — `RegulatorProfile`, `RegulatorReport`, `CooperativeConfig.regulatorReportingEnabled`.
- `prisma/migrations/20261041000000_regulator_reporting/migration.sql` + `20261042000000_regulator_reporting_rls/migration.sql`.
- `prisma/rls/recommended_policies.sql` — FORCE list entries.
- `src/services/regulator-reporting.ts` (new) — profiles, pack data, file generation, periods.
- `src/services/exports.ts` — export `writeXlsx`/`writePdf` (or add a shared `buildXlsxPdfCsv` helper).
- `src/services/scheduler.ts` — `runRegulatorReports`.
- `src/services/admin.ts`, `src/services/handlers/session.ts` — commands + menu.
- `tests/regulator-reporting.test.ts` (new).
- `README.md` — feature section.

---

### Task 1: Schema, migration, RLS

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261041000000_regulator_reporting/migration.sql`
- Create: `prisma/migrations/20261042000000_regulator_reporting_rls/migration.sql`
- Modify: `prisma/rls/recommended_policies.sql`
- Test: `tests/schema-sync.test.ts` (existing)

**Interfaces produced:**
- `RegulatorProfile` (id, cooperativeId, label, type, contactEmail?, monthlyDueDay, quarterlyDueDay, active, createdAt).
- `RegulatorReport` (id, cooperativeId, period, periodType, packType, status, generatedAt, generatedById?, files?, dueAt?, filedAt?, notes?; `@@unique([cooperativeId, period, periodType, packType])`).
- `CooperativeConfig.regulatorReportingEnabled Boolean @default(false)`.

- [ ] **Step 1: Add models to both schemas**

Add to `prisma/schema.prisma` (and identically to `prisma/schema.local.prisma`):

```prisma
// The regulator a cooperative files returns with (state Ministry, CBN, NFIU, or
// a custom label) plus the filing due dates for the pack.
model RegulatorProfile {
  id              String   @id @default(cuid())
  cooperativeId   String
  cooperative     Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  label           String
  type            String // ministry | cbn | nfiu | custom
  contactEmail    String?
  monthlyDueDay   Int      @default(10)
  quarterlyDueDay Int      @default(15)
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())

  @@index([cooperativeId, active])
}

// A generated regulator report pack for a period (idempotent per period/type).
model RegulatorReport {
  id            String    @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  period        String // YYYY-MM
  periodType    String // monthly | quarterly
  packType      String // statutory | nfiu | both
  status        String    @default("generated") // generated | filed
  generatedAt   DateTime  @default(now())
  generatedById String?
  files         String? // JSON { xlsx, pdf, csv }
  dueAt         DateTime?
  filedAt       DateTime?
  notes         String?

  @@unique([cooperativeId, period, periodType, packType])
  @@index([cooperativeId, status])
}
```

Add relations on `Cooperative` (`regulatorProfiles RegulatorProfile[]`, `regulatorReports RegulatorReport[]`) and to `CooperativeConfig`:
```prisma
  regulatorReportingEnabled Boolean @default(false)
```

- [ ] **Step 2: Write the migrations**

`20261041000000_regulator_reporting/migration.sql` — create both tables + indexes + FKs (mirror the `Mandate` migration style) and `ALTER TABLE "CooperativeConfig" ADD COLUMN "regulatorReportingEnabled" BOOLEAN NOT NULL DEFAULT false;`.

`20261042000000_regulator_reporting_rls/migration.sql` — mirror `prisma/migrations/20261030000000_savings_products_rls/migration.sql` (direct `cooperativeId` policy for both tables).

- [ ] **Step 3: FORCE-list entries**

Append `RegulatorProfile` and `RegulatorReport` to the FORCE list in `prisma/rls/recommended_policies.sql`.

- [ ] **Step 4: Generate + push + verify schema sync**

```bash
npm run prisma:generate:local
npx prisma db push --schema prisma/schema.local.prisma --skip-generate
npx vitest run tests/schema-sync.test.ts
```
Expected: schema-sync PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261041000000_regulator_reporting prisma/migrations/20261042000000_regulator_reporting_rls prisma/rls/recommended_policies.sql
git commit -m "feat(regulator): schema, migration, RLS"
```

---

### Task 2: Regulator service + statutory pack

**Files:**
- Create: `src/services/regulator-reporting.ts`
- Modify: `src/services/exports.ts` (export `writeXlsx`/`writePdf` or add a shared helper)
- Test: `tests/regulator-reporting.test.ts` (new)

**Interfaces produced:**
```ts
export function reportPeriod(now: Date, periodType: "monthly" | "quarterly"): string; // YYYY-MM
export function periodDueAt(period: string, periodType: "monthly" | "quarterly", profile: { monthlyDueDay: number; quarterlyDueDay: number }): Date;
export function statutoryPack(coopId: string, period: string): Promise<{ name: string; rows: string[][] }[]>;
export async function generateReport(coopId: string, period: string, periodType: "monthly" | "quarterly", packType: "statutory" | "nfiu" | "both", actorId?: string): Promise<{ ok: boolean; message: string; reportId?: string; files?: { xlsx: string; pdf: string; csv: string } }>;
```

- [ ] **Step 1: Write failing tests**

- `reportPeriod(new Date("2026-03-31"), "monthly")` → `"2026-03"`; quarterly for Q1 → `"2026-03"` (quarter-end month).
- `statutoryPack` includes balance sheet / P&L (from `computePnl`), PAR + PEARLS (from `computePar`/`computePearls`), and membership/savings/loans summary rows.
- `generateReport` writes xlsx + pdf + csv, persists a `generated` `RegulatorReport` with `files`, and audits.

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Export the file helpers**

In `src/services/exports.ts`, export `writeXlsx` and `writePdf` (currently module-private) and add a `writeCsv(path, sheet)` helper, OR add a shared `buildReportFiles(basePath, title, sheets): Promise<{ xlsx: string; pdf: string; csv: string }>`. Keep the existing `runExport` behavior unchanged.

- [ ] **Step 3: Implement `regulator-reporting.ts`**

Follow the `savings-products.ts` structure. `reportPeriod`/`periodDueAt` are pure. `statutoryPack(coopId, period)` calls the existing `computePnl`, `computePar`, `computePearls`, and member/savings/loan aggregates (read the source files) and returns sheet rows (formatted with `formatBalance`). `generateReport` writes the files via the exported helpers, upserts the `RegulatorReport` (idempotent on the unique key), and audits `regulator.report_generate`.

- [ ] **Step 4: Run tests + gate, then commit**

Run `npx vitest run tests/regulator-reporting.test.ts` → PASS; `npm run typecheck`; `npm run lint`.
```bash
git add src/services/regulator-reporting.ts src/services/exports.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): service and statutory pack"
```

---

### Task 3: NFIU AML summaries pack

**Files:**
- Modify: `src/services/regulator-reporting.ts`
- Test: `tests/regulator-reporting.test.ts`

**Interfaces produced:** `nfiuPack(coopId: string, period: string): Promise<{ name: string; rows: string[][] }[]>`; `generateReport` handles `packType: "nfiu"` and `"both"`.

- [ ] **Step 1: Write failing tests**

- `nfiuPack` includes STR/SAR counts + status for the period (from the `STR` model) and the large-transaction list (≥ ₦5M, from aml constants).
- `generateReport(..., "nfiu", ...)` produces an NFIU-only pack; `"both"` produces both sheet groups.

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `nfiuPack`**

Query `STR` rows for the coop within the period (by `createdAt`), group by `status`; list large transactions (reuse the `LARGE_TX_THRESHOLD`/`REPORTING_THRESHOLD` from `aml.ts`). Return sheet rows. Wire `nfiu`/`both` into `generateReport`.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
git add src/services/regulator-reporting.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): NFIU AML summaries pack"
```

---

### Task 4: Scheduler + due-date reminders

**Files:**
- Modify: `src/services/scheduler.ts`
- Test: `tests/regulator-reporting.test.ts`

**Interfaces produced:** `export async function runRegulatorReports(now?: Date): Promise<number>;`

- [ ] **Step 1: Write failing tests**

- For a coop with `regulatorReportingEnabled` and an active `RegulatorProfile`, a `runRegulatorReports` run after month-end generates the monthly pack (idempotent — second run creates none).
- After quarter-end it generates the quarterly pack.
- A due-date reminder is sent to admins when a generated pack is approaching/overdue.

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `runRegulatorReports`**

Follow the `forEachCoop` pattern (like `runOmbudsmanEscalations`): for each enabled coop, compute the last closed period, skip if a report already exists for it (idempotent), else `generateReport`. Send a filing due-date reminder. Wire into `runSchedulerTick`. Guard per-coop (one coop's failure must not abort the rest).

- [ ] **Step 3: Run tests + gate, then commit**

```bash
git add src/services/scheduler.ts tests/regulator-reporting.test.ts
git commit -m "feat(regulator): scheduled pack generation and due reminders"
```

---

### Task 5: Commands + docs

**Files:**
- Modify: `src/services/regulator-reporting.ts`, `src/services/admin.ts`, `src/services/handlers/session.ts`, `README.md`
- Test: `tests/regulator-reporting.test.ts`

**Interfaces produced:**
```ts
export async function setRegulatorProfile(coopId: string, input: { label?: string; type?: string; contactEmail?: string; monthlyDueDay?: number; quarterlyDueDay?: number }, actor: { id: string; phone: string }): Promise<{ ok: boolean; message: string }>;
export async function markFiled(coopId: string, reportId: string, actor: { id: string; phone: string }): Promise<{ ok: boolean; message: string }>;
export async function listReports(coopId: string): Promise<{ ok: boolean; message: string; reports?: ReportSummary[] }>;
```

- [ ] **Step 1: Write failing tests**

- `setRegulatorProfile` upserts the profile.
- `markFiled` sets `status: "filed"`, `filedAt`, and audits.
- `listReports` lists generated/filed packs.

Run: `npx vitest run tests/regulator-reporting.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement + wire commands**

Add `regreport <period> <statutory|nfiu|both>`, `regulatorconfig [label] [type] [email] [monthlyDue] [quarterlyDue]`, `regreportstatus`, `regreport filed <id>` to `handleAdminCommand` (gated admin/superadmin). Add the README `## Regulator reporting` section.

- [ ] **Step 3: Full gate + commit**

Run `npm run typecheck` · `npm run lint` · `npm test` · `npx vitest run tests/schema-sync.test.ts`.
```bash
git add src/services/regulator-reporting.ts src/services/admin.ts src/services/handlers/session.ts README.md tests/regulator-reporting.test.ts
git commit -m "feat(regulator): commands and docs"
```

---

## Self-Review

- **Spec coverage:** statutory + NFIU contents (Tasks 2/3), Excel+PDF+CSV (Task 2), on-demand + scheduled (Tasks 2/4/5), monthly+quarterly + per-coop regulator config (Tasks 1/2/5), read-only generation (Tasks 2/3), manual filing (Task 5). ✅
- **Placeholder scan:** no TBD/TODO; every code step has real code or an exact file+pattern.
- **Type consistency:** `RegulatorProfile`/`RegulatorReport` field names, `reportPeriod`/`periodDueAt`/`statutoryPack`/`nfiuPack`/`generateReport`/`runRegulatorReports` signatures are consistent across tasks.
- **Open items for the plan:** the exact balance-sheet data source (ledger) and quarterly boundary convention are pinned in Task 2; the export helper export is Task 2 Step 2.
