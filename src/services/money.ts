/**
 * Money helpers. All monetary values are NGN floats today; every write path
 * MUST pass amounts through roundMoney so balances stay on 2dp (Float drift
 * guard). Full integer-kobo storage migration is tracked in AUDIT.md.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

export function assertPositiveAmount(n: number): boolean {
  return Number.isFinite(n) && roundMoney(n) > 0;
}
