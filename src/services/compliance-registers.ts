import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { withCoopContext } from "../lib/tenant-context.js";
import { claimOnce } from "../lib/cache.js";
import { audit } from "./audit.js";
import { notifyMember } from "../lib/messaging.js";
import { writePlatformAudit } from "./platform-audit.js";
import type { PlatformActor } from "./platform-coops.js";

/** NDPA s.40: the NDPC must be notified within 72 hours of discovery. */
export const BREACH_NOTIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

export const BREACH_STATUSES = ["open", "contained", "notified", "closed"] as const;
export const DPIA_STATUSES = ["draft", "approved", "review_due", "archived"] as const;
export const TRANSFER_SAFEGUARDS = ["adequacy", "scc", "bcr", "consent", "contract"] as const;

export type BreachStatus = (typeof BREACH_STATUSES)[number];
export type DpiaStatus = (typeof DPIA_STATUSES)[number];
export type TransferSafeguard = (typeof TRANSFER_SAFEGUARDS)[number];

/** A rejected register payload. Maps to HTTP 400. */
export class ComplianceRegisterError extends Error {}

export interface BreachInput {
  title?: string;
  description?: string;
  discoveredAt?: string | Date;
  occurredAt?: string | Date | null;
  affectedCount?: number | null;
  dataCategories?: string | null;
  containment?: string | null;
  notes?: string | null;
}

export interface BreachPatch extends BreachInput {
  status?: string;
  ndpcNotifiedAt?: string | Date | null;
  ndpcReference?: string | null;
  subjectsNotifiedAt?: string | Date | null;
}

export interface BreachView {
  id: string;
  reference: string;
  title: string;
  description: string;
  discoveredAt: Date;
  occurredAt: Date | null;
  affectedCount: number | null;
  dataCategories: string | null;
  containment: string | null;
  status: string;
  ndpcNotifiedAt: Date | null;
  ndpcReference: string | null;
  subjectsNotifiedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  notificationDueAt: Date;
  hoursRemaining: number;
  overdue: boolean;
}

export interface BreachSummary {
  open: number;
  contained: number;
  notified: number;
  closed: number;
  overdue: number;
  dueWithin24h: number;
}

function requiredString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ComplianceRegisterError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ComplianceRegisterError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, max = 2000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ComplianceRegisterError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ComplianceRegisterError(`${field} must be at most ${max} characters`);
  }
  return trimmed || null;
}

export function parseRegisterDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw new ComplianceRegisterError(`${field} must be a valid date`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  return parseRegisterDate(value, field);
}

function parseAffectedCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ComplianceRegisterError("affectedCount must be a non-negative integer");
  }
  return parsed;
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ComplianceRegisterError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

async function platformActor(
  cooperativeId: string,
  actor: PlatformActor | undefined,
  action: string,
  targetType: string,
  targetId: string,
  detail?: string,
): Promise<void> {
  if (!actor) return;
  await writePlatformAudit({
    actorId: actor.id,
    actorPhone: actor.phone,
    actorRole: actor.role,
    action,
    cooperativeId,
    targetType,
    targetId,
    detail: detail ?? null,
  });
}

