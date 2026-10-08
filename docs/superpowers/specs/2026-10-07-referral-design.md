# Referral / Member-Get-Member — Design

**Date:** 2026-10-07
**Status:** Approved (design) — pending spec review
**Feature:** Roadmap Phase 4, Feature 10 (Referral / member-get-member)
**Branch:** `feat/world-class`

## Goal

Let members grow the cooperative: a member shares their **referral code**, a new
member joins with it, and once the referred member makes their **first qualifying
contribution** the referrer earns a reward — paid to their **wallet**, their **bank
account**, or as **airtime recharge**.

## Decisions (user, 2026-10-07)

1. **Referral code:** reuse the member's existing unique `code` (e.g. `A1B2C3`).
2. **Reward:** per-coop configurable — **wallet credit**, **bank payout**, or
   **airtime recharge**. Default reward amount **₦500** (50,000 kobo).
3. **Trigger:** reward the referrer when the referred member makes their **first
   qualifying contribution** (anti-abuse: fake sign-ups earn nothing).
4. **Airtime:** implemented behind a **VTU provider adapter**, **gated** until the
   provider is configured (the user will enable a VTU provider).
5. **Anti-abuse:** one reward per referred member, self-referral blocked, per-referrer
   cap, reward only on first contribution.
6. **Pause/activate:** the **Board committee** (governance) can pause/activate the
   referral program, in addition to the admin/superadmin config command.
7. **Optional at registration:** the referral code is **optional** — a member can join
   with or without one (`join <coop code>` or `join <coop code> ref <code>`); no
   referral is recorded when omitted.

## Non-goals

- No USSD/SMS (WhatsApp-only program constraint).
- No general bill-payments/airtime product (only the referral airtime reward; the
  VTU adapter is scoped to that).
- No multi-level/MLM referrals (single level only).

## Architecture

### Data model (both `schema.prisma` and `schema.local.prisma`; migration + RLS)

**`Referral`**
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `cooperativeId` | String | RLS tenant key |
| `referrerId` | String | the member who shared the code |
| `referredMemberId` | String @unique | one reward per referred member |
| `code` | String | the referrer's code used |
| `status` | String @default("pending") | `pending` \| `qualified` \| `rewarded` \| `rejected` |
| `qualifiedAt` | DateTime? | first qualifying contribution |
| `rewardType` | String? | `wallet` \| `bank` \| `airtime` (snapshot at qualification) |
| `rewardAmount` | Int? | kobo (snapshot at qualification) |
| `rewardedAt` | DateTime? | |
| `createdAt` | DateTime @default(now()) | |

Indexes: `@@index([cooperativeId, referrerId])`, `@@index([cooperativeId, status])`.

**`CooperativeConfig`** additions:
- `referralEnabled Boolean @default(false)`
- `referralRewardType String @default("wallet")` (`wallet|bank|airtime`)
- `referralRewardAmount Int @default(50000)` (kobo = ₦500)
- `referralMaxRewards Int @default(0)` (cap per referrer; 0 = unlimited)

**RLS:** `Referral` carries `cooperativeId` → Stage-1 direct policy + FORCE-list entry.

### Join capture

The new member enters the referrer's code during join: `join <coop code> ref
<referrer code>` (and a step in the onboarding flow). Records a `pending` `Referral`.
Self-referral and unknown codes are rejected (the join still succeeds; the referral
is just not recorded).

### Qualification

When the referred member makes their **first qualifying contribution**, the
`Referral` flips to `qualified` (snapshotting `rewardType` + `rewardAmount` from the
coop config at that moment) and the reward is paid. Idempotent (one reward per
referred member).

### Reward payment

- **wallet** → credit the referrer's wallet: journal `expense:referral_reward` DEBIT /
  `member_wallet:<referrer>` CREDIT; notify.
- **bank** → payout to the referrer's saved bank account via the existing payout path.
- **airtime** → via a new **VTU provider adapter** (`src/services/payments/vtu.ts`),
  **gated** until configured (returns a clear "airtime reward not enabled" and leaves
  the referral `qualified` for later payout).

Every reward is audited; the referral is marked `rewarded` on success.

### Commands

- Member: `myrefcode` (show your code + a share message), `referrals` (your referrals
  + earnings).
- Admin: `referralconfig [on|off] [wallet|bank|airtime] [amount] [maxRewards]`,
  `referralreport`.

### Anti-abuse

- One reward per referred member (`referredMemberId @unique`).
- Self-referral blocked.
- Per-referrer cap (`referralMaxRewards`).
- Reward only on the first qualifying contribution.
- Every reward audited.

## Testing

- Join with a referral code records a `pending` `Referral`; self-referral + unknown
  code rejected.
- First qualifying contribution → `qualified` + reward paid (wallet/bank); airtime
  gated.
- Duplicate/self/cap rejection.
- RLS/schema-sync.

Full gate per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted
tests green · full suite green · schema-sync green.

## Phasing (one feature, built in order)

1. Schema + config.
2. Join capture + qualification.
3. Reward payment (wallet/bank) + VTU adapter (gated).
4. Commands + docs.

## Open risks

- **"First qualifying contribution"** must be pinned in the plan (which contribution
  types count; the existing `Contribution` model + `createContribution`).
- **VTU provider** is not wired; the adapter must be gated and the interface defined
  so enabling it later is a config change.
- **Reward snapshot** — already-qualified referrals keep their original amount if the
  coop later changes the config.
