import { prisma, withTx, withTxBatch } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { toKobo } from "../lib/money.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { assertFreshPin } from "./auth2fa.js";
import { approveLoan, listPendingLoans, rejectLoan } from "./loans.js";
import {
  approveWithdrawal,
  finalizeWithdrawal,
  rejectWithdrawal,
  overrideWithdrawalRule,
} from "./withdrawals.js";
import { startAssistWithdrawal, confirmAssistWithdrawal } from "./adminassist.js";
import {
  checkMultiSigRequirement,
  processMultiSigResponse,
  auditSuperadminCommand,
} from "../lib/security-hardening.js";
import { checkVelocity, checkDailyPayoutLimit } from "./fraud.js";
import { sendToBank } from "./disbursements.js";
import { AdminContext, roleLabel, guardFailed } from "./admin-context.js";

export async function sendPendingLoans(
  phone: string,
  loans: Awaited<ReturnType<typeof listPendingLoans>>,
  scoped: boolean,
): Promise<void> {
  if (loans.length === 0) {
    await sendText({ to: phone, text: "No pending loan applications. ✅" });
    return;
  }
  const body = loans
    .map((l) => {
      const g = l.guarantors.map((x) => `${x.member.name} (${x.status})`).join(", ") || "none yet";
      const stage =
        l.status === "guaranteed"
          ? "Reply *approve <id>* (admin)"
          : l.status === "admin_approved"
            ? "⏳ awaiting *super admin* final approval"
            : "⏳ waiting for guarantors";
      return (
        `• *${l.id.slice(-6)}* — ${l.member.name} — ${formatBalance(l.amount)} for ${l.tenureMonths}mo\n` +
        `   Guarantors: ${g}\n` +
        `   ${stage}`
      );
    })
    .join("\n");
  await sendText({
    to: phone,
    text: `${scoped ? "*Pending loans — your workplace*\n\n" : "*Pending loan applications*\n\n"}${body}`,
  });
}

/**
 * Super-admin payout: pays from the member's WALLET to their bank on file,
 * name-verified by the provider, wallet debited atomically.
 */
