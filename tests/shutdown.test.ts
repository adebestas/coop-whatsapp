/**
 * OPS-1: shutdown controller — must always terminate, run every step, and force
 * an exit if a close hangs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownStep } from "../src/lib/shutdown.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdown", () => {
  it("runs every step in order and exits 0", async () => {
    const order: string[] = [];
    const steps: ShutdownStep[] = [
      { name: "http", close: () => order.push("http") },
      { name: "queues", close: async () => void order.push("queues") },
      { name: "db", close: () => order.push("db") },
    ];
    const exit = vi.fn();
    const { shutdown } = createShutdown(steps, { exit });

    await shutdown("SIGTERM");

    expect(order).toEqual(["http", "queues", "db"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("continues past a failing step and exits 1", async () => {
    const closed: string[] = [];
    const steps: ShutdownStep[] = [
      { name: "http", close: () => closed.push("http") },
      {
        name: "queues",
        close: () => {
          throw new Error("boom");
        },
      },
      { name: "db", close: () => closed.push("db") },
    ];
    const exit = vi.fn();
    const onError = vi.fn();
    const { shutdown } = createShutdown(steps, { exit, onError });

    await shutdown("SIGTERM");

    expect(closed).toEqual(["http", "db"]);
    expect(onError).toHaveBeenCalledWith("queues", expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("propagates a non-zero exit code and never downgrades it", async () => {
    const exit = vi.fn();
    const { shutdown } = createShutdown([{ name: "db", close: () => {} }], { exit });

    await shutdown("uncaughtException", 1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("is idempotent — a second signal is a no-op", async () => {
    const exit = vi.fn();
    const { shutdown, isShuttingDown } = createShutdown([{ name: "db", close: () => {} }], {
      exit,
    });

    await shutdown("SIGTERM");
    expect(isShuttingDown()).toBe(true);
    await shutdown("SIGINT");

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("forces an exit via the watchdog when a close step hangs", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const onError = vi.fn();
    const never = new Promise<void>(() => {});
    const { shutdown } = createShutdown([{ name: "http", close: () => never }], {
      exit,
      onError,
      timeoutMs: 1000,
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);

    expect(onError).toHaveBeenCalledWith("SIGTERM:timeout", expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
