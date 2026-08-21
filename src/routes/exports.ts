import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";

/**
 * Serves generated export files (Excel/PDF). The filename itself is an
 * unguessable random token — whoever holds the link can download it.
 */
export const serveExportFile = (app: FastifyInstance): void => {
  app.get("/api/export/:filename", async (req, reply) => {
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
