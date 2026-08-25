import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { getMemberByPhone } from "./cooperative.js";
import { handleAdminCommand } from "./admin.js";
import { checkMoneyRateLimit, checkAIRateLimit } from "./fraud.js";
import { aiEnabled, suggestCommand } from "../lib/ai.js";
import { handleAIQuery, isNaturalLanguageQuery } from "../lib/ai-query.js";
import { generateSupportResponse } from "../lib/ai-support.js";
import { FIVE_LESSONS, getLesson, getTotalLessons } from "./literacy.js";
import { getReserveInfo } from "./dividends.js";
import { getAnniversaryMessage } from "./anniversary.js";
import { formatBalance } from "./cooperative.js";
import { validateDeviceSession, checkTenureLimit } from "../lib/security-hardening.js";

// ---- Tier-based transaction limits (CBN KYC requirements) ----
const TIER_LIMITS = {
  tier1: { maxSingle: 50_000_00, dailyMax: 300_000_00 }, // ₦50k single, ₦300k daily (in kobo)
  tier2: { maxSingle: 500_000_00, dailyMax: 5_000_000_00 }, // ₦500k single, ₦5M daily (in kobo)
} as const;

async function checkTierLimit(phone: string, amount: number): Promise<string | null> {
  const member = await prisma.member.findFirst({ where: { phone }, select: { id: true } });
  if (!member) return null;
  const tier = "tier1"; // Default tier — upgrade via BVN verification
  const limits = TIER_LIMITS[tier];
  if (amount > limits.maxSingle) {
    return `Your tier (${tier}) limits single transactions to ${formatBalance(limits.maxSingle)}. Complete BVN verification to upgrade to tier 2.`;
  }
  // Check daily limit
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dailyTotal = await prisma.contribution.aggregate({
    where: { memberId: member.id, createdAt: { gte: startOfDay }, status: "confirmed" },
    _sum: { amount: true },
  });
  const total = (dailyTotal._sum.amount ?? 0) + amount;
  if (total > limits.dailyMax) {
    return `Your tier (${tier}) daily limit is ${formatBalance(limits.dailyMax)}. You've already transacted ${formatBalance(dailyTotal._sum.amount ?? 0)} today.`;
  }
  return null;
}

import { z } from "zod"; // used by FlowDataSchema below

import { buildMenu, handleAwaitingInput } from "./handlers/session.js";
import { handleJoinStart, handleOnboardStart } from "./handlers/join.js";
import {
  handleBalance,
  handleSave,
  handleLoan,
  handleRepay,
  handleWithdraw,
  handleFund,
  handlePlan,
  handleDividend,
  handleJoinUnit,
  handleLoanQueue,
} from "./handlers/money.js";
import {
  handleValidateClaim,
  handleConfirmClaim,
  handleConfirm,
  handleCode,
  handlePhone,
  handleSupport,
  handleLedger,
  handleHistory,
  handleStatement,
  handlePosts,
  handleMyDeduction,
  handleSkipMonth,
  handleInsights,
  handleContextHelp,
  handleRisk,
  handleTickets,
  handleResolve,
  handleDeleteAccount,
  handleMyData,
} from "./handlers/admin-actions.js";
import {
  handleStartVote,
  handleCandidate,
  handleVote,
  handleCloseVote,
  handleResults,
  handleBuyPolls,
  handleVoteBuy,
  handlePollResults,
} from "./handlers/voting.js";

export type BotState =
  | "idle"
  | "awaiting_name"
  | "awaiting_coop_code"
  | "awaiting_phone"
  | "awaiting_otp"
  | "awaiting_email"
  | "awaiting_birthday"
  | "awaiting_nok_name"
  | "awaiting_nok_phone"
  | "awaiting_pin"
  | "awaiting_pin_confirm"
  | "awaiting_save_amount"
  | "awaiting_loan_amount"
  | "awaiting_loan_months"
  | "awaiting_loan_bank_account"
  | "awaiting_loan_bank_code"
  | "awaiting_guarantor_1"
  | "awaiting_guarantor_2"
  | "awaiting_withdraw_amount"
  | "awaiting_withdraw_account"
  | "awaiting_withdraw_bank"
  | "awaiting_withdraw_pin"
  | "awaiting_death_cert"
  | "awaiting_ai_confirm"
  | "awaiting_ai_query_confirm"
  | "awaiting_consent"
  | "awaiting_delete_account_pin"
  | "awaiting_optin"
  | "awaiting_onboard_name"
  | "awaiting_onboard_code"
  | "awaiting_onboard_state"
  | "awaiting_onboard_phone";

