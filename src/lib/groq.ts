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
 * - Only retries on 5xx server errors or network failures.
 * - Does NOT retry on 4xx client errors.
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
      // Success or 4xx client error — return immediately (no retry)
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000); // 1s, 2s, 4s
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  throw lastError;
}
