import { prisma } from "../lib/prisma.js";
import { sendText, sendLongText } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { toKobo } from "../lib/money.js";
import { audit } from "./audit.js";
import { computePnl, getMonthlySummary, recordLedger } from "./ledger.js";
import { computePearls, computePar, provisionRates, runProvision } from "./provisioning.js";
import { getFundBalances, previewDividendRun } from "./dividends.js";
import { getReserveReport, runWalletReconciliation } from "./reconciliation.js";
import { runReconciliation } from "./reconcile.js";
import { getCoopConfig, updateCoopConfig } from "./coop-config.js";
import { startDividendVote, closeDividendVote, dividendVoteStatus } from "./dividendvote.js";
import { AdminContext } from "./admin-context.js";

/**
 * Handle dividend, financial reporting, provisioning, and accounting commands.
 * Returns true if the command was recognized and handled.
 */
export async function handleDividendAdminCommand(
  phone: string,
  cmd: string,
  args: string[],
  ctx: AdminContext,
): Promise<boolean> {
  const { admin, unitAdmin, isSuper } = ctx;
  const coopId = admin.cooperativeId;

  switch (cmd) {
    case "interest": {
      await sendText({
        to: phone,
        text:
          "*Loan interest (declining balance tiers)*\n\n" +
          "• Up to 3 months: *20% APR* (~5% flat equivalent)\n" +
          "• 4–6 months: *16% APR* (~8% flat equivalent)\n" +
          "• 7–9 months: *12% APR* (~9% flat equivalent)\n" +
          "• 10–12 months: *10% APR* (~10% flat equivalent)\n\n" +
          `Admin charge per loan: ${formatBalance(2000)} (deducted at disbursement).`,
      });
      return true;
    }

    case "pnl": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can view profit & loss." });
        return true;
      }

      const arg = args.join(" ").trim().toLowerCase();
      let pnl;

      if (!arg) {
        pnl = await computePnl(coopId);
      } else if (arg === "today") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        pnl = await computePnl(coopId, today, new Date());
      } else if (arg === "month" || arg === "this month") {
        const now = new Date();
        pnl = await getMonthlySummary(coopId, now.getFullYear(), now.getMonth());
      } else if (arg === "last month") {
        const now = new Date();
        const lastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
        const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        pnl = await getMonthlySummary(coopId, year, lastMonth);
      } else if (arg.match(/^\d{4}-\d{2}$/)) {
        const [year, month] = arg.split("-").map(Number);
        pnl = await getMonthlySummary(coopId, year, month - 1);
      } else if (arg.includes(" ")) {
        const [startStr, endStr] = arg.split(" ");
        const start = new Date(startStr);
        const end = new Date(endStr);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          await sendText({
            to: phone,
            text: "Invalid date format. Use: *pnl 2026-08-01 2026-08-31*",
          });
          return true;
        }
        pnl = await computePnl(coopId, start, end);
      } else {
        await sendText({
          to: phone,
          text: "Usage:\n• *pnl* — all time\n• *pnl today* — today\n• *pnl month* — this month\n• *pnl last month* — last month\n• *pnl 2026-08* — specific month\n• *pnl 2026-08-01 2026-08-31* — date range",
        });
        return true;
      }

      const inc = Object.entries(pnl.incomeByCategory).map(
        ([c, a]) => `• ${c}: +${formatBalance(a)}`,
      );
      const exp = Object.entries(pnl.expenseByCategory).map(
        ([c, a]) => `• ${c}: −${formatBalance(a)}`,
      );
      const periodText = pnl.period
        ? ` (${pnl.period.start.toLocaleDateString()} - ${pnl.period.end.toLocaleDateString()})`
        : " (all time)";
      const body = [
        `*📊 Profit & Loss${periodText}*`,
        "",
        "*Income*",
        ...(inc.length > 0 ? inc : ["• (none yet)"]),
        "",
        "*Expenses*",
        ...(exp.length > 0 ? exp : ["• (none yet)"]),
        "",
        `Total income: *${formatBalance(pnl.totalIncome)}*`,
        `Total expenses: *${formatBalance(pnl.totalExpense)}*`,
        `NET ${pnl.netProfit >= 0 ? "PROFIT" : "LOSS"}: *${formatBalance(Math.abs(pnl.netProfit))}*`,
        "",
        "_Dividends are paid from this profit: *paydividend <rate%>*_",
      ];
      await sendLongText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "pearls": {
      const pearls = await computePearls(coopId);
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
      const summary = [
        "*💎 PEARLS health check*",
        "",
        "*P — Protection*",
        `• Allowance / loans: *${pct(pearls.protection.allowanceToLoans)}*`,
        `• Net capital: *${pct(pearls.protection.netCapital)}*`,
        "",
        "*E — Effective structure*",
        `• Loans / assets: *${pct(pearls.effectiveStructure.loansToAssets)}*`,
        `• Savings / assets: *${pct(pearls.effectiveStructure.savingsToAssets)}*`,
        "",
        "*A — Asset quality*",
        `• PAR ratio: *${pct(pearls.assetQuality.parRatio)}*`,
        `• Provision coverage: *${pct(pearls.assetQuality.provisionCoverage)}*`,
        "",
        "*R — Rates of return*",
        `• Interest income / assets: *${pct(pearls.ratesOfReturn.interestIncomeToAssets)}*`,
        `• Cost of funds: *${pct(pearls.ratesOfReturn.costOfFunds)}*`,
        "",
        "*L — Liquidity*",
        `• Liquid assets / savings: *${pct(pearls.liquidity.liquidAssetsToSavings)}*`,
        "",
        "*S — Signs of growth*",
        `• Member growth (YoY): *${pct(pearls.signsOfGrowth.memberGrowth)}*`,
        `• Savings growth (YoY): *${pct(pearls.signsOfGrowth.savingsGrowth)}*`,
        "",
        `_Book: ${pearls.totals.members} members · savings ${formatBalance(pearls.totals.savings)} · loans ${formatBalance(pearls.totals.loans)}_`,
      ];
      await sendLongText({ to: phone, text: summary.join("\n") });
      return true;
    }

    case "expense": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can record expenses." });
        return true;
      }

      const match = args
        .join(" ")
        .trim()
        .match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        await sendText({
          to: phone,
          text: "Usage: *expense <amount> <category> <description>*\n\nCategories: salary, stipend, purchase, external_payment, other\nExample: *expense 50000 salary August admin salary*",
        });
        return true;
      }

      const amount = toKobo(parseInt(match[1], 10));
      const category = match[2];
      const description = match[3];

      if (!Number.isFinite(amount) || amount <= 0) {
        await sendText({ to: phone, text: "Amount must be a positive number." });
        return true;
      }

      const validCategories = ["salary", "stipend", "purchase", "external_payment", "other"];
      if (!validCategories.includes(category)) {
        await sendText({
          to: phone,
          text: `Invalid category. Use: ${validCategories.join(", ")}`,
        });
        return true;
      }

      await recordLedger({
        cooperativeId: coopId,
        type: "expense",
        category: category as any,
        amount,
        note: description,
        reference: `EXP-${Date.now()}`,
      });

      await sendText({
        to: phone,
        text: `✅ Expense recorded!\n\nAmount: *${formatBalance(amount)}*\nCategory: *${category}*\nDescription: *${description}*`,
      });
      return true;
    }

    case "monthly": {
      const arg = args.join(" ").trim().toLowerCase();
      let year: number;
      let month: number;

      if (!arg) {
        const now = new Date();
        year = now.getFullYear();
        month = now.getMonth();
      } else if (arg.match(/^\d{4}-\d{2}$/)) {
        [year, month] = arg.split("-").map(Number);
        month -= 1;
      } else {
        await sendText({ to: phone, text: "Usage: *monthly* or *monthly 2026-08*" });
        return true;
      }

      const pnl = await getMonthlySummary(coopId, year, month);
      const monthName = new Date(year, month).toLocaleString("default", { month: "long" });

      const inc = Object.entries(pnl.incomeByCategory).map(
        ([c, a]) => `• ${c}: +${formatBalance(a)}`,
      );
      const exp = Object.entries(pnl.expenseByCategory).map(
        ([c, a]) => `• ${c}: −${formatBalance(a)}`,
      );

      const body = [
        `*📅 Monthly Report: ${monthName} ${year}*`,
        "",
        "*Income*",
        ...(inc.length > 0 ? inc : ["• (none)"]),
        "",
        "*Expenses*",
        ...(exp.length > 0 ? exp : ["• (none)"]),
        "",
        `Total income: *${formatBalance(pnl.totalIncome)}*`,
        `Total expenses: *${formatBalance(pnl.totalExpense)}*`,
        `NET ${pnl.netProfit >= 0 ? "PROFIT" : "LOSS"}: *${formatBalance(Math.abs(pnl.netProfit))}*`,
      ];
      await sendLongText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "annualreport": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can generate annual reports.",
        });
        return true;
      }
      const reportYear = parseInt(args[0]) || new Date().getFullYear();
      const startOfYear = new Date(reportYear, 0, 1);
      const endOfYear = new Date(reportYear + 1, 0, 1);

      const coopFull = await prisma.cooperative.findUnique({ where: { id: coopId } });
      if (!coopFull) {
        await sendText({ to: phone, text: "Cooperative not found." });
        return true;
      }

      const [
        totalLoansDisbursed,
        totalLoansRepaid,
        totalDividends,
        totalWithdrawals,
        memberCount,
        newMembers,
        deceasedMembers,
        activeLoans,
        walletAgg,
        reserveFund,
        eduFund,
        devFund,
        coopConfig,
        officers,
        pnl,
      ] = await Promise.all([
        prisma.loan.aggregate({
          where: {
            cooperativeId: coopId,
            status: { in: ["approved", "disbursed", "paid"] },
            approvedAt: { gte: startOfYear, lt: endOfYear },
          },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.loanRepayment.aggregate({
          where: { loan: { cooperativeId: coopId }, paidAt: { gte: startOfYear, lt: endOfYear } },
          _sum: { amount: true },
        }),
        prisma.dividend.aggregate({
          where: { cooperativeId: coopId, createdAt: { gte: startOfYear, lt: endOfYear } },
          _sum: { totalPool: true },
          _count: true,
        }),
        prisma.withdrawalRequest.aggregate({
          where: {
            cooperativeId: coopId,
            status: "paid",
            finalizedAt: { gte: startOfYear, lt: endOfYear },
          },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.member.count({ where: { cooperativeId: coopId, status: "active" } }),
        prisma.member.count({
          where: { cooperativeId: coopId, createdAt: { gte: startOfYear, lt: endOfYear } },
        }),
        prisma.member.count({
          where: {
            cooperativeId: coopId,
            status: "deceased",
            updatedAt: { gte: startOfYear, lt: endOfYear },
          },
        }),
        prisma.loan.aggregate({
          where: { cooperativeId: coopId, status: { in: ["approved", "disbursed"] } },
          _sum: { balance: true },
          _count: true,
        }),
        prisma.wallet.aggregate({
          where: { member: { cooperativeId: coopId } },
          _sum: { balance: true, totalSaved: true },
        }),
        prisma.cooperative.findUnique({
          where: { id: coopId },
          select: { reserveFundBalance: true },
        }),
        prisma.educationFund.aggregate({
          where: { cooperativeId: coopId },
          _sum: { amount: true },
        }),
        prisma.developmentFund.aggregate({
          where: { cooperativeId: coopId },
          _sum: { amount: true },
        }),
        prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } }),
        prisma.coopPost.findMany({
          where: { cooperativeId: coopId },
          include: { incumbent: true },
        }),
        computePnl(coopId, startOfYear, endOfYear),
      ]);

      const totalSavings = walletAgg._sum.totalSaved ?? 0;
      const totalBalance = walletAgg._sum.balance ?? 0;
      const outstandingLoans = totalLoansDisbursed._sum.amount ?? 0;
      const loanBalance = activeLoans._sum.balance ?? 0;
      const reserve = reserveFund?.reserveFundBalance ?? 0;
      const education = eduFund._sum.amount ?? 0;
      const development = devFund._sum.amount ?? 0;
      const totalRepaid = totalLoansRepaid._sum.amount ?? 0;

      const officerLines = officers
        .map((o) => `• ${o.title}: ${o.incumbent?.name ?? "Vacant"}`)
        .join("\n");

      const lastDividend = await prisma.dividend.findFirst({
        where: { cooperativeId: coopId },
        orderBy: { createdAt: "desc" },
        select: { rate: true },
      });

      const report = [
        `*ANNUAL RETURN — ${reportYear}*`,
        `*${coopFull.name}*`,
        `Registration No: ${coopFull.code}`,
        "",
        `*PART A: GENERAL INFORMATION*`,
        `• Name of Cooperative: ${coopFull.name}`,
        `• Registration Number: ${coopFull.code}`,
        `• State: ${coopFull.state || "N/A"}`,
        `• Date of Registration: ${coopFull.createdAt.toLocaleDateString("en-GB")}`,
        `• Address: ${coopFull.description || "N/A"}`,
        "",
        `*PART B: OFFICERS*`,
        officerLines || "• No officers registered",
        "",
        `*PART C: MEMBERSHIP*`,
        `• Total active members: *${memberCount}*`,
        `• New members this year: *${newMembers}*`,
        `• Deceased members this year: *${deceasedMembers}*`,
        "",
        `*PART D: SHARE CAPITAL & SAVINGS*`,
        `• Total savings mobilized this year: *${formatBalance(totalSavings)}*`,
        `• Total member wallet balance: *${formatBalance(totalBalance)}*`,
        "",
        `*PART E: LOAN ACTIVITIES*`,
        `• Total loans disbursed: *${formatBalance(outstandingLoans)}*`,
        `• Number of loans: *${totalLoansDisbursed._count}*`,
        `• Total loan repayments received: *${formatBalance(totalRepaid)}*`,
        `• Current outstanding loan balance: *${formatBalance(loanBalance)}*`,
        `• Number of active loans: *${activeLoans._count}*`,
        "",
        `*PART F: INCOME & EXPENDITURE*`,
        `• Total income: *${formatBalance(pnl.totalIncome)}*`,
        `• Total expenditure: *${formatBalance(pnl.totalExpense)}*`,
        `• Total withdrawals by members: *${formatBalance(totalWithdrawals._sum.amount ?? 0)}*`,
        `• Net surplus: *${formatBalance(pnl.netProfit)}*`,
        "",
        `*PART G: DIVIDENDS*`,
        `• Total dividends declared: *${formatBalance(totalDividends._sum.totalPool ?? 0)}*`,
        `• Number of dividend distributions: *${totalDividends._count}*`,
        `• Dividend rate: *${lastDividend ? `${lastDividend.rate}%` : coopConfig ? `${coopConfig.lastDividendRate ?? coopConfig.loanInterestRate}%` : "N/A"}*`,
        "",
        `*PART H: STATUTORY FUNDS*`,
        `• Reserve Fund (20%): *${formatBalance(reserve)}*`,
        `• Education Fund (2%): *${formatBalance(education)}*`,
        `• Development Fund (5%): *${formatBalance(development)}*`,
        `• Total statutory funds: *${formatBalance(reserve + education + development)}*`,
        "",
        `*PART I: LOAN POLICY*`,
        `• Interest rate: *${coopConfig?.loanInterestRate ?? 10}%*`,
        `• Max loan multiplier: *${coopConfig?.maxLoanMultiplier ?? 3}x savings*`,
        `• Late fine: *${coopConfig?.lateFinePercent ?? 5}%*`,
        `• Minimum contribution: *${formatBalance(coopConfig?.minContribution ?? 200000)}*`,
        "",
        `_Generated: ${new Date().toLocaleDateString("en-GB")}_`,
        `_This report is suitable for filing with the State Cooperative Registrar._`,
        `_NOTE: For official filing, export this report as PDF/DOCX via the export command or system admin._`,
      ];
      await sendLongText({ to: phone, text: report.join("\n") });
      return true;
    }

    case "fundstatus": {
      const funds = await getFundBalances(coopId);
      const body = [
        `*💰 Cooperative Fund Status*`,
        ``,
        `• Reserve Fund: *${formatBalance(funds.reserve)}*`,
        `• Education Fund: *${formatBalance(funds.education)}*`,
        `• Development Fund: *${formatBalance(funds.development)}*`,
        ``,
        `_These funds are built from statutory deductions on dividend distributions._`,
      ];
      await sendText({ to: phone, text: body.join("\n") });
      return true;
    }

    case "reservefund": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can view the reserve fund." });
        return true;
      }
      const report = await getReserveReport(coopId);
      await sendText({ to: phone, text: report });
      return true;
    }

    case "par": {
      if (unitAdmin) {
        await sendText({
          to: phone,
          text: "Only the cooperative admin can view portfolio risk.",
        });
        return true;
      }
      const par = await computePar(coopId);
      const parBody = [
        `*📉 Portfolio At Risk (PAR)*`,
        ``,
        `• 1–30 days overdue: *${formatBalance(par.buckets["1-30"])}*`,
        `• 31–90 days overdue: *${formatBalance(par.buckets["31-90"])}*`,
        `• 91–180 days overdue: *${formatBalance(par.buckets["91-180"])}*`,
        `• 180+ days overdue: *${formatBalance(par.buckets["180+"])}*`,
        ``,
        `Past-due total: *${formatBalance(par.total)}*`,
        `PAR ratio: *${(par.parRatio * 100).toFixed(1)}%*`,
        ``,
        `_Run provisioning with *provision*._`,
      ];
      await sendText({ to: phone, text: parBody.join("\n") });
      return true;
    }

    case "provisionrates": {
      if (unitAdmin) {
        await sendText({
          to: phone,
          text: "Only the cooperative admin can view provision rates.",
        });
        return true;
      }
      const rates = await provisionRates(coopId);
      const ratesBody = [
        `*Loan-loss provision rates*`,
        ``,
        `• 1–30 days overdue: *${rates["1-30"]}%*`,
        `• 31–90 days overdue: *${rates["31-90"]}%*`,
        `• 91–180 days overdue: *${rates["91-180"]}%*`,
        `• 180+ days overdue: *${rates["180+"]}%*`,
      ];
      await sendText({ to: phone, text: ratesBody.join("\n") });
      return true;
    }

    case "provision": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can run loan-loss provisioning.",
        });
        return true;
      }
      const provisionResult = await runProvision(coopId, {
        id: admin.id,
        phone,
        role: admin.role,
      });
      await sendText({ to: phone, text: provisionResult.message });
      return true;
    }

    case "reconcile": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* runs reconciliation." });
        return true;
      }
      const alerts = await runReconciliation();
      await sendText({
        to: phone,
        text:
          alerts.length === 0
            ? "🌙 Reconciliation clean — no anomalies found. ✅"
            : `🌙 Reconciliation found:\n\n${alerts.join("\n")}`,
      });
      return true;
    }

    case "walletreconcile": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* runs wallet-bank reconciliation.",
        });
        return true;
      }
      const report = await runWalletReconciliation(coopId, phone);
      await sendText({ to: phone, text: report.message });
      await audit({
        cooperativeId: coopId,
        actorPhone: phone,
        actorId: admin.id,
        actorRole: "superadmin",
        action: "reconciliation.wallet_bank",
        detail: `discrepancy: ${formatBalance(report.discrepancy)}, status: ${report.status}`,
      });
      return true;
    }

    case "paydividend": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can distribute dividends." });
        return true;
      }
      const rate = Number(args[0]);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
        await sendText({
          to: phone,
          text: "Usage: *paydividend <rate%>*, e.g. *paydividend 5* to pay a 5% dividend.",
        });
        return true;
      }
      if (rate > 25) {
        await sendText({
          to: phone,
          text: "Dividend rate cannot exceed 25% per the Nigerian Cooperative Societies Act.",
        });
        return true;
      }
      const coopConfig = await getCoopConfig(coopId);
      const lastRate = coopConfig.lastDividendRate;
      const approvedVote = await prisma.dividendVote.findFirst({
        where: { cooperativeId: coopId, proposedRate: rate, status: "approved" },
        orderBy: { closedAt: "desc" },
      });
      if (lastRate !== null && Math.abs(rate - lastRate) > 5 && !approvedVote) {
        await updateCoopConfig(coopId, { pendingDividendRate: rate } as any);
        await audit({
          cooperativeId: coopId,
          actorPhone: phone,
          actorId: admin.id,
          actorRole: "superadmin",
          action: "dividend.vote_required",
          detail: `proposed ${rate}% differs ${Math.abs(rate - lastRate)}% from last ${lastRate}% — member vote needed`,
        });
        await sendText({
          to: phone,
          text:
            `⚠️ The proposed rate *${rate}%* differs by *${Math.abs(rate - lastRate)}%* from the last dividend rate (${lastRate}%).\n\n` +
            `Cooperative governance requires member approval for rate changes above 5%.\n\n` +
            `Reply *startvotediv ${rate}* to open a member vote on this rate.`,
        });
        return true;
      }
      const preview = await previewDividendRun(phone, rate);
      if (!preview.ok || !preview.confirmToken) {
        await sendText({ to: phone, text: preview.message });
        return true;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_dividend_confirm",
          data: JSON.stringify({ dividendRate: rate }),
        },
        update: {
          state: "awaiting_dividend_confirm",
          data: JSON.stringify({ dividendRate: rate }),
        },
      });
      await sendText({ to: phone, text: preview.message });
      return true;
    }

    case "paysharedividend": {
      if (!isSuper) {
        await sendText({ to: phone, text: "Only the *super admin* can distribute dividends." });
        return true;
      }
      const rate = Number(args[0]);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 25) {
        await sendText({
          to: phone,
          text: "Usage: *paysharedividend <rate%>*, e.g. *paysharedividend 5* to pay 5% of profit on shares.",
        });
        return true;
      }
      const preview = await previewDividendRun(phone, rate, "shares");
      if (!preview.ok || !preview.confirmToken) {
        await sendText({ to: phone, text: preview.message });
        return true;
      }
      await prisma.session.upsert({
        where: { phone },
        create: {
          phone,
          state: "awaiting_sharedividend_confirm",
          data: JSON.stringify({ shareDividendRate: rate }),
        },
        update: {
          state: "awaiting_sharedividend_confirm",
          data: JSON.stringify({ shareDividendRate: rate }),
        },
      });
      await sendText({ to: phone, text: preview.message });
      return true;
    }

    case "startvotediv": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can open a dividend-rate vote.",
        });
        return true;
      }
      const voteResult = await startDividendVote(
        { id: admin.id, name: admin.name, phone, role: admin.role, cooperativeId: coopId },
        args[0] ?? "",
      );
      await sendText({ to: phone, text: voteResult.message });
      return true;
    }

    case "closedivid": {
      if (!isSuper) {
        await sendText({
          to: phone,
          text: "Only the *super admin* can close a dividend-rate vote.",
        });
        return true;
      }
      const voteResult = await closeDividendVote(
        { id: admin.id, name: admin.name, phone, role: admin.role, cooperativeId: coopId },
        args[0],
      );
      await sendText({ to: phone, text: voteResult.message });
      return true;
    }

    case "votedivstatus": {
      const voteResult = await dividendVoteStatus(coopId);
      await sendText({ to: phone, text: voteResult.message });
      return true;
    }

    default:
      return false;
  }
}
