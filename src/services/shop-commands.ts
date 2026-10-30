import { sendText } from "../lib/messaging.js";
import { prisma } from "../lib/prisma.js";
import { formatBalance, toKobo } from "../lib/money.js";
import { getMemberByPhone } from "./cooperative.js";
import { issueSecretChallenge } from "./handlers/session.js";
import {
  approveShopOrder,
  catalogText,
  closeShopItem,
  createShopItem,
  dispatchShopOrder,
  installmentSchedule,
  memberOrdersText,
  openOrdersText,
  rejectShopOrder,
} from "./shop.js";

const ADMIN_COMMANDS = new Set([
  "addshopitem",
  "shopitems",
  "shoporders",
  "approveorder",
  "rejectorder",
  "dispatch",
  "closeshopitem",
]);

const MEMBER_COMMANDS = new Set(["shop", "buyitem", "myshop"]);

type MemberRow = NonNullable<Awaited<ReturnType<typeof getMemberByPhone>>>;

function parseAddItemRaw(raw: string): {
  name: string;
  priceNaira?: number;
  months?: number;
  stock?: number | null;
} {
  const body = raw.replace(/^\/?\s*addshopitem\s+/i, "").trim();
  if (!body) return { name: "" };

  let name: string;
  let tail: string;
  const quoted = body.match(/^["']([^"']+)["']\s*(.*)$/);
  if (quoted) {
    name = quoted[1].trim();
    tail = quoted[2].trim();
  } else {
    const tokens = body.split(/\s+/);
    const numbers: string[] = [];
    while (
      tokens.length > 1 &&
      numbers.length < 3 &&
      /^\d[\d,]*$/.test(tokens[tokens.length - 1])
    ) {
      numbers.unshift(tokens.pop() as string);
    }
    name = tokens.join(" ").trim();
    tail = numbers.join(" ");
  }

  const values = tail
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => Number(token.replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));

  return { name, priceNaira: values[0], months: values[1], stock: values[2] ?? null };
}

export async function handleShopCommand(
  phone: string,
  cmd: string,
  args: string[],
  rawText: string,
  member: MemberRow | null,
): Promise<boolean> {
  if (!ADMIN_COMMANDS.has(cmd) && !MEMBER_COMMANDS.has(cmd)) return false;

  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
    return true;
  }

  const cooperativeId = member.cooperativeId;

  if (ADMIN_COMMANDS.has(cmd)) {
    if (member.role !== "admin" && member.role !== "superadmin") {
      await sendText({ to: phone, text: "Only a cooperative admin can use that command." });
      return true;
    }
  }

  switch (cmd) {
    case "shop": {
      await sendText({ to: phone, text: await catalogText(cooperativeId) });
      return true;
    }

    case "myshop": {
      await sendText({ to: phone, text: await memberOrdersText(member.id) });
      return true;
    }

    case "buyitem": {
      const key = (args[0] ?? "").trim();
      if (!key) {
        await sendText({
          to: phone,
          text: "Reply *shop* to see the items, then *buyitem <number> <months>*.",
        });
        return true;
      }
      const items = await prisma.shopItem.findMany({
        where: { cooperativeId, active: true },
        orderBy: { createdAt: "asc" },
        take: 20,
      });
      const item = /^\d+$/.test(key)
        ? items[Number(key) - 1]
        : items.find((row) => row.id === key || row.name.toLowerCase() === key.toLowerCase());
      if (!item) {
        await sendText({
          to: phone,
          text: "I could not find that item. Reply *shop* to see the list.",
        });
        return true;
      }
      const requested = Number(args[1]);
      const months =
        Number.isFinite(requested) && requested >= 1
          ? Math.min(Math.floor(requested), item.maxMonths)
          : Math.min(3, item.maxMonths);
      const { monthly, last } = installmentSchedule(item.cashPrice, months);
      const schedule =
        monthly === last
          ? `${formatBalance(monthly)}/month`
          : `${formatBalance(monthly)}/month for ${months - 1} months, then ${formatBalance(last)}`;
      const prompt =
        `Order *${item.name}* for ${formatBalance(item.cashPrice)} over ${months} month${months === 1 ? "" : "s"} ` +
        `(${schedule}, interest-free).\n\n` +
        `Enter your 4-digit PIN to confirm.`;
      await issueSecretChallenge(
        phone,
        "awaiting_shop_pin",
        { shopItemId: item.id, shopMonths: months },
        prompt,
      );
      return true;
    }

    case "addshopitem": {
      const parsed = parseAddItemRaw(rawText);
      if (!parsed.name) {
        await sendText({
          to: phone,
          text:
            'Usage: *addshopitem "Item name" <price> [months] [stock]*\n' +
            'Example: addshopitem "50kg Rice" 88000 3 10',
        });
        return true;
      }
      const result = await createShopItem({
        cooperativeId,
        createdById: member.id,
        actorPhone: phone,
        actorRole: member.role,
        name: parsed.name,
        cashPrice: toKobo(parsed.priceNaira ?? 0),
        maxMonths: parsed.months ?? 3,
        stockQty: parsed.stock ?? null,
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "shopitems": {
      await sendText({ to: phone, text: await catalogText(cooperativeId) });
      return true;
    }

    case "shoporders": {
      const status = (args[0] ?? "pending").toLowerCase();
      await sendText({ to: phone, text: await openOrdersText(cooperativeId, status) });
      return true;
    }

    case "approveorder": {
      const key = args[0];
      if (!key) {
        await sendText({ to: phone, text: "Usage: *approveorder <order ref>*" });
        return true;
      }
      const result = await approveShopOrder({
        cooperativeId,
        key,
        actorId: member.id,
        actorPhone: phone,
        actorRole: member.role,
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "rejectorder": {
      const key = args[0];
      if (!key) {
        await sendText({ to: phone, text: "Usage: *rejectorder <order ref> [reason]*" });
        return true;
      }
      const result = await rejectShopOrder({
        cooperativeId,
        key,
        reason: args.slice(1).join(" "),
        actorId: member.id,
        actorPhone: phone,
        actorRole: member.role,
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "dispatch": {
      const key = args[0];
      if (!key) {
        await sendText({ to: phone, text: "Usage: *dispatch <order ref>*" });
        return true;
      }
      const result = await dispatchShopOrder({
        cooperativeId,
        key,
        actorId: member.id,
        actorPhone: phone,
        actorRole: member.role,
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "closeshopitem": {
      const key = args.join(" ").trim();
      if (!key) {
        await sendText({ to: phone, text: "Usage: *closeshopitem <item name>*" });
        return true;
      }
      const result = await closeShopItem({
        cooperativeId,
        key,
        actorId: member.id,
        actorPhone: phone,
        actorRole: member.role,
      });
      await sendText({ to: phone, text: result.message });
      return true;
    }
  }

  return false;
}
