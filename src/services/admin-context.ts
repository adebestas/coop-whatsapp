import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { getCoopId } from "../lib/runtime-context.js";
import { toKobo } from "../lib/money.js";
import { unitAdminOf } from "./units.js";

export interface AdminContext {
  admin: {
    id: string;
    phone: string;
    name: string;
    email: string | null;
    role: string;
    cooperativeId: string;
  };
  coop: { id: string; name: string; adminPhone: string | null };
  unitAdmin: Awaited<ReturnType<typeof unitAdminOf>>;
  isSuper: boolean;
}

/**
 * Commands that move (or can move) money out. Each must pass the 2FA gate
 * (live authenticator code when enrolled) before its handler runs.
 */
export const MONEY_OUT_COMMANDS = new Set([
  "approve",
  "approvewithdraw",
  "approvewdraw",
  "finalize",
  "payout",
  "approveclaim",
  "approvepay",
  "approverefund",
  "runpayroll",
  "paydividend",
  "paysharedividend",
  "disable2fa",
  "purchasescheme",
]);

/** Commands a seated committee member can use without being a coop admin. */
export const COMMITTEE_COMMANDS = new Set([
  "cvote",
  "committeequeue",
  "supervisoryfreeze",
  "supervisoryunfreeze",
  "referralpause",
  "referralresume",
]);

/** Resolve an admin's access scope: coop-level or a single unit. */
export async function adminContext(phone: string): Promise<AdminContext | null> {
  // ALWAYS re-check live role + status from the DB per command, so a
  // suspended/demoted/deceased admin loses chat admin powers immediately.
  const admin = await prisma.member.findFirst({
    where: {
      phone,
      role: { in: ["admin", "superadmin"] },
      status: "active",
      ...(getCoopId() ? { cooperativeId: getCoopId() } : {}),
    },
    include: { cooperative: true },
  });
  if (!admin) return null;
  const coop = admin.cooperative;
  // The DB role column is the single source of truth for superadmin power.
  // The coop.adminPhone value is used ONLY for notifications, never for authorization.
  const isSuper = admin.role === "superadmin";
  // Super admins are always coop-wide; plain admins may be scoped to a unit.
  const unitAdmin = isSuper ? null : await unitAdminOf(admin);
  return { admin, coop, unitAdmin, isSuper };
}

export function roleLabel(ctx: AdminContext): string {
  if (ctx.isSuper) return "superadmin";
  return ctx.unitAdmin ? "unit admin" : "admin";
}

/** Send the guard failure text and return true (command handled). */
export async function guardFailed(phone: string, message?: string): Promise<boolean> {
  await sendText({ to: phone, text: message ?? "⛔ Not allowed." });
  return true;
}

/**
 * Parse an admin-typed naira amount into integer kobo, or null if malformed.
 */
export function parseAdminNaira(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,₦\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? toKobo(n) : null;
}

/**
 * Resolve the federation a `federation ...` command targets.
 */
export async function resolveFederation(args: string[]) {
  const code = args[0];
  if (code) {
    const byCode = await prisma.federation.findUnique({ where: { code } });
    if (byCode) return byCode;
  }
  return prisma.federation.findFirst({ orderBy: { createdAt: "desc" } });
}
