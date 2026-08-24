import { prisma } from "../lib/prisma.js";
import { sendText, sendSecurePrompt, platformOf } from "../lib/messaging.js";
import { deleteTelegramMessage } from "../lib/telegram.js";
import { randomBytes, randomInt } from "node:crypto";
import {
  createContribution,
  findOrCreateMember,
  formatBalance,
  getMemberByPhone,
} from "./cooperative.js";
import { applyForLoan, repayLoan } from "./loans.js";
import { handleAdminCommand } from "./admin.js";
import { provisionVirtualAccount } from "./payments/topup.js";
import { addGuarantor, confirmGuarantee } from "./guarantors.js";
import { normalizePhone } from "../lib/phones.js";
import { showLedger, showHistory } from "./statements.js";
import { computeDividendPreview } from "./dividends.js";
import { setAutoSave } from "./scheduler.js";
import { joinUnit } from "./units.js";
import { withdrawLimit, requestWithdrawal, canWithdraw } from "./withdrawals.js";
import { checkMoneyRateLimit } from "./fraud.js";
import { verifyMemberPin } from "./pin.js";
import { resolveBankCode } from "../lib/banks.js";
import { createTicket, listTickets, resolveTicket } from "./support.js";
import { listPosts } from "./posts.js";
import { myDeduction, requestMonthWaiver } from "./deductions.js";
import { aiEnabled, suggestCommand } from "../lib/ai.js";
import { startVote, addCandidate, castVote, closeVote, showResults } from "./votes.js";
import { castBuyVote, listBuyPolls } from "./buypoll.js";
import {
  startDeathClaim,
  submitCertificate,
  validateClaim,
  setClaimBank,
} from "./deathclaims.js";

/** A half-finished flow expires after this long. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** OTP codes expire after this long. */
const OTP_TTL_MS = 10 * 60 * 1000;

export type BotState =
  | "idle"
  | "awaiting_name"
  | "awaiting_coop_code"
  | "awaiting_phone"
  | "awaiting_otp"
  | "awaiting_email"
  | "awaiting_birthday"
  | "awaiting_nok_name"
  | "awaiting_nok_phone"
  | "awaiting_pin"
  | "awaiting_pin_confirm"
  | "awaiting_save_amount"
  | "awaiting_loan_amount"
  | "awaiting_loan_months"
  | "awaiting_loan_bank_account"
  | "awaiting_loan_bank_code"
  | "awaiting_guarantor_1"
  | "awaiting_guarantor_2"
  | "awaiting_withdraw_amount"
  | "awaiting_withdraw_account"
  | "awaiting_withdraw_bank"
  | "awaiting_withdraw_pin"
  | "awaiting_death_cert"
  | "awaiting_ai_confirm";

import { z } from "zod";

// ===== Session Data Schema (validates against corruption/tampering) =====
const FlowDataSchema = z.object({
  joinCode: z.string().optional(),
  pin: z.string().optional(),
  name: z.string().optional(),
  contactPhone: z.string().optional(),
  otp: z.string().optional(),
  otpExpiresAt: z.number().optional(),
  phoneVerified: z.boolean().optional(),
  email: z.string().optional(),
  dateOfBirth: z.string().optional(),
  nokName: z.string().optional(),
  nokPhone: z.string().optional(),
  loanAmount: z.number().positive().optional(),
  loanMonths: z.number().positive().optional(),
  loanAccount: z.string().optional(),
  loanBankCode: z.string().optional(),
  loanBankName: z.string().optional(),
  loanId: z.string().optional(),
  withdrawAmount: z.number().positive().optional(),
  withdrawAccount: z.string().optional(),
  withdrawBankCode: z.string().optional(),
  withdrawBankName: z.string().optional(),
  deathClaimId: z.string().optional(),
  aiCommand: z.string().optional(),
  aiArgs: z.array(z.string()).optional(),
  flowToken: z.string().optional(),
});

export type FlowData = z.infer<typeof FlowDataSchema>;

/** States where the user is typing a secret — flow-token guarded, Telegram messages deleted after read. */
const SECRET_STATES: BotState[] = ["awaiting_pin", "awaiting_pin_confirm", "awaiting_withdraw_pin"];

/** Metadata about how a message arrived (channel-specific extras). */
export interface MessageMeta {
  /** Echoed flow_token from a completed WhatsApp Flow card submission. */
  flowToken?: string;
  /** Telegram message id — secret replies are deleted right after reading. */
  telegramMessageId?: number;
}

function isAwaitingState(state: BotState): boolean {
  return !["idle"].includes(state);
}

function parseCommand(text: string): { cmd: string; args: string[] } {
  const parts = text.trim().toLowerCase().split(/\s+/);
  return { cmd: parts[0] ?? "", args: parts.slice(1) };
}

