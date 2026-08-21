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

/**
 * Append-only trail of every money/admin action. Never throws — auditing
 * must not break the business flow.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        cooperativeId: entry.cooperativeId,
        actorId: entry.actorId ?? null,
        actorPhone: entry.actorPhone,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        detail: entry.detail?.slice(0, 500),
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
