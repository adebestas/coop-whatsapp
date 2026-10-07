import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { resolveProvider } from "./payments/index.js";
import { formatBalance } from "./cooperative.js";
import { showHistory } from "./statements.js";
import { runAllAlerts } from "../lib/ai-alerts.js";
import { alertSupers, AlertSeverity, logAndAlert } from "../lib/alerting.js";
import { getRedis, claimOnce } from "../lib/cache.js";
import { forEachCoop, withCoopContext, listCooperativeIds } from "../lib/tenant-context.js";
import { log } from "../lib/logger.js";
import { maskId } from "../lib/security.js";

/**
 * Background jobs: recurring contribution reminders + monthly interest on
 * savings. Both are exported separately so tests can run them directly.
 */

/** Set up (or turn off) a recurring contribution plan. */
export async function setAutoSave(
  phone: string,
  amount: number | null,
  interval?: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  if (amount === null || (interval !== "weekly" && interval !== "monthly")) {
    // "plan off" or invalid -> disable.
    await prisma.member.update({
      where: { id: member.id },
      data: {
        autoSaveEnabled: false,
        autoSaveAmount: null,
        autoSaveInterval: null,
        autoSaveNextDue: null,
      },
    });
    return { ok: true, message: "Your recurring contribution plan is turned off." };
  }

  const nextDue = new Date();
  nextDue.setDate(nextDue.getDate() + (interval === "weekly" ? 7 : 30));

  await prisma.member.update({
    where: { id: member.id },
    data: {
      autoSaveAmount: amount,
      autoSaveInterval: interval,
      autoSaveNextDue: nextDue,
      autoSaveEnabled: true,
    },
  });
  return {
    ok: true,
    message: `Recurring contribution set: *${formatBalance(amount)}* every ${interval}. You'll get a nudge when it's due — just reply *save ${amount}* to pay.`,
  };
}

/** Send reminders to members whose recurring contribution is due now. */
export async function runAutoSaveReminders(now = new Date()): Promise<number> {
  let sent = 0;
  await forEachCoop(async (coopId) => {
    const due = await prisma.member.findMany({
      where: {
        cooperativeId: coopId,
        autoSaveEnabled: true,
        autoSaveNextDue: { lte: now },
        consentAt: { not: null },
        // A member with an active direct-debit mandate is collected from
        // automatically — do not nag them (the scheduler's mandate job owns it).
        mandates: { none: { cooperativeId: coopId, status: "active" } },
      },
    });
    for (const m of due) {
      const interval = m.autoSaveInterval === "weekly" ? "week" : "month";
      await notifyMember(
        m,
        `⏰ Time to save! Your *${interval}ly* contribution of *${formatBalance(m.autoSaveAmount ?? 0)}* is due.\n\nReply *save ${Math.round((m.autoSaveAmount ?? 0) / 100)}* to pay now.`,
      );
      // Schedule the next one so we don't nag every few minutes.
      const next = new Date(m.autoSaveNextDue!);
      next.setDate(next.getDate() + (m.autoSaveInterval === "weekly" ? 7 : 30));
      await prisma.member.update({
        where: { id: m.id },
        data: { autoSaveNextDue: next },
      });
      sent++;
    }
  });
  return sent;
}

