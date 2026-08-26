import { mkdir, writeFile, readdir, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../lib/prisma.js";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "backups";
const KEEP_BACKUPS = Number(process.env.BACKUP_KEEP ?? "14");

// S3-compatible backup storage (optional — fallback to local if not configured)
const BACKUP_BUCKET = process.env.BACKUP_BUCKET ?? "";
const BACKUP_KEY = process.env.BACKUP_KEY ?? "";
const BACKUP_SECRET = process.env.BACKUP_SECRET ?? "";
const BACKUP_ENDPOINT = process.env.BACKUP_ENDPOINT ?? "";
const BACKUP_REGION = process.env.BACKUP_REGION ?? "eu-west-1";

function s3Configured(): boolean {
  return !!(BACKUP_BUCKET && BACKUP_KEY && BACKUP_SECRET);
}

/**
 * Upload a file to S3-compatible storage using the AWS Signature V4 presigned
 * PUT approach. This avoids pulling in the full AWS SDK.
 */
async function uploadToS3(filePath: string, key: string): Promise<boolean> {
  if (!s3Configured()) return false;
  try {
    const { createHash, createHmac } = await import("node:crypto");
    const fileContent = await readFile(filePath);
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = date.slice(0, 8);
    const host = `${BACKUP_BUCKET}.s3.${BACKUP_REGION}.amazonaws.com`;
    const endpoint = BACKUP_ENDPOINT
      ? `${BACKUP_ENDPOINT}/${BACKUP_BUCKET}/${key}`
      : `https://${host}/${key}`;

    const payloadHash = createHash("sha256").update(fileContent).digest("hex");
    const canonicalRequest = [
      "PUT", `/${key}`, "", `host:${host}`, `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${date}`, "", "host;x-amz-content-sha256;x-amz-date", payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${BACKUP_REGION}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256", date, credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const hmac = (key: Buffer | string, data: string) =>
      createHmac("sha256", key).update(data).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${BACKUP_SECRET}`, dateStamp), BACKUP_REGION), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authHeader = `AWS4-HMAC-SHA256 Credential=${BACKUP_KEY}/${credentialScope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

    const res = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Host: host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": date,
        Authorization: authHeader,
      },
      body: fileContent,
    });
    if (!res.ok) {
      console.error(`[backup] S3 upload failed (${res.status}): ${await res.text()}`);
      return false;
    }
    console.log(`[backup] uploaded to s3://${BACKUP_BUCKET}/${key}`);
    return true;
  } catch (err: any) {
    console.error("[backup] S3 upload error:", err?.message ?? err);
    return false;
  }
}

/**
 * Full JSON snapshot of every table — the data-loss safety net. Runs daily
 * (scheduler) and can be triggered manually. Old backups are pruned.
 *
 * IMPORTANT: For production disaster recovery, use `pg_dump` directly instead
 * of this JSON export. pg_dump preserves indexes, constraints, sequences,
 * and is much faster for large databases. Example:
 *   pg_dump $DATABASE_URL > coop-$(date +%Y%m%d).sql
 */
const BACKUP_ROW_LIMIT = 50_000;
const BACKUP_WARN_THRESHOLD = 10_000;

