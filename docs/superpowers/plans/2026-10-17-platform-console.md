# Platform Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-owner ("developer") console that provisions cooperatives, manages their admins, sets platform rules with per-coop overrides, and monitors/operates every cooperative — without weakening tenant isolation.

**Architecture:** New `PlatformAdmin` identity with a platform-scoped HMAC token (`scope:"platform"`, no `cooperativeId`); a typed rule registry + `PlatformPolicy` layer that `getCoopConfig` applies as defaults/bounds; provisioning extracted from the chat onboarding flow; monitoring computed per-coop inside `withCoopContext`; a static console under `dashboard/dev/`.

**Tech Stack:** TypeScript, Fastify 5, Prisma (Postgres + mirrored SQLite), Redis (cache/rate-limit, in-memory fallback in tests), Vitest, plain-JS static dashboard.

**Spec:** `docs/superpowers/specs/2026-10-17-platform-console-design.md` (and `docs/NIGERIA-COOPERATIVE-COMPLIANCE.md`)

## Deviations from spec (deliberate — this plan supersedes the spec where they differ)

- **Audit table**: the spec extends the coop-scoped `AuditLog` with `actorType`/`actorId`. But `AuditLog.cooperativeId` is **required**, so a platform (cross-coop) action cannot be written there without a bogus coop. This plan instead adds a global **`PlatformAuditLog`** table and a single writer `writePlatformAudit(entry)` (Task 1 + Task 5). No `AuditLog` schema change is made.
- **Cross-coop overview**: the spec proposed two new `SECURITY DEFINER` count-only helpers. This plan instead iterates `listCooperativeIds()` and computes each coop's stats inside `withCoopContext` (Task 8) — same isolation, no new SQL surface.
- **Policy cache**: the spec described a Redis version-keyed cache. This plan uses a process-local TTL cache with an explicit `clearPlatformPolicyCache()` (Task 3), consistent with `src/services/coop-config.ts`'s existing caching, and invalidated on every write.
- **Compliance fields**: spec §4.8 lists "state, registration number/CVN, TIN, SCUML, DPO"; this plan adds `registrationNumber`, `cvn`, `scumlStatus`, `dpoName`, `dpoPhone`, `dpoEmail`, and `tin` (Task 13). `state` already exists on `Cooperative`.

## Global Constraints

- Every schema change MUST be mirrored into BOTH `prisma/schema.prisma` (Postgres) and `prisma/schema.local.prisma` (SQLite); `tests/schema-sync.test.ts` fails otherwise. Only the `provider` line may differ.
- Tests run on SQLite at `file:./dev.db`. `pretest` only generates the Prisma client; a fresh checkout must `npx prisma db push --schema prisma/schema.local.prisma --skip-generate` before tests.
- Gates per task: `npx tsc --noEmit` clean, `npx eslint src/` 0 errors, `npm run format:check` clean (prettier checks `src/**/*.ts` only; format new files with `npx prettier --write <files>`).
- The platform token is a distinct scope: it MUST be rejected by `/api/admin/*`, and coop admin tokens MUST be rejected by `/api/developer/*`.
- Never issue unscoped (cross-tenant) Prisma queries outside `withCoopContext`, except the existing/new `SECURITY DEFINER` helpers and global tables (`PlatformAdmin`, `PlatformPolicy`, `PlatformAuditLog`).
- Exact existing signatures to call (do not redefine):
  - `sign(phone, cooperativeId, role): string`, `verifyAdminToken(token): AdminTokenPayload | null`, `revokeToken(token): Promise<void>`, `isTokenRevoked(token): Promise<boolean>`, `TOKEN_TTL_MS` — `src/lib/admin-auth.ts`
  - `hashPin(pin): string`, `verifyPin(pin, stored): boolean` — `src/lib/security.ts`
  - `generateTotpSecret(bytes=20): string`, `verifyTotp(secret, code, timeMs?): boolean`, `otpauthUri(secret, accountLabel, issuer="Coop"): string` — `src/lib/totp.ts`
  - `withCoopContext<T>(cooperativeId, fn): Promise<T>`, `listCooperativeIds(): Promise<string[]>`, `rlsEnforcementStatus()` — `src/lib/tenant-context.ts`
  - `getCoopConfig(cooperativeId): Promise<CoopConfig>`, `updateCoopConfig(cooperativeId, updates): Promise<CoopConfig>` — `src/services/coop-config.ts`
  - `createCooperative(data): Promise<Cooperative>`, `audit(entry: AuditEntry): Promise<void>` — `src/services/cooperative.ts`, `src/services/audit.ts`
  - `checkRateLimit(key, max, windowSeconds): Promise<{allowed:boolean;retryAfter?:number}>`, `resetRateLimit(key)`, `getRedis()` — `src/lib/cache.ts`
  - `sendText({to, text}): Promise<boolean>` — `src/lib/messaging.js`
- Admin plugin pattern to mirror: `export async function adminApiRoutes(app: FastifyInstance)` in `src/routes/admin.ts:102`, registered in `src/app.ts:165` via `void app.register(adminApiRoutes)`. `FastifyRequest` is augmented in `src/app.ts:18-24` (`adminPhone`/`adminCoopId`/`adminRole`).

---

## Phase 1 — Platform Console

### Task 1: Schema — PlatformAdmin, PlatformPolicy, PlatformAuditLog, new config rules

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma`
- Create: `prisma/migrations/20261018000000_platform_console/migration.sql`, `src/services/platform-audit.ts`
- Test: `tests/platform-schema.test.ts`

**Interfaces:**
- Produces: tables `PlatformAdmin`, `PlatformPolicy`, `PlatformAuditLog`; `Cooperative.tokensValidAfter`; new `CooperativeConfig` columns `loanDurationMonths`, `minLoanTermMonths`, `maxLoanPerMember`, `minMembershipMonths`; `writePlatformAudit(entry): Promise<void>` (the single writer every later platform mutation calls).
- Consumes: `prisma`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-schema.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";

describe("platform schema", () => {
  it("creates a PlatformAdmin with a platform role", async () => {
    const a = await prisma.platformAdmin.create({
      data: { name: "Owner", phone: "2348000000001", role: "owner", pin: "x:y" },
    });
    expect(a.id).toBeTruthy();
    expect(a.role).toBe("owner");
  });
  it("creates a PlatformPolicy row keyed by rule", async () => {
    const p = await prisma.platformPolicy.create({
      data: { key: "loanInterestRate", value: "10", min: 1, max: 60, locked: false },
    });
    expect(p.key).toBe("loanInterestRate");
  });
  it("stores a Cooperative.tokensValidAfter timestamp", async () => {
    const c = await prisma.cooperative.create({
      data: { name: "T", code: "PTEST1", tokensValidAfter: new Date() },
    });
    expect(c.tokensValidAfter).toBeInstanceOf(Date);
  });
  it("has the new loan-term config columns", async () => {
    const c = await prisma.cooperative.create({ data: { name: "T2", code: "PTEST2" } });
    const cfg = await prisma.cooperativeConfig.create({
      data: { cooperativeId: c.id, loanDurationMonths: 12, minMembershipMonths: 0 },
    });
    expect(cfg.loanDurationMonths).toBe(12);
  });
  it("writes a platform audit row via the writer", async () => {
    const { writePlatformAudit } = await import("../src/services/platform-audit.js");
    await writePlatformAudit({ actorId: "pa1", actorPhone: "2348000000001", actorRole: "owner", action: "coop.create", cooperativeId: "c1", targetType: "Cooperative", targetId: "c1", detail: "{}" });
    const rows = await prisma.platformAuditLog.findMany({ where: { action: "coop.create" } });
    expect(rows.length).toBe(1);
    expect(rows[0].actorRole).toBe("owner");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-schema.test.ts`
