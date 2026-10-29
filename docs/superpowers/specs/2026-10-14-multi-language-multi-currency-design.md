# Multi-language + Multi-currency — Design

**Date:** 2026-10-14
**Roadmap:** `2026-10-06-coop-world-class-roadmap.md`, Feature 13 ("Multi-language + multi-currency")
**Status:** Approved (design), pending spec review → implementation plan

## 1. Problem

The platform is Nigeria-first and NGN-only in practice. `Cooperative.currency` exists
(default `"NGN"`) but is barely read; `formatBalance` (`src/lib/money.ts:26`) hardcodes `₦`
and `en-NG`; there are **65 hardcoded `₦` literals** across `src/`, and the payment adapters
hardcode `"NGN"` (paystack.ts:111,127,134,151,355; monnify.ts; flutterwave.ts) and `topup.ts`
rejects any non-NGN notification. Localization is a 5-locale keyword heuristic
(`src/lib/i18n.ts`) with a **3-key** dictionary; the LLM does dynamic translation only on the
AI-query path (`ai-query.ts:154`). There is **no per-member language preference** and no coop
default language. The roadmap promised multi-language + multi-currency; this design delivers both.

## 2. Goals

- **One currency per cooperative** (set at creation / by admin), platform-wide currency
  awareness: formatting, storage, limits, validation, admin config.
- **Provider routing by currency**: route money movement to a provider that supports the coop's
  currency.
- **Hybrid localization**: a deterministic dictionary for critical strings (money, commands,
  errors, confirmations) in the 5 supported languages; the LLM keeps handling conversational
  replies.
- **Language resolution**: member preference → coop default → auto-detect.
- Member command to set language; admin commands to set coop currency + default language.
- **Country awareness**: infer the cooperative's country from the admin's phone number at creation
  and set the currency from it (country → currency map); admin can override.
- **Language understanding**: translate non-English member input to English before command parsing,
  so commands work in every supported language (not just replies).

## 3. Non-goals

- No FX conversion / multi-currency wallets (one currency per cooperative).
- No languages beyond `en`, `pidgin`, `hausa`, `yoruba`, `igbo`.
- No voice replies (voice-note transcription already exists — `src/lib/transcribe.ts`).
- No change to the integer-minor-unit storage model.

## 4. Data model

All schema changes go in **both** `prisma/schema.prisma` and `prisma/schema.local.prisma`
(enforced by `tests/schema-sync.test.ts`) plus a Postgres migration
`prisma/migrations/<ts>_multi_currency_locale/migration.sql`. **No new tables → RLS unchanged.**

### 4.1 `Cooperative`

- `currency String @default("NGN")` — already exists; add ISO-4217 allowlist validation at the
  write boundary (admin command).
- `locale String @default("en")` — **NEW**: the cooperative's default language.

### 4.2 `Member`

- `locale String?` — **NEW**: the member's language preference (`null` = inherit coop default /
  auto-detect).

## 5. Currency registry — `src/lib/currency.ts` (new)

```
interface CurrencyMeta {
  code: string;      // ISO 4217, e.g. "NGN"
  symbol: string;    // e.g. "₦"
  locale: string;    // Intl locale for grouping, e.g. "en-NG"
  decimals: number;  // minor-unit exponent (2 for all shipped currencies)
  providers: string[]; // providers that support this currency
}
```

Curated set (all 2-decimal):

| Code | Symbol | Locale | Providers |
|------|--------|--------|-----------|
| NGN | ₦ | en-NG | monnify, paystack, flutterwave |
| GHS | ₵ | en-GH | paystack, flutterwave |
| KES | KSh | en-KE | paystack, flutterwave |
| ZAR | R | en-ZA | paystack, flutterwave |
| USD | $ | en-US | paystack, flutterwave |
| UGX | USh | en-UG | flutterwave |
| TZS | TSh | en-TZ | flutterwave |
| RWF | FRw | en-RW | flutterwave |
| XOF | CFA | fr-SN | flutterwave |
| ZMW | ZK | en-ZM | flutterwave |
| MWK | MK | en-MW | flutterwave |

Helpers: `currencyMeta(code)`, `isSupportedCurrency(code)`, `formatMoney(kobo, code)`,
`providersForCurrency(code)`, `SUPPORTED_CURRENCIES`.

## 6. Runtime context — `src/lib/runtime-context.ts` (new)

An `AsyncLocalStorage<{ currency: string; locale: Locale }>` (mirrors the existing `txStorage`
in `prisma.ts` and `queueStorage` in `deferred.ts`).

