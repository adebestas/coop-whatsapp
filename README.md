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
| `plan <amount> <weekly\|monthly>` | Set a recurring contribution plan |
| `fund` | Get your personal virtual account number for top-ups |
| `loan <amount> <months>` | Apply for a loan (e.g. `loan 50000 3`) |
| `repay` | Pay the monthly installment on your active loan |
| `history` | Your personal transaction statement |
| `ledger` | Cooperative ledger — transparency for all members |
| `dividend <rate>` | Real-time dividend calculator |
| `joinunit <code>` | Join your workplace/unit |
| `code` | See your member code (share it for guarantor requests) |
| `confirm <code>` | Accept a guarantor request |
| `phone <number>` | Add/update your real phone number (needed for funding) |

Multi-turn onboarding: `join TEST01` → name → (Telegram: phone) → set 4-digit
PIN → confirm → done. You receive a short **member code** on joining.

## Admin commands

| Command | What it does |
| --- | --- |
| `pending` | List loan applications (workplace admins see their unit only) |
| `approve <id>` / `reject <id>` | Approve / reject a guaranteed loan (coop admin) |
| `payout <amount> <phone>` | Disburse money to a member (coop admin) |
| `broadcast <msg>` | Message all members (`broadcast unit <msg>` for your workplace) |
| `addunit <name> <code>` | Create a workplace/unit |
| `unitadmin <unitcode> <membercode>` | Assign a workplace admin |
| `units` | List workplaces |
| `interest <rate%>` | Set monthly interest on savings |
| `dividend <rate>` | Dividend calculator (real-time) |
| `paydividend <rate%>` | Distribute a dividend to all members |

## Channels: WhatsApp + Telegram

The bot runs on **both platforms** from the same codebase and database, so a
cooperative's members can mix freely between them.

- **WhatsApp** — Meta Cloud API webhook (`/webhooks/whatsapp`).
- **Telegram** — long-polling against the Bot API (no public URL needed).

A user is identified by channel-scoped id: a WhatsApp phone (`2348012345678`)
or a Telegram chat id (`tg:123456789`). All flows — onboarding, savings,
loans, guarantors, admin commands — are shared. To enable Telegram:

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Set `TELEGRAM_BOT_TOKEN=<token>` in `.env`.
3. Start the server; the bot begins polling automatically.

**Real phone numbers:** Telegram users are asked for their phone number
during onboarding (and can update it anytime with `phone <number>`). It's
used for KYC when provisioning virtual-account top-ups and payouts. WhatsApp
members already are identified by their number, so no extra step is needed.

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

## Loan disbursement

Loan applications also collect the member's **bank account number and bank**
(by name — Access, GTB, Zenith, etc. — or the bank code). On approval the
system auto-disburses to that account:

1. The payment provider resolves the account holder's name.
2. The name is compared against the member's **registered name** (case and
   punctuation-insensitive; extra titles like "Chief" are ignored).
3. If it **matches** → the loan is `disbursed` and the money is sent to the
   bank account. A payout record is created and the member is notified.
4. If it **doesn't match** (or the account can't be resolved) → the money is
   **not sent**. The loan stays `approved` with a `name_mismatch` /
   `failed` disbursement status so an admin can investigate.

The admin's `approve` reply includes the disbursement result.

## Workplaces (units)

Members can be grouped by workplace. Each workplace has its own code and an
assigned admin. Cooperative rules still apply across the whole cooperative;
units are an organizational layer for communication and visibility.

- Admin: `addunit <name> <code>` → `unitadmin <code> <membercode>` →
  members join with `joinunit <code>`.
- Workplace admins can broadcast to their unit and see unit loan/pending
  lists, but only the coop admin can approve loans / make payouts.

## Recurring contributions & interest

- `plan <amount> weekly|monthly` sets a recurring contribution. A background
  scheduler nudges members when each instalment is due (they reply `save X`
  to pay). `plan off` cancels.
- Admin sets `interest <rate%>` and savings earn that rate monthly; interest
  accrues to wallets on the 1st of each month.

## Dividends

- `dividend <rate>` shows a real-time calculator: the pool and each member's
  share, proportional to their lifetime savings.
- `paydividend <rate>` distributes it — wallets are credited and it appears
  in each member's statement.

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