import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDatabase, createTestCoop, createTestMember, prisma } from "./setup.js";
import {
  appointMember,
  committeeMajority,
  createCommittee,
  hasActiveCommittee,
  isCommitteeMember,
  listCommittees,
  recordCommitteeVote,
  removeMember,
} from "../src/services/committees.js";
import { approveLoan } from "../src/services/loans.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => c[0].text)
    .join("\n");
}

const SUPER = { phone: "2348090000001", role: "superadmin" as const };

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

describe("committee service", () => {
  it("creates a credit committee, appoints 3 members, and lists it", async () => {
    const coop = await createTestCoop("CMT01");
    const superAdmin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000001", name: "Ada Obi" });
    const b = await createTestMember(coop.id, { phone: "2348010000002", name: "Bola Ade" });
    const c = await createTestMember(coop.id, { phone: "2348010000003", name: "Chidi Eze" });

    const actor = { phone: superAdmin.phone, id: superAdmin.id, role: "superadmin" };
    const created = await createCommittee(coop.id, "credit", "Credit Committee", 3, actor);
    expect(created.ok).toBe(true);
    expect(created.committeeId).toBeTruthy();

    const chair = await appointMember(coop.id, "credit", a.code, "chair", actor);
    expect(chair.ok).toBe(true);
    expect((await appointMember(coop.id, "credit", b.code, "member", actor)).ok).toBe(true);
    expect((await appointMember(coop.id, "credit", c.code, "member", actor)).ok).toBe(true);

    expect(await isCommitteeMember(coop.id, "credit", a.id)).toBe(true);
    expect(await isCommitteeMember(coop.id, "credit", b.id)).toBe(true);
    expect(await isCommitteeMember(coop.id, "credit", c.id)).toBe(true);

    const stored = await prisma.committee.findUnique({ where: { id: created.committeeId! } });
    expect(stored!.size).toBe(3);
    expect(await prisma.committeeMember.count()).toBe(3);

    const listed = await listCommittees(coop.id);
    expect(listed.ok).toBe(true);
    expect(listed.message).toContain("Credit Committee");
    expect(listed.message).toContain("Ada Obi");

    expect(committeeMajority(3)).toBe(2);
    expect(committeeMajority(5)).toBe(3);
    expect(committeeMajority(1)).toBe(1);

    const actions = (
      await prisma.auditLog.findMany({ where: { cooperativeId: coop.id }, select: { action: true } })
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["committee.create", "committee.appoint"]),
    );
  });

  it("rejects an invalid type and duplicate committees", async () => {
    const coop = await createTestCoop("CMT02");
    const superAdmin = await createTestMember(coop.id, SUPER);
    const actor = { phone: superAdmin.phone, id: superAdmin.id, role: "superadmin" };

    const bad = await createCommittee(coop.id, "finance", "Finance", 3, actor);
    expect(bad.ok).toBe(false);

    expect((await createCommittee(coop.id, "credit", "Credit", 3, actor)).ok).toBe(true);
    const dup = await createCommittee(coop.id, "credit", "Credit Again", 3, actor);
    expect(dup.ok).toBe(false);
    expect(await prisma.committee.count()).toBe(1);
  });

  it("does not appoint the same member twice", async () => {
    const coop = await createTestCoop("CMT03");
    const superAdmin = await createTestMember(coop.id, SUPER);
    const actor = { phone: superAdmin.phone, id: superAdmin.id, role: "superadmin" };
    const m = await createTestMember(coop.id, { phone: "2348010000010" });
    await createCommittee(coop.id, "credit", "Credit", 3, actor);

    expect((await appointMember(coop.id, "credit", m.code, "member", actor)).ok).toBe(true);
    const second = await appointMember(coop.id, "credit", m.code, "member", actor);
    expect(second.ok).toBe(false);
    expect(await prisma.committeeMember.count()).toBe(1);

    // Removing then re-appointing reactivates the same seat rather than duplicating it.
    expect((await removeMember(coop.id, "credit", m.code, actor)).ok).toBe(true);
    expect(await isCommitteeMember(coop.id, "credit", m.id)).toBe(false);
    expect((await appointMember(coop.id, "credit", m.code, "member", actor)).ok).toBe(true);
    expect(await prisma.committeeMember.count()).toBe(1);
  });

  it("rejects a non-super actor at the service level", async () => {
    const coop = await createTestCoop("CMT06");
    const plainAdmin = await createTestMember(coop.id, { phone: "2348090000100", role: "admin" });
    const nonSuper = { id: plainAdmin.id, role: "admin", phone: plainAdmin.phone };

    const created = await createCommittee(coop.id, "credit", "Credit", 3, nonSuper);
    expect(created.ok).toBe(false);
    expect(created.message).toContain("super admin");
    expect(await prisma.committee.count()).toBe(0);

    // Even if a committee already exists, a non-super cannot appoint or remove.
    await createCommittee(coop.id, "credit", "Credit", 3, {
      id: "super-1",
      role: "superadmin",
    });
    const target = await createTestMember(coop.id, { phone: "2348010000020" });
    expect((await appointMember(coop.id, "credit", target.code, "member", nonSuper)).ok).toBe(false);
    expect(
      (await removeMember(coop.id, "credit", target.code, nonSuper)).ok,
    ).toBe(false);
    expect(await prisma.committeeMember.count()).toBe(0);
  });
});

