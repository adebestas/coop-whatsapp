import { createHash } from "node:crypto";
import { groqAvailable, groqModel, groqFetch, GROQ_TIMEOUT_MS } from "./groq.js";
import type { Locale } from "./i18n.js";

const cache = new Map<string, string>();
const MAX_CACHE = 500;

/**
 * Translate a member's message into English so the deterministic command parser
 * can understand it. Returns the text unchanged for English, blank input, or
 * when Groq is unavailable. Fail-open: any error returns the original text.
 */
export async function translateToEnglish(text: string, locale: Locale): Promise<string> {
  if (locale === "en" || !text.trim() || !groqAvailable()) return text;
  // Hash the key so the raw member text (possible PII) is never held as a cache
  // key (and can never appear in a heap dump / log keyed by it). SEC-6.
  const key = createHash("sha256").update(`${locale}\n${text}`).digest("hex");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
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
      if (cache.size >= MAX_CACHE) cache.clear();
      cache.set(key, out);
      return out;
    }
  } catch (err) {
    console.warn("[translate] failed, using original text", err);
  }
  return text;
}
