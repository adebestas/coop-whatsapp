/**
 * Provider mandate methods (Task 2). These tests exercise the REAL Monnify and
 * Paystack adapters with `global.fetch` stubbed — the app-wide payments mock in
 * tests/setup.ts only replaces `src/services/payments/index.js`, so importing the
 * concrete adapters directly keeps them live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monnifyAdapter } from "../src/services/payments/monnify.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";

const MONNIFY_BASE = "https://sandbox.monnify.com";
const MONNIFY_MANDATE_URL = `${MONNIFY_BASE}/api/v1/disbursements/mandate`;
const MONNIFY_DEBIT_URL = `${MONNIFY_BASE}/api/v1/disbursements/debit`;
const PAYSTACK_BASE = "https://api.paystack.co";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/**
 * Stub `global.fetch`. Monnify's adapter authenticates first, so the login
 * endpoint is answered automatically; everything else is routed to `respond`.
 * Returns the recorded calls so tests can assert on URL + method + body.
 */
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

function bodyOf(init?: RequestInit): any {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

beforeEach(() => {
  process.env.MONNIFY_API_KEY = "test_key";
  process.env.MONNIFY_SECRET_KEY = "test_secret";
  process.env.MONNIFY_CONTRACT_CODE = "test_contract";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_x";
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("monnify mandate adapter", () => {
  it("createMandate POSTs the mandate path and returns the code + authorization link", async () => {
    const calls = stubFetch(() => ({
      requestSuccessful: true,
      responseBody: {
        mandateCode: "MTDD|X",
        authorizationLink: "https://monnify.test/consent",
        mandateStatus: "PENDING_AUTHORIZATION",
      },
    }));

    const result = await monnifyAdapter.createMandate!({
      memberName: "Ada Obi",
      memberEmail: "ada@coop.local",
      memberPhone: "2348010000001",
      accountNumber: "0123456789",
      bankCode: "044",
      accountName: "ADA OBI",
      amountCap: 500_000, // kobo -> N5,000
      reference: "MAN-1",
      narration: "Coop mandate",
      redirectUrl: "https://coop.test/cb",
    });

    expect(result).toEqual({
      ok: true,
      providerMandateId: "MTDD|X",
      authorizationUrl: "https://monnify.test/consent",
      status: "PENDING_AUTHORIZATION",
    });

    const mandateCall = calls.find((c) => c.url === MONNIFY_MANDATE_URL);
    expect(mandateCall).toBeDefined();
    expect(mandateCall!.init?.method).toBe("POST");
    const body = bodyOf(mandateCall!.init);
    expect(body.mandateAmount).toBe(5000); // Monnify takes naira
    expect(body.customerAccountDetails).toEqual({
      accountNumber: "0123456789",
      bankCode: "044",
      accountName: "ADA OBI",
    });
    expect(body.redirectUrl).toBe("https://coop.test/cb");
  });

  it("debitMandate POSTs the debit path and returns the debit status", async () => {
    const calls = stubFetch(() => ({
      requestSuccessful: true,
      responseBody: { transactionReference: "TRX-1", debitStatus: "SUCCESSFUL" },
    }));

    const result = await monnifyAdapter.debitMandate!({
      providerMandateId: "MTDD|X",
      amount: 100_000, // kobo -> N1,000
      reference: "DD-1",
      narration: "savings",
    });

    expect(result).toEqual({ ok: true, providerRef: "TRX-1", status: "SUCCESSFUL" });
    const call = calls.find((c) => c.url === MONNIFY_DEBIT_URL);
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("POST");
    expect(bodyOf(call!.init).amount).toBe(1000);
    expect(bodyOf(call!.init).mandateId).toBe("MTDD|X");
  });

  it("cancelMandate PUTs the mandate path with action CANCEL", async () => {
    const calls = stubFetch(() => ({ requestSuccessful: true, responseBody: {} }));

    const result = await monnifyAdapter.cancelMandate!({ providerMandateId: "MTDD|X" });

    expect(result.ok).toBe(true);
    const call = calls.find((c) => c.url.startsWith(`${MONNIFY_MANDATE_URL}/`));
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("PUT");
    expect(bodyOf(call!.init)).toEqual({ action: "CANCEL" });
    expect(decodeURIComponent(call!.url)).toContain("MTDD|X");
  });

  it("parseMandateNotification maps a MANDATE_UPDATE activation", () => {
    const parsed = monnifyAdapter.parseMandateNotification!({
      eventType: "MANDATE_UPDATE",
      eventData: { mandateCode: "MTDD|X", mandateStatus: "ACTIVATED" },
    });
    expect(parsed).toMatchObject({
      providerMandateId: "MTDD|X",
      status: "active",
      provider: "monnify",
    });
  });

  it("parseDebitNotification maps a successful disbursement", () => {
    const parsed = monnifyAdapter.parseDebitNotification!({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-1", status: "SUCCESSFUL" },
    });
    expect(parsed).toMatchObject({ reference: "DD-1", status: "successful", provider: "monnify" });
  });
});

describe("paystack mandate adapter", () => {
  it("createMandate POSTs /customer/authorization/initialize with channel direct_debit", async () => {
    const calls = stubFetch(() => ({
      status: true,
      data: { reference: "AUTH_REF", redirect_url: "https://paystack.test/redirect" },
    }));

    const result = await paystackAdapter.createMandate!({
      memberName: "Ada Obi",
      memberEmail: "ada@coop.local",
      memberPhone: "2348010000001",
      accountNumber: "0123456789",
      bankCode: "044",
      accountName: "ADA OBI",
      amountCap: 500_000,
      reference: "MAN-1",
      redirectUrl: "https://coop.test/cb",
    });

    expect(result.ok).toBe(true);
    expect(result.providerMandateId).toBe("AUTH_REF");
    expect(result.authorizationUrl).toBe("https://paystack.test/redirect");
    const call = calls.find((c) => c.url === `${PAYSTACK_BASE}/customer/authorization/initialize`);
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("POST");
    const body = bodyOf(call!.init);
    expect(body.channel).toBe("direct_debit");
    expect(body.callback_url).toBe("https://coop.test/cb");
    expect(body.email).toBe("ada@coop.local");
  });

  it("debitMandate POSTs /transaction/partial_debit with the authorization code", async () => {
    const calls = stubFetch(() => ({
      status: true,
      data: { reference: "PDF-1", status: "success" },
    }));

    const result = await paystackAdapter.debitMandate!({
      providerMandateId: "AUTH_X",
      amount: 250_000,
      reference: "DD-1",
    });

    expect(result).toEqual({ ok: true, providerRef: "PDF-1", status: "success" });
    const call = calls.find((c) => c.url === `${PAYSTACK_BASE}/transaction/partial_debit`);
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("POST");
    const body = bodyOf(call!.init);
    expect(body.authorization_code).toBe("AUTH_X");
    expect(body.amount).toBe(250_000); // Paystack keeps kobo
    expect(body.currency).toBe("NGN");
  });

  it("cancelMandate DELETEs /customer/authorization/{code}", async () => {
    const calls = stubFetch(() => ({ status: true, data: {} }));

    const result = await paystackAdapter.cancelMandate!({ providerMandateId: "AUTH_X" });

    expect(result.ok).toBe(true);
    const call = calls.find((c) => c.url === `${PAYSTACK_BASE}/customer/authorization/AUTH_X`);
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe("DELETE");
  });

  it("parseMandateNotification maps direct_debit.authorization.created", () => {
    const parsed = paystackAdapter.parseMandateNotification!({
      event: "direct_debit.authorization.created",
      data: { authorization_code: "AUTH_X", active: true },
    });
    expect(parsed).toMatchObject({
      providerMandateId: "AUTH_X",
      status: "active",
      provider: "paystack",
    });
  });

  it("parseDebitNotification maps a partial_debit success", () => {
    const parsed = paystackAdapter.parseDebitNotification!({
      event: "partial_debit.success",
      data: { reference: "DD-1", id: 99 },
    });
    expect(parsed).toMatchObject({ reference: "DD-1", status: "successful", provider: "paystack" });
  });
});
