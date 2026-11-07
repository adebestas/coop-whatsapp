import { Prisma } from "@prisma/client";
import { ownerPrisma, prisma } from "../lib/prisma.js";
import { hashPin } from "../lib/security.js";
import { resetRateLimitPrefix } from "../lib/cache.js";
import { invalidateCoopMeta, withCoopContext } from "../lib/tenant-context.js";
import { clearMemberCache, invalidateMemberCache } from "./cooperative.js";
import { writePlatformAudit } from "./platform-audit.js";
import {
  assertNoActiveTurns,
  withSandboxResetFlag,
  withSandboxTurn,
} from "../lib/sandbox-locks.js";
import { runInSandbox } from "../lib/sandbox.js";
import { runInSimulatorScope } from "../lib/messaging.js";
import { handleMessage } from "./conversation.js";
import { groqAvailable } from "../lib/groq.js";
import { incCounter } from "../lib/metrics.js";
import type { PlatformActor } from "./platform-coops.js";

export const SANDBOX_CODE = "SANDBOX";
export const SANDBOX_NAME = "Sandbox Cooperative";
export const SANDBOX_ADMIN_PHONE = "2349000000005";
const SANDBOX_PIN_HASH = hashPin("1234");

export type SandboxPersonaId =
  | "new_joiner"
  | "active_saver"
  | "overdue_borrower"
  | "guarantor"
  | "admin"
  | "plain_member"
  | "pending_applicant";

export interface SandboxPersona {
  id: SandboxPersonaId;
  name: string;
  phone: string;
  role: "member" | "superadmin";
  member: boolean;
  label: string;
  description: string;
  code?: string;
  balance: number;
  totalSaved: number;
}

export const SANDBOX_PERSONAS: SandboxPersona[] = [
  {
    id: "new_joiner",
    name: "New Joiner",
    phone: "2349000000001",
    role: "member",
    member: false,
    label: "New Joiner",
    description: "No member row or session",
    balance: 0,
    totalSaved: 0,
  },
  {
    id: "active_saver",
    name: "Ada Active",
    phone: "2349000000002",
    role: "member",
    member: true,
    label: "Active Saver",
    description: "Healthy wallet and three contributions",
    code: "SBXADA",
    balance: 5_000_000,
    totalSaved: 5_000_000,
  },
  {
    id: "overdue_borrower",
    name: "Bola Borrower",
    phone: "2349000000003",
    role: "member",
    member: true,
    label: "Overdue Borrower",
    description: "Active loan overdue by ten days",
    code: "SBXBOLA",
    balance: 200_000,
    totalSaved: 200_000,
  },
  {
    id: "guarantor",
    name: "Grace Guarantor",
    phone: "2349000000004",
    role: "member",
    member: true,
    label: "Guarantor",
    description: "Confirmed guarantor on Bola's loan",
    code: "SBXGRACE",
    balance: 2_000_000,
    totalSaved: 2_000_000,
  },
  {
    id: "admin",
    name: "Sam Superadmin",
    phone: SANDBOX_ADMIN_PHONE,
    role: "superadmin",
    member: true,
    label: "Superadmin",
    description: "Admin command surface",
    code: "SBXSAM",
    balance: 0,
    totalSaved: 0,
  },
  {
    id: "plain_member",
    name: "Peter Plain",
    phone: "2349000000006",
    role: "member",
    member: true,
    label: "Plain Member",
    description: "No loans or special state",
    code: "SBXPETER",
    balance: 500_000,
    totalSaved: 500_000,
  },
  {
    id: "pending_applicant",
    name: "Paul Pending",
    phone: "2349000000007",
    role: "member",
    member: true,
    label: "Pending Loan",
    description: "Pending ₦80,000 loan",
    code: "SBXPAUL",
    balance: 3_000_000,
    totalSaved: 3_000_000,
  },
];

export function getSandboxPersona(id: string): SandboxPersona | null {
  if (!isSandboxPersonaId(id)) return null;
  return SANDBOX_PERSONAS.find((persona) => persona.id === id) ?? null;
}

export function isSandboxPersonaId(id: string): id is SandboxPersonaId {
  return SANDBOX_PERSONAS.some((persona) => persona.id === id);
}

export interface SandboxState {
  session: { state: string; data: unknown } | null;
  wallet: { balanceKobo: number; totalSavedKobo: number } | null;
  loans: Array<{
    id: string;
    amountKobo: number;
    balanceKobo: number;
    status: string;
    dueDate: Date | null;
  }>;
}

