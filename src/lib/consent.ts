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

export const MESSAGE_CONSENT_REASK = "Please reply *YES* to receive messages from your cooperative, or *NO* to skip them.";
