/**
 * A16: sanctions / PEP screening.
 *
 * The local watchlist is the default provider (the external provider is only
 * used when SANCTIONS_SCREENING_URL is set). Screening gates member onboarding
 * (recorded + alerted) and blocks money-out to a matched beneficiary.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../tests/setup.js";
import { createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import {
  screenName,
  screenAndRecord,
  isBlocking,
  normalizeName,
  nameSimilarity,
} from "../src/services/screening.js";
import { findOrCreateMember } from "../src/services/cooperative.js";
import { savePayee } from "../src/lib/beneficiaries.js";

beforeEach(async () => {
  await cleanupDatabase();
  delete process.env.SANCTIONS_SCREENING_URL;
  delete process.env.SANCTIONS_FAIL_CLOSED;
  delete process.env.SANCTIONS_MATCH_THRESHOLD;
  delete process.env.SANCTIONS_REVIEW_THRESHOLD;
});

afterEach(() => {
  delete process.env.SANCTIONS_SCREENING_URL;
  delete process.env.SANCTIONS_FAIL_CLOSED;
});

describe("name normalization and similarity", () => {
  it("normalizes case, diacritics and punctuation", () => {
    expect(normalizeName("  Iván  O'Petrov-Ruiz ")).toBe("ivan o petrov ruiz");
  });

  it("scores exact and near matches high, unrelated names low", () => {
    expect(nameSimilarity("Ivan Petrov", "ivan petrov")).toBe(1);
    expect(nameSimilarity("Ivan Petrov", "Ivan Petrovv")).toBeGreaterThan(0.8);
    expect(nameSimilarity("Ivan Petrov", "Grace Adeyemi")).toBeLessThan(0.4);
  });
});

describe("screenName (local watchlist)", () => {
  it("returns clear when the list is empty", async () => {
    const outcome = await screenName("Grace Adeyemi");
    expect(outcome.status).toBe("clear");
    expect(outcome.score).toBe(0);
  });

  it("flags a strong match and a weak (review) match by threshold", async () => {
    await prisma.sanctionsEntry.create({ data: { name: "Ivan Petrov", listType: "sanction" } });

    const strong = await screenName("IVÁN PETROV");
    expect(strong.status).toBe("matched");
    expect(strong.matches[0]?.listType).toBe("sanction");

    const weak = await screenName("Ivan Petrovski");
    expect(["review", "matched"]).toContain(weak.status);
  });

  it("matches an alias, not just the primary name", async () => {
    await prisma.sanctionsEntry.create({
      data: { name: "Ivan Petrov", aliases: JSON.stringify(["Vanya Petrov"]), listType: "pep" },
    });
    const outcome = await screenName("Vanya Petrov");
    expect(outcome.status).toBe("matched");
    expect(outcome.matches[0]?.listType).toBe("pep");
  });

  it("ignores inactive entries", async () => {
    await prisma.sanctionsEntry.create({
      data: { name: "Ivan Petrov", isActive: false },
    });
    expect((await screenName("Ivan Petrov")).status).toBe("clear");
  });

  it("isBlocking blocks matched/review and fails closed on error when configured", () => {
    expect(isBlocking("matched")).toBe(true);
    expect(isBlocking("review")).toBe(true);
    expect(isBlocking("clear")).toBe(false);
    process.env.SANCTIONS_FAIL_CLOSED = "1";
    expect(isBlocking("error")).toBe(true);
    process.env.SANCTIONS_FAIL_CLOSED = "0";
    expect(isBlocking("error")).toBe(false);
  });
});

describe("screenAndRecord", () => {
  it("persists a ScreeningResult and audits a hit", async () => {
    const coop = await createTestCoop("SCRN1");
    await prisma.sanctionsEntry.create({ data: { name: "Ivan Petrov" } });

    const outcome = await screenAndRecord("Ivan Petrov", {
      cooperativeId: coop.id,
      subjectType: "member",
      subjectName: "Ivan Petrov",
    });

    expect(outcome.status).toBe("matched");
    const row = await prisma.screeningResult.findFirst({ where: { cooperativeId: coop.id } });
    expect(row?.status).toBe("matched");
    expect(row?.subjectName).toBe("Ivan Petrov");
    const auditRow = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "screening.matched" },
    });
    expect(auditRow).not.toBeNull();
  });
});

describe("screening gates", () => {
  it("flags a member whose name is on the list at onboarding", async () => {
    const coop = await createTestCoop("SCRN2");
    await prisma.sanctionsEntry.create({ data: { name: "Ivan Petrov" } });

    const result = await findOrCreateMember("2348000800001", coop.code, "Ivan Petrov", "1234");
    expect(result.ok).toBe(true);

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone: "2348000800001" } },
    });
    expect(member?.screeningStatus).toBe("matched");
    expect(member?.screeningAt).not.toBeNull();
    const nok = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "screening.matched" },
    });
    expect(nok).not.toBeNull();
  });

  it("blocks saving a payee whose name is on the list", async () => {
    const coop = await createTestCoop("SCRN3");
    const m = await createTestMember(coop.id, { phone: "2348000800002" });
    await prisma.sanctionsEntry.create({ data: { name: "Ivan Petrov" } });

    const blocked = await savePayee(m.id, "Ivan Petrov", "0123456789", "058");
    expect(blocked.ok).toBe(false);

    const ok = await savePayee(m.id, "Grace Adeyemi", "0123456789", "058");
    expect(ok.ok).toBe(true);
  });
});
