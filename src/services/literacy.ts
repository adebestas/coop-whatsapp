export interface Lesson {
  id: number;
  title: string;
  content: string;
}

export const LESSONS: Lesson[] = [
  {
    id: 1,
    title: "Why Save Regularly",
    content: `📘 *Lesson 1: Why Save Regularly*

Small, steady savings beat big, occasional ones. When you save the same amount every month, your money grows in two ways: what you put in, plus the discipline that builds your loan eligibility over time.

Our minimum monthly contribution is *₦2,000*. That's not a small "extra" payment — it's the foundation your future loan access is built on, since your loan limit is tied directly to how much you've saved.

Reply *next* for Lesson 2, or ask me anything about your savings.`,
  },
  {
    id: 2,
    title: "How Our Loan System Works",
    content: `📘 *Lesson 2: How Our Loan System Works*

Here's exactly how it works, no hidden math:

• You can borrow up to *2x your current savings balance*
• Interest is *declining balance* (interest calculated on remaining balance only, so it decreases as you repay)
• Rates by tenure: up to 3 months = 20% APR, 4-6 months = 16% APR, 7-9 months = 12% APR, 10-12 months = 10% APR
• There's a one-time *₦2,000 service charge*
• You choose a duration: *6 months* or *11 months*

*Example:* if you've saved ₦50,000, you can borrow up to ₦100,000. At 10% APR declining balance over 11 months, that's ~₦5,500 total interest, plus the ₦2,000 charge.

Reply *next* for Lesson 3.`,
  },
  {
    id: 3,
    title: "What the Reserve Fund Is For",
    content: `📘 *Lesson 3: What the Reserve Fund Is For*

A small part of every transaction goes into our Reserve Fund automatically. Think of it as the cooperative's safety net — it protects every member's savings, even if some loans are repaid late.

It's not admin money and it's not anyone's personal account. It belongs to the cooperative as a whole, and it's what allows us to keep lending responsibly without needing outside banks.

Reply *next* for Lesson 4.`,
  },
  {
    id: 4,
    title: "Being a Guarantor, What It Really Means",
    content: `📘 *Lesson 4: Being a Guarantor — What It Really Means*

If a fellow member asks you to guarantee their loan, here's what you're actually agreeing to:

• If they can't repay, you may become responsible for the outstanding balance
• Your own savings may be held (can't be withdrawn) while you're guaranteeing someone else's active loan
• Your own ability to take a loan may be paused until the loan you guaranteed is cleared

Guaranteeing someone isn't just a formality — it's real financial trust. Only guarantee someone whose repayment habits you genuinely trust.

Reply *next* for Lesson 5.`,
  },
  {
    id: 5,
    title: "Avoiding Loan Default",
    content: `📘 *Lesson 5: Avoiding Loan Default*

A few habits that keep you (and your guarantor) safe:

• Mark your repayment date somewhere you'll actually see it
• If you know a payment will be late, message us *before* the due date, not after
• Never borrow the full 2x limit "just because you can" — borrow what you actually need
• Keep contributing even while repaying a loan — it keeps your account healthy

Reply *next* for Lesson 6.`,
  },
  {
    id: 6,
    title: "Cooperative Insurance & Member Protection",
    content: `📘 *Lesson 6: Cooperative Insurance & Member Protection*

Many cooperatives provide insurance coverage to protect members. Here's what you should know:

• *Death Benefit Insurance*: If a member passes away, their outstanding loans may be covered by the cooperative's insurance, and their family may receive a death benefit from the cooperative's reserve fund.
• *Loan Protection Insurance*: Some cooperatives insure active loans so that if a member becomes incapacitated, the loan balance is covered.
• *Contributions Protection*: Your accumulated savings are protected by the cooperative's reserve fund, which acts as a safety net for all members.

*Important disclosures:*
• Insurance coverage is subject to the cooperative's byelaws and available funds
• Claims must be filed within the stipulated time (usually 30 days of the event)
• The cooperative reserve fund (20% of dividends) partially funds member protections

Reply *class progress* to review all lessons anytime.`,
  },
];

export function getLesson(id: number): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}

export function getTotalLessons(): number {
  return LESSONS.length;
}

export interface QuizQuestion {
  id: number;
  lessonId: number;
  question: string;
  options: string[];
  answerIndex: number;
}

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 1,
    lessonId: 1,
    question: "What is the minimum monthly contribution?",
    options: ["₦1,000", "₦2,000", "₦5,000", "₦10,000"],
    answerIndex: 1,
  },
  {
    id: 2,
    lessonId: 1,
    question: "Why does regular saving matter most?",
    options: [
      "It grows your loan eligibility over time",
      "It is only for emergencies",
      "It replaces your salary",
      "It has no real benefit",
    ],
    answerIndex: 0,
  },
  {
    id: 3,
    lessonId: 2,
    question: "How much can you borrow at most?",
    options: [
      "Up to 1x your savings",
      "Up to 2x your savings",
      "Up to 5x your savings",
      "There is no limit",
    ],
    answerIndex: 1,
  },
  {
    id: 4,
    lessonId: 2,
    question: "How is loan interest calculated?",
    options: [
      "On the full amount forever",
      "On the remaining balance only",
      "On your savings only",
      "It is always fixed",
    ],
    answerIndex: 1,
  },
  {
    id: 5,
    lessonId: 3,
    question: "What is the Reserve Fund for?",
    options: [
      "The admin's personal account",
      "A safety net that protects every member's savings",
      "Paying staff bonuses",
      "Outside bank investments",
    ],
    answerIndex: 1,
  },
  {
    id: 6,
    lessonId: 3,
    question: "Who does the Reserve Fund belong to?",
    options: [
      "The cooperative as a whole",
      "The super admin only",
      "The richest member",
      "The government",
    ],
    answerIndex: 0,
  },
  {
    id: 7,
    lessonId: 4,
    question: "If you guarantee a loan and the borrower defaults, what can happen?",
    options: [
      "Nothing changes for you",
      "You may become responsible for the outstanding balance",
      "You get a bonus",
      "Your loan limit increases",
    ],
    answerIndex: 1,
  },
  {
    id: 8,
    lessonId: 4,
    question: "What happens to your savings while you guarantee an active loan?",
    options: [
      "They are doubled",
      "They may be held and cannot be withdrawn",
      "They are moved to another bank",
      "Nothing",
    ],
    answerIndex: 1,
  },
  {
    id: 9,
    lessonId: 5,
    question: "What should you do if you know a repayment will be late?",
    options: [
      "Wait until they call you",
      "Message us before the due date",
      "Borrow more to cover it",
      "Ignore it",
    ],
    answerIndex: 1,
  },
  {
    id: 10,
    lessonId: 5,
    question: "What is the best borrowing habit?",
    options: [
      "Always borrow the full 2x limit",
      "Borrow what you actually need",
      "Borrow as often as possible",
      "Never repay on time",
    ],
    answerIndex: 1,
  },
  {
    id: 11,
    lessonId: 6,
    question: "What does Loan Protection Insurance cover?",
    options: [
      "Your phone",
      "Active loans if a member becomes incapacitated",
      "Your transport costs",
      "Nothing",
    ],
    answerIndex: 1,
  },
  {
    id: 12,
    lessonId: 6,
    question: "How is the cooperative reserve fund partially funded?",
    options: [
      "20% of dividends",
      "Member fines only",
      "Government grants",
      "Bank loans",
    ],
    answerIndex: 0,
  },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getQuizQuestions(count: number, seed = "default"): QuizQuestion[] {
  const pool = [...QUIZ_QUESTIONS];
  const rand = mulberry32(hashSeed(seed));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}
