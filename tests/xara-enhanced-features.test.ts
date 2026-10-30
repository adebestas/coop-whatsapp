import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./setup.js";
import { sendText, sendButtonsPrompt } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { generateReceiptPdf, getMemberReceiptData } from "../src/services/receipt.js";
import { extractWhatsAppMessages } from "../src/lib/inbound.js";
import { handleMessage } from "../src/services/conversation.js";

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "Xara Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("XC"), adminPhone: null } });
}

async function makeMember(phone: string, coopId: string, name = "Test Member") {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name,
      cooperativeId: coopId,
      role: "member",
      pin: hashPin("1234"),
      consentAt: new Date(),
      wallet: { create: { balance: 200000, totalSaved: 200000 } },
    },
    include: { wallet: true },
  });
}

describe("Xara-Style Visual Receipts & Interactive Features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Receipt PDF Generator", () => {
    it("generates a valid PDF buffer with transaction details", async () => {
      const buffer = await generateReceiptPdf({
        reference: "TXN-TOPUP-123456",
        type: "deposit",
        amount: 500000, // ₦5,000
        currency: "NGN",
        cooperativeName: "Lagos Agri Thrift",
        memberName: "Bisi Adeyemi",
        memberPhone: "2348011223344",
        date: new Date(),
      });

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
      // Valid PDF files start with %PDF
      expect(buffer.toString("utf8", 0, 5)).toContain("%PDF");
    });

    it("retrieves latest member receipt data from confirmed contributions", async () => {
      const coop = await makeCoop();
      const member = await makeMember("2348011229988", coop.id, "Bisi Adeyemi");

      await prisma.contribution.create({
        data: {
          memberId: member.id,
          cooperativeId: coop.id,
          amount: 350000,
          type: "topup",
          status: "confirmed",
          reference: "REC-CONTRIB-001",
          paidAt: new Date(),
        },
      });

      const receipt = await getMemberReceiptData(member.id);
      expect(receipt).not.toBeNull();
      expect(receipt!.reference).toBe("REC-CONTRIB-001");
      expect(receipt!.amount).toBe(350000);
      expect(receipt!.type).toBe("deposit");
    });
  });

  describe("Interactive Button Messages & Inbound Parsing", () => {
    it("parses WhatsApp button_reply interactive events into executable text", () => {
      const webhookPayload = {
        messages: [
          {
            id: "wamid.HBgL...",
            from: "2348011223344",
            type: "interactive",
            interactive: {
              type: "button_reply",
              button_reply: {
                id: "balance",
                title: "Check Balance",
              },
            },
          },
        ],
      };

      const extracted = extractWhatsAppMessages(webhookPayload);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].text).toBe("balance");
      expect(extracted[0].from).toBe("2348011223344");
    });

    it("sendButtonsPrompt routes successfully without errors", async () => {
      const res = await sendButtonsPrompt({
        to: "2348011223344",
        text: "What would you like to do next?",
        buttons: [
          { id: "balance", title: "Balance" },
          { id: "save", title: "Save" },
          { id: "menu", title: "Menu" },
        ],
      });
      expect(typeof res).toBe("boolean");
    });
  });

  describe("Group Ajo Split Command", () => {
    it("splits total amount equally across participants and notifies each", async () => {
      const coop = await makeCoop();
      const requester = await makeMember("2348099887766", coop.id, "Adebayo Salami");

      // Requester splits ₦30,000 across 3 people (themself + 2 friends = ₦10,000 each)
      await handleMessage(requester.phone, "split 30000 08022221111 08033332222");

      const sentTexts = vi
        .mocked(sendText)
        .mock.calls.map((c) => c[0] as { to: string; text: string });

      // Notifications sent to the 2 participants
      const participant1 = sentTexts.find((m) => m.to === "08022221111");
      const participant2 = sentTexts.find((m) => m.to === "08033332222");
      expect(participant1).toBeTruthy();
      expect(participant1!.text).toContain("Group Contribution Request");
      expect(participant1!.text).toContain("₦10,000");

      expect(participant2).toBeTruthy();
      expect(participant2!.text).toContain("Group Contribution Request");

      // Confirmation sent back to requester
      const requesterAck = sentTexts.find((m) => m.to === requester.phone);
      expect(requesterAck).toBeTruthy();
      expect(requesterAck!.text).toContain("Split request created for");
      expect(requesterAck!.text).toContain("across 3 people");
    });
  });
});
