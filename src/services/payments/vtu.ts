/**
 * Gated Value-Added-Service (VTU) provider adapter for airtime referral rewards.
 *
 * Nothing is enabled out of the box: `resolveVtuProvider()` returns null until
 * `VTU_PROVIDER` (the provider key) names a factory in `PROVIDER_FACTORIES` below
 * AND that factory finds its own secret configured. The referral flow treats null
 * as "airtime reward not enabled yet" and leaves the referral `qualified`, so the
 * reward is retried by the scheduler's payout reconciliation job (or an admin's
 * `referralpay`) once a provider is wired in — no change to the referral flow
 * itself, only a config/implementation addition here.
 *
 * Implemented providers:
 *  - `flutterwave` — Flutterwave Bills API (https://developer.flutterwave.com/docs/bill-payment).
 *    Discovers the Airtime biller + item for each Nigerian network at runtime
 *    (categories -> billers -> items), cached in-process for 24h.
 *  - `monnify` — STUB. The Monnify VTU endpoint is not yet confirmed (their docs
 *    are unavailable); add the integration when the official endpoint is supplied.
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

/** Flutterwave API base for the v3 Bill Payments endpoints. */
const FLUTTERWAVE_BASE = "https://api.flutterwave.com/v3";
/** The Flutterwave bill category code for airtime. */
const AIRTIME_CATEGORY_CODE = "AIRTIME";
/** Biller/item discovery is cached for 24h; only a successful discovery is cached. */
const BILLER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type Network = "MTN" | "GLO" | "AIRTEL" | "9MOBILE";

/**
 * Nigerian mobile prefixes -> network. Prefixes are the local (national) 4- or
 * 5-digit forms; they are looked up after normalising the number to `0…`.
 * Prefix allocations change over time (porting, regulator re-assignments) — this
 * map covers the established blocks, and the network is only used to pick the
 * matching Flutterwave biller, so a stale entry degrades to a clear error rather
 * than a wrong recharge.
 */
const PREFIX_TO_NETWORK: Record<string, Network> = {
  // MTN
  "0803": "MTN",
  "0806": "MTN",
  "0703": "MTN",
  "0706": "MTN",
  "0813": "MTN",
  "0816": "MTN",
  "0810": "MTN",
  "0814": "MTN",
  "0903": "MTN",
  "0906": "MTN",
  "0913": "MTN",
  "0916": "MTN",
  "0704": "MTN",
  "07025": "MTN",
  "07026": "MTN",
  // GLO
  "0805": "GLO",
  "0807": "GLO",
  "0705": "GLO",
  "0815": "GLO",
  "0811": "GLO",
  "0905": "GLO",
  "0915": "GLO",
  // AIRTEL
  "0802": "AIRTEL",
  "0808": "AIRTEL",
  "0708": "AIRTEL",
  "0812": "AIRTEL",
  "0701": "AIRTEL",
  "0902": "AIRTEL",
  "0901": "AIRTEL",
  "0907": "AIRTEL",
  "0912": "AIRTEL",
  "0911": "AIRTEL",
  // 9MOBILE
  "0809": "9MOBILE",
  "0817": "9MOBILE",
  "0818": "9MOBILE",
  "0908": "9MOBILE",
  "0909": "9MOBILE",
};

/** Case-insensitive aliases used to match a Flutterwave biller name to a network. */
const NETWORK_ALIASES: Array<{ network: Network; aliases: string[] }> = [
  { network: "MTN", aliases: ["mtn"] },
  { network: "GLO", aliases: ["glo", "globacom"] },
  { network: "AIRTEL", aliases: ["airtel", "zain"] },
  { network: "9MOBILE", aliases: ["9mobile", "etisalat", "emts"] },
];

interface FlwCategory {
  code?: string;
  country_code?: string;
}
interface FlwBiller {
  biller_code?: string;
  name?: string;
  short_name?: string;
}
interface FlwItem {
  item_code?: string;
  is_airtime?: boolean;
  category_name?: string;
}
interface FlwEnvelope<T> {
  status?: string;
  message?: string;
  data?: T;
}
interface FlwPaymentData {
  tx_ref?: string;
  reference?: string;
}

/** A network's discovered Flutterwave airtime biller + item. */
interface AirtimeBiller {
  billerCode: string;
  itemCode: string;
}
type AirtimeBillerMap = Partial<Record<Network, AirtimeBiller>>;

let billerCache: { at: number; map: AirtimeBillerMap } | null = null;

/** Clear the in-process biller cache (tests; and to force re-discovery). */
export function clearVtuBillerCache(): void {
  billerCache = null;
}

/**
 * Normalise a Nigerian phone number (local `0803…`, `+234…` or `234…`) and map
 * it to a mobile network, or null when the prefix is unknown.
 */
export function networkForPhone(phone: string): Network | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  let local: string;
  if (digits.startsWith("234")) local = `0${digits.slice(3)}`;
  else if (digits.startsWith("0")) local = digits;
  else if (digits.length === 10) local = `0${digits}`;
  else return null;
  return PREFIX_TO_NETWORK[local.slice(0, 5)] ?? PREFIX_TO_NETWORK[local.slice(0, 4)] ?? null;
}

/** Match a biller's display name(s) to a network, or null when unrecognised. */
function classifyNetwork(...names: string[]): Network | null {
  const haystack = names.join(" ").toLowerCase();
  for (const { network, aliases } of NETWORK_ALIASES) {
    if (aliases.some((alias) => haystack.includes(alias))) return network;
  }
  return null;
}

