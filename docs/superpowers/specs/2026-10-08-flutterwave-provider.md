# Flutterwave ProviderAdapter — Full Integration

**Date:** 2026-10-08
**Status:** Draft
**Feature:** Add Flutterwave as 3rd payment provider (peer to Monnify/Paystack)
**Branch:** `feat/world-class`

## Goal

Implement a complete `ProviderAdapter` for Flutterwave so cooperatives can use Flutterwave for:
- Virtual account creation (collections)
- Payouts/bank transfers
- Account name resolution
- Bank list
- Webhook verification & parsing
- Direct debit mandates (if supported)

## Architecture

Follow the existing `ProviderAdapter` interface in `src/services/payments/index.ts`. Add `flutterwave.ts` alongside `monnify.ts` and `paystack.ts`. Register in `adapterFor()` and `ALL_PROVIDERS`.

## Flutterwave API Reference (from public docs)

**Base URL:** `https://api.flutterwave.com/v3`
**Auth:** `Authorization: Bearer <FLUTTERWAVE_SECRET_KEY>`
**Webhook signature:** `verif-hash` header = SHA256(webhook secret + payload)

### Endpoints needed

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Create virtual account | `/virtual-account-numbers` | POST |
| List banks | `/banks/NG` | GET |
| Resolve account | `/accounts/resolve` | POST |
| Initiate transfer (payout) | `/transfers` | POST |
| Verify transfer | `/transfers/{id}/verify` | GET |
| Create mandate | `/payment-plans` (or `/mandates`) | POST |
| Verify webhook | `verif-hash` header | — |

### Virtual Account (Collections)
- **Create:** `POST /virtual-account-numbers` with `{email, tx_ref, amount, currency, ...}`
- **Webhook:** `charge.completed` event → parse to `PaymentNotification`

### Payouts (Transfers)
- **Create:** `POST /transfers` with `{account_bank, account_number, amount, currency, reference, ...}`
- **Status:** `GET /transfers/{id}/verify` → `status: SUCCESSFUL|FAILED|PENDING`
- **Webhook:** `transfer.completed` / `transfer.failed`

### Account Resolution
- `POST /accounts/resolve` with `{account_number, account_bank}` → `{account_name}`

### Banks
- `GET /banks/NG` → list of `{code, name}`

### Mandates (Direct Debit)
- Flutterwave supports "Payment Plans" for recurring payments. Need to verify exact endpoint.

## Implementation Plan

### Task 1: Flutterwave Adapter (`src/services/payments/flutterwave.ts`)
- Implement `ProviderAdapter` interface
- HTTP client with auth header
- All methods: `createVirtualAccount`, `payout`, `resolveAccount`, `listBanks`, `verifyWebhook`, `parseNotification`, `parsePayoutNotification`, `getTransferStatus`, `createMandate`, `debitMandate`, `cancelMandate`, `triggerActivationCharge`
- Error handling: map Flutterwave error codes to our `PayoutResult` / `MandateResult`

### Task 2: Registration & Config
- Add `flutterwave` to `ALL_PROVIDERS` and `adapterFor()` in `index.ts`
- Add `FLUTTERWAVE_SECRET_KEY` to `.env.example`
- Update `resolveProvider` to include flutterwave

### Task 3: Webhook Routes
- Add Flutterwave webhook handler in `src/services/webhooks.ts` (or similar)
- Verify `verif-hash` signature
- Parse `charge.completed` → `PaymentNotification`
- Parse `transfer.completed/failed` → `PayoutNotification`

### Task 4: Tests
- Unit tests with stubbed `fetch`
- Integration test: create VA, simulate webhook, verify credit
- Payout test with stubbed transfer API

### Task 5: Docs
- Update README with Flutterwave as provider option

## Open Questions
- Does Flutterwave support direct debit mandates via API? (Need to verify)
- Webhook retry policy / idempotency handling
- Sandbox vs production URL differences

## Credentials (to be added to .env)
```
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-...
FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_TEST-...
FLUTTERWAVE_WEBHOOK_SECRET=...
```