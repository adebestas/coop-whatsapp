import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { runInSandbox, sandboxBlocksProvider } from "../src/lib/sandbox.js";
import { sendToBank } from "../src/services/disbursements.js";
import { createTestCoop, createTestMember } from "./setup.js";

describe("sandbox payment backstop", () => {
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
});
