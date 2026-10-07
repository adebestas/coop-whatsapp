# NIBSS Direct Debit Mandates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member authorize a direct-debit mandate on their bank account so the cooperative can automatically pull money for recurring savings, loan repayments, and group contributions.

**Architecture:** Extend the existing `ProviderAdapter` (Monnify + Paystack) with mandate methods; add `Mandate`/`MandateDebit` models; a `mandates.ts` service drives the lifecycle; a scheduler job creates debits for due obligations; the existing `/webhooks/payments` pipeline settles mandate status and debit results. A successful debit is treated as an incoming funding event (credit the wallet exactly like a top-up), then the purpose is applied via the existing `repayLoan` / `contributeToGroup` services.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres, zod.

**Spec:** `docs/superpowers/specs/2026-10-07-direct-debit-mandates-design.md`

## Global Constraints

- Money is integer kobo everywhere; format with `formatBalance`; parse user input with `parseNaira`.
- `.js` import extensions; no Prisma `enum` (use `String` + comments).
- `prisma/schema.prisma` and `prisma/schema.local.prisma` must stay identical (enforced by `tests/schema-sync.test.ts`).
- Every new table with `cooperativeId` needs a Stage-1 RLS migration (`ENABLE` + policy) and a FORCE-list entry in `prisma/rls/recommended_policies.sql`.
- Chat writes go through `withTx` + `setCoopContext`; system jobs use `ownerPrisma`/`forEachCoop`.
- Every money movement posts a balanced `postJournal` pair and calls `audit()`.
- Mandate create/cancel require the transaction PIN; rate-limited; blocked when frozen/suspended.
- Retry cadence: at most once per day.
- **Every payment and deduction carries a human-readable description** — in the `postJournal` `description`, the `audit()` `detail`, the provider `narration` (where the API accepts one), and the member notification/statement line. No money movement may be posted with an empty or generic description.
- Verification per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted tests green · full suite green (`npm test`) · schema-sync green.

---

## File Structure

- `prisma/schema.prisma`, `prisma/schema.local.prisma` — `Mandate`, `MandateDebit`, `CooperativeConfig` fields, relations.
- `prisma/migrations/20261031000000_direct_debit_mandates/migration.sql` — tables + indexes + FKs.
- `prisma/migrations/20261032000000_direct_debit_mandates_rls/migration.sql` — RLS enable + policies.
- `prisma/rls/recommended_policies.sql` — FORCE list entries.
- `src/services/payments/index.ts` — mandate types + optional `ProviderAdapter` methods.
- `src/services/payments/monnify.ts` — Monnify mandate implementation.
- `src/services/payments/paystack.ts` — Paystack mandate implementation.
- `src/services/mandates.ts` (new) — lifecycle + `settleDebit`.
- `src/services/webhooks.ts` — mandate webhook branch.
- `src/services/scheduler.ts` — `runMandateDebits`, `runMandateRetries`, reminder suppression.
- `src/services/handlers/money.ts`, `src/services/handlers/session.ts` — commands + menus.
- `src/services/admin.ts` — admin `mandates` / `pausemandate`.
- `tests/mandates.test.ts` (new), `tests/mandate-webhooks.test.ts` (new), `tests/mandate-scheduler.test.ts` (new).
- `README.md` — feature section.

---

### Task 1: Schema, migration, RLS

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261031000000_direct_debit_mandates/migration.sql`
- Create: `prisma/migrations/20261032000000_direct_debit_mandates_rls/migration.sql`
- Modify: `prisma/rls/recommended_policies.sql`
- Test: `tests/schema-sync.test.ts` (existing)

**Interfaces produced:**
- `Mandate` (id, cooperativeId, memberId, provider, providerMandateId?, providerReference @unique, status, amountCap, bankAccountNumber, bankCode, bankName?, accountName?, authorizationUrl?, purposes, createdAt, authorizedAt?, cancelledAt?, lastDebitAt?).
- `MandateDebit` (id, mandateId, cooperativeId, memberId, purpose, targetId?, amount, status, providerRef @unique, providerTransactionId?, attempts, nextRetryAt?, failureReason?, createdAt, settledAt?).
- `CooperativeConfig.directDebitEnabled Boolean @default(false)`, `CooperativeConfig.directDebitMaxCap Int @default(0)`.

- [ ] **Step 1: Add models to both schemas**

Add to `prisma/schema.prisma` (and identically to `prisma/schema.local.prisma`):

```prisma
// A member's direct-debit authorization on their own bank account. One flexible
// mandate per member with a per-debit cap; each debit carries a purpose.
model Mandate {
  id                String    @id @default(cuid())
  cooperativeId     String
  cooperative       Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId          String
  member            Member    @relation("MemberMandates", fields: [memberId], references: [id], onDelete: Cascade)
  provider          String // monnify | paystack
  providerMandateId String? // Monnify mandateCode / Paystack authorization_code
  providerReference String    @unique // our reference (idempotency)
  status            String    @default("pending") // pending | active | cancelled | failed | expired
  amountCap         Int // kobo; max per debit
  bankAccountNumber String
  bankCode          String
  bankName          String?
  accountName       String?
  authorizationUrl  String?
  purposes          String    @default("savings,loan,group") // CSV of enabled purposes
  createdAt         DateTime  @default(now())
  authorizedAt      DateTime?
  cancelledAt       DateTime?
  lastDebitAt       DateTime?
  debits            MandateDebit[]

  @@index([cooperativeId, memberId])
  @@index([cooperativeId, status])
}