export async function handleMessage(
  phone: string,
  text: string,
  meta: MessageMeta = {},
): Promise<void> {
  const session = await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "idle" },
    update: {},
  });

  // Expire stale flows so an abandoned "enter your PIN" prompt can't be
  // completed hours later by anyone with the phone.
  if (
    isAwaitingState(session.state as BotState) &&
    Date.now() - session.updatedAt.getTime() > SESSION_TTL_MS
  ) {
    await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
    await sendText({
      to: phone,
      text: "That request expired. Reply *menu* to start again.",
    });
    return;
  }

  // Multi-turn flow: the bot is waiting for an answer to a question.
  if (isAwaitingState(session.state as BotState)) {
    await handleAwaitingInput(phone, session.state as BotState, text, session.data, meta);
    return;
  }

  const member = await getMemberByPhone(phone);

  // Linked alternate channel (same human, other platform): alerts-only.
  // Learn their most-used app, but never execute commands here — banking
  // stays on the account's home platform.
  if (!member) {
    const altOwner = await prisma.member.findFirst({ where: { altChannelId: phone } });
    if (altOwner) {
      const pref = platformOf(phone);
      if (altOwner.preferredChannel !== pref) {
        await prisma.member.update({
          where: { id: altOwner.id },
          data: { preferredChannel: pref },
        });
      }
      const home = altOwner.phone.startsWith("tg:") ? "Telegram" : "WhatsApp";
      await sendText({
        to: phone,
        text: `🔔 This chat receives your cooperative *alerts* only. For saving, loans and withdrawals, please use your *${home}* chat.`,
      });
      return;
    }
  } else if (member.preferredChannel !== platformOf(phone)) {
    // Auto-learn the member's most-used platform from where they type.
    await prisma.member.update({
      where: { id: member.id },
      data: { preferredChannel: platformOf(phone) },
    });
  }

  const { cmd, args } = parseCommand(text);

  // Admin commands take priority (approve, reject, pending, payout).
  const handled = await handleAdminCommand(phone, cmd, args);
  if (handled) return;

  switch (cmd) {
    case "hi":
    case "hello":
    case "hey":
    case "menu":
    case "help":
      await sendText({ to: phone, text: buildMenu(member) });
      break;

    case "join":
      await handleJoinStart(phone, args);
      break;

    case "balance":
      await handleBalance(phone, member);
      break;

    case "save":
    case "loan":
    case "repay":
    case "withdraw": {
      // Fraud brake: cap rapid-fire money commands per phone (6/hour).
      if (!checkMoneyRateLimit(phone)) {
        await sendText({
          to: phone,
          text: "⏳ You've made several money requests in the last hour. For your safety, please wait a little before trying again.",
        });
        break;
      }
      if (cmd === "save") await handleSave(phone, args);
      else if (cmd === "loan") await handleLoan(phone, args);
      else if (cmd === "repay") await handleRepay(phone, args);
      else await handleWithdraw(phone, args);
      break;
    }

    case "fund":
      await handleFund(phone);
      break;

    case "confirm":
      await handleConfirm(phone, args);
      break;

    case "code":
      await handleCode(phone);
      break;

    case "phone":
      await handlePhone(phone, args);
      break;

    case "ledger":
      await handleLedger(phone);
      break;

    case "posts": {
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
        break;
      }
      await sendText({ to: phone, text: await listPosts(member.cooperativeId) });
      break;
    }

    case "mydeduction": {
      const result = await myDeduction(phone);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "skipmonth": {
      const result = await requestMonthWaiver(phone);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "history":
    case "statement":
      await handleHistory(phone);
      break;

    case "plan":
      await handlePlan(phone, args);
      break;

    case "dividend":
      await handleDividend(phone, args);
      break;

    case "joinunit":
      await handleJoinUnit(phone, args);
      break;

    case "validate":
      await handleValidateClaim(phone, args);
      break;

    case "support":
      await handleSupport(phone, text);
      break;

    case "tickets":
    case "mytickets": {
      const result = await listTickets(phone);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "resolve": {
      const ticketCode = args[0];
      const note = args.slice(1).join(" ");
      if (!ticketCode) {
        await sendText({ to: phone, text: "Usage: *resolve <ticket id> <note>*" });
        return;
      }
      const result = await resolveTicket(phone, ticketCode, note);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "startvote": {
      // startvote unit <unitcode> <title...> | startvote exec <position> <title...>
      const kind = args[0]?.toLowerCase();
      const scope = args[1];
      const title = args.slice(2).join(" ");
      const result = await startVote(phone, kind ?? "", scope, title);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "candidate": {
      const voteCode = args[0];
      const memberCode = args[1];
      if (!voteCode || !memberCode) {
        await sendText({ to: phone, text: "Usage: *candidate <election id> <member code>*" });
        return;
      }
      const result = await addCandidate(phone, voteCode, memberCode);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "vote": {
      const voteCode = args[0];
      const memberCode = args[1];
      if (!voteCode || !memberCode) {
        await sendText({ to: phone, text: "Usage: *vote <election id> <member code>*" });
        return;
      }
      const result = await castVote(phone, voteCode, memberCode);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "closevote": {
      if (!args[0]) {
        await sendText({ to: phone, text: "Usage: *closevote <election id>*" });
        return;
      }
      const result = await closeVote(phone, args[0]);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "results": {
      if (!args[0]) {
        await sendText({ to: phone, text: "Usage: *results <election id>*" });
        return;
      }
      const result = await showResults(phone, args[0]);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "buypolls": {
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
        return;
      }
      const polls = await listBuyPolls(member.cooperativeId);
      if (polls.length === 0) {
        await sendText({ to: phone, text: "No buy-votes yet. Admins open one with *startbuyvote <title>*." });
        return;
      }
      const parts: string[] = [];
      for (const p of polls) {
        parts.push(
          `🛒 *${p.title}* (${p.status}) — id *${p.id.slice(-6)}*`,
          ...p.options.map((o, i) => `   ${i + 1}. ${o.name} — ~${formatBalance(o.estimatedCost)} — ${o._count.ballots} vote(s)`),
          "",
        );
      }
      await sendText({
        to: phone,
        text:
          parts.join("\n").trim() +
          `\n\nVote with *votebuy <poll id> <option number>*.`,
      });
      return;
    }

    case "votebuy": {
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
        return;
      }
      const pollCode = args[0];
      const optionNumber = Number(args[1]);
      if (!pollCode || !Number.isInteger(optionNumber) || optionNumber < 1) {
        await sendText({ to: phone, text: "Usage: *votebuy <poll id> <option number>* — see options with *buypolls*." });
        return;
      }
      const result = await castBuyVote(
        { id: member.id, cooperativeId: member.cooperativeId },
        pollCode,
        optionNumber,
      );
      await sendText({ to: phone, text: result.message });
      return;
    }

    default: {
      // Optional AI fallback (GROQ_API_KEY): translate free text / pidgin
      // into a real command, then ask the human to confirm it.
      if (aiEnabled() && text.trim().length >= 4 && !/^[\d\s.,]+$/.test(text)) {
        const suggestion = await suggestCommand(text);
        if (suggestion) {
          await prisma.session.upsert({
            where: { phone },
            create: {
              phone,
              state: "awaiting_ai_confirm",
              data: JSON.stringify({ aiCommand: suggestion.command, aiArgs: suggestion.args }),
            },
            update: {
              state: "awaiting_ai_confirm",
              data: JSON.stringify({ aiCommand: suggestion.command, aiArgs: suggestion.args }),
            },
          });
          await sendText({
            to: phone,
            text:
              `🤖 Did you mean *${[suggestion.command, ...suggestion.args].join(" ")}*?\n\n` +
              `Reply *yes* to run it or *no* to cancel.`,
          });
          return;
        }
      }
      await sendText({
        to: phone,
        text:
          `I didn't quite get that. Reply *menu* to see your options.\n\n` +
          `Tip: you can type things like "save 2000", "loan 50000 3", or "balance".`,
      });
    }
  }
}

function buildMenu(member: { name: string; cooperative: { name: string }; wallet: { balance: number } | null } | null): string {
  if (!member) {
    return (
      `Welcome to *Coop WhatsApp Bank*! 🏦\n\n` +
      `Run your cooperative savings, loans, and payments right here on WhatsApp.\n\n` +
      `Commands:\n` +
      `• *join <code>* — join a cooperative\n` +
      `• *menu* — see this menu`
    );
  }
  return (
    `Hi *${member.name}* from *${member.cooperative.name}* 🏦\n\n` +
      `Commands:\n` +
      `• *balance* — check your savings balance\n` +
      `• *save <amount>* — make a contribution (e.g. *save 2000*)\n` +
      `• *withdraw <amount>* — request a withdrawal (up to 45% of savings; once per 6 months)\n` +
      `• *plan <amount> <weekly|monthly>* — set a recurring contribution\n` +
      `• *fund* — get your personal top-up account number\n` +
      `• *loan <amount> <months>* — apply for a loan (e.g. *loan 50000 3*)\n` +
      `• *repay* — repay your loan monthly installment\n` +
      `• *validate <claim id>* — validate a death claim (guarantors)\n` +
      `• *history* — your transaction statement\n` +
      `• *ledger* — cooperative ledger (transparency)\n` +
      `• *dividend <rate>* — dividend calculator (real-time)\n` +
      `• *joinunit <code>* — join your workplace/unit\n` +
      `• *code* — see your member code (share it for guarantor requests)\n` +
      `• *confirm <code>* — accept a guarantor request\n` +
      `• *phone <number>* — add/update your real phone number (needed for funding)\n` +
      `• *support <issue>* — open a support ticket with customer service\n` +
      `• *vote <election id> <member code>* — vote in an election\n` +
      `• *buypolls* — see what the coop is voting to buy\n` +
      `• *votebuy <poll id> <option #>* — vote for what the coop should buy\n` +
      `• *menu* — show this menu\n\n` +
      `Admins: try *pending*, *approve <id>*, *reject <id>*, *broadcast <msg>*, *units*, *addunit*, *approvewdraw <id>*, *overridewithdrawal <phone>*, *deathclaim*, *claimbank*, *tickets*, *resolve*, *startvote unit|exec ...*, *candidate*, *closevote*, *startbuyvote <title>*, *addoption <id> <item> <cost> <acct> <bank>*, *closebuyvote <id>*, *enable2fa* (protect your account), *verifypin <pin>* (unlock big payouts for 10 min)\n` +
      `Super admin: *finalize <id>*, *approveclaim <id>*, *setrole <code> <role>*, *paydividend <rate% of profit>*, *pnl*, *payout <amt> <phone> <narration>*, *payanyone <amt> <account> <bank> <narration>* (3 supers), *approvepay <id>*, *setsalary*, *runpayroll <narration>*, *export members|transactions|pnl*, *setlimit <amt>*, *backup*, *reconcile*`
  );
}

async function handleJoinStart(phone: string, args: string[]): Promise<void> {
  if (args[0]) {
    // e.g. "join TEST01" — jump straight to asking for name
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_name", data: JSON.stringify({ joinCode: args[0].toUpperCase() }) },
      update: { state: "awaiting_name", data: JSON.stringify({ joinCode: args[0].toUpperCase() }) },
    });
    await sendText({
      to: phone,
      text: `Great — joining cooperative *${args[0].toUpperCase()}*. What's your full name?`,
    });
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_coop_code" },
    update: { state: "awaiting_coop_code" },
  });
  await sendText({
    to: phone,
    text: `Let's get you set up! 🏦\n\nWhat's your cooperative's code? (You can get this from your cooperative admin.)`,
  });
}

async function handleAwaitingInput(
  phone: string,
  state: BotState,
  text: string,
  dataJson: string,
  meta: MessageMeta = {},
): Promise<void> {
  const data = safeParse(dataJson);

  if (SECRET_STATES.includes(state)) {
    // Telegram: scrub the typed secret from chat history immediately.
    if (meta.telegramMessageId) {
      void deleteTelegramMessage(phone.slice(3), meta.telegramMessageId).catch(() => {});
    }
    // WhatsApp Flow cards echo a one-time token. If a token arrives and it
    // doesn't match the outstanding challenge, this submission is stale or
    // replayed (e.g. an old card resubmitted) — kill the flow. Typed text
    // carries no token and stays accepted so the plain-chat fallback works.
    if (data.flowToken && meta.flowToken && meta.flowToken !== data.flowToken) {
      await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
      await sendText({
        to: phone,
        text: "That secure entry expired. Reply *menu* to start again.",
      });
      return;
    }
  }

  switch (state) {
    case "awaiting_coop_code": {
      const code = text.trim().toUpperCase();
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_name", data: JSON.stringify({ joinCode: code }) },
        update: { state: "awaiting_name", data: JSON.stringify({ joinCode: code }) },
      });
      await sendText({ to: phone, text: `Great — joining cooperative *${code}*. What's your full name?` });
      break;
    }

    case "awaiting_name": {
      const name = text.trim().replace(/\s+/g, " ");
      if (!name || name.length < 2) {
        await sendText({ to: phone, text: "Please enter your full name so we know who's saving." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_phone", data: JSON.stringify({ ...data, name }) },
        update: { state: "awaiting_phone", data: JSON.stringify({ ...data, name }) },
      });
      if (phone.startsWith("tg:")) {
        await sendText({
          to: phone,
          text: `Thanks, *${name}*! What's your real phone number? We need it for funding your wallet by bank transfer (e.g. *08012345678*).`,
        });
      } else {
        await askEmail(phone, { ...data, name });
      }
      break;
    }

    case "awaiting_phone": {
      const contactPhone = normalizePhone(text);
      if (!contactPhone) {
        await sendText({ to: phone, text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*." });
        return;
      }
      // Verify the number belongs to them: if it's already a WhatsApp member
      // number we can send a code to that WhatsApp. Otherwise continue
      // unverified (flagged on the account).
      const code = String(randomInt(100000, 999999)); // ✅ Cryptographically secure OTP
      const delivered = await deliverOtp(contactPhone, code);
      if (delivered) {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_otp",
            data: JSON.stringify({ ...data, contactPhone, otp: code, otpExpiresAt: Date.now() + OTP_TTL_MS }),
          },
          update: {
            state: "awaiting_otp",
            data: JSON.stringify({ ...data, contactPhone, otp: code, otpExpiresAt: Date.now() + OTP_TTL_MS }),
          },
        });
        await sendText({
          to: phone,
          text: `We sent a 6-digit code to the WhatsApp connected to *${contactPhone}*. Reply it here to verify your number.`,
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_email", data: JSON.stringify({ ...data, contactPhone, phoneVerified: false }) },
        update: { state: "awaiting_email", data: JSON.stringify({ ...data, contactPhone, phoneVerified: false }) },
      });
      await askEmail(phone, { ...data, contactPhone, phoneVerified: false });
      break;
    }

    case "awaiting_otp": {
      const input = text.trim();
      if (!/^\d{6}$/.test(input)) {
        await sendText({ to: phone, text: "Enter the 6-digit code we sent to your WhatsApp, or reply *resend*." });
        return;
      }
      if (!data.otpExpiresAt || data.otpExpiresAt < Date.now()) {
        await sendText({ to: phone, text: "That code expired. Reply *resend* for a new one." });
        return;
      }
      if (input !== data.otp) {
        await sendText({ to: phone, text: "Wrong code. Check the WhatsApp message and try again." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_email", data: JSON.stringify({ ...data, otp: undefined, phoneVerified: true }) },
        update: { state: "awaiting_email", data: JSON.stringify({ ...data, otp: undefined, phoneVerified: true }) },
      });
      await askEmail(phone, { ...data, phoneVerified: true });
      break;
    }

    case "awaiting_email": {
      const email = text.trim().toLowerCase();
      if (email === "skip" || email === "0" || email === "-" || email === "none") {
        await askBirthday(phone, data);
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await sendText({ to: phone, text: "That doesn't look like a valid email. Reply *skip* to skip this step, or enter an email like *ada@example.com*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_birthday", data: JSON.stringify({ ...data, email }) },
        update: { state: "awaiting_birthday", data: JSON.stringify({ ...data, email }) },
      });
      await askBirthday(phone, { ...data, email });
      break;
    }

    case "awaiting_birthday": {
      const raw = text.trim();
      if (raw === "skip" || raw === "0" || raw === "-" || raw === "none") {
        await askNokName(phone, data);
        return;
      }
      const dob = parseBirthday(raw);
      if (!dob) {
        await sendText({ to: phone, text: "Please use the format *DD/MM*, e.g. *15/08*, or reply *skip* to skip." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_nok_name", data: JSON.stringify({ ...data, dateOfBirth: dob.toISOString() }) },
        update: { state: "awaiting_nok_name", data: JSON.stringify({ ...data, dateOfBirth: dob.toISOString() }) },
      });
      await askNokName(phone, { ...data, dateOfBirth: dob.toISOString() });
      break;
    }

    case "awaiting_nok_name": {
      const nokName = text.trim().replace(/\s+/g, " ");
      if (!nokName || nokName.length < 2) {
        await sendText({ to: phone, text: "Please enter your next of kin's full name (e.g. *Chidi Okafor*)." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_nok_phone", data: JSON.stringify({ ...data, nokName }) },
        update: { state: "awaiting_nok_phone", data: JSON.stringify({ ...data, nokName }) },
      });
      await sendText({
        to: phone,
        text: `What's *${nokName}'s* phone number? If anything happens to you, this is who we contact about your savings.`,
      });
      break;
    }

    case "awaiting_nok_phone": {
      const nokPhone = normalizePhone(text);
      if (!nokPhone) {
        await sendText({ to: phone, text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*." });
        return;
      }
      const nextData: FlowData = { ...data, nokPhone };
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_pin", data: JSON.stringify(nextData) },
        update: { state: "awaiting_pin", data: JSON.stringify(nextData) },
      });
      await askPin(phone, nextData);
      break;
    }

    case "awaiting_pin": {
      if (!/^\d{4}$/.test(text.trim())) {
        await issueSecretChallenge(
          phone,
          "awaiting_pin",
          data,
          "Your PIN must be exactly 4 digits (e.g. *1234*).",
        );
        return;
      }
      await issueSecretChallenge(
        phone,
        "awaiting_pin_confirm",
        { ...data, pin: text.trim() },
        "Please re-enter your PIN to confirm.",
      );
      break;
    }

    case "awaiting_pin_confirm": {
      if (text.trim() !== data.pin) {
        await sendText({ to: phone, text: "PINs didn't match. Let's start again — choose a 4-digit PIN." });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_pin" },
          update: { state: "awaiting_pin" },
        });
        return;
      }
      const result = await findOrCreateMember(
        phone,
        data.joinCode ?? "",
        data.name ?? "",
        text.trim(),
        data.contactPhone,
        data.email,
        data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        data.nokName && data.nokPhone ? { name: data.nokName, phone: data.nokPhone } : undefined,
        data.phoneVerified ?? false,
      );
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_save_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({ to: phone, text: "Please enter a valid amount, e.g. *5000*." });
        return;
      }
      const result = await createContribution(phone, amount);
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_loan_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({ to: phone, text: "Please enter a valid amount, e.g. *50000*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_loan_months", data: JSON.stringify({ ...data, loanAmount: amount }) },
        update: { state: "awaiting_loan_months", data: JSON.stringify({ ...data, loanAmount: amount }) },
      });
      await sendText({ to: phone, text: "For how many months? (1–12)" });
      break;
    }

    case "awaiting_loan_months": {
      const months = parseInt(text.trim(), 10);
      if (!Number.isFinite(months) || months < 1 || months > 12) {
        await sendText({ to: phone, text: "Months must be between 1 and 12, e.g. *3*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_loan_bank_account", data: JSON.stringify({ ...data, loanMonths: months }) },
        update: { state: "awaiting_loan_bank_account", data: JSON.stringify({ ...data, loanMonths: months }) },
      });
      await sendText({
        to: phone,
        text:
          `Perfect. The loan will be paid directly into your bank account.\n\n` +
          `What's your *bank account number*? (10 digits, e.g. *0123456789*)`,
      });
      break;
    }

    case "awaiting_loan_bank_account": {
      const account = text.trim().replace(/[^0-9]/g, "");
      if (!/^\d{10}$/.test(account)) {
        await sendText({ to: phone, text: "Account numbers are 10 digits. Please re-enter, e.g. *0123456789*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_loan_bank_code", data: JSON.stringify({ ...data, loanAccount: account }) },
        update: { state: "awaiting_loan_bank_code", data: JSON.stringify({ ...data, loanAccount: account }) },
      });
      await sendText({
        to: phone,
        text: `Which bank? (e.g. *Access*, *GTB*, *Zenith*, *UBA*, *First Bank*, *Kuda*, *Opay*)`,
      });
      break;
    }

    case "awaiting_loan_bank_code": {
      const bank = resolveBankCode(text);
      if (!bank) {
        await sendText({
          to: phone,
          text: `We don't recognise that bank. Try e.g. *Access*, *GTB*, *Zenith*, *UBA*, *First Bank*, *Kuda*, or reply with the 5-digit bank code directly.`,
        });
        return;
      }
      const result = await applyForLoan(phone, data.loanAmount ?? 0, data.loanMonths ?? 1, {
        accountNumber: data.loanAccount ?? "",
        bankCode: bank.code,
        bankName: bank.name,
      });
      if (!result.ok || !result.loanId) {
        await sendText({ to: phone, text: result.message });
        await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_guarantor_1", data: JSON.stringify({ loanId: result.loanId }) },
        update: { state: "awaiting_guarantor_1", data: JSON.stringify({ loanId: result.loanId }) },
      });
      await sendText({ to: phone, text: result.message });
      await sendText({
        to: phone,
        text:
          `To complete your application, you need *2 guarantors* who are members of the cooperative.\n\n` +
          `Send the *member code* of your first guarantor (e.g. *ABC123-DEFG*).`,
      });
      break;
    }

    case "awaiting_guarantor_1": {
      const result = await addGuarantor(phone, data.loanId ?? "", text);
      await sendText({ to: phone, text: result.message });
      if (result.ok) {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_guarantor_2", data: JSON.stringify({ loanId: data.loanId }) },
          update: { state: "awaiting_guarantor_2", data: JSON.stringify({ loanId: data.loanId }) },
        });
      }
      break;
    }

    case "awaiting_guarantor_2": {
      const result = await addGuarantor(phone, data.loanId ?? "", text);
      await sendText({ to: phone, text: result.message });
      if (result.ok) {
        await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      }
      break;
    }

    case "awaiting_withdraw_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({ to: phone, text: "Please enter a valid amount, e.g. *withdraw 5000*." });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (member?.bankAccountNumber && member.bankCode) {
        await issueSecretChallenge(
          phone,
          "awaiting_withdraw_pin",
          { ...data, withdrawAmount: amount },
          "Enter your 4-digit PIN to confirm the withdrawal.",
        );
      } else {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_withdraw_account", data: JSON.stringify({ ...data, withdrawAmount: amount }) },
          update: { state: "awaiting_withdraw_account", data: JSON.stringify({ ...data, withdrawAmount: amount }) },
        });
        await sendText({
          to: phone,
          text: `Your savings will go to your bank account. What's your *bank account number*? (10 digits, e.g. *0123456789*)`,
        });
      }
      break;
    }

    case "awaiting_withdraw_account": {
      const account = text.trim().replace(/[^0-9]/g, "");
      if (!/^\d{10}$/.test(account)) {
        await sendText({ to: phone, text: "Account numbers are 10 digits. Please re-enter, e.g. *0123456789*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_withdraw_bank", data: JSON.stringify({ ...data, withdrawAccount: account }) },
        update: { state: "awaiting_withdraw_bank", data: JSON.stringify({ ...data, withdrawAccount: account }) },
      });
      await sendText({ to: phone, text: `Which bank? (e.g. *Access*, *GTB*, *Zenith*, *UBA*, *Kuda*)` });
      break;
    }

    case "awaiting_withdraw_bank": {
      const bank = resolveBankCode(text);
      if (!bank) {
        await sendText({ to: phone, text: "We don't recognise that bank. Try e.g. *Access*, *GTB*, *Zenith*, *Kuda*, or the 5-digit bank code." });
        return;
      }
      await issueSecretChallenge(
        phone,
        "awaiting_withdraw_pin",
        { ...data, withdrawBankCode: bank.code, withdrawBankName: bank.name },
        "Enter your 4-digit PIN to confirm the withdrawal.",
      );
      break;
    }

    case "awaiting_withdraw_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle", data: "{}" } });
        await sendText({ to: phone, text: "Withdrawal cancelled. Reply *menu* to start something else." });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first." });
        return;
      }
      // Brute-force protection: 3 wrong PINs locks the account for 15 minutes.
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        // Re-issue the challenge so Flow users get a fresh card to retry with.
        await issueSecretChallenge(phone, "awaiting_withdraw_pin", data, msg);
        return;
      }
      const bank =
        data.withdrawAccount && data.withdrawBankCode
          ? { accountNumber: data.withdrawAccount, bankCode: data.withdrawBankCode, bankName: data.withdrawBankName }
          : undefined;
      const result = await requestWithdrawal(phone, data.withdrawAmount ?? 0, bank);
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_death_cert": {
      const cert = text.trim();
      if (!cert) {
        await sendText({ to: phone, text: "Please send the death certificate (photo, document or reference details)." });
        return;
      }
      const result = await submitCertificate(data.deathClaimId ?? "", cert);
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_ai_confirm": {
      const answer = text.trim().toLowerCase();
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle", data: "{}" } });
      if (answer === "yes" || answer === "1" || answer === "ok") {
        const proposed = [data.aiCommand, ...(data.aiArgs ?? [])].filter(Boolean).join(" ");
        // Re-enter the normal pipeline — every gate (PIN/2FA/roles) applies.
        await handleMessage(phone, proposed);
        return;
      }
      await sendText({ to: phone, text: "Okay, cancelled. Reply *menu* to see your options." });
      break;
    }

    default:
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: buildMenu(null) });
  }
}

