# Group / VSLA / ROSCA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add group savings products — ROSCA (rotating pot), VSLA (shares + loan fund + social fund + share-out), and joint-liability group loans — all scoped within a cooperative.

**Architecture:** `Group` + `GroupMember` + `GroupCycle` + `GroupContribution`. ROSCA pays the pot to the next member in rotation; VSLA accumulates shares and shares out at cycle end. Group loans reuse the existing `Loan` machinery with an optional `groupId` and the group as guarantor.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 4, Feature 6).

## Global Constraints
- Money integer kobo; `.js` imports; both schemas identical; no Prisma `enum`; new `cooperativeId` tables need RLS + FORCE-list entries.
- User decisions (2026-10-06): all three products; groups within a coop; ROSCA fixed contribution + rotation; VSLA shares + loan fund + social fund + share-out; joint-liability group loans.
- Verification per task: typecheck clean, lint 0 errors, targeted tests green.

---

### Task 1: Schema, migrations, RLS

**Files:** both schemas; `prisma/migrations/20261027000000_groups/migration.sql`; `prisma/migrations/20261028000000_groups_rls/migration.sql`; `prisma/rls/recommended_policies.sql`.

**Interfaces produced:**
- `Group` (id, cooperativeId, type `// rosca | vsla`, name, code, status `@default("active")`, contributionAmount `Int`, cycleLength `Int`, createdById, createdAt; `@@unique([cooperativeId, code])`).
- `GroupMember` (id, groupId, memberId, joinedAt, rotationPosition `Int?`, shares `Int @default(0)`, active `Boolean @default(true)`; `@@unique([groupId, memberId])`).
- `GroupCycle` (id, groupId, cycleNumber `Int`, status `@default("open")` `// open | closed`, startedAt, endedAt?, payoutMemberId?, shareOutAmount `Int?`; `@@unique([groupId, cycleNumber])`).
- `GroupContribution` (id, groupId, cycleId, memberId, amount `Int`, createdAt).
- `Loan.groupId String?` + relation.
- Relations on `Cooperative`, `Member`, `Group`.

- [ ] Add models + `Loan.groupId` + relations to both schemas.
- [ ] Migration `20261027000000_groups`: create the 4 tables, indexes, FKs; add `Loan.groupId`.
- [ ] RLS migration `20261028000000_groups_rls`: `Group`/`GroupCycle` carry `cooperativeId` → direct policy; `GroupMember`→`Group`, `GroupContribution`→`Group` → parent-resolver policy.
- [ ] Add all four to the FORCE list in `prisma/rls/recommended_policies.sql`.
- [ ] `npm run prisma:generate:local`; `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`; `npx vitest run tests/schema-sync.test.ts` passes.
- [ ] Commit `feat(groups): group schema, migration, RLS`.

### Task 2: Group service + commands (ROSCA + VSLA)

**Files:** `src/services/groups.ts` (new), `src/services/admin.ts`, `src/services/conversation.ts`, `src/services/handlers/session.ts`, `tests/groups.test.ts` (new).

**Interfaces produced:** `createGroup(coopId, type, name, code, contributionAmount, cycleLength, actor)`, `joinGroup(coopId, groupCode, memberId)`, `contributeToGroup(coopId, groupId, memberId, amount)`, `closeGroupCycle(coopId, groupId, actor)` (ROSCA: pay the pot to the next rotation member; VSLA: compute share-out by shares), `listGroups(coopId)`, `groupStatus(coopId, groupId)`.

- [ ] **Tests (red):** create a ROSCA, members join (rotation assigned), each contributes, closing the cycle pays the pot to the next member and advances rotation; create a VSLA, members buy shares, closing the cycle shares out by shares; a non-member cannot contribute; duplicate join refused.
- [ ] Implement `groups.ts` (contributions credit the group pot via the ledger; ROSCA payout and VSLA share-out post balanced journals; audited).
- [ ] Admin commands: `newgroup <rosca|vsla> <name> <code> <amount> <cycleLength>`, `closegroupcycle <group id>`, `groups`. Member commands: `joingroup <code>`, `groupcontribute <group id> <amount>`, `mygroups`, `groupstatus <group id>`. Add to the menus.
- [ ] **Verify:** `npx vitest run tests/groups.test.ts`; typecheck; lint.
- [ ] Commit `feat(groups): ROSCA and VSLA service and commands`.

### Task 3: Joint-liability group loans + docs

**Files:** `src/services/groups.ts`, `src/services/loans.ts`, `tests/groups.test.ts`, `README.md`.

**Interfaces produced:** `applyGroupLoan(coopId, groupId, memberId, amount, months)` — creates a `Loan` with `groupId` set and the group as joint guarantor; on default the group is liable.

- [ ] **Tests (red):** a group member applies for a group loan; the loan records `groupId`; the group is treated as guarantor (the loan can be approved without individual guarantors when the group is active); a non-member cannot apply.
- [ ] Implement `applyGroupLoan` reusing the existing loan creation + approval machinery (set `groupId`, skip individual guarantors when the group guarantees).
- [ ] Add a `## Groups (ROSCA / VSLA)` section to `README.md`.
- [ ] **Verify:** full gate + `npm test`.
- [ ] Commit `feat(groups): joint-liability group loans and docs`.
