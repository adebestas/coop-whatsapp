import { prisma } from "../lib/prisma.js";
import { getMemberByPhone } from "./cooperative.js";
import { periodOf } from "./deductions.js";

export const DEFAULT_CREDIT_MULTIPLIER = 3;

export function commoditySchemesEnabled(): boolean {
  return process.env.COMMODITY_SCHEMES_ENABLED === "1";
}

export function creditMultiplier(): number {
  const raw = Number(process.env.COMMODITY_CREDIT_MULTIPLIER ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CREDIT_MULTIPLIER;
}

export interface CommodityCreditPosition {
  expectedKobo: number;
  multiplier: number;
  capKobo: number;
  committedKobo: number;
  availableKobo: number;
  blockedReason: string | null;
}

export async function getCommodityCreditPosition(
  phone: string,
): Promise<CommodityCreditPosition | null> {
  const member = await getMemberByPhone(phone);
  if (!member) return null;
  return getCreditPositionForMember(member.id, member.cooperativeId);
}

export async function getCreditPositionForMember(
  memberId: string,
  cooperativeId: string,
): Promise<CommodityCreditPosition> {
  const multiplier = creditMultiplier();
  const period = periodOf(new Date());
  const batches = await prisma.deductionBatch.findMany({
    where: {
      cooperativeId,
      sourceFileKey: { not: null },
      status: { in: ["draft", "submitted", "cheque_received"] },
    },
    include: {
      items: { where: { memberId, kind: "savings", status: "pending" } },
    },
    orderBy: { createdAt: "desc" },
  });
  const current = batches.find((b) => b.ref.startsWith(`DED-${period}-`)) ?? batches[0];
  const expectedKobo = current?.items.reduce((sum, i) => sum + i.amount, 0) ?? 0;
  const capKobo = Math.round(expectedKobo * multiplier);

  const commodityLoans = await prisma.loan.findMany({
    where: { cooperativeId, memberId, kind: "commodity", status: "disbursed", balance: { gt: 0 } },
    select: { balance: true },
  });
  const reservations = await prisma.commoditySubscription.findMany({
    where: { cooperativeId, memberId, status: { in: ["reserved", "approved"] } },
    select: { totalKobo: true },
  });
  const committedKobo =
    commodityLoans.reduce((sum, l) => sum + l.balance, 0) +
    reservations.reduce((sum, s) => sum + s.totalKobo, 0);

  const openShortfall = await prisma.deductionShortfall.findFirst({
    where: { cooperativeId, memberId, status: "open" },
    select: { id: true },
  });

  let blockedReason: string | null = null;
  if (!commoditySchemesEnabled()) {
    blockedReason = "Commodity schemes are not enabled.";
  } else if (openShortfall) {
    blockedReason =
      "Your payroll remittance came up short and the open shortfall is still unpaid. Settle it before using commodity credit.";
  } else if (expectedKobo === 0) {
    blockedReason = "No payroll schedule has been uploaded for you this month.";
  }

  return {
    expectedKobo,
    multiplier,
    capKobo,
    committedKobo,
    availableKobo: blockedReason ? 0 : Math.max(0, capKobo - committedKobo),
    blockedReason,
  };
}
