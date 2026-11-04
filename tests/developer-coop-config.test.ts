import { describe, it, expect, beforeEach } from "vitest";
import { prisma, createTestCoop } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { resetRateLimit } from "../src/lib/cache.js";
import {
  setCoopConfig,
  getCoopDetail,
  ComplianceInputError,
} from "../src/services/platform-coops.js";
import { setPlatformPolicy } from "../src/services/platform-policy.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

async function loginDev(
  phone: string,
  role: "owner" | "developer" | "support" = "owner",
): Promise<string> {
  await prisma.platformAdmin.create({
    data: { name: role, phone, role, pin: hashPin("123456"), mustChangePin: false },
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

const writeHeaders = (cookie: string) => ({
  cookie,
  "x-requested-with": "XMLHttpRequest",
});

beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  await prisma.platformPolicy.deleteMany();
});

describe("Developer Console — Per-Cooperative Feature Activation & Configuration", () => {
  it("activates and deactivates features via setCoopConfig service", async () => {
    const coop = await createTestCoop("DEVCFG1");

    const res = await setCoopConfig(coop.id, {
      autoApproveLoans: true,
      requireGuarantors: false,
      directDebitEnabled: true,
      referralEnabled: true,
      loanProtectionEnabled: true,
    });

    expect(res.ok).toBe(true);
    expect(res.config.autoApproveLoans).toBe(true);
    expect(res.config.requireGuarantors).toBe(false);
    expect(res.rawConfig?.directDebitEnabled).toBe(true);
    expect(res.rawConfig?.referralEnabled).toBe(true);

    const detail = await getCoopDetail(coop.id);
    expect(detail?.config.autoApproveLoans).toBe(true);
    expect(detail?.config.requireGuarantors).toBe(false);
    expect(detail?.rawConfig?.directDebitEnabled).toBe(true);
  });

  it("updates business parameters, loan multipliers, and daily payout limit", async () => {
    const coop = await createTestCoop("DEVCFG2");

    const res = await setCoopConfig(coop.id, {
      loanInterestRate: 15,
      maxLoanMultiplier: 4,
      loanDurationMonths: 24,
      minGuarantors: 3,
      dailyPayoutLimit: 250000000, // ₦2.5M in kobo
    });

    expect(res.ok).toBe(true);
    expect(res.config.loanInterestRate).toBe(15);
    expect(res.config.maxLoanMultiplier).toBe(4);
    expect(res.config.loanDurationMonths).toBe(24);
    expect(res.config.minGuarantors).toBe(3);
    expect(res.cooperative?.dailyPayoutLimit).toBe(250000000);
  });

  it("enforces statutory limits (e.g. reserveFundPercent floor of 25%)", async () => {
    const coop = await createTestCoop("DEVCFG3");

    // Reserve fund minimum is 25% by law (Cap N98 s.34(2))
    await expect(
      setCoopConfig(coop.id, {
        reserveFundPercent: 10,
      }),
    ).rejects.toThrow(ComplianceInputError);
  });

  it("enforces platform policy locks when locked by platform admin", async () => {
    const coop = await createTestCoop("DEVCFG4");

    // Lock maxLoanMultiplier at the platform level
    await setPlatformPolicy("maxLoanMultiplier", {
      value: 2,
      locked: true,
    });

    // Cooperative attempt to override a locked policy must fail
    await expect(
      setCoopConfig(coop.id, {
        maxLoanMultiplier: 5,
      }),
    ).rejects.toThrow(/locked by platform policy/);
  });

  it("PATCH /api/developer/coops/:id/config updates features over REST API", async () => {
    const coop = await createTestCoop("DEVCFG5");
    const cookie = await loginDev("2348000000201", "developer");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}/config`,
      headers: writeHeaders(cookie),
      payload: {
        autoApproveLoans: true,
        loanInterestRate: 12,
        serviceChargePercent: 3,
        statusEnabled: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.config.autoApproveLoans).toBe(true);
    expect(body.config.loanInterestRate).toBe(12);
    expect(body.config.serviceChargePercent).toBe(3);
  });

  it("PATCH /api/developer/coops/:id/config rejects support role (read-only)", async () => {
    const coop = await createTestCoop("DEVCFG6");
    const cookie = await loginDev("2348000000202", "support");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}/config`,
      headers: writeHeaders(cookie),
      payload: {
        autoApproveLoans: true,
      },
    });

    // Support role cannot perform non-GET operations
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /api/developer/coops/:id/config returns 404 for non-existent cooperative", async () => {
    const cookie = await loginDev("2348000000203", "owner");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/non-existent-id/config`,
      headers: writeHeaders(cookie),
      payload: {
        autoApproveLoans: true,
      },
    });

    expect(res.statusCode).toBe(404);
  });
});