function newBreachReference(discoveredAt: Date): string {
  const stamp = discoveredAt.toISOString().slice(0, 10).replace(/-/g, "");
  return `BR-${stamp}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

export function breachView(
  row: {
    id: string;
    reference: string;
    title: string;
    description: string;
    discoveredAt: Date;
    occurredAt: Date | null;
    affectedCount: number | null;
    dataCategories: string | null;
    containment: string | null;
    status: string;
    ndpcNotifiedAt: Date | null;
    ndpcReference: string | null;
    subjectsNotifiedAt: Date | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  now = new Date(),
): BreachView {
  const notificationDueAt = new Date(row.discoveredAt.getTime() + BREACH_NOTIFICATION_WINDOW_MS);
  const hoursRemaining =
    Math.round(((notificationDueAt.getTime() - now.getTime()) / (60 * 60 * 1000)) * 10) / 10;
  return {
    ...row,
    notificationDueAt,
    hoursRemaining,
    overdue: row.status !== "notified" && row.status !== "closed" && hoursRemaining < 0,
  };
}

export async function createBreach(
  cooperativeId: string,
  input: BreachInput,
  actor?: PlatformActor,
): Promise<BreachView> {
  const title = requiredString(input.title, "title", 200);
  const description = requiredString(input.description, "description", 5000);
  const discoveredAt = input.discoveredAt
    ? parseRegisterDate(input.discoveredAt, "discoveredAt")
    : new Date();

  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      created = await withCoopContext(cooperativeId, () =>
        prisma.dataBreach.create({
          data: {
            cooperativeId,
            reference: newBreachReference(discoveredAt),
            title,
            description,
            discoveredAt,
            occurredAt: optionalDate(input.occurredAt, "occurredAt"),
            affectedCount: parseAffectedCount(input.affectedCount),
            dataCategories: optionalString(input.dataCategories, "dataCategories"),
            containment: optionalString(input.containment, "containment"),
            notes: optionalString(input.notes, "notes"),
            createdById: actor?.id ?? null,
          },
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
  if (!created) throw new ComplianceRegisterError("could not allocate a breach reference");

  await platformActor(
    cooperativeId,
    actor,
    "compliance.breach.create",
    "dataBreach",
    created.id,
    `${created.reference} — ${title}`,
  );
  return breachView(created);
}

export async function listBreaches(cooperativeId: string, limit = 100): Promise<BreachView[]> {
  const rows = await withCoopContext(cooperativeId, () =>
    prisma.dataBreach.findMany({
      where: { cooperativeId },
      orderBy: { discoveredAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    }),
  );
  return rows.map((row) => breachView(row));
}

export async function getBreach(cooperativeId: string, id: string): Promise<BreachView | null> {
  const row = await withCoopContext(cooperativeId, () =>
    prisma.dataBreach.findFirst({ where: { id, cooperativeId } }),
  );
  return row ? breachView(row) : null;
}

export async function updateBreach(
  cooperativeId: string,
  id: string,
  patch: BreachPatch,
  actor?: PlatformActor,
): Promise<BreachView> {
  const existing = await withCoopContext(cooperativeId, () =>
    prisma.dataBreach.findFirst({ where: { id, cooperativeId } }),
  );
  if (!existing) throw new ComplianceRegisterError("breach not found");

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = requiredString(patch.title, "title", 200);
  if (patch.description !== undefined) {
    data.description = requiredString(patch.description, "description", 5000);
  }
  if (patch.discoveredAt !== undefined) {
    data.discoveredAt = parseRegisterDate(patch.discoveredAt, "discoveredAt");
  }
  if (patch.occurredAt !== undefined)
    data.occurredAt = optionalDate(patch.occurredAt, "occurredAt");
  if (patch.affectedCount !== undefined)
    data.affectedCount = parseAffectedCount(patch.affectedCount);
  if (patch.dataCategories !== undefined) {
    data.dataCategories = optionalString(patch.dataCategories, "dataCategories");
  }
  if (patch.containment !== undefined) {
    data.containment = optionalString(patch.containment, "containment");
  }
  if (patch.notes !== undefined) data.notes = optionalString(patch.notes, "notes");
  if (patch.ndpcReference !== undefined) {
    data.ndpcReference = optionalString(patch.ndpcReference, "ndpcReference", 120);
  }
  if (patch.subjectsNotifiedAt !== undefined) {
    data.subjectsNotifiedAt = optionalDate(patch.subjectsNotifiedAt, "subjectsNotifiedAt");
  }
  if (patch.ndpcNotifiedAt !== undefined) {
    data.ndpcNotifiedAt = optionalDate(patch.ndpcNotifiedAt, "ndpcNotifiedAt");
  }
  if (patch.status !== undefined) {
    data.status = assertEnum(patch.status, BREACH_STATUSES, "status");
  } else if (patch.ndpcNotifiedAt) {
    data.status = "notified";
  }
  if (Object.keys(data).length === 0) {
    throw new ComplianceRegisterError("no breach fields provided");
  }

  const updated = await withCoopContext(cooperativeId, () =>
    prisma.dataBreach.update({ where: { id: existing.id }, data }),
  );
  await platformActor(
    cooperativeId,
    actor,
    "compliance.breach.update",
    "dataBreach",
    updated.id,
    `${updated.reference} -> ${updated.status}`,
  );
  return breachView(updated);
}

export function summariseBreaches(breaches: BreachView[], now = new Date()): BreachSummary {
  const summary: BreachSummary = {
    open: 0,
    contained: 0,
    notified: 0,
    closed: 0,
    overdue: 0,
    dueWithin24h: 0,
  };
  for (const breach of breaches) {
    if (breach.status === "open") summary.open++;
    else if (breach.status === "contained") summary.contained++;
    else if (breach.status === "notified") summary.notified++;
    else if (breach.status === "closed") summary.closed++;
    const view = breachView(breach, now);
    if (view.overdue) summary.overdue++;
    else if (
      view.hoursRemaining <= 24 &&
      breach.status !== "notified" &&
      breach.status !== "closed"
    ) {
      summary.dueWithin24h++;
    }
  }
  return summary;
}

export interface DpiaInput {
  title?: string;
  activity?: string;
  dataCategories?: string | null;
  necessity?: string | null;
  risks?: string | null;
  mitigations?: string | null;
  status?: string;
  ownerName?: string | null;
  reviewedAt?: string | Date | null;
  nextReviewAt?: string | Date | null;
}

export async function createDpia(cooperativeId: string, input: DpiaInput, actor?: PlatformActor) {
  const status = input.status ? assertEnum(input.status, DPIA_STATUSES, "status") : "draft";
  const reviewedAt =
    optionalDate(input.reviewedAt, "reviewedAt") ?? (status === "approved" ? new Date() : null);
  const record = await withCoopContext(cooperativeId, () =>
    prisma.dpiaRecord.create({
      data: {
        cooperativeId,
        title: requiredString(input.title, "title", 200),
        activity: requiredString(input.activity, "activity", 2000),
        dataCategories: optionalString(input.dataCategories, "dataCategories"),
        necessity: optionalString(input.necessity, "necessity", 4000),
        risks: optionalString(input.risks, "risks", 4000),
        mitigations: optionalString(input.mitigations, "mitigations", 4000),
        status,
        ownerName: optionalString(input.ownerName, "ownerName", 160),
        reviewedAt,
        nextReviewAt: optionalDate(input.nextReviewAt, "nextReviewAt"),
        createdById: actor?.id ?? null,
      },
    }),
  );
  await platformActor(
    cooperativeId,
    actor,
    "compliance.dpia.create",
    "dpiaRecord",
    record.id,
    record.title,
  );
  return record;
}

export async function listDpias(cooperativeId: string, limit = 100) {
  return withCoopContext(cooperativeId, () =>
    prisma.dpiaRecord.findMany({
      where: { cooperativeId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    }),
  );
}

export async function updateDpia(
  cooperativeId: string,
  id: string,
  patch: DpiaInput,
  actor?: PlatformActor,
) {
  const existing = await withCoopContext(cooperativeId, () =>
    prisma.dpiaRecord.findFirst({ where: { id, cooperativeId } }),
  );
  if (!existing) throw new ComplianceRegisterError("DPIA not found");

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = requiredString(patch.title, "title", 200);
  if (patch.activity !== undefined) {
    data.activity = requiredString(patch.activity, "activity", 2000);
  }
  if (patch.dataCategories !== undefined) {
    data.dataCategories = optionalString(patch.dataCategories, "dataCategories");
  }
  if (patch.necessity !== undefined)
    data.necessity = optionalString(patch.necessity, "necessity", 4000);
  if (patch.risks !== undefined) data.risks = optionalString(patch.risks, "risks", 4000);
  if (patch.mitigations !== undefined) {
    data.mitigations = optionalString(patch.mitigations, "mitigations", 4000);
  }
  if (patch.ownerName !== undefined) {
    data.ownerName = optionalString(patch.ownerName, "ownerName", 160);
  }
  if (patch.reviewedAt !== undefined)
    data.reviewedAt = optionalDate(patch.reviewedAt, "reviewedAt");
  if (patch.nextReviewAt !== undefined) {
    data.nextReviewAt = optionalDate(patch.nextReviewAt, "nextReviewAt");
  }
  if (patch.status !== undefined) {
    data.status = assertEnum(patch.status, DPIA_STATUSES, "status");
    if (patch.status === "approved" && patch.reviewedAt === undefined && !existing.reviewedAt) {
      data.reviewedAt = new Date();
    }
  }
  if (Object.keys(data).length === 0) {
    throw new ComplianceRegisterError("no DPIA fields provided");
  }

  const updated = await withCoopContext(cooperativeId, () =>
    prisma.dpiaRecord.update({ where: { id: existing.id }, data }),
  );
  await platformActor(
    cooperativeId,
    actor,
    "compliance.dpia.update",
    "dpiaRecord",
    updated.id,
    `${updated.title} -> ${updated.status}`,
  );
  return updated;
}

export interface CrossBorderInput {
  country?: string;
  recipient?: string;
  purpose?: string;
  dataCategories?: string | null;
  safeguard?: string;
  safeguardDetail?: string | null;
  reviewedAt?: string | Date | null;
}

export async function createCrossBorderTransfer(
  cooperativeId: string,
  input: CrossBorderInput,
  actor?: PlatformActor,
) {
  const record = await withCoopContext(cooperativeId, () =>
    prisma.crossBorderTransfer.create({
      data: {
        cooperativeId,
        country: requiredString(input.country, "country", 120),
        recipient: requiredString(input.recipient, "recipient", 200),
        purpose: requiredString(input.purpose, "purpose", 2000),
        dataCategories: optionalString(input.dataCategories, "dataCategories"),
        safeguard: assertEnum(input.safeguard, TRANSFER_SAFEGUARDS, "safeguard"),
        safeguardDetail: optionalString(input.safeguardDetail, "safeguardDetail", 2000),
        reviewedAt: optionalDate(input.reviewedAt, "reviewedAt"),
        createdById: actor?.id ?? null,
      },
    }),
  );
  await platformActor(
    cooperativeId,
    actor,
    "compliance.cross_border.create",
    "crossBorderTransfer",
    record.id,
    `${record.recipient} (${record.country})`,
  );
  return record;
}

export async function listCrossBorderTransfers(cooperativeId: string, limit = 100) {
  return withCoopContext(cooperativeId, () =>
    prisma.crossBorderTransfer.findMany({
      where: { cooperativeId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    }),
  );
}

export async function endCrossBorderTransfer(
  cooperativeId: string,
  id: string,
  actor?: PlatformActor,
) {
  const existing = await withCoopContext(cooperativeId, () =>
    prisma.crossBorderTransfer.findFirst({ where: { id, cooperativeId } }),
  );
  if (!existing) throw new ComplianceRegisterError("cross-border transfer not found");
  if (existing.status === "ended") return existing;

  const updated = await withCoopContext(cooperativeId, () =>
    prisma.crossBorderTransfer.update({
      where: { id: existing.id },
      data: { status: "ended", endedAt: new Date() },
    }),
  );
  await platformActor(
    cooperativeId,
    actor,
    "compliance.cross_border.end",
    "crossBorderTransfer",
    updated.id,
    `${updated.recipient} (${updated.country})`,
  );
  return updated;
}

/**
 * Notify coop admins as a breach deadline approaches or passes. Deduped per
 * breach per day. Only open/contained breaches are considered — a notified or
 * closed breach no longer has an NDPC deadline to chase.
 */
export async function runBreachDeadlineReminders(now = new Date()): Promise<number> {
  const coops = await prisma.cooperative.findMany({ select: { id: true } });
  const day = now.toISOString().slice(0, 10);
  let reminded = 0;

  for (const coop of coops) {
    try {
      const breaches = await withCoopContext(coop.id, () =>
        prisma.dataBreach.findMany({
          where: { cooperativeId: coop.id, status: { in: ["open", "contained"] } },
        }),
      );
      if (breaches.length === 0) continue;

      const due = breaches
        .map((row) => breachView(row, now))
        .filter((row) => row.overdue || row.hoursRemaining <= 24);
      if (due.length === 0) continue;

      const admins = await prisma.member.findMany({
        where: { cooperativeId: coop.id, role: { in: ["admin", "superadmin"] }, status: "active" },
      });
      if (admins.length === 0) continue;

      for (const breach of due) {
        if (!(await claimOnce("breach-deadline", `${breach.id}:${day}`, 2 * 24 * 3600))) continue;
        const state = breach.overdue ? "OVERDUE" : "due within 24 hours";
        const deadline = breach.notificationDueAt.toISOString().slice(0, 16).replace("T", " ");
        const text =
          `🚨 *NDPC breach notification ${state}*\n\n` +
          `*${breach.title}* (${breach.reference})\n` +
          `NDPC notification deadline: *${deadline} UTC*\n\n` +
          `Open the platform console to record the notification reference once filed.`;
        await Promise.all(admins.map((a) => notifyMember(a, text).catch(() => {})));
        await audit({
          cooperativeId: coop.id,
          actorPhone: "system",
          actorId: null,
          actorRole: "system",
          action: "compliance.breach_deadline_reminder",
          targetType: "dataBreach",
          targetId: breach.id,
          detail: `${breach.reference} ${state}`,
        }).catch(() => {});
        reminded++;
      }
    } catch (err) {
      console.error("[compliance] breach reminder failed", coop.id, err);
    }
  }
  return reminded;
}
