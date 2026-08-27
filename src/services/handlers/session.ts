import { prisma } from "../../lib/prisma.js";
import { sendText, sendSecurePrompt } from "../../lib/messaging.js";
import { deleteTelegramMessage } from "../../lib/telegram.js";
import { randomBytes, randomInt } from "node:crypto";
import { hashOtp, verifyOtp } from "../../lib/security.js";
import { normalizePhone } from "../../lib/phones.js";
import {
  createContribution,
  findOrCreateMember,
  formatBalance,
  getMemberByPhone,
} from "../cooperative.js";
import { toKobo } from "../../lib/money.js";
import { verifyMemberPin } from "../pin.js";
import { resolveBankCode } from "../../lib/banks.js";
import { applyForLoan } from "../loans.js";
import { addGuarantor } from "../guarantors.js";
import { requestWithdrawal } from "../withdrawals.js";
import { submitCertificate } from "../deathclaims.js";
import type { BotState, FlowData, MessageMeta } from "../conversation.js";
import { FlowDataSchema, SECRET_STATES } from "../conversation.js";
import { askEmail, askBirthday, askNokName, parseBirthday } from "./join.js";
import { getActiveElectionsForNewMember } from "../votes.js";
import { createCooperative } from "../cooperative.js";
import { prisma as prismaClient } from "../../lib/prisma.js";
import { hashPin, verifyPin } from "../../lib/security.js";
import { generateMemberCode } from "../../lib/security.js";
import { checkLimits, getCoopConfig } from "../coop-config.js";

/** A half-finished flow expires after this long. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** OTP codes expire after this long. */
const OTP_TTL_MS = 10 * 60 * 1000;