// ===== Session Data Schema (validates against corruption/tampering) =====
export const FlowDataSchema = z.object({
  joinCode: z.string().optional(),
  pin: z.string().optional(),
  name: z.string().optional(),
  contactPhone: z.string().optional(),
  otp: z.string().optional(),
  otpExpiresAt: z.number().optional(),
  phoneVerified: z.boolean().optional(),
  email: z.string().optional(),
  dateOfBirth: z.string().optional(),
  nokName: z.string().optional(),
  nokPhone: z.string().optional(),
  loanAmount: z.number().positive().optional(),
  loanMonths: z.number().positive().optional(),
  loanAccount: z.string().optional(),
  loanBankCode: z.string().optional(),
  loanBankName: z.string().optional(),
  loanId: z.string().optional(),
  withdrawAmount: z.number().positive().optional(),
  withdrawAccount: z.string().optional(),
  withdrawBankCode: z.string().optional(),
  withdrawBankName: z.string().optional(),
  deathClaimId: z.string().optional(),
  aiCommand: z.string().optional(),
  aiArgs: z.array(z.string()).optional(),
  aiQueryText: z.string().optional(),
  aiQueryResponse: z.string().optional(),
  flowToken: z.string().optional(),
  consentGiven: z.boolean().optional(),
  memberId: z.string().optional(),
});

export type FlowData = z.infer<typeof FlowDataSchema>;

/** States where the user is typing a secret — flow-token guarded, Telegram messages deleted after read. */
export const SECRET_STATES: BotState[] = ["awaiting_pin", "awaiting_pin_confirm", "awaiting_withdraw_pin"];

/** Metadata about how a message arrived (channel-specific extras). */
export interface MessageMeta {
  /** Echoed flow_token from a completed WhatsApp Flow card submission. */
  flowToken?: string;
  /** Telegram message id — secret replies are deleted right after reading. */
  telegramMessageId?: number;
  /** Client IP for anomaly detection. */
  ip?: string;
}

function isAwaitingState(state: BotState): boolean {
  return !["idle"].includes(state);
}

function parseCommand(text: string): { cmd: string; args: string[] } {
  const parts = text.trim().toLowerCase().split(/\s+/);
  return { cmd: parts[0] ?? "", args: parts.slice(1) };
}

