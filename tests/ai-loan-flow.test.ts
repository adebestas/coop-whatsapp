import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

const BORROWER = "2348011110001";
const G1_PHONE = "2348022220001"; // guarantor identified by phone
const G2_CODE = "GUA002"; // guarantor identified by member code
const G1_CODE = "GUA001";

/**
 * Route AI calls by system prompt: the loan extractor gets the loan JSON, the
 * account-mismatch warning gets a warning string. Mirrors production, where
 * both calls hit the same Groq endpoint.
 */
function aiFetch(
  loan: unknown,
  warningText = "⚠️ Heads up: the account name (*ADA OBI*) does not match your registered name (*Bisi Borrower*).",
) {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const sys = String(body.messages?.[0]?.content ?? "");
    const content = sys.includes("loan-application details")
      ? JSON.stringify({ loan })
      : warningText;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
}

async function textsSent(): Promise<string> {
  return (sendText as any).mock.calls.map((c: any[]) => String(c[0].text)).join("\n");
}

async function seed(opts: { suspended?: boolean } = {}) {
  const coop = await prisma.cooperative.create({
    data: { name: "Flow Coop", code: "T9FLOW", dailyPayoutLimit: 5_000_000 },
  });
  const borrower = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: BORROWER,
      name: "Bisi Borrower",
      code: "BRW001",
      role: "member",
      status: opts.suspended ? "suspended" : "active",
      consentAt: new Date(),
      wallet: { create: { balance: 20_000_000, totalSaved: 20_000_000 } },
    },
  });
  await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: G1_PHONE,
      name: "G One",
      code: G1_CODE,
      role: "member",
      status: "active",
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
  await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348033330001",
      name: "G Two",
      code: G2_CODE,
      role: "member",
      status: "active",
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
  return { coop, borrower };
}

async function sessionOf(phone: string) {
  const s = await prisma.session.findUnique({ where: { phone } });
  return { state: s?.state, data: s ? (JSON.parse(s.data) as Record<string, unknown>) : {} };
}

async function lastText(): Promise<string> {
  const calls = (sendText as any).mock.calls;
  return calls.length ? String(calls[calls.length - 1][0].text) : "";
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

describe("natural-language loan intake", () => {
  it("auto-fills amount, months and guarantors and jumps to the bank step", async () => {
    process.env.GROQ_API_KEY = "test-key";
    await seed();
    vi.stubGlobal("fetch", aiFetch({ amount: 40000, months: 3, guarantors: [G1_PHONE, G2_CODE] }));

    await handleMessage(
      BORROWER,
      "i need a loan of 40k for 3 months, guarantors 2348022220001 and GUA002",
    );

    const { state, data } = await sessionOf(BORROWER);
    expect(state).toBe("awaiting_loan_bank_account");
    expect(data.loanAmount).toBe(4_000_000); // 40,000 naira in kobo
    expect(data.loanMonths).toBe(3);
    expect(data.pendingGuarantors).toEqual([G1_PHONE, G2_CODE]);
    expect(await lastText()).toContain("bank account number");
  });

  it("asks for months when only the amount is given", async () => {
    process.env.GROQ_API_KEY = "test-key";
    await seed();
    vi.stubGlobal("fetch", aiFetch({ amount: 40000, months: null, guarantors: [G1_PHONE] }));

    await handleMessage(BORROWER, "pls i need a loan of 40k, my guarantor is 2348022220001");

    const { state, data } = await sessionOf(BORROWER);
    expect(state).toBe("awaiting_loan_months");
    expect(data.loanAmount).toBe(4_000_000);
    expect(data.pendingGuarantors).toEqual([G1_PHONE]);
    expect(await lastText()).toContain("months");
  });

  it("asks for the amount when none is given", async () => {
    process.env.GROQ_API_KEY = "test-key";
    await seed();
    vi.stubGlobal("fetch", aiFetch({ amount: null, months: null, guarantors: [] }));

    await handleMessage(BORROWER, "i want to borrow some money please");

    expect((await sessionOf(BORROWER)).state).toBe("awaiting_loan_amount");
  });

  it("auto-adds the supplied guarantors after the bank step and finishes", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const { borrower } = await seed();
    vi.stubGlobal("fetch", aiFetch({ amount: 40000, months: 6, guarantors: [G1_PHONE, G2_CODE] }));

    await handleMessage(BORROWER, "i need a loan of 40k guarantors 2348022220001 and GUA002");
    expect((await sessionOf(BORROWER)).state).toBe("awaiting_loan_bank_account");

    await handleMessage(BORROWER, "0123456789"); // account number
    await handleMessage(BORROWER, "058"); // GTBank code
    await handleMessage(BORROWER, "yes"); // confirm

    expect((await sessionOf(BORROWER)).state).toBe("idle");

    const loan = await prisma.loan.findFirst({ where: { memberId: borrower.id } });
    expect(loan).not.toBeNull();

    const guarantors = await prisma.guarantor.findMany({ where: { loanId: loan!.id } });
    expect(guarantors).toHaveLength(2);
    expect(guarantors.map((g) => g.status)).toEqual(["pending", "pending"]);
  });

  it("asks for the remaining guarantor when fewer than needed are supplied", async () => {
    process.env.GROQ_API_KEY = "test-key";
    await seed();
    vi.stubGlobal("fetch", aiFetch({ amount: 40000, months: 6, guarantors: [G1_PHONE] }));

    await handleMessage(BORROWER, "i need a loan of 40k, guarantor 2348022220001");
    await handleMessage(BORROWER, "0123456789");
    await handleMessage(BORROWER, "058");
    await handleMessage(BORROWER, "yes");

    const { state, data } = await sessionOf(BORROWER);
    expect(state).toBe("awaiting_guarantor_2");
    expect(data.loanId).toBeTruthy();
  });

  it("warns the borrower when the resolved account name doesn't match their registered name", async () => {
    process.env.GROQ_API_KEY = "test-key";
    await seed();
    vi.stubGlobal("fetch", aiFetch({ amount: 40000, months: 6, guarantors: [G1_PHONE] }));

    await handleMessage(BORROWER, "i need a loan of 40k, guarantor 2348022220001");
    await handleMessage(BORROWER, "0123456789");
    await handleMessage(BORROWER, "058");

    const all = await textsSent();
    expect(all).toMatch(/does not match/i);
    expect(all).toContain("ADA OBI");
    expect(all).toContain("Bisi Borrower");
  });

  it("blocked a suspended member's natural-language loan request", async () => {
    process.env.GROQ_API_KEY = "test-key";
    await seed({ suspended: true });
    vi.stubGlobal("fetch", aiFetch({ amount: 40000, months: 6, guarantors: [G1_PHONE] }));

    await handleMessage(BORROWER, "i need a loan of 40k, guarantor 2348022220001");

    const { state } = await sessionOf(BORROWER);
    expect(state).not.toBe("awaiting_loan_bank_account");
    expect(state).not.toBe("awaiting_loan_months");
    expect(await lastText()).toMatch(/suspended/i);
  });
});
