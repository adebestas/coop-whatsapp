import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { getRedis } from "./cache.js";

export const PLATFORM_COOKIE = "coop_dev_token";
export const PLATFORM_TTL_MS = 2 * 60 * 60 * 1000;

export interface PlatformTokenPayload {
  scope: "platform";
  adminId: string;
  phone: string;
  role: string;
  iat: number;
}

function secret(): string {
  const s = process.env.ADMIN_JWT_SECRET;
  if (!s) throw new Error("ADMIN_JWT_SECRET is not configured");
  return s;
}

export function signPlatformToken(admin: { id: string; phone: string; role: string }): string {
  const payload: PlatformTokenPayload = {
    scope: "platform",
    adminId: admin.id,
    phone: admin.phone,
    role: admin.role,
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function verifyPlatformToken(token: string): PlatformTokenPayload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("hex");
  const a = Buffer.from(mac),
    b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data: PlatformTokenPayload;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  if (data.scope !== "platform") return null;
  if (Date.now() - data.iat > PLATFORM_TTL_MS) return null;
  return data;
}

const revKey = (t: string) => `platform:revoked:${createHash("sha256").update(t).digest("hex")}`;
// In-process fallback so revocation works when Redis is absent (dev/tests).
const revokedLocal = new Set<string>();

export async function revokePlatformToken(token: string): Promise<void> {
  revokedLocal.add(revKey(token));
  const r = getRedis();
  if (r) await r.set(revKey(token), "1", "PX", PLATFORM_TTL_MS);
}
export async function isPlatformTokenRevoked(token: string): Promise<boolean> {
  const key = revKey(token);
  if (revokedLocal.has(key)) return true;
  const r = getRedis();
  if (!r) return false;
  return (await r.exists(key)) === 1;
}

export async function requireLivePlatformAdmin(
  payload: PlatformTokenPayload,
): Promise<{ id: string; phone: string; role: string } | null> {
  const { prisma } = await import("./prisma.js");
  const admin = await prisma.platformAdmin.findUnique({ where: { id: payload.adminId } });
  if (!admin || !admin.active) return null;
  if (admin.tokensValidAfter && payload.iat < admin.tokensValidAfter.getTime()) return null;
  return { id: admin.id, phone: admin.phone, role: admin.role };
}
