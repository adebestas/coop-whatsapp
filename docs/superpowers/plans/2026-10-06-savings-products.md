# Savings Product Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add four savings products — fixed deposit (interest at maturity), goal/target savings (target + progress), seasonal savings, and guardian-managed junior/youth accounts — each as a separate product account a member can hold alongside their main wallet.

**Architecture:** `SavingsProduct` (per-coop product definitions) + `SavingsAccount` (a member's instance, with its own balance and lifecycle) + `SavingsDeposit` (movements). Money moves wallet → product account via the ledger (`member_wallet:<walletId>` / `liability:savings_product:<accountId>`), reusing the internal-transfer model.

**Tech Stack:** TypeScript (ESM `.js`), Fastify 5, Prisma 6, vitest 3, SQLite/Postgres.

**Spec:** `docs/superpowers/plans/2026-10-06-coop-world-class-roadmap.md` (Phase 4, Feature 7).

## Global Constraints
- Money integer kobo; `.js` imports; both schemas identical; no Prisma `enum`; new `cooperativeId` tables need RLS + FORCE-list entries.
- User decisions (2026-10-06): all four products; separate product accounts; fixed deposits earn interest at maturity (configurable); goal savings have a target + progress; junior accounts are guardian-managed.
- Verification per task: typecheck clean, lint 0 errors, targeted tests green.

---

### Task 1: Schema, migrations, RLS

**Files:** both schemas; `prisma/migrations/20261029000000_savings_products/migration.sql`; `prisma/migrations/20261030000000_savings_products_rls/migration.sql`; `prisma/rls/recommended_policies.sql`.

**Interfaces produced:**
- `SavingsProduct` (id, cooperativeId, type `// fixed | goal | seasonal | junior`, name, interestRate `Int @default(0)`, termMonths `Int?`, minAmount `Int @default(0)`, active `Boolean @default(true)`, createdById, createdAt; `@@unique([cooperativeId, type, name])`).
- `SavingsAccount` (id, cooperativeId, memberId, productId, balance `Int @default(0)`, targetAmount `Int?`, status `@default("active")` `// active | matured | closed`, guardianMemberId `String?`, openedAt, maturesAt `DateTime?`, createdAt; `@@index([cooperativeId, memberId])`).
- `SavingsDeposit` (id, accountId, memberId, amount `Int`, kind `// deposit | withdrawal | interest`, createdAt).
- Relations on `Cooperative`, `Member`, `SavingsProduct`.

- [ ] Add models + relations to both schemas.
- [ ] Migration `20261029000000_savings_products`: create the 3 tables, indexes, FKs.
- [ ] RLS migration `20261030000000_savings_products_rls`: `SavingsProduct`/`SavingsAccount` carry `cooperativeId` → direct policy; `SavingsDeposit`→`SavingsAccount` → parent-resolver policy.
- [ ] Add all three to the FORCE list in `prisma/rls/recommended_policies.sql`.
- [ ] `npm run prisma:generate:local`; `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`; `npx vitest run tests/schema-sync.test.ts` passes.
- [ ] Commit `feat(savings): savings-product schema, migration, RLS`.

### Task 2: Product service + commands (fixed, goal, seasonal)

**Files:** `src/services/savings-products.ts` (new), `src/services/admin.ts`, `src/services/conversation.ts`, `src/services/handlers/session.ts`, `tests/savings-products.test.ts` (new).

**Interfaces produced:** `createProduct(coopId, type, name, opts, actor)`, `listProducts(coopId)`, `openProduct(coopId, productId, memberId, target?)`, `depositToProduct(coopId, accountId, memberId, amount)`, `withdrawFromProduct(coopId, accountId, memberId, amount)`, `matureProduct(coopId, accountId, memberId)`, `listMemberProducts(coopId, memberId)`, `productProgress(account)`.

- [ ] **Tests (red):** open a goal product with a target, deposit, progress reflects the target, a 100% goal notifies; open a fixed deposit with a term and interest → at maturity the wallet is credited principal + interest; depositing beyond the wallet balance is refused; a non-owner cannot deposit/withdraw.
- [ ] Implement `savings-products.ts` (wallet-funded deposits; journals `member_wallet:<walletId>` ↔ `liability:savings_product:<accountId>`; fixed-deposit maturity credits principal + `interestRate`; goal progress + 100% notification; seasonal maturity date; audited).
- [ ] Admin commands: `newproduct <fixed|goal|seasonal> <name> [rate] [termMonths]`, `products`. Member commands: `products`, `openproduct <product id> [target]`, `saveproduct <account id> <amount>`, `myproducts`, `withdrawproduct <account id> <amount>`, `matureproduct <account id>`. Add to the menus.
- [ ] **Verify:** `npx vitest run tests/savings-products.test.ts`; typecheck; lint.
- [ ] Commit `feat(savings): fixed, goal and seasonal savings products`.

### Task 3: Junior accounts + docs

**Files:** `src/services/savings-products.ts`, `tests/savings-products.test.ts`, `README.md`.

**Interfaces produced:** `openJuniorAccount(coopId, productId, guardianMemberId, minorName, minorPhone?)` — a guardian opens a junior account; the guardian funds it; the account matures to the minor on maturity.

- [ ] **Tests (red):** a guardian opens a junior account for a minor, funds it, and the account is controlled by the guardian; the minor cannot withdraw; at maturity the balance is released to the minor.
- [ ] Implement junior accounts (guardian as `guardianMemberId`; only the guardian can deposit/withdraw until `maturesAt`).
- [ ] Add a `## Savings products` section to `README.md`.
- [ ] **Verify:** full gate + `npm test`.
- [ ] Commit `feat(savings): junior accounts and docs`.