- `withCoopContext(coopId, fn)` (`tenant-context.ts:32`) additionally sets `currency` + the coop
  default `locale`. The coop meta is fetched once and cached in-memory (keyed by coopId, TTL);
  the cache is invalidated when `setconfig currency|language` runs.
- `handleMessage` (`conversation.ts`) sets the member's **resolved** locale (preference → coop
  default → auto-detect) for the duration of the message.
- `getCurrency()` / `getLocale()` read the context (defaults `NGN` / `en`).
- `runWithCurrency(currency, fn)` / `runWithLocale(locale, fn)` for explicit scoping (webhooks,
  schedulers, tests).

## 7. Currency-aware formatting

- `formatBalance(kobo, currency?)` — if `currency` is passed, use it; otherwise `getCurrency()`;
  default `NGN`. **Signature stays backward-compatible → the 412 call sites are unchanged.**
- `formatMoney(kobo, code)` in `currency.ts` is the implementation.
- Replace the **65 hardcoded `₦` literals** (`ai-insights.ts`, `ai-query.ts`, `guarantors.ts`,
  `aml.ts`, `security-hardening.ts`, `ai-support.ts`, etc.) with `formatBalance`.
- `LIMITS` in `money.ts` stay in minor units (currency-agnostic); display via `formatBalance`.

## 8. Provider routing

- `resolveProvider(preferred?, currency?)` (`payments/index.ts:286`) — filter `ALL_PROVIDERS` to
  those supporting `currency` (from the registry), then apply the existing circuit-breaker order.
  Backward-compatible (currency optional).
- Adapters stop hardcoding `"NGN"` (paystack.ts:111,127,134,151,355; monnify.ts; flutterwave.ts) —
  pass the currency through.
- `topup.ts` accepts the coop's currency: validate the notification currency against the **coop's**
  currency (resolved via `withCoopContext`), not a hardcoded `NGN`.
- The currency→provider map lives in the registry (`providersForCurrency`).

## 9. Localization (hybrid)

- Expand the `i18n.ts` `DICTIONARY` for **critical** strings: money/balance, command
  confirmations, errors, key prompts. Keys namespaced (e.g. `money.balance`, `cmd.loan.approved`).
- `t(key, params?)` reads `getLocale()` from the context; keep an explicit-locale overload for
  tests and non-context callers.
- `languageInstruction(locale)` is unchanged; `ai-query.ts` uses the resolved locale.
- `detectLocale` remains the fallback when neither a member preference nor a coop default exists.

## 10. Commands & config

- **Member:** `language <en|pidgin|hausa|yoruba|igbo>` → sets `Member.locale`; `language` alone
  shows the current language + options.
- **Admin:** `setconfig currency <ISO>` (validated against the registry; blocked once any money
  has moved in the coop — see §15), `setconfig language <locale>` (coop default).
- `showconfig` lists currency + locale.

## 11. RLS

No new tables → no RLS changes. Currency/locale are columns on existing tables.

## 12. Cross-cutting requirements

- **Both schemas** + Postgres migration; `tests/schema-sync.test.ts` green.
- **Money:** integer minor units unchanged; all display via `formatBalance`.
- **Tenancy:** context set inside `withCoopContext`; explicit scoping helpers for non-coop paths.
- **Audit:** currency/locale config changes call `audit()`.
- **i18n:** new member-facing strings flow through `t()`.

## 13. Files touched

- `prisma/schema.prisma`, `prisma/schema.local.prisma`
- `prisma/migrations/<ts>_multi_currency_locale/migration.sql` (new)
- `src/lib/currency.ts` (new: registry + `formatMoney` + country↔currency + `countryFromPhone`)
- `src/lib/runtime-context.ts` (new: ALS context)
- `src/lib/translate.ts` (new: `translateToEnglish` via Groq)
- `src/lib/money.ts` (`formatBalance` currency-aware)
- `src/lib/i18n.ts` (dictionary expansion; context-aware `t`)
- `src/lib/tenant-context.ts` (set context in `withCoopContext`)
- `src/services/cooperative.ts` (`createCooperative` infers country/currency)
- `src/services/conversation.ts` (`handleMessage` sets locale + translates input; `language` command)
- `src/services/admin.ts` (`setconfig currency|language|country`; `showconfig`)
- `src/services/payments/index.ts` (`resolveProvider` currency filter)
- `src/services/payments/{paystack,monnify,flutterwave}.ts` (currency-aware)
- `src/services/payments/topup.ts` (accept coop currency)
- `src/lib/ai-query.ts`, `ai-insights.ts`, `ai-support.ts`, `guarantors.ts`, `aml.ts`,
  `security-hardening.ts` (replace `₦`)
