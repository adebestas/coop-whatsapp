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
  routes/payments.ts     # payment provider webhooks (monnify/paystack)
  routes/admin.ts        # REST API for the admin dashboard
  lib/prisma.ts          # Prisma client
  lib/whatsapp.ts        # Meta Cloud API message sender
  services/conversation.ts  # bot state machine + chat flows
  services/cooperative.ts   # members, wallets, contributions
  services/loans.ts         # loan applications, approval, repayments
  services/admin.ts         # admin auth + WhatsApp admin commands
  services/payments/        # provider adapter + monnify + paystack + topup
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
| `save <amount>` | Get your personal funding account, then transfer that amount — your wallet is credited when the transfer confirms (e.g. `save 2000`) |
| `withdraw <amount>` | Withdraw up to 45% of savings to your bank account |
| `plan <amount> <weekly\|monthly>` | Set a recurring contribution plan |
| `fund` | Get your personal virtual account number for top-ups |
| `loan <amount> <months>` | Apply for a loan (e.g. `loan 50000 3`) |
| `repay` | Pay the monthly installment on your active loan |
| `history` | Your personal transaction statement |
| `ledger` | Cooperative ledger — transparency for all members |
| `dividend <rate>` | Real-time dividend calculator (% of net profit) |
| `buypolls` | See open buy-votes (what should the coop purchase?) |
| `votebuy <poll id> <option>` | Vote in a buy-vote |
| `joinunit <code>` | Join your workplace/unit |
| `code` | See your member code (share it for guarantor requests) |
| `confirm <code>` | Accept a guarantor request |
| `phone <number>` | Add/update your real phone number (needed for funding) |
| `support <issue>` | Open a support ticket with customer service |
| `vote <election id> <member code>` | Vote in an open election |
| `freeze` / `unfreeze` | Freeze your account so no money can leave, then lift it yourself |
| `payees` / `addpayee <name> <account> <bank>` / `delpayee <name\|#>` | Save / list / remove favorite payout accounts (beneficiary memory) |
| `analytics` | Personal savings analytics (balance, totals, monthly rate, withdrawals, loans) |
| `votediv <yes\|no>` | Vote on an open dividend-rate change ballot |
| `statement <month\|year>` | Monthly or yearly statement |
| `class` / `next` | Financial literacy lessons |
| `reserveinfo` | Statutory reserve fund info |
| `grievance <complaint>` | Submit a grievance to the cooperative |
| `byelaws` | View the cooperative's registered byelaws |

> **Voice notes:** on WhatsApp you can send a voice note instead of typing a command — it is transcribed and processed as text (requires `GROQ_API_KEY` + `WHATSAPP_TOKEN`).

Multi-turn onboarding: `join TEST01` → name → **NDPR data-consent** → (Telegram:
phone → OTP if the number is already on WhatsApp) → email *(optional)* →
birthday *(optional)* → **next of kin (name + phone)** → set 4-digit PIN →
confirm → done.
You receive a short **member code** on joining. Email + birthday can be skipped
with `skip` and only power monthly statements and birthday greetings. The next
of kin is required — death claims are settled with them.

## Roles

| Role | Powers |
| --- | --- |
| `member` | Save, withdraw, loans, vote, buy-votes |
| `support` | Customer service: view & resolve tickets |
| `admin` | Coop-wide or unit admin: first loan approval, withdrawals intake, claims intake, broadcasts, elections, **initiates pay-anyone requests** |
| `superadmin` | Two super admins must co-sign loan disbursements; final say on all money movement, payroll, dividends, exports, roles (`setrole`), audit trail |

The super admin is any member with the `superadmin` role **or** the
cooperative's registered `adminPhone`. Every money/admin action is written to
an append-only **audit log** (`audit` command shows the latest entries).

## Admin commands

