import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { addGuarantor } from "../src/services/guarantors.js";

const B_PHONE = "2348010000001";
const G_PHONE = "2348071111111";
const OTHER_PHONE = "2348022222222";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Guarantor Coop ${code}`, code } });
}

async function makeMember(phone: string, coopId: string, name: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name,
      cooperativeId: coopId,
      role: "member",
      pin: hashPin("1234"),
      wallet: { create: {} },
      consentAt: new Date(),
    },
  });
}

async function makePendingLoan(coopId: string, memberId: string) {
  return prisma.loan.create({
    data: {
      amount: 5000000,
      balance: 5000000,
      tenureMonths: 3,
      status: "pending",
      memberId,
      cooperativeId: coopId,
    },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("addGuarantor by phone number", () => {
  it("adds a same-coop member as guarantor when given their phone number", async () => {
    const coop = await makeCoop("GP01");
    const borrower = await makeMember(B_PHONE, coop.id, "Bola Borrower");
    const guarantor = await makeMember(G_PHONE, coop.id, "Grace Guarantor");
    const loan = await makePendingLoan(coop.id, borrower.id);

    const result = await addGuarantor(B_PHONE, loan.id, G_PHONE);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Grace Guarantor");
    const row = await prisma.guarantor.findFirst({ where: { loanId: loan.id } });
    expect(row).not.toBeNull();
    expect(row!.memberId).toBe(guarantor.id);
    expect(row!.status).toBe("pending");
  });

  it("still resolves a guarantor by member code (regression)", async () => {
    const coop = await makeCoop("GP02");
    const borrower = await makeMember(B_PHONE, coop.id, "Bola Borrower");
    const guarantor = await makeMember(G_PHONE, coop.id, "Grace Guarantor");
    const loan = await makePendingLoan(coop.id, borrower.id);

    const result = await addGuarantor(B_PHONE, loan.id, guarantor.code);

    expect(result.ok).toBe(true);
    const row = await prisma.guarantor.findFirst({ where: { loanId: loan.id } });
    expect(row!.memberId).toBe(guarantor.id);
  });

  it("rejects a phone number that belongs to a different cooperative", async () => {
    const coop = await makeCoop("GP03");
    const other = await makeCoop("GP04");
    const borrower = await makeMember(B_PHONE, coop.id, "Bola Borrower");
    await makeMember(OTHER_PHONE, other.id, "Other Coop Member");
    const loan = await makePendingLoan(coop.id, borrower.id);

    const result = await addGuarantor(B_PHONE, loan.id, OTHER_PHONE);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No member/i);
    expect(await prisma.guarantor.count({ where: { loanId: loan.id } })).toBe(0);
  });

  it("rejects the borrower's own phone number", async () => {
    const coop = await makeCoop("GP05");
    const borrower = await makeMember(B_PHONE, coop.id, "Bola Borrower");
    const loan = await makePendingLoan(coop.id, borrower.id);

    const result = await addGuarantor(B_PHONE, loan.id, B_PHONE);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/your own guarantor/i);
  });
});