async function handleBalance(
  phone: string,
  member: { name: string; cooperative: { name: string }; wallet: { balance: number } | null } | null,
): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  const balance = member.wallet?.balance ?? 0;
  await sendText({
    to: phone,
    text: `Hi *${member.name}*, your savings balance is *${formatBalance(balance)}*.\n\nReply *save <amount>* to contribute more.`,
  });
}

async function handleSave(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_save_amount" },
      update: { state: "awaiting_save_amount" },
    });
    await sendText({ to: phone, text: "How much would you like to save? (e.g. *2000*)" });
    return;
  }
  const result = await createContribution(phone, amount);
  await sendText({ to: phone, text: result.message });
}

async function handleFund(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const result = await provisionVirtualAccount(member.id);
  await sendText({ to: phone, text: result.message });
}

async function handleWithdraw(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_withdraw_amount" },
      update: { state: "awaiting_withdraw_amount" },
    });
    await sendText({
      to: phone,
      text: "How much would you like to withdraw? You can take out up to *45%* of your savings at once (e.g. *withdraw 5000*).",
    });
    return;
  }
  const limit = await withdrawLimit(phone);
  if (!limit) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  // 6-month rule (admin can override).
  const eligibility = await canWithdraw(phone);
  if (!eligibility.ok) {
    await sendText({ to: phone, text: eligibility.message });
    return;
  }
  if (amount > limit.max) {
    await sendText({
      to: phone,
      text: `You can withdraw at most *${formatBalance(limit.max)}* (45% of your ${formatBalance(limit.balance)} balance).`,
    });
    return;
  }
  const member = await getMemberByPhone(phone);
  if (member?.bankAccountNumber && member.bankCode) {
    await issueSecretChallenge(
      phone,
      "awaiting_withdraw_pin",
      { withdrawAmount: amount },
      `Withdraw ${amount.toLocaleString()} to ${member.bankName ?? member.bankCode} ****${member.bankAccountNumber.slice(-4)}? Enter your 4-digit PIN to confirm.`,
    );
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_withdraw_account", data: JSON.stringify({ withdrawAmount: amount }) },
    update: { state: "awaiting_withdraw_account", data: JSON.stringify({ withdrawAmount: amount }) },
  });
  await sendText({
    to: phone,
    text: "Your savings will go to your bank account. What's your *bank account number*? (10 digits, e.g. *0123456789*)",
  });
}

