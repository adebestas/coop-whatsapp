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

### Task 1: Schema + Migration + RLS ✅ **COMPLETE**

**Files modified:**
- `prisma/schema.prisma` — added `InsurancePolicy` and `InsuranceClaim` models
- `prisma/schema.local.prisma` — added same models (SQLite mirror for tests)
- `prisma/rls/recommended_policies.sql` — added FORCE entries for both tables
- Migration: `prisma/migrations/20261047000000_cubecover_insurance/migration.sql` — already existed

**Schema changes:**
- `InsurancePolicy` model: id, cooperativeId, memberId, productCode, planCode, status, cubecoverPolicyId, premiumKobo, coverageKobo, startDate, endDate, autoRenew, createdAt, updatedAt
- `InsuranceClaim` model: id, cooperativeId, memberId, policyId, claimType, amountKobo, status, cubecoverClaimId, description, documents, payoutKobo, payoutDestination, createdAt, processedAt, paidAt

**Verification:**
- `npx prisma generate` succeeds ✅
- Prisma client generates for both `schema.prisma` and `schema.local.prisma` ✅

**Files:**
- Modify: `prisma/schema.prisma` — add `InsurancePolicy` and `InsuranceClaim` models ✅
- Modify: `prisma/schema.local.prisma` — add same models ✅
- Create: `prisma/migrations/20261047000000_cubecover_insurance/migration.sql` — exists ✅
- Modify: `prisma/rls/recommended_policies.sql` — add FORCE entries ✅

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

Run: `npx vitest tests/insurance/cubecover.test.ts --forceExit`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/insurance/cubecover.ts
import fetch from 'node-fetch';

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

Run: `npx vitest tests/insurance/cubecover.test.ts --forceExit`
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

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write minimal implementation**

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

---

### Task 4: Webhook Handler

**Files:**
- Modify: `src/services/webhooks.ts` — add cubecover adapter
- Create: `tests/insurance/webhook.test.ts` — webhook tests

- [ ] **Step 1: Write the failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add cubecover to webhook router**

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

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

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add session states to conversation.ts**

- [ ] **Step 4: Add insurance handlers**

- [ ] **Step 5: Register handlers in session.ts**

- [ ] **Step 6: Add env vars to .env.example**

- [ ] **Step 7: Run test to verify it passes**

- [ ] **Step 8: Commit**

---

### Task 6: Admin Commands + Report

**Files:**
- Modify: `src/services/handlers/admin.ts` — add admin insurance commands
- Create: `tests/insurance/admin.test.ts` — admin tests

- [ ] **Step 1: Write the failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add admin handlers**

- [ ] **Step 4: Register in admin router**

- [ ] **Step 5: Run test to verify it passes**

- [ ] **Step 6: Commit**

---

### Task 7: Documentation

**Files:**
- Create: `docs/insurance.md` — user-facing docs
- Modify: `README.md` — add insurance section

- [ ] **Step 1: Write user docs**

- [ ] **Step 2: Update README**

- [ ] **Step 3: Commit**

---

## Self-Review Checklist

- [ ] Spec coverage: All spec sections have corresponding tasks
- [ ] Placeholder scan: No "TBD", "TODO", or vague steps
- [ ] Type consistency: `CubeCoverClient`, `InsuranceService`, `InsurancePolicy`, `InsuranceClaim` names consistent across tasks
- [ ] Money safety: All payouts use `enqueueAfterCommit`
- [ ] RLS: Both tables have `cooperativeId` + FORCE entries