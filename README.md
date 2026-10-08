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
| `mandate <cap>` | Authorize automatic bank direct debits up to a cap (returns a bank consent link) |
| `mandates` / `mandatestatus <id>` | View your direct-debit mandates |
| `cancelmandate <id>` | Cancel a direct-debit mandate |
| `fund` | Get your personal virtual account number for top-ups |
| `loan <amount> <months>` | Apply for a loan (e.g. `loan 50000 3`) |
| `repay` | Pay the monthly installment on your active loan |
| `history` | Your personal transaction statement |
| `ledger` | Cooperative ledger — transparency for all members |
| `dividend <rate>` | Real-time dividend calculator (% of net profit) |
| `shares` | Show your shareholding and its current value |
| `buyshares <count>` | Buy shares from your savings balance (default ₦1,000/share) |
| `buypolls` | See open buy-votes (what should the coop purchase?) |
| `votebuy <poll id> <option>` | Vote in a buy-vote |
| `joinunit <code>` | Join your workplace/unit |
| `code` | See your member code (share it for guarantor requests) |
| `confirm <code>` | Accept a guarantor request |
| `phone <number>` | Add/update your real phone number (needed for funding) |
| `support <issue>` | Open a support ticket with customer service |
| `vote <election id> <member code>` | Vote in an open election |
| `freeze` / `unfreeze` | Freeze your account so no money can leave, then lift it yourself |
| `payees` / `addpayee <name> <account>` / `delpayee <name\|#>` | Save / list / remove favorite payout accounts (beneficiary memory). Adding a payee uses the guided bank picker with account-name confirmation. |
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

## Committees

Cooperatives can run three formal committees, appointed by the super admin:

| Committee | Default size | Powers |
| --- | --- | --- |
| **Credit** | 3 | Approves loans — **replaces the two super-admin signatures**. A loan at `admin_approved` is disbursed once a majority of the Credit Committee approves. |
| **Supervisory / Audit** | 3 | Read-only oversight of the audit trail, ledger and reports, **plus** the power to freeze/suspend a member pending review. |
| **Board** | 5 | Sets policy (interest tiers, dividend rate, limits). |

Sizes are configurable per cooperative (`CooperativeConfig.creditCommitteeSize`,
`supervisoryCommitteeSize`, `boardSize`). A member can sit on more than one
committee.

- Super admin: `addcommittee <credit|supervisory|board> <name> [size]` →
  `appoint <type> <member code> [chair]` → `committees` lists them.
- **Credit Committee:** when a cooperative has a Credit Committee staffed to at
  least its majority, loans at `admin_approved` are decided by committee vote
  (`cvote <loan id> approve|reject`; `committeequeue` lists pending decisions).
  A cooperative **without** a staffed Credit Committee keeps the existing
  admin → super → super approval chain.
- **Supervisory freeze:** `supervisoryfreeze <member code> [reason]` /
  `supervisoryunfreeze <member code>` — a supervisory freeze blocks all
  money-out and **cannot** be lifted by the member themselves (only the
  Supervisory Committee or a super admin can clear it).

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
| `mandates` | admin + super | List the cooperative's direct-debit mandates |
| `pausemandate <id> [purpose]` / `resumemandate <id> [purpose]` | admin + super | Pause/resume a whole mandate, or a single purpose (`savings`/`loan`/`group`) |
| `skipdebit <id>` | admin + super | Skip one pending direct debit so it is never retried |
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
| `paysharedividend <rate%>` | super only | Distribute a percentage of **net profit** to members by **shareholding** (bank payout, distinct from `paydividend`) |
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

## Loan protection

Loans carry a **self-insured credit-life protection** — the cooperative pools a
small premium instead of buying third-party insurance:

- A **1% premium** of the loan principal (`loanProtectionPercent`, default `1`)
  is withheld at disbursement and held in the cooperative's protection fund
  (`protectionFundBalance`, a liability to insured members).
- It is **per-cooperative configurable** and can be switched off entirely with
  `loanProtectionEnabled` (then no premium is withheld).
- It covers the borrower's **death and permanent disability**. When a death
  claim is approved, every outstanding protected loan of the member is
  **written off against the fund** — the loan is settled and the family still
  receives the member's savings.
