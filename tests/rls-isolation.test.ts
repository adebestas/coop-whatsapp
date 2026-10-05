import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { hashPin, generateMemberCode } from "../src/lib/security.js";

/**
 * RLS (Row-Level Security) cross-cooperative isolation tests.
 *
 * These run ONLY when RLS_ENABLED=1 AND DATABASE_URL is PostgreSQL.
 *
 * They MUST connect as a NON-OWNER role: the table owner bypasses RLS even with
 * policies enabled, so a test connecting as the owner would assert nothing (the
 * previous version of this file did exactly that, and also used the SQLite test
 * client — so it could never pass). This suite provisions a `coop_app` role,
 * connects a second Prisma client as it, and runs every isolation assertion
 * inside a transaction that sets `app.current_cooperative_id`.
 *
 * Fixtures are created as the owner (which bypasses RLS); assertions run as the
 * non-owner, where the policies actually bite.
 */

const ownerUrl = process.env.DATABASE_URL ?? "";
const rlsEnabled = process.env.RLS_ENABLED === "1" && ownerUrl.startsWith("postgres");

const APP_ROLE = "coop_app";
const APP_PASSWORD = "coop_app_test";

/** Derive the non-owner connection URL from the owner URL. */
function appUrlFrom(owner: string): string {
  const u = new URL(owner);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

vi.mock("../src/lib/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/messaging.js")>();
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue(true),
    notifyMember: vi.fn().mockResolvedValue(true),
    platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
    sendSecurePrompt: vi.fn().mockResolvedValue(true),
  };
});

