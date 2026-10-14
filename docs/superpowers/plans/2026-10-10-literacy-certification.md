# Financial Literacy Certification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in financial literacy certification: quiz after lessons, branded PDF certificate delivered in-chat + verifiable public link, and a certified loan-limit boost.

**Architecture:** Extend schema (MemberProgress, CooperativeConfig, new LiteracyCertificate), add quiz flow in session/conversation, generate PDF on-demand with pdfkit, add channel-aware document send (WhatsApp/Telegram), add public `/api/certificate/:code` verify route, layer certified boost in loan eligibility, and wire admin commands. All changes follow existing patterns (tenancy, audit, i18n, schema-sync).

**Tech Stack:** TypeScript, Fastify 5, Prisma (Postgres prod / SQLite dev.db), pdfkit, WhatsApp Cloud API, Telegram Bot API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-literacy-certification-design.md`

## Global Constraints

- Both `prisma/schema.prisma` and `prisma/schema.local.prisma` must stay identical (enforced by `tests/schema-sync.test.ts`).
- SQLite has no scalar lists — use `Json?` for array-like fields (never `String[]`).
- Money: loan ratios are integers; use `formatBalance` for amounts in user text.
- Tenancy: chat writes via `withCoopContext`; system/verify reads as appropriate.
- Audit: certificate issuance, revocation, and config changes call `audit()`.
- i18n: user-facing strings flow through `i18n.ts` where applicable.
- `npm run typecheck` clean · `npm run lint` 0 errors · full suite green · schema-sync green.
- Never commit unless explicitly asked.

---

### Task 1: Schema — MemberProgress, CooperativeConfig, LiteracyCertificate

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/schema.local.prisma`
- Create: `prisma/migrations/<ts>_literacy_certification/migration.sql` (timestamped)
- Modify: `prisma/rls/recommended_policies.sql`

**Interfaces:**
- Consumes: existing schema patterns (Member, Cooperative, CooperativeConfig, MemberProgress)
- Produces: `LiteracyCertificate` model; `Member.literacyCertificate?`; `MemberProgress.certificationOptIn`, `quizAttempts`, `quizScore`, `quizPassedAt`; `CooperativeConfig.literacyCertificationEnabled`, `literacyQuizPassMark`, `literacyQuizQuestionCount`, `certifiedLoanBoost`

- [x] **Step 1: Write the failing test (schema-sync will catch drift)**

```bash
npx vitest run tests/schema-sync.test.ts 2>&1 | tail -5
```
Expected: PASS (before changes) — confirm baseline.

- [x] **Step 2: Update `prisma/schema.prisma`**

Add to `MemberProgress` (after `lastLessonAt`):
```prisma
  certificationOptIn Boolean  @default(false)
  quizAttempts       Int      @default(0)
  quizScore          Int?
  quizPassedAt       DateTime?
```

Add to `CooperativeConfig` (after `referralMaxRewards`):
```prisma
  literacyCertificationEnabled Boolean @default(true)
  literacyQuizPassMark         Int     @default(4)
  literacyQuizQuestionCount    Int     @default(6)
  certifiedLoanBoost           Int     @default(1)
```

Add `LiteracyCertificate` model:
```prisma
model LiteracyCertificate {
  id             String   @id @default(cuid())
  cooperativeId  String
  cooperative    Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId       String   @unique
  member         Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  referenceCode  String   @unique
  score          Int
  totalQuestions Int
  issuedAt       DateTime @default(now())
  revokedAt      DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([cooperativeId])
}
```

Add back-relation to `Member`:
```prisma
  literacyCertificate LiteracyCertificate?
```

- [x] **Step 3: Mirror to `prisma/schema.local.prisma`**

Apply identical changes.

- [x] **Step 4: Create Postgres migration**

Create `prisma/migrations/<YYYYMMDDHHMMSS>_literacy_certification/migration.sql` with the corresponding DDL.

- [x] **Step 5: Update RLS policies**

Add `LiteracyCertificate` to FORCE RLS list in `prisma/rls/recommended_policies.sql`.

- [x] **Step 6: Verify schema-sync**

