import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { sendEmail } from "./email.js";

export const MAGIC_LINK_TTL_MS = 15 * 60_000;
export const MAGIC_LINK_PURPOSE = "dashboard_login";

export function hashMagicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function uaHash(ua?: string | null): string | null {
  if (!ua) return null;
  return createHash("sha256").update(ua).digest("hex");
}

function baseUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export interface IssuedLink {
  token: string;
  expiresAt: Date;
}

async function mint(data: {
  memberId?: string;
  platformAdminId?: string;
  cooperativeId?: string;
  ip: string;
  userAgent?: string | null;
  email: string;
  surface: "admin" | "developer";
}): Promise<IssuedLink> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  // Only the newest request should work; older unused links die immediately.
  await prisma.magicLinkToken.updateMany({
    where: {
      ...(data.memberId ? { memberId: data.memberId } : {}),
      ...(data.platformAdminId ? { platformAdminId: data.platformAdminId } : {}),
      usedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: hashMagicToken(token),
      memberId: data.memberId ?? null,
      platformAdminId: data.platformAdminId ?? null,
      cooperativeId: data.cooperativeId ?? null,
      requestedIp: data.ip,
      requestUaHash: uaHash(data.userAgent),
      expiresAt,
      purpose: MAGIC_LINK_PURPOSE,
    },
  });

  const page = data.surface === "developer" ? "/dashboard/dev/magic.html" : "/dashboard/magic.html";
  const link = `${baseUrl()}${page}?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: data.email,
    subject: "Your sign-in link",
    text: [
      "Use this link to sign in. It expires in 15 minutes and works once.",
      "",
      link,
      "",
      "If you did not request this, ignore the message and change your PIN.",
    ].join("\n"),
  });
  return { token, expiresAt };
}

export async function issueMemberMagicLink(params: {
  memberId: string;
  cooperativeId: string;
  email: string;
  ip: string;
  userAgent?: string | null;
}): Promise<IssuedLink> {
  return mint({ ...params, surface: "admin" });
}

export async function issuePlatformMagicLink(params: {
  platformAdminId: string;
  email: string;
  ip: string;
  userAgent?: string | null;
}): Promise<IssuedLink> {
  return mint({ ...params, surface: "developer" });
}

export interface LinkLookup {
  id: string;
  memberId: string | null;
  platformAdminId: string | null;
  cooperativeId: string | null;
  expiresAt: Date;
}

/** Read-only validation; the caller performs TOTP before claiming. */
export async function findLiveMagicLink(token: string): Promise<LinkLookup | null> {
  if (!token || token.length < 20) return null;
  const row = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: hashMagicToken(token) },
    select: {
      id: true,
      memberId: true,
      platformAdminId: true,
      cooperativeId: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
    },
  });
  if (!row || row.usedAt || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: row.id,
    memberId: row.memberId,
    platformAdminId: row.platformAdminId,
    cooperativeId: row.cooperativeId,
    expiresAt: row.expiresAt,
  };
}

/**
 * Single-use claim. The conditional update is the authority: if two requests
 * race, exactly one gets count 1 and the other is rejected.
 */
export async function claimMagicLink(id: string, ip: string): Promise<boolean> {
  const res = await prisma.magicLinkToken.updateMany({
    where: { id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date(), usedIp: ip },
  });
  return res.count === 1;
}