export async function getSandboxOverview(): Promise<{
  cooperative: { id: string; name: string; code: string; status: string };
  personas: Array<
    SandboxPersona & {
      walletKobo: number | null;
      loan: { count: number; overdue: number };
    }
  >;
  ai: { available: boolean; provider: string };
}> {
  const { cooperativeId } = await ensureSandbox();
  const [cooperative, personaData] = await Promise.all([
    ownerPrisma.cooperative.findUnique({
      where: { id: cooperativeId },
      select: { id: true, name: true, code: true, status: true },
    }),
    withCoopContext(cooperativeId, async () => {
      const members = await prisma.member.findMany({
        where: { cooperativeId },
        select: { id: true, phone: true, wallet: { select: { balance: true } } },
      });
      const loans = await prisma.loan.findMany({
        where: { cooperativeId, status: "disbursed", balance: { gt: 0 } },
        select: { member: { select: { phone: true } }, dueDate: true },
      });
      const loansByPhone = new Map<string, { count: number; overdue: number }>();
      for (const loan of loans) {
        const stats = loansByPhone.get(loan.member.phone) ?? { count: 0, overdue: 0 };
        stats.count++;
        if (loan.dueDate && loan.dueDate.getTime() < Date.now()) stats.overdue++;
        loansByPhone.set(loan.member.phone, stats);
      }
      return new Map(
        members.map((member) => [
          member.phone,
          {
            walletKobo: member.wallet?.balance ?? null,
            loan: loansByPhone.get(member.phone) ?? { count: 0, overdue: 0 },
          },
        ]),
      );
    }),
  ]);
  if (!cooperative) throw new Error("Sandbox cooperative could not be loaded");
  return {
    cooperative,
    personas: SANDBOX_PERSONAS.map((persona) => ({
      ...persona,
      walletKobo: personaData.get(persona.phone)?.walletKobo ?? null,
      loan: personaData.get(persona.phone)?.loan ?? { count: 0, overdue: 0 },
    })),
    ai: { available: groqAvailable(), provider: "groq" },
  };
}

function parseSessionData(value: string): unknown {
  return JSON.parse(value);
}

