import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { computePnl, recordLedger } from "./ledger.js";

// Nigerian cooperative standard deduction rates
const RESERVE_FUND_RATE = 0.20; // 20%
const EDUCATION_FUND_RATE = 0.02; // 2%
const DEVELOPMENT_FUND_RATE = 0.05; // 5%

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

  // Calculate deductions
  const reserveAmount = Math.floor(pool * RESERVE_FUND_RATE);
  const educationAmount = Math.floor(pool * EDUCATION_FUND_RATE);
  const developmentAmount = Math.floor(pool * DEVELOPMENT_FUND_RATE);
  const totalDeductions = reserveAmount + educationAmount + developmentAmount;
  const memberPool = pool - totalDeductions;

  // Everyone's share is proportional to their lifetime savings.
  const mine = entries.find((m) => m.id === member.id);
  const myShare = mine && totalSaved > 0 ? ((mine.wallet?.totalSaved ?? 0) / totalSaved) * memberPool : 0;

  const lines = [
    `*🎉 Dividend calculator (real-time)*`,
    ``,
    `Coop net profit: ${formatBalance(pnl.netProfit)} (income ${formatBalance(pnl.totalIncome)} − expenses ${formatBalance(pnl.totalExpense)})`,
    `Rate: *${rate}% of profit*`,
    `Dividend pool: *${formatBalance(pool)}*`,
    ``,
    `*Statutory Deductions (Nigerian Cooperative Standard):*`,
    `• Reserve Fund (20%): *${formatBalance(reserveAmount)}*`,
    `• Education Fund (2%): *${formatBalance(educationAmount)}*`,
    `• Development Fund (5%): *${formatBalance(developmentAmount)}*`,
    `• Total deductions: *${formatBalance(totalDeductions)}*`,
    ``,
    `Member pool: *${formatBalance(memberPool)}*`,
    ``,
    `Your share: *${formatBalance(myShare)}* (based on your savings share)`,
  ];

  if (entries.length <= 5 && pool > 0) {
    lines.push(``, `*Shares:*`);
    for (const m of entries) {
      const share = totalSaved > 0 ? ((m.wallet?.totalSaved ?? 0) / totalSaved) * memberPool : 0;
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

  // Calculate deductions
  const reserveAmount = Math.floor(pool * RESERVE_FUND_RATE);
  const educationAmount = Math.floor(pool * EDUCATION_FUND_RATE);
  const developmentAmount = Math.floor(pool * DEVELOPMENT_FUND_RATE);
  const totalDeductions = reserveAmount + educationAmount + developmentAmount;
  const memberPool = pool - totalDeductions;

  // Create reserve allocation record
  await prisma.reserveAllocation.create({
    data: {
      cooperativeId: admin.cooperativeId,
      amount: reserveAmount,
      source: "dividend_declaration",
      referenceId: reference,
      note: `20% statutory reserve from dividend at ${rate}% of net profit`,
    },
  });

  // Create education fund record
  await prisma.educationFund.create({
    data: {
      cooperativeId: admin.cooperativeId,
      amount: educationAmount,
      source: "dividend_declaration",
      referenceId: reference,
      note: `2% education fund from dividend at ${rate}% of net profit`,
    },
  });

  // Create development fund record
  await prisma.developmentFund.create({
    data: {
      cooperativeId: admin.cooperativeId,
      amount: developmentAmount,
      source: "dividend_declaration",
      referenceId: reference,
      note: `5% development fund from dividend at ${rate}% of net profit`,
    },
  });

  // Update cooperative fund balances
  await prisma.cooperative.update({
    where: { id: admin.cooperativeId },
    data: {
      reserveFundBalance: { increment: reserveAmount },
    },
  });

  // Post ledger entries for all allocations
  await recordLedger({
    cooperativeId: admin.cooperativeId,
    type: "appropriation",
    category: "dividend",
    amount: reserveAmount,
    note: `20% statutory reserve from dividend at ${rate}% of net profit`,
    reference,
    fundType: "reserve",
  });

  await recordLedger({
    cooperativeId: admin.cooperativeId,
    type: "appropriation",
    category: "dividend",
    amount: educationAmount,
    note: `2% education fund from dividend at ${rate}% of net profit`,
    reference,
    fundType: "reserve",
  });

  await recordLedger({
    cooperativeId: admin.cooperativeId,
    type: "appropriation",
    category: "dividend",
    amount: developmentAmount,
    note: `5% development fund from dividend at ${rate}% of net profit`,
    reference,
    fundType: "reserve",
  });

  const dividend = await prisma.dividend.create({
    data: {
      cooperativeId: admin.cooperativeId,
      rate,
      totalPool: memberPool,
      reference,
      status: "distributed",
      distributedAt: new Date(),
      entries: {
        create: members
          .filter((m) => (m.wallet?.totalSaved ?? 0) > 0)
          .map((m) => ({
            memberId: m.id,
            amount: ((m.wallet?.totalSaved ?? 0) / totalSaved) * memberPool,
            status: "paid",
            paidAt: new Date(),
          })),
      },
    },
  });

  // Credit wallets + record the appropriation in the ledger.
  let paidCount = 0;
  for (const m of members) {
    const share = totalSaved > 0 ? ((m.wallet?.totalSaved ?? 0) / totalSaved) * memberPool : 0;
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
    amount: memberPool,
    note: `Dividend at ${rate}% of net profit (after statutory deductions)`,
    reference: dividend.id,
    fundType: "operational",
  });

  return {
    ok: true,
    message:
      `🎉 Dividend distributed!\n\n` +
      `Total profit pool: *${formatBalance(pool)}* (${rate}% of ${formatBalance(pnl.netProfit)})\n\n` +
      `*Statutory Deductions (Nigerian Cooperative Standard):*\n` +
      `• Reserve Fund (20%): *${formatBalance(reserveAmount)}*\n` +
      `• Education Fund (2%): *${formatBalance(educationAmount)}*\n` +
      `• Development Fund (5%): *${formatBalance(developmentAmount)}*\n` +
      `• Total deductions: *${formatBalance(totalDeductions)}*\n\n` +
      `Member dividends: *${formatBalance(memberPool)}* shared among ${paidCount} member(s)\n\n` +
      `_Distributed proportional to savings._`,
  };
}

