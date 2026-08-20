import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { approveLoan, listPendingLoans, rejectLoan } from "./loans.js";
import { formatBalance } from "./cooperative.js";
import { resolveProvider } from "./payments/index.js";
import { broadcastToScope, createUnit, listUnits, setUnitAdmin, unitAdminOf } from "./units.js";
import { distributeDividend } from "./dividends.js";
import { setInterestRate } from "./scheduler.js";

/** Is this phone an admin of some cooperative? */
export async function isAdmin(phone: string): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  return member !== null;
}

export async function makeAdmin(phone: string): Promise<void> {
  await prisma.member.updateMany({ where: { phone }, data: { role: "admin" } });
}

/** Resolve an admin's access scope: coop-level or a single unit. */
async function adminContext(phone: string) {
  const admin = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  if (!admin) return null;
  const coop = await prisma.cooperative.findUnique({ where: { id: admin.cooperativeId } });
  const unitAdmin = coop && coop.adminPhone === admin.phone ? null : await unitAdminOf(admin);
  return { admin, coop, unitAdmin };
}

/** Execute an admin command from WhatsApp. Returns true if handled as admin. */
export async function handleAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  const ctx = await adminContext(phone);
  if (!ctx) return false;
  const { admin, coop, unitAdmin } = ctx;
  const coopId = admin.cooperativeId;

  switch (cmd) {
    case "pending": {
      const loans = await listPendingLoans(coopId);
      // Unit admins only see loans from their own workplace.
      const scoped = unitAdmin
        ? loans.filter((l) => l.member.unitId === unitAdmin.unit.id)
        : loans;
      await sendPendingLoans(phone, scoped, unitAdmin !== null);
      return true;
    }

    case "approve": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can approve loans." });
        return true;
      }
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
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can reject loans." });
        return true;
      }
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
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can make payouts." });
        return true;
      }
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

    case "broadcast": {
      const message = args.join(" ").trim();
      if (!message) {
        await sendText({ to: phone, text: "Usage: *broadcast <message>* to send to all members (or *broadcast unit <message>* to your workplace)." });
        return true;
      }
      const scope = args[0] === "unit" ? "unit" : "coop";
      const body = scope === "unit" ? args.slice(1).join(" ") : message;
      const result = await broadcastToScope({ senderPhone: phone, message: body, scope });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "addunit": {
      // addunit <name> <code>
      const name = args.slice(0, -1).join(" ");
      const code = args[args.length - 1];
      if (!name || !code) {
        await sendText({ to: phone, text: "Usage: *addunit <name> <code>*, e.g. *addunit Lagos Office LAG01*." });
        return true;
      }
      const result = await createUnit(phone, name, code);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "unitadmin": {
      // unitadmin <unitcode> <membercode>
      const unitCode = args[0];
      const memberCode = args[1];
      if (!unitCode || !memberCode) {
        await sendText({ to: phone, text: "Usage: *unitadmin <unit code> <member code>*, e.g. *unitadmin LAG01 ABC123-DEFG*." });
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

    case "interest": {
      const rate = Number(args[0]);
      if (!Number.isFinite(rate) || rate < 0 || rate > 20) {
        await sendText({ to: phone, text: "Usage: *interest <rate%>*, e.g. *interest 1* for 1% monthly on savings." });
        return true;
      }
      const result = await setInterestRate(phone, rate);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "paydividend": {
      const rate = Number(args[0]);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
        await sendText({ to: phone, text: "Usage: *paydividend <rate%>*, e.g. *paydividend 5* to pay a 5% dividend." });
        return true;
      }
      const result = await distributeDividend(phone, rate);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    default:
      return false;
  }
}

async function sendPendingLoans(phone: string, loans: Awaited<ReturnType<typeof listPendingLoans>>, scoped: boolean): Promise<void> {
  if (loans.length === 0) {
    await sendText({ to: phone, text: "No pending loan applications. ✅" });
    return;
  }
  const body = loans
    .map((l) => {
      const g = l.guarantors.map((x) => `${x.member.name} (${x.status})`).join(", ") || "none yet";
      return (
        `• *${l.id.slice(-6)}* — ${l.member.name} — ${formatBalance(l.amount)} for ${l.tenureMonths}mo\n` +
        `   Guarantors: ${g}\n` +
        `   ${l.status === "guaranteed" ? `Reply *approve ${l.id.slice(-6)}*` : "⏳ waiting for guarantors"}`
      );
    })
    .join("\n");
  await sendText({
    to: phone,
    text: `${scoped ? "*Pending loans — your workplace*\n\n" : "*Pending loan applications*\n\n"}${body}`,
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