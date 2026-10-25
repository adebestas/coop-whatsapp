# Annual Registrar Pack - Design

- Status: approved for implementation (brainstorming complete)
- Date: 2026-10-20
- Author: platform owner + agent
- Related: `docs/research/2026-10-20-nigeria-coop-fintech-market.md` (market/compliance research),
  `docs/NIGERIA-COOPERATIVE-COMPLIANCE.md`, `docs/superpowers/specs/2026-10-17-platform-console-design.md`

## 1. Context

The platform already generates monthly/quarterly regulator packs and NFIU/AML summaries via
`src/services/regulator-reporting.ts` (Excel/PDF/CSV, S3 upload, email, audit, idempotent per
period/type/pack, filing state). What a state Cooperative Registrar actually asks for once a year
is broader: identity and registration particulars, membership movement, statutory fund
appropriations, dividends, AGM/governance evidence, plus the financial statements.

Today `PeriodType` is `"monthly" | "quarterly"`; `RegulatorProfile` has only monthly/quarterly due
days; `RegulatorReport` records a filed flag but no filing acknowledgement; and there is no console
surface for regulator returns at all (chat commands only).

## 2. Goals

- Generate a filing-ready **annual** return for a calendar year (Jan-Dec UTC) in one workbook.
- Cover identity/compliance particulars, membership movement, financial statements, statutory
  funds and dividends, and AGM/governance evidence.
- Let a platform admin generate, list, download, and mark an annual return **filed** with the
  registrar's acknowledgement number from the developer console.
- Reuse the existing pack pipeline (exports, S3, email, audit, idempotency, RLS-scoped reads).

## 3. Non-goals (YAGNI)

- No registrar API/integration; filing remains self-reported.
- No upload of registrar receipts/stamped copies.
- No per-state return templates; one generic template, differentiated by the profile label.
- No scheduler auto-generation or annual reminders (monthly/quarterly scheduling is unchanged).
- No NDPC breach register, no SCUML filing workflow.
- No historical snapshot of loan balances or member status changes (same limitation as the
  existing monthly/quarterly packs).

## 4. Scope

1. `"annual"` period type in period math (`reportPeriod`, `periodRange`, `periodDueAt`).
2. `annualPack()` composer with five logical sections and the existing statutory financial sheets.
3. Acknowledgement + filing note on `RegulatorReport`; annual due date on `RegulatorProfile`.
4. Three developer API routes (list, generate, file).
5. A "Regulator returns" card on the console coop-detail page.
6. Tests for period math, pack contents, filing, and route validation/authorization.

## 5. Data model changes

Both schema files: `prisma/schema.prisma` (Postgres) and `prisma/schema.local.prisma` (SQLite, used
by tests and local dev):

```prisma
model RegulatorProfile {
  // ...existing...
  annualDueMonth  Int @default(3)  // 1-12
  annualDueDay    Int @default(31) // 1-31
}

model RegulatorReport {
  // ...existing...
  acknowledgementId String? // registrar receipt / acknowledgement reference
  // filing note reuses the existing, currently unused `notes` column
}
```

- `periodType` and `status` stay plain strings; no enum migration.
- `@@unique([cooperativeId, period, periodType, packType])` already covers annual returns
  (`period` = `"2026"`, `periodType` = `"annual"`).
- New fields are nullable/defaulted, so the migration is additive and safe on existing rows.
- Migration file `prisma/migrations/20261060000000_annual_registrar_pack/migration.sql` adds the
  three columns (`ALTER TABLE ... ADD COLUMN`); tests continue to use `prisma db push` against
  `schema.local.prisma`.

## 6. Service design (`src/services/regulator-reporting.ts`)

### 6.1 Period math

- `PeriodType = "monthly" | "quarterly" | "annual"`.
- `reportPeriod(now, "annual")` -> `String(now.getUTCFullYear())`.
- `periodRange(period)` branches on key shape:
  - 4-char `YYYY` -> `start = Jan 1 00:00:00.000Z`, `end = Dec 31 23:59:59.999Z`.
  - existing `YYYY-MM` behavior unchanged.
- `periodDueAt(period, "annual", profile)` -> `Date.UTC(Number(period) + 1, annualDueMonth - 1,
  annualDueDay)`, default 31 March of the following year.
- `dueProfile()` also selects `annualDueMonth`/`annualDueDay`; `DEFAULT_DUE` gains
  `annualDueMonth: 3, annualDueDay: 31`.
