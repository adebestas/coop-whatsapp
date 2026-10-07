/**
 * Provider mandate methods (Task 2). These tests exercise the REAL Monnify and
 * Paystack adapters with `global.fetch` stubbed — the app-wide payments mock in
 * tests/setup.ts only replaces `src/services/payments/index.js`, so importing the
 * concrete adapters directly keeps them live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monnifyAdapter } from "../src/services/payments/monnify.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { resolveProvider } from "../src/services/payments/index.js";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { sendText } from "../src/lib/messaging.js";
import {
  createMandate,
  listMandates,
  listCoopMandates,
  cancelMandate,
  applyMandateStatus,
  pauseMandate,
  resumeMandate,
  skipDebit,
} from "../src/services/mandates.js";

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

// ===== Task 3: mandate lifecycle service =====

const actor = (m: { id: string; phone: string; role: string }) => ({
  id: m.id,
  phone: m.phone,
  role: m.role,
});

/** A fake provider adapter; only the mandate methods this service calls. */
function fakeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    name: "monnify",
    createMandate: vi.fn(async () => ({
      ok: true,
      providerMandateId: "MTDD|X",
      authorizationUrl: "https://monnify.test/consent",
      status: "PENDING_AUTHORIZATION",
    })),
    cancelMandate: vi.fn(async () => ({ ok: true })),
    debitMandate: vi.fn(async () => ({ ok: true, providerRef: "TRX-1", status: "SUCCESSFUL" })),
    resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
    verifyWebhook: () => true,
    parseNotification: () => null,
    ...overrides,
  } as never;
}

async function enableDirectDebit(coopId: string, maxCap = 0) {
  await prisma.cooperativeConfig.create({
    data: { cooperativeId: coopId, directDebitEnabled: true, directDebitMaxCap: maxCap },
  });
}

async function setBank(memberId: string) {
  await prisma.member.update({
    where: { id: memberId },
    data: {
      bankAccountNumber: "0123456789",
      bankCode: "044",
      bankName: "GTB",
      email: "ada@coop.local",
    },
  });
}

async function seedMandate(
  coopId: string,
  memberId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.mandate.create({
    data: {
      cooperativeId: coopId,
      memberId,
      provider: "monnify",
      providerMandateId: "MTDD|X",
      providerReference: `MAN-${Math.random().toString(36).slice(2)}`,
      status: "active",
      amountCap: 100_000,
      bankAccountNumber: "0123456789",
      bankCode: "044",
      ...overrides,
    },
  });
}

