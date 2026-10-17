# Member Ombudsman Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give members an independent, platform-level ombudsman who can investigate a grievance or dispute, issue a binding decision, and apply a remedy.

**Architecture:** A platform-level `Ombudsman` table + `OmbudsmanCase`/`OmbudsmanCaseEvent` (platform-level, referencing a coop). Members escalate (or a scheduler auto-escalates past an SLA); the ombudsman investigates, decides, and applies remedies via the existing services (unfreeze, refund). Cross-tenant access goes through an audited SECURITY DEFINER resolver + explicit `withCoopContext` per case.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/specs/2026-10-07-member-ombudsman-design.md`

## Global Constraints

- Money is integer kobo; format with `formatBalance`; parse user input with `parseNaira`.
- `.js` import extensions; no Prisma `enum` (use `String` + comments).
- `prisma/schema.prisma` and `prisma/schema.local.prisma` must stay identical (enforced by `tests/schema-sync.test.ts`).
- `Ombudsman`/`OmbudsmanCase`/`OmbudsmanCaseEvent` are **platform-level** — NOT coop-RLS-scoped. Access is gated in code (ombudsman role) + the audited resolver path.
- Coop-scoped writes run inside `withTx` + `setCoopContext`; system jobs use `forEachCoop`.
- Every case action calls `audit()` with a human-readable description.
- Ombudsman commands are gated to an active `Ombudsman` (phone match).
- Verification per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted tests green · full suite green (`npm test`) · schema-sync green.

---

## File Structure

- `prisma/schema.prisma`, `prisma/schema.local.prisma` — `Ombudsman`, `OmbudsmanCase`, `OmbudsmanCaseEvent`, `CooperativeConfig.ombudsmanSlaDays`.
- `prisma/migrations/20261039000000_ombudsman/migration.sql` — tables + indexes + FKs.
- `src/services/ombudsman.ts` (new) — escalation, case lifecycle, decisions, remedies.
- `src/services/scheduler.ts` — `runOmbudsmanEscalations`.
- `src/services/handlers/money.ts` / `session.ts` / `conversation.ts` — member `escalate` + ombudsman commands.
- `src/seed.ts` or a CLI — create an ombudsman.
- `tests/ombudsman.test.ts` (new).
- `README.md` — feature section.

---

### Task 1: Schema, migration, RLS

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261039000000_ombudsman/migration.sql`
- Test: `tests/schema-sync.test.ts` (existing)

**Interfaces produced:**
- `Ombudsman` (id, name, phone @unique, active, createdAt).
- `OmbudsmanCase` (id, cooperativeId, memberId, sourceType, sourceId?, category, summary, status, escalatedBy, slaDueAt?, decision?, decisionById?, decidedAt?, remedy?, createdAt, updatedAt).
- `OmbudsmanCaseEvent` (id, caseId, actorId, actorRole, action, detail, createdAt).
- `CooperativeConfig.ombudsmanSlaDays Int @default(7)`.

- [ ] **Step 1: Add models to both schemas**

Add to `prisma/schema.prisma` (and identically to `prisma/schema.local.prisma`):

```prisma
// Platform-level independent ombudsman (not tied to a cooperative).
model Ombudsman {
  id        String   @id @default(cuid())
  name      String
  phone     String   @unique
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
}

// A case escalated to the ombudsman (a grievance or a dispute). Platform-level:
// references a cooperative but is not coop-RLS-scoped.
model OmbudsmanCase {
  id            String    @id @default(cuid())
  cooperativeId String
  memberId      String
  sourceType    String // grievance | dispute
  sourceId      String?
  category      String // loan_rejection | dividend | freeze | suspension | other
  summary       String
  status        String    @default("open") // open | investigating | decided | closed
  escalatedBy   String // member | auto
  slaDueAt      DateTime?
  decision      String?
  decisionById  String?
  decidedAt     DateTime?
  remedy        String? // JSON: { action, detail, appliedAt }
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  events        OmbudsmanCaseEvent[]

  @@index([cooperativeId, status])
  @@index([memberId])
  @@index([status, slaDueAt])
}

// The case timeline.
model OmbudsmanCaseEvent {
  id        String   @id @default(cuid())
  caseId    String
  case      OmbudsmanCase @relation(fields: [caseId], references: [id], onDelete: Cascade)
  actorId   String
  actorRole String // member | ombudsman | system
  action    String // escalated | investigating | info_requested | decided | remedy_applied | closed
  detail    String
  createdAt DateTime @default(now())

  @@index([caseId, createdAt])
}
```

