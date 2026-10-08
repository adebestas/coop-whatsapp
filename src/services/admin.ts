import { prisma, withTx, withTxBatch } from "../lib/prisma.js";
import { sendText, sendLongText, notifyMember } from "../lib/messaging.js";
import { cacheDel } from "../lib/cache.js";
import { normalizeTitle, displayTitle } from "./posts.js";
import {
  buildBatch,
  submitBatch,
  approveBatch,
  rejectBatch,
  setCommitment,
  waiveMonth,
  recordCheque,
  reconcileBatch,
} from "./deductions.js";
import { approveLoan, listPendingLoans, rejectLoan } from "./loans.js";
import { formatBalance } from "./cooperative.js";
import { toKobo } from "../lib/money.js";
import { sendToBank } from "./disbursements.js";
import { broadcastToScope, createUnit, listUnits, setUnitAdmin, unitAdminOf } from "./units.js";
import {
  appointMember,
  committeeMajority,
  createCommittee,
  isCommitteeMember,
  listCommittees,
  recordCommitteeVote,
  removeMember,
} from "./committees.js";
import { previewDividendRun, getFundBalances } from "./dividends.js";
import {
  addMotion,
  closeMeeting,
  closeMotion,
  meetingMinutes,
  MOTION_KINDS,
  openMeeting,
  startMeeting,
} from "./meetings.js";
import {
  approveWithdrawal,
  finalizeWithdrawal,
  rejectWithdrawal,
  overrideWithdrawalRule,
} from "./withdrawals.js";
import { startAssistWithdrawal, confirmAssistWithdrawal } from "./adminassist.js";
import { revokeMemberSessions, unrevokeMemberSessions } from "./revocation.js";
import { approvePhoneChange, rejectPhoneChange } from "./phone-change.js";
import { requestManualCredit, approveManualCredit, rejectManualCredit } from "./manualcredit.js";
import { startDeathClaim, setClaimBank, approveClaim, rejectClaim } from "./deathclaims.js";
import { listCoopMandates, pauseMandate, resumeMandate, skipDebit } from "./mandates.js";
import { recommendRefund, approveRefund, rejectRefund } from "./refunds.js";
import { audit, recentAudit } from "./audit.js";
import { computePnl, getMonthlySummary, recordLedger } from "./ledger.js";
import {
  requestExternalPayment,
  approveExternalPayment,
  rejectExternalPayment,
  listPendingExternal,
} from "./payanyone.js";
import { startBuyPoll, addPollOption, closeBuyPoll, listBuyPolls } from "./buypoll.js";
import { payrollOverview, runPayroll, setSalary } from "./payroll.js";
import { runExport, exportMeetingMinutes, type ExportKind } from "./exports.js";
import { createGroup, closeGroupCycle, listGroups, groupLoans } from "./groups.js";
import { createProduct, listProducts } from "./savings-products.js";
import { checkDailyPayoutLimit, checkVelocity } from "./fraud.js";
import { runBackup } from "./backup.js";
import { runReconciliation } from "./reconcile.js";
import { runWalletReconciliation } from "./reconciliation.js";
import { getReserveReport } from "./reconciliation.js";
import { computePar, computePearls, provisionRates, runProvision } from "./provisioning.js";
import { resolveProvider } from "./payments/index.js";
import {
  assertMoneyAuthorized,
  assertFreshPin,
  disable2fa,
  enable2fa,
  refreshPin,
} from "./auth2fa.js";
import { getCoopConfig, updateCoopConfig, getSubscription } from "./coop-config.js";
import { startDividendVote, closeDividendVote, dividendVoteStatus } from "./dividendvote.js";
import {
  checkMultiSigRequirement,
  processMultiSigResponse,
  auditSuperadminCommand,
} from "../lib/security-hardening.js";
import {
  listCases,
  getCase,
  investigateCase,
  decideCase,
  applyRemedy,
  getActiveOmbudsman,
  type CaseDetail,
} from "./ombudsman.js";
import {
  generateReport,
  listReports,
  markFiled,
  setRegulatorProfile,
  type PackType,
  type PeriodType,
} from "./regulator-reporting.js";

// TODO: Split into domain-specific handlers (loans, withdrawals, config, etc.)

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
  "approverefund",
  "runpayroll",
  "paydividend",
  "paysharedividend",
  "disable2fa",
]);

/** Send the guard failure text and return true (command handled). */
async function guardFailed(phone: string, message?: string): Promise<boolean> {
  await sendText({ to: phone, text: message ?? "⛔ Not allowed." });
  return true;
}

interface AdminContext {
  admin: {
    id: string;
    phone: string;
    name: string;
    email: string | null;
    role: string;
    cooperativeId: string;
  };
  coop: { id: string; name: string; adminPhone: string | null };
  unitAdmin: Awaited<ReturnType<typeof unitAdminOf>>;
  isSuper: boolean;
}

/** Resolve an admin's access scope: coop-level or a single unit. */
async function adminContext(phone: string): Promise<AdminContext | null> {
  // ALWAYS re-check live role + status from the DB per command, so a
  // suspended/demoted/deceased admin loses chat admin powers immediately.
  const admin = await prisma.member.findFirst({
    where: { phone, role: { in: ["admin", "superadmin"] }, status: "active" },
    include: { cooperative: true },
  });
  if (!admin) return null;
  const coop = admin.cooperative;
  // The DB role column is the single source of truth for superadmin power.
  // The coop.adminPhone value is used ONLY for notifications, never for authorization.
  const isSuper = admin.role === "superadmin";
  // Super admins are always coop-wide; plain admins may be scoped to a unit.
  const unitAdmin = isSuper ? null : await unitAdminOf(admin);
  return { admin, coop, unitAdmin, isSuper };
}

function roleLabel(ctx: AdminContext): string {
  if (ctx.isSuper) return "superadmin";
  return ctx.unitAdmin ? "unit admin" : "admin";
}

/** Commands a seated committee member can use without being a coop admin. */
const COMMITTEE_COMMANDS = new Set([
  "cvote",
  "committeequeue",
  "supervisoryfreeze",
  "supervisoryunfreeze",
]);

/**
 * Handle committee-member commands (voting, queue, supervisory freeze). The
 * caller may be a plain member; authorization is by active committee seat, with
 * super admins additionally allowed on the supervisory commands.
 */
