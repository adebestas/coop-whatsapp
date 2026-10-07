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

  it("notifies the member after a successful savings debit", async () => {
    const coop = await createTestCoop("MWH11");
    const m = await createTestMember(coop.id, { phone: "2348000200012" });
    const mandate = await seedMandate(coop.id, m.id);
    await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-SAV-NOTIFY-1" });

    const res = await postMonnify({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-SAV-NOTIFY-1", status: "SUCCESSFUL" },
    });
    expect(res.httpStatus).toBe(200);
    expect(await walletBalance(m.id)).toBe(50_000);

    // Savings is deposited by the wallet credit in settleDebit; applyPurpose
    // still notifies the member so every debit (success or failure) is visible.
    const notified = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => /savings contribution/i.test(String(c[1])));
    expect(notified).toBe(true);
  });

  it("settles an overdue loan debit by repaying the target loan without inflating totalSaved", async () => {
    const coop = await createTestCoop("MWH9");
    const m = await createTestMember(coop.id, { phone: "2348000200010" });
    const mandate = await seedMandate(coop.id, m.id);
    const loan = await prisma.loan.create({
      data: {
        amount: 100_000,
        balance: 100_000,
        monthlyPayment: 50_000,
        tenureMonths: 1,
        status: "disbursed",
        // Overdue, so repayLoan charges installment + a 5% late fine = 52_500.
        dueDate: new Date(Date.now() - 1000),
        memberId: m.id,
        cooperativeId: coop.id,
      },
    });
    const debit = await seedDebit(coop.id, m.id, mandate.id, {
      purpose: "loan",
      targetId: loan.id,
      amount: 52_500,
      providerRef: "DD-LOAN-1",
    });

    const res = await postMonnify({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-LOAN-1", status: "SUCCESSFUL" },
    });
    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");

    // repayLoan debited the wallet (which settleDebit had just credited), so
    // the loan's outstanding balance must drop and a repayment must be booked.
    const after = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(after!.balance).toBeLessThan(100_000);
    const repayments = await prisma.loanRepayment.findMany({ where: { loanId: loan.id } });
    expect(repayments).toHaveLength(1);
    expect(repayments[0].amount).toBe(50_000);
    expect((await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status).toBe(
      "successful",
    );

    // Loan money is not savings: `totalSaved` must stay untouched, and the
    // wallet nets out (credited the debit, debited the repayment incl. fine).
    const wallet = await prisma.wallet.findUnique({ where: { memberId: m.id } });
    expect(wallet?.totalSaved).toBe(0);
    expect(wallet?.balance).toBe(0);

    // The member is told the repayment happened.
    const notified = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => /repaid|loan/i.test(String(c[1])));
    expect(notified).toBe(true);
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

  it("processes an ACTIVATED then a later CANCELLED webhook for the same mandate", async () => {
    const coop = await createTestCoop("MWH7");
    const m = await createTestMember(coop.id, { phone: "2348000200007" });
    const mandate = await seedMandate(coop.id, m.id, { status: "pending" });

    const activated = await postMonnify({
      eventType: "MANDATE_UPDATE",
      eventData: { mandateCode: "MTDD|X", mandateStatus: "ACTIVATED" },
    });
    expect(activated.body.status).toBe("ok");
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe("active");

    // The lifecycle event id must include the status, or this cancels is
    // deduped against the activation and the mandate keeps collecting money.
    const cancelled = await postMonnify({
      eventType: "MANDATE_UPDATE",
      eventData: { mandateCode: "MTDD|X", mandateStatus: "CANCELLED" },
    });
    expect(cancelled.body.status).toBe("ok");
    expect((await prisma.mandate.findUnique({ where: { id: mandate.id } }))?.status).toBe(
      "cancelled",
    );
    expect(await prisma.webhookEvent.count()).toBe(2);
  });

  it("fails and alerts when a settled debit's member has no wallet instead of stranding it", async () => {
    const coop = await createTestCoop("MWH8");
    const admin = await createTestMember(coop.id, { phone: "2348000200008", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000200009" });
    const mandate = await seedMandate(coop.id, m.id);
    const debit = await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-NOWALLET-1" });
    await prisma.wallet.delete({ where: { memberId: m.id } });

    const res = await postMonnify({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-NOWALLET-1", status: "SUCCESSFUL" },
    });

    // Never silently ack: the event is marked failed (retryable) and a super
    // admin is alerted.
    expect(res.httpStatus).toBe(500);
    expect((await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status).toBe(
      "pending",
    );
    const alerted = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => (c[0] as { phone?: string }).phone === admin.phone);
    expect(alerted).toBe(true);
  });

  it("settles a group debit by contributing to the group and increasing the pot", async () => {
    const coop = await createTestCoop("MWH10");
    const m = await createTestMember(coop.id, { phone: "2348000200011" });
    const mandate = await seedMandate(coop.id, m.id);
    const group = await prisma.group.create({
      data: {
        cooperativeId: coop.id,
        type: "rosca",
        name: "Harvest ROSCA",
        code: "HROS1",
        contributionAmount: 200_000,
        cycleLength: 5,
        createdById: m.id,
      },
    });
    const cycle = await prisma.groupCycle.create({
      data: { groupId: group.id, cooperativeId: coop.id, cycleNumber: 1, status: "open" },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, memberId: m.id, active: true, rotationPosition: 1 },
    });
    const debit = await seedDebit(coop.id, m.id, mandate.id, {
      purpose: "group",
      targetId: group.id,
      amount: 200_000,
      providerRef: "DD-GROUP-1",
    });

    const res = await postMonnify({
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-GROUP-1", status: "SUCCESSFUL" },
    });
    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");

    expect((await prisma.mandateDebit.findUnique({ where: { id: debit.id } }))?.status).toBe(
      "successful",
    );

    // contributeToGroup recorded the contribution for the open cycle.
    const contributions = await prisma.groupContribution.findMany({ where: { cycleId: cycle.id } });
    expect(contributions).toHaveLength(1);
    expect(contributions[0].memberId).toBe(m.id);
    expect(contributions[0].amount).toBe(200_000);

    // The group pot grew by the contribution (journal CREDIT to the pot account).
    const postings = await prisma.posting.findMany({
      where: { entry: { cooperativeId: coop.id }, account: `liability:group_pot:${group.id}` },
    });
    const credits = postings
      .filter((p) => p.direction === "CREDIT")
      .reduce((s, p) => s + p.amount, 0);
    expect(credits).toBe(200_000);

    // Group money is not savings: the wallet nets out and totalSaved is untouched.
    const wallet = await prisma.wallet.findUnique({ where: { memberId: m.id } });
    expect(wallet?.balance).toBe(0);
    expect(wallet?.totalSaved).toBe(0);

    // The member is told the contribution happened.
    const notified = vi
      .mocked(notifyMember)
      .mock.calls.some((c) => /contributed/i.test(String(c[1])));
    expect(notified).toBe(true);
  });

  it("credits the wallet when a successful webhook arrives after the reconciler aged the debit to failed", async () => {
    const coop = await createTestCoop("MWH12");
    const m = await createTestMember(coop.id, { phone: "2348000200013" });
    const mandate = await seedMandate(coop.id, m.id);
    // Seed an OLD pending debit, then let the real reconciler age it to failed.
    await seedDebit(coop.id, m.id, mandate.id, {
      providerRef: "DD-LATE-1",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { reconcileStaleMandateDebits } = await import("../src/services/scheduler.js");
    await reconcileStaleMandateDebits(new Date());
    expect(
      (await prisma.mandateDebit.findFirst({ where: { providerRef: "DD-LATE-1" } }))?.status,
    ).toBe("failed");

    // The provider's delayed settlement webhook now arrives. The money was
    // collected, so the wallet MUST be credited exactly once — not dropped as
    // a non-pending no-op.
    const body = {
      eventType: "SUCCESSFUL_DISBURSEMENT",
      eventData: { reference: "DD-LATE-1", providerReference: "TRX-LATE", status: "SUCCESSFUL" },
    };
    const first = await postMonnify(body);
    expect(first.httpStatus).toBe(200);
    expect(first.body.status).toBe("ok");
    expect(await walletBalance(m.id)).toBe(50_000);

    const row = await prisma.mandateDebit.findFirst({ where: { providerRef: "DD-LATE-1" } });
    expect(row?.status).toBe("successful");
    expect(row?.providerTransactionId).toBe("TRX-LATE");

    const postings = await prisma.posting.findMany();
    expect(postings).toHaveLength(2); // exactly one debit + one credit
    expect(
      postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount, 0),
    ).toBe(50_000);

    // A replayed delivery must not credit a second time.
    const second = await postMonnify(body);
    expect(second.body.status).toBe("duplicate");
    expect(await walletBalance(m.id)).toBe(50_000);
  });

  it("activates a Paystack mandate from the webhook email join key", async () => {
    const coop = await createTestCoop("MWHPS1");
    const m = await createTestMember(coop.id, { phone: "2348000200021" });
    const mandate = await seedMandate(coop.id, m.id, {
      provider: "paystack",
      providerMandateId: null,
      providerReference: "MAN-ps-w1",
      status: "pending",
    });

    const res = await postPaystack({
      event: "direct_debit.authorization.created",
      data: {
        authorization_code: "AUTH_W1",
        active: true,
        customer: { code: "CUS_W1", email: "MAN-ps-w1@coop.local" },
      },
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");
    const row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.status).toBe("active");
    expect(row?.providerMandateId).toBe("AUTH_W1");
    expect(row?.authorizedAt).toBeInstanceOf(Date);
    const events = await prisma.webhookEvent.findMany();
    expect(events[0].kind).toBe("mandate_update");
  });

  it("records a Paystack inactive authorization as pending and stores the authorization code", async () => {
    const coop = await createTestCoop("MWHPS2");
    const m = await createTestMember(coop.id, { phone: "2348000200022" });
    const mandate = await seedMandate(coop.id, m.id, {
      provider: "paystack",
      providerMandateId: null,
      providerReference: "MAN-ps-w2",
      status: "pending",
    });

    const res = await postPaystack({
      event: "direct_debit.authorization.created",
      data: {
        authorization_code: "AUTH_W2",
        active: false,
        customer: { code: "CUS_W2", email: "MAN-ps-w2@coop.local" },
      },
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");
    const row = await prisma.mandate.findUnique({ where: { id: mandate.id } });
    expect(row?.status).toBe("pending");
    expect(row?.providerMandateId).toBe("AUTH_W2");
  });

  it("settles a Paystack mandate debit by our reference", async () => {
    const coop = await createTestCoop("MWHPS3");
    const m = await createTestMember(coop.id, { phone: "2348000200023" });
    const mandate = await seedMandate(coop.id, m.id, {
      provider: "paystack",
      providerMandateId: "AUTH_W3",
    });
    const debit = await seedDebit(coop.id, m.id, mandate.id, { providerRef: "DD-PS-1" });

    const res = await postPaystack({
      event: "partial_debit.success",
      data: { reference: "DD-PS-1", id: 4242 },
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(await walletBalance(m.id)).toBe(50_000);
    const row = await prisma.mandateDebit.findUnique({ where: { id: debit.id } });
    expect(row?.status).toBe("successful");
    expect(row?.providerTransactionId).toBe("4242");
  });
});
