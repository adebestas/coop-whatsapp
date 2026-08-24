import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { totpAt } from "../src/lib/totp.js";
import {
  assertMoneyAuthorized,
  enable2fa,
} from "../src/services/auth2fa.js";
import { ensureBeneficiaryAllowed } from "../src/services/beneficiaries.js";
import { runTransferPolling } from "../src/services/statuspoller.js";
import { runDailyDigest } from "../src/services/scheduler.js";
import { checkDailyPayoutLimit, checkMoneyRateLimit, resetMoneyRateLimit } from "../src/services/fraud.js";
import { validateEnvironment } from "../src/lib/envcheck.js";
import { resolveProvider } from "../src/services/payments/index.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

// Configurable fake provider so poller tests can script transfer outcomes.
const fakeProvider = {
  name: "monnify",
  createVirtualAccount: vi.fn(),
  payout: vi.fn(async () => ({ ok: true, providerRef: "pl-pay-1" })),
  resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
  verifyWebhook: () => true,
  parseNotification: () => null,
  getTransferStatus: vi.fn(async (): Promise<{ status: string }> => ({ status: "pending" })),
};

vi.mock("../src/services/payments/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/payments/index.js")>();
  return {
    ...actual,
    resolveProvider: () => fakeProvider,
  };
});

const ENV_KEYS = [
  "NEW_BENEFICIARY_HOLD_HOURS",
  "PILOT_FLOAT_CAP",
  "TWO_FA_REQUIRED",
  "DIGEST_HOUR",
] as const;
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

async function makeCoop(name = "Pre Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("PC"), adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; name?: string; bank?: boolean; balance?: number; pin?: boolean } = {},
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
    pin: hashPin(opts.pin === false ? "" : "1234"),
    wallet: { create: { balance: opts.balance ?? 0 } },
  };
  if (opts.bank) {
    data.bankAccountNumber = "0123456789";
    data.bankCode = "058";
    data.bankName = "Access";
  }
  return prisma.member.create({ data });
}

