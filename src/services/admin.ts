import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { approveLoan, listPendingLoans, rejectLoan } from "./loans.js";
import { formatBalance } from "./cooperative.js";
import { sendToBank } from "./disbursements.js";
import { broadcastToScope, createUnit, listUnits, setUnitAdmin, unitAdminOf } from "./units.js";
import { distributeDividend } from "./dividends.js";
import { setInterestRate } from "./scheduler.js";
import {
  approveWithdrawal,
  finalizeWithdrawal,
  rejectWithdrawal,
  overrideWithdrawalRule,
} from "./withdrawals.js";
import {
  startDeathClaim,
  setClaimBank,
  approveClaim,
  rejectClaim,
} from "./deathclaims.js";
import { audit, recentAudit } from "./audit.js";

/** Is this phone an admin or super admin of some cooperative? */
export async function isAdmin(phone: string): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { phone, role: { in: ["admin", "superadmin"] } } });
  return member !== null;
}

export async function makeAdmin(phone: string): Promise<void> {
  await prisma.member.updateMany({ where: { phone }, data: { role: "admin" } });
}

/** Super admin = explicit role OR the cooperative's registered adminPhone. */
export async function isSuperAdmin(phone: string, cooperativeId?: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { phone, ...(cooperativeId ? { cooperativeId } : {}) },
    include: { cooperative: true },
  });
  if (!member) return false;
  return member.role === "superadmin" || member.cooperative.adminPhone === member.phone;
}

interface AdminContext {
  admin: { id: string; phone: string; name: string; role: string; cooperativeId: string };
  coop: { id: string; name: string; adminPhone: string | null };
  unitAdmin: Awaited<ReturnType<typeof unitAdminOf>>;
  isSuper: boolean;
}

/** Resolve an admin's access scope: coop-level or a single unit. */
async function adminContext(phone: string): Promise<AdminContext | null> {
  const admin = await prisma.member.findFirst({
    where: { phone, role: { in: ["admin", "superadmin"] } },
    include: { cooperative: true },
  });
  if (!admin) return null;
  const coop = admin.cooperative;
  const isSuper = admin.role === "superadmin" || coop.adminPhone === admin.phone;
  // Super admins are always coop-wide; plain admins may be scoped to a unit.
  const unitAdmin = isSuper ? null : await unitAdminOf(admin);
  return { admin, coop, unitAdmin, isSuper };
}

function roleLabel(ctx: AdminContext): string {
  if (ctx.isSuper) return "superadmin";
  return ctx.unitAdmin ? "unit admin" : "admin";
}

