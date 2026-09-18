import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file for tests
dotenvConfig({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  test: {
    hookTimeout: 60000,
    testTimeout: 60000,
    fileParallelism: false,
    setupFiles: [path.resolve(__dirname, "tests/setup.ts")],
    env: {
      NODE_ENV: "test",
      // Use local SQLite schema for tests
      PRISMA_SCHEMA_PATH: path.resolve(__dirname, "prisma/schema.local.prisma"),
    },
  },
});