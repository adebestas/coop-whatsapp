# CubeCover Insurance Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed CubeCover SuperCare health insurance into the cooperative platform so members can browse, purchase, claim, and manage policies via WhatsApp/Telegram bot commands.

**Architecture:** New `src/services/insurance/` module with a CubeCover API client + adapter, webhook handler, Prisma models for policies/claims, and bot commands integrated into the existing conversation/session handler. Premiums deducted from wallet; claims payout to wallet or bank.

**Tech Stack:** TypeScript, Prisma, existing payment/wallet infrastructure, WhatsApp/Telegram bot framework

**Spec:** `docs/superpowers/specs/2026-10-08-cubecover-insurance.md`

## Global Constraints

- Integer kobo for all money amounts
- `formatBalance` for display, `parseNaira` for input
- All payouts deferred via `enqueueAfterCommit` (outside transactions)
- Follow existing patterns: `src/services/payments/` for adapters, `src/services/handlers/` for command handlers
- RLS: both new tables carry `cooperativeId` → Stage-1 RLS + FORCE-list entry
- Tests: 42 existing referral tests must still pass; new tests in `tests/insurance.test.ts`

---

### Task 1: Schema + Migration + RLS

**Files:**
- Modify: `prisma/schema.prisma` — add `InsurancePolicy` and `InsuranceClaim` models
- Modify: `prisma/schema.local.prisma` — add same models (local dev)
- Create: `prisma/migrations/<timestamp>_cubecover_insurance/migration.sql`
- Modify: `prisma/rls/recommended_policies.sql` — add FORCE entries for both tables

**Interfaces:**
- Consumes: existing `Cooperative`, `Member` models
- Produces: `InsurancePolicy`, `InsuranceClaim` Prisma models with `cooperativeId` field

- [ ] **Step 1: Write the failing test**

```typescript
// tests/insurance.test.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

test('InsurancePolicy model exists and has required fields', async () => {
  const policy = await prisma.insurancePolicy.create({
    data: {
      cooperativeId: 'test-coop',
      memberId: 'test-member',
      productCode: 'supercare',
      planCode: 'standard',
      premiumKobo: 500000,
      coverageKobo: 5000000,
    },
  });
  expect(policy.productCode).toBe('supercare');
  expect(policy.status).toBe('active');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/insurance.test.ts -t "InsurancePolicy model exists" --forceExit`
Expected: FAIL with "model InsurancePolicy not found"

- [ ] **Step 3: Add Prisma models**

```prisma
// prisma/schema.prisma
model InsurancePolicy {
  id              String   @id @default(cuid())
  cooperativeId   String
  cooperative     Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId        String
  member          Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  productCode     String    // "supercare" | "superfix"
  planCode        String    // "starter" | "basic" | "plus" | "elite" | "standard"
  status          String    @default("active")
  cubecoverPolicyId String?
  premiumKobo     Int
  coverageKobo    Int
  startDate       DateTime  @default(now())
  endDate         DateTime?
  autoRenew       Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([cooperativeId, memberId])
  @@index([cooperativeId, status])
}

model InsuranceClaim {
  id              String   @id @default(cuid())
  cooperativeId   String
  cooperative     Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  policyId        String
  policy          InsurancePolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  memberId        String
  claimType       String
  amountKobo      Int
  status          String    @default("pending")
  cubecoverClaimId String?
  description     String?
  documents       String[]
  payoutKobo      Int?
  payoutDestination String?
  createdAt       DateTime  @default(now())
  processedAt     DateTime?
  paidAt          DateTime?

  @@index([cooperativeId, memberId])
  @@index([cooperativeId, status])
  @@index([policyId])
}
```

- [ ] **Step 4: Generate migration + apply**

Run: `npx prisma migrate dev --name cubecover_insurance`
Expected: Migration created and applied

- [ ] **Step 5: Add RLS FORCE entries**

