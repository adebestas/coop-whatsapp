// Common Nigerian bank names -> provider bank codes.
export const BANK_CODES: Record<string, string> = {
  access: "044",
  accessbank: "044",
  gtb: "058",
  gtbank: "058",
  guarantee: "058",
  zenith: "057",
  uba: "033",
  firstbank: "011",
  first: "011",
  fbn: "011",
  union: "032",
  fidelity: "070",
  fcmb: "214",
  stanbic: "221",
  ibtc: "221",
  ecobank: "050",
  sterling: "232",
  wema: "035",
  polaris: "076",
  keystone: "082",
  unity: "215",
  jaiz: "301",
  providus: "101",
  kuda: "50211",
  opay: "50212",
  palmpay: "999992",
  moniepoint: "50515",
  fairmoney: "51318",
  globus: "030",
  tajbank: "302",
  xpension: "090",
  cullinan: "100",
  paycom: "100",
};

/** Resolve a bank code from a name (or accept a raw numeric code). */
export function resolveBankCode(input: string): { code: string; name: string } | null {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) {
    return { code: cleaned, name: input.trim() };
  }
  const code = BANK_CODES[cleaned];
  if (!code) return null;
  return { code, name: input.trim() };
}
