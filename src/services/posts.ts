import { prisma } from "../lib/prisma.js";

/** Normalise a post title to its storage key: lowercase, single-spaced. */
export function normalizeTitle(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
}

/** "financial secretary" -> "Financial Secretary" */
export function displayTitle(key: string): string {
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Render the cooperative organogram. */
export async function listPosts(cooperativeId: string): Promise<string> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  const posts = await prisma.coopPost.findMany({
    where: { cooperativeId },
    orderBy: { title: "asc" },
    include: { incumbent: true },
  });
  if (posts.length === 0) {
    return "🏛 No executive posts have been assigned yet. Your super admin can set them with *setpost <post> <member code>*.";
  }
  const lines = [`🏛 *${coop?.name ?? "Cooperative"} — Executive Posts*`, ""];
  for (const p of posts) {
    lines.push(
      `• *${displayTitle(p.title)}:* ${p.incumbent ? `${p.incumbent.name} (${p.incumbent.code})` : "_vacant_"}`,
    );
  }
  return lines.join("\n");
}