- If the outstanding balance exceeds the fund, the excess is absorbed as a
  cooperative expense; the fund never goes negative.

## Loan-loss provisioning & PEARLS

Past-due loans are aged into WOCCU PAR buckets and provisioned against a
loan-loss reserve, and the cooperative's financial health is summarised with
the six WOCCU **PEARLS** ratio groups.

**PAR aging & provisioning.** Outstanding loans are bucketed by how long the
next installment is past due — `1-30`, `31-90`, `91-180`, `180+` days. The
expected loss is the outstanding balance × the bucket rate (defaults `1 / 5 /
20 / 50%`, configurable per cooperative via `provisionRates`). `runProvision`
snapshots the per-loan expected loss into a `ProvisionRun` (one per cooperative
per month), posts a balanced journal (`expense:loan_loss_provision` →
`assets:loan_loss_provision`), and increments the cooperative's
`loanLossProvisionBalance`. Re-running the same month is refused.

- Admin: `par` shows the ageing buckets, `provisionrates` shows the rates, and
  `provision` (super admin) books the month's provision.

**PEARLS ratios.** `computePearls(coopId)` derives six groups of named ratios
from the double-entry journal, the loan book, the ledger, contributions and the
membership roster. Every ratio is a fraction, and an inactive cooperative
returns zeros without throwing.

| Group | Ratios |
| --- | --- |
| **P** — Protection | `allowanceToLoans`, `netCapital` |
| **E** — Effective structure | `loansToAssets`, `savingsToAssets` |
| **A** — Asset quality | `parRatio`, `provisionCoverage` |
| **R** — Rates of return | `interestIncomeToAssets`, `costOfFunds` |
| **L** — Liquidity | `liquidAssetsToSavings` |
| **S** — Signs of growth | `memberGrowth`, `savingsGrowth` (year-on-year) |

- Admin: `pearls` prints a formatted PEARLS summary.
- Dashboard: the **PEARLS** tab renders the six groups as ratio cards.
- API: `GET /api/admin/pearls` (admin bearer token) returns the same figures.

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

## Direct debit mandates

Members can authorize a **NIBSS direct-debit mandate** on their saved bank
account, so the cooperative can pull money automatically for recurring savings,
loan repayments and group (VSLA/ROSCA) contributions — instead of the
reminder-and-reply flow.

Direct debit is **off by default** and enabled per cooperative through
`CooperativeConfig.directDebitEnabled` (super admin). An optional per-debit
ceiling, `directDebitMaxCap` (kobo, `0` = none), caps every debit on top of the
member's own mandate cap.

- **Member commands** (create/cancel require the transaction PIN):
  - `mandate <cap>` — start a mandate; the bot returns a provider-hosted consent
    link and the mandate stays `pending` until the member authorizes it at their
    bank and the provider webhook flips it to `active`.
  - `mandates` / `mandatestatus <id>` — view your mandates.
  - `cancelmandate <id>` — cancel a mandate (also cancelled at the provider).
  - One flexible mandate per member: a single `amountCap` per debit, each debit
    tagged with a purpose (`savings` | `loan` | `group`).
- **Admin commands** (admin or super admin):
  - `mandates` — list the cooperative's mandates.
  - `pausemandate <id>` / `resumemandate <id>` — pause/resume the **whole**
    mandate (status → `paused`).
  - `pausemandate <id> <savings|loan|group>` / `resumemandate <id> <purpose>` —
    pause/resume a **single purpose** (added to / removed from `pausedPurposes`).
  - `skipdebit <id>` — mark one **pending** debit `skipped` so it is never
    retried.
- **Retry policy:** a failed debit is retried **once per day (never more)** until
  it succeeds or the mandate is cancelled. The scheduler skips a `paused`
  mandate, any purpose listed in `pausedPurposes`, and never retries a `skipped`
  debit.
- **No pre-debit notice** — the member is notified **after** each debit (success
  or failure).
- **Provider fallback:** mandates run through the same payment adapter as every
  other movement — **Monnify** primary, **Paystack** fallback — behind the
  existing circuit-breaker failover (`resolveProvider`).

## Refunds

Sometimes a member has **already paid** (say, by bank transfer or cheque) and the
direct debit also pulled — a double payment. A refund is a **maker-checker** flow
so no single person can move money back out to a member:

