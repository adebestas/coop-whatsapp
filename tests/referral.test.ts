import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import {
  recordReferral,
  qualifyReferral,
  myReferrals,
  setReferralConfig,
  referralReport,
  getReferralBonus,
  withdrawReferralBonus,
  listReferralWithdrawals,
} from "../src/services/referrals.js";
import { paymentState } from "./payment-state.js";
import { clearVtuBillerCache } from "../src/services/payments/vtu.js";
import { handleAwaitingInput } from "../src/services/handlers/session.js";
import { handleJoinStart } from "../src/services/handlers/join.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";
import { requestManualCredit, approveManualCredit } from "../src/services/manualcredit.js";
import { enqueueAfterCommit, withDeferredSends } from "../src/lib/deferred.js";
import type { BotState } from "../src/services/conversation.js";
import { handleMessage } from "../src/services/conversation.js";
import { createCommittee, appointMember } from "../src/services/committees.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

async function sessionOf(phone: string) {
  return prisma.session.findUnique({ where: { phone } });
}

function dataOf(json: string | null | undefined): Record<string, unknown> {
  return json ? (JSON.parse(json) as Record<string, unknown>) : {};
}

/** Concatenate every text sent via the mocked transport (direct + notifyMember). */
function textsSent(): string {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => String(c[0].text)),
    ...vi.mocked(notifyMember).mock.calls.map((c) => String(c[1])),
  ].join("\n");
}

/**
 * A coop with the referral program enabled. Referrals are opt-in
 * (`referralEnabled` defaults to false), so tests that exercise recording /
 * qualification must turn the program on first.
 */
async function createCoop(code: string) {
  const coop = await createTestCoop(code);
  await prisma.cooperativeConfig.upsert({
    where: { cooperativeId: coop.id },
    create: { cooperativeId: coop.id, referralEnabled: true },
    update: { referralEnabled: true },
  });
  return coop;
}

/** Walk the onboarding from wherever it is up to member creation (awaiting_optin). */
async function finishRegistration(phone: string): Promise<void> {
  const answers: Record<string, string> = {
    awaiting_consent: "YES",
    awaiting_email: "skip",
    awaiting_birthday: "skip",
    awaiting_nok_name: "Chidi Okafor",
    awaiting_nok_phone: "08030000000",
    awaiting_pin: "1234",
    awaiting_pin_confirm: "1234",
  };
  let session = await sessionOf(phone);
  let guard = 0;
  while (session && session.state !== "awaiting_optin" && guard++ < 20) {
    const answer = answers[session.state];
    if (answer === undefined) break;
    await handleAwaitingInput(phone, session.state as BotState, answer, session.data ?? "{}");
    session = await sessionOf(phone);
  }
}

describe("referrals", () => {
  it("records a pending referral for a valid referrer code", async () => {
    const coop = await createCoop("REF1");
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
    const coop = await createCoop("REF2");
    const m = await createTestMember(coop.id, { phone: "2348011110011" });

    const res = await recordReferral(coop.id, m.code, m.id);
    expect(res.ok).toBe(false);
    expect(await prisma.referral.count()).toBe(0);
  });

  it("rejects an unknown referrer code", async () => {
    const coop = await createCoop("REF3");
    const referred = await createTestMember(coop.id, { phone: "2348011110021" });

    const res = await recordReferral(coop.id, "ZZZZZZ", referred.id);
    expect(res.ok).toBe(false);
    expect(await prisma.referral.count()).toBe(0);
  });

  it("qualifies on the first contribution, credits the bonus balance and marks it rewarded", async () => {
    const coop = await createCoop("REF4");
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
    expect(referral?.status).toBe("rewarded");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
    expect(referral?.rewardType).toBe("bank");
    expect(referral?.rewardAmount).toBe(12345);

    // The bonus lands in the referrer's running balance — no payout/disbursement.
    const credited = await prisma.member.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(credited.referralBonusBalance).toBe(12345);
    expect(await prisma.referralWithdrawal.count()).toBe(0);
    expect(await prisma.payout.count()).toBe(0);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { memberId: referrer.id } })).balance,
    ).toBe(0);

    const audited = await prisma.auditLog.findFirst({
      where: { action: "referral.bonus.credited", targetId: referral!.id },
    });
    expect(audited).toBeTruthy();
  });

  it("is idempotent — a second qualify is a no-op and credits the balance once", async () => {
    const coop = await createCoop("REF5");
    const referrer = await createTestMember(coop.id, { phone: "2348011110041" });
    const referred = await createTestMember(coop.id, { phone: "2348011110042" });
    await recordReferral(coop.id, referrer.code, referred.id);
    await qualifyReferral(coop.id, referred.id);
    const first = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    const afterFirst = await prisma.member.findUniqueOrThrow({ where: { id: referrer.id } });

    const second = await qualifyReferral(coop.id, referred.id);
    expect(second.ok).toBe(true);

    const after = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    // The bonus is granted exactly once at qualification; the snapshot is untouched.
    expect(after?.status).toBe("rewarded");
    expect(after?.qualifiedAt?.getTime()).toBe(first?.qualifiedAt?.getTime());
    const afterSecond = await prisma.member.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(afterSecond.referralBonusBalance).toBe(afterFirst.referralBonusBalance);
  });
});

