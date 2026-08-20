import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/whatsapp.js";
import { approveLoan, listPendingLoans, rejectLoan } from "./loans.js";
import { formatBalance } from "./cooperative.js";
import { resolveProvider } from "./payments/index.js";

/** Is this phone an admin of some cooperative? */
export async function isAdmin(phone: string): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  return member !== null;
}

export async function makeAdmin(phone: string): Promise<void> {
  await prisma.member.updateMany({ where: { phone }, data: { role: "admin" } });
}

/** Execute an admin command from WhatsApp. Returns true if handled as admin. */
export async function handleAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  if (!(await isAdmin(phone))) return false;

  const admin = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  if (!admin) return false;
  const coopId = admin.cooperativeId;

  switch (cmd) {
    case "pending":
      await sendPendingLoans(phone, coopId);
      return true;

    case "approve": {
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *approve <loan id>*" });
        return true;
      }
      const result = await approveLoan(id);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "reject": {
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *reject <loan id>*" });
        return true;
      }
      const result = await rejectLoan(id);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "payout": {
      // payout <amount> <member phone>
      const amount = Number(args[0]);
      const targetPhone = args[1]?.replace(/[^0-9]/g, "");
      if (!Number.isFinite(amount) || amount <= 0 || !targetPhone) {
        await sendText({ to: phone, text: "Usage: *payout <amount> <member phone>*, e.g. *payout 5000 2348012345678*" });
        return true;
      }
      await handlePayout(phone, coopId, amount, targetPhone);
      return true;
    }

    default:
      return false;
  }
}

async function sendPendingLoans(phone: string, coopId: string): Promise<void> {
  const loans = await listPendingLoans(coopId);
  if (loans.length === 0) {
    await sendText({ to: phone, text: "No pending loan applications. ✅" });
    return;
  }
  const body = loans
    .map(
      (l, i) =>
        `${i + 1}. *${l.id.slice(-6)}* — ${l.member.name} — ${formatBalance(l.amount)} for ${l.tenureMonths}mo\n   Reply *approve ${l.id.slice(-6)}* or *reject ${l.id.slice(-6)}*`,
    )
    .join("\n");
  await sendText({
    to: phone,
    text: `*Pending loan applications*\n\n${body}`,
  });
}

async function handlePayout(
  adminPhone: string,
  coopId: string,
  amount: number,
  targetPhone: string,
): Promise<void> {
  const target = await prisma.member.findFirst({
    where: { cooperativeId: coopId, phone: targetPhone },
  });
  if (!target) {
    await sendText({ to: adminPhone, text: `No member found with phone ${targetPhone} in your cooperative.` });
    return;
  }

  const reference = `PO-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await prisma.payout.create({
    data: {
      amount,
      reference,
      status: "pending",
      note: `Admin payout to ${target.name}`,
      memberId: target.id,
      cooperativeId: coopId,
    },
  });

  const provider = resolveProvider();
  try {
    const result = provider.payout
      ? await provider.payout({
          amount,
          bankAccountNumber: "0000000000",
          bankCode: "044",
          recipientName: target.name,
          reference,
        })
      : { ok: false, error: "no payout method on provider" };

    await prisma.payout.update({
      where: { reference },
      data: {
        status: result.ok ? "successful" : "failed",
        provider: provider.name,
        providerRef: result.providerRef,
        note: result.ok ? undefined : result.error,
      },
    });

    await sendText({
      to: adminPhone,
      text: result.ok
        ? `Payout of ${formatBalance(amount)} to *${target.name}* (${target.phone}) was sent ✅ (ref ${reference.slice(-6)}).`
        : `Payout to *${target.name}* failed: ${result.error}. No money moved.`,
    });
  } catch (err) {
    await prisma.payout.update({ where: { reference }, data: { status: "failed" } });
    await sendText({
      to: adminPhone,
      text: `Payout to *${target.name}* failed. Please check the payment provider configuration.`,
    });
  }
}