```sql
-- prisma/rls/recommended_policies.sql
-- Add:
ALTER TABLE "InsurancePolicy" FORCE ROW LEVEL SECURITY;
ALTER TABLE "InsuranceClaim" FORCE ROW LEVEL SECURITY;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/insurance.test.ts -t "InsurancePolicy model exists" --forceExit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations/ prisma/rls/recommended_policies.sql tests/insurance.test.ts
git commit -m "feat(insurance): schema for InsurancePolicy and InsuranceClaim"
```

---

### Task 2: CubeCover API Client

**Files:**
- Create: `src/services/insurance/cubecover.ts` — API client
- Create: `tests/insurance/cubecover.test.ts` — client tests (stubbed fetch)

**Interfaces:**
- Consumes: `CUBECOVER_API_KEY`, `CUBECOVER_BASE_URL` from env
- Produces: `CubeCoverClient` with methods: `getProducts`, `getProduct`, `createQuote`, `purchasePolicy`, `getPolicy`, `cancelPolicy`, `renewPolicy`, `submitClaim`, `getClaim`, `listClaims`, `verifyWebhook`, `parseNotification`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/insurance/cubecover.test.ts
import { CubeCoverClient } from '../../src/services/insurance/cubecover';

test('CubeCoverClient.getProducts returns product list', async () => {
  const client = new CubeCoverClient({ apiKey: 'test', baseUrl: 'https://api.cubecover.ai' });
  const products = await client.getProducts();
  expect(Array.isArray(products)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/insurance/cubecover.test.ts --forceExit`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/insurance/cubecover.ts
export interface CubeCoverConfig {
  apiKey: string;
  baseUrl: string;
}

export interface Product {
  code: string;
  name: string;
  description: string;
  plans: Plan[];
}

export interface Plan {
  code: string;
  name: string;
  premiumKobo: number;
  coverageKobo: number;
}

export interface Policy {
  id: string;
  productCode: string;
  planCode: string;
  status: string;
  startDate: string;
  endDate?: string;
}

export interface Claim {
  id: string;
  policyId: string;
  claimType: string;
  amountKobo: number;
  status: string;
}

export interface CubeCoverEvent {
  event: string;
  data: Record<string, unknown>;
}

export class CubeCoverClient {
  private config: CubeCoverConfig;

  constructor(config: CubeCoverConfig) {
    this.config = config;
  }

  private async request(path: string, options: RequestInit = {}) {
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`CubeCover API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async getProducts(): Promise<Product[]> {
    return this.request('/v1/products');
  }

  async getProduct(code: string): Promise<Product> {
    return this.request(`/v1/products/${code}`);
  }

  async createQuote(params: { productCode: string; planCode: string; memberId: string }): Promise<{ quoteId: string; premiumKobo: number }> {
    return this.request('/v1/quotes', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async purchasePolicy(params: { quoteId: string; memberId: string; paymentRef: string }): Promise<Policy> {
    return this.request('/v1/policies', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getPolicy(id: string): Promise<Policy> {
    return this.request(`/v1/policies/${id}`);
  }

  async cancelPolicy(id: string): Promise<void> {
    await this.request(`/v1/policies/${id}/cancel`, { method: 'POST' });
  }

  async renewPolicy(id: string): Promise<Policy> {
    return this.request(`/v1/policies/${id}/renew`, { method: 'POST' });
  }

  async submitClaim(params: { policyId: string; claimType: string; amountKobo: number; description?: string; documents?: string[] }): Promise<Claim> {
    return this.request('/v1/claims', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getClaim(id: string): Promise<Claim> {
    return this.request(`/v1/claims/${id}`);
  }

  async listClaims(policyId: string): Promise<Claim[]> {
    return this.request(`/v1/claims?policy_id=${policyId}`);
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', process.env.CUBECOVER_WEBHOOK_SECRET || '')
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  parseNotification(body: unknown): CubeCoverEvent | null {
    if (typeof body === 'object' && body !== null && 'event' in body) {
      return body as CubeCoverEvent;
    }
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/insurance/cubecover.test.ts --forceExit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/insurance/cubecover.ts tests/insurance/cubecover.test.ts
git commit -m "feat(insurance): CubeCover API client"
```

---

### Task 3: Insurance Service (business logic)

**Files:**
- Create: `src/services/insurance/index.ts` — service layer
- Create: `tests/insurance/service.test.ts` — service tests

**Interfaces:**
- Consumes: `CubeCoverClient`, Prisma `InsurancePolicy`/`InsuranceClaim` models, wallet service
- Produces: `InsuranceService` with methods: `getProducts`, `purchasePlan`, `getMemberPolicy`, `cancelPolicy`, `renewPolicy`, `submitClaim`, `getClaim`, `listClaims`, `handleWebhook`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/insurance/service.test.ts
import { InsuranceService } from '../../src/services/insurance';

test('InsuranceService.getProducts returns products', async () => {
  const service = new InsuranceService({} as any);
  const products = await service.getProducts();
  expect(Array.isArray(products)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/insurance/service.test.ts --forceExit`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/insurance/index.ts
import { PrismaClient } from '@prisma/client';
import { CubeCoverClient } from './cubecover';
import { enqueueAfterCommit } from '../deferred';

export interface InsuranceServiceConfig {
  prisma: PrismaClient;
  cubecover: CubeCoverClient;
}

export class InsuranceService {
  private prisma: PrismaClient;
  private cubecover: CubeCoverClient;

  constructor(config: InsuranceServiceConfig) {
    this.prisma = config.prisma;
    this.cubecover = config.cubecover;
  }

  async getProducts() {
    return this.cubecover.getProducts();
  }

  async purchasePlan(cooperativeId: string, memberId: string, productCode: string, planCode: string) {
    const quote = await this.cubecover.createQuote({ productCode, planCode, memberId });
    const policy = await this.cubecover.purchasePolicy({
      quoteId: quote.quoteId,
      memberId,
      paymentRef: `insurance_${Date.now()}`,
    });
    return this.prisma.insurancePolicy.create({
      data: {
        cooperativeId,
        memberId,
        productCode,
        planCode,
        premiumKobo: quote.premiumKobo,
        coverageKobo: policy.coverageKobo || 0,
        cubecoverPolicyId: policy.id,
        startDate: new Date(policy.startDate),
        endDate: policy.endDate ? new Date(policy.endDate) : undefined,
      },
    });
  }

  async getMemberPolicy(cooperativeId: string, memberId: string) {
    return this.prisma.insurancePolicy.findFirst({
      where: { cooperativeId, memberId, status: 'active' },
    });
  }

  async cancelPolicy(cooperativeId: string, policyId: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId },
    });
    if (!policy) throw new Error('Policy not found');
    await this.cubecover.cancelPolicy(policy.cubecoverPolicyId!);
    return this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: { status: 'cancelled' },
    });
  }

  async renewPolicy(cooperativeId: string, policyId: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId },
    });
    if (!policy) throw new Error('Policy not found');
    const renewed = await this.cubecover.renewPolicy(policy.cubecoverPolicyId!);
    return this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: {
        status: 'active',
        startDate: new Date(renewed.startDate),
        endDate: renewed.endDate ? new Date(renewed.endDate) : undefined,
      },
    });
  }

  async submitClaim(cooperativeId: string, memberId: string, policyId: string, claimType: string, amountKobo: number, description?: string, documents?: string[]) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId, memberId, status: 'active' },
    });
    if (!policy) throw new Error('Active policy not found');
    const claim = await this.cubecover.submitClaim({
      policyId: policy.cubecoverPolicyId!,
      claimType,
      amountKobo,
      description,
      documents,
    });
    return this.prisma.insuranceClaim.create({
      data: {
        cooperativeId,
        memberId,
        policyId,
        claimType,
        amountKobo,
        cubecoverClaimId: claim.id,
        description,
        documents: documents || [],
      },
    });
  }

  async getClaim(cooperativeId: string, claimId: string) {
    return this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, cooperativeId },
    });
  }

  async listClaims(cooperativeId: string, memberId: string) {
    return this.prisma.insuranceClaim.findMany({
      where: { cooperativeId, memberId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async handleWebhook(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'policy.created':
      case 'policy.renewed':
        await this.prisma.insurancePolicy.updateMany({
          where: { cubecoverPolicyId: data.id as string },
          data: { status: 'active' },
        });
        break;
      case 'policy.cancelled':
        await this.prisma.insurancePolicy.updateMany({
          where: { cubecoverPolicyId: data.id as string },
          data: { status: 'cancelled' },
        });
        break;
      case 'claim.approved':
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: data.id as string },
          data: { status: 'approved', processedAt: new Date() },
        });
        break;
      case 'claim.paid':
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: data.id as string },
          data: { status: 'paid', paidAt: new Date() },
        });
        break;
      case 'claim.rejected':
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: data.id as string },
          data: { status: 'rejected', processedAt: new Date() },
        });
        break;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/insurance/service.test.ts --forceExit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/insurance/index.ts tests/insurance/service.test.ts