async function handleLoan(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  const months = args[1] ? parseInt(args[1], 10) : NaN;
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_loan_amount" },
      update: { state: "awaiting_loan_amount" },
    });
    await sendText({ to: phone, text: "How much would you like to borrow? (e.g. *50000*)" });
    return;
  }
  if (!Number.isFinite(months) || months < 1 || months > 12) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_loan_months", data: JSON.stringify({ loanAmount: amount }) },
      update: { state: "awaiting_loan_months", data: JSON.stringify({ loanAmount: amount }) },
    });
    await sendText({ to: phone, text: "For how many months? (1–12)" });
    return;
  }
  // Amount + months known — now collect the bank account for disbursement.
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_loan_bank_account", data: JSON.stringify({ loanAmount: amount, loanMonths: months }) },
    update: { state: "awaiting_loan_bank_account", data: JSON.stringify({ loanAmount: amount, loanMonths: months }) },
  });
  await sendText({
    to: phone,
    text:
      `Great. The loan will be paid directly into your bank account.\n\n` +
      `What's your *bank account number*? (10 digits, e.g. *0123456789*)`,
  });
}

async function handleRepay(phone: string, _args: string[]): Promise<void> {
  const result = await repayLoan(phone);
  await sendText({ to: phone, text: result.message });
}