/** Get fund balances for a cooperative */
export async function getFundBalances(cooperativeId: string): Promise<{
  reserve: number;
  education: number;
  development: number;
}> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  
  const [reserveTotal, educationTotal, developmentTotal] = await Promise.all([
    prisma.reserveAllocation.aggregate({ where: { cooperativeId }, _sum: { amount: true } }),
    prisma.educationFund.aggregate({ where: { cooperativeId }, _sum: { amount: true } }),
    prisma.developmentFund.aggregate({ where: { cooperativeId }, _sum: { amount: true } }),
  ]);

  return {
    reserve: coop?.reserveFundBalance ?? reserveTotal._sum.amount ?? 0,
    education: educationTotal._sum.amount ?? 0,
    development: developmentTotal._sum.amount ?? 0,
  };
}

/** Get reserve fund info for members */
export async function getReserveInfo(cooperativeId: string): Promise<{
  balance: number;
  thisQuarter: number;
  lastQuarter: number;
  growthPercent: number;
}> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  const balance = coop?.reserveFundBalance ?? 0;

  const now = new Date();
  const thisQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const lastQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 - 3, 1);

  const [thisQuarter, lastQuarter] = await Promise.all([
    prisma.reserveAllocation.aggregate({
      where: {
        cooperativeId,
        createdAt: { gte: thisQuarterStart },
      },
      _sum: { amount: true },
    }),
    prisma.reserveAllocation.aggregate({
      where: {
        cooperativeId,
        createdAt: { gte: lastQuarterStart, lt: thisQuarterStart },
      },
      _sum: { amount: true },
    }),
  ]);

  const thisQ = thisQuarter._sum.amount ?? 0;
  const lastQ = lastQuarter._sum.amount ?? 0;
  const growthPercent = lastQ > 0 ? Math.round(((thisQ - lastQ) / lastQ) * 100) : 0;

  return {
    balance,
    thisQuarter: thisQ,
    lastQuarter: lastQ,
    growthPercent,
  };
}
