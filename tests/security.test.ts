import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { flutterwaveAdapter } from "../src/services/payments/flutterwave.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { processPaymentWebhook } from "../src/services/webhooks.js";
import { sendToBank } from "../src/services/disbursements.js";
import { approveWithdrawal, finalizeWithdrawal } from "../src/services/withdrawals.js";
import { approveLoan } from "../src/services/loans.js";
import { setSalary, runPayroll } from "../src/services/payroll.js";
import { approveClaim } from "../src/services/deathclaims.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/services/payments/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/payments/index.js")>();
  return {
    ...actual,
    resolveProvider: () => ({
      name: "monnify",
      createVirtualAccount: vi.fn(),
      payout: vi.fn(async () => ({ ok: true, providerRef: "sec-pay-1" })),
      resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
      verifyWebhook: () => true,
      parseNotification: () => null,
    }),
  };
});

const ENV_KEYS = ["FLUTTERWAVE_WEBHOOK_HASH", "PAYSTACK_SECRET_KEY", "MONNIFY_SECRET_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "Sec Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("SC"), adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: {
    role?: string;
    name?: string;
    bank?: boolean;
    balance?: number;
    virtual?: string;
  } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  const data: any = {
    code,
    phone,
    name: opts.name ?? `Member ${phone.slice(-4)}`,
    cooperativeId: coopId,
    role: opts.role ?? "member",
    pin: hashPin("1234"),
    wallet: { create: { balance: opts.balance ?? 0 } },
  };
  if (opts.bank) {
    data.bankAccountNumber = "0123456789";
    data.bankCode = "058";
    data.bankName = "Access";
  }
  if (opts.virtual) data.virtualAccountNumber = opts.virtual;
  return prisma.member.create({ data });
}

beforeEach(async () => {
  for (const m of [
    "posting",
    "journalEntry",
    "webhookEvent",
    "pollBallot",
    "pollOption",
    "purchasePoll",
    "externalPayment",
    "guarantorDeduction",
    "ledgerEntry",
    "voteBallot",
    "voteCandidate",
    "vote",
    "supportTicket",
    "auditLog",
    "deathValidation",
    "deathClaim",
    "withdrawalRequest",
    "contribution",
    "loanRepayment",
    "guarantor",
    "loan",
    "payout",
    "dividendEntry",
    "dividend",
    "broadcast",
    "wallet",
    "member",
    "unit",
    "cooperative",
    "session",
  ] as any[]) {
    await prisma[m].deleteMany();
  }
});

describe("cryptographic webhook verification", () => {
  it("fails closed when the provider secret is not configured", () => {
    expect(flutterwaveAdapter.verifyWebhook("{}", {})).toBe(false);
    expect(paystackAdapter.verifyWebhook("{}", {})).toBe(false);
  });

  it("accepts genuine Flutterwave signatures and rejects tampered ones", () => {
    process.env.FLUTTERWAVE_WEBHOOK_HASH = "whsec_test123";
    expect(flutterwaveAdapter.verifyWebhook('{"a":1}', { "verif-hash": "whsec_test123" })).toBe(true);
    expect(flutterwaveAdapter.verifyWebhook('{"a":1}', { "verif-hash": "wrong" })).toBe(false);
    // No header at all -> fail closed.
    expect(flutterwaveAdapter.verifyWebhook('{"a":1}', {})).toBe(false);
  });

  it("verifies Paystack HMAC over the RAW body (not re-serialized JSON)", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_key";
    const rawBody = '{"event":"charge.success","data":{"id":123}}';
    const validSig = createHmac("sha512", "sk_test_key").update(rawBody).digest("hex");
    expect(paystackAdapter.verifyWebhook(rawBody, { "x-paystack-signature": validSig })).toBe(true);
    // Same JSON re-serialized differently must NOT pass.
    const reserialized = '{"data":{"id":123},"event":"charge.success"}';
    expect(paystackAdapter.verifyWebhook(reserialized, { "x-paystack-signature": validSig })).toBe(false);
  });
});

describe("webhook replay protection", () => {
  it("credits once and marks the second identical delivery as duplicate", async () => {
    process.env.FLUTTERWAVE_WEBHOOK_HASH = "whsec_test123";
    const coop = await makeCoop();
    const member = await makeMember("2348010000042", coop.id, { virtual: "VA-SEC-001", balance: 0 });

    const rawBody = JSON.stringify({
      event: "charge.completed",
      data: { id: "SECTX-777", status: "successful", amount: 500, account_number: "VA-SEC-001", currency: "NGN" },
    });
    const headers = { "verif-hash": "whsec_test123" };

    const first = await processPaymentWebhook(rawBody, headers);
    expect(first.httpStatus).toBe(200);

    let wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(500);

    // Replay — same signed payload again.
    const second = await processPaymentWebhook(rawBody, headers);
    expect(second.body.status).toBe("duplicate");
    wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(500);

    const events = await prisma.webhookEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("processed");
    const contributions = await prisma.contribution.findMany();
    expect(contributions).toHaveLength(1);
  });

  it("rejects forged deliveries with 401 before touching any state", async () => {
    process.env.FLUTTERWAVE_WEBHOOK_HASH = "whsec_test123";
    const coop = await makeCoop();
    const member = await makeMember("2348010000043", coop.id, { virtual: "VA-SEC-002", balance: 0 });

    const rawBody = JSON.stringify({
      event: "charge.completed",
      data: { id: "EVIL-TX", status: "successful", amount: 999999, account_number: "VA-SEC-002", currency: "NGN" },
    });

    const result = await processPaymentWebhook(rawBody, { "verif-hash": "forged" });
    expect(result.httpStatus).toBe(401);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(0);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.contribution.count()).toBe(0);
  });
});

