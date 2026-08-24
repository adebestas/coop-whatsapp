/**
 * Custom error types for the coop platform.
 * Provides structured error handling with HTTP status codes and error codes.
 */

export class CoopError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoopError";
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

// ===== Authentication Errors =====

export class UnauthorizedError extends CoopError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", 401, message);
  }
}

export class ForbiddenError extends CoopError {
  constructor(message = "Insufficient permissions") {
    super("FORBIDDEN", 403, message);
  }
}

export class InvalidPinError extends CoopError {
  constructor(attemptsRemaining: number) {
    super("INVALID_PIN", 401, `Invalid PIN. ${attemptsRemaining} attempts remaining.`);
  }
}

export class PinLockedError extends CoopError {
  constructor(unlockAt: Date) {
    super("PIN_LOCKED", 429, `Account locked. Try again after ${unlockAt.toISOString()}.`);
  }
}

export class TwoFactorRequiredError extends CoopError {
  constructor() {
    super("2FA_REQUIRED", 403, "Two-factor authentication required for this action.");
  }
}

// ===== Validation Errors =====

export class ValidationError extends CoopError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", 400, message, details);
  }
}

export class InvalidInputError extends CoopError {
  constructor(field: string, reason: string) {
    super("INVALID_INPUT", 400, `Invalid ${field}: ${reason}`);
  }
}

// ===== Business Logic Errors =====

export class InsufficientBalanceError extends CoopError {
  constructor(available: number, requested: number) {
    super("INSUFFICIENT_BALANCE", 400, `Insufficient balance. Available: ₦${available.toLocaleString()}, Requested: ₦${requested.toLocaleString()}`);
  }
}

export class LoanLimitExceededError extends CoopError {
  constructor(limit: number, requested: number) {
    super("LOAN_LIMIT_EXCEEDED", 400, `Loan limit exceeded. Maximum: ₦${limit.toLocaleString()}, Requested: ₦${requested.toLocaleString()}`);
  }
}

export class WithdrawalLimitError extends CoopError {
  constructor(nextAvailable: Date) {
    super("WITHDRAWAL_LIMIT", 400, `Withdrawal not allowed. Next available: ${nextAvailable.toISOString()}`);
  }
}

export class BeneficiaryHoldError extends CoopError {
  constructor(holdUntil: Date) {
    super("BENEFICIARY_HOLD", 400, `New beneficiary on hold until ${holdUntil.toISOString()}`);
  }
}

export class DefaulterBlockedError extends CoopError {
  constructor() {
    super("DEFAULTER_BLOCKED", 400, "Account blocked due to outstanding loan default.");
  }
}

// ===== Resource Errors =====

export class NotFoundError extends CoopError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id ${id} not found` : `${resource} not found`;
    super("NOT_FOUND", 404, message);
  }
}

export class DuplicateError extends CoopError {
  constructor(resource: string, details?: Record<string, unknown>) {
    super("DUPLICATE", 409, `${resource} already exists`, details);
  }
}

// ===== Rate Limiting =====

export class RateLimitError extends CoopError {
  constructor(action: string, retryAfter: number) {
    super("RATE_LIMITED", 429, `Too many ${action} requests. Retry after ${retryAfter} seconds.`);
  }
}

// ===== Provider Errors =====

export class ProviderError extends CoopError {
  constructor(provider: string, message: string) {
    super("PROVIDER_ERROR", 502, `${provider} error: ${message}`);
  }
}

export class ProviderUnavailableError extends CoopError {
  constructor(provider: string) {
    super("PROVIDER_UNAVAILABLE", 503, `${provider} is currently unavailable`);
  }
}

// ===== System Errors =====

export class InternalError extends CoopError {
  constructor(message = "Internal server error") {
    super("INTERNAL_ERROR", 500, message);
  }
}

export class ConfigurationError extends CoopError {
  constructor(message: string) {
    super("CONFIGURATION_ERROR", 500, message);
  }
}

// ===== Error Handler Helper =====

export function handleError(error: unknown): CoopError {
  if (error instanceof CoopError) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message);
  }

  return new InternalError("An unknown error occurred");
}
