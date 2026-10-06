import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDatabase, createTestCoop, createTestMember, prisma } from "./setup.js";
import {
  appointMember,
  committeeMajority,
  createCommittee,
  isCommitteeMember,
  listCommittees,
  removeMember,
} from "../src/services/committees.js";
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

    const bad = await createCommittee(coop.id, "finance", "Finance", 3);
    expect(bad.ok).toBe(false);

    expect((await createCommittee(coop.id, "credit", "Credit", 3)).ok).toBe(true);
    const dup = await createCommittee(coop.id, "credit", "Credit Again", 3);
    expect(dup.ok).toBe(false);
    expect(await prisma.committee.count()).toBe(1);
  });

  it("does not appoint the same member twice", async () => {
    const coop = await createTestCoop("CMT03");
    const m = await createTestMember(coop.id, { phone: "2348010000010" });
    await createCommittee(coop.id, "credit", "Credit", 3);

    expect((await appointMember(coop.id, "credit", m.code, "member")).ok).toBe(true);
    const second = await appointMember(coop.id, "credit", m.code, "member");
    expect(second.ok).toBe(false);
    expect(await prisma.committeeMember.count()).toBe(1);

    // Removing then re-appointing reactivates the same seat rather than duplicating it.
    expect((await removeMember(coop.id, "credit", m.code)).ok).toBe(true);
    expect(await isCommitteeMember(coop.id, "credit", m.id)).toBe(false);
    expect((await appointMember(coop.id, "credit", m.code, "member")).ok).toBe(true);
    expect(await prisma.committeeMember.count()).toBe(1);
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

    await createCommittee(coop.id, "credit", "Credit", 3);
    await handleMessage(plainAdmin.phone, `appoint credit ${target.code} chair`);
    expect(await prisma.committeeMember.count()).toBe(0);
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