describe("payout idempotency", () => {
  it("blocks a second payout with the same idempotency key", async () => {
    const coop = await makeCoop();
    const member = await makeMember("2348010000044", coop.id, { name: "ADA OBI", bank: true });

    const opts = {
      memberId: member.id,
      amount: 3000,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      note: "test payout",
      idempotencyKey: "TFR-DUP-CHECK",
    };

    const first = await sendToBank(opts);
    expect(first.ok).toBe(true);
    expect(await prisma.payout.count()).toBe(1);

    const second = await sendToBank(opts);
    expect(second.ok).toBe(false);
    expect(second.message).toContain("Duplicate payout blocked");
    expect(await prisma.payout.count()).toBe(1);
  });
});

describe("atomic double-spend protection", () => {
  it("pays a withdrawal exactly once under concurrent finalization", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000077", coop.id, {
      role: "superadmin",
      name: "ADA OBI",
    });
    const member = await makeMember("2348010000045", coop.id, {
      name: "ADA OBI",
      bank: true,
      balance: 10000,
    });

    const request = await prisma.withdrawalRequest.create({
      data: {
        amount: 4000,
        status: "pending",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    const actor = { id: superA.id, role: "superadmin", phone: superA.phone };
    const [r1, r2] = await Promise.all([
      finalizeWithdrawal(request.id, actor),
      finalizeWithdrawal(request.id, actor),
    ]);

    const outcomes = [r1, r2].sort((a) => (a.ok ? -1 : 1));
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[1].ok).toBe(false);

    expect(await prisma.payout.count()).toBe(1);
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(6000); // debited exactly once
    const finalRequest = await prisma.withdrawalRequest.findUnique({ where: { id: request.id } });
    expect(finalRequest!.status).toBe("paid");
  });
});

describe("dual-control blocks", () => {
  it("blocks approving your own withdrawal", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000078", coop.id, { role: "superadmin", bank: true, balance: 5000 });
    const request = await prisma.withdrawalRequest.create({
      data: {
        amount: 1000,
        status: "pending",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: superA.id,
        cooperativeId: coop.id,
      },
    });
    const result = await approveWithdrawal(request.id, {
      id: superA.id,
      role: "superadmin",
      phone: superA.phone,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("own withdrawal");
    const after = await prisma.withdrawalRequest.findUnique({ where: { id: request.id } });
    expect(after!.status).toBe("pending"); // untouched
  });

  it("blocks approving your own loan", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000079", coop.id, { role: "superadmin" });
    const loan = await prisma.loan.create({
      data: {
        amount: 20000,
        interestRate: 5,
        tenureMonths: 3,
        status: "guaranteed",
        balance: 20000,
        memberId: superA.id,
        cooperativeId: coop.id,
      },
    });
    const result = await approveLoan(loan.id, { superAdmin: true, actorId: superA.id });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("own loan");
    const after = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(after!.status).toBe("guaranteed");
  });

  it("blocks setting your own salary and paying yourself via payroll", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000080", coop.id, { role: "superadmin", name: "ADA OBI", bank: true });
    const superB = await makeMember("2348090000081", coop.id, { role: "superadmin", name: "ADA OBI", bank: true });

    // A can't set their own salary...
    const selfSet = await setSalary(
      { id: superA.id, phone: superA.phone, role: "superadmin", cooperativeId: coop.id },
      superA.phone,
      50000,
    );
    expect(selfSet.ok).toBe(false);
    expect(selfSet.message).toContain("own salary");

    // ...but B can set A's salary, and vice versa.
    await setSalary(
      { id: superB.id, phone: superB.phone, role: "superadmin", cooperativeId: coop.id },
      superA.phone,
      30000,
    );
    await setSalary(
      { id: superA.id, phone: superA.phone, role: "superadmin", cooperativeId: coop.id },
      superB.phone,
      25000,
    );

    // B runs payroll: B's own stipend is skipped, only A is paid.
    const run = await runPayroll(coop.id, { id: superB.id, phone: superB.phone, role: "superadmin" }, "March stipends");
    expect(run.ok).toBe(true);
    expect(run.paid).toBe(1);
    expect(run.total).toBe(30000);
    expect(run.message).toContain("pays yourself");

    // Only ONE payout exists and it belongs to A.
    const payouts = await prisma.payout.findMany();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].memberId).toBe(superA.id);
  });

  it("blocks approving a death claim on your own account", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000082", coop.id, { role: "superadmin", balance: 8000 });
    const claim = await prisma.deathClaim.create({
      data: {
        status: "validated",
        memberId: superA.id,
        cooperativeId: coop.id,
      },
    });
    const result = await approveClaim(superA.phone, claim.id.slice(-6));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("own account");
    const after = await prisma.deathClaim.findUnique({ where: { id: claim.id } });
    expect(after!.status).toBe("validated");
  });
});
