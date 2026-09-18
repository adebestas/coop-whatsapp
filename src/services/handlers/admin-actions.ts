import { prisma } from "../../lib/prisma.js";
import { sendText } from "../../lib/messaging.js";
import { normalizePhone } from "../../lib/phones.js";
import { getMemberByPhone, formatBalance } from "../cooperative.js";
import { showLedger, showHistory, getMonthlyStatement, getYearlyStatement } from "../statements.js";
import { confirmGuarantee } from "../guarantors.js";
import { createTicket, listTickets, resolveTicket } from "../support.js";
import { listPosts } from "../posts.js";
import { myDeduction, requestMonthWaiver } from "../deductions.js";
import { validateClaim, confirmFamily } from "../deathclaims.js";
import { generateContextualHelp } from "../../lib/ai-support.js";
import { verifyMemberPin } from "../pin.js";
import { issueSecretChallenge } from "./session.js";

export async function handleValidateClaim(phone: string, args: string[]): Promise<void> {
  const code = args[0];
  if (!code) {
    await sendText({ to: phone, text: "To validate a death claim, reply *validate <claim id>* with the id you received." });
    return;
  }
  const result = await validateClaim(phone, code);
  await sendText({ to: phone, text: result.message });
}

export async function handleConfirmClaim(phone: string, args: string[]): Promise<void> {
  const claimCode = args[0];
  const code = args[1];
  if (!claimCode || !code) {
    await sendText({ to: phone, text: "Usage: *confirmclaim <claim id> <code>* — the code was sent to your phone via SMS." });
    return;
  }
  const result = await confirmFamily(phone, claimCode, code);
  await sendText({ to: phone, text: result.message });
}

export async function handleConfirm(phone: string, args: string[]): Promise<void> {
  const code = args[0];
  if (!code) {
    await sendText({ to: phone, text: "To accept a guarantor request, reply *confirm <code>* with the code you received." });
    return;
  }
  const result = await confirmGuarantee(phone, code);
  await sendText({ to: phone, text: result.message });
}

export async function handleCode(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  await sendText({
    to: phone,
    text: `Your member code is *${member.code}*. Share it with members who want you as a guarantor.`,
  });
}

export async function handlePhone(phone: string, args: string[], cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
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

export async function handleSupport(phone: string, text: string): Promise<void> {
  const message = text.trim().replace(/^\s*support\s*/i, "");
  if (message.length < 10) {
    await sendText({ to: phone, text: "Please describe your issue in at least 10 characters. Try *support <your message>*." });
    return;
  }
  const result = await createTicket(phone, message);
  await sendText({ to: phone, text: result.message });
}

export async function handleLedger(phone: string): Promise<void> {
  const result = await showLedger(phone);
  await sendText({ to: phone, text: result.message });
}

export async function handleHistory(phone: string): Promise<void> {
  const result = await showHistory(phone);
  await sendText({ to: phone, text: result.message });
}

export async function handleStatement(phone: string, args: string[]): Promise<void> {
  const text = args.join(" ").trim().toLowerCase();
  const bareYear = /^\d{4}$/.test(text) ? parseInt(text, 10) : NaN;

  if (text.startsWith("yearly") || (!Number.isNaN(bareYear) && bareYear >= 2000 && bareYear <= 2100)) {
    let year: number;
    if (!Number.isNaN(bareYear)) {
      year = bareYear;
    } else {
      const yearStr = text.replace("yearly", "").trim();
      year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
    }
    const result = await getYearlyStatement(phone, year);
    await sendText({ to: phone, text: result.message });
    return;
  }

  if (!text) {
    const now = new Date();
    const monthName = now.toLocaleString("en-GB", { month: "long" });
    const result = await getMonthlyStatement(phone, `${monthName} ${now.getFullYear()}`);
    await sendText({ to: phone, text: result.message });
    return;
  }

  const result = await getMonthlyStatement(phone, text);
  await sendText({ to: phone, text: result.message });
}

export async function handlePosts(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  await sendText({ to: phone, text: await listPosts(member.cooperativeId) });
}

export async function handleMyDeduction(phone: string, cooperativeId?: string): Promise<void> {
  const result = await myDeduction(phone, cooperativeId);
  await sendText({ to: phone, text: result.message });
}

export async function handleSkipMonth(phone: string, cooperativeId?: string): Promise<void> {
  const result = await requestMonthWaiver(phone, cooperativeId);
  await sendText({ to: phone, text: result.message });
}

export async function handleTickets(phone: string): Promise<void> {
  const result = await listTickets(phone);
  await sendText({ to: phone, text: result.message });
}

export async function handleResolve(phone: string, args: string[], cooperativeId?: string): Promise<void> {
  const id = args[0];
  const note = args.slice(1).join(" ");
  if (!id) {
    await sendText({ to: phone, text: "Usage: *resolve <ticket or grievance id> <response>*" });
    return;
  }

  // Only admins can resolve grievances, and only within their own cooperative.
  // (Mirrors resolveTicket's cross-tenant protection in support.ts.)
  const candidate = await getMemberByPhone(phone, cooperativeId);
  const adminMember =
    candidate && (candidate.role === "admin" || candidate.role === "superadmin") ? candidate : null;
  if (adminMember) {
    const grievance = await prisma.grievance.findFirst({
      where: {
        OR: [{ id }, { id: { endsWith: id } }],
        status: "open",
        cooperativeId: adminMember.cooperativeId,
      },
    });
    if (grievance) {
      if (!note) {
        await sendText({ to: phone, text: "Usage: *resolve <grievance id> <response>*" });
        return;
      }
      await prisma.grievance.update({
        where: { id: grievance.id },
        data: { status: "resolved", response: note, resolvedById: adminMember.id, resolvedAt: new Date() },
      });
      await sendText({ to: phone, text: `✅ Grievance *${grievance.id.slice(-6)}* resolved.` });
      return;
    }
  }

  // Fall back to support ticket resolution
  const result = await resolveTicket(phone, id, note);
  await sendText({ to: phone, text: result.message });
}

export async function handleInsights(phone: string, member: { role: string; cooperativeId: string } | null): Promise<void> {
  if (!member || (member.role !== "admin" && member.role !== "superadmin")) {
    await sendText({ to: phone, text: "Only admins can view financial insights." });
    return;
  }
  const { generateFinancialInsights } = await import("../../lib/ai-insights.js");
  const insights = await generateFinancialInsights(member.cooperativeId);
  await sendText({ to: phone, text: insights });
}

export async function handleContextHelp(phone: string, member: { id: string } | null): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "Please register first. Reply *join <code>* to get started." });
    return;
  }
  const helpText = await generateContextualHelp(member.id);
  await sendText({ to: phone, text: helpText });
}