describe("referral reward deferral (after-commit)", () => {
  it("enqueueAfterCommit runs the callback only after the deferred scope resolves", async () => {
    const order: string[] = [];
    await withDeferredSends(async () => {
      order.push("scope-start");
      const scheduled = enqueueAfterCommit(async () => {
        order.push("after-commit");
      });
      expect(scheduled).toBe(true);
      order.push("scope-end");
    });
    expect(order).toEqual(["scope-start", "scope-end", "after-commit"]);
  });

  it("enqueueAfterCommit returns false with no ambient scope", async () => {
    expect(enqueueAfterCommit(async () => {})).toBe(false);
  });

});

describe("referral registration step", () => {
  it("captures the code in the flow and records the referral at member creation", async () => {
    const coop = await createCoop("REFR1");
    const referrer = await createTestMember(coop.id, { phone: "2348022220001" });
    const phone = "2348022220002";

    await prisma.session.create({
      data: { phone, state: "awaiting_name", data: JSON.stringify({ joinCode: coop.code }) },
    });

    await handleAwaitingInput(phone, "awaiting_name", "Ada Obi", JSON.stringify({ joinCode: coop.code }));
    let session = await sessionOf(phone);
    expect(session?.state).toBe("awaiting_referral");
    expect(dataOf(session?.data).name).toBe("Ada Obi");

    // A lowercase code is stored uppercased.
    await handleAwaitingInput(
      phone,
      "awaiting_referral",
      referrer.code.toLowerCase(),
      session?.data ?? "{}",
    );
    session = await sessionOf(phone);
    expect(session?.state).toBe("awaiting_consent");
    expect(dataOf(session?.data).referrerCode).toBe(referrer.code.toUpperCase());

    await finishRegistration(phone);

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone } },
    });
    expect(member).toBeTruthy();
    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: member!.id },
    });
    expect(referral).toBeTruthy();
    expect(referral?.referrerId).toBe(referrer.id);
    expect(referral?.status).toBe("pending");
  });

  it("skip records no referral", async () => {
    const coop = await createCoop("REFR2");
    await createTestMember(coop.id, { phone: "2348022220011" });
    const phone = "2348022220012";

    await prisma.session.create({
      data: { phone, state: "awaiting_name", data: JSON.stringify({ joinCode: coop.code }) },
    });
    await handleAwaitingInput(phone, "awaiting_name", "Bola Adeyemi", JSON.stringify({ joinCode: coop.code }));
    let session = await sessionOf(phone);
    expect(session?.state).toBe("awaiting_referral");

    await handleAwaitingInput(phone, "awaiting_referral", "skip", session?.data ?? "{}");
    session = await sessionOf(phone);
    expect(session?.state).toBe("awaiting_consent");
    expect(dataOf(session?.data).referrerCode).toBeUndefined();

    await finishRegistration(phone);

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone } },
    });
    expect(member).toBeTruthy();
    expect(await prisma.referral.count()).toBe(0);
  });

  it("the `join ... ref CODE` shortcut skips the referral step", async () => {
    const coop = await createCoop("REFR3");
    const referrer = await createTestMember(coop.id, { phone: "2348022220021" });
    const phone = "2348022220022";

    await handleJoinStart(phone, [coop.code, "ref", referrer.code.toLowerCase()]);
    let session = await sessionOf(phone);
    expect(session?.state).toBe("awaiting_name");
    expect(dataOf(session?.data).referrerCode).toBe(referrer.code.toUpperCase());

    await handleAwaitingInput(phone, "awaiting_name", "Chika Eze", session?.data ?? "{}");
    session = await sessionOf(phone);
    // Straight to consent — the referral step is never shown.
    expect(session?.state).toBe("awaiting_consent");
    expect(dataOf(session?.data).referrerCode).toBe(referrer.code.toUpperCase());
  });
});

