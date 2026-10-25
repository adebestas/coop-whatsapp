import { describe, it, expect } from "vitest";
import {
  signPlatformToken,
  verifyPlatformToken,
  PLATFORM_COOKIE,
} from "../src/lib/platform-auth.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";

describe("platform tokens", () => {
  it("round-trips a platform-scoped token", () => {
    const t = signPlatformToken({ id: "pa1", phone: "2348000000001", role: "owner" });
    const p = verifyPlatformToken(t);
    expect(p?.scope).toBe("platform");
    expect(p?.adminId).toBe("pa1");
    expect(p?.role).toBe("owner");
  });
  it("exposes the developer cookie name", () => {
    expect(PLATFORM_COOKIE).toBe("coop_dev_token");
  });
  it("rejects a tampered token", () => {
    const t = signPlatformToken({ id: "pa1", phone: "x", role: "developer" });
    expect(verifyPlatformToken(t.slice(0, -2) + "zz")).toBeNull();
  });
});
