/**
 * Message-consent (NDPR) copy shared by the chat `join` flow and the consent gate in
 * conversation.ts. Keep the YES/NO instruction here in one place: the
 * `awaiting_optin` session state only accepts those two answers.
 */
export const MESSAGE_CONSENT_PROMPT =
  "📱 *Message Consent*\n\n" +
  "Do you consent to receive messages from this cooperative? " +
  "This includes savings alerts, loan updates, and important notices.\n\n" +
  "Reply *YES* to opt-in or *NO* to skip. (You can still use commands like *balance* either way.)";

export const MESSAGE_CONSENT_REASK =
  "Please reply *YES* to receive messages from your cooperative, or *NO* to skip them.";

/**
 * AI-processing consent (NDPR). Voice notes and messages written in another
 * language are sent to a third-party LLM (Groq) to be turned into English text.
 * That is a separate purpose from "receive messages", so it needs its own,
 * specific consent before any content leaves WhatsApp.
 */
export const AI_CONSENT_PROMPT =
  "🤖 *AI processing*\n\n" +
  "To read *voice notes* and to understand messages written in another language, " +
  "I send their content to our AI processor (Groq). That means it leaves WhatsApp.\n\n" +
  "Reply *YES* to allow this, or *NO* to keep them on your device (I won't be able to read voice notes or non-English messages).";

export const AI_CONSENT_REASK =
  "Please reply *YES* to allow AI processing of voice notes and non-English messages, or *NO* to decline.";

export const AI_CONSENT_GRANTED =
  "✅ Thank you. I can now read your voice notes and messages written in other languages.";

export const AI_CONSENT_DECLINED =
  "Understood — I won't send any voice notes or non-English messages to the AI. " +
  "Please type in English. You can enable AI processing later by replying *aioptin*.";