describe("referral qualification on real money-in paths", () => {
  it("qualifies a pending referral on a provider top-up credit (production path)", async () => {
    const coop = await createCoop("REFQ1");
    const referrer = await createTestMember(coop.id, { phone: "2348033330001" });
    const referred = await createTestMember(coop.id, { phone: "2348033330002" });
    await recordReferral(coop.id, referrer.code, referred.id);
    await prisma.member.update({
      where: { id: referred.id },
      data: { virtualAccountNumber: "9000000301" },
    });

    // Provider webhook credits the wallet — the real production money-in path.
    await handlePaymentNotification({
      transactionId: "TX-REFQ-1",
      reference: "MEM-refq-1",
      accountNumber: "9000000301",
      amount: 500000,
      currency: "NGN",
      status: "successful",
      provider: "monnify",
      raw: {},
    });

    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    // Qualification credits the referrer's bonus balance inline (same tx) and
    // marks the referral rewarded — no prompt, no provider call.
    expect(referral?.status).toBe("rewarded");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
    const credited = await prisma.member.findUniqueOrThrow({ where: { id: referrer.id } });
    expect(credited.referralBonusBalance).toBe(50000);
    const referrerWallet = await prisma.wallet.findUnique({ where: { memberId: referrer.id } });
    expect(referrerWallet?.balance).toBe(0);
    expect(await prisma.referralWithdrawal.count()).toBe(0);
    expect(textsSent()).not.toContain("confirmreward");
  });

  it("does not qualify on a duplicate top-up delivery", async () => {
    const coop = await createCoop("REFDUP");
    const referrer = await createTestMember(coop.id, { phone: "2348033330021" });
    const referred = await createTestMember(coop.id, { phone: "2348033330022" });
    await recordReferral(coop.id, referrer.code, referred.id);
    await prisma.member.update({
      where: { id: referred.id },
      data: { virtualAccountNumber: "9000000321" },
    });

    // Pre-seed the journal entry for this provider transaction, so the delivery
    // below is a DUPLICATE. The top-up path treats it as a no-op (never credits)
    // and must therefore never qualify or pay the referral.
    await prisma.journalEntry.create({
      data: {
        cooperativeId: coop.id,
        txRef: "TOPUP-monnify-TX-REFDUP-1",
        description: "earlier delivery of the same transfer",
      },
    });

    await handlePaymentNotification({
      transactionId: "TX-REFDUP-1",
      reference: "MEM-refdup-1",
      accountNumber: "9000000321",
      amount: 500000,
      currency: "NGN",
      status: "successful",
      provider: "monnify",
      raw: {},
    });

    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    expect(referral?.status).toBe("pending");
    expect(referral?.qualifiedAt).toBeNull();
    expect(await prisma.contribution.count({ where: { reference: "monnify-TX-REFDUP-1" } })).toBe(0);
  });

  it("does not qualify on an admin manual credit (not a real money-in path)", async () => {
    const coop = await createCoop("REFQ2");
    const initiator = await createTestMember(coop.id, {
      phone: "2348033330011",
      role: "superadmin",
    });
    const approver = await createTestMember(coop.id, {
      phone: "2348033330012",
      role: "superadmin",
    });
    const referrer = await createTestMember(coop.id, { phone: "2348033330013" });
    const referred = await createTestMember(coop.id, { phone: "2348033330014" });
    await recordReferral(coop.id, referrer.code, referred.id);

    const requested = await requestManualCredit(initiator.phone, referred.code, 100, "goodwill");
    expect(requested.ok).toBe(true);
    const approved = await approveManualCredit(
      approver.phone,
      requested.creditId!.slice(-6),
      "1234",
    );
    expect(approved.ok).toBe(true);

    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    expect(referral?.status).toBe("pending");
    expect(referral?.qualifiedAt).toBeNull();
  });
});