async function fetchWithWarning<T>(
  findManyFn: () => Promise<T[]>,
  tableName: string,
): Promise<T[]> {
  const rows = await findManyFn();
  if (rows.length >= BACKUP_WARN_THRESHOLD) {
    console.warn(`[backup] WARNING: ${tableName} has ${rows.length} rows (limit: ${BACKUP_ROW_LIMIT}). Consider using pg_dump for large tables.`);
  }
  return rows;
}
export async function runBackup(): Promise<{ ok: boolean; message: string; file?: string }> {
  try {
    await mkdir(BACKUP_DIR, { recursive: true });

    const [
      cooperatives, units, members, wallets, contributions, loans, guarantors,
      loanRepayments, payouts, withdrawalRequests, deathClaims, deathValidations,
      auditLogs, supportTickets, votes, voteCandidates, voteBallots, dividends,
      dividendEntries, broadcasts, sessions, ledgerEntries, externalPayments,
      purchasePolls, pollOptions, pollBallots, guarantorDeductions,
      journalEntries, postings, beneficiaries,
    ] = await Promise.all([
      fetchWithWarning(() => prisma.cooperative.findMany({ take: BACKUP_ROW_LIMIT }), "cooperatives"),
      fetchWithWarning(() => prisma.unit.findMany({ take: BACKUP_ROW_LIMIT }), "units"),
      fetchWithWarning(() => prisma.member.findMany({ take: BACKUP_ROW_LIMIT }), "members"),
      fetchWithWarning(() => prisma.wallet.findMany({ take: BACKUP_ROW_LIMIT }), "wallets"),
      fetchWithWarning(() => prisma.contribution.findMany({ take: BACKUP_ROW_LIMIT }), "contributions"),
      fetchWithWarning(() => prisma.loan.findMany({ take: BACKUP_ROW_LIMIT }), "loans"),
      fetchWithWarning(() => prisma.guarantor.findMany({ take: BACKUP_ROW_LIMIT }), "guarantors"),
      fetchWithWarning(() => prisma.loanRepayment.findMany({ take: BACKUP_ROW_LIMIT }), "loanRepayments"),
      fetchWithWarning(() => prisma.payout.findMany({ take: BACKUP_ROW_LIMIT }), "payouts"),
      fetchWithWarning(() => prisma.withdrawalRequest.findMany({ take: BACKUP_ROW_LIMIT }), "withdrawalRequests"),
      fetchWithWarning(() => prisma.deathClaim.findMany({ take: BACKUP_ROW_LIMIT }), "deathClaims"),
      fetchWithWarning(() => prisma.deathValidation.findMany({ take: BACKUP_ROW_LIMIT }), "deathValidations"),
      fetchWithWarning(() => prisma.auditLog.findMany({ take: BACKUP_ROW_LIMIT }), "auditLogs"),
      fetchWithWarning(() => prisma.supportTicket.findMany({ take: BACKUP_ROW_LIMIT }), "supportTickets"),
      fetchWithWarning(() => prisma.vote.findMany({ take: BACKUP_ROW_LIMIT }), "votes"),
      fetchWithWarning(() => prisma.voteCandidate.findMany({ take: BACKUP_ROW_LIMIT }), "voteCandidates"),
      fetchWithWarning(() => prisma.voteBallot.findMany({ take: BACKUP_ROW_LIMIT }), "voteBallots"),
      fetchWithWarning(() => prisma.dividend.findMany({ take: BACKUP_ROW_LIMIT }), "dividends"),
      fetchWithWarning(() => prisma.dividendEntry.findMany({ take: BACKUP_ROW_LIMIT }), "dividendEntries"),
      fetchWithWarning(() => prisma.broadcast.findMany({ take: BACKUP_ROW_LIMIT }), "broadcasts"),
      fetchWithWarning(() => prisma.session.findMany({ take: BACKUP_ROW_LIMIT }), "sessions"),
      fetchWithWarning(() => prisma.ledgerEntry.findMany({ take: BACKUP_ROW_LIMIT }), "ledgerEntries"),
      fetchWithWarning(() => prisma.externalPayment.findMany({ take: BACKUP_ROW_LIMIT }), "externalPayments"),
      fetchWithWarning(() => prisma.purchasePoll.findMany({ take: BACKUP_ROW_LIMIT }), "purchasePolls"),
      fetchWithWarning(() => prisma.pollOption.findMany({ take: BACKUP_ROW_LIMIT }), "pollOptions"),
      fetchWithWarning(() => prisma.pollBallot.findMany({ take: BACKUP_ROW_LIMIT }), "pollBallots"),
      fetchWithWarning(() => prisma.guarantorDeduction.findMany({ take: BACKUP_ROW_LIMIT }), "guarantorDeductions"),
      fetchWithWarning(() => prisma.journalEntry.findMany({ take: BACKUP_ROW_LIMIT }), "journalEntries"),
      fetchWithWarning(() => prisma.posting.findMany({ take: BACKUP_ROW_LIMIT }), "postings"),
      fetchWithWarning(() => prisma.beneficiary.findMany({ take: BACKUP_ROW_LIMIT }), "beneficiaries"),
    ]);

    // Warn when any table was truncated at the 10K limit
    const tableNames = [
      "cooperatives", "units", "members", "wallets", "contributions", "loans", "guarantors",
      "loanRepayments", "payouts", "withdrawalRequests", "deathClaims", "deathValidations",
      "auditLogs", "supportTickets", "votes", "voteCandidates", "voteBallots", "dividends",
      "dividendEntries", "broadcasts", "sessions", "ledgerEntries", "externalPayments",
      "purchasePolls", "pollOptions", "pollBallots", "guarantorDeductions",
      "journalEntries", "postings", "beneficiaries",
    ];
    const allResults = [
      cooperatives, units, members, wallets, contributions, loans, guarantors,
      loanRepayments, payouts, withdrawalRequests, deathClaims, deathValidations,
      auditLogs, supportTickets, votes, voteCandidates, voteBallots, dividends,
      dividendEntries, broadcasts, sessions, ledgerEntries, externalPayments,
      purchasePolls, pollOptions, pollBallots, guarantorDeductions,
      journalEntries, postings, beneficiaries,
    ];
    for (let i = 0; i < allResults.length; i++) {
      if (allResults[i].length >= BACKUP_WARN_THRESHOLD) {
        console.warn(`[backup] WARNING: table "${tableNames[i]}" has >= ${BACKUP_WARN_THRESHOLD} rows — backup may be truncated. Use pg_dump for full backups.`);
      }
    }

    const dump = {
      exportedAt: new Date().toISOString(),
      version: 2,
      tables: {
        cooperatives, units, members, wallets, contributions, loans, guarantors,
        loanRepayments, payouts, withdrawalRequests, deathClaims, deathValidations,
        auditLogs, supportTickets, votes, voteCandidates, voteBallots, dividends,
        dividendEntries, broadcasts, sessions, ledgerEntries, externalPayments,
        purchasePolls, pollOptions, pollBallots, guarantorDeductions,
        journalEntries, postings, beneficiaries,
      },
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `coop-backup-${stamp}.json`;
    const localPath = join(BACKUP_DIR, file);
    await writeFile(localPath, JSON.stringify(dump), "utf8");

    // Upload to S3 if configured, otherwise keep local only
    let uploaded = false;
    if (s3Configured()) {
      uploaded = await uploadToS3(localPath, `backups/${file}`);
    }

    await pruneOldBackups();

    const storage = uploaded ? "S3" : "local";
    return { ok: true, message: `Backup written (${storage}): ${file}`, file };
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
