import { prisma } from "../lib/prisma.js";
import { listCooperativeIds, withCoopContext } from "../lib/tenant-context.js";
import { sendText } from "../lib/messaging.js";
import { normalizePhone } from "../lib/phones.js";
import { cacheDel } from "../lib/cache.js";
import { getRule } from "../lib/rule-registry.js";
import { platformPolicyVersion } from "./platform-policy-store.js";
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
  /** Optional CAC/CAMA registration number captured at creation time. */
  registrationNumber?: string;
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
  const adminPhone = normalizePhone(input.superAdmin?.phone ?? input.adminPhone ?? "");
  if (!adminPhone) throw new Error("a valid admin phone is required");

  const registrationNumber = normalizeComplianceValue(
    "registrationNumber",
    input.registrationNumber,
  );

  const result = await provisionCooperative({
    name: input.name,
    code: input.code,
    state: input.state,
    country: input.country,
    adminPhone,
    adminName: input.superAdmin?.name ?? input.adminName,
    registrationNumber: registrationNumber ?? undefined,
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
  rawConfig: Awaited<ReturnType<typeof prisma.cooperativeConfig.findUnique>> | null;
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
    const rawConfig = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: id } });
    const { config, meta } = await getEffectiveConfig(id);
    return { cooperative, admins, config, meta, rawConfig };
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
  ndpcRegistrationNumber?: string | null;
  ndpcRegisteredAt?: string | null;
  scumlNumber?: string | null;
  scumlFiledAt?: string | null;
  scumlExpiresAt?: string | null;
}

const COMPLIANCE_FIELDS = [
  "registrationNumber",
  "tin",
  "cvn",
  "scumlStatus",
  "dpoName",
  "dpoPhone",
  "dpoEmail",
  "ndpcRegistrationNumber",
  "ndpcRegisteredAt",
  "scumlNumber",
  "scumlFiledAt",
  "scumlExpiresAt",
] as const satisfies ReadonlyArray<keyof CoopComplianceInput>;

/** Compliance fields stored as dates (ISO YYYY-MM-DD in, UTC Date out). */
const COMPLIANCE_DATE_FIELDS = new Set<string>([
  "ndpcRegisteredAt",
  "scumlFiledAt",
  "scumlExpiresAt",
]);

