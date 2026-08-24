import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, isAllowed } from "../config.js";
import { handleMessage } from "../services/conversation.js";
import { extractWhatsAppMessages } from "../lib/inbound.js";

/**
 * Verify WhatsApp webhook signature (X-Hub-Signature-256).
 * Prevents attackers from injecting fake messages.
 */
function verifyWhatsAppSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature || !process.env.WHATSAPP_TOKEN) return false;
  const expected = createHmac("sha256", process.env.WHATSAPP_TOKEN).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

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
    const rawBody = (req as any).rawBody as string;
    const signature = req.headers["x-hub-signature-256"] as string;

    // Verify webhook signature — blocks fake messages from attackers
    if (!verifyWhatsAppSignature(rawBody, signature)) {
      app.log.warn("WhatsApp webhook signature verification failed");
      return reply.code(401).send({ error: "Invalid signature" });
    }

    // Only process messages, ignore status updates etc.
    const entries: any[] = body?.entry ?? [];
    for (const entry of entries) {
      const changes: any[] = entry.changes ?? [];
      for (const change of changes) {
        for (const inbound of extractWhatsAppMessages(change?.value)) {
          if (!isAllowed(inbound.from)) continue;

          // Don't await — Meta needs a quick 200 and we don't want a
          // slow upstream to cause retries. Errors are logged inside.
          void handleMessage(inbound.from, inbound.text, {
            flowToken: inbound.flowToken,
          }).catch((err) => {
            app.log.error({ err, from: inbound.from }, "handleMessage failed");
          });
        }
      }
    }

    return reply.code(200).send({ status: "received" });
  });
}