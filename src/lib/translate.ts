import { createHash } from "node:crypto";
import { groqAvailable, groqModel, groqFetch, GROQ_TIMEOUT_MS } from "./groq.js";
import type { Locale } from "./i18n.js";

// Values are PII-derived, so entries expire quickly and the map is process-local
// only. Keys are hashed (SEC-6) so raw member text is never used as a key.
const cache = new Map<string, { out: string; at: number }>();
const MAX_CACHE = 500;
const MAX_AGE_MS = 10 * 60 * 1000;

export async function translateToEnglish(text: string, locale: Locale): Promise<string> {
  if (locale === "en" || !text.trim() || !groqAvailable()) return text;
  const key = createHash("sha256").update(`${locale}\n${text}`).digest("hex");
  const hit = cache.get(key);
  if (hit !== undefined) {
    if (Date.now() - hit.at < MAX_AGE_MS) return hit.out;
    cache.delete(key);
  }
  try {
    const res = await groqFetch(
      {
        model: groqModel(),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Translate the user's message into English. Output ONLY the translation — no quotes, no commentary, no explanation.",
          },
          { role: "user", content: text },
        ],
      },
      GROQ_TIMEOUT_MS,
    );
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (out) {
      if (cache.size >= MAX_CACHE) {
        const now = Date.now();
        for (const [k, v] of cache) if (now - v.at >= MAX_AGE_MS) cache.delete(k);
        if (cache.size >= MAX_CACHE) cache.clear();
      }
      cache.set(key, { out, at: Date.now() });
      return out;
    }
  } catch (err) {
    console.warn("[translate] failed, using original text", err);
  }
  return text;
}
