/**
 * TEST-ONLY money helper — DO NOT use in production.
 *
 * This fabricates a wallet credit with NO real payment (no Monnify/Paystack).
 * It lives under tests/ (not src/) so it can never ship in the production
 * bundle. The only legitimate money-in path is `topup.ts`
 * `handlePaymentNotification` via a verified provider webhook.
 */
import { prisma, withTxBatch } from "../src/lib/prisma.js";
import { getMemberByPhone, formatBalance } from "../src/services/cooperative.js";
import { getCoopConfig } from "../src/services/coop-config.js";
import { LIMITS } from "../src/lib/money.js";
import { audit } from "../src/services/audit.js";
import { qualifyReferral } from "../src/services/referrals.js";

export async function createContribution(
  phone: string,
  amount: number,
): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    return {
      ok: false,
      message: "You need to join a cooperative first. Reply *join <code>* to get started.",
    };
  }
  if (!member.wallet) {
    return { ok: false, message: "No wallet found. Please contact your cooperative admin." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Please enter a valid amount, e.g. *save 2000*." };
  }
  const coopConfig = await getCoopConfig(member.cooperativeId);
  if (amount < coopConfig.minContribution) {
    return {
      ok: false,
      message: `Minimum save amount is *${formatBalance(coopConfig.minContribution)}*.`,
    };
  }
  if (amount > LIMITS.MAX_SAVE) {
    return { ok: false, message: `Maximum save amount is *${formatBalance(LIMITS.MAX_SAVE)}*.` };
  }

  const reference = `CON-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  await withTxBatch([
    prisma.contribution.create({
      data: {
        amount,
        reference,
        status: "confirmed",
        paidAt: new Date(),
        memberId: member.id,
        cooperativeId: member.cooperativeId,
      },
    }),
    prisma.wallet.update({
      where: { id: member.wallet.id },
      data: {
        balance: { increment: amount },
        totalSaved: { increment: amount },
      },
    }),
  ]);

  const balanceBefore = member.wallet.balance ?? 0;
  const balance = balanceBefore + amount;
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorId: member.id,
    actorRole: member.role,
    action: "contribution.create",
    targetType: "contribution",
    amount,
    balanceBefore,
    balanceAfter: balance,
    detail: formatBalance(amount),
  });
  await qualifyReferral(member.cooperativeId, member.id).catch(() => {});
  return {
    ok: true,
    message: `✅ Saved ${formatBalance(amount)}.\nYour new balance is *${formatBalance(balance)}*.\n\nReply *balance* anytime to check.`,
  };
}