async function handleCommitteeCommand(
  phone: string,
  cmd: string,
  args: string[],
  ctx: AdminContext | null,
): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { phone, status: { not: "deceased" } },
  });
  if (!member) return false;
  const coopId = member.cooperativeId;
  const isSuper = ctx?.isSuper ?? false;

  if (cmd === "cvote") {
    const loanRef = args[0];
    const vote = args[1]?.trim().toLowerCase();
    if (!loanRef || (vote !== "approve" && vote !== "reject")) {
      await sendText({ to: phone, text: "Usage: *cvote <loan id> approve|reject*." });
      return true;
    }
    if (!(await isCommitteeMember(coopId, "credit", member.id))) {
      await sendText({ to: phone, text: "Only *Credit Committee* members can vote on loans." });
      return true;
    }
    const loan = await prisma.loan.findFirst({
      where: {
        cooperativeId: coopId,
        ...(loanRef.length >= 8 ? { id: loanRef } : { id: { endsWith: loanRef } }),
      },
    });
    if (!loan) {
      await sendText({ to: phone, text: "Loan not found. Check the id and try again." });
      return true;
    }

    if (vote === "approve") {
      const result = await approveLoan(loan.id, {
        actorId: member.id,
        cooperativeId: coopId,
        isAdmin: isSuper || member.role === "admin" || member.role === "superadmin",
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    // Reject vote — decide the committee, then terminate the loan.
    const outcome = await recordCommitteeVote(coopId, "credit", "loan", loan.id, member.id, "reject");
    await sendText({ to: phone, text: outcome.message });
    if (outcome.ok && outcome.decided === "rejected") {
      const updated = await prisma.loan.updateMany({
        where: { id: loan.id, status: { in: ["admin_approved", "super_approved_1"] } },
        data: { status: "rejected", queuePosition: null, queueJoinedAt: null },
      });
      if (updated.count > 0) {
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: member.id,
          actorRole: "committee",
          action: "loan.reject_by_credit_committee",
          targetType: "loan",
          targetId: loan.id,
          detail: `Credit Committee rejected loan ${loan.id.slice(-6)}`,
        });
      }
    }
    return true;
  }

  if (cmd === "committeequeue") {
    const allowed =
      isSuper ||
      (await isCommitteeMember(coopId, "credit", member.id)) ||
      (await isCommitteeMember(coopId, "supervisory", member.id));
    if (!allowed) {
      await sendText({ to: phone, text: "Only committee members can view the committee queue." });
      return true;
    }
    const decisions = await prisma.committeeDecision.findMany({
      where: { cooperativeId: coopId, status: "pending" },
      include: { committee: { select: { name: true, type: true, size: true } }, votes: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    if (decisions.length === 0) {
      await sendText({ to: phone, text: "No pending committee decisions. ✅" });
      return true;
    }
    const body = decisions
      .map((d) => {
        const approvals = d.votes.filter((v) => v.vote === "approve").length;
        return (
          `• *${d.committee.name}* (${d.committee.type}) — ${d.subjectType} *${d.subjectId.slice(-6)}* — ${approvals}/${committeeMajority(d.committee.size)} approvals\n` +
          `   Vote: *cvote ${d.subjectId.slice(-6)} approve|reject*`
        );
      })
      .join("\n");
    await sendText({ to: phone, text: `*Committee queue*\n\n${body}` });
    return true;
  }

  // supervisoryfreeze / supervisoryunfreeze
  const code = args[0]?.trim().toUpperCase();
  if (!code) {
    await sendText({
      to: phone,
      text: `Usage: *${cmd} <member code>${cmd === "supervisoryfreeze" ? " [reason]" : ""}*.`,
    });
    return true;
  }
  const allowed = isSuper || (await isCommitteeMember(coopId, "supervisory", member.id));
  if (!allowed) {
    await sendText({
      to: phone,
      text: "Only *Supervisory Committee* members or the super admin can freeze or unfreeze accounts.",
    });
    return true;
  }
  const target = await prisma.member.findFirst({
    where: { cooperativeId: coopId, code },
    select: { id: true, name: true },
  });
  if (!target) {
    await sendText({ to: phone, text: `No member with code *${code}* in your cooperative.` });
    return true;
  }
  const freezing = cmd === "supervisoryfreeze";
  const reason = args.slice(1).join(" ").trim();
  await prisma.member.update({
    where: { id: target.id },
    data: { supervisoryFrozenAt: freezing ? new Date() : null },
  });
  await audit({
    cooperativeId: coopId,
    actorPhone: phone,
    actorId: member.id,
    actorRole: isSuper ? "superadmin" : "committee",
    action: freezing ? "member.supervisory_freeze" : "member.supervisory_unfreeze",
    targetType: "member",
    targetId: target.id,
    detail: `${freezing ? "Froze" : "Unfroze"} ${target.name}${reason ? `: ${reason}` : ""}`,
  });
  await sendText({
    to: phone,
    text: freezing
      ? `🔒 ${target.name}'s account has been *frozen*${reason ? ` (${reason})` : ""}. No money can leave until unfrozen.`
      : `🔓 ${target.name}'s account has been *unfrozen*.`,
  });
  return true;
}

/** Commands an active platform ombudsman can use from chat (not coop members). */
const OMBUDSMAN_COMMANDS = new Set(["cases", "case", "investigate", "decide", "remedy"]);
/** Valid `OmbudsmanCase.status` values (no Prisma enum — plain strings). */
const CASE_STATUSES = new Set(["open", "investigating", "decided", "closed"]);

/** Render a case + its timeline for the ombudsman console. */
function formatCaseDetail(c: CaseDetail): string {
  const head =
    `*⚖️ Case #${c.id.slice(-6)}* (${c.status})\n` +
    `Category: *${c.category}*${c.slaDueAt ? ` · SLA due ${c.slaDueAt.toISOString().slice(0, 10)}` : ""}\n\n` +
    `${c.summary}\n`;
  const decision = c.decision ? `\n*Decision:* ${c.decision}\n` : "";
  const timeline = c.events
    .map(
      (e) =>
        `• ${e.createdAt.toISOString().slice(0, 16).replace("T", " ")} — ${e.actorRole} ${e.action}: ${e.detail}`,
    )
    .join("\n");
  return `${head}${decision}\n*Timeline*\n${timeline}`;
}

/**
 * Handle platform-level ombudsman commands. Ombudsmen are NOT cooperative
 * members, so this router is separate from `handleAdminCommand` and runs before
 * the member/admin routers. Gated to an active `Ombudsman` phone match. Returns
 * true if the command was handled.
 */
export async function handleOmbudsmanCommand(
  phone: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  if (!OMBUDSMAN_COMMANDS.has(cmd)) return false;
  const ombudsman = await getActiveOmbudsman(phone);
  if (!ombudsman) return false;
  const actor = { id: ombudsman.id, phone };

  if (cmd === "cases") {
    const status = args[0]?.trim().toLowerCase() || undefined;
    if (status && !CASE_STATUSES.has(status)) {
      await sendText({
        to: phone,
        text: "Unknown status. Use one of: *open*, *investigating*, *decided*, *closed*.",
      });
      return true;
    }
    const res = await listCases(status);
    if (!res.cases || res.cases.length === 0) {
      await sendText({ to: phone, text: res.message });
      return true;
    }
    const lines = res.cases.map(
      (c) => `• *#${c.id.slice(-6)}* — ${c.status} — ${c.category}\n   ${c.summary.slice(0, 80)}`,
    );
    await sendText({
      to: phone,
      text:
        `*⚖️ Ombudsman cases (${res.cases.length})*\n\n${lines.join("\n")}\n\n` +
        `Reply *case <id>* for the full timeline.`,
    });
    return true;
  }

  if (cmd === "case") {
    const res = await getCase(args[0] ?? "");
    await sendText({ to: phone, text: res.ok && res.case ? formatCaseDetail(res.case) : res.message });
    return true;
  }

  if (cmd === "investigate") {
    const caseRef = args[0];
    const note = args.slice(1).join(" ").trim();
    if (!caseRef || !note) {
      await sendText({
        to: phone,
        text: "Usage: *investigate <case id> <note for the cooperative>*.",
      });
      return true;
    }
    const res = await investigateCase(caseRef, note, actor);
    await sendText({ to: phone, text: res.message });
    return true;
  }

  if (cmd === "remedy") {
    const caseRef = args[0];
    const action = args[1]?.trim().toLowerCase();
    if (!caseRef || (action !== "unfreeze" && action !== "refund")) {
      await sendText({
        to: phone,
        text:
          "Usage: *remedy <case id> unfreeze* or *remedy <case id> refund <amount naira> [reason]*.",
      });
      return true;
    }
    if (action === "unfreeze") {
      const res = await applyRemedy(caseRef, "unfreeze", {}, actor);
      await sendText({ to: phone, text: res.message });
      return true;
    }
    const amountRaw = args[2];
    const amount = amountRaw ? toKobo(Number(amountRaw.replace(/[^0-9.]/g, ""))) : undefined;
    if (amount === undefined || !Number.isFinite(amount)) {
      await sendText({
        to: phone,
        text: "Usage: *remedy <case id> refund <amount naira> [reason]* — e.g. *remedy 1a2b3c refund 5000 double debit*.",
      });
      return true;
    }
    const reason = args.slice(3).join(" ").trim();
    const res = await applyRemedy(caseRef, "refund", { amount, reason }, actor);
    await sendText({ to: phone, text: res.message });
    return true;
  }

  // decide
  const caseRef = args[0];
  const decision = args.slice(1).join(" ").trim();
  if (!caseRef || !decision) {
    await sendText({ to: phone, text: "Usage: *decide <case id> <decision>*." });
    return true;
  }
  const res = await decideCase(caseRef, decision, actor);
  await sendText({ to: phone, text: res.message });
  return true;
}

/** Execute an admin command from chat. Returns true if handled as admin. */
export async function handleAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  try {
    const ctx = await adminContext(phone);

    // Committee commands are open to seated committee members, who are often
    // ordinary members rather than admins. Resolve them before the admin-only
    // gate so voting and supervisory oversight work without admin rights.
    if (COMMITTEE_COMMANDS.has(cmd)) {
      return handleCommitteeCommand(phone, cmd, args, ctx);
    }

    if (!ctx) return false;
    const { admin, unitAdmin, isSuper } = ctx;
    const coopId = admin.cooperativeId;

    // Security gates for account management.
    if (cmd === "enable2fa") {
      const r = await enable2fa(phone);
      await sendText({ to: phone, text: r.message });
      return true;
    }
    if (cmd === "disable2fa") {
      // 2FA is a security control — disabling it requires BOTH your PIN and, when
      // enrolled, a valid TOTP code appended as the last argument.
      // Syntax: disable2fa <your PIN> <6-digit code>
      const gate = await assertMoneyAuthorized(admin.id, args);
      if (!gate.ok) return guardFailed(phone, gate.message);
      const [pin] = gate.args;
      if (!pin) {
        await sendText({
          to: phone,
          text: "Usage: *disable2fa <your PIN> <6-digit code>* — 2FA stays on unless you provide both.",
        });
        return true;
      }
      const r = await disable2fa(phone, pin);
      await sendText({ to: phone, text: r.message });
      return true;
    }
    if (cmd === "verifypin") {
      if (!args[0]) {
        await sendText({
          to: phone,
          text: "Usage: *verifypin <your PIN>* — unlocks large payouts for 10 minutes.",
        });
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
        const loans = await listPendingLoans(coopId, 20, unitAdmin?.unit?.id);
        await sendPendingLoans(phone, loans, unitAdmin !== null);
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
        // isAdmin must be set even when the caller is not a super admin: approveLoan
        // gates the account_officer_approved -> admin_approved stage on it, so
        // without this a plain admin could never complete their own sign-off.
        const result = await approveLoan(id, {
          superAdmin: isSuper,
          isAdmin: true,
          actorId: admin.id,
          cooperativeId: coopId,
        });
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
        const result = await rejectLoan(id, {
          actorId: admin.id,
          cooperativeId: coopId,
          reason: "Admin rejection via chat",
          stage: "officer",
        });
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
        const amount = toKobo(Number(args[0]));
        const targetPhone = args[1]?.startsWith("tg:")
          ? "tg:" + args[1].replace(/[^0-9]/g, "")
          : args[1]?.replace(/[^0-9]/g, "");
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

      case "approvemultisig":
      case "rejectmultisig": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the super admin can approve multi-sig requests.",
          });
          return true;
        }
        const pendingIdSuffix = args[0];
        if (!pendingIdSuffix) {
          await sendText({
            to: phone,
            text: "Usage: *approvemultisig <request id suffix>* or *rejectmultisig <request id suffix>*",
          });
          return true;
        }
        const action = cmd === "approvemultisig" ? "approve" : "reject";
        const result = await processMultiSigResponse({
          cooperativeId: coopId,
          pendingIdSuffix,
          responderPhone: phone,
          action,
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "approvewithdraw":
      case "approvewdraw": {
        if (unitAdmin) {
          await sendText({
            to: phone,
            text: "Only the cooperative admin can approve withdrawals.",
          });
          return true;
        }
        const id = args[0];
        if (!id) {
          await sendText({ to: phone, text: "Usage: *approvewithdraw <request id>*" });
          return true;
        }
        const result = await approveWithdrawal(id, {
          id: admin.id,
          role: admin.role,
          phone,
          cooperativeId: coopId,
        });
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
          await sendText({
            to: phone,
            text: "Only the *super admin* can give the final approval.",
          });
          return true;
        }
        const id = args[0];
        if (!id) {
          await sendText({ to: phone, text: "Usage: *finalize <request id>*" });
          return true;
        }
        // Look up the amount so large payouts require a fresh PIN too. Scoped to
        // the caller's cooperative so a foreign request can't trigger anything here.
        const req = await prisma.withdrawalRequest.findFirst({
          where: {
            cooperativeId: coopId,
            ...(id.length >= 8 ? { OR: [{ id }, { id: { endsWith: id } }] } : { id }),
          },
        });
        if (req) {
          const pinCheck = await assertFreshPin(phone, req.amount);
          if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
        }
        const result = await finalizeWithdrawal(id, {
          id: admin.id,
          role: admin.role,
          phone,
          cooperativeId: coopId,
        });
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

      case "assistwithdraw": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can initate assisted withdrawals.",
          });
          return true;
        }
        const targetCode = args[0];
        const amt = Number(args[1]);
        if (!targetCode || !Number.isFinite(amt) || amt <= 0) {
          await sendText({
            to: phone,
            text: "Usage: *assistwithdraw <member code> <amount>* — sends a one-time code to the member for authorisation.",
          });
          return true;
        }
        const result = await startAssistWithdrawal(phone, targetCode, amt);
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "confirmassist": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can confirm an assisted withdrawal.",
          });
          return true;
        }
        const assistId = args[0];
        const memberCode = args[1];
        if (!assistId || !memberCode) {
          await sendText({
            to: phone,
            text: "Usage: *confirmassist <assist id> <member code>* — the code the member received.",
          });
          return true;
        }
        // High-value assists require a recently verified PIN (mirrors *finalize*).
        const assist = await prisma.adminAssistAction.findFirst({
          where: { cooperativeId: coopId, status: "pending", id: { endsWith: assistId } },
        });
        if (assist) {
          const pinCheck = await assertFreshPin(phone, assist.amount);
          if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
        }
        const result = await confirmAssistWithdrawal(phone, assistId, memberCode);
        await sendText({ to: phone, text: result.message });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: "superadmin",
          action: "assist.withdrawal.confirm",
          targetType: "assist",
          targetId: result.assistId,
          detail: result.message,
        });
        return true;
      }

      case "revoke": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can revoke a member's sessions.",
          });
          return true;
        }
        const rCode = args[0];
        if (!rCode) {
          await sendText({
            to: phone,
            text: "Usage: *revoke <member code>* — revokes a member's sessions and blocks money movement.",
          });
          return true;
        }
        const r = await revokeMemberSessions(phone, admin.id, coopId, rCode);
        await sendText({ to: phone, text: r.message });
        return true;
      }

      case "unrevoke": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can restore a member's sessions.",
          });
          return true;
        }
        const uCode = args[0];
        if (!uCode) {
          await sendText({
            to: phone,
            text: "Usage: *unrevoke <member code>* — restores a revoked member's sessions.",
          });
          return true;
        }
        const u = await unrevokeMemberSessions(phone, admin.id, coopId, uCode);
        await sendText({ to: phone, text: u.message });
        return true;
      }

      case "manualcredit": {
        // Maker step: an admin requests a manual wallet credit. It stays PENDING
        // until a DIFFERENT super admin approves it (dual control).
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can initiate a manual credit.",
          });
          return true;
        }
        const mcCode = args[0];
        const mcAmt = Number(args[1]);
        const mcNarration = args.slice(2).join(" ").trim();
        if (!mcCode || !Number.isFinite(mcAmt) || mcAmt <= 0) {
          await sendText({
            to: phone,
            text: "Usage: *manualcredit <member code> <amount> <narration>* — e.g. *manualcredit MEM001 5000 Refund for July*",
          });
          return true;
        }
        const mcRes = await requestManualCredit(phone, mcCode, mcAmt, mcNarration);
        await sendText({ to: phone, text: mcRes.message });
        return true;
      }

      case "approvemanualcredit": {
        // Checker step: a DIFFERENT super admin with 2FA + PIN sign-off credits
        // the wallet. Money-into-membership is gated as strictly as money-out.
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can approve a manual credit.",
          });
          return true;
        }
        const creditGuard = await assertMoneyAuthorized(admin.id, args);
        if (!creditGuard.ok) return guardFailed(phone, creditGuard.message);
        const creditArgs = creditGuard.args;
        const amcId = creditArgs[0];
        const amcPin = creditArgs[1];
        if (!amcId || !amcPin) {
          await sendText({
            to: phone,
            text: "Usage: *approvemanualcredit <credit id> <your PIN>* — the approving super admin must differ from the initiator.",
          });
          return true;
        }
        // High-value approvals need a recently verified PIN (mirrors *finalize*).
        const amcCredit = await prisma.manualCredit.findFirst({
          where: { cooperativeId: coopId, status: "pending", id: { endsWith: amcId } },
        });
        if (amcCredit) {
          const amcPinCheck = await assertFreshPin(phone, amcCredit.amount);
          if (!amcPinCheck.ok) return guardFailed(phone, amcPinCheck.message);
        }
        const amcRes = await approveManualCredit(phone, amcId, amcPin);
        await sendText({ to: phone, text: amcRes.message });
        return true;
      }

      case "rejectmanualcredit": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can reject a manual credit." });
          return true;
        }
        const rmId = args[0];
        if (!rmId) {
          await sendText({ to: phone, text: "Usage: *rejectmanualcredit <credit id> [reason]*" });
          return true;
        }
        const rmRes = await rejectManualCredit(phone, rmId, args.slice(1).join(" "));
        await sendText({ to: phone, text: rmRes.message });
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
        const result = await rejectWithdrawal(id, coopId);
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
          await sendText({
            to: phone,
            text: "Usage: *overridewithdrawal <member phone>* — lets them withdraw before 6 months.",
          });
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
          .map(
            (r) =>
              `• *${r.id.slice(-6)}* — ${r.member.name} — ${formatBalance(r.amount)}\n` +
              `   ${
                r.status === "pending"
                  ? `Admin approves: *approvewdraw ${r.id.slice(-6)}*`
                  : `Awaiting super admin: *finalize ${r.id.slice(-6)}*`
              }`,
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
            create: {
              phone,
              state: "awaiting_death_cert",
              data: JSON.stringify({ deathClaimId: result.claimId }),
            },
            update: {
              state: "awaiting_death_cert",
              data: JSON.stringify({ deathClaimId: result.claimId }),
            },
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
          await sendText({
            to: phone,
            text: "Only the cooperative admin can set the family's bank.",
          });
          return true;
        }
        const claimCode = args[0];
        const account = args[1];
        const bank = args.slice(2).join(" ");
        if (!claimCode || !account || !bank) {
          await sendText({
            to: phone,
            text: "Usage: *claimbank <claim id> <account number> <bank>*, e.g. *claimbank ABC123 0123456789 Access*",
          });
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
          await sendText({
            to: phone,
            text: "Only the *super admin* can give the final approval on a death claim.",
          });
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
          where: {
            cooperativeId: coopId,
            status: { in: ["awaiting_certificate", "awaiting_validation", "validated"] },
          },
          include: {
            member: { select: { name: true } },
            validations: { select: { memberId: true } },
          },
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
          await sendText({
            to: phone,
            text: "Usage: *setrole <member code> <member|admin|superadmin|support>*",
          });
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
        // Before demoting, check if target is superadmin and would leave < 1 superadmin
        if (target.role === "superadmin" && role !== "superadmin") {
          const superCount = await prisma.member.count({
            where: {
              cooperativeId: coopId,
              role: "superadmin",
              status: "active",
              id: { not: target.id },
            },
          });
          if (superCount < 1) {
            await sendText({
              to: phone,
              text: "Cannot demote: this would leave the cooperative with no superadmins.",
            });
            return true;
          }
        }
        await prisma.member.update({ where: { id: target.id }, data: { role } });
        await sendText({ to: phone, text: `✅ ${target.name} is now *${role}*.` });
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
          take: 100,
        });
        if (members.length === 0) {
          await sendText({ to: phone, text: "No members in this cooperative." });
          return true;
        }
        const body = members
          .map(
            (m) =>
              `• *${m.name}* (${m.code}) — ${m.role}, ${m.status}\n  Joined: ${m.createdAt.toLocaleDateString("en-GB")} · Balance: ${formatBalance(m.wallet?.balance ?? 0)}`,
          )
          .join("\n");
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
          .map(
            (e) =>
              `• ${e.createdAt.toISOString().slice(5, 16).replace("T", " ")} — ${e.actorPhone.slice(-4)} (${e.actorRole ?? "?"}) ${e.action}${e.targetId ? ` ${e.targetId.slice(-6)}` : ""}`,
          )
          .join("\n");
        await sendText({ to: phone, text: `*Recent activity*\n\n${body}` });
        return true;
      }

      case "regreport": {
        // `regreport filed <id>` marks a generated pack as filed.
        if (args[0]?.toLowerCase() === "filed") {
          const res = await markFiled(coopId, args[1] ?? "", { id: admin.id, phone });
          await sendText({ to: phone, text: res.message });
          return true;
        }
        const period = args[0];
        const packRaw = args[1]?.toLowerCase();
        if (
          !period ||
          !/^\d{4}-\d{2}$/.test(period) ||
          (packRaw !== "statutory" && packRaw !== "nfiu" && packRaw !== "both")
        ) {
          await sendText({
            to: phone,
            text:
              "Usage: *regreport <YYYY-MM> <statutory|nfiu|both> [monthly|quarterly]*.\n" +
              "Mark one filed: *regreport filed <id>*.",
          });
          return true;
        }
        const periodType: PeriodType = args[2]?.toLowerCase() === "quarterly" ? "quarterly" : "monthly";
        const gen = await generateReport(coopId, period, periodType, packRaw as PackType, admin.id);
        await sendText({ to: phone, text: gen.message });
        return true;
      }

      case "regulatorconfig": {
        // regulatorconfig [label...] [type] [email] [monthlyDueDay] [quarterlyDueDay]
        const cfg: {
          label?: string;
          type?: string;
          contactEmail?: string;
          monthlyDueDay?: number;
          quarterlyDueDay?: number;
        } = {};
        const rest = [...args];
        if (rest.length && /^\d{1,2}$/.test(rest[rest.length - 1])) {
          cfg.quarterlyDueDay = Number(rest.pop());
        }
        if (rest.length && /^\d{1,2}$/.test(rest[rest.length - 1])) {
          cfg.monthlyDueDay = Number(rest.pop());
        }
        if (rest.length && rest[rest.length - 1].includes("@")) {
          cfg.contactEmail = rest.pop();
        }
        const typeIdx = rest
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => ["ministry", "cbn", "nfiu", "custom"].includes(t.toLowerCase()))
          .map(({ i }) => i)
          .pop();
        if (typeIdx !== undefined) cfg.type = rest.splice(typeIdx, 1)[0].toLowerCase();
        const cfgLabel = rest.join(" ").trim();
        if (cfgLabel) cfg.label = cfgLabel;
        const res = await setRegulatorProfile(coopId, cfg, { id: admin.id, phone });
        await sendText({ to: phone, text: res.message });
        return true;
      }

      case "regreportstatus": {
        const res = await listReports(coopId);
        if (!res.reports || res.reports.length === 0) {
          await sendText({ to: phone, text: res.message });
          return true;
        }
        const lines = res.reports.map((r) => {
          const due = r.dueAt ? r.dueAt.toISOString().slice(0, 10) : "—";
          const flag = r.status === "filed" ? "✅ filed" : "⏳ generated";
          return `• *${r.period}* ${r.periodType} ${r.packType} — ${flag} (due ${due}) · id ${r.id.slice(-6)}`;
        });
        await sendText({
          to: phone,
          text:
            `*📋 Regulator packs (${res.reports.length})*\n\n${lines.join("\n")}\n\n` +
            `Mark one filed: *regreport filed <id>*.`,
        });
        return true;
      }

      case "internalaudit": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can run internal audits." });
          return true;
        }

        const coopFull = await prisma.cooperative.findUnique({ where: { id: coopId } });
        if (!coopFull) {
          await sendText({ to: phone, text: "Cooperative not found." });
          return true;
        }

        const [
          totalMembers,
          activeMembers,
          totalContributions,
          totalLoanDisbursed,
          loanBalance,
          pendingWithdrawals,
          recentAuditEntries,
          walletAgg,
        ] = await Promise.all([
          prisma.member.count({ where: { cooperativeId: coopId } }),
          prisma.member.count({ where: { cooperativeId: coopId, status: "active" } }),
          prisma.contribution.aggregate({
            where: { cooperativeId: coopId, status: "confirmed" },
            _sum: { amount: true },
            _count: true,
          }),
          prisma.loan.aggregate({
            where: { cooperativeId: coopId, status: { in: ["approved", "disbursed", "paid"] } },
            _sum: { amount: true },
            _count: true,
          }),
          prisma.loan.aggregate({
            where: { cooperativeId: coopId, status: { in: ["approved", "disbursed"] } },
            _sum: { balance: true },
            _count: true,
          }),
          prisma.withdrawalRequest.count({
            where: { cooperativeId: coopId, status: { in: ["pending", "admin_approved"] } },
          }),
          recentAudit(coopId, 50),
          prisma.wallet.aggregate({
            where: { member: { cooperativeId: coopId } },
            _sum: { balance: true, totalSaved: true },
          }),
        ]);

        const totalSaved = walletAgg._sum.totalSaved ?? 0;
        const walletBalance = walletAgg._sum.balance ?? 0;
        const disbursed = totalLoanDisbursed._sum.amount ?? 0;
        const outstanding = loanBalance._sum.balance ?? 0;
        const repayments = disbursed - outstanding;

        // Check for anomalies
        const anomalies: string[] = [];
        if (activeMembers < 20)
          anomalies.push(`Low active membership: ${activeMembers} (minimum 20 required for loans)`);
        if (outstanding > 0 && totalContributions._count > 0) {
          const ratio = outstanding / (totalSaved || 1);
          if (ratio > 2) anomalies.push(`High loan-to-savings ratio: ${(ratio * 100).toFixed(0)}%`);
        }
        if (pendingWithdrawals > 10)
          anomalies.push(`High pending withdrawals: ${pendingWithdrawals}`);

        // Check for unusual audit activity
        const superAdminActions = recentAuditEntries.filter(
          (e) => e.actorRole === "superadmin",
        ).length;
        const totalActions = recentAuditEntries.length;
        if (totalActions > 0 && superAdminActions / totalActions > 0.8) {
          anomalies.push(
            `High super admin activity: ${superAdminActions}/${totalActions} recent actions`,
          );
        }

        const report = [
          `*🔍 Internal Audit Report — ${coopFull.name}*`,
          `_Generated: ${new Date().toLocaleDateString("en-GB")}_`,
          "",
          `*Membership:*`,
          `• Total members: *${totalMembers}*`,
          `• Active: *${activeMembers}*`,
          "",
          `*Finances:*`,
          `• Total savings mobilized: *${formatBalance(totalSaved)}*`,
          `• Current wallet balance: *${formatBalance(walletBalance)}*`,
          `• Total loans disbursed: *${formatBalance(disbursed)}* (${totalLoanDisbursed._count} loans)`,
          `• Outstanding loan balance: *${formatBalance(outstanding)}* (${loanBalance._count} active)`,
          `• Total repayments: *${formatBalance(repayments)}*`,
          `• Pending withdrawals: *${pendingWithdrawals}*`,
          "",
          `*Compliance:*`,
          anomalies.length === 0
            ? "• ✅ No anomalies detected"
            : anomalies.map((a) => `• ⚠️ ${a}`).join("\n"),
          "",
          `*Recent Activity (last 50 entries):*`,
          recentAuditEntries.length === 0
            ? "• No recent activity"
            : recentAuditEntries
                .slice(0, 10)
                .map(
                  (e) =>
                    `• ${e.createdAt.toISOString().slice(5, 16).replace("T", " ")} — ${e.action} — ${e.detail ?? ""}`,
                )
                .join("\n"),
          "",
          `_This is an independent internal audit report for cooperative governance._`,
        ];

        await sendLongText({ to: phone, text: report.join("\n") });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: "superadmin",
          action: "internal_audit.run",
          detail: `Internal audit report generated — ${anomalies.length} anomalies found`,
        });
        return true;
      }

      case "broadcast": {
        const message = args.join(" ").trim();
        if (!message) {
          await sendText({
            to: phone,
            text: "Usage: *broadcast <message>* to send to all members (or *broadcast unit <message>* to your workplace).",
          });
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
          await sendText({
            to: phone,
            text: "Usage: *addunit <name> <code>*, e.g. *addunit Lagos Office LAG01*.",
          });
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
          await sendText({
            to: phone,
            text: "Usage: *unitadmin <unit code> <member code>*, e.g. *unitadmin LAG01 ABC123-DEFG*.",
          });
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

      case "addcommittee": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can create committees." });
          return true;
        }
        const addType = args[0]?.toLowerCase();
        const lastArg = args[args.length - 1] ?? "";
        const hasSize = /^\d+$/.test(lastArg);
        const addName = (hasSize ? args.slice(1, -1) : args.slice(1))
          .join(" ")
          .trim()
          .replace(/\b\w/g, (ch) => ch.toUpperCase());
        if (!addType || !addName) {
          await sendText({
            to: phone,
            text: "Usage: *addcommittee <credit|supervisory|board> <name> [size]* — e.g. *addcommittee credit Credit Committee 3*.",
          });
          return true;
        }
        // When [size] is omitted, default to the cooperative's configured size
        // for this committee type (credit/supervisory default 3, board default 5).
        let addSize: number;
        if (hasSize) {
          addSize = parseInt(lastArg, 10);
        } else {
          const cfg = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
          addSize =
            addType === "credit"
              ? (cfg?.creditCommitteeSize ?? 3)
              : addType === "supervisory"
                ? (cfg?.supervisoryCommitteeSize ?? 3)
                : addType === "board"
                  ? (cfg?.boardSize ?? 5)
                  : 3;
        }
        const addResult = await createCommittee(coopId, addType, addName, addSize, {
          phone,
          id: admin.id,
          role: "superadmin",
        });
        await sendText({ to: phone, text: addResult.message });
        return true;
      }

      case "appoint": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can appoint committee members." });
          return true;
        }
        const appointType = args[0]?.toLowerCase();
        const appointCode = args[1];
        const appointRole = args[2]?.toLowerCase() === "chair" ? "chair" : "member";
        if (!appointType || !appointCode) {
          await sendText({
            to: phone,
            text: "Usage: *appoint <credit|supervisory|board> <member code> [chair]*.",
          });
          return true;
        }
        const appointResult = await appointMember(coopId, appointType, appointCode, appointRole, {
          phone,
          id: admin.id,
          role: "superadmin",
        });
        await sendText({ to: phone, text: appointResult.message });
        return true;
      }

      case "removecommittee": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can remove committee members.",
          });
          return true;
        }
        const removeType = args[0]?.toLowerCase();
        const removeCode = args[1];
        if (!removeType || !removeCode) {
          await sendText({
            to: phone,
            text: "Usage: *removecommittee <credit|supervisory|board> <member code>*.",
          });
          return true;
        }
        const removeResult = await removeMember(coopId, removeType, removeCode, {
          phone,
          id: admin.id,
          role: "superadmin",
        });
        await sendText({ to: phone, text: removeResult.message });
        return true;
      }

      case "committees": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can view committees." });
          return true;
        }
        const committeesResult = await listCommittees(coopId);
        await sendText({ to: phone, text: committeesResult.message });
        return true;
      }

      case "interest": {
        // Interest is now tiered automatically by tenure (declining balance).
        await sendText({
          to: phone,
          text:
            "*Loan interest (declining balance tiers)*\n\n" +
            "• Up to 3 months: *20% APR* (~5% flat equivalent)\n" +
            "• 4–6 months: *16% APR* (~8% flat equivalent)\n" +
            "• 7–9 months: *12% APR* (~9% flat equivalent)\n" +
            "• 10–12 months: *10% APR* (~10% flat equivalent)\n\n" +
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
            await sendText({
              to: phone,
              text: "Invalid date format. Use: *pnl 2026-08-01 2026-08-31*",
            });
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

        const inc = Object.entries(pnl.incomeByCategory).map(
          ([c, a]) => `• ${c}: +${formatBalance(a)}`,
        );
        const exp = Object.entries(pnl.expenseByCategory).map(
          ([c, a]) => `• ${c}: −${formatBalance(a)}`,
        );
        const periodText = pnl.period
          ? ` (${pnl.period.start.toLocaleDateString()} - ${pnl.period.end.toLocaleDateString()})`
          : " (all time)";
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
        await sendLongText({ to: phone, text: body.join("\n") });
        return true;
      }

      case "pearls": {
        // WOCCU PEARLS financial-health ratios — a read-only board report.
        const pearls = await computePearls(coopId);
        const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
        const summary = [
          "*💎 PEARLS health check*",
          "",
          "*P — Protection*",
          `• Allowance / loans: *${pct(pearls.protection.allowanceToLoans)}*`,
          `• Net capital: *${pct(pearls.protection.netCapital)}*`,
          "",
          "*E — Effective structure*",
          `• Loans / assets: *${pct(pearls.effectiveStructure.loansToAssets)}*`,
          `• Savings / assets: *${pct(pearls.effectiveStructure.savingsToAssets)}*`,
          "",
          "*A — Asset quality*",
          `• PAR ratio: *${pct(pearls.assetQuality.parRatio)}*`,
          `• Provision coverage: *${pct(pearls.assetQuality.provisionCoverage)}*`,
          "",
          "*R — Rates of return*",
          `• Interest income / assets: *${pct(pearls.ratesOfReturn.interestIncomeToAssets)}*`,
          `• Cost of funds: *${pct(pearls.ratesOfReturn.costOfFunds)}*`,
          "",
          "*L — Liquidity*",
          `• Liquid assets / savings: *${pct(pearls.liquidity.liquidAssetsToSavings)}*`,
          "",
          "*S — Signs of growth*",
          `• Member growth (YoY): *${pct(pearls.signsOfGrowth.memberGrowth)}*`,
          `• Savings growth (YoY): *${pct(pearls.signsOfGrowth.savingsGrowth)}*`,
          "",
          `_Book: ${pearls.totals.members} members · savings ${formatBalance(pearls.totals.savings)} · loans ${formatBalance(pearls.totals.loans)}_`,
        ];
        await sendLongText({ to: phone, text: summary.join("\n") });
        return true;
      }

      case "expense": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can record expenses." });
          return true;
        }

        const match = args
          .join(" ")
          .trim()
          .match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
          await sendText({
            to: phone,
            text: "Usage: *expense <amount> <category> <description>*\n\nCategories: salary, stipend, purchase, external_payment, other\nExample: *expense 50000 salary August admin salary*",
          });
          return true;
        }

        const amount = toKobo(parseInt(match[1], 10));
        const category = match[2];
        const description = match[3];

        if (!Number.isFinite(amount) || amount <= 0) {
          await sendText({ to: phone, text: "Amount must be a positive number." });
          return true;
        }

        const validCategories = ["salary", "stipend", "purchase", "external_payment", "other"];
        if (!validCategories.includes(category)) {
          await sendText({
            to: phone,
            text: `Invalid category. Use: ${validCategories.join(", ")}`,
          });
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

        const inc = Object.entries(pnl.incomeByCategory).map(
          ([c, a]) => `• ${c}: +${formatBalance(a)}`,
        );
        const exp = Object.entries(pnl.expenseByCategory).map(
          ([c, a]) => `• ${c}: −${formatBalance(a)}`,
        );

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
        await sendLongText({ to: phone, text: body.join("\n") });
        return true;
      }

      case "annualreport": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can generate annual reports.",
          });
          return true;
        }
        const reportYear = parseInt(args[0]) || new Date().getFullYear();
        const startOfYear = new Date(reportYear, 0, 1);
        const endOfYear = new Date(reportYear + 1, 0, 1);

        const coopFull = await prisma.cooperative.findUnique({ where: { id: coopId } });
        if (!coopFull) {
          await sendText({ to: phone, text: "Cooperative not found." });
          return true;
        }

        const [
          totalLoansDisbursed,
          totalLoansRepaid,
          totalDividends,
          totalWithdrawals,
          memberCount,
          newMembers,
          deceasedMembers,
          activeLoans,
          walletAgg,
          reserveFund,
          eduFund,
          devFund,
          coopConfig,
          officers,
          pnl,
        ] = await Promise.all([
          prisma.loan.aggregate({
            where: {
              cooperativeId: coopId,
              status: { in: ["approved", "disbursed", "paid"] },
              approvedAt: { gte: startOfYear, lt: endOfYear },
            },
            _sum: { amount: true },
            _count: true,
          }),
          prisma.loanRepayment.aggregate({
            where: { loan: { cooperativeId: coopId }, paidAt: { gte: startOfYear, lt: endOfYear } },
            _sum: { amount: true },
          }),
          prisma.dividend.aggregate({
            where: { cooperativeId: coopId, createdAt: { gte: startOfYear, lt: endOfYear } },
            _sum: { totalPool: true },
            _count: true,
          }),
          prisma.withdrawalRequest.aggregate({
            where: {
              cooperativeId: coopId,
              status: "paid",
              finalizedAt: { gte: startOfYear, lt: endOfYear },
            },
            _sum: { amount: true },
            _count: true,
          }),
          prisma.member.count({ where: { cooperativeId: coopId, status: "active" } }),
          prisma.member.count({
            where: { cooperativeId: coopId, createdAt: { gte: startOfYear, lt: endOfYear } },
          }),
          prisma.member.count({
            where: {
              cooperativeId: coopId,
              status: "deceased",
              updatedAt: { gte: startOfYear, lt: endOfYear },
            },
          }),
          prisma.loan.aggregate({
            where: { cooperativeId: coopId, status: { in: ["approved", "disbursed"] } },
            _sum: { balance: true },
            _count: true,
          }),
          prisma.wallet.aggregate({
            where: { member: { cooperativeId: coopId } },
            _sum: { balance: true, totalSaved: true },
          }),
          prisma.cooperative.findUnique({
            where: { id: coopId },
            select: { reserveFundBalance: true },
          }),
          prisma.educationFund.aggregate({
            where: { cooperativeId: coopId },
            _sum: { amount: true },
          }),
          prisma.developmentFund.aggregate({
            where: { cooperativeId: coopId },
            _sum: { amount: true },
          }),
          prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } }),
          prisma.coopPost.findMany({
            where: { cooperativeId: coopId },
            include: { incumbent: true },
          }),
          computePnl(coopId, startOfYear, endOfYear),
        ]);

        const totalSavings = walletAgg._sum.totalSaved ?? 0;
        const totalBalance = walletAgg._sum.balance ?? 0;
        const outstandingLoans = totalLoansDisbursed._sum.amount ?? 0;
        const loanBalance = activeLoans._sum.balance ?? 0;
        const reserve = reserveFund?.reserveFundBalance ?? 0;
        const education = eduFund._sum.amount ?? 0;
        const development = devFund._sum.amount ?? 0;
        const totalRepaid = totalLoansRepaid._sum.amount ?? 0;

        const officerLines = officers
          .map((o) => `• ${o.title}: ${o.incumbent?.name ?? "Vacant"}`)
          .join("\n");

        const lastDividend = await prisma.dividend.findFirst({
          where: { cooperativeId: coopId },
          orderBy: { createdAt: "desc" },
          select: { rate: true },
        });

        const report = [
          `*ANNUAL RETURN — ${reportYear}*`,
          `*${coopFull.name}*`,
          `Registration No: ${coopFull.code}`,
          "",
          `*PART A: GENERAL INFORMATION*`,
          `• Name of Cooperative: ${coopFull.name}`,
          `• Registration Number: ${coopFull.code}`,
          `• State: ${coopFull.state || "N/A"}`,
          `• Date of Registration: ${coopFull.createdAt.toLocaleDateString("en-GB")}`,
          `• Address: ${coopFull.description || "N/A"}`,
          "",
          `*PART B: OFFICERS*`,
          officerLines || "• No officers registered",
          "",
          `*PART C: MEMBERSHIP*`,
          `• Total active members: *${memberCount}*`,
          `• New members this year: *${newMembers}*`,
          `• Deceased members this year: *${deceasedMembers}*`,
          "",
          `*PART D: SHARE CAPITAL & SAVINGS*`,
          `• Total savings mobilized this year: *${formatBalance(totalSavings)}*`,
          `• Total member wallet balance: *${formatBalance(totalBalance)}*`,
          "",
          `*PART E: LOAN ACTIVITIES*`,
          `• Total loans disbursed: *${formatBalance(outstandingLoans)}*`,
          `• Number of loans: *${totalLoansDisbursed._count}*`,
          `• Total loan repayments received: *${formatBalance(totalRepaid)}*`,
          `• Current outstanding loan balance: *${formatBalance(loanBalance)}*`,
          `• Number of active loans: *${activeLoans._count}*`,
          "",
          `*PART F: INCOME & EXPENDITURE*`,
          `• Total income: *${formatBalance(pnl.totalIncome)}*`,
          `• Total expenditure: *${formatBalance(pnl.totalExpense)}*`,
          `• Total withdrawals by members: *${formatBalance(totalWithdrawals._sum.amount ?? 0)}*`,
          `• Net surplus: *${formatBalance(pnl.netProfit)}*`,
          "",
          `*PART G: DIVIDENDS*`,
          `• Total dividends declared: *${formatBalance(totalDividends._sum.totalPool ?? 0)}*`,
          `• Number of dividend distributions: *${totalDividends._count}*`,
          `• Dividend rate: *${lastDividend ? `${lastDividend.rate}%` : coopConfig ? `${coopConfig.lastDividendRate ?? coopConfig.loanInterestRate}%` : "N/A"}*`,
          "",
          `*PART H: STATUTORY FUNDS*`,
          `• Reserve Fund (20%): *${formatBalance(reserve)}*`,
          `• Education Fund (2%): *${formatBalance(education)}*`,
          `• Development Fund (5%): *${formatBalance(development)}*`,
          `• Total statutory funds: *${formatBalance(reserve + education + development)}*`,
          "",
          `*PART I: LOAN POLICY*`,
          `• Interest rate: *${coopConfig?.loanInterestRate ?? 10}%*`,
          `• Max loan multiplier: *${coopConfig?.maxLoanMultiplier ?? 3}x savings*`,
          `• Late fine: *${coopConfig?.lateFinePercent ?? 5}%*`,
          `• Minimum contribution: *${formatBalance(coopConfig?.minContribution ?? 200000)}*`,
          "",
          `_Generated: ${new Date().toLocaleDateString("en-GB")}_`,
          `_This report is suitable for filing with the State Cooperative Registrar._`,
          `_NOTE: For official filing, export this report as PDF/DOCX via the export command or system admin._`,
        ];
        await sendLongText({ to: phone, text: report.join("\n") });
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
          // NOTE: Reserve, education, and development funds have no withdrawal
          // mechanism by design — they accumulate statutorily per the Nigerian
          // Cooperative Societies Act. If legitimate spends are needed (e.g.,
          // education fund for member training, development fund for projects),
          // a dedicated `fundwithdraw` admin command should be added with
          // appropriate approval gates and audit trails.
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

      case "par": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can view portfolio risk." });
          return true;
        }
        const par = await computePar(coopId);
        const parBody = [
          `*📉 Portfolio At Risk (PAR)*`,
          ``,
          `• 1–30 days overdue: *${formatBalance(par.buckets["1-30"])}*`,
          `• 31–90 days overdue: *${formatBalance(par.buckets["31-90"])}*`,
          `• 91–180 days overdue: *${formatBalance(par.buckets["91-180"])}*`,
          `• 180+ days overdue: *${formatBalance(par.buckets["180+"])}*`,
          ``,
          `Past-due total: *${formatBalance(par.total)}*`,
          `PAR ratio: *${(par.parRatio * 100).toFixed(1)}%*`,
          ``,
          `_Run provisioning with *provision*._`,
        ];
        await sendText({ to: phone, text: parBody.join("\n") });
        return true;
      }

      case "provisionrates": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can view provision rates." });
          return true;
        }
        const rates = await provisionRates(coopId);
        const ratesBody = [
          `*Loan-loss provision rates*`,
          ``,
          `• 1–30 days overdue: *${rates["1-30"]}%*`,
          `• 31–90 days overdue: *${rates["31-90"]}%*`,
          `• 91–180 days overdue: *${rates["91-180"]}%*`,
          `• 180+ days overdue: *${rates["180+"]}%*`,
        ];
        await sendText({ to: phone, text: ratesBody.join("\n") });
        return true;
      }

      case "provision": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can run loan-loss provisioning.",
          });
          return true;
        }
        const provisionResult = await runProvision(coopId, {
          id: admin.id,
          phone,
          role: admin.role,
        });
        await sendText({ to: phone, text: provisionResult.message });
        return true;
      }

      case "payanyone": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Unit admins can't initiate organization payments." });
          return true;
        }
        const amount = toKobo(Number(args[0]));
        const accountNumber = args[1] ?? "";
        const bankCode = args[2]?.toUpperCase() ?? "";
        const narration = args.slice(3).join(" ").trim();
        if (
          !Number.isFinite(amount) ||
          amount <= 0 ||
          !/^\d{10}$/.test(accountNumber) ||
          !bankCode ||
          narration.length < 3
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
        const provider = await resolveProvider();
        let beneficiaryName = "";
        if (provider.resolveAccount) {
          const resolved = await provider.resolveAccount!({ accountNumber, bankCode });
          if (!resolved.ok || !resolved.name) {
            await sendText({
              to: phone,
              text: `Could not verify that account (${resolved.error ?? "unknown error"}). Check the number and bank code — no request was created.`,
            });
            return true;
          }
          beneficiaryName = resolved.name;
        } else {
          await sendText({
            to: phone,
            text: "Payment provider can't resolve accounts right now — try again later.",
          });
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
          await sendText({
            to: phone,
            text: "Usage: *addoption <poll id> <item name> <cost> <vendor account> <bank>*",
          });
          return true;
        }
        const name = args.slice(1, costIdx).join(" ");
        const cost = toKobo(Number(args[costIdx]));
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
          await sendText({
            to: phone,
            text: "No buy-votes yet. Admins open one with *startbuyvote <title>*.",
          });
          return true;
        }
        const parts: string[] = [];
        for (const p of polls) {
          parts.push(
            `🛒 *${p.title}* (${p.status}) — id *${p.id.slice(-6)}*`,
            ...p.options.map(
              (o, i) =>
                `   ${i + 1}. ${o.name} — ~${formatBalance(o.estimatedCost)} — ${o._count.ballots} vote(s)`,
            ),
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
          await sendText({
            to: phone,
            text: "Usage: *setsalary <phone> <amount>* or *setsalary <phone> off*",
          });
          return true;
        }
        const off = amountArg.toLowerCase() === "off";
        const amount = Number(amountArg);
        if (!off && (!Number.isFinite(amount) || amount <= 0)) {
          await sendText({
            to: phone,
            text: "Amount must be a positive number, or reply *setsalary <phone> off* to stop.",
          });
          return true;
        }
        const result = await setSalary(
          { id: admin.id, phone, role: admin.role, cooperativeId: coopId },
          targetPhone,
          off ? "off" : toKobo(amount),
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
          .map(
            (r) =>
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
        const result = await runPayroll(
          coopId,
          { id: admin.id, phone, role: admin.role },
          narration,
        );
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
          await sendText({
            to: phone,
            text: "Usage: *setlimit <amount>* — daily ceiling on total money-out, e.g. *setlimit 500000*.",
          });
          return true;
        }
        await prisma.cooperative.update({
          where: { id: coopId },
          data: { dailyPayoutLimit: toKobo(amount) },
        });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: "superadmin",
          action: "fraud.set_limit",
          detail: `daily payout limit -> ${formatBalance(amount)}`,
        });
        await sendText({
          to: phone,
          text: `✅ Daily payout ceiling set to *${formatBalance(amount)}*.`,
        });
        return true;
      }

      case "backup": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* triggers backups." });
          return true;
        }
        const result = await runBackup();
        await sendText({
          to: phone,
          text: result.ok ? `🗄️ ${result.message}` : `⚠️ ${result.message}`,
        });
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
          text:
            alerts.length === 0
              ? "🌙 Reconciliation clean — no anomalies found. ✅"
              : `🌙 Reconciliation found:\n\n${alerts.join("\n")}`,
        });
        return true;
      }

      case "walletreconcile": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* runs wallet-bank reconciliation.",
          });
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
          await sendText({
            to: phone,
            text: "Usage: *paydividend <rate%>*, e.g. *paydividend 5* to pay a 5% dividend.",
          });
          return true;
        }
        if (rate > 25) {
          await sendText({
            to: phone,
            text: "Dividend rate cannot exceed 25% per the Nigerian Cooperative Societies Act.",
          });
          return true;
        }
        const coopConfig = await getCoopConfig(coopId);
        const lastRate = coopConfig.lastDividendRate;
        const approvedVote = await prisma.dividendVote.findFirst({
          where: { cooperativeId: coopId, proposedRate: rate, status: "approved" },
          orderBy: { closedAt: "desc" },
        });
        if (lastRate !== null && Math.abs(rate - lastRate) > 5 && !approvedVote) {
          await updateCoopConfig(coopId, { pendingDividendRate: rate } as any);
          await audit({
            cooperativeId: coopId,
            actorPhone: phone,
            actorId: admin.id,
            actorRole: "superadmin",
            action: "dividend.vote_required",
            detail: `proposed ${rate}% differs ${Math.abs(rate - lastRate)}% from last ${lastRate}% — member vote needed`,
          });
          await sendText({
            to: phone,
            text:
              `⚠️ The proposed rate *${rate}%* differs by *${Math.abs(rate - lastRate)}%* from the last dividend rate (${lastRate}%).\n\n` +
              `Cooperative governance requires member approval for rate changes above 5%.\n\n` +
              `Reply *startvotediv ${rate}* to open a member vote on this rate.`,
          });
          return true;
        }
        // GUARDRAIL: never move money off a single casual message. Show the
        // numbers and require an explicit `CONFIRM <rate>` inside the session
        // TTL. The actual run happens in the awaiting_dividend_confirm handler.
        const preview = await previewDividendRun(phone, rate);
        if (!preview.ok || !preview.confirmToken) {
          await sendText({ to: phone, text: preview.message });
          return true;
        }
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_dividend_confirm",
            data: JSON.stringify({ dividendRate: rate }),
          },
          update: {
            state: "awaiting_dividend_confirm",
            data: JSON.stringify({ dividendRate: rate }),
          },
        });
        await sendText({ to: phone, text: preview.message });
        return true;
      }

      case "paysharedividend": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can distribute dividends." });
          return true;
        }
        const rate = Number(args[0]);
        if (!Number.isFinite(rate) || rate <= 0 || rate > 25) {
          await sendText({
            to: phone,
            text: "Usage: *paysharedividend <rate%>*, e.g. *paysharedividend 5* to pay 5% of profit on shares.",
          });
          return true;
        }
        const preview = await previewDividendRun(phone, rate, "shares");
        if (!preview.ok || !preview.confirmToken) {
          await sendText({ to: phone, text: preview.message });
          return true;
        }
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_sharedividend_confirm",
            data: JSON.stringify({ shareDividendRate: rate }),
          },
          update: {
            state: "awaiting_sharedividend_confirm",
            data: JSON.stringify({ shareDividendRate: rate }),
          },
        });
        await sendText({ to: phone, text: preview.message });
        return true;
      }

      case "startvotediv": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can open a dividend-rate vote.",
          });
          return true;
        }
        const voteResult = await startDividendVote(
          { id: admin.id, name: admin.name, phone, role: admin.role, cooperativeId: coopId },
          args[0] ?? "",
        );
        await sendText({ to: phone, text: voteResult.message });
        return true;
      }

      case "closedivid": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can close a dividend-rate vote.",
          });
          return true;
        }
        const voteResult = await closeDividendVote(
          { id: admin.id, name: admin.name, phone, role: admin.role, cooperativeId: coopId },
          args[0],
        );
        await sendText({ to: phone, text: voteResult.message });
        return true;
      }

      case "votedivstatus": {
        const voteResult = await dividendVoteStatus(coopId);
        await sendText({ to: phone, text: voteResult.message });
        return true;
      }

      case "setpost": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can assign executive posts." });
          return true;
        }
        const [rawTitle, rawCode] = args;
        if (!rawTitle || !rawCode) {
          await sendText({
            to: phone,
            text: "Usage: *setpost <post> <member code>*, e.g. *setpost treasurer A1B2C3*.",
          });
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
          create: {
            cooperativeId: coopId,
            title,
            incumbentId: holder.id,
            appointedById: admin.id,
            appointedAt: new Date(),
          },
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
        await notifyMember(
          holder,
          `🏛 You have been appointed *${displayTitle(title)}*. Congratulations!`,
        );
        await sendText({
          to: phone,
          text: `✅ ${displayTitle(title)} is now ${holder.name} (${code}).`,
        });
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
          await notifyMember(
            post.incumbent,
            `🏛 You are no longer *${displayTitle(title)}*. The seat is now vacant.`,
          );
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

      case "recordcheque": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can record a cheque." });
          return true;
        }
        const [ref, amountArg, ...chequeParts] = args;
        const amount = Number(amountArg);
        if (!ref || !Number.isFinite(amount) || amount <= 0) {
          await sendText({
            to: phone,
            text: "Usage: *recordcheque <ref> <amount> [cheque ref]*",
          });
          return true;
        }
        const result = await recordCheque(
          phone,
          ref,
          toKobo(amount),
          chequeParts.join(" ") || undefined,
        );
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "reconbatch": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can reconcile a batch." });
          return true;
        }
        const [ref, amountArg] = args;
        const amount = Number(amountArg);
        if (!ref || !Number.isFinite(amount) || amount <= 0) {
          await sendText({ to: phone, text: "Usage: *reconbatch <ref> <amount>*" });
          return true;
        }
        const result = await reconcileBatch(phone, ref, toKobo(amount));
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "approvebatch":
      case "rejectbatch": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can approve or reject deduction batches.",
          });
          return true;
        }
        if (!args[0]) {
          await sendText({
            to: phone,
            text:
              `Usage: *${cmd} <ref>*` +
              (cmd === "rejectbatch" ? " [reason]" : cmd === "approvebatch" ? " [partial]" : ""),
          });
          return true;
        }
        const result =
          cmd === "approvebatch"
            ? await approveBatch(phone, args[0], { partial: args.slice(1).includes("partial") })
            : await rejectBatch(phone, args[0], args.slice(1).join(" ") || undefined);
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "setcommit": {
        const [code, amountArg] = args;
        const amount = Number(amountArg);
        if (!code || !Number.isFinite(amount)) {
          await sendText({
            to: phone,
            text: "Usage: *setcommit <member code> <amount>* — 0 stops the deduction.",
          });
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

      case "confirmname": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can confirm a member's name.",
          });
          return true;
        }
        const code = args[0]?.toUpperCase();
        if (!code) {
          await sendText({ to: phone, text: "Usage: *confirmname <member code>*" });
          return true;
        }
        const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
        if (!target) {
          await sendText({ to: phone, text: `No member found with code ${code}.` });
          return true;
        }
        if (target.id === admin.id) {
          await sendText({
            to: phone,
            text: "You cannot confirm your own name — ask another super admin.",
          });
          return true;
        }
        await prisma.member.update({ where: { id: target.id }, data: { nameVerified: true } });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: "superadmin",
          action: "member.name.confirm",
          targetType: "member",
          targetId: target.id,
          detail: target.name,
        });
        await notifyMember(
          target,
          "✅ Your name has been confirmed by a super admin. You can now create deduction batches.",
        ).catch(() => {});
        await sendText({ to: phone, text: `✅ ${target.name}'s name is now confirmed.` });
        return true;
      }

      case "approvephone":
      case "rejectphone": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can approve or reject phone changes.",
          });
          return true;
        }
        const code = args[0]?.toUpperCase();
        if (!code) {
          await sendText({
            to: phone,
            text: `Usage: *${cmd} <member code>*` + (cmd === "rejectphone" ? " [reason]" : ""),
          });
          return true;
        }
        const result =
          cmd === "approvephone"
            ? await approvePhoneChange(phone, code)
            : await rejectPhoneChange(phone, code, args.slice(1).join(" ") || undefined);
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "relink": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can relink a member's account.",
          });
          return true;
        }
        const [rawCode, newChannel] = args;
        if (!rawCode || !newChannel) {
          await sendText({
            to: phone,
            text: "Usage: *relink <member code> <new number>* — e.g. *relink A1B2C3 2348012345678* (or tg:<chatid>).",
          });
          return true;
        }
        const target = await prisma.member.findFirst({
          where: { code: rawCode.toUpperCase(), cooperativeId: coopId },
        });
        if (!target) {
          await sendText({
            to: phone,
            text: `No member found with code ${rawCode.toUpperCase()}.`,
          });
          return true;
        }
        const oldPhone = target.phone;
        await withTxBatch([
          prisma.member.update({
            where: { id: target.id },
            data: { phone: newChannel, preferredChannel: null },
          }),
          prisma.session.deleteMany({ where: { phone: oldPhone } }),
          prisma.session.deleteMany({ where: { phone: newChannel } }),
        ]);
        // Best-effort heads-up to the old channel in case it is still alive.
        await sendText({
          to: oldPhone,
          text: "🔐 This account has been moved to a new number by your co-op admin. If this was not you, contact them immediately.",
        }).catch(() => {});
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
          await sendText({
            to: phone,
            text: "Only the *super admin* can unlink a member's second channel.",
          });
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
        await sendText({
          to: phone,
          text: `✅ Second channel detached from ${target.name}. They now chat only on ${target.phone}.`,
        });
        return true;
      }

      case "str": {
        const memberPhone = args[0];
        if (!memberPhone) {
          await sendText({
            to: phone,
            text: "Usage: *str <member-phone>* — e.g. *str 2348012345678*",
          });
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
          "loanInterestRate",
          "serviceChargePercent",
          "minContribution",
          "minSavings",
          "minWithdrawal",
          "maxWithdrawal",
          "withdrawalCooldownMonths",
          "lateFinePercent",
          "maxLoanMultiplier",
          "autoApproveLoans",
          "requireGuarantors",
          "minGuarantors",
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
        const memberCount = await prisma.member.count({
          where: { cooperativeId: coopId, status: "active" },
        });
        const body = [
          `*Subscription & Billing*`,
          ``,
          `• Plan: *${sub.plan}*`,
          `• Status: *${sub.status}*`,
          `• Members: *${memberCount} / ${sub.memberLimit}*`,
          `• Monthly price: *${formatBalance(sub.monthlyPrice)}*`,
          sub.currentPeriodEnd
            ? `• Renews: *${sub.currentPeriodEnd.toISOString().slice(0, 10)}*`
            : "",
        ].filter(Boolean);
        await sendText({ to: phone, text: body.join("\n") });
        return true;
      }

      case "status": {
        const arg = args.join(" ").trim().toLowerCase();
        if (arg === "on") {
          await sendText({
            to: phone,
            text: "✅ Auto-status enabled. The bot will post financial tips 3 times daily (8AM, 12PM, 6PM).",
          });
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
        const gBody = grievanceList
          .map(
            (g) =>
              `• *${g.id.slice(-6)}* — ${g.member.name} (${g.member.code}): ${g.message.slice(0, 100)}${g.message.length > 100 ? "..." : ""}`,
          )
          .join("\n");
        await sendText({
          to: phone,
          text: `*Open Grievances*\n\n${gBody}\n\nResolve with *resolve <id> <response>*`,
        });
        return true;
      }

      case "mandates": {
        const listed = await listCoopMandates(coopId);
        const rows = listed.mandates ?? [];
        if (rows.length === 0) {
          await sendText({ to: phone, text: "No direct-debit mandates yet. ✅" });
          return true;
        }
        const owners = await prisma.member.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.memberId))] } },
          select: { id: true, name: true },
        });
        const ownerName = new Map(owners.map((o) => [o.id, o.name]));
        const body = rows
          .map((r) => {
            const paused = r.pausedPurposes
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            const state =
              r.status === "active" && paused.length > 0
                ? `active (paused: ${paused.join(", ")})`
                : r.status;
            const ref = r.id.slice(-6);
            return (
              `• *${ref}* — ${ownerName.get(r.memberId) ?? "member"} — *${state}* — cap ${formatBalance(r.amountCap)}\n` +
              `   Pause: *pausemandate ${ref}* · Resume: *resumemandate ${ref}*`
            );
          })
          .join("\n");
        await sendText({
          to: phone,
          text: `*Direct-debit mandates (${rows.length})*\n\n${body}`,
        });
        return true;
      }

      case "pausemandate":
      case "resumemandate": {
        const ref = args[0];
        if (!ref) {
          await sendText({
            to: phone,
            text: `Usage: *${cmd} <mandate id> [savings|loan|group]*.`,
          });
          return true;
        }
        const target = await prisma.mandate.findFirst({
          where: {
            cooperativeId: coopId,
            OR: [{ id: ref }, { id: { startsWith: ref } }, { id: { endsWith: ref } }],
          },
        });
        if (!target) {
          await sendText({ to: phone, text: "Mandate not found." });
          return true;
        }
        const purpose = args[1]?.trim().toLowerCase() || null;
        if (purpose && !["savings", "loan", "group"].includes(purpose)) {
          await sendText({
            to: phone,
            text: `Unknown purpose *${purpose}*. Use *savings*, *loan* or *group*.`,
          });
          return true;
        }
        const mandateActor = { id: admin.id, phone, role: admin.role };
        const result =
          cmd === "pausemandate"
            ? await pauseMandate(coopId, target.id, purpose, mandateActor)
            : await resumeMandate(coopId, target.id, purpose, mandateActor);
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "skipdebit": {
        const ref = args[0];
        if (!ref) {
          await sendText({ to: phone, text: "Usage: *skipdebit <debit id>*." });
          return true;
        }
        const target = await prisma.mandateDebit.findFirst({
          where: {
            cooperativeId: coopId,
            OR: [{ id: ref }, { id: { startsWith: ref } }, { id: { endsWith: ref } }],
          },
        });
        if (!target) {
          await sendText({ to: phone, text: "Debit not found." });
          return true;
        }
        const result = await skipDebit(coopId, target.id, {
          id: admin.id,
          phone,
          role: admin.role,
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "recommendrefund": {
        // Maker step: an admin recommends a refund the coop owes a member (e.g.
        // a double payment: bank/cheque + direct debit). A super admin approves.
        const target = args[0];
        const amount = toKobo(Number(args[1]));
        const reason = args.slice(2).join(" ").trim();
        if (!target || !Number.isFinite(amount) || amount <= 0 || reason.length < 3 || reason.length > 200) {
          await sendText({
            to: phone,
            text: "Usage: *recommendrefund <member code|id> <amount> <reason>* — e.g. *recommendrefund MEM001 5000 Double payment* (reason up to 200 characters).",
          });
          return true;
        }
        const result = await recommendRefund(coopId, target, amount, reason, {
          id: admin.id,
          phone,
          role: admin.role,
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "approverefund": {
        // Checker step: only a super admin approves and pays the refund.
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can approve a refund." });
          return true;
        }
        const id = args[0];
        if (!id) {
          await sendText({ to: phone, text: "Usage: *approverefund <refund id>*" });
          return true;
        }
        const result = await approveRefund(coopId, id, {
          id: admin.id,
          phone,
          role: admin.role,
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "rejectrefund": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can reject a refund." });
          return true;
        }
        const id = args[0];
        const reason = args.slice(1).join(" ").trim();
        if (!id) {
          await sendText({ to: phone, text: "Usage: *rejectrefund <refund id> [reason]*" });
          return true;
        }
        const result = await rejectRefund(coopId, id, reason, {
          id: admin.id,
          phone,
          role: admin.role,
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "startmeeting": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can call meetings." });
          return true;
        }
        const type = args[0]?.toLowerCase();
        const rest = args.slice(1);
        const lastArg = rest[rest.length - 1] ?? "";
        const hasQuorum = /^\d+$/.test(lastArg);
        const title = (hasQuorum ? rest.slice(0, -1) : rest).join(" ").trim();
        if (!type || !title) {
          await sendText({
            to: phone,
            text: "Usage: *startmeeting <agm|sgm> <title> [quorum%]* — e.g. *startmeeting agm 2026 Annual General Meeting 50*.",
          });
          return true;
        }
        const startRes = await startMeeting(coopId, type, title, hasQuorum ? Number(lastArg) : undefined, {
          id: admin.id,
          role: admin.role,
          phone,
        });
        await sendText({ to: phone, text: startRes.message });
        return true;
      }

      case "openmeeting": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can open meetings." });
          return true;
        }
        const openId = args[0];
        if (!openId) {
          await sendText({ to: phone, text: "Usage: *openmeeting <meeting id>*" });
          return true;
        }
        const openRes = await openMeeting(coopId, openId, {
          id: admin.id,
          role: admin.role,
          phone,
        });
        await sendText({ to: phone, text: openRes.message });
        return true;
      }

      case "closemeeting": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can close meetings." });
          return true;
        }
        const closeId = args[0];
        if (!closeId) {
          await sendText({ to: phone, text: "Usage: *closemeeting <meeting id>*" });
          return true;
        }
        const closeRes = await closeMeeting(coopId, closeId, {
          id: admin.id,
          role: admin.role,
          phone,
        });
        await sendText({ to: phone, text: closeRes.message });
        return true;
      }

      case "addmotion": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can add motions." });
          return true;
        }
        const motionMeetingRef = args[0];
        const rawMotion = args.slice(1).join(" ").trim();
        const [titlePart, ...descParts] = rawMotion.split("|");
        const motionTitle = titlePart.trim();
        let motionDesc = descParts.join("|").trim();
        let motionKind = "general";
        const descWords = motionDesc.split(/\s+/).filter(Boolean);
        const maybeKind = descWords[descWords.length - 1]?.toLowerCase();
        if (maybeKind && (MOTION_KINDS as readonly string[]).includes(maybeKind)) {
          motionKind = maybeKind;
          motionDesc = descWords.slice(0, -1).join(" ").trim();
        }
        if (!motionMeetingRef || !motionTitle || !motionDesc) {
          await sendText({
            to: phone,
            text: "Usage: *addmotion <meeting id> <title> | <description> [general|bylaw|dividend|election]*",
          });
          return true;
        }
        const addMotionRes = await addMotion(
          coopId,
          motionMeetingRef,
          motionTitle,
          motionDesc,
          motionKind,
          { id: admin.id, role: admin.role, phone },
        );
        await sendText({ to: phone, text: addMotionRes.message });
        return true;
      }

      case "closemotion": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can close motions." });
          return true;
        }
        const closeMotionId = args[0];
        if (!closeMotionId) {
          await sendText({ to: phone, text: "Usage: *closemotion <motion id>*" });
          return true;
        }
        const closeMotionRes = await closeMotion(coopId, closeMotionId, {
          id: admin.id,
          role: admin.role,
          phone,
        });
        await sendText({ to: phone, text: closeMotionRes.message });
        return true;
      }

      case "meetingminutes": {
        const minutesId = args[0];
        if (!minutesId) {
          await sendText({ to: phone, text: "Usage: *meetingminutes <meeting id>*" });
          return true;
        }
        const minutesRes = await meetingMinutes(coopId, minutesId);
        await sendText({ to: phone, text: minutesRes.message });
        if (minutesRes.ok) {
          const baseUrl = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;
          const exportRes = await exportMeetingMinutes(
            { id: admin.id, name: admin.name, email: admin.email ?? null, cooperativeId: coopId },
            minutesId,
            baseUrl,
          );
          if (exportRes.ok) await sendText({ to: phone, text: exportRes.message });
        }
        return true;
      }

      case "agm": {
        const subcommand = args[0];
        if (subcommand === "schedule") {
          if (!isSuper) {
            await sendText({ to: phone, text: "Only super admins can schedule AGM." });
            return true;
          }
          const dateStr = args[1];
          if (!dateStr) {
            await sendText({ to: phone, text: "Usage: *agm schedule YYYY-MM-DD*" });
            return true;
          }
          const agmDate = new Date(dateStr);
          if (isNaN(agmDate.getTime())) {
            await sendText({ to: phone, text: "Invalid date format." });
            return true;
          }
          await prisma.cooperativeConfig.upsert({
            where: { cooperativeId: coopId },
            update: { nextAGMDate: agmDate },
            create: { cooperativeId: coopId, nextAGMDate: agmDate },
          });
          await sendText({
            to: phone,
            text: `AGM scheduled for ${agmDate.toLocaleDateString("en-GB")}`,
          });
          return true;
        }
        if (subcommand === "info") {
          const config = await prisma.cooperativeConfig.findUnique({
            where: { cooperativeId: coopId },
          });
          if (!config?.nextAGMDate) {
            await sendText({ to: phone, text: "No AGM scheduled yet." });
            return true;
          }
          await sendText({
            to: phone,
            text: `Next AGM: ${config.nextAGMDate.toLocaleDateString("en-GB")}`,
          });
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
          if (!title || !content) {
            await sendText({ to: phone, text: "Usage: *byelaws add <title> <content>*" });
            return true;
          }
          await prisma.byelaw.create({ data: { cooperativeId: coopId, title, content } });
          await sendText({ to: phone, text: `Byelaw "${title}" added.` });
          return true;
        }
        const byelaws = await prisma.byelaw.findMany({
          where: { cooperativeId: coopId },
          orderBy: { createdAt: "desc" },
        });
        if (byelaws.length === 0) {
          await sendText({ to: phone, text: "No byelaws registered yet." });
          return true;
        }
        const byelawLines = ["*📜 Cooperative Byelaws*", ""];
        for (const b of byelaws) {
          byelawLines.push(`*${b.title}*`, b.content, "");
        }
        await sendText({ to: phone, text: byelawLines.join("\n") });
        return true;
      }

      case "strs": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only super admins can view STRs." });
          return true;
        }
        const strs = await prisma.sTR.findMany({
          where: { cooperativeId: coopId },
          include: { member: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        });
        if (strs.length === 0) {
          await sendText({ to: phone, text: "No STRs filed." });
          return true;
        }
        const strLines = ["*📋 Suspicious Transaction Reports*", ""];
        for (const s of strs) {
          strLines.push(
            `• ${s.member.name} — ${formatBalance(s.amount)} — ${s.status} — ${s.reason}`,
          );
        }
        await sendText({ to: phone, text: strLines.join("\n") });
        return true;
      }

      case "tin": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can manage TIN." });
          return true;
        }
        const sub = args[0]?.toLowerCase();
        if (sub === "set") {
          const tin = args.slice(1).join(" ").trim();
          if (!tin) {
            await sendText({
              to: phone,
              text: "Usage: *tin set <TIN>* — e.g. *tin set 12345678-0001*",
            });
            return true;
          }
          await prisma.cooperativeConfig.upsert({
            where: { cooperativeId: coopId },
            update: { taxIdentificationNumber: tin },
            create: { cooperativeId: coopId, taxIdentificationNumber: tin },
          });
          await audit({
            cooperativeId: coopId,
            actorPhone: phone,
            actorId: admin.id,
            actorRole: "superadmin",
            action: "tin.set",
            detail: `TIN -> ${tin}`,
          });
          await sendText({ to: phone, text: `✅ TIN set to *${tin}*.` });
          return true;
        }
        if (sub === "info") {
          const config = await prisma.cooperativeConfig.findUnique({
            where: { cooperativeId: coopId },
          });
          const tin = config?.taxIdentificationNumber;
          const coopType = config?.cooperativeType ?? "member";
          const commIncome = config?.commercialIncome ?? 0;
          const body = [
            "*🏛 Tax Identification Number*",
            "",
            `• TIN: *${tin ?? "Not set"}*`,
            `• Cooperative type: *${coopType}*`,
            `• Commercial income: *${formatBalance(commIncome)}*`,
            "",
            tin ? "_TIN is registered with FIRS._" : "_Use *tin set <TIN>* to register._",
          ];
          await sendText({ to: phone, text: body.join("\n") });
          return true;
        }
        await sendText({ to: phone, text: "Usage: *tin set <TIN>* or *tin info*" });
        return true;
      }

      case "paye": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can manage PAYE." });
          return true;
        }
        const sub = args[0]?.toLowerCase();
        if (sub === "add") {
          const memberCode = args[1]?.toUpperCase();
          const gross = Number(args[2]);
          if (!memberCode || !Number.isFinite(gross) || gross <= 0) {
            await sendText({
              to: phone,
              text: "Usage: *paye add <member code> <gross amount>* — e.g. *paye add A1B2C3 500000*",
            });
            return true;
          }
          const target = await prisma.member.findFirst({
            where: { code: memberCode, cooperativeId: coopId },
          });
          if (!target) {
            await sendText({ to: phone, text: `No member with code *${memberCode}*.` });
            return true;
          }
          const now = new Date();
          const month = now.getMonth() + 1;
          const year = now.getFullYear();
          const existing = await prisma.pAYERecord.findUnique({
            where: {
              cooperativeId_memberId_month_year: {
                cooperativeId: coopId,
                memberId: target.id,
                month,
                year,
              },
            },
          });
          if (existing) {
            await sendText({
              to: phone,
              text: `PAYE already recorded for ${target.name} in ${month}/${year}. Use *paye remit* to mark as remitted.`,
            });
            return true;
          }
          // Nigeria PAYE: first ₦300k/month exempt, then 7% up to ₦500k, 11% up to ₦1.16M, 15% up to ₦1.62M, 19% up to ₦3.22M, 21% up to ₦6.42M, 24% above
          // `gross` is entered in NAIRA (e.g. `paye add A1B2C3 500000`); convert to
          // kobo before comparing against the kobo-denominated exemption/brackets.
          const grossKobo = toKobo(gross);
          const exemptKobo = 30_000_00; // ₦300,000
          let taxable = Math.max(0, grossKobo - exemptKobo);
          let tax = 0;
          const brackets = [
            { limit: 20_000_00, rate: 0.07 }, // ₦200k @ 7%
            { limit: 66_000_00, rate: 0.11 }, // ₦660k @ 11%
            { limit: 46_000_00, rate: 0.15 }, // ₦460k @ 15%
            { limit: 160_000_00, rate: 0.19 }, // ₦1.6M @ 19%
            { limit: 320_000_00, rate: 0.21 }, // ₦3.2M @ 21%
            { limit: Infinity, rate: 0.24 }, // above @ 24%
          ];
          for (const b of brackets) {
            if (taxable <= 0) break;
            const chunk = Math.min(taxable, b.limit);
            tax += Math.round(chunk * b.rate);
            taxable -= chunk;
          }
          const net = grossKobo - tax;
          const record = await prisma.pAYERecord.create({
            data: {
              cooperativeId: coopId,
              memberId: target.id,
              month,
              year,
              grossAmount: grossKobo,
              taxAmount: tax,
              netAmount: net,
            },
          });
          await audit({
            cooperativeId: coopId,
            actorPhone: phone,
            actorId: admin.id,
            actorRole: "superadmin",
            action: "paye.add",
            targetType: "paye",
            targetId: record.id,
            detail: `${target.name}: gross ${formatBalance(grossKobo)}, tax ${formatBalance(tax)}, net ${formatBalance(net)}`,
          });
          await sendText({
            to: phone,
            text: `✅ PAYE recorded for *${target.name}* (${month}/${year}):\n\n• Gross: *${formatBalance(grossKobo)}*\n• Tax: *${formatBalance(tax)}*\n• Net: *${formatBalance(net)}*\n\nRecord ID: *${record.id.slice(-6)}*`,
          });
          return true;
        }
        if (sub === "report") {
          const now = new Date();
          const m = args[1] ? Number(args[1]) : now.getMonth() + 1;
          const y = args[2] ? Number(args[2]) : now.getFullYear();
          if (!Number.isFinite(m) || m < 1 || m > 12 || !Number.isFinite(y)) {
            await sendText({
              to: phone,
              text: "Usage: *paye report [month] [year]* — e.g. *paye report 8 2026*",
            });
            return true;
          }
          const records = await prisma.pAYERecord.findMany({
            where: { cooperativeId: coopId, month: m, year: y },
            include: { member: { select: { name: true, code: true } } },
            orderBy: { createdAt: "asc" },
          });
          if (records.length === 0) {
            await sendText({ to: phone, text: `No PAYE records for ${m}/${y}.` });
            return true;
          }
          let totalGross = 0,
            totalTax = 0,
            totalNet = 0;
          const lines = records.map((r) => {
            totalGross += r.grossAmount;
            totalTax += r.taxAmount;
            totalNet += r.netAmount;
            const status = r.status === "remitted" ? "✅" : "⏳";
            return `• ${r.member.name} (${r.member.code}) — Gross: ${formatBalance(r.grossAmount)} — Tax: ${formatBalance(r.taxAmount)} — ${status}`;
          });
          const report = [
            `*📊 PAYE Report — ${m}/${y}*`,
            "",
            ...lines,
            "",
            `*Totals:* Gross: *${formatBalance(totalGross)}* · Tax: *${formatBalance(totalTax)}* · Net: *${formatBalance(totalNet)}*`,
            `Records: *${records.length}* · Remitted: *${records.filter((r) => r.status === "remitted").length}/${records.length}*`,
            "",
            `_SIRS filing ID: ${coopId.slice(-6)}-${y}${String(m).padStart(2, "0")}_`,
          ];
          await sendText({ to: phone, text: report.join("\n") });
          return true;
        }
        if (sub === "remit") {
          const id = args[1];
          if (!id) {
            await sendText({
              to: phone,
              text: "Usage: *paye remit <record id>* — marks PAYE as remitted to state IRS.",
            });
            return true;
          }
          const record = await prisma.pAYERecord.findFirst({
            where: {
              OR: [{ id }, { id: { startsWith: id } }, { id: { endsWith: id } }],
              cooperativeId: coopId,
            },
            include: { member: { select: { name: true } } },
          });
          if (!record) {
            await sendText({ to: phone, text: `No PAYE record found with id *${id}*.` });
            return true;
          }
          if (record.status === "remitted") {
            await sendText({
              to: phone,
              text: `PAYE for ${record.member.name} (${record.month}/${record.year}) already remitted.`,
            });
            return true;
          }
          await prisma.pAYERecord.update({
            where: { id: record.id },
            data: { status: "remitted", remittedAt: new Date() },
          });
          await audit({
            cooperativeId: coopId,
            actorPhone: phone,
            actorId: admin.id,
            actorRole: "superadmin",
            action: "paye.remit",
            targetType: "paye",
            targetId: record.id,
            detail: `${record.member.name} — ${formatBalance(record.taxAmount)} remitted`,
          });
          await sendText({
            to: phone,
            text: `✅ PAYE for *${record.member.name}* (${record.month}/${record.year}) marked as remitted to state IRS.`,
          });
          return true;
        }
        await sendText({
          to: phone,
          text: "Usage:\n• *paye add <member code> <gross>* — record PAYE\n• *paye report [month] [year]* — SIRS report\n• *paye remit <id>* — mark as remitted",
        });
        return true;
      }

      case "taxstatus": {
        const config = await prisma.cooperativeConfig.findUnique({
          where: { cooperativeId: coopId },
        });
        const tin = config?.taxIdentificationNumber;
        const coopType = config?.cooperativeType ?? "member";
        const commIncome = config?.commercialIncome ?? 0;

        // CIT exemption: member-type cooperatives are exempt from Companies Income Tax
        const citExempt = coopType === "member";

        // PAYE compliance: count pending vs remitted
        const payeCounts = await prisma.pAYERecord.groupBy({
          by: ["status"],
          where: { cooperativeId: coopId },
          _count: true,
        });
        const pendingPAYE = payeCounts.find((p) => p.status === "pending")?._count ?? 0;
        const remittedPAYE = payeCounts.find((p) => p.status === "remitted")?._count ?? 0;

        // Income ratio
        const totalIncome = await prisma.ledgerEntry.aggregate({
          where: { cooperativeId: coopId, type: "income" },
          _sum: { amount: true },
        });
        const memberIncome = (totalIncome._sum.amount ?? 0) - commIncome;
        const ratio = memberIncome > 0 ? ((commIncome / memberIncome) * 100).toFixed(1) : "0";

        const body = [
          "*🏛 Tax Compliance Status*",
          "",
          `*TIN:* ${tin ?? "⚠️ Not set — use *tin set <TIN>*"}`,
          `*Cooperative type:* ${coopType}`,
          "",
          `*CIT status:* ${citExempt ? "✅ Exempt (member cooperative)" : "⚠️ Taxable (commercial cooperative)"}`,
          "",
          `*PAYE compliance:*`,
          `• Pending: *${pendingPAYE}* records`,
          `• Remitted: *${remittedPAYE}* records`,
          pendingPAYE > 0
            ? "• ⚠️ Unremitted PAYE — use *paye remit <id>*"
            : "• ✅ All PAYE up to date",
          "",
          `*Income breakdown:*`,
          `• Member income: *${formatBalance(Math.max(0, memberIncome))}*`,
          `• Commercial income: *${formatBalance(commIncome)}*`,
          `• Ratio: *${ratio}%* commercial`,
          commIncome > memberIncome
            ? "• ⚠️ Commercial income exceeds member income — review classification"
            : "",
        ].filter(Boolean);
        await sendText({ to: phone, text: body.join("\n") });
        return true;
      }

      case "newgroup": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can create savings groups." });
          return true;
        }
        const [type, name, code, amountArg, cycleArg] = args;
        const amount = toKobo(Number(amountArg));
        const cycleLength = Number(cycleArg);
        if (!type || !name || !code || !Number.isFinite(amount) || !Number.isFinite(cycleLength)) {
          await sendText({
            to: phone,
            text: "Usage: *newgroup <rosca|vsla> <name> <code> <amount> <cycleLength>* — e.g. *newgroup rosca Family FAM1 5000 12*",
          });
          return true;
        }
        const created = await createGroup(coopId, type, name, code, amount, cycleLength, {
          id: admin.id,
          phone,
          role: roleLabel(ctx),
        });
        await sendText({ to: phone, text: created.message });
        return true;
      }

      case "closegroupcycle": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can close a group cycle." });
          return true;
        }
        const id = args[0];
        if (!id) {
          await sendText({ to: phone, text: "Usage: *closegroupcycle <group id>*" });
          return true;
        }
        const closed = await closeGroupCycle(coopId, id, {
          id: admin.id,
          phone,
          role: roleLabel(ctx),
        });
        await sendText({ to: phone, text: closed.message });
        return true;
      }

      case "groups": {
        if (unitAdmin) {
          await sendText({
            to: phone,
            text: "Only the cooperative admin can view all savings groups.",
          });
          return true;
        }
        const listed = await listGroups(coopId);
        if (!listed.groups || listed.groups.length === 0) {
          await sendText({
            to: phone,
            text: "No savings groups yet. Create one with *newgroup <rosca|vsla> <name> <code> <amount> <cycleLength>*.",
          });
          return true;
        }
        const lines = ["*👥 Savings Groups*", ""];
        for (const g of listed.groups) {
          lines.push(
            `• *${g.name}* (${g.code}) — ${g.type.toUpperCase()} — ${g.memberCount} member(s) — ${formatBalance(g.contributionAmount)} × ${g.cycleLength} — _${g.status}_`,
            `  ID: ${g.id}`,
          );
        }
        await sendText({ to: phone, text: lines.join("\n") });
        return true;
      }

      case "grouploans": {
        if (unitAdmin) {
          await sendText({
            to: phone,
            text: "Only the cooperative admin can view group loans.",
          });
          return true;
        }
        const id = args[0];
        if (!id) {
          await sendText({ to: phone, text: "Usage: *grouploans <group id>*" });
          return true;
        }
        const listed = await groupLoans(coopId, id);
        if (!listed.ok || !listed.loans || listed.loans.length === 0) {
          await sendText({
            to: phone,
            text: listed.ok ? "This group has no joint-liability loans yet." : listed.message,
          });
          return true;
        }
        const glines = [`*👥 Group loans — ${listed.group?.name} (${listed.group?.code})*`, ""];
        for (const l of listed.loans) {
          glines.push(
            `• *${l.memberName}* — ${formatBalance(l.amount)} — _${l.status}_ — balance ${formatBalance(l.balance)}`,
            `  ID: ${l.id.slice(-6)}`,
          );
        }
        await sendText({ to: phone, text: glines.join("\n") });
        return true;
      }

      case "newproduct": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can create savings products." });
          return true;
        }
        const type = (args[0] ?? "").trim().toLowerCase();
        const name = (args[1] ?? "").trim();
        const rate = args[2] !== undefined ? Number(args[2]) : 0;
        const term = args[3] !== undefined ? Number(args[3]) : null;
        if (!type || !name) {
          await sendText({
            to: phone,
            text: "Usage: *newproduct <fixed|goal|seasonal|junior> <name> [rate] [termMonths]* — e.g. *newproduct fixed 12-Month 10 12*",
          });
          return true;
        }
        const created = await createProduct(
          coopId,
          type,
          name,
          {
            interestRate: Number.isFinite(rate) ? rate : 0,
            termMonths: term !== null && Number.isFinite(term) ? term : null,
          },
          { id: admin.id, phone, role: roleLabel(ctx) },
        );
        await sendText({ to: phone, text: created.message });
        return true;
      }

      case "products": {
        if (unitAdmin) {
          await sendText({ to: phone, text: "Only the cooperative admin can view all savings products." });
          return true;
        }
        const listed = await listProducts(coopId);
        if (!listed.products || listed.products.length === 0) {
          await sendText({
            to: phone,
            text: "No savings products yet. Create one with *newproduct <fixed|goal|seasonal|junior> <name> [rate] [termMonths]*.",
          });
          return true;
        }
        const plines = ["*🏦 Savings Products*", ""];
        for (const p of listed.products) {
          const meta = [
            p.termMonths ? `${p.termMonths} months` : null,
            p.interestRate ? `${p.interestRate}% at maturity` : null,
            p.minAmount ? `${formatBalance(p.minAmount)} min` : null,
          ]
            .filter(Boolean)
            .join(" — ");
          plines.push(
            `• *${p.name}* (${p.type.toUpperCase()})${meta ? ` — ${meta}` : ""}${p.active ? "" : " — _closed_"}`,
            `  ID: ${p.id}`,
          );
        }
        await sendText({ to: phone, text: plines.join("\n") });
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    console.error("[admin] handleAdminCommand error:", err);
    await sendText({
      to: phone,
      text: "An error occurred processing your command. Please try again or contact support.",
    });
    return true;
  }
}

