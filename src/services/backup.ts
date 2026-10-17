import { mkdir, writeFile, readdir, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ownerPrisma } from "../lib/prisma.js";

export const BACKUP_DIR = process.env.BACKUP_DIR ?? "backups";
const KEEP_BACKUPS = Number(process.env.BACKUP_KEEP ?? "14");

// Rows per page when reading each table. The backup is COMPLETE — we cursor
// through every row — this only bounds peak memory / query size.
const BACKUP_BATCH_SIZE = Number(process.env.BACKUP_BATCH_SIZE ?? "1000");

// S3-compatible backup storage (required in production — see planBackupStorage).
const BACKUP_BUCKET = process.env.BACKUP_BUCKET ?? "";
const BACKUP_KEY = process.env.BACKUP_KEY ?? "";
const BACKUP_SECRET = process.env.BACKUP_SECRET ?? "";
const BACKUP_ENDPOINT = process.env.BACKUP_ENDPOINT ?? "";
const BACKUP_REGION = process.env.BACKUP_REGION ?? "eu-west-1";

function s3Configured(): boolean {
  return !!(BACKUP_BUCKET && BACKUP_KEY && BACKUP_SECRET);
}

/**
 * Where a backup may be stored. In production a local-disk-only backup is
 * useless (Render wipes the container on redeploy), so we FAIL CLOSED unless
 * off-instance storage is configured or the operator explicitly opts in.
 */
export type BackupStorageMode = "s3" | "local" | "error";

export function planBackupStorage(env: {
  nodeEnv?: string;
  s3Configured: boolean;
  allowLocal?: boolean;
}): { mode: BackupStorageMode; reason: string } {
  if (env.s3Configured) {
    return { mode: "s3", reason: "off-instance S3 storage is configured" };
  }
  if (env.nodeEnv !== "production") {
    return { mode: "local", reason: "non-production: local disk is acceptable" };
  }
  if (env.allowLocal) {
    return {
      mode: "local",
      reason: "BACKUP_ALLOW_LOCAL=1: local-only backup explicitly allowed in production",
    };
  }
  return {
    mode: "error",
    reason:
      "production requires off-instance storage (set BACKUP_BUCKET/BACKUP_KEY/BACKUP_SECRET, or BACKUP_ALLOW_LOCAL=1 to accept an ephemeral local-only backup)",
  };
}

interface BatchArgs {
  take: number;
  skip?: number;
  cursor?: { id: string };
  orderBy: { id: "asc" };
}
type BatchFetcher<T> = (args: BatchArgs) => Promise<T[]>;

/**
 * Read a whole table via keyset pagination on the primary key. Unlike the old
 * `findMany({ take: 50_000 })`, this never silently truncates: it keeps paging
 * until a short page proves the end, so the backup is complete.
 */
