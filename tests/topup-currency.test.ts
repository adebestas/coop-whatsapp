import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
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
  });
});