describe.skipIf(!rlsEnabled)("Row-Level Security: cross-cooperative isolation at DB level", () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let coopA: { id: string; code: string };
  let coopB: { id: string; code: string };
  let memberA: { id: string; phone: string; cooperativeId: string };
  let memberB: { id: string; phone: string; cooperativeId: string };

  /** Run `fn` as the non-owner role inside a transaction scoped to `coopId`. */
  function asCoop<T>(coopId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_cooperative_id', ${coopId}, true)`;
      return fn(tx);
    });
  }

  /** Run `fn` as the non-owner role with NO tenant context (fail-closed). */
  function asNoContext<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return app.$transaction((tx) => fn(tx));
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    app = new PrismaClient({ datasources: { db: { url: appUrlFrom(ownerUrl) } } });

    // Provision the non-owner role + grants (idempotent).
    await owner.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
        ELSE
          ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}';
        END IF;
      END $$;
    `);
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public, app TO ${APP_ROLE}`);
    await owner.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await owner.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${APP_ROLE}`);

    // Defensive: remove leftovers from a previous run against a DB that wasn't
    // wiped (e.g. a local container). CI runs against a fresh database.
    const testPhones = ["2348010000001", "2348010000002"];
    await owner.wallet.deleteMany({ where: { member: { phone: { in: testPhones } } } });
    await owner.member.deleteMany({ where: { phone: { in: testPhones } } });

    coopA = await owner.cooperative.create({ data: { name: "Coop A", code: "COOPA" } });
    coopB = await owner.cooperative.create({ data: { name: "Coop B", code: "COOPB" } });

    memberA = await owner.member.create({
      data: {
        code: generateMemberCode(),
        phone: "2348010000001",
        name: "Member A",
        cooperativeId: coopA.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
      select: { id: true, phone: true, cooperativeId: true },
    });
    memberB = await owner.member.create({
      data: {
        code: generateMemberCode(),
        phone: "2348010000002",
        name: "Member B",
        cooperativeId: coopB.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
      select: { id: true, phone: true, cooperativeId: true },
    });
  });

  afterAll(async () => {
    if (owner && memberA && memberB && coopA && coopB) {
      await owner.member.deleteMany({ where: { id: { in: [memberA.id, memberB.id] } } });
      await owner.cooperative.deleteMany({ where: { id: { in: [coopA.id, coopB.id] } } });
    }
    if (owner) await owner.$disconnect();
    if (app) await app.$disconnect();
  });

  it("isolates Member reads", async () => {
    const a = await asCoop(coopA.id, (tx) =>
      tx.member.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);
    expect(a[0].id).toBe(memberA.id);

    const b = await asCoop(coopA.id, (tx) =>
      tx.member.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);
  });

  it("isolates Wallet reads (reached via the Member parent)", async () => {
    const a = await asCoop(coopA.id, (tx) => tx.wallet.findMany({ where: { memberId: memberA.id } }));
    expect(a.length).toBe(1);

    const b = await asCoop(coopA.id, (tx) => tx.wallet.findMany({ where: { memberId: memberB.id } }));
    expect(b.length).toBe(0);
  });

  it("isolates Loan reads", async () => {
    await owner.loan.create({
      data: {
        amount: 100000,
        interestRate: 5,
        tenureMonths: 3,
        status: "pending",
        balance: 100000,
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });
    await owner.loan.create({
      data: {
        amount: 200000,
        interestRate: 5,
        tenureMonths: 6,
        status: "pending",
        balance: 200000,
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const a = await asCoop(coopA.id, (tx) => tx.loan.findMany({ where: { cooperativeId: coopA.id } }));
    expect(a.length).toBe(1);
    expect(a[0].memberId).toBe(memberA.id);

    const b = await asCoop(coopA.id, (tx) => tx.loan.findMany({ where: { cooperativeId: coopB.id } }));
    expect(b.length).toBe(0);

    await owner.loan.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
  });

  it("isolates Payout reads", async () => {
    await owner.payout.create({
      data: {
        amount: 50000,
        reference: "TFR-TEST-A",
        idempotencyKey: "TFR-TEST-A",
        status: "successful",
        provider: "monnify",
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });
    await owner.payout.create({
      data: {
        amount: 50000,
        reference: "TFR-TEST-B",
        idempotencyKey: "TFR-TEST-B",
        status: "successful",
        provider: "monnify",
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const a = await asCoop(coopA.id, (tx) =>
      tx.payout.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);
    expect(a[0].memberId).toBe(memberA.id);

    const b = await asCoop(coopA.id, (tx) =>
      tx.payout.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);

    await owner.payout.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
  });

  it("isolates Contribution reads", async () => {
    await owner.contribution.create({
      data: {
        amount: 10000,
        type: "savings",
        status: "confirmed",
        reference: "CON-TEST-A",
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });
    await owner.contribution.create({
      data: {
        amount: 20000,
        type: "savings",
        status: "confirmed",
        reference: "CON-TEST-B",
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const a = await asCoop(coopA.id, (tx) =>
      tx.contribution.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);

    const b = await asCoop(coopA.id, (tx) =>
      tx.contribution.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);

    await owner.contribution.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
  });

  it("isolates WithdrawalRequest reads", async () => {
    await owner.withdrawalRequest.create({
      data: {
        amount: 10000,
        status: "pending",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: memberA.id,
        cooperativeId: coopA.id,
      },
    });
    await owner.withdrawalRequest.create({
      data: {
        amount: 20000,
        status: "pending",
        bankAccountNumber: "0987654321",
        bankCode: "044",
        memberId: memberB.id,
        cooperativeId: coopB.id,
      },
    });

    const a = await asCoop(coopA.id, (tx) =>
      tx.withdrawalRequest.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);

    const b = await asCoop(coopA.id, (tx) =>
      tx.withdrawalRequest.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);

    await owner.withdrawalRequest.deleteMany({
      where: { cooperativeId: { in: [coopA.id, coopB.id] } },
    });
  });

  it("isolates AuditLog reads", async () => {
    await owner.auditLog.create({
      data: {
        cooperativeId: coopA.id,
        actorPhone: memberA.phone,
        actorId: memberA.id,
        actorRole: "member",
        action: "test.action",
        detail: "test",
        seq: 1,
      },
    });
    await owner.auditLog.create({
      data: {
        cooperativeId: coopB.id,
        actorPhone: memberB.phone,
        actorId: memberB.id,
        actorRole: "member",
        action: "test.action",
        detail: "test",
        seq: 1,
      },
    });

    const a = await asCoop(coopA.id, (tx) =>
      tx.auditLog.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);

    const b = await asCoop(coopA.id, (tx) =>
      tx.auditLog.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);

    await owner.auditLog.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
  });

  it("isolates JournalEntry reads (and its Posting children)", async () => {
    await owner.journalEntry.create({
      data: {
        cooperativeId: coopA.id,
        txRef: "JE-TEST-A",
        description: "test",
        postings: {
          create: [
            { account: "assets:bank", direction: "DEBIT", amount: 10000 },
            { account: "income:test", direction: "CREDIT", amount: 10000 },
          ],
        },
      },
    });
    await owner.journalEntry.create({
      data: {
        cooperativeId: coopB.id,
        txRef: "JE-TEST-B",
        description: "test",
        postings: {
          create: [
            { account: "assets:bank", direction: "DEBIT", amount: 20000 },
            { account: "income:test", direction: "CREDIT", amount: 20000 },
          ],
        },
      },
    });

    const a = await asCoop(coopA.id, (tx) =>
      tx.journalEntry.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);

    const b = await asCoop(coopA.id, (tx) =>
      tx.journalEntry.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);

    // Posting has no cooperativeId; its policy reaches through JournalEntry.
    const postings = await asCoop(coopA.id, (tx) => tx.posting.findMany());
    expect(postings.length).toBe(2);

    await owner.journalEntry.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
  });

  it("isolates LedgerEntry reads", async () => {
    await owner.ledgerEntry.create({
      data: {
        cooperativeId: coopA.id,
        type: "income",
        category: "test",
        amount: 10000,
        note: "test",
        fundType: "operational",
      },
    });
    await owner.ledgerEntry.create({
      data: {
        cooperativeId: coopB.id,
        type: "income",
        category: "test",
        amount: 20000,
        note: "test",
        fundType: "operational",
      },
    });

    const a = await asCoop(coopA.id, (tx) =>
      tx.ledgerEntry.findMany({ where: { cooperativeId: coopA.id } }),
    );
    expect(a.length).toBe(1);

    const b = await asCoop(coopA.id, (tx) =>
      tx.ledgerEntry.findMany({ where: { cooperativeId: coopB.id } }),
    );
    expect(b.length).toBe(0);

    await owner.ledgerEntry.deleteMany({ where: { cooperativeId: { in: [coopA.id, coopB.id] } } });
  });

  it("fails closed when no tenant context is set (zero rows)", async () => {
    const members = await asNoContext((tx) => tx.member.findMany());
    expect(members.length).toBe(0);

    const wallets = await asNoContext((tx) => tx.wallet.findMany());
    expect(wallets.length).toBe(0);

    const loans = await asNoContext((tx) => tx.loan.findMany());
    expect(loans.length).toBe(0);
  });

  it("blocks cross-tenant writes via WITH CHECK", async () => {
    await expect(
      asCoop(coopA.id, (tx) =>
        tx.member.create({
          data: {
            code: generateMemberCode(),
            phone: "2348010000099",
            name: "Sneaky",
            cooperativeId: coopB.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("resolves a cooperative by phone via the SECURITY DEFINER resolver", async () => {
    // The resolver bypasses RLS by design, so it works with no GUC set — this
    // is what lets the app discover the tenant before it can set the context.
    const unique = await app.$queryRaw<{ coop: string | null }[]>`
      SELECT app.resolve_coop_by_phone(${memberA.phone}) AS coop
    `;
    expect(unique[0].coop).toBe(coopA.id);

    const unknown = await app.$queryRaw<{ coop: string | null }[]>`
      SELECT app.resolve_coop_by_phone('0000000000') AS coop
    `;
    expect(unknown[0].coop).toBeNull();
  });
});
