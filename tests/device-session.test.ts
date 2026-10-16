/**
 * SEC-8: device/session anomaly detection must be ADVISORY, never a lockout.
 *
 * The old behaviour hard-blocked every message on any platform/IP change, which
 * (with the webhook IP being Meta's egress, not the member's) locked legitimate
 * members out. Now a platform switch only produces a warning + a superadmin
 * alert; IP churn is ignored entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      setex: async (k: string, _ttl: number, v: string) => {
        store.set(k, v);
        return "OK";
      },
    },
  };
});

vi.mock("../src/lib/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/cache.js")>();
  return { ...actual, getRedis: () => h.redis };
});

import { createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { validateDeviceSession } from "../src/lib/security-hardening.js";
import { sendText } from "../src/lib/messaging.js";

beforeEach(async () => {
  h.store.clear();
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("device session (advisory)", () => {
  it("never blocks the message; a platform switch only warns + alerts supers", async () => {
    const coop = await createTestCoop("DEV1");
    const member = await createTestMember(coop.id, { phone: "2348000600001" });
    await createTestMember(coop.id, { phone: "2348000600002", role: "superadmin" });

    const first = await validateDeviceSession({
      memberPhone: member.phone,
      platform: "whatsapp",
      ip: "1.1.1.1",
    });
    expect(first.ok).toBe(true);

    const second = await validateDeviceSession({
      memberPhone: member.phone,
      platform: "telegram",
      ip: "9.9.9.9",
    });
    expect(second.ok).toBe(true); // NEVER blocked
    expect(second.warning).toBeTruthy();
    expect(vi.mocked(sendText)).toHaveBeenCalled();
  });

  it("does not warn when the platform is unchanged — IP churn is ignored", async () => {
    const coop = await createTestCoop("DEV2");
    const member = await createTestMember(coop.id, { phone: "2348000600003" });

    await validateDeviceSession({ memberPhone: member.phone, platform: "whatsapp", ip: "1.1.1.1" });
    const again = await validateDeviceSession({
      memberPhone: member.phone,
      platform: "whatsapp",
      ip: "2.2.2.2",
    });
    expect(again.ok).toBe(true);
    expect(again.warning).toBeUndefined();
  });
});
