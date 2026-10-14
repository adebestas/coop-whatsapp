/**
 * AI loan-intent extractor: turns a free-text loan request into structured
 * fields the loan flow can pre-fill. OFF unless GROQ_API_KEY is set. This is a
 * PURE EXTRACTION — it never creates a loan, a guarantor, or moves money. The
 * caller feeds the result into the normal, validated loan session flow.
 *
 * Example input:
 *   "i need a loan of 150k for 3 months, guarantors 08031234567 and ABC123-XYZ"
 * Output:
 *   { amountNaira: 150000, months: 3, guarantors: ["08031234567", "ABC123-XYZ"] }
 */

import { GROQ_URL, groqAvailable, groqModel, groqHeaders, GROQ_TIMEOUT_MS } from "./groq.js";

export interface LoanIntent {
  /** Requested principal in naira (null when the message didn't state one). */
  amountNaira: number | null;
  /** Tenure in months, 1–12 (null when absent or out of range). */
  months: number | null;
  /** Guarantor identifiers as written — phone number or member code. */
  guarantors: string[];
}

const MAX_GUARANTORS = 5;

const SYSTEM_PROMPT = `You extract loan-application details from a Nigerian cooperative member's WhatsApp message (English or Pidgin).
Reply with STRICT JSON only: {"loan":null} when the message is NOT a request to borrow money.
Otherwise reply {"loan":{"amount":<number|null>,"months":<number|null>,"guarantors":["<id>",...]}}.
Rules:
- amount is the requested principal in NAIRA as a plain number. "150k" means 150000, "1.5m" means 1500000, "₦150,000" means 150000. Use null if no amount is stated.
- months is the requested repayment tenure as an integer, 1-12. Use null if not stated.
- guarantors lists the people the member named, EXACTLY as written — a phone number (e.g. 08031234567) or a member code (e.g. ABC123-XYZ). Empty array if none.
- Do not invent values. Only extract what the message says.`;

/** Best-effort coercion of the model's amount field (number or numeric string). */
function coerceAmount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Best-effort coercion of the model's months field, clamped to the flow's 1–12. */
function coerceMonths(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * Keep only safe, unique guarantor identifiers. Identifiers are phone numbers
 * or member codes, so letters/digits/+/hyphen/space/dot are allowed — anything
 * with a newline, slash, or shell metacharacter is dropped outright.
 */
function sanitizeGuarantors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > 60) continue;
    if (!/^[A-Za-z0-9+\-. ]+$/.test(trimmed)) continue;
    const key = trimmed.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_GUARANTORS) break;
  }
  return out;
}

/**
 * Ask the LLM to extract loan details from free text. Returns null when the AI
 * is disabled, the request fails, the response is malformed, or the message is
 * not a loan request.
 */
export async function extractLoanRequest(text: string): Promise<LoanIntent | null> {
  if (!groqAvailable() || !text || text.length > 300) return null;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: groqHeaders(),
      body: JSON.stringify({
        model: groqModel(),
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content ?? "";
    let parsed: { loan?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      parsed = JSON.parse(jsonMatch[0]);
    }
    // Not a loan request, or a shape we don't recognise.
    if (!parsed.loan || typeof parsed.loan !== "object") return null;
    const loan = parsed.loan as Record<string, unknown>;
    return {
      amountNaira: coerceAmount(loan.amount),
      months: coerceMonths(loan.months),
      guarantors: sanitizeGuarantors(loan.guarantors),
    };
  } catch (err) {
    console.warn("[ai-loan] extractLoanRequest failed:", err);
    return null; // network error, timeout, bad JSON — silently fall back
  }
}