/**
 * Discover the airtime biller + item code for each Nigerian network:
 * categories -> billers -> items. Throws on any upstream failure (so the caller
 * can decide), and never caches a partial/failed result.
 */
async function discoverAirtimeBillers(apiKey: string): Promise<AirtimeBillerMap> {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const categoryRes = await fetch(`${FLUTTERWAVE_BASE}/top-bill-categories?country=NG`, {
    method: "GET",
    headers,
  });
  const categories = (await categoryRes.json()) as FlwEnvelope<FlwCategory[]>;
  const category = categories.data?.find(
    (c) => c.country_code === "NG" && (c.code ?? "").toUpperCase() === AIRTIME_CATEGORY_CODE,
  );
  if (categories.status !== "success" || !category?.code) {
    throw new Error(categories.message || "Flutterwave airtime category not available");
  }

  const billerRes = await fetch(
    `${FLUTTERWAVE_BASE}/bills/${category.code}/billers?country=NG`,
    { method: "GET", headers },
  );
  const billers = (await billerRes.json()) as FlwEnvelope<FlwBiller[]>;
  if (billers.status !== "success" || !Array.isArray(billers.data)) {
    throw new Error(billers.message || "Flutterwave airtime billers not available");
  }

  const map: AirtimeBillerMap = {};
  for (const biller of billers.data) {
    if (!biller.biller_code) continue;
    const network = classifyNetwork(biller.name ?? "", biller.short_name ?? "");
    if (!network || map[network]) continue;

    const itemRes = await fetch(`${FLUTTERWAVE_BASE}/billers/${biller.biller_code}/items`, {
      method: "GET",
      headers,
    });
    const items = (await itemRes.json()) as FlwEnvelope<FlwItem[]>;
    const airtimeItem =
      items.data?.find((i) => i.is_airtime === true) ??
      items.data?.find((i) => (i.category_name ?? "").toLowerCase() === "airtime");
    if (airtimeItem?.item_code) {
      map[network] = { billerCode: biller.biller_code, itemCode: airtimeItem.item_code };
    }
  }
  return map;
}

/** Return the cached airtime biller map, discovering it on first use. */
async function getAirtimeBillers(apiKey: string): Promise<AirtimeBillerMap> {
  const now = Date.now();
  if (billerCache && now - billerCache.at < BILLER_CACHE_TTL_MS) return billerCache.map;
  const map = await discoverAirtimeBillers(apiKey);
  billerCache = { at: now, map };
  return map;
}

/** Build a Flutterwave Bills airtime provider bound to `apiKey`. */
function createFlutterwaveProvider(apiKey: string): VtuProvider {
  return {
    name: "flutterwave",
    async recharge({ phone, amountKobo, reference }) {
      const network = networkForPhone(phone);
      if (!network) {
        return {
          ok: false,
          error: `Unrecognized Nigerian mobile number "${phone}" — cannot determine the network.`,
        };
      }

      // Airtime is bought in whole naira; kobo is rounded to the nearest naira.
      const amount = Math.round(amountKobo / 100);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: `Invalid recharge amount (${amountKobo} kobo).` };
      }

      let billers: AirtimeBillerMap;
      try {
        billers = await getAirtimeBillers(apiKey);
      } catch (err) {
        return {
          ok: false,
          error: `Flutterwave airtime biller lookup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const biller = billers[network];
      if (!biller) {
        return { ok: false, error: `Flutterwave has no airtime biller for ${network}.` };
      }

      try {
        const res = await fetch(
          `${FLUTTERWAVE_BASE}/billers/${biller.billerCode}/items/${biller.itemCode}/payment`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ country: "NG", customer_id: phone, amount, reference }),
          },
        );
        const body = (await res.json().catch(() => null)) as FlwEnvelope<FlwPaymentData> | null;
        if (body?.status === "success") {
          const providerRef = body.data?.tx_ref ?? body.data?.reference ?? reference;
          return { ok: true, providerRef };
        }
        return {
          ok: false,
          error: body?.message ?? `Flutterwave bill payment failed (HTTP ${res.status}).`,
        };
      } catch (err) {
        return {
          ok: false,
          error: `Flutterwave bill payment request failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  };
}

/**
 * Provider factories keyed by `VTU_PROVIDER`. Each factory owns its own secret
 * and returns null when that secret is unset, so `resolveVtuProvider()` gates
 * airtime rewards on both the provider choice and its credentials.
 */
const PROVIDER_FACTORIES: Record<string, () => VtuProvider | null> = {
  flutterwave: () => {
    const key = (process.env.FLUTTERWAVE_SECRET_KEY ?? process.env.VTU_API_KEY ?? "").trim();
    return key ? createFlutterwaveProvider(key) : null;
  },
  // TODO(monnify-vtu): implement once the official Monnify VTU endpoint is supplied.
  // Intentionally gated (null) — Monnify VTU docs were unavailable, so no endpoint is invented.
  monnify: () => null,
};

/** The configured VTU provider, or null when airtime rewards are not enabled. */
export function resolveVtuProvider(): VtuProvider | null {
  const name = (process.env.VTU_PROVIDER ?? "").trim().toLowerCase();
  if (!name) return null;
  const factory = PROVIDER_FACTORIES[name];
  return factory ? factory() : null;
}