- **Admin** `recommendrefund <member code|id> <amount> <reason>` — creates a
  `pending` `RefundRequest` the cooperative owes the member.
- **Super admin** `approverefund <id>` — approves and initiates a **payout to the
  member's saved bank account** through the same payout path as withdrawals
  (idempotent `Payout` row + a balanced `expense:refund` / `assets:bank` journal).
  On success the request is marked `paid`; on failure it is marked `failed` and
  super admins are alerted.
- **Super admin** `rejectrefund <id> [reason]` — rejects a pending request.

Approval refuses if the member has **no saved bank account**, and the refund only
pays out from the cooperative's bank/settlement account — never the member's
wallet. Every step (recommend / approve / reject / paid / failed) is audited with
a human-readable description.

## Member ombudsman

Members have an **independent escalation tier above cooperative admins**: a
**platform-level ombudsman** (not tied to any cooperative) who can investigate a
grievance or dispute, issue a **binding decision**, and apply a remedy.

- **Escalate.** A member replies `escalate <grievance id> [reason]` to escalate a
  grievance, or `escalate dispute <loan_rejection|dividend|freeze|suspension|other>
  <reference> [reason]` to escalate a dispute directly (one case per source). A
  grievance left unresolved past `CooperativeConfig.ombudsmanSlaDays` (default
  **7**) is auto-escalated by the scheduler.
- **Ombudsman console** (gated to an active `Ombudsman` phone):
  - `cases [status]` — cases across every cooperative (`open` / `investigating` /
    `decided` / `closed`).
  - `case <id>` — the full case timeline.
  - `investigate <id> <note>` — open an investigation (notifies the cooperative's
    admins).
  - `decide <id> <decision>` — record a binding decision (notifies the member +
    the cooperative).
  - `remedy <id> unfreeze` — lift a member's self-freeze **and** any Supervisory
    Committee freeze.
  - `remedy <id> refund <amount> [reason]` — pay the member a refund through the
    existing refund flow, with the ombudsman acting as the approver (the
    admin-recommend step is bypassed). One remedy per case.
- Every case action is audited and recorded on the case timeline.
- `Ombudsman` / `OmbudsmanCase` / `OmbudsmanCaseEvent` are **platform-level**
  tables (not cooperative-RLS-scoped); cross-tenant access is gated in code by the
  ombudsman role plus an explicit `withCoopContext` per coop-scoped write.

**Create an ombudsman:**

```bash
npm run seed:ombudsman -- --name "Ada Ombuds" --phone 2348012345678
```

or directly:
`npx tsx src/seed.ts --ombudsman --name "Ada Ombuds" --phone 2348012345678`.

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

## Share capital

Members own part of the cooperative by buying shares from their savings
balance with `buyshares <count>` — each share defaults to **₦1,000** (100,000
kobo), configurable per cooperative via `CooperativeConfig.sharePrice`.
`shares` shows their current holding and value.

- Share capital is **permanent equity**, not savings: it is **not withdrawable**
  unless the cooperative enables `allowShareRedemption`.
- Share purchases post a balanced double-entry journal (`equity:share_capital`)
  and are audited.
- Super admins distribute profit **on shares** with `paysharedividend <rate%>`
  — paid to shareholders by their shareholding (a bank payout). This is
  **distinct from `paydividend`**, which pays on **savings**.

## Savings products

Members can hold separate **savings product accounts** alongside their wallet
through four product types:

| Type | What it is |
| --- | --- |
| `fixed` | Fixed deposit — locked until it matures, earning `interestRate`% at maturity. |
| `goal` | Goal/target savings — a target amount with live progress; reaching 100% notifies the member. |
| `seasonal` | Seasonal savings — a term-locked product for festive/seasonal saving. |
| `junior` | Junior/youth — a **guardian-managed** account for a minor. |

- Admin: create with `newproduct <fixed|goal|seasonal|junior> <name> [rate] [termMonths]`; browse with `products`.
- Member: `products` to browse, `openproduct <product id> [target]` to open, `saveproduct <account id> <amount>` to deposit, `withdrawproduct <account id> <amount>` to withdraw, `myproducts` to list, `matureproduct <account id>` to mature.
- Money moves **wallet → product account** through balanced double-entry
  (`member_wallet:<walletId>` ↔ `liability:savings_product:<accountId>`), and
  every movement is audited. Fixed/seasonal accounts are term-locked until
  `maturesAt`; at maturity the principal (plus interest) is credited to the
  holder's wallet.
