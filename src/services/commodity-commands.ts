import { prisma } from "../lib/prisma.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { commoditySchemesEnabled, getCommodityCreditPosition } from "./commodity-credit.js";
import { listMemberSubscriptions, listSchemeSubscriptions } from "./commodity-schemes.js";
import type { SchemeItemInput } from "./commodity-schemes.js";

export const COMMODITY_DISABLED = "Commodity schemes are not enabled on this deployment yet.";

export function parseSchemeItem(raw: string): SchemeItemInput | null {
  const body = raw.replace(/^\/?\s*addschemeitem\s+\S+\s*/i, "").replace(/^\|\s*/, "");
  const parts = body.split("|").map((p) => p.trim());
  if (parts.length < 6) return null;
  const [name, unitLabel, cost, price, units, max] = parts;
  const costNaira = Number(cost.replace(/,/g, ""));
  const priceNaira = Number(price.replace(/,/g, ""));
  const maxQty = Number(max.replace(/,/g, ""));
  if (!name || !Number.isFinite(costNaira) || !Number.isFinite(priceNaira)) return null;
  if (!Number.isFinite(maxQty) || maxQty < 1) return null;
  const totalUnits = units === "-" || units === "" ? null : Number(units.replace(/,/g, ""));
  if (totalUnits !== null && (!Number.isFinite(totalUnits) || totalUnits < 1)) return null;
  return {
    name,
    unitLabel: unitLabel || "unit",
    unitCostKobo: Math.round(costNaira * 100),
    memberPriceKobo: Math.round(priceNaira * 100),
    totalUnits,
    maxQtyPerMember: Math.floor(maxQty),
  };
}

export function parseNaira(raw: string): number | null {
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

export async function formatSchemesText(phone: string): Promise<string> {
  if (!commoditySchemesEnabled()) return COMMODITY_DISABLED;
  const member = await getMemberByPhone(phone);
  if (!member) return "Join a cooperative first.";
  const schemes = await prisma.commodityScheme.findMany({
    where: { cooperativeId: member.cooperativeId, status: "open" },
    include: { items: true },
    orderBy: { closesAt: "asc" },
  });
  if (schemes.length === 0) return "No commodity schemes are open right now.";
  const position = await getCommodityCreditPosition(phone);
  const lines = [
    "📦 *Open commodity schemes*",
    `Your credit: *${formatBalance(position?.availableKobo ?? 0)}*${position?.blockedReason ? ` - ${position.blockedReason}` : ""}`,
    "",
  ];
  for (const scheme of schemes) {
    lines.push(
      `*${scheme.name}* (${scheme.reference}) - closes ${scheme.closesAt.toISOString().slice(0, 10)}`,
    );
    for (const item of scheme.items) {
      lines.push(
        ` • ${item.name} (${item.unitLabel}): ${formatBalance(item.memberPriceKobo)} - max ${item.maxQtyPerMember}`,
      );
    }
    lines.push(` Reply: *subscribe ${scheme.reference} <item> <qty> 3*`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function formatMySubsText(phone: string): Promise<string> {
  if (!commoditySchemesEnabled()) return COMMODITY_DISABLED;
  const member = await getMemberByPhone(phone);
  if (!member) return "Join a cooperative first.";
  const subs = await listMemberSubscriptions(member.id, member.cooperativeId);
  if (subs.length === 0)
    return "You have no commodity subscriptions. Reply *schemes* to see what is open.";
  const lines = ["📦 *My commodity subscriptions*"];
  for (const sub of subs) {
    const state = sub.collectedAt
      ? "collected"
      : sub.dispatchedAt
        ? "ready for collection"
        : sub.status;
    lines.push(
      `*${sub.reference}* - ${sub.qty} x ${sub.item.name} (${sub.scheme.name})\n` +
        ` ${formatBalance(sub.totalKobo)} over ${sub.months} months - ${state}`,
    );
  }
  return lines.join("\n");
}

export async function formatSchemeSubsText(cooperativeId: string, ref: string): Promise<string> {
  if (!commoditySchemesEnabled()) return COMMODITY_DISABLED;
  const result = await listSchemeSubscriptions(cooperativeId, ref);
  if (!result) return "Scheme not found.";
  const { scheme, subs } = result;
  if (subs.length === 0) return `No subscriptions on *${scheme.reference}* yet.`;
  const total = subs.reduce((sum, s) => sum + s.totalKobo, 0);
  const lines = [
    `📦 *${scheme.name}* (${scheme.reference}) - ${scheme.status}`,
    `${subs.length} subscription(s), ${formatBalance(total)}`,
    "",
  ];
  for (const sub of subs) {
    lines.push(
      ` • ${sub.member.name} (${sub.member.code}): ${sub.qty} x ${sub.item.name} - ${sub.status} - ${sub.reference}`,
    );
  }
  return lines.join("\n");
}
