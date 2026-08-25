# Xara-Inspired Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 Xara-inspired features to the cooperative banking bot: voice transcription, beneficiary memory, self-serve account freeze, spending breakdown, and enriched confirmations.

**Architecture:** Each feature is an independent module that plugs into the existing conversation pipeline. Voice transcription adds audio download + Groq Whisper transcription before the NL query engine. Beneficiary memory adds a DB model and a resolver service. Account freeze adds a wallet status check at the top of money commands. Spending breakdown is a new `analytics` command. Enriched confirmations modify existing transaction handlers.

**Tech Stack:** TypeScript, Prisma ORM, Groq API (Whisper for voice), existing `messaging.ts` / `conversation.ts` pipeline.

**Spec:** Derived from Xara (usexara.ai) feature analysis — see conversation context.

## Global Constraints

- All monetary values stored as Int (kobo) — ₦1 = 100 kobo
- AI features are fail-closed: no API key → graceful fallback, 8-sec timeouts
- PowerShell on Windows — use `;` not `&&` as command separator
- Typecheck must pass (`npx tsc --noEmit`) before committing
- All existing 121 tests must continue passing
- Follow existing code conventions: no comments unless asked, Zod for validation
- Prisma schema changes require syncing `schema.prisma` AND `schema.local.prisma`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `prisma/schema.prisma` | Modify | Add `frozen` field to Wallet, add `FavoritePayee` model |
| `prisma/schema.local.prisma` | Modify | Mirror schema changes |
| `src/lib/voice.ts` | Create | Download WhatsApp audio, transcribe via Groq Whisper |
| `src/lib/inbound.ts` | Modify | Extract audio messages alongside text |
| `src/lib/beneficiaries.ts` | Create | Save/list/resolve favorite payees |
| `src/lib/freeze.ts` | Create | Freeze/unfreeze wallet, check frozen status |
| `src/lib/spending.ts` | Create | Monthly spending breakdown query |
| `src/services/conversation.ts` | Modify | Wire new commands: `freeze`, `unfreeze`, `analytics`, `payees` |
| `src/routes/webhook.ts` | Modify | Pass audio messages to voice transcription |
| `tests/xara-features.test.ts` | Create | Tests for all 5 features |

---

## Task 1: Beneficiary Memory (Favorite Payees)

**Files:**
- Modify: `prisma/schema.prisma` (add FavoritePayee model)
- Modify: `prisma/schema.local.prisma` (mirror)
- Create: `src/lib/beneficiaries.ts`
- Test: `tests/xara-features.test.ts`

**Interfaces:**
- Produces: `savePayee(memberId, name, accountNumber, bankCode, bankName)`, `listPayees(memberId)`, `resolvePayee(memberId, nameOrIndex)`, `deletePayee(memberId, payeeId)`

- [ ] **Step 1: Add FavoritePayee model to Prisma schema**

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

- [ ] **Step 2: Mirror to schema.local.prisma**

Copy the same FavoritePayee model and Member relation to `prisma/schema.local.prisma`.

- [ ] **Step 3: Run migration**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx prisma migrate dev --name add-favorite-payees; npx prisma generate
```

- [ ] **Step 4: Write the failing test**

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

- [ ] **Step 5: Run test to verify it fails**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Favorite Payees"
```

- [ ] **Step 6: Implement beneficiaries.ts**

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

- [ ] **Step 7: Run test to verify it passes**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Favorite Payees"
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma src/lib/beneficiaries.ts tests/xara-features.test.ts
git commit -m "feat: add favorite payees (beneficiary memory)"
```

---

## Task 2: Self-Serve Account Freeze

**Files:**
- Modify: `prisma/schema.prisma` (add `frozen` to Wallet)
- Modify: `prisma/schema.local.prisma` (mirror)
- Create: `src/lib/freeze.ts`
- Modify: `src/services/conversation.ts` (add `freeze`/`unfreeze` commands, gate money commands)
- Test: `tests/xara-features.test.ts`

**Interfaces:**
- Produces: `freezeWallet(memberId)`, `unfreezeWallet(memberId)`, `isFrozen(memberId)`
- Consumes: existing `getMemberByPhone()` from cooperative.ts

- [ ] **Step 1: Add `frozen` field to Wallet model**

In `prisma/schema.prisma`, add to the Wallet model (after line 159):

```prisma
  frozen          Boolean             @default(false)
  frozenAt        DateTime?
  frozenById      String? // admin who froze it
