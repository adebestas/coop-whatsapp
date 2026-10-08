import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { sendText, notifyMember } from "../lib/messaging.js";
import { recommendRefund, approveRefund } from "./refunds.js";
import { formatBalance } from "../lib/money.js";
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

/** Notify the admins of a cooperative (member admins + the coop admin phone). Never throws. */
async function notifyCoop(cooperativeId: string, text: string): Promise<void> {
  const admins = await prisma.member.findMany({
    where: { cooperativeId, role: { in: ["admin", "superadmin"] }, status: "active" },
    select: { phone: true, altChannelId: true, preferredChannel: true, optedOut: true },
  });
  const seen = new Set<string>();
  await Promise.all(
    admins.map((a) => {
      seen.add(a.phone);
      return notifyMember(a, text);
    }),
  ).catch(() => {});
  const coop = await prisma.cooperative.findUnique({
    where: { id: cooperativeId },
    select: { adminPhone: true },
  });
  if (coop?.adminPhone && !seen.has(coop.adminPhone)) {
    await sendText({ to: coop.adminPhone, text }).catch(() => {});
  }
}

/**
 * Resolve a case by exact id, or by a unique prefix/suffix of at least 6
 * characters. Ambiguous or short refs are refused rather than guessing, so an
 * ombudsman never acts on the wrong (PII-bearing) case.
 */
async function lookupCase(ref: string) {
  const id = ref?.trim();
  if (!id) return { ok: false as const, message: "Which case? Give the case id." };
  const exact = await prisma.ombudsmanCase.findUnique({ where: { id } });
  if (exact) return { ok: true as const, case: exact };
  if (id.length < 6) {
    return {
      ok: false as const,
      message: "That id is too short. Give at least 6 characters of the case id.",
    };
  }
  const matches = await prisma.ombudsmanCase.findMany({
    where: { OR: [{ id: { startsWith: id } }, { id: { endsWith: id } }] },
    take: 2,
  });
  if (matches.length === 0) return { ok: false as const, message: "Case not found." };
  if (matches.length > 1) {
    return {
      ok: false as const,
      message: "More than one case matches that id. Give more characters of the case id.",
    };
  }
  return { ok: true as const, case: matches[0] };
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
  return (await getActiveOmbudsman(phone)) !== null;
}

/** Load the active platform ombudsman for a phone, if any. */
export async function getActiveOmbudsman(
  phone: string,
): Promise<{ id: string; name: string } | null> {
  if (!phone) return null;
  return prisma.ombudsman.findFirst({
    where: { phone, active: true },
    select: { id: true, name: true },
  });
}

/**
 * Ombudsman-only: open an investigation on a case, record the `investigating`
 * event, notify the cooperative's admins, and audit the action.
 */
export async function investigateCase(
  caseId: string,
  note: string,
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string }> {
  if (!(await isOmbudsman(actor.phone))) {
    return { ok: false, message: "Only the independent ombudsman can act on a case." };
  }
  const detail = note?.trim() ?? "";
  if (!detail) {
    return { ok: false, message: "Add a short note describing what you're investigating." };
  }
  const lookup = await lookupCase(caseId);
  if (!lookup.ok) return { ok: false, message: lookup.message };
  const c = lookup.case;
  if (c.status === "decided" || c.status === "closed") {
    return { ok: false, message: "This case has already been decided." };
  }

  await withTx(async (tx) => {
    await tx.ombudsmanCase.update({
      where: { id: c.id },
      data: { status: "investigating" },
    });
    await tx.ombudsmanCaseEvent.create({
      data: {
        caseId: c.id,
        actorId: actor.id,
        actorRole: "ombudsman",
        action: "investigating",
        detail,
      },
    });
  });

  await audit({
    cooperativeId: c.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "ombudsman",
    action: "ombudsman.case_investigating",
    targetType: "ombudsman_case",
    targetId: c.id,
    detail: `Investigating case #${c.id.slice(-6)}: ${detail}`,
  }).catch(() => {});

  await notifyCoop(
    c.cooperativeId,
    `⚖️ *Ombudsman investigation opened* — case #${c.id.slice(-6)}\n\n` +
      `The independent ombudsman is investigating this matter and needs your input:\n${detail}`,
  );

  return { ok: true, message: `✅ Case #${c.id.slice(-6)} is now under investigation.` };
}

/**
 * Ombudsman-only: record a binding decision on a case (status `decided`,
 * decision, decisionById, decidedAt), add the `decided` event, notify both the
 * member and the cooperative, and audit the action.
 */
