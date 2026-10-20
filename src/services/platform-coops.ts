import { prisma } from "../lib/prisma.js";
import { listCooperativeIds, withCoopContext } from "../lib/tenant-context.js";
import { sendText } from "../lib/messaging.js";
import {
  provisionCooperative,
  addCoopAdmin,
  type AddCoopAdminInput,
  type AddCoopAdminResult,
  type ProvisionCooperativeResult,
} from "./cooperative-provisioning.js";
import { getEffectiveConfig } from "./platform-policy.js";
import { writePlatformAudit } from "./platform-audit.js";

/** The authenticated platform admin performing the action (from the developer preHandler). */
export interface PlatformActor {
  id: string;
  phone: string;
  role: string;
}

export interface CoopSummary {
  id: string;
  name: string;
  code: string;
  status: string;
  plan: string;
  createdAt: Date;
  memberCount: number;
  adminCount: number;
}

export interface CreateCoopInput {
  name: string;
  code: string;
  state?: string;
  country?: string;
  /** Console shape: the first super-admin. */
  superAdmin?: { name?: string; phone: string };
  /** Provisioning shape (chat flow parity). */
  adminPhone?: string;
  adminName?: string;
  sessionPhone?: string;
}

/**
 * Minimal cross-coop summary. Every row is read inside its own tenant context —
 * never an unscoped query across coop-scoped tables. Full health stats land in
 * the Task 8 service.
 */
export async function listCoops(): Promise<CoopSummary[]> {
  const ids = await listCooperativeIds();
  const summaries: CoopSummary[] = [];
  for (const id of ids) {
    const summary = await withCoopContext(id, async () => {
      const coop = await prisma.cooperative.findUnique({ where: { id } });
      if (!coop) return null;
      const [memberCount, adminCount, subscription] = await Promise.all([
        prisma.member.count({ where: { cooperativeId: id } }),
        prisma.member.count({
          where: { cooperativeId: id, role: { in: ["admin", "superadmin"] } },
        }),
        prisma.subscription.findUnique({ where: { cooperativeId: id } }),
      ]);
      return {
        id: coop.id,
        name: coop.name,
        code: coop.code,
        status: coop.status,
        plan: subscription?.plan ?? "free",
        createdAt: coop.createdAt,
        memberCount,
        adminCount,
      } satisfies CoopSummary;
    });
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/**
 * Provision a coop via the shared chat onboarding path and record the platform
 * action. `provisionCooperative` already sends the super-admin welcome itself.
 */
export async function createCoop(
  input: CreateCoopInput,
  actor?: PlatformActor,
): Promise<ProvisionCooperativeResult> {
  const adminPhone = input.superAdmin?.phone ?? input.adminPhone;
  if (!adminPhone) throw new Error("an admin phone is required");

  const result = await provisionCooperative({
    name: input.name,
    code: input.code,
    state: input.state,
    country: input.country,
    adminPhone,
    adminName: input.superAdmin?.name ?? input.adminName,
    sessionPhone: input.sessionPhone,
  });

  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "coop.create",
      cooperativeId: result.cooperativeId,
      targetType: "cooperative",
      targetId: result.cooperativeId,
      detail: JSON.stringify({ name: input.name, code: result.code }),
    });
  }

  return result;
}

export interface CoopAdminView {
  id: string;
  name: string;
  phone: string;
  contactPhone: string | null;
  role: string;
  status: string;
  createdAt: Date;
}

/**
 * Coop detail: the coop row, its admins, and the effective (platform+coop)
 * config. All coop-scoped reads run inside the coop's context.
 */
export async function getCoopDetail(id: string): Promise<{
  cooperative: Awaited<ReturnType<typeof prisma.cooperative.findUnique>>;
  admins: CoopAdminView[];
  config: Awaited<ReturnType<typeof getEffectiveConfig>>["config"];
  meta: Awaited<ReturnType<typeof getEffectiveConfig>>["meta"];
} | null> {
  return withCoopContext(id, async () => {
    const cooperative = await prisma.cooperative.findUnique({ where: { id } });
    if (!cooperative) return null;
    const admins = await prisma.member.findMany({
      where: { cooperativeId: id, role: { in: ["admin", "superadmin"] } },
      select: {
        id: true,
        name: true,
        phone: true,
        contactPhone: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const { config, meta } = await getEffectiveConfig(id);
    return { cooperative, admins, config, meta };
  });
}

/** Whether a coop exists (tenant-scoped read). */
export async function coopExists(id: string): Promise<boolean> {
  const row = await withCoopContext(id, () =>
    prisma.cooperative.findUnique({ where: { id }, select: { id: true } }),
  );
  return row !== null;
}

/** Suspend or reactivate a coop. */
export async function setCoopStatus(
  id: string,
  status: "active" | "suspended",
  actor?: PlatformActor,
): Promise<void> {
  await withCoopContext(id, () => prisma.cooperative.update({ where: { id }, data: { status } }));
  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: status === "suspended" ? "coop.suspend" : "coop.reactivate",
      cooperativeId: id,
      targetType: "cooperative",
      targetId: id,
      detail: JSON.stringify({ status }),
    });
  }
}

