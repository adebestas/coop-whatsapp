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
| `withdraw <amount>` | Withdraw up to 45% of savings to your bank account |
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
| `support <issue>` | Open a support ticket with customer service |
| `vote <election id> <member code>` | Vote in an open election |

Multi-turn onboarding: `join TEST01` → name → (Telegram: phone → OTP if the
number is already on WhatsApp) → email *(optional)* → birthday *(optional)* →
**next of kin (name + phone)** → set 4-digit PIN → confirm → done.
You receive a short **member code** on joining. Email + birthday can be skipped
with `skip` and only power monthly statements and birthday greetings. The next
of kin is required — death claims are settled with them.

## Roles

| Role | Powers |
| --- | --- |
| `member` | Save, withdraw, loans, vote |
| `support` | Customer service: view & resolve tickets |
| `admin` | Unit or coop-wide admin: approve loans (step 1), withdrawals, claims intake, broadcasts, elections |
| `superadmin` | Final approval on **all** money movement, payouts, dividends, roles (`setrole`), audit trail |

The super admin is any member with the `superadmin` role **or** the
cooperative's registered `adminPhone`. Every money/admin action is written to
an append-only **audit log** (`audit` command shows the latest entries).

## Admin commands

| Command | Who | What it does |
| --- | --- | --- |
| `pending` | all admins | List loan applications (workplace admins see their unit only) |
| `approve <id>` / `reject <id>` | admin + super | Two-step loan approval: admin approves, **super admin finalizes & disburses** |
| `approvewdraw <id>` | admin + super | Approve a withdrawal request (super approval pays immediately) |
| `finalize <id>` | super only | Final approval that sends a withdrawal |
| `rejectwithdraw <id>` | admin + super | Reject a withdrawal request |
| `overridewithdrawal <phone>` | admin + super | Let a member withdraw before the 6-month window |
| `pendingwithdraw` | admin + super | List pending withdrawal requests |
| `deathclaim <membercode>` | admin + super | Open a death claim (then send the certificate) |
| `claimbank <claim id> <account> <bank>` | admin + super | Set the family's payout account |
| `approveclaim <id>` | super only | Pay the validated claim to the family |
| `rejectclaim <id>` | admin + super | Reject a death claim |
| `pendingclaims` | admin + super | List death claims in progress |
| `payout <amount> <phone>` | super only | Pay from a member's wallet to their bank on file (name-checked, audited) |
| `setrole <code> <member\|admin\|superadmin\|support>` | super only | Assign roles |
| `tickets` / `resolve <id> <note>` | support + admins | Work support tickets |
| `startvote unit <unitcode> <title>` / `startvote exec <position> <title>` | admin + super | Open an election |
| `candidate <election id> <member code>` | admin + super | Add a candidate |
| `closevote <election id>` | admin + super | Tally ballots; unit elections install the winner as unit admin |
| `results <election id>` | everyone | Live tallies |
| `broadcast <msg>` | all admins | Message all members (`broadcast unit <msg>` for your workplace) |
| `addunit <name> <code>` / `unitadmin <unit> <member>` / `units` | all admins | Manage workplaces |
| `interest <rate%>` | all admins | Set monthly interest on **loans** |
| `paydividend <rate%>` | super only | Distribute a dividend to all members |
| `audit` | admin + super | Recent audit-trail entries |

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

Loans require **2 guarantors** by default — admins and superadmins only need
**1** — and each must confirm before the loan can be approved:

1. `loan <amount> <months>` creates the application.
2. The bot asks for each guarantor's member code in turn.
3. For each valid guarantor, the system **auto-generates a unique code**
   (e.g. `GT-A1B2C3`) and sends it to their chat.
4. Each guarantor replies `confirm <code>` to accept.
5. The loan only becomes `guaranteed` (approvable) once every guarantor has
   confirmed. Admins can't approve earlier.

Rules enforced:

- You can't be your own guarantor; one appearance per loan; unknown codes are
  rejected.
- A member can stand guarantor for at most **2 active loans** at a time.
- Once the cooperative passes **100 members**, guarantors are additionally
  liable up to **2x their own lifetime savings** (`GUARANTOR_EXPOSURE_RATIO`),
  and borrowers need **100 days of membership** before taking a loan.
- A loan can't exceed **2x the borrower's lifetime savings**
  (`LOAN_TO_SAVINGS_RATIO`).
- Members with an overdue loan (**defaulters**) can't borrow again until they
  repay.
