/**
 * OPS-1: crash/shutdown reliability.
 *
 * The old inline handler only set `process.exitCode` and awaited app/queue/
 * redis/db closes. Because the in-process scheduler and Telegram long-poll keep
 * the event loop alive with live timers, setting exitCode never actually ends
 * the process — shutdown "completed" but the container hung until SIGKILL. This
 * module centralizes shutdown so it (a) always terminates via an explicit exit,
 * (b) cannot hang forever thanks to a watchdog, and (c) runs every step even if
 * one throws.
 */

export interface ShutdownStep {
  name: string;
  close: () => Promise<void> | void;
}

export interface ShutdownDeps {
  /** Called once when the first shutdown signal arrives. */
  onStart?: (signal: string) => void;
  /** Called after each step closes successfully. */
  onStep?: (name: string) => void;
  /** Called when a step throws, or the watchdog fires. */
  onError?: (step: string, err: unknown) => void;
  /** Performs the actual process exit. Injected so it is testable. */
  exit: (code: number) => void;
  /** Max time to wait for all steps before forcing an exit. Default 15s. */
  timeoutMs?: number;
}

export interface ShutdownController {
  shutdown: (signal: string, exitCode?: number) => Promise<void>;
  isShuttingDown: () => boolean;
}

export function createShutdown(steps: ShutdownStep[], deps: ShutdownDeps): ShutdownController {
  let shuttingDown = false;

  async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.onStart?.(signal);

    const timeoutMs = deps.timeoutMs ?? 15_000;
    // Watchdog: if a close hangs (open keep-alive socket, stuck Redis), force an
    // exit rather than let the container hang until it is killed.
    const watchdog = setTimeout(() => {
      deps.onError?.(`${signal}:timeout`, new Error(`shutdown exceeded ${timeoutMs}ms`));
      deps.exit(exitCode === 0 ? 1 : exitCode);
    }, timeoutMs);
    if (typeof watchdog.unref === "function") watchdog.unref();

    let code = exitCode;
    for (const step of steps) {
      try {
        await step.close();
        deps.onStep?.(step.name);
      } catch (err) {
        deps.onError?.(step.name, err);
        code = 1;
      }
    }

    clearTimeout(watchdog);
    deps.exit(code);
  }

  return { shutdown, isShuttingDown: () => shuttingDown };
}
