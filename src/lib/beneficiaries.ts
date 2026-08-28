import { prisma } from "./prisma.js";
import { resolveBankCode } from "./banks.js";

export type PayeeResult =
  | { ok: true; payee: { id: string; name: string; accountNumber: string; bankCode: string; bankName: string | null } }
  | { ok: false; message: string };

export interface FavoritePayeeRecord {
  id: string;
  memberId: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  bankName: string | null;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;
}

const NAME_RE = /^[a-z0-9 _.\-']{1,40}$/i;
const ACCT_RE = /^\d{10}$/;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function savePayee(
  memberId: string,
  name: string,
  accountNumber: string,
  bankCode: string,
  bankName?: string | null,
): Promise<PayeeResult> {
  const cleanName = normalizeName(name);
  if (!NAME_RE.test(cleanName)) {
    return { ok: false, message: "Please use a short label (letters and numbers only, up to 40 characters)." };
  }
  if (!ACCT_RE.test(accountNumber.replace(/\s/g, ""))) {
    return { ok: false, message: "Please provide a valid 10-digit bank account number." };
  }
  const resolved = resolveBankCode(bankCode) ?? { code: bankCode, name: bankName ?? null };
  if (!resolved.code) {
    return { ok: false, message: "Please provide a valid bank code." };
  }

  const existing = await prisma.favoritePayee.findUnique({
    where: { memberId_name: { memberId, name: cleanName } },
  });
  if (existing) {
    return { ok: false, message: `You already have a saved payee called *${cleanName}*. Delete it first, or use a different name.` };
  }

  const payee = await prisma.favoritePayee.create({
    data: {
      memberId,
      name: cleanName,
      accountNumber: accountNumber.replace(/\s/g, ""),
      bankCode: resolved.code,
      bankName: resolved.name ?? null,
    },
    select: { id: true, name: true, accountNumber: true, bankCode: true, bankName: true },
  });
  return { ok: true, payee };
}

export function listPayees(memberId: string): Promise<FavoritePayeeRecord[]> {
  return prisma.favoritePayee.findMany({
    where: { memberId },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
  });
}

export function getPayeesText(payees: FavoritePayeeRecord[]): string {
  if (payees.length === 0) {
    return "You haven't saved any payees yet. Reply *addpayee <name> <account> <bank>* to save one.";
  }
  const lines = payees.map((p, i) => {
    const bank = p.bankName ? p.bankName : p.bankCode;
    const last = p.useCount > 0 ? ` · used ${p.useCount}x` : "";
    return `${i + 1}. *${p.name}* — ${bank} ****${p.accountNumber.slice(-4)}${last}`;
  });
  return `*👥 Your saved payees*\n\n${lines.join("\n")}\n\nReply *addpayee <name> <account> <bank>*, or a number to use one.`;
}

export async function resolvePayee(memberId: string, query: string): Promise<FavoritePayeeRecord | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // 1-based index shortcut, e.g. "2"
  if (/^\d+$/.test(trimmed)) {
    const all = await listPayees(memberId);
    const picked = all[parseInt(trimmed, 10) - 1];
    if (picked) return bumpPayee(picked.id);
    return null;
  }

  // fuzzy by name substring
  const fuzzy = await prisma.favoritePayee.findFirst({
    where: { memberId, name: { contains: trimmed.toLowerCase() } },
  });
  if (fuzzy) return bumpPayee(fuzzy.id);
  return null;
}

async function bumpPayee(id: string): Promise<FavoritePayeeRecord | null> {
  try {
    return await prisma.favoritePayee.update({
      where: { id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  } catch {
    return null;
  }
}

export async function deletePayee(memberId: string, id: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await prisma.favoritePayee.deleteMany({ where: { id, memberId } });
    return { ok: true };
  } catch {
    return { ok: false, message: "Couldn't delete that payee." };
  }
}
