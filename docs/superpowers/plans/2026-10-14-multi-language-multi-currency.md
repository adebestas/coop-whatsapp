# Multi-language + Multi-currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform currency-aware (one currency per cooperative, provider routing by currency) and add hybrid localization (deterministic critical strings + LLM conversational) with a per-member language preference.

**Architecture:** A currency registry (`src/lib/currency.ts`) plus an AsyncLocalStorage runtime context (`src/lib/runtime-context.ts`) carry `{ currency, locale }` through the existing `withCoopContext` boundary. `formatBalance`/`t` read the context, so the 412 existing `formatBalance` call sites stay unchanged. Payment providers are selected by the cooperative's currency.

**Tech Stack:** TypeScript, Fastify, Prisma (Postgres + SQLite mirror), Vitest, Node `AsyncLocalStorage`.

**Spec:** `docs/superpowers/specs/2026-10-14-multi-language-multi-currency-design.md`

## Global Constraints

- **Both schemas identical:** every schema change goes in `prisma/schema.prisma` AND `prisma/schema.local.prisma` (enforced by `tests/schema-sync.test.ts`).
- **Money:** integer minor units (kobo) everywhere; all display via `formatBalance`; parse input with `parseNaira`.
- **Tenancy:** chat writes go through `withCoopContext`; the runtime context is set inside it.
- **Audit:** currency/locale config changes call `audit()`.
- **i18n:** new member-facing strings flow through `t()`.
- **Verification gate:** `npm run typecheck` clean · `npm run lint` 0 errors · full suite green · schema-sync green.
- **Test speed:** full `npx vitest run` takes ~11 min; run targeted files during iteration.
- **Commit policy:** do NOT commit unless the user explicitly asks. The commit steps below are intended checkpoints; skip them until the user approves committing.
- **Supported currencies:** NGN, GHS, KES, ZAR, USD, UGX, TZS, RWF, XOF, ZMW, MWK (all 2-decimal).
- **Supported locales:** `en`, `pidgin`, `hausa`, `yoruba`, `igbo`.

---

### Task 1: Currency registry

**Files:**
- Create: `src/lib/currency.ts`
- Test: `tests/currency.test.ts`

**Interfaces:**
- Produces: `CurrencyMeta`, `SUPPORTED_CURRENCIES`, `DEFAULT_CURRENCY`, `currencyMeta(code)`, `isSupportedCurrency(code)`, `providersForCurrency(code)`, `formatMoney(kobo, code)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/currency.test.ts
import { describe, it, expect } from "vitest";
import {
  currencyMeta,
  isSupportedCurrency,
  providersForCurrency,
  formatMoney,
  DEFAULT_CURRENCY,
} from "../src/lib/currency.js";

describe("currency registry", () => {
  it("defaults to NGN", () => {
    expect(DEFAULT_CURRENCY).toBe("NGN");
  });

  it("resolves a known currency", () => {
    expect(currencyMeta("GHS").symbol).toBe("₵");
    expect(currencyMeta("ghs").code).toBe("GHS");
  });

  it("falls back to NGN for an unknown currency", () => {
    expect(currencyMeta("XXX").code).toBe("NGN");
  });

  it("validates supported currencies", () => {
    expect(isSupportedCurrency("KES")).toBe(true);
    expect(isSupportedCurrency("kes")).toBe(true);
    expect(isSupportedCurrency("XXX")).toBe(false);
  });

  it("lists providers per currency", () => {
    expect(providersForCurrency("NGN")).toContain("monnify");
    expect(providersForCurrency("GHS")).not.toContain("monnify");
    expect(providersForCurrency("UGX")).toEqual(["flutterwave"]);
  });

  it("formats money with the right symbol and grouping", () => {
    expect(formatMoney(100050, "NGN")).toBe("₦1,000.50");
    expect(formatMoney(100050, "GHS")).toBe("₵1,000.50");
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/currency.test.ts`
Expected: FAIL — cannot find module `../src/lib/currency.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/currency.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/currency.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit** (only if the user has approved committing)

```bash
git add src/lib/currency.ts tests/currency.test.ts
git commit -m "feat(currency): add currency registry + formatMoney"
```

---

### Task 2: Runtime context

**Files:**
- Create: `src/lib/runtime-context.ts`
- Test: `tests/runtime-context.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CURRENCY` (Task 1); `Locale` type from `src/lib/i18n.ts`.
- Produces: `RuntimeContext`, `getCurrency()`, `getLocale()`, `runWithContext(ctx, fn)`, `runWithCurrency(currency, fn)`, `runWithLocale(locale, fn)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime-context.test.ts
import { describe, it, expect } from "vitest";
import {
  getCurrency,
  getLocale,
  runWithContext,
  runWithCurrency,
  runWithLocale,
} from "../src/lib/runtime-context.js";