export async function handlePayout(
  ctx: AdminContext,
  amount: number,
  targetPhone: string,
  narration: string,
): Promise<void> {
  const { admin, coop } = ctx;
  const target = await prisma.member.findFirst({
    where: { cooperativeId: coop.id, phone: targetPhone },
    include: { wallet: true },
  });
  if (!target) {
    await sendText({
      to: admin.phone,
      text: `No member found with phone ${targetPhone} in your cooperative.`,
    });
    return;
  }
  if (!target.bankAccountNumber || !target.bankCode) {
    await sendText({
      to: admin.phone,
      text: `${target.name} has no bank account on file. They should reply *withdraw <amount>* once to save their bank details first.`,
    });
    return;
  }
  const balance = target.wallet?.balance ?? 0;
  if (balance < amount) {
    await sendText({
      to: admin.phone,
      text: `${target.name}'s wallet has ${formatBalance(balance)} — less than ${formatBalance(amount)}. No money moved.`,
    });
    return;
  }

  // Fraud guard: velocity check — max 5 money-out per 10 minutes per member.
  if (!(await checkVelocity(target.id))) {
    await sendText({
      to: admin.phone,
      text: `🛑 Too many transactions for ${target.name} in a short period. Please wait a few minutes and try again.`,
    });
    return;
  }

  // Fraud guard: daily ceiling on total money-out.
  const limit = await checkDailyPayoutLimit(coop.id, amount);
  if (!limit.ok) {
    await sendText({ to: admin.phone, text: limit.message! });
    return;
  }

  // Multi-sig check: large payouts need second superadmin approval (playbook Attack 6 mitigation)
  const multiSig = await checkMultiSigRequirement({
    cooperativeId: coop.id,
    amount,
    initiatorPhone: admin.phone,
    targetId: target.id,
  });
  if (!multiSig.needsApproval && multiSig.blocked) {
    await sendText({
      to: admin.phone,
      text: `⛔ ${multiSig.error ?? "Payout blocked — multi-sig service temporarily unavailable."}`,
    });
    return;
  }
  if (multiSig.needsApproval) {
    await auditSuperadminCommand({
      cooperativeId: coop.id,
      actorPhone: admin.phone,
      actorId: admin.id,
      command: "payout.pending_multisig",
      target: target.name,
      detail: `${formatBalance(amount)} to ${target.name} — awaiting second superadmin approval`,
      isHighRisk: true,
    });
    await sendText({
      to: admin.phone,
      text: `🔐 Payout of ${formatBalance(amount)} needs a second superadmin approval.\n\nOther superadmins have been notified. Once approved, reply *payout ${targetPhone} ${amount / 100} ${narration}* again to proceed.`,
    });
    return;
  }

  // STEP 1 — atomic claim: create the request in "processing" state so concurrent
  // calls for the same member are rejected. Also debits the wallet in the same
  // transaction so the debit and claim are inseparable.
  const claimed = await withTx(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { memberId: target.id } });
    if (!wallet || wallet.balance < amount) {
      return { ok: false as const, message: "Insufficient balance. No money moved." };
    }
    const debited = await tx.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (debited.count === 0) {
      return { ok: false as const, message: "Insufficient balance. No money moved." };
    }
    const request = await tx.withdrawalRequest.create({
      data: {
        amount,
        status: "processing",
        bankAccountNumber: target.bankAccountNumber!,
        bankCode: target.bankCode!,
        bankName: target.bankName ?? null,
        memberId: target.id,
        cooperativeId: coop.id,
        finalizedById: admin.id,
      },
    });
    return { ok: true as const, request, wallet };
  });

  if (!claimed.ok) {
    await sendText({ to: admin.phone, text: claimed.message });
    return;
  }

  // Whether money has actually been sent. Once true, the outer catch must NOT
  // refund (that would double-pay).
  let paid = false;

  try {
    // STEP 2 — send to bank (outside the transaction so the provider call
    // doesn't hold a DB lock).
    const result = await sendToBank({
      memberId: target.id,
      amount,
      bankAccountNumber: target.bankAccountNumber,
      bankCode: target.bankCode,
      bankName: target.bankName ?? undefined,
      note: `Super admin payout to ${target.name} — ${narration}`,
      idempotencyKey: `TFR-PO-${claimed.request.id}`,
      successMessage: `✅ ${formatBalance(amount)} sent to your bank account. Narration: "${narration}".`,
    });

    if (result.status === "unsure") {
      // The provider may have submitted the transfer. NEVER auto-refund here.
      await prisma.withdrawalRequest.updateMany({
        where: { id: claimed.request.id },
        data: { status: "investigating" },
      });
      await auditSuperadminCommand({
        cooperativeId: coop.id,
        actorPhone: admin.phone,
        actorId: admin.id,
        command: "payout.ambiguous",
        target: target.name,
        detail: `${formatBalance(amount)} — payout outcome unconfirmed. Reconcile with the payment provider before retrying or refunding.`,
        isHighRisk: true,
      }).catch(() => {});
      await sendText({
        to: admin.phone,
        text: `⚠️ Payout could not be confirmed and was flagged for reconciliation. Do NOT retry or refund until the provider is checked: ${result.message}`,
      });
      return;
    }

    if (!result.ok) {
      // STEP 3b — refund on CONFIRMED failure and hand back for retry.
      await withTxBatch([
        prisma.wallet.update({
          where: { id: claimed.wallet.id },
          data: { balance: { increment: amount } },
        }),
        prisma.withdrawalRequest.updateMany({
          where: { id: claimed.request.id, status: "processing" },
          data: { status: "admin_approved" },
        }),
      ]);
      console.error(
        `[payout] sendToBank failed, refunded: ${claimed.request.id} — ${result.message}`,
      );
      await sendText({
        to: admin.phone,
        text: `Payout failed: ${result.message}. Wallet refunded.`,
      });
      return;
    }

    // STEP 3a — success: mark paid.
    paid = true;
    await prisma.withdrawalRequest.updateMany({
      where: { id: claimed.request.id, status: "processing" },
      data: { status: "paid", finalizedAt: new Date() },
    });

    await audit({
      cooperativeId: coop.id,
      actorPhone: admin.phone,
      actorId: admin.id,
      actorRole: "superadmin",
      action: "payout.send",
      targetType: "member",
      targetId: target.id,
      detail: `${formatBalance(amount)} to ${target.name} — ${narration}`,
    });

    // Enhanced audit: alert other superadmins about large payouts
    await auditSuperadminCommand({
      cooperativeId: coop.id,
      actorPhone: admin.phone,
      actorId: admin.id,
      command: "payout.completed",
      target: target.name,
      detail: `${formatBalance(amount)} to ${target.name} — ${narration}`,
      isHighRisk: amount >= 100_000_00, // ₦100k+
    });

    if (limit.warning) {
      await sendText({ to: admin.phone, text: limit.warning });
    }

    await sendText({
      to: admin.phone,
      text: `Payout of ${formatBalance(amount)} to *${target.name}* was sent ✅ and their wallet debited.`,
    });
  } catch (err: any) {
    // Crash safety — any throw after the debit must be handled WITHOUT
    // double-paying. Once money has been sent (paid), never auto-refund:
    // flag for manual reconciliation instead.
    if (paid) {
      await prisma.withdrawalRequest
        .updateMany({
          where: { id: claimed.request.id },
          data: { status: "investigating" },
        })
        .catch(() => {});
      await auditSuperadminCommand({
        cooperativeId: coop.id,
        actorPhone: admin.phone,
        actorId: admin.id,
        command: "payout.ambiguous",
        target: target.name,
        detail: `${formatBalance(amount)} — sent but later bookkeeping threw. Reconcile with the payment provider.`,
        isHighRisk: true,
      }).catch(() => {});
      console.error(`[payout] post-payout error for paid payout: ${claimed.request.id}`, err);
      await sendText({
        to: admin.phone,
        text: `⚠️ The payout was sent but in-app bookkeeping failed. It was flagged for manual reconciliation.`,
      });
      return;
    }
    await prisma.withdrawalRequest
      .updateMany({
        where: { id: claimed.request.id },
        data: { status: "investigating" },
      })
      .catch(() => {});
    console.error(`[payout] threw (unconfirmed outcome): ${claimed.request.id}`, err);
    await sendText({
      to: admin.phone,
      text: `⚠️ Payout hit an unexpected error with an *unconfirmed* outcome and was flagged for reconciliation (${String(err?.message ?? err).slice(0, 120)}). Do NOT retry or refund until the provider is checked.`,
    });
  }
}

