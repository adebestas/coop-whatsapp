/**
 * OPS-4: AML detection must BLOCK (hold) a suspicious withdrawal before money
 * leaves the bank — not merely flag it after payout. Large-but-clean threshold
 * crossings (CTR) are reported but do not block.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { paymentState } from "./payment-state.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { finalizeWithdrawal } from "../src/services/withdrawals.js";
import { REPORTING_THRESHOLD } from "../src/services/aml.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `AML Block Coop ${code}`, code } });
}

async function makeMember(coopId: string, opts: { role?: string; balance?: number } = {}) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  const balance = opts.balance ?? 0;
  return prisma.member.create({
    data: {
      code,
      phone: `2348${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      name: `Block Member ${code}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      status: "active",
      pin: hashPin("1234"),
      bankAccountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
      wallet: { create: { balance, totalSaved: balance } },
    },
  });
}

async function makeWithdrawal(
  coopId: string,
  memberId: string,
  amount: number,
  status = "admin_approved",
) {
  return prisma.withdrawalRequest.create({
    data: {
      cooperativeId: coopId,
      memberId,
      amount,
      status,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
    },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  paymentState.resolveFails = false;
  paymentState.payoutFails = false;
});

describe("AML blocking of suspicious withdrawals", () => {
  it("holds a suspicious-pattern withdrawal for review and moves no money", async () => {
    const coop = await makeCoop("AMLB1");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { balance: 100_000 });
    paymentState.resolveName = member.name;

    // 3 paid, small, non-round money-out txns → rapid-sequence (STR) pattern.
    for (const amount of [30_000, 45_000, 60_000]) {
      await makeWithdrawal(coop.id, member.id, amount, "paid");
    }
    const req = await makeWithdrawal(coop.id, member.id, 40_000);
    const actor = { id: admin.id, role: "superadmin", phone: admin.phone, cooperativeId: coop.id };

    const result = await finalizeWithdrawal(req.id, actor);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/AML review/i);

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe("aml_review");

    // No money moved and the bank rail was never hit.
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: member.id } });
    expect(wallet.balance).toBe(100_000);
    expect(await prisma.payout.count()).toBe(0);

    // A suspicious activity report was auto-filed.
    const strs = await prisma.sTR.findMany({ where: { memberId: member.id } });
    expect(strs).toHaveLength(1);
    expect(strs[0].reportType).toBe("STR");
  });

  it("releases a held withdrawal only with an explicit override", async () => {
    const coop = await makeCoop("AMLB2");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { balance: 100_000 });
    paymentState.resolveName = member.name;
    for (const amount of [30_000, 45_000, 60_000]) {
      await makeWithdrawal(coop.id, member.id, amount, "paid");
    }
    const req = await makeWithdrawal(coop.id, member.id, 40_000);
    const actor = { id: admin.id, role: "superadmin", phone: admin.phone, cooperativeId: coop.id };

    await finalizeWithdrawal(req.id, actor); // held

    // A plain retry is refused; the request stays held.
    const refused = await finalizeWithdrawal(req.id, actor);
    expect(refused.ok).toBe(false);
    expect(
      (await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
    ).toBe("aml_review");

    // Override releases it and pays out.
    const released = await finalizeWithdrawal(req.id, actor, { overrideAml: true });
    expect(released.ok).toBe(true);
    const row = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe("paid");
    expect(await prisma.payout.count({ where: { idempotencyKey: `TFR-WDR-${req.id}` } })).toBe(1);
  });
});

describe("AML does not block clean large transactions (CTR)", () => {
  it("pays a threshold-only withdrawal and files a CTR", async () => {
    const coop = await makeCoop("AMLCTR-B");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { balance: REPORTING_THRESHOLD });
    paymentState.resolveName = member.name;

    const req = await makeWithdrawal(coop.id, member.id, REPORTING_THRESHOLD);
    const actor = { id: admin.id, role: "superadmin", phone: admin.phone, cooperativeId: coop.id };

    const result = await finalizeWithdrawal(req.id, actor);
    expect(result.ok).toBe(true);

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe("paid");

    const strs = await prisma.sTR.findMany({ where: { memberId: member.id } });
    expect(strs).toHaveLength(1);
    expect(strs[0].reportType).toBe("CTR");
    expect(strs[0].amount).toBe(REPORTING_THRESHOLD);
  });
});
