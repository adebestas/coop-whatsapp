/**
 * Task 4: mandate webhook branch + settleDebit (savings).
 *
 * The webhook pipeline imports the CONCRETE Monnify/Paystack adapters (not the
 * app-wide payments mock in tests/setup.ts), so signature verification is real:
 * every body is signed with the provider secret over the EXACT raw bytes.
 *
 * Parser-ordering is the sharp edge here (carry-forward from the Task 2 review):
 * Monnify's `parsePayoutNotification` and `parseDebitNotification` both match the
 * DISBURSEMENT event set, so a mandate debit must NOT be consumed as a payout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { processPaymentWebhook, processPayoutWebhook } from "../src/services/webhooks.js";
import { notifyMember } from "../src/lib/messaging.js";

const ENV_KEYS = ["MONNIFY_SECRET_KEY", "PAYSTACK_SECRET_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  vi.clearAllMocks();
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.MONNIFY_SECRET_KEY = "monnify_test_secret";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_mandate";
  await cleanupDatabase();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function monnifyHeaders(raw: string) {
  const sig = createHmac("sha512", process.env.MONNIFY_SECRET_KEY!).update(raw).digest("hex");
  return { "monnify-signature": sig };
}
function paystackHeaders(raw: string) {
  const sig = createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(raw).digest("hex");
  return { "x-paystack-signature": sig };
}
async function postMonnify(body: unknown) {
  const raw = JSON.stringify(body);
  return processPaymentWebhook(raw, monnifyHeaders(raw));
}
async function postPaystack(body: unknown) {
  const raw = JSON.stringify(body);
  return processPaymentWebhook(raw, paystackHeaders(raw));
}

async function walletBalance(memberId: string): Promise<number> {
  return (await prisma.wallet.findUnique({ where: { memberId } }))?.balance ?? 0;
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

async function seedDebit(
  coopId: string,
  memberId: string,
  mandateId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.mandateDebit.create({
    data: {
      mandateId,
      cooperativeId: coopId,
      memberId,
      purpose: "savings",
      amount: 50_000,
      status: "pending",
      providerRef: `DD-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    },
  });
}

describe("mandate webhooks", () => {
  it("activates a mandate from a MANDATE_UPDATE webhook", async () => {
    const coop = await createTestCoop("MWH1");
    const m = await createTestMember(coop.id, { phone: "2348000200001" });
    const mandate = await seedMandate(coop.id, m.id, { status: "pending" });

    const res = await postMonnify({
      eventType: "MANDATE_UPDATE",
      eventData: { mandateCode: "MTDD|X", mandateStatus: "ACTIVATED" },
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");
    const row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.status).toBe("active");
    expect(row?.authorizedAt).toBeInstanceOf(Date);
    const events = await prisma.webhookEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("mandate_update");
  });

  it("credits the wallet and settles a pending savings debit on success", async () => {
    const coop = await createTestCoop("MWH2");
    const m = await createTestMember(coop.id, { phone: "2348000200002" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-OK-1" });

    const res = await postMonnify({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-OK-1", providerReference: "TRX-9", status: "SUCCESSFUL" },
    });
    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");

    expect(await walletBalance(m.id)).toBe(50_000);
    const wallet = await prisma.wallet.findUnique({ where: { memberId: m.id } });
    expect(wallet?.totalSaved).toBe(50_000);

    const row = await prisma.mandateDebit.findUnique({ where: { id: debit.id } });
    expect(row?.status).toBe("successful");
    expect(row?.settledAt).toBeInstanceOf(Date);
    expect(row?.providerTransactionId).toBe("TRX-9");
    expect(
      (await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.lastDebitAt,
    ).toBeInstanceOf(Date);

    const postings = await prisma.posting.findMany();
    const debitSum = postings
      .filter((p) => p.direction === "DEBIT")
      .reduce((s, p) => s + p.amount, 0);
    const creditSum = postings
      .filter((p) => p.direction === "CREDIT")
      .reduce((s, p) => s + p.amount, 0);
    expect(debitSum).toBe(creditSum);
    expect(debitSum).toBe(50_000);

    // Every money movement carries a human-readable description.
    const journal = await prisma.journalEntry.findFirst();
    expect(journal?.description).toMatch(/savings/i);
  });

  it("marks a debit failed, schedules a retry, and does not credit the wallet", async () => {
    const coop = await createTestCoop("MWH3");
    const m = await createTestMember(coop.id, { phone: "2348000200003" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-FAIL-1" });
    const before = Date.now();

    const res = await postMonnify({
      eventType: "FAILED_DISBURSEMENT",
      eventData: { reference: "DD-FAIL-1", status: "FAILED" },
    });
    expect(res.httpStatus).toBe(200);

    const row = await prisma.mandateDebit.findUnique({ where: { id: debit.id } });
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toBeTruthy();
    const retry = row!.nextRetryAt!.getTime();
    expect(retry).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
    expect(retry).toBeLessThanOrEqual(Date.now() + 25 * 60 * 60 * 1000);
    expect(await walletBalance(m.id)).toBe(0);
    expect(vi.mocked(notifyMember)).toHaveBeenCalled();
  });

  it("acks a duplicate delivery and credits the wallet only once", async () => {
    const coop = await createTestCoop("MWH4");
    const m = await createTestMember(coop.id, { phone: "2348000200004" });
    const mandate = await seedMandate(coop.id, m.id);
    await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-DUP-1" });
    const body = {
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-DUP-1", status: "SUCCESSFUL" },
    };

    const first = await postMonnify(body);
    const second = await postMonnify(body);

    expect(first.body.status).toBe("ok");
    expect(second.body.status).toBe("duplicate");
    expect(await walletBalance(m.id)).toBe(50_000);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it("still credits the wallet for a normal charge.success (mandate branch must not steal it)", async () => {
    const coop = await createTestCoop("MWH5");
    const m = await createTestMember(coop.id, { phone: "2348000200005" });
    await prisma.member.update({
      where: { id: m.id },
      data: { virtualAccountNumber: "VA-MND-1" },
    });

    const res = await postPaystack({
      event: "charge.success",
      data: {
        id: "TX-MND-1",
        status: "success",
        amount: 700,
        account: { number: "VA-MND-1" },
        currency: "NGN",
      },
    });

    expect(res.httpStatus).toBe(200);
    expect(await walletBalance(m.id)).toBe(700);
    const events = await prisma.webhookEvent.findMany();
    expect(events[0].id).toBe("paystack:TX-MND-1");
    expect(await prisma.contribution.count()).toBe(1);
  });

  it("does not consume a mandate-debit reference as a payout, so the mandate branch can settle it", async () => {
    const coop = await createTestCoop("MWH6");
    const m = await createTestMember(coop.id, { phone: "2348000200006" });
    const mandate = await seedMandate(coop.id, m.id);
    await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-ORDER-1" });
    const raw = JSON.stringify({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-ORDER-1", status: "SUCCESSFUL" },
    });

    // The combined route tries the payout saga first. A mandate debit shares the
    // DISBURSEMENT event set with payouts, so the payout handler must yield.
    const payout = await processPayoutWebhook(raw, monnifyHeaders(raw));
    expect(payout.body.status).toBe("ignored");

    const credit = await processPaymentWebhook(raw, monnifyHeaders(raw));
    expect(credit.body.status).toBe("ok");
    expect(await walletBalance(m.id)).toBe(50_000);
  });
});
