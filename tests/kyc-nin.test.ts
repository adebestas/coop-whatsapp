/**
 * A17: NIN-based KYC.
 *
 * BVN is deliberately NOT collected. A member submits an 11-digit NIN; when
 * NIN_VERIFY_URL is configured the provider's registered name is fuzzy-matched
 * against the member's name, else the account is left `pending` for manual
 * confirmation. A verified NIN unlocks the tier-2 transaction ceiling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { verifyNin, submitNin, normalizeNin, isValidNin } from "../src/services/kyc.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { invalidateMemberCache } from "../src/services/cooperative.js";

const NIN = "12345678901";

function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => String((c[0] as { text?: string }).text))
    .join("\n");
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  delete process.env.NIN_VERIFY_URL;
  delete process.env.NIN_VERIFY_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NIN_VERIFY_URL;
  delete process.env.NIN_VERIFY_KEY;
});

describe("NIN format helpers", () => {
  it("normalizes and validates an 11-digit NIN", () => {
    expect(normalizeNin(" 123-456-789 01 ")).toBe(NIN);
    expect(isValidNin(NIN)).toBe(true);
    expect(isValidNin("12345")).toBe(false);
    expect(isValidNin("1234567890123")).toBe(false);
    expect(isValidNin("abcdefghijk")).toBe(false);
  });
});

describe("verifyNin", () => {
  it("returns pending when no provider is configured", async () => {
    expect(await verifyNin(NIN, "Ada Obi")).toEqual({
      status: "pending",
      reason: "no verification provider configured",
    });
  });

  it("verifies on a name match and fails on a mismatch", async () => {
    process.env.NIN_VERIFY_URL = "https://kyc.example/verify";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", data: { firstname: "Ada", lastname: "Obi" } }),
      }),
    );

    expect(await verifyNin(NIN, "Ada Obi")).toMatchObject({ status: "verified" });
    const mismatch = await verifyNin(NIN, "Grace Adeyemi");
    expect(mismatch.status).toBe("failed");
    expect(mismatch.reason).toMatch(/name mismatch/i);
  });

  it("fails on a provider error and stays pending on a network failure", async () => {
    process.env.NIN_VERIFY_URL = "https://kyc.example/verify";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    expect((await verifyNin(NIN, "Ada Obi")).status).toBe("failed");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect((await verifyNin(NIN, "Ada Obi")).status).toBe("pending");
  });
});

describe("submitNin + verify command", () => {
  it("stores the NIN and marks the account pending without a provider", async () => {
    const coop = await createTestCoop("KYC1");
    const m = await createTestMember(coop.id, { phone: "2348000900001" });

    const result = await submitNin(
      { id: m.id, name: m.name, phone: m.phone, cooperativeId: coop.id },
      NIN,
    );
    expect(result.status).toBe("pending");

    const updated = await prisma.member.findUnique({ where: { id: m.id } });
    expect(updated?.nin).toBe(NIN);
    expect(updated?.kycStatus).toBe("pending");
  });

  it("prompts for a valid NIN on a malformed *verify* command", async () => {
    const coop = await createTestCoop("KYC2");
    const m = await createTestMember(coop.id, { phone: "2348000900002" });

    await handleMessage(m.phone, "verify 123");
    expect(textsSent()).toMatch(/11-digit/i);
    expect((await prisma.member.findUnique({ where: { id: m.id } }))?.kycStatus).toBe("unset");
  });

  it("accepts a valid NIN via the *verify* command", async () => {
    const coop = await createTestCoop("KYC3");
    const m = await createTestMember(coop.id, { phone: "2348000900003" });

    await handleMessage(m.phone, `verify ${NIN}`);
    expect((await prisma.member.findUnique({ where: { id: m.id } }))?.kycStatus).toBe("pending");
    expect(textsSent()).toMatch(/queued/i);
  });
});

describe("tier gating by KYC", () => {
  it("blocks an above-tier-1 transaction until the NIN is verified", async () => {
    const coop = await createTestCoop("KYC4");
    const m = await createTestMember(coop.id, { phone: "2348000900004" });

    // ₦60,000 is above the tier-1 single ceiling (₦50,000) → blocked.
    await handleMessage(m.phone, "save 60000");
    expect(textsSent()).toMatch(/Tier 1/i);
    expect(textsSent()).toMatch(/NIN/i);

    // Verify the member, then the same amount passes the tier gate.
    await prisma.member.update({ where: { id: m.id }, data: { kycStatus: "verified" } });
    invalidateMemberCache(m.phone);
    vi.clearAllMocks();
    await handleMessage(m.phone, "save 60000");
    expect(textsSent()).not.toMatch(/Tier 1/i);
  });
});