async function sendPendingLoans(
  phone: string,
  loans: Awaited<ReturnType<typeof listPendingLoans>>,
  scoped: boolean,
): Promise<void> {
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
async function handlePayout(
  ctx: AdminContext,
  amount: number,
  targetPhone: string,
  narration: string,
): Promise<void> {
  const { admin, coop } = ctx;
  const target = await prisma.member.findFirst({
    where: { cooperativeId: coop.id, phone: targetPhone },
    include: { wallet: true },
  });
  if (!target) {
    await sendText({
      to: admin.phone,
      text: `No member found with phone ${targetPhone} in your cooperative.`,
    });
    return;
  }
  if (!target.bankAccountNumber || !target.bankCode) {
    await sendText({
      to: admin.phone,
      text: `${target.name} has no bank account on file. They should reply *withdraw <amount>* once to save their bank details first.`,
    });
    return;
  }
  const balance = target.wallet?.balance ?? 0;
  if (balance < amount) {
    await sendText({
      to: admin.phone,
      text: `${target.name}'s wallet has ${formatBalance(balance)} — less than ${formatBalance(amount)}. No money moved.`,
    });
    return;
  }

  // Fraud guard: velocity check — max 5 money-out per 10 minutes per member.
  if (!(await checkVelocity(target.id))) {
    await sendText({
      to: admin.phone,
      text: `🛑 Too many transactions for ${target.name} in a short period. Please wait a few minutes and try again.`,
    });
    return;
  }

  // Fraud guard: daily ceiling on total money-out.
  const limit = await checkDailyPayoutLimit(coop.id, amount);
  if (!limit.ok) {
    await sendText({ to: admin.phone, text: limit.message! });
    return;
  }

  // Multi-sig check: large payouts need second superadmin approval (playbook Attack 6 mitigation)
  const multiSig = await checkMultiSigRequirement({
    cooperativeId: coop.id,
    amount,
    initiatorPhone: admin.phone,
    targetId: target.id,
  });
  if (!multiSig.needsApproval && multiSig.blocked) {
    await sendText({
      to: admin.phone,
      text: `⛔ ${multiSig.error ?? "Payout blocked — multi-sig service temporarily unavailable."}`,
    });
    return;
  }
  if (multiSig.needsApproval) {
    await auditSuperadminCommand({
      cooperativeId: coop.id,
      actorPhone: admin.phone,
      actorId: admin.id,
      command: "payout.pending_multisig",
      target: target.name,
      detail: `${formatBalance(amount)} to ${target.name} — awaiting second superadmin approval`,
      isHighRisk: true,
    });
    await sendText({
      to: admin.phone,
      text: `🔐 Payout of ${formatBalance(amount)} needs a second superadmin approval.\n\nOther superadmins have been notified. Once approved, reply *payout ${targetPhone} ${amount / 100} ${narration}* again to proceed.`,
    });
    return;
  }

  // STEP 1 — atomic claim: create the request in "processing" state so concurrent
  // calls for the same member are rejected. Also debits the wallet in the same
  // transaction so the debit and claim are inseparable.
  const claimed = await withTx(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { memberId: target.id } });
    if (!wallet || wallet.balance < amount) {
      return { ok: false as const, message: "Insufficient balance. No money moved." };
    }
    const debited = await tx.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (debited.count === 0) {
      return { ok: false as const, message: "Insufficient balance. No money moved." };
    }
    const request = await tx.withdrawalRequest.create({
      data: {
        amount,
        status: "processing",
        bankAccountNumber: target.bankAccountNumber!,
        bankCode: target.bankCode!,
        bankName: target.bankName ?? null,
        memberId: target.id,
        cooperativeId: coop.id,
        finalizedById: admin.id,
      },
    });
    return { ok: true as const, request, wallet };
  });

  if (!claimed.ok) {
    await sendText({ to: admin.phone, text: claimed.message });
    return;
  }

  // Whether money has actually been sent. Once true, the outer catch must NOT
  // refund (that would double-pay).
  let paid = false;

  try {
    // STEP 2 — send to bank (outside the transaction so the provider call
    // doesn't hold a DB lock).
    const result = await sendToBank({
      memberId: target.id,
      amount,
      bankAccountNumber: target.bankAccountNumber,
      bankCode: target.bankCode,
      bankName: target.bankName ?? undefined,
      note: `Super admin payout to ${target.name} — ${narration}`,
      idempotencyKey: `TFR-PO-${claimed.request.id}`,
      successMessage: `✅ ${formatBalance(amount)} sent to your bank account. Narration: "${narration}".`,
    });

    if (result.status === "unsure") {
      // The provider may have submitted the transfer. NEVER auto-refund here.
      await prisma.withdrawalRequest.updateMany({
        where: { id: claimed.request.id },
        data: { status: "investigating" },
      });
      await auditSuperadminCommand({
        cooperativeId: coop.id,
        actorPhone: admin.phone,
        actorId: admin.id,
        command: "payout.ambiguous",
        target: target.name,
        detail: `${formatBalance(amount)} — payout outcome unconfirmed. Reconcile with the payment provider before retrying or refunding.`,
        isHighRisk: true,
      }).catch(() => {});
      await sendText({
        to: admin.phone,
        text: `⚠️ Payout could not be confirmed and was flagged for reconciliation. Do NOT retry or refund until the provider is checked: ${result.message}`,
      });
      return;
    }

    if (!result.ok) {
      // STEP 3b — refund on CONFIRMED failure and hand back for retry.
      await withTxBatch([
        prisma.wallet.update({
          where: { id: claimed.wallet.id },
          data: { balance: { increment: amount } },
        }),
        prisma.withdrawalRequest.updateMany({
          where: { id: claimed.request.id, status: "processing" },
          data: { status: "admin_approved" },
        }),
      ]);
      console.error(
        `[payout] sendToBank failed, refunded: ${claimed.request.id} — ${result.message}`,
      );
      await sendText({
        to: admin.phone,
        text: `Payout failed: ${result.message}. Wallet refunded.`,
      });
      return;
    }

    // STEP 3a — success: mark paid.
    paid = true;
    await prisma.withdrawalRequest.updateMany({
      where: { id: claimed.request.id, status: "processing" },
      data: { status: "paid", finalizedAt: new Date() },
    });

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

    // Enhanced audit: alert other superadmins about large payouts
    await auditSuperadminCommand({
      cooperativeId: coop.id,
      actorPhone: admin.phone,
      actorId: admin.id,
      command: "payout.completed",
      target: target.name,
      detail: `${formatBalance(amount)} to ${target.name} — ${narration}`,
      isHighRisk: amount >= 100_000_00, // ₦100k+
    });

    if (limit.warning) {
      await sendText({ to: admin.phone, text: limit.warning });
    }

    await sendText({
      to: admin.phone,
      text: `Payout of ${formatBalance(amount)} to *${target.name}* was sent ✅ and their wallet debited.`,
    });
  } catch (err: any) {
    // Crash safety — any throw after the debit must be handled WITHOUT
    // double-paying. Once money has been sent (paid), never auto-refund:
    // flag for manual reconciliation instead.
    if (paid) {
      await prisma.withdrawalRequest
        .updateMany({
          where: { id: claimed.request.id },
          data: { status: "investigating" },
        })
        .catch(() => {});
      await auditSuperadminCommand({
        cooperativeId: coop.id,
        actorPhone: admin.phone,
        actorId: admin.id,
        command: "payout.ambiguous",
        target: target.name,
        detail: `${formatBalance(amount)} — sent but later bookkeeping threw. Reconcile with the payment provider.`,
        isHighRisk: true,
      }).catch(() => {});
      console.error(`[payout] post-payout error for paid payout: ${claimed.request.id}`, err);
      await sendText({
        to: admin.phone,
        text: `⚠️ The payout was sent but in-app bookkeeping failed. It was flagged for manual reconciliation.`,
      });
      return;
    }
    await prisma.withdrawalRequest
      .updateMany({
        where: { id: claimed.request.id },
        data: { status: "investigating" },
      })
      .catch(() => {});
    console.error(`[payout] threw (unconfirmed outcome): ${claimed.request.id}`, err);
    await sendText({
      to: admin.phone,
      text: `⚠️ Payout hit an unexpected error with an *unconfirmed* outcome and was flagged for reconciliation (${String(err?.message ?? err).slice(0, 120)}). Do NOT retry or refund until the provider is checked.`,
    });
  }
}
