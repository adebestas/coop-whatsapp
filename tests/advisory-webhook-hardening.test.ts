import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { paymentState } from "./payment-state.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { extractWhatsAppMessages } from "../src/lib/inbound.js";
import { requestWithdrawal, finalizeWithdrawal } from "../src/services/withdrawals.js";

// NOTE: tests/setup.ts registers the payments + disbursements mocks BEFORE the
// app is imported, so a per-file vi.mock of those modules is inert. The bank
// rail is driven through tests/payment-state.ts instead (see that file).

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Flood Coop ${code}`, code } });
}

async function makeMember(
  coopId: string,
  opts: { role?: string; balance?: number; bank?: boolean } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  const balance = opts.balance ?? 0;
  return prisma.member.create({
    data: {
      code,
      phone: `2348${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      name: `Flood Member ${code}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      status: "active",
      pin: hashPin("1234"),
      ...(opts.bank === false
        ? {}
        : { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" }),
      wallet: { create: { balance, totalSaved: balance } },
    },
    include: { wallet: true },
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
  // Provider resolves every account to the member's own name and pays cleanly,
  // so the concurrency guards - not KYC name-matching - are what we measure.
  paymentState.resolveFails = false;
  paymentState.payoutFails = false;
});

// ===========================================================================
// PART 1.3 - Corrupted / unmapped WhatsApp payloads must never reach a
// financial handler. `extractWhatsAppMessages` is the ingest boundary.
// ===========================================================================
describe("WhatsApp payload edge cases (corrupted / unmapped types)", () => {
  const FROM = "2348011111111";

  it("does not throw and yields nothing when message.text is missing", () => {
    const result = extractWhatsAppMessages({
      messages: [{ from: FROM, type: "text" }], // no .text.body
    });
    expect(result).toEqual([]);
  });

  it("does not throw on a completely malformed change.value", () => {
    expect(extractWhatsAppMessages(null)).toEqual([]);
    expect(extractWhatsAppMessages(undefined)).toEqual([]);
    expect(extractWhatsAppMessages({ messages: "not-an-array" })).toEqual([]);
    expect(extractWhatsAppMessages({ messages: [{}] })).toEqual([]);
  });

  it("drops images, documents, locations, contacts, stickers and reactions", () => {
    for (const type of ["image", "document", "location", "contacts", "sticker", "reaction"]) {
      expect(extractWhatsAppMessages({ messages: [{ from: FROM, type }] })).toEqual([]);
    }
  });

  it("treats a malformed Flow (nfm_reply) response_json as an empty, unusable reply", () => {
    const result = extractWhatsAppMessages({
      messages: [
        {
          from: FROM,
          type: "interactive",
          interactive: { type: "nfm_reply", nfm_reply: { response_json: "{not valid json" } },
        },
      ],
    });
    expect(result).toEqual([]);
  });

  it("still extracts valid text and audio payloads", () => {
    expect(
      extractWhatsAppMessages({
        messages: [{ from: FROM, type: "text", text: { body: "save 5000" } }],
      }),
    ).toEqual([{ from: FROM, text: "save 5000" }]);
    expect(
      extractWhatsAppMessages({
        messages: [{ from: FROM, type: "audio", audio: { id: "media-1" } }],
      }),
    ).toEqual([{ from: FROM, text: "", audio: { mediaId: "media-1" } }]);
  });
});

// ===========================================================================
// PART 1.1 - Multi-packet flood: the same user hammers withdraw/finalize.
// Money must move AT MOST once.
// ===========================================================================
describe("withdrawal flood (concurrent webhook deliveries)", () => {
  it("pays a single request exactly once under a concurrent finalize flood", async () => {
    const coop = await makeCoop("FLOOD1");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const borrower = await makeMember(coop.id, { balance: 100_000 });
    paymentState.resolveName = borrower.name;
    const req = await makeWithdrawal(coop.id, borrower.id, 40_000);

    const actor = { id: admin.id, role: "superadmin", phone: admin.phone, cooperativeId: coop.id };

    // 8 identical packets land "simultaneously".
    const results = await Promise.all(
      Array.from({ length: 8 }, () => finalizeWithdrawal(req.id, actor)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: borrower.id } });
    expect(wallet.balance).toBe(60_000); // debited exactly once
    expect(wallet.balance).toBeGreaterThanOrEqual(0);

    const row = await prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe("paid");

    // The bank rail was hit exactly once for this request.
    const payouts = await prisma.payout.count({
      where: { idempotencyKey: `TFR-WDR-${req.id}` },
    });
    expect(payouts).toBe(1);
  });

  it("never over-debits when several distinct requests are finalized at once", async () => {
    const coop = await makeCoop("FLOOD2");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const borrower = await makeMember(coop.id, { balance: 50_000 });
    paymentState.resolveName = borrower.name;

    // 3 requests of 40k each against a 50k balance: only one can be covered.
    const reqs = await Promise.all([
      makeWithdrawal(coop.id, borrower.id, 40_000),
      makeWithdrawal(coop.id, borrower.id, 40_000),
      makeWithdrawal(coop.id, borrower.id, 40_000),
    ]);

    const actor = { id: admin.id, role: "superadmin", phone: admin.phone, cooperativeId: coop.id };
    const results = await Promise.all(reqs.map((r) => finalizeWithdrawal(r.id, actor)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: borrower.id } });
    expect(wallet.balance).toBe(10_000);
    expect(wallet.balance).toBeGreaterThanOrEqual(0); // never negative
  });

  it("does not move money while requests are only being created (flood of requests)", async () => {
    const coop = await makeCoop("FLOOD3");
    const borrower = await makeMember(coop.id, { balance: 100_000 });

    await Promise.all(Array.from({ length: 6 }, () => requestWithdrawal(borrower.phone, 20_000)));

    // Creating a request is not a payout: no wallet movement, no bank rail.
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { memberId: borrower.id } });
    expect(wallet.balance).toBe(100_000);
    expect(await prisma.payout.count()).toBe(0);
  });
});
