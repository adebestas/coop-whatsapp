import { prisma } from "../lib/prisma.js";
import { sendText, notifyMember } from "../lib/messaging.js";
import { cacheDel } from "../lib/cache.js";
import { listPosts, normalizeTitle, displayTitle } from "./posts.js";
import { buildBatch, submitBatch, approveBatch, rejectBatch, setCommitment, waiveMonth } from "./deductions.js";
import { approveLoan, listPendingLoans, rejectLoan } from "./loans.js";
import { formatBalance } from "./cooperative.js";
import { sendToBank } from "./disbursements.js";
import { broadcastToScope, createUnit, listUnits, setUnitAdmin, unitAdminOf } from "./units.js";
import { distributeDividend, getFundBalances } from "./dividends.js";
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
  confirmFamily,
} from "./deathclaims.js";
import { audit, recentAudit } from "./audit.js";
import { computePnl, getMonthlySummary, recordLedger } from "./ledger.js";
import {
  requestExternalPayment,
  approveExternalPayment,
  rejectExternalPayment,
  listPendingExternal,
} from "./payanyone.js";
import {
  startBuyPoll,
  addPollOption,
  closeBuyPoll,
  listBuyPolls,
} from "./buypoll.js";
import { payrollOverview, runPayroll, setSalary } from "./payroll.js";
import { runExport, type ExportKind } from "./exports.js";
import { checkDailyPayoutLimit, checkVelocity } from "./fraud.js";
import { runBackup } from "./backup.js";
import { runReconciliation } from "./reconcile.js";
import { runWalletReconciliation } from "./reconciliation.js";
import { getSegregationReport, getReserveReport } from "./reconciliation.js";
import { resolveProvider } from "./payments/index.js";
import { assertMoneyAuthorized, assertFreshPin, disable2fa, enable2fa, refreshPin } from "./auth2fa.js";
import { getCoopConfig, updateCoopConfig, getBranding, getSubscription } from "./coop-config.js";

/**
 * Commands that move (or can move) money out. Each must pass the 2FA gate
 * (live authenticator code when enrolled) before its handler runs.
 */
const MONEY_OUT_COMMANDS = new Set([
  "approve",
  "approvewithdraw",
  "approvewdraw",
  "finalize",
  "payout",
  "approveclaim",
  "approvepay",
  "runpayroll",
]);

