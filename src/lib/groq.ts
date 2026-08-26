/**
 * Centralized Groq API client for AI features.
 * Used by ai.ts, ai-query.ts, and ai-support.ts.
 */

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export function groqAvailable(): boolean {
  return !!process.env.GROQ_API_KEY;
}

export function groqModel(): string {
  return process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

export function groqHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
  };
}

/** Default timeout for Groq requests (8 seconds). */
export const GROQ_TIMEOUT_MS = 8000;

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the Groq API with exponential backoff retry.
 * - Max 3 retries with delays of 1s, 2s, 4s.
 * - Retries on 5xx server errors, 429 rate limits, and network failures.
 * - Does NOT retry on other 4xx client errors.
 * - Validates response body for empty/malformed JSON.
 * - Logs token usage from responses.
 */
export async function groqFetch(
  body: Record<string, unknown>,
  timeoutMs: number = GROQ_TIMEOUT_MS,
): Promise<Response> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: groqHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      // 429 rate limit — retry with backoff (respecting Retry-After if present)
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const backoffMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.pow(2, attempt) * 1000;
        if (attempt < maxRetries) {
          await sleep(backoffMs);
          continue;
        }
        lastError = new Error(`HTTP 429 rate limited after ${maxRetries} retries`);
        return res;
      }

      // Success or non-retryable 4xx client error — return immediately
      if (res.ok || res.status < 500) return res;

      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000); // 1s, 2s, 4s
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[groq] Request attempt ${attempt + 1} failed:`, lastError.message);
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  throw lastError;
}

/**
 * Validate a Groq response body. Returns the parsed JSON or null if
 * the body is empty, malformed, or missing expected fields.
 */
export function validateGroqResponse(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.choices)) return null;
  return obj;
}

/**
 * Parse token usage from a Groq response and log it.
 * Returns total_tokens or 0 if unavailable.
 */
export function parseTokenUsage(body: unknown): number {
  const obj = body as Record<string, unknown> | null;
  const usage = obj?.usage as Record<string, unknown> | undefined;
  if (!usage) return 0;
  const total = Number(usage.total_tokens ?? 0);
  if (total > 0) {
    console.log(`[groq] tokens used: ${total} (prompt: ${usage.prompt_tokens ?? "?"}, completion: ${usage.completion_tokens ?? "?"})`);
  }
  return total;
}
