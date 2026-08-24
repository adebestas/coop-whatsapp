/**
 * Database reset script.
 * Usage: npx tsx src/scripts/db-reset.ts [--confirm]
 *
 * WARNING: This will DELETE ALL DATA!
 */
import { prisma } from "../lib/prisma.js";

async function reset() {
  const confirm = process.argv.includes("--confirm");

  if (!confirm) {
    console.log("⚠️  WARNING: This will delete ALL data in the database!");
    console.log("Run with --confirm to proceed:");
    console.log("  npx tsx src/scripts/db-reset.ts --confirm");
    process.exit(1);
  }

  console.log("🗑️  Resetting database...");

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
      console.log(`  ✅ Cleared ${table}`);
    } catch (err: any) {
      // Table might not exist yet
      if (!err.message?.includes("does not exist")) {
        console.error(`  ❌ Failed to clear ${table}:`, err.message);
      }
    }
  }

  console.log("\n🎉 Database reset complete!");
  console.log("Run 'npx tsx src/scripts/seed-test.ts' to seed test data.");
}

reset()
  .catch((err) => {
    console.error("❌ Reset failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
