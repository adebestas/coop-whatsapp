import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const files = globSync('tests/*.test.ts');

for (const file of files) {
  let content = readFileSync(file, 'utf-8');
  const updated = content.replace(
    'import { prisma } from "../src/lib/prisma.js";',
    'import { prisma } from "../tests/setup.js";'
  );
  writeFileSync(file, updated, 'utf-8');
  console.log(`Updated: ${file}`);
}

console.log('Done!');