export async function handleMessage(
  phone: string,
  text: string,
  meta: MessageMeta = {},
): Promise<void> {
  const session = await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "idle", lastInboundAt: new Date() },
    update: { lastInboundAt: new Date() },
  });

  const SESSION_TTL_MS = 30 * 60 * 1000;
  if (
    isAwaitingState(session.state as BotState) &&
    Date.now() - session.updatedAt.getTime() > SESSION_TTL_MS
  ) {
    await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
    await sendText({
      to: phone,
      text: "That request expired. Reply *menu* to start again.",
    });
    return;
  }

  // Device binding: detect SIM swap / session hijack (playbook Attack 1, 6)
  const platform = phone.startsWith("tg:") ? "telegram" : "whatsapp";
  const deviceCheck = await validateDeviceSession({
    memberPhone: phone,
    platform,
    ip: meta.ip ?? "unknown",
  });
  if (!deviceCheck.ok) {
    await sendText({ to: phone, text: `⚠️ ${deviceCheck.reason}\n\nIf this was you, try again in a few minutes.` });
    return;
  }

  if (isAwaitingState(session.state as BotState)) {
    await handleAwaitingInput(phone, session.state as BotState, text, session.data, meta);
    return;
  }

  const member = await getMemberByPhone(phone);

  // Opt-out: skip all processing for opted-out members (except opt-in command)
  const { cmd: preCmd } = parseCommand(text);
  if (member?.optedOut && preCmd !== "optin") {
    return;
  }

  // Consent check: skip messages for members who haven't consented (except opt-in command)
  if (member && member.consentAt === null && preCmd !== "optin") {
    return;
  }

  // Handle opt-out / opt-in commands
  if (preCmd === "stop" || preCmd === "unsubscribe" || preCmd === "optout") {
    if (member) {
      await prisma.member.update({ where: { id: member.id }, data: { optedOut: true } });
      await sendText({ to: phone, text: "You have been opted out of all messages. Reply *optin* to re-enable." });
    } else {
      await sendText({ to: phone, text: "You are not a registered member." });
    }
    return;
  }
  if (preCmd === "optin") {
    if (member) {
      await prisma.member.update({ where: { id: member.id }, data: { optedOut: false, consentAt: member.consentAt ?? new Date() } });
      await sendText({ to: phone, text: "Welcome back! You have been re-enabled for messages. Reply *menu* to see your options." });
    } else {
      await sendText({ to: phone, text: "You are not a registered member. Reply *join* to get started." });
    }
    return;
  }

  if (!member) {
    const altOwner = await prisma.member.findFirst({ where: { altChannelId: phone } });
    if (altOwner) {
      const pref = (await import("../lib/messaging.js")).platformOf(phone);
      if (altOwner.preferredChannel !== pref) {
        await prisma.member.update({
          where: { id: altOwner.id },
          data: { preferredChannel: pref },
        });
      }
      const home = altOwner.phone.startsWith("tg:") ? "Telegram" : "WhatsApp";
      await sendText({
        to: phone,
        text: `🔔 This chat receives your cooperative *alerts* only. For saving, loans and withdrawals, please use your *${home}* chat.`,
      });
      return;
    }
  } else if (member.preferredChannel !== (await import("../lib/messaging.js")).platformOf(phone)) {
    await prisma.member.update({
      where: { id: member.id },
      data: { preferredChannel: (await import("../lib/messaging.js")).platformOf(phone) },
    });
  }

  const { cmd, args } = parseCommand(text);

  const handled = await handleAdminCommand(phone, cmd, args);
  if (handled) return;

  switch (cmd) {
    case "hi":
    case "hello":
    case "hey":
    case "menu":
    case "help":
      await sendText({ to: phone, text: buildMenu(member) });
      break;

    case "join":
      await handleJoinStart(phone, args);
      break;

    case "onboard":
      await handleOnboardStart(phone);
      break;

    case "balance":
      await handleBalance(phone, member);
      break;

    case "save":
    case "loan":
    case "repay":
    case "withdraw": {
      if (!await checkMoneyRateLimit(phone)) {
        await sendText({
          to: phone,
          text: "⏳ You've made several money requests in the last hour. For your safety, please wait a little before trying again.",
        });
        break;
      }
      // Tier-based transaction limit check
      const amt = Number(args[0]);
      if (Number.isFinite(amt) && amt > 0) {
        const tierError = await checkTierLimit(phone, amt);
        if (tierError) {
          await sendText({ to: phone, text: `⛔ ${tierError}` });
          break;
        }
      }
      if (cmd === "save") await handleSave(phone, args);
      else if (cmd === "loan") await handleLoan(phone, args);
      else if (cmd === "repay") await handleRepay(phone, args);
      else await handleWithdraw(phone, args);
      break;
    }

    case "fund":
      await handleFund(phone);
      break;

    case "confirm":
      await handleConfirm(phone, args);
      break;

    case "code":
      await handleCode(phone);
      break;

    case "phone":
      await handlePhone(phone, args);
      break;

    case "ledger":
      await handleLedger(phone);
      break;

    case "posts":
      await handlePosts(phone);
      break;

    case "mydeduction":
      await handleMyDeduction(phone);
      break;

    case "skipmonth":
      await handleSkipMonth(phone);
      break;

    case "history":
      await handleHistory(phone);
      break;

    case "statement":
      await handleStatement(phone, args);
      break;

    case "plan":
      await handlePlan(phone, args);
      break;

    case "dividend":
      await handleDividend(phone, args);
      break;

    case "joinunit":
      await handleJoinUnit(phone, args);
      break;

    case "queue":
    case "loanqueue":
      await handleLoanQueue(phone);
      break;

    case "validate":
      await handleValidateClaim(phone, args);
      break;

    case "confirmclaim":
      await handleConfirmClaim(phone, args);
      break;

    case "support":
      await handleSupport(phone, text);
      break;

    case "tickets":
    case "mytickets":
      await handleTickets(phone);
      break;

    case "resolve":
      await handleResolve(phone, args);
      break;

    case "insights":
      await handleInsights(phone, member);
      break;

    case "contexthelp":
      await handleContextHelp(phone, member);
      break;

    case "class":
      await handleClass(phone, member, args);
      break;

    case "next":
      await handleNextLesson(phone, member);
      break;

    case "reserveinfo":
      await handleReserveInfo(phone, member);
      break;

    case "anniversary":
      await handleAnniversary(phone, member);
      break;

    case "risk":
      await handleRisk(phone, member);
      break;

    case "startvote":
      await handleStartVote(phone, args);
      break;

    case "candidate":
      await handleCandidate(phone, args);
      break;

    case "vote":
      await handleVote(phone, args);
      break;

    case "closevote":
      await handleCloseVote(phone, args);
      break;

    case "results":
      await handleResults(phone, args);
      break;

    case "buypolls":
      await handleBuyPolls(phone);
      break;

    case "votebuy":
      await handleVoteBuy(phone, args);
      break;

    case "pollresults":
      await handlePollResults(phone, args);
      break;

    case "deleteaccount":
      await handleDeleteAccount(phone);
      break;

    case "mydata":
      await handleMyData(phone);
      break;

    case "grievance": {
      const grievanceMsg = args.join(" ").trim();
      if (!grievanceMsg) {
        await sendText({ to: phone, text: "Usage: *grievance <your complaint>* — submit a grievance to the cooperative admin." });
        break;
      }
      const grievMember = await getMemberByPhone(phone);
      if (!grievMember) {
        await sendText({ to: phone, text: "You need to be a member first. Reply *join* to get started." });
        break;
      }
      await prisma.grievance.create({
        data: {
          cooperativeId: grievMember.cooperativeId,
          memberId: grievMember.id,
          message: grievanceMsg,
        },
      });
      await sendText({ to: phone, text: "✅ Your grievance has been submitted. Admins will review it. Reply *grievances* to check status." });
      break;
    }

    case "byelaws": {
      const byelawMember = await getMemberByPhone(phone);
      if (!byelawMember) {
        await sendText({ to: phone, text: "You need to be a member first. Reply *join* to get started." });
        break;
      }
      const coopByelaws = await prisma.cooperative.findUnique({
        where: { id: byelawMember.cooperativeId },
        select: { description: true, name: true },
      });
      if (coopByelaws?.description) {
        await sendText({ to: phone, text: `*📜 Byelaws — ${coopByelaws.name}*\n\n${coopByelaws.description}` });
      } else {
        await sendText({ to: phone, text: "No byelaws have been posted for your cooperative yet. The admin can set them with *setconfig description <text>*." });
      }
      break;
    }

    default: {
      if (aiEnabled() && text.trim().length >= 4 && !/^[\d\s.,]+$/.test(text)) {
        if (isNaturalLanguageQuery(text)) {
          const aiMember = await getMemberByPhone(phone);
          if (aiMember && !await checkAIRateLimit(aiMember.id)) {
            await sendText({
              to: phone,
              text: "⏳ You've reached the limit of 10 AI queries per hour. Please try again later.",
            });
            break;
          }
          const response = await handleAIQuery(
            text,
            phone,
            member?.role ?? "member",
            member?.cooperativeId ?? "",
            member?.id,
          );
          if (response) {
            await prisma.session.upsert({
              where: { phone },
              create: {
                phone,
                state: "awaiting_ai_query_confirm",
                data: JSON.stringify({ aiQueryText: text, aiQueryResponse: response }),
              },
              update: {
                state: "awaiting_ai_query_confirm",
                data: JSON.stringify({ aiQueryText: text, aiQueryResponse: response }),
              },
            });
            await sendText({
              to: phone,
              text: response + "\n\n🤖 *Was this helpful?* Reply *yes* or *no*.",
            });
            return;
          }
        }

        const suggestion = await suggestCommand(text);
        if (suggestion) {
          await prisma.session.upsert({
            where: { phone },
            create: {
              phone,
              state: "awaiting_ai_confirm",
              data: JSON.stringify({ aiCommand: suggestion.command, aiArgs: suggestion.args }),
            },
            update: {
              state: "awaiting_ai_confirm",
              data: JSON.stringify({ aiCommand: suggestion.command, aiArgs: suggestion.args }),
            },
          });
          await sendText({
            to: phone,
            text:
              `🤖 Did you mean *${[suggestion.command, ...suggestion.args].join(" ")}*?\n\n` +
              `Reply *yes* to run it or *no* to cancel.`,
          });
          return;
        }
      }
      if (aiEnabled() && text.trim().length >= 4 && isNaturalLanguageQuery(text)) {
        const supportMember = await getMemberByPhone(phone);
        if (!supportMember) {
          await sendText({
            to: phone,
            text: "You need to be a registered member to use AI support. Reply *join* to get started.",
          });
          return;
        }
        const supportResponse = await generateSupportResponse(
          text,
          supportMember.name,
          supportMember.role,
        );
        await sendText({ to: phone, text: supportResponse });
        return;
      }
      await sendText({
        to: phone,
        text:
          `I didn't quite get that. Reply *menu* to see your options.\n\n` +
          `Tip: you can type things like "save 2000", "loan 50000 3", "balance", or ask questions like "How much have I saved this month?"`,
      });
    }
  }
}

