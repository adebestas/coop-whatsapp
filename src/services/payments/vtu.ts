/**
 * Gated Value-Added-Service (VTU) provider adapter for airtime referral rewards.
 *
 * Nothing is enabled out of the box: `resolveVtuProvider()` returns null until
 * BOTH `VTU_PROVIDER` (the provider key) and `VTU_API_KEY` are set AND a matching
 * factory exists in `PROVIDER_FACTORIES` below. The referral flow treats null as
 * "airtime reward not enabled yet" and leaves the referral `qualified`, so the
 * reward is retried by the scheduler's payout reconciliation job (or an admin's
 * `referralpay`) once a provider is wired in — no change to the referral flow
 * itself, only a config/implementation addition here.
 *
 * No live provider is bundled: this file is the seam, not an integration.
 */

export interface VtuProvider {
  name: string;
  recharge(params: {
    phone: string;
    /** Amount to recharge, in KOBO (e.g. 50000 = ₦500). */
    amountKobo: number;
    reference: string;
  }): Promise<{ ok: boolean; providerRef?: string; error?: string }>;
}

/**
 * Provider factories keyed by `VTU_PROVIDER`. Empty until a real VTU provider is
 * integrated — add one factory here and set the env vars to enable airtime.
 */
const PROVIDER_FACTORIES: Record<string, (apiKey: string) => VtuProvider> = {};

/** The configured VTU provider, or null when airtime rewards are not enabled. */
export function resolveVtuProvider(): VtuProvider | null {
  const name = (process.env.VTU_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (process.env.VTU_API_KEY ?? "").trim();
  if (!name || !apiKey) return null;
  const factory = PROVIDER_FACTORIES[name];
  return factory ? factory(apiKey) : null;
}
