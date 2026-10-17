import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file for tests
dotenvConfig({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  test: {
    hookTimeout: 120000,
    testTimeout: 120000,
    fileParallelism: false,
    setupFiles: [path.resolve(__dirname, "tests/setup.ts")],
    env: {
      NODE_ENV: "test",
      // Tests run on SQLite (prisma/dev.db). `npm test` runs `pretest`, which generates the
      // Prisma client from prisma/schema.local.prisma. Running `vitest` directly after a
      // PostgreSQL `prisma generate` will fail — use `npm test` or `npm run prisma:generate:local`.
    },
  },
});