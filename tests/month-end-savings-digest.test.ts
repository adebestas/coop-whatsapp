import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./setup.js";
import { notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { isMonthEndDigestTime, runMonthEndSavingsDigest } from "../src/services/scheduler.js";

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "Digest Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("DC"), adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { name?: string; balance?: number; optedOut?: boolean } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: opts.name ?? `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: "member",
      pin: hashPin("1234"),
      consentAt: new Date(),
      optedOut: opts.optedOut ?? false,
      wallet: { create: { balance: opts.balance ?? 500000, totalSaved: opts.balance ?? 500000 } },
    },
    include: { wallet: true },
  });
}

describe("Xara-style Month-End Savings Digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FORCE_SAVINGS_DIGEST;
    delete process.env.DIGEST_HOUR;
  });

  describe("isMonthEndDigestTime", () => {
    it("recognizes the final day of the month at 20:00 WAT", () => {
      // 31st October at 20:00 WAT (19:00 UTC)
      const lastDay = new Date(Date.UTC(2026, 9, 31, 19, 0, 0));
      expect(isMonthEndDigestTime(lastDay)).toBe(true);
    });

    it("recognizes the final Friday of the month before weekend spending", () => {
      // 30th October 2026 is a Friday (day 5), date >= 24
      const finalFriday = new Date(Date.UTC(2026, 9, 30, 19, 0, 0));
      expect(isMonthEndDigestTime(finalFriday)).toBe(true);
    });

    it("rejects mid-month dates", () => {
      // 15th October at 20:00 WAT
      const midMonth = new Date(Date.UTC(2026, 9, 15, 19, 0, 0));
      expect(isMonthEndDigestTime(midMonth)).toBe(false);
    });

    it("rejects non-target hours even on month-end", () => {
      // 31st October at 10:00 AM WAT (9:00 UTC)
      const morning = new Date(Date.UTC(2026, 9, 31, 9, 0, 0));
      expect(isMonthEndDigestTime(morning)).toBe(false);
    });

    it("forces digest execution when FORCE_SAVINGS_DIGEST=1", () => {
      process.env.FORCE_SAVINGS_DIGEST = "1";
      const randomTime = new Date(Date.UTC(2026, 5, 12, 11, 23, 0));
      expect(isMonthEndDigestTime(randomTime)).toBe(true);
    });
  });

  describe("runMonthEndSavingsDigest", () => {
    it("sends proactive savings digest with monthly progress and smart tips", async () => {
      process.env.FORCE_SAVINGS_DIGEST = "1";
      const coop = await makeCoop("Ibadan Thrift Society");
      const memberA = await makeMember("2348080009901", coop.id, {
        name: "Taiwo Adeleke",
        balance: 1500000,
      });
      const memberB = await makeMember("2348080009902", coop.id, {
        name: "Kehinde Adeleke",
        balance: 800000,
      });
      // Opted out member should be excluded
      await makeMember("2348080009903", coop.id, { name: "Opted Out", optedOut: true });

      // Add a confirmed contribution for Taiwo this month
      await prisma.contribution.create({
        data: {
          memberId: memberA.id,
          cooperativeId: coop.id,
          amount: 250000, // ₦2,500
          type: "topup",
          status: "confirmed",
          reference: `REF-DIGEST-${Date.now()}`,
          paidAt: new Date(),
        },
      });

      const now = new Date(Date.UTC(2026, 9, 31, 19, 0, 0));
      const count = await runMonthEndSavingsDigest(now);
      expect(count).toBe(2); // memberA and memberB, excluding opted-out

      const calls = vi.mocked(notifyMember).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const taiwoCall = calls.find((c) => c[0].phone === memberA.phone);
      expect(taiwoCall).toBeTruthy();
      expect(taiwoCall![1]).toContain("Month-End Savings Digest");
      expect(taiwoCall![1]).toContain("Ibadan Thrift Society");
      expect(taiwoCall![1]).toContain("Taiwo Adeleke");
      expect(taiwoCall![1]).toContain("Total Savings Balance:");
      expect(taiwoCall![1]).toContain("Saved This Month:");
      expect(taiwoCall![1]).toContain("Smart Money Habit");
    });

    it("does not send duplicate digests in the same calendar month", async () => {
      process.env.FORCE_SAVINGS_DIGEST = "1";
      const coop = await makeCoop("Kano Farmers Coop");
      await makeMember("2348080009904", coop.id);

      const now = new Date(Date.UTC(2026, 9, 31, 19, 0, 0));
      const firstRun = await runMonthEndSavingsDigest(now);
      expect(firstRun).toBeGreaterThanOrEqual(1);

      // Second run in the same month returns 0
      const secondRun = await runMonthEndSavingsDigest(now);
      expect(secondRun).toBe(0);
    });
  });
});
