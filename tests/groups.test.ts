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
} from "../src/services/groups.js";
import { clearMemberCache } from "../src/services/cooperative.js";

const actor = (m: { id: string; phone: string; role: string }): {
  id: string;
  phone: string;
  role: string;
} => ({ id: m.id, phone: m.phone, role: m.role });

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
  it("creates a ROSCA, rotates the pot and advances the cycle", async () => {
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
    expect(groupId).toBeTruthy();

    // A default open cycle #1 is created with the group.
    const cycles0 = await prisma.groupCycle.findMany({ where: { groupId } });
    expect(cycles0).toHaveLength(1);
    expect(cycles0[0].cycleNumber).toBe(1);
    expect(cycles0[0].status).toBe("open");

    // Members join and rotation positions are assigned in order.
    expect((await joinGroup(coop.id, "FAM1", a.id)).ok).toBe(true);
    expect((await joinGroup(coop.id, "FAM1", b.id)).ok).toBe(true);
    const ma = await prisma.groupMember.findFirst({ where: { groupId, memberId: a.id } });
    const mb = await prisma.groupMember.findFirst({ where: { groupId, memberId: b.id } });
    expect(ma?.rotationPosition).toBe(1);
    expect(mb?.rotationPosition).toBe(2);

    // Each member contributes the fixed amount, crediting the group pot.
    expect((await contributeToGroup(coop.id, groupId, a.id, 500000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 500000)).ok).toBe(true);

    const status = await groupStatus(coop.id, groupId);
    expect(status.ok).toBe(true);
    expect(status.pot).toBe(1000000);

    const potCredit = await prisma.posting.findFirst({
      where: { account: `liability:group_pot:${groupId}`, direction: "CREDIT" },
    });
    expect(potCredit).not.toBeNull();

    // Closing cycle 1 pays position 1 (a) the whole pot and opens cycle 2.
    const closed = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed.ok).toBe(true);
    expect(closed.payoutMemberId).toBe(a.id);
    expect(closed.shareOutAmount).toBe(1000000);

    const cycles = await prisma.groupCycle.findMany({
      where: { groupId },
      orderBy: { cycleNumber: "asc" },
    });
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe("closed");
    expect(cycles[0].payoutMemberId).toBe(a.id);
    expect(cycles[1].status).toBe("open");
    expect(cycles[1].cycleNumber).toBe(2);

    // Closing cycle 2 advances the rotation to position 2 (b).
    expect((await contributeToGroup(coop.id, groupId, a.id, 500000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 500000)).ok).toBe(true);
    const closed2 = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed2.ok).toBe(true);
    expect(closed2.payoutMemberId).toBe(b.id);

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    expect(group?.status).toBe("closed");

    const { debit, credit } = await postingsBalance();
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);
  });

  it("refuses a duplicate join and a non-member contribution", async () => {
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
    const notMember = await contributeToGroup(coop.id, groupId, outsider.id, 100000);
    expect(notMember.ok).toBe(false);
    expect(
      await prisma.groupContribution.findFirst({ where: { groupId, memberId: outsider.id } }),
    ).toBeNull();
  });

  it("validates the fixed contribution amount for a ROSCA", async () => {
    const coop = await createTestCoop("ROSCA3");
    const admin = await createTestMember(coop.id, { phone: "2348000010020", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010021" });
    const created = await createGroup(coop.id, "rosca", "Fixed", "FIX1", 100000, 3, actor(admin));
    await joinGroup(coop.id, "FIX1", a.id);

    const wrong = await contributeToGroup(coop.id, created.groupId!, a.id, 50000);
    expect(wrong.ok).toBe(false);
  });
});

describe("VSLA groups", () => {
  it("buys shares and shares out the pot by shareholding", async () => {
    const coop = await createTestCoop("VSLA1");
    const admin = await createTestMember(coop.id, { phone: "2348000010100", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348000010101" });
    const b = await createTestMember(coop.id, { phone: "2348000010102" });

    // ₦1,000 (100000 kobo) buys one share.
    const created = await createGroup(coop.id, "vsla", "Market", "MKT1", 100000, 4, actor(admin));
    expect(created.ok).toBe(true);
    const groupId = created.groupId!;

    await joinGroup(coop.id, "MKT1", a.id);
    await joinGroup(coop.id, "MKT1", b.id);

    // a buys 3 shares, b buys 1 share.
    expect((await contributeToGroup(coop.id, groupId, a.id, 300000)).ok).toBe(true);
    expect((await contributeToGroup(coop.id, groupId, b.id, 100000)).ok).toBe(true);

    const ma = await prisma.groupMember.findFirst({ where: { groupId, memberId: a.id } });
    const mb = await prisma.groupMember.findFirst({ where: { groupId, memberId: b.id } });
    expect(ma?.shares).toBe(3);
    expect(mb?.shares).toBe(1);

    const closed = await closeGroupCycle(coop.id, groupId, actor(admin));
    expect(closed.ok).toBe(true);
    expect(closed.shareOutAmount).toBe(400000);
    expect(closed.payouts?.length).toBe(2);
    const payoutA = closed.payouts?.find((p) => p.memberId === a.id);
    const payoutB = closed.payouts?.find((p) => p.memberId === b.id);
    expect(payoutA?.amount).toBe(300000);
    expect(payoutB?.amount).toBe(100000);

    // The share-out drains the pot to zero.
    const status = await groupStatus(coop.id, groupId);
    expect(status.pot).toBe(0);

    const { debit, credit } = await postingsBalance();
    expect(debit).toBe(credit);
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
