import type { FastifyInstance } from "fastify";
import { config, isAllowed } from "../config.js";
import { handleMessage } from "../services/conversation.js";

export async function webhookRoutes(app: FastifyInstance) {
  // ---- GET: Meta verifies your webhook URL ----
  app.get("/webhook", async (req, reply) => {
    const { query } = req as { query: Record<string, string> };
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
      return reply.type("text/plain").send(challenge);
    }
    return reply.code(403).send("Verification failed");
  });

  // ---- POST: Meta delivers incoming messages ----
  app.post("/webhook", async (req, reply) => {
    const body = req.body as any;

    // Only process messages, ignore status updates etc.
    const entries: any[] = body?.entry ?? [];
    for (const entry of entries) {
      const changes: any[] = entry.changes ?? [];
      for (const change of changes) {
        const messages: any[] = change?.value?.messages ?? [];
        for (const message of messages) {
          if (message.type !== "text") continue;
          const from = message.from as string;
          if (!isAllowed(from)) continue;
          const text = message.text?.body as string;
          if (!text) continue;

          // Don't await — Meta needs a quick 200 and we don't want a
          // slow upstream to cause retries. Errors are logged inside.
          void handleMessage(from, text).catch((err) => {
            app.log.error({ err, from }, "handleMessage failed");
          });
        }
      }
    }

    return reply.code(200).send({ status: "received" });
  });
}