git commit -m "feat(insurance): InsuranceService business logic"
```

---

### Task 4: Webhook Handler

**Files:**
- Modify: `src/services/webhooks.ts` — add cubecover adapter
- Create: `tests/insurance/webhook.test.ts` — webhook tests

**Interfaces:**
- Consumes: `CubeCoverClient.verifyWebhook`, `InsuranceService.handleWebhook`
- Produces: webhook endpoint at `/webhooks/cubecover`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/insurance/webhook.test.ts
test('webhook handler verifies and processes cubecover events', async () => {
  // stub and verify
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add cubecover to webhook router**

```typescript
// src/services/webhooks.ts
import { CubeCoverClient } from './insurance/cubecover';

const cubecoverClient = new CubeCoverClient({
  apiKey: process.env.CUBECOVER_API_KEY!,
  baseUrl: process.env.CUBECOVER_BASE_URL || 'https://api.cubecover.ai',
});

// Add to adapters map:
adapters['cubecover'] = {
  verify: (rawBody, headers) => cubecoverClient.verifyWebhook(rawBody, headers['verif-hash'] as string),
  parse: (body) => cubecoverClient.parseNotification(body),
};

// Add to SIGNATURE_HEADERS:
SIGNATURE_HEADERS['cubecover'] = 'verif-hash';
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/services/webhooks.ts tests/insurance/webhook.test.ts
git commit -m "feat(insurance): CubeCover webhook handler"
```

---

### Task 5: Bot Commands + Session States

**Files:**
- Modify: `src/services/conversation.ts` — add insurance states
- Modify: `src/services/handlers/session.ts` — add insurance handlers
- Create: `src/services/handlers/insurance.ts` — insurance command handlers
- Modify: `src/lib/config.ts` — add insurance config
- Modify: `.env.example` — add CubeCover env vars

**Interfaces:**
- Consumes: `InsuranceService`, existing session handler patterns
- Produces: commands: `insurance`, `buyinsurance`, `mypolicy`, `renewinsurance`, `cancelinsurance`, `claim`, `myclaims`, `doctor`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/insurance/commands.test.ts
test('insurance command shows available plans', async () => {
  // stub and verify
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add session states to conversation.ts**

```typescript
// src/services/conversation.ts
// Add to FlowDataSchema:
awaiting_insurance_product: z.boolean().optional(),
awaiting_insurance_plan: z.boolean().optional(),
awaiting_insurance_confirm: z.boolean().optional(),
awaiting_claim_type: z.boolean().optional(),
awaiting_claim_documents: z.boolean().optional(),
insuranceProduct: z.string().optional(),
insurancePlan: z.string().optional(),
claimType: z.string().optional(),
```

- [ ] **Step 4: Add insurance handlers**

```typescript
// src/services/handlers/insurance.ts
export async function handleInsuranceBrowse(ctx: BotContext) {
  const products = await ctx.insurance.getProducts();
  // format and send product list
}

