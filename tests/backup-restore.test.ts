import { beforeEach, describe, expect, it } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { runBackup } from "../src/services/backup.js";
import { createContribution } from "../src/services/cooperative.js";

const EXPECTED_TABLES = [
  "cooperatives",
  "units",
  "members",
  "wallets",
  "contributions",
  "loans",
  "guarantors",
  "loanRepayments",
  "payouts",
  "withdrawalRequests",
  "deathClaims",
  "deathValidations",
  "auditLogs",
  "supportTickets",
  "votes",
  "voteCandidates",
  "voteBallots",
  "dividends",
  "dividendEntries",
  "broadcasts",
  "sessions",
  "ledgerEntries",
  "externalPayments",
  "purchasePolls",
  "pollOptions",
  "pollBallots",
  "guarantorDeductions",
  "journalEntries",
  "postings",
  "beneficiaries",
];

beforeEach(async () => {
  await cleanupDatabase();
});

describe("backup restore smoke test", () => {
  it("writes a complete, round-trippable snapshot whose row counts match the live DB", async () => {
    // Seed one coop with real money rows so the snapshot is non-trivial.
    const coop = await prisma.cooperative.create({ data: { name: "Backup Coop", code: "BKUP01" } });
    const member = await prisma.member.create({
      data: {
        code: generateMemberCode(),
        phone: "2348012000001",
        name: "Backup Member",
        cooperativeId: coop.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
        consentAt: new Date(),
      },
    });
    await createContribution(member.phone, 500000); // ₦5,000 confirmed contribution

    const res = await runBackup();
    expect(res.ok).toBe(true);
    expect(res.file).toBeTruthy();

    // Read the snapshot back from disk — this is the "restore" half of the round trip.
    const raw = await readFile(join("backups", res.file!), "utf8");
    const snapshot = JSON.parse(raw) as { version: number; tables: Record<string, unknown[]> };

    expect(snapshot.version).toBe(2);

    // Every table must be present in the dump (no silent omissions).
    for (const table of EXPECTED_TABLES) {
      expect(snapshot.tables[table], `missing table "${table}"`).toBeInstanceOf(Array);
    }

    // Row counts in the snapshot must equal the live DB for the critical money tables.
    const liveMemberCount = await prisma.member.count();
    const liveWalletCount = await prisma.wallet.count();
    const liveContributionCount = await prisma.contribution.count();

    expect(snapshot.tables.members).toHaveLength(liveMemberCount);
    expect(snapshot.tables.wallets).toHaveLength(liveWalletCount);
    expect(snapshot.tables.contributions).toHaveLength(liveContributionCount);
    expect(snapshot.tables.contributions).toHaveLength(1);

    // The money row survived intact with its kobo amount.
    const contribution = snapshot.tables.contributions[0] as { amount: number };
    expect(contribution.amount).toBe(500000);

    // Clean up the backup artifact this test produced.
    await unlink(join("backups", res.file!)).catch(() => {});
  });
});
