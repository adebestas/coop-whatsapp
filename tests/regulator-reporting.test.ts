import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { formatBalance } from "../src/lib/money.js";
import {
  reportPeriod,
  periodDueAt,
  statutoryPack,
  nfiuPack,
  generateReport,
  setRegulatorProfile,
  markFiled,
  listReports,
  type PackType,
} from "../src/services/regulator-reporting.js";
import { runRegulatorReports } from "../src/services/scheduler.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { notifyMember, sendText } from "../src/lib/messaging.js";

async function makeContrib(
  coopId: string,
  memberId: string,
  amount: number,
  createdAt?: Date,
) {
  return prisma.contribution.create({
    data: {
      amount,
      type: "savings",
      status: "confirmed",
      reference: `reg_${Math.random().toString(36).slice(2)}`,
      memberId,
      cooperativeId: coopId,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

async function makeLedger(
  coopId: string,
  type: "income" | "expense",
  category: string,
  amount: number,
  createdAt: Date,
) {
  return prisma.ledgerEntry.create({
    data: { cooperativeId: coopId, type, category, amount, createdAt },
  });
}

async function makeLoan(
  coopId: string,
  memberId: string,
  balance: number,
  daysOverdue: number,
) {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() - daysOverdue);
  return prisma.loan.create({
    data: {
      amount: balance,
      balance,
      status: "disbursed",
      dueDate,
      memberId,
      cooperativeId: coopId,
    },
  });
}

async function makeSTR(
  coopId: string,
  memberId: string,
  status: string,
  amount: number,
  createdAt: Date,
) {
  return prisma.sTR.create({
    data: { cooperativeId: coopId, memberId, amount, reason: "period test", status, createdAt },
  });
}

async function makeWithdrawal(
  coopId: string,
  memberId: string,
  amount: number,
  status: string,
  createdAt: Date,
) {
  return prisma.withdrawalRequest.create({
    data: {
      amount,
      status,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      memberId,
      cooperativeId: coopId,
      createdAt,
    },
  });
}

async function makePayout(
  coopId: string,
  memberId: string,
  amount: number,
  status: string,
  createdAt: Date,
) {
  return prisma.payout.create({
    data: {
      amount,
      reference: `po_${Math.random().toString(36).slice(2)}`,
      status,
      memberId,
      cooperativeId: coopId,
      createdAt,
    },
  });
}

async function makeDisbursedLoan(
  coopId: string,
  memberId: string,
  amount: number,
  disbursedAt: Date,
) {
  return prisma.loan.create({
    data: {
      amount,
      balance: amount,
      status: "disbursed",
      disbursedAt,
      memberId,
      cooperativeId: coopId,
    },
  });
}

function sheet(pack: { name: string; rows: string[][] }[], re: RegExp) {
  return pack.find((s) => re.test(s.name));
}

function flatten(pack: { name: string; rows: string[][] }[]): string {
  return pack.flatMap((s) => s.rows.flat()).join("\n");
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

afterAll(async () => {
  await cleanupDatabase();
});

describe("reportPeriod", () => {
  it("returns the YYYY-MM of the month for a monthly period", () => {
    expect(reportPeriod(new Date("2026-03-31"), "monthly")).toBe("2026-03");
    expect(reportPeriod(new Date("2026-03-01"), "monthly")).toBe("2026-03");
    expect(reportPeriod(new Date("2026-12-15"), "monthly")).toBe("2026-12");
  });

  it("returns the quarter-end month for a quarterly period", () => {
    expect(reportPeriod(new Date("2026-02-14"), "quarterly")).toBe("2026-03"); // Q1
    expect(reportPeriod(new Date("2026-05-01"), "quarterly")).toBe("2026-06"); // Q2
    expect(reportPeriod(new Date("2026-07-31"), "quarterly")).toBe("2026-09"); // Q3
    expect(reportPeriod(new Date("2026-11-30"), "quarterly")).toBe("2026-12"); // Q4
  });
});

describe("periodDueAt", () => {
  const profile = { monthlyDueDay: 10, quarterlyDueDay: 15 };

  it("is the due day of the month after a monthly period", () => {
    expect(periodDueAt("2026-03", "monthly", profile).toISOString().slice(0, 10)).toBe(
      "2026-04-10",
    );
    // Month-end rollover: December's return is due 10 January.
    expect(periodDueAt("2026-12", "monthly", profile).toISOString().slice(0, 10)).toBe(
      "2027-01-10",
    );
  });

  it("is the quarterly due day of the month after a quarter-end", () => {
    expect(periodDueAt("2026-03", "quarterly", profile).toISOString().slice(0, 10)).toBe(
      "2026-04-15",
    );
  });
});

describe("statutoryPack", () => {
  it("includes balance sheet, P&L, PAR, PEARLS and membership/savings/loans rows", async () => {
    const coop = await createTestCoop("REG1");
    const member = await createTestMember(coop.id, { phone: "2348000010001" });

    // Period P&L (March 2026) plus an April entry that must be excluded.
    await makeLedger(coop.id, "income", "interest", 25000, new Date("2026-03-15T12:00:00Z"));
    await makeLedger(coop.id, "expense", "salary", 5000, new Date("2026-03-20T12:00:00Z"));
    await makeLedger(coop.id, "income", "fine", 99999, new Date("2026-04-02T12:00:00Z"));

    // Confirmed savings + a loan book (one past due).
    await makeContrib(coop.id, member.id, 300000);
    await makeLoan(coop.id, member.id, 200000, 45);
    await makeLoan(coop.id, member.id, 200000, -30);

    const pack = await statutoryPack(coop.id, "2026-03");
    const names = pack.map((s) => s.name);

    expect(sheet(pack, /balance/i)).toBeTruthy();
    expect(sheet(pack, /profit|p&l|income/i)).toBeTruthy();
    expect(sheet(pack, /par/i)).toBeTruthy();
    expect(sheet(pack, /pearls/i)).toBeTruthy();
    expect(sheet(pack, /member/i)).toBeTruthy();
    expect(sheet(pack, /saving/i)).toBeTruthy();
    expect(sheet(pack, /loan/i)).toBeTruthy();
    expect(names.length).toBeGreaterThanOrEqual(7);

    // Every sheet is non-empty and typed as string rows.
    for (const s of pack) {
      expect(s.rows.length).toBeGreaterThan(0);
      for (const row of s.rows) expect(Array.isArray(row)).toBe(true);
    }

    const text = flatten(pack);
    // March P&L figures are present; the April entry is excluded.
    expect(text).toContain(formatBalance(25000));
    expect(text).toContain(formatBalance(5000));
    expect(text).not.toContain(formatBalance(99999));
    // Savings and loan portfolio figures are present.
    expect(text).toContain(formatBalance(300000));
    expect(text).toContain(formatBalance(400000));
  });
});

describe("nfiuPack", () => {
  it("summarises STR counts by status and lists large transactions for the period", async () => {
    const coop = await createTestCoop("REG5");
    const member = await createTestMember(coop.id, { phone: "2348000010005" });

    // STRs within March 2026: 2 pending, 1 filed. The April STR is excluded.
    await makeSTR(coop.id, member.id, "pending", 500_000_000, new Date("2026-03-05T10:00:00Z"));
    await makeSTR(coop.id, member.id, "pending", 600_000_000, new Date("2026-03-15T10:00:00Z"));
    await makeSTR(coop.id, member.id, "filed", 700_000_000, new Date("2026-03-25T10:00:00Z"));
    await makeSTR(coop.id, member.id, "pending", 800_000_000, new Date("2026-04-02T10:00:00Z"));

    // Large (≥ ₦5M) money-out within the period: one withdrawal + one payout.
    await makeWithdrawal(coop.id, member.id, 500_000_000, "paid", new Date("2026-03-10T10:00:00Z"));
    await makePayout(coop.id, member.id, 900_000_000, "successful", new Date("2026-03-20T10:00:00Z"));
    // Excluded: below threshold, wrong status, and out-of-period.
    await makeWithdrawal(coop.id, member.id, 400_000_000, "paid", new Date("2026-03-11T10:00:00Z"));
    await makeWithdrawal(coop.id, member.id, 500_000_000, "pending", new Date("2026-03-12T10:00:00Z"));
    await makePayout(coop.id, member.id, 600_000_000, "successful", new Date("2026-04-10T10:00:00Z"));

    const pack = await nfiuPack(coop.id, "2026-03");

    const strSheet = sheet(pack, /str|sar/i);
    expect(strSheet).toBeTruthy();
    const strRows = strSheet!.rows;
    expect(strRows.find((r) => r[0] === "pending")?.[1]).toBe("2");
    expect(strRows.find((r) => r[0] === "filed")?.[1]).toBe("1");
    expect(strRows.find((r) => /total/i.test(r[0]))?.[1]).toBe("3");

    const largeSheet = sheet(pack, /large|transaction/i);
    expect(largeSheet).toBeTruthy();
    // Header + the two in-period large money-out transactions only.
    expect(largeSheet!.rows.length).toBe(3);
    const largeText = largeSheet!.rows.flat().join(" ");
    expect(largeText).toContain(formatBalance(500_000_000));
    expect(largeText).toContain(formatBalance(900_000_000));
    expect(largeText).toContain(member.code);
    expect(largeText).not.toContain(formatBalance(400_000_000));
  });

  it("includes large money-in contributions and loan disbursements with a direction column", async () => {
    const coop = await createTestCoop("REG9");
    const member = await createTestMember(coop.id, { phone: "2348000010009" });

    await makeWithdrawal(coop.id, member.id, 500_000_000, "paid", new Date("2026-03-05T10:00:00Z"));
    await makeDisbursedLoan(coop.id, member.id, 700_000_000, new Date("2026-03-10T10:00:00Z"));
    await makeContrib(coop.id, member.id, 800_000_000, new Date("2026-03-15T10:00:00Z"));

    const pack = await nfiuPack(coop.id, "2026-03");
    const largeSheet = sheet(pack, /large|transaction/i)!;

    expect(largeSheet.rows[0]).toContain("Direction");
    // Header + the three in-period large transactions (out, out, in).
    expect(largeSheet.rows.length).toBe(4);
    const text = largeSheet.rows.flat().join(" ");
    expect(text).toContain(formatBalance(500_000_000));
    expect(text).toContain(formatBalance(700_000_000));
    expect(text).toContain(formatBalance(800_000_000));
    expect(largeSheet.rows.some((r) => r.includes("in"))).toBe(true);
    expect(largeSheet.rows.some((r) => r.includes("out"))).toBe(true);
  });

  it("returns an empty large-transaction list when there are none", async () => {
    const coop = await createTestCoop("REG6b");
    const pack = await nfiuPack(coop.id, "2026-03");
    const largeSheet = sheet(pack, /large|transaction/i);
    expect(largeSheet).toBeTruthy();
    expect(largeSheet!.rows.length).toBe(1);
  });
});

describe("generateReport", () => {
  it("writes xlsx + pdf + csv, persists a generated report, and audits", async () => {
    const coop = await createTestCoop("REG2");
    const admin = await createTestMember(coop.id, {
      phone: "2348000010002",
      role: "superadmin",
    });
    await makeContrib(coop.id, admin.id, 150000);

    const res = await generateReport(coop.id, "2026-03", "monthly", "statutory", admin.id);
    expect(res.ok).toBe(true);
    expect(res.reportId).toBeTruthy();
    expect(res.files).toBeTruthy();
    const files = res.files!;
    for (const path of [files.xlsx, files.pdf, files.csv]) {
      expect(path).toBeTruthy();
      const info = await stat(path);
      expect(info.size).toBeGreaterThan(100);
    }

    const report = await prisma.regulatorReport.findUnique({
      where: {
        cooperativeId_period_periodType_packType: {
          cooperativeId: coop.id,
          period: "2026-03",
          periodType: "monthly",
          packType: "statutory",
        },
      },
    });
    expect(report).not.toBeNull();
    expect(report!.status).toBe("generated");
    expect(report!.generatedById).toBe(admin.id);
    expect(report!.dueAt).toBeInstanceOf(Date);
    const stored = JSON.parse(report!.files!) as { xlsx: string; pdf: string; csv: string };
    expect(stored.xlsx).toBe(files.xlsx);
    expect(stored.pdf).toBe(files.pdf);
    expect(stored.csv).toBe(files.csv);

    const audited = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "regulator.report_generate" },
    });
    expect(audited).not.toBeNull();
  });

  it("is idempotent per period/type — a second run upserts the same row", async () => {
    const coop = await createTestCoop("REG3");
    const admin = await createTestMember(coop.id, {
      phone: "2348000010003",
      role: "superadmin",
    });

    const first = await generateReport(coop.id, "2026-03", "monthly", "statutory", admin.id);
    expect(first.ok).toBe(true);
    const second = await generateReport(coop.id, "2026-03", "monthly", "statutory", admin.id);
    expect(second.ok).toBe(true);
    expect(second.reportId).toBe(first.reportId);

    const count = await prisma.regulatorReport.count({
      where: { cooperativeId: coop.id, period: "2026-03", periodType: "monthly" },
    });
    expect(count).toBe(1);
  });

  it("rejects unsupported pack types without writing a report", async () => {
    const coop = await createTestCoop("REG4");
    const res = await generateReport(coop.id, "2026-03", "monthly", "bogus" as PackType);
    expect(res.ok).toBe(false);
    expect(res.reportId).toBeUndefined();
    expect(await prisma.regulatorReport.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });

  it("generates an NFIU-only pack containing only AML sheets", async () => {
    const coop = await createTestCoop("REG7");
    const admin = await createTestMember(coop.id, {
      phone: "2348000010007",
      role: "superadmin",
    });
    await makeWithdrawal(coop.id, admin.id, 500_000_000, "paid", new Date("2026-03-10T10:00:00Z"));

    const res = await generateReport(coop.id, "2026-03", "monthly", "nfiu", admin.id);
    expect(res.ok).toBe(true);
    expect(res.reportId).toBeTruthy();

    const report = await prisma.regulatorReport.findUnique({
      where: {
        cooperativeId_period_periodType_packType: {
          cooperativeId: coop.id,
          period: "2026-03",
          periodType: "monthly",
          packType: "nfiu",
        },
      },
    });
    expect(report).not.toBeNull();

    const csv = await readFile(res.files!.csv, "utf8");
    expect(csv).toMatch(/STR|SAR/i);
    expect(csv).toMatch(/large|transaction/i);
    expect(csv).not.toMatch(/Balance Sheet/i);
  });

  it("generates both sheet groups for packType both", async () => {
    const coop = await createTestCoop("REG8");
    const admin = await createTestMember(coop.id, {
      phone: "2348000010008",
      role: "superadmin",
    });
    await makeContrib(coop.id, admin.id, 150000);

    const res = await generateReport(coop.id, "2026-03", "monthly", "both", admin.id);
    expect(res.ok).toBe(true);

    const csv = await readFile(res.files!.csv, "utf8");
    expect(csv).toMatch(/Balance Sheet/i);
    expect(csv).toMatch(/STR|SAR/i);

    const report = await prisma.regulatorReport.findUnique({
      where: {
        cooperativeId_period_periodType_packType: {
          cooperativeId: coop.id,
          period: "2026-03",
          periodType: "monthly",
          packType: "both",
        },
      },
    });
    expect(report).not.toBeNull();
  });
});

describe("runRegulatorReports", () => {
  async function enableReporting(
    coopId: string,
    overrides: { monthlyDueDay?: number; quarterlyDueDay?: number } = {},
  ) {
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coopId, regulatorReportingEnabled: true },
    });
    await prisma.regulatorProfile.create({
      data: {
        cooperativeId: coopId,
        label: "Lagos State Ministry of Cooperatives",
        type: "ministry",
        ...overrides,
      },
    });
  }

  it("generates the last closed monthly pack after month-end, idempotently", async () => {
    const coop = await createTestCoop("REG10");
    await enableReporting(coop.id);

    const created = await runRegulatorReports(new Date("2026-04-05T12:00:00Z"));
    expect(created).toBeGreaterThanOrEqual(1);

    const monthly = await prisma.regulatorReport.findUnique({
      where: {
        cooperativeId_period_periodType_packType: {
          cooperativeId: coop.id,
          period: "2026-03",
          periodType: "monthly",
          packType: "both",
        },
      },
    });
    expect(monthly).not.toBeNull();
    expect(monthly!.status).toBe("generated");
    expect(monthly!.generatedById).toBeNull(); // scheduled, not an admin

    const total = await prisma.regulatorReport.count({ where: { cooperativeId: coop.id } });

    // A second tick creates nothing new.
    const again = await runRegulatorReports(new Date("2026-04-06T12:00:00Z"));
    expect(again).toBe(0);
    expect(await prisma.regulatorReport.count({ where: { cooperativeId: coop.id } })).toBe(total);
  });

  it("generates the last closed quarterly pack after quarter-end", async () => {
    const coop = await createTestCoop("REG11");
    await enableReporting(coop.id);

    await runRegulatorReports(new Date("2026-04-05T12:00:00Z"));

    const quarterly = await prisma.regulatorReport.findUnique({
      where: {
        cooperativeId_period_periodType_packType: {
          cooperativeId: coop.id,
          period: "2026-03",
          periodType: "quarterly",
          packType: "both",
        },
      },
    });
    expect(quarterly).not.toBeNull();
  });

  it("does not generate a quarterly pack while its quarter is still open", async () => {
    const coop = await createTestCoop("REG13");
    await enableReporting(coop.id);

    // 2026-03-15: Q1 (Jan-Mar) has not closed, so the last closed quarter is Q4 2025.
    await runRegulatorReports(new Date("2026-03-15T12:00:00Z"));

    expect(
      await prisma.regulatorReport.count({
        where: { cooperativeId: coop.id, period: "2026-03", periodType: "quarterly" },
      }),
    ).toBe(0);
    expect(
      await prisma.regulatorReport.count({
        where: { cooperativeId: coop.id, period: "2025-12", periodType: "quarterly" },
      }),
    ).toBe(1);
  });

  it("reminds admins (not members) of an overdue unfiled pack", async () => {
    const coop = await createTestCoop("REG12");
    await enableReporting(coop.id);
    const admin = await createTestMember(coop.id, { phone: "2348000010021", role: "superadmin" });
    const member = await createTestMember(coop.id, { phone: "2348000010022" });

    // An overdue, still-unfiled pack.
    await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026-02",
        periodType: "monthly",
        packType: "both",
        status: "generated",
        dueAt: new Date("2026-03-10T00:00:00Z"),
      },
    });

    await runRegulatorReports(new Date("2026-04-05T12:00:00Z"));

    const calls = vi.mocked(notifyMember).mock.calls;
    const adminTexts = calls
      .filter(([m]) => m.phone === admin.phone)
      .map(([, text]) => text)
      .join("\n");
    expect(adminTexts).toMatch(/regulator|filing|due/i);

    const memberTexts = calls.filter(([m]) => m.phone === member.phone);
    expect(memberTexts).toHaveLength(0);
  });

  it("does not generate packs when reporting is disabled", async () => {
    const coop = await createTestCoop("REG14");
    await prisma.regulatorProfile.create({
      data: { cooperativeId: coop.id, label: "Ministry", type: "ministry" },
    });

    const created = await runRegulatorReports(new Date("2026-04-05T12:00:00Z"));
    expect(created).toBe(0);
    expect(await prisma.regulatorReport.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });
});

