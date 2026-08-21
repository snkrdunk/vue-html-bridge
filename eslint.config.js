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
  {
    // Phase 0 spike code (implementation-plan.md §3): lives outside src/,
    // is never shipped, and works directly with loosely-typed Babel/Vue
    // compiler AST nodes where full typing isn't worth the cost for
    // throwaway exploration code. Correctness is enforced by the spike's
    // own tests, not by strict typing here.
    files: ["spikes/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
]);