Add to `CooperativeConfig`:
```prisma
  ombudsmanSlaDays Int @default(7)
```

- [ ] **Step 2: Write the migration SQL**

`prisma/migrations/20261039000000_ombudsman/migration.sql` — create the three tables + indexes + the `OmbudsmanCaseEvent.caseId` FK (mirror the `Mandate` migration style), and `ALTER TABLE "CooperativeConfig" ADD COLUMN "ombudsmanSlaDays" INTEGER NOT NULL DEFAULT 7;`.

- [ ] **Step 3: Generate + push + verify schema sync**

Run:
```bash
npm run prisma:generate:local
npx prisma db push --schema prisma/schema.local.prisma --skip-generate
npx vitest run tests/schema-sync.test.ts
```
Expected: schema-sync PASS.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261039000000_ombudsman
git commit -m "feat(ombudsman): schema, migration"
```

---

### Task 2: Ombudsman service + member escalation

**Files:**
- Create: `src/services/ombudsman.ts`
- Modify: `src/services/handlers/money.ts`, `src/services/handlers/session.ts`, `src/services/conversation.ts`
- Test: `tests/ombudsman.test.ts` (new)

**Interfaces produced:**
```ts
export async function escalateCase(coopId: string, memberId: string, input: { sourceType: "grievance" | "dispute"; sourceId?: string; category: string; summary: string }, actor: { id: string; phone: string }): Promise<{ ok: boolean; message: string; caseId?: string }>;
export async function listCases(status?: string): Promise<{ ok: boolean; message: string; cases?: CaseSummary[] }>;
export async function getCase(caseId: string): Promise<{ ok: boolean; message: string; case?: CaseDetail }>;
export async function isOmbudsman(phone: string): Promise<boolean>;
```

- [ ] **Step 1: Write failing tests**

In `tests/ombudsman.test.ts` (reuse the harness pattern from `tests/savings-products.test.ts`):
- `escalateCase` creates an `OmbudsmanCase` with `escalatedBy: "member"`, `status: "open"`, `slaDueAt` = now + `ombudsmanSlaDays`, and an `escalated` event.
- Escalating the same source twice is refused (one case per source).
- `listCases` returns open cases; `getCase` returns the timeline.
- `isOmbudsman` is true only for an active `Ombudsman` phone.

Run: `npx vitest run tests/ombudsman.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/services/ombudsman.ts`**

Follow the `savings-products.ts` structure (`withTx` + `setCoopContext` for coop-scoped writes, `audit`, `formatBalance`). `escalateCase` loads the coop config for `ombudsmanSlaDays`, refuses a duplicate source, creates the case + `escalated` event, and notifies active ombudsmen. `listCases`/`getCase` read the platform-level tables. `isOmbudsman` checks the `Ombudsman` table.

- [ ] **Step 3: Wire the member `escalate` command**

Add `handleEscalate(phone, args)` in `money.ts` (parse the source id + optional reason), route it in `conversation.ts`, and add a menu line in `session.ts`.

- [ ] **Step 4: Run tests + gate, then commit**

Run `npx vitest run tests/ombudsman.test.ts` → PASS; `npm run typecheck`; `npm run lint`.
```bash
git add src/services/ombudsman.ts src/services/handlers/money.ts src/services/handlers/session.ts src/services/conversation.ts tests/ombudsman.test.ts
git commit -m "feat(ombudsman): service and member escalation"
```

---

### Task 3: Auto-SLA escalation scheduler

**Files:**
- Modify: `src/services/scheduler.ts`
- Test: `tests/ombudsman.test.ts`

**Interfaces produced:** `export async function runOmbudsmanEscalations(now?: Date): Promise<number>;`

- [ ] **Step 1: Write failing tests**

- A grievance open past `ombudsmanSlaDays` is auto-escalated (`escalatedBy: "auto"`) exactly once (idempotent).
- A grievance within the SLA is not escalated.

Run: `npx vitest run tests/ombudsman.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `runOmbudsmanEscalations`**