| Command | Who | What it does |
| --- | --- | --- |
| `pending` | all admins | List loan applications (workplace admins see their unit only) |
| `approve <id>` / `reject <id>` | admin + super | Loan approval needs **3 signatures**: admin → super #1 → a *different* super #2. The second super approval auto-disburses |
| `payanyone <amount> <account> <bank code> <narration>` | admin + super | Queue an external payment (beneficiary name is verified from the account; narration required). Paid only after **3 distinct super approvals** |
| `approvepay <id>` | super only | Approve a pay-anyone request (needs 3 distinct super approvals) |
| `pendingpay` / `rejectpay <id>` | admin + super | List / reject pay-anyone requests |
| `startbuyvote <title>`, `addoption <poll id> <name> <cost> [account] [bank]`, `closebuyvote <poll id>` | all admins | Buy-votes: members vote on what the coop should buy; closing the winning option auto-creates the 3-super payment request |
| `export members\|transactions\|pnl` | super only | Generate Excel + PDF exports and get download links by email |
| `setsalary <phone> <amount>` | super only | Configure an admin's salary/stipend amount |
| `runpayroll <narration>` | super only | Pay all configured salaries — straight to **bank accounts** (never wallets); narration is mandatory |
| `salarylist` / `runpayrollprep` | super only | List configured salaries (alias for the same report) |
| `pnl` | admin + super | Profit & loss: income vs expense categories and net profit from the ledger |
| `approvewdraw <id>` | admin + super | Approve a withdrawal request (super approval pays immediately) |
| `finalize <id>` | super only | Final approval that sends a withdrawal |
| `rejectwithdraw <id>` | admin + super | Reject a withdrawal request |
| `overridewithdrawal <phone>` | admin + super | Let a member withdraw before the 6-month window |
| `pendingwithdraw` | admin + super | List pending withdrawal requests |
| `deathclaim <member code> <family phone>` | admin + super | Open a death claim (then send the certificate) |
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
| `interest` | admin + super | Shows the fixed tiered flat rates: 5% (≤3 months), 8% (≤6), 9% (≤9), 10% (10–12) |
| `paydividend <rate%>` | super only | Distribute a percentage of **net profit** to members by savings share |
| `startvotediv <rate%>` | super only | Open a member ballot when a dividend rate change is >5% |
| `closedivid [approve\|reject]` | super only | Close a dividend-rate vote (auto-tally, or force approve/reject) |
| `votedivstatus` | super + member | Live tally and status of the dividend-rate vote |
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
  and must have been members for **3+ months** before they can stand as
  guarantor.
- A loan can't exceed **2x the borrower's lifetime savings**
  (`LOAN_TO_SAVINGS_RATIO`).
- Members with an overdue loan (**defaulters**) can't borrow again until they
  repay.
- Late instalments attract a fine (per-coop `lateFinePercent`, default **5%**)
  of the installment per month overdue, deducted together with the repayment and
  recorded as a `fine` entry in the ledger.

## Loan disbursement

Approval requires **three signatures**: an admin's `approve <id>` marks the
loan `admin_approved`, the first super admin's approval records super sign-off
#1, and a **second, different** super admin's approval finalizes it. On the
final signature the system auto-disburses to the account on file:

1. The member receives the loan minus a flat **₦2,000 admin charge**
   (`LOAN_ADMIN_CHARGE`) — e.g. a ₦50,000 loan pays out ₦48,000.
2. Interest is **flat by tenure tier**: 5% for ≤3 months, 8% for ≤6,
   9% for ≤9 and 10% for 10–12 months — shown up-front before applying.
3. The payment provider resolves the account holder's name; it is compared
   against the member's **registered name** (case/punctuation-insensitive).
4. If it **matches** → the loan is `disbursed`, money is sent to the bank
   account, a payout record is created, the charge is booked as ledger income,
   and the member is notified.
5. If it **doesn't match** (or the account can't be resolved) → the money is
   **not sent**. The loan stays approved with a `name_mismatch` / `failed`
   status so an admin can investigate.

The same super admin can't give both super signatures.

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
- Loan interest is **tiered and flat** — see `interest`. It applies to loans
  only, never to savings.

## Dividends

Profit comes from the **ledger**: loan interest, fines and admin charges in;
salaries/stipends, pay-anyone and other expenses out.

- `dividend <rate>` shows a real-time calculator: net profit, the pool
  (`rate`% of profit) and each member's share by savings proportion.
- `paydividend <rate>` (super admin only) distributes it — wallets are
  credited and the appropriation is recorded in the ledger.
- Rate changes **more than 5%** from the last dividend require **member
  approval**: `paydividend` will ask the super admin to open a member vote
  (`startvotediv <rate>`), members reply `votediv yes|no`, the super admin
  closes it (`closedivid [approve|reject]`, or `closedivid` auto-tallies).
  `votedivstatus` shows the live tally. A passed vote unlocks the rate for
  `paydividend <rate>`.

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
- **Hash-chained audit log:** each audit entry carries the SHA-256 hash of the
  previous one — editing history breaks the chain, which the nightly
  reconciliation job detects.
- **Daily payout limit:** total money-out per cooperative per day (Payouts +
  withdrawals + pay-anyone) is capped (`Cooperative.dailyPayoutLimit`, default
  ₦1m); approvers are warned at 80% and blocked past the cap.
- **Approval cool-offs:** a pay-anyone request can't collect two approvals
  within `PAYMENT_COOLDOWN_MINUTES` (default 5) — no rubber-stamping chains.
- **Money-command rate limit:** at most 6 money commands per member per hour.

## Pay anyone (3-super approval)

An admin can queue a payment to **any bank account** with
`payanyone <amount> <account> <bank code> <narration>`. The beneficiary's name
is verified from their bank account and stored. The money only moves after
**three distinct super admins** approve (`approvepay <id>` on the `pendingpay`
list). Every step is audited; the payout is booked as a ledger expense.
Self-approval is blocked and repeat approvals are rejected.

