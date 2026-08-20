import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

/** Compute an instant dividend preview for any caller (real-time). */
export async function computeDividendPreview(phone: string, rate: number): Promise<{ ok: boolean; message: string }> {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return { ok: false, message: "Rate must be between 0 and 100, e.g. *dividend 5* for 5%." };
  }

  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true },
  });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  const entries = await prisma.member.findMany({
    where: { cooperativeId: member.cooperativeId },
    include: { wallet: true },
  });
  const totalSaved = entries.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  const pool = (totalSaved * rate) / 100;

  // Everyone's share is proportional to their lifetime savings.
  const mine = entries.find((m) => m.id === member.id);
  const myShare = mine && totalSaved > 0 ? (mine.wallet?.totalSaved ?? 0) * (rate / 100) : 0;

  const lines = [
    `*🎉 Dividend calculator (real-time)*`,
    ``,
    `Rate: *${rate}%* of lifetime savings`,
    `Coop total saved: ${formatBalance(totalSaved)}`,
    `Dividend pool: *${formatBalance(pool)}*`,
    ``,
    `Your share: *${formatBalance(myShare)}*`,
  ];

  if (entries.length <= 5) {
    lines.push(``, `*Shares:*`);
    for (const m of entries) {
      const share = totalSaved > 0 ? (m.wallet?.totalSaved ?? 0) * (rate / 100) : 0;
      lines.push(`• ${m.name} — ${formatBalance(share)}`);
    }
  }

  lines.push(``, `Admin: reply *paydividend ${rate}* to pay everyone now.`);
  return { ok: true, message: lines.join("\n") };
}

/** Admin distributes a dividend run — credits wallets proportionally. */
export async function distributeDividend(phone: string, rate: number): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  if (!admin) {
    return { ok: false, message: "Only a cooperative admin can pay dividends." };
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return { ok: false, message: "Rate must be between 0 and 100, e.g. *paydividend 5*." };
  }

  const members = await prisma.member.findMany({
    where: { cooperativeId: admin.cooperativeId },
    include: { wallet: true },
  });
  const totalSaved = members.reduce((sum, m) => sum + (m.wallet?.totalSaved ?? 0), 0);
  if (totalSaved <= 0 || members.length === 0) {
    return { ok: false, message: "No savings yet — nothing to distribute." };
  }

  const pool = (totalSaved * rate) / 100;
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
            amount: (m.wallet?.totalSaved ?? 0) * (rate / 100),
            status: "paid",
            paidAt: new Date(),
          })),
      },
    },
  });

  // Credit wallets + record a "dividend" contribution per member.
  for (const m of members) {
    const share = totalSaved > 0 ? (m.wallet?.totalSaved ?? 0) * (rate / 100) : 0;
    if (share <= 0) continue;
    await prisma.$transaction([
      prisma.wallet.update({ where: { id: m.wallet!.id }, data: { balance: { increment: share } } }),
      prisma.contribution.create({
        data: {
          amount: share,
          type: "dividend",
          note: `Dividend at ${rate}%`,
          reference: `DIV-${dividend.id.slice(-8)}-${m.id.slice(-6)}`,
          status: "confirmed",
          paidAt: new Date(),
          memberId: m.id,
          cooperativeId: admin.cooperativeId,
        },
      }),
    ]);
  }

  return {
    ok: true,
    message: `🎉 Dividend of *${formatBalance(pool)}* paid at ${rate}% to ${members.length} member(s).`,
  };
}