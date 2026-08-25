/**
 * Optional AI fallback translator: turns unrecognized free text into one of
 * the bot's known commands. OFF unless GROQ_API_KEY is set. The suggestion
 * is NEVER executed directly — the user must confirm it in chat, and even
 * then it flows through the normal command pipeline with all PIN / 2FA /
 * approval gates intact.
 */

import { GROQ_URL, groqAvailable, groqModel, groqHeaders, GROQ_TIMEOUT_MS } from "./groq.js";

/** Every command the bot understands (admin + member). Keep in sync. */
export const KNOWN_COMMANDS = [
  // member basics
  "menu", "help", "balance", "ledger", "history", "statement", "posts", "mydeduction",
  "save", "loan", "repay", "plan", "dividend", "joinunit", "phone", "support", "tickets", "mytickets",
  "skipmonth", "vote", "votebuy", "buypolls", "results", "pollresults", "contexthelp",
  "grievance", "grievances", "byelaws", "members",
  // admin
  "pending", "approve", "reject", "finalize", "payout", "overridewithdrawal",
  "broadcast", "createunit", "units", "setunitadmin", "paydividend", "recordfine",
  "approveclaim", "deathclaim", "validate", "confirmclaim", "claimbank", "resolve", "tickets",
  "startvote", "candidate", "closevote", "startbuy", "addoption", "closebuy",
  "newbatch", "submitbatch", "approvebatch", "rejectbatch", "setcommit", "waive",
  "setpost", "removepost", "relink", "unlink", "setrole", "setsalary", "runpayroll",
  "pay", "approvewdraw", "approvewithdraw", "audit", "backup", "reconcile", "walletreconcile", "reservefund", "pnl",
  "fundstatus",
  "export", "enable2fa", "disable2fa", "verifypin", "setplanfor",
  // SaaS config
  "setconfig", "showconfig", "setbranding", "billing", "onboard",
  // ai-powered
  "insights", "risk",
] as const;

export interface Suggestion {
  command: string;
  args: string[];
}

const SYSTEM_PROMPT = `You translate Nigerian cooperative members' WhatsApp messages (English or Pidgin) into ONE bot command.
Reply with STRICT JSON only, either {"command":"<cmd>","args":["<a1>","<a2>"]} or {"command":null,"args":[]} when unsure.
Never invent commands. Use only this list:\n${KNOWN_COMMANDS.join(", ")}
Rules: amounts are plain numbers without currency symbols or commas. Member codes look like ABC123-XYZ89.
If the person asks a question the commands cannot answer, reply {"command":null,"args":[]}.`;

export function aiEnabled(): boolean {
  return groqAvailable();
}

/** Ask the LLM to map free text to a known command. Returns null when disabled or unsure. */
export async function suggestCommand(text: string): Promise<Suggestion | null> {
  if (!aiEnabled() || !text || text.length > 300) return null;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: groqHeaders(),
      body: JSON.stringify({
        model: groqModel(),
        temperature: 0,
        max_tokens: 100,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content ?? "";
    // Try full parse first, then substring extraction
    let parsed: { command?: unknown; args?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      parsed = JSON.parse(jsonText);
    }
    if (typeof parsed.command !== "string") return null;
    const command = parsed.command.trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(command) || !(KNOWN_COMMANDS as readonly string[]).includes(command)) {
      return null;
    }
    const rawArgs = Array.isArray(parsed.args) ? (parsed.args as unknown[]) : [];
    const args = rawArgs.filter(
      (a): a is string =>
        typeof a === "string" &&
        a.trim().length > 0 &&
        a.length <= 60 &&
        // Reject shell metacharacters, newlines, slashes, and semicolons
        !/[\r\n/;|&<>{}()`]/.test(a),
    );
    // Strict: if the model produced anything smuggly malformed, drop the
    // whole suggestion rather than running a half-cleaned command.
    if (rawArgs.length !== args.length) return null;
    // Defense-in-depth: verify the reconstructed command still parses to the
    // same command (prevents arg-space injection attacks).
    const reconstructed = [command, ...args].join(" ");
    const reparsed = reconstructed.trim().split(/\s+/);
    if (reparsed[0] !== command) return null;
    return { command, args };
  } catch {
    return null; // network error, timeout, bad JSON — silently fall back
  }
}
