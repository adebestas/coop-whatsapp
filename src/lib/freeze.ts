import { prisma } from "./prisma.js";

export type FreezeGuard = { frozen: false } | { frozen: true; message: string };

export async function isFrozen(memberId: string): Promise<FreezeGuard> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { frozenAt: true, supervisoryFrozenAt: true },
  });
  // A Supervisory Committee freeze is the stronger state: it cannot be lifted by
  // the member and takes precedence over a self-freeze.
  if (member?.supervisoryFrozenAt) {
    return {
      frozen: true,
      message:
        "🔒 Your wallet is currently *frozen by the Supervisory Committee*, so no money can leave or be initiated.\n\n" +
        `Only the Supervisory Committee or a super admin can lift this freeze — please contact your cooperative.`,
    };
  }
  if (member?.frozenAt) {
    return {
      frozen: true,
      message:
        "🔒 Your wallet is currently *frozen* by your request, so no money can leave or be initiated.\n\n" +
        `Reply *unfreeze* to lift the freeze.`,
    };
  }
  return { frozen: false };
}

export function freezeMessage(memberName?: string | null): string {
  const who = memberName ? ` *${memberName}*` : "";
  return (
    `🔒 Your account${who} has been *frozen*. No money can be sent, withdrawn, or borrowed until you unfreeze it.\n\n` +
    `Incoming savings transfers to your funding account will still be accepted, but you won't be able to move money out.\n\n` +
    `Reply *unfreeze* to lift the freeze at any time.`
  );
}

export function unfreezeMessage(memberName?: string | null): string {
  const who = memberName ? ` *${memberName}*` : "";
  return `🔓 Your account${who} has been *unfrozen*. Money commands are active again.`;
}