describe("setRegulatorProfile", () => {
  it("creates the profile, enables scheduled reporting and audits", async () => {
    const coop = await createTestCoop("REG20");
    const admin = await createTestMember(coop.id, { phone: "2348000010030", role: "superadmin" });

    const res = await setRegulatorProfile(
      coop.id,
      {
        label: "Lagos State Ministry of Cooperatives",
        type: "ministry",
        contactEmail: "returns@lagos.gov.ng",
        monthlyDueDay: 12,
        quarterlyDueDay: 20,
      },
      { id: admin.id, phone: admin.phone },
    );
    expect(res.ok).toBe(true);

    const profile = await prisma.regulatorProfile.findFirst({
      where: { cooperativeId: coop.id, active: true },
    });
    expect(profile).not.toBeNull();
    expect(profile!.label).toBe("Lagos State Ministry of Cooperatives");
    expect(profile!.type).toBe("ministry");
    expect(profile!.contactEmail).toBe("returns@lagos.gov.ng");
    expect(profile!.monthlyDueDay).toBe(12);
    expect(profile!.quarterlyDueDay).toBe(20);

    const cfg = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coop.id } });
    expect(cfg?.regulatorReportingEnabled).toBe(true);

    const audited = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "regulator.profile_set" },
    });
    expect(audited).not.toBeNull();
  });

  it("updates the existing active profile in place rather than adding another", async () => {
    const coop = await createTestCoop("REG21");
    const admin = await createTestMember(coop.id, { phone: "2348000010031", role: "superadmin" });
    const actor = { id: admin.id, phone: admin.phone };

    await setRegulatorProfile(coop.id, { label: "Ministry A", type: "ministry" }, actor);
    const res = await setRegulatorProfile(coop.id, { label: "NFIU Unit", type: "nfiu" }, actor);
    expect(res.ok).toBe(true);

    const profiles = await prisma.regulatorProfile.findMany({ where: { cooperativeId: coop.id } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].label).toBe("NFIU Unit");
    expect(profiles[0].type).toBe("nfiu");
  });

  it("rejects an unknown regulator type without writing", async () => {
    const coop = await createTestCoop("REG22");
    const admin = await createTestMember(coop.id, { phone: "2348000010032", role: "superadmin" });

    const res = await setRegulatorProfile(
      coop.id,
      { label: "Bad", type: "irs" },
      { id: admin.id, phone: admin.phone },
    );
    expect(res.ok).toBe(false);
    expect(await prisma.regulatorProfile.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });

  it("requires a label when no profile exists yet", async () => {
    const coop = await createTestCoop("REG23");
    const admin = await createTestMember(coop.id, { phone: "2348000010033", role: "superadmin" });

    const res = await setRegulatorProfile(
      coop.id,
      { type: "ministry" },
      { id: admin.id, phone: admin.phone },
    );
    expect(res.ok).toBe(false);
    expect(await prisma.regulatorProfile.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });
});

