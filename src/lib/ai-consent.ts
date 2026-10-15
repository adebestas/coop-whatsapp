import { prisma } from "./prisma.js";

/**
 * AI-processing consent (NDPR).
 *
 * Voice-note transcription and non-English translation both send the member's
 * content to a third-party LLM (Groq). That is a distinct purpose from the
 * "receive messages" consent, so it requires its own recorded consent before
 * any content leaves WhatsApp. This module is the single gate for that.
 */

/** Consent state for a member: granted, explicitly declined, or never asked. */
export type AiConsentState = "granted" | "declined" | "unset";

type MemberForConsent = { id: string; aiConsentAt?: Date | null } | null | undefined;

/** Fast path: the member row already carries `aiConsentAt`. */
export function hasAiConsent(member: MemberForConsent): boolean {
  return !!member?.aiConsentAt;
}

/**
 * Resolve the member's AI-processing consent, distinguishing "never asked"
 * (so we prompt) from "explicitly declined" (so we do NOT re-prompt — instead
 * we tell them the feature is off). Reads the durable `DataConsent` log only
 * when the fast path is a miss.
 */
export async function getAiConsentState(member: MemberForConsent): Promise<AiConsentState> {
  if (!member) return "unset";
  if (member.aiConsentAt) return "granted";
  const latest = await prisma.dataConsent.findFirst({
    where: { memberId: member.id, consentType: "ai_processing" },
    orderBy: { createdAt: "desc" },
    select: { granted: true },
  });
  if (!latest) return "unset";
  return latest.granted ? "granted" : "declined";
}
