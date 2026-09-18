import { PrismaClient } from '@prisma/client';
import { hashPin, generateMemberCode } from './src/lib/security.js';
import { handleMessage } from './src/services/conversation.js';
import { clearMemberCache } from './src/services/cooperative.js';
import { prisma } from './src/lib/prisma.js';

const PHONE = "2348012345678";
const ADMIN_PHONE = "2348099999999";
const G1_PHONE = "2348071111111";
const G2_PHONE = "2348072222222";
const SUPER_PHONE = "2348073333333";
const SUPER2_PHONE = "2348073444444";

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
    
    // Add guarantors
    const g1Code = generateMemberCode();
    const g1 = await prisma.member.create({
      data: { code: g1Code, phone: "2348071111111", name: "G1", cooperativeId: coop.id, pin: hashPin("1234") }
    });
    const g2Code = generateMemberCode();
    const g2 = await prisma.member.create({
      data: { code: g2Code, phone: "2348072222222", name: "G2", cooperativeId: coop.id, pin: hashPin("1234") }
    });
    
    // Add admin and superadmins
    const adminCode = generateMemberCode();
    await prisma.member.create({
      data: { code: adminCode, phone: "2348099999999", name: "Admin", cooperativeId: coop.id, pin: hashPin("1234"), role: "admin" }
    });
    const superCode = generateMemberCode();
    await prisma.member.create({
      data: { code: superCode, phone: "2348073333333", name: "Super", cooperativeId: coop.id, pin: hashPin("1234"), role: "superadmin" }
    });
    const super2Code = generateMemberCode();
    await prisma.member.create({
      data: { code: super2Code, phone: "2348073444444", name: "Super2", cooperativeId: coop.id, pin: hashPin("1234"), role: "superadmin" }
    });
    
    console.log("Step 1: loan application");
    await handleMessage(PHONE, "loan 100000 3");
    console.log("After loan application");
    
    let loan = await prisma.loan.findFirst({ where: { memberId: member.id } });
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