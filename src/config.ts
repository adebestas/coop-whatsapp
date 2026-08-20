import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "dev-verify-token",
  },
  allowedTestNumbers: (process.env.ALLOWED_TEST_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
  defaultCoopCode: process.env.DEFAULT_COOP_CODE ?? "TEST01",
};

export function isAllowed(phone: string): boolean {
  if (config.allowedTestNumbers.length === 0) return true;
  return config.allowedTestNumbers.includes(phone);
}