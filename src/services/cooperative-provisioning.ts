import { randomInt } from "node:crypto";
import { prisma, withTx } from "../lib/prisma.js";
import { hashPin } from "../lib/security.js";
import { sendText } from "../lib/messaging.js";
import { withCoopContext } from "../lib/tenant-context.js";
import { createCooperative, generateMemberFileNumber } from "./cooperative.js";

export interface ProvisionCooperativeInput {
  name: string;
  code: string;
  state?: string;
  country?: string;
  adminPhone: string;
  adminName?: string;
  /**
   * The channel the creator is on (the inbound session phone, e.g. `tg:<chatId>`).
   * Used for the super-admin `Member.phone` and the welcome recipient. Defaults to
   * `adminPhone` when the creator and the admin share one number.
   */
  sessionPhone?: string;
  /** Optional CAC/CAMA registration number captured at creation time. */
  registrationNumber?: string;
}

export interface ProvisionCooperativeResult {
  cooperativeId: string;
  code: string;
  adminMemberId: string;
  tempPin: string;
}

export interface AddCoopAdminInput {
  phone: string;
  name?: string;
  role: "admin" | "superadmin";
}

export interface AddCoopAdminResult {
  memberId: string;
  created: boolean;
  tempPin?: string;
}

/** Inclusive-lower, exclusive-upper 4-digit temp PIN, matching the chat onboarding. */
function generateTempPin(): string {
  return String(randomInt(1000, 9000));
}

/**
 * Provision a brand-new cooperative: the `Cooperative` row plus its default
 * config, branding and subscription, and the first `superadmin` member (wallet +
 * random 4-digit temp PIN). Sends the WhatsApp welcome to the admin phone.
 *
 * Extracted verbatim from the chat onboarding flow so the developer console and
 * the chat flow share one code path.
 */
export async function provisionCooperative(
  input: ProvisionCooperativeInput,
): Promise<ProvisionCooperativeResult> {
  const sessionPhone = input.sessionPhone ?? input.adminPhone;

  // All-or-nothing: a failure halfway through must not leave a cooperative
  // without config/branding/subscription or without its first superadmin.
  const { coop, adminMemberId, memberCode, tempPin } = await withTx(async () => {
    const coop = await createCooperative({
      name: input.name,
      code: input.code,
      adminPhone: input.adminPhone,
      state: input.state,
      country: input.country,
      registrationNumber: input.registrationNumber,
    });

    const created = await withCoopContext(coop.id, async () => {
      await prisma.cooperativeConfig.create({ data: { cooperativeId: coop.id } });
      await prisma.brandingConfig.create({
        data: { cooperativeId: coop.id, displayName: input.name },
      });
      await prisma.subscription.create({ data: { cooperativeId: coop.id } });

      const code = await generateMemberFileNumber(coop.id, coop.code);
      const pin = generateTempPin();

      // NOTE: Admin PIN is sent in plaintext over WhatsApp.
      // This is acceptable due to WhatsApp's end-to-end encryption, but the admin
      // should change their PIN immediately after onboarding (setpin command).
      const member = await prisma.member.create({
        data: {
          phone: sessionPhone,
          contactPhone: input.adminPhone,
          name: input.adminName ?? `${input.name} Admin`,
          code,
          pin: hashPin(pin),
          cooperativeId: coop.id,
          role: "superadmin",
          nameVerified: true,
          wallet: { create: {} },
        },
      });

      return { adminMemberId: member.id, memberCode: code, tempPin: pin };
    });

    return { coop, ...created };
  });

  // Best-effort delivery AFTER the commit: the cooperative exists even if the
  // messaging channel is down, and the console can resend the PIN.
  try {
    await sendText({
      to: sessionPhone,
      text:
        `🏦 *${input.name}* is live!\n\n` +
        `Your cooperative code: *${coop.code}*\n` +
        `Your role: *superadmin*\n` +
        `Your member code: *${memberCode}*\n` +
        `Your temporary PIN: *${tempPin}*\n\n` +
        `⚠️ *Change your PIN immediately* by replying: *setpin ${tempPin} <new pin>*\n\n` +
        `Members can join by sending: *join ${coop.code}*\n\n` +
        `Reply *menu* to see all admin commands.`,
    });
  } catch (err) {
    console.error(`[provision] welcome message failed for coop ${coop.id}`, err);
  }

  return {
    cooperativeId: coop.id,
    code: coop.code,
    adminMemberId,
    tempPin,
  };
}

/**
 * Add or promote a coop admin. If a member already exists for the phone in the
 * cooperative, only their role is updated; otherwise a new member is created
 * with a wallet and a random 4-digit temp PIN. The PIN is never persisted in
 * plaintext and only leaves via the return value (for the caller to message).
 */
export async function addCoopAdmin(
  coopId: string,
  input: AddCoopAdminInput,
): Promise<AddCoopAdminResult> {
  return withCoopContext(coopId, async () => {
    const existing = await prisma.member.findFirst({
      where: { cooperativeId: coopId, phone: input.phone },
    });
    if (existing) {
      await prisma.member.update({
        where: { id: existing.id },
        data: { role: input.role },
      });
      return { memberId: existing.id, created: false };
    }

    const coop = await prisma.cooperative.findUnique({
      where: { id: coopId },
      select: { code: true },
    });
    const code = await generateMemberFileNumber(coopId, coop?.code ?? "");
    const tempPin = generateTempPin();

    const member = await prisma.member.create({
      data: {
        phone: input.phone,
        contactPhone: input.phone,
        name: input.name ?? `${input.role} member`,
        code,
        pin: hashPin(tempPin),
        cooperativeId: coopId,
        role: input.role,
        nameVerified: true,
        wallet: { create: {} },
      },
    });

    return { memberId: member.id, created: true, tempPin };
  });
}
