import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import {
  requestManualCredit,
  approveManualCredit,
  rejectManualCredit,
} from "../src/services/manualcredit.js";
import { flagTransaction, LARGE_TX_THRESHOLD } from "../src/services/aml.js";
import { checkDailyPayoutLimit } from "../src/services/fraud.js";
import { bulkImportMembers } from "../src/services/bulk-import.js";
import { handleMessage } from "../src/services/conversation.js";
import { runReconciliation } from "../src/services/reconcile.js";

const SUPER1 = "2348091111111";
const SUPER2 = "2348092222222";
const MEMBER = "2348015555555";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "Fix Coop", code } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; balance?: number } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin("1234"),
      wallet: { create: { balance: opts.balance ?? 0 } },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterEach(() => {
  delete process.env.PILOT_FLOAT_CAP;
});

describe("manual credit maker-checker", () => {
  it("rejects a non-super maker and a non-super checker", async () => {
    const coop = await makeCoop("MC01");
    const member = await makeMember(MEMBER, coop.id);
    const admin = await makeMember(SUPER1, coop.id, { role: "admin" }); // NOT superadmin

    const req = await requestManualCredit(admin.phone, member.code, 5000, "Refund");
    expect(req.ok).toBe(false);
    expect(req.message).toContain("super admin");

    // Even a valid pending credit can't be approved by a non-super.
    const superA = await makeMember(SUPER2, coop.id, { role: "superadmin" });
    const created = await requestManualCredit(superA.phone, member.code, 5000, "Refund");
    expect(created.ok).toBe(true);

    const approve = await approveManualCredit(admin.phone, created.creditId!.slice(-6), "1234");
    expect(approve.ok).toBe(false);
    expect(approve.message).toContain("super admin");
  });

  it("rejects an incorrect checker PIN and leaves the wallet untouched", async () => {
    const coop = await makeCoop("MC02");
    const member = await makeMember(MEMBER, coop.id);
    const maker = await makeMember(SUPER1, coop.id, { role: "superadmin" });
    const checker = await makeMember(SUPER2, coop.id, { role: "superadmin" });

    const created = await requestManualCredit(maker.phone, member.code, 5000, "Refund");
    expect(created.ok).toBe(true);

    const approved = await approveManualCredit(checker.phone, created.creditId!.slice(-6), "9999");
    expect(approved.ok).toBe(false);
    expect(approved.message).toContain("Incorrect PIN");

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(0);
    const credit = await prisma.manualCredit.findUnique({ where: { id: created.creditId } });
    expect(credit!.status).toBe("pending");
  });

  it("approves once with the correct PIN and cannot be self-approved or double-approved", async () => {
    const coop = await makeCoop("MC03");
    const member = await makeMember(MEMBER, coop.id, { balance: 0 });
    const maker = await makeMember(SUPER1, coop.id, { role: "superadmin" });
    const checker = await makeMember(SUPER2, coop.id, { role: "superadmin" });

    const created = await requestManualCredit(maker.phone, member.code, 5000, "Refund");
    expect(created.ok).toBe(true);
    const shortId = created.creditId!.slice(-6);

    // Maker can't approve their own request.
    const self = await approveManualCredit(maker.phone, shortId, "1234");
    expect(self.ok).toBe(false);
    expect(self.message).toContain("initiated yourself");

    // Checker with correct PIN approves.
    const ok = await approveManualCredit(checker.phone, shortId, "1234");
    expect(ok.ok).toBe(true);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(500000); // 5000 naira = 500000 kobo

    // A second approval is refused — no double credit.
    const again = await approveManualCredit(checker.phone, shortId, "1234");
    expect(again.ok).toBe(false);
    expect(again.message).toContain("already");

    const after = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(after!.balance).toBe(500000);

    // Reject after approval is also refused.
    const rej = await rejectManualCredit(checker.phone, shortId);
    expect(rej.ok).toBe(false);
    expect(rej.message).toContain("already");
  });
});

describe("AML large-transaction threshold", () => {
  it("flags a transaction at exactly the ₦5,000,000 threshold (>= not >)", async () => {
    const coop = await makeCoop("AML01");
    const member = await makeMember(MEMBER, coop.id);

    const res = await flagTransaction({
      memberId: member.id,
      cooperativeId: coop.id,
      amount: LARGE_TX_THRESHOLD, // exactly ₦5,000,000
      type: "withdrawal",
      direction: "out",
    });
    expect(res.flagged).toBe(true);
    expect(res.reasons.join(" ")).toContain("Large transaction");
  });
});

describe("pilot float cap covers all money-out", () => {
  it("counts paid withdrawals toward the monthly PILOT_FLOAT_CAP", async () => {
    process.env.PILOT_FLOAT_CAP = "100000"; // ₦1,000
    const coop = await makeCoop("FRAUD01");
    const member = await makeMember(MEMBER, coop.id);

    // A paid withdrawal this month (₦800) — before the fix, only payouts counted.
    await prisma.withdrawalRequest.create({
      data: {
        amount: 80000,
        status: "paid",
        finalizedAt: new Date(),
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    // ₦300 more would push month total to ₦1,100 > the ₦1,000 cap.
    const res = await checkDailyPayoutLimit(coop.id, 30000);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Pilot safety cap");
  });
});

describe("bulk import member codes", () => {
  it("assigns unique, sequential codes via an atomic sequence", async () => {
    const coop = await makeCoop("IMP01");
    const csv = Buffer.from(
      "Name,Phone\nAlice,2348010000001\nBob,2348010000002\nCarol,2348010000003",
    );
    const res = await bulkImportMembers(coop.id, csv, "members.csv");
    expect(res.ok).toBe(true);
    expect(res.imported).toBe(3);

    const coop2 = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(coop2!.memberSeq).toBe(3);

    const members = await prisma.member.findMany({
      where: { cooperativeId: coop.id },
      orderBy: { code: "asc" },
    });
    expect(members.map((m) => m.code)).toEqual([
      `${coop.code}/001`,
      `${coop.code}/002`,
      `${coop.code}/003`,
    ]);
  });
});

describe("interest disclosure", () => {
  it("shows the correct declining-balance APR tiers (6/8/9/10), not stale 20/16/12", async () => {
    await handleMessage(MEMBER, "interest");
    const text = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(text).toContain("6% APR");
    expect(text).toContain("10% APR");
    expect(text).not.toContain("20% APR");
    expect(text).not.toContain("16% APR");
  });
});

describe("reconciliation tenant isolation", () => {
  it("only alerts the cooperative that owns the anomaly, not every cooperative", async () => {
    const coopA = await makeCoop("RECA");
    const superA = await makeMember(SUPER1, coopA.id, { role: "superadmin" });
    await makeMember(MEMBER, coopA.id, { balance: -100 }); // negative wallet

    const coopB = await makeCoop("RECB");
    const superB = await makeMember(SUPER2, coopB.id, { role: "superadmin" });
    await makeMember("2348016666666", coopB.id, { balance: 0 }); // healthy

    await runReconciliation();

    const alerted = vi
      .mocked(notifyMember)
      .mock.calls.filter((c) => String(c[1]).includes("NEGATIVE"))
      .map((c) => String((c[0] as any).phone ?? c[0]));

    expect(alerted).toContain(superA.phone);
    expect(alerted).not.toContain(superB.phone);
  });
});