- `tests/*` (see §14)

## 14. Tests (TDD)

- `tests/currency.test.ts`: registry lookups, `formatMoney` per currency, unsupported code.
- `tests/runtime-context.test.ts`: context set/read, defaults, nested scoping.
- `tests/currency-formatting.test.ts`: `formatBalance` uses context; explicit override wins.
- `tests/provider-routing.test.ts`: `resolveProvider` filters by currency; NGN-only monnify
  excluded for GHS.
- `tests/i18n.test.ts` (extend): dictionary coverage for all 5 locales; `t()` reads context.
- `tests/locale-resolution.test.ts`: member pref → coop default → auto-detect.
- `tests/country-currency.test.ts`: country↔currency maps, `countryFromPhone`, `createCooperative` inference.
- `tests/translate.test.ts`: `translateToEnglish` passthrough for `en`/no-Groq, translation + cache, fail-open.
- `tests/schema-sync.test.ts`: green (new columns).
- Existing suite stays green.

**Verification gate per the roadmap:** `npm run typecheck` clean · `npm run lint` 0 errors ·
full suite green · schema-sync green.

## 15. Open questions (defaults chosen; confirm during plan)

1. **Currency change after money moved:** block vs allow-with-warning. **Default:** block once any
   wallet/loan/ledger row exists for the coop.
2. **Which currencies to ship:** the curated set in §5. **Default:** ship all listed.
3. **Decimal places:** assume 2 for all shipped currencies. **Default:** 2 (documented).
4. **Locale storage:** `Member.locale` nullable. **Default:** `null` = inherit coop default.

## 16. Country → currency inference

Because the platform targets multiple countries, the system must know a cooperative's country and
its currency without the admin having to type an ISO code.

- **Country → currency map** lives in the registry (`src/lib/currency.ts`):
  `COUNTRY_CURRENCY` (NG→NGN, GH→GHS, KE→KES, ZA→ZAR, US→USD, UG→UGX, TZ→TZS, RW→RWF, SN→XOF,
  ZM→ZMW, MW→MWK) with helpers `currencyForCountry(country)` (fallback `NGN`) and
  `countryForCurrency(currency)` (fallback `NG`).
- **Phone → country**: `countryFromPhone(phone)` maps an E.164 calling-code prefix to an ISO
  country (longest-prefix match): +234→NG, +233→GH, +254→KE, +27→ZA, +1→US, +256→UG, +255→TZ,
  +250→RW, +221→SN, +260→ZM, +265→MW. Returns `null` for a non-E.164 / unknown number.
- **At creation**: `createCooperative()` (`src/services/cooperative.ts:371`) infers `country` from
  `adminPhone` when not supplied, then sets `currency = currencyForCountry(country)`. Explicit
  `country`/`currency` arguments win.
- **Admin override**: `setconfig country <ISO>` sets `country` and re-derives `currency` (blocked
  once money has moved, same guard as `setconfig currency`); `showconfig` lists country.

## 17. Language understanding (translate to English)

The deterministic command parser only understands English; the LLM understands the local languages
but cannot execute money commands. To let members *use* commands in their own language:

- **New module** `src/lib/translate.ts`: `translateToEnglish(text, locale)` — returns `text`
  unchanged when `locale === "en"`, the text is blank, or Groq is unavailable; otherwise calls Groq
  (`groqFetch`, `temperature: 0`) with a "translate to English, output only the translation" system
  prompt. Results are cached in-memory (keyed `locale:text`, bounded). **Fail-open**: any error
  returns the original text.
- **Wiring**: in `handleMessage`, after the member's locale is resolved from the **original** text
  (so auto-detect still sees the local-language signal), the text is translated to English and the
  English text is passed to `handleMessageInner` for command parsing. The reply language is still
  the member's resolved locale (set via `runWithLocale`), so the bot answers in the member's
  language while understanding the command.
- **Cost/latency**: one cached Groq call per distinct non-English message; skipped entirely for
  English members and when Groq is not configured.
- **Voice notes**: WhatsApp audio is already transcribed by Whisper (`src/lib/transcribe.ts`,
  `whisper-large-v3-turbo`) in the **source language**. Whisper also returns the detected
  `language`; the transcription result carries it, the webhook passes it as `MessageMeta.languageHint`,
  and `handleMessage` uses it as the translation trigger (falling back to `detectLocale` when the
  hint is absent or `"en"`, so Pidgin — which Whisper may report as `"en"` — is still caught). This
  makes local-language **voice commands** reliable, not just typed ones.