export function safeParse(json: string): FlowData {
  try {
    const parsed = JSON.parse(json);
    const result = FlowDataSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/**
 * Parse a member-typed monetary amount (in NAIRA, e.g. "5,000", "2000.50") and
 * return it as KOBO (the canonical storage unit). Returns null if invalid.
 * Caveat: do NOT use this for non-money rates (see handleDividend, which parses
 * a percentage rate and must not be multiplied by 100).
 */
export function parseNaira(raw?: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,₦\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? toKobo(n) : null;
}

export function buildMenu(member: { name: string; cooperative: { name: string }; wallet: { balance: number } | null; createdAt?: Date } | null): string {
  if (!member) {
    return (
      `Welcome to your cooperative's WhatsApp bot! 🤝\n\n` +
      `Save, borrow, and manage your cooperative funds right here.\n\n` +
      `To get started, reply *join <code>* with your cooperative's code.`
    );
  }
  return (
    `💰 *Your Cooperative*\n\n` +
    `Reply:\n` +
    `• *balance* — check wallet\n` +
    `• *save <amount>* — contribute savings\n` +
    `• *withdraw <amount>* — withdraw funds\n` +
    `• *loan <amount>* — apply for loan\n` +
    `• *help* — see all commands`
  );
}

export function buildFullMenu(member: { name: string; cooperative: { name: string }; wallet: { balance: number } | null; role?: string; createdAt?: Date } | null): string {
  if (!member) {
    return (
      `Welcome to your cooperative's WhatsApp bot! 🤝\n\n` +
      `Save, borrow, and manage your cooperative funds right here.\n\n` +
      `To get started, reply *join <code>* with your cooperative's code.`
    );
  }
  const isNewMember = member.createdAt && (Date.now() - member.createdAt.getTime()) < 3 * 24 * 60 * 60 * 1000;
  if (isNewMember) {
    return (
      `Hi *${member.name}* from *${member.cooperative.name}* 🏦\n\n` +
      `Here's what you can do:\n` +
      `• *save <amount>* — contribute savings\n` +
      `• *balance* — check your wallet\n` +
      `• *withdraw <amount>* — withdraw funds\n` +
      `• *loan <amount>* — apply for loan\n` +
      `• *help* — see all commands\n\n` +
      `_You're new here — try *save 1000* to make your first contribution!_`
    );
  }
  let menu =
    `Hi *${member.name}* from *${member.cooperative.name}* 🏦\n\n` +
    `Commands:\n` +
    `• *balance* — check your savings balance\n` +
    `• *save <amount>* — make a contribution (e.g. *save 2000*)\n` +
    `• *withdraw <amount>* — request a withdrawal (up to 45% of savings)\n` +
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
    `• *phone <number>* — add/update your real phone number\n` +
    `• *support <issue>* — open a support ticket\n` +
    `• *vote <election id> <member code>* — vote in an election\n` +
    `• *pollresults <election id>* — see live election results\n` +
    `• *buypolls* — see what the coop is voting to buy\n` +
    `• *votebuy <poll id> <option #>* — vote for what the coop should buy\n` +
    `• *contexthelp* — personalized help based on your account\n` +
    `• *class* — start/resume financial literacy (5 lessons)\n` +
    `• *next* — complete current lesson and get next one\n` +
    `• *class progress* — see your lesson progress\n` +
    `• *reserveinfo* — view Reserve Fund dashboard\n` +
    `• *mydata* — view personal data (NDPR right of access)\n` +
    `• *deleteaccount* — delete your account\n` +
    `• *grievance <msg>* — submit a complaint to admin\n` +
    `• *byelaws* — view cooperative byelaws\n` +
    `• *menu* — show this menu\n`;

  if (member.role === "admin" || member.role === "superadmin") {
    menu +=
      `\n*Admin commands:* *admin*\n`;
  }

  return menu;
}

export function buildAdminMenu(): string {
  return (
    `🔧 *Admin Commands*\n\n` +
    `• *members* — list all members\n` +
    `• *pending* — list pending loans\n` +
    `• *approve <id>* — approve a loan\n` +
    `• *reject <id>* — reject a loan\n` +
    `• *broadcast <msg>* — send message to all members\n` +
    `• *units* — list workplace units\n` +
    `• *addunit* — add a new unit\n` +
    `• *approvewdraw <id>* — approve withdrawal\n` +
    `• *overridewithdrawal <phone>* — override withdrawal\n` +
    `• *deathclaim* — process death claim\n` +
    `• *claimbank* — set claim bank\n` +
    `• *tickets* — list support tickets\n` +
    `• *grievances* — list grievances\n` +
    `• *resolve <id> <response>* — resolve ticket/grievance\n` +
    `• *startvote unit|exec ...* — start an election\n` +
    `• *candidate* — add election candidate\n` +
    `• *closevote* — close an election\n` +
    `• *startbuyvote <title>* — start a buy vote\n` +
    `• *addoption <id> <item> <cost> <acct> <bank>* — add buy option\n` +
    `• *closebuyvote <id>* — close a buy vote\n` +
    `• *enable2fa* — protect your account\n` +
    `• *verifypin <pin>* — unlock big payouts (10 min)\n` +
    `• *insights* — AI financial analysis\n` +
    `• *risk* — AI loan risk assessment\n\n` +
    `*Super admin:* *finalize <id>*, *approveclaim <id>*, *setrole <code> <role>*, *paydividend <rate%>*, *pnl*, *monthly*, *expense <amt> <cat> <desc>*, *payout <amt> <phone> <narr>*, *payanyone*, *approvepay <id>*, *setsalary*, *runpayroll <narr>*, *export members|transactions|pnl*, *setlimit <amt>*, *backup*, *reconcile*`
  );
}

export async function deliverOtp(contactPhone: string, code: string): Promise<boolean> {
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

export async function issueSecretChallenge(
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

export async function handleAwaitingInput(
  phone: string,
  state: BotState,
  text: string,
  dataJson: string,
  meta: MessageMeta = {},
): Promise<void> {
  const data = safeParse(dataJson);

  const escapeWords = ["menu", "cancel", "quit", "exit", "back"];
  if (escapeWords.includes(text.trim().toLowerCase())) {
    await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
    await sendText({ to: phone, text: "Flow cancelled. Reply *menu* to see options." });
    return;
  }

  if (SECRET_STATES.includes(state)) {
    if (meta.telegramMessageId) {
      void deleteTelegramMessage(phone.slice(3), meta.telegramMessageId).catch(() => {});
    }
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
        create: { phone, state: "awaiting_consent", data: JSON.stringify({ ...data, name }) },
        update: { state: "awaiting_consent", data: JSON.stringify({ ...data, name }) },
      });
      await sendText({
        to: phone,
        text:
          `*Privacy Notice (NDPR)*\n\n` +
          `By continuing, you consent to the collection and processing of your personal data ` +
          `(name, phone, bank details) for cooperative banking purposes only. Your data is stored ` +
          `securely and never shared with third parties without your consent.\n\n` +
          `For data protection inquiries, contact our Data Protection Officer (DPO): ` +
          `dpo@cooperative-app.ng\n\n` +
          `Reply *YES* to consent or *NO* to cancel.`,
      });
      break;
    }

    case "awaiting_consent": {
      const answer = text.trim().toLowerCase();
      if (answer === "yes" || answer === "y") {
        // Store consent in session data and proceed
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_phone", data: JSON.stringify({ ...data, consentGiven: true }) },
          update: { state: "awaiting_phone", data: JSON.stringify({ ...data, consentGiven: true }) },
        });
        if (phone.startsWith("tg:")) {
          await sendText({
            to: phone,
            text: `Thanks, *${data.name}*! What's your real phone number? We need it for funding your wallet by bank transfer (e.g. *08012345678*).`,
          });
        } else {
          await askEmail(phone, { ...data, name: data.name });
        }
        return;
      }
      if (answer === "no" || answer === "n") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({ to: phone, text: "Registration cancelled. Your data will not be stored." });
        return;
      }
      await sendText({ to: phone, text: "Please reply *YES* to consent or *NO* to cancel." });
      break;
    }

    case "awaiting_phone": {
      const contactPhone = normalizePhone(text);
      if (!contactPhone) {
        await sendText({ to: phone, text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*." });
        return;
      }
      const code = String(randomInt(100000, 999999));
      const hashedCode = hashOtp(code);
      const delivered = await deliverOtp(contactPhone, code);
      if (delivered) {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_otp",
            data: JSON.stringify({ ...data, contactPhone, otp: hashedCode, otpExpiresAt: Date.now() + OTP_TTL_MS }),
          },
          update: {
            state: "awaiting_otp",
            data: JSON.stringify({ ...data, contactPhone, otp: hashedCode, otpExpiresAt: Date.now() + OTP_TTL_MS }),
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
      if (!data.otp || !verifyOtp(input, data.otp)) {
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
        await sendText({ to: phone, text: "That doesn't look like a valid birthday. Use *DD/MM* format, e.g. *15/08*, or reply *skip*." });
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
      await issueSecretChallenge(
        phone,
        "awaiting_pin",
        nextData,
        "Now choose a 4-digit PIN. You'll use it to approve transactions.",
      );
      break;
    }

    case "awaiting_pin": {
      if (!/^\d{4,6}$/.test(text.trim())) {
        await issueSecretChallenge(
          phone,
          "awaiting_pin",
          data,
          "Your PIN must be 4-6 digits (e.g. *1234*).",
        );
        return;
      }
      await issueSecretChallenge(
        phone,
        "awaiting_pin_confirm",
        { ...data, pin: hashPin(text.trim()) },
        "Please re-enter your PIN to confirm.",
      );
      break;
    }

    case "awaiting_pin_confirm": {
      if (!data.pin || !verifyPin(text.trim(), data.pin)) {
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
      // Log NDPR consent if consent was given during registration
      if (result.ok && result.memberId && data.consentGiven) {
        await prisma.dataConsent.create({
          data: {
            memberId: result.memberId,
            consentType: "registration",
            granted: true,
          },
        });
        await prisma.member.update({
          where: { id: result.memberId },
          data: { dataConsentGiven: true },
        });
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_optin", data: JSON.stringify({ memberId: result.memberId }) },
        update: { state: "awaiting_optin", data: JSON.stringify({ memberId: result.memberId }) },
      });
      await sendText({
        to: phone,
        text:
          result.message +
          "\n\n" +
          "📱 *Message Consent*\n\n" +
          "Do you consent to receive messages from this cooperative? " +
          "This includes savings alerts, loan updates, and important notices.\n\n" +
          "Reply *YES* to opt-in or *NO* to skip.",
      });

      // Auto-notify new member of active elections they can participate in
      if (result.ok && result.memberId) {
        const newMember = await prisma.member.findUnique({ where: { id: result.memberId } });
        if (newMember) {
          const activeElections = await getActiveElectionsForNewMember(newMember.cooperativeId, newMember.unitId);
          if (activeElections.length > 0) {
            const electionLines = activeElections.map((e, i) => {
              const typeTag = e.electionType === "workplace" || e.kind === "unit" ? "🏢" : "🏛️";
              const pos = e.position ? ` — ${e.position}` : "";
              return `${i + 1}. ${typeTag} ${e.title}${pos} — reply *vote ${e.id.slice(-6)} <candidate code>*`;
            });
            await sendText({
              to: phone,
              text:
                `🗳️ Active elections you can vote in:\n\n` +
                `${electionLines.join("\n")}\n\n` +
                `View results with *pollresults <election id>*.`,
            });
          }
        }
      }
      break;
    }

    case "awaiting_save_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({ to: phone, text: "That doesn't look like a valid amount. Try *save 5000* or *save 10000*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_save_confirm", data: JSON.stringify({ ...data, saveAmount: amount }) },
        update: { state: "awaiting_save_confirm", data: JSON.stringify({ ...data, saveAmount: amount }) },
      });
      await sendText({
        to: phone,
        text: `You're about to save ${formatBalance(amount)}. Reply *yes* to confirm or *menu* to cancel.`,
      });
      break;
    }

    case "awaiting_save_confirm": {
      const answer = text.trim().toLowerCase();
      if (answer === "yes" || answer === "y") {
        const saveAmount = data.saveAmount;
        if (!saveAmount) {
          await sendText({ to: phone, text: "Something went wrong. Reply *save <amount>* to try again." });
          await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
          return;
        }
        const result = await createContribution(phone, saveAmount);
        await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
        await sendText({ to: phone, text: result.message + "\n\nReply *menu* to see other options." });
      } else {
        await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
        await sendText({ to: phone, text: "Save cancelled. Reply *menu* to see options." });
      }
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
        await sendText({ to: phone, text: "Account numbers are 10 digits. Try *0123456789*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_loan_bank_code", data: JSON.stringify({ ...data, loanAccount: account }) },
        update: { state: "awaiting_loan_bank_code", data: JSON.stringify({ ...data, loanAccount: account }) },
      });
      await sendText({
        to: phone,
        text: `Which bank?\n\n• *Access* • *GTB* • *Zenith* • *UBA* • *First Bank*\n• *Kuda* • *Opay* • *PalmPay* • *Moniepoint* • *Wema*\n• *Fidelity* • *FCMB* • *Stanbic* • *Sterling* • *Union*\n\nReply with bank name or 5-digit bank code.`,
      });
      break;
    }

    case "awaiting_loan_bank_code": {
      const bank = resolveBankCode(text);
      if (!bank) {
        await sendText({
          to: phone,
          text: `We don't recognise that bank. Try *Access*, *GTB*, *Zenith*, *UBA*, *First Bank*, *Kuda*, or reply with the 5-digit bank code.`,
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_loan_bank_confirm", data: JSON.stringify({ ...data, loanBankCode: bank.code, loanBankName: bank.name }) },
        update: { state: "awaiting_loan_bank_confirm", data: JSON.stringify({ ...data, loanBankCode: bank.code, loanBankName: bank.name }) },
      });
      await sendText({ to: phone, text: `You selected *${bank.name}*. Is this correct? Reply *yes* or *no*.` });
      break;
    }

    case "awaiting_loan_bank_confirm": {
      const answer = text.trim().toLowerCase();
      if (answer !== "yes" && answer !== "y") {
        await sendText({
          to: phone,
          text: `Which bank?\n\n• *Access* • *GTB* • *Zenith* • *UBA* • *First Bank*\n• *Kuda* • *Opay* • *PalmPay* • *Moniepoint* • *Wema*\n• *Fidelity* • *FCMB* • *Stanbic* • *Sterling* • *Union*\n\nReply with bank name or 5-digit bank code.`,
        });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_loan_bank_code", data: JSON.stringify(data) },
          update: { state: "awaiting_loan_bank_code", data: JSON.stringify(data) },
        });
        return;
      }
      const result = await applyForLoan(phone, data.loanAmount ?? 0, data.loanMonths ?? 1, {
        accountNumber: data.loanAccount ?? "",
        bankCode: data.loanBankCode ?? "",
        bankName: data.loanBankName ?? "",
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
        await sendText({ to: phone, text: "That doesn't look like a valid amount. Try *withdraw 5000* or *withdraw 10000*." });
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
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_withdraw_pin", data, msg);
        return;
      }
      const bank =
        data.withdrawAccount && data.withdrawBankCode
          ? { accountNumber: data.withdrawAccount, bankCode: data.withdrawBankCode, bankName: data.withdrawBankName }
          : undefined;
      const result = await requestWithdrawal(phone, data.withdrawAmount ?? 0, bank);
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: result.message + "\n\nReply *menu* to see other options." });
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

    case "awaiting_delete_account_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle", data: "{}" } });
        await sendText({ to: phone, text: "Account deletion cancelled. Reply *menu* to start something else." });
        return;
      }
      const { handleDeleteAccountPin } = await import("./admin-actions.js");
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle", data: "{}" } });
      await handleDeleteAccountPin(phone, input);
      break;
    }

    case "awaiting_optin": {
      const answer = text.trim().toLowerCase();
      const memberId = data.memberId as string | undefined;
      if (memberId) {
        if (answer === "yes" || answer === "y") {
          await prisma.member.update({
            where: { id: memberId },
            data: { optedOut: false, consentAt: new Date() },
          });
          await prisma.dataConsent.create({
            data: {
              memberId,
              consentType: "registration",
              granted: true,
            },
          });
          await sendText({ to: phone, text: "✅ You're all set! You'll receive messages from your cooperative. Reply *menu* to see your options." });
        } else {
          await prisma.member.update({
            where: { id: memberId },
            data: { optedOut: true },
          });
          await sendText({ to: phone, text: "You've been opted out of messages. Reply *optin* at any time to re-enable." });
        }
      }
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle", data: "{}" }, update: { state: "idle", data: "{}" } });
      break;
    }

    case "awaiting_ai_confirm": {
      const answer = text.trim().toLowerCase();
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle", data: "{}" } });
      if (answer === "yes" || answer === "1" || answer === "ok") {
        const proposed = [data.aiCommand, ...(data.aiArgs ?? [])].filter(Boolean).join(" ");
        const { handleMessage } = await import("../conversation.js");
        await handleMessage(phone, proposed);
        return;
      }
      await sendText({ to: phone, text: "Okay, cancelled. Reply *menu* to see your options." });
      break;
    }

    case "awaiting_ai_query_confirm": {
      const answer = text.trim().toLowerCase();
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle", data: "{}" } });
      if (answer === "yes" || answer === "1" || answer === "ok") {
        await sendText({ to: phone, text: "Great! Reply *menu* to see your options, or ask me anything else." });
      } else if (answer === "no" || answer === "0") {
        await sendText({ to: phone, text: "Got it. Reply *menu* to see your options, or try asking differently." });
      } else {
        await sendText({ to: phone, text: "Reply *menu* to see your options." });
      }
      break;
    }

    case "awaiting_onboard_name": {
      const coopName = text.trim().replace(/\s+/g, " ");
      if (!coopName || coopName.length < 3) {
        await sendText({ to: phone, text: "Please enter your cooperative name (at least 3 characters)." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_onboard_code", data: JSON.stringify({ coopName }) },
        update: { state: "awaiting_onboard_code", data: JSON.stringify({ coopName }) },
      });
      await sendText({
        to: phone,
        text: `Great — *${coopName}*!\n\nNow choose a short code for your cooperative (e.g. *LAG01*). This is what members will use to join.`,
      });
      break;
    }

    case "awaiting_onboard_code": {
      const code = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!code || code.length < 3 || code.length > 10) {
        await sendText({ to: phone, text: "Code should be 3-10 characters (letters and numbers only), e.g. *LAG01*." });
        return;
      }
      const existing = await prisma.cooperative.findUnique({ where: { code } });
      if (existing) {
        await sendText({ to: phone, text: `Code *${code}* is already taken. Choose another.` });
        return;
      }
      const prevData1 = safeParse(dataJson);
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_onboard_state", data: JSON.stringify({ ...prevData1, coopCode: code }) },
        update: { state: "awaiting_onboard_state", data: JSON.stringify({ ...prevData1, coopCode: code }) },
      });
      await sendText({
        to: phone,
        text: `Code *${code}* is available ✅\n\nWhich state is your cooperative in? (e.g. *Lagos*, *Abuja*) Reply *skip* to skip.`,
      });
      break;
    }

    case "awaiting_onboard_state": {
      const state = text.trim();
      const stateValue = state.toLowerCase() === "skip" ? null : state;
      const prevData2 = safeParse(dataJson);
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_onboard_phone", data: JSON.stringify({ ...prevData2, coopState: stateValue }) },
        update: { state: "awaiting_onboard_phone", data: JSON.stringify({ ...prevData2, coopState: stateValue }) },
      });
      await sendText({
        to: phone,
        text: `Almost done! What's your *phone number*? (e.g. *08012345678*) This will be the admin account for your cooperative.`,
      });
      break;
    }

    case "awaiting_onboard_phone": {
      const adminPhone = normalizePhone(text);
      if (!adminPhone) {
        await sendText({ to: phone, text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*." });
        return;
      }
      const prevData3 = safeParse(dataJson) as any;
      const coopNameVal = prevData3.name ?? prevData3.coopName ?? "";
      const coopCodeVal = prevData3.coopCode ?? "";
      const coopStateVal = prevData3.coopState ?? null;

      // Create the cooperative
      const coop = await createCooperative({
        name: coopNameVal,
        code: coopCodeVal,
        adminPhone,
        state: coopStateVal,
      });

      // Create default config, branding, and subscription
      await prisma.cooperativeConfig.create({
        data: { cooperativeId: coop.id },
      });
      await prisma.brandingConfig.create({
        data: { cooperativeId: coop.id, displayName: coopNameVal },
      });
      await prisma.subscription.create({
        data: { cooperativeId: coop.id },
      });

      // Create the admin member
      let memberCode = generateMemberCode();
      while (await prisma.member.findUnique({ where: { code: memberCode } })) {
        memberCode = generateMemberCode();
      }

      // NOTE: Admin PIN is sent in plaintext over WhatsApp.
      // This is acceptable due to WhatsApp's end-to-end encryption, but the admin
      // should change their PIN immediately after onboarding (setpin command).
      const adminPin = String(randomInt(1000, 9000));
      const member = await prisma.member.create({
        data: {
          phone,
          contactPhone: adminPhone,
          name: `${coopNameVal} Admin`,
          code: memberCode,
          pin: hashPin(adminPin),
          cooperativeId: coop.id,
          role: "superadmin",
          wallet: { create: {} },
        },
      });

      // Link the admin phone to this member if different
      if (phone !== adminPhone) {
        const adminMemberCode = generateMemberCode();
        while (await prisma.member.findUnique({ where: { code: adminMemberCode } })) {
          // regenerate
        }
        // No second member needed — adminPhone is just a contact number on the Cooperative model
      }

      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle", data: "{}" },
        update: { state: "idle", data: "{}" },
      });

      await sendText({
        to: phone,
        text:
          `🏦 *${coopNameVal}* is live!\n\n` +
          `Your cooperative code: *${coopCodeVal}*\n` +
          `Your role: *superadmin*\n` +
          `Your member code: *${memberCode}*\n` +
          `Your temporary PIN: *${adminPin}*\n\n` +
          `⚠️ *Change your PIN immediately* by replying: *setpin ${adminPin} <new pin>*\n\n` +
          `Members can join by sending: *join ${coopCodeVal}*\n\n` +
          `Reply *menu* to see all admin commands.`,
      });
      break;
    }

    default:
      await prisma.session.upsert({ where: { phone }, create: { phone, state: "idle" }, update: { state: "idle" } });
      await sendText({ to: phone, text: buildMenu(null) });
  }
}