// One attempt to pull money under a mandate, tagged with its purpose.
model MandateDebit {
  id                    String    @id @default(cuid())
  mandateId             String
  mandate               Mandate   @relation(fields: [mandateId], references: [id], onDelete: Cascade)
  cooperativeId         String
  memberId              String
  purpose               String // savings | loan | group
  targetId              String? // loanId / groupId; null for savings
  amount                Int // kobo
  status                String    @default("pending") // pending | successful | failed
  providerRef           String    @unique // our debit reference
  providerTransactionId String?
  attempts              Int       @default(0)
  nextRetryAt           DateTime?
  failureReason         String?
  createdAt             DateTime  @default(now())
  settledAt             DateTime?

  @@index([mandateId, status])
  @@index([cooperativeId, status])
  @@index([status, nextRetryAt])
}
```

Add relations: on `Cooperative` add `mandates Mandate[]`; on `Member` add `mandates Mandate[] @relation("MemberMandates")`. Add to `CooperativeConfig`:

```prisma
  directDebitEnabled Boolean @default(false)
  directDebitMaxCap  Int     @default(0) // kobo; 0 = no extra coop cap
```

- [ ] **Step 2: Write the migration SQL**

`prisma/migrations/20261031000000_direct_debit_mandates/migration.sql`:

```sql
CREATE TABLE "Mandate" (
  "id" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMandateId" TEXT,
  "providerReference" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "amountCap" INTEGER NOT NULL,
  "bankAccountNumber" TEXT NOT NULL,
  "bankCode" TEXT NOT NULL,
  "bankName" TEXT,
  "accountName" TEXT,
  "authorizationUrl" TEXT,
  "purposes" TEXT NOT NULL DEFAULT 'savings,loan,group',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "authorizedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "lastDebitAt" TIMESTAMP(3),
  CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Mandate_providerReference_key" ON "Mandate"("providerReference");
CREATE INDEX "Mandate_cooperativeId_memberId_idx" ON "Mandate"("cooperativeId", "memberId");
CREATE INDEX "Mandate_cooperativeId_status_idx" ON "Mandate"("cooperativeId", "status");
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MandateDebit" (
  "id" TEXT NOT NULL,
  "mandateId" TEXT NOT NULL,
  "cooperativeId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "targetId" TEXT,
  "amount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "providerRef" TEXT NOT NULL,
  "providerTransactionId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "MandateDebit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MandateDebit_providerRef_key" ON "MandateDebit"("providerRef");
CREATE INDEX "MandateDebit_mandateId_status_idx" ON "MandateDebit"("mandateId", "status");
CREATE INDEX "MandateDebit_cooperativeId_status_idx" ON "MandateDebit"("cooperativeId", "status");
CREATE INDEX "MandateDebit_status_nextRetryAt_idx" ON "MandateDebit"("status", "nextRetryAt");
ALTER TABLE "MandateDebit" ADD CONSTRAINT "MandateDebit_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CooperativeConfig" ADD COLUMN "directDebitEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CooperativeConfig" ADD COLUMN "directDebitMaxCap" INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Write the RLS migration**

`prisma/migrations/20261032000000_direct_debit_mandates_rls/migration.sql` — follow the exact pattern of `20261030000000_savings_products_rls/migration.sql` (read it first). `Mandate` and `MandateDebit` both carry `cooperativeId` → direct policy using the same `current_setting('app.cooperative_id')` predicate the sibling migration uses.

- [ ] **Step 4: Add FORCE-list entries**

Append `Mandate` and `MandateDebit` to the FORCE list in `prisma/rls/recommended_policies.sql` (same section as `SavingsProduct`/`SavingsAccount`).

- [ ] **Step 5: Generate + push + verify schema sync**

Run:
```bash
npm run prisma:generate:local
npx prisma db push --schema prisma/schema.local.prisma --skip-generate
npx vitest run tests/schema-sync.test.ts
```
Expected: schema-sync PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261031000000_direct_debit_mandates prisma/migrations/20261032000000_direct_debit_mandates_rls prisma/rls/recommended_policies.sql
git commit -m "feat(direct-debit): mandate schema, migration, RLS"
```

---

### Task 2: Provider adapter extension (Monnify + Paystack)

**Files:**
- Modify: `src/services/payments/index.ts`
- Modify: `src/services/payments/monnify.ts`
- Modify: `src/services/payments/paystack.ts`
- Test: `tests/mandates.test.ts` (new — provider section)

**Interfaces produced:**
```ts
export interface CreateMandateParams {
  memberName: string; memberEmail: string; memberPhone: string;
  accountNumber: string; bankCode: string; accountName: string;
  amountCap: number; // kobo
  reference: string; narration?: string; redirectUrl?: string;
}
export interface MandateResult {
  ok: boolean; providerMandateId?: string; authorizationUrl?: string;
  status?: string; error?: string;
}
export interface DebitMandateParams {
  providerMandateId: string; amount: number; reference: string; narration?: string;
}
export interface DebitResult { ok: boolean; providerRef?: string; status?: string; error?: string; }
export interface MandateNotification {
  providerMandateId: string; status: "active" | "cancelled" | "failed" | "expired";
  provider: string; raw: unknown;
}
export interface DebitNotification {
  reference: string; status: "successful" | "failed";
  providerTransactionId?: string; reason?: string; provider: string; raw: unknown;
}
```
`ProviderAdapter` gains optional `createMandate?`, `debitMandate?`, `cancelMandate?`, `parseMandateNotification?`, `parseDebitNotification?`.

- [ ] **Step 1: Write failing provider tests**

In `tests/mandates.test.ts`, mock `global.fetch` and assert:
- `monnifyAdapter.createMandate(...)` POSTs `/api/v1/disbursements/mandate` (note: Monnify mandate path is `/v1/disbursements/mandate` under the `/api` prefix used by the adapter's `api()` helper — verify against the existing `api()` base and use the path that resolves to `https://sandbox.monnify.com/api/v1/disbursements/mandate`) and returns `providerMandateId` + `authorizationUrl` from `responseBody.mandateCode` / `responseBody.authorizationLink`.
- `monnifyAdapter.debitMandate(...)` POSTs `/api/v1/disbursements/debit` and returns `status` from `responseBody.debitStatus`.
- `monnifyAdapter.parseMandateNotification({ eventType: "MANDATE_UPDATE", eventData: { mandateCode: "MTDD|X", mandateStatus: "ACTIVATED" } })` → `{ providerMandateId: "MTDD|X", status: "active" }`.
- `paystackAdapter.createMandate(...)` POSTs `/customer/authorization/initialize` with `channel: "direct_debit"` and returns `authorizationUrl` from `data.redirect_url`.
- `paystackAdapter.parseMandateNotification({ event: "direct_debit.authorization.created", data: { authorization_code: "AUTH_X", active: true } })` → `{ providerMandateId: "AUTH_X", status: "active" }`.
- `paystackAdapter.debitMandate(...)` POSTs `/transaction/partial_debit` with `authorization_code`.

Run: `npx vitest run tests/mandates.test.ts`
Expected: FAIL (methods not defined).

- [ ] **Step 2: Add types + optional methods to `ProviderAdapter`**

Add the interfaces above to `src/services/payments/index.ts` and the five optional methods to the `ProviderAdapter` interface.

- [ ] **Step 3: Implement Monnify mandate methods**

In `monnify.ts`, add to `monnifyAdapter`:
```ts
async createMandate(params) {
  if (!configured()) return { ok: false, error: "Monnify is not configured" };
  try {
    const res = await api<MonnifyResponse<{ mandateCode: string; authorizationLink?: string; mandateStatus?: string }>>(
      "POST", "/api/v1/disbursements/mandate",
      {
        customerName: params.memberName,
        customerEmail: params.memberEmail,
        customerPhoneNumber: params.memberPhone,
        customerAccountDetails: {
          accountNumber: params.accountNumber,
          bankCode: params.bankCode,
          accountName: params.accountName,
        },
        mandateDate: new Date().toISOString().slice(0, 10),
        mandateAmount: forProvider(params.amountCap, "monnify"),
        narration: params.narration ?? "Cooperative savings/loan mandate",
        redirectUrl: params.redirectUrl,
      },
    );
    if (!res.requestSuccessful) return { ok: false, error: res.responseMessage ?? "mandate rejected" };
    return { ok: true, providerMandateId: res.responseBody.mandateCode, authorizationUrl: res.responseBody.authorizationLink, status: res.responseBody.mandateStatus };
  } catch (err: any) { return { ok: false, error: err?.message ?? "mandate failed" }; }
},
async debitMandate(params) {
  if (!configured()) return { ok: false, error: "Monnify is not configured" };
  try {
    const res = await api<MonnifyResponse<{ transactionReference: string; debitStatus: string }>>(
      "POST", "/api/v1/disbursements/debit",
      { mandateId: params.providerMandateId, amount: forProvider(params.amount, "monnify"), reference: params.reference, narration: params.narration },
    );
    if (!res.requestSuccessful) return { ok: false, error: res.responseMessage ?? "debit rejected" };
    return { ok: true, providerRef: res.responseBody.transactionReference, status: res.responseBody.debitStatus };
  } catch (err: any) { return { ok: false, error: err?.message ?? "debit failed" }; }
},
async cancelMandate(params) {
  if (!configured()) return { ok: false, error: "Monnify is not configured" };
  try {
    const res = await api<MonnifyResponse<unknown>>("PUT" as any, `/api/v1/disbursements/mandate/${encodeURIComponent(params.providerMandateId)}`, { action: "CANCEL" });
    return { ok: res.requestSuccessful, error: res.requestSuccessful ? undefined : res.responseMessage };
  } catch (err: any) { return { ok: false, error: err?.message ?? "cancel failed" }; }
},
parseMandateNotification(body) {
  const b: any = body;
  if (String(b?.eventType ?? "").toUpperCase() !== "MANDATE_UPDATE") return null;
  const d = b.eventData ?? {};
  const map: Record<string, MandateNotification["status"]> = { ACTIVATED: "active", CANCELLED: "cancelled", FAILED: "failed", EXPIRED: "expired" };
  const status = map[String(d.mandateStatus ?? "").toUpperCase()];
  if (!status || !d.mandateCode) return null;
  return { providerMandateId: String(d.mandateCode), status, provider: "monnify", raw: body };
},
parseDebitNotification(body) {
  const b: any = body;
  const eventType = String(b?.eventType ?? b?.type ?? "").toUpperCase();
  if (!eventType.includes("DISBURSEMENT")) return null;
  const d = b.eventData ?? {};
  const reference = d.reference ?? d.paymentReference;
  if (!reference) return null;
  const status = eventType.includes("SUCCESS") ? "successful" : eventType.includes("FAIL") || eventType.includes("REVERS") ? "failed" : null;
  if (!status) return null;
  return { reference, status, providerTransactionId: d.providerReference, reason: d.status, provider: "monnify", raw: body };
},
```
Note: the existing `api()` helper only accepts `"GET" | "POST"`. Extend its signature to `"GET" | "POST" | "PUT"` and send a body for PUT too.

- [ ] **Step 4: Implement Paystack mandate methods**

In `paystack.ts`, add:
```ts
async createMandate(params) {
  try {
    const res = await api<any>("/customer/authorization/initialize", "POST", {
      email: params.memberEmail, channel: "direct_debit", callback_url: params.redirectUrl,
    });
    return { ok: true, providerMandateId: res.data?.reference, authorizationUrl: res.data?.redirect_url, status: "pending" };
  } catch (err: any) { return { ok: false, error: err.message ?? "mandate failed" }; }
},
async debitMandate(params) {
  try {
    const res = await api<any>("/transaction/partial_debit", "POST", {
      authorization_code: params.providerMandateId, currency: "NGN",
      amount: forProvider(params.amount, "paystack"), email: params.narration ?? "member@coop.local",
    });
    return { ok: true, providerRef: res.data?.reference, status: res.data?.status };
  } catch (err: any) { return { ok: false, error: err.message ?? "debit failed" }; }
},
async cancelMandate(params) {
  try { await api<any>(`/customer/authorization/${encodeURIComponent(params.providerMandateId)}`, "DELETE"); return { ok: true }; }
  catch (err: any) { return { ok: false, error: err.message ?? "cancel failed" }; }
},
parseMandateNotification(body) {
  const b: any = body;
  if (b?.event !== "direct_debit.authorization.created") return null;
  const code = b.data?.authorization_code;
  if (!code) return null;
  return { providerMandateId: String(code), status: b.data?.active ? "active" : "failed", provider: "paystack", raw: body };
},
parseDebitNotification(body) {
  const b: any = body;
  const event = String(b?.event ?? "").toLowerCase();
  if (!event.includes("partial_debit") && !event.includes("charge")) return null;
  const reference = b.data?.reference;
  if (!reference) return null;
  const status = event.includes("success") ? "successful" : event.includes("fail") ? "failed" : null;
  if (!status) return null;
  return { reference, status, providerTransactionId: b.data?.id !== undefined ? String(b.data.id) : undefined, provider: "paystack", raw: body };
},
```
Note: Paystack's `api()` helper throws on non-2xx; `DELETE` is a new method — extend the helper's method type.

- [ ] **Step 5: Run tests to green**

Run: `npx vitest run tests/mandates.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/payments/index.ts src/services/payments/monnify.ts src/services/payments/paystack.ts tests/mandates.test.ts
git commit -m "feat(direct-debit): provider mandate methods (monnify + paystack)"
```

---

### Task 3: Mandate service + commands

**Files:**
- Create: `src/services/mandates.ts`
- Modify: `src/services/handlers/money.ts`, `src/services/handlers/session.ts`
- Test: `tests/mandates.test.ts`

**Interfaces produced:**
```ts
export async function createMandate(coopId: string, memberId: string, cap: number, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string; mandateId?: string; authorizationUrl?: string }>;
export async function listMandates(coopId: string, memberId: string): Promise<{ ok: boolean; message: string; mandates?: MandateSummary[] }>;
export async function listCoopMandates(coopId: string): Promise<{ ok: boolean; message: string; mandates?: MandateSummary[] }>;
export async function cancelMandate(coopId: string, mandateId: string, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string }>;
export async function applyMandateStatus(provider: string, providerMandateId: string, status: string): Promise<void>;
export async function pauseMandate(coopId: string, mandateId: string, purpose: string | null, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string }>;
export async function resumeMandate(coopId: string, mandateId: string, purpose: string | null, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string }>;
export async function skipDebit(coopId: string, debitId: string, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string }>;
```

**Pause semantics (addendum):** `pauseMandate(id, null)` sets `Mandate.status = "paused"`; `pauseMandate(id, purpose)` adds the purpose to `Mandate.pausedPurposes` (CSV). `resumeMandate(id, null)` sets status back to `active`; `resumeMandate(id, purpose)` removes it from `pausedPurposes`. `skipDebit(id)` sets a `pending` `MandateDebit.status = "skipped"` so it is never retried.

- [ ] **Step 0: Schema delta migration for pause**

Add `pausedPurposes String @default("")` to `Mandate` in BOTH schemas, and create `prisma/migrations/20261033000000_mandate_pause/migration.sql`:
```sql
ALTER TABLE "Mandate" ADD COLUMN "pausedPurposes" TEXT NOT NULL DEFAULT '';
```
Run `npm run prisma:generate:local` and `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`.

- [ ] **Step 1: Write failing service tests**

In `tests/mandates.test.ts` (reuse the existing test harness pattern from `tests/savings-products.test.ts` — read it for `cleanupDatabase`, coop/member creation, and `actor()` helpers):
- `createMandate` with `directDebitEnabled=false` → `{ ok: false }` ("not enabled").
- `createMandate` with no saved bank account → `{ ok: false }` ("add a bank account").
- `createMandate` with a mocked provider returning a link → persists a `pending` Mandate with `authorizationUrl`, returns it.
- `createMandate` with cap > `directDebitMaxCap` (when set) → refused.
- `cancelMandate` → status `cancelled` + provider cancel called.
- `applyMandateStatus(provider, providerMandateId, "active")` → flips the matching Mandate to `active` + sets `authorizedAt`.

Run: `npx vitest run tests/mandates.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/services/mandates.ts`**

Follow the structure of `src/services/savings-products.ts` (read it): `withTx` + `setCoopContext`, `audit()`, `formatBalance`, `resolveProvider`, `markProviderUp/Down`. Key logic:
- `createMandate`: load `CooperativeConfig`; refuse if `!directDebitEnabled`; load member; require `bankAccountNumber` + `bankCode`; enforce `cap > 0` and (`directDebitMaxCap === 0 || cap <= directDebitMaxCap`); build `providerReference = \`MAN-${cuid()}\``; call `resolveProvider().createMandate({...})`; on failure return the error; persist `Mandate` with `status: "pending"`, `authorizationUrl`; audit `mandate.create`; return the link.
- `listMandates` / `listCoopMandates`: query + map to `MandateSummary`.
- `cancelMandate`: load mandate scoped to coop+member; if `providerMandateId` call `cancelMandate`; set `status: "cancelled"`, `cancelledAt`; audit.
- `applyMandateStatus`: `prisma.mandate.updateMany({ where: { provider, providerMandateId }, data: { status, authorizedAt: status === "active" ? new Date() : undefined } })`.
- `pauseMandate` / `resumeMandate` / `skipDebit`: implement per the pause semantics above; each audits (`mandate.pause` / `mandate.resume` / `mandate.debit_skip`).

- [ ] **Step 3: Wire commands**

In `src/services/handlers/money.ts` add `handleMandate(phone, args)` (parse cap with `parseNaira`, require PIN via the existing `issueSecretChallenge`/PIN pattern used by `handleBuyShares` — read it), `handleMandates(phone)`, `handleMandateStatus(phone, args)`, `handleCancelMandate(phone, args)`. Register them in the command router (`src/services/conversation.ts` — find where `openproduct`/`saveproduct` are routed) and add menu lines in `src/services/handlers/session.ts` next to the savings-product lines.

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run tests/mandates.test.ts` → PASS. Then `npm run typecheck` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/services/mandates.ts src/services/handlers/money.ts src/services/handlers/session.ts src/services/conversation.ts tests/mandates.test.ts
git commit -m "feat(direct-debit): mandate lifecycle service and commands"
```

---

### Task 4: Webhook mandate branch + settleDebit (savings)

**Files:**
- Modify: `src/services/webhooks.ts`, `src/services/mandates.ts`
- Test: `tests/mandate-webhooks.test.ts` (new)

**Interfaces produced:**
```ts
export async function settleDebit(provider: string, reference: string, status: "successful" | "failed", providerTransactionId?: string, reason?: string): Promise<void>;
```

- [ ] **Step 1: Write failing webhook tests**

In `tests/mandate-webhooks.test.ts`:
- A `MANDATE_UPDATE`/`direct_debit.authorization.created` body posted to `processPaymentWebhook` (with a valid signature) flips the Mandate to `active`.
- A successful debit notification for a `pending` `MandateDebit` (purpose `savings`) credits the member's wallet by the debit amount and marks the debit `successful`.
- A failed debit notification marks the debit `failed`, sets `nextRetryAt ≈ now + 1 day`, and does NOT credit the wallet.
- A duplicate delivery is acked and not reprocessed (wallet credited once).

Run: `npx vitest run tests/mandate-webhooks.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `settleDebit` in `mandates.ts`**

```ts
export async function settleDebit(provider, reference, status, providerTransactionId?, reason?) {
  const debit = await prisma.mandateDebit.findUnique({ where: { providerRef: reference } });
  if (!debit || debit.status !== "pending") return; // idempotent
  if (status === "failed") {
    await prisma.mandateDebit.update({
      where: { id: debit.id },
      data: { status: "failed", failureReason: reason ?? "debit failed", nextRetryAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await notifyMember(await loadNotifiable(debit.memberId), `⚠️ We couldn't collect *${formatBalance(debit.amount)}* from your bank today. We'll try again tomorrow.`).catch(() => {});
    return;
  }
  // success: credit the wallet exactly like a top-up, then apply the purpose.
  await withCoopContext(debit.cooperativeId, async () => {
    const member = await prisma.member.findUnique({ where: { id: debit.memberId }, include: { wallet: true } });
    if (!member?.wallet) return;
    await withTx(async (tx) => {
      await postJournal({ cooperativeId: debit.cooperativeId, txRef: `DD-${reference}`, description: `Direct debit (${debit.purpose})`, postings: [
        { account: "assets:bank", direction: "DEBIT", amount: debit.amount },
        { account: `member_wallet:${member.wallet!.id}`, direction: "CREDIT", amount: debit.amount, memberId: member.id },
      ], throwOnDuplicate: true }, tx as any);
      await tx.wallet.update({ where: { id: member.wallet!.id }, data: { balance: { increment: debit.amount }, totalSaved: { increment: debit.amount } } });
      await tx.mandateDebit.update({ where: { id: debit.id }, data: { status: "successful", settledAt: new Date(), providerTransactionId } });
      await tx.mandate.update({ where: { id: debit.mandateId }, data: { lastDebitAt: new Date() } });
    });
    await applyPurpose(debit, member); // savings: no-op (credit IS the savings); loan/group: call the service (Tasks 6/7)
  });
  await audit({ cooperativeId: debit.cooperativeId, actorPhone: "", actorId: debit.memberId, action: "mandate.debit", targetType: "mandate_debit", targetId: debit.id, amount: debit.amount, detail: debit.purpose }).catch(() => {});
}
```
`applyPurpose` is a small dispatcher: `savings` → no-op; `loan`/`group` → implemented in Tasks 6/7 (initially `return`).

- [ ] **Step 3: Add the mandate branch to `processPaymentWebhook`**

In `webhooks.ts`, after `adapter.parseNotification(parsedBody)` returns null, try `adapter.parseMandateNotification?.(parsedBody)` → `applyMandateStatus(...)`, then `adapter.parseDebitNotification?.(parsedBody)` → `settleDebit(...)`. Use a distinct `WebhookEvent` id per branch (`${provider}:mandate:${id}` / `${provider}:debit:${reference}:${status}`) and the same INSERT-first idempotency + 200/4xx rules.

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run tests/mandate-webhooks.test.ts` → PASS. Then typecheck + lint.

- [ ] **Step 5: Commit**

```bash
git add src/services/webhooks.ts src/services/mandates.ts tests/mandate-webhooks.test.ts
git commit -m "feat(direct-debit): mandate webhooks and savings debit settlement"
```

---

### Task 5: Scheduler savings auto-debit + reminder suppression

**Files:**
- Modify: `src/services/scheduler.ts`
- Test: `tests/mandate-scheduler.test.ts` (new)

**Interfaces produced:**
```ts
export async function runMandateDebits(now?: Date): Promise<number>;
export async function runMandateRetries(now?: Date): Promise<number>;
```

- [ ] **Step 1: Write failing scheduler tests**

In `tests/mandate-scheduler.test.ts`:
- A member with an active mandate and `autoSaveEnabled` + `autoSaveNextDue <= now` gets a `pending` `MandateDebit` (purpose `savings`, amount = min(autoSaveAmount, amountCap)) and the provider `debitMandate` is called.
- A member with an active mandate is NOT sent an auto-save reminder by `runAutoSaveReminders`.
- A member without a mandate still gets the reminder.
- A `failed` debit with `nextRetryAt <= now` is retried by `runMandateRetries` and `nextRetryAt` advances by 1 day.

Run: `npx vitest run tests/mandate-scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `runMandateDebits` + `runMandateRetries`**

In `scheduler.ts`, follow the `forEachCoop` pattern used by `cleanupExpiredVirtualAccounts`. For each coop with `directDebitEnabled`, find active mandates; for each, find due savings obligations (`autoSaveEnabled && autoSaveNextDue <= now`); create a `pending` `MandateDebit` with `providerRef = \`DD-${cuid()}\`` and call `resolveProvider().debitMandate(...)`; on a synchronous hard failure mark `failed` + `nextRetryAt`. `runMandateRetries` selects `failed` debits with `nextRetryAt <= now`, re-calls `debitMandate`, and sets `nextRetryAt = now + 1 day` on failure. Wire both into `runSchedulerTick`.

**Pause (addendum):** only consider mandates with `status === "active"` (a `paused` mandate is skipped entirely); skip a purpose listed in `Mandate.pausedPurposes`; and never select a `skipped` debit in `runMandateRetries` (only `failed`).

- [ ] **Step 3: Suppress reminders for mandated members**

In `runAutoSaveReminders`, exclude members that have an active mandate (add a relation filter or a pre-query of active-mandate member ids per coop).

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run tests/mandate-scheduler.test.ts` → PASS. Then typecheck + lint.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduler.ts tests/mandate-scheduler.test.ts
git commit -m "feat(direct-debit): scheduler savings auto-debit and reminder suppression"
```

---

### Task 6: Loan repayment purpose

**Files:**
- Modify: `src/services/mandates.ts`, `src/services/scheduler.ts`
- Test: `tests/mandate-scheduler.test.ts`, `tests/mandate-webhooks.test.ts`

**Interfaces produced:** `applyPurpose` handles `purpose === "loan"` by calling `repayLoan(member.phone, debit.targetId, debit.cooperativeId)`.

- [ ] **Step 1: Write failing tests**

- A successful `loan` debit calls `repayLoan` for the target loan and reduces the loan balance.
- `runMandateDebits` creates a `loan` debit for an active loan whose installment is due (`Loan.dueDate <= now`) when the member has an active mandate.

Run: `npx vitest run tests/mandate-scheduler.test.ts tests/mandate-webhooks.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `mandates.ts` `applyPurpose`, add the `loan` branch: load the member's phone, call `repayLoan(member.phone, debit.targetId ?? undefined, debit.cooperativeId)`, and notify on the result. In `scheduler.ts` `runMandateDebits`, add loan-due detection (active loans with `dueDate <= now`), amount = min(installment due, `amountCap`), `targetId = loan.id`.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
git add src/services/mandates.ts src/services/scheduler.ts tests/mandate-scheduler.test.ts tests/mandate-webhooks.test.ts
git commit -m "feat(direct-debit): loan repayment purpose"
```

---

### Task 7: Group contribution purpose

**Files:**
- Modify: `src/services/mandates.ts`, `src/services/scheduler.ts`
- Test: `tests/mandate-scheduler.test.ts`, `tests/mandate-webhooks.test.ts`

**Interfaces produced:** `applyPurpose` handles `purpose === "group"` by calling `contributeToGroup(debit.cooperativeId, debit.targetId!, debit.memberId, debit.amount)`.

- [ ] **Step 1: Write failing tests**

- A successful `group` debit calls `contributeToGroup` and increases the group pot.
- `runMandateDebits` creates a `group` debit for an active group membership whose current-cycle contribution is due when the member has an active mandate.

Run: `npx vitest run tests/mandate-scheduler.test.ts tests/mandate-webhooks.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `mandates.ts` `applyPurpose`, add the `group` branch calling `contributeToGroup`. In `scheduler.ts` `runMandateDebits`, add group-due detection (active `GroupMember` rows in active groups with a due current-cycle contribution), amount = min(group contribution amount, `amountCap`), `targetId = group.id`.

- [ ] **Step 3: Run tests + gate, then commit**

```bash
git add src/services/mandates.ts src/services/scheduler.ts tests/mandate-scheduler.test.ts tests/mandate-webhooks.test.ts
git commit -m "feat(direct-debit): group contribution purpose"
```

---

### Task 8: Admin view + README

**Files:**
- Modify: `src/services/admin.ts`, `README.md`
- Test: `tests/mandates.test.ts`

**Interfaces produced:** admin commands `mandates` (coop-wide list), `pausemandate <id> [purpose]`, `resumemandate <id> [purpose]`, `skipdebit <id>`.

- [ ] **Step 1: Write failing tests**

- `handleAdminCommand("mandates")` lists the coop's mandates.
- `handleAdminCommand("pausemandate <id>")` sets the mandate `paused`; `pausemandate <id> savings` adds `savings` to `pausedPurposes`.
- `handleAdminCommand("resumemandate <id>")` sets it back to `active`.
- `handleAdminCommand("skipdebit <id>")` marks a pending debit `skipped`.

Run: `npx vitest run tests/mandates.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement admin commands**

Add `case "mandates"`, `case "pausemandate"`, `case "resumemandate"`, `case "skipdebit"` to `handleAdminCommand` in `admin.ts` (follow the `grievances` case pattern), gated to admin/superadmin, calling the Task 3 service functions. Add the admin menu lines in `session.ts`.

- [ ] **Step 3: Add the README section**

Add a `## Direct debit mandates` section documenting: enabling (`directDebitEnabled`), the member commands (`mandate`, `mandates`, `mandatestatus`, `cancelmandate`), the admin commands, the retry policy, and the provider fallback.

- [ ] **Step 4: Full gate + commit**

Run: `npm run typecheck` · `npm run lint` · `npm test` (full suite) · `npx vitest run tests/schema-sync.test.ts`.

```bash
git add src/services/admin.ts src/services/handlers/session.ts README.md tests/mandates.test.ts
git commit -m "feat(direct-debit): admin view and docs"
```

---

### Task 9: Refund flow (maker-checker)

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261034000000_refund_requests/migration.sql`
- Create: `prisma/migrations/20261035000000_refund_requests_rls/migration.sql`
- Modify: `prisma/rls/recommended_policies.sql`
- Create: `src/services/refunds.ts`
- Modify: `src/services/admin.ts`, `src/services/handlers/session.ts`, `README.md`
- Test: `tests/refunds.test.ts` (new)

**Interfaces produced:**
```ts
export async function recommendRefund(coopId: string, memberId: string, amount: number, reason: string, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string; refundId?: string }>;
export async function approveRefund(coopId: string, refundId: string, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string }>;
export async function rejectRefund(coopId: string, refundId: string, reason: string, actor: { id: string; phone: string; role?: string | null }): Promise<{ ok: boolean; message: string }>;
```

- [ ] **Step 1: Add the `RefundRequest` model + migration + RLS**

Add to both schemas:
```prisma
// A refund the coop owes a member (e.g. a double payment: bank/cheque + direct
// debit). Admin recommends; a super admin approves and pays out.
model RefundRequest {
  id              String    @id @default(cuid())
  cooperativeId   String
  cooperative     Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId        String
  member          Member    @relation("MemberRefunds", fields: [memberId], references: [id], onDelete: Cascade)
  mandateDebitId  String?
  amount          Int // kobo
  reason          String
  status          String    @default("pending") // pending | approved | rejected | paid | failed
  recommendedById String
  approvedById    String?
  createdAt       DateTime  @default(now())
  approvedAt      DateTime?
  paidAt          DateTime?
  payoutRef       String?

  @@index([cooperativeId, status])
  @@index([cooperativeId, memberId])
}
```
Add `refunds RefundRequest[]` to `Cooperative` and `refunds RefundRequest[] @relation("MemberRefunds")` to `Member`. Migration `20261034000000_refund_requests` creates the table + indexes + FKs (mirror the `Mandate` migration style). RLS migration `20261035000000_refund_requests_rls` mirrors the savings-products RLS pattern; add `RefundRequest` to the FORCE list. Run `npm run prisma:generate:local`, `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`, `npx vitest run tests/schema-sync.test.ts`.

- [ ] **Step 2: Write failing refund tests**

In `tests/refunds.test.ts`:
- `recommendRefund` creates a `pending` `RefundRequest` with the amount + reason.
- `approveRefund` by a super admin initiates a payout to the member's saved bank account (mock the payout path), sets `status: "paid"`, `approvedById`, `paidAt`, `payoutRef`.
- `approveRefund` by a non-super-admin is refused.
- `rejectRefund` sets `status: "rejected"` + reason.
- A member with no saved bank account → `approveRefund` refuses.

Run: `npx vitest run tests/refunds.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/services/refunds.ts`**

Follow the `savings-products.ts` structure (`withTx` + `setCoopContext`, `audit`, `formatBalance`). `approveRefund` reuses the existing payout path (read `src/services/payanyone.ts` / `src/services/withdrawals.ts` for the exact payout helper and journal pair) to pay the member's `bankAccountNumber`/`bankCode`; on success mark `paid`; on failure mark `failed` and alert. Every step audited.

- [ ] **Step 4: Wire commands**

Admin: `recommendrefund <member code|id> <amount> <reason>` in `handleAdminCommand`. Super admin: `approverefund <id>`, `rejectrefund <id> <reason>`. Add menu lines in `session.ts`.

- [ ] **Step 5: README + full gate + commit**

Add a `## Refunds` subsection to the README. Run `npm run typecheck` · `npm run lint` · `npm test` · `npx vitest run tests/schema-sync.test.ts`.
```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/20261034000000_refund_requests prisma/migrations/20261035000000_refund_requests_rls prisma/rls/recommended_policies.sql src/services/refunds.ts src/services/admin.ts src/services/handlers/session.ts README.md tests/refunds.test.ts
git commit -m "feat(direct-debit): refund flow (admin recommend, super admin approve)"
```

---

### Task 10: App-wide payment/deduction description audit

**Files:**
- Modify: any money-path service found missing a description (e.g. `src/services/payments/topup.ts`, `src/services/withdrawals.ts`, `src/services/disbursements.ts`, `src/services/dividends.ts`, `src/services/guarantordeduction.ts`, `src/services/payroll.ts`, `src/services/payanyone.ts`, `src/services/loans.ts`, `src/services/groups.ts`, `src/services/shares.ts`, `src/services/savings-products.ts`)
- Test: `tests/money-invariants.test.ts` (existing) + a new focused test if needed

**Goal:** every payment and deduction across the app carries a human-readable description in the journal, audit, provider narration, and member-facing line.

- [ ] **Step 1: Inventory the money paths**

Grep every `postJournal(` call and every `audit(` call with a money `action`. For each, confirm the `description`/`detail` is present and specific (names the member, the purpose, and the amount). List any that are empty, generic ("transaction"), or missing.

- [ ] **Step 2: Write a failing invariant test**

Add a test that asserts each money-path journal entry has a non-empty, non-generic `description` (e.g. a table of representative flows: topup, withdrawal, payout, dividend, guarantor deduction, payroll, loan repayment, group contribution, share purchase, savings deposit/maturity, direct debit, refund). Run it and watch it fail for any path missing a description.

- [ ] **Step 3: Fix the gaps**

Add/repair descriptions on the failing paths. Keep them specific and member-facing (e.g. `Loan repayment — ₦5,000 (installment 3/11)`), not generic.

- [ ] **Step 4: Full gate + commit**

Run `npm run typecheck` · `npm run lint` · `npm test`.
```bash
git add -A
git commit -m "fix(money): ensure every payment and deduction carries a description"
```

---

### Task 11: Bank picker + account-name confirmation (mandate flow)

**Files:**
- Modify: `src/services/payments/index.ts`, `src/services/payments/monnify.ts`, `src/services/payments/paystack.ts`
- Modify: `src/services/handlers/money.ts`, `src/services/handlers/session.ts`, `src/services/conversation.ts`
- Modify: `src/services/mandates.ts`
- Test: `tests/mandates.test.ts`

**Interfaces produced:**
```ts
export interface Bank { code: string; name: string; }
// ProviderAdapter gains:
listBanks?(): Promise<Bank[]>;
```
And a mandate-flow state machine: `awaiting_mandate_account` → `awaiting_mandate_bank` → `awaiting_mandate_confirm` → create.

- [ ] **Step 1: Add `listBanks` to the provider adapter**

Add `listBanks?(): Promise<Bank[]>` to `ProviderAdapter`. Implement for Paystack (`GET /bank?currency=NGN` → `data[].code/name`) and Monnify (bank list endpoint). Add a small in-process cache (e.g. 24h TTL) and a static fallback built from `BANK_CODES` in `src/lib/banks.ts` when the provider call fails. Write tests with mocked `fetch` asserting the mapping + fallback.

- [ ] **Step 2: Write failing mandate-flow tests**

- `mandate` starts a guided flow: the member is asked for the account number.
- After the account number, the system lists banks (from `listBanks`) and asks the member to pick one (by number or name).
- After the bank is picked, the system calls `resolveAccount` and shows the resolved name, asking the member to confirm.
- On confirm, `createMandate` runs with the account number + bank code + resolved name.
- If `resolveAccount` fails, the member is told and can retry.

Run: `npx vitest run tests/mandates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the guided flow**

Add the session states (`awaiting_mandate_account`, `awaiting_mandate_bank`, `awaiting_mandate_confirm`) in `session.ts`, the handlers in `money.ts`, and route them in `conversation.ts`. The bank list is presented as a numbered, searchable list (accept a number or a name substring). `createMandate` accepts the resolved `accountName` and stores it. Keep the existing PIN step.

- [ ] **Step 4: Run tests + gate, then commit**

Run `npx vitest run tests/mandates.test.ts` → PASS; `npm run typecheck`; `npm run lint`; `npm test`.
```bash
git add src/services/payments/index.ts src/services/payments/monnify.ts src/services/payments/paystack.ts src/services/handlers/money.ts src/services/handlers/session.ts src/services/conversation.ts src/services/mandates.ts tests/mandates.test.ts
git commit -m "feat(direct-debit): bank picker and account-name confirmation in the mandate flow"
```

---

## Self-Review

- **Spec coverage:** providers (Task 2), flexible cap (Tasks 1/3), all three purposes (Tasks 4/6/7), provider-hosted link (Tasks 2/3), retry-until-success once/day (Tasks 4/5), notify-after-only (Tasks 4/6/7), reminder suppression (Task 5), PIN (Task 3), accounting via existing services (Task 4), admin view + docs (Task 8). **Addendum:** pause whole mandate / per purpose / skip one debit (Tasks 3/5/8), refund maker-checker with bank payout (Task 9), every payment/deduction has a description (global constraint + Task 10 app-wide audit), bank picker + account-name confirmation in the mandate flow (Task 11). ✅
- **Placeholder scan:** no TBD/TODO; every code step has real code or an exact file+pattern to follow.
- **Type consistency:** `Mandate`/`MandateDebit` field names, `settleDebit`/`applyPurpose`/`runMandateDebits`/`runMandateRetries` signatures are consistent across tasks.
- **Known risk:** Monnify's mandate path prefix (`/api/v1/...` vs `/v1/...`) must be verified against the adapter's `api()` base in Task 2 Step 1; the test pins the exact URL.
