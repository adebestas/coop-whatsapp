import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_SECRET is not configured");
  return secret;
}

/**
 * Verify admin dashboard token (shared with admin.ts).
 * Returns the phone number if valid, null otherwise.
 *
 * NOTE: Must match the token format produced by admin.ts `sign()`:
 * `<base64url(JSON payload + iat)>.` + HMAC hex digest (2 parts). The iat
 * lives inside the JSON payload, not as a separate part.
 */
function verifyToken(token: string): string | null {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const secret = getSecret();
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.phone || Date.now() - data.iat > TOKEN_TTL_MS) return null;
    return data.phone;
  } catch {
    return null;
  }
}

/**
 * Serves generated export files (Excel/PDF). Requires admin authentication.
 */
export const serveExportFile = (app: FastifyInstance): void => {
  app.get("/api/export/:filename", async (req, reply) => {
    // ✅ Require admin authentication
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const token = verifyToken(auth.slice(7));
    if (!token) {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }

    const { filename } = req.params as { filename: string };
    // Strict allow-list: hex name + known extension only — no path traversal.
    if (!/^[a-f0-9]{8,32}\.(xlsx|pdf)$/.test(filename)) {
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
