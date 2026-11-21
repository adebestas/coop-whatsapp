import nodemailer from "nodemailer";

export interface MailAttachment {
  path?: string;
  filename?: string;
  content?: string | Buffer;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

/** True when SMTP is configured well enough to attempt delivery. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

/**
 * Send one plain-text message. Returns false (never throws) so callers can
 * decide whether a mail failure should fail the request.
 */
export async function sendEmail(message: MailMessage): Promise<boolean> {
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.warn("[email] SMTP_HOST unset; message not sent");
    return false;
  }
  try {
    const transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments?.map((a) => ({
        path: a.path,
        filename: a.filename,
        content: a.content,
      })),
    });
    return true;
  } catch (err) {
    console.error("[email] send failed:", err);
    return false;
  }
}
