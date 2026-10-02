/**
 * Integration test setup.
 * Provides helpers for testing with a real database.
 *
 * Usage in tests:
 *   import { createTestApp, createTestMember, cleanupDatabase } from "./setup";
 */
import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";

// Use SQLite for tests (local schema)
export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "file:./dev.db",
    },
  },
});

// ===== Global Mocks =====
// Mock only the TRANSPORT layer, never src/lib/messaging.js itself.
// The messaging module is wrapped in vi.fn() instead of replaced, so real behaviour
// runs (opt-out suppression, WhatsApp 24h session window, channel selection) while
// existing `vi.mocked(sendText).mock.calls` assertions keep working. Replacing it
// with a pass-through stub — which is what this file used to do — silently hid all
// of that from the suite, and left console.log noise in the output.
vi.mock("../src/lib/whatsapp.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendFlowMessage: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/lib/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/telegram.js")>();
  return {
    ...actual,
    sendTelegramMessage: vi.fn().mockResolvedValue(true),
    sendTelegramKeyboard: vi.fn().mockResolvedValue(1),
    deleteTelegramMessage: vi.fn().mockResolvedValue(true),
    getTelegramUpdates: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../src/lib/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/messaging.js")>();
  return {
    ...actual,
    sendText: vi.fn(actual.sendText),
    sendSecurePrompt: vi.fn(actual.sendSecurePrompt),
    notifyMember: vi.fn(actual.notifyMember),
  };
});

// Mock payments module to avoid real API calls in tests
vi.mock("../src/services/payments/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/payments/index.js")>();
  return {
    ...actual,
    resolveProvider: vi.fn(() => ({
      name: "monnify",
      createVirtualAccount: vi.fn(),
      payout: vi.fn(async () => ({ ok: true, providerRef: "pay-trx-1" })),
      resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
      verifyWebhook: () => true,
      parseNotification: () => null,
    })),
    isProviderAvailable: vi.fn().mockResolvedValue(true),
    markProviderDown: vi.fn(),
    markProviderUp: vi.fn(),
    getProviderStatus: vi.fn(),
  };
});

import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { beforeEach } from "vitest";

// ===== Global Fixtures =====
// getMemberByPhone() memoises member rows for 30s and tests reuse the same phone
// numbers across cases, so a cached row from the previous test survives its own
// beforeEach DELETE and later writes fail with "No record was found for an update".
// Clearing the cache before every test isolates cases regardless of which cleanup
// helper the file happens to use.
beforeEach(() => {
  clearMemberCache();
});

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
      consentAt: new Date(),
    },
    update: { role, name, consentAt: new Date() },
  });

  return { id: member.id, phone: member.phone, code: member.code, name: member.name, role: member.role };
}

// ===== Database Helpers =====

/**
 * Clean up test data.
 *
 * Deletes every table in the database rather than a hand-maintained list: the
 * list silently drifted from the schema (it predates DataConsent, AccountOfficer,
 * GuarantorVerification and others), so rows survived between test files and made
 * unrelated tests fail depending on execution order. Foreign keys are disabled for
 * the duration so the order does not matter.
 */
export async function cleanupDatabase(): Promise<void> {
  clearMemberCache();
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
  );
  if (tables.length === 0) return;

  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = OFF`);
  try {
    for (const table of tables) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table.name}"`);
    }
  } finally {
    await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
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
