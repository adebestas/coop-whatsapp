import { beforeEach, describe, expect, it } from "vitest";
import { cleanupDatabase, prisma } from "./setup.js";
import { checkDailyPayoutLimit } from "../src/services/fraud.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

let seq = 0;

async function makeCoop(limitKobo = 100_000_000) {
  seq++;
  return prisma.cooperative.create({
    data: {
      name: `Payout Limit Test Coop ${seq}`,
      code: `TC_${Date.now()}_${seq}`,
      dailyPayoutLimit: limitKobo,
    },
  });
}

async function makeMember(coopId: string) {
  seq++;
  const code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone: `23480${String(seq).padStart(8, "0")}`,
      name: `Test Member ${seq}`,
      cooperativeId: coopId,
      status: "active",
      pin: hashPin("1234"),
    },
  });
}

describe("checkDailyPayoutLimit — fraud control and single-count aggregation", () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("allows payout when well below the daily limit", async () => {
    const coop = await makeCoop(100_000_000); // ₦1,000,000 ceiling
    const result = await checkDailyPayoutLimit(coop.id, 20_000_000); // ₦200,000
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("warns when approaching the 80% threshold", async () => {
    const coop = await makeCoop(100_000_000);
    const member = await makeMember(coop.id);

    // Pre-record a payout of ₦700,000 (70M kobo)
    await prisma.payout.create({
      data: {
        amount: 70_000_000,
        reference: "TX-PAY-1",
        idempotencyKey: "TX-PAY-1",
        status: "successful",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    // Attempt ₦150,000 (15M kobo) -> total 85M kobo = 85%
    const result = await checkDailyPayoutLimit(coop.id, 15_000_000);
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("85%");
  });

  it("blocks payout that breaches the daily ceiling", async () => {
    const coop = await makeCoop(100_000_000); // ₦1,000,000 ceiling
    const member = await makeMember(coop.id);

    // Record an existing payout of ₦900,000
    await prisma.payout.create({
      data: {
        amount: 90_000_000,
        reference: "TX-PAY-EXISTING",
        idempotencyKey: "TX-PAY-EXISTING",
        status: "successful",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    // Attempting another ₦150,000 should exceed ₦1,000,000 ceiling
    const result = await checkDailyPayoutLimit(coop.id, 15_000_000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Daily payout ceiling reached");
  });

  it("does not double-count payouts against withdrawals or external payments", async () => {
    const coop = await makeCoop(100_000_000); // ₦1,000,000 ceiling
    const member = await makeMember(coop.id);

    // Simulate a successful bank withdrawal:
    // It creates a Payout record AND a paid WithdrawalRequest record
    await prisma.payout.create({
      data: {
        amount: 40_000_000, // ₦400,000
        reference: "TFR-WDR-12345",
        idempotencyKey: "TFR-WDR-12345",
        status: "successful",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    await prisma.withdrawalRequest.create({
      data: {
        id: "12345",
        amount: 40_000_000,
        status: "paid",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: member.id,
        cooperativeId: coop.id,
        finalizedAt: new Date(),
      },
    });

    // If double counted, spentToday would be ₦400,000 + ₦400,000 = ₦800,000.
    // Attempting a ₦300,000 payout would then total ₦1,100,000 and be blocked!
    // With single-counting, spentToday is only ₦400,000, so ₦400k + ₦300k = ₦700k <= ₦1,000,000.
    const result = await checkDailyPayoutLimit(coop.id, 30_000_000); // ₦300,000
    expect(result.ok).toBe(true);
  });
});
