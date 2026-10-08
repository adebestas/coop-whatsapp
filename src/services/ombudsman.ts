import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { sendText } from "../lib/messaging.js";
import { Prisma } from "@prisma/client";

const DEFAULT_SLA_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CaseSourceType = "grievance" | "dispute";

export interface EscalateInput {
  sourceType: CaseSourceType;
  sourceId?: string;
  category: string;
  summary: string;
}

export interface EscalateActor {
  id: string;
  phone: string;
}

export interface CaseSummary {
  id: string;
  cooperativeId: string;
  memberId: string;
  sourceType: string;
  sourceId: string | null;
  category: string;
  summary: string;
  status: string;
  escalatedBy: string;
  slaDueAt: Date | null;
  createdAt: Date;
}

export interface CaseEvent {
  id: string;
  actorId: string;
  actorRole: string;
  action: string;
  detail: string;
  createdAt: Date;
}

export interface CaseDetail extends CaseSummary {
  decision: string | null;
  decisionById: string | null;
  decidedAt: Date | null;
  remedy: string | null;
  updatedAt: Date;
  events: CaseEvent[];
}

function toSummary(c: {
  id: string;
  cooperativeId: string;
  memberId: string;
  sourceType: string;
  sourceId: string | null;
  category: string;
  summary: string;
  status: string;
  escalatedBy: string;
  slaDueAt: Date | null;
  createdAt: Date;
}): CaseSummary {
  return {
    id: c.id,
    cooperativeId: c.cooperativeId,
    memberId: c.memberId,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    category: c.category,
    summary: c.summary,
    status: c.status,
    escalatedBy: c.escalatedBy,
    slaDueAt: c.slaDueAt,
    createdAt: c.createdAt,
  };
}

/** Notify every active platform ombudsman. Never throws. */
async function notifyOmbudsmen(text: string): Promise<void> {
  const ombudsmen = await prisma.ombudsman.findMany({ where: { active: true } });
  await Promise.all(ombudsmen.map((o) => sendText({ to: o.phone, text }))).catch(() => {});
}

/**
 * Escalate a grievance or dispute to the platform ombudsman. Creates a
 * platform-level `OmbudsmanCase` (open), records the `escalated` event, notifies
 * every active ombudsman, and audits the action. One case per source: escalating
 * the same source id twice is refused.
 */
export async function escalateCase(
  coopId: string,
  memberId: string,
  input: EscalateInput,
  actor: EscalateActor,
): Promise<{ ok: boolean; message: string; caseId?: string }> {
  const summary = input.summary?.trim() ?? "";
  if (!summary) {
    return { ok: false, message: "Add a short summary of the issue you're escalating." };
  }
  const sourceType: CaseSourceType = input.sourceType === "dispute" ? "dispute" : "grievance";
  const sourceId = input.sourceId?.trim() || null;
  const category = (input.category?.trim() || "other").slice(0, 60);

  const outcome = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);

    if (sourceType === "grievance") {
      if (!sourceId) return { error: "missing_source" as const };
      const grievance = await tx.grievance.findFirst({
        where: { id: sourceId, cooperativeId: coopId, memberId },
        select: { id: true },
      });
      if (!grievance) return { error: "not_found" as const };
    }

    const config = await tx.cooperativeConfig.findUnique({
      where: { cooperativeId: coopId },
      select: { ombudsmanSlaDays: true },
    });
    const slaDays = config?.ombudsmanSlaDays ?? DEFAULT_SLA_DAYS;
    const slaDueAt = new Date(Date.now() + slaDays * DAY_MS);

    // Deduplication is enforced by the partial unique index
    // OmbudsmanCase_cooperativeId_sourceType_sourceId_key, not a check-then-act
    // read — so two concurrent escalations cannot both succeed.
    const c = await tx.ombudsmanCase.create({
      data: {
        cooperativeId: coopId,
        memberId,
        sourceType,
        sourceId,
        category,
        summary,
        status: "open",
        escalatedBy: "member",
        slaDueAt,
      },
      select: { id: true },
    });
    await tx.ombudsmanCaseEvent.create({
      data: {
        caseId: c.id,
        actorId: actor.id,
        actorRole: "member",
        action: "escalated",
        detail: summary,
      },
    });
    return { caseId: c.id };
  }).catch((err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "duplicate" as const };
    }
    throw err;
  });

  if ("error" in outcome) {
    if (outcome.error === "missing_source") {
      return { ok: false, message: "Which grievance? Reply *escalate <grievance id> [reason]*." };
    }
    if (outcome.error === "not_found") {
      return { ok: false, message: "We couldn't find that grievance. Reply *grievances* to list yours." };
    }
    return { ok: false, message: "This matter has already been escalated to the ombudsman." };
  }
  const caseId = outcome.caseId;

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "member",
    action: "ombudsman.case_escalated",
    targetType: "ombudsman_case",
    targetId: caseId,
    detail: `${sourceType} escalation (${category}): ${summary}`,
  }).catch(() => {});

  await notifyOmbudsmen(
    `⚖️ *New ombudsman case* #${caseId.slice(-6)}\n\n` +
      `Category: *${category}*\n${summary}\n\n` +
      `Reply *cases* to review.`,
  );

  return {
    ok: true,
    message:
      `✅ Escalated to the independent ombudsman.\n\n` +
      `Case ID: *${caseId}*\n` +
      `You'll be notified when the ombudsman reviews it.`,
    caseId,
  };
}

