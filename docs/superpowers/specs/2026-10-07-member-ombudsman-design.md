# Member Ombudsman — Design

**Date:** 2026-10-07
**Status:** Approved (design) — pending spec review
**Feature:** Roadmap Phase 2, Feature 5 (Member ombudsman)
**Branch:** `feat/world-class`

## Goal

Give members an **independent escalation tier above cooperative admins**: a
platform-level ombudsman who can investigate a grievance or dispute, issue a
binding decision, and apply a remedy — so members are not solely dependent on the
coop's own admins for justice.

## Decisions (user, 2026-10-07)

1. **Who:** a **platform-level (cross-cooperative) ombudsman**, independent of any
   coop's admins. One or more ombudsmen serve all cooperatives.
2. **What:** **grievances + disputes** — the existing grievance flow, plus specific
   disputes (loan rejections, dividend/share disputes, freezes, suspensions).
3. **Trigger:** **member-initiated** (after the coop resolves/rejects) **plus
   auto-escalation** when the coop leaves a case unresolved past an SLA.
4. **Powers:** **investigate + binding decision + direct remedy** (the ombudsman can
   apply a remedy via the existing services).
5. **Identity:** a separate platform-level `Ombudsman` table (not a coop `Member`).
6. **Remedies (initial set):** **unfreeze** and **refund** (via the existing refund
   flow); more can be added later.

## Non-goals

- No USSD/SMS (WhatsApp-only program constraint).
- No federation/inter-coop lending (separate feature).
- No change to the existing grievance intake/resolve flow (the ombudsman sits above it).

## Architecture

### Cross-tenant access (the risky part)

A platform-level ombudsman is cross-cooperative, which touches the RLS tenant
model. `OmbudsmanCase` is a **platform-level table** (not coop-RLS-scoped) that
*references* a cooperative. The ombudsman reads/writes cases through a dedicated,
audited path: a SECURITY DEFINER resolver to discover the owning coop, then an
explicit `withCoopContext` per case for any coop-scoped read/write (e.g. applying a
remedy). Never a blanket RLS bypass. This mirrors the resolver pattern already used
for webhooks (`resolve_coop_by_mandate_debit_ref`, etc.).

### Data model (both `schema.prisma` and `schema.local.prisma`; migration + RLS)

**`Ombudsman`** (platform-level)
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `name` | String | |
| `phone` | String @unique | E.164 |
| `active` | Boolean @default(true) | |
| `createdAt` | DateTime @default(now()) | |

**`OmbudsmanCase`** (platform-level; references a coop)
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `cooperativeId` | String | the coop the case concerns |
| `memberId` | String | the complainant |
| `sourceType` | String | `grievance` \| `dispute` |
| `sourceId` | String? | grievance id / dispute reference |
| `category` | String | `loan_rejection` \| `dividend` \| `freeze` \| `suspension` \| `other` |
| `summary` | String | |
| `status` | String @default("open") | `open` \| `investigating` \| `decided` \| `closed` |
| `escalatedBy` | String | `member` \| `auto` |
| `slaDueAt` | DateTime? | |
| `decision` | String? | |
| `decisionById` | String? | the ombudsman |
| `decidedAt` | DateTime? | |
| `remedy` | String? | JSON: `{ action, detail, appliedAt }` |
| `createdAt` | DateTime @default(now()) | |
| `updatedAt` | DateTime @updatedAt | |

Indexes: `@@index([cooperativeId, status])`, `@@index([memberId])`,
`@@index([status, slaDueAt])`.

**`OmbudsmanCaseEvent`** (case timeline)
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `caseId` | String | |
| `actorId` | String | member / ombudsman / system |
| `actorRole` | String | `member` \| `ombudsman` \| `system` |
| `action` | String | `escalated` \| `investigating` \| `info_requested` \| `decided` \| `remedy_applied` \| `closed` |
| `detail` | String | |
| `createdAt` | DateTime @default(now()) | |

Index: `@@index([caseId, createdAt])`.

**`CooperativeConfig.ombudsmanSlaDays`** (Int, default 7).

**RLS:** `OmbudsmanCase`/`OmbudsmanCaseEvent` are platform-level — they are **not**
coop-RLS-scoped (no `cooperativeId` policy); access is gated in code by the
ombudsman role + the audited resolver path. `Ombudsman` is platform-level too.

### Escalation

- **Member:** `escalate <grievance id | dispute ref> [reason]` → creates an
  `OmbudsmanCase` (`escalatedBy: "member"`), sets `slaDueAt`, records an
  `escalated` event, and notifies the ombudsman(s).
- **Auto:** a scheduler job (`runOmbudsmanEscalations`) finds grievances open past
  `ombudsmanSlaDays` (and unresolved disputes) and creates cases
  (`escalatedBy: "auto"`). Idempotent (one case per source).

### Ombudsman commands (platform-level, cross-coop)

- `cases` — open cases across all coops.
- `case <id>` — full timeline.
- `investigate <id> <note>` — request info from the coop (notifies the coop admins).
- `decide <id> <decision>` — records a binding decision; notifies member + coop.
- `remedy <id> <action>` — applies a remedy via the existing services.

### Remedies (initial set)

- **unfreeze** — clears the member's freeze (via the existing freeze service).
- **refund** — creates a refund via the existing refund flow (admin-recommend /
  super-admin-approve is bypassed for an ombudsman remedy, or the ombudsman acts as
  the approver — decide in the plan).

Each remedy is audited and recorded on the case (`remedy` JSON + a
`remedy_applied` event).

### Security

- Ombudsman commands are gated to the `Ombudsman` table (phone match, active).
- Every case action is audited.
- Cross-tenant reads go through the audited resolver path; coop-scoped writes run
  inside `withCoopContext`.
- The member + coop are notified of decisions.

## Testing

- Escalation (member-initiated + auto SLA), idempotent auto-escalation.
- Case timeline events.
- Decision + remedy (unfreeze, refund) applied via existing services.
- Cross-tenant isolation: an ombudsman sees cases across coops; a coop admin does
  not see another coop's cases.
- RLS/schema-sync.

Full gate per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted
tests green · full suite green · schema-sync green.

## Phasing (one feature, built in order)

1. Schema + `Ombudsman` + escalation (member-initiated).
2. Auto-SLA scheduler.
3. Ombudsman commands + decisions.
4. Remedies (unfreeze, refund) + docs.

## Open risks

- **Cross-tenant access** is the riskiest area; the resolver + explicit-context
  pattern must be audited carefully.
- **Ombudsman identity** is a new platform-level concept (no existing platform-user
  table); the plan must define how ombudsmen are created (seed/CLI/admin).
- **Refund remedy** interacts with the maker-checker refund flow; the plan must
  decide whether the ombudsman bypasses or acts as the approver.
