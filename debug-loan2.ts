import { PrismaClient } from '@prisma/client';
import { hashPin, generateMemberCode } from './src/lib/security.js';
import { applyForLoan } from './src/services/loans.js';
import { clearMemberCache } from './src/services/cooperative.js';

const prisma = new PrismaClient({ datasources: { db: { url: 'file:./dev.db' } } });

const PHONE = "2348012345678";

async function debugLoan() {
  try {
    // Clear cache
    clearMemberCache();
    
    // Clean up
    await prisma.guarantor.deleteMany();
    await prisma.loan.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
    
    // Create test data
    const coop = await prisma.cooperative.create({
      data: { name: "Test Coop", code: "TEST01" }
    });
    console.log("Created coop:", coop.id);
    
    const code = generateMemberCode();
    const member = await prisma.member.create({
      data: {
        code,
        phone: PHONE,
        name: "Test Member",
        cooperativeId: coop.id,
        pin: hashPin("1234"),
        wallet: { create: { balance: 200000, totalSaved: 200000 } }
      }
    });
    console.log("Created member:", member.id);
    
    // Simulate loan application using the service directly
    console.log("Applying for loan directly...");
    const result = await applyForLoan(PHONE, 100000, 3, {
      accountNumber: "0123456789",
      bankCode: "044",
      bankName: "Access"
    });
    console.log("Loan application result:", result);
    
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