Expected: FAIL — `prisma.platformAdmin` is undefined / unknown arg.

- [ ] **Step 3: Add the models to BOTH schema files**

Add to `prisma/schema.prisma` and `prisma/schema.local.prisma`:

```prisma
model PlatformAdmin {
  id               String    @id @default(cuid())
  name             String
  phone            String    @unique
  role             String    @default("developer") // owner | developer | support
  pin              String?   // hashed, "<salt>:<scrypthex>"
  totpSecret       String?
  totpEnabled      Boolean   @default(false)
  active           Boolean   @default(true)
  mustChangePin    Boolean   @default(true)
  tokensValidAfter DateTime?
  createdById      String?
  lastLoginAt      DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
}

model PlatformPolicy {
  key         String   @id
  value       String?  // JSON-encoded value
  min         Float?
  max         Float?
  locked      Boolean  @default(false)
  updatedById String?
  updatedAt   DateTime @updatedAt
}

model PlatformAuditLog {
  id             String   @id @default(cuid())
  actorId        String?
  actorPhone     String
  actorRole      String
  action         String
  cooperativeId  String?
  targetType     String?
  targetId       String?
  detail         String?
  createdAt      DateTime @default(now())
  @@index([action])
  @@index([cooperativeId, createdAt])
}
```

Add to `model Cooperative` (both files): `tokensValidAfter DateTime?`.

Add to `model CooperativeConfig` (both files):
```prisma
  loanDurationMonths   Int  @default(12)
  minLoanTermMonths    Int  @default(1)
  maxLoanPerMember     Int  @default(0)  // kobo; 0 = unlimited
  minMembershipMonths  Int  @default(0)
```

- [ ] **Step 3b: Add the platform audit writer**

```ts
// src/services/platform-audit.ts
import { prisma } from "../lib/prisma.js";

export interface PlatformAuditEntry {
  actorId?: string | null;
  actorPhone: string;
  actorRole: string;
  action: string;
  cooperativeId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
}

/** Best-effort global audit for platform (cross-coop) actions. */
export async function writePlatformAudit(entry: PlatformAuditEntry): Promise<void> {
  try {
    await prisma.platformAuditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorPhone: entry.actorPhone,
        actorRole: entry.actorRole,
        action: entry.action,
        cooperativeId: entry.cooperativeId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? null,
      },
    });
  } catch (err) {
    console.error("[platform-audit] write failed", err);
  }
}
```

- [ ] **Step 4: Migrate + regenerate + push SQLite**

