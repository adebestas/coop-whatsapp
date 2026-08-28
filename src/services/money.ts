/**
 * Money helpers. All monetary values are stored as kobo integers (NGN * 100).
 * Every write path MUST pass amounts through roundMoney to ensure integer
 * consistency. Rounding uses Math.round for nearest-kobo precision.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}