describe("markFiled", () => {
  it("sets status filed, stamps filedAt and audits", async () => {
    const coop = await createTestCoop("REG24");
    const admin = await createTestMember(coop.id, { phone: "2348000010034", role: "superadmin" });

    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026-03",
        periodType: "monthly",
        packType: "both",
        status: "generated",
        dueAt: new Date("2026-04-10T00:00:00Z"),
      },
    });

    const res = await markFiled(coop.id, report.id, { id: admin.id, phone: admin.phone });
    expect(res.ok).toBe(true);

    const updated = await prisma.regulatorReport.findUnique({ where: { id: report.id } });
    expect(updated!.status).toBe("filed");
    expect(updated!.filedAt).toBeInstanceOf(Date);

    const audited = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "regulator.report_filed", targetId: report.id },
    });
    expect(audited).not.toBeNull();
  });

  it("resolves a report by id suffix and is a no-op when already filed", async () => {
    const coop = await createTestCoop("REG25");
    const admin = await createTestMember(coop.id, { phone: "2348000010035", role: "superadmin" });

    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026-03",
        periodType: "monthly",
        packType: "statutory",
        status: "generated",
      },
    });

    const actor = { id: admin.id, phone: admin.phone };
    const first = await markFiled(coop.id, report.id.slice(-6), actor);
    expect(first.ok).toBe(true);
    const second = await markFiled(coop.id, report.id, actor);
    expect(second.ok).toBe(true);

    const updated = await prisma.regulatorReport.findUnique({ where: { id: report.id } });
    expect(updated!.status).toBe("filed");
  });

  it("reports failure for an unknown report id", async () => {
    const coop = await createTestCoop("REG26");
    const admin = await createTestMember(coop.id, { phone: "2348000010036", role: "superadmin" });

    const res = await markFiled(coop.id, "does-not-exist", { id: admin.id, phone: admin.phone });
    expect(res.ok).toBe(false);
  });
});

