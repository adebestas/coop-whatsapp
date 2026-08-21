import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { showHistory } from "./statements.js";

/**
 * Background jobs: recurring contribution reminders + monthly interest on
 * savings. Both are exported separately so tests can run them directly.
 */

/** Set up (or turn off) a recurring contribution plan. */
export async function setAutoSave(
  phone: string,
  amount: number | null,
  interval?: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  if (amount === null || (interval !== "weekly" && interval !== "monthly")) {
    // "plan off" or invalid -> disable.
    await prisma.member.update({
      where: { id: member.id },
      data: { autoSaveEnabled: false, autoSaveAmount: null, autoSaveInterval: null, autoSaveNextDue: null },
    });
    return { ok: true, message: "Your recurring contribution plan is turned off." };
  }

  const nextDue = new Date();
  nextDue.setDate(nextDue.getDate() + (interval === "weekly" ? 7 : 30));

  await prisma.member.update({
    where: { id: member.id },
    data: {
      autoSaveAmount: amount,
      autoSaveInterval: interval,
      autoSaveNextDue: nextDue,
      autoSaveEnabled: true,
    },
  });
  return {
    ok: true,
    message: `Recurring contribution set: *${formatBalance(amount)}* every ${interval}. You'll get a nudge when it's due — just reply *save ${amount}* to pay.`,
  };
}

/** Send reminders to members whose recurring contribution is due now. */
export async function runAutoSaveReminders(now = new Date()): Promise<number> {
  const due = await prisma.member.findMany({
    where: { autoSaveEnabled: true, autoSaveNextDue: { lte: now } },
  });
  let sent = 0;
  for (const m of due) {
    const interval = m.autoSaveInterval === "weekly" ? "week" : "month";
    await sendText({
      to: m.phone,
      text: `⏰ Time to save! Your *${interval}ly* contribution of *${formatBalance(m.autoSaveAmount ?? 0)}* is due.\n\nReply *save ${m.autoSaveAmount}* to pay now.`,
    });
    // Schedule the next one so we don't nag every few minutes.
    const next = new Date(m.autoSaveNextDue!);
    next.setDate(next.getDate() + (m.autoSaveInterval === "weekly" ? 7 : 30));
    await prisma.member.update({
      where: { id: m.id },
      data: { autoSaveNextDue: next },
    });
    sent++;
  }
  return sent;
}

/** Set the cooperative's monthly loan interest rate (admin only). */
export async function setInterestRate(
  phone: string,
  rate: number,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: { in: ["admin", "superadmin"] } } });
  if (!admin) return { ok: false, message: "Only a cooperative admin can set the interest rate." };
  if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
    return { ok: false, message: "Monthly loan interest must be between 0 and 20%, e.g. *interest 2* for 2%." };
  }
  await prisma.cooperative.update({
    where: { id: admin.cooperativeId },
    data: { loanInterestRate: rate },
  });
  return {
    ok: true,
    message: `Loan interest rate set to *${rate}%/month*. New loan applications will use this rate.`,
  };
}

/**
 * Send every active member their monthly statement on the 1st of the month.
 * Each member receives at most one statement per calendar month.
 */
export async function runMonthlyStatements(now = new Date()): Promise<number> {
  if (now.getDate() !== 1) return 0;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const members = await prisma.member.findMany({
    where: {
      status: "active",
      OR: [{ lastStatementSentAt: null }, { lastStatementSentAt: { lt: monthStart } }],
    },
    include: { cooperative: true },
  });

  let sent = 0;
  for (const m of members) {
    if (!m.phone) continue;
    const stmt = await showHistory(m.phone);
    if (!stmt.ok) continue;
    const text = `${stmt.message}\n\n_Generated ${now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })} — reply *menu* for options._`;
    await sendText({ to: m.phone, text }).catch(() => {});
    await prisma.member.update({ where: { id: m.id }, data: { lastStatementSentAt: now } });
    sent++;
  }
  return sent;
}

/** Send a birthday greeting to members whose birthday is today (once per year). */
export async function runBirthdayGreetings(now = new Date()): Promise<number> {
  const members = await prisma.member.findMany({
    where: {
      status: "active",
      dateOfBirth: { not: null },
      OR: [{ lastBirthdayGreetedYear: null }, { lastBirthdayGreetedYear: { not: now.getFullYear() } }],
    },
  });

  let sent = 0;
  for (const m of members) {
    if (!m.dateOfBirth) continue;
    if (m.dateOfBirth.getMonth() !== now.getMonth() || m.dateOfBirth.getDate() !== now.getDate()) continue;
    await sendText({
      to: m.phone,
      text: `🎂 *Happy Birthday, ${m.name}!* 🎉\n\nMay your new year be full of blessings and growth. Your cooperative family celebrates you today. 🥳`,
    }).catch(() => {});
    await prisma.member.update({
      where: { id: m.id },
      data: { lastBirthdayGreetedYear: now.getFullYear() },
    });
    sent++;
  }
  return sent;
}