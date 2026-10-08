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
  type PackType,
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
