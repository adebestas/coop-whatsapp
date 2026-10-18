import { prisma } from "../../lib/prisma.js";
import { sendText, sendSecurePrompt, sendDocument } from "../../lib/messaging.js";
import { deleteTelegramMessage } from "../../lib/telegram.js";
import { randomBytes, randomInt } from "node:crypto";
import { hashOtp, verifyOtp } from "../../lib/security.js";
import { normalizePhone } from "../../lib/phones.js";
import {
  MESSAGE_CONSENT_REASK,
  AI_CONSENT_GRANTED,
  AI_CONSENT_DECLINED,
  AI_CONSENT_REASK,
} from "../../lib/consent.js";
import {
  findOrCreateMember,
  formatBalance,
  getMemberByPhone,
  invalidateMemberCache,
} from "../cooperative.js";
import { toKobo } from "../../lib/money.js";
import { provisionVirtualAccount } from "../payments/topup.js";
import { verifyMemberPin } from "../pin.js";
import { resolveBankCode } from "../../lib/banks.js";
import { applyForLoan, repayLoan } from "../loans.js";
import { buyShares } from "../shares.js";
import { addGuarantor, requiredGuarantors } from "../guarantors.js";
import type { LoanIntent } from "../../lib/ai-loan.js";
import { requestWithdrawal } from "../withdrawals.js";
import { submitCertificate } from "../deathclaims.js";
import type { BotState, FlowData, MessageMeta } from "../conversation.js";
import { FlowDataSchema, SECRET_STATES } from "../conversation.js";
import { askEmail, askBirthday, askNokName, askLiteracyOptIn, parseBirthday } from "./join.js";
import { getCoopConfig } from "../coop-config.js";
import { getQuizQuestions, getTotalLessons, QUIZ_QUESTIONS } from "../literacy.js";
import { issueCertificate, renderCertificatePdf } from "../literacy-certificate.js";
import { config } from "../../config.js";
import { verifyPhoneChangeOtp } from "../phone-change.js";
import { getActiveElectionsForNewMember } from "../votes.js";
import { provisionCooperative } from "../cooperative-provisioning.js";
import { confirmDividendDistribution } from "../dividends.js";
import { hashPin, verifyPin } from "../../lib/security.js";
import { createMandate, cancelMandate } from "../mandates.js";
import { myReferrals, getReferralBonus, withdrawReferralBonus } from "../referrals.js";
import { enqueueAfterCommit } from "../../lib/deferred.js";
import { insuranceService } from "./insurance.js";
import type { Product } from "../insurance/cubecover.js";
import { resolveProvider } from "../payments/index.js";
import { getCurrency } from "../../lib/runtime-context.js";
import { namesMatch } from "../disbursements.js";
import { accountMismatchWarning } from "../../lib/ai-notice.js";

/** A half-finished flow expires after this long. */
/** OTP codes expire after this long. */
const OTP_TTL_MS = 10 * 60 * 1000;