async function handleSupport(phone: string, text: string): Promise<void> {
  // Everything after the word "support" is the issue description.
  const message = text.trim().replace(/^\s*support\s*/i, "");
  const result = await createTicket(phone, message);
  await sendText({ to: phone, text: result.message });
}

async function handleValidateClaim(phone: string, args: string[]): Promise<void> {
  const code = args[0];
  if (!code) {
    await sendText({ to: phone, text: "To validate a death claim, reply *validate <claim id>* with the id you received." });
    return;
  }
  const result = await validateClaim(phone, code);
  await sendText({ to: phone, text: result.message });
}

async function handleConfirm(phone: string, args: string[]): Promise<void> {
  const code = args[0];
  if (!code) {
    await sendText({ to: phone, text: "To accept a guarantor request, reply *confirm <code>* with the code you received." });
    return;
  }
  const result = await confirmGuarantee(phone, code);
  await sendText({ to: phone, text: result.message });
}

async function handleCode(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  await sendText({
    to: phone,
    text: `Your member code is *${member.code}*. Share it with members who want you as a guarantor.`,
  });
}

async function handlePhone(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const contactPhone = normalizePhone(args.join(""));
  if (!contactPhone) {
    await sendText({
      to: phone,
      text: "Reply *phone <number>* with a valid number, e.g. *phone 08012345678* or *phone +2348012345678*.",
    });
    return;
  }
  await prisma.member.update({
    where: { id: member.id },
    data: { contactPhone },
  });
  await sendText({ to: phone, text: `Thanks! Your phone is now set to *${contactPhone}*. Reply *fund* to get your funding account.` });
}

