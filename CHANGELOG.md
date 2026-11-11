# Changelog

Notable changes to Coop WhatsApp. Format follows Keep a Changelog; versions use
SemVer.

## [1.0.0] - 2026-11-11

First pilot release. The security and data-protection pass below is why the
version jumps from 0.1.0.

### Security

- Admin and developer logins now require TOTP, with a one-time claim on each
  code so a captured code cannot be replayed inside its validity window.
  Replays raise a security event.
- Foreign-origin POST/PUT/PATCH/DELETE requests to the admin and developer APIs
  are rejected (Origin check in addition to SameSite cookies).
- Global error handler no longer echoes internal error text on 5xx; responses
  carry the request id for log correlation.
- Logger redacts phone numbers, PINs, tokens, secrets, passwords, BVN/NIN,
  account numbers, and OTP/TOTP values from structured metadata.
- Error responses and logs are covered by regression tests.
- Dependency audit (production), secret scan (gitleaks), and post-deploy health
  smoke checks are part of CI.

### Data protection (NDPA)

- Account erasure now removes linked PII in the same transaction: beneficial
  owners, beneficiaries, favourite payees, pending phone-change requests,
  sessions, and webhook failures. Audit entries written at erasure use a
  pseudonym instead of the member's phone number.
- The retention scheduler erases the same linked records for dormant members and
  purges webhook-failure payloads older than 30 days.

### Reliability

- Backup configuration documented for managed deploys: `BACKUP_BUCKET`,
  `BACKUP_KEY`, `BACKUP_SECRET` (plus endpoint/region), with a fail-closed
  production default and a post-first-night verification step.

### Performance

- Text responses are gzip-compressed; dashboard JS/CSS is cacheable for an hour
  while the HTML shell always revalidates.
- Added a k6 load-smoke script (`scripts/load-smoke.js`).

### Accessibility

- Dashboard and developer-console toasts are live regions; error toasts use
  `role="alert"`. Login errors are announced, the submit button exposes
  `aria-busy`, and the authenticator-key label is no longer mis-associated.

### Documentation

- README support workflow, `DEPLOY.md` backup section, `deploy/.env.example`
  backup and `DASHBOARD_ORIGIN` notes.