```

Mirror in `schema.local.prisma`.

- [ ] **Step 2: Run migration**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx prisma migrate dev --name add-wallet-freeze; npx prisma generate
```

- [ ] **Step 3: Write the failing test**

Add to `tests/xara-features.test.ts`:

```typescript
describe("Self-Serve Account Freeze", () => {
  it("freezeWallet freezes the wallet", async () => {
    const { member } = await makeCoopAndMember();
    const result = await freezeWallet(member.id);
    expect(result.ok).toBe(true);
    expect(await isFrozen(member.id)).toBe(true);
  });

  it("unfreezeWallet unfreezes the wallet", async () => {
    const { member } = await makeCoopAndMember();
    await freezeWallet(member.id);
    const result = await unfreezeWallet(member.id);
    expect(result.ok).toBe(true);
    expect(await isFrozen(member.id)).toBe(false);
  });

  it("freeze command in conversation freezes wallet", async () => {
    const { member } = await makeCoopAndMember();
    await handleMessage(PHONE, "freeze");
    expect(sendText).toHaveBeenCalled();
    const lastCall = (sendText as any).mock.calls[(sendText as any).mock.calls.length - 1];
    expect(lastCall[0].text).toContain("frozen");
  });

  it("save command is blocked when wallet is frozen", async () => {
    const { member } = await makeCoopAndMember();
    await freezeWallet(member.id);
    await handleMessage(PHONE, "save 5000");
    expect(sendText).toHaveBeenCalled();
    const lastCall = (sendText as any).mock.calls[(sendText as any).mock.calls.length - 1];
    expect(lastCall[0].text).toContain("frozen");
  });
});
```

- [ ] **Step 4: Implement freeze.ts**

Create `src/lib/freeze.ts`:

```typescript
import { prisma } from "./prisma.js";

export async function freezeWallet(memberId: string): Promise<{ ok: boolean; message: string }> {
  const wallet = await prisma.wallet.findUnique({ where: { memberId } });
  if (!wallet) return { ok: false, message: "No wallet found." };
  if (wallet.frozen) return { ok: true, message: "Your wallet is already frozen." };
  await prisma.wallet.update({
    where: { memberId },
    data: { frozen: true, frozenAt: new Date() },
  });
  return { ok: true, message: "🔒 Your wallet has been frozen. No transactions can be made until it's unfrozen.\n\nReply *unfreeze* to restore access." };
}

export async function unfreezeWallet(memberId: string): Promise<{ ok: boolean; message: string }> {
  const wallet = await prisma.wallet.findUnique({ where: { memberId } });
  if (!wallet) return { ok: false, message: "No wallet found." };
  if (!wallet.frozen) return { ok: true, message: "Your wallet is not frozen." };
  await prisma.wallet.update({
    where: { memberId },
    data: { frozen: false, frozenAt: null, frozenById: null },
  });
  return { ok: true, message: "✅ Your wallet has been unfrozen. You can now make transactions." };
}

export async function isFrozen(memberId: string): Promise<boolean> {
  const wallet = await prisma.wallet.findUnique({ where: { memberId }, select: { frozen: true } });
  return wallet?.frozen ?? false;
}
```

- [ ] **Step 5: Wire freeze/unfreeze into conversation.ts**

In `conversation.ts`, add imports at top:

```typescript
import { freezeWallet, unfreezeWallet, isFrozen } from "../lib/freeze.js";
```

Add cases in the switch statement (before `default:`):

```typescript
    case "freeze": {
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
        return;
      }
      const result = await freezeWallet(member.id);
      await sendText({ to: phone, text: result.message });
      break;
    }

    case "unfreeze": {
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
        return;
      }
      const result = await unfreezeWallet(member.id);
      await sendText({ to: phone, text: result.message });
      break;
    }
```

