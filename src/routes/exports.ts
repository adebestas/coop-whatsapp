import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { verifyAdminToken, isTokenRevoked, requireLiveAdmin } from "../lib/admin-auth.js";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";

/**
 * Serves generated export files (Excel/PDF). Requires an ACTIVE admin token:
 * signature + expiry + revocation are checked, then the caller's CURRENT
 * role/status are re-read live from the DB (fail-closed) so a demoted,
 * suspended, deceased, or deleted admin can never download files.
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

    const { filename } = req.params as { filename: string };
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
