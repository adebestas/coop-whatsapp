import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { hashPin, generateMemberCode } from "../src/lib/security.js";

/**
 * RLS (Row-Level Security) Cross-Cooperative Isolation Tests
 *
 * STATUS: GATED. No migration in this repository creates RLS policies
 * (`grep -ri "CREATE POLICY" prisma/` is empty), so these tests describe a
 * control that does not exist yet. They also call `set_config(..., false)`
 * (session-scoped) through a pooled Prisma client, which is only reliable
 * inside `$transaction` on a single connection.
 *
 * They are skipped unless RLS_ENABLED=1 AND DATABASE_URL is PostgreSQL.
 * Enabling them requires: a migration that ENABLEs + FORCEs RLS and adds
 * policies keyed on current_setting('app.current_cooperative_id'), plus
 * wrapping every tenant query in a transaction that sets the GUC.
 */
const rlsEnabled = process.env.RLS_ENABLED === "1" && (process.env.DATABASE_URL ?? "").startsWith("postgres");

vi.mock("../src/lib/whatsapp.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendFlowMessage: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/lib/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/messaging.js")>();
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue(true),
    notifyMember: vi.fn().mockResolvedValue(true),
    platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
    sendSecurePrompt: vi.fn().mockResolvedValue(true),
  };
});

