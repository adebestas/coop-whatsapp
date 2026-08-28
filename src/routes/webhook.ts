import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, isAllowed } from "../config.js";
import { handleMessage } from "../services/conversation.js";
import { extractWhatsAppMessages } from "../lib/inbound.js";
import { sendText } from "../lib/messaging.js";
import { transcribeAudioMessage, transcriptionEnabled } from "../lib/transcribe.js";

/**
 * Per-user mutex to serialize message processing per phone number.
 * Prevents race conditions where two messages from the same user
 * are processed concurrently and cause inconsistent state (e.g. double spend).
 */
const userMutexes = new Map<string, Promise<void>>();

async function withUserMutex<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any in-flight processing for this user to finish
  const prev = userMutexes.get(phone);
  if (prev) await prev.catch(() => {});

  let release: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  userMutexes.set(phone, current);

  try {
    return await fn();
  } finally {
    release!();
    // Clean up if this is still the latest mutex
    if (userMutexes.get(phone) === current) {
      userMutexes.delete(phone);
    }
  }
}

/**
 * Verify WhatsApp webhook signature (X-Hub-Signature-256).
 * Prevents attackers from injecting fake messages.
 */
function verifyWhatsAppSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature || !process.env.WHATSAPP_TOKEN) return false;
  // Meta sends "sha256=<hex>"; strip the scheme prefix before comparing the
  // raw hex digest (otherwise timingSafeEqual throws on a length mismatch).
  const hex = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  const expected = createHmac("sha256", process.env.WHATSAPP_TOKEN).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(hex));
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

          // Voice notes are transcribed first (fail-closed: if transcription
          // is unavailable, the audio is dropped rather than crashing ingest).
          if (inbound.audio) {
            if (!transcriptionEnabled()) continue;
            const transcript = await transcribeAudioMessage(inbound.audio.mediaId);
            if (!transcript) {
              sendText({
                to: inbound.from,
                text: "I couldn't read that voice note. Please type your message instead.",
              }).catch(() => {});
              continue;
            }
            inbound.text = transcript;
          }

          // Don't await — Meta needs a quick 200 and we don't want a
          // slow upstream to cause retries. But catch errors so the
          // user gets a fallback message instead of silent failure.
          // Per-user mutex serializes processing to prevent race conditions.
          void withUserMutex(inbound.from, () =>
            handleMessage(inbound.from, inbound.text, {
              flowToken: inbound.flowToken,
              ip: req.ip,
            }),
          ).catch((err) => {
            app.log.error({ err, from: inbound.from }, "handleMessage failed");
            sendText({
              to: inbound.from,
              text: "Sorry, something went wrong processing your message. Please try again.",
            }).catch(() => {});
          });
        }
      }
    }

    reply.header("X-Content-Type-Options", "nosniff");
    return reply.code(200).send({ status: "received" });
  });
}