async function handleClass(phone: string, member: { id: string } | null, args: string[]): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to be a member first. Reply *join* to get started." });
    return;
  }

  const arg = args.join(" ").trim().toLowerCase();

  // Check for progress command
  if (arg === "progress") {
    const progress = await prisma.memberProgress.findUnique({ where: { memberId: member.id } });
    if (!progress) {
      await sendText({ to: phone, text: "You haven't started the financial class yet. Reply *class* to begin." });
      return;
    }
    const completed = JSON.parse(progress.completedLessons) as number[];
    const total = getTotalLessons();
    await sendText({
      to: phone,
      text: `📚 *Your Progress*\n\nCompleted: ${completed.length}/${total} lessons\n${completed.map((l) => `✅ Lesson ${l}`).join("\n")}${progress.completedAt ? "\n\n🎉 Class completed!" : `\n\nReply *class* for Lesson ${progress.currentLesson}.`}`,
    });
    return;
  }

  // Check for replay command
  if (arg.startsWith("replay ")) {
    const lessonNum = parseInt(arg.replace("replay ", ""));
    const lesson = getLesson(lessonNum);
    if (!lesson) {
      await sendText({ to: phone, text: "Invalid lesson number. Reply *class progress* to see your progress." });
      return;
    }
    await sendText({ to: phone, text: lesson.content });
    return;
  }

  // Get or create progress
  let progress = await prisma.memberProgress.findUnique({ where: { memberId: member.id } });
  if (!progress) {
    progress = await prisma.memberProgress.create({
      data: { memberId: member.id, currentLesson: 1 },
    });
  }

  // Get current lesson
  const lesson = getLesson(progress.currentLesson);
  if (!lesson) {
    await sendText({ to: phone, text: "🎉 You've completed all lessons! Reply *class progress* to review." });
    return;
  }

  await sendText({ to: phone, text: lesson.content });
}

