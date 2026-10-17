# Referral Bonus Balance + Member-Chosen Withdrawal — Design

**Date:** 2026-10-08
**Status:** Draft — pending user review
**Feature:** Referral (roadmap Feature 9) — reward payout redesign
**Branch:** `feat/world-class`
**Supersedes:** the confirm-at-qualification flow (`9eb27f6`): `confirmreward`/`cancelreward`, the re-prompt job, and `referralpay` force-pay.

## Goal

Turn referral rewards into a **running bonus balance** the member owns, and let the
member **withdraw any amount** of it to a destination of their choice — their wallet,
their saved bank account, or airtime to any phone number — confirmed with their PIN.
Works on **WhatsApp and Telegram**.

## Decisions (user, 2026-10-08)

1. **Running bonus balance** — rewards accumulate; the member withdraws any amount up
   to the balance, any time (partial withdrawals allowed).
2. **Destinations:** wallet, bank (their saved account), airtime (any phone number).
3. **Airtime phone:** any number the member enters (no ownership check).
4. **Bank account must be theirs** — the member's own saved bank account only.
5. `CooperativeConfig.referralRewardType` is kept as the **default destination**
   pre-selected in the withdrawal flow (the member can change it).
6. **Withdrawals are recorded** in a dedicated `ReferralWithdrawal` table.
7. Both channels (WhatsApp + Telegram).

## Non-goals

- No multi-level/MLM referrals (unchanged).
- No arbitrary bank account entry (bank destination is the member's saved account only).
- No change to how a referral is *earned* (first real contribution qualifies it).

## Data model

### `Member` (add column)
- `referralBonusBalance Int @default(0)` — kobo; the member's withdrawable referral bonus.

### `ReferralWithdrawal` (new table)
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `cooperativeId` | String | RLS tenant key |
| `memberId` | String | the withdrawing member |
| `amount` | Int | kobo |
| `destination` | String | `wallet` \| `bank` \| `airtime` |
| `phone` | String? | airtime destination number |
| `status` | String @default("pending") | `pending` \| `paid` \| `failed` |
| `providerRef` | String? | payout/VTU reference |
| `note` | String? | failure reason / detail |
| `createdAt` | DateTime @default(now()) | |
| `paidAt` | DateTime? | |

Indexes: `@@index([cooperativeId, memberId])`, `@@index([cooperativeId, status])`.

**RLS:** `ReferralWithdrawal` carries `cooperativeId` → Stage-1 direct policy + FORCE-list
entry. `Member.referralBonusBalance` is a column (no new RLS).

## Earning (qualification)

When a referral qualifies (referred member's first real contribution — unchanged):
- snapshot `rewardType`/`rewardAmount` (unchanged),
- **credit the referrer's `referralBonusBalance += rewardAmount`** (atomic increment),
- mark the referral `rewarded` (the bonus has been granted),
- audit `referral.bonus.credited`.

No provider call and no member action at qualification — so there is no payout dead-end
and no re-prompt job. (The reward is now a balance credit, not a disbursement.)

## Withdrawal flow (member-initiated)

Commands:
- `referralbonus` — show the current bonus balance + how to withdraw.
- `withdrawbonus` — guided flow:
  1. **amount** (`awaiting_bonus_amount`) — must be > 0 and ≤ balance.
  2. **destination** (`awaiting_bonus_destination`) — `wallet` | `bank` | `airtime`
     (default = `CooperativeConfig.referralRewardType`).
  3. **phone** (`awaiting_bonus_phone`) — only when destination is `airtime`; any number.
  4. **PIN** (`awaiting_bonus_pin`) — `verifyMemberPin`; re-challenge on failure.
  5. **disburse** — debit the balance atomically, then pay:
     - `wallet` → credit the member's wallet (journal `expense:referral_reward` DEBIT /
       `member_wallet:<walletId>` CREDIT).
     - `bank` → `sendToBank` to the member's **saved** account (must exist; else refuse).
     - `airtime` → VTU adapter `recharge({ phone, amountKobo, reference })`.
  - Record a `ReferralWithdrawal` row (`pending` → `paid`/`failed`); audit
    `referral.bonus.withdrawn`.

**Atomicity / money-safety:**
- Debit the balance with a conditional update (`balance >= amount`) so concurrent
  withdrawals cannot overdraw; create the `ReferralWithdrawal` row in the same tx.
- The provider payout (bank/airtime) runs **outside any DB transaction** — the chat
  handler is one tx, so defer it via `enqueueAfterCommit` (fallback to immediate await).
- On a definite payout failure, refund the balance (re-credit) and mark the withdrawal
  `failed`; on an `unsure` outcome, keep it `pending` for reconciliation (do not refund,
  do not retry blindly).
- Idempotent: a withdrawal is claimed once; the provider reference is deterministic
  (`REFBONUS-<withdrawalId>`).
- **Reconciliation:** `pending` (unsure) withdrawals are surfaced in `referralreport`
  and settled by the existing payout reconciliation path (poll the provider by
  `providerRef`); a small `runReferralWithdrawalReconcile` job may be added if the
  existing path does not cover VTU/bank withdrawals.

## Commands summary

- Member: `referralbonus`, `withdrawbonus` (guided), `myrefcode`, `referrals`.
- Admin: `referralconfig`, `referralreport` (add bonus-outstanding + withdrawals stats).
- **Removed:** `confirmreward`, `cancelreward`, `referralpay`, and the
  `runReferralRewardPrompts`/`runReferralPayouts` scheduler job (no longer needed).

## Config

- `referralEnabled`, `referralRewardAmount` (bonus per referral), `referralMaxRewards`
  (cap) — unchanged.
- `referralRewardType` — now the **default destination** in the withdrawal flow.

## Testing

- Qualification credits the referrer's bonus balance and marks the referral `rewarded`
  (no provider call).
- `withdrawbonus` guided flow: amount validation (≤ balance, > 0), destination default
  from config, airtime phone capture, PIN gate.
- Wallet withdrawal credits the wallet + debits the balance + records the withdrawal.
- Bank withdrawal uses the member's saved account; refuses when none.
- Airtime withdrawal recharges the entered number via the VTU adapter.
- Overdraw is impossible (conditional debit); concurrent withdrawals safe.
- Definite payout failure refunds the balance; `unsure` stays `pending`.
- Both channels (the flow is channel-agnostic session states).
- RLS/schema-sync.

## Open risks

- **Balance vs. ledger:** the balance is a denormalized field; every credit/debit is
  audited and mirrored by `Referral`/`ReferralWithdrawal` rows, but a reconciliation
  check (balance == credited − withdrawn) is advisable.
- **Airtime to any number** is a fraud vector (bonus → arbitrary phone). Accepted per
  user decision; mitigated by the PIN + the per-referrer cap.
- **`referralRewardType` semantics change** (fixed type → default destination); existing
  configs keep working as a default.