/** Send the guard failure text and return true (command handled). */
async function guardFailed(phone: string, message?: string): Promise<boolean> {
  await sendText({ to: phone, text: message ?? "⛔ Not allowed." });
  return true;
}

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
  admin: { id: string; phone: string; name: string; email: string | null; role: string; cooperativeId: string };
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

  // Security gates for account management.
  if (cmd === "enable2fa") {
    const r = await enable2fa(phone);
    await sendText({ to: phone, text: r.message });
    return true;
  }
  if (cmd === "disable2fa") {
    const r = await disable2fa(phone);
    await sendText({ to: phone, text: r.message });
    return true;
  }
  if (cmd === "verifypin") {
    if (!args[0]) {
      await sendText({ to: phone, text: "Usage: *verifypin <your PIN>* — unlocks large payouts for 10 minutes." });
      return true;
    }
    const r = await refreshPin(phone, args[0]);
    await sendText({ to: phone, text: r.message });
    return true;
  }

  // 2FA gate on every money-out command (consumes a trailing TOTP code).
  if (MONEY_OUT_COMMANDS.has(cmd)) {
    const guard = await assertMoneyAuthorized(admin.id, args);
    if (!guard.ok) return guardFailed(phone, guard.message);
    args = guard.args;
  }

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
      // wallet debited, narration required, everything audited.
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can make payouts." });
        return true;
      }
      const amount = Number(args[0]);
      const targetPhone = args[1]?.replace(/[^0-9]/g, "");
      const narration = args.slice(2).join(" ").trim();
      if (!Number.isFinite(amount) || amount <= 0 || !targetPhone || narration.length < 3) {
        await sendText({
          to: phone,
          text: "Usage: *payout <amount> <member phone> <narration>* — e.g. *payout 5000 2348012345678 October savings refund*. A narration is required on every payment.",
        });
        return true;
      }
      // Large single payouts need a recently verified PIN.
      const pinCheck = await assertFreshPin(phone, amount);
      if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
      await handlePayout(ctx, amount, targetPhone, narration);
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
      // Look up the amount so large payouts require a fresh PIN too.
      const req = await prisma.withdrawalRequest.findFirst({
        where: { OR: [{ id }, { id: { startsWith: id } }, { id: { endsWith: id } }] },
      });
      if (req) {
        const pinCheck = await assertFreshPin(phone, req.amount);
        if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
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
      const familyPhone = args[1];
      if (!code || !familyPhone) {
        await sendText({ to: phone, text: "Usage: *deathclaim <member code> <family phone>*" });
        return true;
      }
      const result = await startDeathClaim(phone, code, familyPhone);
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

    case "members": {
      const members = await prisma.member.findMany({
        where: { cooperativeId: coopId },
        select: {
          name: true,
          code: true,
          role: true,
          status: true,
          createdAt: true,
          phone: true,
          wallet: { select: { balance: true } },
        },
        orderBy: { name: "asc" },
      });
      if (members.length === 0) {
        await sendText({ to: phone, text: "No members in this cooperative." });
        return true;
      }
      const body = members.map((m) =>
        `• *${m.name}* (${m.code}) — ${m.role}, ${m.status}\n  Joined: ${m.createdAt.toLocaleDateString("en-GB")} · Balance: ${formatBalance(m.wallet?.balance ?? 0)}`,
      ).join("\n");
      await sendText({ to: phone, text: `*Members (${members.length})*\n\n${body}` });
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
      // Interest is now tiered automatically by tenure.
      await sendText({
        to: phone,
        text:
          "*Loan interest (automatic tiers)*\n\n" +
          "• Up to 3 months: *5% flat*\n" +
          "• 4–6 months: *8% flat*\n" +
          "• 7–9 months: *9% flat*\n" +
          "• 10–12 months: *10% flat*\n\n" +
          `Admin charge per loan: ${formatBalance(2000)} (deducted at disbursement).`,
      });
      return true;
    }

    case "pnl": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can view profit & loss." });
        return true;
      }
      
      const arg = args.join(" ").trim().toLowerCase();
      let pnl;
      
      if (!arg) {
        // No args - show all time
        pnl = await computePnl(coopId);
      } else if (arg === "today") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        pnl = await computePnl(coopId, today, new Date());
      } else if (arg === "month" || arg === "this month") {
        const now = new Date();
        pnl = await getMonthlySummary(coopId, now.getFullYear(), now.getMonth());
      } else if (arg === "last month") {
        const now = new Date();
        const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
        const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        pnl = await getMonthlySummary(coopId, year, lastMonth);
      } else if (arg.match(/^\d{4}-\d{2}$/)) {
        // Format: 2026-08
        const [year, month] = arg.split("-").map(Number);
        pnl = await getMonthlySummary(coopId, year, month - 1);
      } else if (arg.includes(" ")) {
        // Format: 2026-08-01 2026-08-31
        const [startStr, endStr] = arg.split(" ");
        const start = new Date(startStr);
        const end = new Date(endStr);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          await sendText({ to: phone, text: "Invalid date format. Use: *pnl 2026-08-01 2026-08-31*" });
          return true;
        }
        pnl = await computePnl(coopId, start, end);
      } else {
        await sendText({
          to: phone,
          text: "Usage:\n• *pnl* — all time\n• *pnl today* — today\n• *pnl month* — this month\n• *pnl last month* — last month\n• *pnl 2026-08* — specific month\n• *pnl 2026-08-01 2026-08-31* — date range",
        });
        return true;
      }
      
      const inc = Object.entries(pnl.incomeByCategory).map(([c, a]) => `• ${c}: +${formatBalance(a)}`);
      const exp = Object.entries(pnl.expenseByCategory).map(([c, a]) => `• ${c}: −${formatBalance(a)}`);
      const periodText = pnl.period ? ` (${pnl.period.start.toLocaleDateString()} - ${pnl.period.end.toLocaleDateString()})` : " (all time)";
      const body = [
        `*📊 Profit & Loss${periodText}*`,
        "",
        "*Income*",
        ...(inc.length > 0 ? inc : ["• (none yet)"]),
        "",
        "*Expenses*",
        ...(exp.length > 0 ? exp : ["• (none yet)"]),
        "",
        `Total income: *${formatBalance(pnl.totalIncome)}*`,
        `Total expenses: *${formatBalance(pnl.totalExpense)}*`,
        `NET ${pnl.netProfit >= 0 ? "PROFIT" : "LOSS"}: *${formatBalance(Math.abs(pnl.netProfit))}*`,
        "",
        "_Dividends are paid from this profit: *paydividend <rate%>*_",
      ];
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "expense": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can record expenses." });
        return true;
      }
      
      const match = args.join(" ").trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        await sendText({
          to: phone,
          text: "Usage: *expense <amount> <category> <description>*\n\nCategories: salary, stipend, purchase, external_payment, other\nExample: *expense 50000 salary August admin salary*",
        });
        return true;
      }
      
      const amount = parseInt(match[1]);
      const category = match[2];
      const description = match[3];
      
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendText({ to: phone, text: "Amount must be a positive number." });
        return true;
      }
      
      const validCategories = ["salary", "stipend", "purchase", "external_payment", "other"];
      if (!validCategories.includes(category)) {
        await sendText({ to: phone, text: `Invalid category. Use: ${validCategories.join(", ")}` });
        return true;
      }
      
      await recordLedger({
        cooperativeId: coopId,
        type: "expense",
        category: category as any,
        amount,
        note: description,
        reference: `EXP-${Date.now()}`,
      });
      
      await sendText({
        to: phone,
        text: `✅ Expense recorded!\n\nAmount: *${formatBalance(amount)}*\nCategory: *${category}*\nDescription: *${description}*`,
      });
      return true;
    }

    case "monthly": {
      const arg = args.join(" ").trim().toLowerCase();
      let year: number;
      let month: number;
      
      if (!arg) {
        const now = new Date();
        year = now.getFullYear();
        month = now.getMonth();
      } else if (arg.match(/^\d{4}-\d{2}$/)) {
        [year, month] = arg.split("-").map(Number);
        month -= 1;
      } else {
        await sendText({ to: phone, text: "Usage: *monthly* or *monthly 2026-08*" });
        return true;
      }
      
      const pnl = await getMonthlySummary(coopId, year, month);
      const monthName = new Date(year, month).toLocaleString("default", { month: "long" });
      
      const inc = Object.entries(pnl.incomeByCategory).map(([c, a]) => `• ${c}: +${formatBalance(a)}`);
      const exp = Object.entries(pnl.expenseByCategory).map(([c, a]) => `• ${c}: −${formatBalance(a)}`);
      
      const body = [
        `*📅 Monthly Report: ${monthName} ${year}*`,
        "",
        "*Income*",
        ...(inc.length > 0 ? inc : ["• (none)"]),
        "",
        "*Expenses*",
        ...(exp.length > 0 ? exp : ["• (none)"]),
        "",
        `Total income: *${formatBalance(pnl.totalIncome)}*`,
        `Total expenses: *${formatBalance(pnl.totalExpense)}*`,
        `NET ${pnl.netProfit >= 0 ? "PROFIT" : "LOSS"}: *${formatBalance(Math.abs(pnl.netProfit))}*`,
      ];
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "fundstatus": {
      const funds = await getFundBalances(coopId);
      const body = [
        `*💰 Cooperative Fund Status*`,
        ``,
        `• Reserve Fund: *${formatBalance(funds.reserve)}*`,
        `• Education Fund: *${formatBalance(funds.education)}*`,
        `• Development Fund: *${formatBalance(funds.development)}*`,
        ``,
        `_These funds are built from statutory deductions on dividend distributions._`,
      ];
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "reservefund": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can view the reserve fund." });
        return true;
      }
      const report = await getReserveReport(coopId);
      await sendText({ to: phone, text: report });
      return true;
    }

    case "payanyone": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Unit admins can't initiate organization payments." });
        return true;
      }
      const amount = Number(args[0]);
      const accountNumber = args[1] ?? "";
      const bankCode = args[2]?.toUpperCase() ?? "";
      const narration = args.slice(3).join(" ").trim();
      if (
        !Number.isFinite(amount) || amount <= 0 ||
        !/^\d{10}$/.test(accountNumber) || !bankCode || narration.length < 3
      ) {
        await sendText({
          to: phone,
          text:
            "Usage: *payanyone <amount> <account number> <bank code> <narration>*\n" +
            "e.g. *payanyone 150000 0123456789 GTB Generator purchase*\n\n" +
            "The beneficiary's name is verified from their bank account, and payment needs *3 super admin approvals*. A narration is required.",
        });
        return true;
      }

      // Resolve + verify the beneficiary's name from their bank account.
      const provider = resolveProvider();
      let beneficiaryName = "";
      if (provider.resolveAccount) {
        const resolved = await provider.resolveAccount({ accountNumber, bankCode });
        if (!resolved.ok || !resolved.name) {
          await sendText({
            to: phone,
            text: `Could not verify that account (${resolved.error ?? "unknown error"}). Check the number and bank code — no request was created.`,
          });
          return true;
        }
        beneficiaryName = resolved.name;
      } else {
        await sendText({ to: phone, text: "Payment provider can't resolve accounts right now — try again later." });
        return true;
      }

      const result = await requestExternalPayment(
        { id: admin.id, name: admin.name, phone, role: admin.role, cooperativeId: coopId },
        { beneficiaryName, accountNumber, bankCode, amount, purpose: narration },
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "approvepay": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only *super admins* approve pay-anyone requests." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *approvepay <request id>*" });
        return true;
      }
      const result = await approveExternalPayment(
        { id: admin.id, name: admin.name, phone, role: admin.role, cooperativeId: coopId },
        id,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "rejectpay": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only *super admins* reject pay-anyone requests." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *rejectpay <request id>*" });
        return true;
      }
      const result = await rejectExternalPayment(
        { id: admin.id, phone, role: admin.role, cooperativeId: coopId },
        id,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "pendingpay": {
      const requests = await listPendingExternal(coopId);
      if (requests.length === 0) {
        await sendText({ to: phone, text: "No pay-anyone requests waiting. ✅" });
        return true;
      }
      const body = requests
        .map((r) => {
          const approvals =
            (r.approved1ById ? 1 : 0) + (r.approved2ById ? 1 : 0) + (r.approved3ById ? 1 : 0);
          return `• *${r.id.slice(-6)}* — ${formatBalance(r.amount)} → ${r.beneficiaryName}\n   by ${r.initiator.name} · "${r.purpose ?? ""}" · ${approvals}/3 approved`;
        })
        .join("\n");
      await sendText({
        to: phone,
        text: `*Pay-anyone requests*\n\n${body}\n\nSupers approve with *approvepay <id>*, reject with *rejectpay <id>*.`,
      });
      return true;
    }

    case "startbuyvote": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only cooperative admins open buy-votes." });
        return true;
      }
      const title = args.join(" ").trim();
      const result = await startBuyPoll(
        { id: admin.id, phone, role: admin.role, cooperativeId: coopId },
        title,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "addoption": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only cooperative admins add options." });
        return true;
      }
      const pollId = args[0];
      const costIdx = args.findIndex((a, i) => i > 0 && /^\d+(\.\d+)?$/.test(a));
      if (!pollId || costIdx === -1) {
        await sendText({ to: phone, text: "Usage: *addoption <poll id> <item name> <cost> <vendor account> <bank>*" });
        return true;
      }
      const name = args.slice(1, costIdx).join(" ");
      const cost = Number(args[costIdx]);
      const account = args[costIdx + 1];
      const bank = args[costIdx + 2]?.toUpperCase();
      const result = await addPollOption(
        { id: admin.id, phone, role: admin.role, cooperativeId: coopId },
        pollId,
        name,
        cost,
        account,
        bank,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "closebuyvote": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only cooperative admins close buy-votes." });
        return true;
      }
      const pollId = args[0];
      if (!pollId) {
        await sendText({ to: phone, text: "Usage: *closebuyvote <poll id>*" });
        return true;
      }
      const result = await closeBuyPoll(
        { id: admin.id, phone, role: admin.role, cooperativeId: coopId },
        pollId,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "buypolls": {
      const polls = await listBuyPolls(coopId);
      if (polls.length === 0) {
        await sendText({ to: phone, text: "No buy-votes yet. Admins open one with *startbuyvote <title>*." });
        return true;
      }
      const parts: string[] = [];
      for (const p of polls) {
        parts.push(
          `🛒 *${p.title}* (${p.status}) — id *${p.id.slice(-6)}*`,
          ...p.options.map((o, i) => `   ${i + 1}. ${o.name} — ~${formatBalance(o.estimatedCost)} — ${o._count.ballots} vote(s)`),
          "",
        );
      }
      await sendText({ to: phone, text: parts.join("\n").trim() });
      return true;
    }

    case "setsalary": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* manages salaries." });
        return true;
      }
      const targetPhone = args[0]?.replace(/[^0-9]/g, "");
      const amountArg = args[1];
      if (!targetPhone || !amountArg) {
        await sendText({ to: phone, text: "Usage: *setsalary <phone> <amount>* or *setsalary <phone> off*" });
        return true;
      }
      const off = amountArg.toLowerCase() === "off";
      const amount = Number(amountArg);
      if (!off && (!Number.isFinite(amount) || amount <= 0)) {
        await sendText({ to: phone, text: "Amount must be a positive number, or reply *setsalary <phone> off* to stop." });
        return true;
      }
      const result = await setSalary(
        { id: admin.id, phone, role: admin.role, cooperativeId: coopId },
        targetPhone,
        off ? "off" : amount,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "salarylist":
    case "runpayrollprep": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* views payroll." });
        return true;
      }
      const rows = await payrollOverview(coopId);
      if (rows.length === 0) {
        await sendText({ to: phone, text: "No super admins yet." });
        return true;
      }
      const body = rows
        .map((r) =>
          `• ${r.name} — ${r.salaryAmount ? formatBalance(r.salaryAmount) : "not set"}${r.bankAccountNumber ? "" : " ⚠️ no bank on file"}`,
        )
        .join("\n");
      await sendText({
        to: phone,
        text: `*Payroll setup*\n\n${body}\n\nSet: *setsalary <phone> <amount>* · Pay: *runpayroll <narration>*`,
      });
      return true;
    }

    case "runpayroll": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* runs payroll." });
        return true;
      }
      const narration = args.join(" ").trim();
      const result = await runPayroll(coopId, { id: admin.id, phone, role: admin.role }, narration);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "export": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can export data." });
        return true;
      }
      const kind = args[0]?.toLowerCase() as ExportKind | undefined;
      if (!kind || !["members", "transactions", "pnl"].includes(kind)) {
        await sendText({
          to: phone,
          text: "Usage: *export members* | *export transactions* | *export pnl* — you get Excel + PDF links, emailed to you when your email is on file.",
        });
        return true;
      }
      const baseUrl = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;
      await sendText({ to: phone, text: "⏳ Generating your export…" });
      const result = await runExport(
        { id: admin.id, name: admin.name, email: admin.email ?? null, cooperativeId: coopId },
        kind,
        baseUrl,
      );
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "setlimit": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* changes payout limits." });
        return true;
      }
      const amount = Number(args[0]);
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendText({ to: phone, text: "Usage: *setlimit <amount>* — daily ceiling on total money-out, e.g. *setlimit 500000*." });
        return true;
      }
      await prisma.cooperative.update({
        where: { id: coopId },
        data: { dailyPayoutLimit: amount },
      });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "fraud.set_limit",
        detail: `daily payout limit -> ${formatBalance(amount)}`,
      });
      await sendText({ to: phone, text: `✅ Daily payout ceiling set to *${formatBalance(amount)}*.` });
      return true;
    }

    case "backup": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* triggers backups." });
        return true;
      }
      const result = await runBackup();
      await sendText({ to: phone, text: result.ok ? `🗄️ ${result.message}` : `⚠️ ${result.message}` });
      return true;
    }

    case "reconcile": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* runs reconciliation." });
        return true;
      }
      const alerts = await runReconciliation();
      await sendText({
        to: phone,
        text: alerts.length === 0 ? "🌙 Reconciliation clean — no anomalies found. ✅" : `🌙 Reconciliation found:\n\n${alerts.join("\n")}`,
      });
      return true;
    }

    case "walletreconcile": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* runs wallet-bank reconciliation." });
        return true;
      }
      const report = await runWalletReconciliation(coopId, phone);
      await sendText({ to: phone, text: report.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "reconciliation.wallet_bank",
        detail: `discrepancy: ${formatBalance(report.discrepancy)}, status: ${report.status}`,
      });
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
      const lastDiv = await prisma.dividend.findFirst({ where: { cooperativeId: coopId }, orderBy: { createdAt: "desc" } });
      if (lastDiv) {
        const diff = Math.abs(rate - lastDiv.rate);
        if (diff > 5) {
          await sendText({ to: phone, text: `Rate change of ${diff}% exceeds 5% threshold. Requires member vote.` });
          return true;
        }
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

    case "setpost": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can assign executive posts." });
        return true;
      }
      const [rawTitle, rawCode] = args;
      if (!rawTitle || !rawCode) {
        await sendText({ to: phone, text: "Usage: *setpost <post> <member code>*, e.g. *setpost treasurer A1B2C3*." });
        return true;
      }
      const code = rawCode.toUpperCase();
      const holder = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!holder) {
        await sendText({ to: phone, text: `No member found with code ${code}.` });
        return true;
      }
      const title = normalizeTitle(rawTitle);
      await prisma.coopPost.upsert({
        where: { cooperativeId_title: { cooperativeId: coopId, title } },
        create: { cooperativeId: coopId, title, incumbentId: holder.id, appointedById: admin.id, appointedAt: new Date() },
        update: { incumbentId: holder.id, appointedById: admin.id, appointedAt: new Date() },
      });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "post.set",
        targetType: "coopPost",
        detail: `${displayTitle(title)} -> ${holder.name} (${code})`,
      });
      await notifyMember(holder, `🏛 You have been appointed *${displayTitle(title)}*. Congratulations!`);
      await sendText({ to: phone, text: `✅ ${displayTitle(title)} is now ${holder.name} (${code}).` });
      return true;
    }

    case "removepost": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can remove executive posts." });
        return true;
      }
      const rawTitle = args[0];
      if (!rawTitle) {
        await sendText({ to: phone, text: "Usage: *removepost <post>*" });
        return true;
      }
      const title = normalizeTitle(rawTitle);
      const post = await prisma.coopPost.findUnique({
        where: { cooperativeId_title: { cooperativeId: coopId, title } },
        include: { incumbent: true },
      });
      if (!post) {
        await sendText({ to: phone, text: `No post called "${rawTitle}" exists.` });
        return true;
      }
      await prisma.coopPost.update({ where: { id: post.id }, data: { incumbentId: null } });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "post.remove",
        targetType: "coopPost",
        detail: displayTitle(title),
      });
      if (post.incumbent) {
        await notifyMember(post.incumbent, `🏛 You are no longer *${displayTitle(title)}*. The seat is now vacant.`);
      }
      await sendText({ to: phone, text: `✅ ${displayTitle(title)} is now vacant.` });
      return true;
    }

    case "newbatch": {
      const result = await buildBatch(phone, args.join(" ") || undefined);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "submitbatch": {
      if (!args[0]) {
        await sendText({ to: phone, text: "Usage: *submitbatch <ref>*" });
        return true;
      }
      const result = await submitBatch(phone, args[0]);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "approvebatch":
    case "rejectbatch": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can approve or reject deduction batches." });
        return true;
      }
      if (!args[0]) {
        await sendText({ to: phone, text: `Usage: *${cmd} <ref>*` + (cmd === "rejectbatch" ? " [reason]" : "") });
        return true;
      }
      const result =
        cmd === "approvebatch"
          ? await approveBatch(phone, args[0])
          : await rejectBatch(phone, args[0], args.slice(1).join(" ") || undefined);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "setcommit": {
      const [code, amountArg] = args;
      const amount = Number(amountArg);
      if (!code || !Number.isFinite(amount)) {
        await sendText({ to: phone, text: "Usage: *setcommit <member code> <amount>* — 0 stops the deduction." });
        return true;
      }
      const result = await setCommitment(phone, code, amount);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "waive": {
      const [code, period] = args;
      if (!code) {
        await sendText({ to: phone, text: "Usage: *waive <member code> [YYYY-MM]*" });
        return true;
      }
      const result = await waiveMonth(phone, code, period);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "relink": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can relink a member's account." });
        return true;
      }
      const [rawCode, newChannel] = args;
      if (!rawCode || !newChannel) {
        await sendText({ to: phone, text: 'Usage: *relink <member code> <new number>* — e.g. *relink A1B2C3 2348012345678* (or tg:<chatid>).' });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code: rawCode.toUpperCase(), cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member found with code ${rawCode.toUpperCase()}.` });
        return true;
      }
      const oldPhone = target.phone;
      await prisma.member.update({
        where: { id: target.id },
        data: { phone: newChannel, preferredChannel: null },
      });
      await prisma.session.deleteMany({ where: { phone: oldPhone } });
      await prisma.session.deleteMany({ where: { phone: newChannel } });
      // Best-effort heads-up to the old channel in case it is still alive.
      await sendText({ to: oldPhone, text: "🔐 This account has been moved to a new number by your co-op admin. If this was not you, contact them immediately." }).catch(() => {});
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "account.relink",
        targetType: "member",
        targetId: target.id,
        detail: `${oldPhone} -> ${newChannel}`,
      });
      await sendText({
        to: phone,
        text: `✅ ${target.name}'s account moved from ${oldPhone} to ${newChannel}. Ask them to send *setpin 1234 1234* style commands to set a fresh PIN.`,
      });
      return true;
    }

    case "unlink": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can unlink a member's second channel." });
        return true;
      }
      const code = args[0]?.toUpperCase();
      if (!code) {
        await sendText({ to: phone, text: "Usage: *unlink <member code>*" });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member found with code ${code}.` });
        return true;
      }
      await prisma.member.update({
        where: { id: target.id },
        data: { altChannelId: null, preferredChannel: null },
      });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "account.unlink",
        targetType: "member",
        targetId: target.id,
        detail: target.code,
      });
      await sendText({ to: phone, text: `✅ Second channel detached from ${target.name}. They now chat only on ${target.phone}.` });
      return true;
    }

    case "str": {
      const memberPhone = args[0];
      if (!memberPhone) {
        await sendText({ to: phone, text: "Usage: *str <member-phone>* — e.g. *str 2348012345678*" });
        return true;
      }
      const { handleSTR } = await import("./aml.js");
      const result = await handleSTR(memberPhone, coopId);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "setconfig": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can change config." });
        return true;
      }
      const [key, ...valueParts] = args;
      const value = valueParts.join(" ");
      if (!key || !value) {
        await sendText({
          to: phone,
          text:
            "Usage: *setconfig <key> <value>*\n\n" +
            "Keys: loanInterestRate, serviceChargePercent, minContribution, minSavings, " +
            "minWithdrawal, maxWithdrawal, withdrawalCooldownMonths, lateFinePercent, " +
            "maxLoanMultiplier, autoApproveLoans, requireGuarantors, minGuarantors",
        });
        return true;
      }
      const validKeys = new Set([
        "loanInterestRate", "serviceChargePercent", "minContribution", "minSavings",
        "minWithdrawal", "maxWithdrawal", "withdrawalCooldownMonths", "lateFinePercent",
        "maxLoanMultiplier", "autoApproveLoans", "requireGuarantors", "minGuarantors",
      ]);
      if (!validKeys.has(key)) {
        await sendText({ to: phone, text: `Unknown config key: *${key}*.` });
        return true;
      }
      const isBoolean = key === "autoApproveLoans" || key === "requireGuarantors";
      let parsedValue: any;
      if (isBoolean) {
        parsedValue = value.toLowerCase() === "true" || value === "1";
      } else {
        parsedValue = Number(value);
        if (!Number.isFinite(parsedValue)) {
          await sendText({ to: phone, text: `Value must be a number for *${key}*.` });
          return true;
        }
      }
      await updateCoopConfig(coopId, { [key]: parsedValue });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "config.set",
        detail: `${key} = ${value}`,
      });
      await sendText({ to: phone, text: `✅ Config updated: *${key}* = *${value}*` });
      return true;
    }

    case "showconfig": {
      const config = await getCoopConfig(coopId);
      const body = [
        `*Cooperative Config*`,
        ``,
        `• Loan interest rate: *${config.loanInterestRate}%*`,
        `• Service charge: *${config.serviceChargePercent}%*`,
        `• Min contribution: *${formatBalance(config.minContribution)}*`,
        `• Min savings: *${formatBalance(config.minSavings)}*`,
        `• Min withdrawal: *${formatBalance(config.minWithdrawal)}*`,
        `• Max withdrawal: *${formatBalance(config.maxWithdrawal)}*`,
        `• Withdrawal cooldown: *${config.withdrawalCooldownMonths} months*`,
        `• Late fine: *${config.lateFinePercent}%*`,
        `• Max loan multiplier: *${config.maxLoanMultiplier}x savings*`,
        `• Auto-approve loans: *${config.autoApproveLoans ? "yes" : "no"}*`,
        `• Require guarantors: *${config.requireGuarantors ? "yes" : "no"}*`,
        `• Min guarantors: *${config.minGuarantors}*`,
      ];
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "setbranding": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can change branding." });
        return true;
      }
      const [bKey, ...bValueParts] = args;
      const bValue = bValueParts.join(" ");
      if (!bKey || !bValue) {
        await sendText({
          to: phone,
          text: "Usage: *setbranding <key> <value>*\n\nKeys: displayName, welcomeMessage, footerText, logoUrl",
        });
        return true;
      }
      const validBrandKeys = new Set(["displayName", "welcomeMessage", "footerText", "logoUrl"]);
      if (!validBrandKeys.has(bKey)) {
        await sendText({ to: phone, text: `Unknown branding key: *${bKey}*.` });
        return true;
      }
      await prisma.brandingConfig.upsert({
        where: { cooperativeId: coopId },
        create: { cooperativeId: coopId, displayName: bValue },
        update: { [bKey]: bValue },
      });
      await cacheDel(`branding:${coopId}`);
      await sendText({ to: phone, text: `✅ Branding updated: *${bKey}* = *${bValue}*` });
      return true;
    }

    case "billing": {
      const sub = await getSubscription(coopId);
      const memberCount = await prisma.member.count({ where: { cooperativeId: coopId, status: "active" } });
      const body = [
        `*Subscription & Billing*`,
        ``,
        `• Plan: *${sub.plan}*`,
        `• Status: *${sub.status}*`,
        `• Members: *${memberCount} / ${sub.memberLimit}*`,
        `• Monthly price: *${formatBalance(sub.monthlyPrice)}*`,
        sub.currentPeriodEnd ? `• Renews: *${sub.currentPeriodEnd.toISOString().slice(0, 10)}*` : "",
      ].filter(Boolean);
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "status": {
      const arg = args.join(" ").trim().toLowerCase();
      if (arg === "on") {
        await sendText({ to: phone, text: "✅ Auto-status enabled. The bot will post financial tips 3 times daily (8AM, 12PM, 6PM)." });
        return true;
      }
      if (arg === "off") {
        await sendText({ to: phone, text: "❌ Auto-status disabled." });
        return true;
      }
      if (arg === "preview") {
        const { getStatusPosts } = await import("./status-scheduler.js");
        const posts = await getStatusPosts(coopId);
        if (posts.length === 0) {
          await sendText({ to: phone, text: "No status posts scheduled for today." });
        } else {
          const list = posts.map((p, i) => `*${i + 1}.* ${p}`).join("\n\n");
          await sendText({ to: phone, text: `📋 *Today's Status Posts:*\n\n${list}` });
        }
        return true;
      }
      await sendText({ to: phone, text: "Usage: *status on|off|preview*" });
      return true;
    }

    case "fundstatus": {
      const funds = await getFundBalances(coopId);
      const body = [
        `*💰 Cooperative Fund Status*`,
        ``,
        `• Reserve Fund: *${formatBalance(funds.reserve)}*`,
        `• Education Fund: *${formatBalance(funds.education)}*`,
        `• Development Fund: *${formatBalance(funds.development)}*`,
        ``,
        `_These funds are built from statutory deductions on dividend distributions._`,
      ];
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "grievances": {
      const grievanceList = await prisma.grievance.findMany({
        where: { cooperativeId: coopId, status: "open" },
        include: { member: { select: { name: true, code: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      if (grievanceList.length === 0) {
        await sendText({ to: phone, text: "No open grievances. ✅" });
        return true;
      }
      const gBody = grievanceList.map((g) =>
        `• *${g.id.slice(-6)}* — ${g.member.name} (${g.member.code}): ${g.message.slice(0, 100)}${g.message.length > 100 ? "..." : ""}`,
      ).join("\n");
      await sendText({ to: phone, text: `*Open Grievances*\n\n${gBody}\n\nResolve with *resolve <id> <response>*` });
      return true;
    }

    case "agm": {
      const subcommand = args[0];
      if (subcommand === "schedule") {
        if (!isSuper) { await sendText({ to: phone, text: "Only super admins can schedule AGM." }); return true; }
        const dateStr = args[1];
        if (!dateStr) { await sendText({ to: phone, text: "Usage: *agm schedule YYYY-MM-DD*" }); return true; }
        const agmDate = new Date(dateStr);
        if (isNaN(agmDate.getTime())) { await sendText({ to: phone, text: "Invalid date format." }); return true; }
        await prisma.cooperativeConfig.upsert({ where: { cooperativeId: coopId }, update: { nextAGMDate: agmDate }, create: { cooperativeId: coopId, nextAGMDate: agmDate } });
        await sendText({ to: phone, text: `AGM scheduled for ${agmDate.toLocaleDateString("en-GB")}` });
        return true;
      }
      if (subcommand === "info") {
        const config = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
        if (!config?.nextAGMDate) { await sendText({ to: phone, text: "No AGM scheduled yet." }); return true; }
        await sendText({ to: phone, text: `Next AGM: ${config.nextAGMDate.toLocaleDateString("en-GB")}` });
        return true;
      }
      await sendText({ to: phone, text: "Usage: *agm schedule YYYY-MM-DD* or *agm info*" });
      return true;
    }

    case "byelaws": {
      const subcommand = args[0];
      if (subcommand === "add" && isSuper) {
        const title = args[1];
        const content = args.slice(2).join(" ");
        if (!title || !content) { await sendText({ to: phone, text: "Usage: *byelaws add <title> <content>*" }); return true; }
        await prisma.byelaw.create({ data: { cooperativeId: coopId, title, content } });
        await sendText({ to: phone, text: `Byelaw "${title}" added.` });
        return true;
      }
      const byelaws = await prisma.byelaw.findMany({ where: { cooperativeId: coopId }, orderBy: { createdAt: "desc" } });
      if (byelaws.length === 0) { await sendText({ to: phone, text: "No byelaws registered yet." }); return true; }
      const byelawLines = ["*📜 Cooperative Byelaws*", ""];
      for (const b of byelaws) { byelawLines.push(`*${b.title}*`, b.content, ""); }
      await sendText({ to: phone, text: byelawLines.join("\n") });
      return true;
    }

    case "members": {
      const allMembers = await prisma.member.findMany({ where: { cooperativeId: coopId }, include: { wallet: true }, orderBy: { createdAt: "asc" } });
      const memberLines = [`*👥 Members (${allMembers.length})*`, ""];
      for (const m of allMembers) { memberLines.push(`• ${m.name} — ${m.status} — ${m.createdAt.toLocaleDateString("en-GB")} — ${formatBalance(m.wallet?.balance ?? 0)}`); }
      await sendText({ to: phone, text: memberLines.join("\n") });
      return true;
    }

    case "strs": {
      if (!isSuper) { await sendText({ to: phone, text: "Only super admins can view STRs." }); return true; }
      const strs = await prisma.sTR.findMany({ where: { cooperativeId: coopId }, include: { member: true }, orderBy: { createdAt: "desc" }, take: 20 });
      if (strs.length === 0) { await sendText({ to: phone, text: "No STRs filed." }); return true; }
      const strLines = ["*📋 Suspicious Transaction Reports*", ""];
      for (const s of strs) { strLines.push(`• ${s.member.name} — ${formatBalance(s.amount)} — ${s.status} — ${s.reason}`); }
      await sendText({ to: phone, text: strLines.join("\n") });
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
async function handlePayout(ctx: AdminContext, amount: number, targetPhone: string, narration: string): Promise<void> {
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

  // Fraud guard: velocity check — max 5 money-out per 10 minutes per member.
  if (!checkVelocity(target.id)) {
    await sendText({ to: admin.phone, text: `🛑 Too many transactions for ${target.name} in a short period. Please wait a few minutes and try again.` });
    return;
  }

  // Fraud guard: daily ceiling on total money-out.
  const limit = await checkDailyPayoutLimit(coop.id, amount);
  if (!limit.ok) {
    await sendText({ to: admin.phone, text: limit.message! });
    return;
  }

  // ✅ DEBIT-FIRST: Lock wallet before sending money (prevents race condition)
  const debited = await prisma.wallet.updateMany({
    where: { memberId: target.id, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  });
  if (debited.count === 0) {
    await sendText({ to: admin.phone, text: `Insufficient balance. No money moved.` });
    return;
  }

  // Now send to bank
  const result = await sendToBank({
    memberId: target.id,
    amount,
    bankAccountNumber: target.bankAccountNumber,
    bankCode: target.bankCode,
    bankName: target.bankName ?? undefined,
    note: `Super admin payout to ${target.name} — ${narration}`,
    successMessage: `✅ ${formatBalance(amount)} sent to your bank account. Narration: "${narration}".`,
  });

  if (!result.ok) {
    // Refund the wallet on failure
    await prisma.wallet.update({
      where: { id: target.wallet!.id },
      data: { balance: { increment: amount } },
    });
    await sendText({ to: admin.phone, text: `Payout failed: ${result.message}. Wallet refunded.` });
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
    detail: `${formatBalance(amount)} to ${target.name} — ${narration}`,
  });

  if (limit.warning) {
    await sendText({ to: admin.phone, text: limit.warning });
  }

  await sendText({
    to: admin.phone,
    text: `Payout of ${formatBalance(amount)} to *${target.name}* was sent ✅ and their wallet debited.`,
  });
}
