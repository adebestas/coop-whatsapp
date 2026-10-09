# CubeCover Health Insurance Integration — Embedded Insurance for Cooperative Members

**Date:** 2026-10-08
**Status:** Draft
**Feature:** Embedded CubeCover health insurance (SuperCare) for cooperative members
**Branch:** `feat/world-class`

## Goal

Embed CubeCover's **SuperCare** health insurance into the cooperative platform so members can:
- Browse and purchase SuperCare plans directly in WhatsApp/Telegram
- Pay premiums from their wallet (kobo balance)
- File claims via the bot (teleconsultation, prescription, hospicash)
- Receive claim payouts to wallet or bank account
- Manage policy lifecycle (renew, cancel, view coverage)

## CubeCover Products (from research)

### SuperCare (Health Insurance)
| Feature | Details |
|---------|---------|
| **Teleconsultations** | Unlimited with licensed MDCN-registered doctors |
| **Prescriptions** | Unlimited, dispensed once every 30 days at partner pharmacies |
| **Hospicash** | ₦60,000/month for verified hospital stays (once/month) |
| **Eligibility** | Adults 18+ |
| **Waiting period** | 2 working days (pharmacy/hospitalization); none for telemedicine |
| **Claims processing** | 24-72 hours |
| **Partner network** | Nationwide teleconsultations; partner pharmacies for pickup |

### SuperFix (Device Insurance) — *Future phase*
- Screen/liquid damage coverage
- Plans: Starter (₦5k/₦50k), Basic (₦10k/₦100k), Plus (₦20k/₦200k), Elite (₦30k/₦300k)
- 12-month coverage

## Architecture

### Data Model
```prisma
model InsurancePolicy {
  id            String   @id @default(cuid())
  cooperativeId String
  cooperative   Cooperative @relation(fields: [cooperativeId], references: [id], onDelete: Cascade)
  memberId      String
  member        Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  productCode   String    // "supercare" | "superfix"
  planCode      String    // "starter" | "basic" | "plus" | "elite" | "standard"
  status        String    @default("active") // active | lapsed | cancelled | expired
  cubecoverPolicyId String? // CubeCover's policy ID
  premiumKobo   Int       // monthly premium in kobo
  coverageKobo  Int       // max coverage in kobo
  startDate     DateTime  @default(now())
  endDate       DateTime? // for fixed-term (SuperFix)
  autoRenew     Boolean   @default(true)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

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
  claimType       String    // "teleconsultation" | "prescription" | "hospicash" | "device_repair"
  amountKobo      Int       // claimed amount in kobo
  status          String    @default("pending") // pending | approved | paid | rejected | pending_review
  cubecoverClaimId String?  // CubeCover's claim ID
  description     String?
  documents       String[]  // document URLs/references
  payoutKobo      Int?      // actual payout amount
  payoutDestination String? // "wallet" | "bank"
  createdAt       DateTime  @default(now())
  processedAt     DateTime?
  paidAt          DateTime?

  @@index([cooperativeId, memberId])
  @@index([cooperativeId, status])
  @@index([policyId])
}
```

### RLS
- Both tables carry `cooperativeId` → Stage-1 RLS + FORCE-list entry

## CubeCover API Integration (from research)

### Base URL
```
https://api.cubecover.ai
```

### Authentication
- API Key in header: `Authorization: Bearer <CUBECOVER_API_KEY>`
- Webhook secret: `CUBECOVER_WEBHOOK_SECRET` for `verif-hash` style signature

### Key Endpoints (inferred from public docs + standard patterns)
| Operation | Endpoint | Method |
|-----------|----------|--------|
| Get plans | `/v1/products` | GET |
| Get plan details | `/v1/products/{code}` | GET |
| Create quote | `/v1/quotes` | POST |
| Purchase policy | `/v1/policies` | POST |
| Get policy | `/v1/policies/{id}` | GET |
| Cancel policy | `/v1/policies/{id}/cancel` | POST |
| Renew policy | `/v1/policies/{id}/renew` | POST |
| Submit claim | `/v1/claims` | POST |
| Get claim | `/v1/claims/{id}` | GET |
| List claims | `/v1/claims?policy_id={id}` | GET |
| Webhook events | `POST /webhooks/cubecover` | — |

### Webhook Events (inferred)
- `policy.created` — policy purchased
- `policy.renewed` — auto-renewal
- `policy.cancelled` — cancellation
- `claim.submitted` — claim filed
- `claim.approved` — claim approved
- `claim.paid` — claim paid out
- `claim.rejected` — claim rejected

## Member Flow (WhatsApp + Telegram)

### 1. Browse Plans
```
Member: *insurance*
Bot: Shows available SuperCare plans with pricing
```