describe.skipIf(!rlsEnabled)("Row-Level Security: Cross-cooperative isolation at DB level", () => {
  let coopA: { id: string; code: string };
  let coopB: { id: string; code: string };
  let memberA: { id: string; phone: string; cooperativeId: string };
  let memberB: { id: string; phone: string; cooperativeId: string };

  beforeAll(async () => {
    // Create two cooperatives
    coopA = await prisma.cooperative.create({
      data: { name: "Coop A", code: "COOPA" },
    });
    coopB = await prisma.cooperative.create({
      data: { name: "Coop B", code: "COOPB" },
    });

    // Create a member in each cooperative
    const codeA = generateMemberCode();
    memberA = await prisma.member.create({
      data: {
        code: codeA,
        phone: "2348010000001",
        name: "Member A",
        cooperativeId: coopA.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
      select: { id: true, phone: true, cooperativeId: true },
    });

    const codeB = generateMemberCode();
    memberB = await prisma.member.create({
      data: {
        code: codeB,
        phone: "2348010000002",
        name: "Member B",
        cooperativeId: coopB.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
      select: { id: true, phone: true, cooperativeId: true },
    });
  });

  afterAll(async () => {
    // Cleanup
    await prisma.member.deleteMany({ where: { id: { in: [memberA.id, memberB.id] } } });
    await prisma.cooperative.deleteMany({ where: { id: { in: [coopA.id, coopB.id] } } });
  });

  function setCoopContext(cooperativeId: string) {
    return prisma.$executeRaw`SELECT set_config('app.current_cooperative_id', ${cooperativeId}, false)`;
  }

  function clearCoopContext() {
    return prisma.$executeRaw`SELECT set_config('app.current_cooperative_id', '', false)`;
  }

  it("blocks Member reads across cooperatives when RLS is active", async () => {
    // Set context to Coop A
    await setCoopContext(coopA.id);

    // Should see member A
    const visibleA = await prisma.member.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(visibleA.length).toBe(1);
    expect(visibleA[0].id).toBe(memberA.id);

    // Should NOT see member B (RLS blocks cross-coop read)
    const visibleB = await prisma.member.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(visibleB.length).toBe(0);

    // Clear context
    await clearCoopContext();
  });

  it("blocks Wallet reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    const walletA = await prisma.wallet.findMany({
      where: { memberId: memberA.id },
    });
    expect(walletA.length).toBe(1);

    const walletB = await prisma.wallet.findMany({
      where: { memberId: memberB.id },
    });
    expect(walletB.length).toBe(0);

    await clearCoopContext();
  });

  it("blocks Loan reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    // Create a loan for member A
    await prisma.loan.create({
      data: {
        amount: 100000,
        interestRate: 5,
        tenureMonths: 3,
        status: "pending",
        balance: 100000,
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });

    // Create a loan for member B (in different cooperative)
    await prisma.loan.create({
      data: {
        amount: 200000,
        interestRate: 5,
        tenureMonths: 6,
        status: "pending",
        balance: 200000,
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    // With Coop A context, should only see A's loan
    const loansA = await prisma.loan.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(loansA.length).toBe(1);
    expect(loansA[0].memberId).toBe(memberA.id);

    // Should NOT see B's loan
    const loansB = await prisma.loan.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(loansB.length).toBe(0);

    // Cleanup
    await prisma.loan.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("blocks Payout reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    await prisma.payout.create({
      data: {
        amount: 50000,
        reference: "TFR-TEST-A",
        idempotencyKey: "TFR-TEST-A",
        status: "successful",
        provider: "monnify",
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });

    await prisma.payout.create({
      data: {
        amount: 50000,
        reference: "TFR-TEST-B",
        idempotencyKey: "TFR-TEST-B",
        status: "successful",
        provider: "monnify",
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const payoutsA = await prisma.payout.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(payoutsA.length).toBe(1);
    expect(payoutsA[0].memberId).toBe(memberA.id);

    const payoutsB = await prisma.payout.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(payoutsB.length).toBe(0);

    await prisma.payout.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("blocks Contribution reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    await prisma.contribution.create({
      data: {
        amount: 10000,
        type: "savings",
        status: "confirmed",
        reference: "CON-TEST-A",
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });

    await prisma.contribution.create({
      data: {
        amount: 20000,
        type: "savings",
        status: "confirmed",
        reference: "CON-TEST-B",
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const contribsA = await prisma.contribution.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(contribsA.length).toBe(1);

    const contribsB = await prisma.contribution.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(contribsB.length).toBe(0);

    await prisma.contribution.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("blocks WithdrawalRequest reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    await prisma.withdrawalRequest.create({
      data: {
        amount: 10000,
        status: "pending",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });

    await prisma.withdrawalRequest.create({
      data: {
        amount: 20000,
        status: "pending",
        bankAccountNumber: "0987654321",
        bankCode: "044",
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const wdA = await prisma.withdrawalRequest.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(wdA.length).toBe(1);

    const wdB = await prisma.withdrawalRequest.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(wdB.length).toBe(0);

    await prisma.withdrawalRequest.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("blocks AuditLog reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopA.id,
        actorPhone: memberA.phone,
        actorId: memberA.id,
        actorRole: "member",
        action: "test.action",
        detail: "test",
      },
    });

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopB.id,
        actorPhone: memberB.phone,
        actorId: memberB.id,
        actorRole: "member",
        action: "test.action",
        detail: "test",
      },
    });

    const auditA = await prisma.auditLog.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(auditA.length).toBe(1);

    const auditB = await prisma.auditLog.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(auditB.length).toBe(0);

    await prisma.auditLog.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("blocks JournalEntry reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    const journalA = await prisma.journalEntry.create({
      data: {
        cooperativeId: coopA.id,
        txRef: "JE-TEST-A",
        description: "test",
        postings: {
          create: [
            { account: "assets:bank", direction: "DEBIT", amount: 10000 },
            { account: "income:test", direction: "CREDIT", amount: 10000 },
          ],
        },
      },
    });

    const journalB = await prisma.journalEntry.create({
      data: {
        cooperativeId: coopB.id,
        txRef: "JE-TEST-B",
        description: "test",
        postings: {
          create: [
            { account: "assets:bank", direction: "DEBIT", amount: 20000 },
            { account: "income:test", direction: "CREDIT", amount: 20000 },
          ],
        },
      },
    });

    const journalsA = await prisma.journalEntry.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(journalsA.length).toBe(1);

    const journalsB = await prisma.journalEntry.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(journalsB.length).toBe(0);

    await prisma.journalEntry.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("blocks LedgerEntry reads across cooperatives when RLS is active", async () => {
    await setCoopContext(coopA.id);

    await prisma.ledgerEntry.create({
      data: {
        cooperativeId: coopA.id,
        type: "income",
        category: "test",
        amount: 10000,
        note: "test",
        fundType: "operational",
      },
    });

    await prisma.ledgerEntry.create({
      data: {
        cooperativeId: coopB.id,
        type: "income",
        category: "test",
        amount: 20000,
        note: "test",
        fundType: "operational",
      },
    });

    const ledgerA = await prisma.ledgerEntry.findMany({
      where: { cooperativeId: coopA.id },
    });
    expect(ledgerA.length).toBe(1);

    const ledgerB = await prisma.ledgerEntry.findMany({
      where: { cooperativeId: coopB.id },
    });
    expect(ledgerB.length).toBe(0);

    await prisma.ledgerEntry.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
    await clearCoopContext();
  });

  it("fails closed when session variable is not set (no rows visible)", async () => {
    await clearCoopContext();

    // With no context set, RLS should deny all access (fail-closed)
    const members = await prisma.member.findMany();
    expect(members.length).toBe(0);

    const wallets = await prisma.wallet.findMany();
    expect(wallets.length).toBe(0);

    const loans = await prisma.loan.findMany();
    expect(loans.length).toBe(0);
  });
});