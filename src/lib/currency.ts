/**
 * Currency registry. One currency per cooperative; money is stored as integer
 * minor units (kobo-style). All shipped currencies are 2-decimal.
 */

export interface CurrencyMeta {
  code: string;
  symbol: string;
  locale: string;
  decimals: number;
  providers: string[];
}

export const DEFAULT_CURRENCY = "NGN";

export const SUPPORTED_CURRENCIES: Record<string, CurrencyMeta> = {
  NGN: { code: "NGN", symbol: "₦", locale: "en-NG", decimals: 2, providers: ["monnify", "paystack", "flutterwave"] },
  GHS: { code: "GHS", symbol: "₵", locale: "en-GH", decimals: 2, providers: ["paystack", "flutterwave"] },
  KES: { code: "KES", symbol: "KSh", locale: "en-KE", decimals: 2, providers: ["paystack", "flutterwave"] },
  ZAR: { code: "ZAR", symbol: "R", locale: "en-ZA", decimals: 2, providers: ["paystack", "flutterwave"] },
  USD: { code: "USD", symbol: "$", locale: "en-US", decimals: 2, providers: ["paystack", "flutterwave"] },
  UGX: { code: "UGX", symbol: "USh", locale: "en-UG", decimals: 2, providers: ["flutterwave"] },
  TZS: { code: "TZS", symbol: "TSh", locale: "en-TZ", decimals: 2, providers: ["flutterwave"] },
  RWF: { code: "RWF", symbol: "FRw", locale: "en-RW", decimals: 2, providers: ["flutterwave"] },
  XOF: { code: "XOF", symbol: "CFA", locale: "fr-SN", decimals: 2, providers: ["flutterwave"] },
  ZMW: { code: "ZMW", symbol: "ZK", locale: "en-ZM", decimals: 2, providers: ["flutterwave"] },
  MWK: { code: "MWK", symbol: "MK", locale: "en-MW", decimals: 2, providers: ["flutterwave"] },
};

export function currencyMeta(code: string): CurrencyMeta {
  return SUPPORTED_CURRENCIES[code?.toUpperCase()] ?? SUPPORTED_CURRENCIES[DEFAULT_CURRENCY];
}

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, code?.toUpperCase() ?? "");
}

export function providersForCurrency(code: string): string[] {
  return currencyMeta(code).providers;
}

export function formatMoney(kobo: number, code: string): string {
  const meta = currencyMeta(code);
  const major = kobo / 10 ** meta.decimals;
  const grouped = major.toLocaleString(meta.locale, {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  });
  return `${meta.symbol}${grouped}`;
}
