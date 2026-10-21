import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma.js";
import { withCoopContext } from "./tenant-context.js";
import { getRedis } from "./cache.js";

/**
 * Shared admin dashboard token auth. Used by both the admin API routes
 * (routes/admin.ts) and the export-file download route (routes/exports.ts)
 * so that authentication + authorization are enforced consistently and
 * cannot drift between the two surfaces.
 *
 * Token format: `<base64url(JSON { phone, cooperativeId, role, iat })>.<hmac-sha256 hex>`
 * The `iat` lives inside the signed payload (not a separate part).
 */

export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (short-lived; refreshed while active)
const TOKEN_BLACKLIST_PREFIX = "admin:token:blacklist:";
const TOKEN_BLACKLIST_TTL_SECONDS = Math.ceil(TOKEN_TTL_MS / 1000);

export interface AdminTokenPayload {
  phone: string;
  cooperativeId: string;
  role: string;
  /** Issued-at (epoch ms), inside the signed payload. */
  iat: number;
}

function getSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_SECRET is not configured");
  return secret;
}

export function sign(phone: string, cooperativeId: string, role: string): string {
  const secret = getSecret();
  const payload = Buffer.from(
    JSON.stringify({ phone, cooperativeId, role, iat: Date.now() }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Verify the token's HMAC signature + expiry (fail-closed on any failure).
 * Returns the token claims only if the signature is valid and unexpired.
 * This proves "a token was signed by us"; it does NOT alone prove the caller
 * is currently an admin (see `requireLiveAdmin` below).
 */
export function verifyAdminToken(token: string): AdminTokenPayload | null {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const secret = getSecret();
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.cooperativeId !== "string") return null;
    if (data.scope !== undefined) return null;
    if (typeof data.iat !== "number" || !Number.isFinite(data.iat)) return null;
    if (Date.now() - data.iat > TOKEN_TTL_MS) return null;
    return { phone: data.phone, cooperativeId: data.cooperativeId, role: data.role, iat: data.iat };
  } catch {
    return null;
  }
}

/**
 * Revoke a token by storing its hash in Redis with a TTL matching the
 * token's remaining lifetime.
 */
export async function revokeToken(token: string): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    await client.setex(`${TOKEN_BLACKLIST_PREFIX}${hash}`, TOKEN_BLACKLIST_TTL_SECONDS, "1");
  } catch (err) {
    console.error("[admin-auth] failed to revoke token:", err);
  }
}

/**
 * Check whether a token has been revoked. Fails OPEN when Redis is
 * unavailable (returns not-revoked) — a transient Redis/Upstash outage must
 * not lock admins out. The live-DB re-check in `requireLiveAdmin` still gates
 * every request, so a revoked-but-valid-signature token is still rejected by
 * signature + the live role/status check.
 */
export async function isTokenRevoked(token: string): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const exists = await client.exists(`${TOKEN_BLACKLIST_PREFIX}${hash}`);
    return exists === 1;
  } catch {
    // Fail OPEN (not-revoked): a transient Redis/Upstash error must not lock
    // admins out. `requireLiveAdmin` still re-checks the live DB on every
    // request, so this does not weaken the real gate.
    return false;
  }
}

/**
 * Re-read the caller's CURRENT role/status/cooperative from the DB and
 * require that they are a currently-active admin/superadmin (fail-closed).
 * This neutralizes stale/demoted/suspended/deceased tokens and re-derives the
 * cooperative id from the live member row (not the token claim), so even a
 * valid signed token cannot be used to cross cooperative boundaries.
 *
 * Returns the live role + cooperativeId, or null when the caller is not a
 * currently-authorized admin.
 */
export async function requireLiveAdmin(
  payload: AdminTokenPayload,
): Promise<{ phone: string; role: string; cooperativeId: string } | null> {
  // The cooperativeId comes from the signed token, so it is trustworthy and can
  // be used to open the RLS context BEFORE reading the RLS-protected Member
  // table (otherwise the read would fail-closed under FORCE RLS).
  const live = await withCoopContext(payload.cooperativeId, async () => {
    const [member, coop] = await Promise.all([
      prisma.member.findFirst({
        where: { phone: payload.phone, cooperativeId: payload.cooperativeId },
        select: { phone: true, role: true, status: true, cooperativeId: true },
      }),
      prisma.cooperative.findUnique({
        where: { id: payload.cooperativeId },
        select: { status: true, tokensValidAfter: true },
      }),
    ]);
    return { member, coop };
  });
  if (
    !live.member ||
    !["admin", "superadmin"].includes(live.member.role) ||
    live.member.status === "suspended" ||
    live.member.status === "deceased"
  ) {
    return null;
  }
  // A suspended cooperative is a platform-level stop: no coop admin may act.
  if (!live.coop || live.coop.status !== "active") return null;
  // Platform-initiated "revoke sessions": any token issued before the cutoff is
  // dead, even though its HMAC and TTL are still valid.
  if (live.coop.tokensValidAfter && payload.iat <= live.coop.tokensValidAfter.getTime()) {
    return null;
  }
  return {
    phone: live.member.phone,
    role: live.member.role,
    cooperativeId: live.member.cooperativeId,
  };
}

export { getRedis };
