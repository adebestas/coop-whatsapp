import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { verifyMemberPin } from "../src/services/pin.js";
import { addGuarantor } from "../src/services/guarantors.js";
import { applyForLoan, repayLoan } from "../src/services/loans.js";
import { resolveProvider, markProviderDown, isProviderAvailable } from "../src/services/payments/index.js";
import { createTicket, listTickets, resolveTicket } from "../src/services/support.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
}));

const ADMIN_PHONE = "2348090000001";
const SUPER_PHONE = "2348090000099";
const PHONE = "2348010000001";
const G_PHONE = "2348071111111";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "Test Coop", code } });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string; pin?: string } = {}) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin(opts.pin ?? "1234"),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const m of [
    "voteBallot", "voteCandidate", "vote", "supportTicket", "auditLog",
    "deathValidation", "deathClaim", "withdrawalRequest", "contribution",
    "loanRepayment", "guarantor", "loan", "payout", "dividendEntry",
    "dividend", "broadcast", "wallet", "member", "unit", "cooperative", "session",
  ] as any[]) {
    await prisma[m].deleteMany();
  }
});

describe("fraud hardening", () => {
  it("locks the PIN after 3 wrong attempts and unlocks after the window", async () => {
    const coop = await makeCoop("TEST31");
    const member = await makeMember(PHONE, coop.id, { pin: "1234" });

    expect((await verifyMemberPin(member, "9999")).ok).toBe(false);
    expect((await verifyMemberPin(member, "9999")).ok).toBe(false);
    const third = await verifyMemberPin(member, "9999");
    expect(third.ok).toBe(false);
    expect(third.message).toContain("locked");

    // Even the right PIN is refused while locked.
    const fresh = await prisma.member.findUnique({ where: { id: member.id } });
    const locked = await verifyMemberPin(fresh!, "1234");
    expect(locked.ok).toBe(false);
    expect(locked.message).toContain("locked");

    // After the lock window passes, the correct PIN works again.
    await prisma.member.update({
      where: { id: member.id },
      data: { pinLockedUntil: new Date(Date.now() - 1000) },
    });
    const unlocked = await verifyMemberPin(await prisma.member.findUnique({ where: { id: member.id } }), "1234");
    expect(unlocked.ok).toBe(true);
    const cleared = await prisma.member.findUnique({ where: { id: member.id } });
    expect(cleared!.pinFailedCount).toBe(0);
  });

  it("expires abandoned multi-turn flows after 30 minutes", async () => {
    const coop = await makeCoop("TEST32");
    await makeMember(PHONE, coop.id);
    await prisma.session.create({
      data: { phone: PHONE, state: "awaiting_withdraw_pin", data: JSON.stringify({ withdrawAmount: 4000 }) },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE Session SET updatedAt = datetime('now', '-40 minutes') WHERE phone = ?`,
      PHONE,
    );

    await handleMessage(PHONE, "1234"); // stale PIN prompt must not process
    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("expired");

    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(session!.state).toBe("idle");
  });

  it("writes an audit trail entry when money moves", async () => {
    const coop = await makeCoop("TEST33");
    await makeMember(PHONE, coop.id);

    await handleMessage(PHONE, "save 5000");
    const logs = await prisma.auditLog.findMany({ where: { action: "contribution.create" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorPhone).toBe(PHONE);
  });
});

describe("nigeria cooperative rules", () => {
  it("caps loans at 2x savings and blocks defaulters", async () => {
    const coop = await makeCoop("TEST34");
    const member = await makeMember(PHONE, coop.id);
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 10000, totalSaved: 10000 },
    });

    const tooBig = await applyForLoan(PHONE, 25000, 3);
    expect(tooBig.ok).toBe(false);
    expect(tooBig.message).toContain("2x your savings");

    const ok = await applyForLoan(PHONE, 20000, 3);
    expect(ok.ok).toBe(true);

    // Make the loan overdue -> member is now defaulting.
    await prisma.loan.updateMany({
      where: { memberId: member.id },
      data: { status: "disbursed", dueDate: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });
    const blocked = await applyForLoan(PHONE, 5000, 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("behind");
  });

  it("charges a late fine on overdue repayments", async () => {
    const coop = await makeCoop("TEST35");
    const member = await makeMember(PHONE, coop.id);
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 20000, totalSaved: 20000 },
    });

    const loan = await prisma.loan.create({
      data: {
        amount: 5000,
        interestRate: 2,
        tenureMonths: 1,
        status: "disbursed",
        balance: 5100,
        monthlyPayment: 5100,
        dueDate: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000), // ~2 months late
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    const result = await repayLoan(PHONE);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("late fine");

    // Installment 5100 + fine (2% x 5100 x 2 months = 204) = 5304.
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(20000 - 5100 - 204);

    const fines = await prisma.contribution.findFirst({ where: { memberId: member.id, type: "fine" } });
    expect(fines!.amount).toBe(204);
    void loan;
  });

  it("stops a guarantor from backing more than 2 active loans", async () => {
    const coop = await makeCoop("TEST36");
    const guarantor = await makeMember(G_PHONE, coop.id);
    const a = await makeMember("2348010000011", coop.id);
    const b = await makeMember("2348010000012", coop.id);

    // Two active loans already guaranteed by G.
    for (const borrower of [a, b]) {
      const loan = await prisma.loan.create({
        data: {
          amount: 5000, interestRate: 2, tenureMonths: 2, status: "approved",
          balance: 5200, memberId: borrower.id, cooperativeId: coop.id,
        },
      });
      await prisma.guarantor.create({
        data: { loanId: loan.id, memberId: guarantor.id, code: `G${borrower.id.slice(-4).toUpperCase()}`, status: "confirmed" },
      });
    }

    // A third request must be refused.
    const cLoan = await prisma.loan.create({
      data: {
        amount: 5000, interestRate: 2, tenureMonths: 2, status: "pending",
        balance: 5000, memberId: a.id, cooperativeId: coop.id,
      },
    });
    const result = await addGuarantor(a.phone, cLoan.id, guarantor.code);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already guarantor");
  });
});

describe("support tickets", () => {
  it("creates a ticket and customer service resolves it", async () => {
    const coop = await makeCoop("TEST37");
    await makeMember(PHONE, coop.id);
    await makeMember("2348090000077", coop.id, { role: "support" });

    const created = await createTicket(PHONE, "My top-up has not reflected since yesterday");
    expect(created.ok).toBe(true);

    const listed = await listTickets("2348090000077");
    expect(listed.ok).toBe(true);
    expect(listed.message).toContain(created.ticketId!.slice(-6));

    const resolved = await resolveTicket("2348090000077", created.ticketId!.slice(-6), "Wallet credited manually");
    expect(resolved.ok).toBe(true);

    const ticket = await prisma.supportTicket.findUnique({ where: { id: created.ticketId! } });
    expect(ticket!.status).toBe("resolved");
    expect(ticket!.resolution).toContain("credited");

    // The member was notified in-chat.
    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("resolved");
  });

  it("lets the super admin assign the support role", async () => {
    const coop = await makeCoop("TEST38");
    const member = await makeMember(PHONE, coop.id);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });

    await handleMessage(SUPER_PHONE, `setrole ${member.code} support`);
    const updated = await prisma.member.findUnique({ where: { id: member.id } });
    expect(updated!.role).toBe("support");
  });
});

describe("voting engine", () => {
  it("elects a unit admin by ballot and installs the winner", async () => {
    const coop = await makeCoop("TEST39");
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const unit = await prisma.unit.create({
      data: { name: "Lagos Office", code: "LAG01", cooperativeId: coop.id },
    });
    const candidateA = await makeMember(PHONE, coop.id);
    const candidateB = await makeMember(G_PHONE, coop.id);
    await prisma.member.update({ where: { id: candidateA.id }, data: { unitId: unit.id } });
    await prisma.member.update({ where: { id: candidateB.id }, data: { unitId: unit.id } });
    const voter = await makeMember("2348010000044", coop.id);
    await prisma.member.update({ where: { id: voter.id }, data: { unitId: unit.id } });

    await handleMessage(ADMIN_PHONE, "startvote unit LAG01 Unit admin election");
    const vote = await prisma.vote.findFirst({ where: { cooperativeId: coop.id } });
    expect(vote).not.toBeNull();
    const shortId = vote!.id.slice(-6);

    await handleMessage(ADMIN_PHONE, `candidate ${shortId} ${candidateA.code}`);
    await handleMessage(ADMIN_PHONE, `candidate ${shortId} ${candidateB.code}`);

    // A non-unit member can't vote.
    const outsider = await makeMember("2348010000055", coop.id);
    await handleMessage(outsider.phone, `vote ${shortId} ${candidateA.code}`);
    expect(await prisma.voteBallot.count()).toBe(0);

    // Unit members vote — A gets 2, B gets 1.
    await handleMessage(voter.phone, `vote ${shortId} ${candidateA.code}`);
    await handleMessage(candidateA.phone, `vote ${shortId} ${candidateA.code}`);
    await handleMessage(candidateB.phone, `vote ${shortId} ${candidateB.code}`);

    // One person, one vote.
    await handleMessage(voter.phone, `vote ${shortId} ${candidateB.code}`);
    expect(await prisma.voteBallot.count()).toBe(3);

    await handleMessage(ADMIN_PHONE, `closevote ${shortId}`);
    const closed = await prisma.vote.findUnique({ where: { id: vote!.id } });
    expect(closed!.status).toBe("closed");
    expect(closed!.winnerId).toBe(candidateA.id);

    // Winner installed as unit admin.
    const winner = await prisma.member.findUnique({ where: { id: candidateA.id } });
    expect(winner!.role).toBe("admin");
    const updatedUnit = await prisma.unit.findUnique({ where: { id: unit.id } });
    expect(updatedUnit!.adminMemberId).toBe(candidateA.id);
    void admin;
  });

  it("runs a cooperative-wide executive election", async () => {
    const coop = await makeCoop("TEST40");
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const a = await makeMember(PHONE, coop.id);
    const b = await makeMember(G_PHONE, coop.id);

    await handleMessage(ADMIN_PHONE, "startvote exec President Executive election 2026");
    const vote = await prisma.vote.findFirst({ where: { cooperativeId: coop.id } });
    const shortId = vote!.id.slice(-6);
    await handleMessage(ADMIN_PHONE, `candidate ${shortId} ${a.code}`);
    await handleMessage(ADMIN_PHONE, `candidate ${shortId} ${b.code}`);

    await handleMessage(a.phone, `vote ${shortId} ${b.code}`);
    await handleMessage(b.phone, `vote ${shortId} ${b.code}`);

    const result = await handleMessage(ADMIN_PHONE, `closevote ${shortId}`);
    void result;
    const closed = await prisma.vote.findUnique({ where: { id: vote!.id } });
    expect(closed!.status).toBe("closed");
    expect(closed!.winnerId).toBe(b.id);
    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("is elected *president*");
  });
});

describe("provider failover", () => {
  it("routes to the healthy provider when one is marked down", () => {
    expect(resolveProvider().name).toBe("flutterwave"); // env default
    markProviderDown("flutterwave");
    expect(isProviderAvailable("flutterwave")).toBe(false);
    expect(resolveProvider().name).toBe("paystack");
    markProviderDown("paystack");
    // Everything down -> falls back to the configured provider.
    expect(resolveProvider().name).toBe("flutterwave");
  });
});
