import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanupDatabase, createTestCoop, createTestMember } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { resetRateLimit } from "../src/lib/cache.js";
import { sendText } from "../src/lib/messaging.js";
import {
  BREACH_NOTIFICATION_WINDOW_MS,
  ComplianceRegisterError,
  breachView,
  createBreach,
  createCrossBorderTransfer,
  createDpia,
  endCrossBorderTransfer,
  listBreaches,
  listCrossBorderTransfers,
  listDpias,
  summariseBreaches,
  updateBreach,
  updateDpia,
} from "../src/services/compliance-registers.js";
import {
  addBeneficialOwner,
  BeneficialOwnerError,
  listBeneficialOwners,
  markCorporateMember,
  removeBeneficialOwner,
} from "../src/services/beneficial-owners.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { vi } from "vitest";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

async function login(phone: string): Promise<string> {
  await prisma.platformAdmin.create({
    data: { name: "owner", phone, role: "owner", pin: hashPin("123456"), mustChangePin: false },
  });
  await resetRateLimit("devlogin:127.0.0.1");
  const res = await app.inject({
    method: "POST",
    url: "/api/developer/login",
    payload: { phone, pin: "123456" },
  });
  expect(res.statusCode).toBe(200);
  return (res.headers["set-cookie"] as string).split(";")[0];
}

