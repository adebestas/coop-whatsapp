import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: [
      "dist/",
      "node_modules/",
      "web/",
      "coverage/",
      "exports/",
      // One-off QA diagnostics, not part of the build.
      "debug-*",
      "check-db.cjs",
      "fix-imports.js",
      "remove-tier.js",
    ],
  },
  {
    // dashboard/ is browser-side JS, not part of the Node build.
    files: ["dashboard/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Build/migration scripts run under Node.
    files: ["scripts/**/*.mjs", "scripts/**/*.cjs", "*.mjs", "*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Test files use the tolerant `try { ... } catch {}` teardown pattern so a
    // missing table or FK constraint does not mask the assertion under test.
    files: ["tests/**/*.ts"],
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-console": ["warn", { allow: ["warn", "error", "log"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
    },
  },
);
