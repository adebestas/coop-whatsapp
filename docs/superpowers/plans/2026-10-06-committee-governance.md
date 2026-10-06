# Committee Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add formal committees — **Credit**, **Supervisory/Audit**, **Board** — appointed by the super admin. The Credit Committee replaces the two super-admin loan signatures (admin first-approval → Credit Committee majority → disbursement). The Supervisory/Audit Committee gets read-only oversight plus the power to freeze/suspend pending review.

**Architecture:** `Committee` + `CommitteeMember` (a member can sit on several committees, with a term) + a generic `CommitteeDecision`/`CommitteeVote` pair so decisions work for loans and future subjects. Loan approval branches on whether the coop has an active Credit Committee.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 2, Feature 3).

## Global Constraints
- Money integer kobo; `.js` imports; both schemas identical; no Prisma `enum`; new `cooperativeId` tables need RLS + FORCE-list entries.
- User decisions (2026-10-06): all three committees; super admin appoints; Credit Committee **replaces the two super signatures** (admin → committee majority → disburse); Supervisory has oversight **and** freeze/suspend; sizes Credit 3 / Supervisory 3 / Board 5, configurable; Credit decision needs a majority.
- Backward compatibility: a coop with **no** active Credit Committee keeps the existing admin→super→super chain.
- Verification per task: typecheck clean, lint 0 errors, targeted tests green.

---

### Task 1: Schema, config, migrations, RLS

**Files:** both schemas; `prisma/migrations/20261020000000_committees/migration.sql`; `prisma/migrations/20261021000000_committees_rls/migration.sql`; `prisma/rls/recommended_policies.sql`.

**Interfaces produced:**
- `Committee` (id, cooperativeId, type `String` `// credit | supervisory | board`, name, size `Int`, createdAt; `@@unique([cooperativeId, type])`).
- `CommitteeMember` (id, committeeId, memberId, role `String` `// chair | member`, appointedById, appointedAt, termEndsAt?, active `Boolean @default(true)`; `@@unique([committeeId, memberId])`).
- `CommitteeDecision` (id, cooperativeId, committeeId, subjectType `String` `// loan`, subjectId, status `String @default("pending")` `// pending | approved | rejected`, createdAt, decidedAt?; `@@unique([committeeId, subjectType, subjectId])`).
- `CommitteeVote` (id, decisionId, memberId, vote `String` `// approve | reject`, createdAt; `@@unique([decisionId, memberId])`).
- `CooperativeConfig.creditCommitteeSize Int @default(3)`, `supervisoryCommitteeSize Int @default(3)`, `boardSize Int @default(5)`.
- Relations on `Cooperative`, `Member` (appointedBy + memberships + votes).

- [ ] Add models + config fields + relations to both schemas.
- [ ] Migration `20261020000000_committees`: create the 4 tables, indexes, FKs; add the 3 config columns.
- [ ] RLS migration `20261021000000_committees_rls`: `Committee`, `CommitteeDecision` carry `cooperativeId` → direct policy; `CommitteeMember`/`CommitteeVote` are child tables reached via a tenant parent → parent-resolver policy (copy the child pattern from `20261005000000_rls_policies`).
- [ ] Add all four to the FORCE list in `prisma/rls/recommended_policies.sql` (direct group: `Committee`, `CommitteeDecision`; child group: `CommitteeMember`→`Committee`, `CommitteeVote`→`CommitteeDecision`).
- [ ] `npm run prisma:generate:local`; `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`; `npx vitest run tests/schema-sync.test.ts` passes.
- [ ] Commit `feat(governance): committee schema, migration, RLS`.

### Task 2: Committee service + admin commands

**Files:** `src/services/committees.ts` (new), `src/services/admin.ts` (commands), `src/services/handlers/session.ts` (admin menu), `tests/committees.test.ts` (new).

**Interfaces produced:** `createCommittee(coopId, type, name, size)`, `appointMember(coopId, type, memberCode, role)`, `removeMember(coopId, type, memberCode)`, `listCommittees(coopId)`, `isCommitteeMember(coopId, type, memberId)`, `committeeMajority(size)` = `Math.floor(size/2)+1`.

- [ ] **Tests (red):** create a credit committee (size 3), appoint 3 members, list it; a non-super cannot create/appoint; a member cannot be appointed twice.
- [ ] Implement `committees.ts` (super-admin-gated create/appoint/remove; audit each action).
- [ ] Admin commands in `handleAdminCommand`: `addcommittee <credit|supervisory|board> <name> [size]`, `appoint <type> <member code> [chair]`, `removecommittee <type> <member code>`, `committees` (list). Add to `buildAdminMenu`.
- [ ] **Verify:** `npx vitest run tests/committees.test.ts`; typecheck; lint.
- [ ] Commit `feat(governance): committee service and admin commands`.

### Task 3: Credit Committee loan approval + Supervisory freeze

**Files:** `src/services/committees.ts` (decision logic), `src/services/loans.ts` (branch in `approveLoan`), `src/services/admin.ts` (commands), `tests/committees.test.ts`, `tests/loans*.test.ts`.

**Interfaces produced:** `recordCommitteeVote(coopId, type, subjectType, subjectId, memberId, vote)` → `{ ok, message, decided?: "approved"|"rejected" }`; `hasActiveCommittee(coopId, type)`.

- [ ] **Tests (red):** with an active Credit Committee, a loan at `admin_approved` is approved by 2 of 3 committee members → loan finalizes + disburses; a single vote does not; a non-member cannot vote; a member cannot vote twice; a coop with NO credit committee still uses the super chain.
- [ ] In `approveLoan`, when `loan.status === "admin_approved"` and `hasActiveCommittee(coopId, "credit")`: require the actor to be a Credit Committee member, record a `CommitteeVote` (approve), and when approvals ≥ `committeeMajority(size)` call `finalizeLoanApproval`. Otherwise keep the existing super path.
- [ ] Add `cvote <loan id> approve|reject` (committee members) and `committeequeue` (pending committee decisions) admin commands.
- [ ] Supervisory freeze: `supervisoryfreeze <member code> [reason]` / `supervisoryunfreeze <member code>` — sets `Member.frozenAt` (reuse the existing freeze mechanism) and audits; only Supervisory Committee members or super admins.
- [ ] **Verify:** `npx vitest run tests/committees.test.ts tests/loans.test.ts` (find the real loan test file); typecheck; lint.
- [ ] Commit `feat(governance): credit-committee loan approval and supervisory freeze`.

### Task 4: Docs + full verification

- [ ] Add a `## Committees` section to `README.md` (three committees, appointment, credit-committee loan flow, supervisory freeze).
- [ ] Full gate: `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] Commit `docs(governance): committees`.
