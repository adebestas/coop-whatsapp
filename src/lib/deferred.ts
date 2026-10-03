import { AsyncLocalStorage } from "node:async_hooks";

type DeferredSend = () => Promise<unknown>;

const queueStorage = new AsyncLocalStorage<DeferredSend[]>();

/**
 * Enqueue a send if we are inside a deferred-send scope. Returns false when
 * there is no scope, so the caller sends immediately.
 */
export function enqueueDeferredSend(send: DeferredSend): boolean {
  const queue = queueStorage.getStore();
  if (!queue) return false;
  queue.push(send);
  return true;
}

/**
 * Run `fn` with outbound sends deferred.
 *
 * Any sendText() call inside `fn` is queued and flushed after `fn` resolves.
 * This keeps a DB transaction wrapping `fn` from spanning network I/O — which
 * would otherwise blow Prisma's 5s interactive-transaction timeout and hold a
 * pooled connection for the whole send (including the 1.5s WhatsApp pacing).
 *
 * Sends are best-effort: a failed send is logged, never thrown, so it cannot
 * roll back or fail the DB work that already committed.
 */
export async function withDeferredSends<T>(fn: () => Promise<T>): Promise<T> {
  const queue: DeferredSend[] = [];
  const result = await queueStorage.run(queue, fn);
  for (const send of queue) {
    try {
      await send();
    } catch (err) {
      console.error("[deferred] send failed", err);
    }
  }
  return result;
}
