import { sendText } from "../lib/messaging.js";
import { toKobo } from "../lib/money.js";
import {
  listCases,
  getCase,
  investigateCase,
  decideCase,
  applyRemedy,
  getActiveOmbudsman,
  type CaseDetail,
} from "./ombudsman.js";

/** Commands an active platform ombudsman can use from chat (not coop members). */
export const OMBUDSMAN_COMMANDS = new Set(["cases", "case", "investigate", "decide", "remedy"]);

/** Valid `OmbudsmanCase.status` values (no Prisma enum — plain strings). */
export const CASE_STATUSES = new Set(["open", "investigating", "decided", "closed"]);

/** Render a case + its timeline for the ombudsman console. */
export function formatCaseDetail(c: CaseDetail): string {
  const head =
    `*⚖️ Case #${c.id.slice(-6)}* (${c.status})\n` +
    `Category: *${c.category}*${c.slaDueAt ? ` · SLA due ${c.slaDueAt.toISOString().slice(0, 10)}` : ""}\n\n` +
    `${c.summary}\n`;
  const decision = c.decision ? `\n*Decision:* ${c.decision}\n` : "";
  const timeline = c.events
    .map(
      (e) =>
        `• ${e.createdAt.toISOString().slice(0, 16).replace("T", " ")} — ${e.actorRole} ${e.action}: ${e.detail}`,
    )
    .join("\n");
  return `${head}${decision}\n*Timeline*\n${timeline}`;
}

/**
 * Handle platform-level ombudsman commands. Ombudsmen are NOT cooperative
 * members, so this router is separate from `handleAdminCommand` and runs before
 * the member/admin routers. Gated to an active `Ombudsman` phone match. Returns
 * true if the command was handled.
 */
export async function handleOmbudsmanCommand(
  phone: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  if (!OMBUDSMAN_COMMANDS.has(cmd)) return false;
  const ombudsman = await getActiveOmbudsman(phone);
  if (!ombudsman) return false;
  const actor = { id: ombudsman.id, phone };

  if (cmd === "cases") {
    const status = args[0]?.trim().toLowerCase() || undefined;
    if (status && !CASE_STATUSES.has(status)) {
      await sendText({
        to: phone,
        text: "Unknown status. Use one of: *open*, *investigating*, *decided*, *closed*.",
      });
      return true;
    }
    const res = await listCases(status);
    if (!res.cases || res.cases.length === 0) {
      await sendText({ to: phone, text: res.message });
      return true;
    }
    const lines = res.cases.map(
      (c) => `• *#${c.id.slice(-6)}* — ${c.status} — ${c.category}\n   ${c.summary.slice(0, 80)}`,
    );
    await sendText({
      to: phone,
      text:
        `*⚖️ Ombudsman cases (${res.cases.length})*\n\n${lines.join("\n")}\n\n` +
        `Reply *case <id>* for the full timeline.`,
    });
    return true;
  }

  if (cmd === "case") {
    const res = await getCase(args[0] ?? "");
    await sendText({
      to: phone,
      text: res.ok && res.case ? formatCaseDetail(res.case) : res.message,
    });
    return true;
  }

  if (cmd === "investigate") {
    const caseRef = args[0];
    const note = args.slice(1).join(" ").trim();
    if (!caseRef || !note) {
      await sendText({
        to: phone,
        text: "Usage: *investigate <case id> <note for the cooperative>*.",
      });
      return true;
    }
    const res = await investigateCase(caseRef, note, actor);
    await sendText({ to: phone, text: res.message });
    return true;
  }

  if (cmd === "remedy") {
    const caseRef = args[0];
    const action = args[1]?.trim().toLowerCase();
    if (!caseRef || (action !== "unfreeze" && action !== "refund")) {
      await sendText({
        to: phone,
        text: "Usage: *remedy <case id> unfreeze* or *remedy <case id> refund <amount naira> [reason]*.",
      });
      return true;
    }
    if (action === "unfreeze") {
      const res = await applyRemedy(caseRef, "unfreeze", {}, actor);
      await sendText({ to: phone, text: res.message });
      return true;
    }
    const amountRaw = args[2];
    const amount = amountRaw ? toKobo(Number(amountRaw.replace(/[^0-9.]/g, ""))) : undefined;
    if (amount === undefined || !Number.isFinite(amount)) {
      await sendText({
        to: phone,
        text: "Usage: *remedy <case id> refund <amount naira> [reason]* — e.g. *remedy 1a2b3c refund 5000 double debit*.",
      });
      return true;
    }
    const reason = args.slice(3).join(" ").trim();
    const res = await applyRemedy(caseRef, "refund", { amount, reason }, actor);
    await sendText({ to: phone, text: res.message });
    return true;
  }

  // decide
  const caseRef = args[0];
  const decision = args.slice(1).join(" ").trim();
  if (!caseRef || !decision) {
    await sendText({ to: phone, text: "Usage: *decide <case id> <decision>*." });
    return true;
  }
  const res = await decideCase(caseRef, decision, actor);
  await sendText({ to: phone, text: res.message });
  return true;
}