describe("referral commands", () => {
  it("myReferrals lists the member's referrals and earnings", async () => {
    const coop = await createCoop("REFMY");
    const referrer = await createTestMember(coop.id, {
      phone: "2348066660001",
      name: "Ada Obi",
    });
    const referred = await createTestMember(coop.id, {
      phone: "2348066660002",
      name: "Bola Adeyemi",
    });
    await recordReferral(coop.id, referrer.code, referred.id);
    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredMemberId: referred.id },
    });
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: "rewarded",
        rewardType: "wallet",
        rewardAmount: 50000,
        rewardedAt: new Date(),
      },
    });

    const res = await myReferrals(coop.id, referrer.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Bola Adeyemi");
    expect(res.message).toContain("₦500.00");
  });

  it("myReferrals is empty-safe for a member with no referrals", async () => {
    const coop = await createCoop("REFMY2");
    const member = await createTestMember(coop.id, { phone: "2348066660011" });

    const res = await myReferrals(coop.id, member.id);
    expect(res.ok).toBe(true);
    expect(res.message.toLowerCase()).toContain("haven't referred");
  });

  it("setReferralConfig upserts the coop config and audits the change", async () => {
    const coop = await createTestCoop("REFSET");
    const admin = await createTestMember(coop.id, {
      phone: "2348066660021",
      role: "admin",
    });

    const res = await setReferralConfig(
      coop.id,
      { enabled: true, rewardType: "airtime", rewardAmount: 20000, maxRewards: 3 },
      { id: admin.id, phone: admin.phone },
    );
    expect(res.ok).toBe(true);

    const cfg = await prisma.cooperativeConfig.findUniqueOrThrow({
      where: { cooperativeId: coop.id },
    });
    expect(cfg.referralEnabled).toBe(true);
    expect(cfg.referralRewardType).toBe("airtime");
    expect(cfg.referralRewardAmount).toBe(20000);
    expect(cfg.referralMaxRewards).toBe(3);

    const audited = await prisma.auditLog.findFirst({ where: { action: "referral.config" } });
    expect(audited).toBeTruthy();
  });

  it("setReferralConfig rejects an unknown reward type", async () => {
    const coop = await createTestCoop("REFSET2");
    const admin = await createTestMember(coop.id, {
      phone: "2348066660031",
      role: "admin",
    });

    const res = await setReferralConfig(
      coop.id,
      { rewardType: "crypto" },
      { id: admin.id, phone: admin.phone },
    );
    expect(res.ok).toBe(false);
  });

  it("setReferralConfig records the caller's true role in the audit", async () => {
    const coop = await createTestCoop("REFSET3");
    const superAdmin = await createTestMember(coop.id, {
      phone: "2348066660051",
      role: "superadmin",
    });

    await setReferralConfig(
      coop.id,
      { enabled: true },
      { id: superAdmin.id, phone: superAdmin.phone, role: "superadmin" },
    );

    const audited = await prisma.auditLog.findFirst({ where: { action: "referral.config" } });
    expect(audited?.actorRole).toBe("superadmin");
  });

  it("referralReport summarises the coop's referrals", async () => {
    const coop = await createCoop("REPR1");
    const referrer = await createTestMember(coop.id, { phone: "2348066660041" });
    const referred = await createTestMember(coop.id, { phone: "2348066660042" });
    await recordReferral(coop.id, referrer.code, referred.id);
    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredMemberId: referred.id },
    });
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: "rewarded",
        rewardType: "wallet",
        rewardAmount: 50000,
        rewardedAt: new Date(),
      },
    });

    const res = await referralReport(coop.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Referred");
    expect(res.message).toContain("₦500.00");
  });
});

