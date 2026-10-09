# SuperCare Embedded Health Insurance

## Overview

Coop members have access to SuperCare, an embedded health insurance plan provided through CubeCover.ai. Insurance is optional and can be added during onboarding or at any time afterward.

## Features

- **Unlimited teleconsultations** — Wait 2-10 minutes to connect with a doctor without leaving the platform
- **Prescriptions** — Once every 30 days, covered medication
- **Hospicash** — ₦60,000/month cash benefit during hospitalization
- **Age requirement** — Adults 18+
- **48-hour claim settlement** — Fast processing for approved claims
- **Deep-linked telemedicine** — Consult entirely within the cooperative platform

## Adding Insurance

Members can add insurance through the bot:

1. Reply `insurance` to browse available products and plans
2. Select a product and plan
3. Confirm the purchase (premium is deferred via `enqueueAfterCommit` so it never runs inside a transaction)
4. Your coverage begins immediately

## Commands

| Command | Description |
|---------|-------------|
| `insurance` | Browse available SuperCare products and plans |
| `mypolicy` | View your current policy details |
| `claim <type> <amount>` | Submit a new insurance claim |
| `myclaims` | List your insurance claims |
| `doctor` | Connect to the in-platform telemedicine service |

## Admin Commands (superadmin)

| Command | Description |
|---------|-------------|
| `insurance` | List all insurance policies across the coop |
| `insuranceclaim <id>` | View claim details |
| `approveinsuranceclaim <id>` | Approve a claim for payout |
| `rejectinsuranceclaim <id>` | Reject a claim |
| `listinsuranceclaims <code>` | List claims for a specific member |

## How It Works

- **Premiums** are deducted via deferred after-commit transactions, ensuring they never run inside a database transaction
- **Claims** are processed through the CubeCover API; approved claims are settled within 48 hours
- **Teleconsultations** use a deep-link relay that keeps the user within the cooperative platform
- **All money amounts** are stored in kobo (integer) for precision; displayed in naira using `formatBalance`

## Technical Details

- **API**: `https://api.cubecover.ai` with Bearer token authentication
- **Webhook**: Events signed with `verif-hash` header (sha256 HMAC of raw body with webhook secret)
- **Events**: `policy.created`, `policy.renewed`, `policy.cancelled`, `claim.approved`, `claim.paid`, `claim.rejected`
- **Models**: `InsurancePolicy`, `InsuranceClaim` (added to `prisma/schema.prisma` and `prisma/schema.local.prisma`)
- **RLS**: Both tables have FORCE entries in `prisma/rls/recommended_policies.sql`