import { prisma } from "../lib/prisma.js";
import { resolveProvider } from "./payments/index.js";
import type { TransferStatus } from "./payments/index.js";
import { formatBalance } from "./cooperative.js";
import { recordLedger } from "./ledger.js";
import { audit } from "./audit.js";
import { notifySupers } from "./payanyone.js";

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
  const minutes = raw !== undefined && raw !== "" ? Number(raw) : process.env.NODE_ENV === "test" ? 0 : 10;
  return Math.max(0, minutes) * 60 * 1000;
}

async function statusFor(reference: string): Promise<TransferStatus> {
  const provider = resolveProvider();
  if (!provider.getTransferStatus) return { status: "unknown", error: "provider has no getTransferStatus" };
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

  // ---- Withdrawals (wallet already debited before paying) ----
  const stuckWithdrawals = await prisma.withdrawalRequest.findMany({
    where: { status: "processing", createdAt: { lt: cutoff } },
    include: { member: true },
  });
  for (const w of stuckWithdrawals) {
    const st = await statusFor(`TFR-WDR-${w.id}`);
    if (st.status === "successful") {
      await prisma.$transaction([
        prisma.withdrawalRequest.updateMany({
          where: { id: w.id, status: "processing" },
          data: { status: "paid", finalizedAt: now },
        }),
        prisma.member.update({
          where: { id: w.memberId },
          data: { lastWithdrawalAt: now, withdrawalOverride: false },
        }),
      ]);
      actions.push(`Withdrawal ${w.id.slice(-6)} (${formatBalance(w.amount)}) confirmed by provider — marked paid.`);
      await notifySupers(w.cooperativeId, `✅ Poller: withdrawal *${w.id.slice(-6)}* for ${w.member.name} was confirmed ${"successful"} at the provider and is now marked paid.`);
    } else if (st.status === "failed") {
      const wallet = await prisma.wallet.findUnique({ where: { memberId: w.memberId } });
      await prisma.$transaction([
        ...(wallet
          ? [prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: w.amount } } })]
          : []),
        prisma.withdrawalRequest.updateMany({
          where: { id: w.id, status: "processing" },
          data: { status: "admin_approved" },
        }),
      ]);
      actions.push(`Withdrawal ${w.id.slice(-6)} FAILED at provider — wallet refunded.`);
      await notifySupers(w.cooperativeId, `↩️ Poller: withdrawal *${w.id.slice(-6)}* failed at the provider. Wallet refunded automatically.`);
    }
  }

  // ---- Death claims (same debit-first saga) ----
  const stuckClaims = await prisma.deathClaim.findMany({
    where: { status: "processing", createdAt: { lt: cutoff }, familyAccountNumber: { not: null } },
    include: { member: true },
  });
  for (const c of stuckClaims) {
    const st = await statusFor(`TFR-CLAIM-${c.id}`);
    const wallet = await prisma.wallet.findUnique({ where: { memberId: c.memberId } });
    const amount = Math.max(0, wallet?.balance ?? 0);
    if (st.status === "successful") {
      await prisma.deathClaim.updateMany({
        where: { id: c.id, status: "processing" },
        data: { status: "paid", approvedAt: now, finalizedAt: now },
      });
      actions.push(`Death claim ${c.id.slice(-6)} confirmed by provider — closed as paid.`);
      await notifySupers(c.cooperativeId, `🕊️ Poller: death claim *${c.id.slice(-6)}* (${c.member.name}) confirmed paid by the provider.`);
    } else if (st.status === "failed") {
      // The saga debited the full pre-payout balance; refund that amount.
      const debited = amount > 0 ? amount : null;
      if (debited && wallet) {
        await prisma.$transaction([
          prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: debited } } }),
          prisma.deathClaim.updateMany({
            where: { id: c.id, status: "processing" },
            data: { status: "validated" },
          }),
        ]);
      } else {
        await prisma.deathClaim.updateMany({
          where: { id: c.id, status: "processing" },
          data: { status: "validated" },
        });
      }
      actions.push(`Death claim ${c.id.slice(-6)} FAILED at provider — reverted${debited ? ", wallet refunded" : ""}.`);
      await notifySupers(c.cooperativeId, `↩️ Poller: death claim *${c.id.slice(-6)}* failed at the provider — reverted${debited ? " and wallet refunded" : ""}.`);
    }
  }

  // ---- Loan disbursements (no wallet involved) ----
  const stuckLoans = await prisma.loan.findMany({
    where: { status: "approved", disbursementStatus: "processing", createdAt: { lt: cutoff } },
    include: { member: true },
  });
  for (const loan of stuckLoans) {
    const st = await statusFor(`TFR-LOAN-${loan.id}`);
    if (st.status === "successful") {
      const adminCharge = loan.adminCharge ?? 0;
      const disbursable = Math.max(0, loan.amount - adminCharge);
      await prisma.loan.updateMany({
        where: { id: loan.id, status: "approved" },
        data: {
          status: "disbursed",
          disbursedAt: now,
          disbursementStatus: "successful",
          disbursementAmount: disbursable,
          disbursementError: null,
        },
      });
      await recordLedger({
        cooperativeId: loan.cooperativeId,
        type: "income",
        category: "admin_charge",
        amount: adminCharge,
        note: `Admin charge on loan ${loan.id.slice(-6)} (confirmed by poller)`,
        reference: loan.id,
      });
      actions.push(`Loan ${loan.id.slice(-6)} disbursement confirmed by provider — marked disbursed.`);
      await notifySupers(loan.cooperativeId, `🎉 Poller: loan *${loan.id.slice(-6)}* (${loan.member.name}) disbursement confirmed by the provider.`);
    } else if (st.status === "failed") {
      await prisma.loan.updateMany({
        where: { id: loan.id, disbursementStatus: "processing" },
        data: { disbursementStatus: "failed", disbursementError: st.error ?? "provider reported failure" },
      });
      actions.push(`Loan ${loan.id.slice(-6)} disbursement FAILED at provider — retryable.`);
      await notifySupers(loan.cooperativeId, `↩️ Poller: loan *${loan.id.slice(-6)}* disbursement failed at the provider. Reply *pending* to review.`);
    }
  }

  // ---- Pay-anyone ----
  const stuckExternals = await prisma.externalPayment.findMany({
    where: { status: "processing", createdAt: { lt: cutoff } },
  });
  for (const p of stuckExternals) {
    const reference = `PAYANY-${p.id.slice(-8)}`;
    const st = await statusFor(reference);
    if (st.status === "successful") {
      const provider = resolveProvider();
      await prisma.$transaction([
        prisma.externalPayment.updateMany({
          where: { id: p.id, status: "processing" },
          data: { status: "paid", payoutReference: reference },
        }),
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
      await recordLedger({
        cooperativeId: p.cooperativeId,
        type: "expense",
        category: "external_payment",
        amount: p.amount,
        note: `Paid ${p.beneficiaryName} — confirmed by poller`,
        reference: p.id,
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
      actions.push(`Pay-anyone ${p.id.slice(-6)} (${formatBalance(p.amount)}) confirmed by provider — marked paid.`);
      await notifySupers(p.cooperativeId, `💸 Poller: pay-anyone *${p.id.slice(-6)}* to ${p.beneficiaryName} was confirmed by the provider and booked.`);
    } else if (st.status === "failed") {
      await prisma.externalPayment.updateMany({
        where: { id: p.id, status: "processing" },
        data: { status: "approved2", payoutReference: st.error ?? "provider reported failure" },
      });
      actions.push(`Pay-anyone ${p.id.slice(-6)} FAILED at provider — reverted for retry.`);
      await notifySupers(p.cooperativeId, `↩️ Poller: pay-anyone *${p.id.slice(-6)}* failed at the provider — reverted so a super can retry the final approval.`);
    }
  }

  return actions;
}

