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
 * Enqueue `fn` to run AFTER the current deferred-send scope's transaction has
 * committed. It uses the SAME queue as `enqueueDeferredSend`, so
 * `withDeferredSends` flushes it once the scope's `fn` (and its transaction)
 * has resolved — never inside the transaction.
 *
 * Returns false when there is no ambient scope, so the caller can run `fn`
 * immediately (e.g. the deductions path, which qualifies outside any tx).
 */
export function enqueueAfterCommit(fn: DeferredSend): boolean {
  return enqueueDeferredSend(fn);
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
