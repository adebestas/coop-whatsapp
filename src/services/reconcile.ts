import { prisma } from "../lib/prisma.js";
import { verifyAuditChain } from "./audit.js";
import { notifySupers } from "./payanyone.js";
import { formatBalance } from "./cooperative.js";
import { trialBalance } from "./journal.js";

/**
 * Nightly reconciliation: data-integrity checks that alert super admins.
 * - audit hash chain tampering
 * - negative wallet balances
 * - payouts/withdrawals stuck in an intermediate state too long
 * - double-entry books that don't balance (tamper / partial-write detector)
 */
export async function runReconciliation(): Promise<string[]> {
  const allAlerts: string[] = [];
  const coops = await prisma.cooperative.findMany({ select: { id: true, name: true } });
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const coop of coops) {
    const alerts: string[] = [];

    // 1. Audit chain integrity.
    const chain = await verifyAuditChain(coop.id);
    if (!chain.ok) {
      alerts.push(`🚨 Audit trail for *${coop.name}* was TAMPERED with at entry ${chain.brokenAt}. Investigate immediately.`);
    }

    // 2. Negative wallets should be impossible.
    const negatives = await prisma.wallet.findMany({
      where: { member: { cooperativeId: coop.id }, balance: { lt: 0 } },
      include: { member: { select: { name: true } } },
    });
    for (const w of negatives) {
      alerts.push(`⚠️ Wallet for ${w.member.name} is NEGATIVE (${formatBalance(w.balance)}).`);
    }

    // 3. Withdrawals waiting on final approval for over 7 days.
    const stale = await prisma.withdrawalRequest.count({
      where: { cooperativeId: coop.id, status: "admin_approved", adminApprovedAt: { lt: weekAgo } },
    });
    if (stale > 0) {
      alerts.push(`ℹ️ ${stale} withdrawal request(s) have waited over a week for super-admin approval.`);
    }

    // 4. Pay-anyone requests that recorded a third approval but never paid.
    const stuck = await prisma.externalPayment.count({
      where: { cooperativeId: coop.id, status: "approved2", approved3ById: { not: null }, updatedAt: { lt: weekAgo } },
    });
    if (stuck > 0) {
      alerts.push(`ℹ️ ${stuck} pay-anyone request(s) are fully approved but not paid — retry with *approvepay <id>*.`);
    }

    // 5. Money mid-flight at the provider for over 24h — needs human eyes,
    //    NEVER auto-fail (the provider may still complete the transfer).
    const stuckPayouts = await prisma.payout.findMany({
      where: { cooperativeId: coop.id, status: "processing", createdAt: { lt: dayAgo } },
      include: { member: { select: { name: true } } },
    });
    for (const p of stuckPayouts) {
      alerts.push(
        `🚨 Payout to ${p.member.name} (${formatBalance(p.amount)}, ref ${p.reference}) has been "processing" for over 24h — verify with the provider before any retry.`,
      );
    }
    const stuckExternals = await prisma.externalPayment.count({
      where: { cooperativeId: coop.id, status: "processing", updatedAt: { lt: dayAgo } },
    });
    if (stuckExternals > 0) {
      alerts.push(`🚨 ${stuckExternals} pay-anyone transfer(s) stuck in "processing" over 24h — verify with the provider.`);
    }
    const stuckWithdrawals = await prisma.withdrawalRequest.count({
      where: { cooperativeId: coop.id, status: "processing", createdAt: { lt: dayAgo } },
    });
    if (stuckWithdrawals > 0) {
      alerts.push(`🚨 ${stuckWithdrawals} withdrawal(s) stuck in "processing" over 24h — verify wallets and provider before retry.`);
    }
    const stuckClaims = await prisma.deathClaim.count({
      where: { cooperativeId: coop.id, status: "processing", createdAt: { lt: dayAgo } },
    });
    if (stuckClaims > 0) {
      alerts.push(`🚨 ${stuckClaims} death-claim payout(s) stuck in "processing" over 24h — investigate immediately.`);
    }

    // 6. Double-entry books must balance. Drift means a write bypassed the
    //    journal or data was edited by hand.
    const tb = await trialBalance(coop.id);
    if (tb.debits !== tb.credits) {
      alerts.push(
        `🚨 Ledger out of balance for *${coop.name}*: debits ${formatBalance(tb.debits)} vs credits ${formatBalance(tb.credits)} (diff ${formatBalance(Math.abs(tb.debits - tb.credits))}).`,
      );
    }

    if (alerts.length > 0) {
      console.log("[reconcile] alerts:\n" + alerts.join("\n"));
      await notifySupers(coop.id, `🌙 *Nightly reconciliation*\n\n${alerts.join("\n")}`).catch(() => {});
      allAlerts.push(...alerts);
    }
  }

  return allAlerts;
}
