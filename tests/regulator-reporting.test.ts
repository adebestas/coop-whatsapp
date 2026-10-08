import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { formatBalance } from "../src/lib/money.js";
import {
  reportPeriod,
  periodDueAt,
  statutoryPack,
  generateReport,
} from "../src/services/regulator-reporting.js";

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
    const res = await generateReport(coop.id, "2026-03", "monthly", "nfiu");
    expect(res.ok).toBe(false);
    expect(res.reportId).toBeUndefined();
    expect(await prisma.regulatorReport.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });
});