/** Platform-level: list cases across every cooperative, optionally by status. */
export async function listCases(
  status?: string,
): Promise<{ ok: boolean; message: string; cases?: CaseSummary[] }> {
  const rows = await prisma.ombudsmanCase.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const cases = rows.map(toSummary);
  return {
    ok: true,
    message: cases.length
      ? `${cases.length} ${status ? `${status} ` : ""}case(s).`
      : status
        ? `No ${status} cases.`
        : "No cases yet.",
    cases,
  };
}

/**
 * Platform-level: read one case and its full timeline. An exact id is resolved
 * with `findUnique`; a partial prefix/suffix must be at least 6 characters and
 * resolve to exactly one case, otherwise an ambiguity error is returned rather
 * than an arbitrary case's (PII-bearing) timeline.
 */
export async function getCase(
  caseId: string,
): Promise<{ ok: boolean; message: string; case?: CaseDetail }> {
  const id = caseId?.trim();
  if (!id) return { ok: false, message: "Which case? Give the case id." };

  const include = { events: { orderBy: { createdAt: "asc" as const } } };
  let c = await prisma.ombudsmanCase.findUnique({ where: { id }, include });
  if (!c) {
    if (id.length < 6) {
      return {
        ok: false,
        message: "That id is too short. Give at least 6 characters of the case id.",
      };
    }
    const matches = await prisma.ombudsmanCase.findMany({
      where: { OR: [{ id: { startsWith: id } }, { id: { endsWith: id } }] },
      include,
      take: 2,
    });
    if (matches.length === 0) return { ok: false, message: "Case not found." };
    if (matches.length > 1) {
      return {
        ok: false,
        message: "More than one case matches that id. Give more characters of the case id.",
      };
    }
    c = matches[0];
  }
  return {
    ok: true,
    message: `Case #${c.id.slice(-6)} (${c.status}).`,
    case: {
      ...toSummary(c),
      decision: c.decision,
      decisionById: c.decisionById,
      decidedAt: c.decidedAt,
      remedy: c.remedy,
      updatedAt: c.updatedAt,
      events: c.events.map((e) => ({
        id: e.id,
        actorId: e.actorId,
        actorRole: e.actorRole,
        action: e.action,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    },
  };
}

/** True only for a phone belonging to an active platform ombudsman. */
export async function isOmbudsman(phone: string): Promise<boolean> {
  if (!phone) return false;
  const found = await prisma.ombudsman.findFirst({
    where: { phone, active: true },
    select: { id: true },
  });
  return found !== null;
}