describe("runtime context", () => {
  it("defaults to NGN / en outside any context", () => {
    expect(getCurrency()).toBe("NGN");
    expect(getLocale()).toBe("en");
  });

  it("reads currency and locale inside a context", () => {
    runWithContext({ currency: "GHS", locale: "yoruba" }, () => {
      expect(getCurrency()).toBe("GHS");
      expect(getLocale()).toBe("yoruba");
    });
  });

  it("nests and restores the outer context", () => {
    runWithCurrency("KES", () => {
      runWithLocale("igbo", () => {
        expect(getCurrency()).toBe("KES");
        expect(getLocale()).toBe("igbo");
      });
      expect(getLocale()).toBe("en");
    });
    expect(getCurrency()).toBe("NGN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime-context.test.ts`
Expected: FAIL — cannot find module `../src/lib/runtime-context.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/runtime-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_CURRENCY } from "./currency.js";
import type { Locale } from "./i18n.js";

export interface RuntimeContext {
  currency: string;
  locale: Locale;
}

const storage = new AsyncLocalStorage<RuntimeContext>();

export function getCurrency(): string {
  return storage.getStore()?.currency ?? DEFAULT_CURRENCY;
}

export function getLocale(): Locale {
  return storage.getStore()?.locale ?? "en";
}

export function runWithContext<T>(ctx: Partial<RuntimeContext>, fn: () => T): T {
  const current = storage.getStore();
  const next: RuntimeContext = {
    currency: ctx.currency ?? current?.currency ?? DEFAULT_CURRENCY,
    locale: ctx.locale ?? current?.locale ?? "en",
  };
  return storage.run(next, fn);
}

export function runWithCurrency<T>(currency: string, fn: () => T): T {
  return runWithContext({ currency }, fn);
}

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return runWithContext({ locale }, fn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtime-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/lib/runtime-context.ts tests/runtime-context.test.ts
git commit -m "feat(i18n): add runtime currency/locale context"
```

---

### Task 3: Currency-aware `formatBalance`

**Files:**
- Modify: `src/lib/money.ts:26-29`
- Test: `tests/currency-formatting.test.ts`

**Interfaces:**
- Consumes: `formatMoney` (Task 1), `getCurrency` (Task 2).
- Produces: `formatBalance(kobo, currency?)` — backward-compatible (currency optional).

- [ ] **Step 1: Write the failing test**

```ts
// tests/currency-formatting.test.ts
import { describe, it, expect } from "vitest";
import { formatBalance } from "../src/lib/money.js";
import { runWithCurrency } from "../src/lib/runtime-context.js";

describe("formatBalance", () => {
  it("defaults to NGN outside a context", () => {
    expect(formatBalance(100050)).toBe("₦1,000.50");
  });

  it("uses the runtime context currency", () => {
    runWithCurrency("GHS", () => {
      expect(formatBalance(100050)).toBe("₵1,000.50");
    });
  });

  it("lets an explicit currency override the context", () => {
    runWithCurrency("GHS", () => {
      expect(formatBalance(100050, "KES")).toBe("KSh1,000.50");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/currency-formatting.test.ts`
Expected: FAIL — `formatBalance` ignores the context (returns `₦` for GHS).

- [ ] **Step 3: Write minimal implementation**

Replace the `formatBalance` function in `src/lib/money.ts`:

```ts
import { formatMoney } from "./currency.js";
import { getCurrency } from "./runtime-context.js";

/**
 * Format a balance for display in the current cooperative's currency.
 * `currency` overrides the runtime context (default NGN).
 */
export function formatBalance(kobo: number, currency?: string): string {
  return formatMoney(kobo, currency ?? getCurrency());
}
```

(Keep `toKobo`, `toNaira`, `forProvider`, and `LIMITS` unchanged. Add the two imports at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/currency-formatting.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/lib/money.ts tests/currency-formatting.test.ts
git commit -m "feat(currency): make formatBalance currency-aware"
```

---

### Task 4: Schema — `Cooperative.locale` + `Member.locale`

**Files:**
- Modify: `prisma/schema.prisma` (Cooperative ~line 22; Member ~line 160)
- Modify: `prisma/schema.local.prisma` (same fields)
- Create: `prisma/migrations/<ts>_multi_currency_locale/migration.sql`
- Test: `tests/schema-sync.test.ts` (existing)

**Interfaces:**
- Produces: `Cooperative.locale: string` (default `"en"`), `Member.locale: string | null`.

- [ ] **Step 1: Add the fields to BOTH schemas**

In `prisma/schema.prisma` and `prisma/schema.local.prisma`, in `model Cooperative` immediately after `currency`:

```prisma
  locale             String              @default("en") // default member language
```

In `model Member` (after `preferredChannel`):

```prisma
  locale                  String? // member language preference (null = inherit coop default)
```

- [ ] **Step 2: Hand-write the Postgres migration**

The local `DATABASE_URL` is SQLite (`file:./dev.db`), so `prisma migrate dev` cannot run in this environment — migrations are Postgres SQL applied in production. Create the migration by hand, following the existing pattern (e.g. `prisma/migrations/20261010000000_name_verified/migration.sql`). The latest migration is `20261047000000_cubecover_insurance`, so use the next timestamp.

Create `prisma/migrations/20261048000000_multi_currency_locale/migration.sql`:

```sql
-- =============================================================================
-- Multi-currency + multi-language: Cooperative.locale + Member.locale
-- =============================================================================
-- Cooperative.locale is the coop's default member language; Member.locale is
-- the member's own preference (NULL = inherit the coop default / auto-detect).
-- =============================================================================

ALTER TABLE "Cooperative" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Member" ADD COLUMN "locale" TEXT;
```

- [ ] **Step 3: Push to the local SQLite DB and regenerate the client**

Run: `npx prisma db push --schema prisma/schema.local.prisma`
Expected: "Your database is now in sync with your Prisma schema." (This also regenerates the SQLite client.)

- [ ] **Step 4: Run the schema-sync test**

Run: `npx vitest run tests/schema-sync.test.ts`
Expected: PASS (both schemas identical).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations
git commit -m "feat(schema): add Cooperative.locale + Member.locale"
```

---

### Task 5: `withCoopContext` sets the runtime context

**Files:**
- Modify: `src/lib/tenant-context.ts:32-44`
- Test: `tests/coop-context-currency.test.ts`

**Interfaces:**
- Consumes: `runWithContext` (Task 2), `DEFAULT_CURRENCY` (Task 1).
- Produces: `getCoopMeta(coopId, tx?)`, `invalidateCoopMeta(coopId)`; `withCoopContext` now sets `{ currency, locale }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/coop-context-currency.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withCoopContext, invalidateCoopMeta } from "../src/lib/tenant-context.js";
import { getCurrency, getLocale } from "../src/lib/runtime-context.js";

describe("withCoopContext sets currency/locale", () => {
  let coopId: string;

  beforeEach(async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Ghana Coop", code: `GH${Date.now()}`, currency: "GHS", locale: "pidgin" },
    });
    coopId = coop.id;
    invalidateCoopMeta(coopId);
  });

  it("exposes the coop currency + locale inside the context", async () => {
    await withCoopContext(coopId, async () => {
      expect(getCurrency()).toBe("GHS");
      expect(getLocale()).toBe("pidgin");
    });
  });

  it("restores the default outside the context", async () => {
    await withCoopContext(coopId, async () => {});
    expect(getCurrency()).toBe("NGN");
    expect(getLocale()).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coop-context-currency.test.ts`
Expected: FAIL — `invalidateCoopMeta` is not exported / currency is `NGN`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/tenant-context.ts`, add imports and a cached meta lookup, and wrap `fn` in `runWithContext`:

```ts
import { runWithContext } from "./runtime-context.js";
import { DEFAULT_CURRENCY } from "./currency.js";
import type { Locale } from "./i18n.js";

interface CoopMeta { currency: string; locale: Locale; at: number; }
const coopMetaCache = new Map<string, CoopMeta>();
const COOP_META_TTL_MS = 5 * 60 * 1000;

export function invalidateCoopMeta(coopId: string): void {
  coopMetaCache.delete(coopId);
}

export async function getCoopMeta(
  coopId: string,
  tx: typeof prisma = prisma,
): Promise<{ currency: string; locale: Locale }> {
  const cached = coopMetaCache.get(coopId);
  if (cached && Date.now() - cached.at < COOP_META_TTL_MS) return cached;
  const coop = await tx.cooperative.findUnique({
    where: { id: coopId },
    select: { currency: true, locale: true },
  });
  const meta: CoopMeta = {
    currency: coop?.currency ?? DEFAULT_CURRENCY,
    locale: (coop?.locale ?? "en") as Locale,
    at: Date.now(),
  };
  coopMetaCache.set(coopId, meta);
  return meta;
}

export async function withCoopContext<T>(
  cooperativeId: string,
  fn: (tx: typeof prisma) => Promise<T>,
): Promise<T> {
  return withDeferredSends(() =>
    withTx(async (tx) => {
      await setCoopContext(tx as never, cooperativeId);
      const meta = await getCoopMeta(cooperativeId, tx as unknown as typeof prisma);
      return runWithContext({ currency: meta.currency, locale: meta.locale }, () =>
        fn(tx as unknown as typeof prisma),
      );
    }),
  );
}
```

Note: `getCoopMeta` reads the cooperative row **inside** the transaction (after `setCoopContext`), so it works under RLS on Postgres. The 5-minute cache avoids a query per message.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coop-context-currency.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the tenancy regression subset**

Run: `npx vitest run tests/conversation.test.ts tests/moneyflows.test.ts`
Expected: PASS (no regression from the extra meta lookup).

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/lib/tenant-context.ts tests/coop-context-currency.test.ts
git commit -m "feat(tenancy): set currency/locale in withCoopContext"
```

---

### Task 6: `handleMessage` sets the member locale + `language` command

**Files:**
- Modify: `src/services/conversation.ts` (`handleMessageInner` ~line 454; add a `language` case)
- Test: `tests/locale-resolution.test.ts`

**Interfaces:**
- Consumes: `runWithLocale` (Task 2), `detectLocale`/`Locale` (i18n), `getCoopMeta` (Task 5).
- Produces: `resolveMemberLocale(member, coopDefault, text): Locale`; the `language <code>` command.

- [ ] **Step 1: Write the failing test**

```ts
// tests/locale-resolution.test.ts
import { describe, it, expect } from "vitest";
import { resolveMemberLocale } from "../src/services/conversation.js";

describe("resolveMemberLocale", () => {
  it("prefers the member's stored preference", () => {
    expect(resolveMemberLocale({ locale: "yoruba" }, "hausa", "hello")).toBe("yoruba");
  });
  it("falls back to the coop default", () => {
    expect(resolveMemberLocale({ locale: null }, "hausa", "hello")).toBe("hausa");
  });
  it("falls back to auto-detect when neither is set", () => {
    expect(resolveMemberLocale({ locale: null }, "en", "bawo ni")).toBe("yoruba");
  });
  it("defaults to English when nothing matches", () => {
    expect(resolveMemberLocale({ locale: null }, "en", "hello")).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/locale-resolution.test.ts`
Expected: FAIL — `resolveMemberLocale` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/services/conversation.ts`, add the export:

```ts
import { detectLocale, type Locale } from "../lib/i18n.js";
import { runWithLocale, getLocale } from "../lib/runtime-context.js";

export const LOCALES: Locale[] = ["en", "pidgin", "hausa", "yoruba", "igbo"];

export function resolveMemberLocale(
  member: { locale?: string | null } | null,
  coopDefault: string,
  text: string,
): Locale {
  const pref = member?.locale as Locale | undefined;
  if (pref && LOCALES.includes(pref)) return pref;
  const coop = coopDefault as Locale;
  if (LOCALES.includes(coop) && coop !== "en") return coop;
  return detectLocale(text);
}
```

Then wrap the two `withCoopContext(...)` call sites in `handleMessage` (the single-coop branch at ~line 402 and the multi-coop branch at ~line 424) so the member's locale is active for the whole handler. Pre-load the member and pass it down to avoid a duplicate query:

```ts
// single-coop branch
if (coopId) {
  return withCoopContext(coopId, async () => {
    const member = await getMemberByPhone(phone, coopId);
    const locale = resolveMemberLocale(member, getLocale(), text);
    return runWithLocale(locale, () => handleMessageInner(phone, text, meta, coopId, member));
  });
}

// multi-coop branch (selected)
return withCoopContext(selected, async () => {
  const member = await getMemberByPhone(phone, selected);
  const locale = resolveMemberLocale(member, getLocale(), text);
  return runWithLocale(locale, () => handleMessageInner(phone, text, meta, selected, member));
});
```

Change `handleMessageInner`'s signature to accept the pre-loaded member and use it at line 501:

```ts
async function handleMessageInner(
  phone: string,
  text: string,
  meta: MessageMeta = {},
  coopId?: string,
  preloadedMember?: Awaited<ReturnType<typeof getMemberByPhone>>,
): Promise<void> {
  // ...
  const member = preloadedMember ?? (await getMemberByPhone(phone, coopId));
```

(The join-flow call at ~line 416 passes no member, so it loads inside as before.)

Add a `language` command check in `handleMessageInner`, placed right before `const { cmd, args } = parseCommand(text);` (after the member is resolved). `handleMessageInner` returns `Promise<void>`, so use a bare `return;` (NOT `return true;`), and guard on `member` (the command needs a registered member):

```ts
if (member && /^language$/i.test(text.trim())) {
  await sendText({
    to: phone,
    text: `🌐 Your language: *${resolveMemberLocale(member, getLocale(), text)}*\n\nReply *language <en|pidgin|hausa|yoruba|igbo>* to change it.`,
  });
  return;
}
if (member && /^language\s+/i.test(text.trim())) {
  const want = text.trim().split(/\s+/)[1]?.toLowerCase() as Locale;
  if (!LOCALES.includes(want)) {
    await sendText({ to: phone, text: `Unsupported language. Choose: ${LOCALES.join(", ")}.` });
    return;
  }
  await prisma.member.update({ where: { id: member.id }, data: { locale: want } });
  invalidateMemberCache(phone, member.cooperativeId);
  await sendText({ to: phone, text: `✅ Language set to *${want}*.` });
  return;
}
```

(`invalidateMemberCache` is already imported in `conversation.ts` — it is used by the opt-out/opt-in handlers. It is required here because `getMemberByPhone` caches the member for 30s; without it the next message would read the stale locale.)

Finally, make the AI path honor the resolved locale — in `src/lib/ai-query.ts:154`, replace `languageInstruction(detectLocale(question))` with `languageInstruction(getLocale())`. Import `getLocale` from `./runtime-context.js` and REMOVE the now-unused `detectLocale` from the `./i18n.js` import (keep `languageInstruction`) so lint stays clean.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/locale-resolution.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the conversation regression**

Run: `npx vitest run tests/conversation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/services/conversation.ts tests/locale-resolution.test.ts
git commit -m "feat(i18n): member locale resolution + language command"
```

---

### Task 7: i18n dictionary expansion + context-aware `t`

**Files:**
- Modify: `src/lib/i18n.ts`
- Test: `tests/i18n.test.ts` (extend)

**Interfaces:**
- Consumes: `getLocale` (Task 2).
- Produces: `t(key, params?)` reads the runtime locale; expanded `DICTIONARY`.

- [ ] **Step 1: Update the existing test calls + write the new failing test**

`tests/i18n.test.ts` already calls `t(locale, key)` in 4 places (lines 24-28). The signature is changing, so update those calls to the new `t(key, params?, locale?)` order:

```ts
    expect(t("member.balance", undefined, "pidgin")).toContain("money");
    expect(t("member.balance", undefined, "hausa")).toBe("💰 Kudin ka");
    expect(t("member.balance", undefined, "en")).toBe("💰 Your Balance");
    expect(t("nonexistent.key", undefined, "pidgin")).toBe("nonexistent.key");
```

Then add the new context test:

```ts
import { t } from "../src/lib/i18n.js";
import { runWithLocale } from "../src/lib/runtime-context.js";

describe("t() reads the runtime locale", () => {
  it("uses the context locale", () => {
    runWithLocale("yoruba", () => {
      expect(t("money.balance")).toBe("💰 Owo re");
    });
  });
  it("falls back to English for an unknown key", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/i18n.test.ts`
Expected: FAIL — `t` requires an explicit locale.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/i18n.ts`, change `t` to read the context and add critical-string keys:

```ts
import { getLocale } from "./runtime-context.js";

export function t(key: string, params?: Params, locale?: Locale): string {
  const entry = DICTIONARY[key];
  if (!entry) return key;
  const loc = locale ?? getLocale();
  let out = entry[loc] ?? entry.en;
  if (params) {
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}
```

Add critical-string entries to `DICTIONARY` (each with all 5 locales), e.g.:

```ts
  "money.balance": { en: "💰 Your Balance", pidgin: "💰 Your money wey you get", hausa: "💰 Kudin ka", yoruba: "💰 Owo re", igbo: "💰 Ego gi" },
  "cmd.language.set": { en: "✅ Language set to *{lang}*.", pidgin: "✅ Language don change to *{lang}*.", hausa: "✅ An saita harshe zuwa *{lang}*.", yoruba: "✅ Ede ti yipada si *{lang}*.", igbo: "✅ Asụsụ agbanweela gaa *{lang}*." },
  "error.unsupportedLanguage": { en: "Unsupported language. Choose: {list}.", pidgin: "We no sabi that language. Pick: {list}.", hausa: "Ba a goyi bayan wannan harshe. Zaɓi: {list}.", yoruba: "A ko ni ede yii. Yan: {list}.", igbo: "Anaghị akwado asụsụ a. Họrọ: {list}." },
```

(Keep the existing `member.balance`, `member.noLoan`, `fallback.unavailable` keys. `t` has **no callers in `src/`** — only its own definition — but `tests/i18n.test.ts` calls it in 4 places, which Step 1 updates. Changing the signature from `t(locale, key, params?)` to `t(key, params?, locale?)` is therefore safe once those test calls are updated. Update the module doc comment at the top of `i18n.ts` to match.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/lib/i18n.ts tests/i18n.test.ts
git commit -m "feat(i18n): context-aware t() + critical-string dictionary"
```

---

### Task 8: Provider routing by currency

**Files:**
- Modify: `src/services/payments/index.ts:286-296`
- Modify: `src/services/payments/paystack.ts` (hardcoded `"NGN"` at 111, 127, 134, 151, 239, 355)
- Modify: `src/services/payments/monnify.ts`, `src/services/payments/flutterwave.ts` (pass currency through)
- Test: `tests/provider-routing.test.ts`

**Interfaces:**
- Consumes: `providersForCurrency` (Task 1).
- Produces: `resolveProvider(preferred?, currency?)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/provider-routing.test.ts
import { describe, it, expect } from "vitest";
import { resolveProvider } from "../src/services/payments/index.js";

describe("resolveProvider by currency", () => {
  it("returns a provider that supports the currency", async () => {
    const p = await resolveProvider(undefined, "GHS");
    expect(["paystack", "flutterwave"]).toContain(p.name);
  });
  it("never returns monnify for a non-NGN currency", async () => {
    const p = await resolveProvider("monnify", "GHS");
    expect(p.name).not.toBe("monnify");
  });
  it("still returns monnify for NGN", async () => {
    const p = await resolveProvider("monnify", "NGN");
    expect(p.name).toBe("monnify");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/provider-routing.test.ts`
Expected: FAIL — `resolveProvider` ignores currency (returns monnify for GHS).

- [ ] **Step 3: Write minimal implementation**

In `src/services/payments/index.ts`:

```ts
import { providersForCurrency } from "../../lib/currency.js";

export async function resolveProvider(preferred?: string, currency?: string): Promise<ProviderAdapter> {
  const supported = currency ? providersForCurrency(currency) : ALL_PROVIDERS;
  const configured = (preferred ?? process.env.PAYMENT_PROVIDER ?? "monnify").toLowerCase();
  const first = supported.includes(configured) ? configured : supported[0];
  const order = [first, ...supported.filter((p) => p !== first)];
  for (const name of order) {
    const adapter = adapterFor(name);
    if (adapter && (await isProviderAvailable(name))) return adapter;
  }
  return adapterFor(first) ?? monnifyAdapter;
}
```

In the adapters, replace hardcoded `"NGN"` in **request** paths with the passed currency (`params.currency ?? "NGN"`). Leave webhook-parse defaults (`d.currency ?? "NGN"`) and Monnify-specific fields alone:
- `paystack.ts`: line 111 (`/bank?currency=NGN`, in `listBanks()`) and line 127 (`...&currency=NGN`, in `payout()`) → `params.currency ?? "NGN"`; line 134 (`r.currency === "NGN"`) → `r.currency === (params.currency ?? "NGN")`; line 151 (`currency: "NGN"`, recipient create) → `params.currency ?? "NGN"`; line 355 (`currency: "NGN"`) → `params.currency ?? "NGN"`. Line 239 (`d.currency ?? "NGN"`) is a webhook parse default — leave it.
- `monnify.ts`: lines 237, 305 already use `params.currency ?? "NGN"` — no change. Line 165 (`payload.currencyCode ?? "NGN"`) is a webhook parse default — leave it. Line 307 (`coin: "NGN"`) is Monnify-specific — leave it.
- `flutterwave.ts`: lines 226, 289 already use `params.currency ?? "NGN"` — no change. Line 165 is a webhook parse default — leave it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/provider-routing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the payments regression**

Run: `npx vitest run tests/mandates.test.ts tests/payout-events.test.ts tests/disbursement.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/services/payments
git commit -m "feat(payments): route providers by cooperative currency"
```

---

### Task 9: `topup` accepts the cooperative's currency

**Files:**
- Modify: `src/services/payments/topup.ts:111-116`
- Test: `tests/topup-currency.test.ts`

**Interfaces:**
- Consumes: `getCurrency` (Task 2), `withCoopContext` (Task 5).

- [ ] **Step 1: Write the failing test**

```ts
// tests/topup-currency.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";

describe("topup currency", () => {
  it("credits a GHS cooperative for a GHS notification", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "GHS Coop", code: `GH${Date.now()}`, currency: "GHS" },
    });
    const member = await prisma.member.create({
      data: {
        code: `M${Date.now()}`,
        phone: `+233${Date.now()}`,
        name: "Ama",
        cooperativeId: coop.id,
        virtualAccountNumber: `VA${Date.now()}`,
        wallet: { create: { balance: 0 } },
      },
    });
    await handlePaymentNotification({
      transactionId: `tx${Date.now()}`,
      accountNumber: member.virtualAccountNumber!,
      amount: 10000,
      currency: "GHS",
      status: "successful",
      provider: "paystack",
      raw: {},
    });
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(10000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/topup-currency.test.ts`
Expected: FAIL — the notification is rejected because `currency !== "NGN"`.

- [ ] **Step 3: Write minimal implementation**

In `src/services/payments/topup.ts`, remove the early NGN-only rejection (lines 110-116) and instead validate inside the coop context against the coop's currency:

```ts
// (delete the top-level `if (n.currency !== "NGN") { ... return; }` block)

// inside withCoopContext(coopId, async () => { ... }), before crediting:
if (n.currency !== getCurrency()) {
  console.warn(
    `[topup] rejected notification currency ${n.currency} (coop expects ${getCurrency()}), txId=${n.transactionId}`,
  );
  return;
}
```

Add `import { getCurrency } from "../../lib/runtime-context.js";`.

Also fix `provisionVirtualAccount`'s hardcoded `currency: "NGN"` (line 49) — a GHS/KES coop must no longer provision NGN virtual accounts. After the member fetch, resolve the coop's currency and use it:

```ts
const { currency } = await getCoopMeta(member.cooperativeId);
const params = {
  phone: kycPhone,
  name: member.name,
  reference: `MEM-${member.id}`,
  currency,
};
```

`getCoopMeta` is already exported from `../../lib/tenant-context.js` (Task 5) — add it to that import line (which already imports `resolveCoopByVirtualAccount`, `withCoopContext`, `forEachCoop`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/topup-currency.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the topup regression**

Run: `npx vitest run tests/moneyflows.test.ts tests/provisioning.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/services/payments/topup.ts tests/topup-currency.test.ts
git commit -m "feat(payments): accept the cooperative's currency in topup"
```

---

### Task 10: Replace hardcoded `₦` literals

**Files:**
- Modify: `src/lib/ai-query.ts:197`, `src/lib/ai-insights.ts:89,150`, `src/lib/ai-support.ts:329`, `src/services/guarantors.ts:167`, `src/services/aml.ts:256`, `src/services/handlers/session.ts:1874,1939`
- Test: `tests/currency-formatting.test.ts` (extend)

**Interfaces:**
- Consumes: `formatBalance` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// tests/currency-formatting.test.ts (add)
import { runWithCurrency } from "../src/lib/runtime-context.js";
import { formatFallbackResponse } from "../src/lib/ai-query.js"; // export it if not already

it("AI fallback uses the context currency", () => {
  runWithCurrency("GHS", () => {
    const out = formatFallbackResponse("member_balance", {
      member: { walletBalance: 100050, totalSaved: 100050, activeLoan: null },
    });
    expect(out).toContain("₵");
    expect(out).not.toContain("₦");
  });
});
```

(If `formatFallbackResponse` is not exported, export it in this task.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/currency-formatting.test.ts`
Expected: FAIL — the fallback still prints `₦`.

- [ ] **Step 3: Replace the literals**

Replace each `₦${(n / 100).toLocaleString()}` / `₦${...}` numeric interpolation with `formatBalance(n)` (importing `formatBalance` where missing). Specifically:
- `ai-query.ts:197` — `const fmt = (n: number) => formatBalance(n);`
- `ai-insights.ts:89,150` — same.
- `ai-support.ts:329` — `formatBalance(loan.balance)`.
- `guarantors.ts:167` — `formatBalance(loan.amount)`.
- `aml.ts:256` — `formatBalance(agg.total)` for the outflow; keep the CBN threshold `₦${(reportingThreshold / 100).toLocaleString()}` as-is (Nigeria regulatory threshold). Do NOT touch aml.ts:264 (already uses `formatBalance(tx.amount)`; the remaining `₦` there is the CBN threshold).
- `session.ts:1874,1939` — `formatBalance(p.premiumKobo)` / `formatBalance(p.coverageKobo)`.

Leave static Naira-denominated content (ai-support.ts:90/96/101/273/277 example strings, literacy.ts, status-scheduler.ts) and comments/regulations unchanged — those encode Naira amounts, not currency-agnostic formatting, and belong to a separate content-localization pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/currency-formatting.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no stray `₦` remains in `src/`**

Run: `Select-String -Path src\lib\ai-query.ts,src\lib\ai-insights.ts,src\lib\ai-support.ts,src\services\guarantors.ts,src\services\aml.ts,src\services\handlers\session.ts -Pattern '₦\$\{' | Measure-Object`
Expected: 0 matches (the interpolation pattern is gone from the target files; `₦` in comments/regulatory/content strings is intentionally left).

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/lib/ai-query.ts src/lib/ai-insights.ts src/lib/ai-support.ts src/services/guarantors.ts src/services/aml.ts src/services/handlers/session.ts
git commit -m "refactor(currency): replace hardcoded naira with formatBalance"
```

---

### Task 11: Admin `setconfig language` + `showconfig`

**Files:**
- Modify: `src/services/admin.ts:3113-3220`
- Test: `tests/admin-language-config.test.ts`

**Interfaces:**
- Consumes: `invalidateCoopMeta` (Task 5), `LOCALES` (Task 6).
- Note: currency is NOT set here — it is derived from country (Task 13). `showconfig` displays country + currency (read-only) + language.

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin-language-config.test.ts
import { describe, it, expect } from "vitest";
import { handleAdminCommand } from "../src/services/admin.js";

describe("setconfig language", () => {
  it("rejects an unsupported language", async () => {
    // create a super admin + coop, send "setconfig language klingon", assert coop.locale unchanged
  });
  it("sets the coop default language and invalidates the meta cache", async () => {
    // send "setconfig language yoruba", assert coop.locale === "yoruba"
  });
});
```

(Fill the bodies using the existing admin test harness — mirror `tests/savings-products.test.ts` setup, which imports `handleAdminCommand` and drives it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/admin-language-config.test.ts`
Expected: FAIL — `language` is an unknown config key.

- [ ] **Step 3: Write minimal implementation**

In `src/services/admin.ts` `case "setconfig"`:
- Add `language` to the usage text.
- Handle it **immediately after the `if (!key || !value)` block and before the `validKeys` check** (it is a string, so it must bypass the boolean/number parsing below). Do NOT add it to `validKeys`.
- Note: `updateCoopConfig`/`getCoopConfig` operate on the separate `CoopConfig` table; `locale` lives on the `Cooperative` model, so update `prisma.cooperative` directly.

```ts
if (key === "language") {
  const want = value.toLowerCase();
  if (!LOCALES.includes(want as never)) {
    await sendText({ to: phone, text: `Unsupported language. Choose: ${LOCALES.join(", ")}.` });
    return true;
  }
  await prisma.cooperative.update({ where: { id: coopId }, data: { locale: want } });
  invalidateCoopMeta(coopId);
  await audit({ cooperativeId: coopId, actorPhone: phone, actorId: admin.id, actorRole: "superadmin", action: "config.set", detail: `language = ${want}` });
  await sendText({ to: phone, text: `✅ Default language set to *${want}*.` });
  return true;
}
```

Add imports to `admin.ts`: `invalidateCoopMeta` from `../lib/tenant-context.js`; `LOCALES` from `./conversation.js` (exported there in Task 6).

Add country/currency/language lines to `showconfig` (fetch the coop separately, since `getCoopConfig` returns the `CoopConfig` row):

```ts
const coop = await prisma.cooperative.findUnique({
  where: { id: coopId },
  select: { country: true, currency: true, locale: true },
});
// ...append to the `body` array:
`• Country: *${coop?.country ?? "NG"}*`,
`• Currency: *${coop?.currency ?? "NGN"}*`,
`• Default language: *${coop?.locale ?? "en"}*`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/admin-language-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/services/admin.ts tests/admin-language-config.test.ts
git commit -m "feat(admin): setconfig language + showconfig country/currency"
```

---

### Task 12: Integration + regression

**Files:**
- Test: `tests/multi-currency-integration.test.ts` (new)

- [ ] **Step 1: Write the integration test**

```ts
// tests/multi-currency-integration.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withCoopContext } from "../src/lib/tenant-context.js";
import { formatBalance } from "../src/lib/money.js";
import { t } from "../src/lib/i18n.js";

describe("multi-currency + multi-language integration", () => {
  it("formats and localizes inside a GHS/pidgin coop context", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Accra Coop", code: `AC${Date.now()}`, currency: "GHS", locale: "pidgin" },
    });
    await withCoopContext(coop.id, async () => {
      expect(formatBalance(100050)).toBe("₵1,000.50");
      expect(t("money.balance")).toBe("💰 Your money wey you get");
    });
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/multi-currency-integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the verification gate**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Run: `npx eslint . --max-warnings=0`
Expected: 0 errors.

Run: `npx vitest run tests/schema-sync.test.ts tests/currency.test.ts tests/runtime-context.test.ts tests/currency-formatting.test.ts tests/provider-routing.test.ts tests/i18n.test.ts tests/locale-resolution.test.ts tests/coop-context-currency.test.ts tests/topup-currency.test.ts tests/admin-language-config.test.ts tests/multi-currency-integration.test.ts`
Expected: all PASS.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run --reporter=dot`
Expected: green (68+ files). Takes ~11 min.

- [ ] **Step 5: Commit** (only if approved)

```bash
git add tests/multi-currency-integration.test.ts
git commit -m "test(currency): multi-currency + multi-language integration"
```

---

### Task 13: Country → currency inference

**Files:**
- Modify: `src/lib/currency.ts` (add country↔currency maps + `countryFromPhone`)
- Modify: `src/services/cooperative.ts:371` (`createCooperative` infers country/currency)
- Modify: `src/services/admin.ts` (`setconfig country`; `showconfig` country)
- Test: `tests/country-currency.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CURRENCY` (Task 1), `isSupportedCurrency` (Task 1), `invalidateCoopMeta` (Task 5).
- Produces: `COUNTRY_CURRENCY`, `currencyForCountry(country)`, `countryForCurrency(currency)`, `countryFromPhone(phone)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/country-currency.test.ts
import { describe, it, expect } from "vitest";
import {
  currencyForCountry,
  countryForCurrency,
  countryFromPhone,
} from "../src/lib/currency.js";
import { createCooperative } from "../src/services/cooperative.js";

describe("country → currency", () => {
  it("maps countries to currencies", () => {
    expect(currencyForCountry("GH")).toBe("GHS");
    expect(currencyForCountry("gh")).toBe("GHS");
    expect(currencyForCountry("XX")).toBe("NGN");
  });

  it("maps currencies back to countries", () => {
    expect(countryForCurrency("KES")).toBe("KE");
    expect(countryForCurrency("XXX")).toBe("NG");
  });

  it("infers country from an E.164 phone (longest prefix wins)", () => {
    expect(countryFromPhone("+2348012345678")).toBe("NG");
    expect(countryFromPhone("+233201234567")).toBe("GH");
    expect(countryFromPhone("+254712345678")).toBe("KE");
    expect(countryFromPhone("+27821234567")).toBe("ZA");
    expect(countryFromPhone("08012345678")).toBeNull();
  });

  it("createCooperative infers country + currency from adminPhone", async () => {
    const coop = await createCooperative({
      name: "Accra Coop",
      code: `AC${Date.now()}`,
      adminPhone: "+233201234567",
    });
    expect(coop.country).toBe("GH");
    expect(coop.currency).toBe("GHS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/country-currency.test.ts`
Expected: FAIL — `currencyForCountry` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/currency.ts`:

```ts
export const COUNTRY_CURRENCY: Record<string, string> = {
  NG: "NGN", GH: "GHS", KE: "KES", ZA: "ZAR", US: "USD",
  UG: "UGX", TZ: "TZS", RW: "RWF", SN: "XOF", ZM: "ZMW", MW: "MWK",
};

export function currencyForCountry(country: string): string {
  return COUNTRY_CURRENCY[country?.toUpperCase()] ?? DEFAULT_CURRENCY;
}

export function countryForCurrency(currency: string): string {
  const code = currency?.toUpperCase();
  const found = Object.entries(COUNTRY_CURRENCY).find(([, c]) => c === code);
  return found?.[0] ?? "NG";
}

const CALLING_CODE_COUNTRY: Array<[string, string]> = [
  ["+234", "NG"], ["+233", "GH"], ["+254", "KE"], ["+27", "ZA"], ["+1", "US"],
  ["+256", "UG"], ["+255", "TZ"], ["+250", "RW"], ["+221", "SN"], ["+260", "ZM"], ["+265", "MW"],
];

export function countryFromPhone(phone: string): string | null {
  const p = phone?.trim();
  if (!p || !p.startsWith("+")) return null;
  const match = CALLING_CODE_COUNTRY
    .filter(([cc]) => p.startsWith(cc))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match?.[1] ?? null;
}
```

Replace `createCooperative` in `src/services/cooperative.ts` (import `countryFromPhone`, `currencyForCountry` from `../lib/currency.js`):

```ts
export async function createCooperative(data: {
  name: string;
  code: string;
  adminPhone?: string;
  state?: string;
  registrationNumber?: string;
  country?: string;
}) {
  if (!data.registrationNumber) {
    console.warn(
      `[compliance] Cooperative "${data.name}" created without a registration number. Registration number is required under CAMA for legal recognition.`,
    );
  }
  const country =
    data.country ?? (data.adminPhone ? countryFromPhone(data.adminPhone) : null) ?? "NG";
  const currency = currencyForCountry(country);
  return prisma.cooperative.create({
    data: {
      name: data.name,
      code: data.code,
      adminPhone: data.adminPhone,
      state: data.state,
      country,
      currency,
    },
  });
}
```

In `src/services/admin.ts` `case "setconfig"`, add a `country` branch (same insertion point as `language` in Task 11 — before the `validKeys` check). This is the ONLY way to set a coop's currency, because currency is always derived from country:

```ts
if (key === "country") {
  const iso = value.toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(COUNTRY_CURRENCY, iso)) {
    await sendText({ to: phone, text: `Unsupported country *${value}*. Supported: ${Object.keys(COUNTRY_CURRENCY).join(", ")}.` });
    return true;
  }
  const moved = await prisma.wallet.count({
    where: { member: { cooperativeId: coopId }, balance: { gt: 0 } },
  });
  if (moved > 0) {
    await sendText({ to: phone, text: "Country can't be changed after money has moved in this cooperative." });
    return true;
  }
  await prisma.cooperative.update({
    where: { id: coopId },
    data: { country: iso, currency: currencyForCountry(iso) },
  });
  invalidateCoopMeta(coopId);
  await audit({ cooperativeId: coopId, actorPhone: phone, actorId: admin.id, actorRole: "superadmin", action: "config.set", detail: `country = ${iso}` });
  await sendText({ to: phone, text: `✅ Country set to *${iso}* (currency *${currencyForCountry(iso)}*).` });
  return true;
}
```

Add `COUNTRY_CURRENCY`, `currencyForCountry` to the `../lib/currency.js` import in `admin.ts`. (`showconfig` already displays country + currency from Task 11 — no change needed here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/country-currency.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit** (only if approved)

```bash
git add src/lib/currency.ts src/services/cooperative.ts src/services/admin.ts tests/country-currency.test.ts
git commit -m "feat(currency): infer country + currency from admin phone"
```

---

### Task 14: Language understanding (translate input to English)

**Files:**
- Create: `src/lib/translate.ts`
- Modify: `src/services/conversation.ts` (`handleMessage` translates non-English input before the tx)
- Test: `tests/translate.test.ts`

**Interfaces:**
- Consumes: `groqFetch`/`groqAvailable`/`groqModel`/`GROQ_TIMEOUT_MS` (`groq.ts`), `Locale` (`i18n.ts`), `detectLocale` (`i18n.ts`), `resolveMemberLocale` (Task 6).
- Produces: `translateToEnglish(text, locale)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/translate.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { groqFetch } from "../src/lib/groq.js";
import { translateToEnglish } from "../src/lib/translate.js";

vi.mock("../src/lib/groq.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/groq.js")>();
  return { ...actual, groqFetch: vi.fn() };
});

const mockGroq = vi.mocked(groqFetch);
const groqReply = (content: string) =>
  ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response;

describe("translateToEnglish", () => {
  const origKey = process.env.GROQ_API_KEY;
  beforeEach(() => mockGroq.mockReset());
  afterEach(() => { process.env.GROQ_API_KEY = origKey; });

  it("passes English through unchanged", async () => {
    expect(await translateToEnglish("hello", "en")).toBe("hello");
    expect(mockGroq).not.toHaveBeenCalled();
  });

  it("passes through when Groq is unavailable", async () => {
    delete process.env.GROQ_API_KEY;
    expect(await translateToEnglish("ina kwana", "hausa")).toBe("ina kwana");
    expect(mockGroq).not.toHaveBeenCalled();
  });

  it("translates non-English text via Groq", async () => {
    process.env.GROQ_API_KEY = "test";
    mockGroq.mockResolvedValue(groqReply("How are you"));
    expect(await translateToEnglish("bawo ni", "yoruba")).toBe("How are you");
  });

  it("caches repeated translations", async () => {
    process.env.GROQ_API_KEY = "test";
    mockGroq.mockResolvedValue(groqReply("Good morning"));
    await translateToEnglish("e kaaro", "yoruba");
    await translateToEnglish("e kaaro", "yoruba");
    expect(mockGroq).toHaveBeenCalledTimes(1);
  });

  it("fails open on error", async () => {
    process.env.GROQ_API_KEY = "test";
    mockGroq.mockRejectedValue(new Error("network"));
    expect(await translateToEnglish("sannu", "hausa")).toBe("sannu");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/translate.test.ts`
Expected: FAIL — cannot find module `../src/lib/translate.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/translate.ts
import { groqAvailable, groqModel, groqFetch, GROQ_TIMEOUT_MS } from "./groq.js";
import type { Locale } from "./i18n.js";

const cache = new Map<string, string>();
const MAX_CACHE = 500;

/**
 * Translate a member's message into English so the deterministic command parser
 * can understand it. Returns the text unchanged for English, blank input, or
 * when Groq is unavailable. Fail-open: any error returns the original text.
 */
export async function translateToEnglish(text: string, locale: Locale): Promise<string> {
  if (locale === "en" || !text.trim() || !groqAvailable()) return text;
  const key = `${locale}:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const res = await groqFetch(
      {
        model: groqModel(),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Translate the user's message into English. Output ONLY the translation — no quotes, no commentary, no explanation.",
          },
          { role: "user", content: text },
        ],
      },
      GROQ_TIMEOUT_MS,
    );
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (out) {
      if (cache.size >= MAX_CACHE) cache.clear();
      cache.set(key, out);
      return out;
    }
  } catch (err) {
    console.warn("[translate] failed, using original text", err);
  }
  return text;
}
```

Wire it into `handleMessage` in `src/services/conversation.ts` (import `translateToEnglish` from `../lib/translate.js`). Translate **outside** the transaction (so the Groq call never holds the DB tx open), using `detectLocale` as the trigger; resolve the reply locale from the **original** text inside the tx:

```ts
// single-coop branch
if (coopId) {
  const detected = detectLocale(text);
  const commandText = detected === "en" ? text : await translateToEnglish(text, detected);
  return withCoopContext(coopId, async () => {
    const member = await getMemberByPhone(phone, coopId);
    const locale = resolveMemberLocale(member, getLocale(), text);
    return runWithLocale(locale, () => handleMessageInner(phone, commandText, meta, coopId, member));
  });
}

// multi-coop branch (selected) — same shape
return withCoopContext(selected, async () => {
  const detected = detectLocale(text);
  const commandText = detected === "en" ? text : await translateToEnglish(text, detected);
  const member = await getMemberByPhone(phone, selected);
  const locale = resolveMemberLocale(member, getLocale(), text);
  return runWithLocale(locale, () => handleMessageInner(phone, commandText, meta, selected, member));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/translate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the conversation regression**

Run: `npx vitest run tests/conversation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/lib/translate.ts src/services/conversation.ts tests/translate.test.ts
git commit -m "feat(i18n): translate non-English input to English for command parsing"
```

---

### Task 15: Reliable voice-note language detection

**Files:**
- Modify: `src/lib/transcribe.ts` (return `{ text, language }`)
- Modify: `src/lib/i18n.ts` (add `localeFromLanguageCode`)
- Modify: `src/services/conversation.ts` (`MessageMeta.languageHint`; use it in the translation trigger)
- Modify: `src/routes/webhook.ts` (pass the language hint)
- Test: `tests/transcribe-language.test.ts`

**Interfaces:**
- Consumes: `Locale`/`detectLocale` (i18n), `translateToEnglish` (Task 14).
- Produces: `localeFromLanguageCode(code)`; `transcribeAudioMessage(mediaId)` → `{ text: string; language: string | null } | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/transcribe-language.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { localeFromLanguageCode } from "../src/lib/i18n.js";
import { transcribeAudioMessage } from "../src/lib/transcribe.js";

describe("localeFromLanguageCode", () => {
  it("maps Whisper ISO codes to locales", () => {
    expect(localeFromLanguageCode("yo")).toBe("yoruba");
    expect(localeFromLanguageCode("ha")).toBe("hausa");
    expect(localeFromLanguageCode("ig")).toBe("igbo");
    expect(localeFromLanguageCode("en")).toBe("en");
    expect(localeFromLanguageCode("pcm")).toBe("pidgin");
  });
  it("returns null for unknown/empty codes", () => {
    expect(localeFromLanguageCode("fr")).toBeNull();
    expect(localeFromLanguageCode("")).toBeNull();
    expect(localeFromLanguageCode(undefined)).toBeNull();
  });
});

describe("transcribeAudioMessage", () => {
  const origKey = process.env.GROQ_API_KEY;
  const origToken = process.env.WHATSAPP_TOKEN;
  const origFetch = global.fetch;
  afterEach(() => {
    process.env.GROQ_API_KEY = origKey;
    process.env.WHATSAPP_TOKEN = origToken;
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("returns the transcript text and the detected language", async () => {
    process.env.GROQ_API_KEY = "test";
    process.env.WHATSAPP_TOKEN = "test";
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://x/audio", mime_type: "audio/ogg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "bawo ni", language: "yo" }) }) as unknown as typeof fetch;
    expect(await transcribeAudioMessage("media-1")).toEqual({ text: "bawo ni", language: "yo" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcribe-language.test.ts`
Expected: FAIL — `localeFromLanguageCode` is not exported; `transcribeAudioMessage` returns a string.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/i18n.ts`, add:

```ts
const WHISPER_LOCALE: Record<string, Locale> = {
  en: "en", yo: "yoruba", ha: "hausa", ig: "igbo", pcm: "pidgin",
};

/** Map a Whisper/ISO-639-1 language code to a supported Locale, or null. */
export function localeFromLanguageCode(code: string | null | undefined): Locale | null {
  if (!code) return null;
  return WHISPER_LOCALE[code.toLowerCase()] ?? null;
}
```

In `src/lib/transcribe.ts`, change the return type to carry the detected language:

```ts
export interface Transcript {
  text: string;
  language: string | null;
}

async function transcribe(audio: Buffer, mime: string): Promise<Transcript | null> {
  if (!groqAvailable()) return null;
  const apiKey = process.env.GROQ_API_KEY!;
  try {
    const form = new FormData();
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("mpeg") ? "mp3" : "ogg";
    form.append("file", new Blob([audio], { type: mime }), `voice-${Date.now()}.${ext}`);
    form.append("model", GROQ_TRANSCRIBE_MODEL);
    const res = await fetch(GROQ_AUDIO_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: string; language?: string };
    const text = body.text?.trim();
    return text ? { text, language: body.language ?? null } : null;
  } catch {
    return null;
  }
}

export async function transcribeAudioMessage(mediaId: string): Promise<Transcript | null> {
  if (!transcriptionEnabled()) return null;
  const audio = await downloadAudio(mediaId);
  if (!audio) return null;
  return transcribe(audio.data, audio.mime);
}
```

In `src/services/conversation.ts`, add the hint to `MessageMeta`:

```ts
export interface MessageMeta {
  flowToken?: string;
  telegramMessageId?: number;
  ip?: string;
  /** Whisper-detected language code from a voice note (e.g. "yo"). */
  languageHint?: string;
}
```

And in `handleMessage` (the Task 14 wiring), use the hint as the translation trigger, falling back to `detectLocale` when the hint is absent or `"en"` (so Pidgin, which Whisper may report as `"en"`, is still caught by the keyword heuristic):

```ts
const hinted = localeFromLanguageCode(meta.languageHint);
const detected = hinted && hinted !== "en" ? hinted : detectLocale(text);
const commandText = detected === "en" ? text : await translateToEnglish(text, detected);
```

(Import `localeFromLanguageCode` from `../lib/i18n.js`.)

In `src/routes/webhook.ts`, capture the language and pass it through:

```ts
let languageHint: string | null = null;
if (inbound.audio) {
  if (!transcriptionEnabled()) continue;
  const transcript = await transcribeAudioMessage(inbound.audio.mediaId);
  if (!transcript) {
    // ...existing failure message + continue...
  }
  inbound.text = transcript.text;
  languageHint = transcript.language;
}
// ...
void withUserMutex(inbound.from, () =>
  handleMessage(inbound.from, inbound.text, {
    flowToken: inbound.flowToken,
    ip: req.ip,
    languageHint: languageHint ?? undefined,
  }),
).catch(/* ...unchanged... */);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transcribe-language.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the webhook + conversation regression**

Run: `npx vitest run tests/conversation.test.ts tests/advisory-webhook-hardening.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit** (only if approved)

```bash
git add src/lib/transcribe.ts src/lib/i18n.ts src/services/conversation.ts src/routes/webhook.ts tests/transcribe-language.test.ts
git commit -m "feat(i18n): use Whisper-detected language for voice-note translation"
```

---

## Self-Review

**Spec coverage:**
- §4 data model → Task 4. §5 registry → Task 1. §6 runtime context → Tasks 2, 5. §7 formatting → Tasks 3, 10. §8 provider routing → Tasks 8, 9. §9 localization → Tasks 6, 7. §10 commands/config → Tasks 6, 11. §11 RLS → no change (no new tables). §12 cross-cutting → Global Constraints + Tasks 4, 5, 11. §14 tests → each task + Task 12. §16 country→currency → Task 13. §17 language understanding → Tasks 14, 15.

**Placeholder scan:** Task 11 Step 1 test bodies are described (not fully coded) because they depend on the existing admin test harness; the implementer must mirror `tests/savings-products.test.ts` (there is no `tests/admin.test.ts`). All other steps carry real code.

**Type consistency:** `formatBalance(kobo, currency?)`, `formatMoney(kobo, code)`, `getCurrency()`, `getLocale()`, `runWithContext/runWithCurrency/runWithLocale`, `getCoopMeta`, `invalidateCoopMeta`, `resolveMemberLocale`, `resolveProvider(preferred?, currency?)` are used consistently across tasks.
