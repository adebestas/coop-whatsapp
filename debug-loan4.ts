import { PrismaClient } from '@prisma/client';
import { hashPin, generateMemberCode } from './src/lib/security.js';
import { handleMessage } from './src/services/conversation.js';
import { clearMemberCache } from './src/services/cooperative.js';
import { getMemberByPhone } from './src/services/cooperative.js';
import { prisma } from './src/lib/prisma.js';

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
    await prisma.session.deleteMany();
    
    // Create test data
    const coop = await prisma.cooperative.create({
      data: { name: "Test Coop", code: "TEST01" }
    });
    console.log("Created coop:", coop.id);
    
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
    
    // Check member
    const found = await getMemberByPhone(PHONE);
    console.log("Found member:", found ? found.id : "null");
    
    // Try direct applyForLoan
    const { applyForLoan } = await import('./src/services/loans.js');
    const result = await applyForLoan(PHONE, 100000, 3, {
      accountNumber: "0123456789",
      bankCode: "044",
      bankName: "Access"
    });
    console.log("Loan application result:", result);
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

debugLoan();