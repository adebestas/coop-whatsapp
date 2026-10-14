// NOTE: Cross-border data transfer provisions — per Nigeria Data Protection
// Regulation (NDPR) and Nigeria Data Protection Act 2023, personal data of
// Nigerian citizens must not be transferred outside Nigeria without adequate
// safeguards. All database hosting, backups, and processing should remain
// within Nigeria or in jurisdictions with equivalent data protection standards.
// Ensure any third-party services (Redis, AI providers, payment gateways)
// comply with NDPR cross-border transfer requirements.

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
  // CubeCover embedded insurance. The API endpoints/signature header below are
  // INFERRED from CubeCover's public material — confirm them against the real
  // developer docs during onboarding before go-live.
  cubecover: {
    apiKey: process.env.CUBECOVER_API_KEY ?? "",
    baseUrl: process.env.CUBECOVER_BASE_URL ?? "https://api.cubecover.ai",
    webhookSecret: process.env.CUBECOVER_WEBHOOK_SECRET ?? "",
    // CubeCover delivers live doctor consultations through its own app/portal
    // (no consultation API is exposed), so the telemedicine handoff deep-links
    // the member out to CubeCover.
    telemedicineUrl: process.env.CUBECOVER_TELEMEDICINE_URL ?? "https://cubecover.ai",
  },
  allowedTestNumbers: (process.env.ALLOWED_TEST_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
  defaultCoopCode: process.env.DEFAULT_COOP_CODE ?? "TEST01",
  // Public base URL used to build shareable/verifiable links (e.g. certificate
  // verification). Override in production with the real host.
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://coop.example",
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
