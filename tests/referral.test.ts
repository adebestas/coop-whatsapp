import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { recordReferral, qualifyReferral, payReferralReward } from "../src/services/referrals.js";
import { handleAwaitingInput } from "../src/services/handlers/session.js";
import { handleJoinStart } from "../src/services/handlers/join.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";
import { requestManualCredit, approveManualCredit } from "../src/services/manualcredit.js";
import { sendToBank } from "../src/services/disbursements.js";
import { txStorage } from "../src/lib/prisma.js";
import { enqueueAfterCommit, withDeferredSends } from "../src/lib/deferred.js";
import type { BotState } from "../src/services/conversation.js";

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
    // Default reward is a wallet credit — the first qualify now pays it, so the
    // referral reaches `rewarded`; the snapshot timestamp is untouched.
    expect(after?.status).toBe("rewarded");
    expect(after?.qualifiedAt?.getTime()).toBe(first?.qualifiedAt?.getTime());
  });
});

describe("referral reward payment", () => {
  /** Create a coop with a referrer + referred member and a `qualified` referral. */
  async function setupReward(
    code: string,
    opts: {
      rewardType: string;
      rewardAmount: number;
      referrerName?: string;
      bank?: boolean;
    },
  ) {
    const coop = await createTestCoop(code);
    const referrer = await createTestMember(coop.id, {
      phone: "2348044440000",
      name: opts.referrerName ?? "Ada Obi",
    });
    const referred = await createTestMember(coop.id, { phone: "2348044440001" });
    await recordReferral(coop.id, referrer.code, referred.id);

    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredMemberId: referred.id },
    });
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: "qualified",
        qualifiedAt: new Date(),
        rewardType: opts.rewardType,
        rewardAmount: opts.rewardAmount,
      },
    });
    if (opts.bank) {
      await prisma.member.update({
        where: { id: referrer.id },
        data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
      });
    }
    return { coop, referrer, referralId: referral.id };
  }

  it("credits the referrer's wallet and posts a balanced journal", async () => {
    const { coop, referrer, referralId } = await setupReward("REFPW", {
      rewardType: "wallet",
      rewardAmount: 25000,
    });

    const res = await payReferralReward(coop.id, referralId);
    expect(res.ok).toBe(true);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe("rewarded");
    expect(referral.rewardedAt).toBeInstanceOf(Date);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: referrer.id } });
    expect(wallet.balance).toBe(25000);

    const entry = await prisma.journalEntry.findUnique({
      where: { txRef: `REFERRAL-${referralId}` },
      include: { postings: true },
    });
    expect(entry).toBeTruthy();
    const debit = entry!.postings.find((p) => p.direction === "DEBIT");
    const credit = entry!.postings.find((p) => p.direction === "CREDIT");
    expect(debit?.account).toBe("expense:referral_reward");
    expect(debit?.amount).toBe(25000);
    expect(credit?.account).toBe(`member_wallet:${wallet.id}`);
    expect(credit?.amount).toBe(25000);

    const audited = await prisma.auditLog.findFirst({ where: { action: "referral.rewarded" } });
    expect(audited).toBeTruthy();
  });

  it("pays the referrer's saved bank account via the existing payout path", async () => {
    const { coop, referrer, referralId } = await setupReward("REFPB", {
      rewardType: "bank",
      rewardAmount: 30000,
      referrerName: "Ada Obi",
      bank: true,
    });

    const res = await payReferralReward(coop.id, referralId);
    expect(res.ok).toBe(true);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe("rewarded");

    const payout = await prisma.payout.findFirst({
      where: { idempotencyKey: `REFERRAL-${referralId}` },
    });
    expect(payout).toBeTruthy();
    expect(payout?.amount).toBe(30000);
    expect(payout?.memberId).toBe(referrer.id);

    // A bank payout must NOT also credit the wallet.
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: referrer.id } });
    expect(wallet.balance).toBe(0);
  });

  it("leaves the referral qualified when airtime has no VTU provider configured", async () => {
    const { coop, referralId } = await setupReward("REFPV", {
      rewardType: "airtime",
      rewardAmount: 20000,
    });

    const res = await payReferralReward(coop.id, referralId);
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain("not enabled");

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe("qualified");
    expect(referral.rewardedAt).toBeNull();
  });

  it("is idempotent — a second payment is a no-op", async () => {
    const { coop, referrer, referralId } = await setupReward("REFPI", {
      rewardType: "wallet",
      rewardAmount: 7000,
    });

    expect((await payReferralReward(coop.id, referralId)).ok).toBe(true);
    expect((await payReferralReward(coop.id, referralId)).ok).toBe(true);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: referrer.id } });
    expect(wallet.balance).toBe(7000);
    expect(await prisma.journalEntry.count({ where: { txRef: `REFERRAL-${referralId}` } })).toBe(1);
  });

  it("keeps the referral rewarded (no retry) when the bank payout is 'unsure'", async () => {
    const { coop, referralId } = await setupReward("REFUN", {
      rewardType: "bank",
      rewardAmount: 33000,
      bank: true,
    });

    vi.mocked(sendToBank).mockImplementationOnce(async () => ({
      ok: false,
      status: "unsure",
      message: "awaiting provider authorization",
    }));

    const res = await payReferralReward(coop.id, referralId);

    // An unsure payout must NOT revert to `qualified` (a retry could double-pay).
    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(after.status).toBe("rewarded");
    expect(after.rewardedAt).toBeInstanceOf(Date);
    expect(res.message.toLowerCase()).toContain("unconfirmed");

    const warned = await prisma.auditLog.findFirst({
      where: { action: "referral.reward.unconfirmed" },
    });
    expect(warned).toBeTruthy();
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

  it("runs the referral payout only after the top-up credit transaction commits", async () => {
    const coop = await createTestCoop("REFORD");
    const referrer = await createTestMember(coop.id, {
      phone: "2348055550001",
      name: "Ada Obi",
    });
    const referred = await createTestMember(coop.id, { phone: "2348055550002" });
    await prisma.cooperativeConfig.upsert({
      where: { cooperativeId: coop.id },
      create: {
        cooperativeId: coop.id,
        referralEnabled: true,
        referralRewardType: "bank",
        referralRewardAmount: 40000,
      },
      update: {
        cooperativeId: coop.id,
        referralEnabled: true,
        referralRewardType: "bank",
        referralRewardAmount: 40000,
      },
    });
    await prisma.member.update({
      where: { id: referrer.id },
      data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
    });
    await recordReferral(coop.id, referrer.code, referred.id);
    await prisma.member.update({
      where: { id: referred.id },
      data: { virtualAccountNumber: "9000000555" },
    });

    // Assert TWO things at payout time: no DB transaction is open (the provider
    // call is not running inside `withCoopContext`'s tx), and the money-in
    // credit is already committed so the deferred reward ran after commit.
    const reference = "monnify-TX-REFORD-1";
    let txOpenAtPayout: boolean | null = null;
    let contributionCommittedAtPayout = false;
    vi.mocked(sendToBank).mockImplementationOnce(async () => {
      txOpenAtPayout = txStorage.getStore() !== undefined;
      contributionCommittedAtPayout =
        (await prisma.contribution.findFirst({ where: { reference } })) !== null;
      return { ok: true, status: "successful", message: "paid" };
    });

    await handlePaymentNotification({
      transactionId: "TX-REFORD-1",
      reference: "MEM-reford-1",
      accountNumber: "9000000555",
      amount: 500000,
      currency: "NGN",
      status: "successful",
      provider: "monnify",
      raw: {},
    });

    expect(txOpenAtPayout).toBe(false);
    expect(contributionCommittedAtPayout).toBe(true);

    const referral = await prisma.referral.findUnique({
      where: { referredMemberId: referred.id },
    });
    expect(referral?.status).toBe("rewarded");
  });
});

describe("referral registration step", () => {
  it("captures the code in the flow and records the referral at member creation", async () => {
    const coop = await createTestCoop("REFR1");
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
    const coop = await createTestCoop("REFR2");
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
    const coop = await createTestCoop("REFR3");
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
    const coop = await createTestCoop("REFQ1");
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
    // The qualification trigger also pays the reward: default is a wallet
    // credit of ₦500 (50,000 kobo) to the referrer.
    expect(referral?.status).toBe("rewarded");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
    const referrerWallet = await prisma.wallet.findUnique({ where: { memberId: referrer.id } });
    expect(referrerWallet?.balance).toBe(50000);
  });

  it("does not qualify on an admin manual credit (not a real money-in path)", async () => {
    const coop = await createTestCoop("REFQ2");
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
