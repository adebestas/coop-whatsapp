import { prisma } from "../lib/prisma.js";

export interface PlatformAuditEntry {
  actorId?: string | null;
  actorPhone: string;
  actorRole: string;
  action: string;
  cooperativeId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
}

/** Best-effort global audit for platform (cross-coop) actions. */
export async function writePlatformAudit(entry: PlatformAuditEntry): Promise<void> {
  try {
    await prisma.platformAuditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorPhone: entry.actorPhone,
        actorRole: entry.actorRole,
        action: entry.action,
        cooperativeId: entry.cooperativeId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? null,
      },
    });
  } catch (err) {
    console.error("[platform-audit] write failed", err);
  }
}