export async function handleStartInsurancePurchase(ctx: BotContext, productCode: string, planCode: string) {
  // show plan details, ask for confirmation
}

export async function handleMyPolicy(ctx: BotContext) {
  const policy = await ctx.insurance.getMemberPolicy(ctx.cooperativeId, ctx.memberId);
  // format and send policy details
}

export async function handleRenewInsurance(ctx: BotContext) {
  // renew policy
}

export async function handleCancelInsurance(ctx: BotContext) {
  // cancel policy
}

export async function handleStartClaim(ctx: BotContext, claimType: string) {
  // guided claim flow
}

export async function handleMyClaims(ctx: BotContext) {
  const claims = await ctx.insurance.listClaims(ctx.cooperativeId, ctx.memberId);
  // format and send claims list
}

export async function handleDoctor(ctx: BotContext) {
  // deep link to CubeCover telemedicine
}
```

- [ ] **Step 5: Register handlers in session.ts**

```typescript
// src/services/handlers/session.ts
// Add to command router:
'insurance': handleInsuranceBrowse,
'buyinsurance': handleStartInsurancePurchase,
'mypolicy': handleMyPolicy,
'renewinsurance': handleRenewInsurance,
'cancelinsurance': handleCancelInsurance,
'claim': handleStartClaim,
'myclaims': handleMyClaims,
'doctor': handleDoctor,
```

- [ ] **Step 6: Add env vars to .env.example**

```env
CUBECOVER_API_KEY=
CUBECOVER_WEBHOOK_SECRET=
CUBECOVER_BASE_URL=https://api.cubecover.ai
```

- [ ] **Step 7: Run test to verify it passes**

- [ ] **Step 8: Commit**

```bash
git add src/services/conversation.ts src/services/handlers/session.ts src/services/handlers/insurance.ts src/lib/config.ts .env.example tests/insurance/commands.test.ts
git commit -m "feat(insurance): bot commands and session states"
```

---

### Task 6: Admin Commands + Report

**Files:**
- Modify: `src/services/handlers/admin.ts` — add admin insurance commands
- Create: `tests/insurance/admin.test.ts` — admin tests

**Interfaces:**
- Consumes: `InsuranceService`
- Produces: `insurancereport`, `insuranceconfig` admin commands

- [ ] **Step 1: Write the failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add admin handlers**

```typescript
// src/services/handlers/admin.ts
export async function handleInsuranceReport(ctx: BotContext) {
  // coop-wide stats: policies, claims, premiums collected
}

export async function handleInsuranceConfig(ctx: BotContext) {
  // enable/disable products, set default plans
}
```

- [ ] **Step 4: Register in admin router**

- [ ] **Step 5: Run test to verify it passes**

- [ ] **Step 6: Commit**

```bash
git add src/services/handlers/admin.ts tests/insurance/admin.test.ts
git commit -m "feat(insurance): admin commands and report"
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/insurance.md` — user-facing docs
- Modify: `README.md` — add insurance section

- [ ] **Step 1: Write user docs**

- [ ] **Step 2: Update README**

- [ ] **Step 3: Commit**

```bash
git add docs/insurance.md README.md
git commit -m "docs(insurance): user documentation"
```

---

## Self-Review Checklist

- [ ] Spec coverage: All spec sections have corresponding tasks
- [ ] Placeholder scan: No "TBD", "TODO", or vague steps
- [ ] Type consistency: `CubeCoverClient`, `InsuranceService`, `InsurancePolicy`, `InsuranceClaim` names consistent across tasks
- [ ] Money safety: All payouts use `enqueueAfterCommit`
- [ ] RLS: Both tables have `cooperativeId` + FORCE entries