/**
 * Handle loan, withdrawal, and payout commands.
 * Returns true if the command was recognized and handled.
 */
export async function handleLoanAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
  ctx: AdminContext,
): Promise<boolean> {
  const { admin, unitAdmin, isSuper } = ctx;
  const coopId = admin.cooperativeId;

  switch (cmd) {
    case "pending": {
      const loans = await listPendingLoans(coopId, 20, unitAdmin?.unit?.id);
      await sendPendingLoans(phone, loans, unitAdmin !== null);
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
      const result = await approveLoan(id, {
        superAdmin: isSuper,
        isAdmin: true,
        actorId: admin.id,
        cooperativeId: coopId,
      });
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: isSuper ? "loan.final_approve" : "loan.admin_approve",
        targetType: "loan",
        detail: result.message,
      });
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
      const result = await rejectLoan(id, {
        actorId: admin.id,
        cooperativeId: coopId,
        reason: "Admin rejection via chat",
        stage: "officer",
      });
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "loan.reject",
        targetType: "loan",
        detail: result.message,
      });
      return true;
    }

    case "payout": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can make payouts." });
        return true;
      }
      const amount = toKobo(Number(args[0]));
      const targetPhone = args[1]?.startsWith("tg:")
        ? "tg:" + args[1].replace(/[^0-9]/g, "")
        : args[1]?.replace(/[^0-9]/g, "");
      const narration = args.slice(2).join(" ").trim();
      if (!Number.isFinite(amount) || amount <= 0 || !targetPhone || narration.length < 3) {
        await sendText({
          to: phone,
          text: "Usage: *payout <amount> <member phone> <narration>* — e.g. *payout 5000 2348012345678 October savings refund*. A narration is required on every payment.",
        });
        return true;
      }
      const pinCheck = await assertFreshPin(phone, amount);
      if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
      await handlePayout(ctx, amount, targetPhone, narration);
      return true;
    }

    case "approvemultisig":
    case "rejectmultisig": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the super admin can approve multi-sig requests.",
        });
        return true;
      }
      const pendingIdSuffix = args[0];
      if (!pendingIdSuffix) {
        await sendText({
          to: phone,
          text: "Usage: *approvemultisig <request id suffix>* or *rejectmultisig <request id suffix>*",
        });
        return true;
      }
      const action = cmd === "approvemultisig" ? "approve" : "reject";
      const result = await processMultiSigResponse({
        cooperativeId: coopId,
        pendingIdSuffix,
        responderPhone: phone,
        action,
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "approvewithdraw":
    case "approvewdraw": {
      if (unitAdmin) {
        await sendText({
          to: phone,
          text: "Only the cooperative admin can approve withdrawals.",
        });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *approvewithdraw <request id>*" });
        return true;
      }
      const result = await approveWithdrawal(id, {
        id: admin.id,
        role: admin.role,
        phone,
        cooperativeId: coopId,
      });
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: isSuper ? "withdraw.final_approve" : "withdraw.admin_approve",
        targetType: "withdrawal",
        targetId: id,
        detail: result.message,
      });
      return true;
    }

    case "finalize": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can give the final approval.",
        });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({
          to: phone,
          text: "Usage: *finalize <request id>* — add *override* to release a withdrawal held for AML review.",
        });
        return true;
      }
      const override = args[1]?.toLowerCase() === "override";
      const req = await prisma.withdrawalRequest.findFirst({
        where: {
          cooperativeId: coopId,
          ...(id.length >= 8 ? { OR: [{ id }, { id: { endsWith: id } }] } : { id }),
        },
      });
      if (req) {
        const pinCheck = await assertFreshPin(phone, req.amount);
        if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
      }
      const result = await finalizeWithdrawal(
        id,
        {
          id: admin.id,
          role: admin.role,
          phone,
          cooperativeId: coopId,
        },
        { overrideAml: override },
      );
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "withdraw.finalize",
        targetType: "withdrawal",
        targetId: id,
        detail: override ? `[AML override] ${result.message}` : result.message,
      });
      return true;
    }

    case "assistwithdraw": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can initate assisted withdrawals.",
        });
        return true;
      }
      const targetCode = args[0];
      const amt = Number(args[1]);
      if (!targetCode || !Number.isFinite(amt) || amt <= 0) {
        await sendText({
          to: phone,
          text: "Usage: *assistwithdraw <member code> <amount>* — sends a one-time code to the member for authorisation.",
        });
        return true;
      }
      const result = await startAssistWithdrawal(phone, targetCode, amt);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "confirmassist": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can confirm an assisted withdrawal.",
        });
        return true;
      }
      const assistId = args[0];
      const memberCode = args[1];
      if (!assistId || !memberCode) {
        await sendText({
          to: phone,
          text: "Usage: *confirmassist <assist id> <member code>* — the code the member received.",
        });
        return true;
      }
      const assist = await prisma.adminAssistAction.findFirst({
        where: { cooperativeId: coopId, status: "pending", id: { endsWith: assistId } },
      });
      if (assist) {
        const pinCheck = await assertFreshPin(phone, assist.amount);
        if (!pinCheck.ok) return guardFailed(phone, pinCheck.message);
      }
      const result = await confirmAssistWithdrawal(phone, assistId, memberCode);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "assist.withdrawal.confirm",
        targetType: "assist",
        targetId: result.assistId,
        detail: result.message,
      });
      return true;
    }

    case "rejectwithdraw": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can reject withdrawals." });
        return true;
      }
      const id = args[0];
      if (!id) {
        await sendText({ to: phone, text: "Usage: *rejectwithdraw <request id>*" });
        return true;
      }
      const result = await rejectWithdrawal(id, coopId);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "withdraw.reject",
        targetType: "withdrawal",
        targetId: id,
        detail: result.message,
      });
      return true;
    }

    case "overridewithdrawal": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can grant overrides." });
        return true;
      }
      const targetPhone = args[0]?.replace(/[^0-9]/g, "");
      if (!targetPhone) {
        await sendText({
          to: phone,
          text: "Usage: *overridewithdrawal <member phone>* — lets them withdraw before 6 months.",
        });
        return true;
      }
      const result = await overrideWithdrawalRule(phone, targetPhone);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "withdraw.override",
        targetType: "member",
        detail: result.message,
      });
      return true;
    }

    case "pendingwithdraw": {
      const requests = await prisma.withdrawalRequest.findMany({
        where: { cooperativeId: coopId, status: { in: ["pending", "admin_approved"] } },
        include: { member: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      if (requests.length === 0) {
        await sendText({ to: phone, text: "No withdrawal requests waiting. ✅" });
        return true;
      }
      const body = requests
        .map(
          (r) =>
            `• *${r.id.slice(-6)}* — ${r.member.name} — ${formatBalance(r.amount)}\n` +
            `   ${
              r.status === "pending"
                ? `Admin approves: *approvewdraw ${r.id.slice(-6)}*`
                : r.status === "aml_review"
                  ? `🛑 AML review: *finalize ${r.id.slice(-6)} override* to release`
                  : `Awaiting super admin: *finalize ${r.id.slice(-6)}*`
            }`,
        )
        .join("\n");
      await sendText({ to: phone, text: `*Withdrawal requests*\n\n${body}` });
      return true;
    }

    default:
      return false;
  }
}