export async function getSandboxState(
  personaId: SandboxPersonaId,
): Promise<{ state: SandboxState; ai: { available: boolean; provider: string } }> {
  const persona = getSandboxPersona(personaId);
  if (!persona) throw new Error("unknown sandbox persona");
  const { cooperativeId } = await ensureSandbox();
  const state = await withCoopContext(cooperativeId, async () => {
    const member = persona.member
      ? await prisma.member.findUnique({
          where: { cooperativeId_phone: { cooperativeId, phone: persona.phone } },
          select: { id: true },
        })
      : null;
    const [session, wallet, loans] = await Promise.all([
      prisma.session.findUnique({
        where: { phone: persona.phone },
        select: { state: true, data: true },
      }),
      member
        ? prisma.wallet.findUnique({
            where: { memberId: member.id },
            select: { balance: true, totalSaved: true },
          })
        : Promise.resolve(null),
      member
        ? prisma.loan.findMany({
            where: { cooperativeId, memberId: member.id },
            orderBy: { createdAt: "desc" },
            select: { id: true, amount: true, balance: true, status: true, dueDate: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      session: session ? { state: session.state, data: parseSessionData(session.data) } : null,
      wallet: wallet ? { balanceKobo: wallet.balance, totalSavedKobo: wallet.totalSaved } : null,
      loans: loans.map((loan) => ({
        id: loan.id,
        amountKobo: loan.amount,
        balanceKobo: loan.balance,
        status: loan.status,
        dueDate: loan.dueDate,
      })),
    };
  });
  return { state, ai: { available: groqAvailable(), provider: "groq" } };
}

export async function runSandboxTurn(input: {
  personaId: SandboxPersonaId;
  text: string;
  aiEnabled: boolean;
}): Promise<{
  messages: Array<{
    to: string;
    toName: string;
    type: string;
    text?: string;
    filename?: string;
    mimeType?: string;
    caption?: string;
    header?: string;
    footer?: string;
    buttons?: Array<{ id: string; title: string }>;
    timestamp: string;
  }>;
  state: SandboxState;
  ai: { mode: "live" | "deterministic"; path: "ai" | "rules" | "guardrail" };
  durationMs: number;
}> {
  const persona = getSandboxPersona(input.personaId);
  if (!persona) throw new Error("unknown sandbox persona");
  const startedAt = Date.now();
  return withSandboxTurn(async () => {
    const { cooperativeId } = await ensureSandbox();
    const simulated = await runInSimulatorScope(persona.phone, async () => {
      const sandbox = await runInSandbox(
        cooperativeId,
        () => handleMessage(persona.phone, input.text),
        { aiEnabled: input.aiEnabled },
      );
      return sandbox;
    });
    const sandboxResult = simulated.result;
    const stateResult = await getSandboxState(input.personaId);
    const namesByPhone = new Map(SANDBOX_PERSONAS.map((entry) => [entry.phone, entry.name]));
    return {
      messages: simulated.messages.map((message) => ({
        ...message,
        toName: namesByPhone.get(message.to) ?? "Unknown sandbox recipient",
      })),
      state: stateResult.state,
      ai: {
        mode: sandboxResult.meta.aiPath === "ai" ? "live" : "deterministic",
        path: sandboxResult.meta.aiPath,
      },
      durationMs: Date.now() - startedAt,
    };
  });
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function ensureLoan(
  cooperativeId: string,
  memberId: string,
  status: string,
  data: {
    amount: number;
    balance: number;
    tenureMonths: number;
    monthlyPayment: number;
    dueDate?: Date;
    disbursedAt?: Date;
  },
) {
  const existing = await prisma.loan.findFirst({
    where: { cooperativeId, memberId, status },
  });
  if (existing) return existing;
  return prisma.loan.create({
    data: {
      cooperativeId,
      memberId,
      status,
      amount: data.amount,
      balance: data.balance,
      tenureMonths: data.tenureMonths,
      monthlyPayment: data.monthlyPayment,
      dueDate: data.dueDate,
      disbursedAt: data.disbursedAt,
      adminCharge: 200_000,
    },
  });
}

async function seedSandbox(cooperativeId: string): Promise<void> {
  await withCoopContext(cooperativeId, async () => {
    await prisma.cooperativeConfig.upsert({
      where: { cooperativeId },
      update: {},
      create: {
        cooperativeId,
        requireGuarantors: true,
        minGuarantors: 1,
        autoApproveLoans: false,
        minContribution: 200_000,
      },
    });

    const members = new Map<SandboxPersonaId, { id: string }>();
    for (const persona of SANDBOX_PERSONAS) {
      if (!persona.member) continue;
      const member = await prisma.member.upsert({
        where: { cooperativeId_phone: { cooperativeId, phone: persona.phone } },
        update: {},
        create: {
          cooperativeId,
          phone: persona.phone,
          name: persona.name,
          code: persona.code!,
          role: persona.role,
          status: "active",
          kycStatus: "verified",
          pin: SANDBOX_PIN_HASH,
          consentAt: new Date(),
          aiConsentAt: new Date(),
        },
      });
      members.set(persona.id, member);
      await prisma.wallet.upsert({
        where: { memberId: member.id },
        update: {},
        create: {
          memberId: member.id,
          balance: persona.balance,
          totalSaved: persona.totalSaved,
        },
      });
    }

    const ada = members.get("active_saver");
    if (ada) {
      const contributions = [
        { amount: 1_000_000, note: "First savings" },
        { amount: 1_500_000, note: "Weekly savings" },
        { amount: 2_500_000, note: "Monthly savings" },
      ];
      for (const [index, contribution] of contributions.entries()) {
        await prisma.contribution.upsert({
          where: { reference: `SBX-ADA-${index + 1}` },
          update: {},
          create: {
            cooperativeId,
            memberId: ada.id,
            amount: contribution.amount,
            reference: `SBX-ADA-${index + 1}`,
            note: contribution.note,
            status: "confirmed",
            paidAt: daysAgo(30 - index * 10),
          },
        });
      }
    }

    const borrower = members.get("overdue_borrower");
    const overdueLoan = borrower
      ? await ensureLoan(cooperativeId, borrower.id, "disbursed", {
          amount: 12_000_000,
          balance: 12_000_000,
          tenureMonths: 6,
          monthlyPayment: 2_000_000,
          dueDate: daysAgo(10),
          disbursedAt: daysAgo(40),
        })
      : null;

    const guarantor = members.get("guarantor");
    if (overdueLoan && guarantor) {
      await prisma.guarantor.upsert({
        where: { loanId_memberId: { loanId: overdueLoan.id, memberId: guarantor.id } },
        update: {},
        create: {
          loanId: overdueLoan.id,
          memberId: guarantor.id,
          code: "SBX-G001",
          status: "confirmed",
          confirmedAt: new Date(),
        },
      });
    }

    const pending = members.get("pending_applicant");
    if (pending) {
      await ensureLoan(cooperativeId, pending.id, "pending", {
        amount: 8_000_000,
        balance: 8_000_000,
        tenureMonths: 3,
        monthlyPayment: 2_800_000,
      });
    }
  });
}

/** Idempotently provision a dedicated cooperative and synthetic member fixtures. */
export async function ensureSandbox(): Promise<{ cooperativeId: string }> {
  let coop = await ownerPrisma.cooperative.findUnique({ where: { code: SANDBOX_CODE } });
  if (coop && !coop.isSandbox) {
    throw new Error("The reserved SANDBOX cooperative code is already in use");
  }
  if (!coop) {
    try {
      coop = await ownerPrisma.cooperative.create({
        data: {
          name: SANDBOX_NAME,
          code: SANDBOX_CODE,
          country: "NG",
          currency: "NGN",
          locale: "en",
          adminPhone: SANDBOX_ADMIN_PHONE,
          status: "active",
          isSandbox: true,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      coop = await ownerPrisma.cooperative.findUnique({ where: { code: SANDBOX_CODE } });
      if (!coop?.isSandbox) {
        throw new Error("Could not provision the sandbox cooperative", { cause: error });
      }
    }
  } else if (coop.status !== "active") {
    coop = await ownerPrisma.cooperative.update({
      where: { id: coop.id },
      data: { status: "active" },
    });
  }
  await seedSandbox(coop.id);
  return { cooperativeId: coop.id };
}

const RESET_EXCLUDED_MODELS = new Set(["PlatformAuditLog"]);

function prismaClientKey(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

/** Delete sandbox-scoped rows, keep the cooperative, reseed fixtures, and audit. */
export async function resetSandbox(
  actor: PlatformActor,
): Promise<{ cooperativeId: string; deleted: Record<string, number> }> {
  return withSandboxResetFlag(async () => {
    await assertNoActiveTurns();
    const { cooperativeId } = await ensureSandbox();
    await resetRateLimitPrefix("sandbox:rl:turn:");
    const members = await withCoopContext(cooperativeId, () =>
      prisma.member.findMany({
        where: { cooperativeId },
        select: { id: true },
      }),
    );
    const memberIds = members.map((member) => member.id);

    const coopScopedModels = Prisma.dmmf.datamodel.models
      .filter(
        (model) =>
          !RESET_EXCLUDED_MODELS.has(model.name) &&
          model.fields.some((field) => field.name === "cooperativeId" && field.kind === "scalar"),
      )
      .reverse();
    const coopScopedNames = new Set(coopScopedModels.map((model) => model.name));
    const memberScopedModels = Prisma.dmmf.datamodel.models
      .filter(
        (model) =>
          !RESET_EXCLUDED_MODELS.has(model.name) &&
          !coopScopedNames.has(model.name) &&
          model.fields.some((field) => field.name === "memberId" && field.kind === "scalar"),
      )
      .reverse();

    const pending = new Map<string, { key: string; where: Record<string, unknown> }>([
      ...coopScopedModels.map(
        (model) =>
          [model.name, { key: prismaClientKey(model.name), where: { cooperativeId } }] as const,
      ),
      ...memberScopedModels.map(
        (model) =>
          [
            model.name,
            { key: prismaClientKey(model.name), where: { memberId: { in: memberIds } } },
          ] as const,
      ),
    ]);
    const deleted: Record<string, number> = {};
    const deleteErrors = new Map<string, unknown>();

    for (let pass = 0; pass < 8 && pending.size > 0; pass++) {
      let progress = false;
      for (const [name, target] of [...pending]) {
        try {
          const count = await withCoopContext(cooperativeId, async () => {
            const delegate = (
              prisma as unknown as Record<
                string,
                { deleteMany: (args: unknown) => Promise<{ count: number }> }
              >
            )[target.key];
            if (!delegate) throw new Error(`Unknown Prisma model delegate: ${target.key}`);
            const result = await delegate.deleteMany({ where: target.where });
            return result.count;
          });
          deleted[name] = (deleted[name] ?? 0) + count;
          pending.delete(name);
          deleteErrors.delete(name);
          progress = true;
        } catch (error) {
          deleteErrors.set(name, error);
        }
      }
      if (!progress) break;
    }

    if (pending.size > 0) {
      const blocked = [...pending.keys()]
        .map((name) => {
          const error = deleteErrors.get(name);
          const message = error instanceof Error ? error.message : "delete failed";
          return `${name}: ${message.slice(0, 120)}`;
        })
        .join("; ");
      throw new Error(`sandbox reset could not clear ${blocked}`);
    }

    const phones = SANDBOX_PERSONAS.map((persona) => persona.phone);
    const sessions = await prisma.session.deleteMany({ where: { phone: { in: phones } } });
    const failures = await prisma.webhookFailure.deleteMany({
      where: { phone: { in: phones } },
    });
    deleted.Session = sessions.count;
    deleted.WebhookFailure = failures.count;

    clearMemberCache();
    for (const persona of SANDBOX_PERSONAS) {
      invalidateMemberCache(persona.phone, cooperativeId);
    }
    invalidateCoopMeta(cooperativeId);
    await seedSandbox(cooperativeId);
    incCounter("sandbox_resets_total");

    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "sandbox.reset",
      cooperativeId,
      targetType: "sandbox",
      targetId: cooperativeId,
      detail: JSON.stringify({ deleted }),
    });

    return { cooperativeId, deleted };
  });
}
