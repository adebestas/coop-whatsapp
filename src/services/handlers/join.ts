import { prisma } from "../../lib/prisma.js";
import { sendText } from "../../lib/messaging.js";
import type { FlowData } from "../conversation.js";

/**
 * Start the onboarding flow for a NEW cooperative (SaaS self-serve).
 * This is separate from the member `join` flow.
 */
export async function handleOnboardStart(phone: string): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_onboard_name" },
    update: { state: "awaiting_onboard_name" },
  });
  await sendText({
    to: phone,
    text:
      "🏦 *Create Your Cooperative*\n\n" +
      "Let's set up your cooperative on Coop WhatsApp Bank.\n\n" +
      "What's your *cooperative name*? (e.g. *Lagos Workers Cooperative*)",
  });
}

export async function handleJoinStart(phone: string, args: string[]): Promise<void> {
  // Optional `ref <code>`: capture the referrer's member code so a referral can
  // be recorded once the member is created. Unknown/malformed codes are rejected
  // later (at record time) — the join itself always proceeds.
  const refIdx = args.findIndex((a) => a.toLowerCase() === "ref");
  const referrerCode = refIdx >= 0 ? args[refIdx + 1]?.toUpperCase() : undefined;
  if (args[0]) {
    const data = {
      joinCode: args[0].toUpperCase(),
      ...(referrerCode ? { referrerCode } : {}),
    };
    await prisma.session.upsert({
      where: { phone },
      create: {
        phone,
        state: "awaiting_name",
        data: JSON.stringify(data),
      },
      update: { state: "awaiting_name", data: JSON.stringify(data) },
    });
    await sendText({
      to: phone,
      text: `Great — joining cooperative *${args[0].toUpperCase()}*. What's your full name?`,
    });
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_coop_code" },
    // Reset any prior flow's data (e.g. a stale joinCode/referrerCode) so a
    // previous attempt cannot leak into this fresh "ask again" session.
    update: { state: "awaiting_coop_code", data: "{}" },
  });
  await sendText({
    to: phone,
    text: `Let's get you set up! 🏦\n\nWhat's your cooperative's code? (You can get this from your cooperative admin.)`,
  });
}

export async function askEmail(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_email", data: JSON.stringify({ ...data, name: data.name }) },
    update: { state: "awaiting_email", data: JSON.stringify({ ...data, name: data.name }) },
  });
  await sendText({
    to: phone,
    text: `Thanks, *${data.name}*! What's your email? *(optional)* We'll send your monthly statement there. Reply *skip* to skip.`,
  });
}

export async function askBirthday(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_birthday", data: JSON.stringify(data) },
    update: { state: "awaiting_birthday", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text: `Almost done — when's your birthday? *(optional, e.g. *15/08* — just day and month, no year needed)* Reply *skip* to skip.`,
  });
}

export async function askNokName(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_nok_name", data: JSON.stringify(data) },
    update: { state: "awaiting_nok_name", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text:
      `Last KYC step — who is your *next of kin*? (full name)\n\n` +
      `If anything happens to you, they're who the cooperative works with on your savings.`,
  });
}

/** Parse DD/MM (or DD-MM) into a date. Year is arbitrary — only month/day matter. */
export function parseBirthday(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(2000, month - 1, day);
  return date;
}
