import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_CURRENCY } from "./currency.js";
import type { Locale } from "./i18n.js";

export interface RuntimeContext {
  currency: string;
  locale: Locale;
  /** The cooperative whose tenant context is active, when inside withCoopContext. */
  cooperativeId?: string;
}

const storage = new AsyncLocalStorage<RuntimeContext>();

export function getCurrency(): string {
  return storage.getStore()?.currency ?? DEFAULT_CURRENCY;
}

export function getLocale(): Locale {
  return storage.getStore()?.locale ?? "en";
}

/** The active cooperative id, or undefined outside a coop context. */
export function getCoopId(): string | undefined {
  return storage.getStore()?.cooperativeId;
}

export function runWithContext<T>(ctx: Partial<RuntimeContext>, fn: () => T): T {
  const current = storage.getStore();
  const next: RuntimeContext = {
    currency: ctx.currency ?? current?.currency ?? DEFAULT_CURRENCY,
    locale: ctx.locale ?? current?.locale ?? "en",
    cooperativeId: ctx.cooperativeId ?? current?.cooperativeId,
  };
  return storage.run(next, fn);
}

export function runWithCurrency<T>(currency: string, fn: () => T): T {
  return runWithContext({ currency }, fn);
}

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return runWithContext({ locale }, fn);
}