```bash
npx vitest run tests/schema-sync.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit** (SKIPPED — never commit unless explicitly asked)

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/*_literacy_certification prisma/rls/recommended_policies.sql
git commit -m "feat(literacy): add LiteracyCertificate model and config fields"
```

---

### Task 2: Quiz content + helpers in literacy service

**Files:**
- Modify: `src/services/literacy.ts`

**Interfaces:**
- Produces: `QuizQuestion`, `QUIZ_QUESTIONS`, `getQuizQuestions(count, seed?)`

- [x] **Step 1: Write the failing test**

Create/extend `tests/literacy-certification.test.ts` — test `getQuizQuestions` returns requested count, unique ids.

```bash
npx vitest run tests/literacy-certification.test.ts -t "quiz selection" 2>&1 | tail -2
```
Expected: FAIL

- [x] **Step 2: Add QuizQuestion + bank + selector**

Add interface, ~12 questions covering lessons 1-6, deterministic Fisher–Yates shuffle by seed.

- [x] **Step 3: Run test to verify it passes**

```bash
npx vitest run tests/literacy-certification.test.ts -t "quiz selection"
```
Expected: PASS

- [ ] **Step 4: Commit** (SKIPPED — never commit unless explicitly asked)

```bash
git add src/services/literacy.ts tests/literacy-certification.test.ts
git commit -m "feat(literacy): add quiz question bank and selector"
```

---

### Task 3: Coop config types + defaults

**Files:**
- Modify: `src/services/coop-config.ts`

- [x] **Step 1: Extend CoopConfig interface + DEFAULT_CONFIG + mapping**

Add the 4 literacy fields with defaults and DB fallbacks.

- [x] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -2
```
Expected: clean

- [ ] **Step 3: Commit** (SKIPPED — never commit unless explicitly asked)

```bash
git add src/services/coop-config.ts
git commit -m "feat(config): add literacy certification config fields"
```

---

### Task 4: Outbound document send (WhatsApp + Telegram + router)

**Files:**
- Modify: `src/lib/whatsapp.ts`, `src/lib/telegram.ts`, `src/lib/messaging.ts`
- Create: `tests/messaging-document.test.ts`

- [x] **Step 1: Write failing test**

Test channel routing + API calls (mocked).

```bash
npx vitest run tests/messaging-document.test.ts
```
Expected: FAIL

- [x] **Step 2: Implement sendDocument in all three layers (deferred-send aware in messaging)**

- [x] **Step 3: Run tests**

```bash
npx vitest run tests/messaging-document.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit** (SKIPPED — never commit unless explicitly asked)

```bash
git add src/lib/whatsapp.ts src/lib/telegram.ts src/lib/messaging.ts tests/messaging-document.test.ts
git commit -m "feat(messaging): add channel-aware sendDocument"
```

---

### Task 5: Certificate service (issue + PDF render)

**Files:**
- Create: `src/services/literacy-certificate.ts`
- Expand: `tests/literacy-certification.test.ts`

- [x] **Step 1: Write failing tests** (issuance, unique ref, re-issue keeps ref, scoring)

```bash
npx vitest run tests/literacy-certification.test.ts
```
Expected: FAIL

- [x] **Step 2: Implement generateReferenceCode, issueCertificate (with audit), renderCertificatePdf (pdfkit)**

- [x] **Step 3: Run tests**

```bash
npx vitest run tests/literacy-certification.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit** (SKIPPED — never commit unless explicitly asked)

```bash
git add src/services/literacy-certificate.ts tests/literacy-certification.test.ts
git commit -m "feat(literacy): certificate issuance + PDF rendering"
```

---

### Task 6: Registration opt-in (join flow)

**Files:**
- Modify: `src/services/handlers/join.ts`, `src/services/handlers/session.ts`, `src/services/conversation.ts`

- [x] **Step 1: Add BotState awaiting_literacy_optin**

- [x] **Step 2: Add askLiteracyOptIn in join.ts**

- [x] **Step 3: Wire after member creation (pin_confirm) or per spec; handle awaiting_literacy_optin to set MemberProgress**

- [x] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -1
```

- [ ] **Step 5: Commit** (SKIPPED — never commit unless explicitly asked)

---

### Task 7: Quiz flow in session + class quiz command