async function handleLedger(phone: string): Promise<void> {
  const result = await showLedger(phone);
  await sendText({ to: phone, text: result.message });
}

async function handleHistory(phone: string): Promise<void> {
  const result = await showHistory(phone);
  await sendText({ to: phone, text: result.message });
}

async function handlePlan(phone: string, args: string[]): Promise<void> {
  if (args[0]?.toLowerCase() === "off") {
    const result = await setAutoSave(phone, null);
    await sendText({ to: phone, text: result.message });
    return;
  }
  const amount = parseNaira(args[0]);
  const interval = args[1]?.toLowerCase();
  if (amount === null || (interval !== "weekly" && interval !== "monthly")) {
    await sendText({
      to: phone,
      text: "Usage: *plan <amount> <weekly|monthly>*, e.g. *plan 2000 weekly*. Or *plan off* to stop.",
    });
    return;
  }
  const result = await setAutoSave(phone, amount, interval);
  await sendText({ to: phone, text: result.message });
}

async function handleDividend(phone: string, args: string[]): Promise<void> {
  const rate = parseNaira(args[0]);
  if (rate === null) {
    await sendText({ to: phone, text: "Usage: *dividend <rate>*, e.g. *dividend 5* for a 5% dividend calculation." });
    return;
  }
  const result = await computeDividendPreview(phone, rate);
  await sendText({ to: phone, text: result.message });
}

