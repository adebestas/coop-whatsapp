/**
 * OPS-3: AML report labelling + amount.
 * - Threshold crossings (single or 24h aggregate) are CTRs, not STRs.
 * - Suspicious patterns are STRs.
 * - The CBN payload/record must carry the TRUE reported amount (the aggregate
 *   total), not the triggering single-transaction amount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import {
  autoFileReport,
  classifyReport,
  flagTransaction,
  REPORTING_THRESHOLD,
} from "../src/services/aml.js";

const MEMBER = "2348017770001";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "AML Coop", code } });
}

async function makeMember(phone: string, coopId: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: "member",
      pin: hashPin("1234"),
      wallet: { create: { balance: 0 } },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterEach(() => {
  delete process.env.CBN_STR_WEBHOOK;
  vi.unstubAllGlobals();
});

describe("AML report labelling (STR vs CTR)", () => {
  it("labels a threshold-only transaction as a CTR with CTR wording", async () => {
    const coop = await makeCoop("AMLCTR");
    const member = await makeMember(MEMBER, coop.id);

    const res = await flagTransaction({
      memberId: member.id,
      cooperativeId: coop.id,
      amount: REPORTING_THRESHOLD,
      type: "withdrawal",
      direction: "out",
    });

    expect(res.reportType).toBe("CTR");
    expect(res.reasons.join(" ")).toContain("CTR threshold");
    expect(res.reasons.join(" ")).not.toContain("STR threshold");

    const records = await prisma.sTR.findMany({ where: { memberId: member.id } });
    expect(records).toHaveLength(1);
    expect(records[0].reportType).toBe("CTR");
    expect(records[0].amount).toBe(REPORTING_THRESHOLD);
  });

  it("labels a suspicious pattern as an STR", async () => {
    const coop = await makeCoop("AMLSTR");
    const member = await makeMember(MEMBER, coop.id);

    // 3 paid money-out transactions within 10 min, small + non-round so only the
    // rapid-sequence rule fires (not round-number, structuring or the threshold).
    for (const amount of [30000, 45000, 60000]) {
      await prisma.withdrawalRequest.create({
        data: {
          amount,
          status: "paid",
          finalizedAt: new Date(),
          bankAccountNumber: "0123456789",
          bankCode: "058",
          memberId: member.id,
          cooperativeId: coop.id,
        },
      });
    }

    const res = await flagTransaction({
      memberId: member.id,
      cooperativeId: coop.id,
      amount: 10000,
      type: "withdrawal",
      direction: "out",
    });

    expect(res.reportType).toBe("STR");
    expect(res.reasons.join(" ")).toContain("Rapid sequence");

    const records = await prisma.sTR.findMany({ where: { memberId: member.id } });
    expect(records).toHaveLength(1);
    expect(records[0].reportType).toBe("STR");
  });
});

describe("CBN payload reports the true amount", () => {
  it("sends and stores the aggregate reported amount, not the single-tx amount", async () => {
    process.env.CBN_STR_WEBHOOK = "https://cbn.test/str";
    const captured: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        captured.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => "ok" } as any;
      }),
    );

    const coop = await makeCoop("AMLCBN");
    const member = await makeMember(MEMBER, coop.id);

    const aggregateTotal = 9_000_000_00; // ₦9,000,000 (24h aggregate)
    const singleTx = 100_000; // ₦1,000 (the tx that tipped the aggregate over)

    const result = await autoFileReport(
      {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: singleTx,
        type: "payout",
        direction: "out",
      },
      "Aggregate outflow meets CTR threshold",
      aggregateTotal,
      "CTR",
    );

    expect(result.filed).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].reportType).toBe("CTR");
    expect(captured[0].amount).toBe(aggregateTotal);
    expect(captured[0].amount).not.toBe(singleTx);

    const record = await prisma.sTR.findUniqueOrThrow({ where: { id: result.strId! } });
    expect(record.reportType).toBe("CTR");
    expect(record.amount).toBe(aggregateTotal);
  });
});

describe("AML report classification", () => {
  it("classifies ≥₦5m cash (individual) as CTR, not STR", () => {
    expect(
      classifyReport({
        amountKobo: 500_000_000,
        isCash: true,
        isCrossBorder: false,
        isCorporate: false,
        suspicious: false,
      }),
    ).toBe("CTR");
  });
  it("classifies a suspicious sub-threshold txn as STR (no threshold)", () => {
    expect(
      classifyReport({
        amountKobo: 1_000_00,
        isCash: false,
        isCrossBorder: false,
        isCorporate: false,
        suspicious: true,
      }),
    ).toBe("STR");
  });
  it("classifies ≥₦10m cash (corporate) as CTR", () => {
    expect(
      classifyReport({
        amountKobo: 1_000_000_000,
        isCash: true,
        isCrossBorder: false,
        isCorporate: true,
        suspicious: false,
      }),
    ).toBe("CTR");
  });
  it("classifies $10k cross-border as CTR", () => {
    expect(
      classifyReport({
        amountKobo: 0,
        isCash: false,
        isCrossBorder: true,
        isCorporate: false,
        suspicious: false,
      }),
    ).toBe("CTR");
  });
  it("returns null when nothing triggers", () => {
    expect(
      classifyReport({
        amountKobo: 1_000_00,
        isCash: true,
        isCrossBorder: false,
        isCorporate: false,
        suspicious: false,
      }),
    ).toBeNull();
  });
  it("below the corporate threshold is null for cash corporate", () => {
    expect(
      classifyReport({
        amountKobo: 500_000_000,
        isCash: true,
        isCrossBorder: false,
        isCorporate: true,
        suspicious: false,
      }),
    ).toBeNull();
  });
});
