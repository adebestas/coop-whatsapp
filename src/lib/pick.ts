/**
 * Input-surface guard for mass assignment.
 *
 * Routes should build `data` objects field by field, never spread a request
 * body into Prisma. These helpers make the allow-list explicit and give the
 * regression suite a single place to assert the deny-list.
 */

/**
 * Fields that must never arrive from a request body, on any endpoint.
 * `phoneVerified` is included because a client that could set it would skip
 * the OTP step entirely.
 */
export const FORBIDDEN_INPUT_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "userId",
  "ownerId",
  "createdById",
  "role",
  "isAdmin",
  "plan",
  "subscriptionPlan",
  "cooperativeId",
  "status",
  "balance",
  "pin",
  "totpSecret",
  "phoneVerified",
  "mustChangePin",
  "createdAt",
  "updatedAt",
]);

/** Names of forbidden fields present on a body (empty when clean). */
export function forbiddenFieldsIn(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).filter((key) =>
    FORBIDDEN_INPUT_FIELDS.has(key),
  );
}

/**
 * Copy only the listed keys from a request body. Undefined values are kept
 * out so a Partial update never writes `undefined` over a stored value.
 */
export function pickAllowed<T extends Record<string, unknown>, K extends keyof T & string>(
  body: unknown,
  fields: readonly K[],
): Partial<Pick<T, K>> {
  const source = (body ?? {}) as Record<string, unknown>;
  const out: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      const value = source[field];
      if (value !== undefined) {
        (out as Record<string, unknown>)[field] = value;
      }
    }
  }
  return out;
}

/** Same as pickAllowed but drops every deny-listed key first. */
export function stripForbidden<T extends Record<string, unknown>>(body: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!FORBIDDEN_INPUT_FIELDS.has(key) && value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
