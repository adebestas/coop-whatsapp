import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { audit } from "./audit.js";

export interface RevokeResult {
  ok: boolean;
  message: string;
}

/**
 * Superadmin revokes a member's sessions: clears in-progress chat flow state,
 * unlinks their alternate channel, and stamps sessionsRevokedAt so every
 * money-out path refuses until the admin runs *unrevoke*.
 */
export async function revokeMemberSessions(
  actorPhone: string,
  actorId: string,
  cooperativeId: string,
  memberCode: string,
): Promise<RevokeResult> {
  const member = await prisma.member.findFirst({
    where: { code: memberCode.trim().toUpperCase(), cooperativeId },
  });
  if (!member) return { ok: false, message: `No member with code *${memberCode}* in this cooperative.` };

  await prisma.$transaction([
    prisma.member.update({
      where: { id: member.id },
      data: { sessionsRevokedAt: new Date(), altChannelId: null },
    }),
    prisma.session.deleteMany({ where: { phone: member.phone } }),
  ]);

  await audit({
    cooperativeId,
    actorPhone,
    actorId,
    actorRole: "superadmin",
    action: "session.revoke",
    targetType: "member",
    targetId: member.id,
    detail: `sessions revoked for ${member.name} (${member.phone})`,
  });

  await notifyMember(member,
    `🔒 Your active sessions were *revoked* by an admin. You can't move money until an admin runs *unrevoke*. Contact your cooperative if this was unexpected.`,
  ).catch(() => {});

  return {
    ok: true,
    message: `🔒 Revoked all sessions for *${member.name}* (${member.phone}). In-progress flows cleared; money-out is blocked until you run *unrevoke ${memberCode.toUpperCase()}*.`,
  };
}

/** Clears the revocation stamp, restoring the member's ability to move money. */
export async function unrevokeMemberSessions(
  actorPhone: string,
  actorId: string,
  cooperativeId: string,
  memberCode: string,
): Promise<RevokeResult> {
  const member = await prisma.member.findFirst({
    where: { code: memberCode.trim().toUpperCase(), cooperativeId },
  });
  if (!member) return { ok: false, message: `No member with code *${memberCode}* in this cooperative.` };

  await prisma.member.update({
    where: { id: member.id },
    data: { sessionsRevokedAt: null },
  });

  await audit({
    cooperativeId,
    actorPhone,
    actorId,
    actorRole: "superadmin",
    action: "session.unrevoke",
    targetType: "member",
    targetId: member.id,
    detail: `sessions restored for ${member.name}`,
  });

  await notifyMember(member,
    `✅ Your sessions were *restored*. You can move money again.`,
  ).catch(() => {});

  return {
    ok: true,
    message: `✅ Sessions restored for *${member.name}* (${member.phone}).`,
  };
}

/**
 * True when a member's sessions are currently revoked. Money-out paths call
 * this before authorising a transfer.
 */
export async function assertNotRevoked(memberId: string): Promise<{ blocked: boolean; message: string }> {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { sessionsRevokedAt: true, name: true } });
  if (member?.sessionsRevokedAt) {
    return {
      blocked: true,
      message: `🔒 ${member.name}'s sessions are revoked. Only a super admin's *unrevoke <code>* restores money movement.`,
    };
  }
  return { blocked: false, message: "" };
}