- Late instalments attract a fine: `LATE_FINE_RATE`% (default 2%) of the
  installment per month overdue, deducted together with the repayment and
  recorded as a `fine` entry in the ledger.

## Loan disbursement

Approval is **two-step**: an admin's `approve <id>` marks the loan
`admin_approved`; only the super admin's approval finalizes it. On finalize
the system auto-disburses to the account on file:

1. The payment provider resolves the account holder's name.
2. The name is compared against the member's **registered name** (case and
   punctuation-insensitive; extra titles like "Chief" are ignored).
3. If it **matches** → the loan is `disbursed`, the wallet is debited
   atomically, and the money is sent to the bank account. A payout record is
   created and the member is notified.
4. If it **doesn't match** (or the account can't be resolved) → the money is
   **not sent**. The loan stays approved with a `name_mismatch` / `failed`
   disbursement status so an admin can investigate.

The admin's approve reply includes the disbursement result.

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
- Admin sets `interest <rate%>` — the monthly interest charged **on loans**.

## Dividends

- `dividend <rate>` shows a real-time calculator: the pool and each member's
  share, proportional to their lifetime savings.
- `paydividend <rate>` (super admin only) distributes it — wallets are
  credited and it appears in each member's statement.

## Withdrawals

- `withdraw <amount>` lets a member take out up to **45% of their current
  savings** at once, and at most once every **6 months** (an admin can waive
  the window with `overridewithdrawal <phone>`).
- The bot collects (or reuses) the member's bank account + bank, then asks for
  the **4-digit PIN**. A **request** is created — no money moves yet.
- An admin approves with `approvewdraw <id>`; the **super admin finalizes**
  (`finalize <id>`, or their own approval pays immediately). Only then is the
  wallet debited atomically and the payout sent — after the account-holder
  name check against the registered name, like loans.

## Fraud hardening & KYC

- **PIN lockout:** 3 wrong PIN attempts lock the PIN for 15 minutes
  (`PIN_MAX_ATTEMPTS`, `PIN_LOCK_MINUTES`).
- **Session expiry:** abandoned multi-turn flows expire after 30 minutes.
- **Phone verification (Telegram):** if an onboarding phone number already
  belongs to a WhatsApp member, a 6-digit OTP (10-minute TTL) is sent to that
  WhatsApp number; the Telegram user must enter it. Otherwise onboarding
  continues with the phone marked unverified.
- **Next of kin** is captured during onboarding — death claims are settled
  with them.
- **Audit trail:** every contribution, repayment, top-up credit, payout,
  withdrawal step, claim action, role change and election is written to an
  append-only audit log (`audit` command).

## Support tickets

Members open tickets with `support <issue>`; customer-service agents (the
`support` role) list them with `tickets` and close them with
`resolve <id> <note>` — the member is notified of the resolution.

## Elections

Admins open ballots with `startvote unit <unitcode> <title>` (workplace
elections) or `startvote exec <position> <title>` (cooperative-wide executive
elections). Members add candidates (`candidate <id> <code>`) and vote
(`vote <id> <code>`) — one ballot per member per election, unit elections
restricted to unit members. `closevote <id>` tallies the result; the winner of
a unit election is automatically installed as that unit's admin.

## Payment provider failover

Top-ups and payouts run through Flutterwave or Paystack. If the configured
provider errors repeatedly it is circuit-broken (5-minute cooldown) and the
other provider takes over automatically until it recovers.

## Monthly statements & birthdays

- On the **1st** of each month the scheduler sends every active member their
  personal statement (`history`) automatically — at most once per calendar
  month.
- Members who shared a birthday during onboarding get a **birthday greeting**
  on the day, once per year. Both steps are optional and skippable (`skip`).

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
- [x] Phase 3: guarantors, auto-disbursement + name verification, units,
  dividends, interest, broadcasts, recurring plans, withdrawals, statements,
  birthday greetings
- [x] Phase 3.5: two-tier admin governance (super admin finalizes all money
  movement), Nigeria rules (6-month withdrawal window, guarantor exposure +
  tenure caps, loan-to-savings cap, late fines, defaulter blocking), KYC
  (OTP phone verification, next of kin), PIN lockout, audit trail, support
  tickets, elections (unit admins + executives), provider failover
- [ ] Phase 4: marketplace, state/LGA grouping, Pidgin, scale, more languages

## Tests

```bash
npm test
```