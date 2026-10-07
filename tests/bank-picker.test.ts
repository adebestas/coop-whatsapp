/**
 * Task 11: bank picker + account-name confirmation.
 *
 * Two layers are covered:
 *  1. `listBanks` on the provider adapters (real Monnify/Paystack with `fetch`
 *     stubbed) plus the cached index-level helper with a static fallback.
 *  2. The reusable guided flow driven end-to-end through `handleMessage`:
 *     account -> bank list -> pick -> resolveAccount -> confirm -> continuation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monnifyAdapter } from "../src/services/payments/monnify.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { listBanks, staticBanks, clearBankCache } from "../src/services/payments/index.js";
import { resolveProvider } from "../src/services/payments/index.js";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { paymentState } from "./payment-state.js";

const MONNIFY_BASE = "https://sandbox.monnify.com";
const PAYSTACK_BASE = "https://api.paystack.co";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function stubFetch(respond: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/v1/auth/login")) {
      return jsonResponse({ responseBody: { accessToken: "tok", expiresIn: 3600 } });
    }
    return jsonResponse(respond(url, init));
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => String(c[0].text))
    .join("\n");
}

async function sessionState(phone: string) {
  return (await prisma.session.findUnique({ where: { phone } }))?.state;
}

beforeEach(async () => {
  process.env.MONNIFY_API_KEY = "test_key";
  process.env.MONNIFY_SECRET_KEY = "test_secret";
  process.env.MONNIFY_CONTRACT_CODE = "test_contract";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_x";
  clearBankCache();
  vi.clearAllMocks();
  paymentState.resolveName = "ADA OBI";
  paymentState.resolveFails = false;
  await cleanupDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore the setup.ts default resolveProvider after any per-test override.
  vi.mocked(resolveProvider).mockReset();
});

describe("provider listBanks", () => {
  it("paystack maps GET /bank?currency=NGN data to {code,name}", async () => {
    const calls = stubFetch(() => ({
      status: true,
      data: [
        { code: "058", name: "GTBank" },
        { code: "011", name: "First Bank" },
      ],
    }));

    const banks = await paystackAdapter.listBanks!();

    expect(banks).toEqual([
      { code: "058", name: "GTBank" },
      { code: "011", name: "First Bank" },
    ]);
    const call = calls.find((c) => c.url === `${PAYSTACK_BASE}/bank?currency=NGN`);
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("GET");
  });

  it("monnify maps the bank list responseBody to {code,name}", async () => {
    const calls = stubFetch(() => ({
      requestSuccessful: true,
      responseBody: [{ code: "044", name: "Access Bank" }],
    }));

    const banks = await monnifyAdapter.listBanks!();

    expect(banks).toEqual([{ code: "044", name: "Access Bank" }]);
    const call = calls.find((c) => c.url === `${MONNIFY_BASE}/api/v1/banks`);
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("GET");
  });
});

describe("listBanks helper (cache + static fallback)", () => {
  it("falls back to the static BANK_CODES map when the provider fails", async () => {
    const provider = {
      name: "x",
      listBanks: vi.fn(async () => {
        throw new Error("provider down");
      }),
    } as never;

    const banks = await listBanks(provider as never);

    expect(banks.find((b) => b.code === "044")).toBeTruthy();
    expect(banks.find((b) => b.code === "058")).toBeTruthy();
    expect(staticBanks().length).toBeGreaterThan(10);
  });

  it("falls back to static when the provider returns an empty list", async () => {
    const provider = { name: "x", listBanks: vi.fn(async () => []) } as never;
    const banks = await listBanks(provider as never);
    expect(banks.find((b) => b.code === "044")).toBeTruthy();
  });

  it("caches a successful provider list (24h) so the next call does not re-fetch", async () => {
    const fn = vi.fn(async () => [{ code: "999", name: "Cached Bank" }]);
    const provider = { name: "x", listBanks: fn } as never;

    const first = await listBanks(provider as never);
    const second = await listBanks(provider as never);

    expect(first).toEqual([{ code: "999", name: "Cached Bank" }]);
    expect(second).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("guided bank picker flow", () => {
  it("guides a mandate: account number -> bank list -> resolved name -> confirm -> PIN", async () => {
    const coop = await createTestCoop("BKP1");
    const m = await createTestMember(coop.id, { phone: "2348000400001" });
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, directDebitEnabled: true },
    });

    await handleMessage(m.phone, "mandate 5000");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_account");
    expect(textsSent()).toMatch(/account number/i);

    await handleMessage(m.phone, "0123456789");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_choice");
    expect(textsSent()).toMatch(/Access Bank/);

    await handleMessage(m.phone, "access");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_confirm");
    expect(textsSent()).toMatch(/ADA OBI/);

    await handleMessage(m.phone, "yes");
    expect(await sessionState(m.phone)).toBe("awaiting_mandate_pin");
  });

  it("lets the member retry when resolveAccount fails", async () => {
    const coop = await createTestCoop("BKP2");
    const m = await createTestMember(coop.id, { phone: "2348000400002" });
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, directDebitEnabled: true },
    });
    paymentState.resolveFails = true;

    await handleMessage(m.phone, "mandate 5000");
    await handleMessage(m.phone, "0123456789");
    await handleMessage(m.phone, "access");

    expect(await sessionState(m.phone)).toBe("awaiting_bank_choice");
    expect(textsSent()).toMatch(/couldn't confirm/i);

    // Provider recovers — the same pick now proceeds.
    paymentState.resolveFails = false;
    await handleMessage(m.phone, "access");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_confirm");
  });

  it("saves the withdrawal bank account + resolved name via the guided flow", async () => {
    const coop = await createTestCoop("BKP3");
    const m = await createTestMember(coop.id, { phone: "2348000400003" });
    await prisma.wallet.update({ where: { memberId: m.id }, data: { balance: 5_000_000 } });

    await handleMessage(m.phone, "withdraw 20000");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_account");

    await handleMessage(m.phone, "0123456789");
    await handleMessage(m.phone, "access");
    await handleMessage(m.phone, "yes");
    expect(await sessionState(m.phone)).toBe("awaiting_withdraw_pin");

    await handleMessage(m.phone, "1234");

    const req = await prisma.withdrawalRequest.findFirst({ where: { memberId: m.id } });
    expect(req?.bankCode).toBe("044");
    expect(req?.bankAccountNumber).toBe("0123456789");
    const updated = await prisma.member.findUnique({ where: { id: m.id } });
    expect(updated?.bankAccountName).toBe("ADA OBI");
  });

  it("saves a payee after the member picks a bank by name substring", async () => {
    const coop = await createTestCoop("BKP4");
    const m = await createTestMember(coop.id, { phone: "2348000400004" });

    await handleMessage(m.phone, "addpayee mama-ngozi 0123456789");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_choice");

    await handleMessage(m.phone, "gtb");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_confirm");

    await handleMessage(m.phone, "yes");
    expect(await sessionState(m.phone)).toBe("idle");

    const payee = await prisma.favoritePayee.findFirst({ where: { memberId: m.id } });
    expect(payee?.bankCode).toBe("058");
    expect(payee?.bankName).toBe("GTBank");
    expect(payee?.accountNumber).toBe("0123456789");
  });

  it("saves a payee after the member picks a bank by its list number", async () => {
    const coop = await createTestCoop("BKP5");
    const m = await createTestMember(coop.id, { phone: "2348000400005" });

    await handleMessage(m.phone, "addpayee mama-ngozi 0123456789");
    await handleMessage(m.phone, "1");
    await handleMessage(m.phone, "yes");

    const payee = await prisma.favoritePayee.findFirst({ where: { memberId: m.id } });
    // The static list's first entry is Access Bank (code 044).
    expect(payee?.bankCode).toBe("044");
  });

  it("re-prompts on an unrecognized reply and cancels on an explicit cancel", async () => {
    const coop = await createTestCoop("BKP6");
    const m = await createTestMember(coop.id, { phone: "2348000400006" });

    await handleMessage(m.phone, "addpayee mama-ngozi 0123456789");
    await handleMessage(m.phone, "access");
    await handleMessage(m.phone, "no");

    // An unrecognized reply must keep the flow alive and re-ask for confirmation.
    expect(await sessionState(m.phone)).toBe("awaiting_bank_confirm");
    expect(textsSent()).toMatch(/reply \*yes\*/i);
    expect(await prisma.favoritePayee.count()).toBe(0);

    await handleMessage(m.phone, "cancel");
    expect(await sessionState(m.phone)).toBe("idle");
    expect(await prisma.favoritePayee.count()).toBe(0);
  });

  it("prefers an exact bank-code match over a list number", async () => {
    const coop = await createTestCoop("BKP8");
    const m = await createTestMember(coop.id, { phone: "2348000400008" });
    // A live-length list where entry #44 is NOT code "044", so a naive
    // number-first match would pick the wrong bank.
    const banks = Array.from({ length: 60 }, (_, i) => ({
      code: String(900 + i),
      name: `Filler Bank ${i + 1}`,
    }));
    banks[43] = { code: "999", name: "Forty-Fourth Bank" };
    banks.push({ code: "044", name: "Access Bank" });
    vi.mocked(resolveProvider).mockResolvedValue({
      name: "monnify",
      listBanks: vi.fn(async () => banks),
      resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
      verifyWebhook: () => true,
      parseNotification: () => null,
    } as never);

    await handleMessage(m.phone, "addpayee mama-ngozi 0123456789");
    await handleMessage(m.phone, "044");
    await handleMessage(m.phone, "yes");

    const payee = await prisma.favoritePayee.findFirst({ where: { memberId: m.id } });
    expect(payee?.bankCode).toBe("044");
    expect(payee?.bankName).toBe("Access Bank");
  });

  it("starts the guided bank flow when a member replies `withdraw` without an amount", async () => {
    const coop = await createTestCoop("BKP9");
    const m = await createTestMember(coop.id, { phone: "2348000400009" });
    await prisma.wallet.update({ where: { memberId: m.id }, data: { balance: 5_000_000 } });

    await handleMessage(m.phone, "withdraw"); // no amount -> prompt for it
    expect(await sessionState(m.phone)).toBe("awaiting_withdraw_amount");

    await handleMessage(m.phone, "20000"); // amount -> no saved bank -> guided flow
    expect(await sessionState(m.phone)).toBe("awaiting_bank_account");

    await handleMessage(m.phone, "0123456789");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_choice");

    await handleMessage(m.phone, "access");
    expect(await sessionState(m.phone)).toBe("awaiting_bank_confirm");

    await handleMessage(m.phone, "yes");
    expect(await sessionState(m.phone)).toBe("awaiting_withdraw_pin");

    await handleMessage(m.phone, "1234");
    const req = await prisma.withdrawalRequest.findFirst({ where: { memberId: m.id } });
    expect(req?.bankCode).toBe("044");
    expect(req?.bankAccountNumber).toBe("0123456789");
  });

  it("re-prompts when the account number is not 10 digits", async () => {
    const coop = await createTestCoop("BKP7");
    const m = await createTestMember(coop.id, { phone: "2348000400007" });

    await handleMessage(m.phone, "addpayee mama-ngozi 123");

    expect(await sessionState(m.phone)).toBe("idle");
    expect(textsSent()).toMatch(/10 digits|account/i);
  });
});
