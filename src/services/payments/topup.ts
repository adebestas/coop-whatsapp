import { prisma } from "../../lib/prisma.js";
import { resolveProvider, markProviderDown, markProviderUp } from "./index.js";
import type { PaymentNotification } from "./index.js";
import { audit } from "../audit.js";
import { postJournal } from "../journal.js";
import { roundMoney } from "../money.js";

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

  // Virtual account expiry: 90 days from now
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  let lastError: unknown = null;
  let lastProviderName: string | undefined;
  // Try preferred provider first, then all fallbacks
  const fallbacks = otherThan(undefined);
  const attempts = [undefined, ...fallbacks];
  for (const preferred of attempts) {
    const provider = resolveProvider(preferred ?? lastProviderName);
    if (lastProviderName && provider.name === lastProviderName) continue; // skip already-failed
    lastProviderName = provider.name;
    try {
      const va = await provider.createVirtualAccount(params);
      markProviderUp(provider.name);

      await prisma.member.update({
        where: { id: member.id },
        data: {
          virtualAccountNumber: va.accountNumber,
          virtualAccountBank: va.bank,
          virtualAccountProvider: va.provider,
          virtualAccountExpiresAt: expiresAt,
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

function otherThan(name?: string): string[] {
  const providers = ["monnify", "paystack"];
  return providers.filter(p => p !== name);
}

/**
 * Handle an incoming provider webhook notification and credit the member wallet.
 * Idempotent on TWO layers:
 *  1. The deterministic journal txRef (TOPUP-<provider>-<txid>) is inserted
 *     FIRST inside the transaction � a replayed delivery aborts the whole
 *     transaction on the unique constraint before any wallet moves.
 *  2. Contribution.reference (`<provider>-<txid>`) is also unique.
 */
export async function handlePaymentNotification(n: PaymentNotification): Promise<void> {
  if (n.status !== "successful") return;
  if (n.currency !== "NGN") {
    console.warn(`[topup] rejected notification with currency ${n.currency} (expected NGN), txId=${n.transactionId}`);
    return;
  }

  // Find the member by their virtual account number.
  const member = await prisma.member.findFirst({
    where: { virtualAccountNumber: n.accountNumber },
    include: { wallet: true },
  });
  if (!member || !member.wallet) {
    console.warn(`[topup] credit for unknown account ${n.accountNumber}, ignoring`);
    return;
  }

  const amount = roundMoney(n.amount);
  if (amount <= 0) return;
  const reference = `${n.provider}-${n.transactionId}`;

  await prisma.$transaction(async (tx) => {
    // Idempotency gate FIRST: duplicate delivery throws P2002 here, which
    // rolls back everything � the wallet is never credited twice.
    try {
      await postJournal(
        {
          cooperativeId: member.cooperativeId,
          txRef: `TOPUP-${reference}`,
          description: `Wallet top-up via ${n.provider} (${n.transactionId})`,
          postings: [
            { account: "assets:bank", direction: "DEBIT" as const, amount },
            { account: `member_wallet:${member.wallet!.id}`, direction: "CREDIT" as const, amount, memberId: member.id },
          ],
          throwOnDuplicate: true,
        },
        tx as any,
      );
    } catch (err: any) {
      if (err?.code === "P2002") {
        console.log(`[topup] duplicate credit blocked: ${reference}`);
        return; // treat like a no-op success
      }
      throw err;
    }

    await tx.contribution.create({
      data: {
        amount,
        type: "topup",
        note: `Incoming transfer via ${n.provider}`,
        reference,
        status: "confirmed",
        paidAt: new Date(),
        memberId: member.id,
        cooperativeId: member.cooperativeId,
      },
    });
    await tx.wallet.update({
      where: { id: member.wallet!.id },
      data: {
        balance: { increment: amount },
        totalSaved: { increment: amount },
      },
    });
  });

  console.log(`[topup] credited ${member.phone} with ${amount} ${n.currency} (${n.transactionId})`);

  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: member.phone,
    actorId: member.id,
    actorRole: member.role,
    action: "topup.credit",
    targetType: "contribution",
    detail: `${amount} ${n.currency} via ${n.provider} (${n.transactionId})`,
  });
}

/**
 * Clean up expired virtual accounts. Run periodically (e.g. daily).
 * Clears the virtual account fields so stale provider accounts are not used.
 */
export async function cleanupExpiredVirtualAccounts(): Promise<number> {
  const expired = await prisma.member.findMany({
    where: {
      virtualAccountNumber: { not: null },
      virtualAccountExpiresAt: { lt: new Date() },
    },
    select: { id: true, phone: true, virtualAccountNumber: true },
  });

  if (expired.length === 0) return 0;

  await prisma.member.updateMany({
    where: {
      virtualAccountNumber: { not: null },
      virtualAccountExpiresAt: { lt: new Date() },
    },
    data: {
      virtualAccountNumber: null,
      virtualAccountBank: null,
      virtualAccountProvider: null,
      virtualAccountExpiresAt: null,
    },
  });

  console.log(`[topup] cleaned up ${expired.length} expired virtual accounts`);
  return expired.length;
}
