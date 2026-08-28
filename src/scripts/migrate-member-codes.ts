/**
 * One-time migration: rewrite every member's code to the new file-number
 * format `{COOP}/{YYY}/{MM}{SEQ}` (e.g. SC/026/08081 — no slash before SEQ).
 *
 *   - COOP = cooperative join code, uppercased
 *   - YYY  = last 3 digits of the member's join year (2026 -> 026)
 *   - MM   = join month, zero-padded
 *   - SEQ  = 1..N per cooperative, assigned in join order (createdAt, then id)
 *
 * Also backfills Cooperative.memberSeq so new members continue the sequence.
 * Idempotent — safe to re-run.
 *
 * Usage: npx tsx src/scripts/migrate-member-codes.ts
 */
import { prisma } from "../lib/prisma.js";

async function main() {
  const coops = await prisma.cooperative.findMany({ orderBy: { createdAt: "asc" } });
  let updated = 0;
  let total = 0;

  for (const coop of coops) {
    const members = await prisma.member.findMany({
      where: { cooperativeId: coop.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, code: true, createdAt: true },
    });
    const prefix = coop.code.trim().toUpperCase();
    let seq = 0;
    for (const m of members) {
      seq += 1;
      const yy = String(m.createdAt.getUTCFullYear() % 1000).padStart(3, "0");
      const mm = String(m.createdAt.getUTCMonth() + 1).padStart(2, "0");
      const code = `${prefix}/${yy}/${mm}${String(seq).padStart(3, "0")}`;
      if (m.code !== code) {
        await prisma.member.update({ where: { id: m.id }, data: { code } });
        updated += 1;
      }
      total += 1;
    }
    await prisma.cooperative.update({
      where: { id: coop.id },
      data: { memberSeq: members.length },
    });
  }

  console.log(`Done. Reviewed ${total} member(s) across ${coops.length} cooperative(s); rewrote ${updated} code(s).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
