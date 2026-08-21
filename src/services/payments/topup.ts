import { prisma } from "../../lib/prisma.js";
import { resolveProvider, markProviderDown } from "./index.js";
import type { PaymentNotification } from "./index.js";
import { audit } from "../audit.js";

/**
 * Create a virtual account for a member so they can receive transfers.
 * Idempotent — returns the existing account if already provisioned.
 * Tries the preferred provider first; if it's down (network/downtime) the
 * other provider is used automatically.
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

  // Real phone for the provider KYC. WhatsApp members have it on `phone`;
  // Telegram members must have set `contactPhone` (collected at onboarding
  // or via the `phone <number>` command).
  const kycPhone =
    member.contactPhone ?? (member.phone.startsWith("tg:") ? null : member.phone);
  if (!kycPhone) {
    return {
      ok: false,
      message:
        "We need your real phone number to set up a funding account. Reply with *phone 08012345678* and try *fund* again.",
    };
  }

  const params = {
    phone: kycPhone,
    name: member.name,
    reference: `MEM-${member.id}`,
    currency: "NGN",
  };

  let lastError: unknown = null;
  let lastProviderName: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const provider = resolveProvider(attempt === 0 ? undefined : otherThan(lastProviderName));
    lastProviderName = provider.name;
    try {
      const va = await provider.createVirtualAccount(params);

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
      lastError = err;
      console.error(`[topup] ${provider.name} failed, failing over`, err);
      markProviderDown(provider.name);
    }
  }

  console.error("[topup] all providers failed", lastError);
  return {
    ok: false,
    message: "We couldn't set up your funding account right now. Please try again later.",
  };
}

function otherThan(name?: string): string | undefined {
  return name === "paystack" ? "flutterwave" : name === "flutterwave" ? "paystack" : undefined;
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

  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: member.phone,
    actorId: member.id,
    actorRole: member.role,
    action: "topup.credit",
    targetType: "contribution",
    detail: `${n.amount} ${n.currency} via ${n.provider} (${n.transactionId})`,
  });
}