export function safeParse(json: string): FlowData {
  try {
    const parsed = JSON.parse(json);
    const result = FlowDataSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/**
 * Parse a member-typed monetary amount (in NAIRA, e.g. "5,000", "2000.50") and
 * return it as KOBO (the canonical storage unit). Returns null if invalid.
 * Caveat: do NOT use this for non-money rates (see handleDividend, which parses
 * a percentage rate and must not be multiplied by 100).
 */
export function parseNaira(raw?: string): number | null {
  if (!raw) return null;
  // Sanitise: strip separator/currency chars, and normalise common human/OCR
  // digit typos (O/o→0, l/I→1, S/s→5, B→8) so "2O00" or "l000" parse correctly.
  const cleaned = raw
    .replace(/[,₦\s]/g, "")
    .replace(/O/g, "0")
    .replace(/o/g, "0")
    .replace(/l/g, "1")
    .replace(/I/g, "1")
    .replace(/S/g, "5")
    .replace(/s/g, "5")
    .replace(/B/g, "8");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? toKobo(n) : null;
}

export function buildMenu(
  member: {
    name: string;
    cooperative: { name: string };
    wallet: { balance: number } | null;
    createdAt?: Date;
  } | null,
): string {
  if (!member) {
    return (
      `Welcome to your cooperative's WhatsApp bot! 🤝\n\n` +
      `Save, borrow, and manage your cooperative funds right here.\n\n` +
      `To get started, reply *join <code>* with your cooperative's code.`
    );
  }
  return (
    `💰 *Your Cooperative*\n\n` +
    `Reply:\n` +
    `• *balance* — check wallet\n` +
    `• *save <amount>* — contribute savings\n` +
    `• *withdraw <amount>* — withdraw funds\n` +
    `• *loan <amount>* — apply for loan\n` +
    `• *help* — see all commands`
  );
}

export function buildFullMenu(
  member: {
    name: string;
    cooperative: { name: string };
    wallet: { balance: number } | null;
    role?: string;
    createdAt?: Date;
  } | null,
): string {
  if (!member) {
    return (
      `Welcome to your cooperative's WhatsApp bot! 🤝\n\n` +
      `Save, borrow, and manage your cooperative funds right here.\n\n` +
      `To get started, reply *join <code>* with your cooperative's code.`
    );
  }
  const isNewMember =
    member.createdAt && Date.now() - member.createdAt.getTime() < 3 * 24 * 60 * 60 * 1000;
  if (isNewMember) {
    return (
      `Hi *${member.name}* from *${member.cooperative.name}* 🏦\n\n` +
      `Here's what you can do:\n` +
      `• *save <amount>* — contribute savings\n` +
      `• *balance* — check your wallet\n` +
      `• *withdraw <amount>* — withdraw funds\n` +
      `• *loan <amount>* — apply for loan\n` +
      `• *help* — see all commands\n\n` +
      `_You're new here — try *save 1000* to make your first contribution!_`
    );
  }
  let menu =
    `Hi *${member.name}* from *${member.cooperative.name}* 👋\n\n` +
    `*💰 Money*\n` +
    `• *balance* — check your savings\n` +
    `• *save <amount>* — contribute (e.g. *save 2000*)\n` +
    `• *withdraw <amount>* — request a withdrawal (up to 45%)\n` +
    `• *plan <amount> <weekly|monthly>* — recurring contribution\n` +
    `• *fund* — your personal top-up account\n` +
    `• *shares* / *buyshares <count>* — own shares in the coop\n\n` +
    `*📄 Loans*\n` +
    `• *loan <amount> <months>* — apply (e.g. *loan 50000 3*)\n` +
    `• *repay* — pay your monthly installment\n` +
    `• *validate <claim id>* — validate a death claim (guarantors)\n\n` +
    `*👥 Savings groups (ROSCA / VSLA)*\n` +
    `• *joingroup <code>* — join a group\n` +
    `• *groupcontribute <group id> <amount>* — pay into your group\n` +
    `• *grouploan <group id> <amount> <months>* — joint-liability group loan\n` +
    `• *mygroups* / *groupstatus <group id>* — your groups\n\n` +
    `*🏦 Savings products*\n` +
    `• *products* — browse fixed, goal, seasonal and junior products\n` +
    `• *openproduct <product id> [target]* — open one\n` +
    `• *openjunior <product id> <minor name> [phone]* — open a junior account\n` +
    `• *saveproduct <account id> <amount>* — deposit\n` +
    `• *withdrawproduct <account id> <amount>* — withdraw\n` +
    `• *myproducts* / *matureproduct <account id>* — your product savings\n\n` +
    `*🔁 Auto-debit mandate*\n` +
    `• *mandate <cap>* — authorize automatic debits\n` +
    `• *mandates* / *mandatestatus <id>* — view your mandates\n` +
    `• *cancelmandate <id>* — stop automatic debits\n\n` +
    `*📊 Account*\n` +
    `• *history* / *statement <month|year>* — transactions\n` +
    `• *analytics* — savings analytics\n` +
    `• *ledger* — cooperative ledger (transparency)\n` +
    `• *code* — your member code\n` +
    `• *myrefcode* / *referrals* — share your referral code & track rewards\n` +
    `• *phone <number>* — add/update your phone\n` +
    `• *changephone <number>* — move your account to a new number (OTP + admin approval)\n` +
    `• *mydata* / *deleteaccount* — your data (NDPR)\n\n` +
    `*🗳️ Governance*\n` +
    `• *vote <election id> <member code>* / *pollresults <id>*\n` +
    `• *buypolls* / *votebuy <poll id> <option #>*\n` +
    `• *votediv <yes|no>* — dividend-rate vote\n` +
    `• *dividend <rate>* — dividend calculator\n` +
    `• *meetings* — general meetings; *attend <id>* / *proxy <id> <code>*\n` +
    `• *motions <meeting id>* / *motionvote <motion id> <yes\\|no\\|abstain>*\n` +
    `• *byelaws* / *grievance <msg>* / *reserveinfo*\n` +
    `• *escalate <grievance id> [reason]* — escalate to the independent ombudsman\n` +
    `• *escalate dispute <form> <ref> [reason]* — escalate a dispute (loan_rejection/dividend/freeze/suspension/other)\n\n` +
    `*🎓 Learn*\n` +
    `• *class* / *next* — financial literacy lessons\n\n` +
    `*🏥 Health*\n` +
    `• *doctor* — talk to a licensed doctor (24/7, via your SuperCare cover)\n\n` +
    `*⚙️ Settings & help*\n` +
    `• *freeze* / *unfreeze* — lock your account\n` +
    `• *payees* / *addpayee* / *delpayee* — saved payout accounts\n` +
    `• *joinunit <code>* / *confirm <code>*\n` +
    `• *support <issue>* / *contexthelp*\n\n` +
    `🤖 You can also just *ask a question* in plain English or Pidgin.\n`;

  if (member.role === "admin" || member.role === "superadmin") {
    menu += `\n*Admin commands:* reply *admin*\n`;
  }

  return menu;
}

export function buildAdminMenu(): string {
  return (
    `🔧 *Admin Commands*\n\n` +
    `• *members* — list all members\n` +
    `• *pending* — list pending loans\n` +
    `• *approve <id>* — approve a loan\n` +
    `• *reject <id>* — reject a loan\n` +
    `• *broadcast <msg>* — send message to all members\n` +
    `• *units* — list workplace units\n` +
    `• *addunit* — add a new unit\n` +
    `• *approvewdraw <id>* — approve withdrawal\n` +
    `• *recordcheque <ref> <amount>* / *reconbatch <ref> <amount>* — employer remittance\n` +
    `• *approvephone <code>* / *rejectphone <code>* — approve a member's phone change\n` +
    `• *overridewithdrawal <phone>* — override withdrawal\n` +
    `• *deathclaim* — process death claim\n` +
    `• *claimbank* — set claim bank\n` +
    `• *tickets* — list support tickets\n` +
    `• *grievances* — list grievances\n` +
    `• *mandates* — list members' direct-debit mandates\n` +
    `• *pausemandate <id> [purpose]* / *resumemandate <id> [purpose]* — pause/resume debits\n` +
    `• *skipdebit <id>* — skip one pending direct debit\n` +
    `• *recommendrefund <member code|id> <amount> <reason>* — recommend a refund\n` +
    `• *approverefund <id>* / *rejectrefund <id> [reason]* — approve/reject a refund (super admin)\n` +
    `• *insurance* — list insurance policies\n` +
    `• *insuranceclaim <id>* — view claim details\n` +
    `• *approveinsuranceclaim <id>* — approve claim for payout\n` +
    `• *rejectinsuranceclaim <id>* — reject claim\n` +
    `• *listinsuranceclaims <code>* — list claims for member\n` +
    `• *resolve <id> <response>* — resolve ticket/grievance\n` +
    `• *startvote unit|exec ...* — start an election\n` +
    `• *candidate* — add election candidate\n` +
    `• *closevote* — close an election\n` +
    `• *startbuyvote <title>* — start a buy vote\n` +
    `• *addoption <id> <item> <cost> <acct> <bank>* — add buy option\n` +
    `• *closebuyvote <id>* — close a buy vote\n` +
    `• *startvotediv <rate%>* — open a dividend-rate member vote\n` +
    `• *closedivid [approve|reject]* — close a dividend-rate vote\n` +
    `• *votedivstatus* — dividend-rate vote tally\n` +
    `• *enable2fa* — protect your account\n` +
    `• *verifypin <pin>* — unlock big payouts (10 min)\n` +
    `• *insights* — AI financial analysis\n` +
    `• *risk* — AI loan risk assessment\n` +
    `• *par* — portfolio-at-risk aging report\n` +
    `• *provisionrates* — loan-loss provision rates\n` +
    `• *provision* — run the monthly loan-loss provision (super admin)\n` +
    `• *regulatorconfig <label> [type] [email] [monthlyDue] [quarterlyDue]* — set the regulator to file with\n` +
    `• *regreport <YYYY-MM> <statutory\\|nfiu\\|both> [monthly\\|quarterly]* — generate a regulator pack\n` +
    `• *regreportstatus* — view generated/filed regulator packs\n` +
    `• *regreport filed <id>* — mark a regulator pack filed\n` +
    `• *referralconfig [on\\|off] [wallet\\|bank\\|airtime] [amount] [maxRewards]* — configure referrals\n` +
    `• *referralreport* — referral summary for the coop\n\n` +
    `*Committees (super admin):* *addcommittee <credit\\|supervisory\\|board> <name> [size]*, *appoint <type> <member code> [chair]*, *removecommittee <type> <member code>*, *committees*\n` +
    `*Committees (members):* *cvote <loan id> approve\\|reject*, *committeequeue*, *supervisoryfreeze <member code> [reason]*, *supervisoryunfreeze <member code>*, *referralpause* / *referralresume* (Board)\n\n` +
    `*Meetings:* *startmeeting <agm\\|sgm> <title> [quorum%]*, *openmeeting <id>*, *closemeeting <id>*, *addmotion <meeting id> <title> \\| <description> [kind]*, *closemotion <id>*, *meetingminutes <id>*\n\n` +
    `*Savings groups:* *newgroup <rosca\\|vsla> <name> <code> <amount> <cycleLength>*, *closegroupcycle <group id>*, *groups*, *grouploans <group id>*\n\n` +
    `*Savings products:* *newproduct <fixed\\|goal\\|seasonal\\|junior> <name> [rate] [termMonths]*, *products*\n\n` +
    `*Super admin:* *finalize <id>*, *approveclaim <id>*, *setrole <code> <role>*, *confirmname <code>*, *paydividend <rate%>*, *paysharedividend <rate%>*, *pnl*, *monthly*, *expense <amt> <cat> <desc>*, *payout <amt> <phone> <narr>*, *payanyone*, *approvepay <id>*, *setsalary*, *runpayroll <narr>*, *export members|transactions|pnl*, *setlimit <amt>*, *backup*, *reconcile*`
  );
}

/** Show the member's own referral code plus a ready-to-share invite. */
export async function handleMyRefCode(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  await sendText({
    to: phone,
    text:
      `🎟️ *Your referral code is ${member.code}*\n\n` +
      `Share it with friends. They can join with *join ${member.cooperative?.code ?? "<coop code>"} ref ${member.code}*, ` +
      `or simply enter your code when the bot asks who referred them.\n\n` +
      `You earn a reward once they make their first contribution.`,
  });
}

/** Show the member's referrals and rewards earned. */
export async function handleReferrals(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  const res = await myReferrals(member.cooperativeId, member.id);
  await sendText({ to: phone, text: res.message });
}

/** Valid referral-bonus withdrawal destinations (no Prisma enum — plain strings). */
const BONUS_DESTINATIONS = new Set(["wallet", "bank", "airtime"]);

/** Parse a destination reply: a name, a 1/2/3 menu choice, or null. */
function parseBonusDestination(raw: string): "wallet" | "bank" | "airtime" | null {
  const t = raw.trim().toLowerCase();
  if (t === "1" || t === "wallet") return "wallet";
  if (t === "2" || t === "bank") return "bank";
  if (t === "3" || t === "airtime") return "airtime";
  return null;
}

/** Show the member's running referral bonus balance + how to withdraw it. */
export async function handleReferralBonus(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  const res = await getReferralBonus(member.cooperativeId, member.id);
  if (!res.ok) {
    await sendText({ to: phone, text: res.message });
    return;
  }
  await sendText({
    to: phone,
    text:
      `${res.message}\n\n` +
      (res.balance > 0
        ? `Reply *withdrawbonus* to move any amount to your wallet, your saved bank account, or airtime to any phone number.`
        : `Refer a friend to start earning — reply *myrefcode* for your referral code.`),
  });
}

/** Start the guided referral-bonus withdrawal flow (amount first). */
export async function handleStartBonusWithdrawal(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_bonus_amount", data: "{}" },
    update: { state: "awaiting_bonus_amount", data: "{}" },
  });
  await sendText({
    to: phone,
    text: "How much of your referral bonus would you like to withdraw? Reply an amount in naira, e.g. *500*.",
  });
}

export function buildOmbudsmanMenu(): string {
  return (
    `⚖️ *Ombudsman Console*\n\n` +
    `You serve as an independent platform ombudsman across every cooperative.\n\n` +
    `• *cases* — open cases across all cooperatives\n` +
    `• *cases investigating* — cases under investigation\n` +
    `• *case <id>* — full case timeline\n` +
    `• *investigate <id> <note>* — open an investigation (notifies the cooperative)\n` +
    `• *decide <id> <decision>* — issue a binding decision (notifies member + cooperative)\n` +
    `• *remedy <id> unfreeze* — lift a member's freeze\n` +
    `• *remedy <id> refund <amount> [reason]* — pay the member a refund`
  );
}

export async function deliverOtp(contactPhone: string, code: string): Promise<boolean> {
  const existing = await prisma.member.findFirst({
    where: { contactPhone, phone: { not: { startsWith: "tg:" } } },
    select: { phone: true },
  });
  if (!existing) return false;
  try {
    await sendText({
      to: existing.phone,
      text: `Your Coop Bank verification code is *${code}*. It expires in 10 minutes.`,
    });
    return true;
  } catch {
    return false;
  }
}