/** Revoke every coop-admin session by invalidating tokens issued before now. */
export async function revokeCoopSessions(id: string, actor?: PlatformActor): Promise<void> {
  await withCoopContext(id, () =>
    prisma.cooperative.update({ where: { id }, data: { tokensValidAfter: new Date() } }),
  );
  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "coop.revoke_sessions",
      cooperativeId: id,
      targetType: "cooperative",
      targetId: id,
    });
  }
}

/**
 * Add (or promote) a coop admin. Spec §5.3 requires a welcome to be sent when a
 * NEW admin is created, so the provisioning service is wrapped here and the
 * temp PIN is delivered. A pure role update sends nothing.
 */
export async function addCoopAdminAndNotify(
  coopId: string,
  input: AddCoopAdminInput,
  actor?: PlatformActor,
): Promise<AddCoopAdminResult> {
  if (!(await coopExists(coopId))) throw new Error("cooperative not found");

  const result = await addCoopAdmin(coopId, input);

  if (result.created && result.tempPin) {
    const info = await withCoopContext(coopId, async () => {
      const coop = await prisma.cooperative.findUnique({
        where: { id: coopId },
        select: { name: true, code: true },
      });
      const member = await prisma.member.findUnique({
        where: { id: result.memberId },
        select: { code: true },
      });
      return { name: coop?.name ?? "", code: coop?.code ?? "", memberCode: member?.code ?? "" };
    });
    await sendText({
      to: input.phone,
      text:
        `🏦 You have been added to *${info.name}* as *${input.role}*.\n\n` +
        `Cooperative code: *${info.code}*\n` +
        `Your member code: *${info.memberCode}*\n` +
        `Your temporary PIN: *${result.tempPin}*\n\n` +
        `⚠️ *Change your PIN immediately* by replying: *setpin ${result.tempPin} <new pin>*\n\n` +
        `Reply *menu* to see all admin commands.`,
    });
  }

  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: result.created ? "coop.admin.create" : "coop.admin.promote",
      cooperativeId: coopId,
      targetType: "member",
      targetId: result.memberId,
      detail: JSON.stringify({ role: input.role }),
    });
  }

  return result;
}

/**
 * Nigeria compliance metadata that a platform admin may set on a coop. Every
 * field is optional and nullable; only these keys are ever written (spec §4.8).
 */
export interface CoopComplianceInput {
  registrationNumber?: string | null;
  tin?: string | null;
  cvn?: string | null;
  scumlStatus?: string | null;
  dpoName?: string | null;
  dpoPhone?: string | null;
  dpoEmail?: string | null;
}

const COMPLIANCE_FIELDS = [
  "registrationNumber",
  "tin",
  "cvn",
  "scumlStatus",
  "dpoName",
  "dpoPhone",
  "dpoEmail",
] as const satisfies ReadonlyArray<keyof CoopComplianceInput>;

/**
 * Update only the whitelisted compliance fields on a coop. Unknown keys are
 * ignored; blank strings normalize to null. Audited.
 */
export async function setCoopCompliance(
  id: string,
  input: CoopComplianceInput,
  actor?: PlatformActor,
): Promise<void> {
  const data: Record<string, string | null> = {};
  for (const key of COMPLIANCE_FIELDS) {
    if (key in input) {
      const raw = input[key];
      data[key] = raw === null || raw === undefined ? null : String(raw).trim() || null;
    }
  }
  if (Object.keys(data).length === 0) {
    throw new Error("no compliance fields provided");
  }
  await withCoopContext(id, () => prisma.cooperative.update({ where: { id }, data }));
  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "coop.compliance.set",
      cooperativeId: id,
      targetType: "cooperative",
      targetId: id,
      detail: JSON.stringify(data),
    });
  }
}

/** Change an existing coop member's admin role by member id. */
export async function setCoopAdminRole(
  coopId: string,
  memberId: string,
  role: "admin" | "superadmin",
  actor?: PlatformActor,
): Promise<void> {
  await withCoopContext(coopId, () =>
    prisma.member.update({ where: { id: memberId }, data: { role } }),
  );
  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "coop.admin.set_role",
      cooperativeId: coopId,
      targetType: "member",
      targetId: memberId,
      detail: JSON.stringify({ role }),
    });
  }
}