async function handleJoinUnit(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({ to: phone, text: "Usage: *joinunit <code>*, e.g. *joinunit LAG01*." });
    return;
  }
  const result = await joinUnit(phone, args[0]);
  await sendText({ to: phone, text: result.message });
}

function parseNaira(raw?: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,₦\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse DD/MM (or DD-MM) into a date. Year is arbitrary — only month/day matter. */
function parseBirthday(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(2000, month - 1, day);
  return date;
}

async function askEmail(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_email", data: JSON.stringify({ ...data, name: data.name }) },
    update: { state: "awaiting_email", data: JSON.stringify({ ...data, name: data.name }) },
  });
  await sendText({
    to: phone,
    text: `Thanks, *${data.name}*! What's your email? *(optional)* We'll send your monthly statement there. Reply *skip* to skip.`,
  });
}

async function askBirthday(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_birthday", data: JSON.stringify(data) },
    update: { state: "awaiting_birthday", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text: `Almost done — when's your birthday? *(optional, e.g. *15/08*)* We'll send you a special message. Reply *skip* to skip.`,
  });
}

async function askNokName(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_nok_name", data: JSON.stringify(data) },
    update: { state: "awaiting_nok_name", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text:
      `Last KYC step — who is your *next of kin*? (full name)\n\n` +
      `If anything happens to you, they're who the cooperative works with on your savings.`,
  });
}