export async function handleRisk(phone: string, member: { role: string; cooperativeId: string } | null): Promise<void> {
  if (!member || (member.role !== "admin" && member.role !== "superadmin")) {
    await sendText({ to: phone, text: "Only admins can view risk assessments." });
    return;
  }
  const { generateLoanRiskAssessment } = await import("../../lib/ai-insights.js");
  const risk = await generateLoanRiskAssessment(member.cooperativeId);
  await sendText({ to: phone, text: risk });
}

export async function handleDeleteAccount(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  if (!member.pin) {
    await sendText({ to: phone, text: "No PIN set on your account. Please contact your cooperative admin to delete your account." });
    return;
  }
  await issueSecretChallenge(
    phone,
    "awaiting_delete_account_pin",
    {},
    "Enter your 4-digit PIN to confirm account deletion. This action cannot be undone.",
  );
}

export async function handleResetPin(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  if (!member.pin) {
    await sendText({ to: phone, text: "No PIN set on your account. Please contact your cooperative admin to reset your PIN." });
    return;
  }
  // Check rate limit for PIN reset requests (max 3 per 10 minutes per phone)
  const { checkOtpRateLimit } = await import("../../lib/cache.js");
  const rateLimit = await checkOtpRateLimit(phone);
  if (!rateLimit.allowed) {
    await sendText({ to: phone, text: rateLimit.message ?? "Too many PIN reset requests. Please wait before trying again." });
    return;
  }

  // Generate a 6-digit reset code
  const { generatePinResetCode, hashPinResetCode } = await import("../../lib/security.js");
  const resetCode = generatePinResetCode();
  const hashedCode = hashPinResetCode(resetCode);

  // Store the hashed code in the session
  const { prisma } = await import("../../lib/prisma.js");
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_reset_pin", data: JSON.stringify({ resetCode: hashedCode }) },
    update: { state: "awaiting_reset_pin", data: JSON.stringify({ resetCode: hashedCode }) },
  });

  // Send the code via WhatsApp/Telegram (in production, send via secure channel)
  // For now, we'll include it in the message (in production, this should be sent via a secure channel)
  await sendText({
    to: phone,
    text: `🔐 *PIN Reset Request*\n\nYour reset code is: *${resetCode}*\n\nThis code expires in 15 minutes and can only be used once.\n\nReply with the code to proceed with PIN reset.\n\n_For security, never share this code with anyone._`,
  });
}