/** Split a CSV column (e.g. Mandate.pausedPurposes) into an order-preserving set. */
function csvSet(value: string | null | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** One day, in milliseconds — the retry cadence ("at most once per day"). */
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Create due savings debits for members with an active direct-debit mandate.
 *
 * For every cooperative with direct debit enabled, each active mandate whose
 * member has a due recurring contribution gets a `pending` `MandateDebit`
 * (amount = min(due, mandate cap)) and a provider debit call. On a synchronous
 * hard failure the debit is marked `failed` with a `nextRetryAt` of +1 day.
 *
 * The member's `autoSaveNextDue` is advanced as soon as the obligation is
 * picked up, so an outstanding (pending/failed) debit is never duplicated on
 * the next tick — retries own the failure path from there. Returns the number
 * of debits created.
 */
export async function runMandateDebits(now = new Date()): Promise<number> {
  let created = 0;
  await forEachCoop(async (coopId) => {
    const config = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
    if (!config?.directDebitEnabled) return;

    const mandates = await prisma.mandate.findMany({
      where: { cooperativeId: coopId, status: "active" },
      include: {
        member: {
          select: {
            id: true,
            autoSaveEnabled: true,
            autoSaveAmount: true,
            autoSaveInterval: true,
            autoSaveNextDue: true,
          },
        },
      },
    });

    for (const mandate of mandates) {
      const member = mandate.member;
      if (!member.autoSaveEnabled || !member.autoSaveNextDue) continue;
      if (member.autoSaveNextDue > now) continue;
      if (csvSet(mandate.pausedPurposes).has("savings")) continue;

      const due = member.autoSaveAmount ?? 0;
      if (due <= 0) continue;
      const amount = Math.min(due, mandate.amountCap);
      if (amount <= 0) continue;

      const providerRef = `DD-${randomUUID()}`;
      const debit = await prisma.mandateDebit.create({
        data: {
          mandateId: mandate.id,
          cooperativeId: coopId,
          memberId: member.id,
          purpose: "savings",
          amount,
          status: "pending",
          providerRef,
        },
      });
      created++;

      // Advance the schedule so this obligation is not re-created next tick.
      const next = new Date(member.autoSaveNextDue);
      next.setDate(next.getDate() + (member.autoSaveInterval === "weekly" ? 7 : 30));
      await prisma.member.update({
        where: { id: member.id },
        data: { autoSaveNextDue: next },
      });

      const narration = `Savings contribution — ${formatBalance(amount)}`;
      let result: { ok: boolean; error?: string } | undefined;
      try {
        const provider = await resolveProvider(mandate.provider);
        result = await provider.debitMandate?.({
          providerMandateId: mandate.providerMandateId ?? "",
          amount,
          reference: providerRef,
          narration,
        });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : "provider error" };
      }

      if (!result?.ok) {
        await prisma.mandateDebit.update({
          where: { id: debit.id },
          data: {
            status: "failed",
            failureReason: result?.error ?? "provider rejected the debit",
            nextRetryAt: new Date(now.getTime() + RETRY_INTERVAL_MS),
          },
        });
      }
    }
  });
  return created;
}

/**
 * Retry `failed` mandate debits whose `nextRetryAt` has passed — at most once a
 * day per debit. A `skipped` debit is never selected (only `failed`), a paused
 * mandate or a paused purpose is skipped, and on another failure `nextRetryAt`
 * advances by one day. A successful retry returns the debit to `pending` so the
 * settlement webhook can credit the wallet. Returns the number retried.
 */
export async function runMandateRetries(now = new Date()): Promise<number> {
  let retried = 0;
  await forEachCoop(async (coopId) => {
    const failed = await prisma.mandateDebit.findMany({
      where: {
        cooperativeId: coopId,
        status: "failed",
        nextRetryAt: { lte: now },
      },
      include: { mandate: true },
    });

    for (const debit of failed) {
      if (debit.mandate.status !== "active") continue;
      if (csvSet(debit.mandate.pausedPurposes).has(debit.purpose)) continue;

      const narration = `Direct debit retry — ${debit.purpose} (${formatBalance(debit.amount)})`;
      let result: { ok: boolean; error?: string } | undefined;
      try {
        const provider = await resolveProvider(debit.mandate.provider);
        result = await provider.debitMandate?.({
          providerMandateId: debit.mandate.providerMandateId ?? "",
          amount: debit.amount,
          reference: debit.providerRef,
          narration,
        });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : "provider error" };
      }
      retried++;

      if (result?.ok) {
        await prisma.mandateDebit.update({
          where: { id: debit.id },
          data: {
            status: "pending",
            attempts: { increment: 1 },
            nextRetryAt: null,
            failureReason: null,
          },
        });
      } else {
        await prisma.mandateDebit.update({
          where: { id: debit.id },
          data: {
            attempts: { increment: 1 },
            failureReason: result?.error ?? "retry failed",
            nextRetryAt: new Date(now.getTime() + RETRY_INTERVAL_MS),
          },
        });
      }
    }
  });
  return retried;
}

