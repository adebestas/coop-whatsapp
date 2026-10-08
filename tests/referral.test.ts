import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { recordReferral, qualifyReferral } from "../src/services/referrals.js";

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("referrals", () => {
  it("records a pending referral for a valid referrer code", async () => {
    const coop = await createTestCoop("REF1");
    const referrer = await createTestMember(coop.id, { phone: "2348011110001" });
    const referred = await createTestMember(coop.id, { phone: "2348011110002" });

    const res = await recordReferral(coop.id, referrer.code, referred.id);
    expect(res.ok).toBe(true);

    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    expect(referral).toBeTruthy();
    expect(referral?.status).toBe("pending");
    expect(referral?.referrerId).toBe(referrer.id);
    expect(referral?.cooperativeId).toBe(coop.id);
    expect(referral?.code).toBe(referrer.code);
  });

  it("rejects a self-referral", async () => {
    const coop = await createTestCoop("REF2");
    const m = await createTestMember(coop.id, { phone: "2348011110011" });

    const res = await recordReferral(coop.id, m.code, m.id);
    expect(res.ok).toBe(false);
    expect(await prisma.referral.count()).toBe(0);
  });

  it("rejects an unknown referrer code", async () => {
    const coop = await createTestCoop("REF3");
    const referred = await createTestMember(coop.id, { phone: "2348011110021" });

    const res = await recordReferral(coop.id, "ZZZZZZ", referred.id);
    expect(res.ok).toBe(false);
    expect(await prisma.referral.count()).toBe(0);
  });

  it("qualifies on the first contribution and snapshots the reward from config", async () => {
    const coop = await createTestCoop("REF4");
    const referrer = await createTestMember(coop.id, { phone: "2348011110031" });
    const referred = await createTestMember(coop.id, { phone: "2348011110032" });
    await prisma.cooperativeConfig.upsert({
      where: { cooperativeId: coop.id },
      create: {
        cooperativeId: coop.id,
        referralEnabled: true,
        referralRewardType: "bank",
        referralRewardAmount: 12345,
      },
      update: {
        referralEnabled: true,
        referralRewardType: "bank",
        referralRewardAmount: 12345,
      },
    });

    expect((await recordReferral(coop.id, referrer.code, referred.id)).ok).toBe(true);

    const res = await qualifyReferral(coop.id, referred.id);
    expect(res.ok).toBe(true);

    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    expect(referral?.status).toBe("qualified");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
    expect(referral?.rewardType).toBe("bank");
    expect(referral?.rewardAmount).toBe(12345);
  });

  it("is idempotent — a second qualify is a no-op", async () => {
    const coop = await createTestCoop("REF5");
    const referrer = await createTestMember(coop.id, { phone: "2348011110041" });
    const referred = await createTestMember(coop.id, { phone: "2348011110042" });
    await recordReferral(coop.id, referrer.code, referred.id);
    await qualifyReferral(coop.id, referred.id);
    const first = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });

    const second = await qualifyReferral(coop.id, referred.id);
    expect(second.ok).toBe(true);

    const after = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    expect(after?.status).toBe("qualified");
    expect(after?.qualifiedAt?.getTime()).toBe(first?.qualifiedAt?.getTime());
  });
});