async function handleNextLesson(phone: string, member: { id: string } | null): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to be a member first. Reply *join* to get started." });
    return;
  }

  const progress = await prisma.memberProgress.findUnique({ where: { memberId: member.id } });
  if (!progress) {
    await sendText({ to: phone, text: "Reply *class* to start your first lesson." });
    return;
  }

  // Mark current lesson as completed
  const completed = JSON.parse(progress.completedLessons) as number[];
  if (!completed.includes(progress.currentLesson)) {
    completed.push(progress.currentLesson);
  }

  const total = getTotalLessons();
  const nextLesson = progress.currentLesson + 1;

  if (nextLesson > total) {
    // All lessons completed
    await prisma.memberProgress.update({
      where: { memberId: member.id },
      data: {
        completedLessons: JSON.stringify(completed),
        completedAt: new Date(),
        lastLessonAt: new Date(),
      },
    });
    await sendText({
      to: phone,
      text: `✅ Lesson ${progress.currentLesson} complete!\n\n🎉 *Congratulations! You've completed all ${total} lessons!*\n\nYour understanding of how this cooperative works puts you ahead. Save consistently, borrow wisely, and support your fellow members.\n\nReply *class progress* to review any lesson anytime.`,
    });
  } else {
    // Move to next lesson
    const nextLessonData = getLesson(nextLesson);
    await prisma.memberProgress.update({
      where: { memberId: member.id },
      data: {
        completedLessons: JSON.stringify(completed),
        currentLesson: nextLesson,
        lastLessonAt: new Date(),
      },
    });
    await sendText({
      to: phone,
      text: `✅ Lesson ${progress.currentLesson} complete!\n\n${nextLessonData?.content}`,
    });
  }
}

