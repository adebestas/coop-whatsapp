import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Bind request metadata for everything the handler awaits from here on. */
export function enterRequestContext(ctx: RequestContext): void {
  storage.enterWith({
    ip: ctx.ip,
    userAgent: ctx.userAgent?.slice(0, 256),
    requestId: ctx.requestId,
  });
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Explicit scoping for scripts/tests that call services outside HTTP. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
