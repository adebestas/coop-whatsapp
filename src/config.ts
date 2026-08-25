export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    // Published WhatsApp Flow used for hidden PIN/OTP entry (see flows/pin-flow.json).
    pinFlowId: process.env.WHATSAPP_PIN_FLOW_ID ?? "",
    // "draft" lets you test an unpublished Flow; publish before go-live.
    pinFlowMode: process.env.WHATSAPP_PIN_FLOW_MODE ?? "published",
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
  },
  allowedTestNumbers: (process.env.ALLOWED_TEST_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
  defaultCoopCode: process.env.DEFAULT_COOP_CODE ?? "TEST01",
};

export function validateConfig() {
  if (!config.whatsapp.token && process.env.NODE_ENV === "production") {
    throw new Error("WHATSAPP_TOKEN is required in production");
  }
  if (!config.telegram.token && process.env.NODE_ENV === "production") {
    console.warn("[config] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled in production");
  }
}

export function isAllowed(phone: string): boolean {
  if (config.allowedTestNumbers.length === 0) return true;
  return config.allowedTestNumbers.includes(phone);
}