# Task 1: Favorite Payees (Beneficiary Memory)

## Files
- Modify: `prisma/schema.prisma` (add FavoritePayee model)
- Modify: `prisma/schema.local.prisma` (mirror)
- Create: `src/lib/beneficiaries.ts`
- Test: `tests/xara-features.test.ts`

## Interfaces
- Produces: `savePayee(memberId, name, accountNumber, bankCode, bankName)`, `listPayees(memberId)`, `resolvePayee(memberId, nameOrIndex)`, `deletePayee(memberId, payeeId)`

## Steps

### Step 1: Add FavoritePayee model to Prisma schema

Add after the `Beneficiary` model (line ~357) in `prisma/schema.prisma`:

```prisma
model FavoritePayee {
  id            String   @id @default(cuid())
  memberId      String
  member        Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  name          String   // user-defined label, e.g. "Mama Ngozi"
  accountNumber String
  bankCode      String
  bankName      String?
  lastUsedAt    DateTime?
  useCount      Int      @default(0)
  createdAt     DateTime @default(now())

  @@unique([memberId, name])
  @@index([memberId])
}
```

Also add `favoritePayees FavoritePayee[]` to the Member model's relations.

### Step 2: Mirror to schema.local.prisma

Copy the same FavoritePayee model and Member relation to `prisma/schema.local.prisma`.

### Step 3: Run migration

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx prisma migrate dev --name add-favorite-payees; npx prisma generate
```

### Step 4: Write the failing test

Add to `tests/xara-features.test.ts`:

```typescript
describe("Favorite Payees (Beneficiary Memory)", () => {
  it("savePayee creates a payee and listPayees returns it", async () => {
    const { member } = await makeCoopAndMember();
    const result = await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    expect(result.ok).toBe(true);
    const payees = await listPayees(member.id);
    expect(payees).toHaveLength(1);
    expect(payees[0].name).toBe("Mama Ngozi");
  });

  it("resolvePayee finds by name fuzzy match", async () => {
    const { member } = await makeCoopAndMember();
    await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    const found = await resolvePayee(member.id, "mama");
    expect(found).not.toBeNull();
    expect(found!.accountNumber).toBe("0123456789");
  });

  it("resolvePayee finds by index", async () => {
    const { member } = await makeCoopAndMember();
    await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    await savePayee(member.id, "Chuks", "0987654321", "033", "Access");
    const found = await resolvePayee(member.id, "2");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Chuks");
  });

  it("deletePayee removes a payee", async () => {
    const { member } = await makeCoopAndMember();
    const saved = await savePayee(member.id, "Mama Ngozi", "0123456789", "044", "GTBank");
    const deleted = await deletePayee(member.id, saved.payee!.id);
    expect(deleted.ok).toBe(true);
    const payees = await listPayees(member.id);
    expect(payees).toHaveLength(0);
  });
});
```

### Step 5: Run test to verify it fails

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Favorite Payees"
```

### Step 6: Implement beneficiaries.ts

Create `src/lib/beneficiaries.ts`:

```typescript
import { prisma } from "./prisma.js";

export async function savePayee(
  memberId: string,
  name: string,
  accountNumber: string,
  bankCode: string,
  bankName?: string,
): Promise<{ ok: boolean; message: string; payee?: { id: string; name: string } }> {
  const existing = await prisma.favoritePayee.findUnique({
    where: { memberId_name: { memberId, name: name.trim().toLowerCase() } },
  });
  if (existing) {
    await prisma.favoritePayee.update({
      where: { id: existing.id },
      data: { accountNumber, bankCode, bankName },
    });
    return { ok: true, message: `Updated payee *${name}*.` , payee: { id: existing.id, name } };
  }
  const payee = await prisma.favoritePayee.create({
    data: { memberId, name: name.trim().toLowerCase(), accountNumber, bankCode, bankName },
  });
  return { ok: true, message: `Saved *${name}* as a favorite payee.`, payee: { id: payee.id, name } };
}

export async function listPayees(memberId: string) {
  return prisma.favoritePayee.findMany({
    where: { memberId },
    orderBy: { lastUsedAt: "desc" },
  });
}

export async function resolvePayee(memberId: string, nameOrIndex: string): Promise<{
  id: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  bankName: string | null;
} | null> {
  // Try index first
  const idx = parseInt(nameOrIndex, 10);
  if (Number.isFinite(idx) && idx >= 1) {
    const payees = await listPayees(memberId);
    if (payees[idx - 1]) return payees[idx - 1];
  }
  // Try exact name match
  const lower = nameOrIndex.toLowerCase().trim();
  const exact = await prisma.favoritePayee.findUnique({
    where: { memberId_name: { memberId, name: lower } },
  });
  if (exact) return exact;
  // Try fuzzy (contains)
  const all = await prisma.favoritePayee.findMany({ where: { memberId } });
  const fuzzy = all.find((p) => p.name.includes(lower) || lower.includes(p.name));
  return fuzzy ?? null;
}

export async function deletePayee(memberId: string, payeeId: string): Promise<{ ok: boolean; message: string }> {
  const payee = await prisma.favoritePayee.findFirst({ where: { id: payeeId, memberId } });
  if (!payee) return { ok: false, message: "Payee not found." };
  await prisma.favoritePayee.delete({ where: { id: payeeId } });
  return { ok: true, message: `Removed *${payee.name}* from your payees.` };
}

export async function recordPayeeUse(payeeId: string): Promise<void> {
  await prisma.favoritePayee.update({
    where: { id: payeeId },
    data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
  });
}
```

### Step 7: Run test to verify it passes

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Favorite Payees"
```

### Step 8: Commit

```bash
git add prisma/schema.prisma prisma/schema.local.prisma src/lib/beneficiaries.ts tests/xara-features.test.ts
git commit -m "feat: add favorite payees (beneficiary memory)"
```