/** Set the cooperative's monthly loan interest rate (admin only). */
export async function setInterestRate(
  phone: string,
  rate: number,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({
    where: { phone, role: { in: ["admin", "superadmin"] } },
  });
  if (!admin) return { ok: false, message: "Only a cooperative admin can set the interest rate." };
  if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
    return {
      ok: false,
      message: "Monthly loan interest must be between 0 and 20%, e.g. *interest 2* for 2%.",
    };
  }
  await prisma.cooperative.update({
    where: { id: admin.cooperativeId },
    data: { loanInterestRate: rate },
  });
  return {
    ok: true,
    message: `Loan interest rate set to *${rate}%/month*. New loan applications will use this rate.`,
  };
}

/**
 * Send every active member their monthly statement on the 1st of the month.
 * Each member receives at most one statement per calendar month.
 */
export async function runMonthlyStatements(now = new Date()): Promise<number> {
  if (now.getDate() !== 1) return 0;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let sent = 0;
  await forEachCoop(async (coopId) => {
    const members = await prisma.member.findMany({
      where: {
        cooperativeId: coopId,
        status: "active",
        consentAt: { not: null },
        OR: [{ lastStatementSentAt: null }, { lastStatementSentAt: { lt: monthStart } }],
      },
      include: { cooperative: true },
    });

    // Process members in batches of 10 to avoid flooding the messaging provider
    for (let i = 0; i < members.length; i += 10) {
      const batch = members.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (m) => {
          if (!m.phone) return;
          const stmt = await showHistory(m.phone);
          if (!stmt.ok) return;
          await notifyMember(
            m,
            `${stmt.message}\n\n_Generated ${now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })} — reply *menu* for options._`,
          ).catch(() => {});
          await prisma.member.update({ where: { id: m.id }, data: { lastStatementSentAt: now } });
        }),
      );
      sent += results.filter((r) => r.status === "fulfilled").length;
    }
  });
  return sent;
}

/** Send a birthday greeting to members whose birthday is today (once per year). */
export async function runBirthdayGreetings(now = new Date()): Promise<number> {
  let sent = 0;
  await forEachCoop(async (coopId) => {
    const members = await prisma.member.findMany({
      where: {
        cooperativeId: coopId,
        status: "active",
        consentAt: { not: null },
        dateOfBirth: { not: null },
        OR: [
          { lastBirthdayGreetedYear: null },
          { lastBirthdayGreetedYear: { not: now.getFullYear() } },
        ],
      },
    });

    // Process in batches of 10 with concurrency
    for (let i = 0; i < members.length; i += 10) {
      const batch = members.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (m) => {
          if (!m.dateOfBirth) return false;
          if (
            m.dateOfBirth.getMonth() !== now.getMonth() ||
            m.dateOfBirth.getDate() !== now.getDate()
          )
            return false;
          try {
            await notifyMember(
              m,
              `🎂 *Happy Birthday, ${m.name}!* 🎉\n\nMay your new year be full of blessings and growth. Your cooperative family celebrates you today. 🥳`,
            );
            await prisma.member.update({
              where: { id: m.id },
              data: { lastBirthdayGreetedYear: now.getFullYear() },
            });
            return true;
          } catch (err) {
            // Log the error but don't fail the entire batch
            console.error(`[scheduler] Failed to send birthday greeting to ${maskId(m.phone)}:`, err);
            return false;
          }
        }),
      );
      sent += results.filter((r) => r.status === "fulfilled" && r.value === true).length;
    }
  });
  return sent;
}

// ---- Data retention & deletion (CAMA compliance) ----
// Monthly job: anonymize financial records older than 7 years, delete stale
// session data older than 30 days. Per the Companies and Allied Matters Act
// (CAMA), cooperative financial records must be retained for at least 6 years;
// we use 7 for safety margin.

