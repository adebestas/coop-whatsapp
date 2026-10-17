/**
 * AI-written account-name mismatch alerts.
 *
 * When a member's bank account resolves to a name that doesn't match their
 * registered name, we call their attention to it before they confirm. The
 * message is AI-written when GROQ_API_KEY is set; otherwise a fixed fallback
 * is used. This is advisory only — the payout path re-verifies the name and
 * blocks on mismatch regardless.
 */

import { groqAvailable, groqModel, GROQ_TIMEOUT_MS, groqFetch } from "./groq.js";

/** Strip anything that could break out of the prompt or the message. */
function sanitize(value: string, maxLen = 60): string {
  return value
    .replace(/[<>\n\r]/g, " ")
    .trim()
    .slice(0, maxLen);
}

function fallback(memberName: string, accountName: string): string {
  return (
    `⚠️ *Heads up:* the name on this account (*${accountName}*) does not match your registered name (*${memberName}*).\n\n` +
    `If this isn't your account, reply *cancel* and re-enter your details. Reply *yes* to continue anyway.`
  );
}

/**
 * Generate a short, friendly warning that the resolved account name doesn't
 * match the member's registered name. Falls back to a fixed message when the
 * AI is disabled or the call fails.
 */
export async function accountMismatchWarning(
  memberName: string,
  accountName: string,
): Promise<string> {
  if (!groqAvailable()) return fallback(memberName, accountName);
  try {
    const res = await groqFetch(
      {
        model: groqModel(),
        temperature: 0.3,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              `You write short, friendly WhatsApp alerts for a Nigerian cooperative banking app. ` +
              `The member's bank account resolved to a name that does not match their registered name. ` +
              `Write a 2-3 sentence warning that calls their attention to the mismatch, shows both names, ` +
              `and tells them they can reply *yes* to continue anyway or *cancel* to re-enter their details. ` +
              `Never invent facts.`,
          },
          {
            role: "user",
            content: `registered name: ${sanitize(memberName)}\naccount name: ${sanitize(accountName)}`,
          },
        ],
      },
      GROQ_TIMEOUT_MS,
    );
    if (!res.ok) return fallback(memberName, accountName);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : fallback(memberName, accountName);
  } catch (err) {
    console.warn("[ai-notice] accountMismatchWarning failed:", err);
    return fallback(memberName, accountName);
  }
}