export async function fetchAllBatched<T extends { id: string }>(
  fetch: BatchFetcher<T>,
  batchSize = BACKUP_BATCH_SIZE,
): Promise<T[]> {
  const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 1000;
  const rows: T[] = [];
  let cursor: { id: string } | undefined;
  for (;;) {
    const page = await fetch({
      take: size,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    rows.push(...page);
    if (page.length < size) break;
    cursor = { id: page[page.length - 1].id };
  }
  return rows;
}

/**
 * Every table captured by the JSON snapshot, as [dumpKey, batch fetcher] pairs.
 * Declarative so the dump keys and queries cannot drift apart.
 */
const TABLE_FETCHERS: Array<[string, BatchFetcher<{ id: string }>]> = [
  ["cooperatives", (a) => ownerPrisma.cooperative.findMany(a)],
  ["units", (a) => ownerPrisma.unit.findMany(a)],
  ["members", (a) => ownerPrisma.member.findMany(a)],
  ["wallets", (a) => ownerPrisma.wallet.findMany(a)],
  ["contributions", (a) => ownerPrisma.contribution.findMany(a)],
  ["loans", (a) => ownerPrisma.loan.findMany(a)],
  ["guarantors", (a) => ownerPrisma.guarantor.findMany(a)],
  ["loanRepayments", (a) => ownerPrisma.loanRepayment.findMany(a)],
  ["payouts", (a) => ownerPrisma.payout.findMany(a)],
  ["withdrawalRequests", (a) => ownerPrisma.withdrawalRequest.findMany(a)],
  ["deathClaims", (a) => ownerPrisma.deathClaim.findMany(a)],
  ["deathValidations", (a) => ownerPrisma.deathValidation.findMany(a)],
  ["auditLogs", (a) => ownerPrisma.auditLog.findMany(a)],
  ["supportTickets", (a) => ownerPrisma.supportTicket.findMany(a)],
  ["votes", (a) => ownerPrisma.vote.findMany(a)],
  ["voteCandidates", (a) => ownerPrisma.voteCandidate.findMany(a)],
  ["voteBallots", (a) => ownerPrisma.voteBallot.findMany(a)],
  ["dividends", (a) => ownerPrisma.dividend.findMany(a)],
  ["dividendEntries", (a) => ownerPrisma.dividendEntry.findMany(a)],
  ["broadcasts", (a) => ownerPrisma.broadcast.findMany(a)],
  ["sessions", (a) => ownerPrisma.session.findMany(a)],
  ["ledgerEntries", (a) => ownerPrisma.ledgerEntry.findMany(a)],
  ["externalPayments", (a) => ownerPrisma.externalPayment.findMany(a)],
  ["purchasePolls", (a) => ownerPrisma.purchasePoll.findMany(a)],
  ["pollOptions", (a) => ownerPrisma.pollOption.findMany(a)],
  ["pollBallots", (a) => ownerPrisma.pollBallot.findMany(a)],
  ["guarantorDeductions", (a) => ownerPrisma.guarantorDeduction.findMany(a)],
  ["journalEntries", (a) => ownerPrisma.journalEntry.findMany(a)],
  ["postings", (a) => ownerPrisma.posting.findMany(a)],
  ["beneficiaries", (a) => ownerPrisma.beneficiary.findMany(a)],
];

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
      "PUT",
      `/${key}`,
      "",
      `host:${host}`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${date}`,
      "",
      "host;x-amz-content-sha256;x-amz-date",
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${BACKUP_REGION}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      date,
      credentialScope,
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
  } catch (err: unknown) {
    console.error("[backup] S3 upload error:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Full JSON snapshot of every table — the data-loss safety net. Runs daily
 * (scheduler) and can be triggered manually. Old backups are pruned.
 *
 * IMPORTANT: For production disaster recovery, prefer `pg_dump` — it preserves
 * indexes, constraints and sequences and is far faster on large databases:
 *   pg_dump $DATABASE_OWNER_URL > coop-$(date +%Y%m%d).sql
 * This JSON export is the secondary, portable safety net.
 */
export async function runBackup(): Promise<{ ok: boolean; message: string; file?: string }> {
  try {
    const plan = planBackupStorage({
      nodeEnv: process.env.NODE_ENV,
      s3Configured: s3Configured(),
      allowLocal: process.env.BACKUP_ALLOW_LOCAL === "1",
    });
    if (plan.mode === "error") {
      console.error(`[backup] refusing to run: ${plan.reason}`);
      return { ok: false, message: `Backup refused: ${plan.reason}` };
    }
    if (plan.mode === "local" && process.env.NODE_ENV === "production") {
      console.warn(`[backup] WARNING: ${plan.reason}`);
    }

    await mkdir(BACKUP_DIR, { recursive: true });

    const tables: Record<string, unknown[]> = {};
    let totalRows = 0;
    for (const [name, fetch] of TABLE_FETCHERS) {
      const rows = await fetchAllBatched(fetch);
      tables[name] = rows;
      totalRows += rows.length;
      if (rows.length >= 100_000) {
        console.warn(
          `[backup] table "${name}" has ${rows.length} rows — consider pg_dump for the primary DR path.`,
        );
      }
    }

    const dump = {
      exportedAt: new Date().toISOString(),
      version: 3,
      tables,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `coop-backup-${stamp}.json`;
    const localPath = join(BACKUP_DIR, file);
    await writeFile(localPath, JSON.stringify(dump), "utf8");
    console.log(
      `[backup] snapshot complete: ${Object.keys(tables).length} tables, ${totalRows} rows -> ${file}`,
    );

    if (plan.mode === "s3") {
      const uploaded = await uploadToS3(localPath, `backups/${file}`);
      if (!uploaded) {
        // Off-instance storage was required: do NOT report a local-only backup
        // as success — it would evaporate on the next redeploy.
        return { ok: false, message: `Backup failed: S3 upload of ${file} did not succeed` };
      }
      await pruneOldBackups();
      return { ok: true, message: `Backup written (S3): ${file}`, file };
    }

    await pruneOldBackups();
    return { ok: true, message: `Backup written (local): ${file}`, file };
  } catch (err: unknown) {
    console.error("[backup] failed:", err instanceof Error ? err.message : err);
    return { ok: false, message: `Backup failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function pruneOldBackups() {
  if (!Number.isFinite(KEEP_BACKUPS) || KEEP_BACKUPS <= 0) return;
  const files = (await readdir(BACKUP_DIR)).filter(
    (f) => f.startsWith("coop-backup-") && f.endsWith(".json"),
  );
  files.sort();
  const excess = files.slice(0, Math.max(0, files.length - KEEP_BACKUPS));
  for (const f of excess) {
    await unlink(join(BACKUP_DIR, f)).catch(() => {});
  }
}
