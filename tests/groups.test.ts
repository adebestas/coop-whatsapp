import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
} from "./setup.js";
import {
  createGroup,
  joinGroup,
  contributeToGroup,
  closeGroupCycle,
  listGroups,
  groupStatus,
  myGroups,
  applyGroupLoan,
  groupLoans,
} from "../src/services/groups.js";
import { approveLoan } from "../src/services/loans.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { createUnit, setUnitAdmin } from "../src/services/units.js";
import { sendText } from "../src/lib/messaging.js";

const actor = (m: { id: string; phone: string; role: string }): {
  id: string;
  phone: string;
  role: string;
} => ({ id: m.id, phone: m.phone, role: m.role });

async function fundWallet(memberId: string, kobo: number) {
  await prisma.wallet.update({ where: { memberId }, data: { balance: kobo } });
}

async function walletBalance(memberId: string): Promise<number> {
  return (await prisma.wallet.findUnique({ where: { memberId } }))?.balance ?? 0;
}

async function postingsBalance(): Promise<{ debit: number; credit: number }> {
  const postings = await prisma.posting.findMany();
  return {
    debit: postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount, 0),
    credit: postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount, 0),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("ROSCA groups", () => {
  it("creates a ROSCA, rotates the pot through member wallets and advances the cycle", async () => {
    const coop = await createTestCoop("ROSCA1");
    const admin = await createTestMember(coop.id, { phone: "2348000010001", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010002" });
    const b = await createTestMember(coop.id, { phone: "2348000010003" });

    const created = await createGroup(
      coop.id,
      "rosca",
      "Family",
      "FAM1",
      500000,
      2,
      actor(admin),
    );
    expect(created.ok).toBe(true);
    const groupId = created.groupId!;

    const cycles0 = await prisma.groupCycle.findMany({ where: { groupId } });
    expect(cycles0).toHaveLength(1);
    expect(cycles0[0].cycleNumber).toBe(1);
    expect(cycles0[0].status).toBe("open");

    expect((await joinGroup(coop.id, "FAM1", a.id)).ok).toBe(true);
    expect((await joinGroup(coop.id, "FAM1", b.id)).ok).toBe(true);
    const ma = await prisma.groupMember.findFirst({ where: { groupId, memberId: a.id } });
    const mb = await prisma.groupMember.findFirst({ where: { groupId, memberId: b.id } });
    expect(ma?.rotationPosition).toBe(1);
    expect(mb?.rotationPosition).toBe(2);

    await fundWallet(a.id, 500000);
    await fundWallet(b.id, 500000);

    // Contributions debit the member's wallet.
    expect((await contributeToGroup(coop.id, groupId, a.id, 500000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 500000)).ok).toBe(true);
    expect(await walletBalance(a.id)).toBe(0);
    expect(await walletBalance(b.id)).toBe(0);

    const status = await groupStatus(coop.id, groupId);
    expect(status.ok).toBe(true);
    expect(status.pot).toBe(1000000);

    // Cycle 1 pays position 1 (a): the pot lands in a's wallet.
    const closed = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed.ok).toBe(true);
    expect(closed.payoutMemberId).toBe(a.id);
    expect(closed.shareOutAmount).toBe(1000000);
    expect(await walletBalance(a.id)).toBe(1000000);
    expect(await walletBalance(b.id)).toBe(0);

    const cycles = await prisma.groupCycle.findMany({
      where: { groupId },
      orderBy: { cycleNumber: "asc" },
    });
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe("closed");
    expect(cycles[1].status).toBe("open");
    expect(cycles[1].cycleNumber).toBe(2);

    // Cycle 2 advances the rotation to position 2 (b).
    await fundWallet(b.id, 500000);
    expect((await contributeToGroup(coop.id, groupId, a.id, 500000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 500000)).ok).toBe(true);
    const closed2 = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed2.ok).toBe(true);
    expect(closed2.payoutMemberId).toBe(b.id);
    expect(await walletBalance(b.id)).toBe(1000000);
    expect(await walletBalance(a.id)).toBe(500000);

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    expect(group?.status).toBe("closed");

    const { debit, credit } = await postingsBalance();
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);
  });

  it("refuses a duplicate join, a non-member contribution and a second round contribution", async () => {
    const coop = await createTestCoop("ROSCA2");
    const admin = await createTestMember(coop.id, { phone: "2348000010010", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010011" });
    const outsider = await createTestMember(coop.id, { phone: "2348000010012" });

    const created = await createGroup(coop.id, "rosca", "Circle", "CIR1", 100000, 3, actor(admin));
    const groupId = created.groupId!;

    expect((await joinGroup(coop.id, "CIR1", a.id)).ok).toBe(true);
    const dup = await joinGroup(coop.id, "CIR1", a.id);
    expect(dup.ok).toBe(false);
    expect(dup.message).toMatch(/already/i);

    // An outsider (not a group member) may not contribute.
    await fundWallet(outsider.id, 100000);
    const notMember = await contributeToGroup(coop.id, groupId, outsider.id, 100000);
    expect(notMember.ok).toBe(false);
    expect(
      await prisma.groupContribution.findFirst({ where: { groupId, memberId: outsider.id } }),
    ).toBeNull();
    expect(await walletBalance(outsider.id)).toBe(100000);

    // A member may contribute only once per ROSCA round.
    await fundWallet(a.id, 500000);
    expect((await contributeToGroup(coop.id, groupId, a.id, 100000)).ok).toBe(true);
    const again = await contributeToGroup(coop.id, groupId, a.id, 100000);
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already/i);
    const cycle = await prisma.groupCycle.findFirst({ where: { groupId, status: "open" } });
    expect(
      await prisma.groupContribution.count({ where: { cycleId: cycle!.id, memberId: a.id } }),
    ).toBe(1);
    expect(await walletBalance(a.id)).toBe(400000);
  });

  it("validates the fixed contribution amount for a ROSCA", async () => {
    const coop = await createTestCoop("ROSCA3");
    const admin = await createTestMember(coop.id, { phone: "2348000010020", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010021" });
    const created = await createGroup(coop.id, "rosca", "Fixed", "FIX1", 100000, 3, actor(admin));
    await joinGroup(coop.id, "FIX1", a.id);
    await fundWallet(a.id, 100000);

    const wrong = await contributeToGroup(coop.id, created.groupId!, a.id, 50000);
    expect(wrong.ok).toBe(false);
    expect(await walletBalance(a.id)).toBe(100000);
  });
});

describe("VSLA groups", () => {
  it("shares out by largest remainder and credits each member wallet", async () => {
    const coop = await createTestCoop("VSLA1");
    const admin = await createTestMember(coop.id, { phone: "2348000010100", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010101" });
    const b = await createTestMember(coop.id, { phone: "2348000010102" });
    const c = await createTestMember(coop.id, { phone: "2348000010103" });

    const created = await createGroup(coop.id, "vsla", "Market", "MKT1", 100000, 4, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "MKT1", a.id);
    await joinGroup(coop.id, "MKT1", b.id);
    await joinGroup(coop.id, "MKT1", c.id);

    for (const m of [a, b, c]) {
      await fundWallet(m.id, 100000);
      expect((await contributeToGroup(coop.id, groupId, m.id, 100000)).ok).toBe(true);
    }

    // Force a non-divisible split: 3/2/2 shares over a 300,000 pot (total 7).
    for (const [m, shares] of [
      [a, 3],
      [b, 2],
      [c, 2],
    ] as const) {
      const gm = await prisma.groupMember.findFirst({ where: { groupId, memberId: m.id } });
      await prisma.groupMember.update({ where: { id: gm!.id }, data: { shares } });
    }

    const closed = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed.ok).toBe(true);
    expect(closed.shareOutAmount).toBe(300000);
    const byId = Object.fromEntries((closed.payouts ?? []).map((p) => [p.memberId, p.amount]));
    // 300000 * 3/7 = 128571.43 -> 128571, remainder 3 (largest) takes the extra kobo
    // 300000 * 2/7 =  85714.29 ->  85714, remainder 2
    expect(byId[a.id]).toBe(128572);
    expect(byId[b.id]).toBe(85714);
    expect(byId[c.id]).toBe(85714);
    expect(byId[a.id] + byId[b.id] + byId[c.id]).toBe(300000);

    expect(await walletBalance(a.id)).toBe(128572);
    expect(await walletBalance(b.id)).toBe(85714);
    expect(await walletBalance(c.id)).toBe(85714);

    // Shares are redeemed (reset) at share-out.
    const members = await prisma.groupMember.findMany({ where: { groupId } });
    expect(members.every((m) => m.shares === 0)).toBe(true);

    const { debit, credit } = await postingsBalance();
    expect(debit).toBe(credit);
  });

  it("shares out only the new contributions in the second cycle (shares reset)", async () => {
    const coop = await createTestCoop("VSLA2");
    const admin = await createTestMember(coop.id, { phone: "2348000010110", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010111" });
    const b = await createTestMember(coop.id, { phone: "2348000010112" });

    const created = await createGroup(coop.id, "vsla", "Round", "RND1", 100000, 2, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "RND1", a.id);
    await joinGroup(coop.id, "RND1", b.id);
    await fundWallet(a.id, 1000000);
    await fundWallet(b.id, 1000000);

    // Cycle 1: a buys 3 shares, b buys 1.
    expect((await contributeToGroup(coop.id, groupId, a.id, 300000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 100000)).ok).toBe(true);
    const closed1 = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed1.shareOutAmount).toBe(400000);
    expect((await prisma.groupMember.findMany({ where: { groupId } })).every((m) => m.shares === 0)).toBe(
      true,
    );

    // Cycle 2: both buy one share each. Only 200,000 is in the fresh pot.
    expect((await contributeToGroup(coop.id, groupId, a.id, 100000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 100000)).ok).toBe(true);
    const closed2 = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed2.shareOutAmount).toBe(200000);
    const byId = Object.fromEntries((closed2.payouts ?? []).map((p) => [p.memberId, p.amount]));
    expect(byId[a.id]).toBe(100000);
    expect(byId[b.id]).toBe(100000);
    expect(await walletBalance(a.id)).toBe(1000000);
    expect(await walletBalance(b.id)).toBe(1000000);
  });

  it("lists groups and the caller's memberships", async () => {
    const coop = await createTestCoop("GROUP4");
    const admin = await createTestMember(coop.id, { phone: "2348000010200", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010201" });
    await createGroup(coop.id, "vsla", "Market", "MKT2", 50000, 6, actor(admin));
    await joinGroup(coop.id, "MKT2", a.id);

    const all = await listGroups(coop.id);
    expect(all.ok).toBe(true);
    expect(all.groups?.length).toBe(1);
    expect(all.groups?.[0].memberCount).toBe(1);

    const mine = await myGroups(coop.id, a.id);
    expect(mine.ok).toBe(true);
    expect(mine.groups?.length).toBe(1);
    expect(mine.groups?.[0].code).toBe("MKT2");
  });

  it("refuses a duplicate group code", async () => {
    const coop = await createTestCoop("GROUP5");
    const admin = await createTestMember(coop.id, { phone: "2348000010210", role: "superadmin" });
    const first = await createGroup(coop.id, "vsla", "One", "DUP1", 50000, 6, actor(admin));
    expect(first.ok).toBe(true);
    const second = await createGroup(coop.id, "vsla", "Two", "DUP1", 50000, 6, actor(admin));
    expect(second.ok).toBe(false);
  });
});

describe("joint-liability group loans", () => {
  it("lets a group member borrow with the group as joint guarantor", async () => {
    const coop = await createTestCoop("GRPLOAN1");
    const admin = await createTestMember(coop.id, { phone: "2348000010400", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010401" });

    const created = await createGroup(coop.id, "vsla", "Traders", "TRD1", 50000, 6, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "TRD1", a.id);

    const applied = await applyGroupLoan(coop.id, groupId, a.id, 500000, 3);
    expect(applied.ok).toBe(true);
    const loanId = applied.loanId!;

    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    expect(loan).not.toBeNull();
    expect(loan!.groupId).toBe(groupId);
    expect(loan!.memberId).toBe(a.id);
    // The group guarantees the loan, so it starts already guaranteed with no
    // individual guarantors on the hook.
    expect(loan!.status).toBe("guaranteed");
    expect(await prisma.guarantor.count({ where: { loanId } })).toBe(0);
  });

  it("can be approved without individual guarantors when the group is active", async () => {
    const coop = await createTestCoop("GRPLOAN2");
    const admin = await createTestMember(coop.id, { phone: "2348000010410", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010411" });

    const created = await createGroup(coop.id, "vsla", "Artisans", "ART1", 50000, 6, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "ART1", a.id);

    const applied = await applyGroupLoan(coop.id, groupId, a.id, 500000, 3);
    expect(applied.ok).toBe(true);
    const loanId = applied.loanId!;

    const officer = await prisma.accountOfficer.create({
      data: { email: `ao-${loanId}@test.local`, name: "Test Officer", isActive: true },
    });
    await prisma.accountOfficerAssignment.create({
      data: {
        accountOfficerId: officer.id,
        cooperativeId: coop.id,
        assignedById: admin.id,
        isActive: true,
      },
    });

    // If the loan still required individual guarantors it would be stuck at
    // "pending" and this approval would be rejected.
    const approved = await approveLoan(loanId.slice(-6), {
      isAdmin: true,
      actorId: officer.id,
      cooperativeId: coop.id,
    });
    expect(approved.ok).toBe(true);
    const after = await prisma.loan.findUnique({ where: { id: loanId } });
    expect(after!.status).toBe("account_officer_approved");
  });

  it("refuses a group loan from a non-member", async () => {
    const coop = await createTestCoop("GRPLOAN3");
    const admin = await createTestMember(coop.id, { phone: "2348000010420", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010421" });
    const outsider = await createTestMember(coop.id, { phone: "2348000010422" });

    const created = await createGroup(coop.id, "vsla", "Savings", "SAV1", 50000, 6, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "SAV1", a.id);

    const refused = await applyGroupLoan(coop.id, groupId, outsider.id, 500000, 3);
    expect(refused.ok).toBe(false);
    expect(await prisma.loan.count({ where: { memberId: outsider.id } })).toBe(0);
  });

  it("refuses a group loan from a closed group", async () => {
    const coop = await createTestCoop("GRPLOAN4");
    const admin = await createTestMember(coop.id, { phone: "2348000010430", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010431" });

    const created = await createGroup(coop.id, "vsla", "Closed", "CLS1", 50000, 6, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "CLS1", a.id);
    await prisma.group.update({ where: { id: groupId }, data: { status: "closed" } });

    const refused = await applyGroupLoan(coop.id, groupId, a.id, 500000, 3);
    expect(refused.ok).toBe(false);
  });

  it("lists a group's joint-liability loans for admins", async () => {
    const coop = await createTestCoop("GRPLOAN5");
    const admin = await createTestMember(coop.id, { phone: "2348000010440", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010441" });

    const created = await createGroup(coop.id, "vsla", "Ledger", "LDG1", 50000, 6, actor(admin));
    const groupId = created.groupId!;
    await joinGroup(coop.id, "LDG1", a.id);
    expect((await applyGroupLoan(coop.id, groupId, a.id, 500000, 3)).ok).toBe(true);

    const listed = await groupLoans(coop.id, groupId);
    expect(listed.ok).toBe(true);
    expect(listed.loans?.length).toBe(1);
    expect(listed.loans?.[0].memberName).toBe(a.name);
    expect(listed.loans?.[0].status).toBe("guaranteed");
  });
});

describe("group command gating", () => {
  it("a unit admin cannot create or list coop-wide groups", async () => {
    const coop = await createTestCoop("GRPCMD");
    const superAdmin = await createTestMember(coop.id, {
      phone: "2348000010300",
      role: "superadmin",
    });
    const coopAdmin = await createTestMember(coop.id, { phone: "2348000010301", role: "admin" });
    const unitAdmin = await createTestMember(coop.id, { phone: "2348000010302" });

    expect((await createUnit(coopAdmin.phone, "Lagos Office", "LAG01")).ok).toBe(true);
    expect((await setUnitAdmin(coopAdmin.phone, "LAG01", unitAdmin.code)).ok).toBe(true);

    vi.clearAllMocks();
    await handleAdminCommand(unitAdmin.phone, "newgroup", ["rosca", "Unit", "UNIT1", "5000", "3"]);
    let texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Only the cooperative admin/i);
    expect(await prisma.group.count({ where: { cooperativeId: coop.id } })).toBe(0);

    vi.clearAllMocks();
    await handleAdminCommand(unitAdmin.phone, "groups", []);
    texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Only the cooperative admin/i);

    vi.clearAllMocks();
    await handleAdminCommand(unitAdmin.phone, "grouploans", ["abc"]);
    texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Only the cooperative admin/i);

    // A super admin can create groups.
    vi.clearAllMocks();
    await handleAdminCommand(superAdmin.phone, "newgroup", ["rosca", "Main", "MAIN1", "5000", "3"]);
    expect(await prisma.group.count({ where: { cooperativeId: coop.id } })).toBe(1);
  });
});
