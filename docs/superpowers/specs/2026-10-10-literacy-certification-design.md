# Financial Literacy Certification — Design

**Date:** 2026-10-10
**Roadmap:** `2026-10-06-coop-world-class-roadmap.md`, Feature 11 ("Literacy → certification")
**Status:** Approved (design), pending spec review → implementation plan

## 1. Problem

The platform ships 6 financial-literacy lessons (`src/services/literacy.ts`) with per-member
progress in `MemberProgress` (`currentLesson`, `completedLessons` JSON, `completedAt`), driven
by `class` / `next` / `class progress` / `replay N` in `conversation.ts:1367-1471`. Completion
today is purely cosmetic — there is no assessment, no certificate, and no benefit. The roadmap
promised **Literacy → certification**; this design closes that gap.

## 2. Goals

- Members **opt in** to certification during registration (optional, skippable).
- Opted-in members, after the lessons, take a **quiz**; passing issues a **certificate**.
- The certificate is a **branded PDF**, delivered **in-chat as an attachment** and also
  addressable by a **verifiable reference link** (shareable/third-party verifiable).
- Certification grants a **loan-limit boost** (the perk), configurable per cooperative.
- Quiz length and pass mark are **admin-configurable per cooperative**.

## 3. Non-goals

- No changes to lesson content/authoring (the 6 lessons stay as-is; we add a question bank).
- No external certificate authority, no blockchain/anchor.
- No change to the base loan cap semantics beyond layering the certified boost.

## 4. Data model

All schema changes go in **both** `prisma/schema.prisma` and `prisma/schema.local.prisma`
(enforced by `tests/schema-sync.test.ts`) plus a Postgres migration
`prisma/migrations/<ts>_literacy_certification/migration.sql`.

### 4.1 New model `LiteracyCertificate`

```
model LiteracyCertificate {
  id             String   @id @default(cuid())
  cooperativeId  String
  cooperative    Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId       String   @unique
  member         Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  referenceCode  String   @unique          // e.g. "CERT-LAG01-7F3K9Q" (public, unguessable suffix)
  score          Int
  totalQuestions Int
  issuedAt       DateTime @default(now())
  revokedAt      DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([cooperativeId])
}
```

Add the back-relation `literacyCertificate LiteracyCertificate?` on `Member`.

- `referenceCode` is **public** (used by the verify endpoint) → must be high-entropy: derive the
  suffix from `randomBytes` (base32, ≥10 chars), prefixed by the coop code for human context.
- One certificate per member (`memberId @unique`); re-issue on a later pass updates the record
  (or is disallowed — see §9 open questions; default: re-issuing updates score/issuedAt,
  keeping the same referenceCode).

### 4.2 Extend `MemberProgress`

```
certificationOptIn Boolean  @default(false)
quizAttempts       Int      @default(0)
quizScore          Int?
quizPassedAt       DateTime?
```

### 4.3 Extend `CooperativeConfig` (+ `CoopConfig` interface + `DEFAULT_CONFIG`)

```
literacyCertificationEnabled Boolean @default(true)
literacyQuizPassMark         Int     @default(4)
literacyQuizQuestionCount    Int     @default(6)
certifiedLoanBoost           Int     @default(1)   // extra x of savings for certified members
```

Defaults: pass 4/6, boost +1x (2x base → 3x for certified). `literacyQuizQuestionCount` and
`literacyQuizPassMark` are validated (`1 ≤ passMark ≤ count ≤ bank size`).

## 5. Quiz content & flow

### 5.1 Question bank (`literacy.ts`)

Add `QUIZ_QUESTIONS: QuizQuestion[]` (~12 items), each tagged with the lesson it covers:

```
interface QuizQuestion { id: number; lessonId: number; prompt: string; options: string[]; answerIndex: number; }
```

The coop config selects `literacyQuizQuestionCount` questions from the bank (deterministic
per-attempt shuffle seeded by member id + attempt so retries vary; pick first N after shuffle).

### 5.2 Conversational flow

New session state `literacy_quiz`, handled in `handlers/session.ts`. Session `data` carries:

```
{ quiz: { questionIds: number[]; index: number; answers: number[] } }
```

- `class quiz` starts a quiz (only if `certificationOptIn` and lessons completed; otherwise guide
  the member to finish lessons first).
- Bot sends Q1 with A/B/C/D options; member replies `A`/`B`/`C`/`D` (case-insensitive). Invalid
  input re-prompts the same question.
