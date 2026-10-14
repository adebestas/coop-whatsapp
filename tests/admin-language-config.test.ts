import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { sendText } from "../src/lib/messaging.js";
import { getCoopMeta, invalidateCoopMeta } from "../src/lib/tenant-context.js";
import { clearMemberCache } from "../src/services/cooperative.js";

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("setconfig language", () => {
  it("rejects an unsupported language", async () => {
    const coop = await createTestCoop("LANG1");
    const admin = await createTestMember(coop.id, { phone: "2348000090001", role: "superadmin" });

    await handleAdminCommand(admin.phone, "setconfig", ["language", "klingon"]);

    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.locale).toBe("en");

    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Unsupported language/);
  });

  it("sets the coop default language and invalidates the meta cache", async () => {
    const coop = await createTestCoop("LANG2");
    const admin = await createTestMember(coop.id, { phone: "2348000090002", role: "superadmin" });

    invalidateCoopMeta(coop.id);
    expect((await getCoopMeta(coop.id)).locale).toBe("en");

    await handleAdminCommand(admin.phone, "setconfig", ["language", "yoruba"]);

    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.locale).toBe("yoruba");
    expect((await getCoopMeta(coop.id)).locale).toBe("yoruba");
  });

  it("shows country, currency and language in showconfig", async () => {
    const coop = await createTestCoop("LANG3");
    const admin = await createTestMember(coop.id, { phone: "2348000090003", role: "superadmin" });

    await handleAdminCommand(admin.phone, "showconfig", []);

    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Country: \*NG\*/);
    expect(texts).toMatch(/Currency: \*NGN\*/);
    expect(texts).toMatch(/Default language: \*en\*/);
  });
});
