/**
 * A12: adapter-level tests for the real provider money-out paths.
 *
 * `tests/setup.ts` globally mocks `resolveProvider()`, so the rest of the suite
 * never exercises the real request construction of `payout`,
 * `createVirtualAccount` or `resolveAccount` — a units/currency/URL regression
 * in the money-out path would ship green. These tests import the adapters
 * directly and stub global `fetch` to assert the outgoing URL, method, auth
 * header, amount units and body — mirroring `tests/bank-picker.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monnifyAdapter } from "../src/services/payments/monnify.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { flutterwaveAdapter } from "../src/services/payments/flutterwave.js";

const MONNIFY_BASE = "https://sandbox.monnify.com";
const PAYSTACK_BASE = "https://api.paystack.co";
const FLW_BASE = "https://api.flutterwave.com/v3";

interface Call {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(respond: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
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

function bodyOf(call: Call): any {
  return call.init?.body ? JSON.parse(String(call.init.body)) : undefined;
}

function headersOf(call: Call): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  process.env.MONNIFY_API_KEY = "test_key";
  process.env.MONNIFY_SECRET_KEY = "test_secret";
  process.env.MONNIFY_CONTRACT_CODE = "test_contract";
  process.env.MONNIFY_TRANSFER_OTP = "123456";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_x";
  process.env.FLUTTERWAVE_SECRET_KEY = "flw_test_x";
  delete process.env.PAYSTACK_TRANSFER_SOURCE;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("monnify adapter", () => {
  it("payout initiates + completes a transfer in naira with the right body", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/api/v2/disbursements/single")) {
        return {
          requestSuccessful: true,
          responseBody: { reference: "MFY-1", transferReference: "TRF-1", status: "PENDING" },
        };
      }
      if (url.endsWith("/api/v2/disbursements/single/complete")) {
        return { requestSuccessful: true, responseBody: { status: "SUCCESS" } };
      }
      return {};
    });

    const result = await monnifyAdapter.payout!({
      amount: 50_000, // kobo -> ₦500
      bankAccountNumber: "0123456789",
      bankCode: "058",
      recipientName: "ADA OBI",
      reference: "TFR-WDR-abcdef12",
      currency: "NGN",
    });

    expect(result).toEqual({ ok: true, providerRef: "MFY-1" });

    const init = calls.find((c) => c.url === `${MONNIFY_BASE}/api/v2/disbursements/single`)!;
    expect(init.init?.method).toBe("POST");
    expect(headersOf(init).Authorization).toBe("Bearer tok");
    const initBody = bodyOf(init);
    expect(initBody.amount).toBe(500); // naira, not kobo
    expect(initBody.currency).toBe("NGN");
    expect(initBody.bankCode).toBe("058");
    expect(initBody.bankAccountNumber).toBe("0123456789");
    expect(initBody.destinationAccountName).toBe("ADA OBI");
    expect(initBody.reference).toBe("TFR-WDR-abcdef12");
    expect(initBody.narration).toContain("abcdef12");

    const complete = calls.find(
      (c) => c.url === `${MONNIFY_BASE}/api/v2/disbursements/single/complete`,
    )!;
    expect(complete.init?.method).toBe("POST");
    expect(bodyOf(complete)).toEqual({ reference: "TRF-1", authorizationCode: "123456" });
  });

  it("payout reports pending (not failed) when the transfer was initiated but has no OTP", async () => {
    delete process.env.MONNIFY_TRANSFER_OTP;
    stubFetch(() => ({
      requestSuccessful: true,
      responseBody: { reference: "MFY-2", transferReference: "TRF-2", status: "PENDING" },
    }));

    const result = await monnifyAdapter.payout!({
      amount: 10_000,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      recipientName: "ADA OBI",
      reference: "TFR-WDR-2",
    });

    expect(result.ok).toBe(false);
    expect(result.pending).toBe(true);
  });

  it("createVirtualAccount reserves an account and maps the response", async () => {
    const calls = stubFetch(() => ({
      requestSuccessful: true,
      responseBody: {
        accountNumber: "1234567890",
        bankName: "Wema Bank",
        accountReference: "MEM-1",
        reservationReference: "RES-1",
      },
    }));

    const va = await monnifyAdapter.createVirtualAccount!({
      phone: "2348000000000",
      name: "Ada Obi",
      reference: "MEM-1",
      currency: "NGN",
    });

    expect(va).toEqual({
      accountNumber: "1234567890",
      bank: "Wema Bank",
      provider: "monnify",
      providerRef: "RES-1",
    });

    const call = calls.find(
      (c) => c.url === `${MONNIFY_BASE}/api/v2/bank-transfer/reserved-accounts`,
    )!;
    expect(call.init?.method).toBe("POST");
    const body = bodyOf(call);
    expect(body.contractCode).toBe("test_contract");
    expect(body.accountReference).toBe("MEM-1");
    expect(body.accountName).toBe("Ada Obi");
    expect(body.currencyCode).toBe("NGN");
  });

  it("resolveAccount GETs the account-details endpoint and maps accountName", async () => {
    const calls = stubFetch(() => ({
      requestSuccessful: true,
      responseBody: { accountName: "ADA OBI" },
    }));

    const resolved = await monnifyAdapter.resolveAccount!({
      accountNumber: "0123456789",
      bankCode: "058",
    });

    expect(resolved).toEqual({ ok: true, name: "ADA OBI" });
    const call = calls.find((c) => c.url.includes("/api/v1/disbursements/account-details"))!;
    expect(call.init?.method).toBe("GET");
    expect(call.url).toBe(
      `${MONNIFY_BASE}/api/v1/disbursements/account-details?accountNumber=0123456789&bankCode=058`,
    );
  });
});

describe("paystack adapter", () => {
  it("payout creates a recipient then a transfer, keeping the amount in kobo", async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith(`${PAYSTACK_BASE}/transferrecipient?`)) {
        return { status: true, data: [] };
      }
      if (url === `${PAYSTACK_BASE}/transferrecipient`) {
        return { status: true, data: { recipient_code: "RCP_1" } };
      }
      if (url === `${PAYSTACK_BASE}/transfer`) {
        return { status: true, data: { transfer_code: "TRF_1" } };
      }
      return { status: true, data: {} };
    });

    const result = await paystackAdapter.payout!({
      amount: 50_000, // kobo stays kobo for Paystack
      bankAccountNumber: "0123456789",
      bankCode: "058",
      recipientName: "ADA OBI",
      reference: "TFR-WDR-abcd1234",
      currency: "NGN",
    });

    expect(result).toEqual({ ok: true, providerRef: "TRF_1" });

    const search = calls.find((c) => c.url.startsWith(`${PAYSTACK_BASE}/transferrecipient?`))!;
    expect(search.init?.method).toBe("GET");
    expect(search.url).toContain("account_number=0123456789");
    expect(search.url).toContain("bank_code=058");

    const createRecipient = calls.find((c) => c.url === `${PAYSTACK_BASE}/transferrecipient`)!;
    expect(createRecipient.init?.method).toBe("POST");
    expect(headersOf(createRecipient).Authorization).toBe("Bearer sk_test_x");
    expect(bodyOf(createRecipient)).toEqual({
      type: "nuban",
      name: "ADA OBI",
      account_number: "0123456789",
      bank_code: "058",
      currency: "NGN",
    });

    const transfer = calls.find((c) => c.url === `${PAYSTACK_BASE}/transfer`)!;
    expect(transfer.init?.method).toBe("POST");
    const transferBody = bodyOf(transfer);
    expect(transferBody.amount).toBe(50_000); // kobo
    expect(transferBody.reference).toBe("TFR-WDR-abcd1234");
    expect(transferBody.recipient).toBe("RCP_1"); // recipient_code, not bank_code
    expect(transferBody.source).toBe("balance");
  });

  it("createVirtualAccount creates the customer when none exists, then assigns a DVA", async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith(`${PAYSTACK_BASE}/customer/`)) {
        return { status: false, message: "Customer not found" }; // -> api() throws -> create
      }
      if (url === `${PAYSTACK_BASE}/customer`) {
        return { status: true, data: { customer_code: "CUS_1" } };
      }
      if (url === `${PAYSTACK_BASE}/dedicated_account`) {
        return {
          status: true,
          data: { bank: { name: "Wema Bank" }, assignments: [{ account_number: "9998887776" }] },
        };
      }
      return { status: true, data: {} };
    });

    const va = await paystackAdapter.createVirtualAccount!({
      phone: "2348000000000",
      name: "Ada Obi",
      reference: "MEM-2",
      currency: "NGN",
    });

    expect(va).toEqual({
      accountNumber: "9998887776",
      bank: "Wema Bank",
      provider: "paystack",
      providerRef: "CUS_1",
    });

    const createCustomer = calls.find((c) => c.url === `${PAYSTACK_BASE}/customer`)!;
    expect(createCustomer.init?.method).toBe("POST");
    expect(bodyOf(createCustomer).email).toBe("MEM-2@coop.local");

    const dva = calls.find((c) => c.url === `${PAYSTACK_BASE}/dedicated_account`)!;
    expect(dva.init?.method).toBe("POST");
    expect(bodyOf(dva).customer).toBe("CUS_1");
  });

  it("resolveAccount GETs /bank/resolve and maps account_name", async () => {
    const calls = stubFetch(() => ({ status: true, data: { account_name: "ADA OBI" } }));

    const resolved = await paystackAdapter.resolveAccount!({
      accountNumber: "0123456789",
      bankCode: "058",
    });

    expect(resolved).toEqual({ ok: true, name: "ADA OBI" });
    const call = calls.find((c) => c.url.startsWith(`${PAYSTACK_BASE}/bank/resolve?`))!;
    expect(call.init?.method).toBe("GET");
    expect(call.url).toBe(`${PAYSTACK_BASE}/bank/resolve?account_number=0123456789&bank_code=058`);
  });
});

describe("flutterwave adapter", () => {
  it("payout POSTs /transfers in naira with the right body", async () => {
    const calls = stubFetch(() => ({
      status: "success",
      data: { id: "1", reference: "TFR-WDR-ff00ff00", flw_ref: "FLW-1", status: "SUCCESSFUL" },
    }));

    const result = await flutterwaveAdapter.payout!({
      amount: 50_000, // kobo -> ₦500
      bankAccountNumber: "0123456789",
      bankCode: "058",
      recipientName: "ADA OBI",
      reference: "TFR-WDR-ff00ff00",
      currency: "NGN",
    });

    expect(result).toEqual({ ok: true, providerRef: "FLW-1", error: undefined });

    const call = calls.find((c) => c.url === `${FLW_BASE}/transfers`)!;
    expect(call.init?.method).toBe("POST");
    expect(headersOf(call).Authorization).toBe("Bearer flw_test_x");
    const body = bodyOf(call);
    expect(body.amount).toBe(500); // naira, not kobo
    expect(body.currency).toBe("NGN");
    expect(body.account_number).toBe("0123456789");
    expect(body.account_bank).toBe("058");
    expect(body.beneficiary_name).toBe("ADA OBI");
    expect(body.reference).toBe("TFR-WDR-ff00ff00");
  });

  it("createVirtualAccount POSTs /virtual-account-numbers and maps the response", async () => {
    const calls = stubFetch(() => ({
      status: "success",
      data: {
        account_number: "5556667778",
        bank_name: "Flutterwave MFB",
        bank_code: "090",
        account_name: "Ada Obi",
        reference: "MEM-3",
        flw_ref: "FLW-VA-1",
      },
    }));

    const va = await flutterwaveAdapter.createVirtualAccount!({
      phone: "2348000000000",
      name: "Ada Obi",
      reference: "MEM-3",
      currency: "NGN",
    });

    expect(va).toEqual({
      accountNumber: "5556667778",
      bank: "Flutterwave MFB",
      provider: "flutterwave",
      providerRef: "FLW-VA-1",
    });

    const call = calls.find((c) => c.url === `${FLW_BASE}/virtual-account-numbers`)!;
    expect(call.init?.method).toBe("POST");
    const body = bodyOf(call);
    expect(body.tx_ref).toBe("MEM-3");
    expect(body.currency).toBe("NGN");
    expect(body.email).toBe("2348000000000@coop.placeholder");
  });

  it("resolveAccount POSTs /accounts/resolve and maps account_name", async () => {
    const calls = stubFetch(() => ({
      status: "success",
      data: { account_name: "ADA OBI", account_number: "0123456789", bank_code: "058" },
    }));

    const resolved = await flutterwaveAdapter.resolveAccount!({
      accountNumber: "0123456789",
      bankCode: "058",
    });

    expect(resolved).toEqual({ ok: true, name: "ADA OBI" });
    const call = calls.find((c) => c.url === `${FLW_BASE}/accounts/resolve`)!;
    expect(call.init?.method).toBe("POST");
    expect(bodyOf(call)).toEqual({ account_number: "0123456789", account_bank: "058" });
  });
});
