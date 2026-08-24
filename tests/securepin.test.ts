import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText, sendSecurePrompt } from "../src/lib/messaging.js";
import { deleteTelegramMessage } from "../src/lib/telegram.js";
import { extractWhatsAppMessages } from "../src/lib/inbound.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

vi.mock("../src/lib/telegram.js", () => ({
  deleteTelegramMessage: vi.fn().mockResolvedValue(true),
}));

const PHONE = "2348012345678";

async function makeCoop(code: string, name: string) {
  return prisma.cooperative.create({ data: { name, code } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; bank?: boolean } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin("1234"),
      ...(opts.bank
        ? { bankAccountNumber: "0123456789", bankCode: "044", bankName: "Access Bank" }
        : {}),
      wallet: { create: { balance: 100000, totalSaved: 200000 } },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
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

describe("whatsapp inbound extraction", () => {
  it("extracts plain text messages", () => {
    const value = {
      messages: [{ type: "text", from: "234801", text: { body: "menu" } }],
    };
    expect(extractWhatsAppMessages(value)).toEqual([
      { from: "234801", text: "menu" },
    ]);
  });

  it("extracts flow (nfm_reply) submissions with the echoed flow token", () => {
    const value = {
      messages: [
        {
          type: "interactive",
          from: "234801",
          interactive: {
            type: "nfm_reply",
            nfm_reply: {
              response_json: JSON.stringify({ code: "1234", flow_token: "tok-1" }),
            },
          },
        },
      ],
    };
    expect(extractWhatsAppMessages(value)).toEqual([
      { from: "234801", text: "1234", flowToken: "tok-1" },
    ]);
  });

  it("drops unsupported message types like reactions", () => {
    const value = {
      messages: [
        { type: "reaction", from: "234801", reaction: { emoji: "👍" } },
        { type: "text", from: "234801", text: { body: "hi" } },
      ],
    };
    expect(extractWhatsAppMessages(value)).toEqual([{ from: "234801", text: "hi" }]);
  });
});

describe("secure PIN challenges", () => {
  it("issues a one-time flow token stored in the session when asking for the onboarding PIN", async () => {
    await makeCoop("TESTSP1", "Test Coop");
    await handleMessage(PHONE, "join TESTSP1");
    await handleMessage(PHONE, "Ada Obi");
    await handleMessage(PHONE, "skip");
    await handleMessage(PHONE, "skip");
    await handleMessage(PHONE, "Chidi Okafor");
    await handleMessage(PHONE, "08087654321");

    const prompts = vi.mocked(sendSecurePrompt).mock.calls;
    const pinPrompt = prompts.find((c) => c[0].text.includes("4-digit PIN"));
    expect(pinPrompt).toBeTruthy();

    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    const data = JSON.parse(session!.data);
    expect(data.flowToken).toBeTruthy();
    expect(pinPrompt![0].flowToken).toBe(data.flowToken);
  });

  it("rejects a flow submission whose token does not match the outstanding challenge", async () => {
    const coop = await makeCoop("TESTSP2", "Test Coop");
    const member = await makeMember(PHONE, coop.id, { bank: true });
    await prisma.session.create({
      data: {
        phone: PHONE,
        state: "awaiting_withdraw_pin",
        data: JSON.stringify({ withdrawAmount: 1000, flowToken: "tok-good" }),
      },
    });

    await handleMessage(PHONE, "1234", { flowToken: "tok-evil" });

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.toLowerCase().includes("expired"))).toBe(true);
    const count = await prisma.withdrawalRequest.count({ where: { memberId: member.id } });
    expect(count).toBe(0);
  });

  it("accepts a flow submission with the matching token", async () => {
    const coop = await makeCoop("TESTSP3", "Test Coop");
    const member = await makeMember(PHONE, coop.id, { bank: true });
    await prisma.session.create({
      data: {
        phone: PHONE,
        state: "awaiting_withdraw_pin",
        data: JSON.stringify({
          withdrawAmount: 10000,
          withdrawAccount: "0123456789",
          withdrawBankCode: "044",
          withdrawBankName: "Access Bank",
          flowToken: "tok-good",
        }),
      },
    });

    await handleMessage(PHONE, "1234", { flowToken: "tok-good" });

    const wr = await prisma.withdrawalRequest.findFirst({ where: { memberId: member.id } });
    expect(wr).not.toBeNull();
    expect(wr!.amount).toBe(10000);
  });

  it("still accepts typed PIN text when a flow challenge is outstanding", async () => {
    const coop = await makeCoop("TESTSP4", "Test Coop");
    const member = await makeMember(PHONE, coop.id, { bank: true });
    await prisma.session.create({
      data: {
        phone: PHONE,
        state: "awaiting_withdraw_pin",
        data: JSON.stringify({
          withdrawAmount: 10000,
          withdrawAccount: "0123456789",
          withdrawBankCode: "044",
          withdrawBankName: "Access Bank",
          flowToken: "tok-good",
        }),
      },
    });

    await handleMessage(PHONE, "1234");

    const wr = await prisma.withdrawalRequest.findFirst({ where: { memberId: member.id } });
    expect(wr).not.toBeNull();
  });
});

describe("telegram secret hygiene", () => {
  it("deletes the user's message after reading a PIN reply in a Telegram chat", async () => {
    await prisma.session.create({
      data: {
        phone: "tg:9999",
        state: "awaiting_withdraw_pin",
        data: JSON.stringify({ withdrawAmount: 1000 }),
      },
    });

    await handleMessage("tg:9999", "1234", { telegramMessageId: 42 });

    expect(vi.mocked(deleteTelegramMessage).mock.calls).toContainEqual(["9999", 42]);
  });
});
