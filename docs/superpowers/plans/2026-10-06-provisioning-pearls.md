# Loan-Loss Provisioning + PEARLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add loan-loss provisioning (aging-bucket %) with PAR aging, and a full WOCCU PEARLS ratio dashboard, surfaced via admin commands and the dashboard.

**Architecture:** A `ProvisionRun`/`ProvisionEntry` pair records each provisioning run; the provision posts `expense:loan_loss_provision` / contra-asset `assets:loan_loss_provision` and maintains `Cooperative.loanLossProvisionBalance`. PAR aging is computed from `Loan.dueDate` + `balance`. PEARLS ratios are computed from the existing journal/ledger.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 3, Feature 5).

## Global Constraints
- Money integer kobo; `.js` imports; both schemas identical; no Prisma `enum`; new `cooperativeId` tables need RLS + FORCE-list entries.
- User decisions (2026-10-06): aging-bucket % provisioning (1–30d 1%, 31–90d 5%, 91–180d 20%, 180d+ 50%, configurable); full WOCCU PEARLS; command + dashboard; provisioning posts expense + contra-asset ledger entries.
- Verification per task: typecheck clean, lint 0 errors, targeted tests green.

---

### Task 1: Schema, config, migrations, RLS

**Files:** both schemas; `prisma/migrations/20261025000000_provisioning/migration.sql`; `prisma/migrations/20261026000000_provisioning_rls/migration.sql`; `prisma/rls/recommended_policies.sql`.

**Interfaces produced:**
- `ProvisionRun` (id, cooperativeId, period `String` `// YYYY-MM`, totalProvision `Int`, createdById, createdAt; `@@unique([cooperativeId, period])`).
- `ProvisionEntry` (id, runId, loanId, bucket `String` `// 1-30 | 31-90 | 91-180 | 180+`, amount `Int`, createdAt).
- `Cooperative.loanLossProvisionBalance Int @default(0)`.
- `CooperativeConfig.provisionRates String @default("{\"1-30\":1,\"31-90\":5,\"91-180\":20,\"180+\":50}")`.
- Relations on `Cooperative`, `Loan`, `ProvisionRun`.

- [ ] Add models + fields + relations to both schemas.
- [ ] Migration `20261025000000_provisioning`: create the 2 tables, indexes, FKs; add the `Cooperative` + `CooperativeConfig` columns.
- [ ] RLS migration `20261026000000_provisioning_rls`: `ProvisionRun` carries `cooperativeId` → direct policy; `ProvisionEntry`→`ProvisionRun` → parent-resolver policy.
- [ ] Add both to the FORCE list in `prisma/rls/recommended_policies.sql`.
- [ ] `npm run prisma:generate:local`; `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`; `npx vitest run tests/schema-sync.test.ts` passes.
- [ ] Commit `feat(finance): provisioning schema, migration, RLS`.

### Task 2: PAR + provisioning service + commands

**Files:** `src/services/provisioning.ts` (new), `src/services/admin.ts`, `src/services/handlers/session.ts`, `tests/provisioning.test.ts` (new).

**Interfaces produced:** `computePar(coopId)` → `{ buckets: { "1-30": kobo, "31-90": kobo, "91-180": kobo, "180+": kobo }, total: kobo, parRatio: number }`; `computeProvision(coopId)` → `{ entries: { loanId, bucket, amount }[], total: kobo }`; `runProvision(coopId, actor)` → `{ ok, message, runId?, total? }`; `provisionRates(coopId)`.

- [ ] **Tests (red):** a loan 45 days overdue with balance 100000 and rate 5% → provision 5000; PAR buckets classify by `dueDate` age; `runProvision` creates a `ProvisionRun` + entries, posts a balanced journal (DEBIT `expense:loan_loss_provision` / CREDIT `assets:loan_loss_provision`), and increments `loanLossProvisionBalance`; a second run in the same period is refused (or supersedes); non-admin cannot run.
- [ ] Implement `provisioning.ts` (aging from `Loan.dueDate` for `status in ["disbursed","partial"]` and `balance > 0`; rates from config JSON; `runProvision` in a `withTx` with `setCoopContext`, audited).
- [ ] Admin commands: `par` (aging buckets + PAR ratio), `provision` (run provisioning), `provisionrates` (show rates). Add to `buildAdminMenu`.
- [ ] **Verify:** `npx vitest run tests/provisioning.test.ts`; typecheck; lint.
- [ ] Commit `feat(finance): PAR aging and loan-loss provisioning`.

### Task 3: PEARLS ratios + dashboard + docs

**Files:** `src/services/provisioning.ts` (PEARLS), `src/services/admin.ts` (`pearls` command), `web/` dashboard panel, `tests/provisioning.test.ts`, `README.md`.

**Interfaces produced:** `computePearls(coopId)` → the six PEARLS groups with named ratios (Protection: allowance/loans, net capital; Effective structure: loans/assets, savings/assets; Asset quality: PAR ratio, provision coverage; Rates of return: interest income/assets, cost of funds; Liquidity: liquid assets/savings; Signs of growth: member growth, savings growth).

- [ ] **Tests (red):** `computePearls` returns the six groups with numeric ratios computed from seeded ledger/loan data; a coop with no loans returns zeros without throwing.
- [ ] Implement `computePearls` from the journal (`trialBalance`, `getBankAccountBalance`), loans, and members.
- [ ] Add a `pearls` admin command (formatted summary) and a dashboard panel (reuse the existing dashboard API pattern; add `GET /api/admin/pearls`).
- [ ] Add a `## Loan-loss provisioning & PEARLS` section to `README.md`.
- [ ] **Verify:** full gate + `npm test`.
- [ ] Commit `feat(finance): PEARLS ratios, dashboard and docs`.