## Buy-votes (what should the coop buy?)

Admins open a purchase poll with `startbuyvote <title>`, add options with
`addoption <poll id> <name> <cost> [account] [bank]`, members vote with
`votebuy <poll id> <option>` and see results with `buypolls`. Closing the poll
(`closebuyvote <id>`) tallies votes and **auto-creates the pay-anyone request**
for the winning option's vendor account — so purchases follow the same
3-super control as every other outgoing payment.

## Payroll

Super admins configure salaries with
`setsalary <phone> <amount>`. `runpayroll <narration>` pays everyone configured —
**to their registered bank accounts, never wallets** — with a mandatory
narration recorded in the ledger and audit log. Members without bank details
are skipped and reported. `salarylist` (alias `runpayrollprep`) lists the
configured salaries.

## Exports

`export members` / `export transactions|pnl` generates **Excel (.xlsx) and PDF**
files, saves them under `exports/`, emails download links to the requesting super
admin (SMTP config), and returns dashboard links. Exports are audited.

## Guarantor default deductions

When a loan is **2+ months overdue**, each confirmed guarantor gets a
**10-day notice**: 50% of the loan's flat interest will be deducted from
their savings unless the borrower clears the arrears first. If day 10 arrives
and the loan still isn't repaid, the deduction executes automatically
(savings balance + lifetime savings reduced, ledger entry recorded, everyone
notified). Clearing the arrears during the window cancels it.

## Backups

A daily scheduler job dumps the database state to `backups/coop-backup-<timestamp>.json`
(kept for the newest `BACKUP_KEEP` — default 14), and optionally uploads each
snapshot to S3-compatible object storage when `BACKUP_*` credentials are set.

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

Top-ups and payouts run through **Monnify** (primary) with **Paystack** as the
automatic fallback. If the active provider errors repeatedly it is circuit-broken
(5-minute cooldown) and the next provider takes over until it recovers. Set
credentials via `MONNIFY_*` / `PAYSTACK_*` env vars.

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

Or, for a quick test coop with no admin, insert one directly so members can
join:

```bash
npx tsx -e "import { prisma } from './src/lib/prisma.js'; await prisma.cooperative.create({ data: { name: 'Test Farmers Coop', code: 'TEST01', state: 'Oyo' } }); console.log('created'); process.exit(0);"
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

## Roadmap

- [x] Phase 1: onboarding, balance, savings (this repo)
- [x] Phase 2: payment adapter (Monnify + Paystack), virtual-account top-ups,
  loans + approvals, admin dashboard, admin WhatsApp commands, payouts
- [x] Phase 3: guarantors, auto-disbursement + name verification, units,
  dividends, interest, broadcasts, recurring plans, withdrawals, statements,
  birthday greetings
- [x] Phase 3.5: two-tier admin governance (super admin finalizes all money
  movement), Nigeria rules (6-month withdrawal window, guarantor exposure +
  tenure caps, loan-to-savings cap, late fines, defaulter blocking), KYC
  (OTP phone verification, next of kin), PIN lockout, audit trail, support
  tickets, elections (unit admins + executives), provider failover
- [x] Phase 3.6: ledger P&L + profit-based dividends, tiered loan interest,
  ₦2,000 loan admin charge, **two-super loan sign-off**, pay-anyone with
  3-super approval, buy-votes with auto payment requests, payroll to bank
  accounts with narrations, Excel/PDF exports by email, hash-chained audit,
  daily payout limits + approval cool-offs, guarantor default deductions,
  daily backups, Monnify primary provider
- [ ] Phase 4: marketplace, state/LGA grouping, Pidgin, scale, more languages

## Tests

```bash
npm test
```
## Security & go-live (batch 4)

Money-out commands can require a one-time 6-digit code from an authenticator
app: admins run *enable2fa* once (scan the QR / paste the key into Google
Authenticator or Authy), after which every payout-style command must end with
the current code, e.g. `payout 5000 234801... vendor refund 482913`. Set
`TWO_FA_REQUIRED=1` to force enrolment. Large payouts additionally need a
recently verified PIN (`verifypin <pin>` unlocks big payouts for 10 minutes).

First-time bank accounts are held for `NEW_BENEFICIARY_HOLD_HOURS` (24h
default) before they can receive money — this kills account-takeover fraud. A
status poller auto-confirms or refunds transfers stuck in "processing" using
the provider API, and every super admin receives a *Daily summary* of all
money movement (`DIGEST_HOUR`). During the pilot, `PILOT_FLOAT_CAP` caps total
monthly money-out per cooperative as a hard brake.

See `.env.example` and AUDIT.md ("Deployment checklist") before going live.