/** Execute an admin command from chat. Returns true if handled as admin. */
export async function handleAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  const ctx = await adminContext(phone);
  if (!ctx) return false;
  const { admin, coop, unitAdmin, isSuper } = ctx;
  const coopId = admin.cooperativeId;

  switch (cmd) {
    case "pending": {
      const loans = await listPendingLoans(coopId);
      const scoped = unitAdmin
        ? loans.filter((l) => l.member.unitId === unitAdmin.unit.id)
        : loans;
      await sendPendingLoans(phone, scoped, unitAdmin !== null);
      return true;
    }

    case "approve": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can approve loans." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *approve <loan id>*" });
        return true;
      }
      const result = await approveLoan(id, { superAdmin: isSuper, actorId: admin.id });
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: isSuper ? "loan.final_approve" : "loan.admin_approve",
        targetType: "loan",
        detail: result.message,
      });
      return true;
    }

    case "reject": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can reject loans." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *reject <loan id>*" });
        return true;
      }
      const result = await rejectLoan(id);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "loan.reject",
        targetType: "loan",
        detail: result.message,
      });
      return true;
    }

    case "payout": {
      // Money out of a member's wallet — super admin only, real bank details,
      // wallet debited, everything audited.
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can make payouts." });
        return true;
      }
      const amount = Number(args[0]);
      const targetPhone = args[1]?.replace(/[^0-9]/g, "");
      if (!Number.isFinite(amount) || amount <= 0 || !targetPhone) {
        await sendText({ to: phone, text: "Usage: *payout <amount> <member phone>*, e.g. *payout 5000 2348012345678*" });
        return true;
      }
      await handlePayout(ctx, amount, targetPhone);
      return true;
    }

    case "approvewithdraw":
    case "approvewdraw": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can approve withdrawals." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *approvewithdraw <request id>*" });
        return true;
      }
      const result = await approveWithdrawal(id, { id: admin.id, role: admin.role, phone });
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: isSuper ? "withdraw.final_approve" : "withdraw.admin_approve",
        targetType: "withdrawal",
        targetId: id,
        detail: result.message,
      });
      return true;
    }

    case "finalize": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can give the final approval." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *finalize <request id>*" });
        return true;
      }
      const result = await finalizeWithdrawal(id, { id: admin.id, role: admin.role, phone });
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "withdraw.finalize",
        targetType: "withdrawal",
        targetId: id,
        detail: result.message,
      });
      return true;
    }

    case "rejectwithdraw": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can reject withdrawals." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *rejectwithdraw <request id>*" });
        return true;
      }
      const result = await rejectWithdrawal(id);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "withdraw.reject",
        targetType: "withdrawal",
        targetId: id,
        detail: result.message,
      });
      return true;
    }

    case "overridewithdrawal": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can grant overrides." });
        return true;
      }
      const targetPhone = args[0]?.replace(/[^0-9]/g, "");
      if (!targetPhone) {
        await sendText({ to: phone, text: "Usage: *overridewithdrawal <member phone>* — lets them withdraw before 6 months." });
        return true;
      }
      const result = await overrideWithdrawalRule(phone, targetPhone);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "withdraw.override",
        targetType: "member",
        detail: result.message,
      });
      return true;
    }

    case "pendingwithdraw": {
      const requests = await prisma.withdrawalRequest.findMany({
        where: { cooperativeId: coopId, status: { in: ["pending", "admin_approved"] } },
        include: { member: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      if (requests.length === 0) {
        await sendText({ to: phone, text: "No withdrawal requests waiting. ✅" });
        return true;
      }
      const body = requests
        .map((r) =>
          `• *${r.id.slice(-6)}* — ${r.member.name} — ${formatBalance(r.amount)}\n` +
          `   ${r.status === "pending"
            ? `Admin approves: *approvewdraw ${r.id.slice(-6)}*`
            : `Awaiting super admin: *finalize ${r.id.slice(-6)}*`}`,
        )
        .join("\n");
      await sendText({ to: phone, text: `*Withdrawal requests*\n\n${body}` });
      return true;
    }

    case "deathclaim": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can open death claims." });
        return true;
      }
      const code = args[0];
      if (!code) {
        await sendText({ to: phone, text: "Usage: *deathclaim <member code>*" });
        return true;
      }
      const result = await startDeathClaim(phone, code);
      await sendText({ to: phone, text: result.message });
      if (result.ok && result.claimId) {
        // The next message from this admin is treated as the certificate upload.
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_death_cert", data: JSON.stringify({ deathClaimId: result.claimId }) },
          update: { state: "awaiting_death_cert", data: JSON.stringify({ deathClaimId: result.claimId }) },
        });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: roleLabel(ctx),
          action: "claim.open",
          targetType: "deathclaim",
          targetId: result.claimId,
          detail: result.message,
        });
      }
      return true;
    }

    case "claimbank": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can set the family's bank." });
        return true;
      }
      const claimCode = args[0];
      const account = args[1];
      const bank = args.slice(2).join(" ");
      if (!claimCode || !account || !bank) {
        await sendText({ to: phone, text: "Usage: *claimbank <claim id> <account number> <bank>*, e.g. *claimbank ABC123 0123456789 Access*" });
        return true;
      }
      const result = await setClaimBank(phone, claimCode, account, bank);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "claim.set_bank",
        targetType: "deathclaim",
        targetId: claimCode,
        detail: result.message,
      });
      return true;
    }

    case "approveclaim": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can give the final approval on a death claim." });
        return true;
      }
      const claimCode = args[0];
      if (!claimCode) {
        await sendText({ to: phone, text: "Usage: *approveclaim <claim id>*" });
        return true;
      }
      const result = await approveClaim(phone, claimCode);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "claim.payout",
        targetType: "deathclaim",
        targetId: claimCode,
        detail: result.message,
      });
      return true;
    }

    case "rejectclaim": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can reject claims." });
        return true;
      }
      const claimCode = args[0];
      if (!claimCode) {
        await sendText({ to: phone, text: "Usage: *rejectclaim <claim id>*" });
        return true;
      }
      const result = await rejectClaim(phone, claimCode);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "claim.reject",
        targetType: "deathclaim",
        targetId: claimCode,
        detail: result.message,
      });
      return true;
    }

    case "pendingclaims": {
      const claims = await prisma.deathClaim.findMany({
        where: { cooperativeId: coopId, status: { in: ["awaiting_certificate", "awaiting_validation", "validated"] } },
        include: { member: { select: { name: true } }, validations: { select: { memberId: true } } },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      if (claims.length === 0) {
        await sendText({ to: phone, text: "No death claims in progress." });
        return true;
      }
      const body = claims
        .map((c) => {
          const stage =
            c.status === "awaiting_certificate"
              ? "⏳ awaiting certificate"
              : c.status === "awaiting_validation"
                ? `⏳ validation ${c.validations.length}/2`
                : "✅ validated — ready for super admin";
          return `• *${c.id.slice(-6)}* — ${c.member.name} (${stage})`;
        })
        .join("\n");
      await sendText({ to: phone, text: `*Death claims*\n\n${body}` });
      return true;
    }

    case "setrole": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can set roles." });
        return true;
      }
      const code = args[0]?.toUpperCase();
      const role = args[1]?.toLowerCase();
      if (!code || !["member", "admin", "superadmin", "support"].includes(role ?? "")) {
        await sendText({ to: phone, text: "Usage: *setrole <member code> <member|admin|superadmin|support>*" });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member with code *${code}* in your cooperative.` });
        return true;
      }
      if (target.id === admin.id) {
        await sendText({ to: phone, text: "You can't change your own role." });
        return true;
      }
      await prisma.member.update({ where: { id: target.id }, data: { role } });
      await sendText({ to: phone, text: `✅ ${target.name} is now *${role}*.`, });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "role.set",
        targetType: "member",
        targetId: target.id,
        detail: `${target.name} -> ${role}`,
      });
      return true;
    }

    case "audit": {
      const entries = await recentAudit(coopId);
      if (entries.length === 0) {
        await sendText({ to: phone, text: "No audit entries yet." });
        return true;
      }
      const body = entries
        .map((e) => `• ${e.createdAt.toISOString().slice(5, 16).replace("T", " ")} — ${e.actorPhone.slice(-4)} (${e.actorRole ?? "?"}) ${e.action}${e.targetId ? ` ${e.targetId.slice(-6)}` : ""}`)
        .join("\n");
      await sendText({ to: phone, text: `*Recent activity*\n\n${body}` });
      return true;
    }

    case "broadcast": {
      const message = args.join(" ").trim();
      if (!message) {
        await sendText({ to: phone, text: "Usage: *broadcast <message>* to send to all members (or *broadcast unit <message>* to your workplace)." });
        return true;
      }
      const scope = args[0] === "unit" ? "unit" : "coop";
      const body = scope === "unit" ? args.slice(1).join(" ") : message;
      const result = await broadcastToScope({ senderPhone: phone, message: body, scope });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "addunit": {
      const name = args.slice(0, -1).join(" ");
      const code = args[args.length - 1];
      if (!name || !code) {
        await sendText({ to: phone, text: "Usage: *addunit <name> <code>*, e.g. *addunit Lagos Office LAG01*." });
        return true;
      }
      const result = await createUnit(phone, name, code);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "unitadmin": {
      const unitCode = args[0];
      const memberCode = args[1];
      if (!unitCode || !memberCode) {
        await sendText({ to: phone, text: "Usage: *unitadmin <unit code> <member code>*, e.g. *unitadmin LAG01 ABC123-DEFG*." });
        return true;
      }
      const result = await setUnitAdmin(phone, unitCode, memberCode);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "units": {
      const result = await listUnits(phone);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "interest": {
      const rate = Number(args[0]);
      if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
        await sendText({ to: phone, text: "Usage: *interest <rate%>*, e.g. *interest 2* for 2%/month on loans." });
        return true;
      }
      const result = await setInterestRate(phone, rate);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "paydividend": {
      // Dividends credit wallets — money movement needs the super admin.
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can distribute dividends." });
        return true;
      }
      const rate = Number(args[0]);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
        await sendText({ to: phone, text: "Usage: *paydividend <rate%>*, e.g. *paydividend 5* to pay a 5% dividend." });
        return true;
      }
      const result = await distributeDividend(phone, rate);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "dividend.distribute",
        detail: result.message,
      });
      return true;
    }

    default:
      return false;
  }
}

async function sendPendingLoans(phone: string, loans: Awaited<ReturnType<typeof listPendingLoans>>, scoped: boolean): Promise<void> {
  if (loans.length === 0) {
    await sendText({ to: phone, text: "No pending loan applications. ✅" });
    return;
  }
  const body = loans
    .map((l) => {
      const g = l.guarantors.map((x) => `${x.member.name} (${x.status})`).join(", ") || "none yet";
      const stage =
        l.status === "guaranteed"
          ? "Reply *approve <id>* (admin)"
          : l.status === "admin_approved"
            ? "⏳ awaiting *super admin* final approval"
            : "⏳ waiting for guarantors";
      return (
        `• *${l.id.slice(-6)}* — ${l.member.name} — ${formatBalance(l.amount)} for ${l.tenureMonths}mo\n` +
        `   Guarantors: ${g}\n` +
        `   ${stage}`
      );
    })
    .join("\n");
  await sendText({
    to: phone,
    text: `${scoped ? "*Pending loans — your workplace*\n\n" : "*Pending loan applications*\n\n"}${body}`,
  });
}

/**
 * Super-admin payout: pays from the member's WALLET to their bank on file,
 * name-verified by the provider, wallet debited atomically.
 */
async function handlePayout(ctx: AdminContext, amount: number, targetPhone: string): Promise<void> {
  const { admin, coop } = ctx;
  const target = await prisma.member.findFirst({
    where: { cooperativeId: coop.id, phone: targetPhone },
    include: { wallet: true },
  });
  if (!target) {
    await sendText({ to: admin.phone, text: `No member found with phone ${targetPhone} in your cooperative.` });
    return;
  }
  if (!target.bankAccountNumber || !target.bankCode) {
    await sendText({ to: admin.phone, text: `${target.name} has no bank account on file. They should reply *withdraw <amount>* once to save their bank details first.` });
    return;
  }
  const balance = target.wallet?.balance ?? 0;
  if (balance < amount) {
    await sendText({ to: admin.phone, text: `${target.name}'s wallet has ${formatBalance(balance)} — less than ${formatBalance(amount)}. No money moved.` });
    return;
  }

  const result = await sendToBank({
    memberId: target.id,
    amount,
    bankAccountNumber: target.bankAccountNumber,
    bankCode: target.bankCode,
    bankName: target.bankName ?? undefined,
    note: `Super admin payout to ${target.name}`,
  });
  if (!result.ok) {
    await sendText({ to: admin.phone, text: `Payout failed: ${result.message}` });
    return;
  }

  // Money moved — debit the wallet.
  const debited = await prisma.wallet.updateMany({
    where: { memberId: target.id, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  });
  if (debited.count === 0) {
    await sendText({ to: admin.phone, text: `⚠️ Payout sent but wallet debit failed (insufficient balance race). Investigate immediately.` });
    return;
  }

  await audit({
    cooperativeId: coop.id,
    actorPhone: admin.phone,
    actorId: admin.id,
    actorRole: "superadmin",
    action: "payout.send",
    targetType: "member",
    targetId: target.id,
    detail: `${formatBalance(amount)} to ${target.name}`,
  });

  await sendText({
    to: admin.phone,
    text: `Payout of ${formatBalance(amount)} to *${target.name}* was sent ✅ and their wallet debited.`,
  });
}
