export interface Lesson {
  id: number;
  title: string;
  content: string;
}

export const FIVE_LESSONS: Lesson[] = [
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
• Interest is *10% flat* (not compounding, so it never grows the longer you take to plan)
• There's a one-time *₦2,000 service charge*
• You choose a duration: *6 months* or *11 months*

*Example:* if you've saved ₦50,000, you can borrow up to ₦100,000. At 10% flat, that's ₦10,000 interest, plus the ₦2,000 charge.

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
  return FIVE_LESSONS.find((l) => l.id === id);
}

export function getTotalLessons(): number {
  return FIVE_LESSONS.length;
}
