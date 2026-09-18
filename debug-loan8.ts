import { PrismaClient } from '@prisma/client';
import { hashPin, generateMemberCode } from './src/lib/security.js';
import { handleMessage } from './src/services/conversation.js';
import { clearMemberCache } from './src/services/cooperative.js';

const PHONE = "2348012345678";

const prisma = new PrismaClient({ datasources: { db: { url: 'file:./dev.db' } } });

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
    
    console.log("Checking session before loan...");
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
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

debugLoan();