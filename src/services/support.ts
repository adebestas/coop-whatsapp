import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";

export interface TicketResult {
  ok: boolean;
  message: string;
  ticketId?: string;
}

/** Roles that can work tickets. */
const SUPPORT_ROLES = ["support", "admin", "superadmin"];

async function isSupportAgent(phone: string, cooperativeId?: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { phone, role: { in: SUPPORT_ROLES }, ...(cooperativeId ? { cooperativeId } : {}) },
  });
  return member !== null;
}

/** Member opens a support ticket describing their issue. */
export async function createTicket(phone: string, message: string): Promise<TicketResult> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }
  const text = message.trim();
  if (text.length < 5) {
    return {
      ok: false,
      message: "Please describe your issue, e.g. *support My top-up has not reflected since yesterday*.",
    };
  }

  const ticket = await prisma.supportTicket.create({
    data: { cooperativeId: member.cooperativeId, memberId: member.id, message: text.slice(0, 1000) },
  });

  // Notify customer-service agents and admins of the cooperative.
  const agents = await prisma.member.findMany({
    where: { cooperativeId: member.cooperativeId, role: { in: SUPPORT_ROLES } },
    select: { phone: true },
  });
  for (const agent of agents) {
    if (agent.phone === phone) continue;
    void sendText({
      to: agent.phone,
      text:
        `🎫 New ticket *${ticket.id.slice(-6)}* from ${member.name}:\n"${text.slice(0, 200)}"\n\n` +
        `Reply *resolve ${ticket.id.slice(-6)} <note>* when handled.`,
    }).catch(() => {});
  }

  return {
    ok: true,
    ticketId: ticket.id,
    message:
      `🎫 Ticket *${ticket.id.slice(-6)}* created. Our customer service team has been notified and will get back to you here.\n\n` +
      `You'll receive a reply in this chat.`,
  };
}

/** Support agent lists open tickets. */
export async function listTickets(phone: string): Promise<TicketResult> {
  const agent = await prisma.member.findFirst({ where: { phone, role: { in: SUPPORT_ROLES } } });
  if (!agent) {
    return { ok: false, message: "Only customer service or admins can view tickets." };
  }
  const tickets = await prisma.supportTicket.findMany({
    where: { cooperativeId: agent.cooperativeId, status: { in: ["open", "in_progress"] } },
    include: { member: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  if (tickets.length === 0) {
    return { ok: true, message: "No open tickets. ✅" };
  }
  const body = tickets
    .map((t) => `• *${t.id.slice(-6)}* — ${t.member.name}: "${t.message.slice(0, 80)}"`)
    .join("\n");
  return {
    ok: true,
    message: `*Open tickets*\n\n${body}\n\nReply *resolve <id> <note>* when a ticket is handled.`,
  };
}

/** Support agent resolves a ticket — the member is notified in-chat. */
export async function resolveTicket(
  phone: string,
  ticketCode: string,
  note: string,
): Promise<TicketResult> {
  const agent = await prisma.member.findFirst({ where: { phone, role: { in: SUPPORT_ROLES } } });
  if (!agent) {
    return { ok: false, message: "Only customer service or admins can resolve tickets." };
  }
  const ticket = await prisma.supportTicket.findFirst({
    where: {
      OR: [{ id: ticketCode }, { id: { startsWith: ticketCode } }, { id: { endsWith: ticketCode } }],
    },
    include: { member: true },
  });
  if (!ticket || ticket.cooperativeId !== agent.cooperativeId) {
    return { ok: false, message: "Ticket not found." };
  }
  if (ticket.status === "resolved") {
    return { ok: false, message: "This ticket is already resolved." };
  }

  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: "resolved", assignedToId: agent.id, resolution: note.trim().slice(0, 500) || null },
  });

  void sendText({
    to: ticket.member.phone,
    text:
      `✅ Your ticket *${ticket.id.slice(-6)}* has been resolved.\n` +
      (note.trim() ? `Note: ${note.trim()}` : ""),
  }).catch(() => {});

  return { ok: true, message: `Ticket *${ticket.id.slice(-6)}* resolved. ${ticket.member.name} has been notified.` };
}
