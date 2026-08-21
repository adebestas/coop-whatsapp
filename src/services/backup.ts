import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../lib/prisma.js";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "backups";
const KEEP_BACKUPS = Number(process.env.BACKUP_KEEP ?? "14");

/**
 * Full JSON snapshot of every table — the data-loss safety net. Runs daily
 * (scheduler) and can be triggered manually. Old backups are pruned.
 */
export async function runBackup(): Promise<{ ok: boolean; message: string; file?: string }> {
  try {
    await mkdir(BACKUP_DIR, { recursive: true });

    const [
      cooperatives, units, members, wallets, contributions, loans, guarantors,
      loanRepayments, payouts, withdrawalRequests, deathClaims, deathValidations,
      auditLogs, supportTickets, votes, voteCandidates, voteBallots, dividends,
      dividendEntries, broadcasts, sessions, ledgerEntries, externalPayments,
      purchasePolls, pollOptions, pollBallots, guarantorDeductions,
    ] = await Promise.all([
      prisma.cooperative.findMany(),
      prisma.unit.findMany(),
      prisma.member.findMany(),
      prisma.wallet.findMany(),
      prisma.contribution.findMany(),
      prisma.loan.findMany(),
      prisma.guarantor.findMany(),
      prisma.loanRepayment.findMany(),
      prisma.payout.findMany(),
      prisma.withdrawalRequest.findMany(),
      prisma.deathClaim.findMany(),
      prisma.deathValidation.findMany(),
      prisma.auditLog.findMany(),
      prisma.supportTicket.findMany(),
      prisma.vote.findMany(),
      prisma.voteCandidate.findMany(),
      prisma.voteBallot.findMany(),
      prisma.dividend.findMany(),
      prisma.dividendEntry.findMany(),
      prisma.broadcast.findMany(),
      prisma.session.findMany(),
      prisma.ledgerEntry.findMany(),
      prisma.externalPayment.findMany(),
      prisma.purchasePoll.findMany(),
      prisma.pollOption.findMany(),
      prisma.pollBallot.findMany(),
      prisma.guarantorDeduction.findMany(),
    ]);

    const dump = {
      exportedAt: new Date().toISOString(),
      version: 1,
      tables: {
        cooperatives, units, members, wallets, contributions, loans, guarantors,
        loanRepayments, payouts, withdrawalRequests, deathClaims, deathValidations,
        auditLogs, supportTickets, votes, voteCandidates, voteBallots, dividends,
        dividendEntries, broadcasts, sessions, ledgerEntries, externalPayments,
        purchasePolls, pollOptions, pollBallots, guarantorDeductions,
      },
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `coop-backup-${stamp}.json`;
    await writeFile(join(BACKUP_DIR, file), JSON.stringify(dump), "utf8");

    await pruneOldBackups();

    return { ok: true, message: `Backup written: ${file}`, file };
  } catch (err: any) {
    console.error("[backup] failed:", err?.message ?? err);
    return { ok: false, message: `Backup failed: ${err?.message ?? err}` };
  }
}

async function pruneOldBackups() {
  if (!Number.isFinite(KEEP_BACKUPS) || KEEP_BACKUPS <= 0) return;
  const files = (await readdir(BACKUP_DIR)).filter((f) => f.startsWith("coop-backup-") && f.endsWith(".json"));
  files.sort();
  const excess = files.slice(0, Math.max(0, files.length - KEEP_BACKUPS));
  for (const f of excess) {
    await unlink(join(BACKUP_DIR, f)).catch(() => {});
  }
}