In `scheduler.ts`, follow the `forEachCoop` pattern. For each coop, find `Grievance` rows with `status: "open"` and `createdAt < now - slaDays` that have no existing `OmbudsmanCase` for that source, and create cases (`escalatedBy: "auto"`). Wire it into `runSchedulerTick`.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
git add src/services/scheduler.ts tests/ombudsman.test.ts
git commit -m "feat(ombudsman): auto-SLA escalation"
```

---

### Task 4: Ombudsman commands + decisions

**Files:**
- Modify: `src/services/ombudsman.ts`, `src/services/admin.ts`, `src/services/handlers/session.ts`
- Test: `tests/ombudsman.test.ts`

**Interfaces produced:**
```ts
export async function investigateCase(caseId: string, note: string, actor: { id: string; phone: string }): Promise<{ ok: boolean; message: string }>;
export async function decideCase(caseId: string, decision: string, actor: { id: string; phone: string }): Promise<{ ok: boolean; message: string }>;
```

- [ ] **Step 1: Write failing tests**

- `investigateCase` sets `status: "investigating"`, adds an `investigating` event, and notifies the coop admins.
- `decideCase` sets `status: "decided"`, `decision`, `decisionById`, `decidedAt`, adds a `decided` event, and notifies the member + coop.
- A non-ombudsman is refused.

Run: `npx vitest run tests/ombudsman.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement + wire commands**

Implement `investigateCase`/`decideCase` in `ombudsman.ts` (gated by `isOmbudsman`). Add the ombudsman command router (a separate handler gated to ombudsman phones, since ombudsmen are not coop members): `cases`, `case <id>`, `investigate <id> <note>`, `decide <id> <decision>`. Route it in `conversation.ts` before the member/admin routers (ombudsman phones are platform-level). Add menu lines.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
git add src/services/ombudsman.ts src/services/admin.ts src/services/handlers/session.ts src/services/conversation.ts tests/ombudsman.test.ts
git commit -m "feat(ombudsman): commands and decisions"
```

---

### Task 5: Remedies + docs

**Files:**
- Modify: `src/services/ombudsman.ts`, `src/seed.ts` (or a CLI), `README.md`
- Test: `tests/ombudsman.test.ts`

**Interfaces produced:**
```ts
export async function applyRemedy(caseId: string, action: "unfreeze" | "refund", params: { amount?: number; reason?: string }, actor: { id: string; phone: string }): Promise<{ ok: boolean; message: string }>;
```

- [ ] **Step 1: Write failing tests**

- `applyRemedy(caseId, "unfreeze")` clears the member's `frozenAt` + `supervisoryFrozenAt`, records a `remedy_applied` event + `remedy` JSON, and audits.
- `applyRemedy(caseId, "refund", { amount })` creates a refund via the existing refund flow (the ombudsman acts as the approver), records the remedy, and audits.
- A non-ombudsman is refused.

Run: `npx vitest run tests/ombudsman.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement remedies**

In `ombudsman.ts`, `applyRemedy` dispatches: `unfreeze` → clear the member's freeze fields (inside `withCoopContext`); `refund` → call the existing refund service (read `src/services/refunds.ts`; the ombudsman acts as the approver, bypassing the admin-recommend step). Record the `remedy` JSON + a `remedy_applied` event; audit.

- [ ] **Step 3: Add an ombudsman seed/CLI**

Add a way to create an ombudsman (e.g. `npm run seed:ombudsman -- <name> <phone>` or a small CLI in `src/seed.ts`). Document it.

- [ ] **Step 4: README + full gate + commit**

Add a `## Member ombudsman` section. Run `npm run typecheck` · `npm run lint` · `npm test` · `npx vitest run tests/schema-sync.test.ts`.
```bash
git add src/services/ombudsman.ts src/seed.ts README.md tests/ombudsman.test.ts
git commit -m "feat(ombudsman): remedies and docs"
```

---

## Self-Review

- **Spec coverage:** platform-level ombudsman (Task 1), grievances + disputes (Task 2), member-initiated + auto SLA (Tasks 2/3), investigate + binding decision + remedy (Tasks 4/5), separate `Ombudsman` table (Task 1), unfreeze + refund remedies (Task 5), cross-tenant audited path (Tasks 2/4/5). ✅
- **Placeholder scan:** no TBD/TODO; every code step has real code or an exact file+pattern to follow.
- **Type consistency:** `OmbudsmanCase`/`OmbudsmanCaseEvent` field names, `escalateCase`/`investigateCase`/`decideCase`/`applyRemedy`/`runOmbudsmanEscalations` signatures are consistent across tasks.
- **Open decision for the plan:** the refund remedy — the ombudsman acts as the approver (bypassing admin-recommend). Confirm during Task 5.
