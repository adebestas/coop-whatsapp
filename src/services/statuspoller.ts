import { prisma, withTxBatch } from "../lib/prisma.js";
import { resolveProvider } from "./payments/index.js";
import type { TransferStatus } from "./payments/index.js";
import { formatBalance } from "./cooperative.js";
import { recordLedger } from "./ledger.js";
import { audit } from "./audit.js";
import { notifySupers } from "./payanyone.js";
import { applyDividendPayoutUpdate } from "./dividends.js";
import { forEachCoop } from "../lib/tenant-context.js";
import { getCurrency } from "../lib/runtime-context.js";

/**
 * Transfer status polling — the safety net for the "crash after the provider
 * accepted, before we recorded it" window.
 *
 * Every money-out flow marks its row "processing" BEFORE calling the provider
 * and completes/fails it afterwards. If the process dies in between (or the
 * webhook is lost), the row stays processing forever — unless this poller
 * runs: it asks the provider directly about each stuck transfer and then
 *   successful -> completes the flow exactly as the normal path would have;
 *   failed     -> reverts the flow and refunds any wallet debit;
 *   pending    -> leaves it alone (money may still land);
 *   unknown    -> leaves it alone and lets reconciliation escalate after 24h.
 *
 * Runs every TRANSFER_POLL_MINUTES (default 10; 0 disables; never scheduled
 * under NODE_ENV=test — tests invoke runTransferPolling() directly).
 */

const MIN_STUCK_MS = 10 * 60 * 1000;

export function transferPollIntervalMs(): number {
  const raw = process.env.TRANSFER_POLL_MINUTES;
  const minutes =
    raw !== undefined && raw !== "" ? Number(raw) : process.env.NODE_ENV === "test" ? 0 : 10;
  return Math.max(0, minutes) * 60 * 1000;
}

async function statusFor(reference: string): Promise<TransferStatus> {
  const provider = await resolveProvider(undefined, getCurrency());
  if (!provider.getTransferStatus)
    return { status: "unknown", error: "provider has no getTransferStatus" };
  try {
    return await provider.getTransferStatus(reference);
  } catch (err: any) {
    return { status: "unknown", error: String(err?.message ?? err) };
  }
}

