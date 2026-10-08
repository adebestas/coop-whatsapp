import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { recordReferral, qualifyReferral } from "../src/services/referrals.js";
import { handleAwaitingInput } from "../src/services/handlers/session.js";
import { handleJoinStart } from "../src/services/handlers/join.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";
import { requestManualCredit, approveManualCredit } from "../src/services/manualcredit.js";
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
    expect(after?.status).toBe("qualified");
    expect(after?.qualifiedAt?.getTime()).toBe(first?.qualifiedAt?.getTime());
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
    expect(referral?.status).toBe("qualified");
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
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