describe("referral enablement gate", () => {
  it("does not record a referral when the program is disabled", async () => {
    const coop = await createTestCoop("REFG1");
    const referrer = await createTestMember(coop.id, { phone: "2348077770001" });
    const referred = await createTestMember(coop.id, { phone: "2348077770002" });

    const res = await recordReferral(coop.id, referrer.code, referred.id);
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain("not enabled");
    expect(await prisma.referral.count()).toBe(0);
  });

  it("does not qualify a pending referral when the program is paused", async () => {
    const coop = await createCoop("REFG2");
    const referrer = await createTestMember(coop.id, { phone: "2348077770011" });
    const referred = await createTestMember(coop.id, { phone: "2348077770012" });
    await recordReferral(coop.id, referrer.code, referred.id);

    await prisma.cooperativeConfig.update({
      where: { cooperativeId: coop.id },
      data: { referralEnabled: false },
    });

    const res = await qualifyReferral(coop.id, referred.id);
    expect(res.ok).toBe(false);

    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredMemberId: referred.id },
    });
    expect(referral.status).toBe("pending");
    expect(referral.qualifiedAt).toBeNull();
  });
});

describe("referral per-referrer cap", () => {
  it("does not qualify beyond the configured reward cap", async () => {
    const coop = await createCoop("REFCAP");
    await prisma.cooperativeConfig.update({
      where: { cooperativeId: coop.id },
      data: { referralMaxRewards: 1 },
    });
    const referrer = await createTestMember(coop.id, { phone: "2348088880001" });
    const first = await createTestMember(coop.id, { phone: "2348088880002" });
    const second = await createTestMember(coop.id, { phone: "2348088880003" });
    await recordReferral(coop.id, referrer.code, first.id);
    await recordReferral(coop.id, referrer.code, second.id);

    const firstRes = await qualifyReferral(coop.id, first.id);
    expect(firstRes.ok).toBe(true);

    const secondRes = await qualifyReferral(coop.id, second.id);
    expect(secondRes.ok).toBe(false);

    const row = await prisma.referral.findUniqueOrThrow({
      where: { referredMemberId: second.id },
    });
    expect(row.status).toBe("rejected");
  });
});

describe("referral config command parsing", () => {
  it("parses on/off, reward type, amount (naira→kobo) and maxRewards", async () => {
    const coop = await createTestCoop("REFCFG");
    const admin = await createTestMember(coop.id, {
      phone: "2348090000300",
      role: "admin",
    });

    await handleMessage(admin.phone, "referralconfig on bank 750 2");
    const cfg = await prisma.cooperativeConfig.findUniqueOrThrow({
      where: { cooperativeId: coop.id },
    });
    expect(cfg.referralEnabled).toBe(true);
    expect(cfg.referralRewardType).toBe("bank");
    expect(cfg.referralRewardAmount).toBe(75000);
    expect(cfg.referralMaxRewards).toBe(2);

    await handleMessage(admin.phone, "referralconfig off");
    const off = await prisma.cooperativeConfig.findUniqueOrThrow({
      where: { cooperativeId: coop.id },
    });
    expect(off.referralEnabled).toBe(false);
    // Untouched fields survive a partial update.
    expect(off.referralRewardType).toBe("bank");
    expect(off.referralRewardAmount).toBe(75000);
  });

  it("bare referralconfig replies with usage and does not write", async () => {
    const coop = await createTestCoop("REFCFG2");
    const admin = await createTestMember(coop.id, {
      phone: "2348090000310",
      role: "admin",
    });

    await handleMessage(admin.phone, "referralconfig");

    expect(
      await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coop.id } }),
    ).toBeNull();
    expect(textsSent()).toContain("Usage: *referralconfig");
  });
});

