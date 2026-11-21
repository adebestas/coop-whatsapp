# Input-surface audit (mass assignment)

Date: 2026-11-20. Scope: every route that writes a stored record from a request
body. Method: grep for `prisma.*.create|update|upsert` whose `data` derives from
`req.body`, then read each hit.

## Verdict

No route spreads a request body into Prisma. Bodies are destructured field by
field against an inline type, or passed to a service that re-derives the values
it writes. Two nested objects needed a closer look and both are explicit:

| Location                                              | Shape                            | Result                                                                                    |
| ----------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/routes/developer.ts` `POST /api/developer/coops` | `body.superAdmin` spread         | Safe: only `name` and `phone` are read; `phone` is overwritten with the normalised value. |
| `src/services/platform-coops.ts` `createCoop`         | forwards `input`                 | Safe: passes named fields to `provisionCooperative`.                                      |
| `src/services/referrals.ts`                           | `{ cooperativeId, ...data }`     | Safe: `data` is built by the service, not from the body.                                  |
| `src/services/sanctions-refresh.ts`                   | `{ id: "global", ...data }`      | Safe: fixed literal id wins.                                                              |
| `src/services/scheduler.ts`                           | `{ ...data, status: "pending" }` | Safe: service-owned payload.                                                              |

## Deny-list

`src/lib/pick.ts` holds `FORBIDDEN_INPUT_FIELDS`: `id`, `userId`, `ownerId`,
`createdById`, `role`, `isAdmin`, `plan`, `subscriptionPlan`, `cooperativeId`,
`status`, `balance`, `pin`, `totpSecret`, `phoneVerified`, `mustChangePin`,
`createdAt`, `updatedAt`. `phoneVerified` is deny-listed so a request cannot
skip the Phase 4 OTP step.

`src/routes/admin.ts` enforces this deny-list centrally: `withTenant()` runs
before every coop-dashboard handler and rejects a mutating request (anything
other than GET/HEAD/OPTIONS) whose body contains a forbidden field with
`400 {error, fields}`. Handlers still build `data` field by field; the guard is
the backstop for fields added later.

## Endpoints inspected (representative, mutating)

- `POST /api/admin/savings/products`, `PATCH /api/admin/savings/products/:id`
- `POST /api/admin/savings/accounts`
- `POST /api/admin/meetings`, `PATCH /api/admin/meetings/:id`
- `POST /api/admin/payroll/set`, `POST /api/admin/payroll/run`
- `POST /api/admin/posts`, `POST /api/admin/posts/:id/assign`
- `POST /api/admin/funds/reserve/allocate`
- `POST /api/admin/refunds/:id/reject`, `POST /api/admin/loans/:id/approve`
- `POST /api/developer/coops`, `PATCH /api/developer/coops/:id`
- `POST /api/admin/members/import`

## Regression coverage

`tests/mass-assignment.test.ts` posts every deny-listed field to the mutating
endpoints above and asserts the stored rows are unchanged. The test reads the
rows directly rather than trusting the response.

## Follow-up pass (2026-11-21): role writes and raw bodies

Re-audit of every place a request body is spread or persisted verbatim, plus
every role write reachable with attacker-influenced input. Answer to "which
endpoints save the whole request body": **none** — the only spreads were
`developer.ts`'s `...safeBody` (into `createCoop`, which reads named fields)
and `detail: JSON.stringify(body)` on the policy audit row. Both now use
explicit fields.

| Finding | Where | Fix |
| --- | --- | --- |
| `setCoopAdminRole` updated a member by `id` alone, so a platform admin could promote a member of another cooperative through `coops/:id` | `src/services/platform-coops.ts` | Runtime role check + `updateMany({ id, cooperativeId })`; `P2025` (→ `404`) when nothing matched |
| `addCoopAdmin` trusted its runtime `role` (callers coerced, but the union is erased) | `src/services/cooperative-provisioning.ts` | Explicit `admin`/`superadmin` allow-list, throws otherwise |
| `createPlatformAdmin` silently downgraded an unknown role to `developer` | `src/services/platform-admin.ts` | Missing role → schema default `developer`; explicit unknown role throws (`400` at the route) |
| `POST /api/developer/coops` spread `...safeBody` | `src/routes/developer.ts` | Fields copied one by one; `superAdmin.phone` still overwritten with the normalised admin phone |
| `policy.set` audit stored client JSON verbatim | `src/routes/developer.ts` | Audit detail built from `{value,min,max,locked}` only |

Already safe and left alone: webhooks verify the raw body signature and trust
no body identifiers; `POST /api/admin/members/import` hardcodes `role: "member"`
(`src/services/bulk-import.ts:156`); WhatsApp join omits `role` (Prisma default
`member`);
the chat `setrole` command is superadmin-only with a last-superadmin guard;
`adminContext` re-reads the live role and `active` status on every request.

