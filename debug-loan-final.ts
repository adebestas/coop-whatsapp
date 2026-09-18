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
    
    // Add admin and superadmins
    await prisma.member.create({
      data: { code: "ADMIN001", phone: "2348099999999", name: "Admin", cooperativeId: "TEST01", pin: "1234", role: "admin" }
    });
    await prisma.member.create({
      data: { code: "SUPER001", phone: "2348073333333", name: "Super", cooperativeId: "TEST01", pin: hashPin("1234"), role: "superadmin" }
    });
    await prisma.member.create({
      data: { code: "SUPER002", phone: "2348073444444", name: "Super2", cooperativeId: "TEST01", pin: hashPin("1234"), role: "superadmin" }
    });
    await prisma.member.create({
      data: { code: "G1CODE", phone: "2348071111111", name: "G1", cooperativeId: "TEST01", pin: hashPin("1234") }
    });
    await prisma.member.create({
      data: { code: "G2CODE", phone: "2348072222222", name: "G2", cooperativeId: "TEST01", pin: hashPin("1234") }
    });
    
    console.log("Step 1: loan application");
    await handleMessage(PHONE, "loan 100000 3");
    console.log("After loan application");
    
    let loan = await prisma.loan.findFirst({ where: { memberId: (await prisma.member.findFirst({ where: { phone: PHONE } }))!.id } });
    console.log("Loan after application:", loan ? loan.id : "null");
    if (loan) console.log("Loan status:", loan.status);
    
    if (!loan) return;
    
    console.log("Step 2: account number");
    await handleMessage(PHONE, "0123456789");
    console.log("After account number");
    
    loan = await prisma.loan.findUnique({ where: { id: loan.id } });
    console.log("Loan after account:", loan ? loan.status : "null");
    
    console.log("Step 3: bank");
    await handleMessage(PHONE, "Access");
    console.log("After bank");
    
    loan = await prisma.loan.findUnique({ where: { id: loan.id } });
    console.log("Loan after bank:", loan ? loan.status : "null");
    
    console.log("Step 4: yes");
    await handleMessage(PHONE, "yes");
    console.log("After yes");
    
    loan = await prisma.loan.findUnique({ where: { id: loan.id } });
    console.log("Loan after yes:", loan ? loan.status : "null");
    
    if (loan) {
      const guarantors = await prisma.guarantor.findMany({
        where: { loanId: loan.id },
        include: { member: true }
      });
      console.log("Guarantors:", guarantors.length);
      for (const g of guarantors) {
        console.log("Guarantor:", g.member.code, g.status);
      }
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

debugLoan();