export async function runDataRetention(
  now = new Date(),
): Promise<{ anonymized: number; deleted: number }> {
  // Monthly job — runs on the 1st of the month.
  if (now.getDate() !== 1) return { anonymized: 0, deleted: 0 };

  const sevenYearsAgo = new Date(now);
  sevenYearsAgo.setFullYear(sevenYearsAgo.getFullYear() - 7);

  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Anonymize member PII on records older than 7 years (keep amounts for audit)
  let anonymized = 0;
  await forEachCoop(async (coopId) => {
    const staleMembers = await prisma.member.findMany({
      where: { cooperativeId: coopId, createdAt: { lt: sevenYearsAgo }, status: "inactive" },
      select: { id: true },
    });
    for (const m of staleMembers) {
      await prisma.member.update({
        where: { id: m.id },
        data: {
          name: `Redacted_${m.id.slice(-6)}`,
          phone: `redacted_${m.id.slice(-6)}`,
          contactPhone: null,
          email: null,
          nextOfKinName: null,
          nextOfKinPhone: null,
          dateOfBirth: null,
        },
      });
      anonymized++;
    }
  });

  // Delete session data older than 30 days (Session is global, not RLS-scoped).
  const { count: deleted } = await prisma.session.deleteMany({
    where: { updatedAt: { lt: thirtyDaysAgo } },
  });

  if (anonymized > 0 || deleted > 0) {
    console.log(
      `[compliance] Data retention: anonymized ${anonymized} members (7yr), deleted ${deleted} sessions (30d)`,
    );
  }

  return { anonymized, deleted };
}

// ---- Daily movement digest to super admins ----
// Every super sees EVERY debit that left the cooperative yesterday. Silent
// insider theft becomes impossible when all eyes see the same daily summary.

const digestLastSentDate = new Map<string, string>();

export async function runDailyDigest(now = new Date()): Promise<number> {
  // Fire on the configured hour in WEST AFRICA TIME, not the container's own
  // timezone (Render/Docker run UTC, so getHours() was firing an hour late).
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "Africa/Lagos",
    }).format(now),
  );
  const targetHour = Number(process.env.DIGEST_HOUR ?? 20); // 8pm default
  if (hour !== targetHour) return 0;

  const coopIds = await listCooperativeIds();
  const redis = getRedis();
  let sent = 0;
  for (const coopId of coopIds) {
    const key = `${coopId}:${now.toDateString()}`;

    // Dedupe across restarts via Redis (in-memory fallback for single-instance).
    let alreadySent = digestLastSentDate.get(coopId) === key;
    if (!alreadySent && redis) {
      try {
        alreadySent = (await redis.get(`digest:last:${coopId}`)) === key;
      } catch {
        /* ignore — fall back to the in-memory marker */
      }
    }
    if (alreadySent) continue;

    await withCoopContext(coopId, async () => {
      const coop = await prisma.cooperative.findUnique({
        where: { id: coopId },
        select: { name: true },
      });

      const start = new Date(now);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      const [payouts, externals, topups] = await Promise.all([
        prisma.payout.findMany({
          where: {
            cooperativeId: coopId,
            status: "successful",
            createdAt: { gte: start, lt: end },
          },
          include: { member: { select: { name: true } } },
        }),
        prisma.externalPayment.findMany({
          where: { cooperativeId: coopId, status: "paid", updatedAt: { gte: start, lt: end } },
        }),
        prisma.contribution.aggregate({
          where: {
            cooperativeId: coopId,
            type: "topup",
            status: "confirmed",
            paidAt: { gte: start, lt: end },
          },
          _sum: { amount: true },
        }),
      ]);

      // Withdrawals appear inside `payouts` too (TFR-WDR refs) — list them by note.
      const lines: string[] = [];
      let outTotal = 0;
      for (const p of payouts) {
        lines.push(
          `• ${formatBalance(p.amount)} → ${p.member.name} (${p.note?.slice(0, 60) ?? "payout"})`,
        );
        outTotal += p.amount;
      }
      for (const e of externals) {
        lines.push(`• ${formatBalance(e.amount)} → external: ${e.beneficiaryName}`);
        outTotal += e.amount;
      }

      const text =
        `📋 *Daily summary for ${coop?.name ?? "your cooperative"}* (${start.toLocaleDateString("en-GB")})\n\n` +
        (lines.length
          ? `Money out (${formatBalance(outTotal)}):\n${lines.join("\n")}\n\n`
          : `No money went out yesterday. ✅\n\n`) +
        `Money in: *${formatBalance(topups._sum.amount ?? 0)}* via bank transfers.\n\n` +
        `_If ANY line looks wrong, raise it with the other supers NOW — reply *tickets* to open one._`;

      await notifySuperAdminsDigest(coopId, text);
    });

    digestLastSentDate.set(coopId, key);
    if (redis) {
      await redis.set(`digest:last:${coopId}`, key).catch(() => {});
    }
    sent++;
  }
  return sent;
}

