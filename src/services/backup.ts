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
      journalEntries, postings, beneficiaries,
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
      prisma.journalEntry.findMany(),
      prisma.posting.findMany(),
      prisma.beneficiary.findMany(),
    ]);

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