**Files:**
- Modify: `src/services/handlers/session.ts`, `src/services/conversation.ts`, `src/services/literacy.ts`
- Expand: `tests/literacy-certification.test.ts`

- [x] **Step 1: Write failing quiz flow tests**

```bash
npx vitest run tests/literacy-certification.test.ts -t "quiz flow"
```
Expected: FAIL

- [x] **Step 2: Add literacy_quiz state, route class quiz, handle quiz in session (A-D, scoring, pass→issue+send cert with fallback, fail→retry hint), extend progress, add certificate command**

- [x] **Step 3: Run tests**

```bash
npx vitest run tests/literacy-certification.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit** (SKIPPED — never commit unless explicitly asked)

---

### Task 8: Loan-limit boost for certified members

**Files:**
- Modify: `src/services/loans.ts`
- Create: `tests/literacy-loan-boost.test.ts`

- [ ] **Step 1: Write failing tests**

```bash
npx vitest run tests/literacy-loan-boost.test.ts
```
Expected: FAIL

- [ ] **Step 2: Compute effective multiplier using live cert + coop config; update messages**

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/literacy-loan-boost.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/loans.ts tests/literacy-loan-boost.test.ts
git commit -m "feat(loans): apply certified loan-limit boost"
```

---

### Task 9: Public verify endpoint + route registration

**Files:**
- Create: `src/routes/certificate.ts`
- Modify: `src/app.ts`
- Create: `tests/certificate-route.test.ts`

- [ ] **Step 1: Write failing tests**

```bash
npx vitest run tests/certificate-route.test.ts
```
Expected: FAIL

- [ ] **Step 2: Implement GET /api/certificate/:code (exact ref or suffix; 404 if revoked/not found; rate-limited; stream PDF)**

- [ ] **Step 3: Register route in app.ts**

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/certificate-route.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/certificate.ts src/app.ts tests/certificate-route.test.ts
git commit -m "feat(routes): public certificate verify endpoint"
```

---

### Task 10: Admin commands (setconfig keys, verifycert, revokecert)

**Files:**
- Modify: `src/services/admin.ts`

- [ ] **Step 1: Extend setconfig/showconfig with 4 literacy keys (validate ranges)**

- [ ] **Step 2: Add verifycert and revokecert (audit on revoke)**

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -1
```

- [ ] **Step 4: Commit**

```bash
git add src/services/admin.ts
git commit -m "feat(admin): literacy cert config + verifycert/revokecert"
```

---

### Task 11: Wire class quiz routing in conversation

**Files:**
- Modify: `src/services/conversation.ts`

- [ ] **Step 1: Ensure class quiz and certificate commands routed**

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -1
```

- [ ] **Step 3: Commit**

```bash
git add src/services/conversation.ts
git commit -m "feat(conversation): class quiz and certificate commands"
```

---

### Task 12: Integration tests + regression

- [ ] **Step 1: Run literacy-related tests**

```bash
npx vitest run tests/literacy-certification.test.ts tests/literacy-loan-boost.test.ts tests/certificate-route.test.ts tests/messaging-document.test.ts
```

- [ ] **Step 2: Run schema-sync + typecheck + lint**

```bash
npx tsc --noEmit && npx vitest run tests/schema-sync.test.ts && npx eslint . --max-warnings=0 2>&1 | tail -8
```

- [ ] **Step 3: Run regression subset**

```bash
npx vitest run tests/conversation.test.ts tests/moneyflows.test.ts tests/disbursement.test.ts tests/routing.test.ts tests/ai-features.test.ts tests/ai-loan.test.ts tests/guarantor-phone.test.ts tests/bank-picker.test.ts tests/ai-loan-flow.test.ts tests/ai-notice.test.ts tests/payout-name-confirm.test.ts
```

- [ ] **Step 4: Full suite (optional but recommended)**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
```

## Verification Gate

- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npx eslint . --max-warnings=0` — 0 errors
- [ ] `npx vitest run tests/schema-sync.test.ts` — PASS
- [ ] All new literacy tests PASS
- [ ] Regression subset PASS
- [ ] Full suite green

**Plan complete.** Save to `docs/superpowers/plans/2026-10-10-literacy-certification.md`

**Execution choice:** Subagent-Driven (recommended) — dispatch fresh subagent per task with two-stage review.