- **Junior accounts.** `openjunior <product id> <minor name> [minor phone]`
  opens a guardian-managed account: the opening guardian controls it — only the
  guardian may deposit, withdraw or mature it while a guardian is set (the minor
  holder is refused). The guardian funds it from their own wallet; on maturity
  the balance is released to the **minor's** wallet. If `minor phone` matches an
  existing member of the cooperative, that member is the holder; otherwise a
  junior member record is created (with a generated placeholder channel phone
  when none is given).

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

## Regulator reporting

Cooperatives file **statutory financial returns** and **NFIU AML summaries** with
their regulator (state Ministry of Cooperatives, CBN, NFIU, or a custom label).
Both are produced as **Excel + PDF + CSV** from existing ledger/AML data — pack
generation is read-only and adds no new accounting.

- **Configure the regulator** — `regulatorconfig <label> [type] [email] [monthlyDue] [quarterlyDue]`
  (type is one of `ministry`, `cbn`, `nfiu`, `custom`; due days default to the
  10th for monthly returns and the 15th for quarterly). Setting a regulator also
  switches scheduled reporting on.
- **Generate on demand** — `regreport <YYYY-MM> <statutory|nfiu|both> [monthly|quarterly]`
  writes the pack, archives it under `exports/`, and replies with the file paths
  and the filing due date.
- **Scheduled packs** — a daily scheduler job generates the monthly pack after
  month-end and the quarterly pack after quarter-end for every coop with
  reporting enabled, and reminds admins when a pack's filing due date is near or
  past.
- **Track filing** — `regreportstatus` lists generated/filed packs; once
  submitted to the regulator, `regreport filed <id>` marks it filed. Filing is
  always manual (no regulator-portal submission). Every generation, config change
  and filing action is audited.

Statutory packs contain the balance sheet, profit & loss, PAR aging, PEARLS
ratios, and membership/savings/loans summaries. NFIU packs contain STR/SAR counts
by status and the large-transaction (≥ ₦5M) list. All admin-only.

## Guarantor default deductions

When a loan is **2+ months overdue**, each confirmed guarantor gets a
**10-day notice**: 50% of the loan's flat interest will be deducted from
their savings unless the borrower clears the arrears first. If day 10 arrives
and the loan still isn't repaid, the deduction executes automatically
(savings balance + lifetime savings reduced, ledger entry recorded, everyone
notified). Clearing the arrears during the window cancels it.

## Employer salary-deduction remittance

Admins collect members' agreed monthly deductions from their employer. The
lifecycle is maker-checked and reconciled before any money is credited:

1. **Set commitments** — `setcommit <code> <amount>` (0 stops it); members can
   request a month off with `skipmonth`, admins approve with `waive <code>`.
2. **Build a batch** — `newbatch` builds a draft from every active member's
   commitment plus any active loan installment. Or upload the employer's file
   (Excel, CSV, PDF, or a photo) as a WhatsApp document/photo, or via
   `POST /api/admin/deductions/build`; rows are matched to members by code,
   phone, or name.
3. **Submit** — `submitbatch <ref>` (draft → submitted).
4. **Record the cheque** — `recordcheque <ref> <amount> [cheque ref]`
   (submitted → cheque_received).
5. **Reconcile** — `reconbatch <ref> <amount>` (cheque_received → reconciled).
   A matching bank credit can auto-reconcile a batch, or upload a bank statement
   via `POST /api/admin/deductions/reconcile-statement` to match credits to
   batches. Approval is blocked while the reconciled amount is below the batch
   total.
6. **Approve** — `approvebatch <ref>` credits wallets and repays loans in a
   single transaction. If the employer under-remitted, `approvebatch <ref>
   partial` credits only the items the reconciled amount covers and leaves the
   rest pending (batch → `partially_approved`) for a later top-up. Maker-checker:
   the approver must be a *different* super admin than the maker, and the maker's
   name must be confirmed first with `confirmname <code>`.