- After the last question: score = count of correct. `quizAttempts++`, `quizScore` = score.
  - **Pass** (`score ≥ literacyQuizPassMark`): set `quizPassedAt`, issue/refresh the certificate,
    send it (see §7/§8).
  - **Fail**: reply with score + "review lessons (`class` / `replay N`) and retry (`class quiz`)".
    Unlimited retries.
- Unknown input mid-quiz → re-prompt current question.

### 5.3 Progress display

`class progress` (`conversation.ts:1379`) gains a certification line: en/disabled, opted-in?,
attempts, last score, pass mark, and certificate reference if issued.

## 6. Registration opt-in

Add a step after next-of-kin. New state `awaiting_literacy_optin` and `askLiteracyOptIn(phone,
data)` in `handlers/join.ts`, wired in `handlers/session.ts` where the NOK step completes.

Prompt (only shown when the coop has `literacyCertificationEnabled`):

> 📘 *Optional:* join our free financial-literacy certification? It takes ~10 minutes and
> unlocks a higher loan limit once you pass. Reply *yes* to enroll or *skip*.

`yes` → `MemberProgress.certificationOptIn = true` (record created/updated); `skip`/anything →
false. Skippable and never blocks registration.

## 7. Certificate generation

New module `src/services/literacy-certificate.ts`:

- `issueCertificate({ memberId, cooperativeId, score, totalQuestions })` — creates/updates the
  `LiteracyCertificate` (generating a unique `referenceCode`), writes an `audit()` entry
  (`literacy.certificate_issued`), returns the record.
- `renderCertificatePdf(cert, member, coop): Promise<Buffer>` — pdfkit A4 landscape-ish document:
  coop name/logo (branding config), "Certificate of Financial Literacy", member name + code,
  issue date, score, reference code, a verify URL. Rendered **on demand** into a Buffer.
  No persistent file storage (`certificates/` dir or S3 not required) — the DB record is the
  source of truth and the PDF is a deterministic rendering.

## 8. Delivery — in-chat attachment + verifiable link

### 8.1 New outbound document-send capability

None exists today (only `sendText`/`sendLongText` + inbound `downloadMedia`). Add:

- `src/lib/whatsapp.ts` → `sendDocument({ to, filename, buffer, caption })`:
  1. `POST {API_BASE}/{phoneNumberId}/media` (multipart/form-data: `messaging_product`, `type`,
     `file`) → `media id`; then
  2. `POST {API_BASE}/{phoneNumberId}/messages` with `type:"document"`,
     `document:{ id, filename, caption }`.
- `src/lib/telegram.ts` → `sendTelegramDocument(chatId, filename, buffer, caption?)`:
  multipart/form-data `sendDocument` with `document` file part + `chat_id` + optional `caption`.
- `src/lib/messaging.ts` → `sendDocument(params)` — channel-aware router mirroring `sendText`
  (routes `tg:` to Telegram, else WhatsApp; respects the deferred-send scope like `sendText`).

### 8.2 On pass

1. `renderCertificatePdf(...)` → Buffer.
2. `sendDocument({ to, filename: "<coop>-literacy-certificate.pdf", buffer, caption })` where the
   caption carries the reference code and verify link:
   `🎓 You're certified! Ref: CERT-LAG01-7F3K9Q\nVerify: <baseUrl>/api/certificate/7F3K9Q`.
3. If attachment send fails, fall back to `sendText` with the reference code + link (never lose
   the outcome).

### 8.3 Public verify endpoint

`GET /api/certificate/:code` (new, in `src/routes/`, registered like the exports route):

- No admin token. Resolves the certificate by `referenceCode` suffix (high-entropy).
- If found and not revoked: regenerate the PDF on demand and stream it
  (`Content-Type: application/pdf`, `Content-Disposition: inline`).
- If not found/revoked: `404`.
- Rate-limited (reuse the existing rate-limit lib) to discourage enumeration.
- Rationale: this endpoint is intentionally public so a member can share proof and a third party
  can verify. The code is unguessable; no other member data is exposed.
- A member command `certificate` re-sends the attachment (re-renders + re-attaches).

## 9. Perk — loan-limit boost

`src/services/loans.ts`, `checkLoanEligibility` (lines ~164-179):

