# Regulator Reporting Pack — Design

**Date:** 2026-10-07
**Status:** Approved (design) — pending spec review
**Feature:** Roadmap Phase 3, Feature 7 (Regulator reporting pack)
**Branch:** `feat/world-class`

## Goal

Give cooperatives a **regulator reporting pack**: statutory financial returns and
NFIU AML summaries, generated on demand and on a schedule, in Excel + PDF + CSV,
with filing due-date tracking — so a coop can meet its state Ministry / CBN / NFIU
obligations from inside WhatsApp.

## Decisions (user, 2026-10-07)

1. **Contents:** **both** statutory financial returns (balance sheet, P&L, PAR,
   PEARLS, membership, savings/loans) **and** NFIU AML summaries (STR/SAR counts,
   large-transaction reports).
2. **Formats:** **Excel + PDF + CSV**, reusing the existing export infra.
3. **Generation:** **on-demand command + scheduled auto-generation** (monthly +
   quarterly), archived with a due-date reminder.
4. **Periods/regulator:** **monthly + quarterly**; the regulator target is
   **per-coop configurable** (state Ministry, CBN, NFIU, or a custom label) with a
   filing due date (monthly by the 10th, quarterly by the 15th by default).
5. **Read-only:** pack generation only formats existing ledger/AML data — no new
   accounting.
6. **Filing is manual:** the pack marks `generated`; an admin confirms `filed`; we
   track the due date. No auto-submission to any regulator portal.

## Non-goals

- No USSD/SMS (WhatsApp-only program constraint).
- No new accounting/ledger logic — the pack reports what already exists.
- No regulator-portal submission (manual filing with tracked status only).
- No federation (separate feature).

## Architecture

### Data model (both `schema.prisma` and `schema.local.prisma`; migration + RLS)

**`RegulatorProfile`** (per-coop)
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `cooperativeId` | String | RLS tenant key |
| `label` | String | e.g. "Lagos State Ministry of Cooperatives" |
| `type` | String | `ministry` \| `cbn` \| `nfiu` \| `custom` |
| `contactEmail` | String? | for the pack + reminders |
| `monthlyDueDay` | Int @default(10) | day of month |
| `quarterlyDueDay` | Int @default(15) | day after quarter end |
| `active` | Boolean @default(true) | |
| `createdAt` | DateTime @default(now()) | |

Index: `@@index([cooperativeId, active])`.

**`RegulatorReport`** (per-coop, per period)
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `cooperativeId` | String | RLS tenant key |
| `period` | String | `YYYY-MM` (the reporting period) |
| `periodType` | String | `monthly` \| `quarterly` |
| `packType` | String | `statutory` \| `nfiu` \| `both` |
| `status` | String @default("generated") | `generated` \| `filed` |
| `generatedAt` | DateTime @default(now()) | |
| `generatedById` | String? | admin, or null for scheduled |
| `files` | String? | JSON `{ xlsx, pdf, csv }` keys/paths |
| `dueAt` | DateTime? | filing due date |
| `filedAt` | DateTime? | |
| `notes` | String? | |
| Unique: `@@unique([cooperativeId, period, periodType, packType])` | | idempotent regeneration |
| Index: `@@index([cooperativeId, status])` | | |

**`CooperativeConfig.regulatorReportingEnabled`** (Boolean, default false).

**RLS:** both tables carry `cooperativeId` → Stage-1 direct policy + FORCE-list
entries.

### Statutory financial returns (per period)

Sourced from the **existing** services — no new accounting:
- Balance sheet + P&L (ledger: `computePnl` / `recordLedger` data).
- PAR aging + PEARLS ratios (provisioning).
- Membership counts, savings/loans/withdrawals summaries, reserve fund.

### NFIU AML summaries (per period)

Sourced from `aml.ts`:
- STR/SAR counts + status for the period.
- Large-transaction (≥ ₦5M) list.
- Aggregate/structuring flags.

### Output

Excel + PDF + CSV via the existing export infra (`exports.ts` uses xlsx + pdf).
Files are written to the export dir / S3 and recorded in `RegulatorReport.files`.

### Commands

- Admin/super: `regreport <period> <statutory|nfiu|both>` (generate + send the
  files), `regulatorconfig [label] [type] [email] [monthlyDue] [quarterlyDue]`,
  `regreportstatus` (list generated/filed), `regreport filed <id>` (mark filed).

### Scheduler (`runRegulatorReports`)

For each coop with reporting enabled: auto-generate the monthly pack after
month-end (and the quarterly pack after quarter-end), archive it, and send a
**filing due-date reminder** to the admins. Idempotent (one pack per period/type).

### Security

- Commands gated to admin/superadmin.
- Every generation + filing action is audited.
- Files are tenant-scoped (in the coop's export namespace).
- Coop-scoped writes via `withTx` + `setCoopContext`; system jobs via `forEachCoop`.

## Testing

- Period math (monthly + quarterly boundaries).
- Statutory pack generation (balance sheet/P&L/PAR/PEARLS present).
- NFIU pack generation (STR counts, large-tx list).
- Due-date reminder + idempotent regeneration.
- `filed` transition + audit.
- RLS/schema-sync.

Full gate per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted
tests green · full suite green · schema-sync green.

## Phasing (one feature, built in order)

1. Schema + `RegulatorProfile` + config.
2. Statutory financial returns pack.
3. NFIU AML summaries pack.
4. Scheduler + due-date reminders.
5. Commands + docs.

## Open risks

- **Report data sources** must be pinned during the plan (ledger balance-sheet
  source, PAR/PEARLS accessor, AML period query).
- **File storage** — reuse the existing export dir/S3; the plan must confirm the
  helper.
- **Quarterly period math** (which months form a quarter) must be explicit.
