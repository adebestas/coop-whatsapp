const { PrismaClient } = require('@prisma/client');
const { hashPin, generateMemberCode } = require('./src/lib/security.js');
const { handleMessage } = require('./src/services/conversation.js');
const { clearMemberCache } = require('./src/services/cooperative.js');
const { provisionVirtualAccount } = require('./src/services/payments/topup.js');

const prisma = new PrismaClient({ datasources: { db: { url: 'file:./dev.db' } } });

const PHONE = "2348012345678";
const ADMIN_PHONE = "2348099999999";
const G1_PHONE = "2348071111111";
const G2_PHONE = "2348072222222";
const SUPER_PHONE = "2348073333333";
const SUPER2_PHONE = "2348073444444";

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
    
    // Simulate loan application
    console.log("Applying for loan...");
    await handleMessage(PHONE, "loan 100000 3");
    console.log("After loan application");
    
    let loan = await prisma.loan.findFirst({ where: { memberId: member.id } });
    console.log("Loan after application:", loan ? loan.id : "null");
    if (loan) console.log("Loan status:", loan.status);
    
    if (loan) {
      console.log("Sending account number...");
      await handleMessage(PHONE, "0123456789");
      console.log("After account number");
      
      loan = await prisma.loan.findUnique({ where: { id: loan.id } });
      console.log("Loan after account:", loan ? loan.status : "null");
      
      console.log("Sending bank...");
      await handleMessage(PHONE, "Access");
      console.log("After bank");
      
      loan = await prisma.loan.findUnique({ where: { id: loan.id } });
      console.log("Loan after bank:", loan ? loan.status : "null");
      
      console.log("Sending yes...");
      await handleMessage(PHONE, "yes");
      console.log("After yes");
      
      loan = await prisma.loan.findUnique({ where: { id: loan.id } });
      console.log("Loan after yes:", loan ? loan.status : "null");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

debugLoan();