/** Settle or refund every stuck "processing" row. Returns action descriptions. */
export async function runTransferPolling(now = new Date()): Promise<string[]> {
  const actions: string[] = [];
  const cutoff = new Date(now.getTime() - MIN_STUCK_MS);

  await forEachCoop(async (coopId) => {
    // ---- Withdrawals (wallet already debited before paying) ----
    const stuckWithdrawals = await prisma.withdrawalRequest.findMany({
      where: { cooperativeId: coopId, status: "processing", createdAt: { lt: cutoff } },
      include: { member: true },
    });
    for (const w of stuckWithdrawals) {
      try {
        const st = await statusFor(`TFR-WDR-${w.id}`);
        if (st.status === "successful") {
          const [claimed] = await withTxBatch([
            prisma.withdrawalRequest.updateMany({
              where: { id: w.id, status: "processing" },
              data: { status: "paid", finalizedAt: now },
            }),
            prisma.member.update({
              where: { id: w.memberId },
              data: { lastWithdrawalAt: now, withdrawalOverride: false },
            }),
          ]);
          // Only book when THIS call actually flipped the row out of
          // "processing". A concurrent webhook/poller may have settled it
          // already; re-booking would post a duplicate ledger entry/journal.
          if (claimed.count === 0) continue;
          // Audit trail: record the poller-confirmed transfer
          await audit({
            cooperativeId: w.cooperativeId,
            actorPhone: "system-poller",
            actorRole: "system",
            action: "withdrawal.poller_confirmed",
            targetType: "withdrawal",
            targetId: w.id,
            amount: w.amount,
            detail: `Withdrawal ${w.id.slice(-6)} confirmed by provider polling`,
          });
          await recordLedger({
            cooperativeId: w.cooperativeId,
            type: "expense",
            category: "withdrawal",
            amount: w.amount,
            note: `Withdrawal ${w.id.slice(-6)} confirmed by poller`,
            reference: w.id,
            fundType: "member",
          });
          actions.push(
            `Withdrawal ${w.id.slice(-6)} (${formatBalance(w.amount)}) confirmed by provider — marked paid.`,
          );
          await notifySupers(
            w.cooperativeId,
            `✅ Poller: withdrawal *${w.id.slice(-6)}* for ${w.member.name} was confirmed ${"successful"} at the provider and is now marked paid.`,
          );
        } else if (st.status === "failed") {
          // Claim the row first so a concurrent refund cannot double-credit
          // the wallet (this runs inside the coop transaction, so the claim
          // and refund remain atomic).
          const claimed = await prisma.withdrawalRequest.updateMany({
            where: { id: w.id, status: "processing" },
            data: { status: "admin_approved" },
          });
          if (claimed.count === 0) continue;
          const wallet = await prisma.wallet.findUnique({ where: { memberId: w.memberId } });
          if (wallet) {
            await prisma.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: w.amount } },
            });
          }
          actions.push(`Withdrawal ${w.id.slice(-6)} FAILED at provider — wallet refunded.`);
          await notifySupers(
            w.cooperativeId,
            `↩️ Poller: withdrawal *${w.id.slice(-6)}* failed at the provider. Wallet refunded automatically.`,
          );
        }
      } catch (err) {
        // One bad row must not abort polling for the remaining coops.
        console.error(`[statuspoller] withdrawal ${w.id} failed`, err);
      }
    }

    // ---- Death claims (same debit-first saga) ----
    const stuckClaims = await prisma.deathClaim.findMany({
      where: {
        cooperativeId: coopId,
        status: "processing",
        createdAt: { lt: cutoff },
        familyAccountNumber: { not: null },
      },
      include: { member: true },
    });
    for (const c of stuckClaims) {
      try {
        const st = await statusFor(`TFR-CLAIM-${c.id}`);
        const amount = c.debitedAmount ?? 0;
        if (st.status === "successful") {
          const claimed = await prisma.deathClaim.updateMany({
            where: { id: c.id, status: "processing" },
            data: { status: "paid", approvedAt: now, finalizedAt: now },
          });
          if (claimed.count === 0) continue;
          await audit({
            cooperativeId: c.cooperativeId,
            actorPhone: "system-poller",
            actorRole: "system",
            action: "deathclaim.poller_confirmed",
            targetType: "deathclaim",
            targetId: c.id,
            amount,
            detail: `Death claim ${c.id.slice(-6)} confirmed by provider polling`,
          });
          actions.push(`Death claim ${c.id.slice(-6)} confirmed by provider — closed as paid.`);
          await notifySupers(
            c.cooperativeId,
            `🕊️ Poller: death claim *${c.id.slice(-6)}* (${c.member.name}) confirmed paid by the provider.`,
          );
        } else if (st.status === "failed") {
          const claimed = await prisma.deathClaim.updateMany({
            where: { id: c.id, status: "processing" },
            data: { status: "validated" },
          });
          if (claimed.count === 0) continue;
          const wallet = await prisma.wallet.findUnique({ where: { memberId: c.memberId } });
          if (amount > 0 && wallet) {
            await prisma.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: amount } },
            });
          }
          await audit({
            cooperativeId: c.cooperativeId,
            actorPhone: "system-poller",
            actorRole: "system",
            action: "deathclaim.poller_refunded",
            targetType: "deathclaim",
            targetId: c.id,
            amount,
            detail: `Death claim ${c.id.slice(-6)} failed at provider — refunded ${amount} kobo`,
          });
          actions.push(
            `Death claim ${c.id.slice(-6)} FAILED at provider — reverted${amount > 0 ? ", wallet refunded" : ""}.`,
          );
          await notifySupers(
            c.cooperativeId,
            `↩️ Poller: death claim *${c.id.slice(-6)}* failed at the provider — reverted${amount > 0 ? " and wallet refunded" : ""}.`,
          );
        }
      } catch (err) {
        console.error(`[statuspoller] death claim ${c.id} failed`, err);
      }
    }

    // ---- Loan disbursements (no wallet involved) ----
    const stuckLoans = await prisma.loan.findMany({
      where: {
        cooperativeId: coopId,
        status: "approved",
        disbursementStatus: "processing",
        createdAt: { lt: cutoff },
      },
      include: { member: true },
    });
    for (const loan of stuckLoans) {
      try {
        const st = await statusFor(`TFR-LOAN-${loan.id}`);
        if (st.status === "successful") {
          const adminCharge = loan.adminCharge ?? 0;
          const disbursable = Math.max(0, loan.amount - adminCharge);
          const claimed = await prisma.loan.updateMany({
            where: { id: loan.id, status: "approved" },
            data: {
              status: "disbursed",
              disbursedAt: now,
              disbursementStatus: "successful",
              disbursementAmount: disbursable,
              disbursementError: null,
            },
          });
          if (claimed.count === 0) continue;
          await recordLedger({
            cooperativeId: loan.cooperativeId,
            type: "income",
            category: "admin_charge",
            amount: adminCharge,
            note: `Admin charge on loan ${loan.id.slice(-6)} (confirmed by poller)`,
            reference: loan.id,
            fundType: "operational",
            counterAccount: "assets:loan_portfolio",
          });
          await audit({
            cooperativeId: loan.cooperativeId,
            actorPhone: "system-poller",
            actorRole: "system",
            action: "loan.poller_disbursed",
            targetType: "loan",
            targetId: loan.id,
            amount: disbursable,
            detail: `Loan ${loan.id.slice(-6)} disbursement confirmed by provider polling`,
          });
          actions.push(
            `Loan ${loan.id.slice(-6)} disbursement confirmed by provider — marked disbursed.`,
          );
          await notifySupers(
            loan.cooperativeId,
            `🎉 Poller: loan *${loan.id.slice(-6)}* (${loan.member.name}) disbursement confirmed by the provider.`,
          );
        } else if (st.status === "failed") {
          const claimed = await prisma.loan.updateMany({
            where: { id: loan.id, disbursementStatus: "processing" },
            data: {
              disbursementStatus: "failed",
              disbursementError: st.error ?? "provider reported failure",
            },
          });
          if (claimed.count === 0) continue;
          actions.push(`Loan ${loan.id.slice(-6)} disbursement FAILED at provider — retryable.`);
          await notifySupers(
            loan.cooperativeId,
            `↩️ Poller: loan *${loan.id.slice(-6)}* disbursement failed at the provider. Reply *pending* to review.`,
          );
        }
      } catch (err) {
        console.error(`[statuspoller] loan ${loan.id} failed`, err);
      }
    }

    // ---- Pay-anyone ----
    const stuckExternals = await prisma.externalPayment.findMany({
      where: { cooperativeId: coopId, status: "processing", createdAt: { lt: cutoff } },
    });
    for (const p of stuckExternals) {
      try {
        const reference = `PAYANY-${p.id.slice(-8)}`;
        const st = await statusFor(reference);
        if (st.status === "successful") {
          // Claim the row first; if a webhook/other poller already settled it,
          // count is 0 and we must not create the payout or book the ledger
          // again.
          const claimed = await prisma.externalPayment.updateMany({
            where: { id: p.id, status: "processing" },
            data: { status: "paid", payoutReference: reference },
          });
          if (claimed.count === 0) continue;
          const provider = await resolveProvider(undefined, getCurrency());
          // The payout is keyed by the transfer reference. If it already
          // exists (partial state left by another path) reuse it instead of
          // inserting a duplicate, which would raise P2002 and poison the
          // cooperative transaction.
          const existingPayout = await prisma.payout.findUnique({
            where: { idempotencyKey: reference },
          });
          if (!existingPayout) {
            await withTxBatch([
              prisma.payout.create({
                data: {
                  amount: p.amount,
                  reference,
                  idempotencyKey: reference,
                  status: "successful",
                  provider: provider.name,
                  providerRef: st.providerRef,
                  note: `Pay-anyone → ${p.beneficiaryName}${p.purpose ? ` (${p.purpose})` : ""} (confirmed by poller)`,
                  memberId: p.initiatedById,
                  cooperativeId: p.cooperativeId,
                },
              }),
            ]);
          }
          await recordLedger({
            cooperativeId: p.cooperativeId,
            type: "expense",
            category: "external_payment",
            amount: p.amount,
            note: `Paid ${p.beneficiaryName} — confirmed by poller`,
            reference: p.id,
            fundType: "operational",
          });
          await audit({
            cooperativeId: p.cooperativeId,
            actorPhone: "system-poller",
            actorRole: "system",
            action: "payanyone.paid",
            targetType: "external_payment",
            targetId: p.id,
            detail: `${formatBalance(p.amount)} confirmed by provider polling`,
          });
          actions.push(
            `Pay-anyone ${p.id.slice(-6)} (${formatBalance(p.amount)}) confirmed by provider — marked paid.`,
          );
          await notifySupers(
            p.cooperativeId,
            `💸 Poller: pay-anyone *${p.id.slice(-6)}* to ${p.beneficiaryName} was confirmed by the provider and booked.`,
          );
        } else if (st.status === "failed") {
          const claimed = await prisma.externalPayment.updateMany({
            where: { id: p.id, status: "processing" },
            data: { status: "approved2", payoutReference: st.error ?? "provider reported failure" },
          });
          if (claimed.count === 0) continue;
          actions.push(`Pay-anyone ${p.id.slice(-6)} FAILED at provider — reverted for retry.`);
          await notifySupers(
            p.cooperativeId,
            `↩️ Poller: pay-anyone *${p.id.slice(-6)}* failed at the provider — reverted so a super can retry the final approval.`,
          );
        }
      } catch (err) {
        console.error(`[statuspoller] external payment ${p.id} failed`, err);
      }
    }

    // ---- Dividend payouts (bank-out journal is posted at initiation; settle or
    // reverse it here if the transfer callback was missed) ----
    const stuckDividends = await prisma.dividendEntry.findMany({
      where: {
        dividend: { cooperativeId: coopId },
        status: "processing",
        createdAt: { lt: cutoff },
        payoutId: { not: null },
      },
      include: { payout: true },
    });
    for (const entry of stuckDividends) {
      const payout = entry.payout;
      if (!payout?.provider) continue;
      const reference = payout.idempotencyKey ?? payout.reference;
      const st = await statusFor(reference);
      if (st.status === "successful") {
        await applyDividendPayoutUpdate({
          provider: payout.provider,
          reference,
          status: "successful",
        });
        actions.push(`Dividend payout ${reference.slice(-10)} confirmed by provider — settled.`);
        await notifySupers(
          payout.cooperativeId,
          `✅ Poller: dividend payout *${reference.slice(-10)}* was confirmed by the provider and settled.`,
        );
      } else if (st.status === "failed") {
        await applyDividendPayoutUpdate({ provider: payout.provider, reference, status: "failed" });
        actions.push(
          `Dividend payout ${reference.slice(-10)} FAILED at provider — journal reversed.`,
        );
        await notifySupers(
          payout.cooperativeId,
          `↩️ Poller: dividend payout *${reference.slice(-10)}* failed at the provider. The bank-out journal was reversed.`,
        );
      }
    }
  });
  return actions;
}
