import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleAwaitingInput } from "../src/services/handlers/session.js";
import { handleJoinStart } from "../src/services/handlers/join.js";
import { sendText } from "../src/lib/messaging.js";

const PHONE = "2348099000001";

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => String(c[0].text))
    .join("\n");
}

async function sessionState(): Promise<string> {
  const session = await prisma.session.findUnique({ where: { phone: PHONE } });
  return session?.state ?? "none";
}

describe("join code entry", () => {
  it("rejects an unknown cooperative code without advancing the flow", async () => {
    await handleAwaitingInput(PHONE, "awaiting_coop_code", "NOPE99", "{}");

    expect(await sessionState()).not.toBe("awaiting_name");
    expect(textsSent().toLowerCase()).toContain("couldn't find");
    expect(textsSent()).toContain("NOPE99");
  });

  it("accepts a known code case-insensitively and shows the cooperative name", async () => {
    const coop = await createTestCoop("LAGOS1");

    await handleAwaitingInput(PHONE, "awaiting_coop_code", " lagos1 ", "{}");

    expect(await sessionState()).toBe("awaiting_name");
    expect(textsSent()).toContain(coop.name);

    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(JSON.parse(session?.data ?? "{}").joinCode).toBe(coop.code);
  });

  it("stops an existing member before they repeat the whole registration", async () => {
    const coop = await createTestCoop("LAGOS2");
    await createTestMember(coop.id, { phone: PHONE, name: "Ada Obi" });

    await handleAwaitingInput(PHONE, "awaiting_coop_code", coop.code, "{}");

    expect(await sessionState()).toBe("idle");
    expect(textsSent()).toContain("already a member");
    expect(textsSent()).not.toContain("full name");
  });

  it("refuses a suspended cooperative at code entry", async () => {
    const coop = await createTestCoop("SUSP01");
    await prisma.cooperative.update({
      where: { id: coop.id },
      data: { status: "suspended" },
    });

    await handleAwaitingInput(PHONE, "awaiting_coop_code", coop.code, "{}");

    expect(await sessionState()).not.toBe("awaiting_name");
    expect(textsSent().toLowerCase()).toContain("isn't accepting");
  });

  it("validates an explicit `join CODE` before asking for a name", async () => {
    await handleJoinStart(PHONE, ["NOPE77"]);

    expect(await sessionState()).toBe("awaiting_coop_code");
    expect(textsSent().toLowerCase()).toContain("couldn't find");
    expect(textsSent()).toContain("NOPE77");
    expect(textsSent()).not.toContain("full name");
  });

  it("names the cooperative for an explicit `join CODE`", async () => {
    const coop = await createTestCoop("LAGOS3");

    await handleJoinStart(PHONE, [" lagos3 "]);

    expect(await sessionState()).toBe("awaiting_name");
    expect(textsSent()).toContain(coop.name);
  });
});
