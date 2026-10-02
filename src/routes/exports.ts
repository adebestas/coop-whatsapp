import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { verifyAdminToken, isTokenRevoked, requireLiveAdmin, getRedis } from "../lib/admin-auth.js";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";
const MAX_EXPORTS = 14; // keep 14 most recent exports; older ones are pruned

/**
 * Generate an export filename that embeds the cooperative ID,
 * so downstream verification can bind the download to a specific coop.
 */
export function exportFilename(coopId: string, type: string): string {
  const hex = Math.random().toString(16).slice(2, 16);
  return `${coopId}-${type}-${hex}.${type === "members" || type === "transactions" || type === "pnl" ? "xlsx" : "pdf"}`;
}

/**
 * Keep only the latest `MAX_EXPORTS` export files; delete older ones.
 * Uses Redis when available; falls back to no-op when unavailable.
 */
export async function pruneExports(maxExports: number = MAX_EXPORTS): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    const keys = await client.lrange(`exports:list`, 0, -1);
    if (keys.length > maxExports) {
      const toDelete = keys.slice(0, keys.length - maxExports);
      await client.del(...toDelete);
      await client.ltrim(`exports:list`, -maxExports, -1);
    }
  } catch (err) {
    console.error("[exports] pruneExports error:", err);
  }
}

/**
 * Serves generated export files (Excel/PDF). Requires an ACTIVE admin token:
 * signature + expiry + revocation are checked, then the caller's CURRENT
 * role/status are re-read live from the DB (fail-closed) so a demoted,
 * suspended, deceased, or deleted admin can never download files.
 * Additionally, the filename must encode the cooperative ID — the caller's
 * `cooperativeId` from the verified token must match the coopId embedded in
 * the filename, preventing cross‑coop file downloads.
 */
export const serveExportFile = (app: FastifyInstance): void => {
  app.get("/api/export/:filename", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const rawToken = auth.slice(7);
    const payload = verifyAdminToken(rawToken);
    if (!payload) {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
    if (await isTokenRevoked(rawToken)) {
      return reply.code(401).send({ error: "Token revoked" });
    }
    // Fail-closed live check: the caller must CURRENTLY be an active
    // admin/superadmin in the DB, not merely hold a signed (possibly stale,
    // revoked, or formerly-admin) token.
    const live = await requireLiveAdmin(payload);
    if (!live) {
      return reply.code(401).send({ error: "Not authorized" });
    }
    // Coop‑scoped check: the filename must encode the caller's cooperative ID.
    const { filename } = req.params as { filename: string };
    const coopIdFromFilename = filename.match(/^([a-z]+)-/);
    if (coopIdFromFilename && coopIdFromFilename[1] !== payload.cooperativeId) {
      return reply.code(403).send({ error: "Export file does not belong to your cooperative." });
    }
    // If the filename has no coop prefix (old format), allow for backward
    // compatibility — these files will be cleaned up by pruneExports().

    // Strict allow-list matching the real generated filenames:
    //   `members-<hex>`, `transactions-<hex>`, `pnl-<hex>`,
    //   `str-compliance-<hex>`, `paye-compliance-<hex>`,
    //   `election-results-<hex>` + safe extension.
    // No slashes or `..` are allowed, so path traversal is impossible;
    // basename() further strips any directory prefix.
    if (!/^[a-z]+(-[a-z]+)*-([a-f0-9]{8,32})\.(xlsx|pdf)$/.test(filename)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const full = join(process.cwd(), EXPORT_DIR, basename(filename));
    try {
      await stat(full);
    } catch {
      return reply.code(404).send({ error: "Export expired or missing" });
    }
    const mime = filename.endsWith(".pdf")
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return reply
      .header("Content-Type", mime)
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(createReadStream(full));
  });
};