- `RegulatorDueProfile` adds both fields; `setRegulatorProfile` accepts and validates them
  (month 1-12, day 1-31).

### 6.2 `annualPack(coopId, year)`

Returns `ReportSheet[]`, in this order:

1. **Annual Return** (cover/identity): coop name, code, state, country, regulator label/type,
   registration number, TIN, CVN, SCUML status, DPO name/phone/email, period `year`, member count,
   generation timestamp (UTC), and a `Warnings` block for missing registration number / TIN /
   SCUML status / DPO email.
2. **Membership Movement**: opening members (`createdAt < Jan 1`), joined in year
   (`createdAt` within range), closing (`createdAt <= Dec 31`), plus a current-status breakdown
   (`active | pending | suspended | deceased`) explicitly labelled "status as of generation - no
   exit timestamps are stored".
3. **Financial Statements**: reuse `statutoryPack(coopId, year)` sheets (Balance Sheet, Profit &
   Loss, PAR Aging, PEARLS, Savings, Loans) and drop its `Membership` sheet (superseded by #2).
4. **Statutory Funds & Dividends**: year sums of `ReserveAllocation`, `EducationFund`,
   `DevelopmentFund` grouped by `source`, plus lifetime-to-date sums (no separate
   education/development balance columns exist); closing balances from `Cooperative`
   (`reserveFundBalance`, `protectionFundBalance`, `federationFundBalance`,
   `loanLossProvisionBalance`); dividend runs created in year (reference,
   rate, basis, total pool, status, distributed date) and total paid from `DividendEntry`.
5. **Governance**: `Meeting` rows with `scheduledAt` in year (type, title, status, scheduled date,
   attendance present count, quorum percent, motion count), and an "AGM held" yes/no line.

All money is integer kobo formatted with the existing `formatBalance`; percentages use the existing
`pct` style. Reads run inside the caller's `withCoopContext` transaction.

### 6.3 Generation and filing

- `generateReport` selects the pack by type:
  - `statutory` -> `periodType === "annual" ? annualPack : statutoryPack`
  - `nfiu` -> `nfiuPack` (annual range supported by `periodRange`)
  - `both` -> the two above.
- Validation: annual periods must match `/^\d{4}$/`; `generateReport` rejects malformed period
  keys for all types (defense in depth alongside route validation).
- Regeneration keeps existing status/filedAt and does not clear acknowledgement fields.
- `markFiled(coopId, reportId, actor, filing?)` where
  `filing?: { acknowledgementId?: string; note?: string }`:
  - trims values, caps acknowledgement at 80 chars and note at 500;
  - stores `status: "filed"`, `filedAt`, `acknowledgementId`, and the note in the existing
    `notes` column;
  - if already filed and no new filing values, returns the existing "already marked filed" message;
  - if already filed with new values, updates acknowledgement/note and audits
    `regulator.report_acknowledged`;
  - audit `regulator.report_filed` detail includes the acknowledgement when present.
- `ReportSummary` gains `acknowledgementId` and `notes`; `listReports` returns them.
- Chat command `regreport filed <id>` keeps working (filing arg omitted).

## 7. API (developer console, `src/routes/developer.ts`)

All routes inherit the existing preHandler: platform cookie/Bearer auth, revocation check,
live-admin check, CSRF `X-Requested-With` on non-GET, `mustChangePin` gate, and
support-role read-only (GET allowed, POST 403).

- `GET /api/developer/coops/:id/regulator-reports`
  - 404 if the coop does not exist.
  - 200 `{ profile: { label, type, contactEmail, monthlyDueDay, quarterlyDueDay, annualDueMonth,
    annualDueDay } | null, reports: ReportSummary[] }`.
- `POST /api/developer/coops/:id/regulator-reports`
  - Body `{ year?: number|string, packType?: "statutory"|"nfiu"|"both" }` (default `statutory`).
  - 400 on a year that is not a 4-digit integer, is before 2000, or is in the future; 400 on an
    unknown pack type; 404 on unknown coop.
  - 200 `{ ok, reportId, dueAt, files, links, message }` from `generateReport(..., "annual", ...)`.
  - Errors from file/S3/SMTP are already contained by `generateReport`; unexpected errors return
    500 with a generic message and `req.log.error`.
- `POST /api/developer/coops/:id/regulator-reports/:reportId/file`
  - Body `{ acknowledgementId?: string, note?: string }`.
  - 404 if no report in that coop matches the id; 400 if acknowledgement is longer than 80 chars or
    note longer than 500.
  - 200 `{ ok, message }`; already-filed-without-changes returns 200 and the existing message.

## 8. Console UI (`dashboard/dev/dev.js`)

New "Regulator returns" card inside the coop detail tab panel, next to the existing compliance card:

- Header shows the active regulator label and due days (monthly/quarterly/annual).
- Controls: year select (current year and the two prior), pack type select, "Generate annual pack"
  button (hidden for support/read-only).
- Table: period, type, status, due date, filed date, acknowledgement, download links
  (`xlsx`/`pdf` from `files`), and a "Mark filed" action opening inline inputs for acknowledgement
  and note.
- Data loaded in `renderCoopDetail` via the new GET route alongside the existing detail/activity
  fetches; handlers `window.generateAnnualReport(coopId)` and
  `window.fileRegulatorReport(coopId, reportId)` follow the existing `api()` +
  `X-Requested-With` pattern and re-render the detail on success.
- Empty state: "No annual returns generated yet."

## 9. Security and tenancy

- Every read/write is coop-scoped: `generateReport`/`markFiled` use `withCoopContext`/`withTx` +
  `setCoopContext`; `listReports` filters by `cooperativeId`.
- Routes are platform-owner routes; the coop id comes from the URL and is existence-checked first,
  then every read/write goes through the coop-scoped service. No cross-coop data is returned, and
  an unknown id yields 404 rather than leaking whether a report exists elsewhere.
- Support role cannot generate or file (preHandler enforces).
- Acknowledgement/note are user-supplied strings rendered with the console's existing `esc()`
  helper (no HTML injection).

## 10. Testing

`tests/regulator-reporting.test.ts` (extend):
- `reportPeriod(new Date("2026-07-15"), "annual") === "2026"`.
- `periodRange` annual bounds (Jan 1 00:00:00.000Z to Dec 31 23:59:59.999Z) via P&L inclusion of a
  Dec 31 contribution and exclusion of a Jan 1 next-year contribution.
- `periodDueAt("2026", "annual", { annualDueMonth: 3, annualDueDay: 31 })` -> 2027-03-31 UTC.
- `annualPack` contains the five expected sheet names and correct seeded values (identity fields,
  opening/joined/closing counts, reserve/education/development sums, dividend pool, AGM attendance).
- `generateReport(coop, "2026", "annual", "statutory")` stores `periodType: "annual"`, correct
  `dueAt`, and is idempotent (second call updates the same row).
- Regenerating a filed annual pack preserves `status`, `filedAt`, `acknowledgementId`.- `markFiled` with acknowledgement/note persists both, writes the audit row, and a repeat call with
  new values updates without un-filing; `listReports` exposes them.

`tests/developer-regulator-reports.test.ts` (new):
- GET returns profile + reports; 404 unknown coop.
- POST generates an annual pack (deps seam or real files in a temp `EXPORT_DIR`), 400 invalid
  (`"26"`, `1999`, future year, `"bogus"` pack), 404 unknown coop.
- POST file stores acknowledgement, 404 unknown report id, 400 over-length note.
- Support role: GET 200, POST 403; missing `X-Requested-With` -> 403 (existing preHandler).

No UI test harness exists; the card is verified manually against a seeded coop (documented in the
implementation plan's verification step).

## 11. Risks and mitigations

- **Heavy annual queries** (12-month P&L, PEARLS, funds, meetings) could be slow for large co-ops:
  generation is on-demand, runs in one read transaction, and file I/O happens outside it.
- **Calendar-year assumptions**: statutory year is Jan-Dec; UTC bounds may differ by hours from
  local time. Documented in the pack's cover sheet note.
- **No membership exit history**: the movement sheet is honest about current-status breakdowns
  rather than inventing period exits.
- **Self-reported acknowledgement**: clearly labelled as registrar-provided; no verification.
- **Additive migration**: nullable/defaulted columns only; no backfill required.

## 12. Rollout

1. Schema + migration.
2. Service changes (period math, `annualPack`, filing fields) with tests.
3. Developer routes with tests.
4. Console card.
5. Full gates (`typecheck`, `lint`, `format:check`, full test suite) and manual console check.
6. Optional follow-up (separate change): annual scheduler generation and due reminders.
