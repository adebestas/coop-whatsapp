import { prisma, withTxBatch } from "../lib/prisma.js";
import { sendText, notifyMember } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { assertFreshPin, assertMoneyAuthorized } from "./auth2fa.js";
import { revokeMemberSessions, unrevokeMemberSessions } from "./revocation.js";
import { requestManualCredit, approveManualCredit, rejectManualCredit } from "./manualcredit.js";
import { startDeathClaim, setClaimBank, approveClaim, rejectClaim } from "./deathclaims.js";
import {
  addBeneficialOwner,
  listBeneficialOwners,
  markCorporateMember,
  removeBeneficialOwner,
  BeneficialOwnerError,
} from "./beneficial-owners.js";
import {
  listSubstitutions,
  approveSubstitution,
  rejectSubstitution,
} from "./guarantor-substitution.js";
import { approvePhoneChange, rejectPhoneChange } from "./phone-change.js";
import { AdminContext, roleLabel, guardFailed } from "./admin-context.js";

/**
 * Handle member administration, roles, KYC, death claims, beneficial owners, and sessions.
 * Returns true if the command was recognized and handled.
 */
export async function handleMemberAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
  ctx: AdminContext,
): Promise<boolean> {
  const { admin, unitAdmin, isSuper } = ctx;
  const coopId = admin.cooperativeId;

  switch (cmd) {
    case "revoke": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can revoke a member's sessions.",
        });
        return true;
      }
      const rCode = args[0];
      if (!rCode) {
        await sendText({
          to: phone,
          text: "Usage: *revoke <member code>* — revokes a member's sessions and blocks money movement.",
        });
        return true;
      }
      const r = await revokeMemberSessions(phone, admin.id, coopId, rCode);
      await sendText({ to: phone, text: r.message });
      return true;
    }

    case "unrevoke": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can restore a member's sessions.",
        });
        return true;
      }
      const uCode = args[0];
      if (!uCode) {
        await sendText({
          to: phone,
          text: "Usage: *unrevoke <member code>* — restores a revoked member's sessions.",
        });
        return true;
      }
      const u = await unrevokeMemberSessions(phone, admin.id, coopId, uCode);
      await sendText({ to: phone, text: u.message });
      return true;
    }

    case "manualcredit": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can initiate a manual credit.",
        });
        return true;
      }
      const mcCode = args[0];
      const mcAmt = Number(args[1]);
      const mcNarration = args.slice(2).join(" ").trim();
      if (!mcCode || !Number.isFinite(mcAmt) || mcAmt <= 0) {
        await sendText({
          to: phone,
          text: "Usage: *manualcredit <member code> <amount> <narration>* — e.g. *manualcredit MEM001 5000 Refund for July*",
        });
        return true;
      }
      const mcRes = await requestManualCredit(phone, mcCode, mcAmt, mcNarration);
      await sendText({ to: phone, text: mcRes.message });
      return true;
    }

    case "approvemanualcredit": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can approve a manual credit.",
        });
        return true;
      }
      const creditGuard = await assertMoneyAuthorized(admin.id, args);
      if (!creditGuard.ok) return guardFailed(phone, creditGuard.message);
      const creditArgs = creditGuard.args;
      const amcId = creditArgs[0];
      const amcPin = creditArgs[1];
      if (!amcId || !amcPin) {
        await sendText({
          to: phone,
          text: "Usage: *approvemanualcredit <credit id> <your PIN>* — the approving super admin must differ from the initiator.",
        });
        return true;
      }
      const amcCredit = await prisma.manualCredit.findFirst({
        where: { cooperativeId: coopId, status: "pending", id: { endsWith: amcId } },
      });
      if (amcCredit) {
        const amcPinCheck = await assertFreshPin(phone, amcCredit.amount);
        if (!amcPinCheck.ok) return guardFailed(phone, amcPinCheck.message);
      }
      const amcRes = await approveManualCredit(phone, amcId, amcPin);
      await sendText({ to: phone, text: amcRes.message });
      return true;
    }

    case "rejectmanualcredit": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can reject a manual credit." });
        return true;
      }
      const rmId = args[0];
      if (!rmId) {
        await sendText({ to: phone, text: "Usage: *rejectmanualcredit <credit id> [reason]*" });
        return true;
      }
      const rmRes = await rejectManualCredit(phone, rmId, args.slice(1).join(" "));
      await sendText({ to: phone, text: rmRes.message });
      return true;
    }

    case "deathclaim": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can open death claims." });
        return true;
      }
      const code = args[0];
      const familyPhone = args[1];
      if (!code || !familyPhone) {
        await sendText({ to: phone, text: "Usage: *deathclaim <member code> <family phone>*" });
        return true;
      }
      const result = await startDeathClaim(phone, code, familyPhone);
      await sendText({ to: phone, text: result.message });
      if (result.ok && result.claimId) {
        await prisma.session.upsert({
          where: { phone },
          create: {
            phone,
            state: "awaiting_death_cert",
            data: JSON.stringify({ deathClaimId: result.claimId }),
          },
          update: {
            state: "awaiting_death_cert",
            data: JSON.stringify({ deathClaimId: result.claimId }),
          },
        });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: roleLabel(ctx),
          action: "claim.open",
          targetType: "deathclaim",
          targetId: result.claimId,
          detail: result.message,
        });
      }
      return true;
    }

    case "claimbank": {
      if (unitAdmin) {
        await sendText({
          to: phone,
          text: "Only the cooperative admin can set the family's bank.",
        });
        return true;
      }
      const claimCode = args[0];
      const account = args[1];
      const bank = args.slice(2).join(" ");
      if (!claimCode || !account || !bank) {
        await sendText({
          to: phone,
          text: "Usage: *claimbank <claim id> <account number> <bank>*, e.g. *claimbank ABC123 0123456789 Access*",
        });
        return true;
      }
      const result = await setClaimBank(phone, claimCode, account, bank);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "claim.set_bank",
        targetType: "deathclaim",
        targetId: claimCode,
        detail: result.message,
      });
      return true;
    }

    case "approveclaim": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can give the final approval on a death claim.",
        });
        return true;
      }
      const claimCode = args[0];
      if (!claimCode) {
        await sendText({ to: phone, text: "Usage: *approveclaim <claim id>*" });
        return true;
      }
      const result = await approveClaim(phone, claimCode);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "claim.payout",
        targetType: "deathclaim",
        targetId: claimCode,
        detail: result.message,
      });
      return true;
    }

    case "rejectclaim": {
      if (unitAdmin) {
        await sendText({ to: phone, text: "Only the cooperative admin can reject claims." });
        return true;
      }
      const claimCode = args[0];
      if (!claimCode) {
        await sendText({ to: phone, text: "Usage: *rejectclaim <claim id>*" });
        return true;
      }
      const result = await rejectClaim(phone, claimCode);
      await sendText({ to: phone, text: result.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: roleLabel(ctx),
        action: "claim.reject",
        targetType: "deathclaim",
        targetId: claimCode,
        detail: result.message,
      });
      return true;
    }

    case "pendingclaims": {
      const claims = await prisma.deathClaim.findMany({
        where: {
          cooperativeId: coopId,
          status: { in: ["awaiting_certificate", "awaiting_validation", "validated"] },
        },
        include: {
          member: { select: { name: true } },
          validations: { select: { memberId: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      if (claims.length === 0) {
        await sendText({ to: phone, text: "No death claims in progress." });
        return true;
      }
      const body = claims
        .map((c) => {
          const stage =
            c.status === "awaiting_certificate"
              ? "⏳ awaiting certificate"
              : c.status === "awaiting_validation"
                ? `⏳ validation ${c.validations.length}/2`
                : "✅ validated — ready for super admin";
          return `• *${c.id.slice(-6)}* — ${c.member.name} (${stage})`;
        })
        .join("\n");
      await sendText({ to: phone, text: `*Death claims*\n\n${body}` });
      return true;
    }

    case "setrole": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can set roles." });
        return true;
      }
      const code = args[0]?.toUpperCase();
      const role = args[1]?.toLowerCase();
      if (!code || !["member", "admin", "superadmin", "support"].includes(role ?? "")) {
        await sendText({
          to: phone,
          text: "Usage: *setrole <member code> <member|admin|superadmin|support>*",
        });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member with code *${code}* in your cooperative.` });
        return true;
      }
      if (target.id === admin.id) {
        await sendText({ to: phone, text: "You can't change your own role." });
        return true;
      }
      if (target.role === "superadmin" && role !== "superadmin") {
        const superCount = await prisma.member.count({
          where: {
            cooperativeId: coopId,
            role: "superadmin",
            status: "active",
            id: { not: target.id },
          },
        });
        if (superCount < 1) {
          await sendText({
            to: phone,
            text: "Cannot demote: this would leave the cooperative with no superadmins.",
          });
          return true;
        }
      }
      await prisma.member.update({ where: { id: target.id }, data: { role } });
      await sendText({ to: phone, text: `✅ ${target.name} is now *${role}*.` });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "role.set",
        targetType: "member",
        targetId: target.id,
        detail: `${target.name} -> ${role}`,
      });
      return true;
    }

    case "corporate": {
      const code = args[0];
      const rc = args.slice(1).join(" ");
      if (!code || !rc) {
        await sendText({
          to: phone,
          text: "Usage: *corporate <member code> <RC number>* — e.g. *corporate MEM001 RC1234567*.",
        });
        return true;
      }
      try {
        const member = await markCorporateMember(coopId, code, rc);
        await sendText({
          to: phone,
          text: `✅ *${member.name}* (${member.code}) is now a corporate member, RC *${member.rcNumber}*.\n\nAdd its owners with *beneficial ${member.code} <owner name> <percent>*.`,
        });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: roleLabel(ctx),
          action: "member.corporate.set",
          targetType: "member",
          targetId: member.id,
          detail: `RC ${member.rcNumber}`,
        });
      } catch (err) {
        if (!(err instanceof BeneficialOwnerError)) throw err;
        await sendText({ to: phone, text: err.message });
      }
      return true;
    }

    case "beneficial": {
      const code = args[0];
      const pctRaw = args[args.length - 1];
      const ownerName = args.slice(1, -1).join(" ");
      const pct = Number(pctRaw);
      if (!code || !ownerName || !Number.isFinite(pct)) {
        await sendText({
          to: phone,
          text: "Usage: *beneficial <member code> <owner name> <percent>* — e.g. *beneficial MEM001 Ada Obi 40*.",
        });
        return true;
      }
      try {
        const owner = await addBeneficialOwner(coopId, code, ownerName, pct);
        await sendText({
          to: phone,
          text: `✅ Recorded *${owner.name}* as a ${owner.ownershipPct}% beneficial owner of *${code.toUpperCase()}*.\n\nOwner id: *${owner.id.slice(-6)}*`,
        });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: roleLabel(ctx),
          action: "member.beneficial_owner.add",
          targetType: "member",
          targetId: owner.memberId,
          detail: `${owner.name} ${owner.ownershipPct}%`,
        });
      } catch (err) {
        if (!(err instanceof BeneficialOwnerError)) throw err;
        await sendText({ to: phone, text: err.message });
      }
      return true;
    }

    case "beneficials": {
      const code = args[0];
      if (!code) {
        await sendText({ to: phone, text: "Usage: *beneficials <member code>*." });
        return true;
      }
      try {
        const { member, owners, total } = await listBeneficialOwners(coopId, code);
        if (owners.length === 0) {
          await sendText({
            to: phone,
            text: `No beneficial owners recorded for *${member.name}* (${member.code}).\n\nAdd one with *beneficial ${member.code} <owner name> <percent>*.`,
          });
          return true;
        }
        const lines = owners
          .map(
            (o) =>
              `• *${o.id.slice(-6)}* — ${o.name} · ${o.ownershipPct}%${o.idType && o.idNumber ? ` · ${o.idType} ${o.idNumber}` : ""}`,
          )
          .join("\n");
        await sendText({
          to: phone,
          text: `*Beneficial owners — ${member.name} (${member.code})*\n\n${lines}\n\nTotal recorded: *${total}%*`,
        });
      } catch (err) {
        if (!(err instanceof BeneficialOwnerError)) throw err;
        await sendText({ to: phone, text: err.message });
      }
      return true;
    }

    case "removebeneficial": {
      const code = args[0];
      const ref = args[1];
      if (!code || !ref) {
        await sendText({
          to: phone,
          text: "Usage: *removebeneficial <member code> <owner id>* — the owner id is printed by *beneficials*.",
        });
        return true;
      }
      try {
        const removed = await removeBeneficialOwner(coopId, code, ref);
        await sendText({ to: phone, text: `✅ Removed beneficial owner *${removed.name}*.` });
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: roleLabel(ctx),
          action: "member.beneficial_owner.remove",
          targetType: "member",
          targetId: removed.memberId,
          detail: `${removed.name} ${removed.ownershipPct}%`,
        });
      } catch (err) {
        if (!(err instanceof BeneficialOwnerError)) throw err;
        await sendText({ to: phone, text: err.message });
      }
      return true;
    }

    case "members": {
      const members = await prisma.member.findMany({
        where: { cooperativeId: coopId },
        select: {
          name: true,
          code: true,
          role: true,
          status: true,
          createdAt: true,
          phone: true,
          wallet: { select: { balance: true } },
        },
        orderBy: { name: "asc" },
        take: 100,
      });
      if (members.length === 0) {
        await sendText({ to: phone, text: "No members in this cooperative." });
        return true;
      }
      const body = members
        .map(
          (m) =>
            `• *${m.name}* (${m.code}) — ${m.role}, ${m.status}\n  Joined: ${m.createdAt.toLocaleDateString("en-GB")} · Balance: ${formatBalance(m.wallet?.balance ?? 0)}`,
        )
        .join("\n");
      await sendText({ to: phone, text: `*Members (${members.length})*\n\n${body}` });
      return true;
    }

    case "substitutions": {
      const result = await listSubstitutions(phone);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "approvesubstitution": {
      const result = await approveSubstitution(phone, args[0] ?? "");
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "rejectsubstitution": {
      const reason = args.slice(1).join(" ");
      const result = await rejectSubstitution(phone, args[0] ?? "", reason);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "confirmname": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can confirm a member's name.",
        });
        return true;
      }
      const code = args[0]?.toUpperCase();
      if (!code) {
        await sendText({ to: phone, text: "Usage: *confirmname <member code>*" });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member found with code ${code}.` });
        return true;
      }
      if (target.id === admin.id) {
        await sendText({
          to: phone,
          text: "You cannot confirm your own name — ask another super admin.",
        });
        return true;
      }
      await prisma.member.update({ where: { id: target.id }, data: { nameVerified: true } });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "member.name.confirm",
        targetType: "member",
        targetId: target.id,
        detail: target.name,
      });
      await notifyMember(
        target,
        "✅ Your name has been confirmed by a super admin. You can now create deduction batches.",
      ).catch(() => {});
      await sendText({ to: phone, text: `✅ ${target.name}'s name is now confirmed.` });
      return true;
    }

    case "confirmkyc": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can confirm a member's KYC." });
        return true;
      }
      const code = args[0]?.toUpperCase();
      if (!code) {
        await sendText({ to: phone, text: "Usage: *confirmkyc <member code>*" });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member found with code ${code}.` });
        return true;
      }
      await prisma.member.update({
        where: { id: target.id },
        data: { kycStatus: "verified", kycVerifiedAt: new Date() },
      });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "member.kyc.confirm",
        targetType: "member",
        targetId: target.id,
        detail: target.name,
      });
      await notifyMember(
        target,
        "✅ Your identity (NIN) has been verified. Your account is now *Tier 2*.",
      ).catch(() => {});
      await sendText({ to: phone, text: `✅ ${target.name}'s KYC is now verified.` });
      return true;
    }

    case "approvephone":
    case "rejectphone": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can approve or reject phone changes.",
        });
        return true;
      }
      const code = args[0]?.toUpperCase();
      if (!code) {
        await sendText({
          to: phone,
          text: `Usage: *${cmd} <member code>*` + (cmd === "rejectphone" ? " [reason]" : ""),
        });
        return true;
      }
      const result =
        cmd === "approvephone"
          ? await approvePhoneChange(phone, code)
          : await rejectPhoneChange(phone, code, args.slice(1).join(" ") || undefined);
      await sendText({ to: phone, text: result.message });
      return true;
    }

    case "relink": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can relink a member's account.",
        });
        return true;
      }
      const [rawCode, newChannel] = args;
      if (!rawCode || !newChannel) {
        await sendText({
          to: phone,
          text: "Usage: *relink <member code> <new number>* — e.g. *relink A1B2C3 2348012345678* (or tg:<chatid>).",
        });
        return true;
      }
      const target = await prisma.member.findFirst({
        where: { code: rawCode.toUpperCase(), cooperativeId: coopId },
      });
      if (!target) {
        await sendText({
          to: phone,
          text: `No member found with code ${rawCode.toUpperCase()}.`,
        });
        return true;
      }
      const oldPhone = target.phone;
      await withTxBatch([
        prisma.member.update({
          where: { id: target.id },
          data: { phone: newChannel, preferredChannel: null },
        }),
        prisma.session.deleteMany({ where: { phone: oldPhone } }),
        prisma.session.deleteMany({ where: { phone: newChannel } }),
      ]);
      await sendText({
        to: oldPhone,
        text: "🔐 This account has been moved to a new number by your co-op admin. If this was not you, contact them immediately.",
      }).catch(() => {});
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "account.relink",
        targetType: "member",
        targetId: target.id,
        detail: `${oldPhone} -> ${newChannel}`,
      });
      await sendText({
        to: phone,
        text: `✅ ${target.name}'s account moved from ${oldPhone} to ${newChannel}. Ask them to send *setpin 1234 1234* style commands to set a fresh PIN.`,
      });
      return true;
    }

    case "unlink": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can unlink a member's second channel.",
        });
        return true;
      }
      const code = args[0]?.toUpperCase();
      if (!code) {
        await sendText({ to: phone, text: "Usage: *unlink <member code>*" });
        return true;
      }
      const target = await prisma.member.findFirst({ where: { code, cooperativeId: coopId } });
      if (!target) {
        await sendText({ to: phone, text: `No member found with code ${code}.` });
        return true;
      }
      await prisma.member.update({
        where: { id: target.id },
        data: { altChannelId: null, preferredChannel: null },
      });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "account.unlink",
        targetType: "member",
        targetId: target.id,
        detail: target.code,
      });
      await sendText({
        to: phone,
        text: `✅ Second channel detached from ${target.name}. They now chat only on ${target.phone}.`,
      });
      return true;
    }

    default:
      return false;
  }
}