describe("referral board controls", () => {
  /** A coop with an active, fully seated Board committee. */
  async function seatedBoard(coopId: string) {
    const superAdmin = await createTestMember(coopId, {
      phone: "2348090000001",
      role: "superadmin",
    });
    const actor = { phone: superAdmin.phone, id: superAdmin.id, role: "superadmin" as const };
    const chair = await createTestMember(coopId, { phone: "2348090000101", name: "Board Chair" });
    const b = await createTestMember(coopId, { phone: "2348090000102" });
    const c = await createTestMember(coopId, { phone: "2348090000103" });
    await createCommittee(coopId, "board", "Board", 3, actor);
    await appointMember(coopId, "board", chair.code, "chair", actor);
    await appointMember(coopId, "board", b.code, "member", actor);
    await appointMember(coopId, "board", c.code, "member", actor);
    return { chair };
  }

  it("lets an active Board member pause and resume the program", async () => {
    const coop = await createCoop("REFB1");
    const { chair } = await seatedBoard(coop.id);

    await handleMessage(chair.phone, "referralpause");
    let cfg = await prisma.cooperativeConfig.findUniqueOrThrow({
      where: { cooperativeId: coop.id },
    });
    expect(cfg.referralEnabled).toBe(false);

    await handleMessage(chair.phone, "referralresume");
    cfg = await prisma.cooperativeConfig.findUniqueOrThrow({
      where: { cooperativeId: coop.id },
    });
    expect(cfg.referralEnabled).toBe(true);

    const actions = (
      await prisma.auditLog.findMany({
        where: { cooperativeId: coop.id },
        select: { action: true, actorRole: true },
      })
    ).filter((e) => e.action.startsWith("referral."));
    expect(actions.map((e) => e.action)).toEqual(
      expect.arrayContaining(["referral.paused", "referral.resumed"]),
    );
    expect(actions.every((e) => e.actorRole === "committee")).toBe(true);
  });

  it("rejects a non-Board member from pausing the program", async () => {
    const coop = await createCoop("REFB2");
    await seatedBoard(coop.id);
    const outsider = await createTestMember(coop.id, { phone: "2348090000200" });

    await handleMessage(outsider.phone, "referralpause");

    const cfg = await prisma.cooperativeConfig.findUniqueOrThrow({
      where: { cooperativeId: coop.id },
    });
    expect(cfg.referralEnabled).toBe(true);
    expect(textsSent()).toContain("Board Committee");
  });
});