Uploaded files are stored in S3-compatible object storage (when `BACKUP_*` is
configured) and linked to the batch via `sourceFileKey` / `sourceFileName`.

Reject with `rejectbatch <ref> [reason]`.

## Changing your phone number

A member moves their account to a new number with `changephone <number>`: an
OTP is sent to the new number, and once verified the request waits for a super
admin to approve it (`approvephone <code>` / `rejectphone <code> [reason]`).
The old channel is warned and its sessions are wiped. Super admins can still
force a move with `relink <code> <number>`.

## AI assistant

The assistant answers plain-English/Pidgin questions and maps free text to bot
commands. It is **not** a tool-calling agent: the model only classifies a
question into a tool name, and the server enforces permissions in code via the
registry in `src/lib/ai-tools.ts` (each tool declares its `scope` and
`requiredRole`). The model never chooses which data to fetch and never bypasses
a permission check. Command suggestions are shown for confirmation and then run
through the normal PIN/2FA/approval pipeline.

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

## General meetings (AGM/SGM)

Cooperatives can run **Annual General Meetings** (`agm`) and **Special General
Meetings** (`sgm`) entirely through chat.

- **Schedule** — an admin calls `startmeeting <agm|sgm> <title> [quorum%]`. The
  quorum defaults to the cooperative's `agmQuorumPercent` (25% unless
  configured).
- **Open & attend** — `openmeeting <id>` moves the meeting to *open*, then
  members mark themselves present with `attend <id>`. Attendance is
  per-meeting and idempotent.
- **Proxies** — a present member may carry another's vote with
  `proxy <id> <member code>`. The represented member's attendance row records
  the proxy holder, and **both count toward quorum**.
- **Quorum** — quorum is met when attendance *including proxies* reaches
  `quorumPercent`% of **active** members (pending/suspended members are not
  counted).
- **Motions** — admins table motions with
  `addmotion <id> <title> | <description> [general|bylaw|dividend|election]`.
  Present members vote `motionvote <id> yes|no|abstain` (one vote each;
  non-attendees cannot vote).
- **Close & tally** — `closemotion <id>` tallies the votes. A motion **passes
  only when quorum is met and yes exceeds no**; otherwise it is *rejected* with
  a clear no-quorum or no-majority note. `closemeeting <id>` closes the floor.
- **Minutes & export** — `meetingminutes <id>` prints the minutes (type,
  quorum, attendance, motions, tallies and carried resolutions) and generates a
  downloadable **Excel + PDF** export via the shared export pipeline
  (`/api/export/<file>`).

## Groups (ROSCA / VSLA)

Cooperatives can run informal **savings groups** inside the coop. An admin
creates one with `newgroup <rosca|vsla> <name> <code> <amount> <cycleLength>`
(amount in naira; cycle length in rounds). Members join with
`joingroup <code>`, pay in with `groupcontribute <group id> <amount>`, and check
their groups with `mygroups` / `groupstatus <group id>`. Admins manage cycles
with `closegroupcycle <group id>` and review joint-liability lending with
`grouploans <group id>`.

**ROSCA (rotating savings).** Each round every member pays the same fixed
contribution into the pot. Members are assigned a rotation position when they
join, and `closegroupcycle` pays the whole pot to the member whose turn it is.
A member may contribute only once per round.

**VSLA (village savings & loans).** Members buy one or more *shares* per round
(contributions must be a multiple of the group's share price). When the cycle
closes, the pot is shared out **pro-rata by shares** using the largest-remainder
method, so the whole pot is distributed with no rounding loss; shares are then
redeemed for the next round.

**Joint-liability group loans.** A group member borrows with
`grouploan <group id> <amount> <months>` (up to 12 months). The group stands as
**joint guarantor**, so an active-group loan is created already *guaranteed*
and needs **no individual guarantors** before it moves through the approval
chain — if the member defaults, the group is liable. A non-member, or a loan
against a closed group, is refused.

Every contribution, payout and share-out is booked through the double-entry
journal against the group's pot account, so the books always balance.

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
- [x] Phase 3.7: employer deduction file ingestion (Excel/CSV/PDF/OCR) +
  cheque/reconciliation lifecycle, maker-checker on batch approval, OTP-verified
  member phone change, AI tool/permission registry
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
