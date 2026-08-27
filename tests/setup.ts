/**
 * Integration test setup.
 * Provides helpers for testing with a real database.
 *
 * Usage in tests:
 *   import { createTestApp, createTestMember, cleanupDatabase } from "./setup";
 */
import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

// ===== Test App =====

let app: FastifyInstance | null = null;

/**
 * Create a test Fastify instance
 */
export async function createTestApp(): Promise<FastifyInstance> {
  if (!app) {
    app = buildApp();
    await app.ready();
  }
  return app;
}

/**
 * Close the test app
 */
export async function closeTestApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

// ===== Test Data =====

export interface TestCoop {
  id: string;
  code: string;
  name: string;
}

export interface TestMember {
  id: string;
  phone: string;
  code: string;
  name: string;
  role: string;
}

/**
 * Create a test cooperative
 */
export async function createTestCoop(code = "TEST01"): Promise<TestCoop> {
  const coop = await prisma.cooperative.upsert({
    where: { code },
    create: {
      name: `Test Coop ${code}`,
      code,
      state: "Lagos",
      adminPhone: "2348012345678",
    },
    update: {},
  });

  return { id: coop.id, code: coop.code, name: coop.name };
}

/**
 * Create a test member
 */
export async function createTestMember(
  coopId: string,
  options: {
    phone?: string;
    name?: string;
    role?: "member" | "admin" | "superadmin";
    pin?: string;
  } = {},
): Promise<TestMember> {
  const phone = options.phone || `23480${Math.floor(1000000 + Math.random() * 9000000)}`;
  const name = options.name || `Test User ${phone.slice(-4)}`;
  const role = options.role || "member";
  const pin = options.pin || "1234";

  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }

  const member = await prisma.member.upsert({
    where: { cooperativeId_phone: { cooperativeId: coopId, phone } },
    create: {
      name,
      phone,
      code,
      pin: hashPin(pin),
      role,
      cooperativeId: coopId,
      wallet: { create: {} },
    },
    update: { role, name },
  });

  return { id: member.id, phone: member.phone, code: member.code, name: member.name, role: member.role };
}

// ===== Database Helpers =====

/**
 * Clean up test data
 */
export async function cleanupDatabase(): Promise<void> {
  // Delete in reverse dependency order
  const tables = [
    "Posting",
    "JournalEntry",
    "WebhookEvent",
    "AuditLog",
    "VoteBallot",
    "PollOption",
    "PurchasePoll",
    "DeathClaim",
    "DeathValidation",
    "DeathCertificate",
    "Beneficiary",
    "LoanRepayment",
    "Loan",
    "Guarantor",
    "WithdrawalRequest",
    "ExternalPayment",
    "Contribution",
    "DeductionItem",
    "DeductionBatch",
    "DeductionWaiver",
    "Payout",
    "Wallet",
    "Session",
    "Member",
    "Unit",
    "Cooperative",
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } catch {
      // Table might not exist
    }
  }
}

/**
 * Reset auto-increment IDs (PostgreSQL only)
 */
export async function resetAutoIncrement(): Promise<void> {
  const tables = [
    "Cooperative",
    "Member",
    "Wallet",
    "Contribution",
    "Loan",
    "LoanRepayment",
    "WithdrawalRequest",
    "ExternalPayment",
    "Payout",
    "AuditLog",
    "WebhookEvent",
    "Session",
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`ALTER SEQUENCE "${table}_id_seq" RESTART WITH 1`);
    } catch {
      // Not PostgreSQL or sequence doesn't exist
    }
  }
}

// ===== Assertion Helpers =====

/**
 * Expect an error to be thrown
 */
export async function expectError(
  fn: () => Promise<unknown>,
  expectedMessage?: string,
): Promise<void> {
  try {
    await fn();
    throw new Error("Expected an error to be thrown");
  } catch (err: any) {
    if (expectedMessage && !err.message.includes(expectedMessage)) {
      throw new Error(`Expected "${expectedMessage}" but got "${err.message}"`);
    }
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for condition");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