export async function decideCase(
  caseId: string,
  decision: string,
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string }> {
  if (!(await isOmbudsman(actor.phone))) {
    return { ok: false, message: "Only the independent ombudsman can act on a case." };
  }
  const detail = decision?.trim() ?? "";
  if (!detail) {
    return { ok: false, message: "Give the decision you're issuing." };
  }
  const lookup = await lookupCase(caseId);
  if (!lookup.ok) return { ok: false, message: lookup.message };
  const c = lookup.case;
  if (c.status === "decided" || c.status === "closed") {
    return { ok: false, message: "This case has already been decided or closed." };
  }

  const decidedAt = new Date();
  await withTx(async (tx) => {
    await tx.ombudsmanCase.update({
      where: { id: c.id },
      data: { status: "decided", decision: detail, decisionById: actor.id, decidedAt },
    });
    await tx.ombudsmanCaseEvent.create({
      data: {
        caseId: c.id,
        actorId: actor.id,
        actorRole: "ombudsman",
        action: "decided",
        detail,
      },
    });
  });

  await audit({
    cooperativeId: c.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "ombudsman",
    action: "ombudsman.case_decided",
    targetType: "ombudsman_case",
    targetId: c.id,
    detail: `Decision on case #${c.id.slice(-6)}: ${detail}`,
  }).catch(() => {});

  const member = await prisma.member.findUnique({
    where: { id: c.memberId },
    select: { phone: true, altChannelId: true, preferredChannel: true, optedOut: true },
  });
  if (member) {
    await notifyMember(
      member,
      `⚖️ *Ombudsman decision on your case* #${c.id.slice(-6)}\n\n${detail}`,
    ).catch(() => {});
  }
  await notifyCoop(
    c.cooperativeId,
    `⚖️ *Ombudsman decision* — case #${c.id.slice(-6)}\n\n${detail}\n\n_This decision is binding._`,
  );

  return { ok: true, message: `✅ Decision recorded for case #${c.id.slice(-6)}.` };
}

export type RemedyAction = "unfreeze" | "refund";

/**
 * Ombudsman-only: apply a binding remedy to a case. `unfreeze` lifts both the
 * member's self-freeze and any Supervisory Committee freeze (inside
 * `withCoopContext`); `refund` pays the member through the existing
 * maker-checker refund flow with the ombudsman acting as the approver (the
 * admin-recommend step is bypassed). Records the `remedy` JSON + a
 * `remedy_applied` event, audits the action, and notifies the member. One remedy
 * per case.
 */
export async function applyRemedy(
  caseId: string,
  action: RemedyAction,
  params: { amount?: number; reason?: string },
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string }> {
  if (!(await isOmbudsman(actor.phone))) {
    return { ok: false, message: "Only the independent ombudsman can act on a case." };
  }
  if (action !== "unfreeze" && action !== "refund") {
    return {
      ok: false,
      message:
        "Unknown remedy. Use *remedy <id> unfreeze* or *remedy <id> refund <amount> [reason]*.",
    };
  }
  const lookup = await lookupCase(caseId);
  if (!lookup.ok) return { ok: false, message: lookup.message };
  const c = lookup.case;
  if (c.remedy) {
    return { ok: false, message: "This case already has a remedy applied." };
  }

  const member = await prisma.member.findUnique({
    where: { id: c.memberId },
    select: {
      name: true,
      phone: true,
      altChannelId: true,
      preferredChannel: true,
      optedOut: true,
    },
  });
  if (!member) return { ok: false, message: "The member on this case no longer exists." };

  let detail: string;
  let amount: number | undefined;

  if (action === "unfreeze") {
    detail = `Wallet unfrozen by ombudsman remedy (case #${c.id.slice(-6)})`;
  } else {
    const refundAmount = params.amount;
    if (!Number.isInteger(refundAmount) || (refundAmount ?? 0) <= 0) {
      return {
        ok: false,
        message: "Give the refund amount in naira, e.g. *remedy <id> refund 5000*.",
      };
    }
    amount = refundAmount as number;
    const reason = (
      params.reason?.trim() || `Ombudsman remedy (case #${c.id.slice(-6)})`
    ).slice(0, 200);

    // The ombudsman bypasses the admin-recommend step and acts as the approver:
    // create the request, then approve it through the shared payout path.
    const recommended = await recommendRefund(c.cooperativeId, c.memberId, amount, reason, {
      id: actor.id,
      phone: actor.phone,
      role: "ombudsman",
    });
    if (!recommended.ok || !recommended.refundId) {
      return { ok: false, message: recommended.message };
    }
    const paid = await approveRefund(
      c.cooperativeId,
      recommended.refundId,
      { id: actor.id, phone: actor.phone, role: "ombudsman" },
      { ombudsmanApproved: true },
    );
    if (!paid.ok) {
      return { ok: false, message: paid.message };
    }
    detail =
      `Refund of ${formatBalance(amount)} ordered for ${member.name} — ${reason} ` +
      `(refund #${recommended.refundId.slice(-6)})`;
  }

  const remedy = JSON.stringify({ action, detail, appliedAt: new Date().toISOString() });
  await withTx(async (tx) => {
    await setCoopContext(tx as never, c.cooperativeId);
    if (action === "unfreeze") {
      await tx.member.update({
        where: { id: c.memberId },
        data: { frozenAt: null, supervisoryFrozenAt: null },
      });
    }
    await tx.ombudsmanCase.update({ where: { id: c.id }, data: { remedy } });
    await tx.ombudsmanCaseEvent.create({
      data: {
        caseId: c.id,
        actorId: actor.id,
        actorRole: "ombudsman",
        action: "remedy_applied",
        detail,
      },
    });
  });

  await audit({
    cooperativeId: c.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "ombudsman",
    action: "ombudsman.remedy_applied",
    targetType: "ombudsman_case",
    targetId: c.id,
    ...(amount ? { amount } : {}),
    detail,
  }).catch(() => {});

  await notifyMember(
    member,
    `⚖️ *Ombudsman remedy applied* on case #${c.id.slice(-6)}\n\n${detail}`,
  ).catch(() => {});

  return {
    ok: true,
    message: `✅ Remedy applied to case #${c.id.slice(-6)}: ${action}.\n\n${detail}`,
  };
}
