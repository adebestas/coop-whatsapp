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

/** Accrue monthly interest on savings for cooperatives with a rate > 0. */
export async function runMonthlyInterest(now = new Date()): Promise<number> {
  const coops = await prisma.cooperative.findMany({ where: { interestRate: { gt: 0 } } });
  let credited = 0;

  for (const coop of coops) {
    // Only run on the 1st of the month.
    if (now.getDate() !== 1) continue;

    const wallets = await prisma.wallet.findMany({
      where: { member: { cooperativeId: coop.id, status: "active" } },
      include: { member: true },
    });

    for (const w of wallets) {
      if ((w.balance ?? 0) <= 0) continue;
      const interest = Math.round(w.balance * (coop.interestRate / 100) * 100) / 100;
      const reference = `INT-${coop.id.slice(-6)}-${w.memberId.slice(-6)}-${now.getFullYear()}-${now.getMonth() + 1}`;
      const exists = await prisma.contribution.findUnique({ where: { reference } });
      if (exists) continue;

      await prisma.$transaction([
        prisma.wallet.update({ where: { id: w.id }, data: { balance: { increment: interest } } }),
        prisma.contribution.create({
          data: {
            amount: interest,
            type: "interest",
            note: `Monthly interest at ${coop.interestRate}%`,
            reference,
            status: "confirmed",
            paidAt: now,
            memberId: w.memberId,
            cooperativeId: coop.id,
          },
        }),
      ]);
      credited++;
    }
  }
  return credited;
}

/** Set the cooperative's monthly interest rate (admin only). */
export async function setInterestRate(
  phone: string,
  rate: number,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  if (!admin) return { ok: false, message: "Only a cooperative admin can set the interest rate." };
  if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
    return { ok: false, message: "Monthly interest must be between 0 and 20%, e.g. *interest 1* for 1%." };
  }
  await prisma.cooperative.update({
    where: { id: admin.cooperativeId },
    data: { interestRate: rate },
  });
  return {
    ok: true,
    message: `Monthly interest rate set to *${rate}%*. Interest accrues on savings on the 1st of each month.`,
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