export async function handleResetPinCode(phone: string, code: string, _cooperativeId?: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { phone } });
  if (!session || session.state !== "awaiting_reset_pin") {
    await sendText({ to: phone, text: "No active PIN reset request found. Reply *resetpin* to start a new one." });
    return;
  }

  const data = JSON.parse(session.data);
  if (!data.resetCode) {
    await sendText({ to: phone, text: "Invalid reset session. Please try again." });
    await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
    return;
  }

  const { verifyPinResetCode } = await import("../../lib/security.js");
  if (!verifyPinResetCode(code, data.resetCode)) {
    await sendText({ to: phone, text: "Invalid or expired reset code. Please try again or request a new one." });
    return;
  }

  // Code is valid - delete it (single-use) and prompt for new PIN
  await prisma.session.update({
    where: { phone },
    data: { state: "awaiting_new_pin", data: "{}" },
  });

  await sendText({
    to: phone,
    text: "✅ Code verified! Now enter your new 4-digit PIN.",
  });
}

export async function handleNewPin(phone: string, newPin: string, cooperativeId?: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { phone } });
  if (!session || session.state !== "awaiting_new_pin") {
    await sendText({ to: phone, text: "No active PIN reset session. Reply *resetpin* to start over." });
    return;
  }

  // Validate PIN format (4 digits)
  if (!/^\d{4}$/.test(newPin)) {
    await sendText({ to: phone, text: "PIN must be exactly 4 digits. Try again." });
    return;
  }

  const { hashPin } = await import("../../lib/security.js");
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "Member not found. Please try again." });
    return;
  }

  await prisma.member.update({
    where: { id: member.id },
    data: { pin: hashPin(newPin) },
  });

  await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });

  await sendText({ to: phone, text: "✅ PIN has been reset successfully. You can now use your new PIN for transactions." });
}

export async function handleDeleteAccountPin(phone: string, pin: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "Account not found." });
    return;
  }
  const pinCheck = await verifyMemberPin(member, pin);
  if (!pinCheck.ok) {
    await sendText({ to: phone, text: "Incorrect PIN. Account deletion cancelled. Reply *menu* to start again." });
    return;
  }

  // Anonymize personal data (retain transaction history for regulatory compliance)
  await prisma.member.update({
    where: { id: member.id },
    data: {
      name: "Deleted Member",
      phone: `deleted:${member.id}`,
      contactPhone: null,
      pin: null,
      bankAccountNumber: null,
      bankCode: null,
      bankName: null,
      bvn: null,
      email: null,
      nextOfKinName: null,
      nextOfKinPhone: null,
      dateOfBirth: null,
      status: "suspended",
    },
  });

  // Log the deletion in DataConsent table
  await prisma.dataConsent.create({
    data: {
      memberId: member.id,
      consentType: "delete_account",
      granted: false,
    },
  });

  await sendText({
    to: phone,
    text: "Your account has been deleted and personal data erased. Transaction history is retained for regulatory compliance.",
  });
}

export async function handleMyData(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }

  const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
  const contributions = await prisma.contribution.findMany({
    where: { memberId: member.id, status: "confirmed" },
    select: { amount: true, type: true, paidAt: true },
  });
  const loans = await prisma.loan.findMany({
    where: { memberId: member.id },
    select: { amount: true, status: true, createdAt: true },
  });

  const totalSaved = wallet?.totalSaved ?? 0;
  const totalContributions = contributions.reduce((sum, c) => sum + c.amount, 0);
  const totalLoans = loans.reduce((sum, l) => sum + l.amount, 0);

  const lines = [
    `*Your Personal Data (NDPR Right of Access)*`,
    "",
    `*Name:* ${member.name}`,
    `*Phone:* ${member.phone}`,
    `*Email:* ${member.email ?? "not set"}`,
    `*Bank Account:* ${member.bankAccountNumber ?? "not set"}`,
    `*Bank:* ${member.bankName ?? "not set"}`,
    `*BVN:* ${member.bvn ? "***" + member.bvn.slice(-4) : "not set"}`,
    `*Next of Kin:* ${member.nextOfKinName ?? "not set"}`,
    "",
    `*Financial Summary*`,
    `*Current Balance:* ${formatBalance(wallet?.balance ?? 0)}`,
    `*Total Saved:* ${formatBalance(totalSaved)}`,
    `*Total Contributions:* ${contributions.length} transactions (${formatBalance(totalContributions)})`,
    `*Total Loans:* ${loans.length} loans (${formatBalance(totalLoans)})`,
    "",
    `*Consent Status:* ${member.dataConsentGiven ? "Consented" : "Not consented"}`,
    "",
    `_To delete your account and erase personal data, reply *deleteaccount*._`,
  ];

  await sendText({ to: phone, text: lines.join("\n") });
}
