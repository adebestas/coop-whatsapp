import { z } from "zod";

// ===== Common schemas =====

export const PhoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)");

export const PositiveIntSchema = z.number().int().positive();

export const PositiveAmountSchema = z
  .number()
  .positive("Amount must be positive")
  .max(100_000_000, "Amount exceeds maximum (₦100M)");

export const MemberCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{6}-[A-Z0-9]{4}$/, "Invalid member code format");

export const BankCodeSchema = z
  .string()
  .regex(/^\d{3,6}$/, "Bank code must be 3-6 digits");

export const AccountNumberSchema = z
  .string()
  .regex(/^\d{10}$/, "Account number must be 10 digits");

// ===== Command schemas =====

export const SaveSchema = z.object({
  amount: PositiveAmountSchema,
});

export const LoanSchema = z.object({
  amount: PositiveAmountSchema,
  months: z.number().int().min(1).max(24, "Loan tenure max 24 months"),
});

export const WithdrawSchema = z.object({
  amount: PositiveAmountSchema,
});

export const PayAnyoneSchema = z.object({
  amount: PositiveAmountSchema,
  account: AccountNumberSchema,
  bank: BankCodeSchema,
  name: z.string().min(2).max(100),
  narration: z.string().min(3).max(200),
});

export const RepaySchema = z.object({
  amount: z.number().positive().optional(), // If omitted, pays full installment
});

export const SetRoleSchema = z.object({
  memberCode: MemberCodeSchema,
  role: z.enum(["member", "admin", "superadmin", "support"]),
});

export const VoteSchema = z.object({
  electionId: z.string().min(1),
  candidateCode: MemberCodeSchema,
});

// ===== Onboarding schemas =====

export const OnboardingNameSchema = z.object({
  name: z.string().min(2).max(100).regex(/^[a-zA-Z\s'-]+$/, "Name contains invalid characters"),
});

export const OnboardingEmailSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const OnboardingPhoneSchema = z.object({
  phone: PhoneSchema,
});

export const OnboardingNokSchema = z.object({
  name: z.string().min(2).max(100),
  phone: PhoneSchema,
});

export const PinSchema = z
  .string()
  .length(4, "PIN must be exactly 4 digits")
  .regex(/^\d{4}$/, "PIN must contain only digits");

// ===== Validation helper =====

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): ValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errorMessage = result.error.errors.map((e) => e.message).join("; ");
  return { success: false, error: errorMessage };
}

// ===== Amount limits =====

export const LIMITS = {
  MIN_SAVE: 100, // ₦100
  MAX_SAVE: 10_000_000, // ₦10M
  MIN_LOAN: 1_000, // ₦1,000
  MAX_LOAN: 50_000_000, // ₦50M
  MIN_WITHDRAW: 100, // ₦100
  MAX_WITHDRAW: 20_000_000, // ₦20M
  MAX_LOAN_TENURE: 24, // months
  MIN_LOAN_TENURE: 1, // month
  MAX_PAYANYONE: 50_000_000, // ₦50M per transaction
  DAILY_PAYANYONE_LIMIT: 100_000_000, // ₦100M per day
} as const;