describe("referral bonus withdrawal", () => {
  async function bonusMember(
    coopId: string,
    phone: string,
    bonus: number,
    extra: { name?: string; bank?: boolean } = {},
  ) {
    const member = await createTestMember(coopId, { phone, name: extra.name });
    await prisma.member.update({
      where: { id: member.id },
      data: {
        referralBonusBalance: bonus,
        ...(extra.bank
          ? { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" }
          : {}),
      },
    });
    return member;
  }

  it("shows the member's referral bonus balance", async () => {
    const coop = await createCoop("RBBAL");
    const member = await bonusMember(coop.id, "2348091000090", 12345);

    const res = await getReferralBonus(coop.id, member.id);
    expect(res.ok).toBe(true);
    expect(res.balance).toBe(12345);
    expect(res.message).toContain("₦123.45");
  });

  it("withdraws to wallet: debits the bonus, credits the wallet, records a paid withdrawal and audits", async () => {
    const coop = await createCoop("RBW1");
    const member = await bonusMember(coop.id, "2348091000001", 50000, { name: "Ada Obi" });

    const res = await withdrawReferralBonus(
      coop.id,
      member.id,
      { amount: 30000, destination: "wallet" },
      { id: member.id, phone: member.phone },
    );
    expect(res.ok).toBe(true);
    expect(res.withdrawalId).toBeTruthy();

    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.referralBonusBalance).toBe(20000);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: member.id } });
    expect(wallet.balance).toBe(30000);

    const wd = await prisma.referralWithdrawal.findUniqueOrThrow({
      where: { id: res.withdrawalId! },
    });
    expect(wd.status).toBe("paid");
    expect(wd.paidAt).toBeInstanceOf(Date);
    expect(wd.amount).toBe(30000);
    expect(wd.destination).toBe("wallet");

    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { txRef: `REFBONUS-${res.withdrawalId}` },
      include: { postings: true },
    });
    const accounts = je.postings.map((p) => `${p.account}:${p.direction}`);
    expect(accounts).toContain("expense:referral_reward:DEBIT");
    expect(accounts).toContain(`member_wallet:${wallet.id}:CREDIT`);

    const audited = await prisma.auditLog.findFirst({
      where: { action: "referral.bonus.withdrawn", targetId: res.withdrawalId! },
    });
    expect(audited).toBeTruthy();
  });

  it("refuses an amount above the balance and a non-positive amount, leaving the balance untouched", async () => {
    const coop = await createCoop("RBW2");
    const member = await bonusMember(coop.id, "2348091000002", 10000);
    const actor = { id: member.id, phone: member.phone };

    const over = await withdrawReferralBonus(
      coop.id,
      member.id,
      { amount: 20000, destination: "wallet" },
      actor,
    );
    expect(over.ok).toBe(false);
    expect(over.message).toContain("Insufficient");

    const zero = await withdrawReferralBonus(
      coop.id,
      member.id,
      { amount: 0, destination: "wallet" },
      actor,
    );
    expect(zero.ok).toBe(false);

    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.referralBonusBalance).toBe(10000);
    expect(await prisma.referralWithdrawal.count()).toBe(0);
  });

  it("withdraws to the member's saved bank account and records the withdrawal", async () => {
    const coop = await createCoop("RBW3");
    const member = await bonusMember(coop.id, "2348091000003", 40000, {
      name: "Ada Obi",
      bank: true,
    });

    const res = await withdrawReferralBonus(
      coop.id,
      member.id,
      { amount: 40000, destination: "bank" },
      { id: member.id, phone: member.phone },
    );
    expect(res.ok).toBe(true);

    const wd = await prisma.referralWithdrawal.findUniqueOrThrow({
      where: { id: res.withdrawalId! },
    });
    expect(wd.status).toBe("paid");
    expect(wd.destination).toBe("bank");
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.referralBonusBalance).toBe(0);
  });

  it("refuses a bank withdrawal when the member has no saved account (refunded, failed)", async () => {
    const coop = await createCoop("RBW4");
    const member = await bonusMember(coop.id, "2348091000004", 15000);

    const res = await withdrawReferralBonus(
      coop.id,
      member.id,
      { amount: 15000, destination: "bank" },
      { id: member.id, phone: member.phone },
    );
    expect(res.ok).toBe(false);
    const wd = await prisma.referralWithdrawal.findUniqueOrThrow({
      where: { id: res.withdrawalId! },
    });
    expect(wd.status).toBe("failed");
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.referralBonusBalance).toBe(15000);
  });

  it("refunds the bonus when the bank payout definitely fails", async () => {
    const coop = await createCoop("RBW5");
    const member = await bonusMember(coop.id, "2348091000005", 20000, {
      name: "Ada Obi",
      bank: true,
    });
    paymentState.payoutFails = true;
    try {
      const res = await withdrawReferralBonus(
        coop.id,
        member.id,
        { amount: 20000, destination: "bank" },
        { id: member.id, phone: member.phone },
      );
      expect(res.ok).toBe(false);
      const wd = await prisma.referralWithdrawal.findUniqueOrThrow({
        where: { id: res.withdrawalId! },
      });
      expect(wd.status).toBe("failed");
      const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
      expect(after.referralBonusBalance).toBe(20000);
    } finally {
      paymentState.payoutFails = false;
    }
  });

  it("withdraws to airtime via the VTU adapter with the entered phone", async () => {
    const coop = await createCoop("RBW6");
    const member = await bonusMember(coop.id, "2348091000006", 25000);

    // The VTU adapter is gated on VTU_PROVIDER + its secret. Enable the real
    // Flutterwave adapter and stub fetch so the adapter's HTTP calls are local.
    const prevProvider = process.env.VTU_PROVIDER;
    const prevKey = process.env.FLUTTERWAVE_SECRET_KEY;
    process.env.VTU_PROVIDER = "flutterwave";
    process.env.FLUTTERWAVE_SECRET_KEY = "test-key";
    clearVtuBillerCache();

    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const json = (obj: unknown) => ({ json: async () => obj }) as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (u.includes("/top-bill-categories")) {
          return json({ status: "success", data: [{ code: "AIRTIME", country_code: "NG" }] });
        }
        if (u.includes("/payment")) {
          return json({ status: "success", data: { tx_ref: "FLW-TX-1" } });
        }
        if (u.includes("/items")) {
          return json({ status: "success", data: [{ item_code: "AT", is_airtime: true }] });
        }
        return json({
          status: "success",
          data: [
            { biller_code: "MTN", name: "MTN" },
            { biller_code: "GLO", name: "Glo" },
            { biller_code: "AIRTEL", name: "Airtel" },
            { biller_code: "9MOBILE", name: "9mobile" },
          ],
        });
      }),
    );

    try {
      const res = await withdrawReferralBonus(
        coop.id,
        member.id,
        { amount: 25000, destination: "airtime", phone: "08031234567" },
        { id: member.id, phone: member.phone },
      );
      expect(res.ok).toBe(true);

      const wd = await prisma.referralWithdrawal.findUniqueOrThrow({
        where: { id: res.withdrawalId! },
      });
      expect(wd.status).toBe("paid");
      expect(wd.providerRef).toBe("FLW-TX-1");
      expect(wd.phone).toBe("08031234567");

      const payment = calls.find((c) => c.url.includes("/payment"));
      expect(payment?.body).toMatchObject({
        customer_id: "08031234567",
        amount: 250,
        reference: `REFBONUS-${res.withdrawalId}`,
      });
    } finally {
      vi.unstubAllGlobals();
      clearVtuBillerCache();
      if (prevProvider === undefined) delete process.env.VTU_PROVIDER;
      else process.env.VTU_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
      else process.env.FLUTTERWAVE_SECRET_KEY = prevKey;
    }
  });

  it("refuses an airtime withdrawal when no VTU provider is configured (balance unchanged)", async () => {
    const coop = await createCoop("RBW7");
    const member = await bonusMember(coop.id, "2348091000007", 10000);
    const prevProvider = process.env.VTU_PROVIDER;
    delete process.env.VTU_PROVIDER;
    try {
      const res = await withdrawReferralBonus(
        coop.id,
        member.id,
        { amount: 10000, destination: "airtime", phone: "08031234567" },
        { id: member.id, phone: member.phone },
      );
      expect(res.ok).toBe(false);
      const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
      expect(after.referralBonusBalance).toBe(10000);
      const wd = await prisma.referralWithdrawal.findUniqueOrThrow({
        where: { id: res.withdrawalId! },
      });
      expect(wd.status).toBe("failed");
    } finally {
      if (prevProvider === undefined) delete process.env.VTU_PROVIDER;
      else process.env.VTU_PROVIDER = prevProvider;
    }
  });

  it("cannot overdraw — concurrent withdrawals cannot both succeed", async () => {
    const coop = await createCoop("RBW8");
    const member = await bonusMember(coop.id, "2348091000008", 10000);
    const actor = { id: member.id, phone: member.phone };

    const [a, b] = await Promise.all([
      withdrawReferralBonus(coop.id, member.id, { amount: 10000, destination: "wallet" }, actor),
      withdrawReferralBonus(coop.id, member.id, { amount: 10000, destination: "wallet" }, actor),
    ]);

    expect([a, b].filter((r) => r.ok).length).toBe(1);
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.referralBonusBalance).toBe(0);
    expect(
      await prisma.referralWithdrawal.count({ where: { memberId: member.id, status: "paid" } }),
    ).toBe(1);
  });

  it("lists referral withdrawals, scoped by member", async () => {
    const coop = await createCoop("RBLIST");
    const member = await bonusMember(coop.id, "2348091000091", 30000);
    await withdrawReferralBonus(
      coop.id,
      member.id,
      { amount: 10000, destination: "wallet" },
      { id: member.id, phone: member.phone },
    );

    const res = await listReferralWithdrawals(coop.id, member.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("₦100.00");

    const other = await bonusMember(coop.id, "2348091000092", 0);
    const empty = await listReferralWithdrawals(coop.id, other.id);
    expect(empty.ok).toBe(true);
    expect(empty.message.toLowerCase()).toContain("no referral withdrawals");
  });
});