describe("mandate lifecycle service", () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("refuses to create a mandate when direct debit is not enabled", async () => {
    const coop = await createTestCoop("MND1");
    const m = await createTestMember(coop.id, { phone: "2348000100001" });

    const res = await createMandate(coop.id, m.id, 100_000, actor(m));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not enabled/i);
    expect(await prisma.mandate.count()).toBe(0);
  });

  it("refuses to create a mandate when the member has no saved bank account", async () => {
    const coop = await createTestCoop("MND2");
    const m = await createTestMember(coop.id, { phone: "2348000100002" });
    await enableDirectDebit(coop.id);

    const res = await createMandate(coop.id, m.id, 100_000, actor(m));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/bank account/i);
  });

  it("creates a pending mandate and returns the provider authorization link", async () => {
    const coop = await createTestCoop("MND3");
    const m = await createTestMember(coop.id, { phone: "2348000100003" });
    await enableDirectDebit(coop.id);
    await setBank(m.id);
    vi.mocked(resolveProvider).mockResolvedValue(fakeAdapter());

    const res = await createMandate(coop.id, m.id, 100_000, actor(m));
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe("https://monnify.test/consent");
    expect(res.mandateId).toBeTruthy();

    const row = await prisma.mandate.findUnique({ where: { id: res.mandateId! } });
    expect(row?.status).toBe("pending");
    expect(row?.authorizationUrl).toBe("https://monnify.test/consent");
    expect(row?.providerMandateId).toBe("MTDD|X");
    expect(row?.providerReference.startsWith("MAN-")).toBe(true);
  });

  it("refuses a cap above the cooperative's directDebitMaxCap", async () => {
    const coop = await createTestCoop("MND4");
    const m = await createTestMember(coop.id, { phone: "2348000100004" });
    await enableDirectDebit(coop.id, 100_000);
    await setBank(m.id);

    const res = await createMandate(coop.id, m.id, 200_000, actor(m));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/cap|limit|most/i);
    expect(await prisma.mandate.count()).toBe(0);
  });

  it("refuses a second mandate when the member already has an active one", async () => {
    const coop = await createTestCoop("MND13");
    const m = await createTestMember(coop.id, { phone: "2348000100013" });
    await enableDirectDebit(coop.id);
    await setBank(m.id);
    await seedMandate(coop.id, m.id); // status: active
    vi.mocked(resolveProvider).mockResolvedValue(fakeAdapter());

    const res = await createMandate(coop.id, m.id, 100_000, actor(m));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/already/i);
    expect(await prisma.mandate.count()).toBe(1);
  });

  it("cancels a mandate and calls the provider cancel", async () => {
    const coop = await createTestCoop("MND5");
    const m = await createTestMember(coop.id, { phone: "2348000100005" });
    const mandate = await seedMandate(coop.id, m.id);
    const adapter = fakeAdapter();
    vi.mocked(resolveProvider).mockResolvedValue(adapter);

    const res = await cancelMandate(coop.id, mandate.id, actor(m));
    expect(res.ok).toBe(true);
    expect(vi.mocked(adapter.cancelMandate)).toHaveBeenCalledTimes(1);

    const row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledAt).toBeInstanceOf(Date);
  });

  it("applies a webhook status flip and stamps authorizedAt on activation", async () => {
    const coop = await createTestCoop("MND6");
    const m = await createTestMember(coop.id, { phone: "2348000100006" });
    const mandate = await seedMandate(coop.id, m.id, { status: "pending" });

    await applyMandateStatus("monnify", "MTDD|X", "active");

    const row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.status).toBe("active");
    expect(row?.authorizedAt).toBeInstanceOf(Date);
  });

  it("pauses and resumes the whole mandate", async () => {
    const coop = await createTestCoop("MND7");
    const m = await createTestMember(coop.id, { phone: "2348000100007" });
    const mandate = await seedMandate(coop.id, m.id);

    const paused = await pauseMandate(coop.id, mandate.id, null, actor(m));
    expect(paused.ok).toBe(true);
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe("paused");

    const resumed = await resumeMandate(coop.id, mandate.id, null, actor(m));
    expect(resumed.ok).toBe(true);
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe("active");
  });

  it("pauses and resumes a single purpose", async () => {
    const coop = await createTestCoop("MND8");
    const m = await createTestMember(coop.id, { phone: "2348000100008" });
    const mandate = await seedMandate(coop.id, m.id);

    await pauseMandate(coop.id, mandate.id, "savings", actor(m));
    let row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.pausedPurposes.split(",")).toContain("savings");
    expect(row?.status).toBe("active");

    await resumeMandate(coop.id, mandate.id, "savings", actor(m));
    row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.pausedPurposes.split(",")).not.toContain("savings");
  });

  it("skips a pending debit so it is never retried", async () => {
    const coop = await createTestCoop("MND9");
    const m = await createTestMember(coop.id, { phone: "2348000100009" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "pending",
        providerRef: "DD-SKIP-1",
      },
    });

    const res = await skipDebit(coop.id, debit.id, actor(m));
    expect(res.ok).toBe(true);
    expect((await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status).toBe(
      "skipped",
    );
  });

  it("cancels a mandate by an id prefix or suffix", async () => {
    const coop = await createTestCoop("MND12");
    const m = await createTestMember(coop.id, { phone: "2348000100012" });
    const mandate = await seedMandate(coop.id, m.id);
    vi.mocked(resolveProvider).mockResolvedValue(fakeAdapter());

    const suffix = mandate.id.slice(-5);
    const res = await cancelMandate(coop.id, suffix, actor(m));
    expect(res.ok).toBe(true);
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe(
      "cancelled",
    );
  });

  it("lists a member's mandates and the cooperative's mandates", async () => {
    const coop = await createTestCoop("MND10");
    const m = await createTestMember(coop.id, { phone: "2348000100010" });
    await seedMandate(coop.id, m.id);

    const mine = await listMandates(coop.id, m.id);
    expect(mine.ok).toBe(true);
    expect(mine.mandates?.length).toBe(1);

    const all = await listCoopMandates(coop.id);
    expect(all.ok).toBe(true);
    expect(all.mandates?.length).toBe(1);
  });

  it("lets a member set a mandate cap above their per-transaction tier limit", async () => {
    const coop = await createTestCoop("MND11");
    const m = await createTestMember(coop.id, { phone: "2348000100011" });
    await enableDirectDebit(coop.id, 100_000_000); // ₦1,000,000 coop cap
    await setBank(m.id);

    // ₦60,000 is above the ₦50,000 tier-1 per-transaction limit, but a mandate
    // cap is a recurring ceiling, not a single movement, so it must be allowed.
    await handleMessage(m.phone, "mandate 60000");

    const session = await prisma.session.findUnique({ where: { phone: m.phone } });
    // The mandate flow now begins with the guided bank picker (Task 11).
    expect(session?.state).toBe("awaiting_bank_account");
    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => String(c[0].text))
      .join("\n");
    expect(texts).not.toMatch(/tier/i);
  });

  it("creates a mandate against the account confirmed in the bank-picker flow", async () => {
    const coop = await createTestCoop("MND14");
    const m = await createTestMember(coop.id, { phone: "2348000100014" });
    await enableDirectDebit(coop.id);
    vi.mocked(resolveProvider).mockResolvedValue(fakeAdapter());

    await handleMessage(m.phone, "mandate 5000");
    await handleMessage(m.phone, "0123456789"); // account number
    await handleMessage(m.phone, "access"); // pick a bank
    await handleMessage(m.phone, "yes"); // confirm the resolved name
    await handleMessage(m.phone, "1234"); // PIN

    const row = await prisma.mandate.findFirst({ where: { memberId: m.id } });
    expect(row).not.toBeNull();
    expect(row?.bankAccountNumber).toBe("0123456789");
    expect(row?.bankCode).toBe("044");
    expect(row?.accountName).toBe("ADA OBI");
  });
});

