# Coop WhatsApp Bank

A Xara-style cooperative banking platform that runs entirely inside WhatsApp.
Cooperatives register once, and members join, save, check balances, and (soon)
borrow and earn dividends — all by chatting. Nigeria-first, grouped by state,
built for global expansion.

## Stack

- **Runtime:** Node.js 22 + TypeScript
- **API:** Fastify 5
- **DB:** Prisma + SQLite (dev) / Postgres (prod)
- **WhatsApp:** Meta WhatsApp Cloud API

## Quick start

```bash
cp .env.example .env     # fill in your Meta credentials
npm install
npm run prisma:push      # sync DB schema
npm run dev              # start server on :3000
```

## Project layout

```
src/
  index.ts               # entrypoint
  app.ts                 # Fastify app (+ serves built admin dashboard)
  config.ts              # env config + phone allowlist
  seed.ts                # create a coop + admin via CLI
  routes/webhook.ts      # Meta webhook verify + receive
  routes/payments.ts     # payment provider webhooks (flutterwave/paystack)
  routes/admin.ts        # REST API for the admin dashboard
  lib/prisma.ts          # Prisma client
  lib/whatsapp.ts        # Meta Cloud API message sender
  services/conversation.ts  # bot state machine + chat flows
  services/cooperative.ts   # members, wallets, contributions
  services/loans.ts         # loan applications, approval, repayments
  services/admin.ts         # admin auth + WhatsApp admin commands
  services/payments/        # provider adapter + flutterwave + paystack + topup
prisma/schema.prisma     # data model
web/                     # React + Vite admin dashboard
tests/                   # vitest smoke tests
```

## WhatsApp bot commands

| Command | What it does |
| --- | --- |
| `menu` / `help` | Show available commands |
| `join <code>` | Join a cooperative by its code |
| `balance` | Check savings balance |
| `save <amount>` | Make a contribution (e.g. `save 2000`) |
| `fund` | Get your personal virtual account number for top-ups |
| `loan <amount> <months>` | Apply for a loan (e.g. `loan 50000 3`) |
| `repay` | Pay the monthly installment on your active loan |
| `code` | See your member code (share it for guarantor requests) |
| `confirm <code>` | Accept a guarantor request |

Multi-turn onboarding: `join TEST01` → name → set 4-digit PIN → confirm →
done. You receive a short **member code** on joining.

## Loan guarantor flow

Every loan requires **2 guarantors**, and each must confirm before the loan
can be approved:

1. `loan <amount> <months>` creates the application.
2. The bot asks for guarantor 1's member code, then guarantor 2's.
3. For each valid guarantor, the system **auto-generates a unique code**
   (e.g. `GT-A1B2C3`) and sends it to that guarantor's WhatsApp.
4. Each guarantor replies `confirm <code>` to accept.
5. The loan only becomes `guaranteed` (approvable) once **both** guarantors
   confirm. Admins can't approve earlier.
6. Admin replies `approve <id>` (or uses the dashboard) to approve.

Rules enforced: you can't be your own guarantor, a member can only appear
once per loan, and unknown member codes are rejected.

## Admin WhatsApp commands

Admins (members with `role: admin`) get extra commands:

| Command | What it does |
| --- | --- |
| `pending` | List pending loan applications |
| `approve <loan id>` | Approve a pending loan |
| `reject <loan id>` | Reject a pending loan |
| `payout <amount> <phone>` | Send a payout to a member |

## Admin dashboard

The web dashboard is a React + Vite SPA in `web/`. It's served by the Fastify
app at `/` after a production build.

```bash
cd web && npm install && npm run build   # build once
cd .. && npm run dev                     # serve API + dashboard on :3000
```

Admins sign in with their WhatsApp phone + PIN. The dashboard shows an
overview, members, loans (approve/reject), contributions, and payouts.

## Seeding a cooperative

```bash
npx tsx src/seed.ts \
  --name "Oyo Farmers Coop" \
  --code OYOF1 \
  --state Oyo \
  --admin-name "Ade Ade" \
  --admin-phone 2348012345678 \
  --admin-pin 1234
```

## Webhook setup (Meta Cloud API)

1. In the Meta developer app, add the **WhatsApp** product and link a test
   phone number.
2. Configure the webhook URL: `https://your-host/webhook`
3. Use `WHATSAPP_VERIFY_TOKEN` as the verify token and subscribe to the
   `messages` field.
4. Set `WHATSAPP_TOKEN` (a system-user access token) and
   `WHATSAPP_PHONE_NUMBER_ID` in `.env`.
5. Use `ALLOWED_TEST_NUMBERS` to restrict who can talk to the bot during
   development.

For local testing without a public host, use a tunnel like `cloudflared
tunnel --url http://localhost:3000`.

## Seeding a cooperative

With no CLI admin yet, insert a cooperative directly so members can join:

```bash
npx tsx -e "import { prisma } from './src/lib/prisma.js'; await prisma.cooperative.create({ data: { name: 'Test Farmers Coop', code: 'TEST01', state: 'Oyo' } }); console.log('created'); process.exit(0);"
```

## Roadmap

- [x] Phase 1: onboarding, balance, savings (this repo)
- [x] Phase 2: payment adapter (Flutterwave + Paystack), virtual-account top-ups,
      loans + approvals, admin dashboard, admin WhatsApp commands, payouts
- [ ] Phase 3: dividends, marketplace, state/LGA grouping, Pidgin
- [ ] Phase 4: scale, more languages, other countries

## Tests

```bash
npm test
```