function normalizeComplianceDate(key: string, raw: unknown): Date | null {
  const value = normalizeComplianceValue(key, raw);
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ComplianceInputError(`${key} must be a date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ComplianceInputError(`${key} must be a valid calendar date`);
  }
  return parsed;
}

/** A rejected compliance payload (bad type or no recognised field). Maps to 400. */
export class ComplianceInputError extends Error {}

/** Truncate an audit detail string to the platform log's cap. */
const AUDIT_DETAIL_MAX = 500;

/**
 * Validate and normalise one compliance value: `string | null` only. Blank /
 * whitespace-only strings become `null`; any other type is rejected so a nested
 * object can never be persisted as `"[object Object]"` in a regulatory field.
 */
export function normalizeComplianceValue(key: string, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ComplianceInputError(`${key} must be a string`);
  return raw.trim() || null;
}

/**
 * Update only the whitelisted compliance fields on a coop. Unknown keys are
 * ignored; blank strings normalize to null. Audited.
 */
export async function setCoopCompliance(
  id: string,
  input: CoopComplianceInput,
  actor?: PlatformActor,
): Promise<void> {
  if (typeof input !== "object" || input === null) {
    throw new ComplianceInputError("invalid compliance payload");
  }
  const data: Record<string, string | Date | null> = {};
  for (const key of COMPLIANCE_FIELDS) {
    if (key in input) {
      data[key] = COMPLIANCE_DATE_FIELDS.has(key)
        ? normalizeComplianceDate(key, input[key])
        : normalizeComplianceValue(key, input[key]);
    }
  }
  if (Object.keys(data).length === 0) {
    throw new ComplianceInputError("no compliance fields provided");
  }
  await withCoopContext(id, () => prisma.cooperative.update({ where: { id }, data }));
  if (actor) {
    const detail = JSON.stringify(data);
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "coop.compliance.set",
      cooperativeId: id,
      targetType: "cooperative",
      targetId: id,
      detail: detail.length > AUDIT_DETAIL_MAX ? detail.slice(0, AUDIT_DETAIL_MAX) : detail,
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

/** Allowed configuration keys in CooperativeConfig */
export const ALLOWED_CONFIG_KEYS = new Set([
  "autoApproveLoans",
  "requireGuarantors",
  "statusEnabled",
  "loanProtectionEnabled",
  "directDebitEnabled",
  "regulatorReportingEnabled",
  "referralEnabled",
  "literacyCertificationEnabled",
  "allowShareRedemption",
  "loanInterestRate",
  "maxLoanMultiplier",
  "loanDurationMonths",
  "minLoanTermMonths",
  "maxLoanPerMember",
  "minMembershipMonths",
  "minGuarantors",
  "serviceChargePercent",
  "lateFinePercent",
  "minContribution",
  "minSavings",
  "minWithdrawal",
  "maxWithdrawal",
  "withdrawalCooldownMonths",
  "loanProtectionPercent",
  "referralRewardAmount",
  "referralRewardType",
  "reserveFundPercent",
  "educationFundPercent",
  "dividendCapPercent",
  "sharePrice",
  "minShares",
  "maxShares",
  "ombudsmanSlaDays",
  "agmQuorumPercent",
]);

/** Update features and configuration for a specific cooperative. */
export async function setCoopConfig(
  coopId: string,
  input: Record<string, unknown>,
  actor?: PlatformActor,
): Promise<{
  ok: boolean;
  cooperative: Awaited<ReturnType<typeof prisma.cooperative.findUnique>>;
  config: Awaited<ReturnType<typeof getEffectiveConfig>>["config"];
  meta: Awaited<ReturnType<typeof getEffectiveConfig>>["meta"];
  rawConfig: Awaited<ReturnType<typeof prisma.cooperativeConfig.findUnique>> | null;
}> {
  if (typeof input !== "object" || input === null) {
    throw new ComplianceInputError("invalid config payload");
  }

  const existingCoop = await withCoopContext(coopId, () =>
    prisma.cooperative.findUnique({ where: { id: coopId } }),
  );
  if (!existingCoop) throw new ComplianceInputError("cooperative not found");

  const { meta } = await getEffectiveConfig(coopId);

  const coopData: Record<string, unknown> = {};
  if (input.dailyPayoutLimit !== undefined) {
    const val = Number(input.dailyPayoutLimit);
    if (!Number.isFinite(val) || val < 0) {
      throw new ComplianceInputError("dailyPayoutLimit must be a non-negative number");
    }
    coopData.dailyPayoutLimit = Math.round(val);
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "suspended") {
      throw new ComplianceInputError("status must be active or suspended");
    }
    coopData.status = input.status;
  }
  if (Object.keys(coopData).length > 0) {
    await withCoopContext(coopId, () =>
      prisma.cooperative.update({ where: { id: coopId }, data: coopData }),
    );
  }

  const configUpdates: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(input)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) continue;

    // Check if key is locked by platform policy
    if (meta[key]?.locked) {
      throw new ComplianceInputError(
        `${key} is locked by platform policy and cannot be overridden at cooperative level`,
      );
    }

    const rule = getRule(key);

    if (typeof val === "boolean") {
      configUpdates[key] = val;
    } else if (typeof val === "string") {
      if (key === "referralRewardType") {
        if (!["wallet", "bank", "airtime"].includes(val)) {
          throw new ComplianceInputError("referralRewardType must be wallet, bank, or airtime");
        }
        configUpdates[key] = val;
      }
    } else if (typeof val === "number" && Number.isFinite(val)) {
      if (rule) {
        if (rule.min !== undefined && val < rule.min) {
          throw new ComplianceInputError(`${key} cannot be below statutory minimum (${rule.min})`);
        }
        if (rule.max !== undefined && val > rule.max) {
          throw new ComplianceInputError(`${key} cannot exceed statutory maximum (${rule.max})`);
        }
      }
      configUpdates[key] = Math.round(val);
    }
  }

  if (Object.keys(configUpdates).length > 0) {
    await withCoopContext(coopId, () =>
      prisma.cooperativeConfig.upsert({
        where: { cooperativeId: coopId },
        create: { cooperativeId: coopId, ...configUpdates },
        update: configUpdates,
      }),
    );
    await cacheDel(`coopconfig:${coopId}:v${platformPolicyVersion()}`);
  }

  if (actor) {
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "coop.config.update",
      cooperativeId: coopId,
      targetType: "cooperative_config",
      targetId: coopId,
      detail: JSON.stringify({ ...coopData, ...configUpdates }).slice(0, 500),
    });
  }

  const updatedDetail = await getCoopDetail(coopId);
  return {
    ok: true,
    cooperative: updatedDetail!.cooperative,
    config: updatedDetail!.config,
    meta: updatedDetail!.meta,
    rawConfig: updatedDetail!.rawConfig,
  };
}
