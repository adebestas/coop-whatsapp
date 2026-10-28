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
    await handleJoinCode(phone, args[0], referrerCode ? { referrerCode } : {});
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

/**
 * Optional financial-literacy certification opt-in, asked after the member is
 * created (so we have a memberId to persist `MemberProgress.certificationOptIn`).
 * Skippable and never blocks registration.
 */
export async function askLiteracyOptIn(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_literacy_optin", data: JSON.stringify(data) },
    update: { state: "awaiting_literacy_optin", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text:
      "📘 *Optional:* join our free financial-literacy certification? " +
      "It takes ~10 minutes and unlocks a higher loan limit once you pass.\n\n" +
      "Reply *yes* to enroll or *skip*.",
  });
}

/**
 * Validate a cooperative code and, when usable, move the session to the name
 * step. Validation happens at entry so a typo or a re-registration is caught
 * before the member answers the whole KYC + PIN flow.
 *
 * Shared by the `join CODE` shortcut and the `awaiting_coop_code` state so both
 * paths behave identically and confirm the cooperative by NAME (not just the
 * code the member typed).
 */
export async function handleJoinCode(
  phone: string,
  rawCode: string,
  extra: FlowData = {},
): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  const coop = code ? await prisma.cooperative.findUnique({ where: { code } }) : null;

  if (!coop) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_coop_code", data: "{}" },
      update: { state: "awaiting_coop_code", data: "{}" },
    });
    await sendText({
      to: phone,
      text: code
        ? `We couldn't find a cooperative with code *${code}*. Double-check the code from your admin and reply again, or reply *cancel*.`
        : "Please reply with your cooperative's code (e.g. *LAGOS01*), or reply *cancel*.",
    });
    return;
  }

  if (coop.status !== "active") {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_coop_code", data: "{}" },
      update: { state: "awaiting_coop_code", data: "{}" },
    });
    await sendText({
      to: phone,
      text: `*${coop.name}* isn't accepting new members right now. Ask your admin to reactivate it, or reply *cancel*.`,
    });
    return;
  }

  const alreadyMember = await prisma.member.findUnique({
    where: { cooperativeId_phone: { cooperativeId: coop.id, phone } },
  });
  if (alreadyMember) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "idle" },
      update: { state: "idle", data: "{}" },
    });
    await sendText({
      to: phone,
      text: `You're already a member of *${coop.name}*. Reply *menu* to see what you can do.`,
    });
    return;
  }

  const data: FlowData = { joinCode: code, ...extra };
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_name", data: JSON.stringify(data) },
    update: { state: "awaiting_name", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text: `Great — joining *${coop.name}*. What's your full name?`,
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
