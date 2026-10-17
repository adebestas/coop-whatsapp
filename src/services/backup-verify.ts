import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { alertSupers, AlertSeverity } from "../lib/alerting.js";
import { BACKUP_DIR } from "./backup.js";

/**
 * Tables a backup must contain to be considered useful. `members`/`wallets`
 * empty is a hard failure; the rest must at least be present.
 */
const REQUIRED_TABLES = ["cooperatives", "members", "wallets"] as const;
const CRITICAL_NON_EMPTY = ["cooperatives", "members", "wallets"] as const;

export interface BackupFileVerifyResult {
  ok: boolean;
  file: string;
  exportedAt?: string;
  version?: number;
  tableCount: number;
  totalRows: number;
  emptyCriticalTables: string[];
  errors: string[];
  message: string;
}

/** Newest `coop-backup-*.json` in `dir`, or null if there is none. */
export async function findLatestBackup(dir: string): Promise<string | null> {
  try {
    const files = (await readdir(dir)).filter(
      (f) => f.startsWith("coop-backup-") && f.endsWith(".json"),
    );
    if (files.length === 0) return null;
    files.sort();
    return join(dir, files[files.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Verify a produced backup artifact by actually reading it: parse the JSON,
 * check the shape/version, confirm required tables are present, and report row
 * counts. This validates the DATE — a missing, truncated, or corrupt file fails.
 *
 * (A true restore-to-a-scratch-database drill is still the gold standard and
 * remains a documented TODO; it requires a second database.)
 */
export async function verifyBackupFile(filePath: string): Promise<BackupFileVerifyResult> {
  const errors: string[] = [];
  const base: Omit<BackupFileVerifyResult, "ok" | "errors" | "message"> = {
    file: filePath,
    tableCount: 0,
    totalRows: 0,
    emptyCriticalTables: [],
  };

  let parsed: { exportedAt?: string; version?: number; tables?: unknown };
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (err) {
    return {
      ...base,
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      message: "Backup file could not be read or parsed",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ...base,
      ok: false,
      errors: ["artifact is not a JSON object"],
      message: "Invalid backup",
    };
  }
  if (parsed.version !== 3) {
    errors.push(`unexpected backup version: ${String(parsed.version)}`);
  }

  const tables = parsed.tables;
  if (!tables || typeof tables !== "object") {
    return {
      ...base,
      ok: false,
      errors: [...errors, "missing tables object"],
      message: "Invalid backup",
    };
  }

  const tableObj = tables as Record<string, unknown>;
  const names = Object.keys(tableObj);
  let totalRows = 0;
  const emptyCriticalTables: string[] = [];

  for (const name of names) {
    const rows = tableObj[name];
    if (!Array.isArray(rows)) {
      errors.push(`table "${name}" is not an array`);
      continue;
    }
    totalRows += rows.length;
    if ((CRITICAL_NON_EMPTY as readonly string[]).includes(name) && rows.length === 0) {
      emptyCriticalTables.push(name);
    }
  }

  const missing = REQUIRED_TABLES.filter((t) => !names.includes(t));
  if (missing.length > 0) errors.push(`missing required tables: ${missing.join(", ")}`);
  if (emptyCriticalTables.length > 0) {
    errors.push(`critical tables are empty: ${emptyCriticalTables.join(", ")}`);
  }

  const ok = errors.length === 0;
  return {
    file: filePath,
    exportedAt: parsed.exportedAt,
    version: parsed.version,
    tableCount: names.length,
    totalRows,
    emptyCriticalTables,
    ok,
    errors,
    message: ok
      ? `Backup OK: ${names.length} tables, ${totalRows} rows`
      : `Backup invalid: ${errors.join("; ")}`,
  };
}

/**
 * Verify the most recent backup artifact. Called monthly by the scheduler.
 * Alerts super admins when the latest backup is missing or does not verify.
 */
export async function runBackupVerification(): Promise<BackupFileVerifyResult> {
  const file = await findLatestBackup(BACKUP_DIR);
  if (!file) {
    const result: BackupFileVerifyResult = {
      ok: false,
      file: "(none)",
      tableCount: 0,
      totalRows: 0,
      emptyCriticalTables: [],
      errors: [`no backup artifact found in ${BACKUP_DIR}`],
      message: `No backup found in ${BACKUP_DIR}`,
    };
    await alertSupers(
      "system",
      `❌ Backup verification failed: ${result.message}`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
    return result;
  }

  const result = await verifyBackupFile(file);
  if (!result.ok) {
    await alertSupers(
      "system",
      `❌ Backup verification failed for *${file}*\n\nErrors:\n${result.errors.join("\n")}`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
  } else {
    console.log(`[backup-verify] ${result.message}`);
  }
  return result;
}