```bash
npx prisma migrate dev --name platform_console --create-only --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.local.prisma
npx prisma db push --schema prisma/schema.local.prisma --skip-generate
```
(If `migrate --create-only` is unavailable offline, hand-write `prisma/migrations/20261018000000_platform_console/migration.sql` with `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN` statements matching the models, then `npx prisma generate`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/platform-schema.test.ts tests/schema-sync.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations src/services/platform-audit.ts tests/platform-schema.test.ts
git commit -m "feat(platform): schema for PlatformAdmin, PlatformPolicy, PlatformAuditLog + loan-term rules"
```

---

### Task 2: Typed rule registry

**Files:**
- Create: `src/lib/rule-registry.ts`
- Test: `tests/rule-registry.test.ts`

**Interfaces:**
- Produces: `RuleDef`, `RULE_REGISTRY: Record<string, RuleDef>`, `getRule(key): RuleDef | undefined`, `RULE_KEYS: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rule-registry.test.ts
import { describe, it, expect } from "vitest";
import { RULE_REGISTRY, getRule, RULE_KEYS } from "../src/lib/rule-registry.js";

describe("rule registry", () => {
  it("contains the core loan rules", () => {
    for (const k of ["loanInterestRate", "loanDurationMonths", "maxLoanMultiplier", "minGuarantors"]) {
      expect(RULE_KEYS).toContain(k);
    }
  });
  it("rejects out-of-range and unknown keys", () => {
    expect(getRule("nope")).toBeUndefined();
    expect(getRule("loanDurationMonths")!.min).toBe(1);
    expect(getRule("loanInterestRate")!.max).toBe(60);
    expect(getRule("loanDurationMonths")!.default).toBe(12);
  });
  it("every rule default is within its own bounds", () => {
    for (const [k, r] of Object.entries(RULE_REGISTRY)) {
      if (typeof r.default === "number") {
        expect(r.default, k).toBeGreaterThanOrEqual(r.min ?? -Infinity);
        expect(r.default, k).toBeLessThanOrEqual(r.max ?? Infinity);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rule-registry.test.ts`
Expected: FAIL — cannot find module `../src/lib/rule-registry.js`.

- [ ] **Step 3: Write the registry**

```ts
// src/lib/rule-registry.ts
export type RuleType = "int" | "float" | "bool" | "money" | "enum" | "percent";
export type RuleCategory =
  | "loans" | "savings" | "withdrawals" | "governance" | "compliance" | "literacy" | "referral" | "general";

export interface RuleDef {
  key: string; label: string; description: string; category: RuleCategory; type: RuleType;
  unit?: string; default: number | boolean | string; min?: number; max?: number;
  coopEditable: boolean; statutory?: string;
}

const R = (r: RuleDef): RuleDef => r;

export const RULE_REGISTRY: Record<string, RuleDef> = Object.fromEntries(
  [
    R({ key: "loanInterestRate", label: "Loan interest rate", description: "Monthly interest % on loans", category: "loans", type: "percent", unit: "%/mo", default: 10, min: 0, max: 60, coopEditable: true, statutory: "Act s.11(3)" }),
    R({ key: "loanDurationMonths", label: "Max loan duration", description: "Maximum repayment period in months", category: "loans", type: "int", unit: "months", default: 12, min: 1, max: 60, coopEditable: true, statutory: "Act s.11(3)" }),
    R({ key: "minLoanTermMonths", label: "Min loan term", description: "Minimum repayment period in months", category: "loans", type: "int", unit: "months", default: 1, min: 1, max: 60, coopEditable: true }),
    R({ key: "maxLoanPerMember", label: "Max loan per member", description: "Maximum single loan (kobo); 0 = unlimited", category: "loans", type: "money", unit: "kobo", default: 0, min: 0, coopEditable: true, statutory: "Act s.11(3)" }),
    R({ key: "maxLoanMultiplier", label: "Loan-to-savings multiplier", description: "Max loan as a multiple of savings", category: "loans", type: "int", unit: "x", default: 3, min: 1, max: 10, coopEditable: true }),
    R({ key: "minMembershipMonths", label: "Min membership before loan", description: "Months a member must belong before borrowing", category: "loans", type: "int", unit: "months", default: 0, min: 0, max: 60, coopEditable: true }),
    R({ key: "minGuarantors", label: "Minimum guarantors", description: "Guarantors required per loan", category: "loans", type: "int", unit: "people", default: 2, min: 0, max: 10, coopEditable: true }),
    R({ key: "requireGuarantors", label: "Require guarantors", description: "Require guarantors for loans", category: "loans", type: "bool", default: true, coopEditable: true }),
    R({ key: "autoApproveLoans", label: "Auto-approve loans", description: "Approve loans without a committee", category: "loans", type: "bool", default: false, coopEditable: true }),
    R({ key: "serviceChargePercent", label: "Service charge %", description: "Service charge on loans", category: "loans", type: "percent", unit: "%", default: 2, min: 0, max: 25, coopEditable: true }),
    R({ key: "lateFinePercent", label: "Late fine %", description: "Fine on overdue repayment", category: "loans", type: "percent", unit: "%", default: 5, min: 0, max: 25, coopEditable: true }),
    R({ key: "minContribution", label: "Min contribution", description: "Minimum contribution (kobo)", category: "savings", type: "money", unit: "kobo", default: 200000, min: 0, coopEditable: true }),
    R({ key: "minSavings", label: "Min savings", description: "Minimum savings (kobo)", category: "savings", type: "money", unit: "kobo", default: 100000, min: 0, coopEditable: true }),
    R({ key: "minWithdrawal", label: "Min withdrawal", description: "Minimum withdrawal (kobo)", category: "withdrawals", type: "money", unit: "kobo", default: 500000, min: 0, coopEditable: true }),
    R({ key: "maxWithdrawal", label: "Max withdrawal", description: "Maximum withdrawal (kobo)", category: "withdrawals", type: "money", unit: "kobo", default: 5000000, min: 0, coopEditable: true }),
    R({ key: "withdrawalCooldownMonths", label: "Withdrawal cooldown", description: "Months between withdrawals", category: "withdrawals", type: "int", unit: "months", default: 6, min: 0, max: 24, coopEditable: true }),
    R({ key: "literacyCertificationEnabled", label: "Literacy certification", description: "Enable literacy certification", category: "literacy", type: "bool", default: true, coopEditable: true }),
    R({ key: "literacyQuizPassMark", label: "Quiz pass mark", description: "Correct answers to pass", category: "literacy", type: "int", default: 4, min: 1, max: 12, coopEditable: true }),
    R({ key: "literacyQuizQuestionCount", label: "Quiz length", description: "Questions per quiz", category: "literacy", type: "int", default: 6, min: 1, max: 12, coopEditable: true }),
    R({ key: "certifiedLoanBoost", label: "Certified loan boost", description: "Extra multiplier for certified members", category: "literacy", type: "int", unit: "x", default: 1, min: 0, max: 10, coopEditable: true }),
  ].map((r) => [r.key, r]),
);

export const RULE_KEYS = Object.keys(RULE_REGISTRY);
export function getRule(key: string): RuleDef | undefined {
  return RULE_REGISTRY[key];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rule-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rule-registry.ts tests/rule-registry.test.ts
git commit -m "feat(platform): typed rule registry"
```

---

### Task 3: Platform policy service + `getCoopConfig` integration

**Files:**
- Create: `src/services/platform-policy.ts`
- Modify: `src/services/coop-config.ts`, `src/services/admin.ts` (setconfig)
- Test: `tests/platform-policy.test.ts`

**Interfaces:**
- Consumes: `RULE_REGISTRY`, `getRule` (Task 2); `getCoopConfig`, `updateCoopConfig`.
- Produces: `listPlatformPolicies()`, `setPlatformPolicy(key, {value?, min?, max?, locked?})`, `getEffectiveConfig(coopId): Promise<{ config: CoopConfig; meta: Record<string, {source:"platform"|"coop"; locked:boolean}> }>`, `clearPlatformPolicyCache()`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-policy.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { setPlatformPolicy, getEffectiveConfig, clearPlatformPolicyCache } from "../src/services/platform-policy.js";
import { updateCoopConfig } from "../src/services/coop-config.js";

let coopId: string;
beforeEach(async () => {
  clearPlatformPolicyCache();
  const c = await prisma.cooperative.create({ data: { name: "P", code: `PC${Date.now()}` } });
  coopId = c.id;
});

describe("platform policy resolution", () => {
  it("uses the platform default when the coop has no override", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 7 });
    const { config } = await getEffectiveConfig(coopId);
    expect(config.loanInterestRate).toBe(7);
  });
  it("clamps a coop override to the platform bounds", async () => {
    await setPlatformPolicy("loanInterestRate", { min: 1, max: 20 });
    await updateCoopConfig(coopId, { loanInterestRate: 99 });
    clearPlatformPolicyCache();
    const { config } = await getEffectiveConfig(coopId);
    expect(config.loanInterestRate).toBe(20);
  });
  it("ignores a coop override when the rule is locked", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 5, locked: true });
    await updateCoopConfig(coopId, { loanInterestRate: 30 });
    clearPlatformPolicyCache();
    const { config } = await getEffectiveConfig(coopId);
    expect(config.loanInterestRate).toBe(5);
  });
  it("rejects an unknown rule key", async () => {
    await expect(setPlatformPolicy("bogus", { value: 1 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-policy.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3a: Create the policy store (shared, no circular import)**

```ts
// src/services/platform-policy-store.ts
import { prisma } from "../lib/prisma.js";

export interface PolicyRow { value: unknown; min: number | null; max: number | null; locked: boolean; }

let cache: { at: number; version: number; rows: Record<string, PolicyRow> } | null = null;
let version = 0;
const TTL_MS = 300_000;

/** Monotonic version folded into the coop-config cache key so a policy change invalidates it. */
export function platformPolicyVersion(): number { return version; }

export function clearPlatformPolicyCache(): void { version++; cache = null; }

export async function loadPlatformPolicyRows(): Promise<Record<string, PolicyRow>> {
  if (cache && Date.now() - cache.at < TTL_MS && cache.version === version) return cache.rows;
  const rows = await prisma.platformPolicy.findMany();
  const out: Record<string, PolicyRow> = {};
  for (const r of rows) {
    out[r.key] = { value: r.value == null ? undefined : JSON.parse(r.value), min: r.min, max: r.max, locked: r.locked };
  }
  cache = { at: Date.now(), version, rows: out };
  return out;
}
```

- [ ] **Step 3b: Implement the service on top of the store**

```ts
// src/services/platform-policy.ts
import { prisma } from "../lib/prisma.js";
import { getRule } from "../lib/rule-registry.js";
import { getCoopConfig, type CoopConfig } from "./coop-config.js";
import { loadPlatformPolicyRows, clearPlatformPolicyCache } from "./platform-policy-store.js";

export { clearPlatformPolicyCache };

export async function listPlatformPolicies() {
  const eff = await loadPlatformPolicyRows();
  return Object.keys(eff).map((k) => ({ key: k, ...(eff[k] as object), rule: getRule(k) }));
}

export function clamp(n: number, min?: number | null, max?: number | null): number {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

export async function setPlatformPolicy(
  key: string,
  input: { value?: number | boolean | string; min?: number; max?: number; locked?: boolean },
): Promise<void> {
  const rule = getRule(key);
  if (!rule) throw new Error(`unknown rule: ${key}`);
  const min = input.min ?? rule.min ?? null;
  const max = input.max ?? rule.max ?? null;
  if (min != null && max != null && min > max) throw new Error(`min > max for ${key}`);
  await prisma.platformPolicy.upsert({
    where: { key },
    create: { key, value: input.value === undefined ? null : JSON.stringify(input.value), min, max, locked: input.locked ?? false },
    update: {
      ...(input.value === undefined ? {} : { value: JSON.stringify(input.value) }),
      ...(input.min === undefined ? {} : { min }),
      ...(input.max === undefined ? {} : { max }),
      ...(input.locked === undefined ? {} : { locked: input.locked }),
    },
  });
  clearPlatformPolicyCache(); // bumps the version -> all coop-config keys miss
}

/** Single resolution path: defer to getCoopConfig, then report provenance per key. */
export async function getEffectiveConfig(coopId: string): Promise<{
  config: CoopConfig;
  meta: Record<string, { source: "platform" | "coop"; locked: boolean }>;
}> {
  const config = await getCoopConfig(coopId);
  const policies = await loadPlatformPolicyRows();
  const meta: Record<string, { source: "platform" | "coop"; locked: boolean }> = {};
  for (const [key, pol] of Object.entries(policies)) {
    if (!getRule(key)) continue;
    const hasCoopValue = (config as Record<string, unknown>)[key] !== undefined;
    meta[key] = { source: !pol.locked && hasCoopValue ? "coop" : "platform", locked: pol.locked };
  }
  return { config, meta };
}
```

- [ ] **Step 3c: Apply the platform layer inside `getCoopConfig`**

Edit `src/services/coop-config.ts`:

```ts
import { getRule } from "../lib/rule-registry.js";
import { loadPlatformPolicyRows, platformPolicyVersion, clearPlatformPolicyCache } from "./platform-policy-store.js";

// inside getCoopConfig: fold the policy version into the key so a policy write invalidates it
const cacheKey = `coopconfig:${cooperativeId}:v${platformPolicyVersion()}`;
const cached = await cacheGet<CoopConfig>(cacheKey);
if (cached) return cached;

const row = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId } });
const base: CoopConfig = row ? { /* existing field mapping, unchanged */ } : { ...DEFAULT_CONFIG };
const result = await applyPlatformPolicy(base);
await cacheSet(cacheKey, result, CACHE_TTL);
return result;

async function applyPlatformPolicy(base: CoopConfig): Promise<CoopConfig> {
  const policies = await loadPlatformPolicyRows();
  const out = { ...base } as Record<string, unknown>;
  for (const [key, pol] of Object.entries(policies)) {
    const rule = getRule(key);
    if (!rule) continue;
    const platVal = pol.value === undefined ? rule.default : pol.value;
    const coopVal = (base as Record<string, unknown>)[key];
    let value: unknown = pol.locked ? platVal : coopVal !== undefined ? coopVal : platVal;
    if (typeof value === "number") value = clamp(value, pol.min ?? rule.min, pol.max ?? rule.max);
    if (rule.type === "bool") value = Boolean(value);
    out[key] = value;
  }
  return out as unknown as CoopConfig;
}

// define locally in coop-config.ts — do NOT import clamp from platform-policy (circular)
function clamp(n: number, min?: number | null, max?: number | null): number {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}
```

- In `updateCoopConfig`, change `await cacheDel(\`coopconfig:${cooperativeId}\`)` to `await cacheDel(\`coopconfig:${cooperativeId}:v${platformPolicyVersion()}\`)` so the versioned key is the one deleted. (A stale prior-version key simply expires via TTL; that is fine.)
- With zero `PlatformPolicy` rows, `applyPlatformPolicy` is a no-op that returns `{...base}`, so output is byte-identical to today (the back-compat guarantee).
- `getEffectiveConfig` (Step 3b) does NOT re-implement resolution — it calls `getCoopConfig` and only annotates provenance, so the two can never diverge.

- [ ] **Step 4: Refactor `setconfig` validation**

In `src/services/admin.ts` `setconfig` (~:3299-3348): replace the ad-hoc numeric handling for registry keys with registry-driven validation — look up `getRule(key)`, reject `!rule` for unknown keys, reject numbers outside `[rule.min, rule.max]`, reject keys that are `locked` in `PlatformPolicy`. Keep the existing `language`/`country` special cases and the non-registry fields unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/platform-policy.test.ts tests/coop-config.test.ts tests/schema-sync.test.ts`
Expected: PASS (if `tests/coop-config.test.ts` does not exist, run the rule-registry + platform-policy tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/platform-policy.ts src/services/platform-policy-store.ts src/services/coop-config.ts src/services/admin.ts tests/platform-policy.test.ts
git commit -m "feat(platform): platform policy layer with defaults, bounds and locking"
```

---

### Task 4: Platform auth library

**Files:**
- Create: `src/lib/platform-auth.ts`
- Test: `tests/platform-auth-lib.test.ts`

**Interfaces:**
- Consumes: `generateTotpSecret`, `verifyTotp`, `otpauthUri`; `getRedis`; `hashPin`, `verifyPin`.
- Produces: `PlatformTokenPayload { scope:"platform"; adminId:string; phone:string; role:string }`, `signPlatformToken(admin): string`, `verifyPlatformToken(token): PlatformTokenPayload | null`, `revokePlatformToken(token)`, `isPlatformTokenRevoked(token)`, `requireLivePlatformAdmin(payload)`, `PLATFORM_COOKIE = "coop_dev_token"`, `PLATFORM_TTL_MS`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-auth-lib.test.ts
import { describe, it, expect } from "vitest";
import { signPlatformToken, verifyPlatformToken, PLATFORM_COOKIE } from "../src/lib/platform-auth.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";

describe("platform tokens", () => {
  it("round-trips a platform-scoped token", () => {
    const t = signPlatformToken({ id: "pa1", phone: "2348000000001", role: "owner" });
    const p = verifyPlatformToken(t);
    expect(p?.scope).toBe("platform");
    expect(p?.adminId).toBe("pa1");
    expect(p?.role).toBe("owner");
  });
  it("exposes the developer cookie name", () => {
    expect(PLATFORM_COOKIE).toBe("coop_dev_token");
  });
  it("rejects a tampered token", () => {
    const t = signPlatformToken({ id: "pa1", phone: "x", role: "developer" });
    expect(verifyPlatformToken(t.slice(0, -2) + "zz")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-auth-lib.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement (mirror `admin-auth.ts` HMAC scheme with scope)**

```ts
// src/lib/platform-auth.ts
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { getRedis } from "./cache.js";

export const PLATFORM_COOKIE = "coop_dev_token";
export const PLATFORM_TTL_MS = 2 * 60 * 60 * 1000;

export interface PlatformTokenPayload { scope: "platform"; adminId: string; phone: string; role: string; iat: number }

function secret(): string {
  const s = process.env.ADMIN_JWT_SECRET;
  if (!s) throw new Error("ADMIN_JWT_SECRET is not configured");
  return s;
}

export function signPlatformToken(admin: { id: string; phone: string; role: string }): string {
  const payload: PlatformTokenPayload = { scope: "platform", adminId: admin.id, phone: admin.phone, role: admin.role, iat: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function verifyPlatformToken(token: string): PlatformTokenPayload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("hex");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data: PlatformTokenPayload;
  try { data = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (data.scope !== "platform") return null;
  if (Date.now() - data.iat > PLATFORM_TTL_MS) return null;
  return data;
}

const revKey = (t: string) => `platform:revoked:${createHash("sha256").update(t).digest("hex")}`;
// In-process fallback so revocation works when Redis is absent (dev/tests).
const revokedLocal = new Set<string>();

export async function revokePlatformToken(token: string): Promise<void> {
  revokedLocal.add(revKey(token));
  const r = getRedis();
  if (r) await r.set(revKey(token), "1", "PX", PLATFORM_TTL_MS);
}
export async function isPlatformTokenRevoked(token: string): Promise<boolean> {
  const key = revKey(token);
  if (revokedLocal.has(key)) return true;
  const r = getRedis();
  if (!r) return false;
  return (await r.exists(key)) === 1;
}

export async function requireLivePlatformAdmin(
  payload: PlatformTokenPayload,
): Promise<{ id: string; phone: string; role: string } | null> {
  const { prisma } = await import("./prisma.js");
  const admin = await prisma.platformAdmin.findUnique({ where: { id: payload.adminId } });
  if (!admin || !admin.active) return null;
  if (admin.tokensValidAfter && payload.iat < admin.tokensValidAfter.getTime()) return null;
  return { id: admin.id, phone: admin.phone, role: admin.role };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/platform-auth-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform-auth.ts tests/platform-auth-lib.test.ts
git commit -m "feat(platform): platform-scoped token library"
```

---

### Task 5: Developer routes plugin — auth endpoints + preHandler

**Files:**
- Create: `src/routes/developer.ts`
- Modify: `src/app.ts` (register plugin + FastifyRequest augmentation)
- Test: `tests/platform-auth.test.ts`

**Interfaces:**
- Consumes: Task 4 lib; `hashPin`, `verifyPin`; `checkRateLimit`, `resetRateLimit`; `verifyTotp`, `otpauthUri`, `generateTotpSecret`.
- Produces: `developerApiRoutes(app: FastifyInstance)`; `req.platformAdmin?: { id: string; phone: string; role: string }`; endpoints `POST /api/developer/login`, `POST /api/developer/change-pin`, `POST /api/developer/setup-2fa`, `POST /api/developer/logout`, `POST /api/developer/refresh`, `GET /api/developer/me`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-auth.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

let ownerId: string;
beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  const owner = await prisma.platformAdmin.create({
    data: { name: "Owner", phone: "2348000000001", role: "owner", pin: hashPin("123456"), mustChangePin: false },
  });
  ownerId = owner.id;
});

describe("platform auth", () => {
  it("logs in with phone + pin and sets the dev cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toContain("coop_dev_token=");
  });
  it("rejects a wrong pin", async () => {
    const res = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "000000" } });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a coop admin token on developer routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { authorization: "Bearer not.a.platform.token" } });
    expect(res.statusCode).toBe(401);
  });
  it("returns the current admin on /me", async () => {
    const login = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    const cookie = login.headers["set-cookie"] as string;
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { cookie: cookie.split(";")[0] } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).admin.id).toBe(ownerId);
  });
  it("rejects a platform token on coop admin routes (scope is not transitive)", async () => {
    const login = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const res = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie } });
    expect([401, 403]).toContain(res.statusCode);
  });
  it("requires a TOTP code when the admin has 2FA enabled", async () => {
    const { generateTotpSecret } = await import("../src/lib/totp.js");
    await prisma.platformAdmin.update({ where: { id: ownerId }, data: { totpSecret: generateTotpSecret(), totpEnabled: true } });
    const res = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    expect(res.statusCode).toBe(401);
  });
  it("blocks the support role from mutating", async () => {
    await prisma.platformAdmin.create({
      data: { name: "S", phone: "2348000000002", role: "support", pin: hashPin("123456"), mustChangePin: false },
    });
    const login = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000002", pin: "123456" } });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const res = await app.inject({ method: "POST", url: "/api/developer/coops", payload: {}, headers: { cookie, "x-requested-with": "xmlhttprequest" } });
    expect(res.statusCode).toBe(403);
  });
  it("rejects a revoked token", async () => {
    const { signPlatformToken, revokePlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    await revokePlatformToken(token);
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a token issued before tokensValidAfter", async () => {
    const { signPlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    await prisma.platformAdmin.update({ where: { id: ownerId }, data: { tokensValidAfter: new Date(Date.now() + 60_000) } });
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});
```

> Note: the revoked-token case needs `getRedis()` to return a client; in tests Redis is null so `isPlatformTokenRevoked` returns `false`. To make this test meaningful, also assert a Redis-less fallback: keep an in-process revoked-token `Set` in `platform-auth.ts` as the fallback (mirror `admin-auth.ts`'s approach for null Redis), and have the test cover that path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-auth.test.ts`
Expected: FAIL — 404 on `/api/developer/login`.

- [ ] **Step 3: Implement the plugin (mirror `admin.ts` structure)**

Create `src/routes/developer.ts` with:
- `readPlatformToken(req)` — `Authorization: Bearer` else `PLATFORM_COOKIE` cookie.
- `setPlatformCookie` / `clearPlatformCookie` (same flags as `admin.ts:72-78`, cookie `coop_dev_token`).
- `app.addHook("preHandler", ...)` — skip `/api/developer/login`; require `X-Requested-With: xmlhttprequest` on non-GET; `verifyPlatformToken` → `isPlatformTokenRevoked` → `requireLivePlatformAdmin`; reject (`support` role on non-GET: 403); set `req.platformAdmin`.
- `POST /api/developer/login`: normalize phone; `checkRateLimit(`devlogin:${ip}`,5,60)` and per-account `("devacct:"+phone,10,900)`; look up `PlatformAdmin` by phone; `verifyPin`; if `totpEnabled` require `body.totp` + `verifyTotp`; if `mustChangePin` return `{ mustChangePin:true, token }` and still set cookie (change-pin is the only allowed next call); else full `{ admin:{id,name,phone,role} }`.
- `POST /api/developer/change-pin`: auth'd, `{ newPin }` (6 digits) → `hashPin`, set `pin`, `mustChangePin:false`.
- `POST /api/developer/setup-2fa`: `{ secret, code }` → `verifyTotp(secret, code)` then persist `totpSecret`+`totpEnabled:true`; `GET`-style helper returns `otpauthUri(secret, phone, "CoopPlatform")`.
- `POST /api/developer/logout`, `POST /api/developer/refresh`, `GET /api/developer/me`.

Register in `src/app.ts`:
```ts
import { developerApiRoutes } from "./routes/developer.js"; // near line 11
declare module "fastify" { interface FastifyRequest { platformAdmin?: { id: string; phone: string; role: string } } } // extend the existing augmentation block (app.ts:18-24)
void app.register(developerApiRoutes); // near app.ts:165
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/platform-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/developer.ts src/app.ts tests/platform-auth.test.ts
git commit -m "feat(platform): developer auth routes + preHandler"
```

---

### Task 6: Provisioning service (extract from onboarding)

**Files:**
- Create: `src/services/cooperative-provisioning.ts`
- Modify: `src/services/handlers/session.ts:2456-2533` (call the new service)
- Test: `tests/cooperative-provisioning.test.ts`

**Interfaces:**
- Consumes: `createCooperative`, `withCoopContext`, `hashPin`, `sendText`.
- Produces: `provisionCooperative(input: { name:string; code:string; state?:string; country?:string; adminPhone:string; adminName?:string }): Promise<{ cooperativeId:string; code:string; adminMemberId:string; tempPin:string }>`, `addCoopAdmin(coopId:string, input:{ phone:string; name?:string; role:"admin"|"superadmin" }): Promise<{ memberId:string; created:boolean; tempPin?:string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cooperative-provisioning.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { provisionCooperative, addCoopAdmin } from "../src/services/cooperative-provisioning.js";

describe("provisioning", () => {
  it("creates a coop with config, branding, subscription and a super-admin", async () => {
    const out = await provisionCooperative({ name: "Ado Coop", code: `ADO${Date.now()}`, state: "Ekiti", adminPhone: "2348011111111", adminName: "Ada" });
    const coop = await prisma.cooperative.findUnique({ where: { id: out.cooperativeId }, include: { config: true, branding: true, subscription: true } });
    expect(coop?.config).toBeTruthy();
    expect(coop?.branding).toBeTruthy();
    expect(coop?.subscription).toBeTruthy();
    const admin = await prisma.member.findFirst({ where: { cooperativeId: out.cooperativeId, role: "superadmin" } });
    expect(admin?.phone).toBe("2348011111111");
  });
  it("adds an admin to an existing coop", async () => {
    const out = await provisionCooperative({ name: "B Coop", code: `B${Date.now()}`, adminPhone: "2348022222222" });
    const added = await addCoopAdmin(out.cooperativeId, { phone: "2348033333333", role: "admin" });
    expect(added.created).toBe(true);
    const m = await prisma.member.findUnique({ where: { id: added.memberId } });
    expect(m?.role).toBe("admin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cooperative-provisioning.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement by moving the onboarding body**

Move the logic from `src/services/handlers/session.ts:2456-2533` (config + branding + subscription create, super-admin member with wallet + random 4-digit temp PIN) into `provisionCooperative`, run tenant-scoped parts inside `withCoopContext(newId, ...)`, and send the welcome via `sendText`. Implement `addCoopAdmin`: check `prisma.member.findFirst({ where:{ cooperativeId, phone } })` inside `withCoopContext`; if found set `role`; else create with wallet + temp PIN; return without exposing the PIN except via the return value for messaging. Then replace the onboarding block with a call to `provisionCooperative`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cooperative-provisioning.test.ts tests/conversation.test.ts`
Expected: PASS (onboarding behaviour unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/services/cooperative-provisioning.ts src/services/handlers/session.ts tests/cooperative-provisioning.test.ts
git commit -m "refactor: extract provisionCooperative + addCoopAdmin from onboarding"
```

---

### Task 7: Developer coop/admin/control routes

**Files:**
- Modify: `src/routes/developer.ts`
- Create: `src/services/platform-coops.ts`, `src/services/platform-admin.ts`
- Test: `tests/platform-provisioning.test.ts`, `tests/platform-controls.test.ts`

**Interfaces:**
- Consumes: Task 5 preHandler; Task 6 services; `listCooperativeIds`, `withCoopContext`.
- Produces: endpoints `GET/POST /api/developer/coops`, `GET /api/developer/coops/:id`, `POST/PATCH /api/developer/coops/:id/admins[/:memberId]`, `POST /api/developer/coops/:id/(suspend|reactivate|revoke-sessions)`, `GET/PUT /api/developer/policies[/:key]`, `GET/POST/PATCH /api/developer/admins[/:id]`; service fns `listCoops()`, `createCoop(input)`, `getCoopDetail(id)`, `setCoopStatus(id,status)`, `revokeCoopSessions(id)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/platform-provisioning.test.ts  (auth header helper: log in and reuse the cookie)
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();
let cookie: string;
beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  await prisma.platformAdmin.create({ data: { name: "O", phone: "2348000000001", role: "owner", pin: hashPin("123456"), mustChangePin: false } });
  const r = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
  cookie = (r.headers["set-cookie"] as string).split(";")[0];
});
const mut = (url: string, payload: any) => app.inject({ method: "POST", url, payload, headers: { cookie, "x-requested-with": "xmlhttprequest" } });

describe("platform provisioning routes", () => {
  it("creates a coop with its first super-admin", async () => {
    const res = await mut("/api/developer/coops", { name: "Lagos Coop", code: `LG${Date.now()}`, state: "Lagos", superAdmin: { name: "Ada", phone: "2348111111111" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const admin = await prisma.member.findFirst({ where: { cooperativeId: body.cooperativeId, role: "superadmin" } });
    expect(admin?.phone).toBe("2348111111111");
  });
  it("adds an admin to an existing coop", async () => {
    const created = await mut("/api/developer/coops", { name: "X", code: `X${Date.now()}`, superAdmin: { name: "S", phone: "2348222222222" } });
    const id = JSON.parse(created.body).cooperativeId;
    const res = await mut(`/api/developer/coops/${id}/admins`, { phone: "2348333333333", role: "admin" });
    expect(res.statusCode).toBe(200);
  });
  it("requires the CSRF header on mutations", async () => {
    const res = await app.inject({ method: "POST", url: "/api/developer/coops", payload: {}, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});
```

```ts
// tests/platform-controls.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { setCoopStatus, revokeCoopSessions } from "../src/services/platform-coops.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";

describe("coop controls", () => {
  it("suspends and reactivates a coop", async () => {
    const { cooperativeId } = await provisionCooperative({ name: "C", code: `C${Date.now()}`, adminPhone: "2348444444444" });
    await setCoopStatus(cooperativeId, "suspended");
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.status).toBe("suspended");
    await setCoopStatus(cooperativeId, "active");
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.status).toBe("active");
  });
  it("sets tokensValidAfter to revoke coop admin sessions", async () => {
    const { cooperativeId } = await provisionCooperative({ name: "D", code: `D${Date.now()}`, adminPhone: "2348555555555" });
    await revokeCoopSessions(cooperativeId);
    expect((await prisma.cooperative.findUnique({ where: { id: cooperativeId } }))?.tokensValidAfter).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/platform-provisioning.test.ts tests/platform-controls.test.ts`
Expected: FAIL — 404 / module missing.

- [ ] **Step 3: Implement the services + routes**

`src/services/platform-coops.ts`: `listCoops()` (iterate `listCooperativeIds()`, read `Cooperative` + counts inside `withCoopContext`, return summary array — the stats come from Task 8's service but a minimal summary here), `createCoop(input)` (calls `provisionCooperative`, writes a `PlatformAuditLog`), `getCoopDetail(id)`, `setCoopStatus(id, status)` (`withCoopContext` update + audit), `revokeCoopSessions(id)` (`withCoopContext` set `tokensValidAfter: new Date()` + audit).
`src/services/platform-admin.ts`: `listPlatformAdmins()`, `createPlatformAdmin({name,phone,role})` (temp PIN), `setPlatformAdmin(id,{role?,active?})` — each audited.
`src/routes/developer.ts`: add the routes listed above; every non-GET also passes the preHandler; mutations write `PlatformAuditLog` (actor = `req.platformAdmin`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/platform-provisioning.test.ts tests/platform-controls.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/developer.ts src/services/platform-coops.ts src/services/platform-admin.ts tests/platform-provisioning.test.ts tests/platform-controls.test.ts
git commit -m "feat(platform): coop/admin provisioning + control routes"
```

---

### Task 8: Monitoring — stats, activity, alerts

**Files:**
- Create: `src/services/platform-monitoring.ts`
- Modify: `src/routes/developer.ts` (`GET /overview`, `GET /coops`, `GET /coops/:id`, `GET /coops/:id/activity`)
- Test: `tests/platform-monitoring.test.ts`

**Interfaces:**
- Consumes: `listCooperativeIds`, `withCoopContext`, `recentAudit`, `rlsEnforcementStatus`.
- Produces: `coopStats(coopId): Promise<CoopStats>`, `platformOverview(): Promise<{ totals: PlatformTotals; coops: CoopSummary[]; alerts: Alert[] }>`, `coopActivity(coopId, take?)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-monitoring.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { coopStats } from "../src/services/platform-monitoring.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";

describe("platform monitoring", () => {
  it("counts members and loan book per coop, isolated by tenant", async () => {
    const a = await provisionCooperative({ name: "A", code: `MA${Date.now()}`, adminPhone: "2348666666661" });
    const b = await provisionCooperative({ name: "B", code: `MB${Date.now()}`, adminPhone: "2348666666662" });
    const stats = await coopStats(a.cooperativeId);
    expect(stats.memberCount).toBe(1);
    const statsB = await coopStats(b.cooperativeId);
    expect(statsB.memberCount).toBe(1); // does not include A's member
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-monitoring.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

`coopStats(coopId)` runs inside `withCoopContext(coopId, ...)` and computes: `memberCount` (+ by status), `loanCount/principal/outstanding/overdueCount/overdueAmount/delinquencyPct`, `savingsTotal`, `pendingPayouts`, `pendingWithdrawals`, `walletFloat`, `reserveFundBalance`, `loanLossProvisionBalance`, `plan`, `status`, `lastActivityAt`. `platformOverview()` iterates `listCooperativeIds()` summing stats and collecting alerts (`delinquencyPct > 10`, negative wallet totals, failed payouts, `rlsEnforcementStatus().enforced === false`). Reuse the routes' preHandler for auth.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/platform-monitoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/platform-monitoring.ts src/routes/developer.ts tests/platform-monitoring.test.ts
git commit -m "feat(platform): per-coop monitoring stats, activity and alerts"
```

---

### Task 9: Console UI (`dashboard/dev/`)

**Files:**
- Create: `dashboard/dev/dev-login.html`, `dashboard/dev/dev-login.js`, `dashboard/dev/index.html`, `dashboard/dev/dev.js`, `dashboard/dev/dev.css`

**Interfaces:**
- Consumes: `/api/developer/*` endpoints.
- Produces: static console served at `/dashboard/dev/`.

- [ ] **Step 1: Build the login page**

`dashboard/dev/dev-login.html` (mirrors `dashboard/login.html`): phone + PIN (+ optional TOTP field shown when required). `dev-login.js`: `POST /api/developer/login` with `X-Requested-With: xmlhttprequest`, then redirect to `index.html`.

- [ ] **Step 2: Build the console shell**

`dashboard/dev/index.html` + `dev.js` (mirror `dashboard/app.js` structure): `API_BASE='/api/developer'`, an `api()` helper adding the CSRF header on non-GET and redirecting to `dev-login.html` on 401. Pages: **Overview** (totals + alert list), **Coops** (searchable list), **Coop detail** (tabs: Health · Activity · Rules · Admins), **Create Coop** (name, code, state, super-admin name+phone), **Policies** (table of rules with default/min/max/locked toggles), **Platform Admins** (owner only).

- [ ] **Step 3: Manual smoke test**

Run the app locally (`npm run dev`) with a seeded `PlatformAdmin`, open `http://localhost:3000/dashboard/dev/`, log in, create a coop, add an admin, set `loanInterestRate` + `loanDurationMonths`, view the coop health. Confirm the browser console has no errors and the coop dashboard (`/dashboard/`) is unaffected.

- [ ] **Step 4: Commit**

```bash
git add dashboard/dev
git commit -m "feat(platform): developer console UI"
```

---

### Task 10: Owner bootstrap + deploy docs

**Files:**
- Create: `src/services/platform-bootstrap.ts`
- Modify: `src/index.ts` (call on boot), `deploy/.env.example`, `DEPLOY.md`, `render.yaml` (optional env)
- Test: covered by `tests/platform-auth.test.ts` (asserting login works after bootstrap) — add one case.

**Interfaces:**
- Consumes: `hashPin`, `prisma`.
- Produces: `ensurePlatformOwner(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/platform-auth.test.ts
import { ensurePlatformOwner } from "../src/services/platform-bootstrap.js";
it("seeds the first owner from PLATFORM_OWNER_PHONE once", async () => {
  await prisma.platformAdmin.deleteMany();
  process.env.PLATFORM_OWNER_PHONE = "2348099999999";
  process.env.PLATFORM_OWNER_NAME = "Boss";
  await ensurePlatformOwner();
  await ensurePlatformOwner();
  const owners = await prisma.platformAdmin.findMany({ where: { role: "owner" } });
  expect(owners.length).toBe(1);
  expect(owners[0].phone).toBe("2348099999999");
  expect(owners[0].mustChangePin).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-auth.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

`ensurePlatformOwner()`: if `PLATFORM_OWNER_PHONE` is set and no `PlatformAdmin` with `role:"owner"` exists, create one with a random 6-digit temp PIN (`hashPin`), `mustChangePin:true`, and `console.log` the temp PIN **once** with a "change on first login" warning. Call `await ensurePlatformOwner()` in `src/index.ts` `main()` after `validateEnvironment()`.

- [ ] **Step 4: Docs + env**

Add to `deploy/.env.example` and `.env` docs: `PLATFORM_OWNER_PHONE=` (and optional `PLATFORM_OWNER_NAME=`). Add a "Platform Console" section to `DEPLOY.md` (URL `https://<DOMAIN>/dashboard/dev/`, first login with the logged temp PIN, then set 2FA).

- [ ] **Step 5: Run tests + gates**

Run: `npx vitest run tests/platform-auth.test.ts` → PASS. Then `npx tsc --noEmit`, `npx eslint src/`, `npm run format:check`.

- [ ] **Step 6: Commit**

```bash
git add src/services/platform-bootstrap.ts src/index.ts deploy/.env.example DEPLOY.md render.yaml tests/platform-auth.test.ts
git commit -m "feat(platform): env-bootstrapped owner + deploy docs"
```

---

## Phase 2 — Standards/compliance hardening

### Task 11: AML report-type fix (CTR vs STR)

**Files:**
- Modify: `src/services/aml.ts`, `src/services/regulator-reporting.ts`
- Test: `tests/aml-report-type.test.ts`

**Interfaces:**
- Produces: `classifyReport({ amountKobo, isCash, isCrossBorder, isCorporate, suspicious }): "CTR" | "STR" | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/aml-report-type.test.ts
import { describe, it, expect } from "vitest";
import { classifyReport } from "../src/services/aml.js";

describe("AML report classification", () => {
  it("classifies ≥₦5m cash (individual) as CTR, not STR", () => {
    expect(classifyReport({ amountKobo: 500_000_000, isCash: true, isCrossBorder: false, isCorporate: false, suspicious: false })).toBe("CTR");
  });
  it("classifies a suspicious sub-threshold txn as STR (no threshold)", () => {
    expect(classifyReport({ amountKobo: 1_000_00, isCash: false, isCrossBorder: false, isCorporate: false, suspicious: true })).toBe("STR");
  });
  it("classifies ≥₦10m cash (corporate) as CTR", () => {
    expect(classifyReport({ amountKobo: 1_000_000_000, isCash: true, isCrossBorder: false, isCorporate: true, suspicious: false })).toBe("CTR");
  });
  it("classifies $10k cross-border as CTR", () => {
    expect(classifyReport({ amountKobo: 0, isCash: false, isCrossBorder: true, isCorporate: false, suspicious: false })).toBe("CTR");
  });
  it("returns null when nothing triggers", () => {
    expect(classifyReport({ amountKobo: 1_000_00, isCash: true, isCrossBorder: false, isCorporate: false, suspicious: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aml-report-type.test.ts`
Expected: FAIL — `classifyReport` not exported.

- [ ] **Step 3: Implement + wire**

Add `classifyReport` to `aml.ts` with constants `CTR_INDIVIDUAL_KOBO = 500_000_000`, `CTR_CORPORATE_KOBO = 1_000_000_000`, cross-border `$10k` (configurable via `PlatformPolicy` key `ctrCrossBorderUsd`). Replace the current "≥₦5M → STR" logic in `aml.ts` and the report-type propagation in `regulator-reporting.ts` with `classifyReport`; STR is emitted with **no** threshold (suspicion only). Add the `ctrIndividualKobo`/`ctrCorporateKobo`/`ctrCrossBorderUsd` rules to the registry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/aml-report-type.test.ts tests/aml.test.ts tests/regulator-reporting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/aml.ts src/services/regulator-reporting.ts src/lib/rule-registry.ts tests/aml-report-type.test.ts
git commit -m "fix(aml): CTR vs STR classification (STR has no threshold)"
```

---

### Task 12: Statutory rules (reserve, education, dividend cap, max term, max loan, membership)

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma` (add config columns), `src/lib/rule-registry.ts`, `src/services/coop-config.ts`
- Test: `tests/statutory-rules.test.ts`

**Interfaces:**
- Produces: registry keys `reserveFundPercent` (default 25, min 25, locked), `educationFundPercent` (default 10, max 10), `dividendCapPercent` (default 5, max 5); matching `CooperativeConfig` columns.

- [ ] **Step 1: Write the failing test**

```ts
// tests/statutory-rules.test.ts
import { describe, it, expect } from "vitest";
import { getRule } from "../src/lib/rule-registry.js";

describe("statutory rules", () => {
  it("reserve fund floor is 25% and locked by default", () => {
    const r = getRule("reserveFundPercent")!;
    expect(r.min).toBe(25);
    expect(r.statutory).toBeTruthy();
  });
  it("education fund is capped at 10%", () => {
    expect(getRule("educationFundPercent")!.max).toBe(10);
  });
  it("dividend cap is 5%", () => {
    expect(getRule("dividendCapPercent")!.max).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/statutory-rules.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `reserveFundPercent`, `educationFundPercent`, `dividendCapPercent` to the registry (with `statutory` citations: Act ss.34, 44(d)) and mirror the columns into both schemas + migrate; surface them in the Policies console. Seed `reserveFundPercent` as `locked` in the migration so the statutory floor applies out of the box:

```sql
-- in prisma/migrations/<ts>_statutory_rules/migration.sql (Postgres)
INSERT INTO "PlatformPolicy" ("key", "value", "min", "max", "locked", "updatedAt")
VALUES ('reserveFundPercent', '25', 25, NULL, true, now())
ON CONFLICT ("key") DO NOTHING;
```

(For the SQLite test DB, add the same row via `tests/setup.ts` seeding only if a test needs it; `db push` does not run migrations.)

- [ ] **Step 4: Run tests + schema-sync to verify they pass**

Run: `npx vitest run tests/statutory-rules.test.ts tests/schema-sync.test.ts tests/platform-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations src/lib/rule-registry.ts src/services/coop-config.ts tests/statutory-rules.test.ts
git commit -m "feat(compliance): statutory rules (reserve/education/dividend) + max term/loan"
```

---

### Task 13: Compliance metadata (state, registration/CVN, TIN, SCUML, DPO)

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.local.prisma` (`Cooperative` fields), `src/routes/developer.ts`, `dashboard/dev/dev.js`
- Test: `tests/coop-compliance-metadata.test.ts`

**Interfaces:**
- Produces: `Cooperative.registrationNumber`, `tin`, `cvn`, `scumlStatus`, `dpoName`, `dpoPhone`, `dpoEmail`; `PATCH /api/developer/coops/:id` to set them.

- [ ] **Step 1: Write the failing test**

```ts
// tests/coop-compliance-metadata.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";

describe("coop compliance metadata", () => {
  it("persists registration/tin/cvn/scuml/dpo fields", async () => {
    const { cooperativeId } = await provisionCooperative({ name: "M", code: `M${Date.now()}`, adminPhone: "2348777777771" });
    const c = await prisma.cooperative.update({
      where: { id: cooperativeId },
      data: { registrationNumber: "EK/12345", tin: "12345678-0001", cvn: "CVN-0001", scumlStatus: "registered", dpoName: "Ada", dpoPhone: "2348777777772", dpoEmail: "dpo@example.com" },
    });
    expect(c.registrationNumber).toBe("EK/12345");
    expect(c.tin).toBe("12345678-0001");
    expect(c.scumlStatus).toBe("registered");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coop-compliance-metadata.test.ts`
Expected: FAIL — unknown args.

- [ ] **Step 3: Implement**

Add the seven nullable columns (`registrationNumber`, `tin`, `cvn`, `scumlStatus`, `dpoName`, `dpoPhone`, `dpoEmail`) to `Cooperative` in BOTH schemas + migrate; add `PATCH /api/developer/coops/:id` (updates only these whitelisted fields, audited); surface them on the Coop detail page. Also fix the phantom: `createCooperative` should now actually persist `registrationNumber` when supplied.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/coop-compliance-metadata.test.ts tests/schema-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma prisma/migrations src/routes/developer.ts src/services/cooperative.ts dashboard/dev/dev.js tests/coop-compliance-metadata.test.ts
git commit -m "feat(compliance): per-coop registration/CVN/SCUML/DPO metadata"
```

---

## Final verification (after Phase 2)

- [ ] `npx vitest run` (full suite; long — ~30 min) — 0 failures.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx eslint src/` 0 errors.
- [ ] `npm run format:check` clean.
- [ ] `docker compose config` still valid (no deploy regressions).
- [ ] Open a PR from `feat/platform-console` → `main`; confirm CI green.