### 2. Purchase Plan
```
Member: *buyinsurance supercare standard*
Bot: Shows plan details, premium (₦X/month), asks for confirmation
Member: *confirm*
Bot: Deducts first premium from wallet, calls CubeCover API, creates policy
```

### 3. Use Benefits
- **Teleconsultation**: `doctor` command → connects to CubeCover telemedicine (deep link or in-app)
- **Prescription**: After consultation, prescription sent to partner pharmacy → member picks up
- **Hospicash**: Member files claim via `claim hospicash` → uploads documents → processed in 24-72h → payout to wallet/bank

### 4. Manage Policy
- `mypolicy` — view active policy, coverage, next premium date
- `renewinsurance` — manual renewal
- `cancelinsurance` — cancel (with confirmation)

### 5. Claims
- `claim hospicash` — guided flow: upload discharge summary, invoice → submit to CubeCover
- `claim prescription` — view prescription history, pickup status
- `myclaims` — list all claims with status

## Commands

| Command | Description |
|---------|-------------|
| `insurance` | Browse available plans |
| `buyinsurance <product> <plan>` | Purchase a plan |
| `mypolicy` | View active policy |
| `renewinsurance` | Renew policy |
| `cancelinsurance` | Cancel policy |
| `claim hospicash` | File hospicash claim |
| `claim prescription` | View prescription status |
| `myclaims` | List all claims |
| `doctor` | Launch teleconsultation (deep link) |

## Admin Commands
- `insurancereport` — coop-wide stats (policies, claims, premiums collected)
- `insuranceconfig` — enable/disable products, set default plans

## Payment & Payout

### Premium Collection
- Monthly premium deducted from member's wallet (auto-renewal)
- If insufficient balance → policy lapses after grace period (7 days)
- Grace period notifications sent via WhatsApp/Telegram

### Claim Payouts
- **Hospicash**: Payout to wallet or saved bank account (member chooses at claim time)
- **Prescription**: No payout (medication dispensed at partner pharmacy)
- **Teleconsultation**: No payout (service provided directly)

## CubeCover API Client (new file)

```typescript
// src/services/insurance/cubecover.ts
export interface CubeCoverClient {
  getProducts(): Promise<Product[]>;
  getProduct(code: string): Promise<Product>;
  createQuote(params: QuoteParams): Promise<Quote>;
  purchasePolicy(params: PurchaseParams): Promise<Policy>;
  getPolicy(id: string): Promise<Policy>;
  cancelPolicy(id: string): Promise<void>;
  renewPolicy(id: string): Promise<Policy>;
  submitClaim(params: ClaimParams): Promise<Claim>;
  getClaim(id: string): Promise<Claim>;
  listClaims(policyId: string): Promise<Claim[]>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseNotification(body: unknown): CubeCoverEvent | null;
}
```

## Webhook Handler
- Add `cubecover` to `adapters` in `webhooks.ts`
- Signature: `verif-hash` header (SHA256 of raw body with webhook secret)
- Events: `policy.created`, `policy.renewed`, `policy.cancelled`, `claim.submitted`, `claim.approved`, `claim.paid`, `claim.rejected`
- Process: record webhook event → update local policy/claim → audit

## Configuration
```env
CUBECOVER_API_KEY=
CUBECOVER_WEBHOOK_SECRET=
CUBECOVER_BASE_URL=https://api.cubecover.ai
```

## Commands to Add
| Command | Handler |
|---------|---------|
| `insurance` | `handleInsuranceBrowse` |
| `buyinsurance` | `handleStartInsurancePurchase` |
| `mypolicy` | `handleMyPolicy` |
| `renewinsurance` | `handleRenewInsurance` |
| `cancelinsurance` | `handleCancelInsurance` |
| `claim` | `handleStartClaim` (sub-commands: hospicash, prescription) |
| `myclaims` | `handleMyClaims` |
| `doctor` | `handleDoctor` (deep link to telemedicine) |

## Session States (new)
- `awaiting_insurance_product` — choose product (supercare/superfix)
- `awaiting_insurance_plan` — choose plan
- `awaiting_insurance_confirm` — confirm purchase
- `awaiting_claim_type` — hospicash/prescription
- `awaiting_claim_documents` — upload docs for hospicash

## Tests
- Unit: CubeCover client (stubbed fetch)
- Integration: purchase flow, claim flow, webhook processing
- E2E: guided purchase → claim → payout

## Open Questions
1. Exact CubeCover API endpoints/auth (need their developer docs)
2. Webhook event payloads (need their webhook docs)
3. Sandbox environment availability
4. Exact premium amounts for each SuperCare plan
5. Whether SuperFix should be in scope for v1

## Next Steps
1. Get CubeCover API docs / sandbox credentials from user
2. Write implementation plan (writing-plans skill)
3. Implement CubeCover client + adapter
3. Add webhook handler
4. Implement member commands + session states
5. Add admin commands + report
5. Tests + docs