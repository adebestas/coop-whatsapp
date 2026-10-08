import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import {
  recordReferral,
  qualifyReferral,
  payReferralReward,
  myReferrals,
  setReferralConfig,
  referralReport,
} from "../src/services/referrals.js";
import { handleAwaitingInput } from "../src/services/handlers/session.js";
import { handleJoinStart } from "../src/services/handlers/join.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";
import { requestManualCredit, approveManualCredit } from "../src/services/manualcredit.js";
import { sendToBank } from "../src/services/disbursements.js";
import { runReferralPayouts } from "../src/services/scheduler.js";
import { clearVtuBillerCache } from "../src/services/payments/vtu.js";
import { txStorage } from "../src/lib/prisma.js";
import { enqueueAfterCommit, withDeferredSends } from "../src/lib/deferred.js";
import type { BotState } from "../src/services/conversation.js";
import { handleMessage } from "../src/services/conversation.js";
import { createCommittee, appointMember } from "../src/services/committees.js";
import { sendText } from "../src/lib/messaging.js";

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

/** Concatenate every text sent via the mocked messaging transport. */
function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => c[0].text)
    .join("\n");
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

  it("qualifies on the first contribution and snapshots the reward from config", async () => {
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
    expect(referral?.status).toBe("qualified");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
    expect(referral?.rewardType).toBe("bank");
    expect(referral?.rewardAmount).toBe(12345);
  });

  it("is idempotent — a second qualify is a no-op", async () => {
    const coop = await createCoop("REF5");
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
    const coop = await createCoop(code);
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

  it("reverts a DEFINITE bank failure back to qualified (retryable)", async () => {
    const { coop, referralId } = await setupReward("REFDF", {
      rewardType: "bank",
      rewardAmount: 41000,
      bank: true,
    });

    vi.mocked(sendToBank).mockImplementationOnce(async () => ({
      ok: false,
      status: "failed",
      message: "provider rejected the transfer",
    }));

    const res = await payReferralReward(coop.id, referralId);
    expect(res.ok).toBe(false);

    // A definite failure moves NO money, so the referral must not be stranded
    // as `rewarded` — it reverts to `qualified` for a later retry.
    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(after.status).toBe("qualified");
    expect(after.rewardedAt).toBeNull();
  });

  it("runReferralPayouts pays a retried `qualified` referral and is idempotent", async () => {
    const { coop, referrer, referralId } = await setupReward("REFJOB", {
      rewardType: "bank",
      rewardAmount: 44000,
      bank: true,
    });

    // A first, definite failure leaves the reward `qualified`...
    vi.mocked(sendToBank).mockImplementationOnce(async () => ({
      ok: false,
      status: "failed",
      message: "nope",
    }));
    await payReferralReward(coop.id, referralId);
    expect(
      (await prisma.referral.findUniqueOrThrow({ where: { id: referralId } })).status,
    ).toBe("qualified");

    // ...and the reconciliation job retries the whole qualified queue and pays it
    // via the real payout path (which writes the Payout row). The payout MUST run
    // with NO ambient transaction: the `qualified → rewarded` claim has committed
    // first, so a later rollback/timeout cannot double-pay.
    const realSendToBank = vi.mocked(sendToBank).getMockImplementation()!;
    let txAtPayout: boolean | null = null;
    vi.mocked(sendToBank).mockImplementationOnce(async (opts) => {
      txAtPayout = txStorage.getStore() !== undefined;
      return realSendToBank(opts);
    });
    const paid = await runReferralPayouts();
    expect(paid).toBe(1);
    expect(txAtPayout).toBe(false);

    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(after.status).toBe("rewarded");
    expect(after.rewardedAt).toBeInstanceOf(Date);
    const payout = await prisma.payout.findFirst({
      where: { idempotencyKey: `REFERRAL-${referralId}` },
    });
    expect(payout).toBeTruthy();
    // A bank payout must NOT also credit the wallet.
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: referrer.id } });
    expect(wallet.balance).toBe(0);

    // A second sweep finds nothing left `qualified` — a strict no-op.
    expect(await runReferralPayouts()).toBe(0);
    expect(await prisma.payout.count({ where: { idempotencyKey: `REFERRAL-${referralId}` } })).toBe(
      1,
    );
  });

  it("admin `referralpay` pays a qualified referral and respects the disabled gate", async () => {
    const { coop, referralId } = await setupReward("REFADM", {
      rewardType: "bank",
      rewardAmount: 46000,
      bank: true,
    });
    const admin = await createTestMember(coop.id, { phone: "2348090000400", role: "admin" });

    await handleMessage(admin.phone, `referralpay ${referralId}`);
    // The payout is deferred past the chat transaction, so the reply is the
    // "triggered" acknowledgement — but the deferred work has flushed by the time
    // `handleMessage` resolves, so the referral is already `rewarded`.
    expect(textsSent().toLowerCase()).toContain("triggered");
    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(after.status).toBe("rewarded");
    expect(
      await prisma.payout.findFirst({ where: { idempotencyKey: `REFERRAL-${referralId}` } }),
    ).toBeTruthy();

    // The Board can pause the program — a retry must then be refused, not paid.
    const second = await setupReward("REFADM2", {
      rewardType: "bank",
      rewardAmount: 47000,
      bank: true,
    });
    await prisma.cooperativeConfig.update({
      where: { cooperativeId: second.coop.id },
      data: { referralEnabled: false },
    });
    const admin2 = await createTestMember(second.coop.id, {
      phone: "2348090000401",
      role: "admin",
    });
    await handleMessage(admin2.phone, `referralpay ${second.referralId}`);
    const untouched = await prisma.referral.findUniqueOrThrow({ where: { id: second.referralId } });
    expect(untouched.status).toBe("qualified");
    expect(textsSent().toLowerCase()).toContain("not enabled");
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
    const coop = await createCoop("REFORD");
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
    // The qualification trigger also pays the reward: default is a wallet
    // credit of ₦500 (50,000 kobo) to the referrer.
    expect(referral?.status).toBe("rewarded");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
    const referrerWallet = await prisma.wallet.findUnique({ where: { memberId: referrer.id } });
    expect(referrerWallet?.balance).toBe(50000);
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

describe("referral airtime reward via the Flutterwave adapter", () => {
  const FLW = "https://api.flutterwave.com/v3";
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  /**
   * Route the discovery calls to a single MTN biller + airtime item, then
   * delegate the bill-payment response (which may throw to simulate a network
   * error). Returns the captured payment requests.
   */
  function stubFetch(payment: () => unknown) {
    const paymentCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/top-bill-categories")) {
          return json({ status: "success", data: [{ code: "AIRTIME", country_code: "NG" }] });
        }
        if (url.includes("/bills/AIRTIME/billers")) {
          return json({
            status: "success",
            data: [{ biller_code: "BIL100", name: "MTN", short_name: "MTN" }],
          });
        }
        if (url.endsWith("/items")) {
          return json({
            status: "success",
            data: [{ item_code: "AT100", is_airtime: true, category_name: "Airtime" }],
          });
        }
        paymentCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json(payment());
      }),
    );
    return paymentCalls;
  }

  /** A `qualified` airtime referral for an MTN referrer (phone set locally). */
  async function airtimeReward(code: string, referredPhone: string) {
    const coop = await createCoop(code);
    const referrer = await createTestMember(coop.id, {
      phone: "08031234567",
      name: "Ada Obi",
    });
    const referred = await createTestMember(coop.id, { phone: referredPhone });
    await recordReferral(coop.id, referrer.code, referred.id);
    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredMemberId: referred.id },
    });
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: "qualified",
        qualifiedAt: new Date(),
        rewardType: "airtime",
        rewardAmount: 50000,
      },
    });
    return { coop, referral };
  }

  beforeEach(() => {
    process.env.VTU_PROVIDER = "flutterwave";
    process.env.FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-abc";
    clearVtuBillerCache();
  });

  afterEach(() => {
    delete process.env.VTU_PROVIDER;
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    vi.unstubAllGlobals();
  });

  it("pays an airtime reward end-to-end when the adapter resolves", async () => {
    const paymentCalls = stubFetch(() => ({
      status: "success",
      message: "Bill payment successful",
      data: { tx_ref: "CF-FLYAPI-REFERRAL", reference: "247891569224" },
    }));
    const { coop, referral } = await airtimeReward("REFAIR", "2348044440011");

    const res = await payReferralReward(coop.id, referral.id);
    expect(res.ok).toBe(true);

    // Money moved: the referral is `rewarded` and audited.
    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referral.id } });
    expect(after.status).toBe("rewarded");
    expect(after.rewardedAt).toBeInstanceOf(Date);
    const audited = await prisma.auditLog.findFirst({
      where: { action: "referral.rewarded", targetId: referral.id },
    });
    expect(audited).toBeTruthy();

    // ₦500 (50,000 kobo) was bought as whole naira via the MTN airtime biller,
    // under the referral's deterministic reference.
    expect(paymentCalls).toHaveLength(1);
    expect(paymentCalls[0].url).toBe(`${FLW}/billers/BIL100/items/AT100/payment`);
    expect(paymentCalls[0].body).toMatchObject({
      country: "NG",
      customer_id: "08031234567",
      amount: 500,
      reference: `REFERRAL-${referral.id}`,
    });
  });

  it("keeps the referral rewarded (no retry) when the airtime payment is UNSURE", async () => {
    // The payment fetch itself rejects: the first payment may have landed, so a
    // retry with the same reference would be a duplicate. Mirror the bank path.
    stubFetch(() => {
      throw new Error("socket hang up");
    });
    const { coop, referral } = await airtimeReward("REFAIRU", "2348044440012");

    const res = await payReferralReward(coop.id, referral.id);

    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referral.id } });
    expect(after.status).toBe("rewarded");
    expect(after.rewardedAt).toBeInstanceOf(Date);
    expect(res.message.toLowerCase()).toContain("unconfirmed");
    const warned = await prisma.auditLog.findFirst({
      where: { action: "referral.reward.unconfirmed", targetId: referral.id },
    });
    expect(warned).toBeTruthy();
  });

  it("reverts to qualified when the airtime payment is a DEFINITE failure", async () => {
    stubFetch(() => ({ status: "error", message: "Invalid customer id", data: null }));
    const { coop, referral } = await airtimeReward("REFAIRF", "2348044440013");

    const res = await payReferralReward(coop.id, referral.id);
    expect(res.ok).toBe(false);

    const after = await prisma.referral.findUniqueOrThrow({ where: { id: referral.id } });
    expect(after.status).toBe("qualified");
    expect(after.rewardedAt).toBeNull();
  });
});
