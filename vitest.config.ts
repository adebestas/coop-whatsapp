import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    hookTimeout: 60000,
    testTimeout: 60000,
    fileParallelism: false,
    setupFiles: [path.resolve(__dirname, "tests/setup.ts")],
  },
});