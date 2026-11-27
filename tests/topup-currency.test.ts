import { describe, it, expect, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";

describe("topup currency", () => {
  it("credits a GHS cooperative for a GHS notification", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "GHS Coop", code: `GH${Date.now()}`, currency: "GHS" },
    });
    const member = await prisma.member.create({
      data: {
        code: `M${Date.now()}`,
        phone: `+233${Date.now()}`,
        name: "Ama",
        cooperativeId: coop.id,
        virtualAccountNumber: `VA${Date.now()}`,
        wallet: { create: { balance: 0 } },
      },
    });
    await handlePaymentNotification({
      transactionId: `tx${Date.now()}`,
      accountNumber: member.virtualAccountNumber!,
      amount: 10000,
      currency: "GHS",
      status: "successful",
      provider: "paystack",
      raw: {},
    });
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(10000);

    const alerts = [
      ...vi.mocked(notifyMember).mock.calls.map((c) => c[1] as string),
      ...vi.mocked(sendText).mock.calls.map((c) => (c[0] as { text: string }).text),
    ];
    const creditAlert = alerts.find((t) => t.includes("Wallet credited"));
    expect(creditAlert).toBeDefined();
    expect(creditAlert).toContain("New balance");
    expect(creditAlert).toContain("Total saved");
  });

  it("credits once under duplicate/concurrent webhook replay and rejects currency mismatch or failed status", async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const coop = await prisma.cooperative.create({
      data: { name: "Replay Coop", code: `RP${suffix}`, currency: "NGN" },
    });
    const member = await prisma.member.create({
      data: {
        code: `MR${suffix}`,
        phone: `+234809${suffix.slice(-7)}`,
        name: "Tunde",
        cooperativeId: coop.id,
        virtualAccountNumber: `VAR${suffix}`,
        wallet: { create: { balance: 0 } },
      },
    });

    const payload = {
      transactionId: `tx-replay-${suffix}`,
      accountNumber: member.virtualAccountNumber!,
      amount: 250000,
      currency: "NGN",
      status: "successful" as const,
      provider: "monnify" as const,
      raw: {},
    };

    // Concurrent + sequential replay of the exact same provider transaction.
    await Promise.all([handlePaymentNotification(payload), handlePaymentNotification(payload)]);
    await handlePaymentNotification(payload);

    // Wrong currency, non-successful status, and non-positive amount must all no-op.
    await handlePaymentNotification({ ...payload, transactionId: `tx-usd-${suffix}`, currency: "USD" });
    await handlePaymentNotification({ ...payload, transactionId: `tx-fail-${suffix}`, status: "failed" });
    await handlePaymentNotification({ ...payload, transactionId: `tx-zero-${suffix}`, amount: 0 });

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(250000);
    expect(wallet?.totalSaved).toBe(250000);
    expect(
      await prisma.contribution.count({
        where: { cooperativeId: coop.id, memberId: member.id, type: "topup" },
      }),
    ).toBe(1);
  });
});
