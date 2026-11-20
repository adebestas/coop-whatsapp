/**
 * Disposable / throwaway email screening.
 *
 * Sign-in links are the only credential an admin receives by email, so a
 * throwaway inbox makes account recovery meaningless. A curated static list
 * covers the common providers; operators can extend it at boot with
 * `DISPOSABLE_EMAIL_DOMAINS=foo.com,bar.net`.
 *
 * The domain list is intentionally small and boring: it is a speed bump, not a
 * security boundary, and false positives (blocking a real co-op domain) are
 * worse than letting an obscure provider through.
 */

const BUILTIN_DISPOSABLE_DOMAINS: readonly string[] = [
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "anonbox.net",
  "burnermail.io",
  "byom.de",
  "discard.email",
  "discardmail.com",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "fakeinbox.com",
  "fakemail.net",
  "getnada.com",
  "getairmail.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxkitten.com",
  "jetable.org",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mintemail.com",
  "moakt.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spam4.me",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempinbox.com",
  "tempmail.dev",
  "tempmail.email",
  "tempmailo.com",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "yopmail.com",
  "yopmail.fr",
  "yuurok.com",
];

let cached: Set<string> | null = null;

function normalise(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\.+$/, "");
}

/** Built-in list merged with DISPOSABLE_EMAIL_DOMAINS (read once at boot). */
export function disposableEmailDomains(): ReadonlySet<string> {
  if (cached) return cached;
  const set = new Set(BUILTIN_DISPOSABLE_DOMAINS);
  for (const raw of (process.env.DISPOSABLE_EMAIL_DOMAINS ?? "").split(",")) {
    const domain = normalise(raw);
    if (domain) set.add(domain);
  }
  cached = set;
  return set;
}

/** Test-only: forget the merged list so the next call re-reads the env. */
export function resetDisposableEmailCache(): void {
  cached = null;
}

/** True when the address is syntactically plausible but uses a throwaway domain. */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const domain = normalise(email.slice(at + 1));
  if (!domain) return false;
  const domains = disposableEmailDomains();
  if (domains.has(domain)) return true;
  // Sub-domains of a listed provider (user@mail.mailinator.com) count too.
  for (const listed of domains) {
    if (domain.endsWith(`.${listed}`)) return true;
  }
  return false;
}

/**
 * Gate before an email is accepted for sign-in or identity. The rejection
 * message is deliberately vague so it does not read as a domain blocklist.
 */
export function rejectDisposableEmail(email: string): { ok: true } | { ok: false; message: string } {
  if (isDisposableEmail(email)) {
    return { ok: false, message: "Please use a different email address." };
  }
  return { ok: true };
}
