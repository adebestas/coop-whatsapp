import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { notifyMember, sendText } from "../src/lib/messaging.js";
import { generateMemberCode } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import {
  requestSubstitution,
  confirmSubstitution,
  approveSubstitution,
  rejectSubstitution,
  listSubstitutions,
} from "../src/services/guarantor-substitution.js";

const BORROWER = "2348071000001";
const OLD = "2348071000002";
const FRESH = "2348071000003";
const ADMIN = "2348071000004";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const table of [
    "guarantorSubstitution",
    "guarantorVerification",
    "guarantor",
    "loanRepayment",
    "auditLog",
    "loan",
    "wallet",
    "shareAccount",
    "member",
    "cooperative",
    "session",
  ]) {
    await wipe(table);
  }
  clearMemberCache();
  vi.mocked(sendText).mockClear();
  vi.mocked(notifyMember).mockClear();
});

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Swap Coop", code: `SW${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const make = (phone: string, name: string, role = "member") =>
    prisma.member.create({
      data: {
        cooperativeId: coop.id,
        phone,
        name,
        code: generateMemberCode(),
        role,
        status: "active",
        consentAt: new Date(),
        wallet: { create: { totalSaved: 5_000_000 } },
      },
    });
  const borrower = await make(BORROWER, "Borrower");
  const oldG = await make(OLD, "Old Guarantor");
  const fresh = await make(FRESH, "Fresh Guarantor");
  const admin = await make(ADMIN, "Admin", "admin");
  const loan = await prisma.loan.create({
    data: {
      amount: 600_000,
      balance: 500_000,
      monthlyPayment: 100_000,
      tenureMonths: 6,
      status: "disbursed",
      dueDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      memberId: borrower.id,
      cooperativeId: coop.id,
    },
  });
  await prisma.guarantor.create({
    data: {
      loanId: loan.id,
      memberId: oldG.id,
      code: "OLD111",
      status: "confirmed",
      confirmedAt: new Date(),
    },
  });
  return { coop, borrower, oldG, fresh, admin, loan };
}

function notifiedTexts(): string[] {
  return vi.mocked(notifyMember).mock.calls.map((c) => (c[1] as string) ?? "");
}

describe("guarantor substitution", () => {
  it("creates a pending request and notifies the new guarantor with a code", async () => {
    const { borrower, oldG, fresh, loan } = await seed();

    const result = await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    expect(result.ok).toBe(true);

    const row = await prisma.guarantorSubstitution.findFirst({ where: { loanId: loan.id } });
    expect(row?.status).toBe("pending_guarantor");
    expect(row?.newMemberId).toBe(fresh.id);
    expect(notifiedTexts().some((t) => t.includes(`confirm ${row?.code}`))).toBe(true);
    expect(row?.requestedById).toBe(borrower.id);
  });

  it("only the new guarantor can confirm, which moves the swap to admin approval", async () => {
    const { oldG, fresh, loan } = await seed();
    await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    const row = await prisma.guarantorSubstitution.findFirstOrThrow({ where: { loanId: loan.id } });

    const wrong = await confirmSubstitution(BORROWER, row.code!);
    expect(wrong?.ok).toBe(false);

    const ok = await confirmSubstitution(FRESH, row.code!);
    expect(ok?.ok).toBe(true);

    const updated = await prisma.guarantorSubstitution.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("pending_admin");
  });

  it("admin approval releases the old guarantor and confirms the new one", async () => {
    const { oldG, fresh, loan } = await seed();
    await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    const row = await prisma.guarantorSubstitution.findFirstOrThrow({ where: { loanId: loan.id } });
    await confirmSubstitution(FRESH, row.code!);

    const result = await approveSubstitution(ADMIN, row.reference!);
    expect(result.ok).toBe(true);

    const oldRow = await prisma.guarantor.findFirstOrThrow({
      where: { loanId: loan.id, memberId: oldG.id },
    });
    expect(oldRow.status).toBe("released");
    expect(oldRow.releasedAt).not.toBeNull();

    const newRow = await prisma.guarantor.findFirstOrThrow({
      where: { loanId: loan.id, memberId: fresh.id },
    });
    expect(newRow.status).toBe("confirmed");

    const updated = await prisma.guarantorSubstitution.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("approved");

    expect(notifiedTexts().some((t) => t.includes("formally released"))).toBe(true);
  });

  it("refuses approval before the new guarantor confirms", async () => {
    const { oldG, fresh, loan } = await seed();
    await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    const row = await prisma.guarantorSubstitution.findFirstOrThrow({ where: { loanId: loan.id } });

    const result = await approveSubstitution(ADMIN, row.reference!);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("hasn't confirmed");
  });

  it("only an admin can approve", async () => {
    const { oldG, fresh, loan } = await seed();
    await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    const row = await prisma.guarantorSubstitution.findFirstOrThrow({ where: { loanId: loan.id } });
    await confirmSubstitution(FRESH, row.code!);

    const result = await approveSubstitution(BORROWER, row.reference!);
    expect(result.ok).toBe(false);
    expect(await prisma.guarantor.count({ where: { loanId: loan.id, memberId: fresh.id } })).toBe(
      0,
    );
  });

  it("rejection keeps the original guarantor liable", async () => {
    const { oldG, fresh, loan } = await seed();
    await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    const row = await prisma.guarantorSubstitution.findFirstOrThrow({ where: { loanId: loan.id } });
    await confirmSubstitution(FRESH, row.code!);

    const result = await rejectSubstitution(ADMIN, row.reference!, "not enough savings");
    expect(result.ok).toBe(true);

    const oldRow = await prisma.guarantor.findFirstOrThrow({
      where: { loanId: loan.id, memberId: oldG.id },
    });
    expect(oldRow.status).toBe("confirmed");
    expect(await prisma.guarantor.count({ where: { loanId: loan.id, memberId: fresh.id } })).toBe(
      0,
    );
  });

  it("refuses a new guarantor who already backs two active loans", async () => {
    const { coop, oldG, fresh, loan, admin } = await seed();
    for (const [index, name] of ["Other A", "Other B"].entries()) {
      const borrower = await prisma.member.create({
        data: {
          cooperativeId: coop.id,
          phone: `23480710001${index}0`,
          name: `${name} ${Math.random()}`,
          code: generateMemberCode(),
          status: "active",
          wallet: { create: {} },
        },
      });
      const other = await prisma.loan.create({
        data: {
          amount: 100_000,
          balance: 100_000,
          tenureMonths: 3,
          status: "disbursed",
          memberId: borrower.id,
          cooperativeId: coop.id,
        },
      });
      await prisma.guarantor.create({
        data: {
          loanId: other.id,
          memberId: fresh.id,
          code: generateMemberCode(),
          status: "confirmed",
        },
      });
    }

    const result = await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("active loans");
    expect(admin.id).toBeTruthy();
  });

  it("only the borrower can request a swap on their own loan", async () => {
    const { oldG, fresh, loan } = await seed();
    const result = await requestSubstitution(FRESH, loan.id, oldG.code, ADMIN);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("doesn't belong to you");
  });

  it("lists pending swaps for admins only", async () => {
    const { oldG, fresh, loan } = await seed();
    await requestSubstitution(BORROWER, loan.id, oldG.code, fresh.code);

    const denied = await listSubstitutions(BORROWER);
    expect(denied.ok).toBe(false);

    const listed = await listSubstitutions(ADMIN);
    expect(listed.ok).toBe(true);
    expect(listed.message).toContain("Pending guarantor substitutions");
  });
});
