import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import {
  computePar,
  computeProvision,
  provisionRates,
  runProvision,
} from "../src/services/provisioning.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Provision Coop ${code}`, code } });
}

async function makeMember(coopId: string, name: string, role: "member" | "admin" | "superadmin" = "member") {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone: `2348${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      name,
      cooperativeId: coopId,
      role,
      status: "active",
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

/** A disbursed loan with `balance` kobo that came due `daysOverdue` days ago. */
async function makeOverdueLoan(coopId: string, memberId: string, balance: number, daysOverdue: number) {
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

async function setRates(coopId: string, rates: Record<string, number>) {
  await prisma.cooperativeConfig.upsert({
    where: { cooperativeId: coopId },
    create: { cooperativeId: coopId, provisionRates: JSON.stringify(rates) },
    update: { provisionRates: JSON.stringify(rates) },
  });
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("provisionRates", () => {
  it("returns the cooperative's configured bucket rates", async () => {
    const coop = await makeCoop("PROV1");
    await setRates(coop.id, { "1-30": 1, "31-90": 5, "91-180": 20, "180+": 50 });
    expect(await provisionRates(coop.id)).toEqual({ "1-30": 1, "31-90": 5, "91-180": 20, "180+": 50 });
  });
});

describe("computePar", () => {
  it("classifies overdue balances into aging buckets by dueDate", async () => {
    const coop = await makeCoop("PROV2");
    const member = await makeMember(coop.id, "Ada");
    await makeOverdueLoan(coop.id, member.id, 10000, 10);
    await makeOverdueLoan(coop.id, member.id, 100000, 45);
    await makeOverdueLoan(coop.id, member.id, 50000, 120);
    await makeOverdueLoan(coop.id, member.id, 20000, 200);
    // Not yet due — should be current, excluded from the PAR buckets.
    await makeOverdueLoan(coop.id, member.id, 7000, -5);

    const par = await computePar(coop.id);
    expect(par.buckets["1-30"]).toBe(10000);
    expect(par.buckets["31-90"]).toBe(100000);
    expect(par.buckets["91-180"]).toBe(50000);
    expect(par.buckets["180+"]).toBe(20000);
    expect(par.total).toBe(180000);
  });

  it("computes PAR ratio as past-due over the whole outstanding portfolio", async () => {
    const coop = await makeCoop("PROV3");
    const member = await makeMember(coop.id, "Ada");
    await makeOverdueLoan(coop.id, member.id, 30000, 45); // past due
    await makeOverdueLoan(coop.id, member.id, 70000, -5); // current
    const par = await computePar(coop.id);
    expect(par.total).toBe(30000);
    expect(par.parRatio).toBeCloseTo(0.3, 5);
  });
});

describe("computeProvision", () => {
  it("provisions a 45-day-overdue 100000 loan at the 5% bucket rate", async () => {
    const coop = await makeCoop("PROV4");
    const member = await makeMember(coop.id, "Ada");
    const loan = await makeOverdueLoan(coop.id, member.id, 100000, 45);
    await setRates(coop.id, { "1-30": 1, "31-90": 5, "91-180": 20, "180+": 50 });

    const provision = await computeProvision(coop.id);
    expect(provision.total).toBe(5000);
    expect(provision.entries).toHaveLength(1);
    expect(provision.entries[0]).toMatchObject({ loanId: loan.id, bucket: "31-90", amount: 5000 });
  });
});

describe("runProvision", () => {
  it("persists a run + entries, posts a balanced journal, and increases the provision balance", async () => {
    const coop = await makeCoop("PROV5");
    const member = await makeMember(coop.id, "Ada");
    const superAdmin = await makeMember(coop.id, "Boss", "superadmin");
    const loan = await makeOverdueLoan(coop.id, member.id, 100000, 45);
    await setRates(coop.id, { "1-30": 1, "31-90": 5, "91-180": 20, "180+": 50 });

    const result = await runProvision(coop.id, {
      id: superAdmin.id,
      phone: superAdmin.phone,
      role: superAdmin.role,
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(5000);

    const run = await prisma.provisionRun.findUnique({
      where: { cooperativeId_period: { cooperativeId: coop.id, period: currentPeriod() } },
      include: { entries: true },
    });
    expect(run).not.toBeNull();
    expect(run!.totalProvision).toBe(5000);
    expect(run!.entries).toHaveLength(1);
    expect(run!.entries[0].loanId).toBe(loan.id);
    expect(run!.entries[0].amount).toBe(5000);
    expect(result.runId).toBe(run!.id);

    const updated = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updated!.loanLossProvisionBalance).toBe(5000);

    const postings = await prisma.posting.findMany({
      where: {
        entry: { cooperativeId: coop.id },
        account: { in: ["expense:loan_loss_provision", "assets:loan_loss_provision"] },
      },
    });
    const debit = postings
      .filter((p) => p.direction === "DEBIT")
      .reduce((s, p) => s + p.amount, 0);
    const credit = postings
      .filter((p) => p.direction === "CREDIT")
      .reduce((s, p) => s + p.amount, 0);
    expect(debit).toBe(5000);
    expect(credit).toBe(5000);
    expect(postings.some((p) => p.account === "expense:loan_loss_provision" && p.direction === "DEBIT")).toBe(true);
    expect(postings.some((p) => p.account === "assets:loan_loss_provision" && p.direction === "CREDIT")).toBe(true);
  });

  it("refuses a second run in the same period", async () => {
    const coop = await makeCoop("PROV6");
    const member = await makeMember(coop.id, "Ada");
    const superAdmin = await makeMember(coop.id, "Boss", "superadmin");
    await makeOverdueLoan(coop.id, member.id, 100000, 45);
    await setRates(coop.id, { "1-30": 1, "31-90": 5, "91-180": 20, "180+": 50 });

    const actor = { id: superAdmin.id, phone: superAdmin.phone, role: superAdmin.role };
    const first = await runProvision(coop.id, actor);
    expect(first.ok).toBe(true);

    const second = await runProvision(coop.id, actor);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already|period/i);
  });

  it("refuses a non-admin actor", async () => {
    const coop = await makeCoop("PROV7");
    const member = await makeMember(coop.id, "Ada");
    await makeOverdueLoan(coop.id, member.id, 100000, 45);
    await setRates(coop.id, { "1-30": 1, "31-90": 5, "91-180": 20, "180+": 50 });

    const result = await runProvision(coop.id, { id: member.id, phone: member.phone, role: member.role });
    expect(result.ok).toBe(false);
    expect(result.runId).toBeUndefined();
    const run = await prisma.provisionRun.findFirst({ where: { cooperativeId: coop.id } });
    expect(run).toBeNull();
  });
});
