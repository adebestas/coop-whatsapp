import crypto from "node:crypto";
import { prisma } from "./prisma.js";
import { sendText, notifyMember } from "./messaging.js";
import { cacheDel } from "./cache.js";
import { audit } from "../services/audit.js";

// ---- Device Binding & Session Anomaly Detection ----
// Detects SIM swap / session hijack by tracking device fingerprints.

const DEVICE_FINGERPRINT_KEY = "session:device:";
const ANOMALY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface DeviceInfo {
  phone: string;
  platform: string;
  ip: string;
  timestamp: number;
}

/**
 * Record and validate a device fingerprint for a member session.
 * Returns { ok: true } if the session is normal, or { ok: false, reason }
 * if the session looks anomalous (possible SIM swap / hijack).
 */
export async function validateDeviceSession(params: {
  memberPhone: string;
  platform: string;
  ip: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { memberPhone, platform, ip } = params;
  const cacheKey = `${DEVICE_FINGERPRINT_KEY}${memberPhone}`;
  const now = Date.now();

  try {
    const { getRedis } = await import("./cache.js");
    const redis = getRedis();
    if (!redis) return { ok: true }; // no Redis, allow (can't check)

    const existing = await redis.get(cacheKey);
    if (!existing) {
      // First session — record it
      await redis.setex(cacheKey, 600, JSON.stringify({
        platform,
        ip,
        recordedAt: now,
      }));
      return { ok: true };
    }

    const prev = JSON.parse(existing) as { platform: string; ip: string; recordedAt: number };
    const timeDiff = now - prev.recordedAt;

    // If same session within window, no anomaly
    if (timeDiff < ANOMALY_WINDOW_MS && prev.ip === ip && prev.platform === platform) {
      return { ok: true };
    }

    // If platform changed (WhatsApp → Telegram) or IP changed rapidly, alert
    if (prev.platform !== platform || prev.ip !== ip) {
      if (timeDiff < ANOMALY_WINDOW_MS) {
        // Rapid platform/IP switch = suspicious
        const member = await prisma.member.findFirst({
          where: { phone: memberPhone },
          select: { id: true, name: true, cooperativeId: true, phone: true },
        });
        if (member) {
          // Log anomaly
          await audit({
            cooperativeId: member.cooperativeId,
            actorPhone: memberPhone,
            actorId: member.id,
            actorRole: "member",
            action: "security.session_anomaly",
            targetType: "member",
            targetId: member.id,
            detail: `Platform/IP change: ${prev.platform}→${platform}, ${prev.ip}→${ip} within ${Math.round(timeDiff / 1000)}s`,
          });

          // Alert superadmins
          const superadmins = await prisma.member.findMany({
            where: { cooperativeId: member.cooperativeId, role: "superadmin" },
            select: { phone: true },
          });
          for (const sa of superadmins) {
            await sendText({
              to: sa.phone,
              text: `🚨 Session anomaly detected!\n\nMember: ${member.name}\nFrom: ${prev.platform} (${prev.ip})\nTo: ${platform} (${ip})\nTime: ${Math.round(timeDiff / 1000)}s\n\nIf this is unexpected, consider suspending the member and changing their PIN.`,
            });
          }

          return { ok: false, reason: `Rapid session change detected (${Math.round(timeDiff / 1000)}s). Please try again.` };
        }
      }
    }

    // Update fingerprint
    await redis.setex(cacheKey, 600, JSON.stringify({
      platform,
      ip,
      recordedAt: now,
    }));

    return { ok: true };
  } catch {
    return { ok: true }; // Redis unavailable, allow
  }
}

// ---- Suspicious Activity Auto-Freeze ----
// Freezes a member's account if multiple suspicious patterns are detected.

const SUSPICIOUS_THRESHOLD = 3; // 3 suspicious events in window = auto-freeze
const SUSPICIOUS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Record a suspicious event. If threshold exceeded, auto-freeze the member.
 */
export async function recordSuspiciousEvent(params: {
  memberId: string;
  cooperativeId: string;
  memberPhone: string;
  event: string;
  detail: string;
}): Promise<{ frozen: boolean; reason?: string }> {
  const { memberId, cooperativeId, memberPhone, event, detail } = params;
  const cacheKey = `suspicious:${memberId}`;
  const now = Date.now();

  try {
    const { getRedis } = await import("./cache.js");
    const redis = getRedis();
    if (!redis) {
      // Database fallback: count recent suspicious events in the last hour
      const oneHourAgo = new Date(Date.now() - SUSPICIOUS_WINDOW_MS);
      const recentCount = await prisma.auditLog.count({
        where: {
          targetId: memberId,
          action: { startsWith: "security.suspicious." },
          createdAt: { gte: oneHourAgo },
        },
      });
      const count = recentCount + 1;

      await audit({
        cooperativeId,
        actorPhone: memberPhone,
        actorId: memberId,
        actorRole: "member",
        action: `security.suspicious.${event}`,
        targetType: "member",
        targetId: memberId,
        detail,
      });

      if (count >= SUSPICIOUS_THRESHOLD) {
        await prisma.member.update({
          where: { id: memberId },
          data: { status: "suspended" },
        });
        const superadmins = await prisma.member.findMany({
          where: { cooperativeId, role: "superadmin" },
          select: { phone: true, name: true },
        });
        const member = await prisma.member.findUnique({
          where: { id: memberId },
          select: { name: true, phone: true },
        });
        for (const sa of superadmins) {
          await sendText({
            to: sa.phone,
            text: `🚨 AUTO-FREEZE ACTIVATED 🚨\n\nMember: ${member?.name ?? memberId}\nPhone: ${member?.phone ?? "unknown"}\nReason: ${SUSPICIOUS_THRESHOLD}+ suspicious events in 1 hour\n\nAccount has been suspended. Use "unsuspend ${memberId.slice(0, 8)}" to review and restore.`,
          });
        }
        return { frozen: true, reason: "Account auto-frozen due to suspicious activity" };
      }
      return { frozen: false };
    }

    // Increment suspicious event counter
    const count = await redis.incr(cacheKey);
    if (count === 1) {
      await redis.expire(cacheKey, 3600); // 1 hour TTL
    }

    // Log each event
    await audit({
      cooperativeId,
      actorPhone: memberPhone,
      actorId: memberId,
      actorRole: "member",
      action: `security.suspicious.${event}`,
      targetType: "member",
      targetId: memberId,
      detail,
    });

    if (count >= SUSPICIOUS_THRESHOLD) {
      // Auto-freeze the member
      await prisma.member.update({
        where: { id: memberId },
        data: { status: "suspended" },
      });

      // Alert superadmins
      const superadmins = await prisma.member.findMany({
        where: { cooperativeId, role: "superadmin" },
        select: { phone: true, name: true },
      });
      const member = await prisma.member.findUnique({
        where: { id: memberId },
        select: { name: true, phone: true },
      });

      for (const sa of superadmins) {
        await sendText({
          to: sa.phone,
          text: `🚨 AUTO-FREEZE ACTIVATED 🚨\n\nMember: ${member?.name ?? memberId}\nPhone: ${member?.phone ?? "unknown"}\nReason: ${SUSPICIOUS_THRESHOLD}+ suspicious events in 1 hour\n\nAccount has been suspended. Use "unsuspend ${memberId.slice(0, 8)}" to review and restore.`,
        });
      }

      // Clear the counter
      await redis.del(cacheKey);

      return { frozen: true, reason: "Account auto-frozen due to suspicious activity" };
    }

    return { frozen: false };
  } catch {
    return { frozen: false };
  }
}

// ---- Multi-Sig Enforcement for Large Superadmin Payouts ----
// Requires a second superadmin approval for payouts above threshold.

const PAYOUT_MULTI_SIG_THRESHOLD = 500_000_00; // ₦500,000 in kobo
const MULTI_SIG_EXPIRY_MS = 60 * 60 * 1000; // 1 hour to get second approval

/**
 * Check if a superadmin payout requires multi-sig approval.
 * Returns { needsApproval: false } if under threshold,
 * or { needsApproval: true, requestId, approvers } if multi-sig required.
 */
export async function checkMultiSigRequirement(params: {
  cooperativeId: string;
  amount: number;
  initiatorPhone: string;
  targetId: string;
}): Promise<{ needsApproval: false; warning?: string } | { needsApproval: true; pendingId: string }> {
  const { cooperativeId, amount, initiatorPhone, targetId } = params;

  if (amount < PAYOUT_MULTI_SIG_THRESHOLD) {
    return { needsApproval: false };
  }

  // Count active superadmins
  const superadmins = await prisma.member.findMany({
    where: { cooperativeId, role: "superadmin", status: "active" },
    select: { id: true, phone: true, name: true },
  });

  if (superadmins.length < 2) {
    // Only 1 superadmin — can't enforce multi-sig, but log warning
    console.warn(`[security] Payout ${amount}kobo needs multi-sig but only ${superadmins.length} superadmin(s) exist`);
    await audit({
      cooperativeId,
      actorPhone: initiatorPhone,
      actorId: initiatorPhone,
      actorRole: "superadmin",
      action: "security.multisig_bypass",
      targetType: "cooperative",
      targetId: cooperativeId,
      detail: `Payout ${amount}kobo needs multi-sig but only ${superadmins.length} superadmin(s) exist`,
    });
    return { needsApproval: false, warning: `Only ${superadmins.length} superadmin(s) — multi-sig unavailable. Add more superadmins.` };
  }

  // Create a pending approval request
  const cacheKey = `multisig:${cooperativeId}:${targetId}`;
  try {
    const { getRedis } = await import("./cache.js");
    const redis = getRedis();
    if (!redis) return { needsApproval: false };

    const pendingId = `msig_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    await redis.setex(cacheKey, 3600, JSON.stringify({
      pendingId,
      amount,
      initiatorPhone,
      targetId,
      requestedAt: Date.now(),
      approvals: [initiatorPhone],
    }));

    // Notify all other superadmins
    for (const sa of superadmins) {
      if (sa.phone !== initiatorPhone) {
        await sendText({
          to: sa.phone,
          text: `🔐 Multi-sig approval required!\n\nA payout of ${(amount / 100).toLocaleString("en-NG", { style: "currency", currency: "NGN" })} requires your approval.\n\nInitiated by: ${initiatorPhone}\nTo approve: reply "approve ${pendingId.slice(-6)}"\nTo reject: reply "reject ${pendingId.slice(-6)}"\n\nExpires in 1 hour.`,
        });
      }
    }

    return { needsApproval: true, pendingId };
  } catch {
    return { needsApproval: false };
  }
}

/**
 * Process a multi-sig approval/rejection.
 */
export async function processMultiSigResponse(params: {
  cooperativeId: string;
  pendingIdSuffix: string;
  responderPhone: string;
  action: "approve" | "reject";
}): Promise<{ processed: boolean; message: string }> {
  const { cooperativeId, pendingIdSuffix, responderPhone, action } = params;

  try {
    const { getRedis } = await import("./cache.js");
    const redis = getRedis();
    if (!redis) return { processed: false, message: "Service unavailable" };

    // Find the pending request
    const keys = await redis.keys(`multisig:${cooperativeId}:*`);
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const pending = JSON.parse(data);
      if (pending.pendingId.endsWith(pendingIdSuffix)) {
        // Check expiry
        if (Date.now() - pending.requestedAt > MULTI_SIG_EXPIRY_MS) {
          await redis.del(key);
          return { processed: false, message: "This approval request has expired." };
        }

        // Check not already approved by this person
        if (pending.approvals.includes(responderPhone)) {
          return { processed: false, message: "You already approved this." };
        }

        if (action === "reject") {
          await redis.del(key);
          return { processed: true, message: "Payout rejected and cancelled." };
        }

        // Approve
        pending.approvals.push(responderPhone);

        // Count unique non-initiator approvals (need at least 1 besides initiator)
        const otherApprovals = pending.approvals.filter((p: string) => p !== pending.initiatorPhone);
        if (otherApprovals.length >= 1) {
          // Multi-sig satisfied — clear the request
          await redis.del(key);
          return { processed: true, message: "✅ Multi-sig approval complete! Payout can proceed." };
        }

        // Update the pending record
        await redis.setex(key, 3600, JSON.stringify(pending));
        return { processed: true, message: "Approval recorded. Waiting for additional approvals." };
      }
    }

    return { processed: false, message: "No matching approval request found." };
  } catch {
    return { processed: false, message: "Service unavailable." };
  }
}

// ---- Enhanced Superadmin Command Audit ----
// Logs every superadmin command with full context for forensics.

/**
 * Enhanced audit wrapper for superadmin commands.
 * Sends real-time alerts for high-risk operations.
 */
export async function auditSuperadminCommand(params: {
  cooperativeId: string;
  actorPhone: string;
  actorId: string;
  command: string;
  target?: string;
  detail: string;
  isHighRisk?: boolean;
}): Promise<void> {
  const { cooperativeId, actorPhone, actorId, command, target, detail, isHighRisk } = params;

  await audit({
    cooperativeId,
    actorPhone,
    actorId,
    actorRole: "superadmin",
    action: `admin.${command}`,
    targetType: "member",
    targetId: actorId,
    detail: `${target ? `${target} — ` : ""}${detail}`,
  });

  // Real-time alert for high-risk operations
  if (isHighRisk) {
    const superadmins = await prisma.member.findMany({
      where: { cooperativeId, role: "superadmin", status: "active" },
      select: { phone: true },
    });
    for (const sa of superadmins) {
      if (sa.phone !== actorPhone) {
        await sendText({
          to: sa.phone,
          text: `⚠️ High-risk admin action:\n\nCommand: ${command}\nBy: ${actorPhone}\nTarget: ${target ?? "N/A"}\nDetail: ${detail}`,
        });
      }
    }
  }
}

// ---- Amount Tiering by Member Tenure ----
// Limits withdrawal amounts based on how long the member has been active.

const TENURE_LIMITS = [
  { minMonths: 0, maxMonths: 3, maxDaily: 50_000_00 },    // ₦50k/day for first 3 months
  { minMonths: 3, maxMonths: 6, maxDaily: 200_000_00 },   // ₦200k/day for 3-6 months
  { minMonths: 6, maxMonths: 12, maxDaily: 500_000_00 },  // ₦500k/day for 6-12 months
  { minMonths: 12, maxMonths: Infinity, maxDaily: Infinity }, // Unlimited after 1 year
];

/**
 * Check if a withdrawal amount is within the member's tenure-based daily limit.
 */
export async function checkTenureLimit(params: {
  memberId: string;
  amount: number;
  cooperativeId: string;
}): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const { memberId, amount, cooperativeId } = params;

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { createdAt: true },
  });
  if (!member) return { allowed: false, message: "Member not found." };

  const tenureMonths = (Date.now() - member.createdAt.getTime()) / (30 * 24 * 60 * 60 * 1000);
  const limit = TENURE_LIMITS.find(l => tenureMonths >= l.minMonths && tenureMonths < l.maxMonths);
  if (!limit || limit.maxDaily === Infinity) return { allowed: true };

  // Check total withdrawals today
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayTotal = await prisma.withdrawalRequest.aggregate({
    where: {
      memberId,
      cooperativeId,
      createdAt: { gte: startOfDay },
      status: { in: ["paid", "processing", "pending", "admin_approved"] },
    },
    _sum: { amount: true },
  });
  const total = (todayTotal._sum.amount ?? 0) + amount;
  if (total > limit.maxDaily) {
    const remaining = Math.max(0, limit.maxDaily - (todayTotal._sum.amount ?? 0));
    return {
      allowed: false,
      message: `Your account tenure limits daily withdrawals to ${(limit.maxDaily / 100).toLocaleString("en-NG", { style: "currency", currency: "NGN" })}. Remaining today: ${(remaining / 100).toLocaleString("en-NG", { style: "currency", currency: "NGN" })}.`,
    };
  }

  return { allowed: true };
}
