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
import { withdrawToBank, withdrawLimit } from "./withdrawals.js";
import { verifyPin } from "../lib/security.js";

export type BotState =
  | "idle"
  | "awaiting_name"
  | "awaiting_coop_code"
  | "awaiting_phone"
  | "awaiting_email"
  | "awaiting_birthday"
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
  | "awaiting_withdraw_pin";

interface FlowData {
  joinCode?: string;
  pin?: string;
  name?: string;
  contactPhone?: string;
  email?: string;
  dateOfBirth?: string; // ISO date string
  loanAmount?: number;
  loanMonths?: number;
  loanAccount?: string;
  loanBankCode?: string;
  loanBankName?: string;
  loanId?: string;
  withdrawAmount?: number;
  withdrawAccount?: string;
  withdrawBankCode?: string;
  withdrawBankName?: string;
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

    case "withdraw":
      await handleWithdraw(phone, args);
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
      `• *withdraw <amount>* — withdraw up to 45% of your savings\n` +
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
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_email", data: JSON.stringify({ ...data, contactPhone }) },
        update: { state: "awaiting_email", data: JSON.stringify({ ...data, contactPhone }) },
      });
      await askEmail(phone, { ...data, contactPhone });
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
        await askPin(phone, data);
        return;
      }
      const dob = parseBirthday(raw);
      if (!dob) {
        await sendText({ to: phone, text: "Please use the format *DD/MM*, e.g. *15/08*, or reply *skip* to skip." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_pin", data: JSON.stringify({ ...data, dateOfBirth: dob.toISOString() }) },
        update: { state: "awaiting_pin", data: JSON.stringify({ ...data, dateOfBirth: dob.toISOString() }) },
      });
      await askPin(phone, { ...data, dateOfBirth: dob.toISOString() });
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
      const result = await findOrCreateMember(
        phone,
        data.joinCode ?? "",
        data.name ?? "",
        text.trim(),
        data.contactPhone,
        data.email,
        data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
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
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_withdraw_pin", data: JSON.stringify({ ...data, withdrawAmount: amount }) },
          update: { state: "awaiting_withdraw_pin", data: JSON.stringify({ ...data, withdrawAmount: amount }) },
        });
        await sendText({ to: phone, text: "Enter your 4-digit PIN to confirm the withdrawal." });
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
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_withdraw_pin", data: JSON.stringify({ ...data, withdrawBankCode: bank.code, withdrawBankName: bank.name }) },
        update: { state: "awaiting_withdraw_pin", data: JSON.stringify({ ...data, withdrawBankCode: bank.code, withdrawBankName: bank.name }) },
      });
      await sendText({ to: phone, text: "Enter your 4-digit PIN to confirm the withdrawal." });
      break;
    }

    case "awaiting_withdraw_pin": {
      const member = await getMemberByPhone(phone);
      if (!member || !member.pin || !verifyPin(text.trim(), member.pin)) {
        await sendText({ to: phone, text: "Incorrect PIN. Try again, or reply *menu* to cancel." });
        return;
      }
      const bank =
        data.withdrawAccount && data.withdrawBankCode
          ? { accountNumber: data.withdrawAccount, bankCode: data.withdrawBankCode, bankName: data.withdrawBankName }
          : undefined;
      const result = await withdrawToBank(phone, data.withdrawAmount ?? 0, bank);
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: result.message });
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
  if (amount > limit.max) {
    await sendText({
      to: phone,
      text: `You can withdraw at most *${formatBalance(limit.max)}* (45% of your ${formatBalance(limit.balance)} balance).`,
    });
    return;
  }
  const member = await getMemberByPhone(phone);
  if (member?.bankAccountNumber && member.bankCode) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_withdraw_pin", data: JSON.stringify({ withdrawAmount: amount }) },
      update: { state: "awaiting_withdraw_pin", data: JSON.stringify({ withdrawAmount: amount }) },
    });
    await sendText({ to: phone, text: `Withdraw ${amount.toLocaleString()} to ${member.bankName ?? member.bankCode} ****${member.bankAccountNumber.slice(-4)}? Enter your 4-digit PIN to confirm.` });
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

// Common Nigerian bank names -> provider bank codes.
const BANK_CODES: Record<string, string> = {
  access: "044",
  gtb: "058",
  gtbank: "058",
  guarantee: "058",
  zenith: "057",
  uba: "033",
  firstbank: "011",
  first: "011",
  fbn: "011",
  union: "032",
  fidelity: "070",
  fcmb: "214",
  stanbic: "221",
  ibtc: "221",
  ecobank: "050",
  sterling: "232",
  wema: "035",
  polaris: "076",
  keystone: "082",
  unity: "215",
  jaiz: "301",
  providus: "101",
  kuda: "50211",
  opay: "50212",
  palmpay: "999992",
  moniepoint: "50515",
  fairmoney: "51318",
};

/** Resolve a bank code from a name (or accept a raw numeric code). */
function resolveBankCode(input: string): { code: string; name: string } | null {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) {
    return { code: cleaned, name: input.trim() };
  }
  const code = BANK_CODES[cleaned];
  if (!code) return null;
  return { code, name: input.trim() };
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

async function askPin(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_pin", data: JSON.stringify(data) },
    update: { state: "awaiting_pin", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text: `Now choose a 4-digit PIN. You'll use it to approve transactions.`,
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}