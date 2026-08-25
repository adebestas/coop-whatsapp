import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { notifyMember } from "../src/lib/messaging.js";
import { sendText as sendWhatsApp } from "../src/lib/whatsapp.js";
import { sendTelegramMessage, deleteTelegramMessage } from "../src/lib/telegram.js";
import { runAutoSaveReminders } from "../src/services/scheduler.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

vi.mock("../src/lib/whatsapp.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendFlowMessage: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/lib/telegram.js", () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(true),
  deleteTelegramMessage: vi.fn().mockResolvedValue(true),
}));

const PHONE = "2348012345678";

async function makeCoop(code: string, name: string) {
  return prisma.cooperative.create({ data: { name, code } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: {
    contactPhone?: string;
    altChannelId?: string;
    preferredChannel?: string;
    autosave?: boolean;
  } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      contactPhone: opts.contactPhone,
      altChannelId: opts.altChannelId,
      preferredChannel: opts.preferredChannel,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      pin: hashPin("1234"),
      ...(opts.autosave
        ? {
            autoSaveEnabled: true,
            autoSaveAmount: 2000,
            autoSaveInterval: "monthly",
            autoSaveNextDue: new Date(Date.now() - 86400000),
          }
        : {}),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.dataConsent.deleteMany();
  await prisma.posting.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.coopPost.deleteMany();
  await prisma.deductionItem.deleteMany();
  await prisma.deductionWaiver.deleteMany();
  await prisma.deductionBatch.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.beneficiary.deleteMany();
  await prisma.pollBallot.deleteMany();
  await prisma.pollOption.deleteMany();
  await prisma.purchasePoll.deleteMany();
  await prisma.externalPayment.deleteMany();
  await prisma.guarantorDeduction.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.voteBallot.deleteMany();
  await prisma.voteCandidate.deleteMany();
  await prisma.vote.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.deathValidation.deleteMany();
  await prisma.deathClaim.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.loanRepayment.deleteMany();
  await prisma.guarantor.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.dividendEntry.deleteMany();
  await prisma.dividend.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.member.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.cooperative.deleteMany();
  await prisma.session.deleteMany();
});

describe("channel linking", () => {
  it("links a Telegram join to an existing WhatsApp account instead of creating a twin", async () => {
    const coop = await makeCoop("TESTR1", "Routing Coop");
    const wa = await makeMember(PHONE, coop.id, { contactPhone: "2348087654321" });

    // Clear mock calls before OTP delivery
    vi.mocked(sendWhatsApp).mockClear();

    await handleMessage("tg:555", "join TESTR1");
    await handleMessage("tg:555", "Ada Obi");
    await handleMessage("tg:555", "YES"); // NDPR consent
    await handleMessage("tg:555", "08087654321"); // real phone → OTP sent to WhatsApp

    // OTP is now hashed in session — extract it from the WhatsApp mock calls instead
    const otpCall = vi.mocked(sendWhatsApp).mock.calls.find((c) => {
      const arg = c[0] as { to: string; text: string };
      return typeof arg === "object" && arg.text?.includes("verification code");
    });
    expect(otpCall).toBeTruthy();
    const arg = otpCall![0] as { to: string; text: string };
    const otpMatch = arg.text.match(/\*(\d{6})\*/);
    expect(otpMatch).toBeTruthy();
    const otp = otpMatch![1];

    await handleMessage("tg:555", otp);
    await handleMessage("tg:555", "skip"); // email optional
    await handleMessage("tg:555", "skip"); // birthday optional
    await handleMessage("tg:555", "Chidi Okafor");
    await handleMessage("tg:555", "08199998888"); // next of kin phone
    await handleMessage("tg:555", "1234");
    await handleMessage("tg:555", "1234");

    const count = await prisma.member.count({ where: { cooperativeId: coop.id } });
    expect(count).toBe(1);

    const updated = await prisma.member.findUnique({ where: { id: wa.id } });
    expect(updated!.altChannelId).toBe("tg:555");

    const texts = vi.mocked(sendTelegramMessage).mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes("alerts"))).toBe(true);
  });

  it("learns preferredChannel from the primary platform on every message", async () => {
    const coop = await makeCoop("TESTR2", "Routing Coop");
    await makeMember(PHONE, coop.id);

    await handleMessage(PHONE, "menu");

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.preferredChannel).toBe("whatsapp");
  });

  it("treats a linked alternate channel as alerts-only and learns preference from it", async () => {
    const coop = await makeCoop("TESTR3", "Routing Coop");
    await makeMember(PHONE, coop.id, { altChannelId: "tg:556" });

    await handleMessage("tg:556", "balance");

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.preferredChannel).toBe("telegram");

    const tgTexts = vi.mocked(sendTelegramMessage).mock.calls.map((c) => String(c[1]));
    expect(tgTexts.some((t) => t.includes("alerts"))).toBe(true);
    // No banking data may leak on the notifications-only channel.
    expect(tgTexts.some((t) => t.includes("NGN"))).toBe(false);
  });
});

describe("notifyMember routing", () => {
  it("sends via the linked Telegram channel when that is the member's preference", async () => {
    await notifyMember(
      { phone: PHONE, altChannelId: "tg:557", preferredChannel: "telegram" },
      "Loan approved 🎉",
    );
    expect(vi.mocked(sendTelegramMessage)).toHaveBeenCalledWith("557", "Loan approved 🎉");
    expect(vi.mocked(sendWhatsApp)).not.toHaveBeenCalled();
  });

  it("falls back to the primary channel when no alternate exists", async () => {
    await notifyMember({ phone: PHONE, preferredChannel: "telegram" }, "Loan approved 🎉");
    expect(vi.mocked(sendWhatsApp)).toHaveBeenCalledWith(
      { to: PHONE, text: "Loan approved 🎉" },
    );
    expect(vi.mocked(sendTelegramMessage)).not.toHaveBeenCalled();
  });

  it("keeps primary-channel members untouched (no duplicate sends)", async () => {
    await notifyMember(
      { phone: PHONE, altChannelId: "tg:557", preferredChannel: "whatsapp" },
      "Statement ready",
    );
    expect(vi.mocked(sendWhatsApp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramMessage)).not.toHaveBeenCalled();
  });
});

describe("notification fan-out integration", () => {
  it("routes autosave reminders through the member's preferred channel", async () => {
    const coop = await makeCoop("TESTR4", "Routing Coop");
    await makeMember(PHONE, coop.id, {
      autosave: true,
      altChannelId: "tg:558",
      preferredChannel: "telegram",
    });

    await runAutoSaveReminders(new Date());

    expect(vi.mocked(sendTelegramMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsApp)).not.toHaveBeenCalled();
  });
});