async function askPin(phone: string, data: FlowData): Promise<void> {
  await issueSecretChallenge(
    phone,
    "awaiting_pin",
    data,
    "Now choose a 4-digit PIN. You'll use it to approve transactions.",
  );
}

/**
 * Persist a flow state and prompt the user for a secret (PIN). A fresh
 * one-time token is stored with the session and bound to the WhatsApp Flow
 * card; on Telegram / plain chat it degrades to an ordinary text prompt.
 */
async function issueSecretChallenge(
  phone: string,
  state: BotState,
  data: FlowData,
  text: string,
): Promise<void> {
  const flowToken = randomBytes(16).toString("hex");
  const nextData: FlowData = { ...data, flowToken };
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state, data: JSON.stringify(nextData) },
    update: { state, data: JSON.stringify(nextData) },
  });
  await sendSecurePrompt({ to: phone, text, flowToken });
}

/**
 * Deliver an OTP to prove ownership of a phone number: if that number is
 * already connected to WhatsApp here, send the code there.
 */
async function deliverOtp(contactPhone: string, code: string): Promise<boolean> {
  const existing = await prisma.member.findFirst({
    where: { contactPhone, phone: { not: { startsWith: "tg:" } } },
    select: { phone: true },
  });
  if (!existing) return false;
  try {
    await sendText({
      to: existing.phone,
      text: `Your Coop Bank verification code is *${code}*. It expires in 10 minutes.`,
    });
    return true;
  } catch {
    return false;
  }
}

function safeParse(json: string): FlowData {
  try {
    const parsed = JSON.parse(json);
    const result = FlowDataSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}
