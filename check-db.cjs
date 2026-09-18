const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'file:./dev.db' } } });

async function test() {
  // Check if loan table exists
  const tables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='Loan'`;
  console.log('Loan table exists:', tables.length > 0);
  
  // Check if member exists
  const member = await prisma.member.findFirst({ where: { phone: '2348012345678' } });
  console.log('Member exists:', !!member);
  
  if (member) {
    const loan = await prisma.loan.findFirst({ where: { memberId: member.id } });
    console.log('Loan exists:', !!loan);
    if (loan) console.log('Loan status:', loan.status);
  }
  
  await prisma.$disconnect();
}
test().catch(console.error);