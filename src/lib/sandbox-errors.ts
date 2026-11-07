/** Thrown when a sandbox turn or reset is already in progress. */
export class SandboxBusyError extends Error {
  constructor(message = "sandbox is busy") {
    super(message);
    this.name = "SandboxBusyError";
  }
}

/** Thrown when sandbox code attempts a real external side effect. */
export class SandboxExternalBlockedError extends Error {
  constructor(service: string) {
    super(`external ${service} calls are blocked in the sandbox`);
    this.name = "SandboxExternalBlockedError";
  }
}