Gate money commands (save/loan/repay/withdraw) by adding at the start of the case block:

```typescript
    case "save":
    case "loan":
    case "repay":
    case "withdraw": {
      if (!checkMoneyRateLimit(phone)) {
        await sendText({ to: phone, text: "⏳ You've made several money requests in the last hour. Please wait." });
        break;
      }
      // Check frozen status
      if (member) {
        const frozen = await isFrozen(member.id);
        if (frozen) {
          await sendText({ to: phone, text: "🔒 Your wallet is frozen. Reply *unfreeze* to restore access." });
          break;
        }
      }
      if (cmd === "save") await handleSave(phone, args);
      // ... rest unchanged
```

- [ ] **Step 6: Add freeze/unfreeze to menu**

In `buildMenu()`, add to the member commands list:

```typescript
      `• *freeze* — freeze your wallet (blocks all transactions)\n` +
      `• *unfreeze* — restore access to your wallet\n` +
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Self-Serve Account Freeze"
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/schema.local.prisma src/lib/freeze.ts src/services/conversation.ts tests/xara-features.test.ts
git commit -m "feat: self-serve account freeze/unfreeze"
```

---

## Task 3: Spending Breakdown Command

**Files:**
- Create: `src/lib/spending.ts`
- Modify: `src/services/conversation.ts` (add `analytics` command)
- Test: `tests/xara-features.test.ts`

**Interfaces:**
- Produces: `getSpendingBreakdown(memberId)`, `getCoopAnalytics(cooperativeId)`

- [ ] **Step 1: Write the failing test**

Add to `tests/xara-features.test.ts`:

```typescript
describe("Spending Breakdown", () => {
  it("getSpendingBreakdown returns member spending data", async () => {
    const { member } = await makeCoopAndMember();
    const breakdown = await getSpendingBreakdown(member.id);
    expect(breakdown).toHaveProperty("totalSaved");
    expect(breakdown).toHaveProperty("thisMonthSaved");
    expect(breakdown).toHaveProperty("activeLoanBalance");
  });

  it("analytics command shows spending breakdown", async () => {
    await makeCoopAndMember();
    await handleMessage(PHONE, "analytics");
    expect(sendText).toHaveBeenCalled();
    const lastCall = (sendText as any).mock.calls[(sendText as any).mock.calls.length - 1];
    expect(lastCall[0].text).toContain("Savings");
  });
});
```

- [ ] **Step 2: Implement spending.ts**

Create `src/lib/spending.ts`:

```typescript
import { prisma } from "./prisma.js";
import { formatBalance } from "../services/cooperative.js";

export async function getSpendingBreakdown(memberId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      wallet: true,
      contributions: {
        where: { status: "confirmed" },
        orderBy: { createdAt: "desc" },
      },
      loans: { where: { status: { in: ["approved", "disbursed"] } } },
    },
  });

  if (!member) return null;

  const thisMonthContributions = member.contributions
    .filter((c) => c.createdAt >= startOfMonth)
    .reduce((sum, c) => sum + c.amount, 0);

  const thisYearContributions = member.contributions
    .filter((c) => c.createdAt >= startOfYear)
    .reduce((sum, c) => sum + c.amount, 0);

  const activeLoan = member.loans[0];
  const monthlyPayment = activeLoan?.monthlyPayment ?? 0;
  const loanBalance = activeLoan?.balance ?? 0;

  return {
    walletBalance: member.wallet?.balance ?? 0,
    totalSaved: member.wallet?.totalSaved ?? 0,
    thisMonthSaved: thisMonthContributions,
    thisYearSaved: thisYearContributions,
    activeLoanBalance: loanBalance,
    monthlyPayment,
    loanCount: member.loans.length,
    contributionCount: member.contributions.length,
  };
}

export function formatSpendingBreakdown(data: Awaited<ReturnType<typeof getSpendingBreakdown>>, name: string): string {
  if (!data) return "No data found.";

  let text = `📊 *Your Financial Summary*\n\n`;
  text += `Hi *${name}*, here's your breakdown:\n\n`;

  text += `💰 *Savings*\n`;
  text += `• Wallet balance: *${formatBalance(data.walletBalance)}*\n`;
  text += `• Saved this month: *${formatBalance(data.thisMonthSaved)}*\n`;
  text += `• Saved this year: *${formatBalance(data.thisYearSaved)}*\n`;
  text += `• Total saved: *${formatBalance(data.totalSaved)}*\n\n`;

  if (data.activeLoanBalance > 0) {
    text += `🏦 *Active Loan*\n`;
    text += `• Remaining: *${formatBalance(data.activeLoanBalance)}*\n`;
    text += `• Monthly payment: *${formatBalance(data.monthlyPayment)}*\n\n`;
  } else {
    text += `🏦 *No active loans*\n\n`;
  }

  text += `_Reply *menu* for all options._`;
  return text;
}

