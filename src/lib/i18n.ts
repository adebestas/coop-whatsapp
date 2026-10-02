/**
 * Lightweight localization for the AI-native assistant.
 *
 * The platform's audience is Nigeria-first, so English is the default but the
 * assistant should respond in the member's language (Pidgin, Hausa, Yoruba,
 * Igbo) when it can detect it from the conversation.
 *
 * This module provides:
 *   - `detectLocale(text)` — keyword heuristics to guess the language.
 *   - `t(locale, key, params?)` — deterministic string lookups with English
 *     fallback, used by the offline command/handler strings.
 *   - `languageInstruction(locale)` — a prompt suffix that tells the LLM which
 *     language to answer in (the LLM does the actual translation at runtime).
 *
 * Deterministic strings remain English unless translated here; the LLM path
 * localizes dynamically, which is the right split for a conversational AI.
 */

export type Locale = "en" | "pidgin" | "hausa" | "yoruba" | "igbo";

// Keyword heuristics. Ordered so more specific/overlapping languages win.
const SIGNALS: Record<Exclude<Locale, "en">, RegExp> = {
  pidgin:
    /\b(abi|wetin|dey|una|chop|wahala|sabi|guy|how far|no dey|make i|im|dem|dollars|e be|shey|abeg|vex|comot)\b/i,
  hausa:
    /\b(sannu|ina kwana|na gode|me ya faru|aiki|kudi|gida|mutum|yaya|don|za ku|aiwatar|runa|ban gane ba)\b/i,
  yoruba: /\b(bawo|e kaaro|e se|emi|kilo|owo|ile|eniyan|mo fe|ng|ti o|awon|ṣe|lati|wa|omo)\b/i,
  igbo: /\b(nno|kedu|daalu|ego|ulo|mmadu|gbasara|ihe|na-em|achoro|ọ|ụ|dị|ka|ndị|biko)\b/i,
};

export function detectLocale(text: string): Locale {
  const lower = text.toLowerCase();
  for (const [locale, pattern] of Object.entries(SIGNALS) as [Exclude<Locale, "en">, RegExp][]) {
    if (pattern.test(lower)) return locale;
  }
  return "en";
}

/** Tell the LLM which language to answer in. */
export function languageInstruction(locale: Locale): string {
  switch (locale) {
    case "pidgin":
      return "Reply in Nigerian Pidgin English.";
    case "hausa":
      return "Reply in Hausa.";
    case "yoruba":
      return "Reply in Yoruba.";
    case "igbo":
      return "Reply in Igbo.";
    default:
      return "Reply in English.";
  }
}

type Params = Record<string, string | number>;

const DICTIONARY: Record<string, Record<Locale, string>> = {
  "member.balance": {
    en: "💰 Your Balance",
    pidgin: "💰 Your money wey you get",
    hausa: "💰 Kudin ka",
    yoruba: "💰 Owo re",
    igbo: "💰 Ego gi",
  },
  "member.noLoan": {
    en: "You have no active loans.",
    pidgin: "You no get any loan wey dey active.",
    hausa: "Ba ka da wani rance mai aiki.",
    yoruba: "O ko ni awin to n lo.",
    igbo: "I nweghị ụgwọ ọ bụla na-arụ ọrụ.",
  },
  "fallback.unavailable": {
    en: "AI is not available right now.",
    pidgin: "AI no dey available now-now.",
    hausa: "AI ba ya nan yanzu.",
    yoruba: "AI ko si lọwọlọwọ.",
    igbo: "AI adịghị adị ugbu a.",
  },
};

export function t(locale: Locale, key: string, _params?: Params): string {
  const entry = DICTIONARY[key];
  if (!entry) return key;
  return entry[locale] ?? entry.en;
}
