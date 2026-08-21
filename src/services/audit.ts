import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";

export interface AuditEntry {
  cooperativeId: string;
  actorPhone: string;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: string;
}

function hashEntry(prevHash: string | null, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${prevHash ?? "GENESIS"}|${JSON.stringify(payload)}`)
    .digest("hex");
}

/**
 * Append-only, hash-chained trail of every money/admin action. Each entry
 * carries the hash of the previous one — editing history breaks the chain
 * (checked nightly by the reconciliation job). Never throws.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const last = await prisma.auditLog.findFirst({
      where: { cooperativeId: entry.cooperativeId },
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });
    const payload = {
      actorId: entry.actorId ?? null,
      actorPhone: entry.actorPhone,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detail: entry.detail?.slice(0, 500) ?? null,
    };
    const prevHash = last?.hash ?? null;
    await prisma.auditLog.create({
      data: {
        ...payload,
        cooperativeId: entry.cooperativeId,
        detail: entry.detail?.slice(0, 500),
        prevHash,
        hash: hashEntry(prevHash, payload),
      },
    });
  } catch (err) {
    console.error("[audit] failed to record", entry.action, err);
  }
}

/** Recent audit entries for a cooperative (admin visibility). */
export async function recentAudit(cooperativeId: string, take = 15) {
  return prisma.auditLog.findMany({
    where: { cooperativeId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

/** Verify the hash chain; returns the first broken point, if any. */
export async function verifyAuditChain(cooperativeId: string) {
  const entries = await prisma.auditLog.findMany({
    where: { cooperativeId },
    orderBy: { createdAt: "asc" },
  });
  let prevHash: string | null = null;
  for (const e of entries) {
    const payload = {
      actorId: e.actorId,
      actorPhone: e.actorPhone,
      actorRole: e.actorRole,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      detail: e.detail,
    };
    if (e.hash !== hashEntry(e.prevHash, payload) || e.prevHash !== prevHash) {
      return { ok: false as const, brokenAt: e.id };
    }
    prevHash = e.hash;
  }
  return { ok: true as const, checked: entries.length };
}