const write = (cookie: string) => ({ cookie, "x-requested-with": "XMLHttpRequest" });

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("breach register", () => {
  it("derives the 72-hour NDPC deadline from discovery", async () => {
    const coop = await createTestCoop("BRCH01");
    const discoveredAt = new Date("2026-10-20T09:00:00.000Z");
    const breach = await createBreach(coop.id, {
      title: "Exposed member export",
      description: "A shared folder link leaked a member CSV.",
      discoveredAt,
      affectedCount: 42,
    });

    expect(breach.reference).toMatch(/^BR-20261020-[0-9A-F]{4}$/);
    expect(breach.notificationDueAt.getTime() - discoveredAt.getTime()).toBe(
      BREACH_NOTIFICATION_WINDOW_MS,
    );
    expect(breach.overdue).toBe(true);
    expect(breach.hoursRemaining).toBeLessThan(0);

    const summary = summariseBreaches(await listBreaches(coop.id));
    expect(summary.open).toBe(1);
    expect(summary.overdue).toBe(1);
  });

  it("flags a fresh breach as due within 24 hours", () => {
    const view = breachView({
      id: "b1",
      reference: "BR-1",
      title: "t",
      description: "d",
      discoveredAt: new Date(Date.now() - 60 * 60 * 1000),
      occurredAt: null,
      affectedCount: null,
      dataCategories: null,
      containment: null,
      status: "open",
      ndpcNotifiedAt: null,
      ndpcReference: null,
      subjectsNotifiedAt: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(view.overdue).toBe(false);
    expect(view.hoursRemaining).toBeGreaterThan(60);
    expect(view.hoursRemaining).toBeLessThanOrEqual(72);
  });

  it("records the NDPC notification and closes the deadline", async () => {
    const coop = await createTestCoop("BRCH02");
    const breach = await createBreach(coop.id, {
      title: "Lost phone",
      description: "An admin phone with chat history was stolen.",
      discoveredAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
    });
    expect(breach.overdue).toBe(false);

    const updated = await updateBreach(coop.id, breach.id, {
      ndpcNotifiedAt: new Date().toISOString(),
      ndpcReference: "NDPC-2026-001",
    });
    expect(updated.status).toBe("notified");
    expect(updated.overdue).toBe(false);
    expect(updated.ndpcReference).toBe("NDPC-2026-001");
  });

  it("rejects a breach without a title or description", async () => {
    const coop = await createTestCoop("BRCH03");
    await expect(createBreach(coop.id, { description: "x" } as never)).rejects.toBeInstanceOf(
      ComplianceRegisterError,
    );
    await expect(createBreach(coop.id, { title: "x" } as never)).rejects.toBeInstanceOf(
      ComplianceRegisterError,
    );
  });
});

describe("DPIA and cross-border registers", () => {
  it("creates and approves a DPIA", async () => {
    const coop = await createTestCoop("DPIA01");
    const dpia = await createDpia(coop.id, {
      title: "Payroll deduction processing",
      activity: "Matching payslips to member accounts",
      risks: "Salary data visible to admins",
      mitigations: "Row-level scoping and audit trail",
    });
    expect(dpia.status).toBe("draft");

    const approved = await updateDpia(coop.id, dpia.id, { status: "approved" });
    expect(approved.status).toBe("approved");
    expect(approved.reviewedAt).not.toBeNull();
    expect((await listDpias(coop.id)).length).toBe(1);
  });

  it("creates and ends a cross-border transfer", async () => {
    const coop = await createTestCoop("XBRD01");
    const transfer = await createCrossBorderTransfer(coop.id, {
      country: "Ireland",
      recipient: "Cloud messaging provider",
      purpose: "Deliver WhatsApp messages",
      safeguard: "scc",
      safeguardDetail: "EU standard contractual clauses",
    });
    expect(transfer.status).toBe("active");

    const ended = await endCrossBorderTransfer(coop.id, transfer.id);
    expect(ended.status).toBe("ended");
    expect(ended.endedAt).not.toBeNull();
    expect((await listCrossBorderTransfers(coop.id)).length).toBe(1);
  });

  it("rejects an unknown safeguard", async () => {
    const coop = await createTestCoop("XBRD02");
    await expect(
      createCrossBorderTransfer(coop.id, {
        country: "US",
        recipient: "Vendor",
        purpose: "Support",
        safeguard: "handshake",
      }),
    ).rejects.toBeInstanceOf(ComplianceRegisterError);
  });
});

describe("developer compliance routes", () => {
  it("requires a platform session", async () => {
    const coop = await createTestCoop("DEVC01");
    const res = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/compliance-registers`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("lists, creates and updates registers", async () => {
    const coop = await createTestCoop("DEVC02");
    const cookie = await login("2348000000201");

    const created = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/breaches`,
      headers: write(cookie),
      payload: {
        title: "Misdirected statement",
        description: "A statement was sent to the wrong phone number.",
        discoveredAt: "2026-10-31T08:00:00.000Z",
      },
    });
    expect(created.statusCode).toBe(200);
    const breach = JSON.parse(created.body);
    expect(breach.reference).toMatch(/^BR-/);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}/breaches/${breach.id}`,
      headers: write(cookie),
      payload: { status: "contained" },
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body).status).toBe("contained");

    const dpia = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/dpias`,
      headers: write(cookie),
      payload: { title: "Voting data", activity: "Processing member votes" },
    });
    expect(dpia.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/compliance-registers`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = JSON.parse(listed.body);
    expect(body.breaches.length).toBe(1);
    expect(body.dpias.length).toBe(1);
    expect(body.breachSummary.contained).toBe(1);
  });

  it("stores NDPC and SCUML evidence and rejects impossible dates", async () => {
    const coop = await createTestCoop("DEVC03");
    const cookie = await login("2348000000202");

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}`,
      headers: write(cookie),
      payload: {
        ndpcRegistrationNumber: "NDPC/DCPMI/2026/001",
        ndpcRegisteredAt: "2026-02-01",
        scumlNumber: "SCUML-12345",
        scumlExpiresAt: "2027-01-31",
      },
    });
    expect(ok.statusCode).toBe(200);

    const stored = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(stored?.ndpcRegistrationNumber).toBe("NDPC/DCPMI/2026/001");
    expect(stored?.ndpcRegisteredAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(stored?.scumlExpiresAt?.toISOString()).toBe("2027-01-31T00:00:00.000Z");

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}`,
      headers: write(cookie),
      payload: { scumlExpiresAt: "2026-02-31" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("returns 404 for an unknown cooperative", async () => {
    const cookie = await login("2348000000203");
    const res = await app.inject({
      method: "GET",
      url: "/api/developer/coops/nope/compliance-registers",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("beneficial ownership", () => {
  it("captures corporate owners and enforces the 100% ceiling", async () => {
    const coop = await createTestCoop("BENF01");
    const member = await createTestMember(coop.id, { role: "member" });

    await expect(addBeneficialOwner(coop.id, member.code, "Ada Obi", 10)).rejects.toBeInstanceOf(
      BeneficialOwnerError,
    );

    const corporate = await markCorporateMember(coop.id, member.code, "RC1234567");
    expect(corporate.entityType).toBe("corporate");
    expect(corporate.rcNumber).toBe("RC1234567");

    await addBeneficialOwner(coop.id, member.code, "Ada Obi", 60);
    await addBeneficialOwner(coop.id, member.code, "Bola Eze", 40);
    await expect(addBeneficialOwner(coop.id, member.code, "Chidi Umeh", 1)).rejects.toBeInstanceOf(
      BeneficialOwnerError,
    );
    await expect(addBeneficialOwner(coop.id, member.code, "ada obi", 5)).rejects.toBeInstanceOf(
      BeneficialOwnerError,
    );

    const listed = await listBeneficialOwners(coop.id, member.code);
    expect(listed.owners).toHaveLength(2);
    expect(listed.total).toBe(100);
  });

  it("removes an owner by its 6-character suffix", async () => {
    const coop = await createTestCoop("BENF02");
    const member = await createTestMember(coop.id, { role: "member" });
    await markCorporateMember(coop.id, member.code, "1234567");
    const owner = await addBeneficialOwner(coop.id, member.code, "Ada Obi", 40);

    const removed = await removeBeneficialOwner(coop.id, member.code, owner.id.slice(-6));
    expect(removed.id).toBe(owner.id);
    expect((await listBeneficialOwners(coop.id, member.code)).owners).toHaveLength(0);
  });

  it("handles the chat commands end to end", async () => {
    const coop = await createTestCoop("BENF03");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348090000301",
    });
    const target = await createTestMember(coop.id, { role: "member" });
    vi.mocked(sendText).mockClear();

    await handleAdminCommand(admin.phone, "corporate", [target.code, "RC", "7654321"]);
    let stored = await prisma.member.findUnique({ where: { id: target.id } });
    expect(stored?.entityType).toBe("corporate");
    expect(stored?.rcNumber).toBe("RC 7654321");

    await handleAdminCommand(admin.phone, "beneficial", [target.code, "Ada", "Obi", "55"]);
    await handleAdminCommand(admin.phone, "beneficials", [target.code]);
    const texts = vi.mocked(sendText).mock.calls.map((call) => call[0].text);
    expect(texts.some((text) => text.includes("Ada Obi"))).toBe(true);
    expect(texts.some((text) => text.includes("Total recorded: *55%*"))).toBe(true);

    const owner = await prisma.memberBeneficialOwner.findFirst({
      where: { cooperativeId: coop.id, memberId: target.id },
    });
    expect(owner?.ownershipPct).toBe(55);
  });
});
