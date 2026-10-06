import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { paymentState } from "./payment-state.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { disburseLoan } from "../src/services/disbursements.js";
import { approveClaim } from "../src/services/deathclaims.js";
import { trialBalance } from "../src/services/journal.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Protection Coop ${code}`, code } });
}

async function makeMember(coopId: string, name: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone: `2348${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      name,
      cooperativeId: coopId,
      role: "member",
      status: "active",
      pin: hashPin("1234"),
      bankAccountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
      wallet: { create: {} },
    },
  });
}

async function makeSuper(coopId: string, name: string) {
  const m = await makeMember(coopId, name);
  return prisma.member.update({ where: { id: m.id }, data: { role: "superadmin" } });
}

/** A loan already approved and ready for disbursement. */
async function makeApprovedLoan(
  coopId: string,
  memberId: string,
  opts: { amount: number; adminCharge: number },
) {
  return prisma.loan.create({
    data: {
      amount: opts.amount,
      balance: opts.amount,
      adminCharge: opts.adminCharge,
      status: "approved",
      memberId,
      cooperativeId: coopId,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
    },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  paymentState.resolveFails = false;
  paymentState.payoutFails = false;
  paymentState.payoutPending = false;
});

describe("loan protection premium at disbursement", () => {
  it("withholds 1% as the protection premium and posts it to the fund", async () => {
    const coop = await makeCoop("PROT1");
    const member = await makeMember(coop.id, "Ada Obi");
    paymentState.resolveName = member.name;
    // 100000 kobo (₦1,000) loan, 20000 kobo admin charge, 1% protection
    // => premium 1000 kobo, member receives 79000 kobo.
    const loan = await makeApprovedLoan(coop.id, member.id, { amount: 100000, adminCharge: 20000 });

    const result = await disburseLoan(loan.id);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/protection/i);

    // The member was paid the net amount.
    const payout = await prisma.payout.findUnique({
      where: { idempotencyKey: `TFR-LOAN-${loan.id}` },
    });
    expect(payout).not.toBeNull();
    expect(payout!.amount).toBe(79000);

    // A protection record exists with the premium.
    const protection = await prisma.loanProtection.findUnique({ where: { loanId: loan.id } });
    expect(protection).not.toBeNull();
    expect(protection!.premium).toBe(1000);
    expect(protection!.memberId).toBe(member.id);
    expect(protection!.status).toBe("active");

    // The cooperative's protection fund was incremented.
    const updatedCoop = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updatedCoop!.protectionFundBalance).toBe(1000);

    // A balance-sheet ledger row records the fund movement.
    const entry = await prisma.ledgerEntry.findFirst({
      where: { cooperativeId: coop.id, category: "liabilities:loan_protection_fund" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("balance_sheet");
    expect(entry!.amount).toBe(1000);

    // Double-entry: DEBIT assets:bank / CREDIT liabilities:loan_protection_fund.
    const jr = await prisma.journalEntry.findUnique({
      where: { txRef: `LOAN-PROT-${loan.id}` },
      include: { postings: true },
    });
    expect(jr).not.toBeNull();
    const debit = jr!.postings
      .filter((p) => p.direction === "DEBIT")
      .reduce((s, p) => s + p.amount, 0);
    const credit = jr!.postings
      .filter((p) => p.direction === "CREDIT")
      .reduce((s, p) => s + p.amount, 0);
    expect(debit).toBe(1000);
    expect(credit).toBe(1000);
    expect(
      jr!.postings.find((p) => p.direction === "DEBIT")!.account,
    ).toBe("assets:bank");
    expect(
      jr!.postings.find((p) => p.direction === "CREDIT")!.account,
    ).toBe("liabilities:loan_protection_fund");

    expect((await trialBalance(coop.id)).balanced).toBe(true);
  });

  it("skips the premium entirely when protection is disabled", async () => {
    const coop = await makeCoop("PROT2");
    const member = await makeMember(coop.id, "Ada Obi");
    paymentState.resolveName = member.name;
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, loanProtectionEnabled: false, loanProtectionPercent: 0 },
    });
    const loan = await makeApprovedLoan(coop.id, member.id, { amount: 100000, adminCharge: 20000 });

    const result = await disburseLoan(loan.id);
    expect(result.ok).toBe(true);

    const payout = await prisma.payout.findUnique({
      where: { idempotencyKey: `TFR-LOAN-${loan.id}` },
    });
    expect(payout!.amount).toBe(80000); // no premium withheld

    expect(await prisma.loanProtection.count({ where: { loanId: loan.id } })).toBe(0);
    const updatedCoop = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updatedCoop!.protectionFundBalance).toBe(0);
    expect(
      await prisma.journalEntry.findUnique({ where: { txRef: `LOAN-PROT-${loan.id}` } }),
    ).toBeNull();
    expect((await trialBalance(coop.id)).balanced).toBe(true);
  });
});

describe("loan protection write-off on an approved death claim", () => {
  async function makeOutstandingLoan(coopId: string, memberId: string, balance: number) {
    return prisma.loan.create({
      data: {
        amount: 100000,
        balance,
        adminCharge: 20000,
        status: "disbursed",
        memberId,
        cooperativeId: coopId,
        bankAccountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
      },
    });
  }

  async function makeValidatedClaim(coopId: string, memberId: string) {
    return prisma.deathClaim.create({
      data: {
        status: "validated",
        memberId,
        cooperativeId: coopId,
        familyConfirmed: true,
        approvalsRequired: 1,
        familyAccountNumber: "0123456789",
        familyBankCode: "058",
        familyBankName: "GTBank",
        waitingPeriodEnd: new Date(Date.now() - 60_000),
      },
    });
  }

  it("writes off the outstanding loan from the fund and still pays the savings", async () => {
    const coop = await makeCoop("PROT3");
    const deceased = await makeMember(coop.id, "Ada Obi");
    const superA = await makeSuper(coop.id, "Super One");
    await prisma.wallet.update({ where: { memberId: deceased.id }, data: { balance: 50000 } });

    const loan = await makeOutstandingLoan(coop.id, deceased.id, 40000);
    await prisma.loanProtection.create({
      data: {
        cooperativeId: coop.id,
        loanId: loan.id,
        memberId: deceased.id,
        premium: 1000,
        status: "active",
      },
    });
    // An accumulated fund larger than the single outstanding balance.
    await prisma.cooperative.update({
      where: { id: coop.id },
      data: { protectionFundBalance: 50000 },
    });

    const claim = await makeValidatedClaim(coop.id, deceased.id);

    const result = await approveClaim(superA.phone, claim.id.slice(-6));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/written off under loan protection/i);

    // The loan is settled.
    const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updatedLoan!.status).toBe("paid");
    expect(updatedLoan!.balance).toBe(0);

    // The protection record is claimed with the written-off amount.
    const protection = await prisma.loanProtection.findUnique({ where: { loanId: loan.id } });
    expect(protection!.status).toBe("claimed");
    expect(protection!.claimId).toBe(claim.id);
    expect(protection!.writtenOff).toBe(40000);
    expect(protection!.claimedAt).not.toBeNull();

    // The fund absorbed the write-off.
    const updatedCoop = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updatedCoop!.protectionFundBalance).toBe(10000);

    // Double-entry: DEBIT liabilities:loan_protection_fund / CREDIT assets:loan_portfolio.
    const jr = await prisma.journalEntry.findUnique({
      where: { txRef: `LOAN-PROT-CLAIM-${claim.id}-${loan.id}` },
      include: { postings: true },
    });
    expect(jr).not.toBeNull();
    expect(jr!.postings.find((p) => p.direction === "DEBIT")!.account).toBe(
      "liabilities:loan_protection_fund",
    );
    expect(jr!.postings.find((p) => p.direction === "CREDIT")!.account).toBe(
      "assets:loan_portfolio",
    );
    expect(
      jr!.postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount, 0),
    ).toBe(40000);
    expect((await trialBalance(coop.id)).balanced).toBe(true);

    // The savings payout to the family still went through.
    const wallet = await prisma.wallet.findUnique({ where: { memberId: deceased.id } });
    expect(wallet!.balance).toBe(0);
    const payout = await prisma.payout.findUnique({
      where: { idempotencyKey: `TFR-CLAIM-${claim.id}` },
    });
    expect(payout).not.toBeNull();
    expect(payout!.amount).toBe(50000);

    const finalClaim = await prisma.deathClaim.findUnique({ where: { id: claim.id } });
    expect(finalClaim!.status).toBe("paid");
  });

  it("never lets the protection fund go negative — excess is absorbed, not thrown", async () => {
    const coop = await makeCoop("PROT4");
    const deceased = await makeMember(coop.id, "Ada Obi");
    const superA = await makeSuper(coop.id, "Super One");
    await prisma.wallet.update({ where: { memberId: deceased.id }, data: { balance: 20000 } });

    const loan = await makeOutstandingLoan(coop.id, deceased.id, 40000);
    await prisma.loanProtection.create({
      data: {
        cooperativeId: coop.id,
        loanId: loan.id,
        memberId: deceased.id,
        premium: 1000,
        status: "active",
      },
    });
    // Fund is smaller than the outstanding balance.
    await prisma.cooperative.update({
      where: { id: coop.id },
      data: { protectionFundBalance: 1000 },
    });

    const claim = await makeValidatedClaim(coop.id, deceased.id);

    const result = await approveClaim(superA.phone, claim.id.slice(-6));
    expect(result.ok).toBe(true);

    const updatedCoop = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updatedCoop!.protectionFundBalance).toBe(0);

    const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updatedLoan!.status).toBe("paid");
    expect(updatedLoan!.balance).toBe(0);
    expect((await trialBalance(coop.id)).balanced).toBe(true);
  });
});
