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
    select: { id: true, name: true, wallet: { select: { totalSaved: true, balance: true } } },
  });
  const totalSaved = entries.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  // pnl.netProfit is kobo; pool stays in kobo
  const pool = Math.max(0, Math.round(pnl.netProfit * (rate / 100)));

  // Calculate deductions in kobo
  const reserveAmount = Math.floor(pool * RESERVE_FUND_RATE);
  const educationAmount = Math.floor(pool * EDUCATION_FUND_RATE);
  const developmentAmount = Math.floor(pool * DEVELOPMENT_FUND_RATE);
  const totalDeductions = reserveAmount + educationAmount + developmentAmount;
  const memberPoolKobo = pool - totalDeductions;

  // Compute shares as kobo integers to avoid rounding drift
  const eligible = entries.filter((m) => (m.wallet?.totalSaved ?? 0) > 0);
  const rawShares = eligible.map((m) => ({
    memberId: m.id,
    name: m.name,
    raw: totalSaved > 0 ? (m.wallet?.totalSaved ?? 0) / totalSaved * memberPoolKobo : 0,
    kobo: 0,
    remainder: 0,
  }));
  for (const s of rawShares) {
    s.kobo = Math.floor(s.raw);
    s.remainder = s.raw - s.kobo;
  }
  let assigned = rawShares.reduce((sum, s) => sum + s.kobo, 0);
  let leftover = memberPoolKobo - assigned;
  // Distribute leftover kobo to members with largest fractional remainders
  rawShares.sort((a, b) => b.remainder - a.remainder);
  for (const s of rawShares) {
    if (leftover <= 0) break;
    s.kobo += 1;
    leftover -= 1;
  }

  const myRaw = rawShares.find((s) => s.memberId === member.id);
  const myShare = myRaw ? myRaw.kobo : 0;

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
    `Member pool: *${formatBalance(memberPoolKobo)}*`,
    ``,
    `Your share: *${formatBalance(myShare)}* (based on your savings share)`,
  ];

  if (entries.length <= 5 && pool > 0) {
    lines.push(``, `*Shares:*`);
    for (const m of entries) {
      const s = rawShares.find((r) => r.memberId === m.id);
      const share = s ? s.kobo : 0;
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
  if (rate > 25) {
    return { ok: false, message: "Dividend rate cannot exceed 25% per Nigerian Cooperative Societies Act." };
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
    select: { id: true, name: true, wallet: { select: { id: true, totalSaved: true } } },
  });
  const totalSaved = members.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  if (totalSaved <= 0 || members.length === 0) {
    return { ok: false, message: "No savings yet — nothing to distribute against." };
  }

  const pool = Math.max(0, Math.round(pnl.netProfit * (rate / 100)));
  const reference = `DIV-${Date.now()}`;

  // Calculate deductions in kobo
  const reserveAmount = Math.floor(pool * RESERVE_FUND_RATE);
  const educationAmount = Math.floor(pool * EDUCATION_FUND_RATE);
  const developmentAmount = Math.floor(pool * DEVELOPMENT_FUND_RATE);
  const totalDeductions = reserveAmount + educationAmount + developmentAmount;
  const memberPoolKobo = pool - totalDeductions;

  return prisma.$transaction(async (tx) => {
    // Create reserve allocation record
    await tx.reserveAllocation.create({
      data: {
        cooperativeId: admin.cooperativeId,
        amount: reserveAmount,
        source: "dividend_declaration",
        referenceId: reference,
        note: `20% statutory reserve from dividend at ${rate}% of net profit`,
      },
    });

    // Create education fund record
    await tx.educationFund.create({
      data: {
        cooperativeId: admin.cooperativeId,
        amount: educationAmount,
        source: "dividend_declaration",
        referenceId: reference,
        note: `2% education fund from dividend at ${rate}% of net profit`,
      },
    });

    // Create development fund record
    await tx.developmentFund.create({
      data: {
        cooperativeId: admin.cooperativeId,
        amount: developmentAmount,
        source: "dividend_declaration",
        referenceId: reference,
        note: `5% development fund from dividend at ${rate}% of net profit`,
      },
    });

    // Update cooperative fund balances
    await tx.cooperative.update({
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
      tx,
    });

    await recordLedger({
      cooperativeId: admin.cooperativeId,
      type: "appropriation",
      category: "dividend",
      amount: educationAmount,
      note: `2% education fund from dividend at ${rate}% of net profit`,
      reference,
      fundType: "education",
      tx,
    });

    await recordLedger({
      cooperativeId: admin.cooperativeId,
      type: "appropriation",
      category: "dividend",
      amount: developmentAmount,
      note: `5% development fund from dividend at ${rate}% of net profit`,
      reference,
      fundType: "development",
      tx,
    });

    // Compute shares as kobo integers with remainder distribution
    const eligible = members.filter((m) => (m.wallet?.totalSaved ?? 0) > 0);
    const rawShares = eligible.map((m) => ({
      member: m,
      raw: totalSaved > 0 ? (m.wallet?.totalSaved ?? 0) / totalSaved * memberPoolKobo : 0,
      kobo: 0,
      remainder: 0,
    }));
    for (const s of rawShares) {
      s.kobo = Math.floor(s.raw);
      s.remainder = s.raw - s.kobo;
    }
    let assigned = rawShares.reduce((sum, s) => sum + s.kobo, 0);
    let leftover = memberPoolKobo - assigned;
    rawShares.sort((a, b) => b.remainder - a.remainder);
    for (const s of rawShares) {
      if (leftover <= 0) break;
      s.kobo += 1;
      leftover -= 1;
    }

    // ATOMICITY: create all DividendEntry records with status "pending" first
    const dividend = await tx.dividend.create({
      data: {
        cooperativeId: admin.cooperativeId,
        rate,
        totalPool: memberPoolKobo,
        reference,
        status: "distributed",
        distributedAt: new Date(),
        entries: {
          create: rawShares.map((s) => ({
            memberId: s.member.id,
            amount: s.kobo,
            status: "pending" as const,
          })),
        },
      },
      include: { entries: true },
    });

    // Credit wallets and mark each entry as "paid" — batched in groups of 100
    let paidCount = 0;
    const entriesWithShares = rawShares.filter((s) => s.kobo > 0);
    for (let i = 0; i < entriesWithShares.length; i += 100) {
      const batch = entriesWithShares.slice(i, i + 100);
      for (const s of batch) {
        paidCount += 1;
        const entry = dividend.entries.find((e) => e.memberId === s.member.id);
        await tx.wallet.update({ where: { id: s.member.wallet!.id }, data: { balance: { increment: s.kobo } } });
        await tx.contribution.create({
          data: {
            amount: s.kobo,
            type: "dividend",
            note: `Dividend at ${rate}% of profit (${reference})`,
            reference: `DIV-${dividend.id.slice(-8)}-${s.member.id.slice(-6)}`,
            status: "confirmed",
            paidAt: new Date(),
            memberId: s.member.id,
            cooperativeId: admin.cooperativeId,
          },
        });
        if (entry) {
          await tx.dividendEntry.update({ where: { id: entry.id }, data: { status: "paid", paidAt: new Date() } });
        }
      }
    }

    await recordLedger({
      cooperativeId: admin.cooperativeId,
      type: "appropriation",
      category: "dividend",
      amount: memberPoolKobo,
      note: `Dividend at ${rate}% of net profit (after statutory deductions)`,
      reference: dividend.id,
      fundType: "operational",
      tx,
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
        `Member dividends: *${formatBalance(memberPoolKobo)}* shared among ${paidCount} member(s)\n\n` +
        `_Distributed proportional to savings._`,
    };
  });
}

/**
 * Resume a partial dividend distribution — credits any "pending" entries
 * that were interrupted. Idempotent: safe to call multiple times.
 */
export async function resumeDividendDistribution(
  dividendId: string,
): Promise<{ ok: boolean; message: string; paidCount: number; remainingCount: number }> {
  const dividend = await prisma.dividend.findUnique({
    where: { id: dividendId },
    include: { entries: { where: { status: "pending" }, include: { member: { include: { wallet: true } } } } },
  });
  if (!dividend) return { ok: false, message: "Dividend not found.", paidCount: 0, remainingCount: 0 };
  if (dividend.entries.length === 0) {
    return { ok: true, message: "All entries already paid.", paidCount: 0, remainingCount: 0 };
  }

  let paidCount = 0;
  // Batch entries in groups of 100 to reduce transaction overhead
  for (let i = 0; i < dividend.entries.length; i += 100) {
    const batch = dividend.entries.slice(i, i + 100);
    for (const entry of batch) {
      const wallet = entry.member?.wallet;
      if (!wallet) continue;
      const share = entry.amount;

      let paid = false;
      await prisma.$transaction(async (tx) => {
        const alreadyPaid = await tx.dividendEntry.findFirst({
          where: {
            dividendId: entry.dividendId,
            memberId: entry.memberId,
            status: "paid",
          },
        });
        if (alreadyPaid) return;

        await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: share } } });
        await tx.contribution.create({
          data: {
            amount: share,
            type: "dividend",
            note: `Dividend at ${dividend.rate}% of profit (${dividend.reference})`,
            reference: `DIV-${dividend.id.slice(-8)}-${entry.memberId.slice(-6)}`,
            status: "confirmed",
            paidAt: new Date(),
            memberId: entry.memberId,
            cooperativeId: dividend.cooperativeId,
          },
        });
        await tx.dividendEntry.update({ where: { id: entry.id }, data: { status: "paid", paidAt: new Date() } });
        paid = true;
      });
      if (paid) paidCount += 1;
    }
  }

  return {
    ok: true,
    message: `Resumed: ${paidCount} entry(ies) paid.`,
    paidCount,
    remainingCount: 0,
  };
}

/**
 * Get fund balances for a cooperative.
 *
 * NOTE: Reserve fund uses the denormalized `coop.reserveFundBalance` column
 * (incremented atomically during dividend distribution), while education and
 * development funds are aggregated from their respective transaction tables.
 * This hybrid approach can diverge if records are edited outside the normal
 * flow. A periodic reconciliation job should verify that the denormalized
 * balance matches the sum of allocation records.
 */
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

  // Reconciliation check: compare denormalized balance against actual allocation sum
  const reserveAggregate = await prisma.reserveAllocation.aggregate({
    where: { cooperativeId },
    _sum: { amount: true },
  });
  const reported = coop?.reserveFundBalance ?? 0;
  const actual = reserveAggregate._sum.amount ?? 0;
  if (Math.abs(reported - actual) > 1) {
    console.warn(`[compliance] Reserve fund divergence: reported ${reported}, actual ${actual}`);
  }

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
  const reserveAgg = await prisma.reserveAllocation.aggregate({ where: { cooperativeId }, _sum: { amount: true } });
  const balance = reserveAgg._sum.amount ?? 0;

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