export async function getCoopAnalytics(cooperativeId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [memberCount, walletStats, monthlyContributions, activeLoans] = await Promise.all([
    prisma.member.count({ where: { cooperativeId, status: "active" } }),
    prisma.wallet.aggregate({ where: { member: { cooperativeId } }, _sum: { balance: true, totalSaved: true } }),
    prisma.contribution.aggregate({
      where: { cooperativeId, status: "confirmed", createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.loan.aggregate({
      where: { cooperativeId, status: { in: ["approved", "disbursed"] } },
      _sum: { balance: true },
      _count: true,
    }),
  ]);

  return {
    memberCount,
    totalBalance: walletStats._sum.balance ?? 0,
    totalSaved: walletStats._sum.totalSaved ?? 0,
    monthlyContributions: monthlyContributions._sum.amount ?? 0,
    monthlyContributionCount: monthlyContributions._count,
    activeLoanBalance: activeLoans._sum.balance ?? 0,
    activeLoanCount: activeLoans._count,
  };
}
```

- [ ] **Step 3: Wire analytics command into conversation.ts**

Add import:

```typescript
import { getSpendingBreakdown, formatSpendingBreakdown, getCoopAnalytics } from "../lib/spending.js";
```

Add case in switch:

```typescript
    case "analytics": {
      if (!member) {
        await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
        return;
      }
      const data = await getSpendingBreakdown(member.id);
      const text = formatSpendingBreakdown(data, member.name);
      await sendText({ to: phone, text });
      break;
    }
```

Add to menu:

```typescript
      `• *analytics* — see your financial breakdown\n` +
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Spending Breakdown"
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/spending.ts src/services/conversation.ts tests/xara-features.test.ts
git commit -m "feat: spending breakdown analytics command"
```

---

## Task 4: Voice Note Transcription

**Files:**
- Create: `src/lib/voice.ts`
- Modify: `src/lib/inbound.ts` (extract audio messages)
- Modify: `src/routes/webhook.ts` (pass audio to transcription)
- Modify: `src/config.ts` (add whisper config)
- Test: `tests/xara-features.test.ts`

**Interfaces:**
- Produces: `transcribeVoice(audioUrl: string, mimeType: string)`, returns transcribed text
- Consumes: WhatsApp media download URL, Groq Whisper API

- [ ] **Step 1: Add Groq config**

In `src/config.ts`, add to config object:

```typescript
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
    whisperModel: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3",
  },
```

- [ ] **Step 2: Write the failing test**

Add to `tests/xara-features.test.ts`:

```typescript
describe("Voice Transcription", () => {
  it("transcribeVoice returns transcribed text from audio", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "save 5000" }),
    }));
    const result = await transcribeVoice("https://example.com/audio.ogg", "audio/ogg");
    expect(result).toBe("save 5000");
    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
  });

  it("transcribeVoice returns null on failure", async () => {
    delete process.env.GROQ_API_KEY;
    const result = await transcribeVoice("https://example.com/audio.ogg", "audio/ogg");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Implement voice.ts**

Create `src/lib/voice.ts`:

```typescript
import { config } from "../config.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Transcribe a voice note using Groq Whisper.
 * Returns the transcribed text, or null if transcription fails.
 */
export async function transcribeVoice(
  audioUrl: string,
  mimeType: string = "audio/ogg",
): Promise<string | null> {
  if (!config.groq.apiKey) return null;

  try {
    // Download the audio file
    const audioRes = await fetch(audioUrl, {
      headers: { Authorization: `Bearer ${config.whatsapp.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!audioRes.ok) return null;

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Determine file extension from MIME type
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "wav";
    const filename = `voice.${ext}`;

    // Create FormData for multipart upload
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append("file", blob, filename);
    formData.append("model", config.groq.whisperModel);
    formData.append("language", "en");

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groq.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;
    const body = (await res.json()) as { text?: string };
    return body.text?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Download a WhatsApp media file and return its URL.
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<string | null> {
  if (!config.whatsapp.token || !mediaId) return null;
  try {
    // Step 1: Get the media URL
    const metaRes = await fetch(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${config.whatsapp.token}` } },
    );
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: string };
    return meta.url ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update inbound.ts to extract audio messages**

In `src/lib/inbound.ts`, add to the InboundMessage interface:

```typescript
export interface InboundMessage {
  from: string;
  text: string;
  flowToken?: string;
  /** Present when the message is a voice/audio note. */
  audio?: {
    id: string;
    mimeType: string;
  };
}
```

In `extractWhatsAppMessages`, add after the interactive block (before the closing brace of the for loop):

```typescript
    // Handle audio/voice notes
    if (message.type === "audio" && (message as { audio?: { id?: string; mime_type?: string } }).audio?.id) {
      const audio = (message as { audio: { id: string; mime_type: string } }).audio;
      out.push({
        from,
        text: "", // Will be filled by voice transcription
        audio: { id: audio.id, mimeType: audio.mime_type },
      });
    }
```

- [ ] **Step 5: Wire voice transcription into webhook.ts**

In `src/routes/webhook.ts`, update the message handling loop:

```typescript
import { transcribeVoice, downloadWhatsAppMedia } from "../lib/voice.js";

// Inside the for loop, after extractWhatsAppMessages:
for (const inbound of extractWhatsAppMessages(change?.value)) {
  if (!isAllowed(inbound.from)) continue;

  // Handle voice notes: download → transcribe → treat as text
  if (inbound.audio && !inbound.text) {
    const audioUrl = await downloadWhatsAppMedia(inbound.audio.id);
    if (audioUrl) {
      const transcribed = await transcribeVoice(audioUrl, inbound.audio.mimeType);
      if (transcribed) {
        inbound.text = transcribed;
      }
    }
    if (!inbound.text) {
      // Transcription failed — send a helpful message
      void sendText({ to: inbound.from, text: "🎤 I couldn't understand that voice note. Please try typing your message, or send the voice note again." }).catch(() => {});
      continue;
    }
  }

  void handleMessage(inbound.from, inbound.text, {
    flowToken: inbound.flowToken,
  }).catch((err) => {
    app.log.error({ err, from: inbound.from }, "handleMessage failed");
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Voice Transcription"
```

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/lib/voice.ts src/lib/inbound.ts src/routes/webhook.ts tests/xara-features.test.ts
git commit -m "feat: voice note transcription via Groq Whisper"
```

---

## Task 5: Enriched Transaction Confirmations

**Files:**
- Modify: `src/services/conversation.ts` (enrich handleSave, handleBalance responses)
- Test: `tests/xara-features.test.ts`

**Interfaces:**
- Consumes: existing `getMemberByPhone()`, `formatBalance()`
- Produces: enriched confirmation text with running balance and context

- [ ] **Step 1: Write the failing test**

Add to `tests/xara-features.test.ts`:

```typescript
describe("Enriched Confirmations", () => {
  it("save confirmation includes running balance", async () => {
    await makeCoopAndMember();
    await handleMessage(PHONE, "save 5000");
    expect(sendText).toHaveBeenCalled();
    const calls = (sendText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0].text).toContain("balance");
  });

  it("balance shows additional context for members with loans", async () => {
    const { coop, member } = await makeCoopAndMember();
    await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 50000,
        balance: 35000,
        monthlyPayment: 10000,
        interestRate: 5,
        status: "disbursed",
      },
    });
    await handleMessage(PHONE, "balance");
    expect(sendText).toHaveBeenCalled();
    const calls = (sendText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0].text).toContain("loan");
  });
});
```

- [ ] **Step 2: Modify handleSave to include enriched confirmation**

In `conversation.ts`, modify `handleSave`:

```typescript
async function handleSave(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_save_amount" },
      update: { state: "awaiting_save_amount" },
    });
    await sendText({ to: phone, text: "How much would you like to save? (e.g. *2000*)" });
    return;
  }
  const result = await createContribution(phone, amount);
  // Enrich with running balance
  const member = await getMemberByPhone(phone);
  if (member?.wallet) {
    const balance = member.wallet.balance;
    result.message += `\n\n💰 Your new balance: *${formatBalance(balance)}*`;
    if (member.wallet.totalSaved > 0) {
      result.message += `\n📈 Total saved: *${formatBalance(member.wallet.totalSaved)}*`;
    }
  }
  await sendText({ to: phone, text: result.message });
}
```

- [ ] **Step 3: Modify handleBalance to show loan context**

In `conversation.ts`, modify `handleBalance`:

```typescript
async function handleBalance(
  phone: string,
  member: { name: string; cooperative: { name: string }; wallet: { balance: number; totalSaved: number } | null } | null,
): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  const balance = member.wallet?.balance ?? 0;
  const totalSaved = member.wallet?.totalSaved ?? 0;
  let text = `Hi *${member.name}*, your savings balance is *${formatBalance(balance)}*.`;
  if (totalSaved > balance) {
    text += `\n📈 Total saved lifetime: *${formatBalance(totalSaved)}*`;
  }
  // Check for active loans
  const fullMember = await prisma.member.findFirst({
    where: { phone },
    include: { loans: { where: { status: { in: ["approved", "disbursed"] } }, take: 1 } },
  });
  if (fullMember?.loans[0]) {
    const loan = fullMember.loans[0];
    text += `\n\n🏦 Active loan: *${formatBalance(loan.balance)}* remaining`;
    if (loan.monthlyPayment) {
      text += `\n📅 Next payment: *${formatBalance(loan.monthlyPayment)}*`;
    }
  }
  text += `\n\nReply *save <amount>* to contribute more.`;
  await sendText({ to: phone, text });
}
```

- [ ] **Step 4: Update the getMemberByPhone call to include totalSaved**

In `handleBalance`, the member type needs `totalSaved`. Update the type signature to include it, or fetch the full member. The existing `getMemberByPhone` already returns the wallet with `totalSaved` since the Wallet model has it.

- [ ] **Step 5: Run test to verify it passes**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run tests/xara-features.test.ts -t "Enriched Confirmations"
```

- [ ] **Step 6: Commit**

```bash
git add src/services/conversation.ts tests/xara-features.test.ts
git commit -m "feat: enriched transaction confirmations with running balance"
```

---

## Task 6: Final Integration & Verification

- [ ] **Step 1: Run full test suite**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx vitest run
```

Expected: All tests pass (121 existing + new xara-features tests).

- [ ] **Step 2: Run typecheck**

```bash
cd "C:\Users\Hp\projects\coop-whatsapp"; npx tsc --noEmit
```

Expected: Clean (no errors).

- [ ] **Step 3: Update menu with all new commands**

Ensure `buildMenu()` in conversation.ts includes:

```
• freeze — freeze your wallet
• unfreeze — restore access
• analytics — see your financial breakdown
• payees — manage favorite payees
```

- [ ] **Step 4: Commit final integration**

```bash
git add -A
git commit -m "feat: Xara-inspired features — voice, payees, freeze, analytics, enriched confirmations"
```