async function handleReserveInfo(phone: string, member: { cooperativeId: string } | null): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to be a member first. Reply *join* to get started." });
    return;
  }

  const info = await getReserveInfo(member.cooperativeId);
  
  const growthText = info.growthPercent > 0
    ? `📈 *+${info.growthPercent}%* growth this quarter`
    : info.growthPercent < 0
      ? `📉 *${info.growthPercent}%* this quarter`
      : `➡️ No change this quarter`;

  const body = [
    `🛡️ *Reserve Fund Dashboard*`,
    ``,
    `Current balance: *${formatBalance(info.balance)}*`,
    ``,
    `*Quarterly Activity:*`,
    `• This quarter: *${formatBalance(info.thisQuarter)}*`,
    `• Last quarter: *${formatBalance(info.lastQuarter)}*`,
    `• ${growthText}`,
    ``,
    `_The Reserve Fund protects all members' savings. It grows from statutory deductions on dividend distributions._`,
  ];

  await sendText({ to: phone, text: body.join("\n") });
}

async function handleAnniversary(phone: string, member: { id: string; name: string; createdAt: Date; wallet?: { totalSaved: number } | null } | null): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to be a member first. Reply *join* to get started." });
    return;
  }

  const now = new Date();
  const diffMs = now.getTime() - member.createdAt.getTime();
  const years = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
  const months = Math.floor((diffMs % (365.25 * 24 * 60 * 60 * 1000)) / (30.44 * 24 * 60 * 60 * 1000));

  const regDate = member.createdAt.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

  const message = [
    `📅 *Your Anniversary Info*`,
    ``,
    `Registered: *${regDate}*`,
    `Membership: *${years} year${years !== 1 ? "s" : ""}${months > 0 ? `, ${months} month${months !== 1 ? "s" : ""}` : ""}*`,
    ``,
    years >= 1
      ? `Your next anniversary is on *${member.createdAt.getDate()} ${member.createdAt.toLocaleString("en-GB", { month: "long" })}* — you'll receive a special thank-you message! 🎉`
      : `Your first anniversary is coming up on *${member.createdAt.getDate()} ${member.createdAt.toLocaleString("en-GB", { month: "long" })}${member.createdAt.getFullYear() + 1}*! 🎉`,
  ].join("\n");

  await sendText({ to: phone, text: message });
}