export async function issueSecretChallenge(
  phone: string,
  state: BotState,
  data: FlowData,
  text: string,
): Promise<void> {
  const flowToken = randomBytes(16).toString("hex");
  // Start a fresh secret entry: drop any stale Telegram kiosk state and reset the buffer.
  const nextData: FlowData = {
    ...data,
    flowToken,
    tgPinBuf: "",
    keyboardMsgId: undefined,
    tgPinPrompt: undefined,
  };
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state, data: JSON.stringify(nextData) },
    update: { state, data: JSON.stringify(nextData) },
  });
  const sent = await sendSecurePrompt({ to: phone, text, flowToken });
  if (phone.startsWith("tg:") && sent.messageId) {
    // Persist the on-screen kiosk card handle + prompt so callback taps can
    // update progress dots and tear the card down on submit/cancel.
    const withKiosk: FlowData = {
      ...nextData,
      tgPinBuf: "",
      keyboardMsgId: sent.messageId,
      tgPinPrompt: text,
    };
    await prisma.session.update({
      where: { phone },
      data: { data: JSON.stringify(withKiosk) },
    });
  }
}

/** Remove the on-screen Telegram PIN kiosk card if one is live for this session. */
async function teardownTelegramKiosk(phone: string, data: FlowData): Promise<void> {
  if (phone.startsWith("tg:") && data.keyboardMsgId) {
    await deleteTelegramMessage(phone.slice(3), data.keyboardMsgId).catch(() => {});
  }
}

/** Store `data` and send the NDPR privacy notice, awaiting a YES/NO. */
async function askConsent(phone: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_consent", data: JSON.stringify(data) },
    update: { state: "awaiting_consent", data: JSON.stringify(data) },
  });
  await sendText({
    to: phone,
    text:
      `*Privacy Notice (NDPR)*\n\n` +
      `By continuing, you consent to the collection and processing of your personal data ` +
      `(name, phone, bank details) for cooperative banking purposes only. Your data is stored ` +
      `securely and never shared with third parties without your consent.\n\n` +
      `For data protection inquiries, contact our Data Protection Officer (DPO): ` +
      `dpo@cooperative-app.ng\n\n` +
      `Reply *YES* to consent or *NO* to cancel.`,
  });
}

/** Persist a session step. Thin wrapper over the upsert the flow uses everywhere. */
async function stageSession(phone: string, state: BotState, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state, data: JSON.stringify(data) },
    update: { state, data: JSON.stringify(data) },
  });
}

/**
 * Start the loan flow from a natural-language request. The AI has already
 * extracted whatever it could; this stages the session at the earliest step
 * whose value is still missing, carrying any guarantors the member named so
 * they can be added automatically after the bank step. It performs NO money
 * movement — the normal, validated loan flow still runs (bank → confirm →
 * applyForLoan → guarantors).
 */
export async function startLoanFromNL(phone: string, intent: LoanIntent): Promise<void> {
  const base = { pendingGuarantors: intent.guarantors };
  if (intent.amountNaira === null) {
    await stageSession(phone, "awaiting_loan_amount", base);
    await sendText({ to: phone, text: "How much would you like to borrow? (e.g. *50000*)" });
    return;
  }
  const amount = toKobo(intent.amountNaira);
  if (intent.months === null) {
    await stageSession(phone, "awaiting_loan_months", { ...base, loanAmount: amount });
    await sendText({ to: phone, text: "For how many months? (1–12)" });
    return;
  }
  await stageSession(phone, "awaiting_loan_bank_account", {
    ...base,
    loanAmount: amount,
    loanMonths: intent.months,
  });
  await sendText({
    to: phone,
    text:
      `Great — I've noted your loan details.\n\n` +
      `The loan will be paid directly into your bank account.\n\n` +
      `What's your *bank account number*? (10 digits, e.g. *0123456789*)`,
  });
}

const QUIZ_LETTERS = ["A", "B", "C", "D"];

interface QuizState {
  questionIds: number[];
  index: number;
  answers: number[];
}

/** Send the current quiz question with its A/B/C/D options. */
async function sendQuizQuestion(phone: string, quiz: QuizState): Promise<void> {
  const q = QUIZ_QUESTIONS.find((x) => x.id === quiz.questionIds[quiz.index]);
  if (!q) return;
  const options = q.options.map((opt, i) => `${QUIZ_LETTERS[i]}. ${opt}`).join("\n");
  await sendText({
    to: phone,
    text:
      `📝 *Question ${quiz.index + 1}/${quiz.questionIds.length}*\n\n` +
      `${q.question}\n\n${options}\n\n` +
      `Reply with *A*, *B*, *C* or *D*.`,
  });
}

/**
 * Start (or restart) the financial-literacy quiz for a member. Only members who
 * opted in and completed every lesson may take it. Questions are selected
 * deterministically per attempt so retries vary.
 */
export async function startLiteracyQuiz(phone: string, memberId: string): Promise<void> {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to be a member first. Reply *join* to get started.",
    });
    return;
  }
  const coopConfig = await getCoopConfig(member.cooperativeId);
  if (!coopConfig.literacyCertificationEnabled) {
    await sendText({
      to: phone,
      text: "Financial-literacy certification isn't enabled for your cooperative.",
    });
    return;
  }
  const progress = await prisma.memberProgress.findUnique({ where: { memberId } });
  if (!progress || !progress.certificationOptIn) {
    await sendText({
      to: phone,
      text:
        "You're not enrolled in the certification yet. Reply *class* to learn about it, " +
        "or ask your cooperative admin to enroll you.",
    });
    return;
  }
  const total = getTotalLessons();
  const completed = JSON.parse(progress.completedLessons) as number[];
  if (completed.length < total) {
    await sendText({
      to: phone,
      text:
        `Finish all ${total} lessons first — you've completed ${completed.length}. ` +
        `Reply *class* to continue.`,
    });
    return;
  }
  const count = Math.max(1, Math.min(coopConfig.literacyQuizQuestionCount, QUIZ_QUESTIONS.length));
  const questions = getQuizQuestions(count, `${memberId}:${progress.quizAttempts}`);
  const quiz: QuizState = { questionIds: questions.map((q) => q.id), index: 0, answers: [] };
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "literacy_quiz", data: JSON.stringify({ memberId, quiz }) },
    update: { state: "literacy_quiz", data: JSON.stringify({ memberId, quiz }) },
  });
  await sendQuizQuestion(phone, quiz);
}

/**
 * Render and deliver a member's certificate as an in-chat PDF attachment,
 * falling back to a text message with the reference + verify link if the
 * attachment cannot be sent (never lose the outcome).
 */
async function deliverCertificate(
  phone: string,
  cert: { referenceCode: string; score: number; totalQuestions: number; issuedAt: Date },
  member: { id: string; name: string; code: string; cooperativeId: string },
): Promise<void> {
  const coop = await prisma.cooperative.findUnique({ where: { id: member.cooperativeId } });
  const suffix = cert.referenceCode.split("-").pop() ?? cert.referenceCode;
  const caption =
    `🎓 You're certified! Ref: ${cert.referenceCode}\n` +
    `Verify: ${config.publicBaseUrl}/api/certificate/${suffix}`;
  try {
    const buffer = await renderCertificatePdf(
      {
        referenceCode: cert.referenceCode,
        score: cert.score,
        totalQuestions: cert.totalQuestions,
        issuedAt: cert.issuedAt,
      },
      { name: member.name, code: member.code },
      { displayName: coop?.name ?? "Cooperative" },
    );
    const ok = await sendDocument({
      to: phone,
      filename: `${coop?.code ?? "coop"}-literacy-certificate.pdf`,
      mimeType: "application/pdf",
      data: buffer,
      caption,
    });
    if (!ok) throw new Error("sendDocument returned false");
  } catch {
    await sendText({ to: phone, text: caption });
  }
}

/** Re-send a member's certificate (re-render + re-attach). */
export async function resendCertificate(phone: string, memberId: string): Promise<void> {
  const cert = await prisma.literacyCertificate.findUnique({ where: { memberId } });
  if (!cert || cert.revokedAt) {
    await sendText({
      to: phone,
      text: "You don't have an active certificate yet. Pass the quiz with *class quiz* to earn one.",
    });
    return;
  }
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) {
    await sendText({ to: phone, text: "You need to be a member first." });
    return;
  }
  await deliverCertificate(phone, cert, member);
}

