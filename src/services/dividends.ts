import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { computePnl, recordLedger } from "./ledger.js";

/** Compute an instant dividend preview for any caller (real-time).
 *  Standard cooperative formula: a percentage of the accumulated NET PROFIT,
 *  shared proportionally to each member's lifetime savings. */
export async function computeDividendPreview(phone: string, rate: number): Promise<{ ok: boolean; message: string }> {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return { ok: false, message: "Rate must be between 0 and 100, e.g. *dividend 50* for 50% of profit." };
  }

  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true },
  });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  const pnl = await computePnl(member.cooperativeId);
  const entries = await prisma.member.findMany({
    where: { cooperativeId: member.cooperativeId },
    include: { wallet: true },
  });
  const totalSaved = entries.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  const pool = Math.max(0, pnl.netProfit) * (rate / 100);

  // Everyone's share is proportional to their lifetime savings.
  const mine = entries.find((m) => m.id === member.id);
  const myShare = mine && totalSaved > 0 ? ((mine.wallet?.totalSaved ?? 0) / totalSaved) * pool : 0;

  const lines = [
    `*🎉 Dividend calculator (real-time)*`,
    ``,
    `Coop net profit: ${formatBalance(pnl.netProfit)} (income ${formatBalance(pnl.totalIncome)} − expenses ${formatBalance(pnl.totalExpense)})`,
    `Rate: *${rate}% of profit*`,
    `Dividend pool: *${formatBalance(pool)}*`,
    ``,
    `Your share: *${formatBalance(myShare)}* (based on your savings share)`,
  ];

  if (entries.length <= 5 && pool > 0) {
    lines.push(``, `*Shares:*`);
    for (const m of entries) {
      const share = totalSaved > 0 ? ((m.wallet?.totalSaved ?? 0) / totalSaved) * pool : 0;
      lines.push(`• ${m.name} — ${formatBalance(share)}`);
    }
  }

  lines.push(``, `Super admin: reply *paydividend ${rate}* to pay everyone now.`);
  return { ok: true, message: lines.join("\n") };
}

/** Super admin distributes a dividend run — % of actual net profit. */
export async function distributeDividend(phone: string, rate: number): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
  if (!admin) {
    return { ok: false, message: "Only the super admin can pay dividends." };
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return { ok: false, message: "Rate must be between 0 and 100, e.g. *paydividend 50* pays 50% of profit." };
  }

  const pnl = await computePnl(admin.cooperativeId);
  if (pnl.netProfit <= 0) {
    return {
      ok: false,
      message:
        `There's no profit to share yet (net: ${formatBalance(pnl.netProfit)}).\n` +
        `Profit comes from loan interest, fines and admin charges, minus salaries and payments.`,
    };
  }

  const members = await prisma.member.findMany({
    where: { cooperativeId: admin.cooperativeId },
    include: { wallet: true },
  });
  const totalSaved = members.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  if (totalSaved <= 0 || members.length === 0) {
    return { ok: false, message: "No savings yet — nothing to distribute against." };
  }

  const pool = pnl.netProfit * (rate / 100);
  const reference = `DIV-${Date.now()}`;

  const dividend = await prisma.dividend.create({
    data: {
      cooperativeId: admin.cooperativeId,
      rate,
      totalPool: pool,
      reference,
      status: "distributed",
      distributedAt: new Date(),
      entries: {
        create: members
          .filter((m) => (m.wallet?.totalSaved ?? 0) > 0)
          .map((m) => ({
            memberId: m.id,
            amount: ((m.wallet?.totalSaved ?? 0) / totalSaved) * pool,
            status: "paid",
            paidAt: new Date(),
          })),
      },
    },
  });

  // Credit wallets + record the appropriation in the ledger.
  let paidCount = 0;
  for (const m of members) {
    const share = totalSaved > 0 ? ((m.wallet?.totalSaved ?? 0) / totalSaved) * pool : 0;
    if (share <= 0) continue;
    paidCount += 1;
    await prisma.$transaction([
      prisma.wallet.update({ where: { id: m.wallet!.id }, data: { balance: { increment: share } } }),
      prisma.contribution.create({
        data: {
          amount: share,
          type: "dividend",
          note: `Dividend at ${rate}% of profit (${reference})`,
          reference: `DIV-${dividend.id.slice(-8)}-${m.id.slice(-6)}`,
          status: "confirmed",
          paidAt: new Date(),
          memberId: m.id,
          cooperativeId: admin.cooperativeId,
        },
      }),
    ]);
  }

  await recordLedger({
    cooperativeId: admin.cooperativeId,
    type: "appropriation",
    category: "dividend",
    amount: pool,
    note: `Dividend at ${rate}% of net profit`,
    reference: dividend.id,
  });

  return {
    ok: true,
    message: `🎉 Dividend of *${formatBalance(pool)}* (${rate}% of the ${formatBalance(pnl.netProfit)} profit) shared among ${paidCount} member(s), proportional to savings.`,
  };
}