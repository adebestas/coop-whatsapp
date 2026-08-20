import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
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

export type BotState =
  | "idle"
  | "awaiting_name"
  | "awaiting_coop_code"
  | "awaiting_phone"
  | "awaiting_pin"
  | "awaiting_pin_confirm"
  | "awaiting_save_amount"
  | "awaiting_loan_amount"
  | "awaiting_loan_months"
  | "awaiting_guarantor_1"
  | "awaiting_guarantor_2";

interface FlowData {
  joinCode?: string;
  pin?: string;
  name?: string;
  contactPhone?: string;
  loanAmount?: number;
  loanId?: string;
}

function isAwaitingState(state: BotState): boolean {
  return !["idle"].includes(state);
}

function parseCommand(text: string): { cmd: string; args: string[] } {
  const parts = text.trim().toLowerCase().split(/\s+/);
  return { cmd: parts[0] ?? "", args: parts.slice(1) };
}

export async function handleMessage(phone: string, text: string): Promise<void> {
  const session = await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "idle" },
    update: {},
  });

  // Multi-turn flow: the bot is waiting for an answer to a question.
  if (isAwaitingState(session.state as BotState)) {
    await handleAwaitingInput(phone, session.state as BotState, text, session.data);
    return;
  }

  const member = await getMemberByPhone(phone);
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
      await handleSave(phone, args);
      break;

    case "fund":
      await handleFund(phone);
      break;

    case "loan":
      await handleLoan(phone, args);
      break;

    case "repay":
      await handleRepay(phone, args);
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

    default:
      await sendText({
        to: phone,
        text:
          `I didn't quite get that. Reply *menu* to see your options.\n\n` +
          `Tip: you can type things like "save 2000", "loan 50000 3", or "balance".`,
      });
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
      `• *plan <amount> <weekly|monthly>* — set a recurring contribution\n` +
      `• *fund* — get your personal top-up account number\n` +
      `• *loan <amount> <months>* — apply for a loan (e.g. *loan 50000 3*)\n` +
      `• *repay* — repay your loan monthly installment\n` +
      `• *history* — your transaction statement\n` +
      `• *ledger* — cooperative ledger (transparency)\n` +
      `• *dividend <rate>* — dividend calculator (real-time)\n` +
      `• *joinunit <code>* — join your workplace/unit\n` +
      `• *code* — see your member code (share it for guarantor requests)\n` +
      `• *confirm <code>* — accept a guarantor request\n` +
      `• *phone <number>* — add/update your real phone number (needed for funding)\n` +
      `• *menu* — show this menu\n\n` +
      `Admins: try *pending*, *approve <id>*, *reject <id>*, *broadcast <msg>*, *dividend <rate>*, *interest <rate>*, *units*, *addunit <name> <code>*, *payout <amount> <phone>*`
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
): Promise<void> {
  const data = safeParse(dataJson) as FlowData;

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
        // WhatsApp members are already on a phone number — skip straight to PIN.
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_pin", data: JSON.stringify({ ...data, name }) },
          update: { state: "awaiting_pin", data: JSON.stringify({ ...data, name }) },
        });
        await sendText({
          to: phone,
          text: `Thanks, *${name}*! Now choose a 4-digit PIN. You'll use it to approve transactions.`,
        });
      }
      break;
    }

    case "awaiting_phone": {
      const contactPhone = normalizePhone(text);
      if (!contactPhone) {
        await sendText({ to: phone, text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_pin", data: JSON.stringify({ ...data, contactPhone }) },
        update: { state: "awaiting_pin", data: JSON.stringify({ ...data, contactPhone }) },
      });
      await sendText({ to: phone, text: `Got it. Now choose a 4-digit PIN. You'll use it to approve transactions.` });
      break;
    }

    case "awaiting_pin": {
      if (!/^\d{4}$/.test(text.trim())) {
        await sendText({ to: phone, text: "Your PIN must be exactly 4 digits (e.g. *1234*)." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_pin_confirm", data: JSON.stringify({ ...data, pin: text.trim() }) },
        update: { state: "awaiting_pin_confirm", data: JSON.stringify({ ...data, pin: text.trim() }) },
      });
      await sendText({ to: phone, text: "Please re-enter your PIN to confirm." });
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
      const result = await findOrCreateMember(phone, data.joinCode ?? "", data.name ?? "", text.trim(), data.contactPhone);
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
      const result = await applyForLoan(phone, data.loanAmount ?? 0, months);
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
  const result = await applyForLoan(phone, amount, months);
  if (result.ok && result.loanId) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_guarantor_1", data: JSON.stringify({ loanId: result.loanId }) },
      update: { state: "awaiting_guarantor_1", data: JSON.stringify({ loanId: result.loanId }) },
    });
    await sendText({ to: phone, text: result.message });
    await sendText({
      to: phone,
      text:
        `You need *2 guarantors* who are members of the cooperative.\n\n` +
        `Send the *member code* of your first guarantor (e.g. *ABC123-DEFG*).`,
    });
    return;
  }
  await sendText({ to: phone, text: result.message });
}

async function handleRepay(phone: string, _args: string[]): Promise<void> {
  const result = await repayLoan(phone);
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

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}