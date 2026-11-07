import { AsyncLocalStorage } from "node:async_hooks";
import { incCounter } from "./metrics.js";

export { SandboxBusyError, SandboxExternalBlockedError } from "./sandbox-errors.js";

export type SandboxAiPath = "ai" | "guardrail" | "rules";

interface SandboxContext {
  cooperativeId: string;
  aiEnabled: boolean;
  aiPath: SandboxAiPath;
}

const storage = new AsyncLocalStorage<SandboxContext>();

/** True while a developer-console sandbox turn is running. */
export function isSandboxMode(): boolean {
  return storage.getStore() !== undefined;
}

/** Cooperative id for the active sandbox turn, or null. */
export function sandboxCooperativeId(): string | null {
  return storage.getStore()?.cooperativeId ?? null;
}

/** Whether real AI calls are permitted in the active sandbox turn. */
export function sandboxAiEnabled(): boolean {
  return storage.getStore()?.aiEnabled ?? true;
}

/** Record which AI path the turn actually took. No-op outside a sandbox turn. */
export function noteSandboxAiPath(path: SandboxAiPath): void {
  const store = storage.getStore();
  if (store) store.aiPath = path;
}

/** Count a blocked external side effect. */
export function blockSandboxExternal(service: string): void {
  incCounter("sandbox_external_block_total", { service });
}

/**
 * Run a function inside a sandbox scope. Nested scopes inherit the parent's
 * AI toggle and can only turn AI off, never back on.
 */
export async function runInSandbox<T>(
  cooperativeId: string,
  fn: () => Promise<T>,
  options: { aiEnabled?: boolean } = {},
): Promise<{ result: T; meta: { aiPath: SandboxAiPath } }> {
  const parent = storage.getStore();
  const ctx: SandboxContext = {
    cooperativeId,
    aiEnabled: options.aiEnabled ?? parent?.aiEnabled ?? true,
    aiPath: "rules",
  };
  if (parent && parent.aiEnabled === false) ctx.aiEnabled = false;

  return storage.run(ctx, async () => {
    const result = await fn();
    return { result, meta: { aiPath: ctx.aiPath } };
  });
}
