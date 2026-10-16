import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";
import { nameSimilarity } from "./screening.js";
import { invalidateMemberCache } from "./cooperative.js";

/**
 * NIN-based member KYC (A17).
 *
 * BVN is deliberately NOT collected — the platform verifies identity with the
 * 11-digit National Identification Number instead. Verification uses an external
 * provider when `NIN_VERIFY_URL` is configured (the returned registered name is
 * fuzzy-matched against the member's name); otherwise the NIN is stored and the
 * account is marked `pending` for a super admin to confirm manually.
 */

export type KycStatus = "unset" | "pending" | "verified" | "failed";

export function normalizeNin(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

export function isValidNin(raw: string): boolean {
  return /^\d{11}$/.test(normalizeNin(raw));
}

export interface NinVerifyResult {
  status: KycStatus;
  verifiedName?: string;
  reason?: string;
}

interface NinProviderBody {
  ok?: boolean;
  status?: string;
  verified?: boolean;
  name?: string;
  firstname?: string;
  lastname?: string;
  middlename?: string;
  data?: { name?: string; firstname?: string; lastname?: string; middlename?: string };
}

function nameThreshold(): number {
  const n = Number(process.env.NIN_NAME_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.7;
}

function joinName(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

/** Verify a NIN against the member's name. Never throws. */
export async function verifyNin(nin: string, expectedName: string): Promise<NinVerifyResult> {
  const url = process.env.NIN_VERIFY_URL;
  if (!url) return { status: "pending", reason: "no verification provider configured" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.NIN_VERIFY_KEY
          ? { Authorization: `Bearer ${process.env.NIN_VERIFY_KEY}` }
          : {}),
      },
      body: JSON.stringify({ nin }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as NinProviderBody;
    if (!res.ok) return { status: "failed", reason: `provider error (${res.status})` };

    const verifiedName =
      body.data?.name ??
      body.name ??
      joinName(
        body.data?.firstname ?? body.firstname,
        body.data?.middlename ?? body.middlename,
        body.data?.lastname ?? body.lastname,
      );
    const ok =
      body.ok === true ||
      body.verified === true ||
      String(body.status ?? "").toLowerCase() === "success" ||
      (!!verifiedName && res.ok);
    if (!ok) return { status: "failed", reason: "NIN could not be verified" };

    if (verifiedName && nameSimilarity(expectedName, verifiedName) < nameThreshold()) {
      return {
        status: "failed",
        reason: `name mismatch (registered: ${verifiedName})`,
        verifiedName,
      };
    }
    return { status: "verified", verifiedName };
  } catch (err) {
    console.error("[kyc] NIN provider error:", err);
    return { status: "pending", reason: "provider unavailable" };
  }
}

/**
 * Persist and verify a member's NIN. Records the outcome on the member, logs it,
 * and returns a member-facing message.
 */
export async function submitNin(
  member: { id: string; name: string; phone: string; cooperativeId: string },
  rawNin: string,
): Promise<{ status: KycStatus; message: string }> {
  const nin = normalizeNin(rawNin);
  const result = await verifyNin(nin, member.name);

  await prisma.member.update({
    where: { id: member.id },
    data: {
      nin,
      kycStatus: result.status,
      kycVerifiedAt: result.status === "verified" ? new Date() : null,
    },
  });
  invalidateMemberCache(member.phone, member.cooperativeId);
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: member.phone,
    actorRole: "member",
    action: `kyc.nin.${result.status}`,
    targetType: "member",
    targetId: member.id,
    detail:
      result.status === "verified"
        ? "NIN verified"
        : `NIN ${result.status}${result.reason ? `: ${result.reason}` : ""}`,
  });

  if (result.status === "verified") {
    return {
      status: result.status,
      message:
        "✅ Your NIN is verified. Your account is now *Tier 2* — you can make larger transactions.",
    };
  }
  if (result.status === "pending") {
    return {
      status: result.status,
      message:
        "📥 We received your NIN. It's queued for review — a cooperative admin will confirm it shortly.",
    };
  }
  return {
    status: result.status,
    message: `We couldn't verify that NIN (${result.reason ?? "no match"}). Please check the number and try again, or contact your admin.`,
  };
}
