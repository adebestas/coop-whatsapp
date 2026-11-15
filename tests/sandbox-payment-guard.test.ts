import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { runInSandbox, sandboxBlocksProvider } from "../src/lib/sandbox.js";
import { sendToBank } from "../src/services/disbursements.js";
import { approveExternalPayment } from "../src/services/payanyone.js";
import { createTestCoop, createTestMember } from "./setup.js";

describe("sandbox payment backstop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks only live providers, and only during a sandbox turn", async () => {
    expect(sandboxBlocksProvider("monnify")).toBe(false);
    expect(sandboxBlocksProvider("sandbox")).toBe(false);

    await runInSandbox("coop-x", async () => {
      expect(sandboxBlocksProvider("monnify")).toBe(true);
      expect(sandboxBlocksProvider(undefined)).toBe(true);
      expect(sandboxBlocksProvider("sandbox")).toBe(false);
    });
  });

  it("routes a sandbox payout through the sandbox adapter", async () => {
    const coop = await createTestCoop();
    await prisma.cooperative.update({ where: { id: coop.id }, data: { isSandbox: true } });
    const member = await createTestMember(coop.id, { name: "Sandbox Member" });

    const { result } = await runInSandbox(coop.id, () =>
      sendToBank({
        memberId: member.id,
        amount: 100_000,
        bankAccountNumber: "0123456789",
        bankCode: "058",
        note: "Sandbox payout (test)",
        skipNameCheck: true,
      }),
    );

    expect(result.ok).toBe(true);
    const payout = await prisma.payout.findFirst({ where: { memberId: member.id } });
    expect(payout?.provider).toBe("sandbox");
  });

  it("refuses and reverts a pay-anyone transfer if a live provider is reached", async () => {
    const coop = await createTestCoop();
    await prisma.cooperative.update({ where: { id: coop.id }, data: { isSandbox: true } });
    const initiator = await createTestMember(coop.id, { role: "admin" });
    const superAdmin = await createTestMember(coop.id, { role: "superadmin" });
    const payment = await prisma.externalPayment.create({
      data: {
        cooperativeId: coop.id,
        beneficiaryName: "Vendor Ltd",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
        amount: 50_000,
        status: "approved2",
        initiatedById: initiator.id,
        approved1ById: initiator.id,
        approved2ById: initiator.id,
        approved3ById: superAdmin.id,
        lastApprovedAt: new Date(),
      },
    });

    // Simulate a regression where a sandbox turn resolves a real adapter:
    // resolveProvider shares one sandbox adapter instance, so relabelling it is
    // enough to drive the production guard without touching the provider code.
    const payments = await vi.importActual<typeof import("../src/services/payments/index.js")>(
      "../src/services/payments/index.js",
    );
    const { result: live } = await runInSandbox(coop.id, async () => payments.resolveProvider());
    const originalName = live.name;
    const payout = vi.spyOn(live, "payout");
    live.name = "monnify";
    try {
      const { result } = await runInSandbox(coop.id, () =>
        approveExternalPayment(
          {
            id: superAdmin.id,
            name: superAdmin.name,
            phone: superAdmin.phone,
            role: "superadmin",
            cooperativeId: coop.id,
          },
          payment.id,
        ),
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/refusing to call a live payment provider/i);
      expect(payout).not.toHaveBeenCalled();
    } finally {
      live.name = originalName;
    }

    const after = await prisma.externalPayment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe("approved2");
    expect(after?.approved3ById).toBeNull();
  });
});
