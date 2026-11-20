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

`src/lib/pick.ts` holds `FORBIDDEN_INPUT_FIELDS`: `id`, `role`, `isAdmin`,
`plan`, `cooperativeId`, `status`, `balance`, `pin`, `totpSecret`,
`phoneVerified`, `createdAt`, `updatedAt`. `phoneVerified` is deny-listed so a
request cannot skip the Phase 4 OTP step.

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