// ===== Task 8: admin view + pause commands =====

describe("mandate admin commands", () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("lists the cooperative's mandates for an admin", async () => {
    const coop = await createTestCoop("MNADM1");
    const admin = await createTestMember(coop.id, { phone: "2348000300001", role: "superadmin" });
    const m = await createTestMember(coop.id, {
      phone: "2348000300002",
      name: "Ada Obi",
    });
    const mandate = await seedMandate(coop.id, m.id);

    vi.clearAllMocks();
    const handled = await handleAdminCommand(admin.phone, "mandates", []);
    expect(handled).toBe(true);

    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => String(c[0].text))
      .join("\n");
    expect(texts).toMatch(/Ada Obi/);
    expect(texts).toMatch(mandate.id.slice(-6));
  });

  it("refuses mandate administration to a plain member", async () => {
    const coop = await createTestCoop("MNADM2");
    const m = await createTestMember(coop.id, { phone: "2348000300011" });
    await seedMandate(coop.id, m.id);

    const handled = await handleAdminCommand(m.phone, "mandates", []);
    expect(handled).toBe(false);
  });

  it("pauses the whole mandate and resumes it", async () => {
    const coop = await createTestCoop("MNADM3");
    const admin = await createTestMember(coop.id, { phone: "2348000300021", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000300022" });
    const mandate = await seedMandate(coop.id, m.id);

    await handleAdminCommand(admin.phone, "pausemandate", [mandate.id]);
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe("paused");

    await handleAdminCommand(admin.phone, "resumemandate", [mandate.id]);
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe(
      "active",
    );
  });

  it("pauses and resumes a single purpose", async () => {
    const coop = await createTestCoop("MNADM4");
    const admin = await createTestMember(coop.id, { phone: "2348000300031", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000300032" });
    const mandate = await seedMandate(coop.id, m.id);

    await handleAdminCommand(admin.phone, "pausemandate", [mandate.id, "savings"]);
    let row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.pausedPurposes.split(",")).toContain("savings");
    expect(row?.status).toBe("active");

    await handleAdminCommand(admin.phone, "resumemandate", [mandate.id, "savings"]);
    row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.pausedPurposes.split(",")).not.toContain("savings");
  });

  it("skips a pending debit", async () => {
    const coop = await createTestCoop("MNADM5");
    const admin = await createTestMember(coop.id, { phone: "2348000300041", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000300042" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await prisma.mandateDebit.create({
      data: {
        mandateId: mandate.id,
        cooperativeId: coop.id,
        memberId: m.id,
        purpose: "savings",
        amount: 50_000,
        status: "pending",
        providerRef: "DD-ADMINSKIP-1",
      },
    });

    await handleAdminCommand(admin.phone, "skipdebit", [debit.id]);
    expect((await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status).toBe(
      "skipped",
    );
  });

  it("accepts a mandate id suffix", async () => {
    const coop = await createTestCoop("MNADM6");
    const admin = await createTestMember(coop.id, { phone: "2348000300051", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000300052" });
    const mandate = await seedMandate(coop.id, m.id);

    await handleAdminCommand(admin.phone, "pausemandate", [mandate.id.slice(-6)]);
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe("paused");
  });

  it("rejects an unknown pause purpose", async () => {
    const coop = await createTestCoop("MNADM7");
    const admin = await createTestMember(coop.id, { phone: "2348000300061", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000300062" });
    const mandate = await seedMandate(coop.id, m.id);

    vi.clearAllMocks();
    await handleAdminCommand(admin.phone, "pausemandate", [mandate.id, "bogus"]);

    const row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.status).toBe("active");
    expect(row?.pausedPurposes).toBe("");
    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => String(c[0].text))
      .join("\n");
    expect(texts).toMatch(/use \*savings\*, \*loan\* or \*group\*/i);
  });
});
