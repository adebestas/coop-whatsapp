import { prisma } from "../../lib/prisma.js";
import { resolveProvider } from "./index.js";
import type { PaymentNotification } from "./index.js";

/**
 * Create a virtual account for a member so they can receive transfers.
 * Idempotent — returns the existing account if already provisioned.
 */
export async function provisionVirtualAccount(memberId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) return { ok: false, message: "Member not found." };
  if (member.virtualAccountNumber) {
    return {
      ok: true,
      message: `Your funding account is *${member.virtualAccountNumber}* (${member.virtualAccountBank}). Transfer to it and your wallet is credited automatically.`,
    };
  }

  const provider = resolveProvider();
  try {
    const va = await provider.createVirtualAccount({
      phone: member.phone,
      name: member.name,
      reference: `MEM-${member.id}`,
      currency: "NGN",
    });

    await prisma.member.update({
      where: { id: member.id },
      data: {
        virtualAccountNumber: va.accountNumber,
        virtualAccountBank: va.bank,
        virtualAccountProvider: va.provider,
      },
    });

    return {
      ok: true,
      message: `Your personal funding account is ready:\n\n*${va.accountNumber}*\nBank: *${va.bank}*\n\nTransfer to it anytime and your wallet is credited automatically.`,
    };
  } catch (err) {
    console.error("[topup] virtual account provisioning failed", err);
    return {
      ok: false,
      message: "We couldn't set up your funding account right now. Please try again later.",
    };
  }
}

/**
 * Handle an incoming provider webhook notification and credit the member wallet.
 * Idempotent: the same provider transaction id never credits twice.
 */
export async function handlePaymentNotification(n: PaymentNotification): Promise<void> {
  if (n.status !== "successful") return;

  // Deduplicate on provider transaction id.
  const existing = await prisma.contribution.findFirst({
    where: { reference: `${n.provider}-${n.transactionId}` },
  });
  if (existing) return;

  // Find the member by their virtual account number.
  const member = await prisma.member.findFirst({
    where: { virtualAccountNumber: n.accountNumber },
    include: { wallet: true },
  });
  if (!member) {
    console.warn(`[topup] credit for unknown account ${n.accountNumber}, ignoring`);
    return;
  }

  await prisma.$transaction([
    prisma.contribution.create({
      data: {
        amount: n.amount,
        type: "topup",
        note: `Incoming transfer via ${n.provider}`,
        reference: `${n.provider}-${n.transactionId}`,
        status: "confirmed",
        paidAt: new Date(),
        memberId: member.id,
        cooperativeId: member.cooperativeId,
      },
    }),
    prisma.wallet.update({
      where: { id: member.wallet!.id },
      data: {
        balance: { increment: n.amount },
        totalSaved: { increment: n.amount },
      },
    }),
  ]);

  console.log(`[topup] credited ${member.phone} with ${n.amount} ${n.currency} (${n.transactionId})`);
}