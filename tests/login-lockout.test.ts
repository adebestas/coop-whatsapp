import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import {
  ACCOUNT_FAILURE_LIMIT,
  BASE_LOCK_MS,
  MAX_LOCK_MS,
  clearFailures,
  lockStatus,
  registerFailure,
} from "../src/lib/login-lockout.js";

const PHONE = "2348012345678";
const IP = "203.0.113.9";

function fail(phone = PHONE, ip = IP) {
  return registerFailure({
    surface: "dashboard_admin",
    phone,
    ip,
    outcome: "bad_credentials",
    errorId: "req-test",
  });
}

async function expireLocks(phone = PHONE) {
  await prisma.loginLock.updateMany({
    where: { surface: "dashboard_admin", subject: phone },
    data: { lockedUntil: new Date(Date.now() - 1000), lastStrikeAt: new Date() },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
});

afterEach(async () => {
  await cleanupDatabase();
});

describe("account lockout", () => {
  it("locks for 15 minutes after five failures in the window", async () => {
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT - 1; i++) {
      const res = await fail();
      expect(res.locked).toBe(false);
    }
    const locked = await fail();
    expect(locked.locked).toBe(true);
    expect(locked.subject).toBe("account");
    expect(locked.retryAfter).toBeGreaterThan(BASE_LOCK_MS / 1000 - 5);
    expect(locked.retryAfter).toBeLessThanOrEqual(BASE_LOCK_MS / 1000 + 5);

    const status = await lockStatus("dashboard_admin", { phone: PHONE, ip: IP });
    expect(status.locked).toBe(true);
    expect(status.subject).toBe("account");
  });

  it("doubles the duration on the next lock within 24 hours", async () => {
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i++) await fail();
    await expireLocks();
    let last = { locked: false, retryAfter: 0 } as Awaited<ReturnType<typeof fail>>;
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT; i++) last = await fail();
    expect(last.locked).toBe(true);
    expect(last.retryAfter).toBeGreaterThan((BASE_LOCK_MS * 2) / 1000 - 5);
  });

  it("caps the ladder at eight hours", async () => {
    await prisma.loginLock.create({
      data: {
        surface: "dashboard_admin",
        subject: PHONE,
        strikes: ACCOUNT_FAILURE_LIMIT - 1,
        lockCount: 12,
        lastStrikeAt: new Date(),
      },
    });
    const res = await fail();
    expect(res.locked).toBe(true);
    expect(res.retryAfter).toBeLessThanOrEqual(MAX_LOCK_MS / 1000 + 5);
    expect(res.retryAfter).toBeGreaterThan(MAX_LOCK_MS / 1000 - 5);
  });

  it("clears the failure window on a successful login", async () => {
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT - 1; i++) await fail();
    await clearFailures("dashboard_admin", { phone: PHONE, ip: IP });
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT - 1; i++) {
      const res = await fail();
      expect(res.locked).toBe(false);
    }
  });

  it("writes an append-only attempt ledger", async () => {
    await fail();
    await fail();
    const rows = await prisma.loginAttempt.findMany({ where: { phone: PHONE } });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.outcome === "bad_credentials")).toBe(true);
    expect(rows.every((r) => r.errorId === "req-test")).toBe(true);
  });
});

describe("IP lockout", () => {
  it("locks an IP for one hour after 30 failures across accounts", async () => {
    let last = { locked: false, subject: null, retryAfter: 0 } as Awaited<ReturnType<typeof fail>>;
    for (let i = 0; i < 30; i++) last = await fail(`23480999${String(i).padStart(5, "0")}`, IP);
    expect(last.locked).toBe(true);
    expect(last.subject).toBe("ip");
    expect(last.retryAfter).toBeGreaterThan(3600 - 5);
    expect(last.retryAfter).toBeLessThanOrEqual(3605);
    const status = await lockStatus("dashboard_admin", { phone: "2348000000000", ip: IP });
    expect(status.locked).toBe(true);
    expect(status.subject).toBe("ip");
  });
});
