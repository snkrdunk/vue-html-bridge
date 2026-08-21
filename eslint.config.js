// @ts-check
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Privacy/logging rule (monorepo.md §11; implementation-plan.md §8):
    // no console.* in adapters, no stdout logging in the language server.
    // Scoped to package source only — build/tooling scripts may log freely.
    files: ["packages/**/src/**/*.ts"],
    rules: {
      "no-console": ["warn", { allow: ["error"] }],
    },
  },
]);
