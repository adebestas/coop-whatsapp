import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import {
  parseCsv,
  parseMatrix,
  parseAmount,
  parseExcel,
} from "../src/lib/deduction-parse/index.js";
import { ingestDeductionFile, handleDeductionUpload } from "../src/services/deduction-ingest.js";
import { extractWhatsAppMessages } from "../src/lib/inbound.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

describe("deduction file parsing", () => {
  it("parses a CSV with a header row", () => {
    const csv = "Staff Code,Name,Amount\nA1B2C3,Ada Obi,5000\nD4E5F6,Chidi Okafor,3000\n";
    const res = parseCsv(csv);
    expect(res.format).toBe("csv");
    expect(res.rows.length).toBe(2);
    expect(res.rows[0].memberCode).toBe("A1B2C3");
    expect(res.rows[0].memberName).toBe("Ada Obi");
    expect(res.rows[0].amount).toBe(500000); // ₦5,000 in kobo
  });

  it("parses a headerless grid positionally", () => {
    const res = parseMatrix([
      ["A1B2C3", "Ada Obi", "5000"],
      ["D4E5F6", "Chidi Okafor", "3000"],
    ]);
    expect(res.rows.length).toBe(2);
    expect(res.rows[1].amount).toBe(300000);
  });

  it("parses naira amounts with symbols and commas", () => {
    expect(parseAmount("₦5,000.50")).toBe(500050);
    expect(parseAmount("5000")).toBe(500000);
    expect(parseAmount("abc")).toBeNull();
  });

  it("parses an Excel workbook", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Code", "Name", "Deduction"]);
    ws.addRow(["A1B2C3", "Ada Obi", 5000]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await parseExcel(buf);
    expect(res.format).toBe("excel");
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].amount).toBe(500000);
  });
});

describe("deduction file ingestion + member matching", () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("matches rows to members by code and reports unmatched rows", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Ingest Coop", code: "ING01" },
    });
    let code = generateMemberCode();
    while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
    await prisma.member.create({
      data: {
        code,
        phone: "2348011111111",
        name: "Ada Obi",
        cooperativeId: coop.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
    });

    const csv = `Code,Name,Amount\n${code},Ada Obi,5000\nZZZZZZ,Ghost,1000\n`;
    const res = await ingestDeductionFile(coop.id, Buffer.from(csv), "deductions.csv");
    expect(res.matchedCount).toBe(1);
    expect(res.unmatchedCount).toBe(1);
    expect(res.rows[0].matched).toBe(true);
    expect(res.rows[0].memberId).toBeTruthy();
    expect(res.rows[1].matched).toBe(false);
  });

  it("builds a draft batch from an uploaded CSV via the WhatsApp handler", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Upload Coop", code: "UPL01" },
    });
    let code = generateMemberCode();
    while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
    await prisma.member.create({
      data: {
        code,
        phone: "2348022222222",
        name: "Admin",
        role: "admin",
        cooperativeId: coop.id,
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
    });

    const csv = `Code,Amount\n${code},5000\n`;
    const res = await handleDeductionUpload("2348022222222", Buffer.from(csv), "ded.csv");
    expect(res.ok).toBe(true);
    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    expect(batch!.items.length).toBe(1);
    expect(batch!.totalAmount).toBe(500000);
    expect(batch!.sourceFileName).toBe("ded.csv");
  });
});

describe("inbound document extraction", () => {
  it("extracts a document message from a WhatsApp webhook payload", () => {
    const msgs = extractWhatsAppMessages({
      messages: [
        {
          from: "2348011111111",
          type: "document",
          document: {
            id: "MEDIA1",
            filename: "ded.xlsx",
            mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        },
      ],
    });
    expect(msgs.length).toBe(1);
    expect(msgs[0].document?.mediaId).toBe("MEDIA1");
    expect(msgs[0].document?.filename).toBe("ded.xlsx");
  });
});
