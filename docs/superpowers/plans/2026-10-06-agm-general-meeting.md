# AGM / General Meeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Structured general meetings — Annual (AGM) and Special (SGM) — with attendance, proxy voting, quorum, motions/resolutions (general, bylaw, dividend ratification, elections), and auto-generated minutes.

**Architecture:** `Meeting` + `MeetingAttendance` (with proxy) + `Motion` + `MotionVote`. Quorum is a configurable % of active members. Minutes are generated from the meeting's data and exported via the existing PDF/Excel pipeline.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 2, Feature 4).

## Global Constraints
- Money integer kobo; `.js` imports; both schemas identical; no Prisma `enum`; new `cooperativeId` tables need RLS + FORCE-list entries.
- User decisions (2026-10-06): AGM + SGM; general motions + key votes (bylaw/dividend/election); proxies allowed; quorum = configurable % of active members (default 25%); auto-generate minutes + export.
- Verification per task: typecheck clean, lint 0 errors, targeted tests green.

---

### Task 1: Schema, config, migrations, RLS

**Files:** both schemas; `prisma/migrations/20261023000000_meetings/migration.sql`; `prisma/migrations/20261024000000_meetings_rls/migration.sql`; `prisma/rls/recommended_policies.sql`.

**Interfaces produced:**
- `Meeting` (id, cooperativeId, type `// agm | sgm`, title, status `@default("scheduled")` `// scheduled | open | closed`, scheduledAt, openedAt?, closedAt?, quorumPercent `Int @default(25)`, createdById, createdAt).
- `MeetingAttendance` (id, meetingId, memberId, present `Boolean @default(true)`, proxyForMemberId?, createdAt; `@@unique([meetingId, memberId])`).
- `Motion` (id, meetingId, cooperativeId, title, description, kind `@default("general")` `// general | bylaw | dividend | election`, status `@default("open")` `// open | passed | rejected`, createdAt, closedAt?).
- `MotionVote` (id, motionId, memberId, choice `// yes | no | abstain`, viaProxy `Boolean @default(false)`, createdAt; `@@unique([motionId, memberId])`).
- `CooperativeConfig.agmQuorumPercent Int @default(25)`.
- Relations on `Cooperative`, `Member`, `Meeting`.

- [ ] Add models + config field + relations to both schemas.
- [ ] Migration `20261023000000_meetings`: create the 4 tables, indexes, FKs; add the config column.
- [ ] RLS migration `20261024000000_meetings_rls`: `Meeting`/`Motion` carry `cooperativeId` → direct policy; `MeetingAttendance`→`Meeting`, `MotionVote`→`Motion` → parent-resolver policy.
- [ ] Add all four to the FORCE list in `prisma/rls/recommended_policies.sql`.
- [ ] `npm run prisma:generate:local`; `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`; `npx vitest run tests/schema-sync.test.ts` passes.
- [ ] Commit `feat(governance): meeting schema, migration, RLS`.

### Task 2: Meeting service + admin/member commands

**Files:** `src/services/meetings.ts` (new), `src/services/admin.ts`, `src/services/conversation.ts`, `src/services/handlers/session.ts`, `tests/meetings.test.ts` (new).

**Interfaces produced:** `startMeeting(coopId, type, title, quorumPercent, actor)`, `openMeeting(coopId, meetingId, actor)`, `closeMeeting(coopId, meetingId, actor)`, `attendMeeting(coopId, meetingId, memberId)`, `assignProxy(coopId, meetingId, memberId, proxyMemberCode)`, `addMotion(coopId, meetingId, title, description, kind, actor)`, `closeMotion(coopId, motionId, actor)`, `castMotionVote(coopId, motionId, memberId, choice)`, `listMeetings(coopId)`, `meetingMinutes(coopId, meetingId)`, `quorumMet(coopId, meetingId)`.

- [ ] **Tests (red):** start an AGM, open it, members attend, add a motion, members vote, close the motion (passes on majority with quorum), minutes generated; a non-admin cannot start/close; a member cannot vote twice; proxy attendance counts toward quorum.
- [ ] Implement `meetings.ts` (admin actions super/admin-gated + audited; member actions self-scoped).
- [ ] Admin commands: `startmeeting <agm|sgm> <title> [quorum%]`, `openmeeting <id>`, `closemeeting <id>`, `addmotion <meeting id> <title> | <description> [kind]`, `closemotion <id>`, `meetingminutes <id>`. Member commands: `meetings`, `attend <meeting id>`, `proxy <meeting id> <member code>`, `motions <meeting id>`, `motionvote <motion id> <yes|no|abstain>`. Add to the menus.
- [ ] **Verify:** `npx vitest run tests/meetings.test.ts`; typecheck; lint.
- [ ] Commit `feat(governance): meeting service and commands`.

### Task 3: Quorum, tally, minutes export + docs

**Files:** `src/services/meetings.ts`, `src/services/exports.ts` (minutes export), `tests/meetings.test.ts`, `README.md`.

- [ ] **Tests (red):** a motion cannot pass without quorum (attendance < quorumPercent% of active members); a motion passes on a yes-majority with quorum; `meetingMinutes` includes attendees, motions, tallies and resolutions; minutes export produces a file.
- [ ] Implement `quorumMet` (attendance incl. proxies ≥ `quorumPercent`% of active members) and enforce it in `closeMotion` (a motion with no quorum is `rejected` with a "no quorum" note). Implement `meetingMinutes` (text) and wire a PDF/Excel export via the existing export pipeline.
- [ ] Add a `## General meetings (AGM/SGM)` section to `README.md`.
- [ ] **Verify:** full gate + `npm test`.
- [ ] Commit `feat(governance): meeting quorum, minutes and export`.
