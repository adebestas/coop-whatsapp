import { prisma } from "../lib/prisma.js";
import { sendText, sendLongText, notifyMember } from "../lib/messaging.js";
import { cacheDel } from "../lib/cache.js";
import { invalidateCoopMeta } from "../lib/tenant-context.js";
import { getCurrency, getCoopId } from "../lib/runtime-context.js";
import { COUNTRY_CURRENCY, currencyForCountry } from "../lib/currency.js";
import { LOCALES, t } from "../lib/i18n.js";
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
  attributeShortfall,
} from "./deductions.js";
import { approveLoan } from "./loans.js";
import {
  addSchemeItem,
  closeScheme,
  collectCommodity,
  convertScheme,
  createScheme,
  dispatchCommodity,
  openScheme,
  purchaseScheme,
  rejectCommoditySubscription,
} from "./commodity-schemes.js";
import { formatSchemeSubsText, parseNaira, parseSchemeItem } from "./commodity-commands.js";
import { formatBalance } from "./cooperative.js";
import { toKobo } from "../lib/money.js";
import { broadcastToScope, createUnit, listUnits, setUnitAdmin } from "./units.js";
import {
  appointMember,
  committeeMajority,
  createCommittee,
  isCommitteeMember,
  listCommittees,
  recordCommitteeVote,
  removeMember,
} from "./committees.js";
import {
  addMotion,
  closeMeeting,
  closeMotion,
  meetingMinutes,
  MOTION_KINDS,
  openMeeting,
  startMeeting,
} from "./meetings.js";
import { listCoopMandates, pauseMandate, resumeMandate, skipDebit } from "./mandates.js";
import { recommendRefund, approveRefund, rejectRefund } from "./refunds.js";
import { audit, recentAudit } from "./audit.js";
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
import { runBackup } from "./backup.js";
import { resolveProvider } from "./payments/index.js";
import { assertMoneyAuthorized, disable2fa, enable2fa, refreshPin } from "./auth2fa.js";
import { getCoopConfig, updateCoopConfig, getSubscription } from "./coop-config.js";
import { loadPlatformPolicyRows } from "./platform-policy-store.js";
import { getRule } from "../lib/rule-registry.js";
import {
  generateReport,
  listReports,
  markFiled,
  setRegulatorProfile,
  type PackType,
  type PeriodType,
} from "./regulator-reporting.js";
import { setReferralConfig, setReferralEnabled, referralReport } from "./referrals.js";
import {
  addMember,
  approveLoan as approveFederationLoan,
  createFederation,
  markDefaulted,
  removeMember as removeFederationMember,
} from "./federation/index.js";
import { setRate } from "./federation/fx.js";