describe("committee admin commands", () => {
  it("blocks a non-super admin from creating or appointing", async () => {
    const coop = await createTestCoop("CMT04");
    const plainAdmin = await createTestMember(coop.id, { phone: "2348090000100", role: "admin" });
    const target = await createTestMember(coop.id, { phone: "2348010000020" });

    await handleMessage(plainAdmin.phone, "addcommittee credit Credit 3");
    expect(await prisma.committee.count()).toBe(0);
    expect(textsSent()).toContain("super admin");

    await createCommittee(coop.id, "credit", "Credit", 3, { id: "super-1", role: "superadmin" });
    await handleMessage(plainAdmin.phone, `appoint credit ${target.code} chair`);
    expect(await prisma.committeeMember.count()).toBe(0);
  });

  it("defaults committee size per type from cooperative config", async () => {
    const coop = await createTestCoop("CMT07");
    const superAdmin = await createTestMember(coop.id, SUPER);
    await prisma.cooperativeConfig.create({
      data: {
        cooperativeId: coop.id,
        creditCommitteeSize: 4,
        supervisoryCommitteeSize: 2,
        boardSize: 7,
      },
    });

    await handleMessage(superAdmin.phone, "addcommittee credit Credit");
    await handleMessage(superAdmin.phone, "addcommittee supervisory Supervisory");
    await handleMessage(superAdmin.phone, "addcommittee board Board");

    expect((await prisma.committee.findFirst({ where: { type: "credit" } }))!.size).toBe(4);
    expect((await prisma.committee.findFirst({ where: { type: "supervisory" } }))!.size).toBe(2);
    expect((await prisma.committee.findFirst({ where: { type: "board" } }))!.size).toBe(7);
  });

  it("lets the super admin create, appoint, list and remove via chat", async () => {
    const coop = await createTestCoop("CMT05");
    const superAdmin = await createTestMember(coop.id, SUPER);
    const m = await createTestMember(coop.id, { phone: "2348010000030", name: "Ada Obi" });

    await handleMessage(superAdmin.phone, "addcommittee credit Credit Committee 3");
    const committee = await prisma.committee.findFirst();
    expect(committee).not.toBeNull();
    expect(committee!.size).toBe(3);

    await handleMessage(superAdmin.phone, `appoint credit ${m.code} chair`);
    const cm = await prisma.committeeMember.findFirst();
    expect(cm!.memberId).toBe(m.id);
    expect(cm!.role).toBe("chair");

    await handleMessage(superAdmin.phone, "committees");
    expect(textsSent()).toContain("Credit Committee");

    await handleMessage(superAdmin.phone, `removecommittee credit ${m.code}`);
    const after = await prisma.committeeMember.findFirst();
    expect(after!.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credit Committee loan approval
// ---------------------------------------------------------------------------

/** A borrower with savings + bank details, 20 padding members, and an
 *  `admin_approved` loan ready for the final approval stage. */
async function makeAdminApprovedLoan(coopId: string, tag: string) {
  const borrower = await createTestMember(coopId, { phone: `234701${tag}0001`, name: "Ada Obi" });
  await prisma.wallet.update({
    where: { memberId: borrower.id },
    data: { balance: 5_000_000, totalSaved: 5_000_000 },
  });
  for (let i = 0; i < 20; i++) {
    await createTestMember(coopId, { phone: `234702${tag}${String(i).padStart(4, "0")}` });
  }
  const loan = await prisma.loan.create({
    data: {
      amount: 4_000_000,
      balance: 4_000_000,
      interestRate: 8,
      tenureMonths: 4,
      status: "admin_approved",
      memberId: borrower.id,
      cooperativeId: coopId,
      bankAccountNumber: "0123456789",
      bankCode: "044",
      bankName: "Access",
      adminCharge: 200000,
    },
  });
  return { borrower, loan };
}

async function seatedCreditCommittee(coopId: string) {
  const superAdmin = await createTestMember(coopId, SUPER);
  const actor = { phone: superAdmin.phone, id: superAdmin.id, role: "superadmin" as const };
  const a = await createTestMember(coopId, { phone: "2348030000001", name: "Comm A" });
  const b = await createTestMember(coopId, { phone: "2348030000002", name: "Comm B" });
  const c = await createTestMember(coopId, { phone: "2348030000003", name: "Comm C" });
  await createCommittee(coopId, "credit", "Credit Committee", 3, actor);
  await appointMember(coopId, "credit", a.code, "chair", actor);
  await appointMember(coopId, "credit", b.code, "member", actor);
  await appointMember(coopId, "credit", c.code, "member", actor);
  return { a, b, c };
}

describe("credit committee loan approval", () => {
  it("finalizes and disburses once a majority of the credit committee approves", async () => {
    const coop = await createTestCoop("CCM01");
    const { a, b } = await seatedCreditCommittee(coop.id);
    const { loan } = await makeAdminApprovedLoan(coop.id, "1");

    const first = await approveLoan(loan.id.slice(-6), { cooperativeId: coop.id, actorId: a.id });
    expect(first.ok).toBe(true);
    expect((await prisma.loan.findUnique({ where: { id: loan.id } }))!.status).toBe("admin_approved");
    expect(await prisma.payout.count()).toBe(0);

    const second = await approveLoan(loan.id.slice(-6), { cooperativeId: coop.id, actorId: b.id });
    expect(second.ok).toBe(true);
    const after = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(after!.status).toBe("disbursed");
    expect(await prisma.payout.count()).toBe(1);

    const decision = await prisma.committeeDecision.findFirst({ where: { subjectId: loan.id } });
    expect(decision!.status).toBe("approved");
  });

  it("does not finalize on a single committee vote", async () => {
    const coop = await createTestCoop("CCM02");
    const { a } = await seatedCreditCommittee(coop.id);
    const { loan } = await makeAdminApprovedLoan(coop.id, "2");

    const res = await approveLoan(loan.id.slice(-6), { cooperativeId: coop.id, actorId: a.id });
    expect(res.ok).toBe(true);
    expect((await prisma.loan.findUnique({ where: { id: loan.id } }))!.status).toBe("admin_approved");
    expect(await prisma.payout.count()).toBe(0);
    expect(await prisma.committeeVote.count()).toBe(1);
  });

  it("rejects a vote from someone who is not on the credit committee", async () => {
    const coop = await createTestCoop("CCM03");
    await seatedCreditCommittee(coop.id);
    const outsider = await createTestMember(coop.id, { phone: "2348060000001", role: "admin" });
    const { loan } = await makeAdminApprovedLoan(coop.id, "3");

    const res = await approveLoan(loan.id.slice(-6), {
      cooperativeId: coop.id,
      actorId: outsider.id,
      isAdmin: true,
    });
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain("committee");
    expect((await prisma.loan.findUnique({ where: { id: loan.id } }))!.status).toBe("admin_approved");
    expect(await prisma.committeeVote.count()).toBe(0);
  });

  it("does not let a committee member vote twice", async () => {
    const coop = await createTestCoop("CCM04");
    const { a } = await seatedCreditCommittee(coop.id);
    const { loan } = await makeAdminApprovedLoan(coop.id, "4");

    expect(
      (await approveLoan(loan.id.slice(-6), { cooperativeId: coop.id, actorId: a.id })).ok,
    ).toBe(true);
    const again = await approveLoan(loan.id.slice(-6), { cooperativeId: coop.id, actorId: a.id });
    expect(again.ok).toBe(false);
    expect(await prisma.committeeVote.count()).toBe(1);
    expect((await prisma.loan.findUnique({ where: { id: loan.id } }))!.status).toBe("admin_approved");
  });

  it("keeps the super-admin chain when the coop has no credit committee", async () => {
    const coop = await createTestCoop("CCM05");
    const super1 = await createTestMember(coop.id, { phone: "2348040000001", role: "superadmin" });
    const { loan } = await makeAdminApprovedLoan(coop.id, "5");

    expect(await hasActiveCommittee(coop.id, "credit")).toBe(false);
    const res = await approveLoan(loan.id.slice(-6), {
      cooperativeId: coop.id,
      superAdmin: true,
      actorId: super1.id,
    });
    expect(res.ok).toBe(true);
    expect((await prisma.loan.findUnique({ where: { id: loan.id } }))!.status).toBe("super_approved_1");
  });
});

describe("recordCommitteeVote", () => {
  it("tallies to a majority, rejecting duplicate and non-member votes", async () => {
    const coop = await createTestCoop("CCM07");
    const { a, b } = await seatedCreditCommittee(coop.id);
    const outsider = await createTestMember(coop.id, { phone: "2348060000002" });

    expect(await hasActiveCommittee(coop.id, "credit")).toBe(true);

    const r1 = await recordCommitteeVote(coop.id, "credit", "loan", "loan-xyz", a.id, "approve");
    expect(r1.ok).toBe(true);
    expect(r1.decided).toBeUndefined();

    const dup = await recordCommitteeVote(coop.id, "credit", "loan", "loan-xyz", a.id, "approve");
    expect(dup.ok).toBe(false);

    const non = await recordCommitteeVote(coop.id, "credit", "loan", "loan-xyz", outsider.id, "approve");
    expect(non.ok).toBe(false);

    const r2 = await recordCommitteeVote(coop.id, "credit", "loan", "loan-xyz", b.id, "approve");
    expect(r2.ok).toBe(true);
    expect(r2.decided).toBe("approved");
  });
});

describe("supervisory freeze", () => {
  it("blocks a member's money-out after a supervisory committee freeze", async () => {
    const coop = await createTestCoop("CCM06");
    const superAdmin = await createTestMember(coop.id, SUPER);
    const actor = { phone: superAdmin.phone, id: superAdmin.id, role: "superadmin" as const };
    const sup = await createTestMember(coop.id, { phone: "2348050000001", name: "Sup One" });
    const target = await createTestMember(coop.id, { phone: "2348050000002", name: "Target Member" });

    await createCommittee(coop.id, "supervisory", "Supervisory Committee", 3, actor);
    await appointMember(coop.id, "supervisory", sup.code, "chair", actor);

    await handleMessage(sup.phone, `supervisoryfreeze ${target.code} suspected fraud`);
    expect((await prisma.member.findUnique({ where: { id: target.id } }))!.frozenAt).not.toBeNull();

    await handleMessage(target.phone, "withdraw 1000");
    expect(textsSent().toLowerCase()).toContain("frozen");

    await handleMessage(sup.phone, `supervisoryunfreeze ${target.code}`);
    expect((await prisma.member.findUnique({ where: { id: target.id } }))!.frozenAt).toBeNull();
  });
});