- Base ratio stays `LOAN_TO_SAVINGS_RATIO` (env, default 2).
- If coop `literacyCertificationEnabled` AND the member has a live
  (`revokedAt == null`) `LiteracyCertificate`: `effectiveRatio = base + certifiedLoanBoost`
  (default 2 + 1 = 3x).
- The eligibility message states the boost: e.g. `Loans are capped at *3x your savings* (2x + 1x
  certified-member boost).`

**Known discrepancy (flagged, out of scope):** the live cap uses `LOAN_TO_SAVINGS_RATIO` (env 2)
while `CooperativeConfig.maxLoanMultiplier` (default 3) is only *displayed* in admin
(`admin.ts:2118,3186`) and not enforced in `checkLoanEligibility`. This design does not change
existing behavior; it layers the boost on the enforced base. Reconciling the two is a separate
decision.

## 10. Admin config & commands

- `setconfig` (`admin.ts` ~3127) accepts the four new keys, validated, with `audit()`.
- `showconfig` lists them.
- `verifycert <code>` admin lookup → member name, coop, score, issuedAt, revoked status.
- Optional: `revokecert <code>` (admin) sets `revokedAt` (revokes the perk and the public verify).

## 11. RLS

`LiteracyCertificate` has `cooperativeId` → add:
- Stage-1 RLS migration: `ENABLE ROW LEVEL SECURITY` + policy (mirrors existing tables).
- `prisma/rls/recommended_policies.sql` FORCE list entry.

## 12. Cross-cutting requirements

- **Both schemas** + Postgres migration; `tests/schema-sync.test.ts` green.
- **Money:** loan ratios are integers; no kobo/naira changes. `formatBalance` for any amount text.
- **Tenancy:** chat writes via `withCoopContext`; system/verify reads as appropriate.
- **Audit:** certificate issuance, revocation, and config changes call `audit()`.
- **i18n:** quiz/certificate user strings flow through `i18n.ts` like other member strings.

## 13. Files touched

- `prisma/schema.prisma`, `prisma/schema.local.prisma`
- `prisma/migrations/<ts>_literacy_certification/migration.sql` (new)
- `prisma/rls/recommended_policies.sql` (FORCE entry)
- `src/services/literacy.ts` (question bank + selection helper)
- `src/services/literacy-certificate.ts` (new: issue + PDF render)
- `src/services/handlers/join.ts` (opt-in ask)
- `src/services/handlers/session.ts` (opt-in state, quiz state, `class quiz`, `certificate`)
- `src/services/conversation.ts` (route `class quiz`; progress line)
- `src/services/loans.ts` (certified boost)
- `src/services/coop-config.ts` (4 new config fields)
- `src/services/admin.ts` (setconfig keys, `verifycert`, optional `revokecert`)
- `src/lib/whatsapp.ts`, `src/lib/telegram.ts`, `src/lib/messaging.ts` (outbound document send)
- `src/routes/certificate.ts` (new public verify route) + route registration
- `tests/*` (see §14)

## 14. Tests (TDD)

- `tests/literacy-certification.test.ts`: quiz scoring + pass/fail boundaries; unlimited retries;
  opt-in persistence; certificate issuance + unique `referenceCode`; re-issue behavior.
- `tests/literacy-loan-boost.test.ts`: base cap unchanged for non-certified; boosted cap for
  certified; disabled-coop → no boost; revoked → no boost.
- `tests/certificate-route.test.ts`: verify endpoint serves PDF for a valid code, 404 for
  unknown/revoked, rate limit.
- `tests/messaging-document.test.ts`: `sendDocument` routes per channel (mocked fetch), success +
  failure fallback.
- Extend `tests/schema-sync.test.ts` implicitly (new model in both schemas).
- Existing `tests/i18n.test.ts` / `tests/conversation.test.ts` stay green.

**Verification gate per the roadmap:** `npm run typecheck` clean · `npm run lint` 0 errors ·
full suite green · schema-sync green.

## 15. Open questions (defaults chosen; confirm during plan)

1. **Re-issue:** a member who re-takes and scores higher — update the same certificate (keep
   referenceCode) vs. issue a new one. **Default:** update, keep code.
2. **Expiry:** certificates never expire unless revoked. **Default:** no expiry (perk persists).
3. **`verifycert`/`revokecert` scope:** superadmin + coop admin. **Default:** coop admin (own coop).
4. **Verify endpoint privacy:** PDF only, no JSON member data. **Default:** PDF only.