describe("listReports", () => {
  it("lists generated and filed packs for the cooperative", async () => {
    const coop = await createTestCoop("REG27");
    await prisma.regulatorReport.createMany({
      data: [
        {
          cooperativeId: coop.id,
          period: "2026-02",
          periodType: "monthly",
          packType: "both",
          status: "filed",
          filedAt: new Date("2026-03-09T00:00:00Z"),
        },
        {
          cooperativeId: coop.id,
          period: "2026-03",
          periodType: "monthly",
          packType: "both",
          status: "generated",
        },
      ],
    });

    const res = await listReports(coop.id);
    expect(res.ok).toBe(true);
    expect(res.reports).toHaveLength(2);
    const statuses = res.reports!.map((r) => r.status).sort();
    expect(statuses).toEqual(["filed", "generated"]);
    expect(res.message).toMatch(/regulator/i);
  });

  it("returns an empty list when nothing has been generated", async () => {
    const coop = await createTestCoop("REG28");
    const res = await listReports(coop.id);
    expect(res.ok).toBe(true);
    expect(res.reports).toEqual([]);
  });
});

describe("regulator admin commands", () => {
  it("configures the regulator, lists packs and marks one filed via chat", async () => {
    const coop = await createTestCoop("REG29");
    const admin = await createTestMember(coop.id, { phone: "2348000010039", role: "superadmin" });

    await handleAdminCommand(admin.phone, "regulatorconfig", [
      "Lagos",
      "Ministry",
      "ministry",
      "returns@lagos.gov.ng",
      "10",
      "15",
    ]);
    const profile = await prisma.regulatorProfile.findFirst({
      where: { cooperativeId: coop.id, active: true },
    });
    expect(profile?.label).toBe("Lagos Ministry");
    expect(profile?.type).toBe("ministry");
    expect(profile?.contactEmail).toBe("returns@lagos.gov.ng");
    expect(profile?.monthlyDueDay).toBe(10);
    expect(profile?.quarterlyDueDay).toBe(15);

    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026-03",
        periodType: "monthly",
        packType: "both",
        status: "generated",
      },
    });

    vi.clearAllMocks();
    await handleAdminCommand(admin.phone, "regreportstatus", []);
    const listed = vi
      .mocked(sendText)
      .mock.calls.map((c) => String(c[0].text))
      .join("\n");
    expect(listed).toMatch(/2026-03/);

    await handleAdminCommand(admin.phone, "regreport", ["filed", report.id.slice(-6)]);
    const updated = await prisma.regulatorReport.findUnique({ where: { id: report.id } });
    expect(updated!.status).toBe("filed");
  });

  it("does not handle regulator commands for ordinary members", async () => {
    const coop = await createTestCoop("REG30");
    const member = await createTestMember(coop.id, { phone: "2348000010040" });

    const handled = await handleAdminCommand(member.phone, "regreportstatus", []);
    expect(handled).toBe(false);
  });
});
