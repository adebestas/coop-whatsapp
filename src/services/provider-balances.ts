/**
 * Provider wallet balances, for reconciliation only.
 *
 * Every value is returned in kobo so it can be compared directly with
 * `assets:bank` journal postings. A provider that is not configured, times out
 * or answers with an unexpected shape returns `null` — this module never
 * throws, because a nightly job must not fail because one dashboard is down.
 */

const TIMEOUT_MS = 10_000;

export type ProviderName = "paystack" | "flutterwave" | "monnify";

export interface ProviderBalance {
  provider: ProviderName;
  configured: boolean;
  /** Balance in kobo, or null when unavailable. */
  kobo: number | null;
  error?: string;
}

function nairaToKobo(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function paystackBalance(): Promise<ProviderBalance> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return { provider: "paystack", configured: false, kobo: null };

  try {
    const res = await fetch("https://api.paystack.co/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const ngn = json.data?.find((row) => row.currency === "NGN");
    const raw = ngn?.balance;
    const kobo = typeof raw === "number" ? Math.round(raw) : nairaToKobo(raw);
    if (kobo === null) throw new Error("no NGN balance in response");
    return { provider: "paystack", configured: true, kobo };
  } catch (err) {
    return {
      provider: "paystack",
      configured: true,
      kobo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function flutterwaveBalance(): Promise<ProviderBalance> {
  const key = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!key) return { provider: "flutterwave", configured: false, kobo: null };

  try {
    const res = await fetch("https://api.flutterwave.com/v3/balances", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const ngn = json.data?.find((row) => row.currency === "NGN");
    const kobo = nairaToKobo(ngn?.available_balance ?? ngn?.balance);
    if (kobo === null) throw new Error("no NGN balance in response");
    return { provider: "flutterwave", configured: true, kobo };
  } catch (err) {
    return {
      provider: "flutterwave",
      configured: true,
      kobo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function monnifyToken(): Promise<string> {
  const basic = Buffer.from(
    `${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`,
  ).toString("base64");
  const res = await fetch("https://api.monnify.com/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`auth HTTP ${res.status}`);
  const json = (await res.json()) as { responseBody?: { accessToken?: string } };
  const token = json.responseBody?.accessToken;
  if (!token) throw new Error("auth response missing accessToken");
  return token;
}

async function monnifyBalance(): Promise<ProviderBalance> {
  const configured = Boolean(
    process.env.MONNIFY_API_KEY &&
    process.env.MONNIFY_SECRET_KEY &&
    process.env.MONNIFY_CONTRACT_CODE,
  );
  if (!configured) return { provider: "monnify", configured: false, kobo: null };

  try {
    const token = await monnifyToken();
    const res = await fetch("https://api.monnify.com/api/v2/disbursements/wallet/balance", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const body = asRecord(json.responseBody) ?? json;
    const kobo = nairaToKobo(body.availableBalance ?? body.ledgerBalance ?? body.balance);
    if (kobo === null) throw new Error("no balance in response");
    return { provider: "monnify", configured: true, kobo };
  } catch (err) {
    return {
      provider: "monnify",
      configured: true,
      kobo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Fetch every configured provider balance concurrently. */
export async function providerBalances(): Promise<ProviderBalance[]> {
  return Promise.all([paystackBalance(), flutterwaveBalance(), monnifyBalance()]);
}