import {
  AdminContext,
  adminContext,
  roleLabel,
  guardFailed,
  parseAdminNaira,
  resolveFederation,
  MONEY_OUT_COMMANDS,
  COMMITTEE_COMMANDS,
} from "./admin-context.js";
export type { AdminContext };
export { handleOmbudsmanCommand } from "./admin-ombudsman.js";
import { handleLoanAdminCommand } from "./admin-loans.js";
import { handleDividendAdminCommand } from "./admin-dividends.js";
import { handleMemberAdminCommand } from "./admin-members.js";

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
    where: {
      phone,
      status: { not: "deceased" },
      ...(getCoopId() ? { cooperativeId: getCoopId() } : {}),
    },
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
    const outcome = await recordCommitteeVote(
      coopId,
      "credit",
      "loan",
      loan.id,
      member.id,
      "reject",
    );
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

  // referralpause / referralresume — governance control reserved for the Board
  // committee. Reuses the exact active-seat check the supervisory commands use.
  if (cmd === "referralpause" || cmd === "referralresume") {
    const allowed = isSuper || (await isCommitteeMember(coopId, "board", member.id));
    if (!allowed) {
      await sendText({
        to: phone,
        text: "Only *Board Committee* members (or the super admin) can pause or activate the referral program.",
      });
      return true;
    }
    const resume = cmd === "referralresume";
    const toggle = await setReferralEnabled(coopId, resume);
    await audit({
      cooperativeId: coopId,
      actorPhone: phone,
      actorId: member.id,
      actorRole: isSuper ? "superadmin" : "committee",
      action: resume ? "referral.resumed" : "referral.paused",
      targetType: "cooperativeConfig",
      targetId: coopId,
      detail: `${resume ? "Resumed" : "Paused"} the referral program`,
    });
    await sendText({ to: phone, text: toggle.message });
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

/** Execute an admin command from chat. Returns true if handled as admin. */
export async function handleAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
  text?: string,
): Promise<boolean> {
  try {
    let rawText = text ?? [cmd, ...args].join(" ");
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
      const before = args.length;
      const guard = await assertMoneyAuthorized(admin.id, args);
      if (!guard.ok) return guardFailed(phone, guard.message);
      args = guard.args;
      if (args.length < before) rawText = rawText.replace(/\s+\S+$/, "");
    }

    if (await handleLoanAdminCommand(phone, cmd, args, ctx)) return true;
    if (await handleMemberAdminCommand(phone, cmd, args, ctx)) return true;
    if (await handleDividendAdminCommand(phone, cmd, args, ctx)) return true;

    switch (cmd) {
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
          Number(period.slice(5)) < 1 ||
          Number(period.slice(5)) > 12 ||
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
        const periodType: PeriodType =
          args[2]?.toLowerCase() === "quarterly" ? "quarterly" : "monthly";
        const gen = await generateReport(coopId, period, periodType, packRaw as PackType, admin.id);
        await sendText({ to: phone, text: gen.message });
        return true;
      }

      case "regulatorconfig": {
        // regulatorconfig [label...] [type] [email] [monthlyDueDay] [quarterlyDueDay]
        // [annual=MM/DD]
        const cfg: {
          label?: string;
          type?: string;
          contactEmail?: string;
          monthlyDueDay?: number;
          quarterlyDueDay?: number;
          annualDueMonth?: number;
          annualDueDay?: number;
        } = {};
        const rest = [...args];
        const annualIdx = rest.findIndex((t) => /^annual=\d{1,2}\/\d{1,2}$/i.test(t));
        if (annualIdx !== -1) {
          const [month, day] = rest[annualIdx]
            .split("=")[1]
            .split("/")
            .map((n) => Number(n));
          cfg.annualDueMonth = month;
          cfg.annualDueDay = day;
          rest.splice(annualIdx, 1);
        }
        const isDueDay = (s: string | undefined): boolean => s !== undefined && /^\d{1,2}$/.test(s);
        if (
          rest.length >= 2 &&
          isDueDay(rest[rest.length - 1]) &&
          isDueDay(rest[rest.length - 2])
        ) {
          cfg.quarterlyDueDay = Number(rest.pop());
          cfg.monthlyDueDay = Number(rest.pop());
        } else if (rest.length && isDueDay(rest[rest.length - 1])) {
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

      case "referralconfig": {
        // referralconfig [on|off] [wallet|bank|airtime] [amount] [maxRewards]
        const input: {
          enabled?: boolean;
          rewardType?: string;
          rewardAmount?: number;
          maxRewards?: number;
        } = {};
        const rest = [...args];
        const head = rest[0]?.toLowerCase();
        if (head === "on" || head === "enable" || head === "enabled") {
          input.enabled = true;
          rest.shift();
        } else if (head === "off" || head === "disable" || head === "disabled") {
          input.enabled = false;
          rest.shift();
        }
        const typeTok = rest[0]?.toLowerCase();
        if (typeTok && ["wallet", "bank", "airtime"].includes(typeTok)) {
          input.rewardType = typeTok;
          rest.shift();
        }
        if (rest[0] !== undefined) {
          const amount = parseAdminNaira(rest[0]);
          if (amount === null) {
            await sendText({
              to: phone,
              text: "Usage: *referralconfig [on|off] [wallet|bank|airtime] [amount] [maxRewards]*.",
            });
            return true;
          }
          input.rewardAmount = amount;
          rest.shift();
        }
        if (rest[0] !== undefined) {
          if (!/^\d+$/.test(rest[0])) {
            await sendText({
              to: phone,
              text: "Max rewards must be a whole number (0 = unlimited).",
            });
            return true;
          }
          input.maxRewards = Number(rest.shift());
        }
        const hasInput =
          input.enabled !== undefined ||
          input.rewardType !== undefined ||
          input.rewardAmount !== undefined ||
          input.maxRewards !== undefined;
        if (!hasInput || rest.length > 0) {
          await sendText({
            to: phone,
            text: "Usage: *referralconfig [on|off] [wallet|bank|airtime] [amount] [maxRewards]*.",
          });
          return true;
        }
        const cfgRes = await setReferralConfig(coopId, input, {
          id: admin.id,
          phone,
          role: roleLabel(ctx),
        });
        await sendText({ to: phone, text: cfgRes.message });
        return true;
      }

      case "referralreport": {
        const res = await referralReport(coopId);
        await sendText({ to: phone, text: res.message });
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
            where: {
              cooperativeId: coopId,
              status: { in: ["pending", "admin_approved", "aml_review"] },
            },
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
          const cfg = await prisma.cooperativeConfig.findUnique({
            where: { cooperativeId: coopId },
          });
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
          await sendText({
            to: phone,
            text: "Only the *super admin* can appoint committee members.",
          });
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
        const provider = await resolveProvider(undefined, getCurrency());
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

      case "shortbatch": {
        if (!isSuper) {
          await sendText({
            to: phone,
            text: "Only the *super admin* can attribute a shortfall.",
          });
          return true;
        }
        const [ref, code, amountArg, ...reasonParts] = args;
        if (!ref || !code || !amountArg) {
          await sendText({
            to: phone,
            text: "Usage: *shortbatch <ref> <member code|all> <amount|all|waive> [reason]*",
          });
          return true;
        }
        const raw = amountArg.toLowerCase();
        const parsed =
          raw === "all" || raw === "waive"
            ? raw
            : Number.isFinite(Number(raw))
              ? toKobo(Number(raw))
              : NaN;
        if (typeof parsed === "number" && !(parsed > 0)) {
          await sendText({
            to: phone,
            text: "Usage: *shortbatch <ref> <member code|all> <amount|all|waive> [reason]*",
          });
          return true;
        }
        const result = await attributeShortfall(
          phone,
          ref,
          code,
          parsed,
          reasonParts.join(" ") || undefined,
        );
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "newscheme": {
        const body = rawText.replace(/^\/?\s*newscheme\s+/i, "");
        const [name, season, opens, closes] = body.split("|").map((p) => p.trim());
        if (!name || !opens || !closes) {
          await sendText({
            to: phone,
            text: "Usage: *newscheme <name> | <season> | <YYYY-MM-DD> | <YYYY-MM-DD>*",
          });
          return true;
        }
        const result = await createScheme(phone, {
          name,
          season,
          opensAt: new Date(`${opens}T00:00:00Z`),
          closesAt: new Date(`${closes}T23:59:59Z`),
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "addschemeitem": {
        const parsed = parseSchemeItem(rawText);
        if (!parsed) {
          await sendText({
            to: phone,
            text: "Usage: *addschemeitem <ref> | <name> | <unit> | <cost> | <price> | <units|-> | <max>*",
          });
          return true;
        }
        const ref = rawText
          .replace(/^\/?\s*addschemeitem\s+/i, "")
          .split("|")[0]
          .trim();
        const result = await addSchemeItem(phone, ref, parsed);
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "openscheme": {
        const result = await openScheme(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "closescheme": {
        const result = await closeScheme(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "schemesubs": {
        await sendText({ to: phone, text: await formatSchemeSubsText(coopId, args[0] ?? "") });
        return true;
      }

      case "rejectsub": {
        const result = await rejectCommoditySubscription(
          phone,
          args[0] ?? "",
          args.slice(1).join(" "),
        );
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "purchasescheme": {
        const body = rawText.replace(/^\/?\s*purchasescheme\s+/i, "");
        const parts = body.split("|").map((p) => p.trim());
        const [ref, supplier, cost, funding, ...noteParts] = parts;
        const costKobo = parseNaira(cost ?? "");
        if (!ref || !supplier || !costKobo) {
          await sendText({
            to: phone,
            text: "Usage: *purchasescheme <ref> | <supplier> | <cost> [| supplier_credit | <terms>]*",
          });
          return true;
        }
        const result = await purchaseScheme(phone, ref, supplier, costKobo, {
          fundingSource: funding === "supplier_credit" ? "supplier_credit" : "cash",
          note: noteParts.join(" | ") || undefined,
        });
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "convertscheme": {
        const result = await convertScheme(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "dispatchsub": {
        const result = await dispatchCommodity(phone, args[0] ?? "");
        await sendText({ to: phone, text: result.message });
        return true;
      }

      case "collectsub": {
        const result = await collectCommodity(phone, args[0] ?? "", args[1] ?? "");
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
              "maxLoanMultiplier, loanDurationMonths, minLoanTermMonths, maxLoanPerMember, " +
              "minMembershipMonths, autoApproveLoans, requireGuarantors, minGuarantors, " +
              "reserveFundPercent, educationFundPercent, dividendCapPercent, " +
              "literacyCertificationEnabled, literacyQuizPassMark, literacyQuizQuestionCount, " +
              "certifiedLoanBoost, language",
          });
          return true;
        }
        if (key === "language") {
          const want = value.toLowerCase();
          if (!LOCALES.includes(want as never)) {
            await sendText({
              to: phone,
              text: t("error.unsupportedLanguage", { list: LOCALES.join(", ") }),
            });
            return true;
          }
          await prisma.cooperative.update({ where: { id: coopId }, data: { locale: want } });
          invalidateCoopMeta(coopId);
          await audit({
            cooperativeId: coopId,
            actorPhone: phone,
            actorId: admin.id,
            actorRole: "superadmin",
            action: "config.set",
            detail: `language = ${want}`,
          });
          await sendText({ to: phone, text: t("admin.config.language.set", { lang: want }) });
          return true;
        }
        if (key === "country") {
          const iso = value.toUpperCase();
          if (!Object.prototype.hasOwnProperty.call(COUNTRY_CURRENCY, iso)) {
            await sendText({
              to: phone,
              text: `Unsupported country *${value}*. Supported: ${Object.keys(COUNTRY_CURRENCY).join(", ")}.`,
            });
            return true;
          }
          const moved = await prisma.journalEntry.count({ where: { cooperativeId: coopId } });
          if (moved > 0) {
            await sendText({
              to: phone,
              text: "Country can't be changed after money has moved in this cooperative.",
            });
            return true;
          }
          await prisma.cooperative.update({
            where: { id: coopId },
            data: { country: iso, currency: currencyForCountry(iso) },
          });
          invalidateCoopMeta(coopId);
          await audit({
            cooperativeId: coopId,
            actorPhone: phone,
            actorId: admin.id,
            actorRole: "superadmin",
            action: "config.set",
            detail: `country = ${iso}`,
          });
          await sendText({
            to: phone,
            text: `✅ Country set to *${iso}* (currency *${currencyForCountry(iso)}*).`,
          });
          return true;
        }
        const rule = getRule(key);
        if (!rule) {
          await sendText({ to: phone, text: `Unknown config key: *${key}*.` });
          return true;
        }
        if (!rule.coopEditable) {
          await sendText({
            to: phone,
            text: `*${key}* is set by the platform and can't be changed here.`,
          });
          return true;
        }
        const policies = await loadPlatformPolicyRows();
        if (policies[key]?.locked) {
          await sendText({
            to: phone,
            text: `*${key}* is locked by the platform and can't be changed here.`,
          });
          return true;
        }
        let parsedValue: any;
        if (rule.type === "bool") {
          parsedValue = value.toLowerCase() === "true" || value === "1";
        } else {
          parsedValue = Number(value);
          if (!Number.isFinite(parsedValue)) {
            await sendText({ to: phone, text: `Value must be a number for *${key}*.` });
            return true;
          }
          // Registry-driven bounds — reject out-of-range values before persisting.
          const lo = rule.min;
          const hi = rule.max;
          if ((lo !== undefined && parsedValue < lo) || (hi !== undefined && parsedValue > hi)) {
            await sendText({
              to: phone,
              text: `*${key}* must be between *${lo ?? "-∞"}* and *${hi ?? "∞"}*.`,
            });
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
        const coop = await prisma.cooperative.findUnique({
          where: { id: coopId },
          select: { country: true, currency: true, locale: true },
        });
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
          `• Literacy certification: *${config.literacyCertificationEnabled ? "on" : "off"}*`,
          `• Quiz pass mark: *${config.literacyQuizPassMark}*`,
          `• Quiz questions: *${config.literacyQuizQuestionCount}*`,
          `• Certified loan boost: *+${config.certifiedLoanBoost}x savings*`,
          `• Country: *${coop?.country ?? "NG"}*`,
          `• Currency: *${coop?.currency ?? "NGN"}*`,
          `• Default language: *${coop?.locale ?? "en"}*`,
        ];
        await sendText({ to: phone, text: body.join("\n") });
        return true;
      }

      case "verifycert": {
        const code = args[0];
        if (!code) {
          await sendText({ to: phone, text: "Usage: *verifycert <reference code>*" });
          return true;
        }
        const cert = await prisma.literacyCertificate.findFirst({
          where: {
            cooperativeId: coopId,
            OR: [{ referenceCode: code }, { referenceCode: { endsWith: code } }],
          },
          include: { member: true },
        });
        if (!cert) {
          await sendText({ to: phone, text: `No certificate found for *${code}*.` });
          return true;
        }
        await sendText({
          to: phone,
          text:
            `*Certificate ${cert.referenceCode}*\n` +
            `Member: *${cert.member.name}* (${cert.member.code})\n` +
            `Score: *${cert.score}/${cert.totalQuestions}*\n` +
            `Issued: *${cert.issuedAt.toISOString().slice(0, 10)}*\n` +
            `Status: *${cert.revokedAt ? "revoked" : "valid"}*`,
        });
        return true;
      }

      case "revokecert": {
        const code = args[0];
        if (!code) {
          await sendText({ to: phone, text: "Usage: *revokecert <reference code>*" });
          return true;
        }
        const cert = await prisma.literacyCertificate.findFirst({
          where: {
            cooperativeId: coopId,
            OR: [{ referenceCode: code }, { referenceCode: { endsWith: code } }],
          },
          include: { member: true },
        });
        if (!cert) {
          await sendText({ to: phone, text: `No certificate found for *${code}*.` });
          return true;
        }
        if (cert.revokedAt) {
          await sendText({
            to: phone,
            text: `Certificate *${cert.referenceCode}* is already revoked.`,
          });
          return true;
        }
        await prisma.literacyCertificate.update({
          where: { id: cert.id },
          data: { revokedAt: new Date() },
        });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: "superadmin",
          action: "literacy.certificate_revoked",
          targetType: "LiteracyCertificate",
          targetId: cert.id,
          detail: `revoked ${cert.referenceCode} for ${cert.member.name}`,
        });
        await sendText({
          to: phone,
          text: `✅ Certificate *${cert.referenceCode}* for *${cert.member.name}* revoked.`,
        });
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
        if (
          !target ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          reason.length < 3 ||
          reason.length > 200
        ) {
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
        const startRes = await startMeeting(
          coopId,
          type,
          title,
          hasQuorum ? Number(lastArg) : undefined,
          {
            id: admin.id,
            role: admin.role,
            phone,
          },
        );
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
        const strLines = ["*📋 AML Reports (STR / CTR)*", ""];
        for (const s of strs) {
          strLines.push(
            `• [${s.reportType}] ${s.member.name} — ${formatBalance(s.amount)} — ${s.status} — ${s.reason}`,
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
          await sendText({
            to: phone,
            text: "Only the cooperative admin can create savings groups.",
          });
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
          await sendText({
            to: phone,
            text: "Only the cooperative admin can close a group cycle.",
          });
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
          await sendText({
            to: phone,
            text: "Only the cooperative admin can create savings products.",
          });
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
          await sendText({
            to: phone,
            text: "Only the cooperative admin can view all savings products.",
          });
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

      case "federation": {
        if (!isSuper) {
          await sendText({ to: phone, text: "Only the *super admin* can manage federations." });
          return true;
        }
        const fed = await resolveFederation(args);
        // Explicit `federation <code> <sub> ...` targeting shifts the subcommand
        // and its positionals down by one; the bare `federation <sub> ...` form
        // leaves `args` untouched.
        const rest = fed && fed.code === args[0] ? args.slice(1) : args;
        const sub = (rest[0] ?? "").toLowerCase();
        if (sub === "create") {
          const [name, baseCurrency] = [rest[1], (rest[2] ?? "NGN").toUpperCase()];
          if (!name) {
            await sendText({
              to: phone,
              text: "Usage: *federation create <name> <baseCurrency>*",
            });
            return true;
          }
          const fed = await createFederation(name, `FED${Date.now()}`, baseCurrency);
          await sendText({
            to: phone,
            text: `✅ Federation *${fed.name}* created (${fed.baseCurrency}).`,
          });
          return true;
        }
        if (sub === "addcoop") {
          const code = rest[1];
          const coop = code ? await prisma.cooperative.findUnique({ where: { code } }) : null;
          if (!coop) {
            await sendText({ to: phone, text: "Usage: *federation addcoop <coop code>*" });
            return true;
          }
          if (!fed) {
            await sendText({ to: phone, text: "No federation exists yet." });
            return true;
          }
          await addMember(fed.id, coop.id);
          await sendText({ to: phone, text: `✅ *${coop.name}* added to *${fed.name}*.` });
          return true;
        }
        if (sub === "removecoop") {
          const code = rest[1];
          const coop = code ? await prisma.cooperative.findUnique({ where: { code } }) : null;
          if (!coop) {
            await sendText({ to: phone, text: "Usage: *federation removecoop <coop code>*" });
            return true;
          }
          if (!fed) {
            await sendText({ to: phone, text: "No federation exists yet." });
            return true;
          }
          await removeFederationMember(fed.id, coop.id);
          await sendText({ to: phone, text: `✅ *${coop.name}* removed from *${fed.name}*.` });
          return true;
        }
        if (sub === "rate") {
          const [from, to, rateStr] = [rest[1]?.toUpperCase(), rest[2]?.toUpperCase(), rest[3]];
          const rate = Number(rateStr);
          if (!from || !to || !Number.isFinite(rate) || rate <= 0) {
            await sendText({ to: phone, text: "Usage: *federation rate <from> <to> <rate>*" });
            return true;
          }
          if (!fed) {
            await sendText({ to: phone, text: "No federation exists yet." });
            return true;
          }
          await setRate(fed.id, from, to, rate, phone);
          await sendText({ to: phone, text: `✅ Rate set: 1 ${from} = ${rate} ${to}.` });
          return true;
        }
        if (sub === "loans") {
          const loans = fed
            ? await prisma.federationLoan.findMany({
                where: { federationId: fed.id },
                orderBy: { createdAt: "desc" },
                take: 20,
              })
            : [];
          const lines = loans.map(
            (l) =>
              `• *${l.id.slice(0, 8)}* — ${formatBalance(l.principalKobo, l.currency)} ${l.status}`,
          );
          await sendText({
            to: phone,
            text: lines.length
              ? `*Federation loans*\n\n${lines.join("\n")}`
              : "No federation loans.",
          });
          return true;
        }
        if (sub === "approveloan") {
          const id = rest[1];
          if (!id) {
            await sendText({ to: phone, text: "Usage: *federation approveloan <id>*" });
            return true;
          }
          await approveFederationLoan(id);
          await sendText({ to: phone, text: `✅ Loan *${id}* approved.` });
          return true;
        }
        if (sub === "default") {
          const id = rest[1];
          if (!id) {
            await sendText({ to: phone, text: "Usage: *federation default <id>*" });
            return true;
          }
          await markDefaulted(id);
          await sendText({ to: phone, text: `Loan *${id}* marked defaulted.` });
          return true;
        }
        await sendText({
          to: phone,
          text: "Usage: *federation <code>? create|addcoop|removecoop|rate|loans|approveloan|default* (prefix a federation code to target it, else the most-recent federation is used)",
        });
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