beforeEach(async () => {
  for (const m of [
    "posting",
    "journalEntry",
    "coopPost",
    "deductionItem",
    "deductionWaiver",
    "deductionBatch",
    "webhookEvent",
    "beneficiary",
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

describe("TOTP two-factor authentication", () => {
  it("enrols a member and requires a live code on money-out commands", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000101", coop.id, { role: "superadmin" });

    const enrol = await enable2fa(superA.phone);
    expect(enrol.ok).toBe(true);
    const enrolled = await prisma.member.findUnique({ where: { id: superA.id } });
    expect(enrolled!.totpSecret).toBeTruthy();

    // No code at all -> refused.
    const noCode = await assertMoneyAuthorized(superA.id, ["abc123"]);
    expect(noCode.ok).toBe(false);
    expect(noCode.message).toContain("6-digit");

    // Wrong code -> refused.
    const bad = await assertMoneyAuthorized(superA.id, ["abc123", "000000"]);
    expect(bad.ok).toBe(false);

    // Valid current code -> allowed AND consumed (args shrunk).
    const secret = enrolled!.totpSecret!;
    const good = await assertMoneyAuthorized(superA.id, ["abc123", totpAt(secret)]);
    expect(good.ok).toBe(true);
    expect(good.args).toEqual(["abc123"]);

    // A member WITHOUT 2FA passes untouched (test env, not required globally).
    const plain = await makeMember("2348090000102", coop.id, { role: "superadmin" });
    const skip = await assertMoneyAuthorized(plain.id, ["abc123"]);
    expect(skip.ok).toBe(true);
    expect(skip.args).toEqual(["abc123"]);
  });
});

describe("new-beneficiary cooling period", () => {
  it("blocks the first payment to an account, then allows once aged past the hold", async () => {
    process.env.NEW_BENEFICIARY_HOLD_HOURS = "24";
    const coop = await makeCoop();
    const member = await makeMember("2348010000201", coop.id);

    const base = {
      cooperativeId: coop.id,
      memberId: member.id,
      accountNumber: "9988776655",
      bankCode: "058",
      bankName: "Access",
    };

    const first = await ensureBeneficiaryAllowed(base);
    expect(first.ok).toBe(false);
    expect(first.message).toContain("24 hours");

    // Still inside the window -> still blocked.
    const second = await ensureBeneficiaryAllowed(base);
    expect(second.ok).toBe(false);

    // Age the record past the hold -> allowed.
    await prisma.beneficiary.updateMany({
      where: { cooperativeId: coop.id, accountNumber: "9988776655" },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const third = await ensureBeneficiaryAllowed(base);
    expect(third.ok).toBe(true);
  });

  it("never blocks when the hold is disabled", async () => {
    const coop = await makeCoop();
    const member = await makeMember("2348010000202", coop.id);
    const result = await ensureBeneficiaryAllowed({
      cooperativeId: coop.id,
      memberId: member.id,
      accountNumber: "1122334455",
      bankCode: "058",
    });
    expect(result.ok).toBe(true);
  });
});

describe("transfer status polling", () => {
  it("settles a stuck pay-anyone transfer when the provider reports success", async () => {
    const coop = await makeCoop();
    const initiator = await makeMember("2348090000203", coop.id, { role: "admin" });

    const payment = await prisma.externalPayment.create({
      data: {
        cooperativeId: coop.id,
        beneficiaryName: "Vendor One",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        amount: 5000,
        initiatedById: initiator.id,
        approved1ById: initiator.id,
        approved2ById: initiator.id,
        approved3ById: initiator.id,
        status: "processing",
        updatedAt: new Date(Date.now() - 30 * 60 * 1000),
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });

    fakeProvider.getTransferStatus.mockResolvedValueOnce({ status: "successful", providerRef: "pr-9" });
    const actions = await runTransferPolling(new Date(Date.now() + 60 * 60 * 1000));

    const settled = await prisma.externalPayment.findUnique({ where: { id: payment.id } });
    expect(settled!.status).toBe("paid");
    const payouts = await prisma.payout.findMany();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].idempotencyKey).toBe(`PAYANY-${payment.id.slice(-8)}`);
    expect(actions.join("\n")).toContain("confirmed by provider");
  });

  it("refunds the wallet when a stuck withdrawal failed at the provider", async () => {
    const coop = await makeCoop();
    const member = await makeMember("2348010000204", coop.id, { balance: 0 }); // already debited

    const request = await prisma.withdrawalRequest.create({
      data: {
        amount: 2500,
        status: "processing",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: member.id,
        cooperativeId: coop.id,
        createdAt: new Date(Date.now() - 40 * 60 * 1000),
      },
    });

    fakeProvider.getTransferStatus.mockResolvedValueOnce({ status: "failed", error: "insufficient funds at bank" });
    const actions = await runTransferPolling(new Date());

    const after = await prisma.withdrawalRequest.findUnique({ where: { id: request.id } });
    expect(after!.status).toBe("admin_approved"); // handed back for retry
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(2500); // refunded
    expect(actions.join("\n")).toContain("refunded");
  });

  it("leaves genuinely pending transfers alone", async () => {
    const coop = await makeCoop();
    const initiator = await makeMember("2348090000205", coop.id, { role: "admin" });
    const payment = await prisma.externalPayment.create({
      data: {
        cooperativeId: coop.id,
        beneficiaryName: "Slow Vendor",
        bankAccountNumber: "5544332211",
        bankCode: "058",
        amount: 1200,
        initiatedById: initiator.id,
        status: "processing",
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });

    fakeProvider.getTransferStatus.mockResolvedValueOnce({ status: "pending" });
    await runTransferPolling(new Date());
    const after = await prisma.externalPayment.findUnique({ where: { id: payment.id } });
    expect(after!.status).toBe("processing");
    expect(await prisma.payout.count()).toBe(0);
  });
});

describe("daily movement digest", () => {
  it("sends every super a summary of yesterday's money movement", async () => {
    const coop = await makeCoop();
    const superA = await makeMember("2348090000206", coop.id, { role: "superadmin" });
    const member = await makeMember("2348010000207", coop.id);

    await prisma.payout.create({
      data: {
        amount: 3000,
        reference: "TFR-WDR-digest1",
        status: "successful",
        provider: "monnify",
        note: "Member withdrawal (finalized by super admin)",
        memberId: member.id,
        cooperativeId: coop.id,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const now = new Date();
    now.setHours(20, 5, 0, 0); // default digest hour
    const sent = await runDailyDigest(now);
    expect(sent).toBe(1);

    const texts = [
      ...vi.mocked(sendText).mock.calls.map((c) => c[0] as { to: string; text: string }),
      ...vi.mocked(notifyMember).mock.calls.map((c) => ({
        to: typeof c[0] === "string" ? c[0] : String((c[0] as { phone?: string }).phone),
        text: String(c[1]),
      })),
    ];
    const digest = texts.find((t) => t.to === superA.phone && t.text.includes("Daily summary"));
    expect(digest).toBeTruthy();
    expect(digest!.text).toContain("NGN 3,000");
    expect(digest!.text).toContain("Member withdrawal");
  });

  it("does not resend twice on the same day", async () => {
    const coop = await makeCoop();
    await makeMember("2348090000208", coop.id, { role: "superadmin" });
    const now = new Date();
    now.setHours(20, 0, 0, 0);
    expect(await runDailyDigest(now)).toBe(1);
    expect(await runDailyDigest(now)).toBe(0);
  });
});

describe("pilot float cap", () => {
  it("blocks money-out once the monthly pilot ceiling would be crossed", async () => {
    process.env.PILOT_FLOAT_CAP = "10000";
    const coop = await makeCoop();
    const member = await makeMember("2348010000301", coop.id);
    await prisma.payout.create({
      data: {
        amount: 9000,
        reference: "cap-seed-1",
        idempotencyKey: "cap-seed-1",
        status: "successful",
        provider: "monnify",
        note: "seed",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    const within = await checkDailyPayoutLimit(coop.id, 500);
    expect(within.ok).toBe(true);

    const over = await checkDailyPayoutLimit(coop.id, 2000);
    expect(over.ok).toBe(false);
    expect(over.message).toContain("Pilot safety cap");
  });

  it("is inactive when PILOT_FLOAT_CAP is unset", async () => {
    const coop = await makeCoop();
    const result = await checkDailyPayoutLimit(coop.id, 500_000);
    expect(result.ok).toBe(true);
  });
});

describe("money command rate limit", () => {
  it("caps rapid-fire money commands per phone (6/hour), per phone independently", () => {
    resetMoneyRateLimit();
    for (let i = 0; i < 6; i++) {
      expect(checkMoneyRateLimit("2348010000401")).toBe(true);
    }
    expect(checkMoneyRateLimit("2348010000401")).toBe(false);
    // A different phone is unaffected.
    expect(checkMoneyRateLimit("2348010000402")).toBe(true);
    resetMoneyRateLimit();
    expect(checkMoneyRateLimit("2348010000401")).toBe(true);
  });
});

describe("startup environment validation", () => {
  it("fails fatally without core WhatsApp credentials", () => {
    const report = validateEnvironment({
      WHATSAPP_TOKEN: "",
      WHATSAPP_PHONE_ID: "",
    } as any);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("FATAL"))).toBe(true);
  });

  it("passes with core credentials present but warns about providers", () => {
    // Warnings only fire outside test mode — rehearse production here.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const report = validateEnvironment({
        WHATSAPP_TOKEN: "x",
        WHATSAPP_PHONE_ID: "y",
        ADMIN_JWT_SECRET: "a-real-secret-key-that-is-not-a-placeholder-1234567890ab",
      } as any);
      expect(report.ok).toBe(true);
      expect(report.problems.some((p) => p.includes("No payment provider"))).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
