import { PrismaClient } from '@prisma/client';
import { hashPin, generateMemberCode } from './src/lib/security.js';
import { handleMessage } from './src/services/conversation.js';
import { clearMemberCache } from './src/services/cooperative.js';
import { prisma } from './src/lib/prisma.js';

const PHONE = "2348012345678";

async function debugLoan() {
  try {
    clearMemberCache();
    
    await prisma.guarantor.deleteMany();
    await prisma.loan.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
    await prisma.session.deleteMany();
    
    const coop = await prisma.cooperative.create({
      data: { name: "Test Coop", code: "TEST01" }
    });
    console.log("Created coop:", coop.id);
    
    const code = generateMemberCode();
    const member = await prisma.member.create({
      data: {
        code: "TEST001",
        phone: PHONE,
        name: "Test Member",
        cooperativeId: coop.id,
        pin: hashPin("1234"),
        wallet: { create: { balance: 200000, totalSaved: 200000 } }
      }
    });
    console.log("Created member:", member.id);
    
    // Check session before
    let session = await prisma.session.findUnique({ where: { phone: PHONE } });
    console.log("Session before:", session);
    
    console.log("Step 1: loan application");
    await handleMessage(PHONE, "loan 100000 3");
    console.log("After loan application");
    
    let sessionAfter = await prisma.session.findUnique({ where: { phone: PHONE } });
    console.log("Session after:", sessionAfter);
    
    let loan = await prisma.loan.findFirst({ where: { memberId: member.id } });
    console.log("Loan after application:", loan ? loan.id : "null");
    if (loan) console.log("Loan status:", loan.status);
    
    if (!loan) return;
    
    console.log("Step 2: account number");
    await handleMessage(PHONE, "0123456789");
    console.log("After account number");
    
    sessionAfter = await prisma.session.findUnique({ where: { phone: PHONE } });
    console.log("Session after account:", sessionAfter);
    
    loan = await prisma.loan.findUnique({ where: { id: loan.id } });
    console.log("Loan after account:", loan ? loan.status : "null");
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

debugLoan();