export async function handleAwaitingInput(
  phone: string,
  state: BotState,
  text: string,
  dataJson: string,
  meta: MessageMeta = {},
): Promise<void> {
  const data = safeParse(dataJson);

  const escapeWords = ["menu", "cancel", "quit", "exit", "back"];
  if (escapeWords.includes(text.trim().toLowerCase())) {
    await teardownTelegramKiosk(phone, data);
    await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
    await sendText({ to: phone, text: "Flow cancelled. Reply *menu* to see options." });
    return;
  }

  if (SECRET_STATES.includes(state)) {
    if (meta.telegramMessageId) {
      void deleteTelegramMessage(phone.slice(3), meta.telegramMessageId).catch(() => {});
    }
    if (data.flowToken && meta.flowToken && meta.flowToken !== data.flowToken) {
      await teardownTelegramKiosk(phone, data);
      await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
      await sendText({
        to: phone,
        text: "That secure entry expired. Reply *menu* to start again.",
      });
      return;
    }
  }

  switch (state) {
    case "awaiting_coop_code": {
      const code = text.trim().toUpperCase();
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_name", data: JSON.stringify({ joinCode: code }) },
        update: { state: "awaiting_name", data: JSON.stringify({ joinCode: code }) },
      });
      await sendText({
        to: phone,
        text: `Great — joining cooperative *${code}*. What's your full name?`,
      });
      break;
    }

    case "awaiting_name": {
      const name = text.trim().replace(/\s+/g, " ");
      if (!name || name.length < 2) {
        await sendText({ to: phone, text: "Please enter your full name so we know who's saving." });
        return;
      }
      // Allowlist letters/marks/space and common name punctuation only. Names are
      // rendered elsewhere (dashboard, statements), so reject anything else.
      if (name.length > 80 || !/^[\p{L}\p{M}'’. -]+$/u.test(name)) {
        await sendText({
          to: phone,
          text: "Please use letters only for your name (e.g. *Ada Obi*).",
        });
        return;
      }
      // The `join ... ref CODE` shortcut pre-fills referrerCode, so skip the
      // referral step; otherwise ask for it here (runs on WhatsApp and Telegram).
      if (data.referrerCode) {
        await askConsent(phone, { ...data, name });
        break;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_referral", data: JSON.stringify({ ...data, name }) },
        update: { state: "awaiting_referral", data: JSON.stringify({ ...data, name }) },
      });
      await sendText({
        to: phone,
        text:
          `One quick thing — were you referred by a member? ` +
          `Enter their member code (e.g. *ABC123-DEFG*), or reply *skip*.`,
      });
      break;
    }

    case "awaiting_referral": {
      const answer = text.trim();
      const skipped =
        answer === "" || ["skip", "none", "no", "0", "-"].includes(answer.toLowerCase());
      const nextData: FlowData = { ...data };
      if (skipped) {
        // No referral — clear anything that may have been pre-filled.
        delete nextData.referrerCode;
      } else {
        // Store the code as-is (uppercased). Unknown codes are NOT blocked here:
        // the join always proceeds and recordReferral rejects unknown codes
        // gracefully when the member is created.
        nextData.referrerCode = answer.toUpperCase();
      }
      await askConsent(phone, nextData);
      break;
    }

    case "awaiting_consent": {
      const answer = text.trim().toLowerCase();
      if (answer === "yes" || answer === "y") {
        // Store consent in session data and proceed
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_phone",
            data: JSON.stringify({ ...data, consentGiven: true }),
          },
          update: {
            state: "awaiting_phone",
            data: JSON.stringify({ ...data, consentGiven: true }),
          },
        });
        if (phone.startsWith("tg:")) {
          await sendText({
            to: phone,
            text: `Thanks, *${data.name}*! What's your real phone number? We need it for funding your wallet by bank transfer (e.g. *08012345678*).`,
          });
        } else {
          await askEmail(phone, { ...data, name: data.name });
        }
        return;
      }
      if (answer === "no" || answer === "n") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Registration cancelled. Your data will not be stored.",
        });
        return;
      }
      await sendText({ to: phone, text: "Please reply *YES* to consent or *NO* to cancel." });
      break;
    }

    case "awaiting_phone": {
      const contactPhone = normalizePhone(text);
      if (!contactPhone) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*.",
        });
        return;
      }
      const code = String(randomInt(100000, 999999));
      const hashedCode = hashOtp(code);
      const delivered = await deliverOtp(contactPhone, code);
      if (delivered) {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_otp",
            data: JSON.stringify({
              ...data,
              contactPhone,
              otp: hashedCode,
              otpExpiresAt: Date.now() + OTP_TTL_MS,
            }),
          },
          update: {
            state: "awaiting_otp",
            data: JSON.stringify({
              ...data,
              contactPhone,
              otp: hashedCode,
              otpExpiresAt: Date.now() + OTP_TTL_MS,
            }),
          },
        });
        await sendText({
          to: phone,
          text: `We sent a 6-digit code to the WhatsApp connected to *${contactPhone}*. Reply it here to verify your number.`,
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_email",
          data: JSON.stringify({ ...data, contactPhone, phoneVerified: false }),
        },
        update: {
          state: "awaiting_email",
          data: JSON.stringify({ ...data, contactPhone, phoneVerified: false }),
        },
      });
      await askEmail(phone, { ...data, contactPhone, phoneVerified: false });
      break;
    }

    case "awaiting_otp": {
      const input = text.trim();
      if (!/^\d{6}$/.test(input)) {
        await sendText({
          to: phone,
          text: "Enter the 6-digit code we sent to your WhatsApp, or reply *resend*.",
        });
        return;
      }
      if (!data.otpExpiresAt || data.otpExpiresAt < Date.now()) {
        await sendText({ to: phone, text: "That code expired. Reply *resend* for a new one." });
        return;
      }
      if (!data.otp || !verifyOtp(input, data.otp)) {
        await sendText({
          to: phone,
          text: "Wrong code. Check the WhatsApp message and try again.",
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_email",
          data: JSON.stringify({ ...data, otp: undefined, phoneVerified: true }),
        },
        update: {
          state: "awaiting_email",
          data: JSON.stringify({ ...data, otp: undefined, phoneVerified: true }),
        },
      });
      await askEmail(phone, { ...data, phoneVerified: true });
      break;
    }

    case "awaiting_changephone_otp": {
      const input = text.trim();
      if (!/^\d{6}$/.test(input)) {
        await sendText({
          to: phone,
          text: "Enter the 6-digit code we sent to your new number, or reply *menu* to cancel.",
        });
        return;
      }
      const result = await verifyPhoneChangeOtp(phone, input);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_email": {
      const email = text.trim().toLowerCase();
      if (email === "skip" || email === "0" || email === "-" || email === "none") {
        await askBirthday(phone, data);
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid email. Reply *skip* to skip this step, or enter an email like *ada@example.com*.",
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_birthday", data: JSON.stringify({ ...data, email }) },
        update: { state: "awaiting_birthday", data: JSON.stringify({ ...data, email }) },
      });
      await askBirthday(phone, { ...data, email });
      break;
    }

    case "awaiting_birthday": {
      const raw = text.trim();
      if (raw === "skip" || raw === "0" || raw === "-" || raw === "none") {
        await askNokName(phone, data);
        return;
      }
      const dob = parseBirthday(raw);
      if (!dob) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid birthday. Use *DD/MM* format, e.g. *15/08*, or reply *skip*.",
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_nok_name",
          data: JSON.stringify({ ...data, dateOfBirth: dob.toISOString() }),
        },
        update: {
          state: "awaiting_nok_name",
          data: JSON.stringify({ ...data, dateOfBirth: dob.toISOString() }),
        },
      });
      await askNokName(phone, { ...data, dateOfBirth: dob.toISOString() });
      break;
    }

    case "awaiting_nok_name": {
      const nokName = text.trim().replace(/\s+/g, " ");
      if (!nokName || nokName.length < 2) {
        await sendText({
          to: phone,
          text: "Please enter your next of kin's full name (e.g. *Chidi Okafor*).",
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_nok_phone", data: JSON.stringify({ ...data, nokName }) },
        update: { state: "awaiting_nok_phone", data: JSON.stringify({ ...data, nokName }) },
      });
      await sendText({
        to: phone,
        text: `What's *${nokName}'s* phone number? If anything happens to you, this is who we contact about your savings.`,
      });
      break;
    }

    case "awaiting_nok_phone": {
      const nokPhone = normalizePhone(text);
      if (!nokPhone) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*.",
        });
        return;
      }
      const nextData: FlowData = { ...data, nokPhone };
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_pin", data: JSON.stringify(nextData) },
        update: { state: "awaiting_pin", data: JSON.stringify(nextData) },
      });
      await issueSecretChallenge(
        phone,
        "awaiting_pin",
        nextData,
        "Now choose a 4-digit PIN. You'll use it to approve transactions.",
      );
      break;
    }

    case "awaiting_pin": {
      if (!/^\d{4,6}$/.test(text.trim())) {
        await issueSecretChallenge(
          phone,
          "awaiting_pin",
          data,
          "Your PIN must be 4-6 digits (e.g. *1234*).",
        );
        return;
      }
      await issueSecretChallenge(
        phone,
        "awaiting_pin_confirm",
        { ...data, pin: hashPin(text.trim()) },
        "Please re-enter your PIN to confirm.",
      );
      break;
    }

    case "awaiting_pin_confirm": {
      if (!data.pin || !verifyPin(text.trim(), data.pin)) {
        await sendText({
          to: phone,
          text: "PINs didn't match. Let's start again — choose a 4-digit PIN.",
        });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_pin" },
          update: { state: "awaiting_pin" },
        });
        return;
      }
      const result = await findOrCreateMember(
        phone,
        data.joinCode ?? "",
        data.name ?? "",
        text.trim(),
        data.contactPhone,
        data.email,
        data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        data.nokName && data.nokPhone ? { name: data.nokName, phone: data.nokPhone } : undefined,
        data.phoneVerified ?? false,
        data.referrerCode,
      );
      // Log NDPR consent if consent was given during registration
      if (result.ok && result.memberId && data.consentGiven) {
        await prisma.dataConsent.create({
          data: {
            memberId: result.memberId,
            consentType: "registration",
            granted: true,
          },
        });
        await prisma.member.update({
          where: { id: result.memberId },
          data: { dataConsentGiven: true },
        });
      }
      // Optional financial-literacy certification opt-in. Only offered when the
      // cooperative enables it; asked after member creation so we have a memberId
      // to persist the choice. Never blocks registration.
      const newMember =
        result.ok && result.memberId
          ? await prisma.member.findUnique({ where: { id: result.memberId } })
          : null;
      const coopConfig = newMember ? await getCoopConfig(newMember.cooperativeId) : null;

      if (result.ok && result.memberId && coopConfig?.literacyCertificationEnabled) {
        await sendText({ to: phone, text: result.message });
        await askLiteracyOptIn(phone, { memberId: result.memberId });
      } else {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_optin",
            data: JSON.stringify({ memberId: result.memberId }),
          },
          update: { state: "awaiting_optin", data: JSON.stringify({ memberId: result.memberId }) },
        });
        await sendText({
          to: phone,
          text:
            result.message +
            "\n\n" +
            "📱 *Message Consent*\n\n" +
            "Do you consent to receive messages from this cooperative? " +
            "This includes savings alerts, loan updates, and important notices.\n\n" +
            "Reply *YES* to opt-in or *NO* to skip.",
        });
      }

      // Auto-notify new member of active elections they can participate in
      if (newMember) {
        const activeElections = await getActiveElectionsForNewMember(
          newMember.cooperativeId,
          newMember.unitId,
        );
        if (activeElections.length > 0) {
          const electionLines = activeElections.map((e, i) => {
            const typeTag = e.electionType === "workplace" || e.kind === "unit" ? "🏢" : "🏛️";
            const pos = e.position ? ` — ${e.position}` : "";
            return `${i + 1}. ${typeTag} ${e.title}${pos} — reply *vote ${e.id.slice(-6)} <candidate code>*`;
          });
          await sendText({
            to: phone,
            text:
              `🗳️ Active elections you can vote in:\n\n` +
              `${electionLines.join("\n")}\n\n` +
              `View results with *pollresults <election id>*.`,
          });
        }
      }
      break;
    }

    case "awaiting_save_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid amount. Try *save 5000* or *save 10000*.",
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_save_confirm",
          data: JSON.stringify({ ...data, saveAmount: amount }),
        },
        update: {
          state: "awaiting_save_confirm",
          data: JSON.stringify({ ...data, saveAmount: amount }),
        },
      });
      await sendText({
        to: phone,
        text: `You're about to save ${formatBalance(amount)}. Reply *yes* to confirm or *menu* to cancel.`,
      });
      break;
    }

    case "awaiting_save_confirm": {
      // Legacy/stale sessions may reach here, but we NEVER fabricate a wallet
      // credit — savings only land after a REAL provider payment (topup.ts via
      // the Monnify/Paystack webhook). Route the member to their funding account.
      const answer = text.trim().toLowerCase();
      const member = await getMemberByPhone(phone);
      if (answer === "yes" || answer === "y") {
        const saveAmount = data.saveAmount ?? null;
        const amountLine = saveAmount
          ? `To save *${formatBalance(saveAmount)}*, transfer that exact amount to your funding account below — your wallet is credited automatically once the transfer is confirmed.`
          : `Transfer any amount to your funding account below — your wallet is credited automatically once the transfer is confirmed.`;
        const fund = member ? await provisionVirtualAccount(member.id) : null;
        const accountLine = fund?.ok
          ? fund.message
          : "We couldn't set up your funding account right now. Please try *fund* again.";
        await sendText({ to: phone, text: `${amountLine}\n\n${accountLine}` });
      } else {
        await sendText({ to: phone, text: "Save cancelled. Reply *menu* to see options." });
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle" },
      });
      break;
    }

    case "awaiting_loan_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({ to: phone, text: "Please enter a valid amount, e.g. *50000*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_loan_months",
          data: JSON.stringify({ ...data, loanAmount: amount }),
        },
        update: {
          state: "awaiting_loan_months",
          data: JSON.stringify({ ...data, loanAmount: amount }),
        },
      });
      await sendText({ to: phone, text: "For how many months? (1–12)" });
      break;
    }

    case "awaiting_loan_months": {
      const months = parseInt(text.trim(), 10);
      if (!Number.isFinite(months) || months < 1 || months > 12) {
        await sendText({ to: phone, text: "Months must be between 1 and 12, e.g. *3*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_loan_bank_account",
          data: JSON.stringify({ ...data, loanMonths: months }),
        },
        update: {
          state: "awaiting_loan_bank_account",
          data: JSON.stringify({ ...data, loanMonths: months }),
        },
      });
      await sendText({
        to: phone,
        text:
          `Perfect. The loan will be paid directly into your bank account.\n\n` +
          `What's your *bank account number*? (10 digits, e.g. *0123456789*)`,
      });
      break;
    }

    case "awaiting_loan_bank_account": {
      const account = text.trim().replace(/[^0-9]/g, "");
      if (!/^\d{10}$/.test(account)) {
        await sendText({ to: phone, text: "Account numbers are 10 digits. Try *0123456789*." });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_loan_bank_code",
          data: JSON.stringify({ ...data, loanAccount: account }),
        },
        update: {
          state: "awaiting_loan_bank_code",
          data: JSON.stringify({ ...data, loanAccount: account }),
        },
      });
      await sendText({
        to: phone,
        text: `Which bank?\n\n• *Access* • *GTB* • *Zenith* • *UBA* • *First Bank*\n• *Kuda* • *Opay* • *PalmPay* • *Moniepoint* • *Wema*\n• *Fidelity* • *FCMB* • *Stanbic* • *Sterling* • *Union*\n\nReply with bank name or 5-digit bank code.`,
      });
      break;
    }

    case "awaiting_loan_bank_code": {
      const bank = resolveBankCode(text);
      if (!bank) {
        await sendText({
          to: phone,
          text: `We don't recognise that bank. Try *Access*, *GTB*, *Zenith*, *UBA*, *First Bank*, *Kuda*, or reply with the 5-digit bank code.`,
        });
        return;
      }
      // Resolve the account name (advisory): if it doesn't match the member's
      // registered name, call their attention to it. Fail-open — the payout
      // path re-verifies and blocks on mismatch anyway.
      let accountName: string | null = null;
      let mismatch = false;
      try {
        const provider = await resolveProvider(undefined, getCurrency());
        const resolved = await provider.resolveAccount?.({
          accountNumber: data.loanAccount ?? "",
          bankCode: bank.code,
        });
        if (resolved?.ok && resolved.name) {
          accountName = resolved.name;
          const member = await getMemberByPhone(phone);
          mismatch = !!member && !namesMatch(resolved.name, member.name);
        }
      } catch (err) {
        console.warn("[loan] account-name resolution failed:", err);
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_loan_bank_confirm",
          data: JSON.stringify({
            ...data,
            loanBankCode: bank.code,
            loanBankName: bank.name,
            bankAccountName: accountName ?? undefined,
            bankNameMismatch: mismatch,
          }),
        },
        update: {
          state: "awaiting_loan_bank_confirm",
          data: JSON.stringify({
            ...data,
            loanBankCode: bank.code,
            loanBankName: bank.name,
            bankAccountName: accountName ?? undefined,
            bankNameMismatch: mismatch,
          }),
        },
      });
      await sendText({
        to: phone,
        text:
          `You selected *${bank.name}*` +
          (accountName ? ` — name on account: *${accountName}*` : "") +
          `. Is this correct? Reply *yes* or *no*.`,
      });
      if (mismatch && accountName) {
        const member = await getMemberByPhone(phone);
        await sendText({
          to: phone,
          text: await accountMismatchWarning(member?.name ?? "", accountName),
        });
      }
      break;
    }

    case "awaiting_loan_bank_confirm": {
      const answer = text.trim().toLowerCase();
      if (answer !== "yes" && answer !== "y") {
        await sendText({
          to: phone,
          text: `Which bank?\n\n• *Access* • *GTB* • *Zenith* • *UBA* • *First Bank*\n• *Kuda* • *Opay* • *PalmPay* • *Moniepoint* • *Wema*\n• *Fidelity* • *FCMB* • *Stanbic* • *Sterling* • *Union*\n\nReply with bank name or 5-digit bank code.`,
        });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "awaiting_loan_bank_code", data: JSON.stringify(data) },
          update: { state: "awaiting_loan_bank_code", data: JSON.stringify(data) },
        });
        return;
      }
      const result = await applyForLoan(phone, data.loanAmount ?? 0, data.loanMonths ?? 1, {
        accountNumber: data.loanAccount ?? "",
        bankCode: data.loanBankCode ?? "",
        bankName: data.loanBankName ?? "",
      });
      if (!result.ok || !result.loanId) {
        await sendText({ to: phone, text: result.message });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle" },
        });
        return;
      }
      await sendText({ to: phone, text: result.message });
      const borrower = await getMemberByPhone(phone);
      const needed = requiredGuarantors(borrower?.role);

      // Auto-add guarantors the member supplied up front (NL intake). Each
      // addGuarantor() notifies the guarantor with their `confirm <code>`.
      const pending = Array.isArray(data.pendingGuarantors) ? data.pendingGuarantors : [];
      let added = 0;
      for (const id of pending) {
        if (added >= needed) break;
        const g = await addGuarantor(phone, result.loanId, id);
        await sendText({ to: phone, text: g.message });
        if (!g.ok) break;
        added++;
      }

      if (added >= needed) {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle" },
        });
        await sendText({
          to: phone,
          text: `That's all the guarantors needed. The loan can be approved once they confirm.`,
        });
        break;
      }

      const nextState: BotState = added === 0 ? "awaiting_guarantor_1" : "awaiting_guarantor_2";
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: nextState,
          data: JSON.stringify({ loanId: result.loanId }),
        },
        update: { state: nextState, data: JSON.stringify({ loanId: result.loanId }) },
      });
      await sendText({
        to: phone,
        text:
          `To complete your application, you need *${needed} guarantor${needed === 1 ? "" : "s"}* in total.\n\n` +
          `Send the *member code* or *phone number* of your ${added > 0 ? "next" : "first"} guarantor (e.g. *ABC123-DEFG*).`,
      });
      break;
    }

    case "awaiting_guarantor_1": {
      const result = await addGuarantor(phone, data.loanId ?? "", text);
      await sendText({ to: phone, text: result.message });
      if (result.ok) {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_guarantor_2",
            data: JSON.stringify({ loanId: data.loanId }),
          },
          update: { state: "awaiting_guarantor_2", data: JSON.stringify({ loanId: data.loanId }) },
        });
      }
      break;
    }

    case "awaiting_guarantor_2": {
      const result = await addGuarantor(phone, data.loanId ?? "", text);
      await sendText({ to: phone, text: result.message });
      if (result.ok) {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle" },
        });
      }
      break;
    }

    case "awaiting_withdraw_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid amount. Try *withdraw 5000* or *withdraw 10000*.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (member?.bankAccountNumber && member.bankCode) {
        await issueSecretChallenge(
          phone,
          "awaiting_withdraw_pin",
          { ...data, withdrawAmount: amount },
          "Enter your 4-digit PIN to confirm the withdrawal.",
        );
      } else {
        const { startBankFlow } = await import("./money.js");
        await startBankFlow(phone, "withdraw", { ...data, withdrawAmount: amount });
      }
      break;
    }

    case "awaiting_bank_account": {
      const { handleBankAccountStep } = await import("./money.js");
      await handleBankAccountStep(phone, text, data);
      break;
    }

    case "awaiting_bank_choice": {
      const { handleBankChoiceStep } = await import("./money.js");
      await handleBankChoiceStep(phone, text, data);
      break;
    }

    case "awaiting_bank_confirm": {
      const { handleBankConfirmStep } = await import("./money.js");
      await handleBankConfirmStep(phone, text, data);
      break;
    }

    case "awaiting_withdraw_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Withdrawal cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_withdraw_pin", data, msg);
        return;
      }
      const bank =
        data.withdrawAccount && data.withdrawBankCode
          ? {
              accountNumber: data.withdrawAccount,
              bankCode: data.withdrawBankCode,
              bankName: data.withdrawBankName,
              accountName: data.bankAccountName,
            }
          : undefined;
      const result = await requestWithdrawal(phone, data.withdrawAmount ?? 0, bank);
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle" },
      });
      await sendText({
        to: phone,
        text: result.message + "\n\nReply *menu* to see other options.",
      });
      break;
    }

    case "awaiting_repay_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Repayment cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_repay_pin", data, msg);
        return;
      }
      const result = await repayLoan(phone);
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle" },
      });
      await sendText({
        to: phone,
        text: result.message + "\n\nReply *menu* to see other options.",
      });
      break;
    }

    case "awaiting_buyshares_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Share purchase cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_buyshares_pin", data, msg);
        return;
      }
      const result = await buyShares(member.id, data.shareCount ?? 0);
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle" },
      });
      await sendText({
        to: phone,
        text: result.message + "\n\nReply *menu* to see other options.",
      });
      break;
    }

    case "awaiting_bonus_amount": {
      const amount = parseNaira(text);
      if (amount === null) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid amount. Try e.g. *500*.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const bonus = await getReferralBonus(member.cooperativeId, member.id);
      if (!bonus.ok || amount > bonus.balance) {
        await sendText({
          to: phone,
          text:
            `That's more than your referral bonus balance of *${formatBalance(bonus.balance)}*. ` +
            `Enter a smaller amount, or reply *menu* to cancel.`,
        });
        return;
      }
      const cfg = await prisma.cooperativeConfig.findUnique({
        where: { cooperativeId: member.cooperativeId },
      });
      const defaultDest = (cfg?.referralRewardType ?? "wallet").toLowerCase();
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_bonus_destination",
          data: JSON.stringify({ ...data, bonusAmount: amount }),
        },
        update: {
          state: "awaiting_bonus_destination",
          data: JSON.stringify({ ...data, bonusAmount: amount }),
        },
      });
      await sendText({
        to: phone,
        text:
          `Where should we send it?\n\n` +
          `• *1* — your wallet\n` +
          `• *2* — your saved bank account\n` +
          `• *3* — airtime to any number\n\n` +
          `Reply *1*, *2* or *3* (or *wallet*, *bank*, *airtime*). Default: *${defaultDest}*.`,
      });
      break;
    }

    case "awaiting_bonus_destination": {
      const member = await getMemberByPhone(phone);
      const cfg = member
        ? await prisma.cooperativeConfig.findUnique({
            where: { cooperativeId: member.cooperativeId },
          })
        : null;
      const configured = (cfg?.referralRewardType ?? "wallet").toLowerCase();
      const raw = text.trim().toLowerCase();
      const destination =
        raw === "" || raw === "default" || raw === "skip"
          ? ((BONUS_DESTINATIONS.has(configured) ? configured : "wallet") as
              "wallet" | "bank" | "airtime")
          : parseBonusDestination(raw);
      if (!destination) {
        await sendText({ to: phone, text: "Reply *1* (wallet), *2* (bank) or *3* (airtime)." });
        return;
      }
      if (destination === "airtime") {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_bonus_phone",
            data: JSON.stringify({ ...data, bonusDestination: destination }),
          },
          update: {
            state: "awaiting_bonus_phone",
            data: JSON.stringify({ ...data, bonusDestination: destination }),
          },
        });
        await sendText({
          to: phone,
          text: "Which phone number should receive the airtime? Any number, e.g. *08012345678*.",
        });
        return;
      }
      await issueSecretChallenge(
        phone,
        "awaiting_bonus_pin",
        { ...data, bonusDestination: destination },
        "Enter your 4-digit PIN to confirm the withdrawal.",
      );
      break;
    }

    case "awaiting_bonus_phone": {
      const airtimePhone = normalizePhone(text);
      if (!airtimePhone) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid number. Try e.g. *08012345678*.",
        });
        return;
      }
      await issueSecretChallenge(
        phone,
        "awaiting_bonus_pin",
        { ...data, bonusPhone: airtimePhone },
        "Enter your 4-digit PIN to confirm the airtime withdrawal.",
      );
      break;
    }

    case "awaiting_bonus_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Withdrawal cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_bonus_pin", data, msg);
        return;
      }
      const amount = data.bonusAmount ?? 0;
      const destination = (data.bonusDestination ?? "wallet") as "wallet" | "bank" | "airtime";
      const airtimePhone = data.bonusPhone;
      // Leave the flow BEFORE the disbursement so a replayed PIN cannot withdraw twice.
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      // The chat handler is ONE transaction, so the provider payout must run
      // after it commits. Fall back to an immediate await when there is no scope.
      const disburse = async () => {
        const result = await withdrawReferralBonus(
          member.cooperativeId,
          member.id,
          { amount, destination, phone: airtimePhone },
          { id: member.id, phone },
        );
        await sendText({
          to: phone,
          text: result.message + "\n\nReply *menu* to see other options.",
        });
      };
      if (!enqueueAfterCommit(disburse)) {
        await disburse();
      } else {
        await sendText({ to: phone, text: "⏳ Processing your referral bonus withdrawal…" });
      }
      break;
    }

    case "awaiting_mandate_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Mandate setup cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_mandate_pin", data, msg);
        return;
      }
      const result = await createMandate(
        member.cooperativeId,
        member.id,
        data.mandateCap ?? 0,
        {
          id: member.id,
          phone,
          role: member.role,
        },
        data.bankAccount && data.bankCode
          ? {
              accountNumber: data.bankAccount,
              bankCode: data.bankCode,
              bankName: data.bankName ?? null,
              accountName: data.bankAccountName ?? null,
            }
          : undefined,
      );
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      await sendText({
        to: phone,
        text: result.message + "\n\nReply *menu* to see other options.",
      });
      break;
    }

    case "awaiting_cancelmandate_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Mandate cancellation cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const member = await getMemberByPhone(phone);
      if (!member) {
        await sendText({
          to: phone,
          text: "You need to join a cooperative first. Reply *join <code>* to get started.",
        });
        return;
      }
      const pinCheck = await verifyMemberPin(member, input);
      if (!pinCheck.ok) {
        const msg = pinCheck.message ?? "Incorrect PIN. Try again, or reply *menu* to cancel.";
        await sendText({ to: phone, text: msg });
        await issueSecretChallenge(phone, "awaiting_cancelmandate_pin", data, msg);
        return;
      }
      const result = await cancelMandate(member.cooperativeId, data.mandateId ?? "", {
        id: member.id,
        phone,
        role: member.role,
      });
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      await sendText({
        to: phone,
        text: result.message + "\n\nReply *menu* to see other options.",
      });
      break;
    }

    case "awaiting_insurance_product": {
      const input = text.trim().toLowerCase();
      if (input === "menu" || input === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({ to: phone, text: "Insurance cancelled. Reply *menu* to see options." });
        break;
      }
      let products: Product[];
      try {
        products = await insuranceService().getProducts();
      } catch {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Insurance is temporarily unavailable. No money was taken. Reply *menu* to return.",
        });
        break;
      }
      const product = products.find((p) => p.code.toLowerCase() === input);
      if (!product) {
        await sendText({
          to: phone,
          text: `Unknown product. Reply a code from the list (e.g. *${products[0]?.code ?? "..."}*) or *menu* to cancel.`,
        });
        break;
      }
      const plansText = product.plans
        .map(
          (p) =>
            `• *${p.code}* — ${formatBalance(p.premiumKobo)}/month, cover ${formatBalance(p.coverageKobo)}`,
        )
        .join("\n");
      const nextData = { insuranceProduct: product.code };
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_insurance_plan", data: JSON.stringify(nextData) },
        update: { state: "awaiting_insurance_plan", data: JSON.stringify(nextData) },
      });
      await sendText({
        to: phone,
        text: `*${product.name}*\n${product.description}\n\nPlans:\n${plansText}\n\nReply a plan code (e.g. *${product.plans[0]?.code ?? "..."}*) to continue, or *menu* to cancel.`,
      });
      break;
    }

    case "awaiting_insurance_plan": {
      const input = text.trim().toLowerCase();
      if (input === "menu" || input === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({ to: phone, text: "Insurance cancelled. Reply *menu* to see options." });
        break;
      }
      const productCode = data.insuranceProduct ?? data.productCode ?? "";
      let products: Product[];
      try {
        products = await insuranceService().getProducts();
      } catch {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Insurance is temporarily unavailable. No money was taken. Reply *menu* to return.",
        });
        break;
      }
      const product = products.find((p) => p.code === productCode);
      const plan = product?.plans.find((p) => p.code.toLowerCase() === input);
      if (!product || !plan) {
        await sendText({
          to: phone,
          text: `Unknown plan. Reply a plan code from *${productCode}* or *menu* to cancel.`,
        });
        break;
      }
      const nextData = {
        insuranceProduct: product.code,
        productCode: product.code,
        insurancePlan: plan.code,
        premiumKobo: plan.premiumKobo,
      };
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_insurance_confirm", data: JSON.stringify(nextData) },
        update: { state: "awaiting_insurance_confirm", data: JSON.stringify(nextData) },
      });
      await sendText({
        to: phone,
        text: `Confirm *${product.name}* — *${plan.name}* at ${formatBalance(plan.premiumKobo)}/month (cover ${formatBalance(plan.coverageKobo)})?\n\nReply *yes* to confirm or *no* to cancel.`,
      });
      break;
    }

    case "awaiting_insurance_confirm": {
      const answer = text.trim().toLowerCase();
      if (answer === "yes" || answer === "y") {
        const member = await getMemberByPhone(phone);
        if (!member) {
          await sendText({
            to: phone,
            text: "You need to join a cooperative first. Reply *join <code>* to get started.",
          });
          break;
        }
        const productCode = data.productCode ?? data.insuranceProduct ?? "";
        const planCode = data.insurancePlan ?? "";
        try {
          const policy = await insuranceService().purchasePlan(
            member.cooperativeId,
            member.id,
            productCode,
            planCode,
          );
          await sendText({
            to: phone,
            text: `✅ Your *${productCode}* cover is active (plan *${planCode}*). Policy ref *${policy.id.slice(0, 8)}*.\n\nReply *menu* to return.`,
          });
        } catch {
          await sendText({
            to: phone,
            text: "We couldn't complete the purchase right now (insurance service unavailable). No money was taken. Please try again later. Reply *menu*.",
          });
        }
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
      } else if (answer === "no" || answer === "n") {
        await sendText({
          to: phone,
          text: "Insurance purchase cancelled. Reply *menu* to see options.",
        });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
      } else {
        await sendText({ to: phone, text: "Please reply *yes* to confirm or *no* to cancel." });
      }
      break;
    }

    case "awaiting_death_cert": {
      const cert = text.trim();
      if (!cert) {
        await sendText({
          to: phone,
          text: "Please send the death certificate (photo, document or reference details).",
        });
        return;
      }
      const result = await submitCertificate(data.deathClaimId ?? "", cert);
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle" },
      });
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_delete_account_pin": {
      const input = text.trim();
      if (input.toLowerCase() === "menu" || input.toLowerCase() === "cancel") {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle" },
          update: { state: "idle", data: "{}" },
        });
        await sendText({
          to: phone,
          text: "Account deletion cancelled. Reply *menu* to start something else.",
        });
        return;
      }
      const { handleDeleteAccountPin } = await import("./admin-actions.js");
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      await handleDeleteAccountPin(phone, input);
      break;
    }

    case "literacy_quiz": {
      const memberId = data.memberId as string | undefined;
      const quiz = data.quiz as QuizState | undefined;
      if (!memberId || !quiz) {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
        break;
      }
      const choice = QUIZ_LETTERS.indexOf(text.trim().toUpperCase());
      const q = QUIZ_QUESTIONS.find((x) => x.id === quiz.questionIds[quiz.index]);
      if (!q || choice < 0 || choice >= q.options.length) {
        await sendText({ to: phone, text: "Please reply with *A*, *B*, *C* or *D*." });
        await sendQuizQuestion(phone, quiz);
        return;
      }
      const answers = [...quiz.answers, choice];
      const nextIndex = quiz.index + 1;
      if (nextIndex < quiz.questionIds.length) {
        const nextQuiz: QuizState = { ...quiz, index: nextIndex, answers };
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "literacy_quiz",
            data: JSON.stringify({ memberId, quiz: nextQuiz }),
          },
          update: { state: "literacy_quiz", data: JSON.stringify({ memberId, quiz: nextQuiz }) },
        });
        await sendQuizQuestion(phone, nextQuiz);
        return;
      }
      // Quiz complete — score it.
      const score = quiz.questionIds.reduce((acc, qid, i) => {
        const question = QUIZ_QUESTIONS.find((x) => x.id === qid);
        return acc + (question && answers[i] === question.answerIndex ? 1 : 0);
      }, 0);
      const member = await prisma.member.findUnique({ where: { id: memberId } });
      const coopConfig = member ? await getCoopConfig(member.cooperativeId) : null;
      const passMark = coopConfig?.literacyQuizPassMark ?? 4;
      const passed = score >= passMark;
      await prisma.memberProgress.update({
        where: { memberId },
        data: {
          quizAttempts: { increment: 1 },
          quizScore: score,
          ...(passed ? { quizPassedAt: new Date() } : {}),
        },
      });
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle", data: "{}" },
        update: { state: "idle", data: "{}" },
      });
      if (passed && member) {
        const cert = await issueCertificate({
          memberId,
          cooperativeId: member.cooperativeId,
          score,
          totalQuestions: quiz.questionIds.length,
          actorPhone: phone,
        });
        await deliverCertificate(phone, cert, member);
      } else {
        await sendText({
          to: phone,
          text:
            `You scored *${score}/${quiz.questionIds.length}*. You need *${passMark}* to pass.\n\n` +
            `Review the lessons (*class* / *replay N*) and retry with *class quiz*.`,
        });
      }
      break;
    }

    case "awaiting_literacy_optin": {
      const answer = text.trim().toLowerCase();
      const memberId = data.memberId as string | undefined;
      if (memberId && (answer === "yes" || answer === "y")) {
        await prisma.memberProgress.upsert({
          where: { memberId },
          create: { memberId, certificationOptIn: true },
          update: { certificationOptIn: true },
        });
        await sendText({
          to: phone,
          text: "✅ You're enrolled! Learn at your own pace with *class*, then take the quiz with *class quiz*.",
        });
      } else {
        await sendText({
          to: phone,
          text: "No problem — you can enroll any time with *class*.",
        });
      }
      // Continue to the message-consent step.
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_optin", data: JSON.stringify({ memberId }) },
        update: { state: "awaiting_optin", data: JSON.stringify({ memberId }) },
      });
      await sendText({
        to: phone,
        text:
          "📱 *Message Consent*\n\n" +
          "Do you consent to receive messages from this cooperative? " +
          "This includes savings alerts, loan updates, and important notices.\n\n" +
          "Reply *YES* to opt-in or *NO* to skip.",
      });
      break;
    }

    case "awaiting_optin": {
      const answer = text.trim().toLowerCase();
      const memberId = data.memberId as string | undefined;
      if (!memberId) {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
        break;
      }
      if (answer === "yes" || answer === "y") {
        await prisma.member.update({
          where: { id: memberId },
          data: { optedOut: false, consentAt: new Date() },
        });
        invalidateMemberCache(phone);
        await prisma.dataConsent.create({
          data: {
            memberId,
            consentType: "messaging",
            granted: true,
          },
        });
        await sendText({
          to: phone,
          text: "✅ You're all set! You'll receive messages from your cooperative. Reply *menu* to see your options.",
        });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
      } else if (answer === "no" || answer === "n") {
        await prisma.member.update({
          where: { id: memberId },
          data: { optedOut: true },
        });
        invalidateMemberCache(phone);
        // Record the explicit decline too — a consent decision must be logged
        // either way, not only when granted (mirrors the AI-consent flow).
        await prisma.dataConsent.create({
          data: { memberId, consentType: "messaging", granted: false },
        });
        await sendText({
          to: phone,
          text: "You've been opted out of messages. You can still use *balance*, *statement* and the rest of the menu — reply *optin* any time to receive messages again.",
        });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
      } else {
        // Anything else (including the founder re-sending "menu") is not an answer.
        // Re-ask instead of silently recording a NO the member never gave.
        await sendText({ to: phone, text: MESSAGE_CONSENT_REASK });
      }
      break;
    }

    case "awaiting_ai_consent": {
      const answer = text.trim().toLowerCase();
      const memberId = data.memberId as string | undefined;
      if (!memberId) {
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
        break;
      }
      if (answer === "yes" || answer === "y") {
        await prisma.member.update({
          where: { id: memberId },
          data: { aiConsentAt: new Date() },
        });
        invalidateMemberCache(phone);
        await prisma.dataConsent.create({
          data: { memberId, consentType: "ai_processing", granted: true },
        });
        await sendText({ to: phone, text: AI_CONSENT_GRANTED });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
      } else if (answer === "no" || answer === "n") {
        await prisma.dataConsent.create({
          data: { memberId, consentType: "ai_processing", granted: false },
        });
        await sendText({ to: phone, text: AI_CONSENT_DECLINED });
        await prisma.session.upsert({
          where: { phone },
          create: { phone, state: "idle", data: "{}" },
          update: { state: "idle", data: "{}" },
        });
      } else {
        // Anything else is not an answer — re-ask (session stays in this state).
        await sendText({ to: phone, text: AI_CONSENT_REASK });
      }
      break;
    }

    case "awaiting_ai_confirm": {
      const answer = text.trim().toLowerCase();
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      if (answer === "yes" || answer === "1" || answer === "ok") {
        const proposed = [data.aiCommand, ...(data.aiArgs ?? [])].filter(Boolean).join(" ");
        const { handleMessage } = await import("../conversation.js");
        await handleMessage(phone, proposed);
        return;
      }
      await sendText({ to: phone, text: "Okay, cancelled. Reply *menu* to see your options." });
      break;
    }

    case "awaiting_dividend_confirm": {
      const rate = data.dividendRate;
      // Always leave the confirming state first so a malformed/again reply
      // cannot re-trigger a payout.
      await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
      if (!rate || rate <= 0) {
        await sendText({
          to: phone,
          text: "That dividend request expired. Reply *paydividend <rate>* to start again.",
        });
        break;
      }
      // Exact match on the token shown in the preview — a casual "yes" is not
      // enough to move money to every member's bank account.
      if (text.trim().toUpperCase() !== `CONFIRM ${rate}`) {
        await sendText({
          to: phone,
          text: "Dividend cancelled. Nothing was paid. Reply *paydividend <rate>* to start again.",
        });
        break;
      }
      await sendText({
        to: phone,
        text: "⏳ Processing the dividend run — sending bank transfers now…",
      });
      const dividendResult = await confirmDividendDistribution(phone, rate);
      await sendText({ to: phone, text: dividendResult.message });
      break;
    }

    case "awaiting_sharedividend_confirm": {
      const rate = data.shareDividendRate;
      await prisma.session.update({ where: { phone }, data: { state: "idle", data: "{}" } });
      if (!rate || rate <= 0) {
        await sendText({
          to: phone,
          text: "That share-dividend request expired. Reply *paysharedividend <rate>* to start again.",
        });
        break;
      }
      if (text.trim().toUpperCase() !== `CONFIRM ${rate}`) {
        await sendText({
          to: phone,
          text: "Share dividend cancelled. Nothing was paid. Reply *paysharedividend <rate>* to start again.",
        });
        break;
      }
      await sendText({
        to: phone,
        text: "⏳ Processing the share dividend run — sending bank transfers now…",
      });
      const result = await confirmDividendDistribution(phone, rate, "shares");
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "awaiting_ai_query_confirm": {
      const answer = text.trim().toLowerCase();
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle", data: "{}" },
      });
      if (answer === "yes" || answer === "1" || answer === "ok") {
        await sendText({
          to: phone,
          text: "Great! Reply *menu* to see your options, or ask me anything else.",
        });
      } else if (answer === "no" || answer === "0") {
        await sendText({
          to: phone,
          text: "Got it. Reply *menu* to see your options, or try asking differently.",
        });
      } else {
        await sendText({ to: phone, text: "Reply *menu* to see your options." });
      }
      break;
    }

    case "awaiting_onboard_name": {
      const coopName = text.trim().replace(/\s+/g, " ");
      if (!coopName || coopName.length < 3) {
        await sendText({
          to: phone,
          text: "Please enter your cooperative name (at least 3 characters).",
        });
        return;
      }
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "awaiting_onboard_code", data: JSON.stringify({ coopName }) },
        update: { state: "awaiting_onboard_code", data: JSON.stringify({ coopName }) },
      });
      await sendText({
        to: phone,
        text: `Great — *${coopName}*!\n\nNow choose a short code for your cooperative (e.g. *LAG01*). This is what members will use to join.`,
      });
      break;
    }

    case "awaiting_onboard_code": {
      const code = text
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (!code || code.length < 3 || code.length > 10) {
        await sendText({
          to: phone,
          text: "Code should be 3-10 characters (letters and numbers only), e.g. *LAG01*.",
        });
        return;
      }
      const existing = await prisma.cooperative.findUnique({ where: { code } });
      if (existing) {
        await sendText({ to: phone, text: `Code *${code}* is already taken. Choose another.` });
        return;
      }
      const prevData1 = safeParse(dataJson);
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_onboard_state",
          data: JSON.stringify({ ...prevData1, coopCode: code }),
        },
        update: {
          state: "awaiting_onboard_state",
          data: JSON.stringify({ ...prevData1, coopCode: code }),
        },
      });
      await sendText({
        to: phone,
        text: `Code *${code}* is available ✅\n\nWhich state is your cooperative in? (e.g. *Lagos*, *Abuja*) Reply *skip* to skip.`,
      });
      break;
    }

    case "awaiting_onboard_state": {
      const state = text.trim();
      const stateValue = state.toLowerCase() === "skip" ? null : state;
      const prevData2 = safeParse(dataJson);
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_onboard_phone",
          data: JSON.stringify({ ...prevData2, coopState: stateValue }),
        },
        update: {
          state: "awaiting_onboard_phone",
          data: JSON.stringify({ ...prevData2, coopState: stateValue }),
        },
      });
      await sendText({
        to: phone,
        text: `Almost done! What's your *phone number*? (e.g. *08012345678*) This will be the admin account for your cooperative.`,
      });
      break;
    }

    case "awaiting_onboard_phone": {
      const adminPhone = normalizePhone(text);
      if (!adminPhone) {
        await sendText({
          to: phone,
          text: "That doesn't look like a valid number. Try e.g. *08012345678* or *+2348012345678*.",
        });
        return;
      }
      const prevData3 = safeParse(dataJson) as any;
      const coopNameVal = prevData3.name ?? prevData3.coopName ?? "";
      const coopCodeVal = prevData3.coopCode ?? "";
      const coopStateVal = prevData3.coopState ?? null;

      await provisionCooperative({
        name: coopNameVal,
        code: coopCodeVal,
        state: coopStateVal,
        adminPhone,
      });

      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle", data: "{}" },
        update: { state: "idle", data: "{}" },
      });
      break;
    }

    default:
      await prisma.session.upsert({
        where: { phone },
        create: { phone, state: "idle" },
        update: { state: "idle" },
      });
      await sendText({ to: phone, text: buildMenu(null) });
  }
}