/** Digests go to every super admin directly (not the adminPhone alias). */
async function notifySuperAdminsDigest(cooperativeId: string, text: string): Promise<void> {
  const supers = await prisma.member.findMany({
    where: { cooperativeId, role: "superadmin", status: "active" },
  });
  for (const s of supers) {
    try {
      await notifyMember(s, text);
    } catch (err) {
      console.error(`[scheduler] Failed to send digest to super admin ${maskId(s.phone)}:`, err);
    }
  }
}

// ---- Proactive intelligence alerts (opt-in) ----
// Savings reminders, loan/overdue reminders, low-balance warnings, trend
// alerts and monthly summaries. Runs monthly (on the 1st) so members are
// not nagged repeatedly; deduped per cooperative per month.

export async function runBackupVerificationJob(now = new Date()): Promise<number> {
  // Run on the 2nd of each month (after monthly statements)
  if (now.getDate() !== 2) return 0;

  const coopIds = await listCooperativeIds();
  let ran = 0;
  for (const coopId of coopIds) {
    const key = `${coopId}:${now.getFullYear()}-${now.getMonth()}`;
    // Redis-backed claim: survives restarts and is shared across instances.
    if (!(await claimOnce("backup-verify", key, 40 * 24 * 3600))) continue;
    try {
      await withCoopContext(coopId, async () => {
        const { runBackupVerification } = await import("./backup-verify.js");
        await runBackupVerification();
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error("[scheduler] backup verification failed", err);
      await alertSupers(
        "system",
        `Backup verification failed for cooperative ${coopId}: ${msg}`,
        AlertSeverity.CRITICAL,
      );
    }
    ran++;
  }
  return ran;
}

export async function runProactiveAlerts(now = new Date()): Promise<number> {
  if (now.getDate() !== 1) return 0;

  const coopIds = await listCooperativeIds();
  let ran = 0;
  for (const coopId of coopIds) {
    const key = `${coopId}:${now.getFullYear()}-${now.getMonth()}`;
    // Redis-backed claim: survives restarts and is shared across instances.
    if (!(await claimOnce("ai-alerts", key, 40 * 24 * 3600))) continue;
    try {
      await withCoopContext(coopId, () => runAllAlerts(coopId));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error("[scheduler] proactive alerts failed", err);
      await alertSupers(
        "system",
        `Proactive alerts failed for cooperative ${coopId}: ${msg}`,
        AlertSeverity.CRITICAL,
      );
    }
    ran++;
  }
  return ran;
}

// ---------------------------------------------------------------------------
// Scheduler jobs — the bodies run by the BullMQ repeatable jobs (or the
// in-process fallback loops in index.ts when Redis is unavailable).
// ---------------------------------------------------------------------------

/** One scheduler tick: reminders, statements, birthdays, anniversaries,
 *  guarantor defaults, status posts, VA cleanup, retention, STR escalation,
 *  proactive alerts, backup verification. */
export async function runSchedulerTick(): Promise<void> {
  const { checkAnniversaries } = await import("./anniversary.js");
  const { scanGuarantorDefaults, executeDueDeductions } = await import("./guarantordeduction.js");
  const { postAutoStatus } = await import("./status-scheduler.js");
  const { cleanupExpiredVirtualAccounts } = await import("./payments/topup.js");
  const { escalateOverdueSTRs } = await import("./aml.js");

  await runAutoSaveReminders().catch((err) =>
    log.error("[scheduler] auto-save reminders failed", { err: String(err) }),
  );
  await runMandateDebits().catch((err) =>
    log.error("[scheduler] mandate debits failed", { err: String(err) }),
  );
  await runMandateRetries().catch((err) =>
    log.error("[scheduler] mandate retries failed", { err: String(err) }),
  );
  await runMonthlyStatements().catch((err) =>
    log.error("[scheduler] monthly statements failed", { err: String(err) }),
  );
  await runBirthdayGreetings().catch((err) =>
    log.error("[scheduler] birthday greetings failed", { err: String(err) }),
  );
  await checkAnniversaries().catch((err) =>
    log.error("[scheduler] anniversary greetings failed", { err: String(err) }),
  );
  await scanGuarantorDefaults()
    .then(async (n) => {
      if (n > 0) {
        // Critical: guarantor default deductions move money — alert on failure.
        await logAndAlert(
          "system",
          "executeDueDeductions (guarantor default deductions)",
          async () => {
            await executeDueDeductions();
          },
          AlertSeverity.CRITICAL,
        );
      }
    })
    .catch((err) => log.error("[scheduler] guarantor default scan failed", { err: String(err) }));
  await postAutoStatus().catch((err) =>
    log.error("[scheduler] status auto-post failed", { err: String(err) }),
  );
  await cleanupExpiredVirtualAccounts().catch((err) =>
    log.error("[scheduler] virtual account cleanup failed", { err: String(err) }),
  );
  await runDataRetention().catch((err) =>
    log.error("[scheduler] data retention failed", { err: String(err) }),
  );
  await escalateOverdueSTRs().catch((err) =>
    log.error("[scheduler] STR deadline escalation failed", { err: String(err) }),
  );
  await runProactiveAlerts().catch((err) =>
    log.error("[scheduler] proactive alerts failed", { err: String(err) }),
  );
  await runBackupVerificationJob().catch((err) =>
    log.error("[scheduler] backup verification failed", { err: String(err) }),
  );
}

export async function runBackupJob(): Promise<void> {
  const { runBackup } = await import("./backup.js");
  await logAndAlert(
    "system",
    "runBackup (daily backup)",
    async () => {
      await runBackup();
    },
    AlertSeverity.CRITICAL,
  );
}

export async function runReconcileJob(): Promise<void> {
  const { runReconciliation } = await import("./reconcile.js");
  await logAndAlert(
    "system",
    "runReconciliation (nightly reconciliation)",
    async () => {
      await runReconciliation();
    },
    AlertSeverity.CRITICAL,
  );
}

export async function runPollerJob(): Promise<void> {
  const { runTransferPolling } = await import("./statuspoller.js");
  await logAndAlert(
    "system",
    "runTransferPolling (payout status polling)",
    async () => {
      await runTransferPolling();
    },
    AlertSeverity.CRITICAL,
  );
}

export async function runDigestJob(): Promise<void> {
  await logAndAlert(
    "system",
    "runDailyDigest (daily movement digest)",
    async () => {
      await runDailyDigest();
    },
    AlertSeverity.CRITICAL,
  );
}

/** Dispatch a named scheduler job (used by the BullMQ worker). */
export async function runSchedulerJob(name: string): Promise<void> {
  switch (name) {
    case "tick":
      return runSchedulerTick();
    case "backup":
      return runBackupJob();
    case "reconcile":
      return runReconcileJob();
    case "poller":
      return runPollerJob();
    case "digest":
      return runDigestJob();
    default:
      log.warn("[scheduler] unknown job", { name });
  }
}
